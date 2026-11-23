import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { DatabaseSync } from "node:sqlite";
import { Service } from "@opencode/client/service";
import { OpenCode } from "@opencode/client";
import { REVIEW_INSTRUCTIONS, parseReview } from "../shared/rcf";
import type { ModelRef } from "../shared/types";
// Use only an already running engine and the user's exact selected free/local
// model. Never start/reconfigure the user's engine, copy keys or change settings.
const profiles = [
  path.resolve(".runtime/desktop"),
  path.join(process.env.APPDATA ?? "", "Rote Coding Fraktion"),
];
const result: Record<string, unknown> = { passed: false, paidRequests: 0 };
let tested = false;
for (const profile of profiles) {
  let db: DatabaseSync | undefined;
  let sessionId: string | undefined;
  let client: ReturnType<typeof OpenCode.make> | undefined;
  try {
    const endpoint = await Service.discover({
      file: path.join(profile, "engine/state/opencode/service.json"),
      version: "2.3.0",
    }).catch(() => undefined);
    if (!endpoint) continue;
    db = new DatabaseSync(path.join(profile, "forge.sqlite"), {
      readOnly: true,
    });
    const row = db
      .prepare("SELECT value FROM settings WHERE key='preferences'")
      .get() as { value: string } | undefined;
    db.close();
    db = undefined;
    const model: ModelRef | undefined = row
      ? JSON.parse(row.value).model
      : undefined;
    if (
      !model ||
      (!/(?:^|[-/:])free(?:$|[-/:])/i.test(model.id) &&
        !["ollama", "lmstudio"].includes(model.providerID))
    ) {
      result.reason =
        "Selected model is not explicitly free/local; no paid request made.";
      continue;
    }
    client = OpenCode.make({
      baseUrl: endpoint.url,
      headers: Service.headers(endpoint),
    });
    const models = await client.model.list({ types: ["chat"] });
    if (
      !models.data.some(
        (m) =>
          m.enabled && m.id === model.id && m.providerID === model.providerID,
      )
    )
      continue;
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "rcf-live-"));
    await fs.writeFile(
      path.join(directory, "calc.ts"),
      "export const divide = (a: number,b: number) => a * b;\n",
    );
    const before = await fs.readFile(path.join(directory, "calc.ts"), "utf8");
    const session = await client.session.create({
      title: "RCF temporary independent review verification",
      location: { directory },
      agent: "build",
      model,
      permissions: [{ action: "*", resource: "*", effect: "deny" }],
      metadata: { forgeWorkspace: "work", rcfVerification: true },
    });
    sessionId = session.id;
    tested = true;
    await client.session.prompt({
      sessionID: session.id,
      text: `${REVIEW_INSTRUCTIONS}\nReview this tiny change. Requirement: divide(a,b) returns a divided by b. No tests were run.\n--- a/calc.ts\n+++ b/calc.ts\n@@ -1 +1 @@\n-export const divide = (a: number,b: number) => a / b;\n+export const divide = (a: number,b: number) => a * b;\nKeep response under 250 words.`,
    });
    const end = Date.now() + 60000;
    while ((await client.session.active())[session.id] && Date.now() < end)
      await new Promise((r) => setTimeout(r, 250));
    const info = await client.session.get({ sessionID: session.id });
    const messages = await client.message.list({
      sessionID: session.id,
      order: "asc",
      limit: 100,
    });
    const raw = messages.data
      .filter((m) => m.type === "assistant")
      .flatMap((m) =>
        m.content.filter((p) => p.type === "text").map((p) => p.text),
      )
      .join("\n");
    const parsed = parseReview(raw);
    const unchanged =
      before === (await fs.readFile(path.join(directory, "calc.ts"), "utf8"));
    Object.assign(result, {
      model,
      outcome: info.outcome,
      issues: parsed.issues,
      limitations: parsed.limitations,
      raw,
      unchanged,
      passed:
        info.outcome === "succeeded" &&
        unchanged &&
        !!parsed.issues?.some(
          (i) =>
            i.file === "calc.ts" &&
            /multipl|division|divid|умнож|делени/i.test(JSON.stringify(i)),
        ),
    });
    console.log(
      result.passed
        ? "PASS actual selected free/local model independently found seeded division regression"
        : "UNVERIFIED real model review; see rcf-live.json",
    );
  } catch (e) {
    result.reason = e instanceof Error ? e.message : String(e);
    console.log(
      "Live check did not complete; no provider/configuration changes.",
    );
  } finally {
    db?.close();
    if (client && sessionId) {
      await client.session
        .interrupt({ sessionID: sessionId, resume: false })
        .catch(() => {});
      await client.session.remove({ sessionID: sessionId }).catch(() => {});
    }
  }
  if (tested) break;
}
if (!tested) {
  result.reason ??=
    "No running engine with a selected enabled free/local model was available. User profiles were not started or changed.";
  console.log(result.reason);
}
await fs.mkdir("test-results", { recursive: true });
await fs.writeFile(
  "test-results/rcf-live.json",
  JSON.stringify(result, null, 2),
);
