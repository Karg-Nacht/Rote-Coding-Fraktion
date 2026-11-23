import fs from "node:fs/promises";
import path from "node:path";
import { OpenCodeSupervisor } from "../electron/supervisor";
import { Redactor } from "../electron/security";
const report = JSON.parse(
  await fs.readFile("test-results/desktop-verification.json", "utf8"),
);
const engine = new OpenCodeSupervisor(
  path.join(report.dataDir, "engine"),
  path.resolve("node_modules/@opencode/cli/bin/opencode.exe"),
  new Redactor(),
  () => {},
);
try {
  const client = await engine.ensure();
  const messages = await client.message.list({
    sessionID: report.sessionId,
    limit: 150,
  });
  console.log("pagination", messages.data.length, messages.cursor);
  for (const message of messages.data)
    if (message.type === "assistant")
      for (const p of message.content)
        if (p.type === "tool" && p.name === "write")
          console.log(
            "Write metadata",
            JSON.stringify(p.state, null, 2).slice(0, 6000),
          );
  console.log(
    "Integrations after refresh",
    (await client.integration.list()).data.length,
  );
} finally {
  await engine.stop();
}
