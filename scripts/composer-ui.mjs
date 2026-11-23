import { _electron as electron } from "playwright";
import { Service } from "@opencode/client/service";
import { OpenCode } from "@opencode/client";
import fs from "node:fs/promises";
import path from "node:path";
import http from "node:http";
import assert from "node:assert/strict";

const directory = path.resolve(`.runtime/composer-ui-${process.pid}`);
const projectPath = path.join(directory, "Мастерская");
const providerID = "composer-qa";
const definitions = {
  reasoning: {
    name: "Claude Opus 4.6 Thinking",
    variants: ["high", "low", "xhigh", "medium"],
  },
  mini: { name: "Mini Reasoner", variants: ["high", "low"] },
  plain: { name: "Simple Chat", variants: [] },
  custom: {
    name: "Provider presets",
    variants: ["balanced-mode", "deep-review"],
  },
};
const requests = [],
  errors = [],
  layouts = [];
let release, app, page;
const server = http.createServer(async (request, response) => {
  if (request.url !== "/v1/chat/completions")
    return response.writeHead(404).end();
  let raw = "";
  for await (const chunk of request) raw += chunk;
  const body = JSON.parse(raw);
  if (body.tools?.length) requests.push(body);
  response.writeHead(200, { "Content-Type": "text/event-stream" });
  const chunk = (delta, finish_reason = null) =>
    response.write(
      `data: ${JSON.stringify({
        id: "chatcmpl-composer",
        object: "chat.completion.chunk",
        created: 1,
        model: body.model,
        choices: [{ index: 0, delta, finish_reason }],
      })}\n\n`,
    );
  chunk({ role: "assistant", content: "COMPOSER_OK" });
  if (body.tools?.length)
    await new Promise((resolve) => {
      const timer = setTimeout(resolve, 20000);
      release = () => {
        clearTimeout(timer);
        resolve();
      };
      response.once("close", release);
    });
  if (!response.destroyed) {
    chunk({}, "stop");
    response.end("data: [DONE]\n\n");
  }
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
await fs.mkdir(projectPath, { recursive: true });
const configPath = path.join(directory, "engine/config/opencode/opencode.json");
await fs.mkdir(path.dirname(configPath), { recursive: true });
await fs.mkdir("test-results", { recursive: true });
await fs.writeFile(
  configPath,
  JSON.stringify(
    {
      providers: {
        [providerID]: {
          name: "Composer QA",
          package: "@opencode/ai/providers/openai-compatible",
          settings: { baseURL: `http://127.0.0.1:${server.address().port}/v1` },
          models: Object.fromEntries(
            Object.entries(definitions).map(([id, value]) => [
              id,
              {
                name: value.name,
                capabilities: {
                  tools: true,
                  input: ["text", "image"],
                  output: ["text"],
                },
                variants: value.variants.map((variant) => ({
                  id: variant,
                  body: { reasoning_effort: variant },
                })),
              },
            ]),
          ),
        },
      },
    },
    null,
    2,
  ),
);

async function launch() {
  app = await electron.launch({
    args: ["."],
    env: { ...process.env, FORGE_DATA_DIR: directory },
    timeout: 30000,
  });
  page = await app.firstWindow();
  page.on("pageerror", (error) => errors.push(error.message));
  await page.waitForSelector(".status-dot.ready", { timeout: 40000 });
}
const modelButton = () =>
  page.getByRole("button", { name: "Выбрать модель", exact: true });
const effortButton = () =>
  page.getByRole("button", { name: "Настроить уровень мышления", exact: true });
const preferences = () =>
  page.evaluate(async () => (await window.desktop.bootstrap()).preferences);
async function choose(id) {
  await modelButton().click();
  await page
    .getByRole("button", { name: "Выбрать другую модель", exact: true })
    .click();
  await page
    .getByRole("menuitem", { name: new RegExp(definitions[id].name) })
    .click();
  await page.locator(".model-popover").waitFor({ state: "detached" });
}
async function checkLayout(width, kind) {
  const value = await page.evaluate(() => {
    const elements = [
      ".composer",
      ".mode-trigger",
      ".model-select",
      ".effort-trigger",
      ".send-button",
      ".composer-popover",
    ];
    const bounds = elements.flatMap((selector) => {
      const el = document.querySelector(selector);
      if (!el) return [];
      const box = el.getBoundingClientRect();
      return [
        {
          selector,
          left: box.left,
          right: box.right,
          top: box.top,
          bottom: box.bottom,
          width: box.width,
        },
      ];
    });
    const children = [
      ...document.querySelectorAll(".composer-toolbar > div"),
    ].map((el) => el.getBoundingClientRect());
    return {
      bounds,
      fits: bounds.every(
        (b) =>
          b.left >= 0 &&
          b.right <= innerWidth &&
          b.top >= 32 &&
          b.bottom <= innerHeight,
      ),
      overlap: children[0].right > children[1].left,
      font: getComputedStyle(document.querySelector(".model-select")).fontSize,
      radius: getComputedStyle(document.querySelector(".composer"))
        .borderRadius,
    };
  });
  assert.ok(value.fits && !value.overlap, JSON.stringify(value));
  assert.equal(value.font, "12px");
  assert.ok(parseInt(value.radius) >= 20);
  layouts.push({ width, kind, ...value });
  await page.screenshot({ path: `test-results/composer-${kind}-${width}.png` });
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
    value: { type: "key", key: "local-composer-fixture" },
    activate: true,
  });
  await client.location.reload();
  await page.evaluate(
    async ({ project, providerID, ids }) => {
      const model = { id: "reasoning", providerID };
      const session = await window.desktop.createSession(
        project.id,
        model,
        "cautious",
      );
      await window.desktop.savePreferences({
        projectId: project.id,
        sessionId: session.id,
        model,
        favoriteModels: ids.map((id) => ({ id, providerID })),
      });
    },
    { project, providerID, ids: Object.keys(definitions) },
  );
  await page.reload();
  await modelButton().filter({ hasText: definitions.reasoning.name }).waitFor();

  // Exact model-specific values, default reset, and keyboard support.
  await effortButton().click();
  let slider = page.getByRole("slider", {
    name: "Уровень мышления",
    exact: true,
  });
  assert.equal(await slider.getAttribute("max"), "4");
  assert.equal(await slider.getAttribute("aria-valuetext"), "По умолчанию");
  assert.ok(await slider.evaluate((el) => el === document.activeElement));
  await slider.press("End");
  await page.waitForFunction(
    async () =>
      (await window.desktop.bootstrap()).preferences.model.variant === "xhigh",
  );
  assert.equal(await slider.getAttribute("aria-valuetext"), "Extra High");
  await slider.press("Home");
  await page.waitForFunction(
    async () => !(await window.desktop.bootstrap()).preferences.model.variant,
  );
  await slider.press("ArrowRight");
  await page.waitForFunction(
    async () =>
      (await window.desktop.bootstrap()).preferences.model.variant === "low",
  );
  await page
    .getByRole("button", { name: "Сбросить уровень по умолчанию" })
    .click();
  await page.waitForFunction(
    async () => !(await window.desktop.bootstrap()).preferences.model.variant,
  );
  await slider.focus();
  await slider.press("Escape");
  assert.ok(
    await effortButton().evaluate((el) => el === document.activeElement),
  );
  await choose("mini");
  await effortButton().click();
  slider = page.getByRole("slider", { name: "Уровень мышления", exact: true });
  assert.equal(await slider.getAttribute("max"), "2");
  // Mouse position also chooses only a supported value.
  const track = await slider.boundingBox();
  await page.mouse.click(track.x + track.width - 8, track.y + track.height / 2);
  await page.waitForFunction(
    async () =>
      (await window.desktop.bootstrap()).preferences.model.variant === "high",
  );
  await slider.press("Escape");
  await choose("plain");
  assert.equal(await effortButton().count(), 0);
  await choose("custom");
  await page
    .getByRole("button", { name: "Вариант модели", exact: true })
    .click();
  slider = page.getByRole("slider", { name: "Вариант модели", exact: true });
  await slider.press("End");
  await page.waitForFunction(
    async () =>
      (await window.desktop.bootstrap()).preferences.model.variant ===
      "deep-review",
  );
  assert.equal(await slider.getAttribute("aria-valuetext"), "deep-review");
  await slider.press("Escape");
  await choose("reasoning");

  // The custom menu must keep actual permission changes and Full Access confirmation.
  const mode = page.getByRole("button", {
    name: "Режим разрешений",
    exact: true,
  });
  await mode.click();
  await page.getByRole("menuitemradio", { name: /^Автономно/ }).click();
  await page.waitForFunction(
    async () =>
      (await window.desktop.bootstrap()).preferences.mode === "autonomous",
  );
  await app.evaluate(({ dialog }) => {
    dialog.showMessageBox = async () => ({ response: 0 });
  });
  await mode.click();
  await page.getByRole("menuitemradio", { name: /^Полный доступ/ }).click();
  await page.getByText("Full Access не включён.", { exact: true }).waitFor();
  assert.equal((await preferences()).mode, "autonomous");
  await page
    .getByRole("button", { name: "Закрыть уведомление", exact: true })
    .click();

  // Real previews and responsive open menus, without changing the user's profile.
  const imagePath = path.join(projectPath, "reference.png");
  const png = await app.evaluate(({ nativeImage }) =>
    nativeImage
      .createFromBitmap(Buffer.alloc(64 * 64 * 4, 130), {
        width: 64,
        height: 64,
      })
      .toPNG()
      .toString("base64"),
  );
  await fs.writeFile(imagePath, Buffer.from(png, "base64"));
  await app.evaluate(({ dialog }, file) => {
    dialog.showOpenDialog = async () => ({
      canceled: false,
      filePaths: [file],
    });
  }, imagePath);
  await page
    .getByRole("button", { name: "Добавить файлы и возможности", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Файлы и папки", exact: false })
    .click();

  await page.locator(".attachment-chip img").waitFor();
  await page
    .getByRole("textbox", { name: "Сообщение агенту", exact: true })
    .fill(
      "Сделай интерфейс компактным и удобным. Сохрани выбранную модель и её уровень мышления.",
    );
  for (const width of [1440, 1080, 780]) {
    await app.evaluate(
      ({ BrowserWindow }, width) =>
        BrowserWindow.getAllWindows()[0].setSize(
          width,
          width === 780 ? 600 : 900,
        ),
      width,
    );
    await page.waitForTimeout(180);
    await checkLayout(width, "closed");
    await effortButton().click();
    slider = page.getByRole("slider", {
      name: "Уровень мышления",
      exact: true,
    });
    await slider.press("End");
    await checkLayout(width, "effort");
    await slider.press("Escape");
    await mode.click();
    await checkLayout(width, "permissions");
    await page.keyboard.press("Escape");
    await modelButton().click();
    await page
      .getByRole("button", { name: "Выбрать другую модель", exact: true })
      .click();
    assert.equal(await page.getByRole("menuitem").count(), 5);
    await checkLayout(width, "models");
    await page.keyboard.press("Escape");
  }

  // Persisted exact effort reaches the local provider, controls lock while running.
  await page
    .getByRole("button", { name: "Удалить reference.png", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Отправить сообщение", exact: true })
    .click();
  await page
    .locator(".assistant-message")
    .getByText("COMPOSER_OK", { exact: true })
    .waitFor();
  assert.equal(requests.at(-1).reasoning_effort, "xhigh");
  assert.equal(await modelButton().isDisabled(), true);
  assert.equal(await effortButton().isDisabled(), true);
  assert.equal(await mode.isDisabled(), true);
  release();
  await page
    .getByRole("button", { name: "Остановить агента", exact: true })
    .waitFor({ state: "detached" });
  await app.close();
  await launch();
  await effortButton().filter({ hasText: "Extra High" }).waitFor();
  assert.deepEqual((await preferences()).model, {
    id: "reasoning",
    providerID,
    variant: "xhigh",
  });
  assert.equal((await preferences()).mode, "autonomous");
  assert.deepEqual(errors, []);
  await fs.writeFile(
    "test-results/composer-verification.json",
    JSON.stringify(
      {
        passed: true,
        layouts,
        checks: [
          "adaptive slider",
          "exact wire variant",
          "keyboard and pointer",
          "default reset",
          "custom variants",
          "no-variant model",
          "Full Access cancellation",
          "favorites only",
          "attachments",
          "running lock",
          "restart persistence",
        ],
      },
      null,
      2,
    ),
  );
  console.log(
    "PASS composer, adaptive effort, actual permissions, local provider request and restart; 1440/1080/780 layouts",
  );
} finally {
  release?.();
  if (app) await app.close().catch(() => {});
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
}
