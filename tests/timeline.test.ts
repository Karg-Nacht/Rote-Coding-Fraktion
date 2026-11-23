import test from "node:test";
import assert from "node:assert/strict";
import type {
  SessionMessageAssistant,
  SessionMessageInfo,
} from "@opencode/client";
import { normalizeTimeline } from "../electron/timeline";
import { activityGroups, activityRows } from "../shared/activity";
import { permissionRules } from "../shared/permissions";
import {
  Redactor,
  contained,
  safeExternal,
  safeFile,
} from "../electron/security";
import fs from "node:fs/promises";
import path from "node:path";
const assistant = (id: string, content: unknown[]): SessionMessageAssistant =>
  ({
    id,
    type: "assistant",
    agent: "build",
    model: { id: "fixture", providerID: "test" },
    time: { created: 100 },
    content,
  }) as SessionMessageAssistant;
const tool = (id: string, name = "shell", status = "completed") => ({
  type: "tool",
  id,
  name,
  time: { created: 100, ran: 110, completed: 130 },
  state: {
    status,
    input: { command: "node check.mjs", workdir: "C:\\fixture" },
    content: [{ type: "text", text: "OK" }],
    metadata: { exit: 0 },
  },
});
test("normalizer preserves text/tool order and never exposes reasoning", () => {
  const source = [
    assistant("m1", [
      { type: "reasoning", text: "private internal text" },
      { type: "text", text: "Inspecting" },
      tool("t1"),
      tool("t2", "read"),
      { type: "text", text: "Done" },
    ]),
  ];
  const rows = normalizeTimeline(source, () => undefined);
  assert.deepEqual(
    rows.map((r) => r.type),
    ["text", "actions", "text", "run"],
  );
  assert.equal(rows[1].type === "actions" && rows[1].tools.length, 2);
  assert.equal(JSON.stringify(rows).includes("private internal text"), false);
  assert.deepEqual(
    rows,
    normalizeTimeline(source, () => undefined),
  );
});
test("unknown tools remain inspectable and errors retain details", () => {
  const rows = normalizeTimeline(
    [
      assistant("m1", [
        tool("t1", "mcp_unknown"),
        {
          ...tool("t2"),
          state: {
            status: "error",
            input: {},
            error: { type: "Failure", message: "fixture failed" },
          },
        },
      ]),
    ],
    () => undefined,
  );
  assert.equal(rows[0].type, "actions");
  if (rows[0].type !== "actions") return;
  assert.equal(rows[0].tools[0].category, "other");
  assert.equal(rows[0].tools[1].output, "fixture failed");
  assert.equal(rows[0].tools[0].exit, "0");
});
test("activity preserves long stages, execution boundaries and relative paths", () => {
  const directory = "C:\\fixture";
  const read = (id: string, file: string) => ({
    ...tool(id, "read"),
    state: { ...tool(id).state, input: { path: file } },
  });
  const command = (id: string, command: string, exit = 0) => ({
    ...tool(id),
    state: { ...tool(id).state, input: { command }, metadata: { exit } },
  });
  const first = assistant("long", [
    ...Array.from({ length: 121 }, (_, i) =>
      read(`read-${i}`, `${directory}\\src${i}\\index.ts`),
    ),
    command("check", "npm.cmd run test:unit"),
    command("fail", "node --test", 2),
    command("echo", "echo npm test"),
  ]);
  const rows = normalizeTimeline(
    [
      first,
      assistant("same-agent", [
        read("later", "C:\\fixture-external\\index.ts"),
        read("relative", "sub/index.ts"),
      ]),
      { ...assistant("other-agent", [tool("explore")]), agent: "explore" },
      assistant("text-break", [
        { type: "text", text: "Next phase" },
        tool("next"),
      ]),
    ],
    () => undefined,
    undefined,
    false,
    directory,
  );
  const stages = rows.filter((row) => row.type === "actions");
  assert.deepEqual(
    stages.map((row) => row.tools.length),
    [126, 1, 1],
  );
  const groups = activityGroups(stages[0].tools);
  assert.deepEqual(
    groups.map((group) => [group.kind, group.tools.length]),
    [
      ["read", 121],
      ["check", 2],
      ["shell", 1],
      ["read", 2],
    ],
  );
  assert.equal(groups[0].tools[0].path?.display, "src0/index.ts");
  assert.equal(groups[0].tools[1].path?.full, "C:\\fixture\\src1\\index.ts");
  assert.equal(
    groups.at(-1)?.tools[0].path?.display,
    "C:\\fixture-external\\index.ts",
  );
  assert.deepEqual(groups.at(-1)?.tools[1].path, {
    display: "sub/index.ts",
    full: "C:\\fixture\\sub\\index.ts",
  });
  assert.deepEqual(
    activityRows(rows, true)
      .filter((row) => row.type === "actions")
      .map((row) => row.id),
    [stages[0].id],
  );
});
test("only completed file tools receive their own redacted diff evidence", () => {
  const patch = "@@ -1 +1 @@\n-before\n+PRIVATE\n";
  const move = {
    ...tool("move", "patch"),
    state: {
      ...tool("move").state,
      input: { patchText: "*** Update File: old.txt\n*** Move to: new.txt\n" },
      metadata: {
        files: [{ file: "new.txt", patch, additions: 1, deletions: 1 }],
      },
    },
  };
  const rows = normalizeTimeline(
    [
      assistant("m1", [
        {
          ...move,
          id: "in-flight",
          state: { ...move.state, status: "running" },
        },
        move,
        { ...move, id: "other", name: "shell" },
      ]),
    ],
    () => undefined,
    (text) => text.replaceAll("PRIVATE", "[redacted]"),
    true,
  );
  const actions = rows[0];
  assert.equal(actions.type, "actions");
  if (actions.type !== "actions") return;
  assert.equal(actions.tools[0].changes, undefined);
  assert.equal(actions.tools[2].changes, undefined);
  assert.deepEqual(actions.tools[1].changes, [
    {
      file: "new.txt",
      previousFile: "old.txt",
      status: "renamed",
      patch: patch.replace("PRIVATE", "[redacted]"),
      additions: 1,
      deletions: 1,
      more: undefined,
    },
  ]);
});
test("run summaries hide model switches and combine interruption events without marking cancellation as an error", () => {
  const firstModel = { providerID: "qa", id: "first", variant: "medium" };
  const secondModel = { providerID: "qa", id: "second" };
  const source = [
    {
      id: "switch1",
      type: "model-switched",
      model: firstModel,
      time: { created: 1000 },
    },
    { id: "u1", type: "user", text: "Первый запрос", time: { created: 2000 } },
    {
      ...assistant("a1", []),
      model: firstModel,
      time: { created: 3000 },
      error: { type: "interrupted", message: "Step interrupted" },
    },
    {
      id: "stop",
      type: "idle",
      outcome: "interrupted",
      time: { created: 14000 },
    },
    {
      id: "switch2",
      type: "model-switched",
      model: secondModel,
      time: { created: 15000 },
    },
    { id: "u2", type: "user", text: "Второй запрос", time: { created: 16000 } },
    {
      ...assistant("a2", [{ type: "text", text: "Привет!" }]),
      model: secondModel,
      time: { created: 17000 },
    },
    {
      id: "done",
      type: "idle",
      outcome: "succeeded",
      time: { created: 21000 },
    },
  ] as SessionMessageInfo[];
  const rows = normalizeTimeline(source, () => undefined);
  assert.deepEqual(
    rows.map((r) => r.type),
    ["user", "run", "user", "text", "run"],
  );
  const stopped = rows[1],
    done = rows[4];
  assert.equal(stopped.type, "run");
  assert.equal(done.type, "run");
  if (stopped.type !== "run" || done.type !== "run") return;
  assert.equal(stopped.text, "Остановлено");
  assert.equal(stopped.status, "interrupted");
  assert.equal(stopped.duration, 12000);
  assert.ok(stopped.details.some((d) => d.text.includes("qa/first")));
  assert.ok(
    !stopped.details.some(
      (d) => d.text.includes("qa/second") || d.status === "error",
    ),
  );
  assert.equal(done.duration, 5000);
  assert.equal(done.text, "Готово");
  assert.deepEqual(
    done.details.map((d) => d.text),
    ["Модель: qa/second"],
  );
});
test("real provider errors stay visible, deduplicate idle errors and remain distinct from a user interruption", () => {
  const error = {
    type: "provider.auth",
    message: "Provider rejected the request",
  };
  const source = [
    { id: "u", type: "user", text: "Запрос", time: { created: 0 } },
    { ...assistant("a", []), error },
    {
      id: "end",
      type: "idle",
      outcome: "failed",
      error,
      time: { created: 200 },
    },
  ] as SessionMessageInfo[];
  const rows = normalizeTimeline(source, () => undefined);
  const visibleErrors = rows.filter(
    (r) => r.type === "system" && r.status === "error",
  );
  assert.equal(visibleErrors.length, 1);
  assert.equal(
    visibleErrors[0].type === "system" && visibleErrors[0].text,
    error.message,
  );
  const summary = rows.at(-1);
  assert.equal(summary?.type === "run" && summary.status, "failed");
  assert.equal(
    summary?.type === "run" &&
      summary.details.filter((d) => d.status === "error").length,
    1,
  );
  const providerInterruption = normalizeTimeline(
    [
      {
        ...assistant("provider", []),
        error: { type: "provider.auth", message: "Step interrupted" },
      },
    ],
    () => undefined,
  );
  assert.ok(
    providerInterruption.some(
      (r) => r.type === "system" && r.status === "error",
    ),
  );
});
test("live run details preserve a stable identity, retries and redaction without exposing reasoning", () => {
  const source = [
    { id: "u", type: "user", text: "Запрос", time: { created: 0 } },
    {
      ...assistant("a", [
        { type: "reasoning", text: "secret reasoning" },
        { type: "text", text: "Ответ" },
      ]),
      retry: {
        attempt: 2,
        at: 110,
        error: { type: "provider.rate_limit", message: "private-key" },
      },
    },
    {
      id: "sys",
      type: "system",
      text: "Instructions updated",
      time: { created: 120 },
    },
  ] as SessionMessageInfo[];
  const running = normalizeTimeline(
    source,
    () => undefined,
    (text) => text.replaceAll("private-key", "[скрыто]"),
    true,
  );
  const summary = running.at(-1);
  assert.equal(summary?.type === "run" && summary.status, "running");
  assert.ok(
    summary?.type === "run" &&
      summary.details.some((d) => d.text.includes("[скрыто]")),
  );
  assert.equal(JSON.stringify(running).includes("secret reasoning"), false);
  assert.equal(JSON.stringify(running).includes("private-key"), false);
  const completed = normalizeTimeline(
    [
      ...source,
      {
        id: "idle",
        type: "idle",
        outcome: "succeeded",
        time: { created: 500 },
      },
    ],
    () => undefined,
  );
  assert.equal(summary?.id, completed.at(-1)?.id);
});
test("an aborted upstream request that ends in failure keeps its visible cause", () => {
  const rows = normalizeTimeline(
    [
      { id: "u", type: "user", text: "Запрос", time: { created: 0 } },
      {
        ...assistant("a", []),
        error: { type: "AbortError", message: "Upstream request timed out" },
      },
      { id: "end", type: "idle", outcome: "failed", time: { created: 200 } },
    ] as SessionMessageInfo[],
    () => undefined,
  );
  assert.ok(
    rows.some(
      (r) =>
        r.type === "system" &&
        r.status === "error" &&
        r.text.includes("timed out"),
    ),
  );
  const summary = rows.at(-1);
  assert.equal(summary?.type === "run" && summary.status, "failed");
  assert.ok(
    summary?.type === "run" &&
      summary.details.some((d) => d.status === "error"),
  );
});
test("a stop reason reported only by the idle event remains available in neutral details", () => {
  const rows = normalizeTimeline(
    [
      { id: "u", type: "user", text: "Запрос", time: { created: 0 } },
      {
        id: "idle",
        type: "idle",
        outcome: "interrupted",
        error: { type: "interrupted", message: "Request cancelled" },
        time: { created: 200 },
      },
    ] as SessionMessageInfo[],
    () => undefined,
  );
  assert.equal(
    rows.some((r) => r.type === "system" && r.status === "error"),
    false,
  );
  const summary = rows.at(-1);
  assert.ok(
    summary?.type === "run" &&
      summary.details.some(
        (d) =>
          d.text.includes("Request cancelled") && d.status === "interrupted",
      ),
  );
});
test("viewed images require successful read evidence and accessible media", () => {
  const read = {
    ...tool("t"),
    name: "read",
    state: {
      status: "completed",
      input: { path: "x.png" },
      content: [{ type: "file", uri: "file:///x.png", mime: "image/png" }],
    },
  };
  const absent = normalizeTimeline([assistant("m", [read])], () => undefined);
  const present = normalizeTimeline(
    [assistant("m", [read])],
    () => "forge-media://token",
  );
  assert.equal(
    absent[0].type === "actions" && absent[0].tools[0].category,
    "read",
  );
  assert.equal(
    present[0].type === "actions" && present[0].tools[0].category,
    "image",
  );
});
test("10000 source operations normalize deterministically within a bounded time", () => {
  const content = Array.from({ length: 10000 }, (_, i) =>
    i % 3 === 0 ? { type: "text", text: `Paragraph ${i}` } : tool(`t${i}`),
  );
  const start = performance.now();
  const rows = normalizeTimeline(
    [assistant("large", content)],
    () => undefined,
  );
  assert.ok(rows.length > 6000);
  assert.ok(performance.now() - start < 2000);
  assert.deepEqual(
    rows,
    normalizeTimeline([assistant("large", content)], () => undefined),
  );
});
test("all modes produce real V2 rules, caution requests writes, autonomous asks external access", () => {
  const resolve = (
    mode: "cautious" | "autonomous" | "full",
    action: string,
    resource: string,
  ) =>
    permissionRules(mode)
      .filter((rule) => rule.action === "*" || rule.action === action)
      .filter((rule) =>
        new RegExp(
          `^${rule.resource
            .split("*")
            .map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
            .join(".*")}$`,
        ).test(resource),
      )
      .at(-1)?.effect;
  assert.equal(resolve("cautious", "edit", "main.ts"), "ask");
  assert.equal(resolve("autonomous", "edit", "main.ts"), "allow");
  assert.equal(
    resolve("autonomous", "external_directory", "C:/private/*"),
    "ask",
  );
  assert.equal(resolve("autonomous", "shell", "git push origin main"), "ask");
  assert.equal(resolve("full", "external_directory", "C:/private/*"), "allow");
});
test("URL and path gates reject unwanted schemes and traversal", () => {
  assert.equal(safeExternal("https://example.com/a"), "https://example.com/a");
  for (const url of [
    "file:///C:/Windows",
    "javascript:alert(1)",
    "https://user:pass@example.com",
    "data:text/html,<h1>x</h1>",
  ])
    assert.throws(() => safeExternal(url));
  assert.equal(
    contained(path.resolve("root"), path.resolve("root/file.txt")),
    true,
  );
  assert.equal(
    contained(path.resolve("root"), path.resolve("root-other/file.txt")),
    false,
  );
});
test("media file gate resolves Windows junctions before granting access", async () => {
  const root = path.resolve(".runtime/security-tests/root"),
    outside = path.resolve(".runtime/security-tests/outside");
  await fs.mkdir(root, { recursive: true });
  await fs.mkdir(outside, { recursive: true });
  await fs.writeFile(path.join(outside, "secret.txt"), "fixture");
  const link = path.join(root, "escape");
  await fs
    .symlink(outside, link, "junction")
    .catch((e: NodeJS.ErrnoException) => {
      if (e.code !== "EEXIST") throw e;
    });
  await assert.rejects(safeFile(root, "escape/secret.txt"), /за пределами/);
});
test("secrets are removed from service errors and timeline values", () => {
  const redactor = new Redactor();
  redactor.add("fixture-secret-key");
  assert.equal(redactor.text("key=fixture-secret-key"), "key=[скрыто]");
  assert.ok(
    !redactor
      .error(new Error("Bearer a2345678901234567890"))
      .includes("a2345678901234567890"),
  );
});
