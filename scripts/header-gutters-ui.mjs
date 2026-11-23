import { _electron as electron } from "playwright";
import { Service } from "@opencode/client/service";
import { OpenCode } from "@opencode/client";
import fs from "node:fs/promises";
import path from "node:path";
import assert from "node:assert/strict";

const directory = path.resolve(`.runtime/header-gutters-${process.pid}`);
const folder = path.join(directory, "RCF Demo");
await fs.mkdir(folder, { recursive: true });
const packaged = process.env.RCF_PACKAGED;
const suffix = packaged ? "-packaged" : "";
let app, page;
const errors = [],
  checks = [];
try {
  app = await electron.launch({
    args: packaged ? [] : ["."],
    executablePath: packaged,
    env: { ...process.env, FORGE_DATA_DIR: directory },
    timeout: 30000,
  });
  page = await app.firstWindow();
  page.on("pageerror", (error) => errors.push(error.message));
  await page.waitForSelector(".status-dot.ready", { timeout: 40000 });
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
  const info = await client.session.create({
    location: { directory: folder },
    title: "Архитектура и запуск проекта",
  });
  await client.session.remove({ sessionID: info.id });
  const model = { id: "demo-model", providerID: "qa" };
  const message = (index, value) => ({
    id: `msg_${(0x10000000000 + index).toString(16)}qa${String(index).padStart(10, "0")}`,
    time: {
      created: info.time.created + index * 1000,
      ...(value.type === "assistant"
        ? { completed: info.time.created + index * 1000 + 500 }
        : {}),
    },
    ...value,
  });
  await client.experimental.session.import({
    info,
    location: { directory: folder },
    messages: [
      message(1, { type: "model-switched", model }),
      message(2, {
        type: "user",
        text: "Изучи структуру проекта, опиши архитектуру и команды запуска. Пока не изменяй файлы.",
      }),
      message(3, {
        type: "assistant",
        agent: "build",
        model,
        content: [
          {
            type: "text",
            text:
              "Посмотрю структуру проекта, точки входа и команды запуска.\n\n### Архитектура\n\nПриложение разделено на интерфейс и локальный движок. Состояние чата сохраняется между запусками, а операции с проектом выполняются в выбранной рабочей папке.\n\n```typescript\nconst workspace = { directory: project.path, session: currentSession.id };\nawait engine.connect(workspace);\n```\n\n| Раздел | Назначение |\n| --- | --- |\n| Интерфейс | Переписка, проекты и настройки |\n| Движок | Выполнение задач и работа с файлами |\n\nСначала проверю конфигурацию, затем подготовлю краткие инструкции по запуску.\n\n" +
              "Дополнительный контекст проекта остаётся в центральной колонке. ".repeat(
                12,
              ),
          },
        ],
      }),
      message(4, { type: "idle", outcome: "succeeded" }),
    ],
  });
  await page.evaluate(
    async ({ projectId, sessionId }) =>
      window.desktop.savePreferences({
        projectId,
        sessionId,
        language: "ru",
        animations: true,
      }),
    { projectId: project.id, sessionId: info.id },
  );
  await page.reload();
  await page.locator(".timeline-column").waitFor();
  const size = async (width, height = 900) => {
    await app.evaluate(
      ({ BrowserWindow }, [w, h]) =>
        BrowserWindow.getAllWindows()[0].setSize(w, h),
      [width, height],
    );
    await page.waitForTimeout(200);
  };
  const geometry = async (label) => {
    const result = await page.evaluate(() => {
      const box = (selector) => {
        const r = document.querySelector(selector).getBoundingClientRect();
        return {
          left: r.left,
          right: r.right,
          top: r.top,
          bottom: r.bottom,
          width: r.width,
        };
      };
      const left = box(".chat-gutter-left"),
        right = box(".chat-gutter-right"),
        column = box(".timeline-column"),
        composer = box(".composer-area");
      const title = box(".workspace-title"),
        actions = box(".rcf-task-actions"),
        more = box(".header-actions");
      return {
        left,
        right,
        column,
        composer,
        title,
        actions,
        more,
        overflow: document.documentElement.scrollWidth > innerWidth,
        pointer: getComputedStyle(document.querySelector(".chat-gutter"))
          .pointerEvents,
        hiddenPath: getComputedStyle(document.querySelector(".rcf-directory"))
          .display,
      };
    });
    assert.equal(result.overflow, false, label);
    assert.ok(
      result.left.right <= result.column.left - 15 || result.left.width === 0,
      label,
    );
    assert.ok(
      result.right.left >= result.column.right + 15 || result.right.width === 0,
      label,
    );
    assert.ok(
      result.left.right <= result.composer.left - 15 || result.left.width === 0,
      label,
    );
    assert.ok(
      result.right.left >= result.composer.right + 15 ||
        result.right.width === 0,
      label,
    );
    assert.ok(result.title.right <= result.actions.left + 1, label);
    assert.ok(result.actions.right <= result.more.left + 1, label);
    assert.equal(result.hiddenPath, "none");
    assert.equal(result.pointer, "none");
    checks.push({ label, ...result });
    return result;
  };
  for (const theme of ["dark", "light"]) {
    await page.evaluate(
      (theme) => window.desktop.savePreferences({ theme }),
      theme,
    );
    await page.waitForFunction(
      (theme) => document.documentElement.dataset.theme === theme,
      theme,
    );
    for (const width of [1920, 1440, 1080, 780]) {
      await size(width, width === 780 ? 650 : 900);
      const result = await geometry(`${theme}/${width}`);
      if (width >= 1440) assert.ok(result.left.width > 0);
      if (width <= 1080) assert.equal(result.left.width, 0);
      await page
        .locator(".timeline-scroll")
        .evaluate((el) => (el.scrollTop = 0));
      await page.screenshot({
        path: `test-results/header-gutters${suffix}-${theme}-${width}.png`,
      });
    }
    await size(1440);
    await page.locator(".rcf-location").click();
    await page
      .getByRole("dialog", { name: "Рабочая папка", exact: true })
      .waitFor();
    await page
      .getByRole("button", { name: "Копировать путь", exact: true })
      .click();
    assert.equal(
      await app.evaluate(({ clipboard }) => clipboard.readText()),
      folder,
    );
    await page.locator(".rcf-location").click();
    await page
      .getByRole("button", { name: "Действия с задачей", exact: true })
      .click();
    assert.equal(await page.locator(".rcf-project-menu").count(), 0);
    assert.equal(await page.locator(".session-menu").count(), 1);
    await page.locator(".rcf-location").click();
    assert.equal(await page.locator(".session-menu").count(), 0);
    await page.keyboard.press("Escape");
    assert.equal(await page.locator(".rcf-project-menu").count(), 0);
    await page
      .getByRole("button", { name: "Управление задачей", exact: true })
      .click();
    for (const tab of ["Помощники", "Проверка изменений", "История задачи", "Рабочие копии"]) {
      await page.getByRole("tab", { name: tab, exact: true }).click();
      assert.equal(
        await page
          .getByRole("tab", { name: tab, exact: true })
          .getAttribute("aria-selected"),
        "true",
      );
    }
    await page.keyboard.press("Escape");
    await page.locator(".rcf-metrics>summary").click();
    await page.locator(".rcf-metrics[open]>div").waitFor();
    await page.keyboard.press("Escape");
    await page
      .getByRole("button", { name: "Действия с задачей", exact: true })
      .click();
    await page
      .getByRole("button", { name: "Изменения проекта", exact: true })
      .click();
    await page.locator(".git-panel").waitFor();
    await geometry(`${theme}/git-open`);
    await page.screenshot({
      path: `test-results/header-gutters${suffix}-${theme}-git.png`,
    });
    await page
      .getByRole("button", { name: "Изменения Git", exact: true })
      .click();
  }
  await size(1440);
  await page.evaluate(() =>
    window.desktop.savePreferences({ animations: true }),
  );
  await page.emulateMedia({ reducedMotion: "no-preference" });
  const transform = () =>
    page
      .locator(".chat-gutter-dots")
      .first()
      .evaluate((el) => getComputedStyle(el).transform);
  const before = await transform();
  await page.waitForTimeout(250);
  assert.notEqual(await transform(), before);
  await page.emulateMedia({ reducedMotion: "reduce" });
  assert.equal(
    await page
      .locator(".chat-gutter-dots")
      .first()
      .evaluate((el) => getComputedStyle(el).animationName),
    "none",
  );
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await page.keyboard.press("Control+,");
  await page.getByRole("button", { name: "Внешний вид", exact: true }).click();
  await page.getByRole("switch", { name: "Анимации", exact: true }).click();
  await page.keyboard.press("Escape");
  await page.waitForFunction(
    () => document.documentElement.dataset.motion === "reduced",
  );
  assert.equal(
    await page
      .locator(".chat-gutter-dots")
      .first()
      .evaluate((el) => getComputedStyle(el).animationName),
    "none",
  );
  const composer = page.getByRole("textbox", {
    name: "Сообщение агенту",
    exact: true,
  });
  await composer.fill("Черновик сохраняется при открытии меню.");
  await page
    .getByRole("button", { name: "Действия с задачей", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Переименовать", exact: true })
    .waitFor();
  await page.keyboard.press("Escape");
  assert.equal(
    await composer.inputValue(),
    "Черновик сохраняется при открытии меню.",
  );
  await page.evaluate(() => {
    const p = document.querySelector(".timeline-column p");
    const r = document.createRange();
    r.selectNodeContents(p);
    getSelection().removeAllRanges();
    getSelection().addRange(r);
  });
  assert.ok((await page.evaluate(() => getSelection().toString())).length > 10);
  assert.deepEqual(errors, []);
  await fs.writeFile(
    `test-results/header-gutters${suffix}.json`,
    JSON.stringify(
      {
        passed: true,
        directory,
        checks,
        animation: true,
        reducedMotion: true,
        projectPathCopy: true,
        menus: true,
        textSelection: true,
        errors,
      },
      null,
      2,
    ),
  );
  console.log(
    "PASS unified header, both themes, 1920/1440/1080/780, Git panel, clean central column, menus, slow animation, reduced motion, selection and draft",
  );
} catch (error) {
  await page
    ?.screenshot({ path: `test-results/header-gutters${suffix}-failure.png` })
    .catch(() => {});
  throw error;
} finally {
  await app?.close().catch(() => {});
}
