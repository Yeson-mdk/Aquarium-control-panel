// 梗图指纹库（看图 2.0 第 2 层）：同一张梗图第二次见面不用再看一遍——
// dHash 指纹认出来，直接用上次看懂的字和意思。认不出/解不动 → 照常走视觉模型，不劣于现状。
//
// 全部零依赖手写（NAS 容器里没有 sips/ffmpeg，也不能 npm）：
// - PNG：zlib 解压 + 反滤波（8 位、colortype 0/2/6、不交织）
// - JPEG：只写基线 sequential（DQT/SOF0/DHT/SOS/DRI、huffman、反量化、IDCT）；
//   渐进式/WebP → 解不动就返回 null 跳过指纹，不影响正事
// - GIF：走 gif.mjs 的 gifFrames 拿第一帧 PNG 再按 PNG 解
import { inflateSync } from 'node:zlib';
import { readFileSync, writeFileSync } from 'node:fs';
import { FILES, nowIso } from './store.mjs';
import { gifFrames } from './gif.mjs';

const THRESH = 10;      // 汉明距离 ≤10 算同一张（QQ 重压缩/尺寸变化基本扛得住，反相/换图直接拉远）
const LIB_CAP = 500;    // 库容上限：最久没见的先请出去

// ─── 解码 → 灰度图 ─────────────────────────────────────────
/** 任何 supported 图片字节 → { w, h, gray: Uint8Array(w*h) }；解不动抛错（dHash 会接住返回 null） */
export function decodeGray(buf) {
  if (!buf || buf.length < 8) throw new Error('太短');
  if (buf[0] === 0x89 && buf[1] === 0x50) return decodePng(buf);
  if (buf[0] === 0xff && buf[1] === 0xd8) return decodeJpeg(buf);
  if (buf[0] === 0x47 && buf[1] === 0x49) return decodePng(gifFrames(buf)[0]?.png); // 动图按第一帧认
  throw new Error('不认识的图格式');
}

// ─── PNG ───────────────────────────────────────────────────
function decodePng(buf) {
  let p = 8, idat = [], w = 0, h = 0, ch = 0;
  while (p + 8 <= buf.length) {
    const len = buf.readUInt32BE(p);
    const type = buf.toString('latin1', p + 4, p + 8);
    const data = buf.subarray(p + 8, p + 8 + len);
    if (type === 'IHDR') {
      w = data.readUInt32BE(0); h = data.readUInt32BE(4);
      const depth = data[8], ct = data[9];
      if (depth !== 8) throw new Error('只解 8 位 PNG');
      ch = ct === 0 ? 1 : ct === 2 ? 3 : ct === 6 ? 4 : 0;
      if (!ch || data[12]) throw new Error('只解 8 位灰度/真彩/带透明、不交织');
    } else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
    p += 12 + len;
  }
  if (!w || !h || !idat.length) throw new Error('PNG 结构不全');
  const raw = inflateSync(Buffer.concat(idat));
  const stride = w * ch;
  if (raw.length < h * (stride + 1)) throw new Error('PNG 数据不够');
  const gray = new Uint8Array(w * h);
  let prev = new Uint8Array(stride); // 上一行（反滤波用）
  const line = new Uint8Array(stride);
  for (let y = 0; y < h; y++) {
    const f = raw[y * (stride + 1)];
    line.set(raw.subarray(y * (stride + 1) + 1, y * (stride + 1) + 1 + stride));
    for (let x = 0; x < stride; x++) {
      const a = x >= ch ? line[x - ch] : 0, b = prev[x], c = x >= ch ? prev[x - ch] : 0;
      if (f === 1) line[x] = (line[x] + a) & 255;
      else if (f === 2) line[x] = (line[x] + b) & 255;
      else if (f === 3) line[x] = (line[x] + ((a + b) >> 1)) & 255;
      else if (f === 4) {
        const pa = Math.abs(b - c), pb = Math.abs(a - c), pc = Math.abs(a + b - 2 * c);
        line[x] = (line[x] + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c)) & 255;
      } // f===0 不动
    }
    for (let x = 0; x < w; x++) {
      let v;
      if (ch === 1) v = line[x];
      else { const o = x * ch; v = (line[o] * 299 + line[o + 1] * 587 + line[o + 2] * 114) / 1000; }
      gray[y * w + x] = v;
    }
    prev = line.slice(); // 上一行要独立一份（line 下一轮要复用）
  }
  return { w, h, gray };
}

