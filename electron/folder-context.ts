import fs from "node:fs/promises";
import path from "node:path";

// A folder attachment is a bounded directory listing. No file contents or links are read.
export async function folderContext(directory: string) {
  const root = await fs.realpath(directory);
  const lines = [
    `Folder: ${path.basename(root)}`,
    `Location: ${root}`,
    "Directory listing only; file contents are not attached.",
    "",
  ];
  const ignore =
    /^(?:\.git|node_modules|\.env(?:\..*)?|credentials.*|id_rsa.*|id_ed25519.*)$/i;
  let count = 0;
  let truncated = false;
  const walk = async (current: string, depth: number) => {
    const entries = (await fs.readdir(current, { withFileTypes: true }))
      .filter((e) => !ignore.test(e.name) && !e.isSymbolicLink())
      .sort(
        (a, b) =>
          Number(b.isDirectory()) - Number(a.isDirectory()) ||
          a.name.localeCompare(b.name),
      );
    for (const entry of entries) {
      if (++count > 200) {
        truncated = true;
        return;
      }
      lines.push(
        `${"  ".repeat(depth)}${entry.name}${entry.isDirectory() ? "/" : ""}`,
      );
      if (entry.isDirectory() && depth < 2)
        await walk(path.join(current, entry.name), depth + 1).catch(() =>
          lines.push(`${"  ".repeat(depth + 1)}[unavailable]`),
        );
      if (truncated) return;
    }
  };
  await walk(root, 0);
  if (truncated) lines.push("[Directory listing limited to 200 entries.]");
  return {
    name: `${path.basename(root)}.structure.txt`,
    mime: "text/plain",
    bytes: new TextEncoder().encode(lines.join("\n")),
  };
}
