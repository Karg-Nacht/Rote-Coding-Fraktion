import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { _electron as electron } from "playwright";
import { selectList, selectValue } from "./select-ui.mjs";

await fs.mkdir(".runtime", { recursive: true });
const profile = await fs.mkdtemp(path.resolve(".runtime/custom-controls-"));
const output =
  process.env.RCF_CONTROLS_OUTPUT ?? "test-results/custom-controls";
await fs.mkdir(output, { recursive: true });
const initial =
  "Правила проекта\n\nИспользовать TypeScript, проверять изменения в обеих темах и сохранять результаты тестов.";
const sizes = [
  [1440, 960],
  [1080, 720],
  [780, 600],
];
const geometry = [];
const errors = [];
let app;
let page;

async function launch() {
  app = await electron.launch({
    args: ["."],
    env: { ...process.env, RCF_DATA_DIR: profile },
  });
  page = await app.firstWindow();
  page.on("pageerror", (error) => errors.push(error.message));
  await page.locator(".status-dot.ready").waitFor({ timeout: 45_000 });
}

const button = (name) => page.getByRole("button", { name, exact: true });
const setting = (id) => page.locator(`#setting-${id}`).getByRole("combobox");
const openSettings = async () => {
  await page.keyboard.press("Control+,");
  await page.locator(".settings-screen").waitFor();
};
const resize = async (width, height) => {
  await app.evaluate(
    ({ BrowserWindow }, size) => {
      BrowserWindow.getAllWindows()[0].setContentSize(...size);
    },
    [width, height],
  );
  await page.waitForFunction(
    ([w, h]) => innerWidth === w && innerHeight === h,
    [width, height],
  );
};
const capture = (name) =>
  page.screenshot({ path: path.join(output, name + ".png") });
const focused = (locator) =>
  locator.evaluate((el) => el === document.activeElement);

async function menuGeometry(control) {
  const list = await selectList(control);
  await list.and(page.locator(":popover-open")).waitFor({ state: "attached" });
  await list.evaluate((el) =>
    Promise.all(el.getAnimations().map((animation) => animation.finished)),
  );
  const bounds = await list.evaluate((el) => {
    const rect = el.getBoundingClientRect();
    const titlebar = document
      .querySelector(".titlebar")
      .getBoundingClientRect();
    const modal = el.closest('[role="dialog"]');
    const header = modal
      ?.querySelector(":scope > header")
      ?.getBoundingClientRect();
    const footer = modal
      ?.querySelector("[data-select-footer]")
      ?.getBoundingClientRect();
    const x = rect.left + rect.width / 2;
    const y = rect.top + Math.min(12, rect.height / 2);
    return {
      safe:
        rect.left >= 7 &&
        rect.top >= titlebar.bottom &&
        (!header || rect.top >= header.bottom) &&
        (!footer || rect.bottom <= footer.top) &&
        rect.right <= innerWidth - 7 &&
        rect.bottom <= innerHeight - 7,
      hit: el.contains(document.elementFromPoint(x, y)),
      overflow: el.scrollWidth > el.clientWidth,
      scrollable: el.scrollHeight > el.clientHeight,
      side: el.dataset.side,
    };
  });
  assert.equal(bounds.safe, true);
  assert.equal(bounds.hit, true);
  assert.equal(bounds.overflow, false);
  return bounds;
}

async function openEditor(readerCapture) {
  await button("Открыть запись «Правила проекта»").click();
  if (readerCapture) {
    const reader = page.getByRole("dialog", {
      name: "Правила проекта",
      exact: true,
    });
    await reader.getByRole("region", { name: "Текст записи" }).waitFor();
    const styling = await reader.evaluate((el) => ({
      border: getComputedStyle(el).borderLeftWidth,
      header: getComputedStyle(el.querySelector("header")).borderBottomWidth,
      footer: getComputedStyle(el.querySelector(".memory-panel-actions"))
        .borderTopWidth,
    }));
    assert.deepEqual(styling, { border: "0px", header: "0px", footer: "0px" });
    await capture(readerCapture);
  }
  await button("Редактировать запись").click();
  const editor = page.getByRole("dialog", {
    name: "Редактировать запись",
    exact: true,
  });
  await editor.waitFor();
  return editor;
}

