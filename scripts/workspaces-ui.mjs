import { _electron as electron } from "playwright";
import { Service } from "@opencode/client/service";
import { OpenCode } from "@opencode/client";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import http from "node:http";

// An isolated application profile and a loopback provider keep user projects,
// existing engine history and paid-provider credentials outside this test.
const directory = path.resolve(`.runtime/workspaces-ui-${process.pid}`);
const projectPath = path.join(directory, "Проверка пространств");
const providerID = "workspace-local-fixture";
const model = { id: "fixture", providerID };
const marker = "КИРИЛЛИЦА_МИШЕНЬ_5241";
const errors = [];
let app,
  page,
  requests = 0;
const server = http.createServer(async (request, response) => {
  if (request.url !== "/v1/chat/completions")
    return void response.writeHead(404).end();
  for await (const _chunk of request) {
    /* Drain fixture input without logging it. */
  }
  requests++;
  response.writeHead(200, { "Content-Type": "text/event-stream" });
  for (const [delta, finish_reason] of [
    [{ role: "assistant", content: "LOCAL_WORKSPACE_FIXTURE_OK" }, null],
    [{}, "stop"],
  ])
    response.write(
      `data: ${JSON.stringify({ id: `workspace-fixture-${requests}`, object: "chat.completion.chunk", created: 1, model: model.id, choices: [{ index: 0, delta, finish_reason }] })}\n\n`,
    );
  response.end("data: [DONE]\n\n");
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
await fs.mkdir(projectPath, { recursive: true });
await fs.mkdir("test-results", { recursive: true });
const configPath = path.join(directory, "engine/config/opencode/opencode.json");
await fs.mkdir(path.dirname(configPath), { recursive: true });
await fs.writeFile(
  configPath,
  JSON.stringify({
    providers: {
      [providerID]: {
        name: "Workspace Local Fixture",
        package: "@opencode/ai/providers/openai-compatible",
        settings: { baseURL: `http://127.0.0.1:${server.address().port}/v1` },
        models: {
          [model.id]: {
            name: "Workspace Fixture",
            capabilities: { tools: true, input: ["text"], output: ["text"] },
          },
        },
      },
    },
  }),
);

async function switchTo(workspace) {
  await page
    .getByRole("button", {
      name: "Переключить рабочее пространство",
      exact: true,
    })
    .click();
  await page
    .getByRole("menuitemradio", {
      name: new RegExp(workspace === "chat" ? "Chat Faction" : "Work Faction"),
    })
    .click();
  await page
    .locator(".faction-switcher small:visible")
    .filter({ hasText: workspace === "chat" ? "Chat Faction" : "Work Faction" })
    .waitFor();
}

try {
  app = await electron.launch({
    args: ["."],
    env: { ...process.env, FORGE_DATA_DIR: directory },
    timeout: 30000,
  });
  page = await app.firstWindow();
  page.on("pageerror", (error) => errors.push(error.message));
  await page.waitForSelector(".status-dot.ready", { timeout: 45000 });
  await app.evaluate(({ dialog }, folder) => {
    dialog.showOpenDialog = async () => ({
      canceled: false,
      filePaths: [folder],
    });
  }, projectPath);
  const project = await page.evaluate(() => window.desktop.addProject());
  const endpoint = await Service.discover({
    file: path.join(directory, "engine/state/opencode/service.json"),
    version: "2.3.0",
  });
  assert.ok(endpoint);
  const client = OpenCode.make({
    baseUrl: endpoint.url,
    headers: Service.headers(endpoint),
  });
  await client.credential.create({
    integrationID: providerID,
    value: { type: "key", key: "workspace-loopback-fixture-only" },
    activate: true,
  });
  await client.location.reload();
  const createHistory = async (workspace, title, count, offset) => {
    const info = await client.session.create({
      location: { directory: projectPath },
      model,
      title,
      metadata: { forgeWorkspace: workspace, forgeMode: "cautious" },
      permissions: [
        {
          action: "*",
          resource: "*",
          effect: workspace === "chat" ? "deny" : "ask",
        },
      ],
    });
    await client.session.remove({ sessionID: info.id });
    const messages = Array.from({ length: count }, (_, i) => ({
      id: `msg_${(0x10000000000 + offset + i).toString(16)}qa${String(offset + i).padStart(10, "0")}`,
      type: "user",
      time: { created: info.time.created + i * 10 },
      text:
        workspace === "chat" && i === 8
          ? `${marker}: сохранить существующую архитектуру.`
          : `${workspace === "chat" ? "Обсуждение" : "Рабочая задача"} ${i + 1}`,
    }));
    messages.push({
      id: `msg_${(0x10000000000 + offset + count).toString(16)}qa${String(offset + count).padStart(10, "0")}`,
      type: "assistant",
      agent: "build",
      model,
      time: {
        created: info.time.created + count * 10,
        completed: info.time.created + count * 10 + 1,
      },
      content: [
        { type: "reasoning", text: "HIDDEN_REASONING_MUST_NOT_REACH_UI" },
        {
          type: "text",
          text:
            workspace === "chat"
              ? "Согласован план: сохранить данные и проверить интерфейс."
              : "Рабочая история сохранена.",
        },
      ],
    });
    await client.experimental.session.import({
      info,
      location: { directory: projectPath },
      messages,
    });
    return info;
  };
  const work = await createHistory("work", "WORK_VISIBLE_ONLY", 2, 1000);
  const chat = await createHistory("chat", "CHAT_VISIBLE_ONLY", 180, 2000);
  await page.evaluate(
    async ({ projectId, sessionId, model }) =>
      window.desktop.savePreferences({
        projectId,
        sessionId,
        workspace: "work",
        model,
        favoriteModels: [model],
      }),
    { projectId: project.id, sessionId: work.id, model },
  );
  await page.reload();
  await page
    .locator(`.projects-section .session-row[data-session-id="${work.id}"]`)
    .waitFor();
  assert.equal(
    await page
      .locator(`.projects-section .session-row[data-session-id="${chat.id}"]`)
      .count(),
    0,
  );
  await page.getByText("Рабочая история сохранена.", { exact: true }).waitFor();
  await switchTo("chat");
  await page
    .locator(`.projects-section .session-row[data-session-id="${chat.id}"]`)
    .waitFor();
  assert.equal(
    await page
      .locator(`.projects-section .session-row[data-session-id="${work.id}"]`)
      .count(),
    0,
  );
  await page
    .locator(
      `.projects-section .session-row[data-session-id="${chat.id}"] .session-link`,
    )
    .click();
  await page
    .getByText("Согласован план: сохранить данные и проверить интерфейс.", {
      exact: true,
    })
    .waitFor();
  assert.equal(
    await page
      .getByText("HIDDEN_REASONING_MUST_NOT_REACH_UI", { exact: false })
      .count(),
    0,
  );
  await switchTo("work");
  await page.getByText("Рабочая история сохранена.", { exact: true }).waitFor();
  await switchTo("chat");
  await page
    .getByText("Согласован план: сохранить данные и проверить интерфейс.", {
      exact: true,
    })
    .waitFor();
  console.log(
    "PASS workspace switch preserves separate histories and restores the selected chat",
  );

  await page.getByRole("button", { name: "Настройки", exact: true }).click();
  await page.locator(".settings-screen").waitFor();
  await page.keyboard.press("Control+k");
  const search = page.getByRole("combobox", {
    name: "Поиск по истории",
    exact: true,
  });
  await search.fill(marker.toLocaleLowerCase());
  await page.getByRole("option").filter({ hasText: marker }).waitFor();
  await search.press("ArrowDown");
  await search.press("Enter");
  const hit = page
    .locator(".timeline-item.search-hit")
    .filter({ hasText: marker });
  await hit.waitFor({ timeout: 15000 });
  assert.equal(
    await page.locator(".settings-screen").count(),
    0,
    "Search result leaves Settings for the conversation",
  );
  await page.waitForFunction(
    (marker) => {
      const element = [
        ...document.querySelectorAll(".timeline-item.search-hit"),
      ].find((el) => el.textContent.includes(marker));
      const scroll = element?.closest(".timeline-scroll");
      if (!element || !scroll) return false;
      const bounds = element.getBoundingClientRect(),
        viewport = scroll.getBoundingClientRect();
      return bounds.bottom > viewport.top && bounds.top < viewport.bottom;
    },
    marker,
    { timeout: 15000 },
  );
  await page.screenshot({ path: "test-results/workspaces-search-jump.png" });
  console.log(
    "PASS Ctrl+K, Unicode content search, arrow/Enter selection and highlighted older-message jump",
  );

  const denied = await page.evaluate(async (sessionId) => {
    try {
      await window.desktop.permission(
        sessionId,
        "req_fixture_never_exists",
        "once",
      );
      return false;
    } catch (error) {
      return error.message.includes("Chat Faction");
    }
  }, chat.id);
  assert.equal(denied, true, "Direct renderer IPC cannot approve Chat tools");
  const fork = await page.evaluate(
    ({ sessionId, projectId }) =>
      window.desktop.forkSession(sessionId, projectId),
    { sessionId: chat.id, projectId: project.id },
  );
  assert.equal(fork.workspace, "chat");
  const forkInfo = await client.session.get({ sessionID: fork.id });
  assert.equal(forkInfo.metadata.forgeWorkspace, "chat");
  for (const action of [
    "edit",
    "shell",
    "subagent",
    "mcp.fixture",
    "plugin.fixture",
    "external_directory",
  ])
    assert.equal(
      (
        await client.permission.create(
          { sessionID: fork.id, action, resources: ["*"] },
          { signal: AbortSignal.timeout(3000) },
        )
      ).effect,
      "deny",
    );
  const transcript = await page.evaluate(
    (sessionId) => window.desktop.refreshSession(sessionId),
    chat.id,
  );
  assert.equal(
    JSON.stringify(transcript).includes("HIDDEN_REASONING_MUST_NOT_REACH_UI"),
    false,
  );
  console.log(
    "PASS direct Chat permission approval is rejected, forks retain engine denials and reasoning is absent from IPC snapshots",
  );

  const handoffText =
    "Цель: HANDOFF_USER_APPROVED_8162\nПлан: проверить интерфейс.\nОграничения: сохранить данные.";
  const beforeHandoff = requests;
  await page
    .getByRole("button", { name: "В Work Faction", exact: true })
    .click();
  await page
    .getByRole("textbox", { name: "Контекст для Work Faction", exact: true })
    .fill(handoffText);
  await page
    .getByRole("button", { name: "Создать задачу с черновиком", exact: true })
    .click();
  await page
    .locator(".faction-switcher small:visible")
    .filter({ hasText: "Work Faction" })
    .waitFor();
  const editor = page.getByRole("textbox", {
    name: "Сообщение агенту",
    exact: true,
  });
  await editor.waitFor();
  await page.waitForFunction(
    (expected) =>
      document.querySelector('textarea[aria-label="Сообщение агенту"]')
        ?.value === expected,
    handoffText,
  );
  const state = await page.evaluate(() => window.desktop.bootstrap());
  const handoff = await client.session.get({
    sessionID: state.preferences.sessionId,
  });
  assert.notEqual(handoff.id, work.id);
  assert.notEqual(handoff.id, chat.id);
  assert.equal(handoff.metadata.forgeWorkspace, "work");
  assert.equal(
    (
      await client.message.list({ sessionID: handoff.id, limit: 10 })
    ).data.filter((message) => message.type === "user").length,
    0,
  );
  assert.equal(
    requests,
    beforeHandoff,
    "Handoff creates a draft without contacting a model",
  );
  assert.equal(
    await page.evaluate(
      (sessionId) => window.desktop.loadDraft(sessionId),
      handoff.id,
    ),
    handoffText,
  );
  assert.deepEqual(errors, []);
  await page.screenshot({ path: "test-results/workspaces-handoff-draft.png" });
  const layouts = [];
  for (const [width, height, zoom] of [
    [1440, 960, 1],
    [780, 600, 1],
    [1440, 960, 1.25],
    [1440, 960, 1.5],
    [1440, 960, 2],
    [780, 600, 2],
  ]) {
    await app.evaluate(
      ({ BrowserWindow }, values) => {
        const win = BrowserWindow.getAllWindows()[0];
        win.setSize(values[0], values[1]);
        win.webContents.setZoomFactor(values[2]);
      },
      [width, height, zoom],
    );
    await page.waitForTimeout(120);
    const hide = page.getByRole("button", {
      name: "Скрыть боковую панель",
      exact: true,
    });
    if (
      width / zoom < 650 &&
      (await hide.count()) &&
      (await hide.isVisible())
    ) {
      await hide.focus();
      await page.keyboard.press("Enter");
      await page.locator(".sidebar").waitFor({ state: "detached" });
      await page.waitForTimeout(150);
    }
    const layout = await page.evaluate(() => ({
      width: innerWidth,
      height: innerHeight,
      overflow: document.documentElement.scrollWidth > innerWidth,
      composerOverflow:
        document.querySelector(".composer").scrollWidth >
        document.querySelector(".composer").clientWidth,
    }));
    assert.equal(layout.overflow, false, JSON.stringify(layout));
    assert.equal(layout.composerOverflow, false, JSON.stringify(layout));
    layouts.push({ ...layout, zoom });
    if (zoom === 2) {
      const bytes = await app.evaluate(async ({ BrowserWindow }) =>
        (await BrowserWindow.getAllWindows()[0].capturePage())
          .toPNG()
          .toString("base64"),
      );
      await fs.writeFile(
        "test-results/workspace-" + width + "-scale-" + zoom + ".png",
        Buffer.from(bytes, "base64"),
      );
    }
  }
  await fs.writeFile(
    "test-results/workspace-layouts.json",
    JSON.stringify(layouts, null, 2),
  );

  await fs.writeFile(
    "test-results/workspaces-verification.json",
    JSON.stringify(
      {
        passed: true,
        engineVersion: "2.3.0",
        importedFixture: true,
        localProviderRequests: requests,
        checks: [
          "separate workspace histories",
          "selected session restored",
          "Ctrl+K Unicode content search",
          "keyboard selection and older-message jump",
          "Chat permission IPC rejection",
          "Chat fork retains engine denials",
          "reasoning absent from UI and snapshots",
          "explicit Work handoff preserves draft without sending",
        ],
      },
      null,
      2,
    ),
  );
  console.log(
    "PASS explicit handoff creates a Work task with the approved draft and never auto-sends",
  );
} catch (error) {
  if (page)
    await page
      .screenshot({ path: "test-results/workspaces-failure.png" })
      .catch(() => {});
  throw error;
} finally {
  await app?.close().catch(() => {});
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
}
