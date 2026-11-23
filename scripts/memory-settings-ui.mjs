import { selectValue } from "./select-ui.mjs";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { _electron as electron } from "playwright";

await fs.mkdir(".runtime", { recursive: true });
const dataDir = await fs.mkdtemp(path.resolve(".runtime/memory-settings-ui-"));
const output = path.resolve("test-results/memory-settings");
const projectDir = path.join(dataDir, "Документация RCF");
await fs.mkdir(projectDir, { recursive: true });
await fs.mkdir(output, { recursive: true });

const longTitle = "Правила подготовки релиза";
const searchTerm = "контрольная сверка";
const paragraphs = [
  "Собираем изменения за релиз по пользовательским сценариям. Для каждого сценария указываем заметный результат и пример, который можно воспроизвести на чистом профиле.",
  "Перед публикацией проверяем запуск приложения, настройки, работу с проектом и восстановление последнего сеанса. Результаты smoke-проверок сохраняем рядом с отчётом.",
  "Результаты проверки в светлой и тёмной темах прикладываем к отчёту. Для узкого окна отдельно смотрим, помещаются ли подписи и остаются ли доступны действия с клавиатуры.",
  "Для изменений в хранилище используем отдельный тестовый профиль. Сверяем содержимое до и после перезапуска и проверяем, как отображаются данные предыдущих версий.",
  "Следующий шаг — сверить текст заметок с фактическими изменениями. У каждого описанного сценария должен быть результат проверки или записанная причина, почему его проверить не удалось.",
  "Команды для воспроизведения и пути к снимкам добавляем в отчёт. Формулировки о поведении приложения сверяем с результатами, полученными на production-сборке.",
  "К отчёту прикладываем только тестовые данные. Для демонстрации переносов в середине длинной записи оставляем идентификатор:",
  "идентификатор".repeat(19),
];
const longText = [
  "# " + longTitle,
  ...paragraphs,
  "Последний этап — контрольная сверка.",
].join("\n\n");
const editedText = longText.replace("Последний этап", "После перезапуска");
const projectText =
  "Шаблон отчёта проекта\n\nВ приложении к отчёту — контрольная сверка и результаты сборки.";
const deletedText = "Временная заметка для удаления";
const cards = [
  [
    "Проверка клавиатурной навигации",
    "Проверяем Tab, Shift+Tab, Enter и Escape в диалогах. После закрытия фокус возвращается к исходному действию.",
  ],
  [
    "Формат технических заметок",
    "Сначала пишем короткий заголовок, затем фиксируем решение, причины и пример использования. Пути указываем относительно корня проекта.",
  ],
  [
    "Каталог общих компонентов",
    "Используем существующие поля, кнопки и диалоги настроек. Новые варианты добавляем, когда они нужны нескольким связанным сценариям.",
  ],
  [
    "Правила регрессионного тестирования",
    "Для каждого сценария создаём отдельный профиль и локальные тестовые данные. Записываем размеры окна и активную тему.",
  ],
  [
    "Работа с документацией",
    "Пишем инструкции в порядке выполнения. Примеры должны запускаться с чистого рабочего места и использовать тестовые файлы.",
  ],
  [
    "Именование задач",
    "Название задачи описывает результат, который можно проверить. В комментариях фиксируем решения, влияющие на следующие изменения.",
  ],
];
const errors = [];
const geometry = [];
let app;

async function launch() {
  app = await electron.launch({
    args: ["."],
    env: { ...process.env, RCF_DATA_DIR: dataDir },
  });
  const page = await app.firstWindow();
  page.on("pageerror", (error) => errors.push(error.message));
  await page.locator(".status-dot.ready").waitFor({ timeout: 45000 });
  return page;
}

async function openMemory(page) {
  await page
    .getByRole("button", { name: "Память и персонализация", exact: true })
    .click();
  await page.locator("#setting-memory-records [aria-busy=false]").waitFor();
}

async function resize(page, width, height) {
  await app.evaluate(
    ({ BrowserWindow }, size) =>
      BrowserWindow.getAllWindows()[0].setContentSize(...size),
    [width, height],
  );
  await page.waitForFunction(
    ([width, height]) => innerWidth === width && innerHeight === height,
    [width, height],
  );
}

async function capture(page, name) {
  await page.mouse.move(4, 28);
  await page.evaluate(
    () =>
      new Promise((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(resolve));
      }),
  );
  const image = await app.evaluate(async ({ BrowserWindow }) => {
    const png = await BrowserWindow.getAllWindows()[0].capturePage();
    return png.toPNG().toString("base64");
  });
  await fs.writeFile(
    path.join(output, name + ".png"),
    Buffer.from(image, "base64"),
  );
}

async function focusOn(locator) {
  await locator.and(locator.page().locator(":focus")).waitFor();
}