// ─── JPEG（基线 sequential）────────────────────────────────
const ZIGZAG = [0,1,8,16,9,2,3,10,17,24,32,25,18,11,4,5,12,19,26,33,40,48,41,34,27,20,13,6,7,14,21,28,35,42,49,56,57,50,43,36,29,22,15,23,30,37,44,51,58,59,52,45,38,31,39,46,53,60,61,54,47,55,62,63];
// IDCT 基底：A[u][x] = c(u)·cos((2x+1)uπ/16)，c(0)=1/√2
const IDCT_A = (() => {
  const A = [];
  for (let u = 0; u < 8; u++) {
    A[u] = [];
    for (let x = 0; x < 8; x++) A[u][x] = (u ? 1 : Math.SQRT1_2) * Math.cos((2 * x + 1) * u * Math.PI / 16);
  }
  return A;
})();
function idct(coef, out) { // coef 自然序 64 项（已反量化）→ out[8y+x] 空间域（0-255 未截断）
  for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) {
    let s = 0;
    for (let v = 0; v < 8; v++) {
      const bv = IDCT_A[v][y];
      for (let u = 0; u < 8; u++) { const c = coef[v * 8 + u]; if (c) s += c * IDCT_A[u][x] * bv; }
    }
    out[y * 8 + x] = s * 0.25 + 128;
  }
}

function buildHuff(counts, symbols) {
  const mincode = new Int32Array(17), maxcode = new Int32Array(17).fill(-1), valptr = new Int32Array(17);
  let code = 0, k = 0;
  for (let l = 1; l <= 16; l++) {
    valptr[l] = k; mincode[l] = code;
    if (counts[l - 1]) maxcode[l] = code + counts[l - 1] - 1;
    code = (code + counts[l - 1]) << 1; k += counts[l - 1];
  }
  return { mincode, maxcode, valptr, symbols };
}
class Bits {
  constructor(buf, start) { this.buf = buf; this.p = start; this.cur = 0; this.left = 0; }
  bit() {
    if (!this.left) {
      if (this.p >= this.buf.length) throw new Error('JPEG 数据不够');
      let v = this.buf[this.p];
      if (v === 0xff) {
        const nx = this.buf[this.p + 1];
        if (nx === 0x00) this.p += 2;            // ff 00 = 字面 ff
        else if (nx >= 0xd0 && nx <= 0xd7) this.p += 2; // 重启标记：当作没看见（块循环里对齐后会跳过）
        else throw new Error('JPEG 提前收尾');
      } else this.p++;
      this.cur = v; this.left = 8;
    }
    this.left--;
    return (this.cur >> this.left) & 1;
  }
  bits(k) { let v = 0; while (k--) v = (v << 1) | this.bit(); return v; }
  align() { this.left = 0; }
  /** 对齐到字节边界后，吃掉紧跟的重启标记（有的话） */
  eatRestart() {
    this.align();
    while (this.buf[this.p] === 0xff && this.buf[this.p + 1] >= 0xd0 && this.buf[this.p + 1] <= 0xd7) this.p += 2;
  }
}
function huff(t, br) {
  let code = 0;
  for (let l = 1; l <= 16; l++) {
    code = (code << 1) | br.bit();
    if (t.maxcode[l] >= 0 && code <= t.maxcode[l]) return t.symbols[t.valptr[l] + code - t.mincode[l]];
  }
  throw new Error('huffman 解不出来');
}
const extend = (v, s) => (v < (1 << (s - 1)) ? v - (1 << s) + 1 : v);

