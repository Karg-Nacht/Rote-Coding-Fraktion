export const ATTACHMENT_LIMITS = {
  files: 20,
  fileBytes: 20 * 1024 * 1024,
  requestBytes: 40 * 1024 * 1024,
  textCharacters: 128_000,
  pdfTextPages: 12,
  pdfVisualPages: 6,
  pdfMaximumPages: 500,
} as const;

export const supportedImageMime = /^image\/(png|jpeg|webp|gif|avif|bmp)$/;

/** Magic bytes are authoritative; file names and browser MIME are only hints. */
export function signatureMime(bytes: Uint8Array): string | undefined {
  const ascii = (start: number, length: number) =>
    String.fromCharCode(...bytes.subarray(start, start + length));
  if (
    bytes.length >= 24 &&
    bytes[0] === 137 &&
    ascii(1, 7) === "PNG\r\n\x1a\n" &&
    ascii(12, 4) === "IHDR"
  )
    return "image/png";
  if (
    bytes.length >= 4 &&
    bytes[0] === 255 &&
    bytes[1] === 216 &&
    bytes[2] === 255
  )
    return "image/jpeg";
  if (bytes.length >= 12 && ascii(0, 4) === "RIFF" && ascii(8, 4) === "WEBP")
    return "image/webp";
  if (bytes.length >= 13 && ["GIF87a", "GIF89a"].includes(ascii(0, 6)))
    return "image/gif";
  if (bytes.length >= 26 && ascii(0, 2) === "BM") return "image/bmp";
  if (
    bytes.length >= 16 &&
    ascii(4, 4) === "ftyp" &&
    /avif|avis/.test(ascii(8, Math.min(64, bytes.length - 8)))
  )
    return "image/avif";
  if (ascii(0, Math.min(1024, bytes.length)).includes("%PDF-"))
    return "application/pdf";
  return undefined;
}

export function attachmentName(value: string): string {
  const clean = value
    .split(/[\\/]/)
    .at(-1)
    ?.replace(/[\u0000-\u001f\u007f]/g, "")
    .trim();
  return (clean || "Вложение").slice(0, 240);
}

export function decodeAttachmentText(bytes: Uint8Array): string {
  let text: string;
  try {
    // Unicode text files from Windows commonly carry a UTF-16 BOM.
    const encoding =
      bytes[0] === 255 && bytes[1] === 254
        ? "utf-16le"
        : bytes[0] === 254 && bytes[1] === 255
          ? "utf-16be"
          : "utf-8";
    text = new TextDecoder(encoding, { fatal: true }).decode(bytes);
  } catch {
    throw new Error(
      "Файл не является текстом UTF-8/UTF-16 или поддерживаемым изображением/PDF.",
    );
  }
  if (/[\u0000-\u0008\u000b\u000e-\u001f]/.test(text))
    throw new Error(
      "Неподдерживаемый бинарный файл. Выберите изображение, PDF или текстовый файл.",
    );
  return text.replace(/\r\n?/g, "\n");
}

export function parsePageRange(
  value: string,
  pageCount: number,
  maxPages = ATTACHMENT_LIMITS.pdfVisualPages,
): number[] {
  const pages = new Set<number>();
  for (const part of value.split(/[,;]+/)) {
    const match = /^\s*(\d+)\s*(?:-\s*(\d+)\s*)?$/.exec(part);
    if (!match) throw new Error("Укажите страницы, например: 1, 3-5.");
    const first = Number(match[1]),
      last = Number(match[2] ?? match[1]);
    if (first < 1 || last < first || last > pageCount)
      throw new Error(`Номер страницы должен быть от 1 до ${pageCount}.`);
    if (last - first + 1 > maxPages)
      throw new Error(
        `За один запрос можно подготовить до ${maxPages} страниц.`,
      );
    for (let page = first; page <= last; page++) pages.add(page);
    if (pages.size > maxPages)
      throw new Error(
        `За один запрос можно подготовить до ${maxPages} страниц.`,
      );
  }
  if (!pages.size) throw new Error("Выберите хотя бы одну страницу.");
  return [...pages].sort((a, b) => a - b);
}

export function formatAttachmentSize(
  size?: number,
  language: "ru" | "en" = "ru",
): string {
  if (size === undefined) return "";
  return size < 1024 * 1024
    ? `${Math.max(1, Math.round(size / 1024))} ${language === "en" ? "KB" : "КБ"}`
    : `${(size / (1024 * 1024)).toFixed(1)} ${language === "en" ? "MB" : "МБ"}`;
}
