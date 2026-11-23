// Build application icons from the two approved originals. No reference artwork is used.
import fs from "node:fs/promises";
import { createHash } from "node:crypto";
import { createCanvas, loadImage } from "@napi-rs/canvas";
const sizes = [16, 24, 32, 48, 64, 128, 256];
const checks = [];
for (const theme of ["dark", "light"]) {
  const source = `resources/rcf-${theme}.png`;
  const bytes = await fs.readFile(source),
    original = await loadImage(bytes);
  const master = createCanvas(1024, 1024),
    ctx = master.getContext("2d");
  const inset = 40,
    edge = 944,
    radius = 208;
  ctx.beginPath();
  ctx.roundRect(inset, inset, edge, edge, radius);
  ctx.clip();
  ctx.drawImage(original, inset, inset, edge, edge);
  const appIcon = createCanvas(512, 512);
  appIcon.getContext("2d").drawImage(master, 0, 0, 512, 512);
  await fs.writeFile(
    `resources/rcf-app-${theme}.png`,
    appIcon.toBuffer("image/png"),
  );
  const images = sizes.map((size) => {
    const icon = createCanvas(size, size);
    icon.getContext("2d").drawImage(master, 0, 0, size, size);
    return icon.toBuffer("image/png");
  });
  const head = Buffer.alloc(6 + sizes.length * 16);
  head.writeUInt16LE(1, 2);
  head.writeUInt16LE(sizes.length, 4);
  let offset = head.length;
  sizes.forEach((size, i) => {
    const p = 6 + i * 16;
    head[p] = size === 256 ? 0 : size;
    head[p + 1] = head[p];
    head.writeUInt16LE(1, p + 4);
    head.writeUInt16LE(32, p + 6);
    head.writeUInt32LE(images[i].length, p + 8);
    head.writeUInt32LE(offset, p + 12);
    offset += images[i].length;
  });
  await fs.writeFile(
    `resources/${theme === "dark" ? "rcf" : "rcf-light"}.ico`,
    Buffer.concat([head, ...images]),
  );
  const pixels = appIcon.getContext("2d");
  for (const [x, y] of [
    [0, 0],
    [511, 0],
    [0, 511],
    [511, 511],
  ])
    if (pixels.getImageData(x, y, 1, 1).data[3] !== 0)
      throw Error("Icon corner must be transparent");
  if (pixels.getImageData(256, 256, 1, 1).data[3] !== 255)
    throw Error("Artwork center must remain opaque");
  checks.push({
    theme,
    originalSha256: createHash("sha256").update(bytes).digest("hex"),
    sizes,
    roundedCorners: true,
    transparentExterior: true,
  });
}
await fs.mkdir("test-results", { recursive: true });
await fs.writeFile(
  "test-results/icon-verification.json",
  JSON.stringify(checks, null, 2),
);
console.log(
  "PASS both approved originals converted into rounded application PNG/ICO icons with transparent corners",
);
