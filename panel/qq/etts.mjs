/**
 * 发语音用的 TTS：微软 Edge 浏览器「大声朗读」的公开接口（edge-tts），直连 WebSocket 拿 mp3。
 * 零依赖（Node 自带 WebSocket 和 crypto），也不需要 ffmpeg，Windows / Linux 容器都能跑——
 * 老方案是 macOS 的 say + ffmpeg，NAS 里没有 say，语音一直发不出（2026-10-29 换掉）。
 * 接口偶尔抽风时这里抛错，上层（index.mjs 的 deliver）会兜底改成发文字，不用在这重试。
 */
import { createHash, randomUUID } from 'node:crypto';
import { readConfig } from '../store.mjs';

const TRUSTED = '6A5AA1D4EAFF4E9FB37E23D68491D6F4'; // Edge「大声朗读」的公开 client token
const GEC_VERSION = '2-143.0.3650.96';

// 对外的嗓音名还是 Meijia / Flo / Eddy（模型那边一直在用），底下换成微软的中文音色。
// 面板「她的嗓音」选了具体的微软音色就全程用它（Meijia/Flo/Eddy 不再区分）
const VOICE_MAP = {
  Meijia: 'zh-CN-XiaoxiaoNeural', // 温柔大方的女声（默认）
  Flo: 'zh-CN-XiaoyiNeural',      // 甜软一点的女声
  Eddy: 'zh-CN-YunxiNeural',      // 男声
};
const isMsVoice = (v) => /^[a-z]{2,3}-[A-Za-z-]+Neural$/.test(String(v || '').trim());
export const edgeVoice = (voice) => {
  const v = String(voice || '').trim();
  if (isMsVoice(v)) return v; // 直接给了微软音色 id（试听）
  const chosen = String(readConfig().qq.ttsVoice || '').trim();
  if (isMsVoice(chosen)) return chosen;
  return VOICE_MAP[v] || VOICE_MAP.Meijia;
};

// ─── Sec-MS-GEC v2：微软的防白嫖校验，算不对整个握手直接 403 ────────
// 算法来自 edge-tts 社区逆向（rany2/edge-tts#492）：版权行 + (ticks+token) 做 SHA-256，
// 再对「原文+摘要」算一个自定义 CS64 校验和，最后拼成「校验和-摘要」。
const COPYRIGHT = 'Copyright (C) Microsoft Corporation. All rights reserved.';
const hex = (b) => b.toString('hex').toUpperCase();
const swapHalves = (v) => ((v << 16) | (v >>> 16)) >>> 0;
const swapTerm = (w, key, [a, b, c]) => {
  const sum = (Math.imul(w, key) + Math.imul(swapHalves(w), a)) >>> 0;
  const product = Math.imul(swapHalves(sum), b) >>> 0;
  return (Math.imul(swapHalves(product), c) + product) >>> 0;
};
const swapMul = (v, mults) => mults.reduce((x, m) => Math.imul(swapHalves(x), m) >>> 0, v);
function cs64(message, digest) {
  const k1 = (digest.readUInt32LE(0) | 1) >>> 0;
  const k2 = (digest.readUInt32LE(4) | 1) >>> 0;
  const padded = Buffer.alloc(Math.ceil(message.length / 8) * 8); // 按 8 字节一组零补齐
  message.copy(padded);
  let swapSum = 0, lastSwap = 0, mix = 0, mixSum = 0;
  for (let o = 0; o < padded.length; o += 8) {
    const w1 = padded.readUInt32LE(o), w2 = padded.readUInt32LE(o + 4);
    const s1 = swapTerm(w1, k1, [0xEF0569FB, 0x76F50F34, 0xC3EFEA97]);
    lastSwap = swapTerm(w2, k2, [0xC31713DB, 0x1881CE3C, 0x35BD1EC9]);
    swapSum = (swapSum + s1 + lastSwap) >>> 0;
    mix = swapMul(Math.imul(mix + w1, k1), [0xCF98B111, 0x87085B9F, 0x12CEB96D, 0x257E1D83]);
    mixSum = (mixSum + mix) >>> 0;
    mix = swapMul(Math.imul(mix + w2, k2), [0xA27416F5, 0xD38396FF, 0x7C932B89, 0xBFA49F69]);
    mixSum = (mixSum + mix) >>> 0;
  }
  const out = Buffer.alloc(8);
  out.writeUInt32LE((lastSwap ^ mix) >>> 0, 0);
  out.writeUInt32LE((swapSum ^ mixSum) >>> 0, 4);
  return out;
}
function gec() {
  let ticks = Math.floor(Date.now() / 1000) + 11644473600; // unix 秒 → Windows 纪元秒
  ticks -= ticks % 300; // 对齐 5 分钟（防重放）
  const message = Buffer.from(COPYRIGHT + `${ticks * 1e7}${TRUSTED}`, 'utf-8');
  const digest = createHash('sha256').update(message).digest();
  return `${hex(cs64(message, digest))}-${hex(digest)}`;
}

