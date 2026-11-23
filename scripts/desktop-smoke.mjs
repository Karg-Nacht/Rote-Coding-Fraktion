import { _electron as electron } from "playwright";
import fs from "node:fs/promises";
import path from "node:path";
await fs.mkdir("test-results", { recursive: true });
const app = await electron.launch({
  args: ["."],
  env: {
    ...process.env,
    FORGE_DATA_DIR: path.resolve(`.runtime/ui-smoke-${process.pid}`),
  },
  timeout: 30000,
});
try {
  const page = await app.firstWindow();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.locator(".welcome").getByRole("heading", { level: 1 }).waitFor();
  await page.waitForFunction(
    () => document.querySelector(".status-dot.ready"),
    null,
    { timeout: 40000 },
  );
  await page.screenshot({ path: "test-results/desktop-empty.png" });
  console.log(
    "Electron UI ready",
    await app.evaluate(({ app }) => ({
      version: app.getVersion(),
      electron: process.versions.electron,
      node: process.versions.node,
    })),
  );
  console.log(
    "Runtime security",
    await page.evaluate(() => ({
      node: typeof window.require,
      bridge: Object.keys(window.desktop),
    })),
  );
  console.log("Errors", errors);
} finally {
  await app.close();
}
