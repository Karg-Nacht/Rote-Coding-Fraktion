import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { LocalStorage } from "../electron/storage";
import { WorkspaceGitService } from "../electron/git";
test("SQLite preserves Unicode projects, pins, draft and exact model across restart", async () => {
  const directory = path.resolve(
    `.runtime/storage-tests/${crypto.randomUUID()}`,
  );
  const first = new LocalStorage(directory);
  const project = first.addProject(path.join(directory, "Проект"));
  first.pin("ses_fixture", true);
  first.renameProject(project.id, "Мастерская");
  first.saveDraft("ses_fixture", "Черновик\n次の行");
  first.saveDraft(`new:${project.id}`, "Старый черновик Work");
  first.savePreferences({
    projectId: project.id,
    model: {
      id: "vendor/exact-model",
      providerID: "openrouter",
      variant: "high",
    },
    mode: "autonomous",
    showProjects: false,
    chatSort: "title",
    theme: "light",
    pinnedProjects: [project.id],
  });
  first.close();
  const second = new LocalStorage(directory);
  assert.equal(second.projects()[0].name, "Мастерская");
  assert.equal(second.projects()[0].path, path.join(directory, "Проект"));
  assert.equal(second.preferences().showProjects, false);
  assert.equal(second.preferences().chatSort, "title");
  assert.equal(second.preferences().theme, "light");
  assert.deepEqual(second.preferences().pinnedProjects, [project.id]);
  assert.equal(second.pinned("ses_fixture"), true);
  assert.equal(second.draft("ses_fixture"), "Черновик\n次の行");
  assert.equal(second.draft(`new:work:${project.id}`), "Старый черновик Work");
  assert.equal(second.draft(`new:chat:${project.id}`), "");
  assert.deepEqual(second.preferences().model, {
    id: "vendor/exact-model",
    providerID: "openrouter",
    variant: "high",
  });
  second.close();
});
test("Git reports actual additions, staged files, deletion and Unicode paths; safe branch and local commit", async () => {
  const directory = path.resolve(`.runtime/git-tests/${crypto.randomUUID()}`);
  await fs.mkdir(directory, { recursive: true });
  const run = (args: string[]) =>
    execFileSync("git", args, {
      cwd: directory,
      windowsHide: true,
      stdio: "ignore",
    });
  run(["init"]);
  await fs.writeFile(path.join(directory, "данные.txt"), "first\nsecond\n");
  await fs.writeFile(path.join(directory, "delete.txt"), "gone\n");
  run(["add", "."]);
  run([
    "-c",
    "user.name=Forge QA",
    "-c",
    "user.email=qa@example.invalid",
    "commit",
    "-m",
    "fixture",
  ]);
  await fs.writeFile(
    path.join(directory, "данные.txt"),
    "first\nreplacement\nthird\n",
  );
  await fs.unlink(path.join(directory, "delete.txt"));
  await fs.writeFile(path.join(directory, "new.txt"), "new\n");
  const service = new WorkspaceGitService();
  const status = await service.status(directory);
  assert.equal(status.repository, true);
  assert.equal(status.files.length, 3);
  const unicode = status.files.find((f) => f.path === "данные.txt")!;
  assert.equal(unicode.additions, 2);
  assert.equal(unicode.deletions, 1);
  assert.match(await service.diff(directory, "данные.txt"), /\+replacement/);
  await assert.rejects(
    service.diff(directory, "../outside.txt"),
    /Недопустимый/,
  );
  await service.stage(directory, ["данные.txt"]);
  assert.ok(
    (await service.status(directory)).files
      .find((f) => f.path === "данные.txt")!
      .status.startsWith("M"),
  );
  await service.action(directory, "branch", "qa-branch");
  assert.equal((await service.status(directory)).branch, "qa-branch");
  await assert.rejects(service.action(directory, "branch", "--bad"), /имя/);
  assert.match(await service.diff(directory, "new.txt"), /\+new/);
  // Test local commit without changing the user's global Git identity.
  run([
    "-c",
    "user.name=Forge QA",
    "-c",
    "user.email=qa@example.invalid",
    "commit",
    "-m",
    "verify staging",
  ]);
  assert.equal((await service.status(directory)).files.length, 2);
});
