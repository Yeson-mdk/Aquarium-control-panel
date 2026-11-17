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
const notify = await import('../notify.mjs');
const brain = await import('../qq/brain.mjs');
const auto = await import('../autopilot.mjs');
const { readTasks, readActions } = store;

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
  const logs = readActions().filter((x) => x.target === a.id);
  assert.equal(logs.length, 1, '建约定只写一条日志');
  assert.equal(logs[0].kind, 'appointment_set', '建约定不写 kind:task 的「派任务」');
  assert.match(logs[0].detail, /认出个约定/);
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

test('发送通道：notify 必须导出 rawSend（赴约直发用，曾漏 export 导致「rawSend is not a function」）', () => {
  assert.equal(typeof notify.rawSend, 'function', 'notify.mjs 必须导出 rawSend，否则号主闹钟赴约必失败');
});

test('set_appointment 群聊兼容：号主在群里说话放行，约定记成发回那个群；别人在群里仍被挡', async () => {
  const dueAt = new Date(NOW + 30 * 60_000).toISOString();
  const out = { peerKey: 'g:8888', isOwner: true, name: 'Yeson' }; // 号主在群里说话
  const r = await brain.runTool('set_appointment', { dueAt, text: '10点45分在群里冒个泡吧' }, out);
  assert.match(r, /记下了|到点/, '号主在群里设约定要放行');
  const a = readTasks().filter((t) => t.type === 'appointment' && t.originText === '10点45分在群里冒个泡吧').at(-1);
  assert.equal(a.peer, 'g:8888', '约定记成发回那个群，不是私聊');
  assert.equal(a.who, 'Yeson', 'who 记真实发言人');
  assert.match(a.note, /群里赴约/, 'note 标群聊');
  const logs = readActions().filter((x) => x.target === a.id);
  assert.equal(logs.length, 1, 'set_appointment 只写一条日志');
  assert.equal(logs[0].kind, 'appointment_set', '不再混进「派任务」');
  assert.match(logs[0].detail, /设了个提醒/);
  // 别人在群里：工具单里压根没有 set_appointment，门禁也挡
  assert.equal(await brain.runTool('set_appointment', { dueAt, text: 'x' }, { peerKey: 'g:8888', isOwner: false }), '这个只有号主能用', '别人群里不能设约定');
  assert.equal(await brain.runTool('set_appointment', { dueAt, text: 'x' }, { peerKey: 'p:123' }), '这个只有号主能用', '别人私聊也不能');
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

test('scanDueAppointments：赴约次数不设上限，同一拍多条都进兑现流程且没有上限提示', async () => {
  llmQueue.length = 0; llmCalls.length = 0;
  // 前面用例里发送失败留在 pending 的约定会一直被扫，先清场
  for (const t of readTasks().filter((x) => x.type === 'appointment' && x.status === 'pending')) store.updateTask(t.id, { status: 'cancelled' });
  appoint.addAppointment({ dueAt: NOW - 2 * 60_000, peer: 'owner', originText: '10点57分给老大发消息', who: '号主' });
  appoint.addAppointment({ dueAt: NOW - 60_000, peer: 'owner', originText: '10点57在群里冒个泡', who: '号主' });
  llmQueue.push({ content: '第一条赴约话' }, { content: '第二条赴约话' });
  await appoint.scanDueAppointments(NOW);
  assert.equal(llmCalls.length, 2, '两条都写了赴约话，不再被 2 条上限挡掉第二条');
  assert.ok(!readActions().some((x) => /今天已兑现/.test(x.detail)), '不再输出「今天已兑现 2 条」提示');
  const setLogs = readActions().filter((x) => x.kind === 'appointment_set');
  assert.ok(setLogs.length >= 2, '两条建立约定各有一条约定日志');
  assert.ok(!readActions().some((x) => x.kind === 'task' && /赴约|提醒号主/.test(x.detail)), '建约定不写派任务日志');
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

test('autopilot 重排判定：约定不算「号主新派的活」，不触发时辰重排', () => {
  const base = { executor: 'bot', status: 'pending', ts: new Date(NOW).toISOString() };
  assert.equal(auto.isReplanBotTask({ ...base, type: 'appointment' }), false, '约定不参与 botTaskNew');
  assert.equal(auto.isReplanBotTask({ ...base, type: 'research' }), true, '真正的派活照旧触发重排');
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
