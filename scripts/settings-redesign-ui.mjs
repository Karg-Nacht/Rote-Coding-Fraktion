import { selectValue } from "./select-ui.mjs";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { _electron as electron } from "playwright";

const output = path.resolve("test-results/settings-redesign");
await fs.mkdir(output, { recursive: true });
await fs.mkdir(".runtime", { recursive: true });
const profile = await fs.mkdtemp(path.resolve(".runtime/settings-redesign-"));
const sections = [
  ["general", "Основные"],
  ["appearance", "Внешний вид"],
  ["shortcuts", "Горячие клавиши"],
  ["connections", "Модели и подключения"],
  ["permissions", "Агенты и разрешения"],
  ["memory", "Память и персонализация"],
  ["history", "История и хранение"],
  ["about", "О приложении"],
];
const sizes = [
  [1440, 960],
  [1080, 720],
  [780, 600],
];
const measurements = [];
const pictures = [];
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
  await page.locator(".status-dot.ready").waitFor({ timeout: 45000 });
}
function nav(title) {
  return page
    .locator(".settings-category-list")
    .getByRole("button", { name: title, exact: true });
}
async function resize(width, height, zoom = 1) {
  await app.evaluate(
    ({ BrowserWindow }, { width, height, zoom }) => {
      const window = BrowserWindow.getAllWindows()[0];
      window.setContentSize(width, height);
      window.webContents.setZoomFactor(zoom);
    },
    { width, height, zoom },
  );
  await page.waitForFunction(
    ({ width, height, zoom }) =>
      Math.abs(innerWidth * zoom - width) < 2 &&
      Math.abs(innerHeight * zoom - height) < 2,
    { width, height, zoom },
  );
}
async function capture(file) {
  await page.mouse.move(1, 18);
  await page.evaluate(async () => {
    await Promise.allSettled(
      [...document.querySelectorAll(".settings-screen img")].map((image) =>
        image.decode(),
      ),
    );
    await new Promise((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(resolve)),
    );
    await Promise.allSettled(
      document.getAnimations()
        .filter((animation) => animation instanceof CSSTransition)
        .map((animation) => animation.finished),
    );
  });
  const png = await app.evaluate(async ({ BrowserWindow }) =>
    (await BrowserWindow.getAllWindows()[0].capturePage())
      .toPNG()
      .toString("base64"),
  );
  await fs.writeFile(path.join(output, file), Buffer.from(png, "base64"));
}

