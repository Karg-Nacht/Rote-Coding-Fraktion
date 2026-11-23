import { spawn } from "node:child_process";
import { createServer } from "vite";
import { mkdirSync } from "node:fs";
import path from "node:path";
import electron from "electron";
await import("./build-main.mjs");
const server = await createServer();
await server.listen();
mkdirSync(".runtime/desktop", { recursive: true });
const child = spawn(electron, ["."], {
  stdio: "inherit",
  windowsHide: true,
  env: {
    ...process.env,
    FORGE_DEV_URL: "http://127.0.0.1:5183",
    FORGE_DATA_DIR: path.resolve(".runtime/desktop"),
  },
});
child.on("close", async (code) => {
  await server.close();
  process.exit(code ?? 0);
});