function decodeJpeg(buf) {
  let p = 2;
  const qt = [null, null, null, null];
  const huffs = {};
  let w = 0, h = 0, comps = null, restart = 0, entropy = 0, scan = null;
  while (p + 1 < buf.length) {
    if (buf[p] !== 0xff) { p++; continue; }
    const m = buf[p + 1];
    if (m === 0xff) { p++; continue; } // 填充字节
    p += 2;
    if (m === 0xd9) throw new Error('没碰到扫描数据就结束了');
    if (m >= 0xd0 && m <= 0xd7) continue;
    if (p + 2 > buf.length) throw new Error('JPEG 头被截断');
    const len = buf.readUInt16BE(p);
    const seg = buf.subarray(p + 2, p + len);
    if (m === 0xdb) { // DQT（存成自然序，用时直接乘）
      let q = 0;
      while (q + 1 < seg.length) {
        const pq = seg[q] >> 4, tq = seg[q] & 15; q++;
        const tbl = new Float64Array(64);
        for (let i = 0; i < 64; i++) {
          let v;
          if (pq) { v = seg.readUInt16BE(q); q += 2; } else { v = seg[q]; q += 1; }
          tbl[ZIGZAG[i]] = v;
        }
        qt[tq] = tbl;
      }
    } else if (m === 0xc0 || m === 0xc1) { // SOF0/1：基线/扩展 sequential——能解
      h = seg.readUInt16BE(1); w = seg.readUInt16BE(3);
      comps = [];
      for (let i = 0; i < seg[5]; i++) {
        const o = 6 + i * 3;
        comps.push({ id: seg[o], hs: seg[o + 1] >> 4, vs: seg[o + 1] & 15, tq: seg[o + 2] });
      }
    } else if (m === 0xc2) throw new Error('渐进式 JPEG 不解（跳过指纹走视觉）');
    else if (m >= 0xc3 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) throw new Error('这种 SOF 不支持');
    else if (m === 0xc4) { // DHT
      let q = 0;
      while (q + 17 <= seg.length) {
        const tc = seg[q] >> 4, th = seg[q] & 15; q++;
        const counts = Array.from(seg.subarray(q, q + 16)); q += 16;
        const total = counts.reduce((a, b) => a + b, 0);
        huffs[`${tc}${th}`] = buildHuff(counts, Array.from(seg.subarray(q, q + total)));
        q += total;
      }
    } else if (m === 0xdd) restart = seg.readUInt16BE(0);
    else if (m === 0xda) { // SOS：头后面就是熵编码数据
      scan = {};
      for (let i = 0; i < seg[0]; i++) {
        const o = 1 + i * 2;
        const c = comps.find((x) => x.id === seg[o]);
        if (!c) throw new Error('SOS 里的分量对不上');
        c.dcT = huffs[`0${seg[o + 1] >> 4}`]; c.acT = huffs[`1${seg[o + 1] & 15}`];
        if (!c.dcT || !c.acT) throw new Error('huffman 表没配齐');
      }
      entropy = p + len;
      break;
    }
    p += len;
  }
  if (!w || !h || !scan || !entropy) throw new Error('JPEG 结构不全');
  const luma = comps.length === 1 ? comps[0] : comps.find((c) => c.id === 1);
  if (!luma) throw new Error('找不着亮度分量');
  const maxH = Math.max(...comps.map((c) => c.hs)), maxV = Math.max(...comps.map((c) => c.vs));
  const mcuX = Math.ceil(w / (8 * maxH)), mcuY = Math.ceil(h / (8 * maxV));
  const gray = new Uint8Array(w * h);
  const br = new Bits(buf, entropy);
  const coefs = new Float64Array(64);
  const px = new Float64Array(64);
  const preds = {};
  let mcuIdx = 0;
  for (let my = 0; my < mcuY; my++) for (let mx = 0; mx < mcuX; mx++, mcuIdx++) {
    for (const c of comps) {
      for (let by = 0; by < c.vs; by++) for (let bx = 0; bx < c.hs; bx++) {
        // 解一个 8×8 块（色度分量也要解——不解位流就错位了，只是不做 IDCT 不落灰度）
        coefs.fill(0);
        const t = huff(c.dcT, br);
        preds[c.id] = (preds[c.id] || 0) + (t ? extend(br.bits(t), t) : 0);
        coefs[0] = preds[c.id] * qt[c.tq][0];
        let k = 1;
        while (k < 64) {
          const rs = huff(c.acT, br);
          const r = rs >> 4, s = rs & 15;
          if (!s) { if (r === 15) { k += 16; continue; } break; }
          k += r;
          if (k > 63) throw new Error('交流系数越界');
          coefs[ZIGZAG[k]] = extend(br.bits(s), s) * qt[c.tq][k];
          k++;
        }
        if (c === luma) {
          idct(coefs, px);
          const x0 = (mx * c.hs + bx) * 8, y0 = (my * c.vs + by) * 8;
          for (let y = 0; y < 8; y++) {
            const gy = y0 + y; if (gy >= h) break;
            for (let x = 0; x < 8; x++) {
              const gx = x0 + x; if (gx >= w) break;
              gray[gy * w + gx] = Math.max(0, Math.min(255, Math.round(px[y * 8 + x])));
            }
          }
        }
      }
    }
    if (restart && mcuIdx % restart === restart - 1) { br.eatRestart(); for (const k2 of Object.keys(preds)) preds[k2] = 0; }
  }
  return { w, h, gray };
}

