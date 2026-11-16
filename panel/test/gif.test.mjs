import './_env.mjs';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { inflateSync } from 'node:zlib';

// ─── 手搓一个最小 GIF89a 生成器：每帧可指定局部矩形、dispose 方式、透明色、是否隔行 ──
// LZW 用「每个像素前都发 clear」的无压缩写法（合法流，解码器必须认），fixture 完全自包含
const GCT = [[255, 0, 0], [0, 0, 255], [0, 255, 0], [255, 255, 255]]; // 0红 1蓝 2绿 3白
function buildGif(w, h, frames) {
  const out = [];
  const s = (n) => [n & 255, (n >> 8) & 255];
  out.push(...Buffer.from('GIF89a', 'latin1'), ...s(w), ...s(h), 0x81, 0, 0);
  for (const c of GCT) out.push(c[0], c[1], c[2]);
  for (const f of frames) {
    out.push(0x21, 0xf9, 0x04, ((f.disposal || 0) << 2) | (f.transparent == null ? 0 : 1), ...s(f.delay ?? 10), f.transparent == null ? 0 : f.transparent, 0);
    const [x, y, fw, fh] = f.rect;
    out.push(0x2c, ...s(x), ...s(y), ...s(fw), ...s(fh), f.interlace ? 0x40 : 0x00);
    const order = f.interlace
      ? [[0, 8], [4, 8], [2, 4], [1, 2]].flatMap(([st, sp]) => { const r = []; for (let i = st; i < fh; i += sp) r.push(i); return r; })
      : [...Array(fh).keys()];
    const codes = [];
    for (const r of order) for (const px of f.rows[r]) codes.push(4, px); // clear + 字面量
    codes.push(5); // eoi
    let cur = 0, bits = 0; const bytes = [];
    for (const c of codes) { cur |= c << bits; bits += 3; while (bits >= 8) { bytes.push(cur & 255); cur >>= 8; bits -= 8; } }
    if (bits) bytes.push(cur & 255);
    out.push(2); // LZW 最小码长 2 → 码长 3，0..3 字面量、4=clear、5=eoi
    for (let i = 0; i < bytes.length; i += 255) { const ch = bytes.slice(i, i + 255); out.push(ch.length, ...ch); }
    out.push(0);
  }
  out.push(0x3b);
  return Buffer.from(out);
}

// ─── 最小 PNG 读取器：只认 8 位 RGBA + filter 0（自家编码器写的，够用了）────────
function pngPixels(buf) {
  assert.deepEqual([...buf.subarray(0, 4)], [0x89, 0x50, 0x4e, 0x47], 'PNG 头');
  let w = 0, h = 0; const idat = [];
  let p = 8;
  while (p < buf.length) {
    const len = buf.readUInt32BE(p); const type = buf.toString('latin1', p + 4, p + 8);
    const data = buf.subarray(p + 8, p + 8 + len);
    if (type === 'IHDR') { w = data.readUInt32BE(0); h = data.readUInt32BE(4); }
    if (type === 'IDAT') idat.push(data);
    p += 12 + len;
  }
  const raw = inflateSync(Buffer.concat(idat));
  const stride = 1 + w * 4;
  assert.equal(raw.length, h * stride, '行数据长度');
  const px = (x, y) => {
    const o = y * stride + 1 + x * 4;
    assert.equal(raw[y * stride], 0, 'filter 得是 0');
    return [raw[o], raw[o + 1], raw[o + 2], raw[o + 3]];
  };
  return { w, h, px };
}

// ─── seeImage 走假 ModelScope 接口（同 qq.test.mjs 的套路，但只直调 seeImage）────
const llmCalls = [];
const server = createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    llmCalls.push(JSON.parse(body));
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: '一张动图' } }], usage: { total_tokens: 100 } }));
  });
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
before(async () => {
  const store = await import('../store.mjs');
  store.writeConfig({ llm: { baseUrl: 'http://127.0.0.1:1', model: 'fake' }, qq: { visionModel: 'Qwen/Qwen3.5-27B' } });
  store.writeSecrets({ llmApiKey: 'test', modelscopeToken: 'ms-tk' });
  process.env.YANGYU_MS_BASE = `http://127.0.0.1:${server.address().port}/v1`;
});
after(() => { server.close(); delete process.env.YANGYU_MS_BASE; });

test('gif 拆帧：两帧全屏红→蓝，解出两帧各自颜色的 PNG', async () => {
  const { gifFrames } = await import('../gif.mjs');
  const gif = buildGif(4, 4, [
    { rect: [0, 0, 4, 4], rows: Array.from({ length: 4 }, () => [0, 0, 0, 0]), delay: 10 },
    { rect: [0, 0, 4, 4], rows: Array.from({ length: 4 }, () => [1, 1, 1, 1]), delay: 20 },
  ]);
  const fr = gifFrames(gif);
  assert.equal(fr.length, 2, '两帧');
  assert.equal(fr[0].delay, 100, 'delay 换算成毫秒（GIF 单位是 1/100 秒）');
  assert.equal(fr[1].delay, 200);
  const f1 = pngPixels(fr[0].png); const f2 = pngPixels(fr[1].png);
  assert.equal(f1.w, 4); assert.equal(f1.h, 4);
  assert.deepEqual(f1.px(1, 2), [255, 0, 0, 255], '第一帧是红');
  assert.deepEqual(f2.px(2, 3), [0, 0, 255, 255], '第二帧是蓝');
});

