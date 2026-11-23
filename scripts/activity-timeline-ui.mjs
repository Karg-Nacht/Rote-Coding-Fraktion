import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { createServer } from "node:http";
import { _electron as electron } from "playwright";
import { OpenCode } from "@opencode/client";
import { Service } from "@opencode/client/service";
import { revealActivity } from "./activity-ui-controls.mjs";

const before = process.argv.includes("--before");
const baseline = before ? process.env.RCF_BASELINE_EXE : undefined;
const liveOnly = process.argv.includes("--live-only");
await fs.mkdir(".runtime", { recursive: true });
const data = await fs.mkdtemp(path.resolve(".runtime/activity-timeline-"));
const folder = path.join(data, "Local fixture");
const output =
  process.env.RCF_ACTIVITY_OUTPUT ?? "test-results/activity-timeline";
await fs.mkdir(folder);
await fs.mkdir(output, { recursive: true });
await fs.writeFile(path.join(folder, "live.txt"), "before\n");
await fs.writeFile(
  path.join(folder, "log.cjs"),
  "for(let i=0;i<1600;i++) console.log('LOG-LINE-' + i);",
);
const model = { providerID: "activityqa", id: "fixture" };
const markdown = [
  "# Результат",
  "Проверены файлы проекта.",
  "---",
  "## Проверки",
  "- История",
  "- Вывод",
  "| Файл | Результат |\n| --- | --- |\n| editor.ts | Готово |",
  "> Сводка относится к этой задаче.",
  "```ts\nconst checked: boolean = true;\n```",
].join("\n\n");
const largePatch =
  "@@ -0,0 +1,900 @@\n" +
  Array.from(
    { length: 900 },
    (_, i) => "+" + i + " " + "text ".repeat(82),
  ).join("\n");
const editPatch = "@@ -1 +1 @@\n-old value\n+new value";
const fixtureFiles = [
  {
    file: "src/components/Editor.tsx",
    status: "modified",
    patch: editPatch,
    additions: 1,
    deletions: 1,
  },
  {
    file: "long.txt",
    status: "added",
    patch: largePatch,
    additions: 900,
    deletions: 0,
  },
  {
    file: "removed.txt",
    status: "deleted",
    patch: "@@ -1 +0,0 @@\n-old",
    additions: 0,
    deletions: 1,
  },
  {
    file: "renamed.txt",
    status: "modified",
    patch: "rename from old.txt\nrename to renamed.txt",
  },
  {
    file: "asset.bin",
    status: "modified",
    patch: "Binary files a/asset.bin and b/asset.bin differ",
  },
  { file: "unavailable.txt", status: "modified", patch: "" },
];
const errors = [];
const cases = [];
let app;
let calls = 0;
let toolsAvailable;
const server = createServer(async (req, res) => {
  if (!req.url?.endsWith("/chat/completions"))
    return void res.writeHead(404).end();
  const body = JSON.parse(Buffer.concat(await Array.fromAsync(req)).toString());
  const step = body.tools?.length ? calls++ : -1;
  if (step === 0)
    toolsAvailable =
      body.tools?.map((tool) => tool.function?.name ?? tool.name) ?? [];
  res.writeHead(200, { "Content-Type": "text/event-stream" });
  const emit = (delta, finish_reason = null) =>
    res.write(
      `data: ${JSON.stringify({
        id: "qa-" + step,
        object: "chat.completion.chunk",
        created: 0,
        model: body.model,
        choices: [{ index: 0, delta, finish_reason }],
      })}\n\n`,
    );
  if (step < 0) {
    emit({ role: "assistant", content: "Activity fixture" });
    emit({}, "stop");
  } else if (step < 3) {
    const name =
      step === 0
        ? (["edit", "patch", "write"].find((name) =>
            toolsAvailable.includes(name),
          ) ?? "edit")
        : "shell";
    const args =
      step === 0
        ? name === "patch"
          ? {
              patchText:
                "*** Begin Patch\n*** Update File: live.txt\n@@\n-before\n+after\n*** End Patch",
            }
          : name === "write"
            ? { path: "live.txt", content: "after\n" }
            : {
                path: "live.txt",
                oldString: "before",
                newString: "after",
                replaceAll: false,
              }
        : {
            command:
              step === 1
                ? 'node -e "setTimeout(()=>console.log(123),3500)"'
                : 'node -e "console.error(456);process.exit(2)"',
            description: "Fixture command",
          };
    emit({
      role: "assistant",
      tool_calls: [
        {
          index: 0,
          id: `tool-${step}`,
          type: "function",
          function: { name, arguments: JSON.stringify(args) },
        },
      ],
    });
    emit({}, "tool_calls");
  } else {
    emit({ role: "assistant", content: "Потоковый результат." });
    emit({}, "stop");
  }
  res.end("data: [DONE]\n\n");
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));

