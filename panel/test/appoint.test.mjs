import './_env.mjs';
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { writeFileSync, readdirSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';

// ─── 假的模型接口（照 morning.test.mjs 范式）──────────────────
const llmQueue = [];
const llmCalls = [];
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
  enabled: true,
  appoint: { enabled: true },
});
store.writeSecrets({ llmApiKey: 'test' });

const appoint = await import('../qq/appoint.mjs');
const owner = await import('../qq/owner.mjs');
const { readTasks, addTask, updateTask, todayCounts, localDate, logAction, readActions } = store;

const DATA = process.env.YANGYU_DATA;
const NOW = Date.now();

// ─── 铺聊天记录：在临时数据目录写 qq-chat-g_9003.jsonl ──────────
function seedChat(peer, lines) {
  const f = join(DATA, 'qq-chat-' + String(peer).replace(/[^a-z0-9_-]/gi, '_') + '.jsonl');
  const rows = lines.map((l) => JSON.stringify({ ts: new Date(NOW - 3600_000).toISOString(), from: 'other', name: l.name, text: l.text, kind: 'text' }));
  writeFileSync(f, rows.join('\n') + '\n');
}
// 清掉所有聊天记录文件（防测试间数据污染）
function cleanChat() {
  for (const f of readdirSync(DATA).filter((f) => /^qq-chat-.*\.jsonl$/.test(f))) unlinkSync(join(DATA, f));
}

// ─── 测试 ──────────────────────────────────────────────────

test('addAppointment 落库：type=appointment + executor=bot + 带 dueAt/peer/originText', () => {
  const a = appoint.addAppointment({ dueAt: NOW + 3600_000, peer: 'owner', originText: '明早8点叫我', who: '号主' });
  const t = readTasks().find((x) => x.id === a.id);
  assert.equal(t.type, 'appointment');
  assert.equal(t.executor, 'bot');
  assert.equal(t.status, 'pending');
  assert.equal(t.peer, 'owner');
  assert.equal(t.originText, '明早8点叫我');
  assert.ok(t.dueAt > NOW);
});

test('scanForAppointments：指向她的约定被认出落库；不指向她的不落', async () => {
  llmQueue.length = 0; llmCalls.length = 0; cleanChat();
  // 群聊：卷心菜约她明天9点找他（指向她）；路人闲聊凑够 digestCandidates 的 6 条门槛
  seedChat('g:9003', [
    { name: '卷心菜', text: '哦鲸鲸，明天9点找我，带你去看猫' },
    { name: '路人甲', text: '今天天气不错' },
    { name: '路人乙', text: '是啊挺热的' },
    { name: '路人甲', text: '晚上吃什么' },
    { name: '路人乙', text: '随便吧' },
    { name: '路人丙', text: '我也随便' },
  ]);
  llmQueue.push({ content: JSON.stringify({ appointments: [{ text: '明天9点找我，带你去看猫', dueAt: new Date(NOW + 86400_000).toISOString(), who: '卷心菜', msgId: '1' }] }) });
  await appoint.scanForAppointments({ now: NOW });
  const aps = readTasks().filter((t) => t.type === 'appointment' && t.peer === 'g:9003');
  assert.equal(aps.length, 1, '认出 1 条约定');
  assert.equal(aps[0].who, '卷心菜');
  assert.match(aps[0].originText, /9点找我/);
  assert.ok(aps[0].dueAt > NOW, 'dueAt 在未来');
});

test('scanForAppointments：坏 JSON 不炸、不落垃圾约定', async () => {
  llmQueue.length = 0; llmCalls.length = 0; cleanChat();
  seedChat('g:9007', Array.from({ length: 6 }, (_, i) => ({ name: '某人', text: `鲸鲸第${i + 1}句` })));
  llmQueue.push({ content: '这不是JSON' });
  const before = readTasks().filter((t) => t.type === 'appointment').length;
  await appoint.scanForAppointments({ now: NOW });
  const after = readTasks().filter((t) => t.type === 'appointment').length;
  assert.equal(after, before, '坏 JSON 不落库');
});

