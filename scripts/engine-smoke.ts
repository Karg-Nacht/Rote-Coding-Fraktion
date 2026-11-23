import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import { OpenCodeSupervisor } from "../electron/supervisor";
import { SessionCoordinator } from "../electron/coordinator";
import { LocalStorage } from "../electron/storage";
import { MediaService } from "../electron/media";
import { Redactor } from "../electron/security";
import { permissionRules } from "../shared/permissions";

const waitFor = async <T>(
  run: () => Promise<T | undefined | false>,
  timeout = 15000,
): Promise<T> => {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = await run();
    if (value) return value;
    await new Promise((r) => setTimeout(r, 60));
  }
  throw new Error("Timed out waiting for verified engine state");
};
const directory = path.resolve(`.runtime/engine-smoke-${process.pid}`);
const projectPath = path.join(directory, "Проект");
await fs.mkdir(projectPath, { recursive: true });
await fs.mkdir("test-results", { recursive: true });
let requests = 0;
let sawKey = false;
const provider = http.createServer(async (request, response) => {
  if (!request.url?.endsWith("/chat/completions")) {
    response.writeHead(404).end();
    return;
  }
  let text = "";
  for await (const chunk of request) text += chunk;
  requests++;
  const body = JSON.parse(text);
  sawKey ||=
    request.headers.authorization === "Bearer forge-fixture-not-a-real-key";
  response.writeHead(200, { "Content-Type": "text/event-stream" });
  const chunk = (delta: unknown, finish_reason: string | null = null) =>
    response.write(
      `data: ${JSON.stringify({ id: `chatcmpl-qa-${requests}`, object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model: body.model, choices: [{ index: 0, delta, finish_reason }] })}\n\n`,
    );
  chunk({ role: "assistant", content: "" });
  chunk({ content: "LOCAL_FIXTURE_" });
  await new Promise<void>((r) => {
    const timer = setTimeout(
      r,
      JSON.stringify(body.messages?.at(-1)).includes("WAIT_FOR_ABORT")
        ? 20000
        : 450,
    );
    response.once("close", () => {
      clearTimeout(timer);
      r();
    });
  });
  if (response.destroyed) return;
  chunk({ content: "TRANSPORT_OK" });
  chunk({}, "stop");
  response.end("data: [DONE]\n\n");
});
await new Promise<void>((r) => provider.listen(0, "127.0.0.1", r));
const port = (provider.address() as { port: number }).port;
const storage = new LocalStorage(directory);
const project = storage.addProject(projectPath);
const redactor = new Redactor();
const engine = new OpenCodeSupervisor(
  path.join(directory, "engine"),
  path.resolve(process.env.RCF_TEST_ENGINE ?? "node_modules/@opencode/cli/bin/opencode.exe"),
  redactor,
  (s) => console.log("Engine:", s.state),
);
let snapshots = 0;
let sawPartial = false;
const coordinator = new SessionCoordinator(
  storage,
  engine,
  new MediaService(),
  (event) => {
    if (event.type === "snapshot") {
      snapshots++;
      sawPartial ||= event.snapshot.rows.some(
        (r) => r.type === "text" && r.text === "LOCAL_FIXTURE_",
      );
    }
  },
);
try {
  await coordinator.start();
  assert.equal(engine.status.compatibility?.state, "compatible");
  assert.equal(engine.status.compatibility.canSend, true);
  let client = await engine.ensure();
  await coordinator.customProvider({
    id: "qa",
    name: "QA local test provider",
    baseUrl: `http://127.0.0.1:${port}/v1`,
    model: "fixture-model",
    key: "forge-fixture-not-a-real-key",
    runtime: "compatible",
    images: true,
    tools: true,
  });
  const models = await coordinator.models(project.id);
  assert.ok(
    models.some(
      (m) =>
        m.providerID === "qa" && m.id === "fixture-model" && m.image && m.tools,
    ),
  );
  console.log("PASS custom OpenCode provider configuration and model metadata");
  const session = await coordinator.create(
    project.id,
    { id: "fixture-model", providerID: "qa" },
    "cautious",
  );
  await coordinator.open(session.id);
  await coordinator.send(
    session.id,
    "Transport fixture only. Return the configured response.",
    { id: "fixture-model", providerID: "qa" },
    "cautious",
    [],
  );
  await waitFor(async () => {
    const info = await client.session.get({ sessionID: session.id });
    return (
      info.outcome === "succeeded" &&
      !(await client.session.active())[session.id]
    );
  });
  const initial = await coordinator.open(session.id);
  assert.ok(
    initial.rows.some(
      (r) => r.type === "text" && r.text.includes("LOCAL_FIXTURE_TRANSPORT_OK"),
    ),
  );
  assert.ok(sawKey);
  assert.ok(requests >= 1);
  assert.ok(snapshots > 0);
  assert.ok(sawPartial, "Real intermediate text must reach the UI snapshot");
  console.log(
    "PASS real OpenCode transport, credential routing, SSE and authoritative snapshot",
  );
  const requested = client.permission.create({
    sessionID: session.id,
    action: "edit",
    resources: ["test.txt"],
  });
  const request = await waitFor(
    async () => (await client.permission.list({ sessionID: session.id }))[0],
  );
  assert.equal(request.action, "edit");
  await client.permission.reply({
    sessionID: session.id,
    requestID: request.id,
    decision: "once",
  });
  assert.equal((await requested).effect, "ask");
  assert.equal(
    (await client.permission.list({ sessionID: session.id })).length,
    0,
  );
  await coordinator.mode(session.id, "autonomous");
  assert.equal(
    (
      await client.permission.create({
        sessionID: session.id,
        action: "edit",
        resources: ["test2.txt"],
      })
    ).effect,
    "allow",
  );
  await coordinator.mode(session.id, "full");
  assert.equal(
    (
      await client.permission.create({
        sessionID: session.id,
        action: "external_directory",
        resources: ["C:/outside/*"],
      })
    ).effect,
    "allow",
  );
  await coordinator.mode(session.id, "cautious");
  console.log(
    "PASS actual V2 cautious/autonomous/full rules and permission reply",
  );
  const pid = (await client.server.info()).pid;
  process.kill(pid);
  await waitFor(async () => {
    if (engine.status.state !== "ready") return false;
    return engine.client?.server
      .info({ signal: AbortSignal.timeout(1000) })
      .then(
        (i) => i.pid !== pid,
        () => false,
      );
  }, 45000);
  client = await engine.ensure();
  const recovered = await coordinator.open(session.id);
  assert.deepEqual(recovered.rows, initial.rows);
  assert.equal(
    new Set(recovered.rows.map((r) => r.id)).size,
    recovered.rows.length,
  );
  console.log(
    "PASS forced server loss, automatic restart, resync and no duplicate history",
  );
  await coordinator.send(
    session.id,
    "WAIT_FOR_ABORT",
    { id: "fixture-model", providerID: "qa" },
    "cautious",
    [],
  );
  await waitFor(async () => (await client.session.active())[session.id]);
  await coordinator.stop(session.id);
  await waitFor(async () => !(await client.session.active())[session.id]);
  assert.equal(
    (await client.session.get({ sessionID: session.id })).outcome,
    "interrupted",
  );
  console.log(
    "PASS interruption of a real OpenCode request and idle-state restoration",
  );
  const blank = await client.session.create({
    location: { directory: projectPath },
    title: "QA fixture: 2000 history entries",
  });
  await client.session.remove({ sessionID: blank.id });
  const messages = Array.from({ length: 2000 }, (_, i) => ({
    id: `msg_${(0x10000000000 + i).toString(16)}qa${String(i).padStart(10, "0")}`,
    type: "system",
    time: { created: blank.time.created + i },
    text: `QA fixture history entry ${i}: deterministic pagination verification.`,
  }));
  const imported = await client.experimental.session.import({
    info: blank,
    messages,
    location: { directory: projectPath },
  });
  const first = await coordinator.open(imported.id);
  assert.equal(first.rows.length, 150);
  assert.ok(first.olderCursor);
  const second = await coordinator.snapshot(imported.id, first.olderCursor!);
  assert.equal(second.rows.length, 300);
  assert.ok(second.rows[0].at < first.rows[0].at);
  console.log(
    "PASS actual OpenCode history import, page order and incremental loading",
  );
  await fs.writeFile(
    "test-results/engine-verification.json",
    JSON.stringify(
      {
        passed: true,
        engineVersion: engine.status.version,
        fixtureProvider: true,
        requests,
        sawKey,
        snapshots,
        sawPartial,
        reconnection: true,
        permissions: true,
        interrupted: true,
        longHistoryId: imported.id,
        directory,
        projectPath,
        sessionId: session.id,
      },
      null,
      2,
    ),
  );
} finally {
  await coordinator.close();
  storage.close();
  provider.closeAllConnections();
  await new Promise<void>((r) => provider.close(() => r()));
}
