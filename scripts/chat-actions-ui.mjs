import { _electron as electron } from "playwright";
import { Service } from "@opencode/client/service";
import { OpenCode } from "@opencode/client";
import fs from "node:fs/promises";
import path from "node:path";
import assert from "node:assert/strict";

const directory = path.resolve(`.runtime/chat-actions-${process.pid}`);
await fs.mkdir(directory, { recursive: true });
const app = await electron.launch({
  args: ["."],
  env: { ...process.env, FORGE_DATA_DIR: directory },
  timeout: 30000,
});
let page;
const errors = [];
try {
  page = await app.firstWindow();
  page.on("pageerror", (e) => errors.push(e.message));
  await page.locator(".status-dot.ready").waitFor({ timeout: 40000 });
  await app.evaluate(({ clipboard }) => {
    globalThis.chatQaClipboard = clipboard.read();
  });
  const projects = [];
  for (const name of ["Проект A", "Проект B"]) {
    const folder = path.join(directory, name);
    await fs.mkdir(folder, { recursive: true });
    await app.evaluate(({ dialog }, folder) => {
      dialog.showOpenDialog = async () => ({
        canceled: false,
        filePaths: [folder],
      });
    }, folder);
    projects.push(await page.evaluate(() => window.desktop.addProject()));
  }
  const ep = await Service.discover({
    file: path.join(directory, "engine/state/opencode/service.json"),
    version: "2.3.0",
  });
  assert.ok(ep);
  const client = OpenCode.make({
    baseUrl: ep.url,
    headers: Service.headers(ep),
  });
  const blank = await client.session.create({
    location: { directory: projects[0].path },
    title: "Тест меню чата",
  });
  await client.session.remove({ sessionID: blank.id });
  const messages = Array.from({ length: 320 }, (_, i) => ({
    id: `msg_${(0x20000000000 + i).toString(16)}qa${String(i).padStart(10, "0")}`,
    type: "user",
    time: { created: blank.time.created + i },
    text: `История ${i}: проверка полного экспорта`,
  }));
  const session = await client.experimental.session.import({
    info: blank,
    messages,
    location: { directory: projects[0].path },
  });
  await page.evaluate(
    async ({ id, projectId }) =>
      window.desktop.savePreferences({ sessionId: id, projectId }),
    { id: session.id, projectId: projects[0].id },
  );
  await page.reload();
  await page
    .locator(".workspace-title")
    .filter({ hasText: "Тест меню чата" })
    .waitFor();
  const row = () =>
    page.locator(`.session-row[data-session-id="${session.id}"]`).first();
  const menu = async () => {
    await row().click({ button: "right" });
    await page.getByRole("menuitem", { name: /^Переименовать/ }).waitFor();
  };
  await menu();
  assert.equal(await page.getByRole("menuitem").count(), 11);
  await page.getByRole("menuitem", { name: /^Переименовать/ }).click();
  const rename = page.getByRole("dialog", { name: "Переименовать чат" });
  // Existing rename dialog title is shared by toolbar and context menu.
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("textbox").fill("Переименованный чат");
  await dialog.getByRole("button", { name: "Сохранить", exact: true }).click();
  await row().filter({ hasText: "Переименованный чат" }).waitFor();
  await menu();
  await page.getByRole("menuitem", { name: /^Закрепить/ }).click();
  await page
    .locator(`.pinned-section [data-session-id="${session.id}"]`)
    .waitFor();
  await menu();
  await page
    .getByRole("menuitem", { name: "Отметить непрочитанным", exact: true })
    .click();
  await page.waitForFunction(
    (id) =>
      document
        .querySelector(`[data-session-id="${id}"]`)
        ?.classList.contains("unread"),
    session.id,
  );
  await menu();
  await page.getByRole("menuitem", { name: "Раздел", exact: true }).click();
  await page.getByRole("textbox", { name: "Новый раздел" }).fill("На проверку");
  await page
    .getByRole("button", { name: "Создать раздел и переместить чат" })
    .click();
  await page.getByText("На проверку", { exact: true }).first().waitFor();
  await page.reload();
  await row().waitFor();
  assert.equal(
    (await page.evaluate((id) => window.desktop.refreshSession(id), session.id))
      .session.section,
    "На проверку",
  );
  await menu();
  await page.getByRole("menuitem", { name: "Копировать", exact: true }).click();
  await page.getByRole("menuitem", { name: "Переписку", exact: true }).click();
  await page.waitForFunction(() => !document.querySelector('[role="menu"]'));
  const copied = await app.evaluate(({ clipboard }) => clipboard.readText());
  assert.ok(
    copied.includes("История 0:") && copied.includes("История 319:"),
    JSON.stringify({
      length: copied.length,
      first: copied.includes("История 0:"),
      last: copied.includes("История 319:"),
    }),
  );
  for (const [label, value] of [
    ["Название", "Переименованный чат"],
    ["ID чата", session.id],
  ]) {
    await menu();
    await page
      .getByRole("menuitem", { name: "Копировать", exact: true })
      .click();
    await page.getByRole("menuitem", { name: label, exact: true }).click();
    await page.waitForTimeout(120);
    assert.equal(
      await app.evaluate(({ clipboard }) => clipboard.readText()),
      value,
    );
  }
  const exported = path.join(directory, "shared.md");
  await app.evaluate(({ dialog }, filePath) => {
    dialog.showSaveDialog = async () => ({ canceled: false, filePath });
  }, exported);
  await menu();
  await page.getByRole("menuitem", { name: "Поделиться", exact: true }).click();
  await page
    .getByRole("menuitem", { name: "Сохранить Markdown…", exact: true })
    .click();
  await page.waitForFunction(() => !document.querySelector('[role="menu"]'));
  assert.equal(await fs.readFile(exported, "utf8"), copied);
  await menu();
  await page.getByRole("menuitem", { name: "Ответвить", exact: true }).click();
  await page.getByRole("menuitem", { name: "Проект A", exact: true }).click();
  await page
    .locator(".workspace-title")
    .filter({ hasText: "ответвление" })
    .waitFor();
  const fork = (
    await client.session.list({
      directory: projects[0].path,
      limit: 20,
      archived: false,
    })
  ).data.find((s) => s.id !== session.id && s.title.includes("ответвление"));
  assert.ok(fork);
  assert.equal(
    (await client.message.list({ sessionID: fork.id, limit: 10, order: "asc" }))
      .data[0].text,
    messages[0].text,
  );
  await menu();
  await page.getByRole("menuitem", { name: "Проект", exact: true }).click();
  await page.getByRole("menuitem", { name: "Проект B", exact: true }).click();
  await page.waitForFunction(
    async ({ id, projectId }) =>
      (await window.desktop.refreshSession(id)).session.projectId === projectId,
    { id: session.id, projectId: projects[1].id },
  );
  await page.waitForFunction(() => !document.querySelector('[role="menu"]'));
  for (
    let i = 0;
    i < 100 &&
    (await client.session.get({ sessionID: session.id })).location.directory !==
      projects[1].path;
    i++
  )
    await page.waitForTimeout(50);
  assert.equal(
    (await client.session.get({ sessionID: session.id })).location.directory,
    projects[1].path,
  );
  const secondReady = app.waitForEvent("window");
  await menu();
  await page
    .getByRole("menuitem", { name: "Открыть в новом окне", exact: true })
    .click();
  console.log("PASS move and full history fork");
  const second = await secondReady;
  await second
    .locator(".workspace-title")
    .filter({ hasText: "Переименованный чат" })
    .waitFor();
  assert.ok(
    (await page.locator(".workspace-title").innerText()).includes(
      "ответвление",
    ),
  );
  await second.evaluate(async (id) => {
    await window.desktop.renameSession(id, "Ответвление в первом окне");
  }, fork.id);
  await page
    .locator(".workspace-title")
    .filter({ hasText: "Ответвление в первом окне" })
    .waitFor();
  assert.ok(
    (await second.locator(".workspace-title").innerText()).includes(
      "Переименованный чат",
    ),
  );
  await second
    .getByRole("button", { name: "Закрыть окно", exact: true })
    .click();
  await page.locator(".workspace-title").waitFor();
  await menu();
  await page.getByRole("menuitem", { name: /^Архивировать/ }).click();
  await row().waitFor({ state: "detached" });
  assert.ok(
    (
      await page.evaluate(
        (projectId) => window.desktop.sessions(projectId, undefined, true),
        projects[1].id,
      )
    ).sessions.some((s) => s.id === session.id),
  );
  await page.evaluate(
    (id) => window.desktop.archiveSession(id, false),
    session.id,
  );
  await row().waitFor();
  await app.evaluate(({ dialog }) => {
    dialog.showMessageBox = async () => ({
      response: 0,
      checkboxChecked: false,
    });
  });
  await menu();
  await page
    .getByRole("menuitem", { name: "Удалить навсегда", exact: true })
    .click();
  await page.waitForFunction(() => !document.querySelector('[role="menu"]'));
  assert.ok(await client.session.get({ sessionID: session.id }));
  await app.evaluate(({ dialog }) => {
    dialog.showMessageBox = async () => ({
      response: 1,
      checkboxChecked: false,
    });
  });
  await menu();
  await page
    .getByRole("menuitem", { name: "Удалить навсегда", exact: true })
    .click();
  await row().waitFor({ state: "detached" });
  await assert.rejects(() => client.session.get({ sessionID: session.id }));
  assert.ok(await client.session.get({ sessionID: fork.id }));
  await page.waitForTimeout(850);
  assert.equal(await page.getByRole("alert").count(), 0);
  for (const width of [1440, 780]) {
    await app.evaluate(
      ({ BrowserWindow }, width) =>
        BrowserWindow.getAllWindows()[0].setSize(width, 600),
      width,
    );
    const last = page.locator(".session-row").last();
    await last.click({ button: "right" });
    const bounds = await page.getByRole("menu").boundingBox();
    const viewport = await page.evaluate(() => ({
      w: innerWidth,
      h: innerHeight,
    }));
    assert.ok(
      bounds.x >= 0 &&
        bounds.y >= 0 &&
        bounds.x + bounds.width <= viewport.w &&
        bounds.y + bounds.height <= viewport.h,
    );
    await page.screenshot({ path: `test-results/chat-menu-${width}.png` });
    await page.keyboard.press("Escape");
  }
  assert.deepEqual(errors, []);
  await fs.writeFile(
    "test-results/chat-actions-verification.json",
    JSON.stringify(
      {
        passed: true,
        all11Actions: true,
        fullHistoryExport: 320,
        forkHistory: true,
        move: true,
        multiWindow: true,
        deleteCancel: true,
        deleteConfirmed: true,
        narrowMenu: true,
        errors,
      },
      null,
      2,
    ),
  );
  console.log(
    "PASS all 11 chat context actions, full 320-message history, isolated engine, two windows, delete cancellation and narrow layout",
  );
} catch (error) {
  await page
    ?.screenshot({ path: "test-results/chat-actions-failure.png" })
    .catch(() => {});
  throw error;
} finally {
  await app
    .evaluate(({ clipboard }) => {
      if (globalThis.chatQaClipboard)
        clipboard.write(globalThis.chatQaClipboard);
    })
    .catch(() => {});
  await app.close();
}
