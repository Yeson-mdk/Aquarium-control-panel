import './_env.mjs';
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';

// flash 档网关的已知偶发：HTTP 200 但 content 空（限流/降级）——429/5xx 有重试，这种也该有
const llmQueue = [];
const llmCalls = [];
const server = createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    try { llmCalls.push(JSON.parse(body)); } catch { /* 不挡 */ }
    const msg = llmQueue.shift() || { content: '' };
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', ...msg }, finish_reason: 'stop' }], usage: { total_tokens: 50 } }));
  });
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
after(() => server.close());

const store = await import('../store.mjs');
store.writeConfig({ llm: { baseUrl: `http://127.0.0.1:${server.address().port}`, model: 'fake' } });
store.writeSecrets({ llmApiKey: 'test' });
const llm = await import('../llm.mjs');

test('chatRaw：200 但空回话（无 tool_calls）重试一次——flash 网关限流降级的已知行为（2026-11-16 晨间计划「没回话」实测）', async () => {
  llmQueue.push({ content: '' }, { content: '{"ok":1}' });
  const r = await llm.chatRaw([{ role: 'user', content: '排计划' }], { maxTokens: 100 });
  assert.equal(r.content, '{"ok":1}', '第二次拿到真回话');
  assert.equal(llmCalls.length, 2, '空回话重试了一次');
  // 重试都空：照旧返回空串（调用方的「没回话」兜底各自有日志），不无限重试
  llmQueue.push({ content: '' }, { content: '' });
  const r2 = await llm.chatRaw([{ role: 'user', content: '再排' }], { maxTokens: 100 });
  assert.equal(r2.content, '');
  assert.equal(llmCalls.length, 4, '只重试一次，两次都空就认了');
  // 带 tool_calls 的空文字回包是合法的（工具调用轮），不许重试
  llmQueue.push({ content: '', tool_calls: [{ id: 't1', type: 'function', function: { name: 'x', arguments: '{}' } }] });
  const r3 = await llm.chatRaw([{ role: 'user', content: '调工具' }], { maxTokens: 100 });
  assert.ok(r3.toolCalls.length === 1);
  assert.equal(llmCalls.length, 5, '工具调用轮不重试');
});
