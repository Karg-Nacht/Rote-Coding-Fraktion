import { _electron as electron } from "playwright";
import { Service } from "@opencode/client/service";
import { OpenCode } from "@opencode/client";
import { createCanvas } from "@napi-rs/canvas";
import fs from "node:fs/promises";
import path from "node:path";
import http from "node:http";
import assert from "node:assert/strict";

// This test only contacts the loopback fixture. It makes no real-provider calls.
const directory = path.resolve(`.runtime/multimodal-ui-${process.pid}`);
const projectPath = path.join(directory, "Мультимодальный проект");
const providerID = "multimodal-local-fixture",
  requests = [],
  errors = [];
const canvas = createCanvas(160, 96),
  ctx = canvas.getContext("2d");
ctx.fillStyle = "white";
ctx.fillRect(0, 0, 160, 96);
ctx.fillStyle = "#ee2233";
ctx.fillRect(12, 20, 44, 44);
ctx.fillStyle = "#2255ee";
ctx.beginPath();
ctx.arc(112, 42, 24, 0, Math.PI * 2);
ctx.fill();
const image = canvas.toBuffer("image/png"),
  base64 = image.toString("base64");
let app, page;
const server = http.createServer(async (request, response) => {
  if (request.url !== "/v1/chat/completions")
    return response.writeHead(404).end();
  let raw = "";
  for await (const chunk of request) raw += chunk;
  const body = JSON.parse(raw);
  requests.push(body);
  const images =
    body.messages?.flatMap((message) =>
      Array.isArray(message.content)
        ? message.content.filter((part) => part.type === "image_url")
        : [],
    ) ?? [];
  response.writeHead(200, { "Content-Type": "text/event-stream" });
  for (const [delta, finish_reason] of [
    [
      {
        role: "assistant",
        content: images.length
          ? "FIXTURE_IMAGE_RECEIVED"
          : "FIXTURE_TEXT_RECEIVED",
      },
      null,
    ],
    [{}, "stop"],
  ])
    response.write(
      `data: ${JSON.stringify({ id: "multimodal-fixture", object: "chat.completion.chunk", created: 1, model: body.model, choices: [{ index: 0, delta, finish_reason }] })}\n\n`,
    );
  response.end("data: [DONE]\n\n");
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
await fs.mkdir(projectPath, { recursive: true });
await fs.mkdir("test-results", { recursive: true });
const configPath = path.join(directory, "engine/config/opencode/opencode.json");
await fs.mkdir(path.dirname(configPath), { recursive: true });
await fs.writeFile(
  configPath,
  JSON.stringify({
    providers: {
      [providerID]: {
        name: "Multimodal Local Fixture",
        package: "@opencode/ai/providers/openai-compatible",
        settings: { baseURL: `http://127.0.0.1:${server.address().port}/v1` },
        models: {
          vision: {
            name: "Vision Fixture",
            capabilities: {
              tools: true,
              input: ["text", "image"],
              output: ["text"],
            },
          },
          text: {
            name: "Text Fixture",
            capabilities: { tools: true, input: ["text"], output: ["text"] },
          },
        },
      },
    },
  }),
);
async function launch() {
  app = await electron.launch({
    args: process.env.FORGE_PACKAGED ? [] : ["."],
    executablePath: process.env.FORGE_PACKAGED || undefined,
    env: { ...process.env, FORGE_DATA_DIR: directory },
    timeout: 30000,
  });
  page = await app.firstWindow();
  page.on("pageerror", (error) => errors.push(error.message));
  await page.waitForSelector(".status-dot.ready", { timeout: 45000 });
}
async function chooseModel(name) {
  await page
    .getByRole("button", { name: "Выбрать модель", exact: true })
    .click();
  await page.getByRole('button',{name:'Выбрать другую модель',exact:true}).click();
  await page.getByRole("menuitem", { name: new RegExp(name) }).click();
}
function textPdf() {
  const content =
    "BT /F1 16 Tf 20 140 Td (LOCAL_PDF_TEXT_5162) Tj ET 0 0 1 rg 30 30 70 70 re f";
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 240 180] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    `<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}\nendstream`,
  ];
  let pdf = "%PDF-1.4\n";
  const offsets = objects.map((object, i) => {
    const offset = Buffer.byteLength(pdf);
    pdf += `${i + 1} 0 obj\n${object}\nendobj\n`;
    return offset;
  });
  const xref = Buffer.byteLength(pdf);
  pdf += `xref\n0 6\n0000000000 65535 f \n${offsets.map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`).join("")}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(pdf);
}
async function pasteFile(name, bytes, mime) {
  await page
    .getByRole("textbox", { name: "Сообщение агенту", exact: true })
    .evaluate(
      (element, value) => {
        const transfer = new DataTransfer();
        transfer.items.add(
          new File(
            [Uint8Array.from(atob(value.data), (c) => c.charCodeAt(0))],
            value.name,
            { type: value.mime },
          ),
        );
        element.dispatchEvent(
          new ClipboardEvent("paste", {
            bubbles: true,
            cancelable: true,
            clipboardData: transfer,
          }),
        );
      },
      { name, mime, data: bytes.toString("base64") },
    );
  await page.locator(".attachment-chip").filter({ hasText: name }).waitFor();
}
async function freshSession(project, modelID) {
  await page.evaluate(
    async ({ project, providerID, modelID }) => {
      const model = { id: modelID, providerID };
      const session = await window.desktop.createSession(
        project.id,
        model,
        "cautious",
        "work",
      );
      await window.desktop.savePreferences({
        projectId: project.id,
        sessionId: session.id,
        workspace: "work",
        model,
      });
    },
    { project, providerID, modelID },
  );
  await page.reload();
  await page
    .getByRole("button", { name: "Выбрать модель", exact: true })
    .filter({ hasText: modelID === "text" ? "Text Fixture" : "Vision Fixture" })
    .waitFor();
}
async function sendAndWait(reply) {
  await page
    .getByRole("button", { name: "Отправить сообщение", exact: true })
    .click();
  await page
    .locator(".assistant-message")
    .filter({ hasText: reply })
    .waitFor({ timeout: 45000 });
  await page
    .getByRole("button", { name: "Остановить агента", exact: true })
    .waitFor({ state: "detached", timeout: 20000 });
}
try {
  await launch();
  await app.evaluate(({ dialog }, folder) => {
    dialog.showOpenDialog = async () => ({
      canceled: false,
      filePaths: [folder],
    });
  }, projectPath);
  const project = await page.evaluate(() => window.desktop.addProject());
  const endpoint = await Service.discover({
    file: path.join(directory, "engine/state/opencode/service.json"),
    version: "2.3.0",
  });
  const client = OpenCode.make({
    baseUrl: endpoint.url,
    headers: Service.headers(endpoint),
  });
  await client.credential.create({
    integrationID: providerID,
    value: { type: "key", key: "local-fixture-only" },
    activate: true,
  });
  await client.location.reload();
  await page.evaluate(
    async ({ project, providerID }) => {
      const model = { id: "vision", providerID };
      const session = await window.desktop.createSession(
        project.id,
        model,
        "cautious",
        "work",
      );
      await window.desktop.savePreferences({
        projectId: project.id,
        sessionId: session.id,
        workspace: "work",
        model,
        favoriteModels: [
          { id: "vision", providerID },
          { id: "text", providerID },
        ],
      });
    },
    { project, providerID },
  );
  await page.reload();
  await page
    .getByRole("button", { name: "Выбрать модель", exact: true })
    .filter({ hasText: "Vision Fixture" })
    .waitFor();
  const editor = page.getByRole("textbox", {
    name: "Сообщение агенту",
    exact: true,
  });
  await editor.evaluate((element, data) => {
    const transfer = new DataTransfer();
    transfer.items.add(
      new File(
        [Uint8Array.from(atob(data), (c) => c.charCodeAt(0))],
        "pasted-control.png",
        { type: "image/png" },
      ),
    );
    element.dispatchEvent(
      new ClipboardEvent("paste", {
        bubbles: true,
        cancelable: true,
        clipboardData: transfer,
      }),
    );
  }, base64);
  await page
    .locator(".attachment-chip")
    .filter({ hasText: "pasted-control.png" })
    .waitFor();
  await page.locator(".composer").evaluate((element, data) => {
    const transfer = new DataTransfer();
    transfer.items.add(
      new File(
        [Uint8Array.from(atob(data), (c) => c.charCodeAt(0))],
        "dropped-control.png",
        { type: "image/png" },
      ),
    );
    element.dispatchEvent(
      new DragEvent("drop", {
        bubbles: true,
        cancelable: true,
        dataTransfer: transfer,
      }),
    );
  }, base64);
  await page
    .locator(".attachment-chip")
    .filter({ hasText: "dropped-control.png" })
    .waitFor();
  assert.equal(await page.locator(".attachment-chip").count(), 2);
  await page.locator(".attachment-preview-button").first().click();
  await page
    .getByRole("dialog", { name: "pasted-control.png", exact: true })
    .waitFor();
  assert.ok(
    await page
      .locator(".attachment-detail-image")
      .evaluate((element) => element.complete && element.naturalWidth === 160),
  );
  await page.getByRole("button", { name: "Закрыть", exact: true }).click();
  await chooseModel("Text Fixture");
  assert.equal(
    await page
      .getByRole("button", { name: "Отправить сообщение", exact: true })
      .isDisabled(),
    true,
  );
  await page
    .getByText(
      "Эта модель не принимает изображения. Выберите модель с поддержкой зрения.",
      { exact: true },
    )
    .waitFor();
  await chooseModel("Vision Fixture");
  await editor.fill("Проверь визуальные элементы контрольного изображения.");
  await page
    .getByRole("button", { name: "Отправить сообщение", exact: true })
    .click();
  await page
    .getByText("FIXTURE_IMAGE_RECEIVED", { exact: true })
    .waitFor({ timeout: 45000 });
  await page
    .getByRole("button", { name: "Остановить агента", exact: true })
    .waitFor({ state: "detached", timeout: 20000 });
  const imageRequest = requests.find((body) =>
    body.messages?.some(
      (message) =>
        Array.isArray(message.content) &&
        message.content.some((part) => part.type === "image_url"),
    ),
  );
  assert.ok(imageRequest, "actual local engine sent a multimodal request");
  const sentImages = imageRequest.messages.flatMap((message) =>
    Array.isArray(message.content)
      ? message.content.filter((part) => part.type === "image_url")
      : [],
  );
  assert.equal(sentImages.length, 2);
  for (const part of sentImages)
    assert.equal(part.image_url.url, `data:image/png;base64,${base64}`);
  await page.screenshot({ path: "test-results/multimodal-image-history.png" });
  await app.close();
  app = undefined;
  await launch();
  await page.locator(".user-message-wrap img").first().waitFor();
  const preserved = await page
    .locator(".user-message-wrap img")
    .evaluateAll((images) =>
      images.every((image) => image.complete && image.naturalWidth === 160),
    );
  assert.ok(
    preserved,
    "both sent images still render after an app/engine restart",
  );
  // Plain attachments must arrive as readable text, not opaque file/base64 data.
  await freshSession(project, "text");
  const textMarker = "LOCAL_TEXT_ATTACHMENT_4071\nconst число = 42;";
  await pasteFile("пример.ts", Buffer.from(textMarker), "text/plain");
  await page.locator(".attachment-preview-button").click();
  await page
    .locator(".attachment-text-preview")
    .filter({ hasText: textMarker })
    .waitFor();
  await page.getByRole("button", { name: "Закрыть", exact: true }).click();
  await page
    .getByRole("textbox", { name: "Сообщение агенту", exact: true })
    .fill("Прочитай прикреплённый исходный код.");
  const beforeText = requests.length;
  await sendAndWait("FIXTURE_TEXT_RECEIVED");
  const textRequests = requests.slice(beforeText);
  await fs.writeFile(
    "test-results/multimodal-text-upstream.json",
    JSON.stringify(
      textRequests.map((request) => ({
        model: request.model,
        messages: request.messages.filter((message) => message.role === "user"),
      })),
      null,
      2,
    ),
  );
  assert.ok(
    textRequests.some((request) =>
      JSON.stringify(request.messages).includes("LOCAL_TEXT_ATTACHMENT_4071"),
    ),
    "code attachment becomes readable provider text",
  );
  assert.ok(
    textRequests.every(
      (request) => !JSON.stringify(request.messages).includes("file://"),
    ),
    "local paths are never substituted for content",
  );

  await freshSession(project, "text");
  await pasteFile("таблица.pdf", textPdf(), "application/pdf");
  await page
    .locator(".attachment-chip")
    .filter({ hasText: "1 стр." })
    .waitFor();
  await page
    .getByRole("textbox", { name: "Сообщение агенту", exact: true })
    .fill("Прочитай PDF.");
  const beforePdfText = requests.length;
  await sendAndWait("FIXTURE_TEXT_RECEIVED");
  assert.ok(
    requests
      .slice(beforePdfText)
      .some((request) =>
        JSON.stringify(request.messages).includes("LOCAL_PDF_TEXT_5162"),
      ),
    "PDF compatible extraction reaches a text-only model",
  );

  await freshSession(project, "vision");
  await pasteFile("схема.pdf", textPdf(), "application/pdf");
  await page.locator(".attachment-preview-button").click();
  await page
    .getByLabel("Страницы для визуального анализа", { exact: true })
    .fill("1");
  await page
    .getByRole("button", {
      name: "Подготовить текст и изображения",
      exact: true,
    })
    .click();
  await page
    .getByText(
      "Подготовлены изображения страниц: 1. Превью показывает первую страницу.",
      { exact: true },
    )
    .waitFor();
  await page.locator(".attachment-detail-image").waitFor();
  await page.screenshot({ path: "test-results/multimodal-pdf-preview.png" });
  await page.getByRole("button", { name: "Закрыть", exact: true }).click();
  await page
    .getByRole("textbox", { name: "Сообщение агенту", exact: true })
    .fill("Проанализируй текст и графику выбранной страницы PDF.");
  const beforePdfVisual = requests.length;
  await sendAndWait("FIXTURE_IMAGE_RECEIVED");
  const pdfRequest = requests
    .slice(beforePdfVisual)
    .find((request) =>
      JSON.stringify(request.messages).includes("LOCAL_PDF_TEXT_5162"),
    );
  assert.ok(pdfRequest, "PDF page text reaches the model");
  assert.ok(
    pdfRequest.messages.some(
      (message) =>
        Array.isArray(message.content) &&
        message.content.some(
          (part) =>
            part.type === "image_url" &&
            part.image_url.url.startsWith("data:image/png;base64,"),
        ),
    ),
    "selected PDF page PNG reaches the same model request",
  );
  assert.deepEqual(errors, []);
  await fs.writeFile(
    "test-results/multimodal-verification.json",
    JSON.stringify(
      {
        passed: true,
        engineVersion: "2.3.0",
        packaged: !!process.env.FORGE_PACKAGED,
        checks: [
          "clipboard bytes",
          "drop bytes",
          "preview",
          "nonvision model blocked",
          "actual engine upstream data URI equality",
          "history after restart",
          "readable text/code attachment at upstream",
          "text-only model receives extracted PDF text",
          "PDF page selection and preview",
          "PDF text and PNG in one upstream request",
        ],
        realProviderVisionTested: false,
        imageCount: sentImages.length,
      },
      null,
      2,
    ),
  );
  console.log(
    "PASS clipboard/drop, preview, nonvision block, engine image/text/PDF requests, PDF page selection, and history after restart; loopback fixture only",
  );
} finally {
  if (app) await app.close().catch(() => {});
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
}
