import fs from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { loadImage } from "@napi-rs/canvas";
import {
  mediaHashFromUri,
  type OpenCodeClient,
  type SessionMessageInfo,
} from "@opencode/client";
import type { Attachment } from "../shared/types";
import {
  ATTACHMENT_LIMITS,
  attachmentName,
  decodeAttachmentText,
  signatureMime,
  supportedImageMime,
} from "../shared/attachments";
import { safeFile } from "./security";
import { preparePdf, type PreparedPdf } from "./pdf-attachments";

type ImportFile = { name: string; mime: string; bytes: number[] | Uint8Array };
type StoredAttachment = Omit<Attachment, "preview"> & {
  version: 1;
  hash: string;
  text?: string;
  rendered?: { page: number; file: string }[];
};
type MediaRecord = {
  path?: string;
  root?: string;
  bytes?: Uint8Array;
  mime: string;
};
const validId =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const hash = (bytes: Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex");

export class MediaService {
  private records = new Map<string, MediaRecord>();
  private uris = new Map<string, string>();
  private files = new Map<string, StoredAttachment>();
  constructor(private directory = path.resolve(".runtime", "attachments")) {}

  private filePath(id: string, name = "original.bin") {
    if (!validId.test(id)) throw new Error("Выберите вложение заново.");
    return path.join(this.directory, id, name);
  }
  private async load(id: string): Promise<StoredAttachment> {
    const cached = this.files.get(id);
    if (cached) return cached;
    try {
      const target = await safeFile(
        this.directory,
        this.filePath(id, "manifest.json"),
      );
      if ((await fs.stat(target)).size > 2 * 1024 * 1024) throw new Error();
      const item = JSON.parse(
        await fs.readFile(target, "utf8"),
      ) as StoredAttachment;
      if (
        item.id !== id ||
        item.version !== 1 ||
        typeof item.name !== "string" ||
        typeof item.mime !== "string" ||
        !/^[a-f0-9]{64}$/.test(item.hash)
      )
        throw new Error();
      if (
        item.rendered?.some(
          (page) => !/^page-\d+-[a-f0-9-]+\.png$/.test(page.file),
        )
      )
        throw new Error();
      this.files.set(id, item);
      return item;
    } catch {
      throw new Error(
        "Сохранённое вложение недоступно. Прикрепите файл заново.",
      );
    }
  }
  private public(item: StoredAttachment): Attachment {
    const {
      hash: _hash,
      version: _version,
      text: _text,
      rendered: _rendered,
      ...metadata
    } = item;
    return {
      ...metadata,
      excerpt: item.text?.slice(0, 6000),
      preview:
        supportedImageMime.test(item.mime) || item.rendered?.length
          ? `forge-media://${item.id}`
          : undefined,
    };
  }
  private async original(item: StoredAttachment): Promise<Uint8Array> {
    const target = await safeFile(this.directory, this.filePath(item.id));
    if ((await fs.stat(target)).size > ATTACHMENT_LIMITS.fileBytes)
      throw new Error("Вложение превышает 20 МБ.");
    const bytes = await fs.readFile(target);
    if (hash(bytes) !== item.hash)
      throw new Error(
        "Сохранённое вложение изменено. Прикрепите оригинал заново.",
      );
    return bytes;
  }
  private async save(item: StoredAttachment) {
    const temporary = this.filePath(item.id, `${randomUUID()}.tmp`);
    await fs.writeFile(temporary, JSON.stringify(item), { flag: "wx" });
    await fs.rename(temporary, this.filePath(item.id, "manifest.json"));
    this.files.set(item.id, item);
  }
  private async applyPdf(
    item: StoredAttachment,
    prepared: PreparedPdf,
  ): Promise<StoredAttachment> {
    const rendered: NonNullable<StoredAttachment["rendered"]> = [];
    for (const image of prepared.images) {
      const file = `page-${image.page}-${randomUUID()}.png`;
      await fs.writeFile(this.filePath(item.id, file), image.bytes, {
        flag: "wx",
      });
      rendered.push({ page: image.page, file });
    }
    return {
      ...item,
      pages: prepared.pages,
      selectedPages: prepared.selectedPages,
      visualPages: prepared.visualPages,
      status:
        prepared.partial || !prepared.visualPages.length ? "warning" : "ready",
      detail: prepared.detail,
      text: prepared.text,
      rendered,
    };
  }
  private async add(name: string, bytes: Uint8Array): Promise<Attachment> {
    if (!bytes.length || bytes.byteLength > ATTACHMENT_LIMITS.fileBytes)
      throw new Error(
        "Вложение должно быть непустым файлом размером до 20 МБ.",
      );
    name = attachmentName(name);
    const mime = signatureMime(bytes);
    if (!mime && /\.(?:png|jpe?g|webp|gif|avif|bmp|pdf)$/i.test(name))
      throw new Error(
        `${name}: сигнатура не соответствует поддерживаемому изображению или PDF.`,
      );
    const text = !mime ? decodeAttachmentText(bytes) : undefined;
    if (mime && supportedImageMime.test(mime)) {
      try {
        const image = await loadImage(Buffer.from(bytes));
        if (
          !image.width ||
          !image.height ||
          image.width * image.height > 40_000_000
        )
          throw new Error("dimensions");
      } catch {
        throw new Error(
          `${name}: не удалось декодировать изображение или оно превышает 40 мегапикселей.`,
        );
      }
    }
    // Reject unreadable documents before creating an owned cache entry.
    const pdf =
      mime === "application/pdf" ? await preparePdf(bytes, name) : undefined;
    const id = randomUUID();
    await fs.mkdir(path.dirname(this.filePath(id)), { recursive: true });
    await fs.writeFile(this.filePath(id), bytes, { flag: "wx" });
    let item: StoredAttachment = {
      id,
      name,
      mime: mime ?? "text/plain",
      size: bytes.byteLength,
      version: 1,
      hash: hash(bytes),
      status: "ready",
    };
    if (text !== undefined) {
      item.text = text.slice(0, ATTACHMENT_LIMITS.textCharacters);
      if (text.length > item.text.length) {
        item.status = "warning";
        item.detail =
          "Передаются первые 128 000 символов. Файл обработан частично.";
      } else
        item.detail =
          "Текст подготовлен локально; содержимое передаётся модели.";
    } else if (pdf) {
      item = await this.applyPdf(item, pdf);
    } else
      item.detail = "Изображение передаётся модели как мультимодальные данные.";
    await this.save(item);
    return this.public(item);
  }
  async choose(paths: string[]): Promise<Attachment[]> {
    if (paths.length > ATTACHMENT_LIMITS.files)
      throw new Error("Можно прикрепить до 20 файлов.");
    const targets: { target: string; name: string; size: number }[] = [];
    for (const chosen of paths) {
      const target = await fs.realpath(chosen);
      const stat = await fs.stat(target);
      if (!stat.isFile() || stat.size > ATTACHMENT_LIMITS.fileBytes)
        throw new Error("Вложение должно быть файлом размером до 20 МБ.");
      targets.push({ target, name: path.basename(chosen), size: stat.size });
    }
    if (
      targets.reduce((sum, item) => sum + item.size, 0) >
      ATTACHMENT_LIMITS.requestBytes
    )
      throw new Error("Общий размер вложений должен быть до 40 МБ.");
    const files: Attachment[] = [];
    for (const { target, name } of targets)
      files.push(await this.add(name, await fs.readFile(target)));
    return files;
  }
  async import(input: ImportFile[]): Promise<Attachment[]> {
    if (
      input.length > ATTACHMENT_LIMITS.files ||
      input.reduce((sum, file) => sum + file.bytes.length, 0) >
        ATTACHMENT_LIMITS.requestBytes
    )
      throw new Error("Можно прикрепить до 20 файлов общим размером до 40 МБ.");
    for (const file of input)
      if (
        (!Array.isArray(file.bytes) && !(file.bytes instanceof Uint8Array)) ||
        file.bytes.length > ATTACHMENT_LIMITS.fileBytes ||
        (Array.isArray(file.bytes) &&
          file.bytes.some(
            (byte) => !Number.isInteger(byte) || byte < 0 || byte > 255,
          ))
      )
        throw new Error("Недопустимое содержимое вложения.");
    const files: Attachment[] = [];
    for (const file of input)
      files.push(await this.add(file.name, Uint8Array.from(file.bytes)));
    return files;
  }
  async metadata(ids: string[]): Promise<Attachment[]> {
    return Promise.all(ids.map(async (id) => this.public(await this.load(id))));
  }
  async preparePdfAttachment(id: string, pages: number[]): Promise<Attachment> {
    const item = await this.load(id);
    if (item.mime !== "application/pdf")
      throw new Error("Выберите PDF-документ.");
    const selected = [...new Set(pages)].sort((a, b) => a - b);
    const prepared = await this.applyPdf(
      item,
      await preparePdf(await this.original(item), item.name, selected),
    );
    await this.save(prepared);
    return this.public(prepared);
  }
  async requiresImages(ids: string[]): Promise<boolean> {
    const items = await Promise.all(ids.map((id) => this.load(id)));
    return items.some(
      (item) =>
        supportedImageMime.test(item.mime) || !!item.visualPages?.length,
    );
  }
  async promptFiles(ids: string[]) {
    if (ids.length > ATTACHMENT_LIMITS.files)
      throw new Error("Можно прикрепить до 20 файлов.");
    let total = 0,
      textTotal = 0;
    const files: {
      uri: string;
      name: string;
      source: { type: "inline" };
      description?: string;
    }[] = [];
    const append = (
      bytes: Uint8Array,
      mime: string,
      name: string,
      description?: string,
    ) => {
      total += bytes.byteLength;
      if (total > ATTACHMENT_LIMITS.requestBytes)
        throw new Error(
          "Подготовленные вложения превышают 40 МБ. Уменьшите число файлов или страниц.",
        );
      files.push({
        uri: `data:${mime};base64,${Buffer.from(bytes).toString("base64")}`,
        name,
        source: { type: "inline" },
        description,
      });
    };
    for (const id of ids) {
      const item = await this.load(id);
      const bytes = await this.original(item);
      if (supportedImageMime.test(item.mime)) {
        if (signatureMime(bytes) !== item.mime)
          throw new Error(
            "Изображение имеет неверную сигнатуру. Прикрепите его заново.",
          );
        append(bytes, item.mime, item.name);
      } else {
        const text = item.text ?? decodeAttachmentText(bytes);
        textTotal += text.length;
        if (textTotal > ATTACHMENT_LIMITS.textCharacters)
          throw new Error(
            "Текст вложений превышает 128 000 символов. Уменьшите число файлов или страниц.",
          );
        append(
          Buffer.from(text, "utf8"),
          "text/plain",
          item.mime === "application/pdf" ? `${item.name}.txt` : item.name,
          item.detail,
        );
        for (const page of item.rendered ?? []) {
          const target = await safeFile(
            this.directory,
            this.filePath(id, page.file),
          );
          const data = await fs.readFile(target);
          if (
            data.byteLength > ATTACHMENT_LIMITS.fileBytes ||
            signatureMime(data) !== "image/png"
          )
            throw new Error(
              "Подготовленная страница PDF недоступна. Подготовьте её заново.",
            );
          append(
            data,
            "image/png",
            `${item.name} — страница ${page.page}.png`,
            `Страница ${page.page} из ${item.pages}`,
          );
        }
      }
    }
    return files;
  }
  async prepare(
    messages: SessionMessageInfo[],
    root: string,
    client: OpenCodeClient,
  ) {
    const uris = messages.flatMap((m) =>
      m.type === "assistant"
        ? m.content.flatMap((p) =>
            p.type === "tool" && "content" in p.state
              ? (p.state.content ?? []).flatMap((c) =>
                  c.type === "file" && supportedImageMime.test(c.mime)
                    ? [{ uri: c.uri, mime: c.mime }]
                    : [],
                )
              : [],
          )
        : [],
    );
    for (const item of uris) {
      const key = `${root}\0${item.uri}`;
      if (this.uris.has(key) || item.uri.startsWith("data:")) continue;
      try {
        const id = randomUUID(),
          mediaHash = mediaHashFromUri(item.uri);
        if (mediaHash) {
          const bytes = await client.experimental.media.get({
            hash: mediaHash,
          });
          if (
            bytes.byteLength > ATTACHMENT_LIMITS.fileBytes ||
            signatureMime(bytes) !== item.mime
          )
            continue;
          this.records.set(id, { bytes, mime: item.mime });
        } else {
          const input = item.uri.startsWith("file:")
            ? fileURLToPath(item.uri)
            : item.uri;
          const target = await safeFile(root, input);
          if ((await fs.stat(target)).size > ATTACHMENT_LIMITS.fileBytes)
            continue;
          this.records.set(id, { path: target, root, mime: item.mime });
        }
        this.uris.set(key, `forge-media://${id}`);
      } catch {
        /* Results outside the project remain unavailable. */
      }
    }
  }
  resolve(root: string, uri: string): string | undefined {
    if (
      /^data:image\/(png|jpeg|webp|gif|avif|bmp);base64,[A-Za-z0-9+/=\r\n]+$/.test(
        uri,
      ) &&
      uri.length <= 28 * 1024 * 1024
    ) {
      const mime = uri.slice(5, uri.indexOf(";"));
      if (
        signatureMime(
          Buffer.from(uri.slice(uri.indexOf(",") + 1), "base64"),
        ) === mime
      )
        return uri;
      return undefined;
    }
    return this.uris.get(`${root}\0${uri}`);
  }
  async response(id: string): Promise<Response> {
    try {
      const record = this.records.get(id);
      let data: Uint8Array, mime: string;
      if (record) {
        const target =
          record.path && record.root
            ? await safeFile(record.root, record.path)
            : record.path;
        data =
          record.bytes ??
          (target ? await fs.readFile(target) : new Uint8Array());
        mime = record.mime;
      } else {
        const item = await this.load(id);
        if (supportedImageMime.test(item.mime)) {
          data = await this.original(item);
          mime = item.mime;
        } else if (item.rendered?.length) {
          data = await fs.readFile(
            await safeFile(
              this.directory,
              this.filePath(id, item.rendered[0].file),
            ),
          );
          mime = "image/png";
        } else return new Response("Unavailable", { status: 404 });
      }
      if (
        !data.byteLength ||
        data.byteLength > ATTACHMENT_LIMITS.fileBytes ||
        signatureMime(data) !== mime
      )
        return new Response("Unavailable", { status: 404 });
      return new Response(new Uint8Array(data) as BodyInit, {
        headers: {
          "Content-Type": mime,
          "Cache-Control": "no-store",
          "X-Content-Type-Options": "nosniff",
        },
      });
    } catch {
      return new Response("Unavailable", { status: 404 });
    }
  }
}
