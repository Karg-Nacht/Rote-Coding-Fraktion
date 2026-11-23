import test from "node:test";
import assert from "node:assert/strict";
import { formatToolOutput } from "../shared/tool-output";
import { explainError } from "../shared/errors";
import { normalizeTimeline } from "../electron/timeline";
import type { SessionMessageInfo } from "@opencode/client";

test("subagent envelopes become readable text and structured private reasoning fields are removed", () => {
  const encoded = JSON.stringify({
    content: [
      {
        type: "text",
        text: JSON.stringify({ output: "Первая строка\nВторая строка" }),
      },
    ],
    reasoning: "PRIVATE_REASONING_SENTINEL",
  });
  assert.equal(formatToolOutput(encoded), "Первая строка\nВторая строка");
  assert.equal(
    formatToolOutput({
      result: { status: "ok" },
      reasoning: "PRIVATE_REASONING_SENTINEL",
    }).includes("PRIVATE_REASONING_SENTINEL"),
    false,
  );
});
test("provider failures distinguish cooldown, authentication, quotas and network without altering selected model", () => {
  assert.match(
    explainError("All credentials are cooling down").title,
    /приостановил/,
  );
  assert.match(explainError("HTTP 401 User not found").title, /авторизацию/);
  assert.match(explainError("Free usage limit reached").title, /лимит/);
  assert.match(explainError("ECONNREFUSED").title, /связи/);
});
test("active reasoning gets a neutral title from the event and no private text; inactive orphan run is interrupted", () => {
  const messages = [
    { id: "u", type: "user", text: "Task", time: { created: 1 } },
    {
      id: "a",
      type: "assistant",
      agent: "build",
      model: { providerID: "qa", id: "qa" },
      time: { created: 2 },
      content: [{ type: "reasoning", text: "PRIVATE_REASONING_SENTINEL" }],
    },
  ] as SessionMessageInfo[];
  const active = normalizeTimeline(
    messages,
    () => undefined,
    (s) => s,
    true,
  );
  const activeRun = active.at(-1);
  assert.equal(activeRun?.type === "run" && activeRun.text, "Обрабатывает запрос");
  assert.equal(
    JSON.stringify(active).includes("PRIVATE_REASONING_SENTINEL"),
    false,
  );
  const stopped = normalizeTimeline(messages, () => undefined);
  const stoppedRun = stopped.at(-1);
  assert.equal(stoppedRun?.type === "run" && stoppedRun.status, "interrupted");
});
