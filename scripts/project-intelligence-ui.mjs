import { _electron as electron, expect } from "playwright/test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { OpenCode } from "@opencode/client";
import { Service } from "@opencode/client/service";
import { appName, metadata } from "./windows-artifacts.mjs";

await fs.mkdir(".runtime", { recursive: true });
const dataDir = await fs.mkdtemp(
  path.resolve(".runtime/project-intelligence-ui-"),
);
const projectDir = path.join(dataDir, "Project Intelligence fixture");
await fs.mkdir(projectDir);
await fs.mkdir("test-results", { recursive: true });
const code = 'export function restoreModel() { return "UI_EVIDENCE_41072"; }\n';
const source = path.join(projectDir, "restore-model.ts");
await fs.writeFile(source, code);
await fs.writeFile(path.join(projectDir, ".env"), "UI_EXCLUDED_FIXTURE");

const requests = [];
const provider = http.createServer(async (request, response) => {
  if (!request.url?.endsWith("/chat/completions"))
    return void response.writeHead(404).end();
  let raw = "";
  for await (const chunk of request) raw += chunk;
  const body = JSON.parse(raw);
  const phase = JSON.stringify(body.messages).includes("UI_EVIDENCE_41072")
    ? "CONTEXT"
    : "ORDINARY";
  requests.push(body);
  response.writeHead(200, { "Content-Type": "text/event-stream" });
  for (const [delta, finish] of [
    [{ role: "assistant", content: `UI_${phase}_OK` }, null],
    [{}, "stop"],
  ]) {
    response.write(
      `data: ${JSON.stringify({ id: `ui-${requests.length}`, object: "chat.completion.chunk", created: 1, model: body.model, choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`,
    );
  }
  response.end("data: [DONE]\n\n");
});
await new Promise((resolve) => provider.listen(0, "127.0.0.1", resolve));
const model = { id: "fixture", providerID: "project-intelligence-ui" };
let app;
try {
  const packaged = process.argv.includes("--packaged");
  app = await electron.launch({
    executablePath: packaged
      ? path.resolve("release", "win-unpacked", appName)
      : undefined,
    args: packaged ? [] : ["."],
    env: { ...process.env, RCF_DATA_DIR: dataDir },
    timeout: 30000,
  });
  const page = await app.firstWindow();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const ready = () =>
    page.waitForSelector(".status-dot.ready", { timeout: 40000 });
  const button = (name) => page.getByRole("button", { name, exact: true });
  const input = () =>
    page.getByRole("textbox", { name: "Message the agent", exact: true });
  const toggle = () => button("Project Context");
  await ready();
  const port = provider.address().port;
  await page.evaluate(
    async ({ model, port }) => {
      await window.desktop.customProvider({
        id: model.providerID,
        name: "Project Intelligence local fixture",
        runtime: "compatible",
        baseUrl: `http://127.0.0.1:${port}/v1`,
        model: model.id,
        key: "local-fixture-only",
        images: false,
        tools: true,
      });
      await window.desktop.savePreferences({
        language: "en",
        workspace: "chat",
        model,
      });
    },
    { model, port },
  );
  await page.reload();
  await ready();
  await expect(toggle()).toBeDisabled();
  await app.evaluate(({ dialog }, projectDir) => {
    dialog.showOpenDialog = async () => ({
      canceled: false,
      filePaths: [projectDir],
    });
  }, projectDir);
  const project = await page.evaluate(() => window.desktop.addProject());
  await page.evaluate(
    (id) => window.desktop.savePreferences({ projectId: id }),
    project.id,
  );
  await page.reload();
  await ready();
  await expect(toggle()).toBeEnabled();
  await expect(toggle()).toHaveAttribute("aria-pressed", "false");
  await expect(button("Preview Context")).toHaveCount(0);
  await toggle().click();
  await expect(
    page.getByText(
      "Relevant source excerpts will be sent to the selected model with your message.",
    ),
  ).toBeVisible();
  await input().fill("xylophonic neitherwhalebone");
  await button("Send message").click();
  await expect(page.getByRole("alert")).toContainText(
    "No relevant excerpts found",
  );
  await expect(input()).toHaveValue("xylophonic neitherwhalebone");
  assert.equal(
    requests.length,
    0,
    "An empty result must never send an ordinary prompt",
  );
  await input().fill("Where does restoreModel run?");
  await button("Preview Context").click();
  const preview = page.getByRole("dialog", { name: "Project Context" });
  await expect(preview.getByText("restore-model.ts:1–1")).toBeVisible();
  await expect(preview.locator("pre")).toContainText(code.trim());
  await expect(preview.getByText("Scan exclusions")).toBeVisible();
  assert.equal(requests.length, 0, "Preview must not contact any model");
  await page.keyboard.press("Escape");
  const widths = [1440, 1080, 780];
  for (const theme of ["dark", "light"]) {
    await page.evaluate(
      (theme) => window.desktop.savePreferences({ theme }),
      theme,
    );
    await page.reload();
    await ready();
    await expect(toggle()).toHaveAttribute("aria-pressed", "false");
    await toggle().click();
    await input().fill("Where does restoreModel run?");
    for (const width of widths) {
      await app.evaluate(
        ({ BrowserWindow }, width) =>
          BrowserWindow.getAllWindows()[0].setSize(width, 850),
        width,
      );
      await expect.poll(() => page.evaluate(() => innerWidth)).toBe(width);
      await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
      await page.screenshot({
        path: `test-results/project-intelligence-composer-${theme}-${width}.png`,
      });
      await button("Preview Context").click();
      await expect(preview.getByText("restore-model.ts:1–1")).toBeVisible();
      const layout = await page.evaluate(() => {
        const bounds = (selector) =>
          document.querySelector(selector).getBoundingClientRect();
        const { left, right } = bounds(".project-intelligence-preview");
        const bar = bounds(".composer-context-bar");
        return (
          left >= 0 &&
          right <= innerWidth &&
          bar.left >= 0 &&
          bar.right <= innerWidth &&
          document.documentElement.scrollWidth <= innerWidth
        );
      });
      assert.ok(
        layout,
        `${theme} theme at ${width}px must fit without overflow`,
      );
      await page.screenshot({
        path: `test-results/project-intelligence-${theme}-${width}.png`,
      });
      await page.keyboard.press("Escape");
    }
  }
  await button("Send message").click();
  await expect(
    page.getByText("UI_CONTEXT_OK", { exact: true }).last(),
  ).toBeVisible({ timeout: 15000 });
  await expect(toggle()).toHaveAttribute("aria-pressed", "false");
  await input().fill("UI_ORDINARY_FOLLOWUP");
  await button("Send message").click();
  await expect(
    page.getByText("UI_ORDINARY_OK", { exact: true }).last(),
  ).toBeVisible({ timeout: 15000 });
  const requestText = requests.map((body) => JSON.stringify(body.messages));
  assert.ok(
    requestText.some(
      (body) =>
        body.includes("UI_EVIDENCE_41072") && body.includes("restore-model.ts"),
    ),
  );
  assert.ok(requestText.every((body) => !body.includes("UI_EXCLUDED_FIXTURE")));
  assert.ok(
    requestText
      .filter((body) => body.includes("UI_ORDINARY_FOLLOWUP"))
      .every((body) => !body.includes("UI_EVIDENCE_41072")),
  );
  assert.ok(requests.every((body) => !body.tools?.length));
  const endpoint = await Service.discover({
    file: path.join(dataDir, "engine", "state", "opencode", "service.json"),
    version: metadata.devDependencies["@opencode/cli"],
  });
  assert.ok(endpoint);
  const client = OpenCode.make({
    baseUrl: endpoint.url,
    headers: Service.headers(endpoint),
  });
  const sessionId = await page.evaluate(
    async () => (await window.desktop.bootstrap()).preferences.sessionId,
  );
  assert.ok(sessionId);
  await expect
    .poll(async () => !(await client.session.active())[sessionId], {
      timeout: 15000,
    })
    .toBe(true);
  await expect(button("Stop agent")).toHaveCount(0, { timeout: 15000 });
  await button("Detach project from chat").click();
  await expect(button("Choose project")).toBeVisible({ timeout: 15000 });
  await expect(toggle()).toBeDisabled();
  assert.equal(await fs.readFile(source, "utf8"), code);
  assert.deepEqual(errors, []);
  console.log(
    "PASS Project Context preview, draft preservation, provider inclusion/removal, selected project, and dark/light at 1440/1080/780 px",
  );
} finally {
  await app?.close();
  provider.closeAllConnections();
  await new Promise((resolve) => provider.close(resolve));
}
