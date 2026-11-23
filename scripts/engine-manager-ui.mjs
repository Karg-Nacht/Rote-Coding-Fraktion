import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { _electron as electron } from "playwright";
import { OpenCode } from "@opencode/client";
import { Service } from "@opencode/client/service";

const data = await fs.mkdtemp(path.resolve(".runtime/engine-manager-ui-"));
const folder = path.join(data, "Engine Manager fixture");
const output = path.resolve("test-results/engine-manager");
await fs.mkdir(folder);
await fs.mkdir(output, { recursive: true });
const binary = path.resolve("node_modules/@opencode/cli/bin/opencode.exe");
const env = { ...process.env, RCF_DATA_DIR: data };
delete env.FORGE_ENGINE_PATH;
const errors = [];

async function launch() {
  const app = await electron.launch({ args: ["."], env, timeout: 30000 });
  const page = await app.firstWindow();
  page.on("pageerror", (error) => errors.push(error.message));
  await page.locator(".status-dot.ready").first().waitFor({ timeout: 45000 });
  return { app, page };
}
async function about(page) {
  await page.keyboard.press("Control+,");
  await page.getByRole("button", { name: "О приложении", exact: true }).click();
  await page.locator("#setting-engine").waitFor();
}
async function fixtureMain(app) {
  await app.evaluate(({ dialog }) => {
    const network = globalThis.fetch;
    globalThis.engineFixture = { mode: "offline", active: false, requests: 0, confirmations: 0 };
    dialog.showMessageBox = async () => {
      globalThis.engineFixture.confirmations++;
      return { response: 1, checkboxChecked: false };
    };
    globalThis.fetch = async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      const fixture = globalThis.engineFixture;
      if (url.origin === "https://registry.npmjs.org") {
        fixture.requests++;
        if (fixture.mode === "offline") throw new TypeError("Fixture offline");
        if (url.pathname.endsWith("/latest")) return Response.json({
          name: "@opencode/cli",
          version: fixture.mode === "current" ? "2.3.0" : "2.3.2",
        });
        return new Response(null, { status: 503 });
      }
      if (fixture.active && url.pathname === "/api/session/active")
        return Response.json({ data: { ses_fixture: { type: "running" } } });
      return network(input, init);
    };
  });
}
async function capture(app, page, theme, width, height) {
  await app.evaluate(({ BrowserWindow }, size) => BrowserWindow.getAllWindows()[0].setSize(...size), [width, height]);
  await page.evaluate((theme) => window.desktop.savePreferences({ theme }), theme);
  await page.waitForFunction((theme) => document.documentElement.dataset.theme === theme, theme);
  await page.waitForTimeout(350);
  const image = await app.evaluate(async ({ BrowserWindow }) =>
    (await BrowserWindow.getAllWindows()[0].capturePage()).toPNG().toString("base64"));
  await fs.writeFile(path.join(output, theme + "-" + width + ".png"), Buffer.from(image, "base64"));
}

const first = await launch();
let project;
let session;
let status;
try {
  const { app, page } = first;
  await fixtureMain(app);
  await app.evaluate(({ dialog }, directory) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [directory] });
  }, folder);
  project = await page.evaluate(() => window.desktop.addProject());
  assert.ok(project?.id);
  session = await page.evaluate(async (id) => {
    await window.desktop.savePreferences({ chatFontSize: 16 });
    return window.desktop.createSession(id, undefined, "cautious");
  }, project.id);
  await page.evaluate(async (id) => window.desktop.renameSession(id, "Engine rollback history"), session.id);
  const serviceFile = path.join(data, "engine", "state", "opencode", "service.json");
  const info = JSON.parse(await fs.readFile(serviceFile, "utf8"));
  const endpoint = await Service.discover({ file: serviceFile, version: "2.3.0" });
  assert.ok(endpoint?.auth && info.pid);
  const sdk = OpenCode.make({ baseUrl: endpoint.url, headers: Service.headers(endpoint) });
  await sdk.credential.create({
    integrationID: "openai", label: "Engine Manager fixture",
    value: { type: "key", key: "local-engine-manager-test-key" },
  });
  const history = await sdk.session.get({ sessionID: session.id });
  await sdk.session.remove({ sessionID: session.id });
  session = await sdk.experimental.session.import({
    info: history,
    location: { directory: folder },
    messages: [{
      id: "msg_20000000000enginehistoryfixture", type: "system",
      time: { created: Date.now() },
      text: "History before engine switch",
    }],
  });
  const active = await page.evaluate(() => window.desktop.bootstrap());
  status = active.engine.compatibility;
  assert.equal(active.engine.version, "2.3.0");
  assert.equal(status?.canSend, true);
  await about(page);
  await page.getByRole("switch", { name: "Проверять обновления автоматически" }).click();

  const check = page.getByRole("button", { name: "Проверить обновления", exact: true });
  await check.click();
  await page.getByRole("alert").filter({ hasText: "Не удалось проверить обновления." }).waitFor();
  await app.evaluate(() => { globalThis.engineFixture.mode = "current"; });
  await check.click();
  await page.getByText("Обновлений нет.", { exact: true }).waitFor();
  await app.evaluate(() => { globalThis.engineFixture.mode = "new"; });
  await check.click();
  await page.getByText("Доступно обновление · 2.3.2", { exact: true }).waitFor();
  await page.locator("#setting-engine-diagnostics summary").click();
  const engineControls = page.locator(".engine-settings");
  assert.match(await engineControls.innerText(), /Сессии и история/);
  await capture(app, page, "dark", 1440, 960);
  await page.locator("#setting-engine-diagnostics summary").click();
  await capture(app, page, "light", 820, 760);
  const overflow = await page.locator(".settings-content").evaluate((panel) => panel.scrollWidth > panel.clientWidth + 1);
  assert.equal(overflow, false);

  await app.evaluate(() => { globalThis.engineFixture.active = true; });
  const blocked = await page.evaluate(() => window.desktop.installEngineUpdate().then(() => "", (error) => String(error)));
  assert.match(blocked, /остановите активные задачи/);
  await app.evaluate(() => { globalThis.engineFixture.active = false; });
  await page.getByRole("button", { name: "Скачать и проверить", exact: true }).click();
  await page.getByRole("alert").filter({ hasText: "Не удалось скачать пакет OpenCode" }).waitFor();
  assert.equal((await page.evaluate(() => window.desktop.engineUpdateInfo())).installed, "2.3.0");
} finally {
  await first.app.close();
}

