import { objectFields, errorField } from "../runtime/type-boundary.mjs";
import type { CredentialStoragePort } from "./connection-port.mjs";
import type { ConnectionCredentials } from "../contracts/connection.mjs";
import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from "node:crypto";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";

const execute = promisify(execFile);
const failure = () => Object.assign(new Error("凭据仓库不可用；原配置已保留，请检查本机钥匙串后重试"), { reason: "credential_vault_unavailable" });
const keys = new Map<string, Promise<Buffer>>();
async function addKey(account: string, key: Buffer) {
  await new Promise<void>((resolve, reject) => {
    const child = spawn("/usr/bin/security", ["-i"], { stdio: ["pipe", "ignore", "ignore"] });
    child.once("error", reject); child.once("exit", (code) => code === 0 ? resolve() : reject(failure()));
    child.stdin.on("error", reject);
    child.stdin.end(`add-generic-password -s "NEUMA Credential Vault" -a "${account}" -w "${key.toString("base64")}"\n`);
  });
}

export function keychainKeySource(namespace: string | undefined) {
  const account = createHash("sha256").update(namespace ?? "").digest("hex");
  return async () => {
    if (!keys.has(account)) keys.set(account, (async () => {
      if (process.platform !== "darwin") throw failure();
      try {
        const read = await execute("/usr/bin/security", ["find-generic-password", "-s", "NEUMA Credential Vault", "-a", account, "-w"], { timeout: 15000 });
        const key = Buffer.from(read.stdout.trim(), "base64");
        if (key.length !== 32) throw failure();
        return key;
      } catch (error) {
        if (errorField(error, "code") !== 44) throw failure();
        const key = randomBytes(32);
        try {
          await addKey(account, key);
          const saved = await execute("/usr/bin/security", ["find-generic-password", "-s", "NEUMA Credential Vault", "-a", account, "-w"], { timeout: 15000 });
          if (!Buffer.from(saved.stdout.trim(), "base64").equals(key)) throw failure();
        }
        catch { throw failure(); }
        return key;
      }
    })().catch((error) => { keys.delete(account); throw error; }));
    return keys.get(account)!;
  };
}

export class CredentialVault {
  declare storage: CredentialStoragePort; declare keySource: () => Promise<Buffer>;
  constructor({ storage, keySource = keychainKeySource(storage.dataDir) }: { storage: CredentialStoragePort; keySource?: (() => Promise<Buffer>) | undefined }) { Object.assign(this, { storage, keySource }); }
  async put(agentId: string, value: unknown) {
    const reference = randomUUID(), iv = randomBytes(12);
    try {
      const cipher = createCipheriv("aes-256-gcm", await this.keySource(), iv);
      cipher.setAAD(Buffer.from(`${agentId}:${reference}`));
      const data = Buffer.concat([cipher.update(JSON.stringify(value), "utf8"), cipher.final()]);
      await this.storage.writeJson(agentId, `private/credentials/${reference}.json`, { version: 1, iv: iv.toString("base64"), tag: cipher.getAuthTag().toString("base64"), data: data.toString("base64") });
      return reference;
    } catch { throw failure(); }
  }
  async get(agentId: string, reference?: string): Promise<ConnectionCredentials> {
    if (!reference) return {};
    if (!/^[a-f0-9-]{36}$/.test(reference)) throw failure();
    try {
      const record = objectFields(await this.storage.readJson(agentId, `private/credentials/${reference}.json`, { maxBytes: 128 * 1024 }));
      if (record.version !== 1 || typeof record.iv !== "string" || typeof record.tag !== "string" || typeof record.data !== "string") throw failure();
      const decipher = createDecipheriv("aes-256-gcm", await this.keySource(), Buffer.from(record.iv, "base64"));
      decipher.setAAD(Buffer.from(`${agentId}:${reference}`)); decipher.setAuthTag(Buffer.from(record.tag, "base64"));
      const value = objectFields(JSON.parse(Buffer.concat([decipher.update(Buffer.from(record.data, "base64")), decipher.final()]).toString("utf8")));
      if (value.secret !== undefined && typeof value.secret !== "string" || value.secretValues !== undefined && Object.values(objectFields(value.secretValues)).some((item) => typeof item !== "string")) throw failure();
      return value as ConnectionCredentials;
    } catch { throw failure(); }
  }
}