// ─── dHash：9×8 灰度 → 左右邻比 → 64 位指纹（16 位十六进制）──────────
/** 图片字节 → 指十六进制指纹；解不动/不认识的格式 → null（不挡正事） */
export function dHash(buf) {
  let g;
  try { g = decodeGray(buf); } catch { return null; }
  const W = 9, H = 8;
  const small = new Float64Array(W * H);
  for (let ty = 0; ty < H; ty++) for (let tx = 0; tx < W; tx++) {
    // 盒式平均：每个目标格盖住源图一块（抗缩放/抗 QQ 重压缩的关键——比逐点采样稳）
    const x0 = Math.floor(tx * g.w / W), x1 = Math.max(x0 + 1, Math.floor((tx + 1) * g.w / W));
    const y0 = Math.floor(ty * g.h / H), y1 = Math.max(y0 + 1, Math.floor((ty + 1) * g.h / H));
    let s = 0, n = 0;
    for (let y = y0; y < y1 && y < g.h; y++) for (let x = x0; x < x1 && x < g.w; x++) { s += g.gray[y * g.w + x]; n++; }
    small[ty * W + tx] = n ? s / n : 0;
  }
  let hex = '';
  for (let r = 0; r < H; r++) {
    let byte = 0;
    for (let c = 0; c < 8; c++) byte = (byte << 1) | (small[r * W + c] > small[r * W + c + 1] ? 1 : 0);
    hex += byte.toString(16).padStart(2, '0');
  }
  return hex;
}

export function hamming(a, b) {
  if (!/^[0-9a-f]{16}$/.test(String(a || '')) || !/^[0-9a-f]{16}$/.test(String(b || ''))) return 64;
  // 64 位指纹超出 Number 安全整数：用 BigInt 异或，别用 parseInt（低 11 位会被浮点精度吃掉，
  // 反相图会被算成只差几位，指纹库把两张图认成同一张）
  let d = 0, x = BigInt('0x' + a) ^ BigInt('0x' + b);
  while (x) { d += Number(x & 1n); x >>= 1n; }
  return d;
}

// ─── 梗图库：data/meme-lib.json（只记梗图；「她见过什么、谁常发」是她自己的经历）──
function readLib() {
  try { const j = JSON.parse(readFileSync(FILES.memeLib, 'utf-8')); return Array.isArray(j) ? j : []; } catch { return []; }
}
function writeLib(lib) {
  writeFileSync(FILES.memeLib, JSON.stringify(lib), 'utf-8');
}

/** 看一眼认不认得：{ hash, hit }——hit 是库里最近的那张（≤阈值），没有就 null */
export function recognize(buf) {
  const hash = dHash(buf);
  if (!hash) return { hash: null, hit: null };
  let best = null, bestD = THRESH + 1;
  for (const e of readLib()) {
    const d = hamming(hash, e.hash);
    if (d < bestD) { bestD = d; best = e; }
  }
  return { hash, hit: bestD <= THRESH ? best : null };
}

