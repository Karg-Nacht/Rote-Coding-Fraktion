import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { listPackage, extractFile } from "@electron/asar";
import assert from "node:assert/strict";
import * as PE from "pe-library";
import { Data, Resource } from "resedit";
import {
  appName,
  metadata,
  portableName,
  setupName,
} from "./windows-artifacts.mjs";

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
const packaged = JSON.parse(extractFile(archive, "package.json").toString());
assert.equal(packaged.name, metadata.name);
assert.equal(packaged.version, metadata.version);
assert.equal(
  packaged.dependencies["@opencode/client"],
  metadata.dependencies["@opencode/client"],
);
assert.equal(
  entries.some((file) =>
    /(?:^|\/)(?:\.git|\.runtime|\.cache|test-results|\.env(?:\.[^/]*)?|forge\.sqlite(?:-wal|-shm)?|credentials\.json)(?:\/|$)/i.test(
      file,
    ),
  ),
  false,
);
assert.ok(
  entries.every((file) =>
    /^(?:dist|dist-electron|node_modules)(?:\/|$)|^(?:package\.json|LICENSE(?:\.txt)?|THIRD_PARTY_NOTICES\.md)$/.test(
      file,
    ),
  ),
  "App archive contains only production files and dependencies",
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
  `release/win-unpacked/${appName}`,
  `release/${portableName}`,
  `release/${setupName}`,
]) {
  const executable = PE.NtExecutable.from(await fs.readFile(file));
  if (file.includes("win-unpacked"))
    assert.equal(
      executable.newHeader.fileHeader.machine,
      0x8664,
      "Electron payload is Windows x64",
    );
  const resources = PE.NtExecutableResource.from(executable);
  const versions = Resource.VersionInfo.fromEntries(resources.entries).flatMap(
    (info) =>
      info
        .getAllLanguagesForStringValues()
        .map((language) => info.getStringValues(language)),
  );
  const expectedVersions = [metadata.version, `${metadata.version}.0`];
  assert.ok(
    versions.some(
      (strings) =>
        expectedVersions.includes(strings.ProductVersion) &&
        expectedVersions.includes(strings.FileVersion),
    ),
    `${file} must advertise ${metadata.version}`,
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
const engine = PE.NtExecutable.from(
  await fs.readFile("release/win-unpacked/resources/engine/opencode.exe"),
  { ignoreCert: true },
);
assert.equal(
  engine.newHeader.fileHeader.machine,
  0x8664,
  "Bundled OpenCode is Windows x64",
);
assert.equal(
  bundledEngine,
  await hashFile("node_modules/@opencode/cli/bin/opencode.exe"),
);
const artifacts = [];
for (const name of [portableName, setupName]) {
  const file = path.join("release", name),
    stat = await fs.stat(file);
  artifacts.push({ name, bytes: stat.size, sha256: await hashFile(file) });
  assert.ok(
    stat.isFile() && stat.size > 0,
    `${name} must be a non-empty executable`,
  );
}
await fs.mkdir("test-results", { recursive: true });
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
