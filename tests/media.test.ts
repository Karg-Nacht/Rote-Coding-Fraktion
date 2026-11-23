import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { createCanvas, loadImage } from "@napi-rs/canvas";
import { MediaService } from "../electron/media";
import { normalizeTimeline } from "../electron/timeline";
import {
  ATTACHMENT_LIMITS,
  attachmentName,
  decodeAttachmentText,
  parsePageRange,
  signatureMime,
} from "../shared/attachments";
import type { SessionMessageInfo } from "@opencode/client";

async function fixture() {
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), "forge-media-test-"),
  );
  return {
    directory,
    media: new MediaService(path.join(directory, "owned")),
    cleanup: () => fs.rm(directory, { recursive: true, force: true }),
  };
}
function controlImage() {
  const canvas = createCanvas(160, 96);
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "white";
  ctx.fillRect(0, 0, 160, 96);
  ctx.fillStyle = "#ee2233";
  ctx.fillRect(12, 20, 44, 44);
  ctx.fillStyle = "#2255ee";
  ctx.beginPath();
  ctx.arc(112, 42, 24, 0, Math.PI * 2);
  ctx.fill();
  return canvas.toBuffer("image/png");
}
const imported = (
  name: string,
  bytes: Uint8Array,
  mime = "application/octet-stream",
) => ({ name, mime, bytes: Array.from(bytes) });
function text(uri: string) {
  return Buffer.from(uri.slice(uri.indexOf(",") + 1), "base64").toString(
    "utf8",
  );
}

/** Tiny deterministic PDF: text/table on page one; an image-only page two. */
function pdfFixture(pages = 2, imageOnly = false) {
  const objects: Buffer[] = [];
  const add = (value: string | Buffer) =>
    objects.push(Buffer.isBuffer(value) ? value : Buffer.from(value));
  const stream = (header: string, content: Buffer) =>
    Buffer.concat([
      Buffer.from(`<< ${header} /Length ${content.length} >>\nstream\n`),
      content,
      Buffer.from("\nendstream"),
    ]);
  add("<< /Type /Catalog /Pages 2 0 R >>");
  const pageIds = Array.from({ length: pages }, (_, i) => 4 + i * 2);
  add(
    `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(" ")}] /Count ${pages} >>`,
  );
  add("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>");
  const imageId = 4 + pages * 2;
  for (let i = 0; i < pages; i++) {
    const contentId = 5 + i * 2;
    add(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 240 180] /Resources << /Font << /F1 3 0 R >> /XObject << /Im1 ${imageId} 0 R >> >> /Contents ${contentId} 0 R >>`,
    );
    const content =
      i === 1 || imageOnly
        ? "q 100 0 0 100 50 30 cm /Im1 Do Q"
        : `BT /F1 14 Tf 20 150 Td (PAGE ${i + 1} HELLO) Tj 0 -30 Td (LEFT  RIGHT) Tj ET 20 100 m 200 100 l S 20 80 m 200 80 l S`;
    add(stream("", Buffer.from(content)));
  }
  add(
    stream(
      "/Type /XObject /Subtype /Image /Width 2 /Height 2 /ColorSpace /DeviceRGB /BitsPerComponent 8",
      Buffer.from([255, 0, 0, 0, 0, 255, 0, 255, 0, 255, 255, 0]),
    ),
  );
  const chunks = [Buffer.from("%PDF-1.4\n")];
  const offsets = [0];
  let length = chunks[0].length;
  objects.forEach((object, i) => {
    const chunk = Buffer.concat([
      Buffer.from(`${i + 1} 0 obj\n`),
      object,
      Buffer.from("\nendobj\n"),
    ]);
    offsets.push(length);
    chunks.push(chunk);
    length += chunk.length;
  });
  chunks.push(
    Buffer.from(
      `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets
        .slice(1)
        .map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`)
        .join(
          "",
        )}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${length}\n%%EOF\n`,
    ),
  );
  return Buffer.concat(chunks);
}

test("PNG bytes reach the multimodal prompt exactly and source changes cannot affect the snapshot", async () => {
  const f = await fixture();
  try {
    const image = controlImage(),
      original = path.join(f.directory, "картинка с пробелами.jpg");
    await fs.writeFile(original, image);
    const [file] = await f.media.choose([original]);
    assert.equal(
      file.mime,
      "image/png",
      "signature overrides a misleading extension",
    );
    await fs.writeFile(original, "edited original");
    const [prompt] = await f.media.promptFiles([file.id]);
    assert.match(prompt.uri, /^data:image\/png;base64,/);
    assert.deepEqual(Buffer.from(prompt.uri.split(",")[1], "base64"), image);
    assert.equal(prompt.source.type, "inline");
    assert.equal(prompt.uri.includes("file:"), false);
    assert.equal(await f.media.requiresImages([file.id]), true);
    const fresh = new MediaService(path.join(f.directory, "owned"));
    assert.deepEqual(await fresh.promptFiles([file.id]), [prompt]);
    const response = await fresh.response(file.id);
    assert.equal(response.headers.get("Content-Type"), "image/png");
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), image);
  } finally {
    await f.cleanup();
  }
});

