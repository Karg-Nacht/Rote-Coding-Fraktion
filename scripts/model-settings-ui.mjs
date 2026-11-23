import { selectValue } from "./select-ui.mjs";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { OpenCode } from "@opencode/client";
import { Service } from "@opencode/client/service";
import { _electron as electron } from "playwright";

await fs.mkdir(".runtime", { recursive: true });
const dataDir = await fs.mkdtemp(path.resolve(".runtime/model-settings-ui-"));
const output = "test-results/model-settings-polish";
const configFile = path.join(dataDir, "engine/config/opencode/opencode.json");
const providerID = "settings-qa";
const reasoner = "qa/reasoner:exact";
const swift = "qa/swift:exact";
const swiftName =
  "QA Swift — a deliberately long model name to verify truncation and preserve the full title";
const custom = "custom-qa";
const customModel = "custom/nested:model";
const baseURL = "http://127.0.0.1:1/v1";
const capabilities = { tools: true, input: ["text"], output: ["text"] };
const errors = [];
await fs.mkdir(output, { recursive: true });
await fs.mkdir(path.dirname(configFile), { recursive: true });
await fs.writeFile(
  configFile,
  JSON.stringify({
    providers: {
      [providerID]: {
        name: "QA Model Service",
        package: "@opencode/ai/providers/openai-compatible",
        settings: { baseURL },
        models: {
          [reasoner]: {
            name: "QA Reasoner",
            capabilities,
            variants: ["low", "high"].map((id) => ({
              id,
              body: { reasoning_effort: id },
            })),
          },
          [swift]: { name: swiftName, capabilities, variants: [] },
        },
      },
    },
  }),
);

function launch() {
  return electron.launch({
    args: ["."],
    env: { ...process.env, RCF_DATA_DIR: dataDir },
  });
}

async function windowPage(app) {
  const page = await app.firstWindow();
  page.setDefaultTimeout(10000);
  page.on("pageerror", (error) => errors.push(error.message));
  await page.locator(".status-dot.ready").waitFor({ timeout: 45000 });
  return page;
}

async function openSettings(page) {
  await page.keyboard.press("Control+,");
  await page
    .getByRole("button", { name: "Модели и подключения", exact: true })
    .click();
}

async function layout(app, page, width, height, columns) {
  await app.evaluate(
    ({ BrowserWindow }, size) => {
      BrowserWindow.getAllWindows()[0].setSize(...size);
    },
    [width, height],
  );
  await page.waitForFunction(
    ([width, height]) => innerWidth === width && innerHeight === height,
    [width, height],
  );
  assert.deepEqual(
    await page.locator(".model-settings").evaluate((grid) => {
      const content = grid.closest(".settings-content");
      return {
        columns: getComputedStyle(grid).gridTemplateColumns.split(" ").length,
        overflow: [
          document.documentElement.scrollWidth > innerWidth,
          content.scrollWidth > content.clientWidth,
          grid.scrollWidth > grid.clientWidth,
        ],
      };
    }),
    { columns, overflow: [false, false, false] },
  );
}

async function capture(app, page, name) {
  await page.mouse.move(1, 55);
  await page.evaluate(() => {
    document.activeElement?.blur();
    document.querySelector(".settings-content").scrollTop = 0;
  });
  // Allow the theme's CSS transitions and the native window resize to paint.
  await page.waitForTimeout(180);
  const png = await app.evaluate(async ({ BrowserWindow }) =>
    (await BrowserWindow.getAllWindows()[0].capturePage())
      .toPNG()
      .toString("base64"),
  );
  await fs.writeFile(`${output}/${name}.png`, Buffer.from(png, "base64"));
  console.log(`Captured ${name}`);
}

