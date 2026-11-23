import { chromium } from "playwright";
import { spawn, execFileSync } from "node:child_process";
import net from "node:net";
import path from "node:path";
import fs from "node:fs/promises";
import assert from "node:assert/strict";

// Debugging is enabled only for this isolated smoke process, on loopback.
const listener = net.createServer();
await new Promise((r) => listener.listen(0, "127.0.0.1", r));
const port = listener.address().port;
await new Promise((r) => listener.close(r));
const directory = path.resolve(`.runtime/portable-smoke-${process.pid}`);
const executable = path.resolve("release/RCF-0.2.1-x64-Portable.exe");
const child = spawn(
  executable,
  [`--remote-debugging-port=${port}`, "--remote-debugging-address=127.0.0.1"],
  {
    env: { ...process.env, FORGE_DATA_DIR: directory },
    windowsHide: true,
    stdio: "ignore",
  },
);
let browser;
try {
  const deadline = Date.now() + 55000;
  let endpoint;
  while (Date.now() < deadline) {
    const response = await fetch(`http://127.0.0.1:${port}/json/version`).catch(
      () => undefined,
    );
    if (response?.ok) {
      endpoint = await response.json();
      break;
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  assert.ok(
    endpoint?.webSocketDebuggerUrl,
    "Portable app must unpack and expose its test browser endpoint",
  );
  browser = await chromium.connectOverCDP(endpoint.webSocketDebuggerUrl);
  const context = browser.contexts()[0],
    page = context.pages()[0];
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.locator('.welcome h1').waitFor();
  assert.match(await page.title(),/Rote Coding Fraktion/);
  await page.waitForSelector(".status-dot.ready", { timeout: 30000 });
  const state = await page.evaluate(async () => {
    const initial = await window.desktop.bootstrap();
    return {
      engine: initial.engine,
      node: typeof window.require,
      background: getComputedStyle(document.querySelector(".main-area"))
        .backgroundColor,
    };
  });
  assert.equal(state.engine.state, "ready");
  assert.equal(state.engine.version, "2.3.0");
  assert.equal(state.node, "undefined");
  assert.equal(state.background, "rgb(16, 16, 16)");
  await page.getByRole("button", { name: "Настройки", exact: true }).click();
  await page.getByRole('heading',{name:'Настройки',exact:true}).waitFor();
  await page.screenshot({ path: "test-results/portable-settings.png" });
  await page
    .getByRole("button", { name: "Закрыть настройки", exact: true })
    .click();
  await page.getByRole("button", { name: "Закрыть окно", exact: true }).click();
  await new Promise((resolve, reject) => {
    if (child.exitCode !== null) return resolve();
    const timer = setTimeout(
      () => reject(new Error("Portable did not exit after window close")),
      15000,
    );
    child.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
  });
  assert.deepEqual(errors, []);
  await fs.writeFile(
    "test-results/portable-verification.json",
    JSON.stringify(
      {
        passed: true,
        executable,
        dataDir: directory,
        engine: state.engine,
        neutralStyle: true,
        cleanExit: true,
        errors,
      },
      null,
      2,
    ),
  );
  console.log(
    "PASS actual portable unpack/start, bundled engine, settings, neutral style and clean exit",
  );
} catch (error) {
  if (child.exitCode === null && child.pid) {
    try {
      execFileSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], {
        windowsHide: true,
        stdio: "ignore",
      });
    } catch {}
  }
  throw error;
} finally {
  await browser?.close().catch(() => {});
}
