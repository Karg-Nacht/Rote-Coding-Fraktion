import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import http from "node:http";
import { execFileSync } from "node:child_process";
import { OpenCodeSupervisor } from "../electron/supervisor";
import { SessionCoordinator } from "../electron/coordinator";
import { LocalStorage } from "../electron/storage";
import { MediaService } from "../electron/media";
import { Redactor } from "../electron/security";
import { WorktreeService } from "../electron/worktrees";
import { AgentControlService } from "../electron/agent-control";

const dir = await fs.mkdtemp(path.join(os.tmpdir(), "rcf-integration-"));
const repo = path.join(dir, "Проект");
await fs.mkdir(repo);
const git = (...args: string[]) =>
  execFileSync("git", args, {
    cwd: repo,
    encoding: "utf8",
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
git("init");
await fs.writeFile(
  path.join(repo, "calc.ts"),
  "export const divide = (a: number, b: number) => a / b;\n",
);
await fs.writeFile(path.join(repo, "b.txt"), "base\n");
git("add", ".");
git(
  "-c",
  "user.name=RCF QA",
  "-c",
  "user.email=qa@example.invalid",
  "commit",
  "-m",
  "initial",
);
const model = { providerID: "rcfqa", id: "fixture" };
let requests = 0,
  reviewTools = -1,
  forged = false;
const server = http.createServer(async (req, res) => {
  if (!req.url?.endsWith("/chat/completions"))
    return void res.writeHead(404).end();
  let raw = "";
  for await (const chunk of req) raw += chunk;
  const body = JSON.parse(raw);
  requests++;
  const review = JSON.stringify(body.messages).includes("untrusted-diff");
  if (review) reviewTools = Math.max(reviewTools, body.tools?.length ?? 0);
  res.writeHead(200, { "Content-Type": "text/event-stream" });
  const emit = (delta: unknown, finish: string | null = null) =>
    res.write(
      `data: ${JSON.stringify({ id: "qa-" + requests, object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model: body.model, choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`,
    );
  if (review && !forged) {
    forged = true;
    emit({
      role: "assistant",
      tool_calls: [
        {
          index: 0,
          id: "forged-review",
          type: "function",
          function: {
            name: "shell",
            arguments: JSON.stringify({
              command: `echo forbidden > "${path.join(repo, "forbidden.txt").replaceAll("\\", "/")}"`,
              description: "negative test",
            }),
          },
        },
      ],
    });
    emit({}, "tool_calls");
    res.end("data: [DONE]\n\n");
    return;
  }
  emit({ role: "assistant", content: "" });
  await new Promise<void>((r) => {
    const t = setTimeout(
      r,
      /Read-only fixture|Separate worktree fixture/.test(
        JSON.stringify(body.messages),
      )
        ? 3500
        : 700,
    );
    res.once("close", () => {
      clearTimeout(t);
      r();
    });
  });
  if (res.destroyed) return;
  emit({
    content: review
      ? JSON.stringify({
          issues: [
            {
              severity: "major",
              file: "calc.ts",
              line: 1,
              description: "Division was replaced by multiplication",
              rationale: "The diff changes a / b to a * b",
              fix: "Restore division and add a regression test",
            },
          ],
          tests: "Not run; fixture provider",
          limitations: [
            "Deterministic transport fixture; not an actual model judgment",
          ],
        })
      : "RCF_ENGINE_OK",
  });
  emit({}, "stop");
  res.end("data: [DONE]\n\n");
});
await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
let storage = new LocalStorage(path.join(dir, "profile"));
let engine!: OpenCodeSupervisor,
  coordinator!: SessionCoordinator,
  worktrees!: WorktreeService,
  control!: AgentControlService;
const setup = () => {
  engine = new OpenCodeSupervisor(
    path.join(dir, "profile", "engine"),
    path.resolve(process.env.RCF_TEST_ENGINE ?? "node_modules/@opencode/cli/bin/opencode.exe"),
    new Redactor(),
    () => {},
  );
  coordinator = new SessionCoordinator(
    storage,
    engine,
    new MediaService(path.join(dir, "profile", "attachments")),
    () => {},
  );
  worktrees = new WorktreeService(storage, () => engine.ensure());
  control = new AgentControlService(
    coordinator,
    storage,
    () => engine.ensure(),
    worktrees,
  );
};
setup();
const wait = async (fn: () => Promise<boolean>, label: string) => {
  const end = Date.now() + 45000;
  while (Date.now() < end) {
    if (await fn()) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw Error("Timed out: " + label);
};
const done = async (id: string) =>
  wait(async () => {
    const c = await engine.ensure();
    const s = await c.session.get({ sessionID: id });
    return !!s.outcome && !(await c.session.active())[id];
  }, id);
const results: Record<string, unknown> = { directory: dir };
try {
  await coordinator.start();
  const project = storage.addProject(repo);
  await coordinator.customProvider({
    id: model.providerID,
    name: "RCF local fixture",
    baseUrl: `http://127.0.0.1:${(server.address() as any).port}/v1`,
    model: model.id,
    key: "rcf-fixture-not-a-real-key",
    runtime: "compatible",
    images: true,
    tools: true,
  });
  await coordinator.customProvider({
    id: model.providerID,
    name: "RCF local fixture",
    baseUrl: `http://127.0.0.1:${(server.address() as any).port}/v1`,
    model: "second-fixture",
    runtime: "compatible",
    images: true,
    tools: true,
  });
  const a = await worktrees.create(project.id, "rcf/task-a"),
    b = await worktrees.create(project.id, "rcf/task-b");
  console.log(
    "PASS official OpenCode worktree.create",
    a.directory,
    b.directory,
  );
  await fs.writeFile(
    path.join(a.directory, "calc.ts"),
    "export const divide = (a: number, b: number) => a * b;\n",
  );
  await fs.writeFile(path.join(b.directory, "b.txt"), "task B\n");
  assert.match(
    await fs.readFile(path.join(b.directory, "calc.ts"), "utf8"),
    /a \/ b/,
  );
  assert.equal(
    (await fs.readFile(path.join(a.directory, "b.txt"), "utf8")).trim(),
    "base",
  );
  assert.equal(a.branch, "rcf/task-a");
  await assert.rejects(
    worktrees.remove(project.id, a.directory),
    /несохранённые/,
  );
  results.worktreeIsolation = true;
  const main = await coordinator.create(
    project.id,
    model,
    "cautious",
    "work",
    a.directory,
  );
  await coordinator.send(
    main.id,
    "Check transport only",
    model,
    "cautious",
    [],
  );
  await done(main.id);
  assert.equal(
    (await coordinator.open(main.id)).session.directory,
    a.directory,
  );
  console.log("PASS real worktree session binding and execution");
  const defs = await control.definitions(main.id);
  assert.ok(defs.some((d) => d.id === "rcf-reader"));
  assert.ok(defs.some((d) => d.id === "rcf-reviewer"));
  results.agents = defs.map((d) => d.id);
  const reader = await control.launch(
    main.id,
    "rcf-reader",
    "Read-only fixture",
    { providerID: model.providerID, id: "second-fixture" },
  );
  const writer = await control.launch(
    main.id,
    "general",
    "Separate worktree fixture",
    model,
    b.directory,
  );
  assert.equal(writer.directory, b.directory);
  assert.equal(reader.directory, a.directory);
  assert.equal(writer.parentId, main.id);
  const active = await (await engine.ensure()).session.active();
  assert.ok(active[reader.id] && active[writer.id]);
  await assert.rejects(
    control.launch(main.id, "general", "Unsafe writer", model),
    /отдельный/,
  );
  await assert.rejects(coordinator.mode(reader.id, "full"), /расширить/);
  await Promise.all([done(reader.id), done(writer.id)]);
  const children = await control.children(main.id);
  assert.equal(children.length, 2);
  assert.ok(children.every((c) => c.status === "Completed"));
  assert.equal(
    children.find((c) => c.session.id === reader.id)?.session.model?.id,
    "second-fixture",
  );
  results.parallelChildren = true;
  console.log(
    "PASS parallel real children, independent models and authoritative completion",
  );
  await done(main.id);
  const review = await control.startReview(main.id, model);
  await done(review.id);
  const report = await control.report(review.id);
  assert.equal(reviewTools, 0);
  assert.equal(
    await fs.stat(path.join(repo, "forbidden.txt")).catch(() => undefined),
    undefined,
  );
  assert.equal(report.issues?.[0].severity, "major");
  assert.equal(report.stale, false);
  await assert.rejects(
    coordinator.send(review.id, "change policy", model, "full", []),
    /Ограниченная/,
  );
  const client = await engine.ensure();
  for (const action of ["shell", "edit", "read", "subagent", "external_tool"]) {
    const decision = await client.permission.create({
      sessionID: review.id,
      action,
      resources: ["*"],
    });
    assert.equal(decision.effect, "deny");
  }
  results.review = { report, tools: reviewTools, forgedCallBlocked: forged };
  console.log(
    "PASS independent review, deny-all engine permissions, forged shell cannot execute",
  );
  const beforeFix = (await control.history(main.id)).length;
  await control.fix(review.id);
  await done(main.id);
  assert.ok((await control.history(main.id)).length > beforeFix);
  results.manualFix = true;
  const stopped = await control.launch(
    main.id,
    "rcf-reader",
    "Read-only fixture stop test",
    model,
  );
  await coordinator.stop(stopped.id);
  await done(stopped.id);
  await done(main.id);
  assert.equal(
    (await control.children(main.id)).find((r) => r.session.id === stopped.id)
      ?.status,
    "Interrupted",
  );
  results.childStop = true;
  await fs.writeFile(
    path.join(a.directory, "calc.ts"),
    "unrelated user change\n",
  );
  assert.equal((await control.report(review.id)).stale, true);
  await assert.rejects(control.fix(review.id), /актуальный/);
  await done(main.id);
  const points = await control.checkpoints(main.id);
  assert.ok(points.length);
  const before = await fs.readFile(path.join(a.directory, "calc.ts"), "utf8");
  await control.restoreHistory(main.id, points[0].messageId);
  assert.equal(
    await fs.readFile(path.join(a.directory, "calc.ts"), "utf8"),
    before,
  );
  results.restoreFilesUntouched = true;
  console.log("PASS history-only revert preserves unrelated file content");
  const chat = await coordinator.create(project.id, model, "full", "chat");
  await assert.rejects(
    control.launch(chat.id, "general", "no", model, b.directory),
    /Work Faction/,
  );
  await assert.rejects(control.startReview(chat.id, model), /Work Faction/);
  results.chatIsolation = true;
  storage.pin(main.id, true);
  storage.savePreferences({ sessionId: main.id, projectId: project.id, model });
  await coordinator.close();
  storage.close();
  storage = new LocalStorage(path.join(dir, "profile"));
  setup();
  await coordinator.start();
  const restored = await coordinator.open(main.id);
  assert.equal(restored.session.directory, a.directory);
  assert.equal(restored.session.projectId, project.id);
  assert.ok(restored.session.pinned);
  assert.ok(
    (await coordinator.list(project.id)).sessions.some(
      (s) => s.id === reader.id,
    ),
  );
  assert.equal((await control.children(main.id)).length, 4);
  results.restart = true;
  results.projectId = project.id;
  results.sessionId = main.id;
  results.writerId = writer.id;
  results.reviewId = review.id;
  results.requests = requests;
  console.log(
    "PASS fresh storage, coordinator and engine restart restores worktrees and children",
  );
  const removable = await worktrees.create(project.id, "rcf/removable");
  const retained = await coordinator.create(
    project.id,
    model,
    "cautious",
    "work",
    removable.directory,
  );
  await worktrees.remove(project.id, removable.directory);
  assert.equal((await coordinator.open(retained.id)).session.id, retained.id);
  results.removedWorktreeHistory = true;
  await coordinator.open(main.id);
  await fs.mkdir("test-results", { recursive: true });
  await fs.writeFile(
    "test-results/rcf-integration.json",
    JSON.stringify(results, null, 2),
  );
  console.log("ALL RCF INTEGRATION CHECKS PASSED");
} finally {
  await coordinator!.close().catch(() => {});
  storage.close();
  server.closeAllConnections();
  await new Promise<void>((r) => server.close(() => r()));
}
