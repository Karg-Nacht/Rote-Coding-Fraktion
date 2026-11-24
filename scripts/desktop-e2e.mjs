import { _electron as electron } from "playwright";
import { Service } from "@opencode/client/service";
import { OpenCode } from "@opencode/client";
import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { revealActivity } from "./activity-ui-controls.mjs";
const dataDir = path.resolve(`.runtime/desktop-e2e-${process.pid}`);
const projectDir = path.join(dataDir, "Тестовый проект");
await fs.mkdir(projectDir, { recursive: true });
await fs.mkdir("test-results", { recursive: true });
await fs.writeFile(path.join(projectDir, "input.txt"), "hello forge\n");
await fs.writeFile(
  path.join(projectDir, "check.mjs"),
  "import fs from 'node:fs'; if(fs.readFileSync('result.txt','utf8').trim() !== 'HELLO FORGE') process.exit(1); console.log('FORGE_CHECK_OK')",
);
execFileSync("git", ["init"], {
  cwd: projectDir,
  windowsHide: true,
  stdio: "ignore",
});
const errors = [];
const live = process.argv.includes("--live");
const fixture = { providerID: "e2e-fixture", id: "desktop-fixture" };
const toolSteps = [
  ["read", { path: "input.txt" }],
  ["write", { path: "result.txt", content: "HELLO FORGE\n" }],
  [
    "shell",
    { command: "node check.mjs", description: "Verify the fixture result" },
  ],
];
let app, provider;
const launch = async () => {
  const launched = await electron.launch({
    args: [process.env.FORGE_PACKAGED ? "" : "."].filter(Boolean),
    executablePath: process.env.FORGE_PACKAGED || undefined,
    env: { ...process.env, FORGE_DATA_DIR: dataDir },
    timeout: 30000,
  });
  const page = await launched.firstWindow();
  page.on("pageerror", (e) => errors.push(e.message));
  await page.waitForFunction(
    () => document.querySelector(".status-dot.ready"),
    null,
    { timeout: 40000 },
  );
  return [launched, page];
};
try {
  if (!live) {
    provider = http.createServer(async (request, response) => {
      if (!request.url?.endsWith("/chat/completions"))
        return void response.writeHead(404).end();
      let raw = "";
      for await (const chunk of request) raw += chunk;
      const body = JSON.parse(raw);
      const available = new Set(
        (body.tools ?? []).map((tool) => tool.function?.name),
      );
      const completed = new Set(
        body.messages
          .filter((message) => message.role === "tool")
          .map((message) => message.tool_call_id),
      );
      const next = available.has("read")
        ? toolSteps.find(([name]) => !completed.has(`e2e-${name}`))
        : undefined;
      response.writeHead(200, { "Content-Type": "text/event-stream" });
      const emit = (delta, finish_reason = null) =>
        response.write(
          `data: ${JSON.stringify({ id: "e2e", object: "chat.completion.chunk", created: 1, model: body.model, choices: [{ index: 0, delta, finish_reason }] })}\n\n`,
        );
      if (next) {
        const [name, input] = next;
        assert.ok(
          available.has(name),
          `The real engine must advertise ${name} before the test can request it`,
        );
        emit({
          role: "assistant",
          tool_calls: [
            {
              index: 0,
              id: `e2e-${name}`,
              type: "function",
              function: { name, arguments: JSON.stringify(input) },
            },
          ],
        });
        emit({}, "tool_calls");
      } else {
        emit({ role: "assistant", content: "Desktop fixture complete" });
        emit({}, "stop");
      }
      response.end("data: [DONE]\n\n");
    });
    await new Promise((resolve) => provider.listen(0, "127.0.0.1", resolve));
  }
  let page;
  [app, page] = await launch();
  if (provider)
    await page.evaluate(
      async ({ fixture, port }) => {
        await window.desktop.customProvider({
          id: fixture.providerID,
          name: "Desktop E2E loopback fixture",
          model: fixture.id,
          runtime: "compatible",
          baseUrl: `http://127.0.0.1:${port}/v1`,
          key: "desktop-e2e-fixture-only",
          images: false,
          tools: true,
        });
        await window.desktop.savePreferences({ engineAutoCheck: false });
      },
      { fixture, port: provider.address().port },
    );
  await app.evaluate(({ dialog }, project) => {
    dialog.showOpenDialog = async () => ({
      canceled: false,
      filePaths: [project],
    });
  }, projectDir);
  await page
    .getByRole("button", { name: "Выбрать проект", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Открыть другую папку…", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Выбрать модель", exact: true })
    .click();
  const models = await page.evaluate(() => window.desktop.models());
  const targetModel = live
    ? { providerID: "opencode", id: "deepseek-v4.1-flash-free" }
    : fixture;
  const free = models.find(
    (m) => m.providerID === targetModel.providerID && m.id === targetModel.id,
  );
  assert.ok(free, "The designated fixture model must be available");
  await page
    .getByRole("button", { name: "Выбрать другую модель", exact: true })
    .click();
  await page.getByRole("menuitem", { name: /Найти и закрепить/ }).click();
  const catalog = page.getByRole("dialog", { name: "Каталог моделей" });
  await catalog.getByRole("combobox", { name: "Поиск моделей" }).fill(free.id);
  await catalog
    .getByRole("button", { name: `Закрепить модель ${free.name}`, exact: true })
    .click();
  await catalog
    .getByRole("button", { name: "Закрыть каталог моделей", exact: true })
    .click();
  await page.getByRole("button", { name: "Выбрать модель" }).click();
  await page
    .getByRole("button", { name: "Выбрать другую модель", exact: true })
    .click();
  await page.getByRole("menuitem").filter({ hasText: free.name }).click();
  await page
    .getByRole("textbox", { name: "Сообщение агенту" })
    .fill(
      "This is an isolated desktop integration test. Use read to inspect input.txt, create result.txt containing HELLO FORGE followed by a newline, then execute node check.mjs using shell. Do not modify other files. Finish with a short sentence. Do not use subagents.",
    );
  await page
    .getByRole("button", { name: "Отправить сообщение", exact: true })
    .click();
  await page.waitForSelector(".permission-card", { timeout: 90000 });
  await page.screenshot({ path: "test-results/desktop-permission.png" });
  let approvals = 0;
  const deadline = Date.now() + 100000;
  while (Date.now() < deadline) {
    const approve = page.getByRole("button", {
      name: "Разрешить один раз",
      exact: true,
    });
    if (await approve.count()) {
      const resource = await page
        .locator(".permission-card")
        .first()
        .innerText();
      assert.ok(
        resource.includes("result.txt") || resource.includes("node check.mjs"),
        "Only the intended fixture operation may be approved",
      );
      await approve.first().click();
      approvals++;
    }
    if (await page.locator('.run-summary[data-status="succeeded"]').count())
      break;
    await page.waitForTimeout(500);
  }
  assert.ok(approvals >= 2, "Write and shell requests must reach the UI");
  assert.equal(
    (await fs.readFile(path.join(projectDir, "result.txt"), "utf8")).trim(),
    "HELLO FORGE",
  );
  await revealActivity(page.locator(".action-group").last(), "shell");
  const shell = page
    .locator(".tool-summary")
    .filter({ hasText: /node check.mjs|check.mjs/ })
    .first();
  await shell.click();
  await page
    .locator(".tool-output")
    .getByText("FORGE_CHECK_OK", { exact: true })
    .waitFor();
  await page.screenshot({ path: "test-results/desktop-timeline.png" });
  console.log(
    "PASS real prompt, permission UI, read/write/shell and expandable output",
    { approvals },
  );
  await page
    .getByRole("button", { name: "Действия с задачей", exact: true })
    .click();
  await page.getByRole("button", { name: "Закрепить", exact: true }).click();
  await page
    .getByRole("button", { name: "Действия с задачей", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Изменения проекта", exact: true })
    .click();
  await page.getByRole("button", { name: "Эта задача", exact: true }).click();
  await page.locator(".diff-file").filter({ hasText: "result.txt" }).click();
  await page
    .getByRole("dialog")
    .locator(".diff-content")
    .getByText("HELLO FORGE", { exact: false })
    .waitFor();
  await page.screenshot({ path: "test-results/desktop-diff.png" });
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Закрыть", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Закрыть изменения", exact: true })
    .click();
  console.log("PASS authentic session diff and pin");
  await page
    .getByRole("textbox", { name: "Сообщение агенту" })
    .fill("Сохранённый черновик после перезапуска");
  await page.waitForTimeout(500);
  const state = await page.evaluate(() => window.desktop.bootstrap());
  const sessionId = state.preferences.sessionId;
  assert.ok(sessionId);
  const before = await page.evaluate(
    (id) => window.desktop.openSession(id),
    sessionId,
  );
  assert.equal(new Set(before.rows.map((r) => r.id)).size, before.rows.length);
  const prefs = await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].webContents.getLastWebPreferences(),
  );
  const runtime = await app.evaluate(({ app }) => ({
    packaged: app.isPackaged,
    resourcesPath: process.resourcesPath,
    electron: process.versions.electron,
  }));
  assert.equal(runtime.packaged, !!process.env.FORGE_PACKAGED);
  assert.equal(prefs.sandbox, true);
  assert.equal(prefs.contextIsolation, true);
  assert.equal(prefs.nodeIntegration, false);
  const rejected = await page.evaluate(async () => {
    try {
      await window.desktop.openExternal("file:///C:/Windows");
      return false;
    } catch {
      return true;
    }
  });
  assert.equal(rejected, true);
  await app.close();
  app = undefined;
  [app, page] = await launch();
  await page.getByRole("textbox", { name: "Сообщение агенту" }).waitFor();
  await page.waitForFunction(
    () =>
      document.querySelector("textarea")?.value ===
      "Сохранённый черновик после перезапуска",
  );
  const after = await page.evaluate(
    (id) => window.desktop.openSession(id),
    sessionId,
  );
  assert.equal(after.rows.length, before.rows.length);
  assert.equal(after.session.pinned, true);
  assert.equal(after.session.model.id, free.id);
  console.log(
    "PASS restart: history, exact model, project, pin, draft and sandbox settings",
  );
  for (const [width, height] of [
    [1440, 960],
    [1080, 720],
    [780, 600],
  ]) {
    await app.evaluate(
      ({ BrowserWindow }, size) =>
        BrowserWindow.getAllWindows()[0].setSize(...size),
      [width, height],
    );
    await page.waitForTimeout(250);
    const geometry = await page.evaluate(() => {
      const composer = document
          .querySelector(".composer")
          .getBoundingClientRect(),
        timeline = document
          .querySelector(".timeline-area")
          .getBoundingClientRect();
      return {
        overflow: document.documentElement.scrollWidth > innerWidth,
        input: {
          left: composer.left,
          right: composer.right,
          top: composer.top,
          bottom: composer.bottom,
        },
        timelineBottom: timeline.bottom,
        width: innerWidth,
        height: innerHeight,
      };
    });
    assert.equal(geometry.overflow, false);
    assert.ok(
      geometry.input.right <= geometry.width &&
        geometry.input.bottom <= geometry.height,
    );
    assert.ok(geometry.timelineBottom <= geometry.input.top);
    await page.screenshot({ path: `test-results/desktop-${width}.png` });
  }
  console.log("PASS desktop geometry at 1440, 1080 and 780 pixels");
  assert.deepEqual(errors, []);
  await fs.writeFile(
    process.env.FORGE_PACKAGED
      ? "test-results/desktop-packaged-verification.json"
      : "test-results/desktop-verification.json",
    JSON.stringify(
      {
        passed: true,
        packaged: !!process.env.FORGE_PACKAGED,
        runtime,
        dataDir,
        sessionId,
        model: `${free.providerID}/${free.id}`,
        approvals,
        rows: after.rows.length,
        sandbox: true,
        errors,
        sizes: [
          [1440, 960],
          [1080, 720],
          [780, 600],
        ],
      },
      null,
      2,
    ),
  );
} finally {
  if (app) await app.close();
  if (provider) {
    provider.closeAllConnections();
    await new Promise((resolve) => provider.close(resolve));
  }
}
