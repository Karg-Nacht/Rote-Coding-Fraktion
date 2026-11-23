import fs from "node:fs/promises";
import path from "node:path";
const lock = JSON.parse(await fs.readFile("package-lock.json", "utf8"));
const output = "resources/third-party-licenses";
await fs.mkdir(output, { recursive: true });
let count = 0;
for (const [directory, metadata] of Object.entries(lock.packages)) {
  if (!directory || metadata.dev || !directory.startsWith("node_modules/"))
    continue;
  const names = await fs.readdir(directory).catch(() => []);
  const info = JSON.parse(
    await fs
      .readFile(path.join(directory, "package.json"), "utf8")
      .catch(() => "{}"),
  );
  const texts = [];
  for (const filename of names.filter((name) =>
    /^(license|licence|copying|notice)(\.|$)/i.test(name),
  )) {
    const content = await fs
      .readFile(path.join(directory, filename), "utf8")
      .catch(() => "");
    if (content) texts.push(`--- ${filename} ---\n${content}`);
  }
  if (String(info.name).startsWith("@opencode/"))
    texts.push(await fs.readFile("resources/OPENCODE-LICENSE", "utf8"));
  await fs.writeFile(
    path.join(
      output,
      `${(info.name ?? directory).replace(/[^a-z0-9_.-]/gi, "_")}.txt`,
    ),
    `${info.name} ${info.version}\nLicense: ${info.license ?? metadata.license ?? "See upstream license"}\nRepository: ${typeof info.repository === "object" ? info.repository.url : (info.repository ?? "")}\n\n${texts.join("\n\n")}`,
  );
  count++;
}
console.log(`Collected notices for ${count} production packages.`);
