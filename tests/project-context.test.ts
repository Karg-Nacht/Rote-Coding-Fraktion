import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { LocalStorage } from "../electron/storage";
import {
  buildProjectEvidence,
  PROJECT_CONTEXT_LIMITS,
  ProjectContextService,
  scanProjectContext,
} from "../electron/project-context";

async function fixture(t: import("node:test").TestContext) {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), "rcf-project-context-"));
  const root = path.join(base, "workspace");
  await fs.mkdir(root);
  const storage = new LocalStorage(path.join(base, "profile"));
  t.after(async () => {
    storage.close();
    await fs.rm(base, { recursive: true, force: true });
  });
  const project = storage.addProject(root);
  async function write(name: string, content: string | Uint8Array) {
    const target = path.join(root, name);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, content);
  }
  return { base, root, project, storage, write };
}

test("registered project search ranks symbols and paths with accurate nonoverlapping lines", async (t) => {
  const { storage, project, root, write } = await fixture(t);
  const code = Array.from({ length: 42 }, (_, i) =>
    i === 17
      ? "export const restoreSelectedModel = () => savedModel;"
      : i === 20
        ? "restoreSelectedModel();"
        : `// location ${i + 1}`,
  ).join("\r\n");
  await write("src/restore-selected-model.ts", code);
  await write("README.md", "Model overview\n");
  await write("src/unrelated.ts", "export const other = 1;\n");
  const question = "Why does it lose the selected model after restart?";
  const result = await scanProjectContext(storage, project.id, question);
  assert.equal(result.files, 2);
  assert.deepEqual(
    result,
    await scanProjectContext(storage, project.id, question),
  );
  const [first, second] = result.excerpts;
  assert.equal(first.path, "src/restore-selected-model.ts");
  assert.equal(second.path, "README.md");
  assert.equal(first.startLine, 14);
  assert.equal(first.endLine, 26);
  assert.equal(
    first.text.split("\n")[18 - first.startLine],
    "export const restoreSelectedModel = () => savedModel;",
  );
  assert.match(buildProjectEvidence(result), /untrusted data/);
  assert.equal(await fs.readFile(path.join(root, first.path), "utf8"), code);
  assert.deepEqual(
    (await scanProjectContext(storage, project.id, "xylophonic")).excerpts,
    [],
  );
  await assert.rejects(
    scanProjectContext(storage, "../workspace", question),
    /Проект недоступен/,
  );
  await assert.rejects(
    scanProjectContext(storage, root, question),
    /Проект недоступен/,
  );
  await assert.rejects(
    scanProjectContext(storage, "missing", question),
    /Проект недоступен/,
  );
  storage.set(`project:${project.id}`, { managed: true });
  await assert.rejects(
    scanProjectContext(storage, project.id, question),
    /Выберите добавленный проект/,
  );
});

test("scanner excludes credentials, binary files, oversized files, hidden and generated folders, and links", async (t) => {
  const { base, storage, project, root, write } = await fixture(t);
  const marker = "needle fixture";
  for (const name of [
    "good.ts",
    ".env",
    ".env.local",
    ".git/needle.ts",
    "node_modules/needle.ts",
    "dist/needle.ts",
    "generated/needle.ts",
    ".runtime/needle.ts",
    "package-lock.json",
    "id_ed25519",
    "identity.key",
    "credentials.json",
    "service-account.json",
    "tokens.txt",
    "unknown.exe",
  ])
    await write(name, marker);
  await write(
    "pem-in-text.md",
    `${marker}\n-----BEGIN PRIVATE KEY-----\ntest\n-----END PRIVATE KEY-----`,
  );
  await write(
    "secret-in-source.ts",
    `${marker}\nconst api_key = "SYNTHETIC_FIXTURE_ONLY";`,
  );
  await write(
    "binary.txt",
    new Uint8Array([110, 101, 101, 100, 108, 101, 0, 202]),
  );
  await write(
    "oversized.ts",
    `${marker}${"x".repeat(PROJECT_CONTEXT_LIMITS.fileBytes)}`,
  );
  await fs.mkdir(path.join(base, "outside"));
  await fs.writeFile(path.join(base, "outside", "external.ts"), marker);
  await fs.symlink(
    path.join(base, "outside"),
    path.join(root, "needle-linked"),
    process.platform === "win32" ? "junction" : "dir",
  );
  await fs.link(
    path.join(base, "outside", "external.ts"),
    path.join(root, "needle-hard-link.ts"),
  );
  const result = await scanProjectContext(storage, project.id, "needle");
  assert.deepEqual(
    result.excerpts.map((excerpt) => excerpt.path),
    ["good.ts"],
  );
  assert.deepEqual(result.excluded, {
    directories: 5,
    files: 1,
    links: 2,
    oversized: 1,
    binary: 1,
    sensitive: 10,
    unavailable: 0,
  });
  await fs.rename(root, path.join(base, "renamed"));
  await assert.rejects(
    scanProjectContext(storage, project.id, "needle"),
    /Не удалось открыть папку проекта/,
  );
});

test("scanner enforces traversal, file-count, read and prompt budgets", async (t) => {
  const { storage, project, write } = await fixture(t);
  await write("a/hidden/needle.ts", "needle");
  await write("needle-a.ts", `${"wide ".repeat(100)} needle\n`);
  await write("needle-b.ts", "needle and another line\n");
  await write("needle-c.ts", "needle\n");
  const limited = async (limits: Partial<typeof PROJECT_CONTEXT_LIMITS>) =>
    scanProjectContext(storage, project.id, "needle", undefined, {
      ...PROJECT_CONTEXT_LIMITS,
      ...limits,
    });
  const result = await limited({
    depth: 1,
    scannedFiles: 2,
    files: 1,
    characters: 150,
    readBytes: 600,
  });
  assert.equal(result.files, 1);
  assert.equal(result.scannedFiles, 2);
  assert.ok(result.characters <= 150);
  assert.ok(result.truncated);
  assert.deepEqual(
    result.excerpts.map((item) => item.path),
    ["needle-b.ts"],
  );
  assert.equal((await limited({ characters: 3 })).files, 0);
  assert.equal((await limited({ readBytes: 1 })).files, 0);
  assert.equal((await limited({ entries: 2 })).files, 0);
  assert.equal((await limited({ files: 1 })).files, 1);
  assert.ok((await limited({})).excerpts.some((item) => item.clipped));
});

test("preview is cancelable and bound to the question, project, and session", async (t) => {
  const { storage, project, write } = await fixture(t);
  const service = new ProjectContextService(storage);
  t.after(() => service.close());
  await write("needle.txt", "needle preview content");
  const request = randomUUID();
  const preparing = service.prepare(project.id, "needle", request, "session");
  service.cancel(request);
  await assert.rejects(preparing, /отменена/);
  const preview = await service.prepare(
    project.id,
    "needle",
    request,
    "session",
  );
  assert.equal(preview.excerpts[0].text, "needle preview content");
  for (const args of [
    ["other", "needle", "session"],
    [project.id, "changed", "session"],
    [project.id, "needle", "other"],
  ])
    assert.throws(
      () => service.take(request, args[0], args[1], args[2]),
      /Контекст устарел/,
    );
  assert.equal(service.take(request, project.id, "needle", "session"), preview);
  assert.throws(
    () => service.take(request, project.id, "needle", "session"),
    /Контекст устарел/,
  );
});
