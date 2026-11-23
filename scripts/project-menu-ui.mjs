import { _electron as electron } from "playwright";
import { Service } from "@opencode/client/service";
import { OpenCode } from "@opencode/client";
import fs from "node:fs/promises";
import path from "node:path";
import assert from "node:assert/strict";

const directory = path.resolve(`.runtime/project-menu-${process.pid}`);
await fs.mkdir(directory, { recursive: true });
let app, page;
const errors = [];
const launch = async () => {
  app = await electron.launch({
    args: ["."],
    env: { ...process.env, FORGE_DATA_DIR: directory },
    timeout: 30000,
  });
  page = await app.firstWindow();
  page.on("pageerror", (e) => errors.push(e.message));
  await page.locator(".status-dot.ready").waitFor({ timeout: 40000 });
};
try {
  await launch();
  const projects = [];
  for (const name of ["Мастерская", "Второй проект"]) {
    const folder = path.join(directory, name);
    await fs.mkdir(folder, { recursive: true });
    await fs.writeFile(path.join(folder, "keep.txt"), "DO NOT DELETE");
    await app.evaluate(({ dialog }, folder) => {
      dialog.showOpenDialog = async () => ({
        canceled: false,
        filePaths: [folder],
      });
    }, folder);
    projects.push(await page.evaluate(() => window.desktop.addProject()));
  }
  const file = path.join(directory, "engine/state/opencode/service.json");
  const endpoint = await Service.discover({ file, version: "2.3.0" });
  assert.ok(endpoint);
  let client = OpenCode.make({
    baseUrl: endpoint.url,
    headers: Service.headers(endpoint),
  });
  const sessions = [];
  for (let index = 0; index < 125; index++)
    sessions.push(
      await client.session.create({
        location: { directory: projects[0].path },
        title: `Чат ${index}`,
      }),
    );
  const other = await client.session.create({
    location: { directory: projects[1].path },
    title: "Сохранить другой чат",
  });
  await page.evaluate(
    async ({ projectId, sessionId }) =>
      window.desktop.savePreferences({ projectId, sessionId }),
    { projectId: projects[1].id, sessionId: other.id },
  );
  await page.reload();
  await page
    .locator(".workspace-title")
    .filter({ hasText: other.title })
    .waitFor();
  const group = () => page.locator(`[data-project-id="${projects[0].id}"]`);
  const open = async () => {
    await group().locator(".project-row").click({ button: "right" });
    await page.getByRole("menu", { name: "Действия с проектом" }).waitFor();
  };
  const closed = () => page.getByRole("menu").waitFor({ state: "detached" });
  await open();
  assert.equal(await page.getByRole("menuitem").count(), 6);
  await page.getByRole("menuitem", { name: "Закрепить", exact: true }).click();
  await closed();
  await group().locator(".project-pin-marker").waitFor();
  await open();
  await page
    .getByRole("menuitem", { name: "Редактировать", exact: true })
    .click();
  const edit = page.getByRole("dialog", { name: "Редактировать проект" });
  await edit.getByRole("textbox").fill("Игровая мастерская");
  await edit.getByRole("button", { name: "Сохранить", exact: true }).click();
  await group()
    .locator(".project-name")
    .filter({ hasText: "Игровая мастерская" })
    .waitFor();
  assert.ok(
    (await page.locator(".workspace-title").innerText()).includes(other.title),
  );
  await open();
  await page.getByRole("menuitem", { name: "Раздел", exact: true }).click();
  await page.getByRole("textbox", { name: "Новый раздел" }).fill("Игры");
  await page
    .getByRole("button", { name: "Создать раздел для проекта" })
    .click();
  await closed();
  await group().getByText("Игры", { exact: true }).waitFor();
  await app.close();
  await launch();
  const saved = await page.evaluate(() => window.desktop.bootstrap());
  assert.equal(
    saved.projects.find((p) => p.id === projects[0].id).section,
    "Игры",
  );
  assert.equal(
    saved.projects.find((p) => p.id === projects[0].id).name,
    "Игровая мастерская",
  );
  assert.ok(saved.preferences.pinnedProjects.includes(projects[0].id));
  const ep = await Service.discover({ file, version: "2.3.0" });
  client = OpenCode.make({ baseUrl: ep.url, headers: Service.headers(ep) });
  await group().waitFor();
  await app.evaluate(({ shell }) => {
    globalThis.projectQaOpened = [];
    shell.openPath = async (folder) => {
      globalThis.projectQaOpened.push(folder);
      return "";
    };
  });
  await open();
  await page
    .getByRole("menuitem", { name: "Открыть в Проводнике", exact: true })
    .click();
  await closed();
  assert.deepEqual(await app.evaluate(() => globalThis.projectQaOpened), [
    projects[0].path,
  ]);
  for (const width of [1440, 780]) {
    await app.evaluate(
      ({ BrowserWindow }, width) =>
        BrowserWindow.getAllWindows()[0].setSize(width, 600),
      width,
    );
    await open();
    const box = await page.getByRole("menu").boundingBox();
    const size = await page.evaluate(() => ({
      width: innerWidth,
      height: innerHeight,
    }));
    assert.ok(
      box.x >= 0 &&
        box.y >= 0 &&
        box.x + box.width <= size.width &&
        box.y + box.height <= size.height,
    );
    await page.screenshot({ path: `test-results/project-menu-${width}.png` });
    await page.keyboard.press("Escape");
  }
  await open();
  await page
    .getByRole("menuitem", { name: "Архивировать чаты", exact: true })
    .click();
  await closed();
  const archived = [];
  let cursor;
  do {
    const pageResult = await page.evaluate(
      ({ id, cursor }) => window.desktop.sessions(id, cursor, true),
      { id: projects[0].id, cursor },
    );
    archived.push(...pageResult.sessions);
    cursor = pageResult.next ?? undefined;
  } while (cursor);
  assert.equal(archived.length, 125);
  assert.equal(
    (await page.evaluate((id) => window.desktop.sessions(id), projects[0].id))
      .sessions.length,
    0,
  );
  assert.equal(
    (await page.evaluate((id) => window.desktop.sessions(id), projects[1].id))
      .sessions.length,
    1,
  );
  // Restore one chat, then verify removing a project leaves history and files intact.
  await page.evaluate(
    (id) => window.desktop.archiveSession(id, false),
    sessions[0].id,
  );
  await open();
  await page.getByRole("menuitem", { name: "Раздел", exact: true }).click();
  await page
    .getByRole("menuitem", { name: "Без раздела", exact: true })
    .click();
  await closed();
  await open();
  await page.getByRole("menuitem", { name: "Открепить", exact: true }).click();
  await closed();
  const secondReady = app.waitForEvent("window");
  await page.evaluate(
    (id) => window.desktop.openSessionWindow(id),
    sessions[0].id,
  );
  const second = await secondReady;
  second.on("pageerror", (e) => errors.push(e.message));
  await second
    .locator(".workspace-title")
    .filter({ hasText: sessions[0].title })
    .waitFor();
  await open();
  await page
    .getByRole("menuitem", { name: "Убрать проект", exact: true })
    .click();
  await closed();
  await group().waitFor({ state: "detached" });
  assert.equal(
    await fs.readFile(path.join(projects[0].path, "keep.txt"), "utf8"),
    "DO NOT DELETE",
  );
  assert.ok(await client.session.get({ sessionID: sessions[0].id }));
  assert.ok(
    (await page.locator(".workspace-title").innerText()).includes(other.title),
  );
  await app.evaluate(({ dialog }, folder) => {
    dialog.showOpenDialog = async () => ({
      canceled: false,
      filePaths: [folder],
    });
  }, projects[0].path);
  const restored = await page.evaluate(() => window.desktop.addProject());
  assert.ok(
    (
      await page.evaluate((id) => window.desktop.sessions(id), restored.id)
    ).sessions.some((s) => s.id === sessions[0].id),
  );
  await page.waitForTimeout(850);
  assert.equal(await page.getByRole("alert").count(), 0);
  assert.equal(await second.getByRole("alert").count(), 0);

  await second
    .getByRole("button", { name: "Закрыть окно", exact: true })
    .click();
  assert.deepEqual(errors, []);
  await fs.writeFile(
    "test-results/project-menu-verification.json",
    JSON.stringify(
      {
        passed: true,
        all6Actions: true,
        archivedChats: 125,
        restartPersistence: true,
        explorerIpc: true,
        filesAndHistoryPreserved: true,
        reAddProjectRestoresChats: true,
        otherProjectUnchanged: true,
        sizes: [1440, 780],
        errors,
      },
      null,
      2,
    ),
  );
  console.log(
    "PASS project menu: six actions, 125-chat archive, restart, Explorer IPC, sections, safe removal/re-add and narrow layout",
  );
} catch (error) {
  await page
    ?.screenshot({ path: "test-results/project-menu-failure.png" })
    .catch(() => {});
  throw error;
} finally {
  if (app) {
    await Promise.race([app.close(), new Promise(resolve => setTimeout(resolve, 5000))]);
    assert.notEqual(app.process().exitCode, null, "Electron test instance must exit cleanly");
  }
}

// Both Electron instances have closed; release SDK keep-alive handles in this standalone harness.
process.exit(0);
