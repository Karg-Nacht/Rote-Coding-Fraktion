import { chromium, expect } from "playwright/test";
import { spawn, execFileSync } from "node:child_process";
import { once } from "node:events";
import http from "node:http";
import net from "node:net";
import path from "node:path";
import fs from "node:fs/promises";
import assert from "node:assert/strict";
import { OpenCode } from "@opencode/client";
import { Service } from "@opencode/client/service";
import {
  appName,
  metadata,
  portableName,
  setupName,
} from "./windows-artifacts.mjs";

const usingSetup = process.argv.includes("--setup");
const kind = usingSetup ? "setup" : "portable";
await fs.mkdir(".runtime", { recursive: true });
await fs.mkdir("test-results", { recursive: true });
const directory = await fs.mkdtemp(path.resolve(".runtime", kind + "-smoke-"));
const dataDir = path.join(directory, "profile");
const installedDir = path.join(directory, "installation");
const artifact = path.resolve("release", usingSetup ? setupName : portableName);
const executable = usingSetup ? path.join(installedDir, appName) : artifact;
const uninstaller = path.join(installedDir, "Uninstall " + appName);
const env = { ...process.env, RCF_DATA_DIR: dataDir };

function spawnIsolated(file, args) {
  return spawn(file, args, { env, windowsHide: true, stdio: "ignore" });
}
async function waitForExit(child, milliseconds, label) {
  if (child.exitCode !== null) return child.exitCode;
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(new Error(label)),
    milliseconds,
  );
  try {
    const [code, signal] = await once(child, "exit", {
      signal: controller.signal,
    });
    assert.equal(signal, null, label);
    return code;
  } finally {
    clearTimeout(timer);
  }
}
function stop(child) {
  if (!child?.pid || child.exitCode !== null) return;
  try {
    execFileSync("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], {
      windowsHide: true,
      stdio: "ignore",
    });
  } catch {}
}

const listener = net.createServer();
await new Promise((resolve) => listener.listen(0, "127.0.0.1", resolve));
const port = listener.address().port;
await new Promise((resolve) => listener.close(resolve));
const requests = [];
const provider = http.createServer(async (request, response) => {
  if (!request.url?.endsWith("/chat/completions"))
    return void response.writeHead(404).end();
  let raw = "";
  for await (const chunk of request) raw += chunk;
  const body = JSON.parse(raw);
  const text = JSON.stringify(body.messages);
  const chat = text.includes("RCF_PACKAGED_CHAT_317");
  requests.push({ chat, text, tools: body.tools?.length ?? 0 });
  response.writeHead(200, { "Content-Type": "text/event-stream" });
  for (const [delta, finish_reason] of [
    [
      {
        role: "assistant",
        content: chat ? "PACKAGED_CHAT_OK" : "PACKAGED_WORK_OK",
      },
      null,
    ],
    [{}, "stop"],
  ]) {
    response.write(
      "data: " +
        JSON.stringify({
          id: "smoke-" + requests.length,
          object: "chat.completion.chunk",
          created: 1,
          model: body.model,
          choices: [{ index: 0, delta, finish_reason }],
        }) +
        "\n\n",
    );
  }
  response.end("data: [DONE]\n\n");
});
await new Promise((resolve) => provider.listen(0, "127.0.0.1", resolve));

let child,
  browser,
  installAttempted = false,
  shortcutsVerified = false,
  uninstallVerified = false;