test("clipboard imports validate content, reject renamed binaries, and preserve Unicode text/code", async () => {
  const f = await fixture();
  try {
    const [image] = await f.media.import([
      imported("clipboard.png", controlImage(), "text/plain"),
    ]);
    assert.equal(image.mime, "image/png");
    const typedBytes = Uint8Array.from(controlImage());
    const [typed] = await f.media.import([
      { name: "typed.png", mime: "image/png", bytes: typedBytes },
    ]);
    typedBytes.fill(0);
    assert.match(
      (await f.media.promptFiles([typed.id]))[0].uri,
      /^data:image\/png;base64,/,
    );
    const source = "// Кириллица\r\nconst value = '✓';\n";
    const [code] = await f.media.import([
      imported("../../код.ts", Buffer.from(source)),
    ]);
    assert.equal(code.name, "код.ts");
    assert.equal(
      text((await f.media.promptFiles([code.id]))[0].uri),
      source.replace(/\r\n/g, "\n"),
    );
    assert.equal(await f.media.requiresImages([code.id]), false);
    assert.match(code.excerpt ?? "", /Кириллица/);
    await assert.rejects(
      f.media.import([imported("fake.png", Buffer.from("not image"))]),
      /сигнатура/,
    );
    await assert.rejects(
      f.media.import([imported("binary.bin", Buffer.from([0, 1, 2, 3]))]),
      /бинарный/,
    );
    await assert.rejects(
      f.media.import([
        imported(
          "truncated.png",
          Buffer.from([
            137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82, 0, 0,
            0, 1, 0, 0, 0, 1,
          ]),
        ),
      ]),
      /декодировать/,
    );
    assert.equal((await f.media.response("../escape")).status, 404);
    await assert.rejects(
      f.media.import([
        {
          name: "large.png",
          mime: "image/png",
          bytes: new Uint8Array(ATTACHMENT_LIMITS.fileBytes + 1),
        },
      ]),
      /Недопустимое/,
    );
    await assert.rejects(
      f.media.import(
        Array.from({ length: 21 }, () =>
          imported("small.txt", Buffer.from("ok")),
        ),
      ),
      /до 20/,
    );
  } finally {
    await f.cleanup();
  }
});

test("bounded text preserves a visible partial-file notice and integrity is checked before sending", async () => {
  const f = await fixture();
  try {
    const [file] = await f.media.import([
      imported(
        "long.txt",
        Buffer.from("x".repeat(ATTACHMENT_LIMITS.textCharacters + 100)),
      ),
    ]);
    assert.equal(file.status, "warning");
    assert.match(file.detail ?? "", /частично/);
    assert.equal(
      text((await f.media.promptFiles([file.id]))[0].uri).length,
      ATTACHMENT_LIMITS.textCharacters,
    );
    await fs.writeFile(
      path.join(f.directory, "owned", file.id, "original.bin"),
      "changed",
    );
    await assert.rejects(f.media.promptFiles([file.id]), /изменено/);
    assert.equal((await f.media.response(file.id)).status, 404);
  } finally {
    await f.cleanup();
  }
});

test("PDF extracts bounded page-labelled text and tables; selected image page becomes real PNG", async () => {
  const f = await fixture();
  try {
    const [pdf] = await f.media.import([
      imported("документ.pdf", pdfFixture()),
    ]);
    assert.equal(pdf.pages, 2);
    assert.deepEqual(pdf.selectedPages, [1, 2]);
    assert.deepEqual(pdf.visualPages, []);
    const preparedText = text((await f.media.promptFiles([pdf.id]))[0].uri);
    assert.match(preparedText, /страница 1 из 2/);
    assert.match(preparedText, /PAGE 1 HELLO/);
    assert.match(preparedText, /LEFT\s+RIGHT/);
    assert.match(preparedText, /страница 2 из 2/);
    assert.equal(await f.media.requiresImages([pdf.id]), false);
    const visual = await f.media.preparePdfAttachment(pdf.id, [2]);
    assert.deepEqual(visual.visualPages, [2]);
    assert.equal(await f.media.requiresImages([pdf.id]), true);
    const [multiScan] = await f.media.import([
      imported("scan-many.pdf", pdfFixture(2, true)),
    ]);
    assert.equal(multiScan.status, "warning");
    assert.match(multiScan.detail ?? "", /часть документа/);
    const files = await f.media.promptFiles([pdf.id]);
    assert.equal(files.length, 2);
    assert.match(files[1].uri, /^data:image\/png;base64,/);
    const pageImage = await loadImage(
      Buffer.from(files[1].uri.split(",")[1], "base64"),
    );
    const canvas = createCanvas(pageImage.width, pageImage.height),
      ctx = canvas.getContext("2d");
    ctx.drawImage(pageImage, 0, 0);
    const pixels = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
    let red = 0,
      blue = 0;
    for (let offset = 0; offset < pixels.length; offset += 4) {
      if (
        pixels[offset] > 220 &&
        pixels[offset + 1] < 30 &&
        pixels[offset + 2] < 30
      )
        red++;
      if (
        pixels[offset + 2] > 220 &&
        pixels[offset] < 30 &&
        pixels[offset + 1] < 30
      )
        blue++;
    }
    assert.ok(
      red > 100 && blue > 100,
      "render preserves the known red and blue source image quadrants",
    );
    assert.match(files[1].name, /страница 2/);
    assert.match(text(files[0].uri), /OCR не выполнялся/);
    const fresh = new MediaService(path.join(f.directory, "owned"));
    assert.deepEqual(await fresh.promptFiles([pdf.id]), files);
    assert.equal((await fresh.response(pdf.id)).status, 200);
    await assert.rejects(
      fresh.preparePdfAttachment(pdf.id, [3]),
      /Выберите страницы/,
    );
    await assert.rejects(
      fresh.preparePdfAttachment(pdf.id, []),
      /Выберите страницы/,
    );
  } finally {
    await f.cleanup();
  }
});

