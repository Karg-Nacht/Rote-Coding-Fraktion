import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import type { OpenCodeClient } from "@opencode/client";
import { EngineManager } from "../electron/engine-manager";
import { checkEngine } from "../electron/engine-compatibility";
import { discoverEngine, downloadEngine, hasRegistrySignature, nativePackage, npmSigningKeyId, resolveEngine } from "../electron/engine-download";
import { OpenCodeSupervisor } from "../electron/supervisor";
import { Redactor } from "../electron/security";
import type { EngineCompatibility } from "../shared/engine-manager";

test("official npm metadata pins the native package and rejects prereleases and alternate origins", async () => {
  const name = "@opencode/cli-windows-x64-baseline";
  const version = "2.3.2";
  const dist = {
    tarball: "https://registry.npmjs.org/" + name + "/-/cli-windows-x64-baseline-2.3.2.tgz",
    integrity: "sha512-" + Buffer.alloc(64).toString("base64"),
    signatures: [{ keyid: "placeholder", sig: "placeholder" }],
  };
  const registry: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    assert.equal(url.origin, "https://registry.npmjs.org");
    assert.equal(init?.redirect, "error");
    return Response.json(url.pathname.startsWith("/%40opencode%2Fcli/")
      ? { name: "@opencode/cli", version, optionalDependencies: { [name]: version } }
      : { name, version, dist });
  };
  assert.equal(await discoverEngine(registry), version);
  assert.deepEqual(await resolveEngine(version, name, registry), { name, version, dist });
  dist.tarball = dist.tarball.replace("registry.npmjs.org", "elsewhere.invalid");
  await assert.rejects(resolveEngine(version, name, registry));
  await assert.rejects(discoverEngine(async () => Response.json({ name: "@opencode/cli", version: "2.3.2-beta" })));
});

test("registry signature verification binds package, version and SHA-512 integrity to a valid key", () => {
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const der = publicKey.export({ format: "der", type: "spki" });
  const keyid = npmSigningKeyId(publicKey)!;
  const key = { keyid, key: der.toString("base64"), expires: null,
    keytype: "ecdsa-sha2-nistp256", scheme: "ecdsa-sha2-nistp256" };
  const name = "@opencode/cli-windows-x64-baseline";
  const integrity = "sha512-" + Buffer.alloc(64).toString("base64");
  const sig = sign("sha256", Buffer.from(name + "@2.3.2:" + integrity), privateKey).toString("base64");
  const release = { name, version: "2.3.2", dist: { integrity, signatures: [{ keyid, sig }], tarball: "" } };
  assert.equal(hasRegistrySignature(release, { keys: [key] }), true);
  const replacement = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const replacementDer = replacement.publicKey.export({ format: "der", type: "spki" });
  const replacementSig = sign("sha256", Buffer.from(name + "@2.3.2:" + integrity), replacement.privateKey);
  assert.equal(hasRegistrySignature(
    { ...release, dist: { ...release.dist, signatures: [{ keyid, sig: replacementSig.toString("base64") }] } },
    { keys: [{ ...key, key: replacementDer.toString("base64") }] },
  ), false);
  assert.equal(hasRegistrySignature({ ...release, version: "2.3.3" }, { keys: [key] }), false);
  assert.equal(hasRegistrySignature({ ...release, dist: { ...release.dist, integrity: integrity + "x" } }, { keys: [key] }), false);
  assert.equal(hasRegistrySignature(release, { keys: [{ ...key, expires: "2000-01-01T00:00:00Z" }] }), false);
});

test("the published Windows OpenCode 2.3.2 package verifies against the real npm signing key", () => {
  const keyid = "SHA256:DhQ8wR5APBvFHLF/+Tc+AYvPOdTpcIDqOhxsBHRwC7U";
  const release = {
    name: "@opencode/cli-windows-x64-baseline",
    version: "2.3.2",
    dist: {
      tarball: "https://registry.npmjs.org/@opencode/cli-windows-x64-baseline/-/cli-windows-x64-baseline-2.3.2.tgz",
      integrity: "sha512-4hucKWMj31OpFyZUhNZBNU/YqSrZlNP8RaZtcgUuDmmvjfeYv205YEZCBVwKtR2iCkt08KImt7KLN3g3z4cjKQ==",
      signatures: [{
        keyid,
        sig: "MEQCIBgMBra8Dt7yrYArXvGcLF8vcNZWlRJzaGfqi6oSBtG5AiA+PHyAk5nlnVdrnQse3btGV9SK80RopFBs5geHzVTOqA==",
      }],
    },
  };
  const key = {
    keyid,
    key: "MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEY6Ya7W++7aUPzvMTrezH6Ycx3c+HOKYCcNGybJZSCJq/fd7Qa8uuAKtdIkUQtQiEKERhAmE5lMMJhP8OkDOa2g==",
    expires: null,
    keytype: "ecdsa-sha2-nistp256",
    scheme: "ecdsa-sha2-nistp256",
  };
  assert.equal(hasRegistrySignature(release, { keys: [key] }), true);
});