try {
  if (usingSetup) {
    // NSIS registers uninstall and shortcut entries for the signed-in account.
    // Exercise the actual installer only when the app has no existing registration.
    const existing = execFileSync(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        "$paths = @('HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*', 'HKLM:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*', 'HKLM:\\Software\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*'); Get-ItemProperty $paths -ErrorAction SilentlyContinue | Where-Object { $_.DisplayName -in @('Rote Coding Fraktion', 'Forge Agent', 'RCF') } | Select-Object -ExpandProperty DisplayName",
      ],
      { windowsHide: true, encoding: "utf8" },
    ).trim();
    assert.equal(
      existing,
      "",
      "An existing Windows installation must be tested on a separate Windows account or runner",
    );
    const installer = spawnIsolated(artifact, ["/S", "/D=" + installedDir]);
    installAttempted = true;
    try {
      assert.equal(
        await waitForExit(installer, 120_000, "Setup did not finish"),
        0,
      );
    } finally {
      stop(installer);
    }
    await fs.access(executable);
    await fs.access(uninstaller);
    const links = JSON.parse(
      execFileSync(
        "powershell.exe",
        [
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          "$name = 'Rote Coding Fraktion.lnk'; $desktop = Join-Path ([Environment]::GetFolderPath('DesktopDirectory')) $name; $programs = [Environment]::GetFolderPath('Programs'); $menu = Get-ChildItem -LiteralPath $programs -Filter $name -Recurse -File -ErrorAction SilentlyContinue | Select-Object -First 1 -ExpandProperty FullName; @{ desktop = $desktop; menu = $menu } | ConvertTo-Json -Compress",
        ],
        { windowsHide: true, encoding: "utf8" },
      ),
    );
    assert.ok(links.desktop && links.menu, "Setup must create both shortcuts");
    const shortcutTargets = execFileSync(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        "$shell = New-Object -ComObject WScript.Shell; @($env:RCF_QA_DESKTOP_LINK,$env:RCF_QA_MENU_LINK) | ForEach-Object { if (Test-Path -LiteralPath $_ -PathType Leaf) { $shell.CreateShortcut($_).TargetPath } }",
      ],
      {
        windowsHide: true,
        encoding: "utf8",
        env: {
          ...env,
          RCF_QA_DESKTOP_LINK: links.desktop,
          RCF_QA_MENU_LINK: links.menu,
        },
      },
    );
    assert.deepEqual(
      shortcutTargets
        .trim()
        .split(/\r?\n/)
        .map((target) => target.toLowerCase()),
      [executable.toLowerCase(), executable.toLowerCase()],
    );
    shortcutsVerified = true;
  }

  // Enable CDP on loopback for this isolated smoke process.
  child = spawn(
    executable,
    ["--remote-debugging-port=" + port, "--remote-debugging-address=127.0.0.1"],
    {
      env: { ...env, ELECTRON_ENABLE_LOGGING: "1" },
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let diagnostic = "";
  for (const stream of [child.stdout, child.stderr])
    stream.on("data", (chunk) => {
      diagnostic = (diagnostic + chunk.toString()).slice(-12000);
    });
  const launched = once(child, "spawn");
  await launched;
  const deadline = Date.now() + 60_000;
  let endpoint;
  while (Date.now() < deadline && child.exitCode === null) {
    const response = await fetch(
      "http://127.0.0.1:" + port + "/json/version",
    ).catch(() => undefined);
    if (response?.ok) {
      endpoint = await response.json();
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  assert.ok(
    endpoint?.webSocketDebuggerUrl,
    kind +
      " did not start its test browser endpoint. Exit code: " +
      child.exitCode,
  );
  browser = await chromium.connectOverCDP(endpoint.webSocketDebuggerUrl);
  const context = browser.contexts()[0];
  const page =
    context.pages()[0] ??
    (await context.waitForEvent("page", { timeout: 20000 }));
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.locator(".welcome h1").waitFor();
  assert.match(await page.title(), /Rote Coding Fraktion/);
  const ready = () =>
    page.waitForSelector(".status-dot.ready", { timeout: 40000 });
  await ready();
  const initial = await page.evaluate(async () => ({
    engine: (await window.desktop.bootstrap()).engine,
    node: typeof window.require,
    background: getComputedStyle(document.querySelector(".main-area"))
      .backgroundColor,
  }));
  assert.equal(initial.engine.state, "ready");
  assert.equal(
    initial.engine.version,
    metadata.devDependencies["@opencode/cli"],
  );
  assert.equal(initial.node, "undefined");
  assert.equal(initial.background, "rgb(16, 16, 16)");

  const model = { id: "fixture", providerID: "packaged-smoke" };
  await page.evaluate(
    async ({ model, port }) => {
      await window.desktop.customProvider({
        id: model.providerID,
        name: "Packaged local smoke",
        runtime: "compatible",
        baseUrl: "http://127.0.0.1:" + port + "/v1",
        model: model.id,
        key: "packaged-local-fixture",
        images: false,
        tools: true,
      });
      await window.desktop.savePreferences({
        model,
        workspace: "chat",
        language: "en",
      });
    },
    { model, port: provider.address().port },
  );
  await page.reload();
  await ready();
  const button = (name) => page.getByRole("button", { name, exact: true });
  const input = () =>
    page.getByRole("textbox", { name: "Message the agent", exact: true });
  await button("Settings").click();
  await page.getByRole("heading", { name: "Settings", exact: true }).waitFor();
  await expect(
    page.getByText("Rote Coding Fraktion " + metadata.version, { exact: true }),
  ).toBeVisible();
  await page.screenshot({ path: "test-results/" + kind + "-settings.png" });
  await button("Close settings").click();
  await expect(button("Project Context")).toBeVisible();
  await expect(button("Project Context")).toBeDisabled();
  await input().fill("RCF_PACKAGED_CHAT_317");
  await button("Send message").click();
  await expect(
    page.getByText("PACKAGED_CHAT_OK", { exact: true }).last(),
  ).toBeVisible({ timeout: 15000 });
  assert.ok(
    requests.some((item) => item.chat && !item.tools),
    "Packaged Chat must send no model tools",
  );
  await page.evaluate(
    ({ model }) =>
      window.desktop.savePreferences({
        workspace: "work",
        sessionId: undefined,
        workspaceSessions: {},
        model,
      }),
    { model },
  );
  await page.reload();
  await ready();
  await expect(button("Project Context")).toHaveCount(0);
  await input().fill("RCF_PACKAGED_WORK_318");
  await button("Send message").click();
  await expect(
    page.getByText("PACKAGED_WORK_OK", { exact: true }).last(),
  ).toBeVisible({ timeout: 15000 });
  assert.ok(
    requests.some(
      (item) => item.text.includes("RCF_PACKAGED_WORK_318") && item.tools > 0,
    ),
  );
  const engineEndpoint = await Service.discover({
    file: path.join(dataDir, "engine", "state", "opencode", "service.json"),
    version: initial.engine.version,
  });
  assert.ok(engineEndpoint);
  const engine = OpenCode.make({
    baseUrl: engineEndpoint.url,
    headers: Service.headers(engineEndpoint),
  });
  await expect
    .poll(async () => Object.keys(await engine.session.active()).length, {
      timeout: 15000,
    })
    .toBe(0);
  await button("Close window").click();
  assert.equal(
    await waitForExit(
      child,
      30_000,
      kind + " did not exit after closing the window",
    ),
    0,
    diagnostic,
  );
  assert.deepEqual(errors, []);
  await browser.close().catch(() => {});
  browser = undefined;

  if (usingSetup) {
    const removal = spawnIsolated(uninstaller, ["/S"]);
    try {
      assert.equal(
        await waitForExit(removal, 90_000, "Uninstall did not finish"),
        0,
      );
      await expect
        .poll(() =>
          fs.access(executable).then(
            () => true,
            () => false,
          ),
        )
        .toBe(false);
      uninstallVerified = true;
    } finally {
      stop(removal);
    }
  }
  await fs.writeFile(
    "test-results/" + kind + "-verification.json",
    JSON.stringify(
      {
        passed: true,
        artifact,
        dataDir,
        version: metadata.version,
        engine: initial.engine.version,
        chat: true,
        work: true,
        projectContext: true,
        cleanExit: true,
        shortcutsVerified,
        uninstallVerified,
        errors,
      },
      null,
      2,
    ),
  );
  console.log(
    "PASS actual " +
      kind +
      " executable, bundled engine, settings, Chat and Work, Project Context, and clean exit" +
      (uninstallVerified ? ", followed by uninstall" : ""),
  );
} finally {
  stop(child);
  await browser?.close().catch(() => {});
  if (
    installAttempted &&
    !uninstallVerified &&
    (await fs.access(uninstaller).then(
      () => true,
      () => false,
    ))
  ) {
    const removal = spawnIsolated(uninstaller, ["/S"]);
    await waitForExit(
      removal,
      60_000,
      "Cleanup uninstall did not finish",
    ).catch(() => stop(removal));
  }
  provider.closeAllConnections();
  await new Promise((resolve) => provider.close(resolve));
}
