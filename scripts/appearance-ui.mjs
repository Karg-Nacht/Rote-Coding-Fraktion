import { selectValue } from "./select-ui.mjs";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { _electron as electron } from "playwright";

await fs.mkdir(".runtime", { recursive: true });
const dataDir = await fs.mkdtemp(path.resolve(".runtime/appearance-ui-"));
const output = "test-results/appearance";
await fs.mkdir(output, { recursive: true });

const selects = [
  ["theme", "theme", "light"],
  ["scale", "uiScale", "125"],
  ["density", "density", "compact"],
  ["chat-font", "chatFontSize", "18"],
  ["code-font", "codeFontSize", "16"],
  ["sidebar-width", "sidebarWidth", "320"],
  ["sort", "chatSort", "title"],
];
const switches = [
  ["show-projects", "showProjects"],
  ["animations", "animations"],
];
const errors = [];
const results = [];

function launch() {
  return electron.launch({
    args: ["."],
    env: { ...process.env, RCF_DATA_DIR: dataDir },
  });
}

async function openAppearance(app) {
  const page = await app.firstWindow();
  page.on("pageerror", (error) => errors.push(error.message));
  await page.locator(".status-dot.ready").waitFor({ timeout: 45000 });
  await page.keyboard.press("Control+,");
  await page.getByRole("button", { name: "Внешний вид", exact: true }).click();
  await page.locator(".appearance-settings").waitFor();
  return page;
}

function control(page, id, role = "combobox") {
  return page.locator(`#setting-${id}`).getByRole(role);
}

async function checkPreferences(page) {
  const preferences = (await page.evaluate(() => window.desktop.bootstrap()))
    .preferences;
  for (const [id, key, value] of selects) {
    assert.equal(await control(page, id).getAttribute("data-value"), value, id);
    assert.equal(String(preferences[key]), value, key);
  }
  for (const [id, key] of switches) {
    assert.equal(
      await control(page, id, "switch").getAttribute("aria-checked"),
      "false",
      key,
    );
    assert.equal(preferences[key], false, key);
  }
  assert.deepEqual(
    await page.evaluate(() => {
      const root = document.documentElement;
      return [
        root.dataset.theme,
        root.dataset.density,
        root.dataset.motion,
        ...["--chat-font-size", "--code-font-size", "--sidebar-width"].map(
          (name) => root.style.getPropertyValue(name),
        ),
      ];
    }),
    ["light", "compact", "reduced", "18px", "16px", "320px"],
  );
}

async function checkLayout(app, page, theme, width, height, zoom, screenshot) {
  await app.evaluate(
    ({ BrowserWindow }, size) => {
      BrowserWindow.getAllWindows()[0].setSize(...size);
    },
    [width, height],
  );
  await page.waitForFunction(
    ({ theme, width, height, zoom }) =>
      document.documentElement.dataset.theme === theme &&
      Math.abs(innerWidth * zoom - width) < 2 &&
      Math.abs(innerHeight * zoom - height) < 2,
    { theme, width, height, zoom },
  );
  const geometry = await page
    .locator(".appearance-settings")
    .evaluate((grid) => {
      const scroll = grid.closest(".settings-content");
      scroll.scrollTop = 0;
      const rows = [...grid.querySelectorAll(".setting-row")];
      const controlHeight = parseFloat(
        getComputedStyle(grid).getPropertyValue("--density-control-height"),
      );
      return {
        columns: getComputedStyle(grid).gridTemplateColumns.split(" ").length,
        contentWidth: grid.clientWidth,
        documentOverflow: document.documentElement.scrollWidth > innerWidth,
        overflow: scroll.scrollWidth > scroll.clientWidth,
        clippedControls: rows
          .filter((row) => {
            const hit = row
              .querySelector("button")
              .getBoundingClientRect();
            const bounds = row.getBoundingClientRect();
            return (
              hit.height < controlHeight - 0.1 ||
              hit.left < bounds.left ||
              hit.right > bounds.right + 0.1
            );
          })
          .map((row) => row.id),
      };
    });
  const result = { theme, width, height, zoom, ...geometry };
  assert.equal(geometry.columns, zoom === 1 && width >= 1080 ? 2 : 1);
  assert.ok(geometry.contentWidth <= 812);
  assert.equal(geometry.documentOverflow, false);
  assert.equal(geometry.overflow, false);
  assert.deepEqual(geometry.clippedControls, []);
  results.push(result);
  if (screenshot) {
    await page.mouse.move(1, 55);
    await page.evaluate(async () => {
      document.activeElement?.blur();
      await new Promise((resolve) => requestAnimationFrame(resolve));
      await Promise.allSettled(
        document
          .getAnimations()
          .filter((animation) => animation instanceof CSSTransition)
          .map((animation) => animation.finished),
      );
    });
    const png = await app.evaluate(async ({ BrowserWindow }) =>
      (await BrowserWindow.getAllWindows()[0].capturePage())
        .toPNG()
        .toString("base64"),
    );
    await fs.writeFile(
      `${output}/${theme}-${width}.png`,
      Buffer.from(png, "base64"),
    );
  }
}

let app = await launch();
try {
  let page = await openAppearance(app);
  assert.equal(
    await page.locator(".appearance-settings .setting-row").count(),
    9,
  );
  const search = page.getByRole("textbox", { name: "Поиск по параметрам" });
  await search.fill("шрифт");
  await page.getByRole("button", { name: /Размер шрифта чата/ }).click();
  assert.equal(
    await page.evaluate(() => document.activeElement.id),
    "setting-chat-font",
  );
  await page.keyboard.press("Tab");
  assert.equal(
    await control(page, "chat-font").evaluate(
      (el) => el === document.activeElement,
    ),
    true,
  );

  for (const theme of ["dark", "light"]) {
    await selectValue(control(page, "theme"), theme);
    for (const width of [1440, 1080, 780]) {
      await checkLayout(app, page, theme, width, 800, 1, true);
    }
    await checkLayout(app, page, theme, 780, 600, 1, false);
  }

  for (const [id, , value] of selects) {
    await selectValue(control(page, id), value);
  }
  await control(page, "show-projects", "switch").click();
  await control(page, "animations", "switch").press("Space");
  await checkPreferences(page);
  await checkLayout(app, page, "light", 780, 600, 1.25, false);
  await selectValue(control(page, "scale"), "200");
  await checkLayout(app, page, "light", 780, 600, 2, false);
  await selectValue(control(page, "scale"), "125");

  await app.close();
  app = await launch();
  page = await openAppearance(app);
  await checkPreferences(page);
  assert.equal(
    await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0].webContents.getZoomFactor(),
    ),
    1.25,
  );
  assert.deepEqual(errors, []);
  console.log(
    JSON.stringify({ layouts: results, persisted: 9, errors }, null, 2),
  );
} finally {
  await app.close();
}