test("signed Windows archives are checked before extracting the exact executable entry", { skip: !nativePackage() }, async () => {
  const name = nativePackage()!;
  const directory = await fs.mkdtemp(path.resolve(".runtime/engine-download-fixture-"));
  const packageBin = path.join(directory, "package", "bin");
  await fs.mkdir(packageBin, { recursive: true });
  const payload = Buffer.from("fixture payload, never executed");
  await fs.writeFile(path.join(packageBin, "opencode.exe"), payload);
  await fs.writeFile(path.join(packageBin, "unrelated.txt"), "must stay in the archive");
  const tar = path.join(process.env.SystemRoot!, "System32", "tar.exe");
  const archive = path.join(directory, "fixture.tgz");
  await promisify(execFile)(tar, ["-czf", archive, "-C", directory, "package"], { windowsHide: true });
  const bytes = await fs.readFile(archive);
  const version = "2.3.2";
  const integrity = "sha512-" + createHash("sha512").update(bytes).digest("base64");
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const der = publicKey.export({ format: "der", type: "spki" });
  const keyid = npmSigningKeyId(publicKey)!;
  const sig = sign("sha256", Buffer.from(name + "@" + version + ":" + integrity), privateKey).toString("base64");
  const tarball = "https://registry.npmjs.org/" + name + "/-/" + name.split("/")[1] + "-" + version + ".tgz";
  let damaged = false;
  const registry: typeof fetch = async (input) => {
    const url = new URL(String(input));
    if (url.href === tarball) return new Response(new Uint8Array(damaged ? Buffer.from("changed") : bytes));
    if (url.pathname.endsWith("/keys")) return Response.json({ keys: [{
      keyid, key: der.toString("base64"), expires: null,
      keytype: "ecdsa-sha2-nistp256", scheme: "ecdsa-sha2-nistp256",
    }] });
    if (url.pathname.startsWith("/%40opencode%2Fcli/"))
      return Response.json({ name: "@opencode/cli", version, optionalDependencies: { [name]: version } });
    return Response.json({ name, version, dist: { tarball, integrity, signatures: [{ keyid, sig }] } });
  };
  const accepted = path.join(directory, "accepted");
  await fs.mkdir(accepted);
  assert.equal(await downloadEngine(version, accepted, registry), createHash("sha512").update(payload).digest("hex"));
  assert.deepEqual(await fs.readdir(accepted), ["opencode.exe"]);
  assert.deepEqual(await fs.readFile(path.join(accepted, "opencode.exe")), payload);
  damaged = true;
  const rejected = path.join(directory, "rejected");
  await fs.mkdir(rejected);
  await assert.rejects(downloadEngine(version, rejected, registry), /Контрольная сумма/);
  assert.deepEqual(await fs.readdir(rejected), []);
});

test("unknown releases stay read-only and a broken history contract cannot attach", async () => {
  const base = new URL("http://127.0.0.1:2000");
  const routes = {
    "/api/session": { get: { operationId: "session.list" }, post: { operationId: "session.create" } },
    "/api/session/active": { get: { operationId: "session.active" } },
    "/api/session/{sessionID}": { get: { operationId: "session.get" } },
    "/api/session/{sessionID}/message": { get: { operationId: "session.message.list" } },
    "/api/session/{sessionID}/prompt": { post: { operationId: "session.prompt" } },
    "/api/event": { get: { operationId: "event.subscribe" } },
  };
  const session = { id: "session", location: { directory: "." }, time: { updated: 1 } };
  const page = { data: [], cursor: {} };
  const client = {
    session: { list: async () => page, active: async () => ({}), get: async () => session, create: async () => session },
    message: { list: async () => page },
  } as unknown as OpenCodeClient;
  const fixture: typeof fetch = async (url) => String(url).endsWith("openapi.json")
    ? Response.json({ paths: routes })
    : new Response('data: {"type":"server.connected"}\n\n', { headers: { "content-type": "text/event-stream" } });
  const compatible = await checkEngine(client, base, {}, "2.3.99", ".", fixture);
  assert.equal(compatible.compatibility.state, "partial");
  assert.equal(compatible.compatibility.canSend, false);
  assert.equal(compatible.compatibility.checks.find((item) => item.feature === "stream")?.state, "verified");
  await assert.rejects(compatible.fetch(new URL("/api/session/session/prompt", base), { method: "POST" }));
  await assert.rejects(compatible.fetch("http://elsewhere.invalid/api/session"));
  const broken = { ...client, message: { ...client.message, list: async () => null } } as unknown as OpenCodeClient;
  assert.equal((await checkEngine(broken, base, {}, "2.3.99", ".", fixture)).compatibility.state, "incompatible");
  assert.equal((await checkEngine(client, base, {}, "2.3.99", ".", async () => new Response(null, { status: 404 }))).compatibility.state, "unchecked");
});

