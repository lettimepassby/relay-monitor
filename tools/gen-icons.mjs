// PWA 图标生成器：零依赖手写 PNG 编码（node:zlib），按品牌 logo 光栅化
// 用法：node tools/gen-icons.mjs   → 输出到 public/icons/
import { deflateSync } from "node:zlib";
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const outDir = join(dirname(fileURLToPath(import.meta.url)), "..", "public", "icons");
mkdirSync(outDir, { recursive: true });

// ---- 最小 PNG 编码器 ----------------------------------------------------------
const crcTable = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();
const crc32 = (buf) => {
  let c = -1;
  for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
};
const chunk = (type, data) => {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
};
function encodePNG(w, h, rgba) {
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 4 + 1)] = 0; // 无滤波
    rgba.copy(raw, y * (w * 4 + 1) + 1, y * w * 4, (y + 1) * w * 4);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 6; // 8bit RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

// ---- 绘制 --------------------------------------------------------------------
// 品牌 logo：蓝紫渐变底 + 白色坐标轴与折线（同 index.html 的 SVG）
const AXIS = [[3, 3], [3, 21], [21, 21]];
const LINE = [[7, 15], [11, 10], [14, 13], [19, 6]];

const distToSeg = (px, py, x1, y1, x2, y2) => {
  const dx = x2 - x1, dy = y2 - y1;
  const t = Math.max(0, Math.min(1, ((px - x1) * dx + (py - y1) * dy) / (dx * dx + dy * dy || 1)));
  const cx = x1 + t * dx, cy = y1 + t * dy;
  return Math.hypot(px - cx, py - cy);
};

function draw(size, { rounded, pad = 0 }) {
  const rgba = Buffer.alloc(size * size * 4);
  const r = rounded ? size * 0.22 : 0;
  const scale = (size * (1 - 2 * pad)) / 24;
  const off = size * pad;
  const lw = size * 0.055; // 线宽的一半
  const paths = [AXIS, LINE].map((pts) => pts.map(([x, y]) => [off + x * scale, off + y * scale]));

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4;
      // 圆角矩形裁剪
      if (r > 0) {
        const cx = Math.max(r - x, x - (size - 1 - r), 0);
        const cy = Math.max(r - y, y - (size - 1 - r), 0);
        if (cx > 0 && cy > 0 && Math.hypot(cx, cy) > r) { rgba[i + 3] = 0; continue; }
      }
      // 渐变底（左上蓝 → 右下紫）
      const t = (x + y) / (2 * size);
      rgba[i] = Math.round(10 + t * (94 - 10));      // R: 0A → 5E
      rgba[i + 1] = Math.round(132 + t * (92 - 132)); // G: 84 → 5C
      rgba[i + 2] = Math.round(255 + t * (230 - 255)); // B: FF → E6
      rgba[i + 3] = 255;
      // 白色笔画（带 1px 抗锯齿边）
      let d = Infinity;
      for (const pts of paths) {
        for (let s = 0; s < pts.length - 1; s++) {
          d = Math.min(d, distToSeg(x, y, pts[s][0], pts[s][1], pts[s + 1][0], pts[s + 1][1]));
        }
      }
      if (d < lw) {
        const a = d > lw - 1.5 ? (lw - d) / 1.5 : 1; // 边缘抗锯齿
        rgba[i] = Math.round(rgba[i] * (1 - a) + 255 * a);
        rgba[i + 1] = Math.round(rgba[i + 1] * (1 - a) + 255 * a);
        rgba[i + 2] = Math.round(rgba[i + 2] * (1 - a) + 255 * a);
      }
    }
  }
  return encodePNG(size, size, rgba);
}

const files = [
  ["icon-192.png", draw(192, { rounded: true, pad: 0.10 })],
  ["icon-512.png", draw(512, { rounded: true, pad: 0.10 })],
  ["maskable-512.png", draw(512, { rounded: false, pad: 0.18 })], // 全出血，内容留安全区
  ["apple-touch-icon.png", draw(180, { rounded: false, pad: 0.12 })], // iOS 自己做圆角
];
for (const [name, buf] of files) {
  writeFileSync(join(outDir, name), buf);
  console.log("生成", name, (buf.length / 1024).toFixed(1) + "KB");
}
