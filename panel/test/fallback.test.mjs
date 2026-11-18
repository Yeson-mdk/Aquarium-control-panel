import './_env.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { after } from 'node:test';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { DATA, writeConfig, writeSecrets } from '../store.mjs';
import * as llm from '../llm.mjs';

// 假接口：body.model 是 bad-* 就报配置错，是 busy-* 就报 429，否则正常回话
let server, base;
const calls = [];
after(() => server?.close());

function setup() {
  if (server) return;
  server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const b = JSON.parse(body || '{}');
      calls.push(b.model);
      res.setHeader('Content-Type', 'application/json');
      if (String(b.model).startsWith('bad-')) { res.writeHead(401); return res.end(JSON.stringify({ error: { message: 'Invalid API key' } })); }
      if (String(b.model).startsWith('busy-')) { res.writeHead(429); return res.end(JSON.stringify({ error: { message: 'Too many requests' } })); }
      res.end(JSON.stringify({ choices: [{ message: { content: `回复自 ${b.model}` } }], usage: { total_tokens: 10 } }));
    });
  });
}

function cfg(fallback) {
  writeConfig({ llm: { baseUrl: base, model: 'bad-primary' }, qq: { modelFallback: fallback } });
  writeSecrets({ llmApiKey: 'test' });
}

test('0. 前置：假接口起来', async () => {
  setup();
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}/v1`;
  cfg('');
});

test('1. isConfigError：认得出 Key/地址/模型名/余额，不认限流和网络', () => {
  for (const m of ['API Key 不对或已失效', '接口地址不对（404）', '没有这个模型：xxx', '余额不足', 'insufficient quota']) {
    assert.ok(llm.isConfigError(new Error(m)), m);
  }
  for (const m of ['模型接口报错：HTTP 429', '连不上模型接口（ECONNRESET）', '模型接口报错：HTTP 500', '今天的模型预算用完了']) {
    assert.ok(!llm.isConfigError(new Error(m)), m);
  }
});

test('2. 主模型配置错 → 自动降档到备用，拿到回复', async () => {
  cfg('good-fallback');
  calls.length = 0;
  const r = await llm.chatRawWithFallback([{ role: 'user', content: 'hi' }], { model: 'bad-primary', essential: true });
  assert.equal(r.content, '回复自 good-fallback');
  assert.deepEqual(calls, ['bad-primary', 'good-fallback'], '先打主模型，401 后换备用');
});

test('3. 没配备用 → 配置错原样抛，不吞', async () => {
  cfg('');
  calls.length = 0;
  await assert.rejects(
    llm.chatRawWithFallback([{ role: 'user', content: 'hi' }], { model: 'bad-primary', essential: true }),
    /API Key/,
  );
  assert.deepEqual(calls, ['bad-primary'], '没备用就不打第二枪');
});

test('4. 429 不是配置错 → 不降档（主模型内部重试，别在外层再包）', async () => {
  cfg('good-fallback');
  calls.length = 0;
  // busy-primary 会 429 两次（chatRaw 内部重试一次），都算主模型的枪；不该出现 fallback
  await assert.rejects(
    llm.chatRawWithFallback([{ role: 'user', content: 'hi' }], { model: 'busy-primary', essential: true }),
  );
  assert.ok(calls.every((m) => m === 'busy-primary'), '全程打主模型，没换备用');
  assert.equal(calls.length, 2, 'chatRaw 自己重试了一次');
});

test('5. 备用和主模型同名 → 不降档（避免死循环重打同一个）', async () => {
  cfg('bad-primary');
  calls.length = 0;
  await assert.rejects(
    llm.chatRawWithFallback([{ role: 'user', content: 'hi' }], { model: 'bad-primary', essential: true }),
    /API Key/,
  );
  assert.deepEqual(calls, ['bad-primary'], '只打一次');
});

test('6. 降档写了 logAction 告警日志（actions.jsonl 可查）', async () => {
  cfg('good-fallback-2');
  const before = existsSync(join(DATA, 'actions.jsonl')) ? readFileSync(join(DATA, 'actions.jsonl'), 'utf-8') : '';
  await llm.chatRawWithFallback([{ role: 'user', content: 'hi' }], { model: 'bad-primary', essential: true });
  const afterLog = readFileSync(join(DATA, 'actions.jsonl'), 'utf-8');
  assert.ok(afterLog.length > before.length, '写了一条动作日志');
  assert.match(afterLog.slice(before.length), /降档到备用模型/);
});