test("image-only scanned PDF automatically sends its first page and declares missing OCR", async () => {
  const f = await fixture();
  try {
    const [pdf] = await f.media.import([
      imported("scan.pdf", pdfFixture(1, true)),
    ]);
    assert.deepEqual(pdf.visualPages, [1]);
    assert.match(pdf.detail ?? "", /OCR не выполнялся/);
    const files = await f.media.promptFiles([pdf.id]);
    assert.equal(files.length, 2);
    assert.match(files[1].uri, /^data:image\/png;base64,/);
    assert.equal(await f.media.requiresImages([pdf.id]), true);
  } finally {
    await f.cleanup();
  }
});

test("JPEG, WebP and GIF retain their actual binary MIME", async () => {
  const f = await fixture();
  try {
    const canvas = createCanvas(24, 16),
      ctx = canvas.getContext("2d");
    ctx.fillStyle = "#2468ac";
    ctx.fillRect(0, 0, 24, 16);
    const gif = Buffer.from(
      "R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7",
      "base64",
    );
    for (const [mime, bytes] of [
      ["image/jpeg", canvas.toBuffer("image/jpeg")],
      ["image/webp", canvas.toBuffer("image/webp")],
      ["image/gif", gif],
    ] as const) {
      const [file] = await f.media.import([imported("image.bin", bytes)]);
      assert.equal(file.mime, mime);
      const [prompt] = await f.media.promptFiles([file.id]);
      assert.ok(prompt.uri.startsWith(`data:${mime};base64,`));
      assert.deepEqual(Buffer.from(prompt.uri.split(",")[1], "base64"), bytes);
    }
  } finally {
    await f.cleanup();
  }
});

test("large PDF is explicitly partial; damaged PDF fails clearly without provider calls", async () => {
  const f = await fixture();
  try {
    const [pdf] = await f.media.import([imported("many.pdf", pdfFixture(14))]);
    assert.equal(pdf.pages, 14);
    assert.equal(pdf.selectedPages?.length, 12);
    assert.match(pdf.detail ?? "", /часть документа/);
    const content = text((await f.media.promptFiles([pdf.id]))[0].uri);
    assert.match(content, /страница 12 из 14/);
    assert.doesNotMatch(content, /страница 13 из 14/);
    await assert.rejects(
      f.media.import([imported("broken.pdf", Buffer.from("%PDF-1.7\nbroken"))]),
      /повреждён/,
    );
  } finally {
    await f.cleanup();
  }
});

test("persisted engine-shaped user files render after service recreation; invalid image data is hidden", async () => {
  const image = controlImage(),
    uri = `data:image/png;base64,${image.toString("base64")}`;
  const media = new MediaService();
  const message = {
    id: "u-image",
    type: "user",
    text: "Что на рисунке?",
    time: { created: 1 },
    files: [
      {
        name: "control.png",
        mime: "image/png",
        data: image.toString("base64"),
        source: { type: "inline" },
      },
    ],
  } as unknown as SessionMessageInfo;
  const rows = normalizeTimeline([message], (value) =>
    media.resolve("fixture", value),
  );
  const user = rows.find((row) => row.type === "user");
  assert.equal(user?.type === "user" && user.images?.[0]?.url, uri);
  assert.equal(
    media.resolve("fixture", "data:image/png;base64,bm90IGltYWdl"),
    undefined,
  );
});

test("page ranges, names and Windows Unicode decoding enforce explicit limits", () => {
  assert.deepEqual(parsePageRange("1, 3-5, 3", 10), [1, 3, 4, 5]);
  assert.throws(() => parsePageRange("1-10000000", 10000000), /до 6/);
  assert.throws(() => parsePageRange("0", 10), /от 1/);
  assert.throws(() => parsePageRange("2-1", 10), /от 1/);
  assert.equal(attachmentName("C:\\private\\hello.txt"), "hello.txt");
  assert.equal(
    decodeAttachmentText(
      Buffer.concat([Buffer.from([255, 254]), Buffer.from("Текст", "utf16le")]),
    ),
    "Текст",
  );
  assert.equal(signatureMime(controlImage()), "image/png");
});