async function launch() {
  app = await electron.launch({
    args: baseline ? [] : ["."],
    executablePath: baseline,
    env: { ...process.env, RCF_DATA_DIR: data },
  });
  const page = await app.firstWindow();
  page.on("pageerror", (error) => errors.push(error.message));
  await page.locator(".status-dot.ready").waitFor({ timeout: 45_000 });
  return page;
}

try {
  let page = await launch();
  await app.evaluate(({ dialog }, directory) => {
    dialog.showOpenDialog = async () => ({
      canceled: false,
      filePaths: [directory],
    });
  }, folder);
  const project = await page.evaluate(() => window.desktop.addProject());
  const endpoint = await Service.discover({
    file: path.join(data, "engine/state/opencode/service.json"),
    version: "2.3.0",
  });
  const engine = OpenCode.make({
    baseUrl: endpoint.url,
    headers: Service.headers(endpoint),
  });
  function messageId(i) {
    return `msg_${(0x20000000000 + i).toString(16)}activity${String(i).padStart(6, "0")}`;
  }
  const imported = await engine.session.create({
    location: { directory: folder },
    title: "Activity QA history",
  });
  await engine.session.remove({ sessionID: imported.id });
  const tool = (i, name, input, text, metadata = {}) => ({
    type: "tool",
    id: "activity-" + i,
    name,
    time: { created: 500 + i, ran: 500 + i, completed: 710 + i },
    state: {
      status: "completed",
      input,
      content: [{ type: "text", text }],
      metadata,
    },
  });
  const history = Array.from({ length: 330 }, (_, i) => ({
    id: messageId(i),
    time: { created: imported.time.created + i },
    ...(i % 2
      ? {
          type: "assistant",
          agent: "build",
          model,
          content: [{ type: "text", text: `Ответ ${i}` }],
        }
      : { type: "user", text: `Запрос ${i}` }),
  }));
  const at = imported.time.created + history.length;
  history.push(
    {
      id: messageId(330),
      time: { created: at },
      type: "user",
      text: "Проверь изменения",
    },
    {
      id: messageId(331),
      time: { created: at + 1, completed: at + 2 },
      type: "assistant",
      agent: "build",
      model,
      content: [
        ...Array.from({ length: 120 }, (_, index) =>
          tool(
            100 + index,
            "read",
            {
              path: path.join(
                folder,
                index < 2 ? ["src", "fixtures"][index] : "batch",
                index < 2 ? "index.ts" : `item-${index}.ts`,
              ),
            },
            `Результат чтения ${index}`,
          ),
        ),
        tool(
          250,
          "shell",
          { command: "npm.cmd run typecheck" },
          "Проверка типов",
          { exit: 0 },
        ),
        tool(251, "shell", { command: "node --test" }, "Результат тестов", {
          exit: 0,
        }),
        { type: "text", text: "Закончил исследование." },
        tool(
          1,
          "read",
          { path: "src/components/Editor.tsx" },
          "Содержимое файла",
        ),
        tool(
          2,
          "shell",
          { command: "node log.cjs" },
          Array.from({ length: 1600 }, (_, i) => `LOG-LINE-${i}`).join("\n"),
          { exit: 0 },
        ),
        tool(3, "shell", { command: "node failed.cjs" }, "FIXTURE_ERROR", {
          exit: 2,
        }),
        tool(4, "patch", {}, "Engine patch result", { files: fixtureFiles }),
        { type: "text", text: markdown },
      ],
    },
  );
  await engine.experimental.session.import({
    info: imported,
    location: { directory: folder },
    messages: history,
  });

  async function openHistory(theme) {
    await page.evaluate(
      async ({ projectId, sessionId, theme }) =>
        window.desktop.savePreferences({
          projectId,
          sessionId,
          theme,
          animations: true,
        }),
      {
        projectId: project.id,
        sessionId: imported.id,
        theme,
      },
    );
    await page.reload();
    await page.locator(".assistant-message .markdown h1").waitFor();
    await page.locator("html[data-theme=" + theme + "]").waitFor();
  }
  async function resize(width, height) {
    await app.evaluate(
      ({ BrowserWindow }, size) =>
        BrowserWindow.getAllWindows()[0].setContentSize(...size),
      [width, height],
    );
    await page.waitForFunction(
      ([w, h]) => innerWidth === w && innerHeight === h,
      [width, height],
    );
  }
  const screen = (name) =>
    page.screenshot({ path: path.join(output, name + ".png") });
  async function checkDisclosureAnchor(control) {
    await control.focus();
    await control.scrollIntoViewIfNeeded();
    const before = (await control.boundingBox()).y;
    await control.press("Enter");
    await page.evaluate(() => new Promise((resolve) => {
      let frames = 0;
      const settle = () => ++frames < 10 ? requestAnimationFrame(settle) : resolve();
      requestAnimationFrame(settle);
    }));
    const after = (await control.boundingBox()).y;
    assert.ok(Math.abs(after - before) < 5, `Stage header moved ${after - before}px`);
  }
  const jump = () =>
    page.locator(".timeline-scroll").evaluate((el) => {
      el.scrollTop = el.scrollHeight;
    });
  for (const theme of liveOnly ? [] : ["dark", "light"]) {
    await openHistory(theme);
    if (before) {
      await resize(1080, 720);
      await jump();
      const group = page.locator(".action-group-summary").last();
      await group.scrollIntoViewIfNeeded();
      await group.click();
      await page.waitForFunction(() => {
        const boxes = [...document.querySelectorAll(".timeline-item")].map(
          (el) => el.getBoundingClientRect(),
        );
        return (
          boxes.length > 1 &&
          boxes.every((box, i) => i === 0 || box.top >= boxes[i - 1].bottom - 1)
        );
      });
      await screen("before-" + theme);
      await jump();
      await screen("before-markdown-" + theme);
      continue;
    }
    await resize(1080, 720);
    await jump();
    const dense = page
      .locator(".action-group")
      .filter({ has: page.getByRole("button", { name: /^Действия: 122/ }) });
    const denseSummary = dense.locator(".activity-stage-toggle");
    await denseSummary.scrollIntoViewIfNeeded();
    assert.equal(await denseSummary.getAttribute("aria-expanded"), "false");
    assert.equal(await dense.locator(".tool-item").count(), 0);
    await screen("collapsed-" + theme);
    await checkDisclosureAnchor(denseSummary);
    await revealActivity(dense, "read");
    const reads = dense.locator('.activity-category[data-kind="read"]');
    assert.equal(
      await reads.locator(".tool-item").count(),
      theme === "dark" ? 36 : 120,
    );
    const src = reads.getByText("src/index.ts", { exact: true });
    const fixtures = reads.getByText("fixtures/index.ts", { exact: true });
    assert.equal(
      await src.getAttribute("title"),
      path.join(folder, "src", "index.ts"),
    );
    assert.equal(
      await fixtures.getAttribute("title"),
      path.join(folder, "fixtures", "index.ts"),
    );
    const more = reads.getByRole("button", { name: "Показать ещё действия" });
    if (theme === "dark")
      for (let batch = 0; batch < 3; batch++) await more.click();
    assert.equal(await reads.locator(".tool-item").count(), 120);
    await reads.getByRole("button", { name: /Чтение файлов · 120/ }).click();
    await revealActivity(dense, "check");
    assert.equal(
      await dense
        .locator('.activity-category[data-kind="check"] .tool-item')
        .count(),
      2,
    );
    await screen("groups-" + theme);
    await checkDisclosureAnchor(denseSummary);
    assert.equal(await dense.locator(".tool-item").count(), 0);
    await page
      .getByRole("button", { name: "Скрыть завершённые действия" })
      .click();
    await dense.waitFor({ state: "hidden" });
    await page
      .locator('.tool-item[data-status="error"]')
      .getByText("Ошибка", { exact: true })
      .waitFor();
    await page.getByRole("button", { name: "Показать действия" }).click();
    for (const [width, height] of [
      [1440, 960],
      [1080, 720],
      [780, 600],
    ]) {
      await resize(width, height);
      await jump();
      const group = page.locator(".action-group").last();
      await revealActivity(group, "shell");
      const command = group.getByRole("button", { name: /node log\.cjs/ });
      await command.scrollIntoViewIfNeeded();
      await command.press("Enter");
      const details = command.locator("..").locator(".tool-output");
      assert.match(await details.innerText(), /LOG-LINE-0/);
      assert.doesNotMatch(await details.innerText(), /LOG-LINE-1599/);
      if (width === 1080) {
        const detail = command.locator("..");
        await detail
          .getByRole("button", { name: "Копировать команду" })
          .click();
        assert.equal(
          await app.evaluate(({ clipboard }) => clipboard.readText()),
          "node log.cjs",
        );
        await detail.getByRole("button", { name: "Копировать вывод" }).click();
        assert.match(
          await app.evaluate(({ clipboard }) => clipboard.readText()),
          /LOG-LINE-1599/,
        );
        await screen("after-shell-" + theme);
      }
      await details
        .getByRole("button", { name: "Показать сохранённый вывод" })
        .click();
      const log = details.getByRole("region", { name: "Вывод инструмента" });
      await log.evaluate((el) => {
        el.scrollTop = el.scrollHeight;
      });
      await log.getByText("LOG-LINE-1599", { exact: true }).waitFor();
      assert.ok((await log.locator(":scope > div > div").count()) < 60);
      await details.getByRole("button", { name: "Свернуть вывод" }).click();
      await command.press("Enter");
      const failed = group.getByRole("button", {
        name: /node failed\.cjs.*Ошибка/,
      });
      await failed.press("Enter");
      await failed
        .locator("..")
        .getByText("FIXTURE_ERROR", { exact: true })
        .waitFor();
      await failed.press("Enter");
      const edit = group
        .locator(".tool-summary")
        .filter({ hasText: "Изменение" });
      await edit.click();
      const diff = group.getByRole("button", {
        name: /Изменён src\/components\/Editor/,
      });
      await diff.focus();
      await diff.scrollIntoViewIfNeeded();
      await page.evaluate(
        () =>
          new Promise((resolve) =>
            requestAnimationFrame(() => requestAnimationFrame(resolve)),
          ),
      );
      const top = (await diff.boundingBox()).y;
      await diff.press("Enter");
      const scope = diff.locator("../..");
      await scope.locator(".diff-add[data-new='1']").waitFor();
      await page.evaluate(
        () =>
          new Promise((resolve) => {
            let frames = 0;
            const settle = () =>
              ++frames < 9 ? requestAnimationFrame(settle) : resolve();
            requestAnimationFrame(settle);
          }),
      );
      const moved = (await diff.boundingBox()).y - top;
      assert.ok(
        Math.abs(moved) < 5,
        `Diff header moved ${moved}px at ${width} in ${theme}`,
      );
      assert.equal(
        await page
          .locator(".timeline-scroll")
          .evaluate((el) => el.scrollWidth > el.clientWidth),
        false,
      );
      if (width === 1080) await screen("after-activity-" + theme);
      await diff.press("Enter");
      const large = group.getByRole("button", { name: /Добавлен long.txt/ });
      await large.press("Enter");
      await large
        .locator("../..")
        .getByText("Показан начальный фрагмент diff.")
        .waitFor();
      await large
        .locator("../..")
        .getByRole("button", { name: "Открыть diff long.txt" })
        .click();
      const dialog = page.getByRole("dialog", {
        name: "long.txt",
        exact: true,
      });
      await dialog
        .getByRole("button", { name: /Показать полный diff/ })
        .click();
      await dialog.getByText(/899 text/).waitFor();
      await page.keyboard.press("Escape");
      await large.press("Enter");
      for (const [name, expected] of [
        [/Удалён removed.txt/, "-old"],
        [/Переименован renamed.txt/, "Прежний путь: old.txt"],
        [/asset.bin/, "Двоичный файл · текстовый diff недоступен"],
        [/unavailable.txt/, "OpenCode не сохранил текстовый diff."],
      ]) {
        const file = group.getByRole("button", { name });
        await file.press("Enter");
        await file
          .locator("../..")
          .getByText(expected, { exact: true })
          .waitFor();
        await file.press("Enter");
      }
      await jump();
      const response = page
        .locator(".assistant-message")
        .filter({ has: page.getByRole("heading", { name: "Результат" }) });
      await response.locator("table").waitFor();
      assert.equal(
        await response
          .locator("hr")
          .evaluate((el) => el.getBoundingClientRect().height),
        1,
      );
      await response.locator(".markdown-code .shiki").waitFor();
      await response.getByRole("button", { name: "Копировать код" }).click();
      assert.match(
        await app.evaluate(({ clipboard }) => clipboard.readText()),
        /const checked/,
      );
      if (width === 1080) await screen("after-markdown-" + theme);
      await edit.click();
      cases.push({ theme, width, height });
    }
  }

  if (!before) {
    await page.evaluate(
      async ({ port, projectId, model }) => {
        await window.desktop.customProvider({
          id: model.providerID,
          name: "Activity fixture",
          baseUrl: `http://127.0.0.1:${port}/v1`,
          model: model.id,
          key: "fixture-key",
          runtime: "compatible",
          images: false,
          tools: true,
        });
        const session = await window.desktop.createSession(
          projectId,
          model,
          "autonomous",
          "work",
        );
        await window.desktop.savePreferences({
          projectId,
          sessionId: session.id,
          model,
          mode: "autonomous",
        });
      },
      { port: server.address().port, projectId: project.id, model },
    );
    await page.reload();
    const composer = page.getByRole("textbox", { name: "Сообщение агенту" });
    await composer.fill("Проверь активность");
    await page
      .getByRole("button", { name: "Отправить сообщение", exact: true })
      .click();
    const running = page.locator(
      '.tool-item[data-status="running"] .activity-shimmer',
    );
    await running.waitFor({ timeout: 25_000 });
    await revealActivity(
      running.locator("xpath=ancestor::*[contains(@class, 'action-group')]"),
      "shell",
    );
    assert.equal(
      await running.evaluate((el) => getComputedStyle(el).animationName),
      "activity-luminance",
    );
    await page.emulateMedia({ reducedMotion: "reduce" });
    assert.equal(
      await running.evaluate((el) => getComputedStyle(el).animationName),
      "none",
    );
    await page
      .getByText("Потоковый результат.", { exact: true })
      .waitFor({ timeout: 40_000 });
    await running.waitFor({ state: "hidden" });
    const actual = await fs.readFile(path.join(folder, "live.txt"), "utf8");
    assert.equal(actual, "after\n", JSON.stringify({ toolsAvailable }));
    const liveFile = page
      .getByRole("button", { name: /Изменён .*live.txt/ })
      .first();
    await liveFile.press("Enter");
    assert.equal(await liveFile.getAttribute("aria-expanded"), "true");
    assert.equal(await liveFile.locator("xpath=ancestor::*[contains(@class, 'tool-item')]").locator(".tool-input").count(), 0);
    await page
      .getByRole("button", { name: "Полный результат инструмента" })
      .click();
    await page
      .getByRole("button", { name: "Свернуть результат инструмента" })
      .waitFor();
    await page
      .locator(".action-files .diff-add")
      .getByText("+after", { exact: true })
      .waitFor();
    await page
      .locator('.tool-item[data-status="error"]')
      .getByText("Ошибка", { exact: true })
      .waitFor();
    await page
      .getByRole("button", { name: "Скрыть завершённые действия" })
      .click();
    await liveFile.waitFor({ state: "hidden" });
    await app.close();
    page = await launch();
    await page.getByText("Потоковый результат.", { exact: true }).waitFor();
    await page.getByRole("button", { name: "Показать действия" }).click();
    assert.equal(
      await page
        .getByRole("button", { name: /Изменён .*live.txt/ })
        .first()
        .getAttribute("aria-expanded"),
      "true",
    );
    await page
      .locator(".action-files .diff-add")
      .getByText("+after", { exact: true })
      .waitFor();

    calls = 1; // The next fixture uses the same shell tool with cautious permissions.
    await page.evaluate(
      async ({ projectId, model }) => {
        const session = await window.desktop.createSession(
          projectId,
          model,
          "cautious",
          "work",
        );
        await window.desktop.savePreferences({
          projectId,
          sessionId: session.id,
          model,
          mode: "cautious",
          animations: false,
        });
      },
      { projectId: project.id, model },
    );
    await page.reload();
    await page
      .getByRole("textbox", { name: "Сообщение агенту" })
      .fill("Подтверди команду");
    await page
      .getByRole("button", { name: "Отправить сообщение", exact: true })
      .click();
    const permission = page.locator(".timeline-permission");
    await permission.getByText("Требуется разрешение").waitFor();
    await page
      .locator('.tool-item[data-status="waiting"]')
      .getByText("Ожидает подтверждения")
      .waitFor();
    await permission
      .getByRole("button", { name: "Разрешить один раз" })
      .click();
    const resumed = page.locator(
      '.tool-item[data-status="running"] .activity-shimmer',
    );
    await resumed.waitFor();
    assert.equal(
      await resumed.evaluate((el) => getComputedStyle(el).animationName),
      "none",
    );
    await page.keyboard.press("Escape");
    await page.keyboard.press("Escape");
    await page.locator('.run-summary[data-status="interrupted"]').waitFor();
    await resumed.waitFor({ state: "hidden" });
    assert.deepEqual(errors, []);
    await fs.writeFile(
      path.join(output, "verification.json"),
      JSON.stringify(
        {
          cases,
        groupedActions: 122,
        stageScrollAnchor: true,
        completionVisibilityAfterRestart: true,
          liveToolResults: true,
          liveDiffAfterRestart: true,
          permissionAndStop: true,
          errors,
        },
        null,
        2,
      ),
    );
    console.log(
      "PASS activity history, streaming, log virtualization, diff, copy, Markdown and both themes",
    );
  } else console.log("Captured baseline in both themes");
} finally {
  await app?.close();
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
}