test('scanForAppointments：没指向她的句子不扫（不烧模型调用）', async () => {
  llmQueue.length = 0; llmCalls.length = 0; cleanChat();
  // 6 条都不指向她（没叫名字）
  seedChat('g:9008', Array.from({ length: 6 }, (_, i) => ({ name: '路人', text: `今天天气真好第${i + 1}句` })));
  await appoint.scanForAppointments({ now: NOW });
  assert.equal(llmCalls.length, 0, '没指向她的句子不调模型');
});

test('scanDueAppointments：到期的被处理（调模型生成赴约话）；过期超1小时的不处理', async () => {
  llmQueue.length = 0; llmCalls.length = 0;
  // 一条刚到期（now - 5分钟）
  appoint.addAppointment({ dueAt: NOW - 5 * 60_000, peer: 'owner', originText: '叫我起床', who: '号主' });
  // 一条过期超1小时
  appoint.addAppointment({ dueAt: NOW - 2 * 3600_000, peer: 'owner', originText: '过期的约定', who: '号主' });
  llmQueue.push({ content: '到点啦，起床了～' });
  await appoint.scanDueAppointments(NOW);
  // 刚到期的那条：调了模型生成话（llmCalls 有记录）
  assert.ok(llmCalls.length >= 1, '到期的调了模型');
  // 过期超1小时的那条：不会被选中（dueAt <= now - STALE_MS 被过滤）
  const expired = readTasks().find((t) => t.originText === '过期的约定');
  assert.equal(expired.status, 'pending', '过期超1小时的不处理，状态还是 pending');
});

test('scanDueAppointments：每天最多兑现 2 条，第 3 条被挡', async () => {
  llmQueue.length = 0; llmCalls.length = 0;
  // 先垫到今天已兑现 >= 2 条（不依赖精确值，避免被前面测试的 logAction 污染）
  const cur = (todayCounts().appointment) || 0;
  for (let i = cur; i < 2; i++) logAction({ kind: 'appointment', ok: true, detail: `垫满${i}` });
  assert.ok((todayCounts().appointment) >= 2, '前置：今天已兑现至少 2 条');
  // 再加一条到期的
  appoint.addAppointment({ dueAt: NOW - 60_000, peer: 'owner', originText: '第三条', who: '号主' });
  llmQueue.push({ content: '第三条赴约话' });
  await appoint.scanDueAppointments(NOW);
  const third = readTasks().find((t) => t.originText === '第三条');
  assert.equal(third.status, 'pending', '第 3 条被挡，状态还是 pending');
});

test('scanDueAppointments：开关关着不跑', async () => {
  llmQueue.length = 0; llmCalls.length = 0;
  store.writeConfig({ llm: { baseUrl: `http://127.0.0.1:${server.address().port}`, model: 'fake' }, appoint: { enabled: false } });
  appoint.addAppointment({ dueAt: NOW - 60_000, peer: 'owner', originText: '开关关着', who: '号主' });
  llmQueue.push({ content: '不该出现' });
  await appoint.scanDueAppointments(NOW);
  assert.equal(llmCalls.length, 0, '开关关着不调模型');
  // 恢复开关
  store.writeConfig({ llm: { baseUrl: `http://127.0.0.1:${server.address().port}`, model: 'fake' }, appoint: { enabled: true } });
});

test('listAppointments：分待兑现/已兑现/已过期', () => {
  // 清一下，加几条干净的
  const t1 = appoint.addAppointment({ dueAt: NOW + 3600_000, peer: 'owner', originText: '未来的', who: '号主' });
  const t2 = appoint.addAppointment({ dueAt: NOW - 2 * 3600_000, peer: 'owner', originText: '过期的', who: '号主' });
  const list = appoint.listAppointments();
  assert.ok(Array.isArray(list.pending), 'pending 是数组');
  assert.ok(Array.isArray(list.fired), 'fired 是数组');
  assert.ok(Array.isArray(list.expired), 'expired 是数组');
  assert.ok(list.pending.some((t) => t.id === t1.id), '未来的在 pending');
  assert.ok(list.expired.some((t) => t.id === t2.id), '过期的在 expired');
});
