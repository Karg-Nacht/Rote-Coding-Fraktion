import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { createServer } from "node:http";
import { OpenCode } from "@opencode/client";
import { Service } from "@opencode/client/service";

const [, , binary, version] = process.argv;
assert.ok(binary && /^2\.\d+\.\d+$/.test(version), "Pass the verified binary and exact version");
const profile = await fs.mkdtemp(path.resolve(".runtime/opencode-contract-"));
const env = {
  XDG_CONFIG_HOME: path.join(profile, "config"),
  XDG_DATA_HOME: path.join(profile, "data"),
  XDG_CACHE_HOME: path.join(profile, "cache"),
  XDG_STATE_HOME: path.join(profile, "state"),
  OPENCODE_DISABLE_AUTOUPDATE: "true",
};
const file = path.join(env.XDG_STATE_HOME, "opencode", "service.json");
const project = path.join(profile, "project");
const config = path.join(env.XDG_CONFIG_HOME, "opencode");
await fs.mkdir(project);
await fs.mkdir(config, { recursive: true });
const sample = "RCF_VERIFIED_FILE_READ";
await fs.writeFile(path.join(project, "fixture.txt"), sample);
const model = { providerID: "rcfqa", id: "fixture" };
const deny = { action: "*", resource: "*", effect: "deny" };
const permissions = [deny, { action: "read", resource: "*", effect: "allow" }, { action: "edit", resource: "*", effect: "ask" }];
let sentRead = false, sawRead = false, sawKey = false;
const offered = new Set();
const server = createServer(async (req, res) => {
  if (!req.url?.endsWith("/chat/completions")) return res.writeHead(404).end();
  const body = JSON.parse(Buffer.concat(await Array.fromAsync(req)).toString());
  sawKey ||= req.headers.authorization === "Bearer rcf-local-contract-fixture";
  for (const tool of body.tools ?? []) offered.add(tool.function?.name);
  res.writeHead(200, { "Content-Type": "text/event-stream" });
  const emit = (delta, finish_reason = null) => res.write(
    `data: ${JSON.stringify({ id: "rcf-fixture", object: "chat.completion.chunk", created: 0, model: body.model, choices: [{ index: 0, delta, finish_reason }] })}\n\n`,
  );
  if (!sentRead && offered.has("read")) {
    sentRead = true;
    emit({ role: "assistant", tool_calls: [{
      index: 0, id: "rcf-verify-read", type: "function",
      function: { name: "read", arguments: JSON.stringify({ path: "fixture.txt" }) },
    }] });
    emit({}, "tool_calls");
  } else {
    sawRead ||= JSON.stringify(body.messages).includes(sample);
    emit({ role: "assistant", content: "RCF_CONTRACT_OK" });
    emit({}, "stop");
  }
  res.end("data: [DONE]\n\n");
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
async function until(check) {
  for (let attempt = 0; attempt < 150; attempt++) {
    const result = await check();
    if (result) return result;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("Timed out waiting for OpenCode");
}
const stream = new AbortController();
let events;
try {
  await fs.writeFile(path.join(config, "opencode.json"), JSON.stringify({
    providers: { rcfqa: {
      name: "RCF isolated fixture", package: "@opencode/ai/providers/openai-compatible",
      settings: { baseURL: "http://127.0.0.1:" + server.address().port + "/v1" },
      models: { fixture: { name: "Fixture", capabilities: { tools: true, input: ["text"], output: ["text"] } } },
    } },
    agents: { "rcf-qa": { name: "RCF QA", description: "Isolated read-only fixture", mode: "subagent", permissions: [deny] } },
  }));
  const endpoint = await Service.ensure({
    file, version, command: [path.resolve(binary), "serve", "--service", "--hostname", "127.0.0.1", "--port", "0"], env,
  });
  const client = OpenCode.make({ baseUrl: endpoint.url, headers: Service.headers(endpoint) });
  assert.equal((await client.server.info()).version, version);
  await client.credential.create({
    integrationID: model.providerID, value: { type: "key", key: "rcf-local-contract-fixture" }, activate: true,
  });
  assert.ok((await client.model.list({ location: { directory: project }, types: ["chat"] })).data.some(
    (entry) => entry.providerID === model.providerID && entry.id === model.id,
  ));
  const seen = new Set();
  events = (async () => {
    for await (const event of client.event.subscribe({ signal: stream.signal })) seen.add(event.type);
  })().catch((error) => { if (!stream.signal.aborted) throw error; });
  await until(() => seen.has("server.connected"));
  const parent = await client.session.create({ title: "RCF contract", location: { directory: project }, model, permissions });
  const send = async (id, text) => {
    await client.session.prompt({ sessionID: id, text, delivery: "queue" });
    await until(async () => (await client.session.get({ sessionID: id })).outcome === "succeeded");
  };
  await send(parent.id, "Read fixture.txt.");
  assert.ok(sawKey && sentRead && sawRead, JSON.stringify({ sawKey, sentRead, sawRead, offered: [...offered] }));
  assert.match(JSON.stringify(await client.message.list({ sessionID: parent.id })), /RCF_CONTRACT_OK/);
  assert.ok(seen.has("session.execution.started"));
  console.log("PASS prompt, file read tool, SSE, model and credential routing");
  const request = client.permission.create({ sessionID: parent.id, action: "edit", resources: ["fixture.txt"] });
  const pending = await until(async () => (await client.permission.list({ sessionID: parent.id }))[0]);
  assert.equal(pending.action, "edit");
  await client.permission.reply({ sessionID: parent.id, requestID: pending.id, decision: "once" });
  assert.equal((await request).effect, "ask");
  assert.equal((await client.permission.create({ sessionID: parent.id, action: "shell", resources: ["fixture"] })).effect, "deny");
  assert.deepEqual(await client.session.diff({ sessionID: parent.id }), []);
  const child = await client.session.create({
    parentID: parent.id, agent: "rcf-qa", model, location: { directory: project }, permissions: [deny],
  });
  assert.equal(child.parentID, parent.id);
  assert.equal((await client.permission.create({ sessionID: child.id, action: "edit", resources: ["fixture.txt"] })).effect, "deny");
  await send(child.id, "Return the fixture response.");
  assert.equal(await fs.readFile(path.join(project, "fixture.txt"), "utf8"), sample);
  console.log("PASS permission reply, denial, diff and restricted child");
  await fs.mkdir("test-results/engine-manager", { recursive: true });
  await fs.writeFile("test-results/engine-manager/opencode-" + version + "-contract.json", JSON.stringify({
    version, prompt: true, fileReadTool: true, events: true, permissions: true, diff: true, restrictedChild: true,
  }, null, 2));
} finally {
  stream.abort();
  await events;
  await Service.stop({ file, pty: "clear" });
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
}