test("offline, current, download failure, candidate failure, profile recovery and rollback", async () => {
  const root = await fs.mkdtemp(path.resolve(".runtime/engine-manager-unit-"));
  const original = path.join(root, "engine");
  const file = (dir: string, name: string) => path.join(dir, "data", name);
  await fs.mkdir(path.join(original, "data"), { recursive: true });
  await fs.writeFile(file(original, "history"), "history on the original");
  await fs.writeFile(path.join(root, "rcf-settings"), "project and preferences");
  const base = { directory: original, binary: "bundled.exe", version: "2.3.0" };
  const compatible: EngineCompatibility = { state: "partial", canSend: false, checks: [] };
  let latest: string | undefined;
  let broken: "download" | "candidate" | "api" | "start" | undefined;
  let starts = 0;
  const engine = new OpenCodeSupervisor(original, base.binary, new Redactor(), () => {});
  const lifecycle = {
    engine, stop: async () => {},
    async start() {
      starts++;
      if (engine.directory !== original) {
        assert.equal(await fs.readFile(file(engine.directory, "history"), "utf8"), "history on the original");
        await fs.writeFile(file(engine.directory, "history"), "history after migration");
        if (broken === "start") throw new Error("fixture secret must stay out of journal");
      }
    },
  };
  const io = {
    supported: () => true,
    async discover() { if (!latest) throw new Error("fixture network offline"); return latest; },
    async download() { if (broken === "download") throw new Error("fixture download error"); return "a".repeat(128); },
    async inspect() {
      if (broken === "candidate") throw new Error("fixture cannot start");
      if (broken === "api") return { ...compatible, state: "incompatible" as const };
      return compatible;
    },
  };
  const makeManager = (external = false) => new EngineManager(path.join(root, "manager"), base, external,
    () => engine.directory === original ? "2.3.0" : "2.3.2", () => {}, io);
  const manager = makeManager();
  await manager.load();
  assert.equal((await manager.check()).error, "registry");
  latest = "2.3.0";
  assert.equal((await manager.check()).available, false);
  latest = "2.3.2";
  assert.equal((await manager.check()).available, true);
  for (const [fault, expected] of [["download", "download"], ["candidate", "candidate"], ["api", "api"]] as const) {
    broken = fault;
    const info = await manager.stage();
    assert.equal(info.error, expected);
    assert.equal(info.staged, undefined);
    if (fault === "api") assert.equal(info.rejected?.compatibility.state, "incompatible");
  }
  broken = "start";
  assert.equal((await manager.stage()).staged?.compatibility.state, "partial");
  assert.equal((await manager.activate(lifecycle)).error, "activation");
  assert.equal(engine.directory, original);
  assert.equal(await fs.readFile(file(original, "history"), "utf8"), "history on the original");
  assert.equal(starts, 2);

  broken = undefined;
  await manager.stage();
  const restored = makeManager();
  await restored.load();
  assert.equal(restored.info().staged?.version, "2.3.2");
  assert.equal((await restored.activate(lifecycle)).previous, "2.3.0");
  const moved = engine.directory;
  assert.equal((await restored.activate(lifecycle, true)).source, "bundled");
  assert.equal(engine.directory, original);
  assert.equal(await fs.readFile(file(moved, "history"), "utf8"), "history after migration");
  assert.equal(await fs.readFile(path.join(root, "rcf-settings"), "utf8"), "project and preferences");
  assert.doesNotMatch(JSON.stringify(restored.info().journal), /fixture secret/);
  const external = makeManager(true);
  await external.load();
  assert.equal(external.info().canInstall, false);
  assert.equal(external.info().previous, undefined);
});