// ─── 合成 ────────────────────────────────────────────────
/** 一段话 → mp3 的 Buffer（NapCat 自己转成 QQ 的语音格式）。voice 用对外的嗓音名，不认识的当 Meijia */
export async function edgeTtsMp3(text, voice = 'Meijia') {
  if (typeof WebSocket === 'undefined') throw new Error('这个 Node 没有 WebSocket');
  const url = `wss://speech.platform.bing.com/consumer/speech/synthesize/readaloud/edge/v1`
    + `?TrustedClientToken=${TRUSTED}&Sec-MS-GEC=${gec()}&Sec-MS-GEC-Version=${GEC_VERSION}`
    + `&ConnectionId=${randomUUID()}`;
  const ws = new WebSocket(url, {
    headers: {
      Origin: 'chrome-extension://jdiccldimpdaibmpdkjnbmckianbfold', // 得装成 Edge 的朗读插件，否则 403
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36 Edg/143.0.0.0',
    },
  });
  ws.binaryType = 'arraybuffer';
  return new Promise((resolve, reject) => {
    const chunks = [];
    const timer = setTimeout(() => { try { ws.close(); } catch { /* 还在连就直接算失败 */ } reject(new Error('语音合成超时')); }, 20000);
    const done = (fn, arg) => { clearTimeout(timer); try { ws.close(); } catch { /* 关不掉就算了 */ } fn(arg); };
    ws.onopen = () => {
      ws.send('Content-Type:application/json; charset=utf-8\r\nPath:speech.config\r\n\r\n'
        + JSON.stringify({ context: { synthesis: { audio: { metadataoptions: { sentenceBoundaryEnabled: 'false', wordBoundaryEnabled: 'false' }, outputFormat: 'audio-24khz-48kbitrate-mono-mp3' } } } }));
      const id = randomUUID().replace(/-/g, '');
      const esc = String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
      ws.send(`X-RequestId:${id}\r\nContent-Type:application/ssml+xml\r\nPath:ssml\r\n\r\n`
        + `<speak version='1.0' xmlns='http://www.w3.org/2001/10/synthesis' xml:lang='zh-CN'><voice name='${edgeVoice(voice)}'>${esc}</voice></speak>`);
    };
    ws.onmessage = (ev) => {
      const buf = Buffer.from(ev.data instanceof ArrayBuffer ? ev.data : Buffer.from(ev.data));
      const head = buf.subarray(0, 200).toString();
      if (head.includes('Path:turn.end')) return done(resolve, Buffer.concat(chunks));
      const at = buf.indexOf('Path:audio\r\n');
      if (at >= 0) chunks.push(buf.subarray(at + 'Path:audio\r\n'.length)); // 头和音频的分界
    };
    ws.onerror = () => done(reject, new Error('语音接口连不上（被拒或没网）'));
    ws.onclose = () => { clearTimeout(timer); if (chunks.length) resolve(Buffer.concat(chunks)); else reject(new Error('语音接口没给音频')); };
  });
}
