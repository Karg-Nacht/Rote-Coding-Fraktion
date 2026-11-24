import test from "node:test";
import assert from "node:assert/strict";
import metadata from "../package.json";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { LocalStorage } from "../electron/storage";
import { WorktreeService } from "../electron/worktrees";
import { parseReview, agentStatus } from "../shared/rcf";
import {
  LEGACY_PROFILE,
  PRODUCT_NAME,
  PRODUCT_VERSION,
} from "../shared/branding";
import {
  READER_PERMISSIONS,
  REVIEW_PERMISSIONS,
} from "../electron/agent-control";
import { workspacePermissions } from "../shared/permissions";
import {sessionMetrics} from '../electron/metrics';
test('Session details retain real provider failures but do not reintroduce neutral interruption diagnostics',()=>{
  const info={tokens:{input:100,output:10,reasoning:2,cache:{read:20,write:0}},cost:0.001} as Parameters<typeof sessionMetrics>[0];
  const messages=[{type:'assistant',error:{type:'Interrupted',message:'Step interrupted'},tokens:{input:50,output:10,reasoning:2,cache:{read:20,write:0}}},{type:'assistant',error:{type:'provider.http',message:'HTTP 401'}}] as Parameters<typeof sessionMetrics>[1];
  const metrics=sessionMetrics(info,messages,true);assert.deepEqual(metrics.errors,['HTTP 401']);assert.equal(metrics.input,100);assert.equal(metrics.contextInput,70);assert.equal(metrics.partial,true);
});
test("RCF keeps the legacy profile and database, task bindings and all prior state after reopening", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "rcf-storage-"));
  let db = new LocalStorage(dir);
  const project = db.addProject(path.join(dir, "Проект"));
  db.bindDirectory(project.id, path.join(dir, "ветка"));
  db.pin("old-session", true);
  db.saveDraft("old-session", "旧 черновик");
  db.savePreferences({ model: { providerID: "exact", id: "vendor/model" } });
  db.close();
  db = new LocalStorage(dir);
  assert.deepEqual(db.taskDirectories(project.id), [path.join(dir, "ветка")]);
  assert.ok(db.pinned("old-session"));
  assert.equal(db.draft("old-session"), "旧 черновик");
  assert.equal(db.preferences().model?.id, "vendor/model");
  assert.ok((await fs.stat(path.join(dir, "forge.sqlite"))).isFile());
  db.close();
  assert.equal(LEGACY_PROFILE, "Forge Agent");
  assert.equal(PRODUCT_NAME, "Rote Coding Fraktion");
  assert.equal(PRODUCT_VERSION, metadata.version);
});
test("Worktree removal refuses tracked, untracked, ignored changes and root; clean removal preserves branch", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "rcf-git-"));
  const root = path.join(dir, "repo"),
    tree = path.join(dir, "tree");
  await fs.mkdir(root);
  const git = (...args: string[]) =>
    execFileSync("git", args, {
      cwd: root,
      windowsHide: true,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  git("init");
  await fs.writeFile(path.join(root, "a.txt"), "original\n");
  await fs.writeFile(path.join(root, ".gitignore"), "ignored.txt\n");
  git("add", ".");
  git(
    "-c",
    "user.name=RCF QA",
    "-c",
    "user.email=qa@example.invalid",
    "commit",
    "-m",
    "fixture",
  );
  git("worktree", "add", "-b", "rcf/test", tree);
  const db = new LocalStorage(path.join(dir, "profile"));
  const p = db.addProject(root);
  const service = new WorktreeService(
    db,
    async () => ({ session: { active: async () => ({}) } }) as any,
  );
  const original = await fs.readFile(path.join(tree, "a.txt"));
  assert.equal((await service.list(p.id)).length, 2);
  await assert.rejects(service.remove(p.id, root), /Основную/);
  for (const file of ["a.txt", "untracked.txt", "ignored.txt"]) {
    await fs.writeFile(path.join(tree, file), "changed");
    await assert.rejects(service.remove(p.id, tree), /несохранённые/);
    if (file === "a.txt") await fs.writeFile(path.join(tree, file), original);
    else await fs.unlink(path.join(tree, file));
  }
  await service.select(p.id, tree);
  db.close();
  const restored = new LocalStorage(path.join(dir, "profile"));
  assert.equal(restored.taskDirectories(p.id)[0], await fs.realpath(tree));
  await new WorktreeService(
    restored,
    async () => ({ session: { active: async () => ({}) } }) as any,
  ).remove(p.id, tree);
  assert.match(git("branch", "--list", "rcf/test"), /rcf\/test/);
  assert.equal(await fs.stat(tree).catch(() => undefined), undefined);
  restored.close();
});
test("Review parser never invents counts, malformed findings or successful child completion", () => {
  assert.equal(parseReview("All looks good").issues, undefined);
  assert.equal(
    parseReview('{"issues":[{"severity":"major"}],"limitations":[]}').issues,
    undefined,
  );
  const result = parseReview(
    '```json\n{"issues":[{"severity":"major","file":"a.ts","line":2,"description":"fault","rationale":"evidence","fix":"correction"}],"tests":"Not run","limitations":[]}\n```',
  );
  assert.equal(result.issues?.length, 1);
  assert.equal(result.tests, "Not run");
  assert.equal(agentStatus({ running: false }), "Waiting");
  assert.equal(agentStatus({ running: false, busy: 1 }), "Unknown");
  assert.equal(agentStatus({ running: true, outcome: "succeeded" }), "Running");
  assert.equal(
    agentStatus({ running: false, outcome: "interrupted" }),
    "Interrupted",
  );
});
test("Review denies every tool and readers deny shell, edits, external tools and delegation; Chat stays denied", () => {
  const effect = (rules: typeof REVIEW_PERMISSIONS, action: string) =>
    [...rules].reverse().find((r) => r.action === action || r.action === "*")
      ?.effect;
  for (const action of [
    "shell",
    "edit",
    "subagent",
    "read",
    "server_tool",
    "execute",
  ])
    assert.equal(effect(REVIEW_PERMISSIONS, action), "deny");
  for (const action of [
    "shell",
    "edit",
    "subagent",
    "server_tool",
    "execute",
    "external_directory",
  ])
    assert.equal(
      effect(READER_PERMISSIONS as typeof REVIEW_PERMISSIONS, action),
      "deny",
    );
  for (const mode of ["cautious", "autonomous", "full"] as const)
    assert.deepEqual(workspacePermissions("chat", mode), REVIEW_PERMISSIONS);
});
