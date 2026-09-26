// 生成应用图标 assets/icon.ico
//
// 两条路径：
//   A) 图片模式（默认）：读取 tools/prepare-icon.ps1 生成的 assets/generated/icon-<n>.bgra，
//      打包成包含 16/20/24/32/40/48/64/128/256 多尺寸的 ICO。
//   B) 程序绘制模式（兜底）：没有 BGRA 素材时，用 SDF 画一个「>_」终端图标，
//      不依赖任何图形库，也不依赖原图。
//
// 用法: node tools/make-icon.js

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const ASSETS = path.join(__dirname, '..', 'assets');
const GEN = path.join(ASSETS, 'generated');
const SIZE_ORDER = [16, 20, 24, 32, 40, 48, 64, 128, 256];

/* ============================================================
   ICO 容器：ICONDIR + N×(BITMAPINFOHEADER + BGRA + AND 掩码)
   ============================================================ */

function bmpEntry(bgra, size) {
  const header = Buffer.alloc(40);
  header.writeUInt32LE(40, 0);
  header.writeInt32LE(size, 4);
  header.writeInt32LE(size * 2, 8);     // 高度含掩码，故 ×2
  header.writeUInt16LE(1, 12);
  header.writeUInt16LE(32, 14);
  header.writeUInt32LE(0, 16);          // BI_RGB
  header.writeUInt32LE(size * size * 4, 20);

  // BMP 行序自下而上，输入 bgra 是自上而下
  const rowBytes = size * 4;
  const xor = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    const src = (size - 1 - y) * rowBytes;
    bgra.copy(xor, y * rowBytes, src, src + rowBytes);
  }

  // 32 位图靠 alpha 通道，AND 掩码全 0 即可（行按 4 字节对齐）
  const maskRow = Math.ceil(size / 32) * 4;
  const andMask = Buffer.alloc(maskRow * size, 0);

  return Buffer.concat([header, xor, andMask]);
}

function buildIco(entries) {
  const dir = Buffer.alloc(6);
  dir.writeUInt16LE(0, 0);
  dir.writeUInt16LE(1, 2);          // type = icon
  dir.writeUInt16LE(entries.length, 4);

  let offset = 6 + entries.length * 16;
  const dirEntries = [];
  const blobs = [];

  for (const { size, bgra } of entries) {
    const img = bmpEntry(bgra, size);
    const e = Buffer.alloc(16);
    e[0] = size >= 256 ? 0 : size;
    e[1] = size >= 256 ? 0 : size;
    e[2] = 0;                        // 调色板数
    e[3] = 0;
    e.writeUInt16LE(1, 4);           // 色平面
    e.writeUInt16LE(32, 6);          // 位深
    e.writeUInt32LE(img.length, 8);
    e.writeUInt32LE(offset, 12);
    offset += img.length;
    dirEntries.push(e);
    blobs.push(img);
  }

  return Buffer.concat([dir, ...dirEntries, ...blobs]);
}

/* ============================================================
   A) 图片模式
   ============================================================ */

function fromImage() {
  if (!fs.existsSync(GEN)) return null;
  const entries = [];
  for (const size of SIZE_ORDER) {
    const f = path.join(GEN, `icon-${size}.bgra`);
    if (!fs.existsSync(f)) continue;
    const bgra = fs.readFileSync(f);
    if (bgra.length !== size * size * 4) {
      console.warn(`  跳过 ${size}×${size}: 字节数不对 (${bgra.length})`);
      continue;
    }
    entries.push({ size, bgra });
  }
  if (!entries.length) return null;

  const ico = buildIco(entries);
  fs.writeFileSync(path.join(ASSETS, 'icon.ico'), ico);
  console.log('图片模式：已用原图生成 icon.ico');
  console.log('  尺寸: ' + entries.map((e) => e.size).join(', '));
  console.log('  大小: ' + (ico.length / 1024).toFixed(1) + ' KB');
  return true;
}

/* ============================================================
   B) 程序绘制兜底（SDF + 4× 超采样）
   ============================================================ */

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const mix = (a, b, t) => a + (b - a) * t;
const mixColor = (c1, c2, t) => [mix(c1[0], c2[0], t), mix(c1[1], c2[1], t), mix(c1[2], c2[2], t)];

function sdRoundRect(px, py, cx, cy, hw, hh, r) {
  const qx = Math.abs(px - cx) - (hw - r);
  const qy = Math.abs(py - cy) - (hh - r);
  const ax = Math.max(qx, 0), ay = Math.max(qy, 0);
  return Math.sqrt(ax * ax + ay * ay) + Math.min(Math.max(qx, qy), 0) - r;
}

