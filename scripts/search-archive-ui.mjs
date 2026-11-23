import { _electron as electron, expect } from "playwright/test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";

// Real IPC and engine history, in a fresh profile without user credentials.
const directory = path.resolve(`.runtime/search-archive-ui-${process.pid}`);
const folders = [
  "Rote Coding Fraktion",
  "Очень длинное название проекта — проверка русского интерфейса",
];
for (const folder of folders)
  await fs.mkdir(path.join(directory, folder), { recursive: true });
await fs.mkdir("test-results", { recursive: true });
const packaged = process.argv.includes("--packaged");
const app = await electron.launch({
  executablePath: packaged
    ? path.resolve("release/win-unpacked/Rote Coding Fraktion.exe")
    : undefined,
  args: packaged ? [] : ["."],
  env: { ...process.env, FORGE_DATA_DIR: directory },
  timeout: 30000,
});
const page = await app.firstWindow();
const errors = [];
page.on("pageerror", (error) => errors.push(error.message));
const capture = async (name) => {
  await page.evaluate(
    () =>
      new Promise((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(resolve)),
      ),
  );
  await page.waitForTimeout(180);
  const png = await app.evaluate(async ({ BrowserWindow }) =>
    (await BrowserWindow.getAllWindows()[0].capturePage())
      .toPNG()
      .toString("base64"),
  );
  await fs.writeFile(`test-results/${name}.png`, Buffer.from(png, "base64"));
};
const palette = () =>
  page.getByRole("dialog", { name: "Поиск диалогов", exact: true });
const input = () =>
  page.getByRole("combobox", { name: "Поиск по истории", exact: true });