try {
  await launch();
  const folders = [
    "Atelier Alpha",
    ...Array.from(
      { length: 26 },
      (_, i) => `Workspace ${String(i + 1).padStart(2, "0")}`,
    ),
    "Zentrum",
  ];
  for (const folder of folders) {
    await fs.mkdir(path.join(profile, folder));
  }
  await app.evaluate(
    ({ dialog }, paths) => {
      let index = 0;
      dialog.showOpenDialog = async () => ({
        canceled: false,
        filePaths: [paths[index++]],
      });
    },
    folders.map((folder) => path.join(profile, folder)),
  );
  const projects = await page.evaluate(
    async ({ count, initial }) => {
      const projects = [];
      for (let i = 0; i < count; i++)
        projects.push(await window.desktop.addProject());
      await window.desktop.createSession(
        projects.at(-1).id,
        undefined,
        "cautious",
        "work",
      );
      await window.desktop.saveMemory({ scope: "global", text: initial });
      return projects;
    },
    { count: folders.length, initial },
  );
  await page.reload();
  await page.locator(".status-dot.ready").waitFor({ timeout: 45_000 });
  await resize(780, 600);
  await openSettings();
  await button("Основные").click();
  const project = setting("project");
  await project.press("Alt+ArrowDown");
  const projectList = await selectList(project);
  assert.equal((await menuGeometry(project)).scrollable, true);
  await project.press("Home");
  const active = async (name) => {
    const option = projectList.getByRole("option", { name, exact: true });
    assert.equal(
      await project.getAttribute("aria-activedescendant"),
      await option.getAttribute("id"),
    );
  };
  await active(folders[0]);
  await project.press("ArrowDown");
  await active(folders[1]);
  await project.press("ArrowUp");
  await active(folders[0]);
  await project.press("End");
  await active(folders.at(-1));
  assert.ok(await projectList.evaluate((el) => el.scrollTop > 0));
  await project.press("Escape");
  assert.ok(await focused(project));
  assert.equal(await project.getAttribute("aria-expanded"), "false");
  await project.press("a");
  await project.press("t");
  await active(folders[0]);
  await project.press("Enter");
  assert.equal(await project.getAttribute("data-value"), projects[0].id);
  await project.click();
  const search = page.getByRole("textbox", { name: "Поиск по параметрам" });
  await search.click();
  assert.ok(await focused(search));
  assert.equal(await project.getAttribute("aria-expanded"), "false");
  await selectValue(project, projects.at(-1).id);

  for (const [theme, themeLabel] of [
    ["dark", "Тёмная"],
    ["light", "Светлая"],
  ]) {
    await button("Внешний вид").click();
    await selectValue(setting("theme"), theme);
    for (const [width, height] of sizes) {
      await resize(width, height);
      const modes = {};
      for (const density of ["comfortable", "compact"]) {
        await button("Внешний вид").click();
        await selectValue(setting("density"), density);
        await page.locator(`html[data-density="${density}"]`).waitFor();
        const layout = await page.evaluate(() => {
          const measure = (selector) =>
            document.querySelector(selector).getBoundingClientRect().height;
          const scroller = document.querySelector(".settings-content");
          return {
            row: measure("#setting-theme"),
            nav: measure(".settings-nav-group button"),
            control: measure("#setting-theme .custom-select"),
            font: getComputedStyle(
              document.querySelector("#setting-theme .custom-select"),
            ).fontSize,
            overflow:
              scroller.scrollWidth > scroller.clientWidth ||
              document.documentElement.scrollWidth > innerWidth,
          };
        });
        assert.equal(layout.overflow, false);
        if (width === 1080 && density === "comfortable") {
          await page.evaluate(() => document.activeElement.blur());
          await capture(`after-appearance-${theme}`);
          const themeControl = setting("theme");
          await themeControl.click();
          const list = await selectList(themeControl);
          assert.equal(
            await list
              .getByRole("option", { name: themeLabel })
              .getAttribute("aria-selected"),
            "true",
          );
          await menuGeometry(themeControl);
          await capture(`after-select-${theme}`);
          await themeControl.press("Tab");
          assert.equal(
            await themeControl.getAttribute("aria-expanded"),
            "false",
          );
          assert.ok(await focused(setting("scale")));
        }
        await button("Память и персонализация").click();
        const editor = await openEditor(
          width === 1080 && density === "comfortable"
            ? `after-reader-${theme}`
            : undefined,
        );
        const editorBounds = await editor.boundingBox();
        assert.ok(editorBounds.width <= 536 && editorBounds.y > 36);
        assert.ok(
          Math.abs(editorBounds.x * 2 + editorBounds.width - width) < 2,
        );
        assert.ok(
          Math.abs(editorBounds.y * 2 + editorBounds.height - height - 36) < 2,
        );
        assert.ok(
          await editor
            .getByRole("textbox", { name: "Текст записи" })
            .isVisible(),
        );
        const scope = editor.getByRole("combobox", { name: "Использовать в" });
        await scope.press("Enter");
        const bounds = await menuGeometry(scope);
        assert.equal(bounds.scrollable, true);
        if (width === 1080 && density === "comfortable") {
          await capture(`after-editor-scope-${theme}`);
        }
        await scope.press("Escape");
        assert.ok(await focused(scope));
        assert.equal(await scope.getAttribute("aria-expanded"), "false");
        assert.ok(await editor.isVisible());
        if (width === 1080 && density === "comfortable") {
          await (await selectList(scope)).waitFor({ state: "hidden" });
          await scope.evaluate((el) => el.blur());
          await capture(`after-editor-${theme}`);
        }
        const text = editor.getByRole("textbox", { name: "Текст записи" });
        if (width === 780 && density === "compact") {
          await text.fill("а".repeat(2001));
          assert.equal((await text.inputValue()).length, 2000);
          assert.match(
            await editor.locator("#memory-text-length").innerText(),
            /2000\s*\/\s*2000/,
          );
        }
        await text.fill("Несохранённая правка");
        assert.match(
          await editor.locator("#memory-text-length").innerText(),
          /^20\s*\//,
        );
        await editor.getByRole("button", { name: "Отмена" }).click();
        await editor.waitFor({ state: "hidden" });
        assert.equal(
          (await page.evaluate(() => window.desktop.listMemory()))[0].text,
          initial,
        );
        const memory = await page
          .locator(".memory-entry")
          .first()
          .evaluate((el) => el.getBoundingClientRect().height);
        await button("Закрыть настройки").click();
        const sidebar = {
          project: await page
            .locator(".project-row")
            .first()
            .evaluate((el) => el.getBoundingClientRect().height),
          session: await page
            .locator(".session-row")
            .first()
            .evaluate((el) => el.getBoundingClientRect().height),
        };
        await openSettings();
        modes[density] = {
          ...layout,
          ...sidebar,
          memory,
          popupSide: bounds.side,
        };
      }
      for (const key of [
        "row",
        "nav",
        "control",
        "project",
        "session",
        "memory",
      ]) {
        assert.ok(
          modes.compact[key] < modes.comfortable[key],
          `${theme} ${width} ${key}`,
        );
      }
      assert.equal(modes.compact.font, modes.comfortable.font);
      geometry.push({ theme, width, height, ...modes });
    }
  }
  await app.close();
  await launch();
  await page
    .locator('html[data-density="compact"][data-theme="light"]')
    .waitFor();
  assert.equal(
    (await page.evaluate(() => window.desktop.bootstrap())).preferences
      .projectId,
    projects.at(-1).id,
  );
  assert.deepEqual(errors, []);
  await fs.writeFile(
    path.join(output, "verification.json"),
    JSON.stringify({ geometry, persisted: true, errors }, null, 2),
  );
  console.log(
    "PASS Select keyboard and focus, editor bounds and cancel, density geometry in 12 layouts, restart",
  );
} finally {
  await app?.close();
}
