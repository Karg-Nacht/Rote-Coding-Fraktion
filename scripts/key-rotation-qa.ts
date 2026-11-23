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
const directory = path.resolve(`.runtime/key-rotation-${process.pid}`);
const projectPath = path.join(directory, "Проект");
await fs.mkdir(projectPath, { recursive: true });
await fs.mkdir("test-results", { recursive: true });
let requests = 0;
let sawKey = false; const received: string[] = [];
const provider = http.createServer(async (request, response) => {
  if (!request.url?.endsWith("/chat/completions")) {
    response.writeHead(404).end();
    return;
  }
  let text = "";
  for await (const chunk of request) text += chunk;
  requests++; received.push(request.headers.authorization ?? '');
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
  path.resolve("node_modules/@opencode/cli/bin/opencode.exe"),
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
  let client = await engine.ensure();
  await coordinator.customProvider({
    id: "qa",
    name: "QA local test provider",
    baseUrl: `http://127.0.0.1:${port}/v1`,
    model: "fixture-model",
    key: "forge-fixture-not-a-real-key",
    runtime: "openrouter",
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

  await client.credential.create({integrationID:'qa',value:{type:'key',key:'forge-fixture-replacement-key'},activate:true});
  await coordinator.send(session.id,'Second isolated transport request',{id:'fixture-model',providerID:'qa'},'cautious',[]);
  await waitFor(async()=>received.includes('Bearer forge-fixture-replacement-key'),15000);
  assert.equal(received.at(-1),'Bearer forge-fixture-replacement-key');
  console.log('PASS replacement key is used on next request without restart');
} finally { await coordinator.close(); await engine.stop(); storage.close(); provider.closeAllConnections(); await new Promise<void>(r=>provider.close(()=>r())); }