let app = await launch();
try {
  let page = await windowPage(app);
  const endpoint = await Service.discover({
    file: path.join(dataDir, "engine/state/opencode/service.json"),
    version: "2.3.0",
  });
  const client = OpenCode.make({
    baseUrl: endpoint.url,
    headers: Service.headers(endpoint),
  });
  await client.credential.create({
    integrationID: providerID,
    value: { type: "key", key: "local-model-settings-fixture" },
    activate: true,
  });
  await client.location.reload();
  await openSettings(page);

  const searchButton = page.getByRole("button", {
    name: "Найти модель…",
    exact: true,
  });
  const modelSearch = page.getByRole("combobox", { name: "Поиск моделей" });
  const current = page.locator("#setting-default-model");
  const reasoning = page.getByRole("combobox", { name: "Вариант модели" });
  const favorites = page.locator("#setting-favorites");
  const directory = page.locator(
    "#provider-directory-panel .provider-directory",
  );
  const catalogToggle = page.getByRole("button", {
    name: /^Каталог провайдеров/,
  });
  const providerSearch = directory.getByRole("textbox", {
    name: "Поиск провайдеров",
  });
  const filter = page.getByRole("combobox", { name: "Фильтр провайдеров" });
  const addConnection = page.getByRole("button", {
    name: "Добавить подключение",
  });
  const picker = page.getByRole("dialog", { name: "Добавить подключение" });
  const pickerSearch = picker.getByRole("textbox", {
    name: "Поиск провайдеров",
  });

  await searchButton.press("Enter");
  await modelSearch.fill("QA Reasoner");
  await page.getByRole("option", { name: /QA Reasoner/ }).waitFor();
  assert.match(
    await page.getByRole("option", { name: /QA Reasoner/ }).innerText(),
    /settings-qa/,
  );
  await modelSearch.press("Enter");
  await current.getByText("QA Reasoner", { exact: true }).waitFor();
  await selectValue(reasoning, "high");
  await current
    .getByRole("button", { name: "Закрепить модель" })
    .press("Space");
  await searchButton.press("Enter");
  await modelSearch.fill(swift);
  await page.getByRole("option", { name: /QA Swift/ }).waitFor();
  await modelSearch.press("Shift+Enter");
  await page
    .getByRole("button", { name: /^Открепить модель QA Swift/ })
    .waitFor();
  await modelSearch.press("Escape");
  assert.equal(
    await searchButton.evaluate((el) => el === document.activeElement),
    true,
  );
  assert.equal(await favorites.getAttribute("open"), null);
  await favorites.locator("summary").press("Enter");
  await favorites.getByRole("button", { name: /QA Swift/ }).press("Enter");
  const longTitle = current.getByText(swiftName, { exact: true });
  await longTitle.waitFor();
  assert.equal(await longTitle.getAttribute("title"), swiftName);
  assert.equal(
    await longTitle.evaluate((el) => el.scrollWidth > el.clientWidth),
    true,
  );
  assert.equal(
    await current.getByText(swift, { exact: true }).getAttribute("title"),
    swift,
  );
  assert.equal(
    (await page.evaluate(() => window.desktop.bootstrap())).preferences.model
      .variant,
    undefined,
  );
  await favorites.getByRole("button", { name: /QA Reasoner/ }).press("Enter");
  await current.getByText("QA Reasoner", { exact: true }).waitFor();
  await selectValue(reasoning, "high");
  await favorites.locator("summary").press("Enter");
  await page
    .locator(".configured-providers")
    .getByRole("button", { name: /QA Model Service/ })
    .waitFor();

  assert.equal(await directory.count(), 0);
  await page.getByRole("button", { name: "Обновить подключения" }).click();
  await page.waitForFunction(async () => {
    const { textContent } = document.querySelector(".catalog-total");
    const integrations = await window.desktop.integrations();
    return textContent === `· ${integrations.length}`;
  });
  await catalogToggle.press("Enter");
  await providerSearch.waitFor();
  await catalogToggle.press("Tab");
  assert.equal(
    await providerSearch.evaluate((el) => el === document.activeElement),
    true,
  );
  const rows = directory.locator(".integration-list > button");
  assert.equal(await rows.count(), 24);
  const firstName = await rows.first().innerText();
  await directory.getByRole("button", { name: "Далее" }).press("Enter");
  assert.notEqual(await rows.first().innerText(), firstName);
  assert.ok((await rows.count()) <= 24);
  await directory.getByRole("button", { name: "Назад" }).press("Enter");
  assert.equal(await rows.first().innerText(), firstName);
  await providerSearch.fill("no-provider-matches-this-fixture");
  await directory.getByText("Провайдеры не найдены.").waitFor();
  await providerSearch.fill("openai");
  assert.ok((await rows.count()) > 0);
  const oauth = await page.evaluate(async () => {
    const available = (await window.desktop.integrations()).filter(
      (integration) =>
        integration.methods.some((method) => method.type === "oauth"),
    );
    return (
      available.find((integration) => integration.id === "openai") ??
      available[0]
    );
  });
  assert.ok(oauth);
  await selectValue(filter, "oauth");
  await providerSearch.fill(oauth.id);
  const oauthRow = rows.filter({ hasText: oauth.name });
  assert.equal(
    await oauthRow.count(),
    1,
    JSON.stringify({
      expected: oauth.name,
      search: await providerSearch.inputValue(),
      results: await rows.allTextContents(),
    }),
  );
  await oauthRow.press("Enter");
  const form = page.locator(".connection-form");
  const methodIndex = oauth.methods.findIndex((m) => m.type === "oauth");
  if (oauth.methods.length > 1)
    await selectValue(form.getByLabel("Способ подключения"), String(methodIndex));
  await form.getByRole("button", { name: "Подключить", exact: true }).waitFor();
  assert.equal(await form.locator("input[type=password]").count(), 0);
  await form.getByRole("button", { name: "← Все подключения" }).press("Enter");
  assert.equal(
    await oauthRow.evaluate((el) => el === document.activeElement),
    true,
  );
  await selectValue(filter, "all");
  await providerSearch.fill("");
  await addConnection.press("Enter");
  await pickerSearch.waitFor();
  assert.equal(await directory.count(), 0);
  assert.equal(
    await pickerSearch.evaluate((el) => el === document.activeElement),
    true,
  );
  await pickerSearch.press("ArrowDown");
  assert.equal(
    await picker
      .getByRole("button", { name: "OmniRoute", exact: true })
      .evaluate((el) => el === document.activeElement),
    true,
  );
  await page.keyboard.press("ArrowDown");
  assert.equal(
    await picker
      .getByRole("button", { name: "OpenRouter", exact: true })
      .evaluate((el) => el === document.activeElement),
    true,
  );
  await page.keyboard.press("Escape");
  await picker.waitFor({ state: "hidden" });
  assert.equal(
    await addConnection.evaluate((el) => el === document.activeElement),
    true,
  );

  const otherProvider = await page.evaluate(async () =>
    (await window.desktop.integrations()).find(
      (integration) => integration.id === "mistral",
    ),
  );
  assert.ok(otherProvider);
  await addConnection.press("Enter");
  await pickerSearch.fill(otherProvider.id);
  await picker
    .getByRole("button", { name: new RegExp(otherProvider.name, "i") })
    .waitFor();
  await pickerSearch.press("Enter");
  await form
    .getByRole("heading", { name: otherProvider.name, exact: true })
    .waitFor();
  await form.getByRole("button", { name: "← Все подключения" }).press("Enter");

  for (const theme of ["dark", "light"]) {
    await page.evaluate(
      (theme) => window.desktop.savePreferences({ theme }),
      theme,
    );
    await page.waitForFunction(
      (theme) => document.documentElement.dataset.theme === theme,
      theme,
    );
    for (const width of [1440, 1080, 780]) {
      await layout(app, page, width, 800, width === 780 ? 1 : 2);
      await capture(app, page, `${theme}-${width}`);
      await addConnection.press("Enter");
      await pickerSearch.waitFor();
      assert.equal(
        await picker.evaluate((el) => {
          const box = el.getBoundingClientRect();
          return (
            box.left >= 0 &&
            box.right <= innerWidth &&
            box.top >= 0 &&
            box.bottom <= innerHeight
          );
        }),
        true,
      );
      if (width === 780) await capture(app, page, `${theme}-picker`);
      await pickerSearch.press("Escape");
      await picker.waitFor({ state: "hidden" });
    }
    await catalogToggle.press("Enter");
    await providerSearch.fill("openai");
    await layout(app, page, 1080, 800, 2);
    await capture(app, page, `${theme}-catalog`);
    await layout(app, page, 780, 600, 1);
    await catalogToggle.press("Enter");
  }

  for (const [name, url] of [
    ["OmniRoute", "http://localhost:20128/v1"],
    ["OpenRouter", "https://openrouter.ai/api/v1"],
    ["OpenAI", "https://api.openai.com/v1"],
    ["Anthropic", "https://api.anthropic.com/v1"],
    ["Ollama", "http://127.0.0.1:11434/v1"],
    ["LM Studio", "http://127.0.0.1:1234/v1"],
  ]) {
    await addConnection.press("Enter");
    const preset = picker.getByRole("button", { name, exact: true });
    await preset.press("Enter");
    assert.equal(await form.getByLabel("Base URL").inputValue(), url);
    await form
      .getByRole("button", { name: "← Все подключения" })
      .press("Enter");
    assert.equal(
      await addConnection.evaluate((el) => el === document.activeElement),
      true,
    );
  }
  await addConnection.press("Enter");
  await picker
    .getByRole("button", { name: "Другой провайдер / свой сервер" })
    .press("Enter");
  await form.getByLabel("Название").fill("QA Local Server");
  const runtime = form.getByRole("combobox", { name: "API", exact: true });
  await selectValue(runtime, "anthropic");
  assert.equal(await runtime.innerText(), "Anthropic");
  await selectValue(runtime, "compatible");
  await form.getByLabel("ID провайдера", { exact: true }).fill(custom);
  await form.getByLabel("Base URL").fill(baseURL);
  await form
    .getByRole("textbox", { name: /^Точный ID модели/ })
    .fill(customModel);
  await layout(app, page, 780, 600, 1);
  await form
    .getByRole("button", { name: "Сохранить подключение" })
    .press("Enter");
  await page
    .getByText("Провайдер добавлен. Модель доступна в поле ввода.", {
      exact: true,
    })
    .waitFor();
  await app.close();

  app = await launch();
  page = await windowPage(app);
  await openSettings(page);
  const prefs = (await page.evaluate(() => window.desktop.bootstrap()))
    .preferences;
  assert.deepEqual(prefs.model, { id: reasoner, providerID, variant: "high" });
  assert.deepEqual(prefs.favoriteModels, [
    { id: reasoner, providerID },
    { id: swift, providerID },
  ]);
  assert.equal(
    await page.getByRole("combobox", { name: "Вариант модели" }).getAttribute("data-value"),
    "high",
  );
  const config = JSON.parse(await fs.readFile(configFile, "utf8"));
  assert.deepEqual(Object.keys(config.providers[custom].models), [customModel]);
  assert.equal(config.providers[custom].settings.baseURL, baseURL);
  const savedServer = page
    .locator(".configured-providers")
    .getByRole("button", { name: /QA Local Server.*Настроен/ });
  await savedServer.press("Enter");
  assert.equal(await page.getByLabel("Base URL").inputValue(), baseURL);
  assert.equal(
    await page.locator(".connection-form input[type=password]").inputValue(),
    "",
  );
  assert.deepEqual(errors, []);
  console.log(
    "PASS: both themes, 1440/1080/780, model search, pinning, reasoning, provider pagination, OAuth form, custom connection and restart persistence",
  );
} finally {
  await app.close();
}
