import { _electron as electron } from "playwright";
import { Service } from "@opencode/client/service";
import { OpenCode } from "@opencode/client";
import fs from "node:fs/promises";
import path from "node:path";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";

const directory = path.resolve(`.runtime/ux-refinement-${process.pid}`);
const folder = path.join(directory, "Fixture project");
await fs.mkdir(folder, { recursive: true });
await fs.mkdir("test-results/ux", { recursive: true });
const checks = [],
  errors = [];
let app;
const launch = () =>
  electron.launch({
    args: process.env.RCF_PACKAGED ? [] : ["."],
    executablePath: process.env.RCF_PACKAGED,
    env: { ...process.env, FORGE_DATA_DIR: directory },
    timeout: 30000,
  });
try {
  app = await launch();
  let page = await app.firstWindow();
  page.on("pageerror", (e) => errors.push(e.message));
  await page.waitForSelector(".status-dot.ready", { timeout: 45000 });
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
    title: "UX: длинная переписка",
  });
  await client.session.remove({ sessionID: info.id });
  const model = { providerID: "qa", id: "fixture" };
  const messages = Array.from({ length: 480 }, (_, i) => ({
    id: `msg_${(0x20000000000 + i).toString(16)}qa${String(i).padStart(10, "0")}`,
    time: {
      created: info.time.created + i * 1000,
      ...(i % 2 ? { completed: info.time.created + i * 1000 + 500 } : {}),
    },
    ...(i % 2
      ? {
          type: "assistant",
          agent: "build",
          model,
          content: [
            {
              type: "text",
              text:
                `Ответ ${i}:\n\n` +
                "Изменяемая высота сообщения и блоки кода. ".repeat(
                  (i % 7) * 12,
                ) +
                "\n```ts\nconst verified = true;\n```",
            },
          ],
        }
      : {
          type: "user",
          text:
            `Запрос ${i / 2 + 1}: архитектура, Unicode и прокрутка.\n` +
            "Длинный контекст. ".repeat((i % 5) * 16),
        }),
  }));
  await client.experimental.session.import({
    info,
    location: { directory: folder },
    messages,
  });
  const emptyInfo = await client.session.create({
    location: { directory: folder },
    title: "UX: пустой чат",
  });
  const shortInfo = await client.session.create({
    location: { directory: folder },
    title: "UX: короткий чат",
  });
  await client.session.remove({ sessionID: shortInfo.id });
  await client.experimental.session.import({
    info: shortInfo,
    location: { directory: folder },
    messages: [
      {
        ...messages[0],
        id: messages[0].id.replace("qa", "qb"),
        text: "Короткое сообщение",
      },
    ],
  });
  await page.evaluate(
    async ({ projectId, sessionId }) =>
      window.desktop.savePreferences({
        projectId,
        sessionId,
        language: "ru",
        theme: "dark",
      }),
    { projectId: project.id, sessionId: info.id },
  );
  await page.reload();
  await page.locator(".timeline-scroll").waitFor();
  const size = async (width, zoom = 1) => {
    await app.evaluate(
      ({ BrowserWindow }, [width, zoom]) => {
        const w = BrowserWindow.getAllWindows()[0];
        w.setSize(width, 960);
        w.webContents.setZoomFactor(zoom);
      },
      [width, zoom],
    );
    await page.waitForTimeout(80);
    if (!await page.locator('.settings-screen').count()) {
      const narrow = await page.evaluate(()=>innerWidth<=650);
      const exists = await page.locator('.sidebar').count();
      if ((narrow && exists) || (!narrow && !exists)) await page.keyboard.press('Control+b');
    }
  };
  await size(1440);
  // The first marker is not in the initial 150-message snapshot.
  const first = page.locator('[data-marker-index="0"]');
  await page.waitForFunction(
    () =>
      document.querySelector(".rail-scroll > div")?.style.height === "4800px",
  );
  await page.locator(".rail-scroll").evaluate((el) => {
    el.scrollTop = 0;
  });
  await first.waitFor();
  assert.equal(
    (await page.locator(".rail-marker").count()) < 40,
    true,
    "rail DOM stays bounded",
  );
  await first.hover();
  await page.getByRole("tooltip").filter({ hasText: "Запрос 1:" }).waitFor();
  await first.click();
  await page.waitForFunction((id) => {
    const row = [...document.querySelectorAll("[data-row-id]")].find(
      (el) => el.dataset.rowId === id,
    );
    const scroller = document.querySelector(".timeline-scroll");
    return (
      row &&
      Math.abs(
        row.getBoundingClientRect().top -
          scroller.getBoundingClientRect().top -
          12,
      ) < 2
    );
  }, messages[0].id);
  checks.push({
    railOlderTarget: true,
    railDOM: await page.locator(".rail-marker").count(),
    timelineDOM: await page.locator(".timeline-item").count(),
  });
  await page.screenshot({ path: "test-results/ux/rail-oldest.png" });
  await page.locator(".timeline-scroll").evaluate((el) => {
    el.scrollTop += 800;
  });
  await page.waitForTimeout(700);
  const positionBefore = await page.evaluate(() => {
    const top = document
      .querySelector(".timeline-scroll")
      .getBoundingClientRect().top;
    const row = [...document.querySelectorAll("[data-row-id]")].find(
      (el) => el.getBoundingClientRect().bottom > top,
    );
    return {
      id: row.dataset.rowId,
      top: row.getBoundingClientRect().top - top,
    };
  });
  const activeBefore = await page
    .locator(".rail-marker[aria-current]")
    .getAttribute("aria-label");
  assert.ok(activeBefore && !activeBefore.startsWith("Сообщение 1:"));
  await page.evaluate(() =>
    window.desktop.savePreferences({ animations: false }),
  );
  await app.close();
  app = await launch();
  page = await app.firstWindow();
  page.on("pageerror", (e) => errors.push(e.message));
  await page.waitForSelector(".status-dot.ready", { timeout: 45000 });
  await size(1440);
  await page.waitForFunction(
    (expected) =>
      document
        .querySelector(".rail-marker[aria-current]")
        ?.getAttribute("aria-label") === expected,
    activeBefore,
  );
  await page.waitForFunction((expected) => {
    const top = document
      .querySelector(".timeline-scroll")
      .getBoundingClientRect().top;
    const row = [...document.querySelectorAll("[data-row-id]")].find(
      (el) => el.dataset.rowId === expected.id,
    );
    return (
      row && Math.abs(row.getBoundingClientRect().top - top - expected.top) < 2
    );
  }, positionBefore);
  checks.push({
    restoredAnchor: true,
    exactRestore: positionBefore,
    animationsDisabled: true,
  });
  await page.keyboard.press("Control+,");
  const categories = [
    "Основные",
    "Внешний вид",
    "Модели и подключения",
    "Агенты и разрешения",
    "Память и персонализация",
    "История и хранение",
    "Горячие клавиши",
    "О приложении",
  ];
  for (const theme of ["dark", "light"]) {
    await page.evaluate(
      (theme) => window.desktop.savePreferences({ theme }),
      theme,
    );
    for (const width of [1440, 1080, 780])
      for (const zoom of [1, 1.25, 1.5, 2]) {
        await size(width, zoom);
        for (let i = 0; i < categories.length; i++) {
          await page
            .locator(".settings-category-list")
            .getByRole("button", { name: categories[i], exact: true })
            .click();
          const geometry = await page.evaluate(() => {
            const content = document.querySelector(".settings-content");
            const bounds = content.getBoundingClientRect();
            return {
              overflow: content.scrollWidth > content.clientWidth + 1,
              documentOverflow:
                document.documentElement.scrollWidth > innerWidth + 1,
              clipped: [
                ...content.querySelectorAll("button, select, input, textarea"),
              ]
                .filter((el) => {
                  const r = el.getBoundingClientRect();
                  return (
                    r.width > 0 &&
                    (r.left < bounds.left - 1 || r.right > bounds.right + 1)
                  );
                })
                .map((el) => el.outerHTML.slice(0, 100)),
            };
          });
          assert.equal(
            geometry.overflow,
            false,
            JSON.stringify({
              theme,
              width,
              zoom,
              tab: categories[i],
              ...geometry,
            }),
          );
          assert.equal(geometry.documentOverflow, false);
          assert.deepEqual(
            geometry.clipped,
            [],
            JSON.stringify({
              theme,
              width,
              zoom,
              tab: categories[i],
              ...geometry,
            }),
          );
          checks.push({ theme, width, zoom, tab: categories[i], ...geometry });
          if (zoom === 1 && width === 1440) {
            await page.evaluate(async () => {
              await Promise.all(
                [...document.querySelectorAll(".settings-content img")].map(
                  (img) => img.decode(),
                ),
              );
            });
            await page.waitForTimeout(100);
            await page.screenshot({
              path: `test-results/ux/settings-${i}-${theme}.png`,
            });
          }
        }
      }
  }
  await size(1440);
  await page
    .locator(".settings-category-list")
    .getByRole("button", { name: "Модели и подключения", exact: true })
    .click();
  assert.equal(await page.locator(".provider-directory").count(), 0);
  await page.getByRole("button", { name: /^Каталог провайдеров/ }).click();
  assert.ok(
    (await page
      .locator(".provider-directory .integration-list > button")
      .count()) <= 40,
  );
  await page.getByPlaceholder("Найти провайдера…").fill("openai");
  assert.ok(
    (await page
      .locator(".provider-directory .integration-list > button")
      .count()) > 0,
  );
  await page
    .getByRole("button", { name: "Горячие клавиши", exact: true })
    .click();
  await page
    .getByRole("textbox", { name: "Найти сочетание клавиш" })
    .fill("Ctrl K");
  assert.equal(await page.locator(".settings-shortcuts section").count(), 1);
  await page
    .getByRole("button", { name: "Закрыть настройки", exact: true })
    .click();
  const openGit = async () => {
    await page
      .getByRole("button", { name: "Действия с задачей", exact: true })
      .click();
    await page
      .getByRole("button", { name: "Изменения проекта", exact: true })
      .click();
  };
  await openGit();
  await page
    .getByText("В этой папке нет Git репозитория.", { exact: false })
    .waitFor();
  checks.push({ gitNonRepository: true });
  const git = (...args) =>
    execFileSync("git", args, {
      cwd: folder,
      encoding: "utf8",
      windowsHide: true,
    });
  git("init");
  git("config", "core.autocrlf", "false");
  await fs.writeFile(path.join(folder, "base.txt"), "base\n");
  git("add", ".");
  git(
    "-c",
    "user.name=QA",
    "-c",
    "user.email=qa@example.invalid",
    "commit",
    "-m",
    "fixture",
  );
  await page.getByRole("button", { name: "Обновить изменения" }).click();
  await page.getByText("Рабочая папка чиста", { exact: true }).waitFor();
  checks.push({ gitClean: true });
  for (let i = 0; i < 60; i++) {
    const file = path.join(
      folder,
      "long-directory-name".repeat(4),
      `file-${i}.txt`,
    );
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, `new ${i}\n`);
  }
  git("add", ".");
  git(
    "-c",
    "user.name=QA",
    "-c",
    "user.email=qa@example.invalid",
    "commit",
    "-m",
    "many tracked files",
  );
  for (let i = 0; i < 60; i++)
    await fs.appendFile(
      path.join(folder, "long-directory-name".repeat(4), `file-${i}.txt`),
      "changed\n",
    );
  await page.getByRole("button", { name: "Обновить изменения" }).click();
  await page.waitForFunction(
    () => document.querySelectorAll(".git-file-row").length === 60,
  );
  await page.screenshot({ path: "test-results/ux/git-files.png" });
  await page.getByRole("button", { name: "Эта задача", exact: true }).click();
  await page
    .getByText("OpenCode пока не сообщил об изменениях этой задачи.", {
      exact: true,
    })
    .waitFor();
  checks.push({ gitManyLongPaths: true, gitSessionEmpty: true });
  const inViewport = async (selector) => {
    const box = await page.locator(selector).evaluate((el) => {
      const r = el.getBoundingClientRect();
      return {
        left: r.left,
        right: r.right,
        top: r.top,
        bottom: r.bottom,
        width: innerWidth,
        height: innerHeight,
        overflow: el.scrollWidth > el.clientWidth + 1,
      };
    });
    assert.ok(
      box.left >= -1 &&
        box.right <= box.width + 1 &&
        box.top >= -1 &&
        box.bottom <= box.height + 1 &&
        !box.overflow,
      JSON.stringify({ selector, ...box }),
    );
  };
  await page
    .getByRole("button", { name: "Рабочая папка", exact: true })
    .click();
  for (const theme of ["dark", "light"]) {
    await page.evaluate(
      (theme) => window.desktop.savePreferences({ theme }),
      theme,
    );
    for (const width of [1440, 1080, 780])
      for (const zoom of [1, 1.25, 1.5, 2]) {
        await size(width, zoom);
        await inViewport(".git-panel");
        checks.push({ panel: "git", theme, width, zoom });
      }
  }
  await page.getByRole("button", { name: "Закрыть изменения" }).click();
  for (const theme of ["dark", "light"]) {
    await page.evaluate(
      (theme) => window.desktop.savePreferences({ theme }),
      theme,
    );
    for (const width of [1440, 1080, 780])
      for (const zoom of [1, 1.25, 1.5, 2]) {
        await size(width, zoom);
        await page
          .getByRole("button", { name: "Режим разрешений", exact: true })
          .click();
        await inViewport(".mode-popover");
        assert.equal(await page.getByRole("menuitemradio").count(), 3);
        await page.keyboard.press("End");
        assert.equal(
          await page
            .getByRole("menuitemradio", { name: /^Полный доступ/ })
            .evaluate((el) => el === document.activeElement),
          true,
        );
        if (width === 1440 && zoom === 1)
          await page.screenshot({
            path: `test-results/ux/permissions-${theme}.png`,
          });
        await page.keyboard.press("Escape");
        await page
          .getByRole("button", { name: "Управление задачей", exact: true })
          .click();
        for (const name of [
          "Рабочие копии",
          "Помощники",
          "Проверка изменений",
          "История задачи",
        ]) {
          await page.getByRole("tab", { name, exact: true }).click();
          await inViewport(".task-dialog");
        }
        await page.keyboard.press("Escape");
        checks.push({ panel: "permissions-and-task", theme, width, zoom });
        const visible = await page.locator(".conversation-rail").isVisible();
        const conversationWidth = await page
          .locator(".conversation")
          .evaluate((el) => el.clientWidth);
        assert.equal(visible, conversationWidth > 940);
      }
  }
  await size(1440);
  for (const [title, count] of [
    ["UX: пустой чат", 0],
    ["UX: короткий чат", 1],
  ]) {
    await page
      .locator(".session-title")
      .getByText(title, { exact: true })
      .first()
      .click();
    await page.waitForFunction(
      (expected) =>
        document.querySelector(".workspace-title>span")?.textContent ===
        expected,
      title,
    );
    await page.waitForTimeout(200);
    assert.equal(await page.locator(".rail-marker").count(), count);
  }
  await page
    .locator(".session-title")
    .getByText(info.title, { exact: true })
    .first()
    .click();
  await page.waitForFunction(
    (expected) =>
      document.querySelector(".workspace-title>span")?.textContent === expected,
    info.title,
  );
  await page.locator(".rail-marker").first().waitFor();
  checks.push({ emptyChat: true, shortChat: true, switchedChats: true });
  assert.deepEqual(errors, []);
  await fs.writeFile(
    "test-results/ux/refinement-verification.json",
    JSON.stringify({ passed: true, directory, checks, errors }, null, 2),
  );
  console.log(
    `PASS ${checks.length} checks: 192 settings layouts, paginated rail, exact jump, restart anchor, provider search, Git states`,
  );
} finally {
  if (app) await app.close();
}
