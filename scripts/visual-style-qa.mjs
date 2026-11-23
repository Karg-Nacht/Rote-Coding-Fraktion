import { _electron as electron } from "playwright";
import fs from "node:fs/promises";
import assert from "node:assert/strict";
import { revealActivity, revealTaskDiff } from "./activity-ui-controls.mjs";

// Reuse isolated QA history from the real agent test; never open a user profile.
const qa = JSON.parse(
  await fs.readFile("test-results/desktop-verification.json", "utf8"),
);
const app = await electron.launch({
  args: process.env.FORGE_PACKAGED ? [] : ["."],
  executablePath: process.env.FORGE_PACKAGED || undefined,
  env: { ...process.env, FORGE_DATA_DIR: qa.dataDir },
  timeout: 30000,
});
const errors = [];
const sizes = [
  [1440, 960],
  [1080, 720],
  [780, 600],
];
const results = [];
let page;
try {
  page = await app.firstWindow();
  page.on("pageerror", (e) => errors.push(e.message));
  await page.waitForSelector(".status-dot.ready", { timeout: 40000 });
  const title = await page.evaluate(
    async (id) => (await window.desktop.openSession(id)).session.title,
    qa.sessionId,
  );
  await page
    .locator(".session-link")
    .filter({ hasText: title })
    .first()
    .click();
  await page.locator(".file-edit-card").waitFor();
  await revealTaskDiff(page);
  await page.locator(".file-edit-card .file-change-toggle").first().click();
  await page.locator(".file-edit-card .inline-diff .shiki").waitFor();
  const compactDiff = await page.locator(".file-edit-card").evaluate((el) => ({
    height: el.getBoundingClientRect().height,
    codeLines: el.querySelectorAll(".inline-diff .diff-line").length,
    metadataLines: el.querySelectorAll(
      ".inline-diff .diff-header, .inline-diff .diff-hunk",
    ).length,
    newLine: el
      .querySelector(".inline-diff .diff-add")
      ?.getAttribute("data-new"),
  }));
  assert.ok(
    compactDiff.height <= 124,
    "One changed line must produce a compact inline preview",
  );
  assert.equal(compactDiff.codeLines, 1);
  assert.equal(compactDiff.metadataLines, 0);
  assert.equal(compactDiff.newLine, "1");

  const style = await page.evaluate(() => {
    const sample = (selector) => {
      const s = getComputedStyle(document.querySelector(selector));
      return {
        background: s.backgroundColor,
        color: s.color,
        radius: s.borderTopLeftRadius,
        border: s.borderTopColor,
      };
    };
    return {
      main: sample(".main-area"),
      sidebar: sample(".sidebar"),
      composer: sample(".composer"),
      files: sample(".file-edit-card"),
      additions: sample(".file-edit-card .green"),
    };
  });
  assert.equal(style.main.background, "rgb(16, 16, 16)");
  assert.equal(style.sidebar.background, "rgb(27, 23, 23)");
  assert.equal(style.composer.background, "rgb(37, 37, 37)");
  assert.equal(style.composer.radius, "8px");
  assert.equal(style.files.background, "rgba(0, 0, 0, 0)");
  assert.equal(style.files.radius, "0px");
  assert.equal(style.additions.color, "rgb(147, 184, 139)");

  await revealActivity(page.locator(".action-group").last(), "shell");
  const shell = page
    .locator(".tool-summary")
    .filter({ hasText: "check.mjs" })
    .first();
  await shell.waitFor();
  if ((await shell.getAttribute("aria-expanded")) === "false")
    await shell.click();

  for (const [width, height] of sizes) {
    await app.evaluate(
      ({ BrowserWindow }, size) =>
        BrowserWindow.getAllWindows()[0].setSize(...size),
      [width, height],
    );
    await page.waitForTimeout(500);
    const geometry = await page.evaluate(() => {
      const box = (s) => document.querySelector(s).getBoundingClientRect();
      const c = box(".composer"),
        t = box(".timeline-area");
      const rows = [...document.querySelectorAll(".timeline-item")].map((e) =>
        e.getBoundingClientRect(),
      );
      return {
        overflow: document.documentElement.scrollWidth > innerWidth,
        inputFits: c.right <= innerWidth && c.bottom <= innerHeight,
        timelineFits: t.bottom <= c.top,
        overlaps: rows.slice(1).filter((r, i) => r.top < rows[i].bottom - 1)
          .length,
      };
    });
    assert.equal(geometry.overflow, false);
    assert.equal(geometry.inputFits, true);
    assert.equal(geometry.timelineFits, true);
    assert.equal(geometry.overlaps, 0);
    await page.locator(".timeline-scroll").evaluate((el) => {
      el.scrollTop = el.scrollHeight;
    });
    await page.waitForTimeout(200);
    await page.screenshot({ path: `test-results/style-main-${width}.png` });
    if (width === 1440)
      await page
        .locator(".file-edit-card")
        .screenshot({ path: "test-results/style-file-card.png" });

    await page
      .locator(".file-edit-card")
      .getByRole("button", { name: /^Открыть diff / })
      .first()
      .click();
    await page.getByRole("dialog").locator(".shiki").waitFor();
    const diffWindow = await page.evaluate(() => {
      const modal = document.querySelector('[role="dialog"]'),
        backdrop = modal.parentElement,
        b = modal.getBoundingClientRect();
      const line = modal.querySelector(".shiki .line:last-child"),
        l = line.getBoundingClientRect();
      const hit = document.elementFromPoint(l.left + 2, (l.top + l.bottom) / 2);
      return {
        portal: backdrop.parentElement === document.body,
        fits:
          b.left >= 0 &&
          b.right <= innerWidth &&
          b.top >= 36 &&
          b.bottom <= innerHeight,
        centered: Math.abs((b.left + b.right) / 2 - innerWidth / 2) < 1,
        contentVisible: modal.contains(hit),
      };
    });
    assert.equal(diffWindow.portal, true);
    assert.equal(diffWindow.fits, true);
    assert.equal(diffWindow.centered, true);
    assert.equal(diffWindow.contentVisible, true);
    await page.screenshot({ path: `test-results/style-diff-${width}.png` });
    await page
      .getByRole("dialog")
      .getByRole("button", { name: "Закрыть", exact: true })
      .click();

    await page.getByRole("button", { name: "Настройки", exact: true }).click();
    await page
      .locator(".integration-list > button")
      .first()
      .waitFor({ timeout: 20000 });
    const modal = await page.evaluate(() => {
      const d = document.querySelector(".settings-modal"),
        c = document.querySelector(".settings-content"),
        l = document.querySelector(".integration-list");
      const b = d.getBoundingClientRect();
      const scrolls = [...d.querySelectorAll("*")].filter(
        (el) =>
          ["auto", "scroll"].includes(getComputedStyle(el).overflowY) &&
          el.scrollHeight > el.clientHeight + 1,
      );
      return {
        fits:
          b.left >= 0 &&
          b.right <= innerWidth &&
          b.top >= 36 &&
          b.bottom <= innerHeight,
        overflow: c.scrollWidth > c.clientWidth,
        radius: getComputedStyle(d).borderTopLeftRadius,
        listOverflow: getComputedStyle(l).overflowY,
        scrollAreas: scrolls.length,
        rowHeight: l.firstElementChild.getBoundingClientRect().height,
      };
    });
    assert.equal(modal.fits, true);
    assert.equal(modal.overflow, false);
    assert.equal(modal.radius, "8px");
    assert.equal(modal.listOverflow, "visible");
    assert.equal(modal.scrollAreas, 1);
    assert.ok(modal.rowHeight <= 42);
    await page.screenshot({ path: `test-results/style-settings-${width}.png` });
    await page.getByPlaceholder("Найти провайдера…").fill("openai");
    await page.waitForTimeout(200);
    await page.screenshot({
      path: `test-results/style-providers-${width}.png`,
    });
    await page.getByRole("button", { name: "LM Studio", exact: true }).click();
    await page.getByLabel("Base URL", { exact: true }).waitFor();
    await page.screenshot({ path: `test-results/style-form-${width}.png` });
    await page
      .getByRole("button", { name: "Сохранить подключение", exact: true })
      .scrollIntoViewIfNeeded();
    assert.equal(
      await page
        .getByRole("button", { name: "Сохранить подключение", exact: true })
        .isVisible(),
      true,
    );
    await page.getByRole("button", { name: "Приложение", exact: true }).click();
    await page.screenshot({
      path: `test-results/style-application-${width}.png`,
    });
    await page
      .getByRole("dialog")
      .getByRole("button", { name: "Закрыть", exact: true })
      .click();
    results.push({ width, height, geometry, modal, diffWindow });
  }
  assert.deepEqual(errors, []);
  await fs.writeFile(
    "test-results/visual-style-verification.json",
    JSON.stringify(
      {
        passed: true,
        packaged: !!process.env.FORGE_PACKAGED,
        style,
        compactDiff,
        results,
        errors,
      },
      null,
      2,
    ),
  );
  console.log(
    "PASS neutral palette, radius tokens, expanded timeline, diff, settings/forms and single settings scroll at all 3 sizes",
  );
} catch (error) {
  if (page)
    await page
      .screenshot({ path: "test-results/style-failure.png" })
      .catch(() => {});
  throw error;
} finally {
  await app.close();
}