const managerDir = path.join(data, "engine-manager");
const manifestFile = path.join(managerDir, "manager.json");
const slot = { id: randomUUID(), version: "2.3.0", digest: "" };
const slotDir = path.join(managerDir, "slots", slot.id);
await fs.mkdir(slotDir, { recursive: true });
const digest = createHash("sha512");
for await (const chunk of createReadStream(binary)) digest.update(chunk);
slot.digest = digest.digest("hex");
await fs.copyFile(binary, path.join(slotDir, "opencode.exe"));
const manifest = JSON.parse(await fs.readFile(manifestFile, "utf8"));
await fs.writeFile(manifestFile, JSON.stringify({ ...manifest, staged: { slot, compatibility: status } }));

const second = await launch();
try {
  const { app, page } = second;
  await fixtureMain(app);
  await about(page);
  await page.getByRole("button", { name: "Переключить · 2.3.0" }).click();
  await page.getByText("Установлен через RCF", { exact: false }).waitFor({ timeout: 45000 });
  const validateProfile = async (engineDir) => {
    const current = await page.evaluate(async (id) => ({
      app: await window.desktop.bootstrap(),
      session: await window.desktop.openSession(id),
    }), session.id);
    assert.ok(current.app.projects.some((row) => row.id === project.id));
    assert.equal(current.app.preferences.chatFontSize, 16);
    assert.equal(current.app.preferences.engineAutoCheck, false);
    assert.equal(current.session.session.title, "Engine rollback history");
    assert.match(JSON.stringify(current.session.rows), /History before engine switch/);
    const serviceFile = path.join(engineDir, "state", "opencode", "service.json");
    const endpoint = await Service.discover({ file: serviceFile, version: "2.3.0" });
    assert.ok(endpoint);
    const sdk = OpenCode.make({ baseUrl: endpoint.url, headers: Service.headers(endpoint) });
    const key = (await sdk.credential.list()).find((entry) => entry.label === "Engine Manager fixture");
    assert.equal(key?.value.key, "local-engine-manager-test-key");
  };
  await validateProfile(path.join(slotDir, "profile"));
  assert.ok(await fs.stat(path.join(slotDir, "profile", "data", "opencode", "opencode.db")));
  await page.getByRole("button", { name: "Вернуться · 2.3.0" }).click();
  await page.getByText("В комплекте с RCF", { exact: false }).waitFor({ timeout: 45000 });
  await validateProfile(path.join(data, "engine"));
  await capture(app, page, "light", 1080, 820);
} finally {
  await second.app.close();
}
assert.deepEqual(errors, []);
await fs.writeFile(path.join(output, "verification.json"), JSON.stringify({
  electron: true, profile: data, installed: "2.3.0",
  registry: ["offline", "current", "update available", "download failure"],
  activeTask: "blocked by IPC",
  switchAndRollback: "two private copies of actual OpenCode 2.3.0; history, project, preferences and a fixture credential checked both ways",
  screenshots: ["dark-1440.png", "light-820.png", "light-1080.png"],
}, null, 2));
console.log("PASS isolated Electron Engine Manager, active guard, switch, rollback and both themes");
