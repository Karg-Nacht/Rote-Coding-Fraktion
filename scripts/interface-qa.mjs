import { _electron as electron } from "playwright";
import fs from "node:fs/promises";
import path from "node:path";
import assert from "node:assert/strict";
const dataDir = path.resolve(`.runtime/interface-qa-${process.pid}`);
const projectDir = path.join(dataDir, "Проект");
await fs.mkdir(projectDir, { recursive: true });
let app;
async function launch() {
  app = await electron.launch({
    args: ["."],
    env: { ...process.env, FORGE_DATA_DIR: dataDir },
    timeout: 30000,
  });
  const page = await app.firstWindow();
  page.on("pageerror", (e) => {
    console.error("PAGE ERROR", e);
  });
  await page.waitForSelector(".status-dot.ready", { timeout: 40000 });
  return page;
}
try {
  let page = await launch();
  await app.evaluate(({ dialog }, project) => {
    dialog.showOpenDialog = async () => ({
      canceled: false,
      filePaths: [project],
    });
  }, projectDir);
  await page.getByRole("button", { name: "Выбрать проект", exact: true }).click();
  await page.getByRole("button", { name: "Открыть другую папку…", exact: true }).click();
  await page
    .getByRole("button", { name: "Новая задача", exact: true })
    .last()
    .click();
  await page.locator(".session-row").first().waitFor();
  const title = await page.locator(".session-title").first().innerText();
  await page.locator(".session-row").first().hover();
  await page
    .getByRole("button", { name: "Закрепить чат", exact: true })
    .first()
    .click();
  await page
    .locator(".sidebar-section")
    .filter({ hasText: "Закреплено" })
    .locator(".session-row")
    .waitFor();
  assert.equal(await page.locator(".session-row").count(), 1);
  await page.locator(".session-row").first().hover();
  await page
    .getByRole("button", { name: "Архивировать чат", exact: true })
    .first()
    .click();
  await page.locator(".session-row").first().waitFor({ state: "detached" });
  await page.getByRole("button", { name: "Архив чатов" }).click();
  await page.getByText(title, { exact: true }).waitFor();
  await page.getByRole("button", { name: /Восстановить чат/ }).click();
  await page.getByText("В архиве пока нет чатов.").waitFor();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Закрыть" })
    .click();
  await page
    .locator(".sidebar-section")
    .filter({ hasText: "Закреплено" })
    .locator(".session-row")
    .waitFor();
  await page.getByRole("button", { name: "Выбрать модель" }).click();
  await page.getByRole("menuitem", { name: /Найти и закрепить/ }).click();
  const catalog = page.getByRole("dialog", { name: "Каталог моделей" });
  await catalog.locator(".model-option").first().waitFor();
  const first = catalog.locator(".model-option").first();
  const name = await first
    .locator("button")
    .first()
    .locator("span")
    .first()
    .evaluate((el) => el.childNodes[0].textContent.trim());
  const search = catalog.getByPlaceholder("Модель или провайдер…");
  await search.fill("__no_such_model__");
  await catalog.getByText("Модели не найдены.").waitFor();
  await search.fill(name);
  await first.waitFor();
  await first.getByRole("button", { name: /^Закрепить модель/ }).click();
  await first.getByRole("button", { name: /^Открепить модель/ }).waitFor();
  await catalog.getByRole("button", { name: "Закрыть" }).click();
  await page.getByRole("button", { name: "Выбрать модель" }).click();
  assert.equal(await page.getByRole("menuitem").count(), 2);
  assert.ok((await page.locator(".model-popover").innerText()).includes(name));
  for (const size of [
    [1440, 900],
    [780, 600],
  ]) {
    await app.evaluate(
      ({ BrowserWindow }, size) =>
        BrowserWindow.getAllWindows()[0].setSize(...size),
      size,
    );
    await page.waitForTimeout(200);
    const layout = await page.evaluate(() => {
      const p = document
        .querySelector(".model-popover")
        .getBoundingClientRect();
      const c = document.querySelector(".composer").getBoundingClientRect();
      return {
        fits:
          p.left >= 0 &&
          p.right <= innerWidth &&
          p.top >= 0 &&
          c.right <= innerWidth,
        font: getComputedStyle(document.querySelector(".model-select"))
          .fontSize,
        composer: c.height,
      };
    });
    assert.ok(layout.fits, JSON.stringify(layout));
    console.log("layout", size, layout);
    await page.screenshot({ path: `test-results/interface-${size[0]}.png` });
  }
  await page.getByRole("menuitem").filter({ hasText: name }).click();
  assert.ok(
    (
      await page.getByRole("button", { name: "Выбрать модель" }).innerText()
    ).includes(name),
  );
  const lineHeight = await page.evaluate(() => {
    const sample = document.createElement("div");
    sample.className = "assistant-message";
    sample.innerHTML = '<div class="markdown">Текст агента</div>';
    document.body.append(sample);
    const style = getComputedStyle(sample.firstElementChild);
    const ratio = parseFloat(style.lineHeight) / parseFloat(style.fontSize);
    sample.remove();
    return ratio;
  });
  assert.ok(lineHeight >= 1.2 && lineHeight <= 1.3);
  await app.close();
  page = await launch();
  await page.getByRole("button", { name: "Выбрать модель" }).click();
  await page.waitForFunction(
    (name) =>
      document.querySelector(".model-popover")?.innerText.includes(name),
    name,
  );
  await page
    .locator(".sidebar-section")
    .filter({ hasText: "Закреплено" })
    .locator(".session-row")
    .waitFor();
  console.log(
    "PASS archive/restore, pinned session and model persist on restart",
  );
} finally {
  if (app) await app.close().catch(() => {});
}
