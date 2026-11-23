import { selectValue } from "./select-ui.mjs";
import { _electron as electron } from "playwright";
import fs from "node:fs/promises";
import path from "node:path";
import assert from "node:assert/strict";
import http from "node:http";

// Explicit OpenAI-compatible transport fixture, not a simulated product provider.
const directory = path.resolve(`.runtime/omniroute-ui-${process.pid}`);
const project = path.join(directory, "QA project");
await fs.mkdir(project, { recursive: true });
const key = "qa-omniroute-fixture-key",
  exactModel = "qa-coding-combo";
let catalogAuth = false,
  promptAuth = false,
  promptModel,
  promptTools = false;
let failCatalogOnce = true;
const server = http.createServer(async (request, response) => {
  if (request.url === "/v1/models") {
    catalogAuth = request.headers.authorization === `Bearer ${key}`;
    if (failCatalogOnce) {
      failCatalogOnce = false;
      response.writeHead(503, { "content-type": "application/json" }).end(
        JSON.stringify({
          error: {
            code: "CATALOG_UNAVAILABLE",
            correlation_id: "qa-ui-request-503",
          },
        }),
      );
      return;
    }
    response.setHeader("content-type", "application/json");
    response.end(
      JSON.stringify({
        data: [
          { id: "provider/model:exact", name: "QA model" },
          { id: exactModel },
        ],
      }),
    );
    return;
  }
  if (request.url !== "/v1/chat/completions") {
    response.writeHead(404).end();
    return;
  }
  let text = "";
  for await (const chunk of request) text += chunk;
  const input = JSON.parse(text);
  promptAuth = request.headers.authorization === `Bearer ${key}`;
  promptModel = input.model;
  promptTools = Array.isArray(input.tools) && input.tools.length > 0;
  assert.equal(input.stream, true);
  response.writeHead(200, { "Content-Type": "text/event-stream" });
  const chunk = (delta, finish_reason = null) =>
    response.write(
      `data: ${JSON.stringify({ id: "chatcmpl-omniroute-fixture", object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model: input.model, choices: [{ index: 0, delta, finish_reason }] })}\n\n`,
    );
  chunk({ role: "assistant", content: "OMNIROUTE_FIXTURE_" });
  await new Promise((r) => setTimeout(r, 500));
  if (response.destroyed) return;
  chunk({ content: "TRANSPORT_OK" });
  chunk({}, "stop");
  response.end("data: [DONE]\n\n");
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const baseUrl = `http://127.0.0.1:${server.address().port}/v1`;
const app = await electron.launch({
  args: process.env.FORGE_PACKAGED ? [] : ["."],
  executablePath: process.env.FORGE_PACKAGED || undefined,
  env: { ...process.env, FORGE_DATA_DIR: directory },
  timeout: 30000,
});
let page;
async function openOmniRoute() {
  await page.getByRole("button", { name: "Добавить подключение" }).click();
  await page.getByRole("dialog", { name: "Добавить подключение" })
    .getByRole("button", { name: "OmniRoute", exact: true }).click();
}
try {
  page = await app.firstWindow();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.waitForSelector(".status-dot.ready", { timeout: 40000 });
  await app.evaluate(({ dialog }, directory) => {
    dialog.showOpenDialog = async () => ({
      canceled: false,
      filePaths: [directory],
    });
  }, project);
  await page.getByRole("button", { name: "Выбрать проект", exact: true }).click();
  await page.getByRole("button", { name: "Открыть другую папку…", exact: true }).click();
  await page.locator(".composer").waitFor();
  await page.getByRole("button", { name: "Настройки", exact: true }).click();
  await page
    .getByRole("button", { name: "Модели и подключения", exact: true })
    .click();
  await openOmniRoute();
  assert.equal(
    await page.getByLabel("Base URL", { exact: true }).inputValue(),
    "http://localhost:20128/v1",
  );
  await page.getByLabel("Base URL", { exact: true }).fill(`${baseUrl}/`);
  await page.locator('input[type="password"]').fill(key);
  await page
    .getByRole("button", { name: "Загрузить модели OmniRoute", exact: true })
    .click();
  await page
    .getByRole("alert")
    .getByText(/HTTP 503/)
    .waitFor();
  const diagnostic = await page.getByRole("alert").innerText();
  assert.ok(
    diagnostic.includes("CATALOG_UNAVAILABLE") &&
      diagnostic.includes("qa-ui-request-503"),
  );
  assert.equal(diagnostic.includes("Проверьте Base URL"), false);
  assert.equal(
    await page.locator(".connection-form .custom-select:disabled").count(),
    0,
  );
  await page.screenshot({ path: "test-results/omniroute-503.png" });
  await page
    .getByRole("button", { name: "Закрыть уведомление", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Загрузить модели OmniRoute", exact: true })
    .click();
  const catalog = page.getByRole("combobox", { name: "Каталог OmniRoute · 2" });
  await catalog.waitFor();
  await selectValue(catalog, exactModel);
  assert.equal(
    await page.getByRole("textbox", { name: /^Точный ID модели/ }).inputValue(),
    exactModel,
  );
  assert.equal(catalogAuth, true);
  for (const size of [
    [1440, 960],
    [780, 600],
  ]) {
    await app.evaluate(
      ({ BrowserWindow }, size) =>
        BrowserWindow.getAllWindows()[0].setSize(...size),
      size,
    );
    await catalog.scrollIntoViewIfNeeded();
    await page.screenshot({
      path: `test-results/omniroute-settings-${size[0]}.png`,
    });
    const overflow = await page
      .locator(".settings-content")
      .evaluate((el) => el.scrollWidth > el.clientWidth);
    assert.equal(overflow, false);
  }
  await page
    .getByRole("button", { name: "Сохранить подключение", exact: true })
    .click();
  await page
    .getByText("Провайдер добавлен. Модель доступна в поле ввода.")
    .waitFor();
  const config = await fs.readFile(
    path.join(directory, "engine/config/opencode/opencode.json"),
    "utf8",
  );
  assert.equal(config.includes(key), false);
  const provider = JSON.parse(config).providers.omniroute;
  assert.equal(provider.package, "@opencode/ai/providers/openai-compatible");
  assert.equal(provider.settings.baseURL, baseUrl);
  assert.ok(provider.models[exactModel].capabilities.tools);
  // Regression: adding a second model must preserve the provider URL and stored key.
  await openOmniRoute();
  assert.equal(
    await page.getByLabel("Base URL", { exact: true }).inputValue(),
    baseUrl,
  );
  assert.equal(await page.locator('input[type="password"]').inputValue(), "");
  await page
    .getByRole("button", { name: "Загрузить модели OmniRoute", exact: true })
    .click();
  await selectValue(page.getByLabel("Каталог OmniRoute · 2"), "provider/model:exact");
  assert.equal(catalogAuth, true);
  await page
    .getByRole("button", { name: "Сохранить подключение", exact: true })
    .click();
  await page
    .getByText("Провайдер добавлен. Модель доступна в поле ввода.")
    .waitFor();
  const second = JSON.parse(
    await fs.readFile(
      path.join(directory, "engine/config/opencode/opencode.json"),
      "utf8",
    ),
  ).providers.omniroute;
  assert.equal(second.settings.baseURL, baseUrl);
  assert.deepEqual(
    Object.keys(second.models).sort(),
    [exactModel, "provider/model:exact"].sort(),
  );
  await openOmniRoute();
  await page
    .getByLabel("Base URL", { exact: true })
    .fill(baseUrl.replace("/v1", "/other/v1"));
  await page
    .getByRole("button", { name: "Загрузить модели OmniRoute", exact: true })
    .click();
  await page
    .getByRole("alert")
    .getByText(/Для нового адреса введите API ключ явно/)
    .waitFor();
  await page
    .getByRole("button", { name: "Закрыть уведомление", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Закрыть настройки", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Выбрать модель", exact: true })
    .click();
  await page.getByRole("button", { name: "Выбрать другую модель", exact:true }).click();
  await page.getByRole("menuitem", { name: /Найти и закрепить/ }).click();
  await page.getByRole('combobox',{name:'Поиск моделей'}).fill(exactModel);
  await page
    .locator(".catalog-model-row")
    .filter({ hasText: exactModel })
    .locator(".catalog-pin")
    .click();
  await page
    .getByRole("dialog", { name: "Каталог моделей" })
    .getByRole("button", { name: "Закрыть каталог моделей" })
    .click();
  await page.getByRole("button", { name: "Выбрать модель" }).click();
  await page.getByRole("button", { name: "Выбрать другую модель", exact:true }).click();
  await page.getByRole("menuitem").filter({ hasText: exactModel }).click();
  await page
    .getByRole("textbox", { name: "Сообщение агенту" })
    .fill("Isolated OmniRoute transport fixture only");
  await page
    .getByRole("button", { name: "Отправить сообщение", exact: true })
    .click();
  await page
    .locator(".assistant-message")
    .getByText("OMNIROUTE_FIXTURE_TRANSPORT_OK", { exact: true })
    .waitFor({ timeout: 30000 });
  await page.locator('.run-summary[data-status="succeeded"]').waitFor();
  assert.equal(promptAuth, true);
  assert.equal(promptModel, exactModel);
  assert.equal(promptTools, true);
  assert.deepEqual(errors, []);
  await fs.writeFile(
    "test-results/omniroute-verification.json",
    JSON.stringify(
      {
        passed: true,
        packaged: !!process.env.FORGE_PACKAGED,
        preset: true,
        server503Diagnostic: true,
        catalogAuth,
        exactComboId: promptModel,
        promptAuth,
        promptTools,
        realEngineTransport: true,
        fixture: true,
        noKeyInConfig: true,
        secondModelPreservesEndpoint: true,
        savedKeyCatalog: true,
        credentialUrlGuard: true,
        errors,
      },
      null,
      2,
    ),
  );
  console.log(
    "PASS OmniRoute preset, catalog, exact combo ID, credential storage, real OpenCode Chat Completions/SSE and tool schemas",
  );
} catch (error) {
  await page
    ?.screenshot({ path: "test-results/omniroute-failure.png" })
    .catch(() => {});
  throw error;
} finally {
  await app.close();
  server.closeAllConnections();
  await new Promise((r) => server.close(r));
}
