/**
 * 纯 JS 的 GIF 拆帧：把动图解成一张张整幅 PNG（按时间顺序、带 dispose 合成）。
 *
 * 为什么自己写：QQ 聊天里 gif 表情包整文件塞给视觉接口，对方只按「一张静图」处理
 * （大多只吃第一帧，动画就丢了）。容器里又没有 sips/ffmpeg 可以拆帧，
 * 所以这里用零依赖把 GIF89a 解掉——只干「聊天看图」这一件事，不求全：
 *   - 支持局部更新、隔行扫描、dispose 2（清回背景）/3（还原上一帧）、透明色
 *   - 每帧输出合成后的整幅 RGBA PNG（filter 0、8 位色）
 * 坏文件、超尺寸（>2 百万像素）、超帧数（>64 帧）直接抛错，调用方退回原图直传。
 */
import { deflateSync } from 'node:zlib';

/** @returns {{delay:number, png:Buffer}[]} 每帧一张合成好的 PNG，delay 是毫秒 */
export function gifFrames(buf, { maxFrames = 64, maxPixels = 2 << 20 } = {}) {
  if (!buf || buf.length < 14 || !/^GIF8[79]a$/.test(buf.toString('latin1', 0, 6))) throw new Error('不是 GIF 文件');
  const W = buf.readUInt16LE(6), H = buf.readUInt16LE(8);
  if (!W || !H) throw new Error('尺寸是 0');
  if (W * H > maxPixels) throw new Error(`尺寸 ${W}x${H} 超过 ${maxPixels} 像素`);
  let p = 13;
  let gct = null;
  if (buf[10] & 0x80) { const n = 2 << (buf[10] & 7); gct = buf.subarray(p, p + n * 3); p += n * 3; }

  let canvas = new Uint8Array(W * H * 4); // RGBA，初始全透明
  let disposal = 0, transparent = -1, delay = 0;
  const frames = [];
  const subBlocks = () => { // 读到块终结符为止的一串子块
    const parts = [];
    while (p < buf.length && buf[p] !== 0) { parts.push(buf.subarray(p + 1, p + 1 + buf[p])); p += 1 + buf[p]; }
    p++;
    return Buffer.concat(parts);
  };

  while (p < buf.length) {
    const b = buf[p++];
    if (b === 0x3b) break; // trailer
    if (b === 0x21) { // 扩展块：只关心图像控制（GCE），其余跳过
      const label = buf[p++];
      if (label === 0xf9) {
        const n = buf[p], d = buf.subarray(p + 1, p + 1 + n);
        disposal = (d[0] >> 2) & 7; transparent = (d[0] & 1) ? d[3] : -1;
        delay = ((d[1] | (d[2] << 8))) * 10; // GIF 单位 1/100 秒
        p += 1 + n + 1;
      } else subBlocks();
      continue;
    }
    if (b !== 0x2c) throw new Error(`不认识的块 0x${b.toString(16)}`);

    const ix = buf.readUInt16LE(p), iy = buf.readUInt16LE(p + 2), iw = buf.readUInt16LE(p + 4), ih = buf.readUInt16LE(p + 6), flags = buf[p + 8];
    p += 9;
    const lct = flags & 0x80 ? buf.subarray(p, p + (2 << (flags & 7)) * 3) : gct; // 局部色表优先
    if (flags & 0x80) p += (2 << (flags & 7)) * 3;
    if (!lct) throw new Error('这张图没有色表');
    const minCode = buf[p++];
    const pixels = decodeLzw(subBlocks(), minCode);

    const saved = disposal === 3 ? canvas.slice() : null; // dispose 3：画完还原
    draw(canvas, W, H, pixels, lct, ix, iy, iw, ih, !!(flags & 0x40), transparent);
    frames.push({ delay, png: pngEncode(canvas, W, H) });
    if (frames.length >= maxFrames) break;
    if (disposal === 2) for (let y = iy; y < iy + ih && y < H; y++) for (let x = ix; x < ix + iw && x < W; x++) canvas[(y * W + x) * 4 + 3] = 0; // 清回背景（按透明处理）
    else if (saved) canvas = saved;
  }
  if (!frames.length) throw new Error('一帧都没解出来');
  return frames;
}

/** 把一帧的像素序列画到画布上（局部矩形 + 隔行扫描的行序还原 + 透明色跳过） */
function draw(canvas, W, H, pixels, lct, ix, iy, iw, ih, interlace, transparent) {
  const passes = interlace ? [[0, 8], [4, 8], [2, 4], [1, 2]] : [[0, 1]];
  let q = 0;
  for (const [start, step] of passes) for (let y = start; y < ih; y += step) for (let x = 0; x < iw; x++) {
    const v = pixels[q++];
    if (v === transparent) continue;
    const cx = ix + x, cy = iy + y;
    if (cx >= W || cy >= H) continue;
    const o = (cy * W + cx) * 4;
    canvas[o] = lct[v * 3] || 0; canvas[o + 1] = lct[v * 3 + 1] || 0; canvas[o + 2] = lct[v * 3 + 2] || 0; canvas[o + 3] = 255;
  }
}

/** GIF 的 LZW：返回逐像素的色表下标序列 */
function decodeLzw(data, minCode) {
  const clear = 1 << minCode, eoi = clear + 1;
  const prefix = new Int32Array(4096), suffix = new Uint8Array(4096), first = new Uint8Array(4096);
  for (let i = 0; i < clear; i++) { suffix[i] = i; first[i] = i; prefix[i] = -1; }
  let size = minCode + 1, next = eoi + 1, prev = -1, bits = 0, cur = 0, pos = 0;
  const out = [];
  const emit = (code) => { const st = []; let k = code; while (k >= 0) { st.push(suffix[k]); k = prefix[k]; } for (let i = st.length - 1; i >= 0; i--) out.push(st[i]); };
  for (;;) {
    while (bits < size) { if (pos >= data.length) return out; cur |= data[pos++] << bits; bits += 8; }
    const c = cur & ((1 << size) - 1); cur >>>= size; bits -= size;
    if (c === clear) { size = minCode + 1; next = eoi + 1; prev = -1; continue; }
    if (c === eoi) return out;
    if (prev < 0) { // 紧跟 clear 的第一个码必是字面量
      if (c >= clear) return out;
      out.push(c); prev = c; continue;
    }
    const inDict = c < next;
    if (!inDict && c !== next) return out; // 码坏了：把已解出来的交回去，别硬崩
    if (inDict) emit(c); else { emit(prev); out.push(first[prev]); } // KwKwK 情形
    prefix[next] = prev; suffix[next] = inDict ? first[c] : first[prev]; first[next] = first[prev];
    next++;
    if (next === 1 << size && size < 12) size++;
    prev = c;
  }
}

/** 整幅 RGBA 画布 → PNG（8 位色、带 alpha、逐行 filter 0） */
function pngEncode(rgba, w, h) {
  const raw = Buffer.alloc(h * (1 + w * 4));
  for (let y = 0; y < h; y++) raw.set(rgba.subarray(y * w * 4, (y + 1) * w * 4), y * (1 + w * 4) + 1); // 行首 filter 字节留 0
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 6;
  const chunk = (type, data) => {
    const t = Buffer.from(type, 'latin1'); const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([t, data])) >>> 0);
    return Buffer.concat([len, t, data, crc]);
  };
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

// 与 llm.mjs makeTestPng 同一套 crc32（zlib 没直接给，查表法）
const CRC_TABLE = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
function crc32(buf) { let c = 0xffffffff; for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; }
