import { _electron as electron } from "playwright";
import { Service } from "@opencode/client/service";
import { OpenCode } from "@opencode/client";
import fs from "node:fs/promises";
import path from "node:path";
import assert from "node:assert/strict";
import http from "node:http";
import { revealActivity, revealTaskDiff } from "./activity-ui-controls.mjs";
const qa = JSON.parse(
  await fs.readFile("test-results/desktop-verification.json", "utf8"),
);
const engineQa = JSON.parse(
  await fs.readFile("test-results/engine-verification.json", "utf8"),
);
const binary = path.resolve("node_modules/@opencode/cli/bin/opencode.exe");
const connection = async (dir, start = false) => {
  const env = {
    XDG_DATA_HOME: path.join(dir, "data"),
    XDG_CONFIG_HOME: path.join(dir, "config"),
    XDG_CACHE_HOME: path.join(dir, "cache"),
    XDG_STATE_HOME: path.join(dir, "state"),
  };
  const file = path.join(env.XDG_STATE_HOME, "opencode/service.json");
  const endpoint = start
    ? await Service.ensure({
        file,
        env,
        version: "2.3.0",
        command: [
          binary,
          "serve",
          "--service",
          "--hostname",
          "127.0.0.1",
          "--port",
          "0",
        ],
      })
    : await Service.discover({ file, version: "2.3.0" });
  assert.ok(endpoint);
  return {
    client: OpenCode.make({
      baseUrl: endpoint.url,
      headers: Service.headers(endpoint),
    }),
    file,
  };
};
const source = await connection(path.join(engineQa.directory, "engine"), true);
const largeHistory = await source.client.experimental.session.export({
  sessionID: engineQa.longHistoryId,
});
await Service.stop({ file: source.file, pty: "clear" });
const provider = http.createServer(async (request, response) => {
  let body = "";
  for await (const chunk of request) body += chunk;
  const input = JSON.parse(body);
  response.writeHead(200, { "Content-Type": "text/event-stream" });
  const chunk = (delta, reason = null) =>
    response.write(
      `data: ${JSON.stringify({ id: "chatcmpl-desktop-fixture", object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model: input.model, choices: [{ index: 0, delta, finish_reason: reason }] })}\n\n`,
    );
  chunk({ role: "assistant", content: "UI_FIXTURE_FIRST_CHUNK" });
  await new Promise((r) => {
    const timer = setTimeout(r, 3000);
    response.once("close", () => {
      clearTimeout(timer);
      r();
    });
  });
  if (response.destroyed) return;
  chunk({ content: " UI_FIXTURE_COMPLETE" });
  chunk({}, "stop");
  response.end("data: [DONE]\n\n");
});
await new Promise((r) => provider.listen(0, "127.0.0.1", r));
const port = provider.address().port;
const app = await electron.launch({
  args: process.env.FORGE_PACKAGED ? [] : ["."],
  executablePath: process.env.FORGE_PACKAGED || undefined,
  env: { ...process.env, FORGE_DATA_DIR: qa.dataDir },
  timeout: 30000,
});
try {
  const page = await app.firstWindow();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.waitForFunction(
    () => document.querySelector(".status-dot.ready"),
    null,
    { timeout: 40000 },
  );
  const original = await page.evaluate(
    async (id) => (await window.desktop.openSession(id)).session.title,
    qa.sessionId,
  );
  await page
    .locator(".session-link")
    .filter({ hasText: original })
    .first()
    .click();
  await revealActivity(page.locator(".action-group").last(), "shell");
  await page
    .locator(".tool-summary")
    .filter({ hasText: "check.mjs" })
    .first()
    .click();
  await page.waitForTimeout(500);
  const overlaps = await page.evaluate(() => {
    const boxes = [...document.querySelectorAll(".timeline-item")].map((el) =>
      el.getBoundingClientRect(),
    );
    return boxes.slice(1).filter((box, i) => box.top < boxes[i].bottom - 1)
      .length;
  });
  assert.equal(overlaps, 0, "Expanded tools must not overlap later text");
  assert.equal(
    await page
      .getByRole("button", {
        name: "Загрузить предыдущие сообщения",
        exact: true,
      })
      .count(),
    0,
  );
  await page.screenshot({ path: "test-results/desktop-expanded-final.png" });
  await revealTaskDiff(page);
  await page.locator(".file-edit-card .file-change-toggle").first().click();
  await page
    .locator(".file-edit-card")
    .getByRole("button", { name: /^Открыть diff / })
    .first()
    .click();
  await page.getByRole("dialog").locator(".shiki").waitFor();
  await page.screenshot({ path: "test-results/desktop-diff-highlighted.png" });
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Закрыть", exact: true })
    .click();
  console.log(
    "PASS expanded geometry, scoped edit card and Shiki diff under CSP",
  );
  await page.getByRole("button", { name: "Настройки", exact: true }).click();
  await page.getByRole("button", { name: "LM Studio", exact: true }).click();
  await page
    .getByLabel("Название", { exact: true })
    .fill("QA UI local provider");
  await page.getByLabel("ID провайдера", { exact: true }).fill("qa-ui");
  await page
    .getByLabel("Base URL", { exact: true })
    .fill(`http://127.0.0.1:${port}/v1`);
  await page.getByLabel("Точный ID модели").fill("ui-fixture");
  await page
    .getByRole("button", { name: "Сохранить подключение", exact: true })
    .click();
  await page
    .getByText("Провайдер добавлен. Модель доступна в поле ввода.")
    .waitFor();
  await page.screenshot({ path: "test-results/desktop-settings.png" });
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Закрыть", exact: true })
    .click();
  await page.locator(".new-chat").click();
  await page.locator(".session-empty").waitFor();
  await page
    .getByRole("button", { name: "Выбрать модель", exact: true })
    .click();
  await page.getByRole("menuitem", { name: /Найти и закрепить/ }).click();
  await page
    .locator(".model-option")
    .filter({ hasText: "ui-fixture" })
    .locator("button")
    .first()
    .click();
  await page
    .getByRole("dialog", { name: "Каталог моделей" })
    .getByRole("button", { name: "Закрыть" })
    .click();
  await page.getByRole("button", { name: "Выбрать модель" }).click();
  await page.getByRole("menuitem").filter({ hasText: "ui-fixture" }).click();
  await page
    .getByRole("textbox", { name: "Сообщение агенту" })
    .fill("UI test fixture streaming and interruption");
  await page
    .getByRole("button", { name: "Отправить сообщение", exact: true })
    .click();
  await page
    .getByText("UI_FIXTURE_FIRST_CHUNK", { exact: true })
    .waitFor({ timeout: 20000 });
  assert.equal(
    await page.getByText("UI_FIXTURE_COMPLETE", { exact: false }).count(),
    0,
  );
  await page
    .getByRole("button", { name: "Остановить агента", exact: true })
    .click();
  await page.locator('.run-summary[data-status="interrupted"]').waitFor();
  console.log(
    "PASS custom provider settings, actual SSE first chunk and Stop button",
  );
  const { client } = await connection(path.join(qa.dataDir, "engine"));
  const state = await page.evaluate(() => window.desktop.bootstrap());
  const target = state.projects[0].path;
  const imported = await client.experimental.session.import({
    ...largeHistory,
    location: { directory: target },
  });
  await page
    .getByRole("button", {
      name: "QA fixture: 2000 history entries",
      exact: true,
    })
    .click({ timeout: 20000 });
  await page
    .getByRole("button", {
      name: "Загрузить предыдущие сообщения",
      exact: true,
    })
    .waitFor();
  let loads = 0;
  while (
    await page
      .getByRole("button", {
        name: "Загрузить предыдущие сообщения",
        exact: true,
      })
      .count()
  ) {
    await page
      .getByRole("button", {
        name: "Загрузить предыдущие сообщения",
        exact: true,
      })
      .click();
    await page.waitForTimeout(150);
    if (++loads > 15) throw new Error("History pagination failed to terminate");
  }
  const snapshot = await page.evaluate(
    (id) => window.desktop.openSession(id),
    imported.id,
  );
  assert.equal(snapshot.rows.length, 2000);
  assert.ok((await page.locator(".timeline-item").count()) < 60);
  await page.locator(".timeline-scroll").evaluate((el) => {
    el.scrollTop = 0;
  });
  await page
    .getByRole("button", { name: "К последнему сообщению", exact: true })
    .waitFor();
  await page
    .getByRole("button", { name: "К последнему сообщению", exact: true })
    .click();
  await page.waitForTimeout(300);
  await page.screenshot({ path: "test-results/desktop-large-history.png" });
  console.log(
    "PASS 2000 real engine history entries, pagination, DOM virtualization and jump button",
    { loads, rendered: await page.locator(".timeline-item").count() },
  );
  // Imported QA records exercise media/log UI; this is test data, never a product demo mode.
  const blank = await client.session.create({
    title: "QA fixture: images and large logs",
    location: { directory: target },
  });
  await client.session.remove({ sessionID: blank.id });
  const now = Date.now(),
    png =
      "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aI/8AAAAASUVORK5CYII=";
  await client.experimental.session.import({
    info: blank,
    location: { directory: target },
    messages: [
      {
        id: `msg_${now.toString(16)}QaFixtureMedia0001`,
        type: "assistant",
        agent: "build",
        model: { id: "fixture", providerID: "qa" },
        time: { created: now, completed: now + 2 },
        content: [
          {
            type: "tool",
            id: "qa-image",
            name: "read",
            time: { created: now, completed: now + 1 },
            state: {
              status: "completed",
              input: { path: "QA fixture.png" },
              content: [
                {
                  type: "file",
                  uri: png,
                  mime: "image/png",
                  name: "QA fixture.png",
                },
              ],
            },
          },
          {
            type: "tool",
            id: "qa-log",
            name: "shell",
            time: { created: now + 1, completed: now + 2 },
            state: {
              status: "completed",
              input: { command: "QA fixture 10000 log lines" },
              content: [
                {
                  type: "text",
                  text: Array.from(
                    { length: 10000 },
                    (_, i) => `QA_LOG_LINE_${i}`,
                  ).join("\n"),
                },
              ],
              metadata: { exit: 0 },
            },
          },
        ],
      },
    ],
  });
  await page
    .getByRole("button", {
      name: "QA fixture: images and large logs",
      exact: true,
    })
    .click({ timeout: 20000 });
  await page.locator(".image-gallery button").first().click();
  await page.getByRole("dialog").locator("img").waitFor();
  assert.equal(
    await page
      .getByRole("dialog")
      .locator("img")
      .evaluate((img) => img.naturalWidth),
    1,
  );
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Закрыть", exact: true })
    .click();
  await revealActivity(page.locator(".action-group").last(), "shell");
  await page
    .locator(".tool-summary")
    .filter({ hasText: "QA fixture 10000 log lines" })
    .click();
  await page.getByRole("button", { name: "Показать сохранённый вывод" }).click();
  await page.locator(".virtual-log").waitFor();
  assert.ok((await page.locator(".virtual-log>div>div").count()) < 60);
  console.log(
    "PASS image preview/full view and 10000-line virtual log fixture",
  );
  assert.deepEqual(errors, []);
  await fs.writeFile(
    "test-results/desktop-followup-verification.json",
    JSON.stringify(
      {
        passed: true,
        expandedOverlap: false,
        highlightedDiff: true,
        customProvider: true,
        sseFirstChunk: true,
        stop: true,
        historyEntries: 2000,
        renderedHistoryItems: await page.locator(".timeline-item").count(),
        virtualLog: true,
        imageFixture: true,
        errors,
      },
      null,
      2,
    ),
  );
} catch (error) {
  await (
    await app.firstWindow()
  )
    .screenshot({ path: "test-results/followup-failure.png" })
    .catch(() => {});
  throw error;
} finally {
  await app.close();
  provider.closeAllConnections();
  await new Promise((r) => provider.close(r));
}
