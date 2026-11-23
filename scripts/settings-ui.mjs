import { selectValue } from "./select-ui.mjs";
import { _electron as electron } from "playwright";
import fs from "node:fs/promises";
import path from "node:path";
import assert from "node:assert/strict";
const dataDir = path.resolve(`.runtime/settings-ui-${process.pid}`);
const project = path.join(
  dataDir,
  "Проект с длинным названием — проверка интерфейса Unicode",
);
await fs.mkdir(project, { recursive: true });
await fs.mkdir("test-results", { recursive: true });
const app = await electron.launch({
  args: ["."],
  env: { ...process.env, FORGE_DATA_DIR: dataDir },
  timeout: 30000,
});
const results = [];
const errors = [];
const capture = async (file) => {
  const png = await app.evaluate(async ({ BrowserWindow }) =>
    (await BrowserWindow.getAllWindows()[0].capturePage())
      .toPNG()
      .toString("base64"),
  );
  await fs.writeFile(file, Buffer.from(png, "base64"));
};
try {
  const page = await app.firstWindow();
  page.on("pageerror", (e) => errors.push(e.message));
  await page.waitForSelector(".status-dot.ready", { timeout: 45000 });
  await app.evaluate(({ dialog }, project) => {
    dialog.showOpenDialog = async () => ({
      canceled: false,
      filePaths: [project],
    });
  }, project);
  await page
    .getByRole("button", { name: "Добавить проект", exact: true })
    .first()
    .click();
  await page.keyboard.press("Control+,");
  await page.locator(".settings-screen").waitFor();
  await page
    .getByRole("textbox", { name: "Поиск по параметрам" })
    .fill("шрифт");
  assert.equal(await page.locator(".settings-results > button").count(), 2);
  await page.getByRole("button", { name: /Размер шрифта чата/ }).click();
  await selectValue(page.getByLabel("Размер шрифта чата", { exact: true }), "16");
  await selectValue(page.getByLabel("Ширина боковой панели", { exact: true }), "280");
  await page.getByRole("switch", { name: "Анимации", exact: true }).click();
  const prefs = (await page.evaluate(() => window.desktop.bootstrap()))
    .preferences;
  assert.equal(prefs.chatFontSize, 16);
  assert.equal(prefs.sidebarWidth, 280);
  assert.equal(prefs.animations, false);
  for (const [width, height, zoom] of [
    [1440, 960, 1],
    [780, 600, 1],
    [1440, 960, 1.25],
    [1440, 960, 1.5],
    [1440, 960, 2],
    [780, 600, 2],
  ]) {
    await app.evaluate(
      ({ BrowserWindow }, v) => {
        const w = BrowserWindow.getAllWindows()[0];
        w.setSize(v[0], v[1]);
        w.webContents.setZoomFactor(v[2]);
      },
      [width, height, zoom],
    );
    await page.waitForTimeout(300);
    await capture(`test-results/settings-appearance-${width}-${zoom}.png`);
    const geometry = await page.evaluate(() => {
      const el = document.querySelector(".settings-content"),
        screen = document.querySelector(".settings-screen");
      return {
        width: innerWidth,
        height: innerHeight,
        contentWidth: el.clientWidth,
        overflow: el.scrollWidth > el.clientWidth,
        documentOverflow: document.documentElement.scrollWidth > innerWidth,
        screen: screen.getBoundingClientRect().toJSON(),
      };
    });
    results.push({
      windowWidth: width,
      windowHeight: height,
      zoom,
      ...geometry,
    });
    assert.equal(geometry.overflow, false, JSON.stringify(results.at(-1)));
    assert.equal(
      geometry.documentOverflow,
      false,
      JSON.stringify(results.at(-1)),
    );
  }
  await fs.writeFile(
    "test-results/settings-geometry.json",
    JSON.stringify(results, null, 2),
  );
  await app.evaluate(({ BrowserWindow }) => {
    const w = BrowserWindow.getAllWindows()[0];
    w.setSize(1440, 960);
    w.webContents.setZoomFactor(1);
  });
  await page
    .getByRole("button", { name: "Память и персонализация", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Добавить запись", exact: true })
    .click();
  await page
    .getByRole("textbox", { name: /^Текст записи/ })
    .fill("Для этого QA используем строгий TypeScript.");
  await page
    .getByRole("button", { name: "Сохранить запись", exact: true })
    .click();
  await page.getByText("Запись памяти сохранена", { exact: true }).waitFor();
  let memory = await page.evaluate(() => window.desktop.listMemory());
  assert.equal(memory.length, 1);
  assert.equal(memory[0].scope, "global");
  await page
    .getByRole("button", { name: "Редактировать запись памяти", exact: true })
    .click();
  await page
    .getByRole("textbox", { name: /^Текст записи/ })
    .fill("Проверенная запись памяти после редактирования.");
  await page
    .getByRole("button", { name: "Сохранить запись", exact: true })
    .click();
  await page
    .getByText("Проверенная запись памяти после редактирования.", {
      exact: true,
    })
    .waitFor();
  memory = await page.evaluate(() => window.desktop.listMemory());
  assert.equal(memory.length, 1);
  assert.equal(
    memory[0].text,
    "Проверенная запись памяти после редактирования.",
  );
  await page.locator(".memory-editor").waitFor({ state: "hidden" });
  await capture("test-results/settings-memory.png");
  await page
    .getByRole("button", { name: "Удалить запись памяти", exact: true })
    .click();
  await page
    .getByRole("dialog", { name: "Удалить запись памяти?" })
    .getByRole("button", { name: "Удалить", exact: true })
    .click();
  await page.getByText("Пока нет записей", { exact: true }).waitFor();
  assert.equal(
    (await page.evaluate(() => window.desktop.listMemory())).length,
    0,
  );
  const projectId = (await page.evaluate(() => window.desktop.bootstrap()))
    .projects[0].id;
  await selectValue(page.getByLabel("Область памяти", { exact: true }), projectId);
  await page
    .getByRole("button", { name: "Добавить запись", exact: true })
    .click();
  await page
    .getByRole("textbox", { name: /^Текст записи/ })
    .fill("Запись только для выбранного проекта.");
  await page
    .getByRole("button", { name: "Сохранить запись", exact: true })
    .click();
  await page.locator(".memory-editor").waitFor({ state: "hidden" });
  memory = await page.evaluate(() => window.desktop.listMemory());
  assert.equal(memory.length, 1);
  assert.equal(memory[0].scope, "project");
  assert.equal(memory[0].projectId, projectId);
  await page
    .getByRole("button", { name: "Удалить запись памяти", exact: true })
    .click();
  await page.keyboard.press("Escape");
  assert.equal(await page.locator(".settings-screen").count(), 1);
  assert.equal(await page.getByRole("dialog").count(), 0);
  await page
    .getByRole("button", { name: "Удалить записи (1)", exact: true })
    .click();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Удалить", exact: true })
    .click();
  await page.getByText("Пока нет записей", { exact: true }).waitFor();
  await page
    .getByRole("switch", {
      name: "Использовать долговременную память",
      exact: true,
    })
    .click();
  assert.equal(
    (await page.evaluate(() => window.desktop.bootstrap())).preferences
      .memoryEnabled,
    true,
  );
  await page.evaluate(async (projectId) => {
    await window.desktop.saveMemory({
      scope: "project",
      projectId,
      text: "Память отключённого проекта для проверки.",
    });
    await window.desktop.removeProject(projectId);
  }, projectId);
  await page
    .getByRole("button", { name: "Обновить память", exact: true })
    .click();
  await page
    .getByText("Память отключённого проекта для проверки.", { exact: true })
    .waitFor();
  await selectValue(page.getByLabel("Область памяти", { exact: true }), projectId);
  await page
    .locator(".memory-filters [data-option-value]")
    .filter({ hasText: "Отключённый проект" })
    .waitFor({ state: "attached" });
  assert.ok(
    (
      await page.getByRole("combobox", { name: "Область памяти", exact: true }).innerText()
    ).includes("Отключённый проект"),
  );
  await page
    .getByRole("button", { name: "Редактировать запись памяти", exact: true })
    .click();
  await selectValue(page.getByLabel("Использовать в", { exact: true }), "global");
  await page
    .getByRole("button", { name: "Сохранить запись", exact: true })
    .click();
  await page.locator(".memory-editor").waitFor({ state: "hidden" });
  memory = await page.evaluate(() => window.desktop.listMemory());
  assert.equal(memory[0].scope, "global");

  await page
    .getByRole("button", { name: "Модели и подключения", exact: true })
    .click();
  await page.getByRole("button", { name: "Добавить подключение" }).click();
  await page.getByRole("dialog", { name: "Добавить подключение" })
    .getByRole("button", { name: "OmniRoute", exact: true }).click();
  assert.equal(
    await page.getByLabel("Base URL", { exact: true }).inputValue(),
    "http://localhost:20128/v1",
  );
  assert.equal(await page.locator("input[type=password]").count(), 1);
  await capture("test-results/settings-provider.png");
  await page.getByRole("button", { name: "О приложении", exact: true }).click();
  await page.getByText("Локальный движок OpenCode", { exact: true }).waitFor();
  assert.ok(
    (await page.locator("#setting-engine").innerText()).includes("2.3.0"),
  );
  await capture("test-results/settings-about.png");
  await page.getByRole("button", { name: "Основные", exact: true }).click();
  await page
    .getByRole("button", { name: "Меню Rote Coding Fraktion", exact: true })
    .click();
  await page
    .getByRole("menuitem", { name: "О приложении", exact: true })
    .click();
  await page
    .getByRole("heading", { name: "О приложении", exact: true })
    .waitFor();
  assert.deepEqual(errors, []);
  await fs.writeFile(
    "test-results/settings-verification.json",
    JSON.stringify(
      {
        dataDir,
        results,
        errors,
        memoryCrud: true,
        projectMemory: true,
        scopeClear: true,
        confirmationEscape: true,
        disconnectedMemory: true,
        aboutDeepLink: true,
        preferencePersistence: true,
        providerPreset: true,
        engineVersion: true,
      },
      null,
      2,
    ),
  );
  console.log(JSON.stringify({ ok: true, results, errors }));
} finally {
  await app.close();
}
