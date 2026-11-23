import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import { OpenCodeSupervisor } from "../electron/supervisor";
import { SessionCoordinator } from "../electron/coordinator";
import { LocalStorage } from "../electron/storage";
import { MediaService } from "../electron/media";
import { Redactor } from "../electron/security";

const directory = path.resolve(`.runtime/retry-smoke-${process.pid}`);
const projectPath = path.join(directory, "Проект");
await fs.mkdir(projectPath, { recursive: true });
const requests = new Map<string, number>();
let recovered = false;
const errors: string[] = [];
const retries = new Map<string, number[]>();
const verified: {
  status: number;
  scheduledAttempts: number[];
  upstreamRequestsBeforeStop: number;
  queuedMessagePreserved: boolean;
}[] = [];
const server = http.createServer(async (request, response) => {
  if (!request.url?.endsWith("/chat/completions"))
    return void response.writeHead(404).end();
  let text = "";
  for await (const chunk of request) text += chunk;
  const body = JSON.parse(text);
  const model = String(body.model);
  requests.set(model, (requests.get(model) ?? 0) + 1);
  if (!recovered && /^fixture-(429|503)$/.test(model)) {
    response.writeHead(model.endsWith("429") ? 429 : 503, {
      "Content-Type": "application/json",
      "Retry-After": "0.1",
    });
    response.end(
      JSON.stringify({
        error: {
          message: "LOCAL_TRANSIENT_FAILURE",
          type: model.endsWith("429") ? "rate_limit_exceeded" : "server_error",
        },
      }),
    );
    return;
  }
  response.writeHead(200, { "Content-Type": "text/event-stream" });
  for (const [delta, finish_reason] of [
    [{ role: "assistant", content: "LOCAL_RECOVERY_OK" }, null],
    [{}, "stop"],
  ] as const)
    response.write(
      `data: ${JSON.stringify({ id: "retry-fixture", object: "chat.completion.chunk", created: 1, model, choices: [{ index: 0, delta, finish_reason }] })}\n\n`,
    );
  response.end("data: [DONE]\n\n");
});
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const port = (server.address() as { port: number }).port;
const storage = new LocalStorage(directory);
const project = storage.addProject(projectPath);
const engine = new OpenCodeSupervisor(
  path.join(directory, "engine"),
  path.resolve("node_modules/@opencode/cli/bin/opencode.exe"),
  new Redactor(),
  () => {},
);
const coordinator = new SessionCoordinator(
  storage,
  engine,
  new MediaService(),
  (event) => {
    if (event.type === "error") errors.push(event.message);
  },
);
const controller = new AbortController();
let watch: Promise<void> | undefined;
const waitFor = async (run: () => Promise<boolean>, timeout = 30000) => {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await run()) return;
    await new Promise((resolve) => setTimeout(resolve, 60));
  }
  throw new Error("Retry fixture timed out");
};
try {
  await coordinator.start();
  for (const status of [429, 503])
    await coordinator.customProvider({
      id: "retryqa",
      name: "Retry loopback fixture",
      baseUrl: `http://127.0.0.1:${port}/v1`,
      model: `fixture-${status}`,
      key: "retry-fixture-only-not-a-real-key",
      runtime: "compatible",
      images: false,
      tools: true,
    });
  const client = await engine.ensure();
  watch = (async () => {
    for await (const event of client.event.subscribe({
      signal: controller.signal,
    })) {
      if (event.type === "session.retry.scheduled") {
        const attempts = retries.get(event.data.sessionID) ?? [];
        attempts.push(event.data.attempt);
        retries.set(event.data.sessionID, attempts);
        console.log("Retry event:", event.data.attempt);
      }
    }
  })().catch((error) => {
    if (!controller.signal.aborted) throw error;
  });
  for (const status of [429, 503]) {
    recovered = false;
    const model = {
      id: `fixture-${status}`,
      providerID: "retryqa",
      variant: "default",
    };
    const session = await coordinator.create(project.id, model, "cautious");
    await client.session.update({
      sessionID: session.id,
      title: `Retry fixture ${status}`,
    });
    await coordinator.send(
      session.id,
      `LOCAL_FAILURE_${status}`,
      model,
      "cautious",
      [],
    );
    await waitFor(async () => (retries.get(session.id)?.length ?? 0) >= 1);
    const queued = await client.session.prompt({
      sessionID: session.id,
      text: `LOCAL_QUEUED_${status}`,
      delivery: "queue",
    });
    await waitFor(async () => {
      const info = await client.session.get({ sessionID: session.id });
      return !!info.outcome && !(await client.session.active())[session.id];
    });
    const attempts = retries.get(session.id) ?? [];
    console.log(
      "Completed fixture:",
      status,
      "scheduled retries",
      attempts.length,
      "requests",
      requests.get(model.id) ?? 0,
    );
    assert.ok(
      attempts.length > 0,
      "Real provider retry scheduling must be exercised",
    );
    assert.ok(
      Math.max(...attempts) <= 5,
      "The fourth retry is interrupted when it is scheduled as attempt 5",
    );
    assert.ok(
      (requests.get(model.id) ?? 0) <= 4,
      "At most initial attempt plus three retries may contact the provider",
    );
    assert.ok(
      (await client.session.inbox.list({ sessionID: session.id })).some(
        (item) => item.id === queued.id,
      ),
      "Retry exhaustion preserves queued user messages",
    );
    verified.push({
      status,
      scheduledAttempts: [...attempts],
      upstreamRequestsBeforeStop: requests.get(model.id) ?? 0,
      queuedMessagePreserved: true,
    });
    assert.deepEqual(
      (await client.session.get({ sessionID: session.id })).model,
      model,
    );
    assert.ok(
      (
        await client.message.list({ sessionID: session.id, limit: 150 })
      ).data.some(
        (message) =>
          message.type === "user" && message.text === `LOCAL_FAILURE_${status}`,
      ),
    );
    recovered = true;
    await coordinator.send(
      session.id,
      `LOCAL_RECOVER_${status}`,
      model,
      "cautious",
      [],
    );
    await waitFor(
      async () =>
        (await client.session.get({ sessionID: session.id })).outcome ===
          "succeeded" && !(await client.session.active())[session.id],
    );
    assert.ok(
      (await coordinator.snapshot(session.id)).rows.some(
        (row) => row.type === "text" && row.text.includes("LOCAL_RECOVERY_OK"),
      ),
    );
    const history = await client.message.list({
      sessionID: session.id,
      limit: 150,
    });
    assert.equal(
      history.data.filter(
        (message) =>
          message.type === "user" && message.text === `LOCAL_FAILURE_${status}`,
      ).length,
      1,
      "Retry handling never resubmits the original user prompt",
    );
  }
  assert.equal(
    errors.filter((message) => message.includes("после 3 повторных попыток"))
      .length,
    2,
    "Each exhausted session emits a clear retry-limit error",
  );
  await fs.mkdir("test-results", { recursive: true });
  await fs.writeFile(
    "test-results/retry-verification.json",
    JSON.stringify(
      {
        passed: true,
        engineVersion: "2.3.0",
        localProviderOnly: true,
        selectedModelPreserved: true,
        manualRecoveryVerified: true,
        capMessageCount: 2,
        cases: verified,
      },
      null,
      2,
    ),
  );
  console.log(
    "PASS real OpenCode 429/503 retries stop at three; original model and history retained; manual send recovers",
  );
} finally {
  controller.abort();
  await watch;
  await coordinator.close();
  storage.close();
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
}