function sdCapsule(px, py, ax, ay, bx, by, r) {
  const pax = px - ax, pay = py - ay;
  const bax = bx - ax, bay = by - ay;
  const h = clamp((pax * bax + pay * bay) / (bax * bax + bay * bay), 0, 1);
  const dx = pax - bax * h, dy = pay - bay * h;
  return Math.sqrt(dx * dx + dy * dy) - r;
}

const coverage = (d) => clamp(0.5 - d, 0, 1);

const BG_A = [0x5e, 0xb3, 0xf6];
const BG_B = [0x8b, 0x5c, 0xf6];
const BG_C = [0x22, 0xd3, 0xee];
const FG = [0xff, 0xff, 0xff];

// 以 256×256 为设计基准，按比例缩放到目标尺寸
function renderProcedural(SIZE) {
  const SS = 4;
  const W = SIZE * SS;
  const k = SIZE / 256;
  const acc = new Float64Array(SIZE * SIZE * 4);

  for (let sy = 0; sy < W; sy++) {
    for (let sx = 0; sx < W; sx++) {
      const x = (sx + 0.5) / SS / k;
      const y = (sy + 0.5) / SS / k;

      let r = 0, g = 0, b = 0, a = 0;

      const bgCov = coverage(sdRoundRect(x, y, 128, 128, 122, 122, 58));
      if (bgCov > 0) {
        const t = clamp((x / 256) * 0.55 + (y / 256) * 0.45, 0, 1);
        const c = t < 0.55 ? mixColor(BG_A, BG_C, t / 0.55) : mixColor(BG_C, BG_B, (t - 0.55) / 0.45);
        const gloss = clamp(1 - y / 184, 0, 1) * 0.18;
        r = c[0] * (1 + gloss); g = c[1] * (1 + gloss); b = c[2] * (1 + gloss);
        a = bgCov;
      }

      const fgCov = Math.max(
        coverage(sdCapsule(x, y, 80, 76, 146, 122, 12)),
        coverage(sdCapsule(x, y, 146, 122, 80, 168, 12)),
        coverage(sdRoundRect(x, y, 142, 182, 36, 9, 9))
      );
      if (fgCov > 0) {
        r = mix(r, FG[0], fgCov); g = mix(g, FG[1], fgCov); b = mix(b, FG[2], fgCov);
        a = Math.max(a, fgCov);
      }

      const di = (Math.floor(y * k) * SIZE + Math.floor(x * k)) * 4;
      acc[di] += r; acc[di + 1] += g; acc[di + 2] += b; acc[di + 3] += a * 255;
    }
  }

  const out = Buffer.alloc(SIZE * SIZE * 4);
  const n = SS * SS;
  for (let i = 0; i < SIZE * SIZE; i++) {
    out[i * 4] = clamp(Math.round(acc[i * 4] / n), 0, 255);
    out[i * 4 + 1] = clamp(Math.round(acc[i * 4 + 1] / n), 0, 255);
    out[i * 4 + 2] = clamp(Math.round(acc[i * 4 + 2] / n), 0, 255);
    out[i * 4 + 3] = clamp(Math.round(acc[i * 4 + 3] / n), 0, 255);
  }
  return out;
}

function crc32(buf) {
  let c, crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c = (crc ^ buf[i]) & 0xff;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crc = c ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td), 0);
  return Buffer.concat([len, td, crc]);
}

function toPng(rgba, w, h) {
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 4 + 1)] = 0;
    rgba.copy(raw, y * (w * 4 + 1) + 1, y * w * 4, (y + 1) * w * 4);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ]);
}

function fromProcedural() {
  console.log('兜底模式：用内置图形生成图标（没找到 assets/generated/*.bgra）');
  const entries = SIZE_ORDER.map((size) => ({ size, bgra: renderProcedural(size) }));
  const ico = buildIco(entries);
  fs.writeFileSync(path.join(ASSETS, 'icon.ico'), ico);
  fs.writeFileSync(path.join(ASSETS, 'icon.png'), toPng(entries.find((e) => e.size === 256).bgra, 256, 256));
  fs.writeFileSync(path.join(ASSETS, 'icon-32.png'), toPng(entries.find((e) => e.size === 32).bgra, 32, 32));
  console.log('  已生成 icon.ico / icon.png / icon-32.png');
}

/* ============================================================ */

fs.mkdirSync(ASSETS, { recursive: true });
if (!fromImage()) fromProcedural();

const ico = path.join(ASSETS, 'icon.ico');
console.log('\n图标: ' + ico + '  (' + (fs.statSync(ico).size / 1024).toFixed(1) + ' KB)');
console.log('提示: 换图请先运行 tools/prepare-icon.ps1（可指定裁剪参数），再运行本脚本。');
