import { _electron as electron } from "playwright";
import fs from "node:fs/promises";
import path from "node:path";
import http from "node:http";
import assert from "node:assert/strict";
import { deflateSync, crc32 } from "node:zlib";

const directory = path.resolve(`.runtime/edit-message-ui-${process.pid}`);
const project = path.join(directory, "Проект редактирования");
await fs.mkdir(project, { recursive: true });
await fs.mkdir("test-results", { recursive: true });
const attachmentPath = path.join(project, "reference.png");
const pngChunk = (type, data) => {
  const body = Buffer.concat([Buffer.from(type), data]);
  const length = Buffer.alloc(4),
    checksum = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  checksum.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, checksum]);
};
const header = Buffer.alloc(13);
header.writeUInt32BE(32, 0);
header.writeUInt32BE(32, 4);
header[8] = 8;
header[9] = 6;
const pixels = Buffer.alloc(32 * 129, 255);
for (let y = 0; y < 32; y++) pixels[y * 129] = 0;
await fs.writeFile(
  attachmentPath,
  Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk("IHDR", header),
    pngChunk("IDAT", deflateSync(pixels)),
    pngChunk("IEND", Buffer.alloc(0)),
  ]),
);
await fs.writeFile(
  path.join(project, "keep.txt"),
  "Сохранить изменения файлов\n",
);
const requests = [];
let releaseEdited;
const server = http.createServer(async (request, response) => {
  if (request.url !== "/v1/chat/completions") {
    response.writeHead(404).end();
    return;
  }
  let raw = "";
  for await (const chunk of request) raw += chunk;
  const body = JSON.parse(raw);
  if (body.tools?.length) requests.push(body);
  const text = JSON.stringify(body.messages.at(-1));
  response.writeHead(200, { "Content-Type": "text/event-stream" });
  const chunk = (delta, finish_reason = null) =>
    response.write(
      `data: ${JSON.stringify({ id: `chatcmpl-edit-${requests.length}`, object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model: body.model, choices: [{ index: 0, delta, finish_reason }] })}\n\n`,
    );
  const answer = text.includes("ORIGINAL_WAIT")
    ? "ORIGINAL_REPLY_PARTIAL"
    : text.includes("EDITED_WAIT")
      ? "EDITED_REPLY_PARTIAL"
      : "KEPT_REPLY";
  chunk({ role: "assistant", content: answer });
  if (text.includes("ORIGINAL_WAIT") || text.includes("EDITED_WAIT"))
    await new Promise((resolve) => {
      const timer = setTimeout(resolve, 30000);
      if (text.includes("EDITED_WAIT"))
        releaseEdited = () => {
          clearTimeout(timer);
          resolve();
        };
      response.once("close", () => {
        clearTimeout(timer);
        resolve();
      });
    });
  if (response.destroyed) return;
  chunk({}, "stop");
  response.end("data: [DONE]\n\n");
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
let app, page;
const errors = [];
try {
  app = await electron.launch({
    args: ["."],
    env: { ...process.env, FORGE_DATA_DIR: directory },
    timeout: 30000,
  });
  page = await app.firstWindow();
  await app.evaluate(async ({ clipboard }) => {
    globalThis.forgeEditClipboardBackup = await clipboard.read();
  });
  page.on("pageerror", (error) => errors.push(error.message));
  await page.waitForSelector(".status-dot.ready", { timeout: 40000 });
  await app.evaluate(({ dialog }, project) => {
    dialog.showOpenDialog = async () => ({
      canceled: false,
      filePaths: [project],
    });
  }, project);
  await page
    .getByRole("button", { name: "Выбрать проект", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Открыть другую папку…", exact: true })
    .click();
  const model = { id: "edit-fixture", providerID: "edit-qa" };
  await page.evaluate(
    async ({ port, model }) => {
      await window.desktop.customProvider({
        id: model.providerID,
        name: "Edit QA",
        baseUrl: `http://127.0.0.1:${port}/v1`,
        model: model.id,
        runtime: "compatible",
        key: "local-test-key",
        images: true,
        tools: true,
      });
      await window.desktop.savePreferences({ model });
    },
    { port: server.address().port, model },
  );
  await page.reload();
  await page
    .getByRole("button", { name: "Выбрать модель" })
    .filter({ hasText: "edit-fixture" })
    .waitFor();
  const input = page.getByRole("textbox", {
    name: "Сообщение агенту",
    exact: true,
  });
  const send = page.getByRole("button", {
    name: "Отправить сообщение",
    exact: true,
  });
  await input.fill("KEEP_HISTORY");
  await send.click();
  await page
    .locator(".assistant-message")
    .getByText("KEPT_REPLY", { exact: true })
    .waitFor();
  await page
    .getByRole("button", { name: "Остановить агента" })
    .waitFor({ state: "detached" });
  const userMessage = page.locator(".user-message-wrap").last();
  await userMessage.hover();
  await userMessage
    .getByRole("button", { name: "Копировать сообщение", exact: true })
    .click();
  assert.equal(
    await app.evaluate(({ clipboard }) => clipboard.readText()),
    "KEEP_HISTORY",
  );
  assert.ok((await userMessage.locator("time").innerText()).length >= 4);
  await input.fill("ORIGINAL_WAIT");
  await app.evaluate(({ dialog }, file) => {
    dialog.showOpenDialog = async () => ({
      canceled: false,
      filePaths: [file],
    });
  }, attachmentPath);
  await page
    .getByRole("button", { name: "Добавить файлы и возможности", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Файлы и папки", exact: false })
    .click();

  await page.locator(".attachment-chip").waitFor();
  await send.click();
  await page.getByText("ORIGINAL_REPLY_PARTIAL", { exact: true }).waitFor();
  const sessionId = await page.evaluate(
    async () => (await window.desktop.bootstrap()).preferences.sessionId,
  );
  const original = await page.evaluate(
    (id) => window.desktop.openSession(id),
    sessionId,
  );
  const users = original.rows.filter((row) => row.type === "user");
  assert.equal(users.length, 2);
  assert.equal(users.at(-1).images.length, 1);
  const attachmentLayout = await page
    .locator(".user-message-wrap")
    .last()
    .evaluate((element) => {
      const images = element
        .querySelector(".user-attachments")
        .getBoundingClientRect();
      const bubble = element
        .querySelector(".user-message")
        .getBoundingClientRect();
      return { imagesBottom: images.bottom, bubbleTop: bubble.top };
    });
  assert.ok(
    attachmentLayout.imagesBottom <= attachmentLayout.bubbleTop + 1,
    "Attachments must be above the user bubble",
  );
  const rejectedActive = await page.evaluate(
    async ({ id, messageId, model }) => {
      try {
        await window.desktop.editLastMessage(
          id,
          messageId,
          "INVALID_WHILE_RUNNING",
          model,
          "cautious",
        );
        return false;
      } catch {
        return true;
      }
    },
    { id: sessionId, messageId: users.at(-1).id, model },
  );
  assert.equal(rejectedActive, true);
  await input.press("Escape");
  await page.waitForTimeout(700);
  assert.equal(
    await page.getByRole("button", { name: "Остановить агента" }).count(),
    1,
    "A single Escape must not stop the agent",
  );
  await input.press("Escape");
  await input.press("Escape");
  await page
    .getByRole("button", { name: "Остановить агента" })
    .waitFor({ state: "detached" });
  await page
    .getByRole("button", { name: "Изменить последнее сообщение" })
    .click();
  const editor = page.getByRole("textbox", {
    name: "Изменить сообщение",
    exact: true,
  });
  assert.equal(
    await page.locator('.run-summary[data-status="interrupted"]').count(),
    1,
  );
  assert.equal(
    await page.locator(".system-event.red").count(),
    0,
    "A real user interruption must not render as an error",
  );
  assert.equal(await editor.inputValue(), "ORIGINAL_WAIT");
  await editor.fill("CANCELLED_EDIT");
  await page.getByRole("button", { name: "Отмена", exact: true }).click();
  assert.equal(requests.length, 2);
  await page.getByText("ORIGINAL_REPLY_PARTIAL", { exact: true }).waitFor();
  const rejectedEarlier = await page.evaluate(
    async ({ id, messageId, model }) => {
      try {
        await window.desktop.editLastMessage(
          id,
          messageId,
          "INVALID_EARLIER",
          model,
          "cautious",
        );
        return false;
      } catch {
        return true;
      }
    },
    { id: sessionId, messageId: users[0].id, model },
  );
  assert.equal(rejectedEarlier, true, "Earlier turns must remain protected");
  await page
    .getByRole("button", { name: "Изменить последнее сообщение" })
    .click();
  await editor.fill("EDITED_WAIT");
  for (const size of [
    [1440, 900],
    [780, 600],
  ]) {
    await app.evaluate(
      ({ BrowserWindow }, size) =>
        BrowserWindow.getAllWindows()[0].setSize(...size),
      size,
    );
    await page.waitForTimeout(200);
    const layout = await editor.evaluate((element) => {
      const b = element.getBoundingClientRect();
      const actions = element
        .closest(".user-edit")
        .querySelector(".user-edit-actions")
        .getBoundingClientRect();
      const timeline = element
        .closest(".timeline-scroll")
        .getBoundingClientRect();
      return {
        left: b.left,
        right: b.right,
        width: innerWidth,
        overflow: document.documentElement.scrollWidth > innerWidth,
        actionsVisible:
          actions.top >= timeline.top && actions.bottom <= timeline.bottom,
      };
    });
    assert.ok(
      layout.left >= 0 && layout.right <= layout.width && !layout.overflow,
    );
    assert.ok(
      layout.actionsVisible,
      "Editor actions must stay visible when the window resizes",
    );
    await page.screenshot({ path: `test-results/edit-message-${size[0]}.png` });
  }
  await page.getByRole("button", { name: "Отправить", exact: true }).click();
  await page
    .getByText("EDITED_REPLY_PARTIAL", { exact: true })
    .waitFor()
    .catch(async (error) => {
      console.log(
        "Edit error",
        await page.locator(".error-toast").allTextContents(),
      );
      throw error;
    });
  await page
    .getByText("ORIGINAL_REPLY_PARTIAL", { exact: true })
    .waitFor({ state: "detached" });
  assert.equal(requests.length, 3);
  const editedContext = JSON.stringify(requests[2].messages);
  assert.ok(
    editedContext.includes("KEEP_HISTORY") &&
      editedContext.includes("KEPT_REPLY"),
  );
  assert.ok(editedContext.includes("EDITED_WAIT"));
  assert.ok(
    !editedContext.includes("ORIGINAL_WAIT") &&
      !editedContext.includes("ORIGINAL_REPLY_PARTIAL"),
  );
  const originalImage = requests[1].messages
    .at(-1)
    .content.find((part) => part.type === "image_url");
  const editedImage = requests[2].messages
    .at(-1)
    .content.find((part) => part.type === "image_url");
  assert.ok(
    originalImage && editedImage,
    "The image must be delivered again with the edited request",
  );
  assert.deepEqual(editedImage, originalImage);
  releaseEdited?.();
  await page
    .getByRole("button", { name: "Остановить агента" })
    .waitFor({ state: "detached" });
  const updated = await page.evaluate(
    (id) => window.desktop.openSession(id),
    sessionId,
  );
  assert.equal(updated.rows.filter((row) => row.type === "user").length, 2);
  assert.ok(!JSON.stringify(updated.rows).includes("ORIGINAL_REPLY_PARTIAL"));
  assert.ok(!JSON.stringify(updated.rows).includes("ORIGINAL_WAIT"));
  assert.equal(
    await fs.readFile(path.join(project, "keep.txt"), "utf8"),
    "Сохранить изменения файлов\n",
  );
  await page.reload();
  await page.getByText("EDITED_REPLY_PARTIAL", { exact: true }).waitFor();
  assert.equal(
    await page.getByText("ORIGINAL_REPLY_PARTIAL", { exact: true }).count(),
    0,
  );
  assert.deepEqual(errors, []);
  await fs.writeFile(
    "test-results/edit-message-verification.json",
    JSON.stringify(
      {
        passed: true,
        isolatedProfile: directory,
        sessionId,
        localProviderFixture: true,
        generationRequests: requests.length,
        singleEscapePreservesRun: true,
        doubleEscapeStopsRun: true,
        cancelPreservesHistory: true,
        onlyLastMessageEditable: true,
        oldAnswerExcludedFromContext: true,
        imageAttachmentPreserved: true,
        historyReloaded: true,
        editorSizes: [
          [1440, 900],
          [780, 600],
        ],
        pageErrors: errors,
      },
      null,
      2,
    ),
  );
  console.log(
    "PASS single/double Escape, cancel, last-message validation, replacement of old context, image attachment retention and history reload; files preserved",
  );
} catch (error) {
  if (page) {
    console.error(
      "Visible errors",
      await page.locator(".error-toast, .system-event.red").allTextContents(),
    );
    await page.screenshot({ path: "test-results/edit-message-failure.png" });
  }
  throw error;
} finally {
  await app
    ?.evaluate(({ clipboard }) => {
      if (globalThis.forgeEditClipboardBackup)
        return clipboard.write(globalThis.forgeEditClipboardBackup);
    })
    .catch(() => {});
  await app?.close().catch(() => {});
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
}
