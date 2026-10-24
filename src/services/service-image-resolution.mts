import { objectFields, isArray } from "../runtime/type-boundary.mjs";
import { ServiceError, serviceHash } from "./service-contract.mjs";

const ACCEPT = ["application/vnd.oci.image.index.v1+json", "application/vnd.docker.distribution.manifest.list.v2+json", "application/vnd.oci.image.manifest.v1+json", "application/vnd.docker.distribution.manifest.v2+json"].join(", ");
async function limitedJSON(response: Response, limit = 4 * 1024 * 1024) {
  if (!response.ok || !response.body) throw new ServiceError(response.status === 429 ? "docker_registry_rate_limited" : "docker_image_metadata_unavailable");
  const chunks = []; let size = 0;
  for await (const chunk of response.body) { size += chunk.length; if (size > limit) throw new ServiceError("docker_manifest_limit"); chunks.push(chunk); }
  const bytes = Buffer.concat(chunks); return { value: objectFields(JSON.parse(bytes.toString("utf8"))), bytes };
}

/** Resolve an official image tag without installing or starting Docker. */
export async function resolveDockerImage({ image, signal, fetchImpl = fetch }: { image: unknown; signal?: AbortSignal | undefined; fetchImpl?: typeof fetch }) {
  if (typeof image !== "string" || image.length > 250) throw new ServiceError("invalid_docker_image_reference");
  const reference = image.replace(/^(?:docker\.io\/)?library\//, "");
  const match = /^([a-z0-9]+(?:[._-][a-z0-9]+)*):([A-Za-z0-9_][A-Za-z0-9_.-]{0,127})$/.exec(reference);
  if (!match) throw new ServiceError("unsupported_docker_registry", "请选择 Docker Hub 官方 library 镜像并明确版本标签；私有镜像尚未接入");
  signal = signal ? AbortSignal.any([signal, AbortSignal.timeout(30000)]) : AbortSignal.timeout(30000);
  const [, name, tag] = match;
  const tokenURL = new URL("https://auth.docker.io/token"); tokenURL.search = new URLSearchParams({ service: "registry.docker.io", scope: `repository:library/${name}:pull` }).toString();
  const auth = await limitedJSON(await fetchImpl(tokenURL, { signal, redirect: "error" }), 64 * 1024);
  const token = auth.value.token ?? auth.value.access_token;
  if (typeof token !== "string" || !token || token.length > 32000) throw new ServiceError("docker_anonymous_auth_failed");
  const manifest = async (ref: string) => {
    const response = await fetchImpl(`https://registry-1.docker.io/v2/library/${name}/manifests/${encodeURIComponent(ref)}`, { signal, redirect: "error", headers: { accept: ACCEPT, authorization: `Bearer ${token}` } });
    const content = await limitedJSON(response), digest = `sha256:${serviceHash(content.bytes)}`;
    if (ref.startsWith("sha256:") && ref !== digest || response.headers.get("docker-content-digest") && response.headers.get("docker-content-digest") !== digest) throw new ServiceError("docker_manifest_digest_mismatch");
    return { ...content, digest };
  };
  const index = await manifest(tag!);
  if (!isArray(index.value.manifests)) throw new ServiceError("docker_image_platform_unverified", "镜像没有可核实的平台索引，请提供明确支持 Linux ARM64 的官方标签");
  const descriptor = objectFields(index.value.manifests.find((entry) => { const platform = objectFields(objectFields(entry).platform); return platform.os === "linux" && platform.architecture === "arm64" && (!platform.variant || platform.variant === "v8"); }));
  if (typeof descriptor.digest !== "string" || !/^sha256:[a-f0-9]{64}$/.test(descriptor.digest)) throw new ServiceError("docker_image_platform_unavailable");
  const chosen = await manifest(descriptor.digest);
  if (chosen.value.schemaVersion !== 2 || !Array.isArray(chosen.value.layers) || !objectFields(chosen.value.config).digest) throw new ServiceError("invalid_docker_image_manifest");
  return { source: "docker-hub-official", image: `docker.io/library/${name}:${tag}`, baseImage: `docker.io/library/${name}@${chosen.digest}`, digest: chosen.digest, platform: "linux/arm64", indexDigest: index.digest, verifiedAt: new Date().toISOString() };
}