function entry(page, title) {
  return page.getByRole("button", {
    name: `Открыть запись «${title}»`,
    exact: true,
  });
}

async function add(page, text) {
  await page
    .getByRole("button", { name: "Добавить запись", exact: true })
    .click();
  const dialog = page.getByRole("dialog", { name: "Новая запись" });
  await dialog.getByRole("textbox", { name: "Текст записи" }).fill(text);
  await dialog.getByRole("button", { name: "Сохранить запись" }).click();
  await dialog.waitFor({ state: "hidden" });
  await page.getByText("Запись памяти сохранена", { exact: true }).waitFor();
}

function memory(page) {
  return page.evaluate(() => window.desktop.listMemory());
}

async function checkListGeometry(page, theme, width, height) {
  const measured = await page.locator(".memory-settings").evaluate((root) => {
    const scroll = root.closest(".settings-content");
    const filters = [...root.querySelectorAll(".memory-filters .field")].map(
      (element) => element.getBoundingClientRect(),
    );
    const cards = [...root.querySelectorAll(".memory-entry")].map((card) => {
      const rect = card.getBoundingClientRect();
      const hit = card
        .querySelector(".memory-entry-open")
        .getBoundingClientRect();
      const actions = card
        .querySelector(".memory-entry-actions")
        .getBoundingClientRect();
      return {
        height: rect.height,
        fullyVisible: rect.bottom <= scroll.getBoundingClientRect().bottom,
        overlap: hit.right > actions.left,
        outside: actions.right > rect.right,
      };
    });
    return {
      viewport: [innerWidth, innerHeight],
      theme: document.documentElement.dataset.theme,
      overflow:
        scroll.scrollWidth > scroll.clientWidth ||
        root.scrollWidth > root.clientWidth ||
        document.documentElement.scrollWidth > innerWidth,
      filterOverlap:
        filters[0].bottom > filters[1].top &&
        filters[0].right > filters[1].left,
      cards,
    };
  });
  assert.deepEqual(measured.viewport, [width, height]);
  assert.equal(measured.theme, theme);
  assert.equal(measured.overflow, false);
  assert.equal(measured.filterOverlap, false);
  assert.equal(measured.cards.length, cards.length + 1);
  assert.ok(
    measured.cards.every(
      ({ height, overlap, outside }) => height <= 88 && !overlap && !outside,
    ),
  );
  const fullyVisibleCards = measured.cards.filter(
    (card) => card.fullyVisible,
  ).length;
  assert.ok(fullyVisibleCards >= (height === 600 ? 3 : 4));
  geometry.push({
    theme,
    width,
    height,
    maximumCardHeight: Math.max(...measured.cards.map((card) => card.height)),
    fullyVisibleCards,
    overflow: false,
    overlap: false,
  });
}