/** 见过就记一笔：同一张再见面 count+1、谁发的也记着；字段以第一次看懂的为准（后续只补空） */
export function remember(hash, info = {}, peer = '') {
  if (!/^[0-9a-f]{16}$/.test(String(hash || ''))) return null;
  const lib = readLib();
  const iso = nowIso();
  let e = lib.find((x) => x.hash === hash);
  if (!e) {
    e = { hash, kind: info.kind || 'meme', textOnImage: '', scene: '', emotion: '', motion: '', desc: '', firstSeen: iso, count: 0, peers: [] };
    lib.push(e);
  }
  e.count++; e.lastSeen = iso;
  if (info.desc && !e.desc) e.desc = info.desc; // 第一次看懂的描述定住；面板改过也不会被下一次自动描述盖掉
  if (info.textOnImage && !e.textOnImage) e.textOnImage = info.textOnImage; // 题眼第一次抄到就定住
  if (info.scene && !e.scene) e.scene = info.scene;
  if (info.emotion && !e.emotion) e.emotion = info.emotion;
  if (info.motion && !e.motion) e.motion = info.motion;
  if (peer && !e.peers.includes(peer)) e.peers.push(peer);
  if (e.peers.length > 20) e.peers = e.peers.slice(-20);
  if (lib.length > LIB_CAP) { // 满了：最久没见的先请出去
    lib.sort((a, b) => String(b.lastSeen || '').localeCompare(String(a.lastSeen || '')));
    lib.length = LIB_CAP;
  }
  writeLib(lib);
  return e;
}

/** 面板用：按最近见过排序的梗图库（只读副本） */
export function list() {
  return readLib().slice().sort((a, b) => String(b.lastSeen || '').localeCompare(String(a.lastSeen || '')));
}

/** 面板改描述：顺带从「图上文字：…；」里同步题眼，闸门下次还按字段走 */
export function update(hash, patch = {}) {
  const h = String(hash || '');
  const lib = readLib();
  const e = lib.find((x) => x.hash === h);
  if (!e) return null;
  if (patch.desc !== undefined) e.desc = String(patch.desc || '').replace(/\s+/g, ' ').trim().slice(0, 200);
  if (patch.textOnImage !== undefined) e.textOnImage = String(patch.textOnImage || '').replace(/\s+/g, '').trim().slice(0, 60);
  if (patch.kind !== undefined) e.kind = ['meme', 'gif', 'content'].includes(patch.kind) ? patch.kind : e.kind;
  const m = String(e.desc || '').match(/图上文字[：:]\s*([^；;，,。]{2,60})/);
  if (m) e.textOnImage = m[1].replace(/[“”"「」『』]/g, '').trim();
  e.updatedAt = nowIso();
  writeLib(lib);
  return e;
}

export function remove(hash) {
  const h = String(hash || '');
  const lib = readLib();
  const next = lib.filter((x) => x.hash !== h);
  if (next.length === lib.length) return false;
  writeLib(next);
  return true;
}

/**
 * 看图入口：先查指纹库，认得出就零视觉调用；认不出才 describe()，看完入库。
 * 只缓存梗图/动图（内容图、截图不占库）；describe 返回 seeImage 的结构化对象。
 */
export async function cachedSee(buf, { describe, peer = '' } = {}) {
  const { hash, hit } = recognize(buf);
  if (hit?.desc) {
    // 命中也要记一笔：count / 谁常发 / 最近一次见，都是靠这里累加的；描述不覆盖
    const e = remember(hash, {}, peer) || hit;
    return { ...e, hash, cached: true };
  }
  const info = await describe();
  if (!info) return null;
  // 兼容旧版 seeImage 返回字符串：指纹库/闸门都按结构化字段消费，别把字符串展开成字符
  const norm = typeof info === 'string'
    ? { desc: info, kind: null, textOnImage: '', scene: info, emotion: '', motion: '' }
    : info;
  if (hash && (norm.kind === 'meme' || norm.kind === 'gif')) remember(hash, norm, peer);
  return { ...norm, hash, cached: false };
}
