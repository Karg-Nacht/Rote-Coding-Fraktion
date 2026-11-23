import fs from "node:fs/promises";
import path from "node:path";

export function safeExternal(value: string): string {
  const url = new URL(value);
  if (
    !["https:", "http:"].includes(url.protocol) ||
    url.username ||
    url.password
  )
    throw new Error("Разрешены только HTTP(S) ссылки без пароля.");
  return url.href;
}
export function contained(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return (
    relative === "" ||
    (!relative.startsWith(`..${path.sep}`) &&
      relative !== ".." &&
      !path.isAbsolute(relative))
  );
}
export async function safeFile(root: string, input: string): Promise<string> {
  const canonicalRoot = await fs.realpath(root);
  const target = await fs.realpath(path.resolve(canonicalRoot, input));
  if (!contained(canonicalRoot, target))
    throw new Error("Файл находится за пределами выбранного проекта.");
  if (!(await fs.stat(target)).isFile()) throw new Error("Ожидался файл.");
  return target;
}
export class Redactor {
  private secrets = new Set<string>();
  add(secret: string) {
    if (secret.length >= 6) this.secrets.add(secret);
  }
  text(input: string): string {
    let result = input;
    for (const secret of this.secrets)
      result = result.split(secret).join("[скрыто]");
    return result
      .replace(/(Bearer\s+)[A-Za-z0-9._~+\/-]{16,}/gi, "$1[скрыто]")
      .replace(/\bsk-(?:or-v1-)?[A-Za-z0-9_-]{16,}\b/g, "[скрыто]");
  }
  error(error: unknown): string {
    return this.text(
      error instanceof Error ? error.message : String(error),
    ).slice(0, 2000);
  }
}
