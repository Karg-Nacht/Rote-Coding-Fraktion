import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { listPackage, extractFile } from "@electron/asar";
import assert from "node:assert/strict";
import * as PE from "pe-library";
import { Data, Resource } from "resedit";

const archive = "release/win-unpacked/resources/app.asar";
const entries = listPackage(archive).map((file) =>
  file.replaceAll("\\", "/").replace(/^\//, ""),
);
assert.ok(entries.includes("dist-electron/main.js"));
for (const file of ["dist-electron/main.js", "dist-electron/preload.cjs"])
  assert.equal(
    extractFile(archive, file).toString(),
    await fs.readFile(file, "utf8"),
  );
const metadata = JSON.parse(extractFile(archive, "package.json").toString());
assert.equal(metadata.name, "rcf");
assert.equal(metadata.version, "0.2.1");
assert.equal(
  entries.some((file) =>
    /^(\.runtime|\.cache|test-results|\.env)(\/|$)/.test(file),
  ),
  false,
);
assert.equal(
  extractFile(archive, "dist/index.html").toString(),
  await fs.readFile("dist/index.html", "utf8"),
);
for (const file of await fs.readdir("dist/assets")) {
  assert.deepEqual(
    extractFile(archive, path.join("dist", "assets", file)),
    await fs.readFile(`dist/assets/${file}`),
  );
}
for (const name of ["rcf.ico", "rcf-light.ico"]) {
  assert.deepEqual(
    await fs.readFile(`release/win-unpacked/resources/${name}`),
    await fs.readFile(`resources/${name}`),
  );
}
const expectedIcons = Data.IconFile.from(
  await fs.readFile("resources/rcf.ico"),
).icons;
const executableIcons = [];
for (const file of [
  "release/win-unpacked/Rote Coding Fraktion.exe",
  "release/RCF-0.2.1-x64-Portable.exe",
  "release/RCF-0.2.1-x64-Setup.exe",
]) {
  const resources = PE.NtExecutableResource.from(
    PE.NtExecutable.from(await fs.readFile(file)),
  );
  const groups = Resource.IconGroupEntry.fromEntries(resources.entries);
  const match = groups.some((group) => {
    const icons = group.getIconItemsFromEntries(resources.entries);
    return (
      icons.length === expectedIcons.length &&
      expectedIcons.every((expected) =>
        icons.some(
          (icon) =>
            icon.isRaw() &&
            Buffer.from(icon.bin).equals(Buffer.from(expected.data.bin)),
        ),
      )
    );
  });
  assert.ok(
    match,
    `${file} must embed the new rounded application icon at every size`,
  );
  executableIcons.push({
    file,
    roundedIconSizes: expectedIcons.map((icon) => icon.data.width || 256),
  });
}
const hashFile = async (file) => {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest("hex");
};
const bundledEngine = await hashFile(
  "release/win-unpacked/resources/engine/opencode.exe",
);
assert.equal(
  bundledEngine,
  await hashFile("node_modules/@opencode/cli/bin/opencode.exe"),
);
const artifacts = [];
for (const name of ["RCF-0.2.1-x64-Portable.exe", "RCF-0.2.1-x64-Setup.exe"]) {
  const file = path.join("release", name),
    stat = await fs.stat(file);
  artifacts.push({ name, bytes: stat.size, sha256: await hashFile(file) });
}
await fs.writeFile(
  "test-results/artifact-verification.json",
  JSON.stringify(
    {
      passed: true,
      archiveEntries: entries.length,
      profileDataExcluded: true,
      currentProductionUi: true,
      themeIconsBundled: true,
      executableIcons,
      bundledEngine,
      artifacts,
    },
    null,
    2,
  ),
);
await fs.writeFile(
  "release/SHA256SUMS.txt",
  artifacts.map((file) => `${file.sha256}  ${file.name}`).join("\n") + "\n",
);
console.log(
  "PASS archive contents, current UI, bundled engine identity and artifact SHA-256",
);
