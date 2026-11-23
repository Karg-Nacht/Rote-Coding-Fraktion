import path from "node:path";
import { spawnSync } from "node:child_process";
import { mkdirSync } from "node:fs";
const data = path.resolve(".runtime/setup");
mkdirSync(data, { recursive: true });
const env = {
  ...process.env,
  electron_config_cache: path.resolve(".cache/electron"),
  npm_config_cache: path.resolve(".cache/npm"),
  XDG_DATA_HOME: path.join(data, "data"),
  XDG_CONFIG_HOME: path.join(data, "config"),
  XDG_STATE_HOME: path.join(data, "state"),
  XDG_CACHE_HOME: path.join(data, "cache"),
};
for (const file of [
  "node_modules/electron/install.js",
  "node_modules/@opencode/cli/postinstall.mjs",
]) {
  const result = spawnSync(process.execPath, [file], {
    env,
    stdio: "inherit",
    windowsHide: true,
  });
  if (result.status !== 0) process.exit(result.status ?? 1);
}
console.log("Electron and OpenCode 2.3.0 are ready.");
