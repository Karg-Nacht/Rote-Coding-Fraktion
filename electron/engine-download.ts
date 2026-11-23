import { createHash, createPublicKey, verify, type KeyObject } from "node:crypto";
import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as NodeReadableStream } from "node:stream/web";
import { z } from "zod";
import { STABLE_ENGINE_VERSION } from "./engine-compatibility";
import { sha512 } from "./supervisor";

const registry = "https://registry.npmjs.org";
const cli = "@opencode/cli";
const mib = 1024 * 1024;
const signingScheme = "ecdsa-sha2-nistp256";
const stable = z.string().regex(STABLE_ENGINE_VERSION);
const distSchema = z.object({
  tarball: z.url(),
  integrity: z.string().regex(/^sha512-[A-Za-z0-9+/]{86}==$/),
  signatures: z.array(z.object({ keyid: z.string(), sig: z.string() })).min(1),
});
const keysSchema = z.object({
  keys: z.array(z.object({
    keyid: z.string(),
    key: z.string(),
    keytype: z.string(),
    scheme: z.string(),
    expires: z.string().nullable(),
  })),
});

export type EngineRelease = { version: string; name: string; dist: z.infer<typeof distSchema> };

export class EngineVerificationError extends Error {
  constructor(readonly reason: "signature" | "integrity", message: string) {
    super(message);
  }
}

export function nativePackage(platform = process.platform, arch = process.arch) {
  if (platform !== "win32") return undefined;
  if (arch === "x64") return "@opencode/cli-windows-x64-baseline";
  if (arch === "arm64") return "@opencode/cli-windows-arm64";
}

export function compareVersions(a: string, b: string) {
  const left = a.split(".").map(Number), right = b.split(".").map(Number);
  return left[0] - right[0] || left[1] - right[1] || left[2] - right[2];
}

function bounded(max: number) {
  let length = 0;
  return new Transform({
    transform(chunk, _encoding, done) {
      length += chunk.length;
      if (length > max) done(new Error("Файл OpenCode превышает допустимый размер."));
      else done(null, chunk);
    },
  });
}

async function registryResponse(route: string, timeout: number, fetcher: typeof fetch) {
  const url = new URL(route, registry);
  if (url.origin !== registry || url.username || url.password)
    throw new Error("Источник OpenCode не прошёл проверку.");
  const response = await fetcher(url, { redirect: "error", signal: AbortSignal.timeout(timeout) });
  if (!response.ok || !response.body) {
    void response.body?.cancel();
    throw new Error("Не удалось получить данные из реестра OpenCode.");
  }
  return response.body as NodeReadableStream<Uint8Array>;
}

async function registryJson(route: string, fetcher: typeof fetch) {
  const body = Readable.fromWeb(await registryResponse(route, 20000, fetcher));
  const limited = bounded(2 * mib);
  const chunks: Buffer[] = [];
  limited.on("data", (chunk: Buffer) => chunks.push(chunk));
  await pipeline(body, limited);
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
}

const packageRoute = (name: string, version: string) => "/" + encodeURIComponent(name) + "/" + version;

export async function discoverEngine(fetcher: typeof fetch = fetch) {
  const release = await registryJson(packageRoute(cli, "latest"), fetcher);
  return z.object({ name: z.literal(cli), version: stable }).parse(release).version;
}

export async function resolveEngine(version: string, name: string, fetcher: typeof fetch = fetch) {
  stable.parse(version);
  if (![nativePackage("win32", "x64"), nativePackage("win32", "arm64")].includes(name))
    throw new Error("Установка для этой платформы недоступна.");
  const wrapper = z.object({
    name: z.literal(cli), version: z.literal(version), optionalDependencies: z.record(z.string(), z.string()),
  }).parse(await registryJson(packageRoute(cli, version), fetcher));
  if (wrapper.optionalDependencies[name] !== version)
    throw new Error("Официальный пакет не содержит двоичный файл для этой платформы.");
  const release = z.object({ version: z.literal(version), name: z.literal(name), dist: distSchema })
    .parse(await registryJson(packageRoute(name, version), fetcher));
  const expectedFile = name.split("/")[1] + "-" + version + ".tgz";
  const archive = new URL(release.dist.tarball);
  if (archive.origin !== registry || archive.username || archive.password || archive.search || archive.hash ||
    archive.pathname !== "/" + name + "/-/" + expectedFile)
    throw new Error("Адрес архива OpenCode не прошёл проверку.");
  return release;
}

