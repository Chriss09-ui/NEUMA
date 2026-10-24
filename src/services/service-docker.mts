import type { ServiceManifest } from "../contracts/service.mjs";
import type { ProgressOptions, InstalledDependencies, DockerDelivery, IsolationProbe } from "./service-port.mjs";
import { errorField, objectFields } from "../runtime/type-boundary.mjs";
interface DockerRecord { manifest: ServiceManifest; docker?: DockerDelivery }
import { cp, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { ServiceError, serviceHash } from "./service-contract.mjs";
import { privateDirectory } from "./service-files.mjs";
import { commandResult } from "./service-process.mjs";
import { extractPackageTar } from "./service-runtime.mjs";

// The container also denies new process creation. CLONE_THREAD remains available for language runtimes.
const SECCOMP = Object.freeze({ defaultAction: "SCMP_ACT_ALLOW", syscalls: [
  { names: ["fork", "vfork", "unshare", "setns", "mount", "umount2", "pivot_root", "ptrace", "bpf", "keyctl", "add_key", "request_key", "perf_event_open", "reboot", "kexec_load", "init_module", "finit_module", "delete_module", "open_by_handle_at"], action: "SCMP_ACT_ERRNO", errnoRet: 1 },
  { names: ["clone3"], action: "SCMP_ACT_ERRNO", errnoRet: 38 },
  { names: ["clone"], action: "SCMP_ACT_ERRNO", errnoRet: 1, args: [{ index: 0, value: 65536, valueTwo: 0, op: "SCMP_CMP_MASKED_EQ" }] },
  { names: ["socket"], action: "SCMP_ACT_ERRNO", errnoRet: 1, args: [{ index: 0, value: 1, op: "SCMP_CMP_NE" }] }
] });
export class DockerServiceRuntime {
  declare dockerPath: string; declare ownerId: string | undefined; declare command: typeof commandResult;
  constructor({ dockerPath = "docker", ownerId, command = commandResult }: { dockerPath?: string; ownerId?: string; command?: typeof commandResult } = {}) { Object.assign(this, { dockerPath, ownerId, command }); }
  async probe({ signal }: { signal?: AbortSignal | undefined } = {}): Promise<IsolationProbe> {
    try {
      const result = await this.command(this.dockerPath, ["info", "--format", "{{json .}}"], { signal, timeoutMs: 10000 });
      if (result.code !== 0) return { available: false, host: "docker", reason: "docker_not_running" };
      const info = JSON.parse(result.stdout);
      if (info.OSType !== "linux" || !["aarch64", "arm64"].includes(info.Architecture)) return { available: false, host: "docker", reason: "unsupported_docker_platform" };
      return { available: true, host: "docker", kind: "docker-linux-arm64", version: info.ServerVersion, verified: false };
    } catch (error) { return { available: false, host: "docker", reason: String(errorField(error, "reason") ?? "docker_unavailable") }; }
  }
  async build({ directory, codeDir, dependencies, manifest, signal, onProgress = () => {} }: ProgressOptions & { directory: string; codeDir: string; dependencies: InstalledDependencies; manifest: ServiceManifest }): Promise<DockerDelivery> {
    const status = await this.probe({ signal }); if (!status.available) throw new ServiceError(status.reason ?? "docker_unavailable");
    const context = await privateDirectory(join(directory, "docker-context"));
    await cp(codeDir, join(context, "code"), { recursive: true, force: false, errorOnExist: false });
    await mkdir(join(context, "worker"), { recursive: true, mode: 0o700 });
    for (const name of ["node-service-worker.mjs", "python-service-worker.py"]) await cp(fileURLToPath(new URL(name, import.meta.url)), join(context, "worker", name));
    await mkdir(join(context, "deps"), { recursive: true, mode: 0o700 });
    let install = "";
    if (manifest.language === "javascript") {
      for (const pkg of manifest.dependencies.packages) {
        const target = await privateDirectory(join(context, "deps", pkg.installPath ?? `node_modules/${pkg.name}`));
        await extractPackageTar(await readFile(join(dependencies.path, pkg.filename)), target);
      }
      await writeFile(join(context, "deps", "package.json"), '{"private":true}');
      install = 'RUN ["/bin/sh","-c","ln -s /app/deps/node_modules /app/node_modules"]\n';
    } else if (manifest.dependencies.packages.length) {
      await cp(dependencies.path, join(context, "locked"), { recursive: true });
      install = 'COPY locked/ /locked/\nRUN ["/bin/sh","-c","python3 -I -m pip install --no-index --no-deps --no-compile --target /app/deps /locked/*.whl"]\n';
    }
    const buildSteps = (manifest.docker!.buildSteps ?? []).map((args) => `RUN ${JSON.stringify(args)}`).join("\n");
    const executable = manifest.language === "javascript" ? "node" : "python3";
    const entrypoint = manifest.language === "javascript" ? [executable, "--disable-proto=throw", "/app/worker/node-service-worker.mjs", `/app/code/${manifest.entrypoint}`, "/app/deps"]
      : [executable, "-I", "-S", "-B", "/app/worker/python-service-worker.py", `/app/code/${manifest.entrypoint}`, "/app/deps"];
    const source = `FROM ${manifest.docker!.baseImage}\nWORKDIR /app\nCOPY code/ /app/code/\nCOPY worker/ /app/worker/\nCOPY deps/ /app/deps/\n${install}${buildSteps}\nRUN ["/bin/sh","-c","chmod -R a+rX /app"]\nUSER 10001:10001\nWORKDIR /scratch\nENTRYPOINT ${JSON.stringify(entrypoint)}\n`;
    await writeFile(join(context, "Dockerfile"), source, { mode: 0o600 });
    const tag = `neuma-service:${serviceHash({ source, code: directory }).slice(0, 40)}`;
    await onProgress({ status: "building_container" });
    const built = await this.command(this.dockerPath, ["build", "--network=none", "--label", `neuma.owner=${this.ownerId}`, "--tag", tag, context], { signal, timeoutMs: 600000, maxBytes: 1024 * 1024 });
    if (built.code !== 0) throw new ServiceError("docker_build_failed");
    const inspected = await this.command(this.dockerPath, ["image", "inspect", "--format", "{{.Id}}", tag], { signal });
    if (inspected.code !== 0 || !/^sha256:[a-f0-9]{64}$/.test(inspected.stdout.trim())) throw new ServiceError("docker_image_missing");
    const seccompPath = join(directory, "docker-seccomp.json"); await writeFile(seccompPath, JSON.stringify(SECCOMP), { mode: 0o600 });
    const docker: DockerDelivery = { imageId: inspected.stdout.trim(), seccompPath, buildHash: serviceHash(source) };
    docker.isolation = await this.verifyImage({ manifest, docker, signal });
    return docker;
  }
  launchArguments({ record, name }: { record: DockerRecord; name: string }) {
    const { memoryMiB, scratchMiB } = record.manifest.resources;
    return ["run", "--rm", "--interactive", "--name", name, "--label", `neuma.owner=${this.ownerId}`, "--network=none", "--read-only", "--cap-drop=ALL", "--security-opt=no-new-privileges", `--security-opt=seccomp=${record.docker!.seccompPath}`, "--pids-limit=64", `--memory=${memoryMiB}m`, `--memory-swap=${memoryMiB}m`, "--cpus=1", `--tmpfs=/scratch:rw,nosuid,nodev,size=${scratchMiB}m,uid=10001,gid=10001,mode=700`, "--log-driver=local", "--log-opt=max-size=1m", "--log-opt=max-file=1", record.docker!.imageId];
  }
  async verifyImage({ manifest, docker, signal }: { manifest: ServiceManifest; docker: DockerDelivery; signal?: AbortSignal | undefined }) {
    const name = `neuma-probe-${serviceHash([docker.imageId, Date.now()]).slice(0, 24)}`;
    const args = this.launchArguments({ record: { manifest, docker }, name }); args.pop();
    const source = manifest.language === "javascript" ? `const fs=require('node:fs'),net=require('node:net'),{spawnSync}=require('node:child_process');const deny=fn=>{try{fn();return false}catch(e){return ['EPERM','EACCES','EROFS'].includes(e.code)}};fs.writeFileSync('/scratch/check','yes');const child=spawnSync(process.execPath,['-e','0']);const s=net.createServer();s.once('error',e=>console.log(JSON.stringify({scratch:fs.readFileSync('/scratch/check','utf8')==='yes',code:deny(()=>fs.writeFileSync('/app/code/probe','bad')),network:['EPERM','EACCES'].includes(e.code),subprocess:['EPERM','EACCES'].includes(child.error?.code)})));s.listen(0,'127.0.0.1',()=>s.close(()=>process.exit(2)));`
      : `import os,sys,json,socket,subprocess\ndef deny(fn):\n try:fn();return False\n except OSError as e:return e.errno in (1,13,30)\nopen('/scratch/check','w').write('yes')\nprint(json.dumps({'scratch':open('/scratch/check').read()=='yes','code':deny(lambda:open('/app/code/probe','w').write('bad')),'network':deny(lambda:socket.socket(socket.AF_INET,socket.SOCK_STREAM)),'subprocess':deny(lambda:subprocess.run([sys.executable,'-c','pass'],timeout=1))}))`;
    args.push("--entrypoint", manifest.language === "javascript" ? "node" : "python3", docker.imageId, ...(manifest.language === "javascript" ? ["-e", source] : ["-I", "-S", "-B", "-c", source]));
    try {
      const result = await this.command(this.dockerPath, args, { signal, timeoutMs: 15000 });
      let checks; try { checks = JSON.parse(result.stdout); } catch {}
      if (result.code !== 0 || !checks || ["scratch", "code", "network", "subprocess"].some((key) => checks[key] !== true)) throw new ServiceError("docker_isolation_failed");
      return { available: true, checks, kind: "docker-linux-arm64", resourceEnforcement: "container-hard-limits" };
    } finally { await this.stop(name); }
  }
  async stop(name: string) { await this.command(this.dockerPath, ["rm", "--force", name], { timeoutMs: 10000 }).catch(() => {}); }
  async cleanupOwned() {
    try {
      const result = await this.command(this.dockerPath, ["ps", "--all", "--quiet", "--filter", `label=neuma.owner=${this.ownerId}`]);
      if (result.code === 0) for (const id of result.stdout.trim().split(/\s+/).filter((id) => /^[a-f0-9]{12,64}$/.test(id))) await this.stop(id);
    } catch { /* Missing Docker must not disable ordinary services. */ }
  }
}
