import fs from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Service } from "@opencode/client/service";
import { createCanvas } from "@napi-rs/canvas";
import { OpenCodeSupervisor } from "../electron/supervisor";
import { MediaService } from "../electron/media";
import { Redactor } from "../electron/security";
import type { ModelRef } from "../shared/types";

// Explicit live verification of the user's currently selected free vision model.
// Credentials stay exclusively in its existing engine profile. User preferences,
// provider configuration, project lists and real conversations are never changed.
const profile = path.resolve(
  process.env.FORGE_SELECTED_PROFILE ?? ".runtime/desktop",
);
const directory = path.resolve(`.runtime/selected-vision-${process.pid}`);
const folder = path.join(directory, "control-project");
await fs.mkdir(folder, { recursive: true });
const db = new DatabaseSync(path.join(profile, "forge.sqlite"), {
  readOnly: true,
});
const row = db
  .prepare("SELECT value FROM settings WHERE key='preferences'")
  .get() as { value: string } | undefined;
db.close();
const selected: ModelRef | undefined = row
  ? JSON.parse(row.value).model
  : undefined;
const redactor = new Redactor();
const supervisor = new OpenCodeSupervisor(
  path.join(profile, "engine"),
  path.resolve("node_modules/@opencode/cli/bin/opencode.exe"),
  redactor,
  () => {},
);
const existed = await Service.discover({
  file: supervisor.file,
  version: "2.3.0",
}).catch(() => undefined);
const media = new MediaService(path.join(directory, "attachments"));
let ownSession: string | undefined;
let report: Record<string, unknown> = {
  passed: false,
  realProviderVisionTested: false,
  selected,
  configurationChanged: false,
};
try {
  if (!selected || !/(?:^|[-/:])free(?:$|[-/:])/i.test(selected.id))
    throw Error(
      "Current selected model is not explicitly free; live check skipped without substituting a model.",
    );
  const client = await supervisor.ensure();
  const model = (await client.model.list({ types: ["chat"] })).data.find(
    (m) => m.providerID === selected.providerID && m.id === selected.id,
  );
  if (!model?.enabled || !model.capabilities.input.includes("image"))
    throw Error(
      "Current selected model is not enabled for images; live check skipped without changing capabilities.",
    );
  const canvas = createCanvas(360, 240),
    ctx = canvas.getContext("2d");
  ctx.fillStyle = "white";
  ctx.fillRect(0, 0, 360, 240);
  ctx.fillStyle = "#df0000";
  ctx.beginPath();
  ctx.arc(70, 70, 35, 0, 2 * Math.PI);
  ctx.fill();
  ctx.fillStyle = "#003fe0";
  ctx.fillRect(180, 30, 130, 70);
  ctx.fillStyle = "#ffcd00";
  ctx.beginPath();
  ctx.moveTo(110, 210);
  ctx.lineTo(170, 120);
  ctx.lineTo(230, 210);
  ctx.closePath();
  ctx.fill();
  const [attachment] = await media.import([
    {
      name: "control.png",
      mime: "image/png",
      bytes: canvas.toBuffer("image/png"),
    },
  ]);
  const session = await client.session.create({
    location: { directory: folder },
    title: "Forge generated vision control",
    model: selected,
    permissions: [{ action: "*", resource: "*", effect: "deny" }],
    metadata: { forgeWorkspace: "chat", forgeVerification: true },
  });
  ownSession = session.id;
  await client.session.prompt({
    sessionID: session.id,
    text: "Describe the colors, shapes and approximate positions in the attached image. English only, one short sentence. Do not use tools.",
    files: await media.promptFiles([attachment.id]),
  });
  const deadline = Date.now() + 60000;
  do {
    await new Promise((resolve) => setTimeout(resolve, 500));
  } while (
    (await client.session.active())[session.id] &&
    Date.now() < deadline
  );
  if ((await client.session.active())[session.id])
    await client.session.interrupt({ sessionID: session.id, resume: false });
  const messages = (
    await client.message.list({ sessionID: session.id, limit: 100 })
  ).data;
  const answer = messages
    .flatMap((m) =>
      m.type === "assistant"
        ? m.content.flatMap((p) => (p.type === "text" ? [p.text] : []))
        : [],
    )
    .join(" ");
  const errors = messages.flatMap((m) =>
    m.type === "assistant" && m.error ? [redactor.text(m.error.message)] : [],
  );
  const passed =
    /red.{0,30}circle|circle.{0,30}red/i.test(answer) &&
    /blue.{0,30}rectang|rectang.{0,30}blue/i.test(answer) &&
    /yellow.{0,30}triangle|triangle.{0,30}yellow/i.test(answer);
  report = {
    ...report,
    passed,
    realProviderVisionTested: !!answer,
    answer,
    errors,
    engineVersion: supervisor.status.version,
  };
} catch (error) {
  report = { ...report, error: redactor.error(error) };
} finally {
  if (ownSession)
    await supervisor.client?.session
      .remove({ sessionID: ownSession })
      .catch(() => {}); // Only this generated control session.
  const active = await supervisor.client?.session
    .active()
    .catch(() => undefined);
  // Do not stop a service already running before the check, or interrupt other work.
  if (!existed && active && !Object.keys(active).length)
    await supervisor.stop();
}
await fs.writeFile(
  "test-results/vision-selected-verification.json",
  JSON.stringify(report, null, 2),
);
console.log(JSON.stringify(report));