test('gif 拆帧：局部更新 + dispose 恢复背景 + 透明色跳过', async () => {
  const { gifFrames } = await import('../gif.mjs');
  const gif = buildGif(4, 4, [
    { rect: [0, 0, 4, 4], rows: Array.from({ length: 4 }, () => [0, 0, 0, 0]) },
    { rect: [1, 1, 2, 2], rows: [[1, 1], [1, 1]], disposal: 2 }, // 中央蓝块，帧后清回透明
    { rect: [0, 0, 2, 2], rows: [[2, 3], [3, 3]], transparent: 3 }, // 左上绿 + 透明色 3
  ]);
  const fr = gifFrames(gif);
  assert.equal(fr.length, 3);
  const f2 = pngPixels(fr[1].png);
  assert.deepEqual(f2.px(1, 1), [0, 0, 255, 255], '第二帧中央是蓝');
  assert.deepEqual(f2.px(0, 0), [255, 0, 0, 255], '第二帧周围还是红（局部更新，别的没动）');
  const f3 = pngPixels(fr[2].png);
  assert.deepEqual(f3.px(0, 0), [0, 255, 0, 255], '第三帧左上画了绿');
  assert.deepEqual(f3.px(1, 0), [255, 0, 0, 255], '透明色 3 没盖掉底下的红');
  assert.equal(f3.px(1, 1)[3], 0, 'dispose 恢复背景：第二帧的矩形被清成透明');
  assert.deepEqual(f3.px(3, 3), [255, 0, 0, 255], '没被碰过的地方还是红');
});

test('gif 拆帧：隔行存储的帧也要摆对行', async () => {
  const { gifFrames } = await import('../gif.mjs');
  const rows = Array.from({ length: 8 }, (_, r) => [r % 2 ? 1 : 0, r % 2 ? 1 : 0]); // 偶数行红、奇数行蓝
  const gif = buildGif(2, 8, [{ rect: [0, 0, 2, 8], rows, interlace: true }]);
  const { px } = pngPixels(gifFrames(gif)[0].png);
  assert.deepEqual(px(0, 0), [255, 0, 0, 255], '第 0 行红');
  assert.deepEqual(px(0, 1), [0, 0, 255, 255], '第 1 行蓝');
  assert.deepEqual(px(0, 6), [255, 0, 0, 255], '第 6 行红（隔行扫描最容易摆错的就是中间行）');
  assert.deepEqual(px(1, 7), [0, 0, 255, 255], '第 7 行蓝');
});

test('看图：多帧 gif 按时间顺序抽成几张 PNG 喂模型，静帧去重；单帧/解不动就原图直传', async () => {
  const llm = await import('../llm.mjs');
  const see = (buf) => llm.seeImage(buf, { model: 'Qwen/Qwen3.5-27B' }); // 生产上模型名由 index.mjs 从配置带进来，直调也得给
  const body = () => {
    const m = llmCalls.at(-1).messages[1].content;
    return { text: m[0].text, imgs: m.filter((x) => x.type === 'image_url') };
  };
  // 3 帧但后两帧一样 → 去重成 2 帧
  const red = Array.from({ length: 4 }, () => [0, 0, 0, 0]);
  const blue = Array.from({ length: 4 }, () => [1, 1, 1, 1]);
  await see(buildGif(4, 4, [{ rect: [0, 0, 4, 4], rows: red }, { rect: [0, 0, 4, 4], rows: blue }, { rect: [0, 0, 4, 4], rows: blue }]));
  let b = body();
  assert.equal(b.imgs.length, 2, '两张帧图（重复帧去重）');
  assert.ok(b.imgs.every((x) => x.image_url.url.startsWith('data:image/png;base64,')), '帧都转成了 PNG');
  assert.match(b.text, /动图/, '告诉模型这是动图、按帧序看');
  // 单帧 gif：动画没信息，原图直传
  await see(buildGif(4, 4, [{ rect: [0, 0, 4, 4], rows: red }]));
  b = body();
  assert.equal(b.imgs.length, 1);
  assert.ok(b.imgs[0].image_url.url.startsWith('data:image/gif;base64,'), '单帧退回整张 gif');
  assert.doesNotMatch(b.text, /动图/);
  // 坏 gif：解不动不炸，退回原图直传
  await see(Buffer.concat([Buffer.from('GIF89a'), Buffer.alloc(40, 7)]));
  b = body();
  assert.equal(b.imgs.length, 1);
  assert.ok(b.imgs[0].image_url.url.startsWith('data:image/gif;base64,'), '坏文件也原图直传');
});
