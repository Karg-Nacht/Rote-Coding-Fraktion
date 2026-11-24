import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { OpenCodeSupervisor } from "../electron/supervisor";
import { SessionCoordinator } from "../electron/coordinator";
import { LocalStorage } from "../electron/storage";
import { MediaService } from "../electron/media";
import { Redactor } from "../electron/security";

const directory = path.resolve(`.runtime/chat-isolation-${process.pid}`);
const projectPath = path.join(directory, "Проект");
await fs.mkdir(projectPath, { recursive: true });
const discoveredInstructions = path.join(projectPath, "AGENTS.md");
await fs.writeFile(discoveredInstructions, "RCF_DISCOVERED_PROJECT_INSTRUCTIONS_41");
let requests = 0;
let offeredTools = -1;
let sawMemory = false;
let forgedCall = false;
const modelRequests: string[] = [];
const forbiddenFile = path.join(projectPath, "forbidden-tool-write.txt");
const provider = http.createServer(async (request, response) => {
  if (!request.url?.endsWith("/chat/completions"))
    return void response.writeHead(404).end();
  let text = "";
  for await (const chunk of request) text += chunk;
  const body = JSON.parse(text);
  requests++;
  modelRequests.push(JSON.stringify(body.messages));
  offeredTools = Math.max(offeredTools, body.tools?.length ?? 0);
  sawMemory ||= JSON.stringify(body.messages).includes(
    "USER_MEMORY_MARKER_спокойно",
  );
  response.writeHead(200, { "Content-Type": "text/event-stream" });
  const chunk = (delta: unknown, finish: string | null = null) =>
    response.write(
      `data: ${JSON.stringify({ id: `chatcmpl-${requests}`, object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model: body.model, choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`,
    );
  if (
    !forgedCall &&
    JSON.stringify(body.messages).includes("ATTEMPT_FORGED_SHELL_CALL")
  ) {
    forgedCall = true;
    chunk({
      role: "assistant",
      tool_calls: [
        {
          index: 0,
          id: "forbidden_fixture_call",
          type: "function",
          function: {
            name: "shell",
            arguments: JSON.stringify({
              command: `echo FORBIDDEN > "${forbiddenFile.replaceAll("\\", "/")}"`,
              description: "Chat isolation negative fixture",
            }),
          },
        },
      ],
    });
    chunk({}, "tool_calls");
    response.end("data: [DONE]\n\n");
    return;
  }
  chunk({ role: "assistant", content: "CHAT_FIXTURE_OK" });
  chunk({}, "stop");
  response.end("data: [DONE]\n\n");
});
await new Promise<void>((resolve) => provider.listen(0, "127.0.0.1", resolve));
const port = (provider.address() as { port: number }).port;
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
  () => {},
);
const model = { id: "fixture", providerID: "chatqa" };
try {
  await coordinator.start();
  await coordinator.customProvider({
    id: model.providerID,
    name: "Chat isolation fixture",
    baseUrl: `http://127.0.0.1:${port}/v1`,
    model: model.id,
    key: "fixture-only-not-a-real-key",
    runtime: "compatible",
    images: true,
    tools: true,
  });
  storage.memorySave({
    scope: "project",
    projectId: project.id,
    text: "USER_MEMORY_MARKER_спокойно",
  });
  storage.savePreferences({ memoryEnabled: true });
  const session = await coordinator.create(project.id, model, "full", "chat");
  const client = await engine.ensure();
  await client.session.update({
    sessionID: session.id,
    title: "Chat security fixture",
  });
  for (const mode of ["cautious", "autonomous", "full"] as const) {
    await coordinator.mode(session.id, mode);
    for (const action of [
      "read",
      "edit",
      "shell",
      "subagent",
      "external_directory",
      "mcp.some_tool",
      "plugin.some_tool",
      "skill",
      "webfetch",
    ])
      assert.equal(
        (
          await client.permission.create(
            { sessionID: session.id, action, resources: ["*"] },
            { signal: AbortSignal.timeout(3000) },
          )
        ).effect,
        "deny",
        `${action} must remain denied in ${mode}`,
      );
  }
  await coordinator.send(
    session.id,
    "USER_VISIBLE_CONTENT_ONLY. Verify Chat isolation fixture.",
    model,
    "full",
    [],
  );
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    const info = await client.session.get({ sessionID: session.id });
    if (
      info.outcome === "succeeded" &&
      !(await client.session.active())[session.id]
    )
      break;
    await new Promise((resolve) => setTimeout(resolve, 80));
  }
  assert.ok(requests > 0, "Model transport was exercised");
  assert.equal(offeredTools, 0, "Chat must not offer any tools to the model");
  assert.ok(sawMemory, "Manually saved project memory must reach the provider");
  assert.ok(modelRequests.every((body) => !body.includes("RCF_DISCOVERED_PROJECT_INSTRUCTIONS_41")));
  assert.equal(
    (await coordinator.snapshot(session.id)).session.workspace,
    "chat",
  );
  const matches = await coordinator.search({
    query: "USER_VISIBLE_CONTENT_ONLY",
    workspace: "chat",
  });
  assert.ok(
    matches.some(
      (result) => result.sessionId === session.id && result.messageId,
    ),
  );
  assert.equal(
    (
      await coordinator.search({
        query: "USER_VISIBLE_CONTENT_ONLY",
        workspace: "work",
      })
    ).length,
    0,
  );
  storage.savePreferences({ memoryEnabled: false });
  await fs.writeFile(discoveredInstructions, "RCF_DISCOVERED_PROJECT_INSTRUCTIONS_42");
  await client.location.reload();
  await coordinator.send(
    session.id,
    "Memory is now disabled.",
    model,
    "full",
    [],
  );
  assert.equal(
    (
      await client.experimental.session.instructions.entry.list({
        sessionID: session.id,
      })
    ).length,
    1,
    "Only Chat rules remain after disabling saved memory",
  );
  assert.ok(
    !(
      await client.experimental.session.instructions.entry.list({
        sessionID: session.id,
      })
    ).some((entry) =>
      JSON.stringify(entry.value).includes("USER_MEMORY_MARKER"),
    ),
  );
  async function waitForTurn(marker: string) {
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      const sent = modelRequests.find((body) => body.includes(marker));
      if (sent && !(await client.session.active())[session.id]) return sent;
      await new Promise((resolve) => setTimeout(resolve, 80));
    }
    assert.fail(`The provider did not complete ${marker}`);
  }
  await waitForTurn("Memory is now disabled.");
  const code = 'export const restoreModel = "RCF_PROJECT_EVIDENCE_71259";\n';
  const file = path.join(projectPath, "restore-model.ts");
  await fs.writeFile(file, code);
  const question = "ATTEMPT_FORGED_SHELL_CALL. Where does restoreModel run?";
  const requestId = randomUUID();
  const preview = await coordinator.prepareProjectContext(project.id, question, requestId, session.id);
  assert.equal(preview.files, 1);
  assert.equal(preview.excerpts[0]?.path, "restore-model.ts");
  assert.ok(preview.excerpts[0]?.text.includes("RCF_PROJECT_EVIDENCE_71259"));
  assert.ok(modelRequests.every((body) => !body.includes("RCF_PROJECT_EVIDENCE_71259")));
  await coordinator.send(
    session.id,
    question,
    model,
    "full",
    [],
    { projectContext: { projectId: project.id, requestId } },
  );
  const blockedDeadline = Date.now() + 10000;
  while (Date.now() < blockedDeadline) {
    if (forgedCall && !(await client.session.active())[session.id]) break;
    await new Promise((resolve) => setTimeout(resolve, 80));
  }
  assert.ok(
    forgedCall,
    "Provider attempted a shell tool even though it was not offered",
  );
  await assert.rejects(
    fs.access(forbiddenFile),
    /ENOENT/,
    "Forged shell tool must never write a file",
  );
  assert.equal(offeredTools, 0);
  assert.match(await waitForTurn(question), /RCF_PROJECT_EVIDENCE_71259/);
  assert.doesNotMatch(JSON.stringify(await client.message.list({ sessionID: session.id })), /RCF_PROJECT_EVIDENCE_71259/);
  assert.doesNotMatch(JSON.stringify(await client.experimental.session.instructions.entry.list({ sessionID: session.id })), /RCF_PROJECT_EVIDENCE_71259/);
  await coordinator.send(session.id, "CONTEXT_DISABLED_FOLLOWUP", model, "cautious", []);
  assert.doesNotMatch(await waitForTurn("CONTEXT_DISABLED_FOLLOWUP"), /RCF_PROJECT_EVIDENCE_71259/);
  assert.ok(modelRequests.every((body) => !body.includes("RCF_DISCOVERED_PROJECT_INSTRUCTIONS_4")));
  assert.equal(await fs.readFile(file, "utf8"), code);
  console.log("PASS Project Intelligence preview and provider request, clean follow-up and no source persistence in OpenCode history");
  console.log(
    "PASS actual OpenCode 2.3 Chat catch-all denials across every mode; no model tools; forged shell call cannot write; scoped memory injection/removal; workspace-filtered content search",
  );
} finally {
  await coordinator.close();
  storage.close();
  provider.closeAllConnections();
  await new Promise<void>((resolve) => provider.close(() => resolve()));
}
