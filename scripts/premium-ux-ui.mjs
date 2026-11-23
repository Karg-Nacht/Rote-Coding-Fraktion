import { selectValue } from "./select-ui.mjs";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { _electron as electron } from "playwright";

await fs.mkdir(".runtime", { recursive: true });
const dataDir = await fs.mkdtemp(path.resolve(".runtime/premium-ux-ui-"));
const output = path.resolve("test-results/premium-ux");
await fs.mkdir(output, { recursive: true });

const titles = [
  "Rote Coding Fraktion",
  "Rote Magick Fraktion!",
  "God Left a Long Time Ago",
  "Karg Nacht",
  "Karg",
  "Assassination",
  "Firtan",
  "TRNA",
  "Harakiri for the Sky",
  "Ellende",
  "Lifelover",
  "Hypothermia",
  "Ghost Bath — The Sleeping Fields",
];
const app = await electron.launch({
  args: ["."],
  env: { ...process.env, RCF_DATA_DIR: dataDir },
});
const geometry = [];
const errors = [];

try {
  const page = await app.firstWindow();
  page.on("pageerror", (error) => errors.push(error.message));
  await page.locator(".status-dot.ready").waitFor({ timeout: 45_000 });
  const brand = page.locator(".title-center");
  const stone = brand.locator("img");
  const phrase = brand.locator(".title-phrases > span:last-child");
  const button = (name) => page.getByRole("button", { name, exact: true });
  const openPermissions = () => button("Агенты и разрешения").click();
  const permissions = page.getByRole("radiogroup");
  const mode = (value) => permissions.locator(`input[value="${value}"]`);
  const rules = page.locator("#setting-chat-permissions");

  await page.keyboard.press("Control+,");
  await openPermissions();
  assert.ok(await mode("cautious").isChecked());
  await mode("cautious").press("ArrowRight");
  await page.waitForFunction(
    () =>
      document.querySelector("#setting-mode input:checked").value ===
      "autonomous",
  );
  assert.equal(
    await mode("autonomous").evaluate(
      (el) => getComputedStyle(el.parentElement).outlineStyle,
    ),
    "solid",
  );
  await mode("full").click();
  const confirmation = page.getByRole("dialog", {
    name: "Включить Full Access?",
  });
  await confirmation.getByRole("button", { name: "Отмена" }).press("Enter");
  await confirmation.waitFor({ state: "hidden" });
  assert.ok(await mode("autonomous").isChecked());
  await mode("full").click();
  await confirmation
    .getByRole("button", { name: "Включить", exact: true })
    .click();
  await confirmation.waitFor({ state: "hidden" });
  assert.ok(await mode("full").isChecked());
  await mode("cautious").click();
  await page.waitForFunction(
    () =>
      document.querySelector("#setting-mode input:checked").value ===
      "cautious",
  );
  await rules.locator("summary").press("Enter");
  await rules.getByText(/^OpenCode запрещает все инструменты/).waitFor();
  await rules.locator("summary").press("Space");
  assert.equal(await rules.getAttribute("open"), null);

  for (const theme of ["dark", "light"]) {
    await button("Внешний вид").click();
    await selectValue(page.locator("#setting-theme .custom-select"), theme);
    await page.locator(`html[data-theme="${theme}"]`).waitFor();
    await openPermissions();
    await rules.locator("summary").click();
    for (const [width, height] of [
      [1440, 960],
      [1080, 720],
      [780, 600],
    ]) {
      await app.evaluate(
        ({ BrowserWindow }, size) => {
          BrowserWindow.getAllWindows()[0].setContentSize(...size);
        },
        [width, height],
      );
      await page.waitForFunction(
        ([w, h]) => innerWidth === w && innerHeight === h,
        [width, height],
      );
      await stone.evaluate((image) => image.decode());
      const bounds = await page.evaluate(() => {
        const rect = (selector) =>
          document.querySelector(selector).getBoundingClientRect();
        const bar = rect(".titlebar");
        const brand = rect(".title-center");
        const icon = rect(".title-center img");
        const text = document.querySelector(".title-phrases > span:last-child");
        const content = document.querySelector(".settings-content");
        return {
          offset: (brand.left + brand.right - bar.left - bar.right) / 2,
          gap: text.getBoundingClientRect().left - icon.right,
          controlClearance:
            rect(".window-controls").left - text.getBoundingClientRect().right,
          truncated: text.scrollWidth > text.clientWidth,
          overflow: content.scrollWidth > content.clientWidth,
          controls: document.querySelectorAll(".window-controls button").length,
          drag: getComputedStyle(document.querySelector(".titlebar"))
            .webkitAppRegion,
          noDrag: getComputedStyle(
            document.querySelector(".window-controls button"),
          ).webkitAppRegion,
        };
      });
      assert.ok(Math.abs(bounds.offset) < 1);
      assert.equal(bounds.gap, 7);
      assert.ok(bounds.controlClearance > 0);
      assert.equal(bounds.truncated, false);
      assert.equal(bounds.overflow, false);
      assert.equal(bounds.controls, 3);
      assert.equal(bounds.drag, "drag");
      assert.equal(bounds.noDrag, "no-drag");
      geometry.push({ theme, width, height, ...bounds });
      await page.mouse.move(4, 24);
      await page.screenshot({
        path: path.join(output, `permissions-${theme}-${width}.png`),
      });
    }
  }

  const windowState = () =>
    app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0].isMaximized(),
    );
  assert.equal(await windowState(), false);
  await button("Развернуть окно").click();
  assert.equal(await windowState(), true);
  await button("Развернуть окно").click();
  assert.equal(await windowState(), false);
  await page.waitForFunction(() => innerWidth === 780 && innerHeight === 600);

  // Drive the renderer clock from a known mount time while leaving CSS motion on Chromium's clock.
  const mountTime = new Date("2026-01-01T00:00:00Z");
  await page.clock.install({ time: mountTime });
  await page.clock.pauseAt(new Date(mountTime.getTime() + 1000));
  await page.reload();
  await brand.waitFor();
  assert.equal(await phrase.textContent(), titles[0]);
  const iconBounds = await stone.boundingBox();
  await page.clock.fastForward(20_999);
  assert.equal(await phrase.textContent(), titles[0]);
  for (const [index, title] of titles.slice(1).concat(titles[0]).entries()) {
    await page.clock.fastForward(index === 0 ? 1 : 21_000);
    await brand
      .getByText(title, { exact: true })
      .last()
      .waitFor({ state: "attached" });
    assert.equal(await phrase.textContent(), title);
    assert.deepEqual(await stone.boundingBox(), iconBounds);
    assert.equal(
      await phrase.evaluate((el) => el.scrollWidth > el.clientWidth),
      false,
    );
    if (index === 0) {
      assert.deepEqual(
        await brand.evaluate((el) => {
          const out = getComputedStyle(el.querySelector(".title-phrase-out"));
          const incoming = getComputedStyle(
            el.querySelector(".title-phrase-in"),
          );
          return [
            out.animationDuration,
            incoming.animationDelay,
            incoming.animationDuration,
          ];
        }),
        ["0.12s", "0.12s", "0.13s"],
      );
      await page.emulateMedia({ reducedMotion: "reduce" });
    }
    if (index > 0) {
      assert.deepEqual(
        await brand.evaluate((el) => [
          getComputedStyle(el.querySelector(".title-phrase-out")).display,
          getComputedStyle(el.querySelector(".title-phrase-in")).animationName,
        ]),
        ["none", "none"],
      );
    }
    if (title === titles.at(-1)) {
      await stone.evaluate((image) => image.decode());
      await page.screenshot({
        path: path.join(output, "titlebar-longest-light-780.png"),
      });
    }
  }
  assert.deepEqual(errors, []);
  await fs.writeFile(
    path.join(output, "verification.json"),
    JSON.stringify(
      {
        geometry,
        rotationIntervalMs: 21_000,
        titlesVerified: titles.length,
        reducedMotion: true,
        keyboardAndConfirmation: true,
        maximizeAndRestore: true,
        errors,
      },
      null,
      2,
    ),
  );
  console.log(
    "PASS permissions, 6 window geometries, 21-second title cycle and reduced motion",
  );
} finally {
  await app.close();
}
