import { selectValue } from "./select-ui.mjs";
import { _electron as electron, expect } from "playwright/test";
import { Service } from "@opencode/client/service";
import { OpenCode } from "@opencode/client";
import fs from "node:fs/promises";
import path from "node:path";
import http from "node:http";
import assert from "node:assert/strict";

// Only loopback fixtures and an isolated Forge/OpenCode profile are used.
const directory = path.resolve(`.runtime/context-ui-${process.pid}`);
const folder = path.join(directory, "Мастерская"),
  providerID = "context-fixture";
const model = { id: "fixture", providerID };
const written = path.join(folder, "executed.txt"),
  forbidden = path.join(folder, "forbidden.txt");
const mcpMarker = path.join(directory, "mcp-started.txt");
const requests = [],
  errors = [],
  issued = new Set();
let app, page, client;
await fs.mkdir(path.join(folder, ".opencode/skills/forge-context"), {
  recursive: true,
});
await fs.writeFile(
  path.join(folder, ".opencode/skills/forge-context/SKILL.md"),
  "---\nname: forge-context\ndescription: Isolated project planning skill\n---\nFORGE_SKILL_CONTENT_7254: Verify the project carefully.\n",
);
await fs.writeFile(
  path.join(folder, "readme.txt"),
  "DO_NOT_INCLUDE_FILE_CONTENTS",
);
await fs.mkdir("test-results", { recursive: true });
const server = http.createServer(async (req, res) => {
  if (!req.url?.endsWith("/chat/completions"))
    return void res.writeHead(404).end();
  let raw = "";
  for await (const c of req) raw += c;
  const body = JSON.parse(raw);
  requests.push(body);
  res.writeHead(200, { "Content-Type": "text/event-stream" });
  const chunk = (delta, finish_reason = null) =>
    res.write(
      `data: ${JSON.stringify({ id: `context-${requests.length}`, object: "chat.completion.chunk", created: 1, model: body.model, choices: [{ index: 0, delta, finish_reason }] })}\n\n`,
    );
  const user = JSON.stringify(
    body.messages.filter((m) => m.role === "user").at(-1),
  );
  const marker = user.includes("FORGE_PLAN_NEGATIVE")
    ? "plan"
    : user.includes("FORGE_EXECUTE_POSITIVE")
      ? "execute"
      : undefined;
  if (marker && !issued.has(marker)) {
    issued.add(marker);
    const file = marker === "plan" ? forbidden : written;
    chunk({
      role: "assistant",
      tool_calls: [
        {
          index: 0,
          id: `call_${marker}`,
          type: "function",
          function: {
            name: "shell",
            arguments: JSON.stringify({
              command: `echo LOCAL_FIXTURE > "${file.replaceAll("\\", "/")}"`,
              description: "Isolated planning permission fixture",
            }),
          },
        },
      ],
    });
    chunk({}, "tool_calls");
  } else {
    chunk({ role: "assistant", content: "CONTEXT_FIXTURE_OK" });
    chunk({}, "stop");
  }
  res.end("data: [DONE]\n\n");
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const config = path.join(directory, "engine/config/opencode/opencode.json");
await fs.mkdir(path.dirname(config), { recursive: true });
await fs.writeFile(
  config,
  JSON.stringify({
    providers: {
      [providerID]: {
        name: "Context Local Fixture",
        package: "@opencode/ai/providers/openai-compatible",
        settings: { baseURL: `http://127.0.0.1:${server.address().port}/v1` },
        models: {
          fixture: {
            name: "Forge Fixture",
            capabilities: { tools: true, input: ["text"], output: ["text"] },
          },
        },
      },
    },
  }),
);
const mcpFile = path.join(directory, "mcp-fixture.mjs");
await fs.writeFile(
  mcpFile,
  String.raw`import readline from 'node:readline';import fs from 'node:fs';fs.appendFileSync(${JSON.stringify(mcpMarker)},'started\n');readline.createInterface({input:process.stdin}).on('line',line=>{try{const q=JSON.parse(line);if(q.id===undefined)return;const result=q.method==='initialize'?{protocolVersion:q.params.protocolVersion,capabilities:{tools:{}},serverInfo:{name:'forge-fixture',version:'1'}}:q.method==='tools/list'?{tools:[{name:'ping',description:'Local fixture',inputSchema:{type:'object',properties:{}}}]}:q.method==='tools/call'?{content:[{type:'text',text:'pong'}]}:{};process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:q.id,result})+'\n');}catch{}});`,
);
const button = (name) =>
  page.getByRole("button", { name: new RegExp("^" + name + "(?:$|\\s)") });
const add = async () => {
  await button("Add files and capabilities").click();
  await page.waitForTimeout(200);
  await expect(page.locator(".composer-add-panel.is-open")).toBeVisible();
};
const prompt = () =>
  page.getByRole("textbox", { name: "Message the agent", exact: true });
async function capture(name) {
  await page.waitForTimeout(200);
  const data = await app.evaluate(async ({ BrowserWindow }) =>
    (await BrowserWindow.getAllWindows()[0].capturePage())
      .toPNG()
      .toString("base64"),
  );
  await fs.writeFile(`test-results/${name}.png`, Buffer.from(data, "base64"));
}
async function launch() {
  const packaged = process.argv.includes("--packaged");
  app = await electron.launch({
    executablePath: packaged
      ? path.resolve("release/win-unpacked/Rote Coding Fraktion.exe")
      : undefined,
    args: packaged ? [] : ["."],
    env: { ...process.env, FORGE_DATA_DIR: directory },
    timeout: 30000,
  });
  page = await app.firstWindow();
  page.on("pageerror", (e) => errors.push(e.message));
  await page.waitForSelector(".status-dot.ready", { timeout: 45000 });
}
async function idle(id) {
  await expect
    .poll(
      async () => {
        const info = await client.session.get({ sessionID: id });
        return !!info.outcome && !(await client.session.active())[id];
      },
      { timeout: 20000 },
    )
    .toBe(true);
  await expect(button("Stop agent")).toHaveCount(0, { timeout: 10000 });
}
async function prefs() {
  return page.evaluate(
    async () => (await window.desktop.bootstrap()).preferences,
  );
}
async function layout(name) {
  await page.waitForTimeout(180);
  const issues = await page.evaluate(() => {
    const bad = [];
    for (const selector of [
      ".composer-context-bar",
      ".composer-toolbar",
      ".composer-surface.is-open",
      ".send-button",
    ]) {
      for (const el of document.querySelectorAll(selector)) {
        const r = el.getBoundingClientRect();
        if (
          r.width &&
          (r.left < -0.5 ||
            r.top < 31 ||
            r.right > innerWidth + 0.5 ||
            r.bottom > innerHeight + 0.5)
        )
          bad.push({
            selector,
            x: r.x,
            y: r.y,
            w: r.width,
            h: r.height,
            vw: innerWidth,
            vh: innerHeight,
          });
      }
    }
    return bad;
  });
  assert.deepEqual(issues, [], name);
  const panel = page.locator(".composer-add-panel.is-open");
  if (await panel.count()) {
    const bounds = await page.evaluate(() => {
      const panel = document
          .querySelector(".composer-add-panel.is-open")
          .getBoundingClientRect(),
        composer = document.querySelector(".composer").getBoundingClientRect();
      return {
        width: Math.abs(panel.width - composer.width),
        left: Math.abs(panel.left - composer.left),
        gap: composer.top - panel.bottom,
        compact: [...document.querySelectorAll(".add-list-row")].every(
          (el) => el.getBoundingClientRect().height <= 30,
        ),
        inline: [...document.querySelectorAll(".add-list-row")].every((el) => {
          const label = el.querySelector("strong")?.getBoundingClientRect(),
            description = el
              .querySelector(".add-row-description")
              ?.getBoundingClientRect();
          return (
            !label || !description || Math.abs(label.top - description.top) < 1
          );
        }),
      };
    });
    assert.ok(
      bounds.width < 1 && bounds.left < 1 && bounds.gap >= 4,
      `${name}: panel must match composer and sit above attachments ${JSON.stringify(bounds)}`,
    );
    assert.ok(
      bounds.compact && bounds.inline,
      "Labels and descriptions must stay compact on one line",
    );
  }
  await capture(name);
}
try {
  await launch();
  const endpoint = await Service.discover({
    file: path.join(directory, "engine/state/opencode/service.json"),
    version: "2.3.0",
  });
  client = OpenCode.make({
    baseUrl: endpoint.url,
    headers: Service.headers(endpoint),
  });
  await client.credential.create({
    integrationID: providerID,
    value: { type: "key", key: "local-fixture-only" },
    activate: true,
  });
  await client.location.reload();
  await page.evaluate(
    (model) =>
      window.desktop.savePreferences({
        language: "en",
        model,
        mode: "autonomous",
      }),
    model,
  );
  await page.reload();
  await page.waitForSelector(".status-dot.ready");
  await expect(page.locator(".welcome h1")).toHaveText(
    "What should we work on?",
  );
  await expect(button("Choose project")).toBeVisible();
  await capture("context-welcome");
  await button("Execution environment").click();
  await button("Environments").click();
  await button("Manage environments").click();
  await expect(page.locator(".environment-directory code")).toContainText(
    "tasks",
  );
  await layout("context-environment");
  await page.keyboard.press("Escape");
  await page.keyboard.press("Escape");
  await app.evaluate(({ dialog }, folder) => {
    dialog.showOpenDialog = async () => ({
      canceled: false,
      filePaths: [folder],
    });
  }, folder);
  const project = await page.evaluate(() => window.desktop.addProject());
  await expect(page.locator(".project-row")).toHaveCount(1);
  await prompt().fill("Draft survives context changes");
  await button("Choose project").click();
  await page
    .locator(".project-context-panel")
    .getByRole("button")
    .filter({ hasText: "Мастерская" })
    .click();
  await expect(prompt()).toHaveValue("Draft survives context changes");
  await button("Detach project from chat").click();
  await expect(button("Choose project")).toBeVisible();
  await expect(prompt()).toHaveValue("Draft survives context changes");
  await page.keyboard.press("Control+Alt+Shift+o");
  await page
    .locator(".project-context-panel")
    .getByRole("button")
    .filter({ hasText: "Мастерская" })
    .click();
  await add();
  await page.getByRole("switch", { name: /Planning mode/ }).click();
  await expect(button("Turn off planning mode")).toBeVisible();
  await add();
  await page
    .getByRole("checkbox", { name: /forge-context/ })
    .click({ timeout: 15000 });
  await page.keyboard.press("Escape");
  await expect(page.locator(".skill-context-chip")).toContainText(
    "forge-context",
  );
  await add();
  await button("Code or command context").click();
  await page
    .getByRole("textbox", { name: "Context name", exact: true })
    .fill("fixture-output");
  await page
    .getByRole("textbox", { name: "Context text", exact: true })
    .fill("FORGE_CONTEXT_TEXT_6412");
  await button("Attach context").click();
  await expect(page.locator(".attachment-chip")).toHaveCount(1);
  await add();
  await button("Attach folder").click();
  await expect(page.locator(".attachment-chip")).toHaveCount(2);
  await add();
  await layout("add-menu-with-attachments");
  await page.keyboard.press("Escape");
  // Connect a real stdio MCP fixture through the actual Add server form.
  await add();
  await button("Add MCP server").click();
  await page
    .getByRole("textbox", { name: "MCP server name" })
    .fill("fixture-tools");
  await selectValue(page.getByRole("combobox", { name: "MCP connection type" }), "local");
  await page
    .getByRole("textbox", { name: "MCP address or command" })
    .fill(JSON.stringify([process.execPath, mcpFile]));
  await button("Save server").click();
  await expect(button("Connect fixture-tools")).toBeVisible();
  await assert.rejects(fs.access(mcpMarker), /ENOENT/);
  await button("Connect fixture-tools").click();
  await expect(button("Disconnect fixture-tools")).toBeVisible({
    timeout: 20000,
  });
  await fs.access(mcpMarker);
  await button("Disconnect fixture-tools").click();
  await expect(button("Connect fixture-tools")).toBeVisible();
  await button("Connect fixture-tools").click();
  await expect(button("Disconnect fixture-tools")).toBeVisible({
    timeout: 20000,
  });
  await capture("context-mcp");
  await page.keyboard.press("Escape");
  await page.keyboard.press("Escape");
  // Existing drafts, attachments and choices survive a context picker round trip.
  await page.keyboard.press("Control+Alt+Shift+o");
  await page.keyboard.press("Escape");
  await expect(page.locator(".attachment-chip")).toHaveCount(2);
  await prompt().fill("FORGE_PLAN_NEGATIVE");
  await button("Send message").click();
  await expect
    .poll(async () => (await prefs()).sessionId, { timeout: 15000 })
    .toBeTruthy();
  const sessionId = (await prefs()).sessionId;
  await idle(sessionId);
  assert.ok(issued.has("plan"));
  await assert.rejects(fs.access(forbidden), /ENOENT/);
  for (const action of [
    "shell",
    "edit",
    "subagent",
    "mcp.fixture-tools.ping",
    "external_directory",
  ]) {
    assert.equal(
      (
        await client.permission.create(
          { sessionID: sessionId, action, resources: ["*"] },
          { signal: AbortSignal.timeout(3000) },
        )
      ).effect,
      "deny",
    );
  }
  assert.equal(
    (
      await client.permission.create({
        sessionID: sessionId,
        action: "read",
        resources: ["*"],
      })
    ).effect,
    "allow",
  );
  assert.ok(
    requests.some((b) =>
      JSON.stringify(b.messages).includes("Planning mode is active"),
    ),
  );
  assert.ok(
    requests.some((b) =>
      JSON.stringify(b.messages).includes("FORGE_SKILL_CONTENT_7254"),
    ),
    "Selected skill reached real prompt",
  );
  assert.ok(
    requests.some((b) =>
      JSON.stringify(b.messages).includes("FORGE_CONTEXT_TEXT_6412"),
    ),
    "Text context reached provider",
  );
  assert.ok(
    requests.some((b) => JSON.stringify(b.messages).includes("readme.txt")),
    "Folder listing reached provider",
  );
  assert.ok(
    !requests.some((b) =>
      JSON.stringify(b.messages).includes("DO_NOT_INCLUDE_FILE_CONTENTS"),
    ),
  );
  const wire = await client.message.list({ sessionID: sessionId, limit: 100 });
  assert.ok(wire.data.some((m) => m.type === "user" && m.skills?.length));
  await button("Turn off planning mode").click();
  await prompt().fill("FORGE_EXECUTE_POSITIVE");
  await button("Send message").click();
  await expect
    .poll(
      () =>
        fs
          .readFile(written)
          .then((buffer) =>
            buffer[0] === 255 && buffer[1] === 254
              ? buffer.toString("utf16le")
              : buffer.toString("utf8"),
          )
          .catch(() => ""),
      {
        timeout: 20000,
      },
    )
    .toContain("LOCAL_FIXTURE");
  await idle(sessionId);
  // Detach an existing chat: same history and new real working directory, no file copying.
  await button("Detach project from chat").click();
  await expect(button("Choose project")).toBeVisible({ timeout: 15000 });
  const moved = await client.session.get({ sessionID: sessionId });
  assert.ok(moved.location.directory.startsWith(path.join(directory, "tasks")));
  await fs.access(written);
  assert.equal((await prefs()).sessionId, sessionId);
  const state = await page.evaluate(() => window.desktop.bootstrap());
  assert.ok(
    state.projects.find((p) => p.path === moved.location.directory)?.managed,
  );
  await expect(page.locator(".project-row")).toHaveCount(1);
  await expect(page.locator(".timeline-area")).toContainText(
    "FORGE_EXECUTE_POSITIVE",
  );
  await button("Choose project").click();
  await page
    .locator(".project-context-panel")
    .getByRole("button")
    .filter({ hasText: "Мастерская" })
    .click();
  await expect.poll(async () => (await prefs()).projectId).toBe(project.id);
  assert.equal((await prefs()).sessionId, sessionId);
  await expect(page.locator(".timeline-area")).toContainText(
    "FORGE_PLAN_NEGATIVE",
  );
  await button("Detach project from chat").click();
  await expect(button("Choose project")).toBeVisible();
  await page.keyboard.press("Control+n");
  await expect(page.locator(".welcome h1")).toBeVisible();
  await expect(button("Choose project")).toBeVisible();
  await prompt().fill("PROJECTLESS_MESSAGE");
  await button("Send message").click();
  await expect
    .poll(
      async () => {
        const id = (await prefs()).sessionId;
        return !!id && id !== sessionId;
      },
      { timeout: 15000 },
    )
    .toBe(true);
  const detachedId = (await prefs()).sessionId;
  await idle(detachedId);
  const detached = await client.session.get({ sessionID: detachedId });
  assert.ok(
    detached.location.directory.startsWith(path.join(directory, "tasks")),
  );
  assert.notEqual(detached.location.directory, moved.location.directory);
  await expect(page.locator(".recents-section .session-row")).toHaveCount(2);
  await page.keyboard.press("Control+n");
  await prompt().fill("Saved neutral draft");
  await add();
  await page
    .getByRole("button", { name: /^Attach chat / })
    .first()
    .click();
  await expect(page.locator(".attachment-chip")).toHaveCount(1);
  assert.equal(
    (await prefs()).sessionId,
    undefined,
    "Attaching context must not navigate into the source chat",
  );
  await page.locator(".attachment-preview-button").first().click();
  await expect(page.locator(".attachment-text-preview")).toContainText(
    /FORGE_PLAN_NEGATIVE|PROJECTLESS_MESSAGE/,
  );
  await page.keyboard.press("Escape");
  await page.locator(".attachment-chip .icon-button").click();
  await add();
  await page.getByRole("switch", { name: /Planning mode/ }).click();
  await page.waitForTimeout(400);
  await page.reload();
  await expect(prompt()).toHaveValue("Saved neutral draft");
  await expect(button("Turn off planning mode")).toBeVisible();
  for (const [w, h, zoom] of [
    [1440, 900, 1],
    [780, 600, 1],
    [1080, 760, 1.5],
    [1080, 800, 2],
  ]) {
    await app.evaluate(
      ({ BrowserWindow }, [w, h, z]) => {
        const win = BrowserWindow.getAllWindows()[0];
        win.setSize(w, h);
        win.webContents.setZoomFactor(z);
      },
      [w, h, zoom],
    );
    await page.waitForTimeout(180);
    if (
      (await page.evaluate(() => innerWidth <= 650)) &&
      (await button("Hide sidebar").isVisible())
    )
      await button("Hide sidebar").click();
    await layout(`context-${w}-${zoom}-closed`);
    await add();
    await layout(`context-${w}-${zoom}-add`);
    const menu = page.locator(".composer-add-panel");
    await menu.hover();
    await page.mouse.wheel(0, 260);
    await page.waitForTimeout(120);
    assert.ok(
      await menu.evaluate((el) => el.scrollTop > 0),
      "One shared list must scroll",
    );
    await page.keyboard.press("Home");
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("Escape");
    await expect(button("Add files and capabilities")).toBeFocused();
    await button("Choose project").click();
    await layout(`context-${w}-${zoom}-project`);
    await page.keyboard.press("Escape");
  }
  await app.evaluate(({ BrowserWindow }) => {
    const w = BrowserWindow.getAllWindows()[0];
    w.webContents.setZoomFactor(1);
    w.setSize(1440, 900);
  });
  await page.evaluate(() =>
    window.desktop.savePreferences({ language: "ru", animations: false }),
  );
  await page.reload();
  await expect(
    page.getByRole("button", { name: "Выбрать проект", exact: true }),
  ).toBeVisible();
  await expect(page.locator("html")).toHaveAttribute("data-motion", "reduced");
  await page
    .getByRole("button", { name: "Добавить файлы и возможности", exact: true })
    .click();
  await layout("context-add-ru");
  assert.deepEqual(errors, []);
  console.log(
    "PASS real planning denials and post-plan shell execution; skills in prompt; MCP add/connect/disconnect transport; context attachments; project detach/history; isolated projectless tasks; draft persistence; keyboard, RU/EN and 100/150/200% layouts",
  );
} catch (error) {
  await capture("context-failure").catch(() => {});
  throw error;
} finally {
  if (app) await app.close().catch(() => {});
  server.closeAllConnections();
  await new Promise((r) => server.close(r));
}
