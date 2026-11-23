import fs from "node:fs/promises";
import path from "node:path";
import { createCanvas } from "@napi-rs/canvas";
import { OpenCodeSupervisor } from "../electron/supervisor";
import { SessionCoordinator } from "../electron/coordinator";
import { LocalStorage } from "../electron/storage";
import { MediaService } from "../electron/media";
import { Redactor } from "../electron/security";

// Optional live quality check: use only an enabled free vision model in a fresh
// profile, with a generated control image. Never import a user's credentials.
const directory = path.resolve(`.runtime/vision-live-${process.pid}`);
const folder = path.join(directory, "project");
await fs.mkdir(folder, { recursive: true });
await fs.mkdir("test-results", { recursive: true });
const storage = new LocalStorage(directory);
const media = new MediaService(path.join(directory, "attachments"));
const supervisor = new OpenCodeSupervisor(
  path.join(directory, "engine"),
  path.resolve("node_modules/@opencode/cli/bin/opencode.exe"),
  new Redactor(),
  () => {},
);
const coordinator = new SessionCoordinator(
  storage,
  supervisor,
  media,
  () => {},
);
let report: Record<string, unknown> = {
  passed: false,
  realProviderVisionTested: false,
};
try {
  await coordinator.start();
  const project = storage.addProject(folder);
  const models = await coordinator.models(project.id);
  const available = models.filter(
    (m) => m.enabled && m.image && /(?:^|[-/:])free(?:$|[-/:])/i.test(m.id),
  );
  if (!available.length) {
    report = {
      ...report,
      status: "unavailable",
      reason:
        "No enabled free vision model in isolated profile; no user credentials accessed.",
      enabledVisionModels: models
        .filter((m) => m.enabled && m.image)
        .map((m) => `${m.providerID}/${m.id}`),
    };
  } else {
    const model = available[0];
    const canvas = createCanvas(360, 240),
      context = canvas.getContext("2d");
    context.fillStyle = "white";
    context.fillRect(0, 0, 360, 240);
    context.fillStyle = "#e00000";
    context.beginPath();
    context.arc(70, 70, 35, 0, Math.PI * 2);
    context.fill();
    context.fillStyle = "#0044dd";
    context.fillRect(180, 30, 130, 70);
    context.fillStyle = "#ffc800";
    context.beginPath();
    context.moveTo(110, 210);
    context.lineTo(170, 120);
    context.lineTo(230, 210);
    context.closePath();
    context.fill();
    const [attachment] = await media.import([
      {
        name: "control.png",
        mime: "image/png",
        bytes: canvas.toBuffer("image/png"),
      },
    ]);
    const session = await coordinator.create(
      project.id,
      { id: model.id, providerID: model.providerID },
      "cautious",
      "chat",
    );
    await coordinator.send(
      session.id,
      "Describe the colors, shapes and approximate positions visible in the attached image. Reply in English, in one short sentence. Do not use tools.",
      { id: model.id, providerID: model.providerID },
      "cautious",
      [attachment.id],
    );
    let snapshot;
    const deadline = Date.now() + 90000;
    do {
      await new Promise((resolve) => setTimeout(resolve, 500));
      snapshot = await coordinator.snapshot(session.id);
    } while (snapshot.session.running && Date.now() < deadline);
    if (snapshot.session.running) await coordinator.stop(session.id);
    const answer = snapshot.rows
      .filter((row) => row.type === "text")
      .map((row) => row.text)
      .join(" ");
    const passed =
      /red.{0,24}circle|circle.{0,24}red/i.test(answer) &&
      /blue.{0,24}rectang|rectang.{0,24}blue/i.test(answer) &&
      /yellow.{0,24}triangle|triangle.{0,24}yellow/i.test(answer);
    report = {
      passed,
      realProviderVisionTested: !!answer,
      model: `${model.providerID}/${model.id}`,
      answer,
      status: snapshot.session.outcome,
      errors: snapshot.rows.flatMap((row) =>
        row.type === "system" && row.status === "error" ? [row.text] : [],
      ),
    };
  }
} catch (error) {
  report = {
    ...report,
    status: "error",
    error: supervisor.redactor.error(error),
  };
} finally {
  await coordinator.close();
  storage.close();
}
await fs.writeFile(
  "test-results/vision-live-verification.json",
  JSON.stringify(report, null, 2),
);
console.log(JSON.stringify(report));
