import { _electron as electron, expect } from "playwright/test";
import { Service } from "@opencode/client/service";
import { OpenCode } from "@opencode/client";
import fs from "node:fs/promises";
import path from "node:path";
import assert from "node:assert/strict";
import { createCanvas, loadImage } from "@napi-rs/canvas";

const directory = path.resolve(`.runtime/effort-animation-${process.pid}`),
  providerID = "effort-art-fixture";
const config = path.join(directory, "engine/config/opencode/opencode.json");
await fs.mkdir(path.dirname(config), { recursive: true });
await fs.mkdir("test-results", { recursive: true });
const models = {
  reasoner: {
    name: "Forge Reasoner",
    capabilities: { tools: true, input: ["text"], output: ["text"] },
    variants: ["low", "medium", "high", "xhigh"].map((id) => ({
      id,
      body: { reasoning_effort: id },
    })),
  },
  toggle: {
    name: "Thinking toggle",
    capabilities: { tools: true, input: ["text"], output: ["text"] },
    variants: [{ id: "thinking", body: { thinking: true } }],
  },
  plain: {
    name: "Simple Chat",
    capabilities: { input: ["text"], output: ["text"] },
    variants: [],
  },
};
await fs.writeFile(
  config,
  JSON.stringify({
    providers: {
      [providerID]: {
        name: "Effort art fixture",
        package: "@opencode/ai/providers/openai-compatible",
        settings: { baseURL: "http://127.0.0.1:9/v1" },
        models,
      },
    },
  }),
);
let app, page;
const errors = [];
const button = (name) => page.getByRole("button", { name, exact: true });
const rail = () => page.locator(".effort-psychedelic");
const slider = () => page.getByRole("slider");
const preferences = () =>
  page.evaluate(async () => (await window.desktop.bootstrap()).preferences);
