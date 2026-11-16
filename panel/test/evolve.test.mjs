import './_env.mjs';
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';

// ─── 假的模型接口：按顺序吐预先排好的回复 ─────────────────────
const llmQueue = [];
const llmCalls = []; // 收下每次实际发出去的请求体，好断言「哪些记忆进了提示词」
const server = createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    try { llmCalls.push(JSON.parse(body)); } catch { /* 记录不挡正事 */ }
    const msg = llmQueue.shift() || { content: '{}' };
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', ...msg } }], usage: { total_tokens: 100 } }));
  });
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
after(() => server.close());

const store = await import('../store.mjs');
store.writeConfig({
  llm: { baseUrl: `http://127.0.0.1:${server.address().port}`, model: 'fake' },
  mind: { enabled: true, personaDays: 14 },
});
store.writeSecrets({ llmApiKey: 'test' });

const mind = await import('../mind.mjs');
const memory = await import('../memory.mjs');

test('人设微调：到了周期跑一次，产出拼进 QQ 人设；周期内不空跑', async () => {
  // 记忆攒够了才会微调
  for (let i = 0; i < 8; i++) memory.add({ kind: i % 2 ? 'chat' : 'watch', text: `记忆${i}：她今天${i % 2 ? '跟号主聊得很开心' : '刷到一个天文视频看入迷了'}`, imp: 3 });
  assert.equal(mind.personaPatchText(), '', '还没微调过，补丁是空的');
  llmQueue.push({ content: JSON.stringify({ text: '最近迷上天文迷得不行，说话比以前更爱打比方了。', why: '好几条天文相关的记忆' }) });
  const t = await mind.maybeEvolvePersona();
  assert.match(t, /天文/);
  assert.match(mind.personaPatchText(), /最近自然长出来的样子/);
  assert.match(mind.personaPatchText(), /天文/);
  assert.equal(mind.readMind().personaHistory.length, 1, '留了底');
  // 周期内再调：直接返回，不调模型
  const n = llmQueue.length;
  assert.equal(await mind.maybeEvolvePersona(), null);
  assert.equal(llmQueue.length, n, '没到周期不空跑');
});

test('人设微调：personaDays 0 关掉；到周期但记忆太少不定性', async () => {
  store.writeConfig({ mind: { personaDays: 0 } });
  assert.equal(await mind.maybeEvolvePersona(), null, '关着就不跑');
  store.writeConfig({ mind: { personaDays: 14 } });
  // 把上次微调时间清掉，模拟到了周期，但把记忆清空 → 记忆太少不定性
  const { writeFileSync } = await import('node:fs');
  const { join } = await import('node:path');
  const { DATA } = await import('./_env.mjs');
  const m = mind.readMind();
  writeFileSync(join(DATA, 'mind.json'), JSON.stringify({ ...m, personaAt: null }));
  const { rmSync } = await import('node:fs');
  try { rmSync(join(DATA, 'memories.json')); } catch { /* 可能本来就没有 */ }
  const n = llmQueue.length;
  assert.equal(await mind.maybeEvolvePersona(), null, '记忆太少不定性');
  assert.equal(llmQueue.length, n, '不调模型');
});

test('人设微调：群聊/好友对话的记忆不进（朋友改变不了她的性格）', async () => {
  // 上个测试那次空跑也把 personaAt 记成现在了（防天天空跑是先记时间再查记忆），再清一次模拟到了周期
  { const { writeFileSync } = await import('node:fs'); const { join } = await import('node:path'); const { DATA } = await import('./_env.mjs');
    writeFileSync(join(DATA, 'mind.json'), JSON.stringify({ ...mind.readMind(), personaAt: null })); }
  // 攒够她自己的 B站 记忆，再混进三种对话日结
  for (let i = 0; i < 8; i++) memory.add({ kind: 'watch', imp: 3, text: `看了《天文观测第${i}夜》：星空真好看`, keys: ['up:观星者'] });
  memory.add({ kind: 'chat', imp: 4, text: '「群·9002」聊的主要是：他们在吵架，我劝了半天', keys: ['g:9002'] });
  memory.add({ kind: 'chat', imp: 4, text: '「私·10086」他失恋了来找我安慰', keys: ['p:10086'] });
  memory.add({ kind: 'chat', imp: 4, text: '「群·9002」老格式的条目，还没带钥匙' });
  llmQueue.push({ content: JSON.stringify({ text: '最近迷上天文迷得不行，说话都带着星星。', why: '一串天文记忆' }) });
  const t = await mind.maybeEvolvePersona();
  assert.match(t, /天文/, '自己的记忆照常进、照常长');
  const sent = JSON.stringify(llmCalls.at(-1));
  assert.match(sent, /天文观测/, 'B站 记忆在提示词里');
  assert.ok(!/吵架|失恋|老格式/.test(sent), '带 g:/p: 钥匙的和「群·」开头的都没进');
});
