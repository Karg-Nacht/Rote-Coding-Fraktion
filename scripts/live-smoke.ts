import path from "node:path";
import fs from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { OpenCodeSupervisor } from "../electron/supervisor";
import { Redactor } from "../electron/security";
import { permissionRules } from "../shared/permissions";
const project = path.resolve(".runtime/live-project");
await fs.mkdir(project, { recursive: true });
await fs.writeFile(path.join(project, "input.txt"), "hello forge\n");
await fs.writeFile(
  path.join(project, "check.mjs"),
  "import fs from 'node:fs'; if(fs.readFileSync('result.txt','utf8').trim() !== 'HELLO FORGE') process.exit(1); console.log('FORGE_CHECK_OK')",
);
execFileSync("git", ["init"], {
  cwd: project,
  windowsHide: true,
  stdio: "ignore",
});
const engine = new OpenCodeSupervisor(
  path.resolve(".runtime/live-engine"),
  path.resolve("node_modules/@opencode/cli/bin/opencode.exe"),
  new Redactor(),
  (s) => console.log("Engine", s.state),
);
const abort = new AbortController();
const events = new Set<string>();
try {
  const client = await engine.ensure();
  const available = (
    await client.model.list({ location: { directory: project } })
  ).data;
  const model = available.find(
    (m) =>
      m.providerID === "opencode" &&
      m.id === "deepseek-v4.1-flash-free" &&
      m.enabled,
  );
  if (!model)
    throw new Error(
      "Expected free model unavailable; no paid model will be substituted.",
    );
  const session = await client.session.create({
    location: { directory: project },
    model: { id: model.id, providerID: model.providerID },
    permissions: [
      ...permissionRules("cautious"),
      { action: "external_directory", resource: "*", effect: "deny" },
    ],
  });
  console.log(
    "Live test model",
    `${model.providerID}/${model.id}`,
    "session",
    session.id,
  );
  const timeout = setTimeout(() => abort.abort(), 100000);
  const listen = (async () => {
    for await (const event of client.event.subscribe({
      signal: abort.signal,
    })) {
      if (
        "data" in event &&
        event.data &&
        "sessionID" in event.data &&
        event.data.sessionID === session.id
      ) {
        events.add(event.type);
        if (event.type === "permission.asked") {
          const pending = await client.permission.list({
            sessionID: session.id,
          });
          for (const item of pending) {
            const allowed =
              (item.action === "edit" &&
                item.resources.every((r) => /result\.txt$/.test(r))) ||
              (item.action === "shell" &&
                item.resources.every((r) =>
                  /^node\s+(?:\.\/)?check\.mjs$/.test(r),
                ));
            console.log(
              "Permission",
              item.action,
              allowed ? "approved test operation" : "rejected",
            );
            await client.permission.reply({
              sessionID: session.id,
              requestID: item.id,
              decision: allowed ? "once" : "reject",
            });
          }
        }
        if (
          event.type === "session.execution.succeeded" ||
          event.type === "session.execution.failed"
        )
          return;
      }
    }
  })();
  await client.session.prompt({
    sessionID: session.id,
    text: "This is an isolated integration test. Use the read tool to read input.txt. Create result.txt containing the uppercased input (HELLO FORGE followed by a newline). Run the command node check.mjs using the shell tool. Do not edit any other files. Finish with one short sentence. Do not use subagents.",
  });
  await listen;
  clearTimeout(timeout);
  const messages = await client.message.list({
    sessionID: session.id,
    limit: 100,
    order: "asc",
  });
  console.log(
    "Message summary",
    messages.data.map((m) =>
      m.type === "assistant"
        ? {
            type: m.type,
            content: m.content.map((c) =>
              c.type === "tool"
                ? { type: c.type, name: c.name, state: c.state.status }
                : { type: c.type },
            ),
            error: m.error?.message,
          }
        : { type: m.type },
    ),
  );
  console.log(
    "Result",
    await fs
      .readFile(path.join(project, "result.txt"), "utf8")
      .catch(() => "MISSING"),
  );
  console.log("Events", [...events]);
  console.log(
    "Diff",
    (await client.session.diff({ sessionID: session.id })).map((d) => ({
      file: d.file,
      additions: d.additions,
      deletions: d.deletions,
    })),
  );
} finally {
  abort.abort();
  await engine.stop();
}
