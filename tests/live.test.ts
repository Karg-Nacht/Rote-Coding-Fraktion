import test from "node:test";
import assert from "node:assert/strict";
import type { OpenCodeEvent } from "@opencode/client";
import { LiveProjection } from "../electron/live";
import { normalizeTimeline } from "../electron/timeline";
const event = (type: string, data: object): OpenCodeEvent =>
  ({
    id: crypto.randomUUID(),
    type,
    created: 100,
    data: { sessionID: "s", assistantMessageID: "m", ...data },
  }) as OpenCodeEvent;
test("live SSE projection streams real deltas in tool/text order and drops reasoning payloads", () => {
  const live = new LiveProjection();
  live.apply(
    event("session.step.started", {
      started: 100,
      agent: "build",
      model: { id: "fixture", providerID: "qa" },
    }),
  );
  live.apply(event("session.reasoning.started", { ordinal: 0 }));
  live.apply(
    event("session.reasoning.delta", { ordinal: 0, delta: "hidden-payload" }),
  );
  live.apply(event("session.text.started", { ordinal: 1 }));
  live.apply(event("session.text.delta", { ordinal: 1, delta: "Hello " }));
  live.apply(event("session.text.delta", { ordinal: 1, delta: "world" }));
  live.apply(event("session.tool.input.started", { id: "t", name: "unknown" }));
  live.apply(
    event("session.tool.called", {
      id: "t",
      input: { value: 42 },
      executed: false,
    }),
  );
  live.apply(
    event("session.tool.progress", {
      id: "t",
      metadata: { output: "real progress" },
    }),
  );
  const merged = live.merge("s", []);
  assert.ok(!JSON.stringify(merged).includes("hidden-payload"));
  const rows = normalizeTimeline(merged, () => undefined);
  assert.equal(rows[0].type === "text" && rows[0].text, "Hello world");
  assert.equal(
    rows[1].type === "actions" && rows[1].tools[0].output,
    "real progress",
  );
});
test("late subscriptions never invent a missing prefix; completed history replaces live projection", () => {
  const live = new LiveProjection();
  live.apply(event("session.text.delta", { ordinal: 0, delta: "suffix only" }));
  assert.deepEqual(live.merge("s", []), []);
  live.apply(
    event("session.step.started", {
      started: 100,
      agent: "build",
      model: { id: "fixture", providerID: "qa" },
    }),
  );
  live.apply(event("session.text.started", { ordinal: 0 }));
  live.apply(event("session.text.delta", { ordinal: 0, delta: "partial" }));
  const canonical = [
    {
      id: "m",
      type: "assistant" as const,
      agent: "build",
      model: { id: "fixture", providerID: "qa" },
      time: { created: 100, completed: 200 },
      content: [{ type: "text" as const, text: "authoritative complete" }],
    },
  ];
  assert.deepEqual(live.merge("s", canonical), canonical);
  live.clear();
  assert.deepEqual(live.merge("s", canonical), canonical);
});
