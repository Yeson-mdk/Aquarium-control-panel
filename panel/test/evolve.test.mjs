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
  assert.match(mind.personaPatchText(), /慢慢长成的性子/);
  assert.match(mind.personaPatchText(), /天文/);
  // 职责分层写进了 prompt：近况是证据不是内容、旧补丁原样保留、没新的就空
  const sent = JSON.stringify(llmCalls.at(-1));
  assert.match(sent, /证据.*不是要抄进补丁的内容|不是要抄进补丁/);
  assert.match(sent, /原样保留/);
  assert.match(sent, /输出空 text/);
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

test('人设补丁：写成了近况流水账（带数字/天气/吃的）就拒收，不污染永久补丁', async () => {
  const { writeFileSync } = await import('node:fs');
  const { join } = await import('node:path');
  const { DATA } = await import('./_env.mjs');
  // 清掉上次的时间戳，模拟又到周期（前面用例已攒够记忆）；沿用「先记时间再干活」口径
  writeFileSync(join(DATA, 'mind.json'), JSON.stringify({ ...mind.readMind(), personaAt: null }));
  const before = mind.readMind().personaHistory.length;
  // 模型又把近况抄进来了：湿度、数字、BV、想吃的——全是记忆，不是性子
  llmQueue.push({ content: JSON.stringify({
    text: '今晚广州阴着湿度74%，上弦月才亮51%，残影378还是想试，半夜馋黄芥末蘸鸡',
    why: '最近的记忆',
  }) });
  const t = await mind.maybeEvolvePersona();
  assert.equal(t, null, '流水账被拒收');
  assert.equal(mind.readMind().personaHistory.length, before, '没留底、没污染补丁');
});

test('人设补丁：净化旧补丁里的近况 + 没长出新的（空 text）都不乱写', async () => {
  const { writeFileSync } = await import('node:fs');
  const { join } = await import('node:path');
  const { DATA } = await import('./_env.mjs');
  const file = join(DATA, 'mind.json');
  // 场景一：旧补丁混着数字近况，模型这次净化了（只删不添）→ 应该落库
  writeFileSync(file, JSON.stringify({ ...mind.readMind(), personaAt: null,
    persona: { at: new Date().toISOString(), text: '她嘴甜心软，残影378记着，馋黄芥末蘸鸡', why: '旧' } }));
  llmQueue.push({ content: JSON.stringify({ text: '她嘴甜心软，遇事先替别人想一步', why: '净化掉旧补丁里的数字和吃的' }) });
  const t = await mind.maybeEvolvePersona();
  assert.equal(t, '她嘴甜心软，遇事先替别人想一步', '净化后的干净补丁落库');
  assert.ok(!/\d|蘸鸡/.test(mind.readMind().persona.text), '旧补丁里的近况成分被清掉了');

  // 场景二：没长出新的，模型输出空 → 补丁原样不动、不留底
  writeFileSync(file, JSON.stringify({ ...mind.readMind(), personaAt: null }));
  const before = mind.readMind().personaHistory.length;
  const keep = mind.readMind().persona.text;
  llmQueue.push({ content: JSON.stringify({ text: '', why: '暂无' }) });
  assert.equal(await mind.maybeEvolvePersona(), null, '没新的就不写');
  assert.equal(mind.readMind().persona.text, keep, '旧补丁原样保留');
  assert.equal(mind.readMind().personaHistory.length, before, '不变相重写留底');

  // force 越过周期：刚写完 personaAt，正常调不跑，force 能立刻重跑（手动净化旧补丁用）
  llmQueue.push({ content: JSON.stringify({ text: '她遇事先替别人想一步，嘴甜但不怼人', why: 'force 重跑' }) });
  assert.equal(await mind.maybeEvolvePersona(), null, '周期内不 force 不跑');
  assert.equal(await mind.maybeEvolvePersona(Date.now(), { force: true }), '她遇事先替别人想一步，嘴甜但不怼人', 'force 立刻重跑');
});