export function npmSigningKeyId(publicKey: KeyObject) {
  if (publicKey.asymmetricKeyType !== "ec") return undefined;
  const { crv, x, y } = publicKey.export({ format: "jwk" });
  if (crv !== "P-256" || !x || !y) return undefined;
  const point = Buffer.concat([Buffer.of(4), Buffer.from(x, "base64url"), Buffer.from(y, "base64url")]);
  // The registry fingerprints the SSH wire key, including the length of
  // each field. The same public key encoded as SPKI has a different hash.
  const hash = createHash("sha256");
  for (const field of [Buffer.from(signingScheme), Buffer.from("nistp256"), point]) {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(field.length);
    hash.update(length).update(field);
  }
  return "SHA256:" + hash.digest("base64").replace(/=+$/, "");
}

export function hasRegistrySignature(release: EngineRelease, document: unknown, now = Date.now()) {
  const { keys } = keysSchema.parse(document);
  const signed = Buffer.from(release.name + "@" + release.version + ":" + release.dist.integrity);
  return release.dist.signatures.some(({ keyid, sig }) => keys.some((key) => {
    if (key.keyid !== keyid || key.keytype !== signingScheme || key.scheme !== key.keytype ||
      (key.expires !== null && !(Date.parse(key.expires) > now))) return false;
    try {
      const publicKey = createPublicKey({ key: Buffer.from(key.key, "base64"), format: "der", type: "spki" });
      return npmSigningKeyId(publicKey) === keyid && verify("sha256", signed, publicKey, Buffer.from(sig, "base64"));
    } catch {
      return false;
    }
  }));
}

async function extractBinary(archive: string, binary: string) {
  const system = process.env.SystemRoot;
  if (!system || !path.isAbsolute(system)) throw new Error("Не найден системный распаковщик Windows.");
  const child = spawn(path.join(system, "System32", "tar.exe"),
    ["-xOzf", archive, "package/bin/opencode.exe"],
    { windowsHide: true, stdio: ["ignore", "pipe", "ignore"], signal: AbortSignal.timeout(60000) });
  const completed = new Promise<void>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code) => code === 0 ? resolve() : reject(new Error("Архив OpenCode не удалось распаковать.")));
  });
  try {
    await Promise.all([completed, pipeline(child.stdout, bounded(350 * mib), createWriteStream(binary, { flags: "wx" }))]);
  } finally {
    if (child.exitCode === null) child.kill();
  }
}

export async function downloadEngine(version: string, directory: string, fetcher: typeof fetch = fetch) {
  const name = nativePackage();
  if (!name) throw new Error("Установка для этой платформы недоступна.");
  const release = await resolveEngine(version, name, fetcher);
  const keys = await registryJson("/-/npm/v1/keys", fetcher);
  if (!hasRegistrySignature(release, keys))
    throw new EngineVerificationError("signature", "Подпись npm для OpenCode не прошла проверку.");
  const archive = path.join(directory, "engine.tgz");
  const binary = path.join(directory, "opencode.exe");
  try {
    const body = await registryResponse(release.dist.tarball, 180000, fetcher);
    await pipeline(Readable.fromWeb(body), bounded(192 * mib), createWriteStream(archive, { flags: "wx" }));
    const integrity = "sha512-" + Buffer.from(await sha512(archive), "hex").toString("base64");
    if (integrity !== release.dist.integrity)
      throw new EngineVerificationError("integrity", "Контрольная сумма архива OpenCode не совпадает.");
    await extractBinary(archive, binary);
    if (!(await fs.stat(binary)).size) throw new Error("Архив OpenCode не содержит двоичный файл.");
    return await sha512(binary);
  } finally {
    await fs.rm(archive, { force: true });
  }
}
