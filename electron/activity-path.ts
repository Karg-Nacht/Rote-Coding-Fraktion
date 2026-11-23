import path from "node:path";

export function activityPath(file: string, directory?: string) {
  const paths =
    /^(?:[a-z]:|\\\\)/i.test(file) || /^(?:[a-z]:|\\\\)/i.test(directory ?? "")
      ? path.win32
      : path.posix;
  const base = directory && paths.isAbsolute(directory) ? directory : undefined;
  const full =
    !paths.isAbsolute(file) && base ? paths.resolve(base, file) : file;
  if (!base) return { full, display: file.replaceAll("\\", "/") };
  const relative = paths.relative(base, full);
  if (
    relative === ".." ||
    relative.startsWith(`..${paths.sep}`) ||
    paths.isAbsolute(relative)
  )
    return { full, display: full };
  return { full, display: relative.replaceAll("\\", "/") || "." };
}

export function fileDisplayPaths(
  file: string,
  directory: string | undefined,
  redact: (text: string) => string,
) {
  const { full, display } = activityPath(file, directory);
  return {
    ...(display !== file && { displayFile: redact(display) }),
    ...(full !== file && { fullFile: redact(full) }),
  };
}
