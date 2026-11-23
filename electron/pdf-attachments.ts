import { createCanvas } from "@napi-rs/canvas";
import { ATTACHMENT_LIMITS } from "../shared/attachments";

export type PreparedPdf = {
  pages: number;
  selectedPages: number[];
  visualPages: number[];
  text: string;
  title?: string;
  detail: string;
  partial: boolean;
  images: { page: number; bytes: Uint8Array }[];
};

/** PDF bytes stay local. Only the bounded, explicitly described result is sent. */
export async function preparePdf(
  bytes: Uint8Array,
  name: string,
  selected?: number[],
): Promise<PreparedPdf> {
  const { getDocument } = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const loading = getDocument({
    data: Uint8Array.from(bytes),
    useSystemFonts: true,
    disableFontFace: true,
    disableAutoFetch: true,
    disableRange: true,
    stopAtErrors: true,
    verbosity: 0,
  });
  const timer = setTimeout(() => void loading.destroy(), 30_000);
  timer.unref?.();
  try {
    const doc = await loading.promise;
    if (doc.numPages > ATTACHMENT_LIMITS.pdfMaximumPages)
      throw new Error(
        `PDF содержит ${doc.numPages} страниц. Допустимо до ${ATTACHMENT_LIMITS.pdfMaximumPages}; разделите документ.`,
      );
    const pages =
      selected ??
      Array.from(
        { length: Math.min(doc.numPages, ATTACHMENT_LIMITS.pdfTextPages) },
        (_, i) => i + 1,
      );
    if (
      !pages.length ||
      pages.some(
        (page) => !Number.isInteger(page) || page < 1 || page > doc.numPages,
      )
    )
      throw new Error(`Выберите страницы от 1 до ${doc.numPages}.`);
    if (selected && pages.length > ATTACHMENT_LIMITS.pdfVisualPages)
      throw new Error(
        `Можно подготовить до ${ATTACHMENT_LIMITS.pdfVisualPages} страниц изображениями.`,
      );
    // Reserve room for file/page provenance and the visible processing summary.
    let remaining = ATTACHMENT_LIMITS.textCharacters - 10_000;
    let truncated = false;
    const extracted: string[] = [];
    for (const number of pages) {
      const page = await doc.getPage(number);
      const content = await page.getTextContent();
      const text = content.items
        .flatMap((item) =>
          "str" in item ? [item.str + (item.hasEOL ? "\n" : " ")] : [],
        )
        .join("")
        .trim();
      const snippet = text.slice(0, remaining);
      if (snippet.length < text.length) truncated = true;
      remaining -= snippet.length;
      extracted.push(
        `--- ${name}: страница ${number} из ${doc.numPages} ---\n${snippet || "[Текст не извлечён: возможен скан или страница с графикой.]"}`,
      );
      page.cleanup();
      if (!remaining) {
        truncated = pages.at(-1) !== number || truncated;
        break;
      }
    }
    const noText = extracted.every((text) =>
      text.includes("[Текст не извлечён:"),
    );
    const visualPages = selected ?? (noText ? [pages[0]] : []);
    const images: PreparedPdf["images"] = [];
    for (const number of visualPages) {
      const page = await doc.getPage(number);
      const base = page.getViewport({ scale: 1 });
      const scale = Math.min(
        2,
        1600 / Math.max(base.width, base.height),
        Math.sqrt(2_000_000 / (base.width * base.height)),
      );
      const viewport = page.getViewport({ scale });
      const canvas = createCanvas(
        Math.max(1, Math.ceil(viewport.width)),
        Math.max(1, Math.ceil(viewport.height)),
      );
      await page.render({
        canvas: canvas as unknown as HTMLCanvasElement,
        canvasContext: canvas.getContext(
          "2d",
        ) as unknown as CanvasRenderingContext2D,
        viewport,
        background: "rgb(255,255,255)",
      }).promise;
      const data = await canvas.encode("png");
      if (data.byteLength > ATTACHMENT_LIMITS.fileBytes)
        throw new Error("Изображение страницы превышает 20 МБ.");
      images.push({ page: number, bytes: data });
      // Release native backing memory after each page, including large originals.
      canvas.width = 1;
      canvas.height = 1;
      page.cleanup();
    }
    const metadata = await doc.getMetadata().catch(() => undefined);
    const title =
      metadata &&
      "Title" in metadata.info &&
      typeof metadata.info.Title === "string"
        ? metadata.info.Title.slice(0, 500)
        : undefined;
    const partial =
      pages.length < doc.numPages ||
      truncated ||
      (noText && visualPages.length < doc.numPages);
    const detail = [
      `Текст: страницы ${pages.join(", ")} из ${doc.numPages}${truncated ? ", сокращён до 128 000 символов" : ""}.`,
      visualPages.length
        ? `Изображения: ${visualPages.join(", ")}.`
        : "Графика не передана. Выберите страницы для визуального анализа.",
      noText
        ? "Текст не найден; OCR не выполнялся."
        : "Порядок текста и таблиц может отличаться от оригинала.",
      partial ? "Подготовлена часть документа." : "",
    ]
      .filter(Boolean)
      .join(" ");
    return {
      pages: doc.numPages,
      selectedPages: pages,
      visualPages,
      images,
      title,
      detail,
      partial,
      text: `PDF: ${name}${title ? `\nНазвание: ${title}` : ""}\n${detail}\n\n${extracted.join("\n\n")}`,
    };
  } catch (error) {
    if (error instanceof Error && error.name === "PasswordException")
      throw new Error(
        "PDF защищён паролем. Прикрепите локальную копию без пароля.",
      );
    if (
      error instanceof Error &&
      /^(PDF содержит|Выберите страницы|Можно подготовить|Изображение страницы)/.test(
        error.message,
      )
    )
      throw error;
    throw new Error(
      "Не удалось прочитать PDF: документ повреждён, имеет неподдерживаемую структуру или обработка превысила 30 секунд.",
    );
  } finally {
    clearTimeout(timer);
    await loading.destroy().catch(() => {});
  }
}
