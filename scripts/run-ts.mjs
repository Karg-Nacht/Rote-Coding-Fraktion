import { build } from "esbuild";
import { spawn } from "node:child_process";
import { mkdirSync, readdirSync } from "node:fs";
import path from "node:path";
const input = process.argv[2];
mkdirSync(".runtime/scripts", { recursive: true });
const files =
  input === "--test"
    ? readdirSync("tests")
        .filter((f) => f.endsWith(".test.ts"))
        .map((f) => `tests/${f}`)
    : [input];
const outputs = [];
for (const file of files) {
  const output = path.resolve(
    ".runtime/scripts",
    path.basename(file, ".ts") + ".mjs",
  );
  await build({
    entryPoints: [file],
    outfile: output,
    bundle: true,
    platform: "node",
    target: "node22",
    format: "esm",
    packages: "external",
  });
  outputs.push(output);
}
const child = spawn(
  process.execPath,
  [...(input === "--test" ? ["--test"] : []), ...outputs],
  { stdio: "inherit", windowsHide: true },
);
child.on("exit", (code) => process.exit(code ?? 1));