try {
  await launch();
  const folders = [
    "Документация RCF",
    "Интерфейс рабочего пространства",
    "Примеры проектов",
    "Локальные проверки",
    "Сценарии Electron",
    "Исследования",
    "Тесты провайдеров",
    "Справочные материалы",
    "Архив решений",
  ];
  const paths = folders.map((folder) => path.join(profile, folder));
  await Promise.all(paths.map((folder) => fs.mkdir(folder)));
  await app.evaluate(({ dialog }, folders) => {
    dialog.showOpenDialog = async () => ({
      canceled: false,
      filePaths: [folders.shift()],
    });
  }, paths);
  for (const folder of folders)
    await page.evaluate(() => window.desktop.addProject());

  await page.evaluate(async () => {
    for (const text of [
      "Правила подготовки релиза\n\nПроверить рабочие сценарии в светлой и тёмной темах. Приложить результаты проверки к заметкам о выпуске.",
      "Проверка клавиатурной навигации\n\nОбойти элементы управления с Tab. Проверить возврат фокуса после закрытия диалога.",
      "Оформление документации\n\nЗаписывать решения рядом с инструкциями и использовать относительные пути в примерах.",
      "Профили для тестов\n\nСоздавать отдельный профиль Electron для проверок сохранения и перезапуска.",
    ])
      await window.desktop.saveMemory({ scope: "global", text });
  });
  await page.reload();
  await page.locator(".status-dot.ready").waitFor();
  await page.keyboard.press("Control+,");
  const search = page.getByRole("textbox", { name: "Поиск по параметрам" });
  assert.ok(await search.evaluate((node) => node === document.activeElement));
  assert.deepEqual(
    await page.locator(".settings-nav-group h2").allTextContents(),
    ["Приложение", "ИИ и агенты", "Данные и хранение", "Система"],
  );
  assert.deepEqual(
    await page.locator(".settings-nav-group button").allTextContents(),
    sections.map(([, title]) => title),
  );
  await search.fill("шрифт");
  await search.press("ArrowDown");
  assert.match(
    await page.evaluate(() => document.activeElement.textContent),
    /Размер шрифта чата/,
  );
  await page.keyboard.press("Enter");
  assert.equal(
    await page.evaluate(() => document.activeElement.id),
    "setting-chat-font",
  );
  await page.keyboard.press("Tab");
  assert.equal(
    await page.evaluate(() =>
      document.activeElement.getAttribute("aria-labelledby"),
    ),
    "label-chat-font",
  );
  await page.keyboard.press("Enter");
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Enter");
  const newFont = await page.locator("#setting-chat-font .custom-select").getAttribute("data-value");
  assert.notEqual(newFont, "14");
  await search.fill("несуществующий параметр");
  await page.getByText("Параметры не найдены", { exact: true }).waitFor();
  await page.keyboard.press("Escape");
  assert.equal(await search.inputValue(), "");
  await nav("Основные").press("Enter");
  assert.equal(await nav("Основные").getAttribute("aria-current"), "page");

  await resize(780, 600, 1.5);
  const left = page.locator(".settings-category-list");
  const right = page.locator(".settings-content");
  await left.hover();
  await page.mouse.wheel(0, 240);
  await page.waitForFunction(
    () => document.querySelector(".settings-category-list").scrollTop > 0,
  );
  assert.equal(await right.evaluate((node) => node.scrollTop), 0);
  const navTop = await left.evaluate((node) => node.scrollTop);
  await right.hover();
  await page.mouse.wheel(0, 240);
  await page.waitForFunction(
    () => document.querySelector(".settings-content").scrollTop > 0,
  );
  assert.equal(await left.evaluate((node) => node.scrollTop), navTop);
  await resize(1440, 960);

  for (const theme of ["dark", "light"]) {
    await nav("Внешний вид").click();
    await selectValue(page.locator("#setting-theme .custom-select"), theme);
    await page.waitForFunction(
      (theme) => document.documentElement.dataset.theme === theme,
      theme,
    );
    for (const [width, height] of sizes) {
      await resize(width, height);
      for (const [key, title] of sections) {
        await nav(title).click();
        const heading = page.locator(".settings-page-heading");
        assert.equal(await heading.locator("h2").innerText(), title);
        assert.ok((await heading.locator("p").innerText()).length > 8);
        assert.equal(await nav(title).getAttribute("aria-current"), "page");
        if (key === "memory")
          await page.locator(".memory-entry").first().waitFor();
        const geometry = await page
          .locator(".settings-screen")
          .evaluate((screen) => {
            const content = screen.querySelector(".settings-content");
            const nav = screen.querySelector(".settings-category-list");
            const bounds = content.getBoundingClientRect();
            const clippedControls = [
              ...content.querySelectorAll("button, select, input, textarea"),
            ]
              .filter((control) => {
                const rect = control.getBoundingClientRect();
                return (
                  rect.width &&
                  (rect.left < bounds.left - 1 || rect.right > bounds.right + 1)
                );
              })
              .map((control) => control.outerHTML.slice(0, 100));
            return {
              overflow: [content, nav, screen].some(
                (pane) => pane.scrollWidth > pane.clientWidth + 1,
              ),
              clippedControls,
              twoColumns:
                getComputedStyle(screen).gridTemplateColumns.split(" ")
                  .length === 2,
              viewport: [innerWidth, innerHeight],
            };
          });
        assert.deepEqual(
          geometry,
          {
            overflow: false,
            clippedControls: [],
            twoColumns: true,
            viewport: [width, height],
          },
          `${theme} ${width} ${title}`,
        );
        measurements.push({ key, theme, width, height, ...geometry });
        const file = `${key}-${theme}-${width}.png`;
        pictures.push({ key, theme, width, height, file });
        await capture(file);
      }
    }
  }

  await page
    .getByRole("button", { name: "Закрыть настройки", exact: true })
    .click();
  await page.locator(".settings-screen").waitFor({ state: "hidden" });
  await page.keyboard.press("Control+,");
  await page.keyboard.press("Escape");
  await page.locator(".settings-screen").waitFor({ state: "hidden" });
  await app.close();
  app = undefined;
  await launch();
  await page.keyboard.press("Control+,");
  await nav("Внешний вид").click();
  assert.equal(
    await page.locator("#setting-theme .custom-select").getAttribute("data-value"),
    "light",
  );
  assert.equal(
    await page.locator("#setting-chat-font .custom-select").getAttribute("data-value"),
    newFont,
  );
  assert.deepEqual(errors, []);
  await fs.writeFile(
    path.join(output, "verification.json"),
    JSON.stringify(
      {
        profile,
        measurements,
        independentScroll: true,
        searchKeyboard: true,
        closeAndRestart: true,
        errors,
      },
      null,
      2,
    ),
  );
  const gallery = sections
    .map(
      ([key, title]) =>
        `<section><h2>${title}</h2><div>${pictures
          .filter((picture) => picture.key === key)
          .map(
            ({ theme, width, height, file }) =>
              `<a href="${file}"><img loading="lazy" src="${file}" alt="${title}, ${theme}, ${width}×${height}"><span>${theme === "dark" ? "Тёмная" : "Светлая"} · ${width}×${height}</span></a>`,
          )
          .join("")}</div></section>`,
    )
    .join("");
  await fs.writeFile(
    path.join(output, "index.html"),
    `<!doctype html><html lang="ru"><meta charset="utf-8"><title>Настройки RCF в Electron</title><style>body{margin:28px auto;padding:0 18px;max-width:1240px;background:#201b1c;color:#f2e9e8;font:15px system-ui}section>div{display:grid;gap:12px;grid-template-columns:repeat(auto-fit,minmax(260px,1fr))}a{color:inherit;text-decoration:none;display:grid;gap:6px}img{width:100%;border-radius:6px}section{margin-bottom:32px}</style><h1>Настройки RCF в Electron</h1>${gallery}</html>`,
  );
  console.log(
    `PASS ${pictures.length} Electron captures, independent scrolling, navigation, search, themes and persistence`,
  );
} finally {
  await app?.close();
}