try {
  let page = await launch();
  await app.evaluate(({ dialog }, folder) => {
    dialog.showOpenDialog = async () => ({
      canceled: false,
      filePaths: [folder],
    });
  }, projectDir);
  await page
    .getByRole("button", { name: "Добавить проект", exact: true })
    .first()
    .click();
  const project = (
    await page.evaluate(() => window.desktop.bootstrap())
  ).projects.find((project) => project.name === "Документация RCF");
  assert.ok(project);
  await page.keyboard.press("Control+,");
  await openMemory(page);
  await page.getByText("Пока нет записей", { exact: true }).waitFor();

  const toggle = page.getByRole("switch", {
    name: "Использовать долговременную память",
  });
  assert.equal(await toggle.getAttribute("aria-checked"), "false");
  await toggle.focus();
  await page.keyboard.press("Space");
  assert.equal(await toggle.getAttribute("aria-checked"), "true");
  const help = page.locator("#setting-memory-help");
  assert.equal(await help.getAttribute("open"), null);
  await page.getByText("Как работает память", { exact: true }).focus();
  await page.keyboard.press("Enter");
  await help
    .getByText(/документы, ответы моделей и содержимое репозиториев/)
    .waitFor();
  await page.keyboard.press("Enter");
  assert.equal(await help.getAttribute("open"), null);

  await page.evaluate(async (entries) => {
    for (const [title, body] of entries) {
      await window.desktop.saveMemory({
        scope: "global",
        text: [title, ...Array(4).fill(body)].join("\n\n"),
      });
    }
  }, cards);
  await page
    .getByRole("button", { name: "Обновить память", exact: true })
    .click();
  await entry(page, cards[0][0]).waitFor();
  await add(page, longText);
  await add(page, deletedText);
  assert.equal(
    (await memory(page)).find((item) => item.text === longText)?.scope,
    "global",
  );

  const scope = page.getByRole("combobox", {
    name: "Область памяти",
    exact: true,
  });
  const search = page.getByRole("textbox", { name: "Поиск записей памяти" });
  await search.fill("  КОНТРОЛЬНАЯ СВЕРКА  ");
  assert.equal(await page.locator(".memory-count").innerText(), "1 из 8");
  assert.match(
    await page.locator(".memory-entry-preview").innerText(),
    /контрольная сверка/,
  );
  await selectValue(scope, project.id);
  await page.getByText("Записи не найдены", { exact: true }).waitFor();
  assert.equal(await search.inputValue(), "  КОНТРОЛЬНАЯ СВЕРКА  ");
  await search.focus();
  await page.keyboard.press("Escape");
  await page.getByText("Пока нет записей", { exact: true }).waitFor();
  await focusOn(search);
  await add(page, projectText);
  await search.fill(searchTerm);
  assert.equal(await page.locator(".memory-count").innerText(), "1 из 1");
  const projectEntry = entry(page, "Шаблон отчёта проекта");
  await projectEntry.waitFor();
  assert.ok(
    await projectEntry.getByText("Память проекта", { exact: true }).isVisible(),
  );
  await selectValue(scope, "global");
  assert.ok(await entry(page, longTitle).isVisible());
  assert.equal(await search.inputValue(), searchTerm);

  await resize(page, 780, 600);
  await toggle.click();
  assert.equal(await toggle.getAttribute("aria-checked"), "false");
  const open = entry(page, longTitle);
  await open.focus();
  await page.keyboard.press("Enter");
  const reader = page.getByRole("dialog", { name: longTitle, exact: true });
  const fullText = reader.getByRole("region", { name: "Текст записи" });
  assert.equal(await fullText.textContent(), longText);
  assert.ok(await reader.locator("time[datetime]").isVisible());
  await focusOn(fullText);
  await page.keyboard.press("PageDown");
  await page.waitForFunction(
    () => document.querySelector(".memory-panel-body").scrollTop > 0,
  );
  await page.keyboard.press("Escape");
  await reader.waitFor({ state: "hidden" });
  await focusOn(open);

  await open.press("Enter");
  await page.keyboard.press("Tab");
  const edit = reader.getByRole("button", {
    name: "Редактировать запись",
    exact: true,
  });
  await focusOn(edit);
  await page.keyboard.press("Enter");
  const editor = page.getByRole("dialog", {
    name: "Редактировать запись",
    exact: true,
  });
  const textBox = editor.getByRole("textbox", { name: "Текст записи" });
  await focusOn(textBox);
  assert.equal(await textBox.inputValue(), longText);
  await textBox.fill(editedText);
  await page.keyboard.press("Tab");
  await focusOn(editor.getByRole("button", { name: "Отмена", exact: true }));
  await page.keyboard.press("Tab");
  await focusOn(
    editor.getByRole("button", { name: "Сохранить запись", exact: true }),
  );
  await page.keyboard.press("Tab");
  await focusOn(editor.getByRole("button", { name: "Закрыть", exact: true }));
  await page.keyboard.press("Shift+Tab");
  await page.keyboard.press("Enter");
  await editor.waitFor({ state: "hidden" });
  await focusOn(open);
  assert.ok((await memory(page)).some(({ text }) => text === editedText));

  await page.getByRole("button", { name: "Очистить поиск записей" }).click();
  const remove = page
    .locator(".memory-entry")
    .filter({ has: entry(page, deletedText) })
    .getByRole("button", { name: "Удалить запись памяти", exact: true });
  const actions = remove.locator("..");
  await search.focus();
  await page.mouse.move(4, 28);
  assert.equal(await actions.evaluate((el) => getComputedStyle(el).opacity), "0");
  await entry(page, deletedText).hover();
  assert.equal(await actions.evaluate((el) => getComputedStyle(el).opacity), "1");
  await page.mouse.move(4, 28);
  await entry(page, deletedText).focus();
  await page.keyboard.press("Tab");
  await focusOn(
    actions.getByRole("button", { name: "Редактировать запись памяти" }),
  );
  await page.keyboard.press("Tab");
  await focusOn(remove);
  assert.equal(await actions.evaluate((el) => getComputedStyle(el).opacity), "1");
  await page.keyboard.press("Enter");
  const confirmation = page.getByRole("dialog", {
    name: "Удалить запись памяти?",
    exact: true,
  });
  await focusOn(
    confirmation.getByRole("button", { name: "Отмена", exact: true }),
  );
  assert.ok((await memory(page)).some(({ text }) => text === deletedText));
  await page.keyboard.press("Escape");
  await focusOn(remove);
  await remove.press("Enter");
  await page.keyboard.press("Tab");
  await focusOn(
    confirmation.getByRole("button", { name: "Удалить", exact: true }),
  );
  await page.keyboard.press("Enter");
  await confirmation.waitFor({ state: "hidden" });
  await focusOn(search);
  assert.ok(!(await memory(page)).some(({ text }) => text === deletedText));

  await toggle.click();
  assert.equal(await toggle.getAttribute("aria-checked"), "true");
  await app.close();
  app = undefined;
  page = await launch();
  await page.keyboard.press("Control+,");
  await openMemory(page);
  assert.equal(
    await page
      .getByRole("switch", { name: "Использовать долговременную память" })
      .getAttribute("aria-checked"),
    "true",
  );
  const persisted = await memory(page);
  assert.equal(persisted.length, cards.length + 2);
  assert.ok(
    persisted.some(
      (item) => item.scope === "global" && item.text === editedText,
    ),
  );
  assert.ok(
    persisted.some(
      (item) => item.projectId === project.id && item.text === projectText,
    ),
  );

  for (const theme of ["dark", "light"]) {
    await page
      .getByRole("button", { name: "Внешний вид", exact: true })
      .click();
    await selectValue(page.locator("#setting-theme .custom-select"), theme);
    await openMemory(page);
    for (const [width, height] of [
      [1440, 960],
      [1080, 720],
      [780, 600],
    ]) {
      await resize(page, width, height);
      await checkListGeometry(page, theme, width, height);
      await capture(page, `memory-${theme}-${width}`);
    }
    await entry(page, longTitle).click();
    const drawer = page.getByRole("dialog", { name: longTitle, exact: true });
    assert.deepEqual(
      await drawer.evaluate((dialog) => {
        const rect = dialog.getBoundingClientRect();
        const body = dialog.querySelector(".memory-panel-body");
        return {
          right: rect.right,
          overflow: body.scrollWidth > body.clientWidth,
          scrollTop: body.scrollTop,
        };
      }),
      { right: 780, overflow: false, scrollTop: 0 },
    );
    assert.equal(await drawer.getByRole("region").textContent(), editedText);
    await capture(page, `memory-${theme}-reader-780`);
    await page.keyboard.press("Escape");
  }

  const additionalEntries = 24;
  await page.evaluate(
    async ({ count, body }) => {
      for (let index = 0; index < count; index++) {
        await window.desktop.saveMemory({
          scope: "global",
          text: [
            `Тестовая заметка ${index + 1}`,
            ...body,
            `Метка проверки ${index + 1}.`,
          ].join("\n\n"),
        });
      }
    },
    { count: additionalEntries, body: paragraphs.slice(0, 3) },
  );
  await page
    .getByRole("button", { name: "Обновить память", exact: true })
    .click();
  await entry(page, "Тестовая заметка 24").waitFor();
  const denseListCount = cards.length + 1 + additionalEntries;
  assert.equal(await page.locator(".memory-entry").count(), denseListCount);
  await page
    .getByRole("textbox", { name: "Поиск записей памяти" })
    .fill("метка проверки 24");
  assert.equal(
    await page.locator(".memory-count").innerText(),
    `1 из ${denseListCount}`,
  );
  assert.match(
    await page.locator(".memory-entry-preview").innerText(),
    /метка проверки 24/i,
  );

  await selectValue(page.getByRole("combobox", { name: "Область памяти", exact: true }), project.id);
  await page.getByRole("button", { name: "Очистить поиск записей" }).click();
  const clearProject = page.getByRole("button", { name: "Удалить записи (1)" });
  await clearProject.press("Enter");
  const clearDialog = page.getByRole("dialog", { name: "Очистить память?" });
  await clearDialog.getByRole("button", { name: "Отмена" }).press("Enter");
  await clearDialog.waitFor({ state: "hidden" });
  assert.equal((await memory(page)).length, denseListCount + 1);
  await clearProject.press("Enter");
  await clearDialog.getByRole("button", { name: "Удалить", exact: true }).click();
  await clearDialog.waitFor({ state: "hidden" });
  const remaining = await memory(page);
  assert.equal(remaining.length, denseListCount);
  assert.ok(remaining.every((item) => item.scope === "global"));

  assert.deepEqual(errors, []);
  await fs.writeFile(
    path.join(output, "verification.json"),
    JSON.stringify(
      {
        runtime: "Electron production build",
        isolatedProfile: dataDir,
        keyboardNavigation: true,
        preferencesAndCrudAfterRestart: true,
        retainedSearchAcrossScopes: true,
        clearAffectsOnlySelectedScope: true,
        denseListCount,
        notes:
          "Synthetic fixture entries only. Sizes are Electron content dimensions in CSS pixels.",
        geometry,
        errors,
      },
      null,
      2,
    ),
  );
  console.log(
    "PASS memory controls, scoped search, CRUD, restart, keyboard, both themes and all three window sizes",
  );
} finally {
  await app?.close();
}
