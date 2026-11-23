import { _electron as electron } from "playwright";
import fs from "node:fs/promises";
import path from "node:path";
import assert from "node:assert/strict";
const qa = JSON.parse(
  await fs.readFile("test-results/rcf-integration.json", "utf8"),
);
const executable = process.env.RCF_PACKAGED;
const theme = process.env.RCF_THEME ?? "dark";
const suffix = `${executable ? "-packaged" : ""}-${theme}`;
const app = await electron.launch({
  args: executable ? [] : ["."],
  executablePath: executable,
  env: { ...process.env, FORGE_DATA_DIR: path.join(qa.directory, "profile") },
  timeout: 30000,
});
const errors = [];
try {
  const page = await app.firstWindow();
  page.on("pageerror", (e) => errors.push(e.message));
  await page.waitForSelector(".status-dot.ready", { timeout: 40000 });
  await page.evaluate(
    (theme) => window.desktop.savePreferences({ theme }),
    theme,
  );
  const session = await page.evaluate(
    async (id) => (await window.desktop.openSession(id)).session,
    qa.writerId,
  );
  await page.reload();
  await page.waitForFunction(
    (expected) =>
      document.querySelector(".workspace-title>span")?.textContent ===
        expected.title &&
      document.querySelector(".rcf-context>.rcf-directory")?.textContent ===
        expected.directory,
    session,
  );
  const composer = page.getByRole("textbox", {
    name: "Сообщение агенту",
    exact: true,
  });
  await composer.fill("Preserve this existing draft.");
  await page
    .getByRole("button", { name: "Действия с задачей", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Изменения проекта", exact: true })
    .click();
  await page
    .locator(".git-branch")
    .getByText("rcf/task-b", { exact: true })
    .waitFor();
  await page.getByRole("button", { name: /^Full diff ·/ }).click();
  await page
    .getByRole("dialog", { name: "Full diff", exact: true })
    .locator(".diff-content")
    .getByText("+task B", { exact: false })
    .waitFor();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Закрыть", exact: true })
    .click();
  await page
    .locator(".git-panel .diff-file")
    .filter({ hasText: "b.txt" })
    .click();
  const dialog = page.getByRole("dialog", { name: "b.txt", exact: true });
  await dialog.waitFor();
  assert.ok(
    await dialog.getByRole("button", { name: "Previous file" }).isDisabled(),
  );
  assert.ok(
    await dialog.getByRole("button", { name: "Next file" }).isDisabled(),
  );
  await dialog
    .getByRole("textbox", { name: "Diff comment", exact: true })
    .fill("Please check this change.");
  await dialog
    .getByRole("spinbutton", { name: "Diff line (new version)", exact: true })
    .fill("999");
  assert.ok(
    await dialog
      .getByRole("button", { name: "Add to message draft" })
      .isDisabled(),
  );
  await dialog
    .getByRole("spinbutton", { name: "Diff line (new version)", exact: true })
    .fill("1");
  await dialog.locator(".shiki .diff-add").waitFor();
  const colors = await dialog
    .locator(".shiki .diff-add")
    .first()
    .evaluate((el) => ({
      background: getComputedStyle(el).backgroundColor,
      text: getComputedStyle(el.querySelector("span") ?? el).color,
    }));
  assert.equal(
    colors.background,
    theme === "light" ? "rgb(225, 237, 223)" : "rgb(28, 42, 30)",
  );
  await page.screenshot({ path: `test-results/rcf-diff${suffix}.png` });
  await dialog.getByRole("button", { name: "Add to message draft" }).click();
  const draft = await composer.inputValue();
  assert.ok(draft.startsWith("Preserve this existing draft.\n\n"));
  assert.ok(draft.includes("b.txt:1"));
  assert.ok(draft.includes("Please check this change."));
  assert.ok(draft.includes("+task B"));
  assert.deepEqual(errors, []);
  await fs.writeFile(
    `test-results/rcf-diff-ui${suffix}.json`,
    JSON.stringify(
      {
        passed: true,
        packaged: !!executable,
        theme,
        colors,
        taskBranch: "rcf/task-b",
        fullDiff: true,
        fileNavigation: true,
        lineValidation: true,
        commentAppendsDraft: true,
        noAutoSend: true,
        errors,
      },
      null,
      2,
    ),
  );
  console.log(
    "PASS task-specific full Git diff, file navigation, invalid line rejection, exact diff excerpt and draft preservation without sending",
  );
} finally {
  await app.close();
}
