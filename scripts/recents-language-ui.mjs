import { selectValue } from "./select-ui.mjs";
import { _electron as electron, expect } from "playwright/test";
import { Service } from "@opencode/client/service";
import { OpenCode } from "@opencode/client";
import fs from "node:fs/promises";
import path from "node:path";
import assert from "node:assert/strict";

const directory = path.resolve(`.runtime/recents-language-${process.pid}`);
const folder = path.join(directory, "Мастерская Forge");
const providerID = "local-interface-fixture";
await fs.mkdir(folder, { recursive: true });
await fs.mkdir("test-results", { recursive: true });
const config = path.join(directory, "engine/config/opencode/opencode.json");
await fs.mkdir(path.dirname(config), { recursive: true });
await fs.writeFile(
  config,
  JSON.stringify({
    providers: {
      [providerID]: {
        name: "Local interface fixture",
        package: "@opencode/ai/providers/openai-compatible",
        settings: { baseURL: "http://127.0.0.1:9/v1" },
        models: Object.fromEntries(
          Array.from({ length: 240 }, (_, i) => [
            `model-${i}`,
            {
              name:
                i === 0
                  ? "Forge Reasoner"
                  : i === 1
                    ? "Simple Chat"
                    : `Catalog Model ${String(i).padStart(3, "0")}`,
              capabilities: {
                tools: true,
                input: ["text", "image"],
                output: ["text"],
              },
              variants:
                i === 1
                  ? []
                  : ["low", "medium", "high"].map((id) => ({
                      id,
                      body: { reasoning_effort: id },
                    })),
            },
          ]),
        ),
      },
    },
  }),
);
let app, page;
const errors = [];
async function launch() {
  const packaged = process.argv.includes("--packaged");
  app = await electron.launch({
    executablePath: packaged
      ? path.resolve("release/win-unpacked/Rote Coding Fraktion.exe")
      : undefined,
    args: packaged ? [] : ["."],
    env: { ...process.env, FORGE_DATA_DIR: directory },
    timeout: 30000,
  });
  page = await app.firstWindow();
  page.on("pageerror", (error) => errors.push(error.message));
  await page.waitForSelector(".status-dot.ready", { timeout: 45000 });
}
const capture = async (name) => {
  await page.waitForTimeout(200);
  const png = await app.evaluate(async ({ BrowserWindow }) =>
    (await BrowserWindow.getAllWindows()[0].capturePage())
      .toPNG()
      .toString("base64"),
  );
  await fs.writeFile(`test-results/${name}.png`, Buffer.from(png, "base64"));
};
const openModels = async () => {
  await page.getByRole("button", { name: "Choose model", exact: true }).click();
  await expect(
    page.getByRole("dialog", { name: "Reasoning effort", exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Choose another model", exact: true })
    .click();
};
try {
  await launch();
  await app.evaluate(({ dialog }, folder) => {
    dialog.showOpenDialog = async () => ({
      canceled: false,
      filePaths: [folder],
    });
  }, folder);
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
    value: { type: "key", key: "isolated-ui-fixture-only" },
    activate: true,
  });
  await client.location.reload();
  const sessions = await page.evaluate(
    async ({ project, providerID }) => {
      const all = [];
      for (let i = 0; i < 27; i++) {
        const workspace = i % 2 ? "chat" : "work";
        const s = await window.desktop.createSession(
          project.id,
          { providerID, id: "model-0" },
          "cautious",
          workspace,
        );
        const title =
          i === 0
            ? "Настройки"
            : `${workspace === "chat" ? "Обсуждение" : "Разработка"} ${i}`;
        await window.desktop.renameSession(s.id, title);
        all.push({ ...s, workspace, title });
      }
      await window.desktop.archiveSession(all[26].id, true);
      await window.desktop.pinSession(all[1].id, true);
      await window.desktop.savePreferences({
        projectId: project.id,
        sessionId: all[0].id,
        workspace: "work",
        model: { providerID, id: "model-0" },
        favoriteModels: Array.from({ length: 12 }, (_, i) => ({
          providerID,
          id: `model-${i}`,
        })),
      });
      return all;
    },
    { project, providerID },
  );
  await page.reload();
  const recents = page.locator(".recents-section");
  await expect(recents.locator(".session-row")).toHaveCount(26);
  assert.equal(
    await recents.locator(`[data-session-id="${sessions[26].id}"]`).count(),
    0,
  );
  assert.equal(
    await recents.locator(`[data-session-id="${sessions[1].id}"]`).count(),
    1,
    "Pinned chats also appear in Recents",
  );
  assert.equal(await recents.locator(".sidebar-show-more").count(), 0);
  const order = await recents
    .locator(".session-row")
    .evaluateAll((rows) => rows.map((el) => el.dataset.sessionId));
  assert.equal(new Set(order).size, 26);
  await recents.scrollIntoViewIfNeeded();
  await capture("recents-scrolled-ru");
  await page.locator(".sidebar-scroll").evaluate((el) => {
    el.scrollTop = 0;
  });
  await capture("recents-ru");
  for (const session of [sessions[1], sessions[0]]) {
    await recents
      .locator(`[data-session-id="${session.id}"] .session-link`)
      .click();
    await expect(page.locator(".faction-switcher small:visible")).toHaveText(
      session.workspace === "chat" ? "Chat Faction" : "Work Faction",
    );
    await expect(page.locator(".workspace-title")).toContainText(session.title);
    const saved = (await page.evaluate(() => window.desktop.bootstrap()))
      .preferences;
    assert.equal(saved.workspace, session.workspace);
    assert.equal(saved.sessionId, session.id);
    await expect(recents.locator(".session-row")).toHaveCount(26);
  }
  await page.keyboard.press("Control+,");
  await selectValue(page.getByLabel("Язык приложения", { exact: true }), "en");
  await expect(
    page.getByRole("heading", { name: "General", exact: true }),
  ).toBeVisible();
  assert.equal(await page.locator("html").getAttribute("lang"), "en");
  assert.equal(
    (await page.evaluate(() => window.desktop.bootstrap())).preferences
      .language,
    "en",
  );
  await capture("language-en-general");
  for (const category of [
    "General",
    "Appearance",
    "Models and connections",
    "Agents and permissions",
    "Memory and personalization",
    "History and storage",
    "Keyboard shortcuts",
    "About",
  ]) {
    await page.getByRole("button", { name: category, exact: true }).click();
    const text = (await page.locator(".settings-page-body").innerText())
      .replaceAll("Мастерская Forge", "")
      .replaceAll("Настройки", "")
      .replaceAll("Русский", "");
    assert.ok(
      !/[А-Яа-яЁё]/.test(text),
      `${category} contains untranslated interface text: ${text.match(/[^\n]*[А-Яа-яЁё][^\n]*/g)}`,
    );
  }
  await page
    .getByRole("textbox", { name: "Search settings", exact: true })
    .fill("font");
  await expect(page.locator(".settings-results > button")).toHaveCount(2);
  await page
    .getByRole("button", { name: "Close settings", exact: true })
    .click();
  await expect(recents.locator(".section-title-button")).toContainText(
    "Recent chats",
  );
  await expect(
    recents.locator(`[data-session-id="${sessions[0].id}"] .session-title`),
  ).toHaveText("Настройки");
  await page.keyboard.press("Control+k");
  await expect(
    page.getByRole("combobox", { name: "Search history", exact: true }),
  ).toBeFocused();
  await page
    .getByRole("combobox", { name: "Search history", exact: true })
    .fill("settings");
  await page.getByRole("option", { name: /Settings/ }).click();
  await expect(
    page.getByRole("option", { name: "General", exact: true }),
  ).toBeVisible();
  await page.keyboard.press("Escape");
  await page.keyboard.press("Escape");
  await openModels();
  await expect(
    page.locator(".model-favorites-list [role=menuitem]"),
  ).toHaveCount(12);
  assert.ok(
    (
      await page
        .locator(".model-favorites-list [role=menuitem]")
        .first()
        .boundingBox()
    ).height <= 34,
  );
  await capture("models-favorites-en");
  await page.getByRole("menuitem", { name: /Simple Chat/ }).click();
  await page.getByRole("button", { name: "Choose model", exact: true }).click();
  await expect(
    page.getByText("This model has no reasoning setting.", { exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Choose another model", exact: true })
    .click();
  await page.getByRole("menuitem", { name: /Forge Reasoner/ }).click();
  await page.keyboard.press("Control+Shift+m");
  const slider = page.getByRole("slider", {
    name: "Reasoning effort",
    exact: true,
  });
  await expect(slider).toBeFocused();
  await slider.press("End");
  await expect(slider).toHaveAttribute("aria-valuetext", "High");
  await capture("models-effort-en");
  await page
    .getByRole("button", { name: "Choose another model", exact: true })
    .click();
  await page
    .getByRole("menuitem", { name: "Find and pin models", exact: true })
    .click();
  const catalog = page.getByRole("dialog", {
    name: "Model catalog",
    exact: true,
  });
  const search = page.getByRole("combobox", {
    name: "Search models",
    exact: true,
  });
  await expect(search).toBeFocused();
  await expect(catalog.locator(".catalog-model-row").first()).toBeVisible();
  assert.ok(
    (await catalog.locator(".catalog-model-row").count()) < 50,
    "Catalog renders only visible rows",
  );
  await capture("models-catalog-en");
  await search.fill("Catalog Model 239");
  await expect(catalog.getByRole("option")).toHaveCount(1);
  await catalog
    .getByRole("button", { name: "Pin model Catalog Model 239", exact: true })
    .click();
  await expect(
    catalog.getByRole("button", {
      name: "Unpin model Catalog Model 239",
      exact: true,
    }),
  ).toHaveAttribute("aria-pressed", "true");
  await search.press("Enter");
  await expect(catalog).toHaveCount(0);
  assert.equal(
    (await page.evaluate(() => window.desktop.bootstrap())).preferences.model
      .id,
    "model-239",
  );
  await openModels();
  await page
    .getByRole("menuitem", { name: "Find and pin models", exact: true })
    .click();
  for (const [width, height, zoom] of [
    [1440, 960, 1],
    [780, 600, 1],
    [1440, 960, 2],
    [780, 600, 2],
  ]) {
    await app.evaluate(
      ({ BrowserWindow }, values) => {
        const w = BrowserWindow.getAllWindows()[0];
        w.setSize(values[0], values[1]);
        w.webContents.setZoomFactor(values[2]);
      },
      [width, height, zoom],
    );
    await page.waitForTimeout(200);
    const geometry = await catalog.evaluate((el) => {
      const r = el.getBoundingClientRect();
      return {
        fits:
          r.x >= 0 &&
          r.y >= 0 &&
          r.right <= innerWidth + 1 &&
          r.bottom <= innerHeight + 1,
        overflow: el.scrollWidth > el.clientWidth,
      };
    });
    assert.ok(geometry.fits && !geometry.overflow, JSON.stringify(geometry));
    await capture(`models-catalog-${width}-${zoom}`);
  }
  await page.keyboard.press("Escape");
  await app.evaluate(({ BrowserWindow }) => {
    const w = BrowserWindow.getAllWindows()[0];
    w.setSize(1440, 960);
    w.webContents.setZoomFactor(1);
  });
  await app.close();
  await launch();
  await expect(
    page.getByRole("button", { name: "Choose model", exact: true }),
  ).toContainText("Catalog Model 239");
  assert.equal(await page.locator("html").getAttribute("lang"), "en");
  await expect(page.locator(".recents-section .session-row")).toHaveCount(26);
  await page.keyboard.press("Control+,");
  await selectValue(page.getByLabel("App language", { exact: true }), "ru");
  await expect(
    page.getByRole("heading", { name: "Основные", exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Закрыть настройки", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Выбрать модель", exact: true })
    .click();
  await capture("models-effort-ru");
  await page
    .getByRole("button", { name: "Выбрать другую модель", exact: true })
    .click();
  await capture("models-favorites-ru");
  await page
    .getByRole("menuitem", { name: "Найти и закрепить модели", exact: true })
    .click();
  await capture("models-catalog-ru");
  await page.keyboard.press("Escape");
  assert.deepEqual(errors, []);
  console.log(
    "PASS all-mode scrollable recents, automatic workspace switching, RU/EN live translation and persistence, all settings, effort-first model flow, exact model selection, pinning, virtual catalog and four zoom layouts",
  );
} catch (error) {
  await capture("recents-language-failure").catch(() => {});
  throw error;
} finally {
  if (app) await app.close().catch(() => {});
}