const openSearch = async () => {
  await page.keyboard.press("Control+k");
  await expect(input()).toBeFocused();
  await expect(
    page.locator(".palette-row .palette-shortcut").filter({ hasText: /^Alt/ }),
  ).toHaveCount(9);
};
const openArchive = async () => {
  await openSearch();
  await input().fill("Архив");
  await page.getByRole("option", { name: "Архив чатов", exact: true }).click();
  await expect(page.locator(".archive-count")).toHaveText(/\d+/);
  await expect(page.locator(".archive-results .spin")).toHaveCount(0);
};
try {
  await page.waitForSelector(".status-dot.ready", { timeout: 45000 });
  const projects = [];
  for (const folder of folders) {
    await app.evaluate(
      ({ dialog }, folder) => {
        dialog.showOpenDialog = async () => ({
          canceled: false,
          filePaths: [folder],
        });
      },
      path.join(directory, folder),
    );
    projects.push(await page.evaluate(() => window.desktop.addProject()));
  }
  const seeded = await page.evaluate(async (projects) => {
    const active = [],
      archived = [];
    for (let i = 0; i < 10; i++) {
      const s = await window.desktop.createSession(
        projects[i % 2].id,
        undefined,
        "cautious",
        "work",
      );
      const title = [
        "Модернизировать Rote Coding Fraktion",
        "Проработать поиск диалогов",
        "Подобрать идеи для GitHub",
        "Создать библиотеку",
        "Улучшить интерфейс чатов",
        "Подключить мультимодальность",
        "Настроить память",
        "Проверить рабочие пространства",
        "Собрать приложение Windows",
        "Спроектировать систему плагинов",
      ][i];
      await window.desktop.renameSession(s.id, title);
      active.push({ ...s, title });
    }
    for (let i = 0; i < 4; i++) {
      const s = await window.desktop.createSession(
        projects[i % 2].id,
        undefined,
        "cautious",
        "work",
      );
      const title = [
        "Red Coding Faction website",
        "Новая задача",
        "Пиксельный платформер-головоломка на pygame с очень длинным названием",
        "Эскизы и визуальные референсы",
      ][i];
      await window.desktop.renameSession(s.id, title);
      await window.desktop.archiveSession(s.id, true);
      archived.push({ ...s, title });
    }
    const chat = await window.desktop.createSession(
      projects[0].id,
      undefined,
      "cautious",
      "chat",
    );
    await window.desktop.renameSession(chat.id, "CHAT_FACTION_PRIVATE");
    await window.desktop.archiveSession(chat.id, true);
    await window.desktop.savePreferences({
      projectId: projects[0].id,
      sessionId: active[0].id,
      workspace: "work",
    });
    return { active, archived, chat };
  }, projects);
  await page.reload();
  await page.waitForSelector(".status-dot.ready");
  await openSearch();
  await expect(
    page.locator(".palette-row .palette-shortcut").filter({ hasText: /^Alt/ }),
  ).toHaveCount(9);
  assert.equal(await palette().locator("select").count(), 0);
  assert.equal(
    await page
      .locator(".history-backdrop")
      .evaluate((el) => getComputedStyle(el).backdropFilter),
    "none",
  );
  await capture("search-palette");
  const second = await page.locator(".palette-row-title").nth(1).textContent();
  await input().press("ArrowDown");
  await expect(page.getByRole("option", { selected: true })).toContainText(
    second,
  );
  await input().press("Enter");
  await expect(palette()).toHaveCount(0);
  assert.equal(
    (await page.evaluate(() => window.desktop.bootstrap())).preferences
      .sessionId,
    seeded.active.find((s) => s.title === second).id,
  );
  await openSearch();
  const first = await page.locator(".palette-row-title").first().textContent();
  await input().press("Alt+1");
  await expect(palette()).toHaveCount(0);
  assert.equal(
    (await page.evaluate(() => window.desktop.bootstrap())).preferences
      .sessionId,
    seeded.active.find((s) => s.title === first).id,
  );
  await openSearch();
  const filter = page.getByRole("button", { name: /^Проект для поиска:/ });
  await filter.focus();
  await page.keyboard.press("Enter");
  await expect(
    page.getByRole("menu", { name: "Проекты для поиска" }),
  ).toBeVisible();
  await capture("search-project-filter");
  await page.keyboard.press("Escape");
  await expect(palette()).toBeVisible();
  await expect(filter).toBeFocused();
  await filter.press("Enter");
  await page.keyboard.press("Tab");
  assert.equal(
    await palette().evaluate((el) => el.contains(document.activeElement)),
    true,
  );
  await filter.click();
  await page
    .getByRole("menuitemradio", { name: folders[0], exact: true })
    .click();
  await expect(page.locator(".palette-row-project")).toHaveCount(5);
  assert.ok(
    (await page.locator(".palette-row-project").allTextContents()).every(
      (s) => s === folders[0],
    ),
  );
  await filter.click();
  await page
    .getByRole("menuitemradio", { name: "Все проекты", exact: true })
    .click();
  await input().fill("мультимодальность");
  await expect(page.getByRole("option")).toHaveCount(1);
  await expect(page.locator(".palette-row-title mark")).toHaveText(
    "мультимодальность",
  );
  await capture("search-query");
  await input().fill("не существует 8934");
  await expect(
    page.getByText("Диалоги не найдены", { exact: true }),
  ).toBeVisible();
  await input().fill("");
  await page.getByRole("option", { name: /Настройки/ }).click();
  await expect(input()).toHaveAttribute("placeholder", "Найти настройку…");
  await capture("search-settings");
  await input().fill("шрифт");
  await expect(page.getByRole("option")).toHaveCount(1);
  await input().press("Escape");
  await expect(input()).toHaveAttribute("placeholder", "Поиск чатов и команд…");
  await input().fill("Настройки");
  await input().press("Enter");
  await input().fill("шрифт");
  await input().press("Enter");
  await expect(page.locator(".settings-screen")).toBeVisible();
  await expect(palette()).toHaveCount(0);
  await openSearch();
  await input().fill("Новый чат");
  await page.getByRole("option", { name: /Новый чат/ }).click();
  await expect(palette()).toHaveCount(0);
  await expect(page.locator(".settings-screen")).toHaveCount(0);
  const activeNow = await page.evaluate(
    async (projects) =>
      Promise.all(projects.map((p) => window.desktop.sessions(p.id))),
    projects,
  );
  assert.equal(
    activeNow.reduce((sum, page) => sum + page.sessions.length, 0),
    10,
  );
  await openArchive();
  await expect(page.locator(".archive-count")).toHaveText("4");
  await expect(page.locator(".archive-chat-row")).toHaveCount(4);
  await expect(
    page.getByRole("textbox", { name: "Поиск в архиве" }),
  ).toBeFocused();
  await capture("archive-chats");
  await page.getByRole("button", { name: /^Проект для поиска:/ }).click();
  await page
    .getByRole("menuitemradio", { name: folders[1], exact: true })
    .click();
  await expect(page.locator(".archive-chat-row")).toHaveCount(2);
  await page.getByRole("button", { name: /^Проект для поиска:/ }).click();
  await page
    .getByRole("menuitemradio", { name: "Все проекты", exact: true })
    .click();
  const archiveInput = page.getByRole("textbox", { name: "Поиск в архиве" });
  await archiveInput.fill("платформер");
  await expect(page.locator(".archive-chat-row")).toHaveCount(1);
  await capture("archive-filtered");
  await page.getByRole("button", { name: /^Восстановить чат/ }).click();
  await expect(page.locator(".archive-count")).toHaveText("3");
  await expect(
    page.getByText("Ничего не найдено", { exact: true }),
  ).toBeVisible();
  const restored = await page.evaluate(
    (id) => window.desktop.openSession(id),
    seeded.archived[2].id,
  );
  assert.equal(restored.session.title, seeded.archived[2].title);
  const remaining = await page.evaluate(
    (id) => window.desktop.sessions(id, undefined, true),
    projects[0].id,
  );
  assert.ok(!remaining.sessions.some((s) => s.id === seeded.archived[2].id));
  assert.ok(
    remaining.sessions.some((s) => s.id === seeded.chat.id),
    "Chat Faction archive must stay untouched",
  );
  await page
    .getByRole("button", { name: "Сбросить поиск", exact: true })
    .click();
  await expect(page.locator(".archive-chat-row")).toHaveCount(3);
  const geometry = [];
  for (const [width, height, zoom] of [
    [1440, 960, 1],
    [780, 600, 1],
    [1440, 960, 1.5],
    [1440, 960, 2],
    [780, 600, 2],
  ]) {
    await app.evaluate(
      ({ BrowserWindow }, [w, h, z]) => {
        const win = BrowserWindow.getAllWindows()[0];
        win.setSize(w, h);
        win.webContents.setZoomFactor(z);
      },
      [width, height, zoom],
    );
    await page.waitForTimeout(220);
    const measure = async (selector) =>
      page.locator(selector).evaluate((el) => {
        const r = el.getBoundingClientRect();
        return {
          x: r.x,
          y: r.y,
          right: r.right,
          bottom: r.bottom,
          width: r.width,
          height: r.height,
          viewportWidth: innerWidth,
          viewportHeight: innerHeight,
          overflow: el.scrollWidth > el.clientWidth,
        };
      });
    let box = await measure(".archive-dialog");
    assert.ok(
      box.x >= 0 &&
        box.y >= 0 &&
        box.right <= box.viewportWidth + 1 &&
        box.bottom <= box.viewportHeight + 1 &&
        !box.overflow,
      JSON.stringify(box),
    );
    await capture(`archive-${width}-${zoom}`);
    await page.keyboard.press("Escape");
    await openSearch();
    box = await measure(".command-palette");
    assert.ok(
      box.x >= 0 &&
        box.y >= 0 &&
        box.right <= box.viewportWidth + 1 &&
        box.bottom <= box.viewportHeight + 1 &&
        !box.overflow,
      JSON.stringify(box),
    );
    await capture(`search-${width}-${zoom}`);
    geometry.push({ windowWidth: width, windowHeight: height, zoom, ...box });
    await input().fill("Архив");
    await page
      .getByRole("option", { name: "Архив чатов", exact: true })
      .click();
    await expect(page.locator(".archive-count")).toHaveText("3");
  }
  await fs.writeFile(
    "test-results/search-archive-geometry.json",
    JSON.stringify(geometry, null, 2),
  );
  await app.evaluate(({ BrowserWindow }) => {
    const w = BrowserWindow.getAllWindows()[0];
    w.setSize(1440, 960);
    w.webContents.setZoomFactor(1);
  });
  for (let count = 3; count > 0; count--) {
    await page.getByRole("textbox", { name: "Поиск в архиве" }).press("Enter");
    await expect(page.locator(".archive-count")).toHaveText(String(count - 1));
    await expect(page.locator(".archive-restore-button:disabled")).toHaveCount(
      0,
    );
  }
  await expect(
    page.getByText("Архив пока пуст", { exact: true }),
  ).toBeVisible();
  await capture("archive-empty");
  await page.keyboard.press("Escape");
  const trigger = page
    .getByRole("button", { name: "Поиск чатов и команд · Ctrl+K", exact: true })
    .first();
  await trigger.click();
  await expect(input()).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(trigger).toBeFocused();
  await openSearch();
  await input().fill("любая фраза");
  await input().press("Control+n");
  await expect(palette()).toHaveCount(0);
  const afterShortcut = await page.evaluate(
    async (projects) =>
      Promise.all(projects.map((p) => window.desktop.sessions(p.id))),
    projects,
  );
  assert.equal(
    afterShortcut.reduce((sum, page) => sum + page.sessions.length, 0),
    14,
    "Ctrl+N starts a draft without creating an empty chat after restoring all four archived chats",
  );
  await openSearch();
  await input().press("Control+,");
  await expect(input()).toHaveAttribute("placeholder", "Найти настройку…");
  await input().press("Control+k");
  await expect(palette()).toHaveCount(0);
  assert.deepEqual(errors, []);
  console.log(
    "PASS compact search, title matching, project filter, keyboard navigation, settings, new chat, archive restoration, workspace isolation and five viewport/zoom layouts",
  );
} catch (error) {
  await capture("search-archive-failure").catch(() => {});
  throw error;
} finally {
  await app.close();
}
