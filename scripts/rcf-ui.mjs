import { selectList, selectValue } from "./select-ui.mjs";
import { _electron as electron } from "playwright";
import fs from "node:fs/promises";
import path from "node:path";
import http from "node:http";
import assert from "node:assert/strict";
const qa = JSON.parse(
  await fs.readFile("test-results/rcf-integration.json", "utf8"),
);
const profile = path.join(qa.directory, "profile");
const packaged = !!process.env.RCF_PACKAGED;
const prefix = `test-results/refinement${packaged ? "-packaged" : ""}`;
const errors = [],
  layouts = [],
  requests = [];
const server = http.createServer(async (req, res) => {
  if (!req.url?.endsWith("/chat/completions"))
    return void res.writeHead(404).end();
  let raw = "";
  for await (const chunk of req) raw += chunk;
  const body = JSON.parse(raw);
  requests.push({
    model: body.model,
    reader: /^GUI (?:stopped )?researcher \d+$/.test(
      body.messages
        .filter((m) => m.role === "user")
        .map((m) =>
          typeof m.content === "string"
            ? m.content
            : m.content.map((p) => p.text ?? "").join(""),
        )
        .at(-1)
        ?.trim() ?? "",
    ),
    tools: body.tools?.map((t) => t.function?.name) ?? [],
  });
  res.writeHead(200, { "Content-Type": "text/event-stream" });
  const emit = (delta, finish_reason = null) =>
    res.write(
      `data: ${JSON.stringify({ id: "refinement-fixture", object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model: body.model, choices: [{ index: 0, delta, finish_reason }] })}\n\n`,
    );
  emit({ role: "assistant", content: "" });
  const timer = setTimeout(
    () => {
      if (res.destroyed) return;
      emit({ content: "GUI_RESEARCH_OK — project inspected without changes." });
      emit({}, "stop");
      res.end("data: [DONE]\n\n");
    },
    JSON.stringify(
      body.messages.filter((m) => m.role === "user").at(-1),
    ).includes("GUI stopped researcher")
      ? 45000
      : 3500,
  );
  res.once("close", () => clearTimeout(timer));
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
let app;
const launch = () =>
  electron.launch({
    args: packaged ? [] : ["."],
    executablePath: process.env.RCF_PACKAGED || undefined,
    env: { ...process.env, FORGE_DATA_DIR: profile },
    timeout: 30000,
  });
const screenshot = (page, name) =>
  page.screenshot({ path: `${prefix}-${name}.png` });
try {
  app = await launch();
  let page = await app.firstWindow();
  page.on("pageerror", (e) => errors.push(e.message));
  await page.waitForSelector(".status-dot.ready", { timeout: 45000 });
  await app.evaluate(({ dialog }) => {
    globalThis.__rcfDecision = 0;
    globalThis.__rcfConfirmations = 0;
    dialog.showMessageBox = async () => {
      globalThis.__rcfConfirmations++;
      return { response: globalThis.__rcfDecision, checkboxChecked: false };
    };
  });
  await page.evaluate(() =>
    window.desktop.savePreferences({ language: "ru", theme: "dark" }),
  );
  const activate = async (id) => {
    const session = await page.evaluate(
      async (id) => (await window.desktop.openSession(id)).session,
      id,
    );
    await page.reload();
    await page.waitForFunction(
      (s) =>
        document.querySelector(".workspace-title>span")?.textContent ===
          s.title &&
        document.querySelector(".rcf-context>.rcf-directory")?.textContent ===
          s.directory,
      session,
    );
  };
  await activate(qa.sessionId);
  const brand = await app.evaluate(({ app }) => ({
    name: app.getName(),
    version: app.getVersion(),
    data: app.getPath("userData"),
  }));
  assert.equal(brand.name, "Rote Coding Fraktion");
  assert.equal(brand.data, profile);
  const openControls = () =>
    page
      .getByRole("button", { name: "Управление задачей", exact: true })
      .click();
  const tab = (name) => page.getByRole("tab", { name: ({ "Агенты": "Помощники", "Проверка": "Проверка изменений", "История": "История задачи" })[name] ?? name, exact: true }).click();
  const checkGeometry = async (name) => {
    const g = await page.evaluate(() => {
      const el = document.querySelector(".rcf-tools");
      const dialog = document.querySelector("[role=dialog]");
      return {
        width: innerWidth,
        height: innerHeight,
        document: document.documentElement.scrollWidth,
        dialog: dialog?.getBoundingClientRect().toJSON(),
        content: el?.scrollWidth,
        client: el?.clientWidth,
        blur: getComputedStyle(document.querySelector(".modal-backdrop"))
          .backdropFilter,
      };
    });
    assert.ok(g.document <= g.width + 1, JSON.stringify(g));
    if (g.content) assert.ok(g.content <= g.client + 1, JSON.stringify(g));
    assert.ok(
      g.dialog.left >= 0 &&
        g.dialog.right <= g.width + 1 &&
        g.dialog.bottom <= g.height + 1,
      JSON.stringify(g),
    );
    assert.equal(g.blur, "none");
    layouts.push({ name, ...g });
  };
  for (const theme of ["dark", "light"]) {
    await page.keyboard.press("Control+,");
    await page.locator(".settings-screen").waitFor();
    await page
      .getByRole("button", { name: "Внешний вид", exact: true })
      .click();
    await selectValue(page.getByLabel("Тема", { exact: true }), theme);
    await page.waitForFunction(
      (t) => document.documentElement.dataset.theme === t,
      theme,
    );
    await page.waitForTimeout(200);
    const prefs = await page.evaluate(() => window.desktop.bootstrap());
    assert.equal(prefs.preferences.theme, theme);
    await screenshot(page, `${theme}-settings`);
    await page.keyboard.press("Escape");
    await page.locator(".settings-screen").waitFor({ state: "detached" });
    const assets = await page.locator(".brand-glyph").getAttribute("src");
    assert.ok(assets.includes(`rcf-app-${theme}-`));
    for (const [width, height] of [
      [1440, 960],
      [1080, 760],
      [780, 650],
    ]) {
      await app.evaluate(
        ({ BrowserWindow }, size) =>
          BrowserWindow.getAllWindows()[0].setSize(...size),
        [width, height],
      );
      await page.waitForTimeout(160);
      await screenshot(page, `${theme}-${width}-conversation`);
      await openControls();
      for (const name of ["Рабочие копии", "Агенты", "Проверка", "История"]) {
        await tab(name);
        if (name === "Рабочие копии")
          await page.locator(".rcf-tree-row").first().waitFor();
        if (name === "Агенты")
          await page.locator(".rcf-agent-row").first().waitFor();
        if (name === "Проверка")
          await page
            .getByText("Division was replaced by multiplication", {
              exact: true,
            })
            .waitFor();
        await screenshot(
          page,
          `${theme}-${width}-${{ Рабочие_копии: "worktrees", Агенты: "agents", Проверка: "review", История: "history" }[name.replaceAll(" ", "_")]}`,
        );
        await checkGeometry(`${theme}/${width}/${name}`);
      }
      await page.keyboard.press("Escape");
      await page.keyboard.press("Control+k");
      await page.locator(".palette-input-line input").waitFor();
      await screenshot(page, `${theme}-${width}-search`);
      await checkGeometry(`${theme}/${width}/search`);
      await page.keyboard.press("Escape");
    }
    await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0].setSize(1440, 960),
    );
    for (const [selector, name] of [
      [".model-select", "models"],
      [".mode-trigger", "permissions"],
      [".composer-add-trigger", "attach"],
      [".environment-chip", "environment"],
    ]) {
      await page.locator(selector).click();
      await page.waitForTimeout(150);
      await screenshot(page, `${theme}-menu-${name}`);
      if (name === "models") {
        await page.locator(".effort-model-link").click();
        await screenshot(page, `${theme}-menu-favorites`);
        await page.locator(".model-catalog-link").click();
        await page.locator(".catalog-results").waitFor();
        await screenshot(page, `${theme}-model-catalog`);
      }
      await page.keyboard.press("Escape");
    }
    const summary = page.locator(".rcf-metrics>summary");
    await summary.click();
    await screenshot(page, `${theme}-session-details`);
    await openControls();
    assert.equal(await page.locator(".rcf-metrics").getAttribute("open"), null);
    await tab("Агенты");
    await page
      .getByRole("button", { name: "Добавить помощника", exact: true })
      .click();
    await page
      .getByRole("textbox", { name: "Задача помощника" })
      .fill("Проверить расчёт, не меняя файлы.");
    await selectValue(page.getByRole("combobox", { name: "Роль помощника" }), "general");
    assert.ok(
      await page
        .getByRole("button", { name: "Запустить помощника" })
        .isDisabled(),
    );
    const directory = page.getByRole("combobox", { name: "Папка помощника" });
    await directory.click();
    const options = await (await selectList(directory))
      .getByRole("option")
      .evaluateAll((nodes) =>
        nodes.map((n) => ({ value: n.dataset.optionValue, label: n.textContent })),
      );
    await directory.press("Escape");
    const currentDirectory = await page
      .locator(".rcf-context>.rcf-directory")
      .textContent();
    assert.ok(!options.some((o) => o.value === currentDirectory));
    await screenshot(page, `${theme}-writer-form`);
    await selectValue(page.getByRole("combobox", { name: "Роль помощника" }), "rcf-reader");
    await page
      .locator(".rcf-advanced>summary")
      .filter({ hasText: "Модель и сведения о роли" })
      .click();
    assert.ok(
      await page
        .getByRole("button", { name: "Запустить помощника" })
        .isEnabled(),
    );
    await screenshot(page, `${theme}-reader-form`);
    await page.keyboard.press("Escape");
  }
  // A global theme change reaches an already-open conversation window.
  const nextWindow = app.waitForEvent("window");
  await page.evaluate(
    (id) => window.desktop.openSessionWindow(id),
    qa.sessionId,
  );
  const secondary = await nextWindow;
  secondary.on("pageerror", (e) => errors.push(e.message));
  await secondary.waitForFunction(
    () => document.documentElement.dataset.theme === "light",
  );
  for (const theme of ["dark", "light"]) {
    await page.evaluate(
      (theme) => window.desktop.savePreferences({ theme }),
      theme,
    );
    await page.waitForFunction(
      (t) => document.documentElement.dataset.theme === t,
      theme,
    );
    await secondary.waitForFunction(
      (t) => document.documentElement.dataset.theme === t,
      theme,
    );
  }
  await secondary.close();
  // Run an actual child through the UI, using a local deterministic transport.
  await page.evaluate(
    async (port) =>
      window.desktop.customProvider({
        id: "rcfqa",
        name: "RCF UI fixture",
        baseUrl: `http://127.0.0.1:${port}/v1`,
        model: "fixture",
        key: "rcf-fixture-not-a-real-key",
        runtime: "compatible",
        images: true,
        tools: true,
      }),
    server.address().port,
  );
  await activate(qa.sessionId);
  await openControls();
  await tab("Агенты");
  await page
    .getByRole("button", { name: "Добавить помощника", exact: true })
    .click();
  const completedTask = `GUI researcher ${Date.now()}`;
  await page
    .getByRole("textbox", { name: "Задача помощника" })
    .fill(completedTask);
  await page
    .getByRole("button", { name: "Запустить помощника", exact: true })
    .click();
  const child = page
    .locator(".rcf-agent-row")
    .filter({ hasText: completedTask });
  await child.waitFor();
  await child
    .locator(".rcf-status")
    .getByText("Завершено", { exact: true })
    .waitFor({ timeout: 35000 });
  await child.locator(":scope>summary").click();
  await child.getByText(/GUI_RESEARCH_OK/).waitFor();
  await child.locator(".rcf-advanced>summary").click();
  await child
    .getByRole("button", { name: "Открыть переписку", exact: true })
    .click();
  await page.getByRole("button", { name: "К задаче", exact: true }).click();
  await openControls();
  await tab("Агенты");
  await page
    .getByRole("button", { name: "Добавить помощника", exact: true })
    .click();
  const stopTask = `GUI stopped researcher ${Date.now()}`;
  await page.getByRole("textbox", { name: "Задача помощника" }).fill(stopTask);
  await page
    .getByRole("button", { name: "Запустить помощника", exact: true })
    .click();
  const stopped = page.locator(".rcf-agent-row").filter({ hasText: stopTask });
  await stopped.locator(":scope>summary").click();
  await stopped
    .getByRole("button", { name: "Остановить", exact: true })
    .click();
  await stopped
    .locator(".rcf-status")
    .getByText("Остановлено", { exact: true })
    .waitFor({ timeout: 20000 });
  await screenshot(page, "agent-result");
  await page.keyboard.press("Escape");
  const readerRequests = requests.filter((r) => r.reader);
  assert.ok(readerRequests.length >= 2, JSON.stringify(requests));
  assert.ok(
    readerRequests.every((r) =>
      r.tools.every((t) => ["read", "glob", "grep", "ls", "list"].includes(t)),
    ),
    JSON.stringify(requests),
  );
  await page.evaluate((id) => window.desktop.stop(id), qa.sessionId);
  // Review isolation and navigation are unchanged.
  await activate(qa.reviewId);
  await page.locator(".composer").waitFor({ state: "detached" });
  await page.getByRole("button", { name: "К задаче", exact: true }).click();
  await page.locator(".composer").waitFor();
  const rejected = await page.evaluate(async (id) => {
    const r = {};
    for (const [method, args] of [
      [
        "send",
        [id, "malicious", { providerID: "rcfqa", id: "fixture" }, "full", []],
      ],
      ["setMode", [id, "autonomous"]],
      ["permission", [id, "fake", "once"]],
    ]) {
      try {
        await window.desktop[method](...args);
        r[method] = false;
      } catch {
        r[method] = true;
      }
    }
    return r;
  }, qa.reviewId);
  assert.ok(Object.values(rejected).every(Boolean));
  await activate(qa.writerId);
  await openControls();
  await tab("История");
  await page
    .getByRole("button", { name: "Продолжить отсюда…" })
    .first()
    .waitFor();
  await page.keyboard.press("Escape");
  // Exercise create -> enter -> finish -> remove -> history via the real GUI.
  await activate(qa.sessionId);
  await openControls();
  await tab("Рабочие копии");
  await page.getByRole("button", { name: "Новая копия", exact: true }).click();
  const branch = `rcf/ui-${Date.now().toString(36)}`;
  await page
    .getByRole("textbox", { name: "Новая ветка рабочей копии" })
    .fill(branch);
  await page
    .getByRole("button", { name: "Создать копию", exact: true })
    .click();
  const tree = page
    .locator(".rcf-tree-row")
    .filter({ has: page.getByText(branch, { exact: true }) });
  await tree.waitFor();
  const directory = await tree.locator("code").innerText();
  await tree
    .getByRole("button", { name: "Новая задача здесь", exact: true })
    .click();
  await page.waitForFunction(
    (dir) =>
      document
        .querySelector(".rcf-context>.rcf-directory")
        ?.textContent?.replaceAll("\\", "/")
        .toLowerCase() === dir.replaceAll("\\", "/").toLowerCase(),
    directory,
  );
  const created = (await page.evaluate(() => window.desktop.bootstrap()))
    .preferences.sessionId;
  await openControls();
  await page
    .getByRole("button", { name: "Завершить задачу", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Задача завершена", exact: true })
    .waitFor();
  await app.evaluate(() => {
    globalThis.__rcfDecision = 1;
  });
  await page
    .locator(".rcf-tree-row")
    .filter({ hasText: branch })
    .getByRole("button", { name: "Убрать копию…", exact: true })
    .click();
  await page.getByText(/Workspace directory is unavailable/).waitFor();
  await page.locator(".composer").waitFor({ state: "detached" });
  assert.ok(
    (await page.evaluate((id) => window.desktop.openSession(id), created))
      .session.directoryMissing,
  );
  // Light theme survives a full process restart, including native window color.
  await app.close();
  app = await launch();
  page = await app.firstWindow();
  page.on("pageerror", (e) => errors.push(e.message));
  await page.waitForSelector(".status-dot.ready", { timeout: 45000 });
  await page.waitForFunction(
    () => document.documentElement.dataset.theme === "light",
  );
  const native = await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].getBackgroundColor(),
  );
  assert.match(native.toLowerCase(), /^#(?:ff)?faf9f7$/);
  assert.ok(
    (await page.locator(".brand-glyph").getAttribute("src")).includes(
      "rcf-app-light-",
    ),
  );
  assert.deepEqual(errors, []);
  await fs.writeFile(
    `${prefix}.json`,
    JSON.stringify(
      {
        brand,
        packaged,
        layouts,
        agentGuiLaunchAndResult: true,
        agentGuiStop: true,
        readerToolAllowlist: true,
        reviewerIpcPolicy: rejected,
        worktreeGuiLifecycle: true,
        removedHistory: true,
        themePersistenceAfterRestart: true,
        themeSyncAcrossWindows: true,
        nativeWindowColor: native,
        errors,
      },
      null,
      2,
    ),
  );
  console.log(
    "PASS both themes, 1440/1080/780 layouts, no backdrop blur, settings and menus, helper launch/result/stop, reviewer isolation, worktree GUI lifecycle, persistent theme and icons",
  );
} catch (e) {
  console.error(e);
  if (app) {
    const page = await app.firstWindow().catch(() => undefined);
    if (page) {
      await screenshot(page, "failure").catch(() => {});
      console.log((await page.locator("body").innerText()).slice(-6500));
    }
  }
  throw e;
} finally {
  await app
    ?.evaluate(({ dialog }) => {
      dialog.showMessageBox = async () => ({
        response: 1,
        checkboxChecked: false,
      });
    })
    .catch(() => {});
  await app?.close().catch(() => {});
  server.closeAllConnections();
  await new Promise((r) => server.close(r));
}
