import path from "node:path";
// Keep tool downloads in the workspace, including restricted Windows runs.
process.env.ELECTRON_BUILDER_CACHE ??= path.resolve(".cache/electron-builder");
const { build, Platform, Arch } = await import("electron-builder");
await build({
  targets: Platform.WINDOWS.createTarget(
    process.argv.includes("--dir") ? ["dir"] : ["portable", "nsis"],
    Arch.x64,
  ),
});
