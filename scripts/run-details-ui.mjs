import { _electron as electron } from "playwright";
import { Service } from "@opencode/client/service";
import { OpenCode } from "@opencode/client";
import fs from "node:fs/promises";
import path from "node:path";
import assert from "node:assert/strict";

// Imported history is an isolated layout fixture; no model generation is made.
const directory = path.resolve(`.runtime/run-details-ui-${process.pid}`);
const projectPath = path.join(directory, "Проверка ленты");
await fs.mkdir(projectPath, { recursive: true });
await fs.mkdir("test-results", { recursive: true });
let app, page;
try {
  app = await electron.launch({
    args: ["."],
    env: { ...process.env, FORGE_DATA_DIR: directory },
    timeout: 30000,
  });
  page = await app.firstWindow();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.waitForSelector(".status-dot.ready", { timeout: 40000 });
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
  const info = await client.session.create({
    location: { directory: projectPath },
    title: "Лента без разделителей",
  });
  await client.session.remove({ sessionID: info.id });
  const base = info.time.created;
  const model1 = { id: "first-model", providerID: "qa" };
  const model2 = {
    id: `long-model-${"extended-context-".repeat(14)}`,
    providerID: "qa",
  };
  const message = (index, time, value) => ({
    id: `msg_${(0x10000000000 + index).toString(16)}qa${String(index).padStart(10, "0")}`,
    time: {
      created: base + time,
      ...(value.type === "assistant" ? { completed: base + time + 1 } : {}),
    },
    ...value,
  });
  const error = {
    type: "provider.auth",
    message: "Провайдер отклонил запрос: HTTP 401.",
  };
  await client.experimental.session.import({
    info,
    location: { directory: projectPath },
    messages: [
      message(1, 0, { type: "model-switched", model: model1 }),
      message(2, 1000, { type: "user", text: "Привет" }),
      message(3, 2000, {
        type: "assistant",
        agent: "build",
        model: model1,
        content: [],
        error: { type: "interrupted", message: "Step interrupted" },
      }),
      message(4, 13000, { type: "idle", outcome: "interrupted" }),
      message(5, 14000, { type: "model-switched", model: model2 }),
      message(6, 15000, { type: "user", text: "Привет" }),
      message(7, 16000, {
        type: "assistant",
        agent: "build",
        model: model2,
        content: [{ type: "text", text: "Привет! 👋 Чем могу помочь?" }],
      }),
      message(8, 20000, { type: "idle", outcome: "succeeded" }),
      message(9, 21000, {
        type: "user",
        text: "Посмотри, как устроен проект.",
      }),
      message(10, 22000, {
        type: "assistant",
        agent: "build",
        model: model2,
        content: [],
        error,
      }),
      message(11, 23000, { type: "idle", outcome: "failed", error }),
    ],
  });
  await page.evaluate(
    async ({ projectId, sessionId }) =>
      window.desktop.savePreferences({ projectId, sessionId }),
    { projectId: project.id, sessionId: info.id },
  );
  await page.reload();
  await page.locator('.run-summary[data-status="succeeded"]').waitFor();
  await page
    .getByText("Привет! 👋 Чем могу помочь?", { exact: true })
    .waitFor();
  assert.equal(await page.locator(".run-summary").count(), 3);
  assert.equal(await page.locator(".system-event.red").count(), 1);
  assert.equal(
    await page.getByText("Step interrupted", { exact: false }).count(),
    0,
  );
  assert.equal(await page.locator(".run-details").count(), 0);
  assert.ok(
    (await page.locator(".system-event.red").innerText()).includes("HTTP 401"),
  );
  const borders = await page
    .locator(".run-summary, .system-event")
    .evaluateAll((elements) =>
      elements.map((element) => getComputedStyle(element).borderTopWidth),
    );
  assert.ok(borders.every((border) => border === "0px"));
  const noOverlap = async () => {
    await page.waitForTimeout(150);
    const geometry = await page
      .locator(".timeline-item")
      .evaluateAll((elements) =>
        elements.map((element) => {
          const box = element.getBoundingClientRect();
          return { top: box.top, bottom: box.bottom };
        }),
      );
    assert.ok(
      geometry.slice(1).every((box, i) => box.top >= geometry[i].bottom - 1),
    );
    assert.equal(
      await page.evaluate(
        () => document.documentElement.scrollWidth > innerWidth,
      ),
      false,
    );
  };
  for (const size of [
    [1440, 960],
    [780, 600],
  ]) {
    await app.evaluate(
      ({ BrowserWindow }, size) =>
        BrowserWindow.getAllWindows()[0].setSize(...size),
      size,
    );
    await page.locator(".timeline-scroll").evaluate((element) => {
      element.scrollTop = 0;
    });
    await noOverlap();
    await page.screenshot({
      path: `test-results/run-details-collapsed-${size[0]}.png`,
    });
    if (size[0] === 1440)
      await page
        .locator(".timeline-column")
        .screenshot({ path: "test-results/run-details-conversation.png" });
    const done = page.locator('.run-summary[data-status="succeeded"]');
    await done.getByRole("button").click();
    await done.getByLabel("Детали запуска").waitFor();
    assert.ok((await done.innerText()).includes(model2.id));
    await noOverlap();
    const detailFits = await done
      .getByLabel("Детали запуска")
      .evaluate((element) => element.scrollWidth <= element.clientWidth + 1);
    assert.equal(detailFits, true);
    await page.screenshot({
      path: `test-results/run-details-expanded-${size[0]}.png`,
    });
    await done.getByRole("button").click();
  }
  await page
    .locator('.run-summary[data-status="interrupted"]')
    .getByRole("button")
    .click();
  const stopDetails = page.locator(
    '.run-summary[data-status="interrupted"] .run-details',
  );
  assert.ok((await stopDetails.innerText()).includes("Step interrupted"));
  assert.equal(await stopDetails.locator(".red").count(), 0);
  assert.deepEqual(errors, []);
  await fs.writeFile(
    "test-results/run-details-verification.json",
    JSON.stringify(
      {
        passed: true,
        directory,
        importedFixture: true,
        summaryCount: 3,
        visibleRealErrors: 1,
        cancellationIsNeutral: true,
        noHorizontalSeparators: true,
        longModelIdWraps: true,
        expandedRowsDoNotOverlap: true,
        sizes: [
          [1440, 960],
          [780, 600],
        ],
      },
      null,
      2,
    ),
  );
  console.log(
    "PASS compact run captions, hidden model details, neutral interruption, visible provider error, wrapping and expansion on wide/narrow windows",
  );
} catch (error) {
  if (page) {
    console.error(
      "Visible errors",
      await page.locator(".error-toast").allTextContents(),
    );
    await page.screenshot({ path: "test-results/run-details-failure.png" });
  }
  throw error;
} finally {
  await app?.close().catch(() => {});
}
