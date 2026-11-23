import { _electron as electron } from "playwright";
import fs from "node:fs/promises";
import path from "node:path";
import assert from "node:assert/strict";

const directory = path.resolve(`.runtime/sidebar-ui-${process.pid}`);
await fs.mkdir(directory, { recursive: true });
await fs.mkdir("test-results", { recursive: true });
const names = [
  "AgentOpenCodeDesktop",
  "Игровая мастерская",
  "Pocket LAN",
  "Larsta",
  "Библиотека",
  "Наброски",
];
let app, page;
const errors = [];
try {
  app = await electron.launch({
    args: ["."],
    env: { ...process.env, FORGE_DATA_DIR: directory },
    timeout: 30000,
  });
  page = await app.firstWindow();
  page.on("pageerror", (error) => errors.push(error.message));
  await page.waitForSelector(".status-dot.ready", { timeout: 40000 });
  await app.evaluate(async ({ clipboard }) => {
    globalThis.forgeUiClipboardBackup = await clipboard.read();
  });
  const projects = [],
    sessions = [];
  for (let index = 0; index < names.length; index++) {
    const folder = path.join(directory, names[index]);
    await fs.mkdir(folder, { recursive: true });
    await app.evaluate(({ dialog }, folder) => {
      dialog.showOpenDialog = async () => ({
        canceled: false,
        filePaths: [folder],
      });
    }, folder);
    const project = await page.evaluate(() => window.desktop.addProject());
    projects.push(project);
    const titles =
      index === 0
        ? [
            "Улучшить интерфейс приложения",
            "Разработать OpenCode Desktop Agent",
            "Проверить архитектуру",
          ]
        : index === 1
          ? [
              "Собрать идеи для GitHub",
              "Придумать 2D платформер",
              "Переработать движение персонажа",
              "Добавить эффекты окружения",
              "Проверить сцены",
              "Настроить управление",
              "Улучшить освещение",
            ]
          : index === 2
            ? ["Добавить программируемые блоки"]
            : [];
    for (const title of titles) {
      const session = await page.evaluate(
        async ({ projectId, title }) => {
          const session = await window.desktop.createSession(
            projectId,
            undefined,
            "cautious",
          );
          await window.desktop.renameSession(session.id, title);
          return { ...session, title };
        },
        { projectId: project.id, title },
      );
      sessions.push(session);
    }
  }
  const current = sessions[0],
    pinned = sessions[3],
    target = sessions[2];
  await page.evaluate(
    async ({ current, pinned }) => {
      await window.desktop.pinSession(pinned.id, true);
      await window.desktop.savePreferences({
        projectId: current.projectId,
        sessionId: current.id,
      });
    },
    { current, pinned },
  );
  await page.reload();
  await page
    .locator(".workspace-title")
    .filter({ hasText: current.title })
    .waitFor();
  await page.locator(".pinned-section .session-row").waitFor();
  assert.equal(
    await page.locator(".projects-section .project-group").count(),
    6,
  );
  assert.equal(
    await page.locator(".recents-section .session-row").count(),
    sessions.length,
    "Recents includes every chat, including chats shown under projects",
  );
  const rows = await page
    .locator(".recents-section .session-row")
    .evaluateAll((items) => items.map((item) => item.dataset.sessionId));
  assert.equal(
    new Set(rows).size,
    rows.length,
    "Each chat appears once in Recents",
  );
  const projectGroup = page.locator(`[data-project-id="${projects[1].id}"]`);
  assert.equal(await projectGroup.locator(".session-row").count(), 5);
  await projectGroup.getByRole("button", { name: /Показать ещё/ }).click();
  assert.equal(await projectGroup.locator(".session-row").count(), 6);

  const targetRow = () =>
    page.locator(`.recents-section [data-session-id="${target.id}"]`);
  await targetRow().click({ button: "right" });
  await page.getByRole("menuitem", { name: /Переименовать/ }).click();
  const rename = page.getByRole("dialog", { name: "Название задачи" });
  assert.equal(await rename.getByRole("textbox").inputValue(), target.title);
  await rename.getByRole("textbox").fill("Проверить архитектуру интерфейса");
  await rename.getByRole("button", { name: "Сохранить" }).click();
  await targetRow()
    .filter({ hasText: "Проверить архитектуру интерфейса" })
    .waitFor();
  assert.ok(
    (await page.locator(".workspace-title").innerText()).includes(
      current.title,
    ),
    "Renaming another chat must preserve the open chat",
  );
  await targetRow().click({ button: "right" });
  await page.getByRole("menuitem", { name: /Закрепить/ }).click();
  await page
    .locator(`.pinned-section [data-session-id="${target.id}"]`)
    .waitFor();

  await projectGroup.locator(".project-row").hover();
  await projectGroup
    .getByRole("button", { name: /Сведения о проекте/ })
    .click();
  const card = page.getByRole("dialog", { name: "Сведения о проекте" });
  await card
    .getByRole("button", { name: "Копировать путь", exact: true })
    .click();
  assert.equal(
    await app.evaluate(({ clipboard }) => clipboard.readText()),
    projects[1].path,
  );
  await projectGroup.locator(".project-row").hover();
  await projectGroup
    .getByRole("button", { name: /Сведения о проекте/ })
    .click();
  await card
    .getByRole("button", { name: "Закрепить проект", exact: true })
    .click();
  await page.screenshot({ path: "test-results/sidebar-project-card.png" });
  await card
    .getByRole("button", { name: "Редактировать проект", exact: true })
    .click();
  const edit = page.getByRole("dialog", { name: "Редактировать проект" });
  await edit.getByRole("textbox").fill("Мастерская игр");
  await edit.getByRole("button", { name: "Сохранить", exact: true }).click();
  await projectGroup
    .locator(".project-name")
    .filter({ hasText: "Мастерская игр" })
    .waitFor();

  await page.getByRole("button", { name: "Организация панели" }).click();
  await page
    .getByRole("menuitemradio", { name: "По названию", exact: true })
    .click();
  await page.getByRole("button", { name: "Организация панели" }).click();
  await page
    .getByRole("menuitemcheckbox", { name: "Показывать проекты" })
    .click();
  await page.locator(".projects-section").waitFor({ state: "detached" });
  await page.reload();
  await page.locator(".recents-section .session-row").first().waitFor();
  assert.equal(await page.locator(".projects-section").count(), 0);
  const saved = await page.evaluate(() => window.desktop.bootstrap());
  assert.equal(saved.preferences.chatSort, "title");
  assert.equal(saved.preferences.showProjects, false);
  assert.ok(saved.preferences.pinnedProjects.includes(projects[1].id));
  assert.equal(
    saved.projects.find((p) => p.id === projects[1].id).name,
    "Мастерская игр",
  );
  assert.equal(
    saved.projects.find((p) => p.id === projects[1].id).path,
    projects[1].path,
  );
  await page.getByRole("button", { name: "Организация панели" }).click();
  await page
    .getByRole("menuitemcheckbox", { name: "Показывать проекты" })
    .click();
  await page.locator(".projects-section .project-group").first().waitFor();
  assert.equal(
    await page
      .locator(".project-group")
      .first()
      .getAttribute("data-project-id"),
    projects[1].id,
  );
  for (const size of [
    [1440, 900],
    [1080, 720],
    [780, 600],
  ]) {
    await app.evaluate(
      ({ BrowserWindow }, size) =>
        BrowserWindow.getAllWindows()[0].setSize(...size),
      size,
    );
    await page.locator(".sidebar-scroll").evaluate((element) => {
      element.scrollTop = 0;
    });
    await page.waitForTimeout(200);
    assert.equal(
      await page.evaluate(
        () => document.documentElement.scrollWidth > innerWidth,
      ),
      false,
    );
    await page.screenshot({ path: `test-results/sidebar-${size[0]}.png` });
  }
  await page.locator(".session-row").last().click({ button: "right" });
  const bounds = await page
    .getByRole("menu", { name: "Действия с чатом" })
    .evaluate((element) => {
      const b = element.getBoundingClientRect();
      return (
        b.left >= 0 &&
        b.right <= innerWidth &&
        b.top >= 36 &&
        b.bottom <= innerHeight
      );
    });
  assert.ok(bounds);
  await page.keyboard.press("Escape");
  assert.equal(
    await page.getByRole("menu", { name: "Действия с чатом" }).count(),
    0,
  );
  assert.deepEqual(errors, []);
  await fs.writeFile(
    "test-results/sidebar-verification.json",
    JSON.stringify(
      {
        passed: true,
        directory,
        projects: projects.length,
        sessions: sessions.length,
        renameInactiveChat: true,
        pinProject: true,
        renameProject: true,
        copyProjectPath: true,
        persistedSidebarPreferences: true,
        menuFits: true,
        sizes: [
          [1440, 900],
          [1080, 720],
          [780, 600],
        ],
      },
      null,
      2,
    ),
  );
  console.log(
    "PASS sidebar projects/recents, menus, inactive chat rename, project edit/pin, clipboard, preferences after reload and 3 window sizes",
  );
} catch (error) {
  if (page) {
    console.error(
      "Visible errors",
      await page.locator(".error-toast").allTextContents(),
    );
    await page.screenshot({ path: "test-results/sidebar-failure.png" });
  }
  throw error;
} finally {
  if (app) {
    await app
      .evaluate(({ clipboard }) => {
        if (globalThis.forgeUiClipboardBackup)
          clipboard.write(globalThis.forgeUiClipboardBackup);
      })
      .catch(() => {});
    await app.close().catch(() => {});
  }
}