async function shot(name, selector = ".effort-popover") {
  const box = await page.locator(selector).boundingBox();
  assert.ok(box);
  const clip = {
    x: Math.floor(box.x),
    y: Math.floor(box.y),
    width: Math.ceil(box.width),
    height: Math.ceil(box.height),
  };
  const png = await app.evaluate(
    async ({ BrowserWindow }, clip) =>
      (await BrowserWindow.getAllWindows()[0].capturePage(clip))
        .toPNG()
        .toString("base64"),
    clip,
  );
  if (name)
    await fs.writeFile(`test-results/${name}.png`, Buffer.from(png, "base64"));
  return png;
}
async function open() {
  await button("Choose model").click();
  await expect(page.locator(".effort-popover")).toBeVisible();
}
async function choose(name) {
  await button("Choose another model").click();
  await page.getByRole("menuitem", { name: new RegExp(name) }).click();
  await open();
}
async function animationState() {
  return page.evaluate(() => {
    const rail = document.querySelector(".effort-psychedelic"),
      svg = rail.querySelector("svg"),
      orb = rail.querySelector(".effort-orb"),
      box = rail.getBoundingClientRect(),
      knob = orb.getBoundingClientRect();
    return {
      duration: getComputedStyle(svg).animationDuration,
      animation: getComputedStyle(svg).animationName,
      orbAnimation: getComputedStyle(orb, "::before").animationName,
      ratio: rail.style.getPropertyValue("--effort-progress"),
      center: knob.x + knob.width / 2 - box.x,
      width: box.width,
      background: getComputedStyle(document.querySelector(".effort-popover"))
        .backgroundColor,
    };
  });
}
try {
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
  page.on("pageerror", (error) => errors.push(error.message));
  await page.waitForSelector(".status-dot.ready", { timeout: 45000 });
  const endpoint = await Service.discover({
    file: path.join(directory, "engine/state/opencode/service.json"),
    version: "2.3.0",
  });
  const client = OpenCode.make({
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
    (providerID) =>
      window.desktop.savePreferences({
        language: "en",
        animations: true,
        model: { id: "reasoner", providerID },
        favoriteModels: ["reasoner", "toggle", "plain"].map((id) => ({
          id,
          providerID,
        })),
      }),
    providerID,
  );
  await page.reload();
  await expect(button("Choose model")).toContainText("Forge Reasoner");
  await open();
  await expect(slider()).toBeFocused();
  await page.waitForTimeout(300);
  const low = await animationState();
  assert.equal(low.duration, "18s");
  assert.ok(Math.abs(low.center - 11.5) < 1);
  assert.equal(low.background, "rgb(35, 35, 35)");
  const first = await shot("effort-psychedelic-auto");
  await page.waitForTimeout(450);
  const second = await shot(null);
  assert.notEqual(
    first,
    second,
    "Visible artwork must actually animate, not only declare an animation",
  );
  // Compare actual rendered endpoints, including a deliberately unwrapped end
  // transform. An infinite animation alone would reset to zero and hide a seam.
  await page.evaluate(() => {
    for (const animation of document
      .querySelector(".effort-psychedelic")
      .getAnimations({ subtree: true })) {
      animation.pause();
      animation.currentTime = 0;
    }
    const flow = document
      .querySelector(".effort-spectrum-motion")
      .getAnimations()[0];
    flow.effect.updateTiming({ iterations: 1, fill: "both" });
  });
  await page.waitForTimeout(80);
  const startFrame = await shot("effort-seamless-start", ".effort-spectrum");
  await page.evaluate(() => {
    const flow = document
      .querySelector(".effort-spectrum-motion")
      .getAnimations()[0];
    flow.currentTime = Number(flow.effect.getTiming().duration);
  });
  await page.waitForTimeout(80);
  const endFrame = await shot("effort-seamless-end", ".effort-spectrum");
  const pixels = async (png) => {
    const image = await loadImage(Buffer.from(png, "base64"));
    const canvas = createCanvas(image.width, image.height);
    const context = canvas.getContext("2d");
    context.drawImage(image, 0, 0);
    return context.getImageData(0, 0, image.width, image.height).data;
  };
  const [startPixels, endPixels] = await Promise.all([
    pixels(startFrame),
    pixels(endFrame),
  ]);
  assert.equal(startPixels.length, endPixels.length);
  const meanError =
    startPixels.reduce(
      (sum, value, index) => sum + Math.abs(value - endPixels[index]),
      0,
    ) / startPixels.length;
  assert.ok(
    meanError < 0.25,
    `Loop endpoints must match, pixel error ${meanError}`,
  );
  console.log(
    `Seamless loop rendered endpoint pixel error: ${meanError.toFixed(4)}`,
  );
  await page.evaluate(() => {
    for (const animation of document
      .querySelector(".effort-psychedelic")
      .getAnimations({ subtree: true })) {
      if (animation.effect.target?.matches?.(".effort-spectrum-motion"))
        animation.effect.updateTiming({ iterations: Infinity, fill: "none" });
      animation.currentTime = 0;
      animation.play();
    }
  });
  await slider().press("End");
  await expect(slider()).toHaveAttribute("aria-valuetext", "Extra High");
  await page.waitForTimeout(65);
  const moving = await animationState();
  assert.ok(
    moving.center > 12 && moving.center < moving.width - 12,
    "Knob travels smoothly between steps",
  );
  await page.waitForTimeout(300);
  const high = await animationState();
  assert.equal(high.duration, "8s");
  assert.ok(Math.abs(high.center - (high.width - 11.5)) < 1);
  assert.equal((await preferences()).model.variant, "xhigh");
  await shot("effort-psychedelic-high");
  await slider().press("Home");
  await slider().press("ArrowRight");
  await expect(slider()).toHaveAttribute("aria-valuetext", "Low");
  assert.equal((await preferences()).model.variant, "low");
  await page.waitForTimeout(300);
  await shot("effort-psychedelic-low");
  const box = await slider().boundingBox();
  await page.mouse.move(box.x + box.width / 4, box.y + box.height / 2);
  await page.mouse.down();
  await expect(rail()).toHaveClass(/is-dragging/);
  await page.mouse.move(box.x + box.width - 4, box.y + box.height / 2, {
    steps: 8,
  });
  await page.mouse.up();
  await expect(rail()).not.toHaveClass(/is-dragging/);
  await expect(slider()).toHaveValue("4");
  assert.equal((await preferences()).model.variant, "xhigh");
  await button("Reset to default").click();
  await expect(slider()).toHaveValue("0");
  await choose("Thinking toggle");
  await slider().press("End");
  await expect(slider()).toHaveAttribute("aria-valuetext", "thinking");
  assert.equal((await preferences()).model.variant, "thinking");
  await page.waitForTimeout(350);
  await shot("effort-psychedelic-thinking");
  await choose("Simple Chat");
  await expect(slider()).toHaveCount(0);
  await expect(
    page.getByText("This model has no reasoning setting.", { exact: true }),
  ).toBeVisible();
  await button("Choose another model").click();
  await page.getByRole("menuitem", { name: /Forge Reasoner/ }).click();
  await open();
  await slider().press("End");
  await page.waitForTimeout(350);
  for (const [width, height, zoom] of [
    [780, 600, 1],
    [1080, 800, 2],
  ]) {
    await app.evaluate(
      ({ BrowserWindow }, [w, h, z]) => {
        const win = BrowserWindow.getAllWindows()[0];
        win.setSize(w, h);
        win.webContents.setZoomFactor(z);
      },
      [width, height, zoom],
    );
    await page.waitForTimeout(250);
    const fits = await page.locator(".effort-popover").evaluate((el) => {
      const r = el.getBoundingClientRect();
      return (
        r.left >= 0 &&
        r.right <= innerWidth &&
        r.top >= 35 &&
        r.bottom <= innerHeight
      );
    });
    assert.ok(fits);
  }
  await app.evaluate(({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows()[0];
    win.webContents.setZoomFactor(1);
    win.setSize(1440, 900);
  });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await expect
    .poll(async () => (await animationState()).animation)
    .toBe("none");
  assert.equal((await animationState()).orbAnimation, "none");
  await page.waitForTimeout(250);
  const still = await shot("effort-psychedelic-reduced");
  await page.waitForTimeout(350);
  assert.equal(
    await shot(null),
    still,
    "System reduced motion stops the visible artwork",
  );
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await slider().press("Escape");
  await page.evaluate(() =>
    window.desktop.savePreferences({ animations: false }),
  );
  await page.reload();
  await open();
  assert.equal((await animationState()).animation, "none");
  assert.equal((await animationState()).orbAnimation, "none");
  assert.deepEqual(errors, []);
  console.log(
    "PASS seamless rendered loop endpoints, animated SVG pixels, smooth knob movement, intensity/speed, native drag and keyboard, exact variants/default reset, unsupported model, 100/200% layout, app and system reduced motion",
  );
} catch (error) {
  if (page) await shot("effort-psychedelic-failure").catch(() => {});
  throw error;
} finally {
  if (app) await app.close().catch(() => {});
}
