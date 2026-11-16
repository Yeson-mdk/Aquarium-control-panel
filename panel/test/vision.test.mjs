import './_env.mjs';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { deflateSync } from 'node:zlib';

// ─── seeImage 走假 ModelScope 接口（同 gif.test.mjs 的套路）─────────────
const llmQueue = [];
const llmCalls = [];
const server = createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    try { llmCalls.push(JSON.parse(body)); } catch { /* 不挡 */ }
    const msg = llmQueue.shift() || { content: '' };
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', ...msg } }], usage: { total_tokens: 100 } }));
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

// 最小 PNG 生成器（8 位 RGB、filter 0）：给 seeImage 一个合法图片字节
const CRC_T = (() => { const t = new Int32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c; } return t; })();
const crc32 = (b) => { let c = -1; for (const x of b) c = CRC_T[(c ^ x) & 255] ^ (c >>> 8); return (c ^ -1) >>> 0; };
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const t = Buffer.from(type, 'latin1');
  const c = Buffer.alloc(4); c.writeUInt32BE(crc32(Buffer.concat([t, data])));
  return Buffer.concat([len, t, data, c]);
}
function tinyPng() {
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(1, 0); ihdr.writeUInt32BE(1, 4); ihdr[8] = 8; ihdr[9] = 2;
  const raw = Buffer.from([0, 200, 30, 30]); // 1×1 RGB，filter 0
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

test('看图 2.0：结构化回包拆成字段，desc 拼装保留「图上文字/意思是」这些她提示词认的措辞', async () => {
  const llm = await import('../llm.mjs');
  llmQueue.push({ content: JSON.stringify({ 类型: '梗图', 图上文字: '鱼鱼蒸', 画面: '一只鱼举着牌子', 情绪: '无语', 动作: '' }) });
  const r = await llm.seeImage(tinyPng(), { model: 'Qwen/Qwen3.5-27B' });
  assert.equal(r.kind, 'meme');
  assert.equal(r.textOnImage, '鱼鱼蒸');
  assert.equal(r.scene, '一只鱼举着牌子');
  assert.match(r.desc, /^图上文字：鱼鱼蒸；/, '题眼原字打头，她的「读字→查梗百科」规则才接得上');
  assert.match(r.desc, /意思是无语/);
  // 提示词纪律：逐字照抄、谐音不硬解释、只输出 JSON 这三条硬规则都还在
  const sent = JSON.stringify(llmCalls.at(-1));
  assert.match(sent, /逐字照抄/);
  assert.match(sent, /谐音/);
  assert.match(sent, /只输出.*JSON/);
});

test('看图 2.0：散文回包（没守 JSON 规矩）不炸——desc=原样、kind 空，闸门回退老正则', async () => {
  const llm = await import('../llm.mjs');
  llmQueue.push({ content: '猫猫瘫倒，意思是摆烂' });
  const r = await llm.seeImage(tinyPng(), { model: 'Qwen/Qwen3.5-27B' });
  assert.equal(r.kind, null);
  assert.equal(r.desc, '猫猫瘫倒，意思是摆烂');
  assert.ok(!r.textOnImage);
});

test('看图 2.0：内容图无字——kind=content，desc 就是画面一句', async () => {
  const llm = await import('../llm.mjs');
  llmQueue.push({ content: JSON.stringify({ 类型: '截图', 图上文字: '', 画面: '一个桌面，开着编辑器', 情绪: '', 动作: '' }) });
  const r = await llm.seeImage(tinyPng(), { model: 'Qwen/Qwen3.5-27B' });
  assert.equal(r.kind, 'content');
  assert.equal(r.desc, '一个桌面，开着编辑器');
});

test('看图 2.0 补完：画面放开到 80 字、maxTokens 配套放大——内容图细节不再被 40 字压扁', async () => {
  const llm = await import('../llm.mjs');
  llmQueue.push({ content: JSON.stringify({ 类型: '照片', 图上文字: '', 画面: '一'.repeat(80), 情绪: '', 动作: '' }) });
  const r = await llm.seeImage(tinyPng(), { model: 'Qwen/Qwen3.5-27B' });
  assert.equal(r.scene, '一'.repeat(80), '80 字的画面完整保留');
  assert.equal(r.desc, '一'.repeat(80), 'desc 不把它截掉——不然放开了还是白放');
  const sent = JSON.stringify(llmCalls.at(-1));
  assert.match(sent, /80 字内/, '提示词教的是 80 字（不是 40）');
  assert.ok(llmCalls.at(-1).max_tokens >= 450, `上限配套放大（实际 ${llmCalls.at(-1).max_tokens}），截图类的字+画面才抄得完`);
  assert.doesNotMatch(sent, /40 字内/, '40 字的旧约束清干净了');
});

test('visionText：旧版返回字符串、新版返回对象都能拿到文字', async () => {
  const llm = await import('../llm.mjs');
  assert.equal(llm.visionText('猫猫瘫倒，意思是摆烂'), '猫猫瘫倒，意思是摆烂');
  assert.equal(llm.visionText({ desc: '图上文字：鱼鱼蒸；一只鱼举着牌子' }), '图上文字：鱼鱼蒸；一只鱼举着牌子');
  assert.equal(llm.visionText(null), '');
});
