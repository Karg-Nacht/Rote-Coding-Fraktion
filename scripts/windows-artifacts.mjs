import { readFile } from "node:fs/promises";

export const metadata = JSON.parse(
  await readFile(new URL("../package.json", import.meta.url), "utf8"),
);
const artifact = (pattern) =>
  pattern
    .replace("${version}", metadata.version)
    .replace("${arch}", "x64")
    .replace("${ext}", "exe");

export const portableName = artifact(metadata.build.portable.artifactName);
export const setupName = artifact(metadata.build.nsis.artifactName);
export const appName = `${metadata.build.win.executableName}.exe`;
