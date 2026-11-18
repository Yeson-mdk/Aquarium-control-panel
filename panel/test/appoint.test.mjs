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

test('set_appointment 群聊兼容：号主在群里约发回本群；群友也能约本群且@发起人、禁跨群', async () => {
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
  // 群友在群里：也能约，但只能约在本群、记发言者本人（到点 @ 他），填 target 想跨群也不放行
  const guest = { peerKey: 'g:8888', isOwner: false, name: '萌胶带', speakerQq: '555001' };
  const rg = await brain.runTool('set_appointment', { dueAt, text: '后面三天早上九点@我一下', repeat: 'daily', days: 3 }, guest);
  assert.match(rg, /记下了/, '群友能约');
  const g = readTasks().filter((t) => t.type === 'appointment' && t.originText === '后面三天早上九点@我一下').at(-1);
  assert.ok(g, '群友约定落库');
  assert.equal(g.peer, 'g:8888', '约在本群');
  assert.equal(g.targetPeer, 'g:8888', '发回本群，不跨群');
  assert.equal(g.who, '萌胶带', 'who 记发言者本人（到点@他）');
  assert.equal(g.whoQq, '555001', '记发言者 QQ 兜底 @');
  assert.equal(g.days, 3, '连着3天落库');
  const rgCross = await brain.runTool('set_appointment', { dueAt, text: '去别的群提醒', target: 'g:9999' }, guest);
  const g2 = readTasks().filter((t) => t.type === 'appointment' && t.originText === '去别的群提醒').at(-1);
  assert.equal(g2.targetPeer, 'g:8888', '群友填 target 也被摁回本群，禁跨群');
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

test('定时任务：addJob 写 kind=watch/task + jobPayload，旧 appointment 仍写 type=appointment', () => {
  const w = appoint.addJob({ at: NOW + 3600_000, kind: 'watch', peer: 'owner', sourcePeer: 'owner', originText: '看这个', payload: { bvid: 'BV1xx411c7mD' }, who: '号主' });
  const tw = readTasks().find((x) => x.id === w.id);
  assert.equal(tw.type, 'job');
  assert.equal(tw.kind, 'watch');
  assert.equal(tw.jobPayload.bvid, 'BV1xx411c7mD');
  assert.equal(tw.at, NOW + 3600_000);
  assert.equal(tw.dueAt, NOW + 3600_000, '旧字段 dueAt 也写，兼容老读法');
  const old = appoint.addAppointment({ dueAt: NOW + 7200_000, peer: 'owner', originText: '老约定', who: '号主' });
  assert.equal(readTasks().find((x) => x.id === old.id).type, 'appointment', '旧接口仍写 type=appointment');
});

test('schedule_task：号主能建看视频任务，别人被挡；BV 号/时间校验', async () => {
  const dueAt = new Date(NOW + 30 * 60_000).toISOString();
  const ok = await brain.runTool('schedule_task', { kind: 'watch', dueAt, bvid: 'BV1xx411c7mD', text: '看这个视频' }, { isOwner: true, peerKey: 'owner' });
  assert.match(ok, /记下了.*看了/);
  const j = readTasks().filter((t) => t.kind === 'watch').at(-1);
  assert.equal(j.jobPayload.bvid, 'BV1xx411c7mD');
  assert.equal(j.sourcePeer, 'owner', '号主来源');
  // 别人不能建
  assert.equal(await brain.runTool('schedule_task', { kind: 'watch', dueAt, bvid: 'BV1xx411c7mD', text: 'x' }, { isOwner: false, peerKey: 'g:8888' }), '这个只有号主能用');
  // 坏 BV
  assert.match(await brain.runTool('schedule_task', { kind: 'watch', dueAt, bvid: '瞎写的', text: 'x' }, { isOwner: true, peerKey: 'owner' }), /视频号没认出来/);
});

test('scanDueJobs：watch 任务到点被选中走看视频链路（未登录会失败也不抛，留失败日志）', async () => {
  llmQueue.length = 0; llmCalls.length = 0;
  for (const t of readTasks().filter((x) => isJobLike(x) && x.status === 'pending')) store.updateTask(t.id, { status: 'cancelled' });
  const w = appoint.addJob({ at: NOW - 60_000, kind: 'watch', peer: 'owner', sourcePeer: 'owner', originText: '看视频', payload: { bvid: 'BV1xx411c7mD' }, who: '号主' });
  const n0 = readActions().length;
  await appoint.scanDueJobs(NOW);
  // 测试环境 B站 没登录，runSession 会失败——关键是「被选中执行了、且失败没炸」，不是非要 fired
  const after = readTasks().find((t) => t.id === w.id);
  assert.notEqual(after.status, 'pending', 'watch 任务被摘出来处理了（不再挂 pending）或失败记了日志');
  assert.ok(readActions().length > n0, '留下执行/失败日志');
});

test('面板：在看的 watch 任务列进 pending；已执行带 resultNote/bvid；中断的在看会重排', () => {
  for (const t of readTasks().filter((x) => isJobLike(x) && x.status === 'pending')) store.updateTask(t.id, { status: 'cancelled' });
  // 正在看 + 旧的认领时刻（模拟崩了 20 分钟）；at 设未来，放回 pending 后不会被立刻当到期执行
  const stuck = appoint.addJob({ at: NOW + 3600_000, kind: 'watch', peer: 'owner', sourcePeer: 'owner', originText: '看这个', payload: { bvid: 'BV1Stuck011c7' }, who: '号主' });
  store.updateTask(stuck.id, { status: 'in_progress', claimedAt: new Date(NOW - 20 * 60_000).toISOString() });
  // 正在看 + 刚认领（还在看，别动它）
  const live = appoint.addJob({ at: NOW + 3600_000, kind: 'watch', peer: 'owner', sourcePeer: 'owner', originText: '正在看这个', payload: { bvid: 'BV1Live011c7' }, who: '号主' });
  store.updateTask(live.id, { status: 'in_progress', claimedAt: new Date(NOW).toISOString() });

  let list = appoint.listAppointments();
  assert.ok(list.pending.some((t) => t.id === live.id && t.status === 'in_progress'), '在看的列进待执行区供面板显示');

  appoint.scanDueJobs(NOW);
  const stuckAfter = readTasks().find((t) => t.id === stuck.id);
  const liveAfter = readTasks().find((t) => t.id === live.id);
  assert.equal(stuckAfter.status, 'pending', '中断超 15 分钟的在看被放回 pending');
  assert.equal(liveAfter.status, 'in_progress', '刚认领的在看不被误伤');

  // 已执行带总结和 bvid（模拟 doWatch 写完的状态）
  store.updateTask(live.id, { status: 'fired', resultNote: '这视频讲的是深海生物', firedAt: new Date(NOW).toISOString() });
  const fired = appoint.listAppointments().fired.find((t) => t.id === live.id);
  assert.equal(fired.resultNote, '这视频讲的是深海生物', '已执行带总结');
  assert.equal(fired.jobPayload.bvid, 'BV1Live011c7', '已执行带 bvid');
});

function isJobLike(t) { return t.type === 'appointment' || t.type === 'job'; }

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
  assert.equal(auto.isReplanBotTask({ ...base, type: 'job' }), false, '新定时任务(watch/task)也不参与 botTaskNew，避免下午平白重排');
  assert.equal(auto.isReplanBotTask({ ...base, type: 'research' }), true, '真正的派活照旧触发重排');
});

test('daily 重复：到点推进到明天不终结；满 30 天自动停', async () => {
  llmQueue.length = 0; llmCalls.length = 0;
  for (const t of readTasks().filter((x) => isJobLike(x) && x.status === 'pending')) store.updateTask(t.id, { status: 'cancelled' });
  llmQueue.push({ content: '到点啦' });
  // 今天到点的 daily（startedAt = 30 天前 → 这次触发后满 30 天，应自动停）
  const old = appoint.addJob({ at: NOW - 60_000, kind: 'say', peer: 'owner', repeat: 'daily', originText: '每天叫我', startedAt: NOW - 30 * 86400_000 - 1000 });
  await appoint.scanDueJobs(NOW);
  let t = readTasks().find((x) => x.id === old.id);
  assert.equal(t.status, 'cancelled', '满 30 天自动停');
  assert.match(t.cancelReason, /30 天/);

  // 刚建的 daily：触发后仍 pending，at 推进到明天
  for (const t2 of readTasks().filter((x) => isJobLike(x) && x.status === 'pending')) store.updateTask(t2.id, { status: 'cancelled' });
  llmQueue.push({ content: '到点啦' });
  const fresh = appoint.addJob({ at: NOW - 60_000, kind: 'say', peer: 'owner', repeat: 'daily', originText: '每天叫我2' });
  await appoint.scanDueJobs(NOW);
  t = readTasks().find((x) => x.id === fresh.id);
  assert.equal(t.status, 'pending', '没到 30 天继续挂着');
  assert.ok(t.at > NOW + 23 * 3600_000, '推进到明天同一时刻');
  assert.ok(t.startedAt, '记下了首次基准');
});

test('cancelDaily：只停同一人同一来源的 daily，不碰一次性约定、不误伤别人', () => {
  for (const t of readTasks().filter((x) => isJobLike(x) && x.status === 'pending')) store.updateTask(t.id, { status: 'cancelled' });
  const mine = appoint.addJob({ at: NOW + 3600_000, kind: 'say', peer: 'g:9003', sourcePeer: 'g:9003', repeat: 'daily', originText: '每天叫我', who: '卷心菜' });
  const other = appoint.addJob({ at: NOW + 3600_000, kind: 'say', peer: 'g:9003', sourcePeer: 'g:9003', repeat: 'daily', originText: '别人的每天', who: '路人' });
  const once = appoint.addJob({ at: NOW + 3600_000, kind: 'say', peer: 'g:9003', sourcePeer: 'g:9003', repeat: 'once', originText: '一次性约定', who: '卷心菜' });
  const otherPeer = appoint.addJob({ at: NOW + 3600_000, kind: 'say', peer: 'g:9999', sourcePeer: 'g:9999', repeat: 'daily', originText: '别群的每天', who: '卷心菜' });
  const n = appoint.cancelDaily({ peer: 'g:9003', who: '卷心菜' });
  assert.equal(n, 1, '只停一条');
  assert.equal(readTasks().find((x) => x.id === mine.id).status, 'cancelled');
  assert.equal(readTasks().find((x) => x.id === other.id).status, 'pending', '别人的没动');
  assert.equal(readTasks().find((x) => x.id === once.id).status, 'pending', '一次性的没动');
  assert.equal(readTasks().find((x) => x.id === otherPeer.id).status, 'pending', '别群的同名没动');
});

test('set_appointment daily：口头告知带"每天+30天"，落库 repeat=daily', async () => {
  const dueAt = new Date(NOW + 3600_000).toISOString();
  const r = await brain.runTool('set_appointment', { dueAt, text: '每天8点叫我', repeat: 'daily' }, { isOwner: true, peerKey: 'owner', name: '号主' });
  assert.match(r, /每天.*提醒你.*30 天/, '口头告知自然带每天+30天');
  assert.ok(!/已为您设置|设置成功/.test(r), '不客服腔');
  const j = readTasks().filter((t) => t.repeat === 'daily' && t.originText === '每天8点叫我').at(-1);
  assert.ok(j, '落库了 daily');
  assert.ok(j.startedAt, '记了首次基准');
});

test('scanForAppointments：识别 daily 与喊停', async () => {
  llmQueue.length = 0; llmCalls.length = 0; cleanChat();
  seedChat('g:9003', [
    { name: '卷心菜', text: '哦鲸鲸，每天9点找我' },
    { name: '卷心菜', text: '哦鲸鲸，不用继续了' },
    { name: '路人甲', text: '今天天气不错' }, { name: '路人乙', text: '是啊' },
    { name: '路人丙', text: '晚上吃什么' }, { name: '路人丁', text: '随便' },
  ]);
  // 先建一条这个人的 daily，验证喊停会停掉它
  const daily = appoint.addJob({ at: NOW + 3600_000, kind: 'say', peer: 'g:9003', sourcePeer: 'g:9003', repeat: 'daily', originText: '每天9点找我', who: '卷心菜' });
  llmQueue.push({ content: JSON.stringify({
    appointments: [{ text: '每天9点找我', dueAt: new Date(NOW + 86400_000).toISOString(), who: '卷心菜', msgId: '1', repeat: 'daily' }],
    stops: [{ stopWho: '卷心菜', msgId: '2' }],
  }) });
  await appoint.scanForAppointments({ now: NOW });
  assert.equal(readTasks().find((x) => x.id === daily.id).status, 'cancelled', '喊停把旧 daily 停了');
  assert.ok(readTasks().some((x) => x.repeat === 'daily' && x.status === 'pending' && /每天9点找我/.test(x.originText)), '新的 daily 也建了（先停后建，同一拍）');
});

test('resolveTarget：群名/QQ/owner/歧义/没找到', async () => {
  const groups = await import('../group-names.mjs');
  groups.noteGroup('g:7001', {}); groups.setGroupName('g:7001', '一期测试群');
  groups.noteGroup('g:7002', {}); groups.setGroupName('g:7002', '一期测试群'); // 同名歧义
  groups.noteGroup('g:7003', {}); groups.setGroupName('g:7003', '摸鱼群');
  assert.deepEqual(await appoint.resolveTarget('摸鱼群'), { peer: 'g:7003' }, '群名翻成群号');
  assert.deepEqual(await appoint.resolveTarget('12345678'), { peer: 'p:12345678' }, '不在群表的纯数字→QQ');
  groups.noteGroup('g:70044', {}); groups.setGroupName('g:70044', '鲸鲸群');
  assert.deepEqual(await appoint.resolveTarget('70044'), { peer: 'g:70044' }, '群表里的纯数字群号→群');
  assert.deepEqual(await appoint.resolveTarget('私聊', { isOwner: true }), { peer: 'owner' }, '号主私聊');
  assert.ok((await appoint.resolveTarget('一期测试群')).error?.includes('有几个群'), '同名提示说清楚');
  assert.ok((await appoint.resolveTarget('没听过的群')).error, '找不到给提示');
  assert.equal(await appoint.resolveTarget(''), null, '没说目标就地执行');
});

test('checkPermission：号主全开；好友群私互通；禁群跨群', () => {
  assert.equal(appoint.checkPermission({ isOwner: true, sourcePeer: 'g:1', targetPeer: 'g:2' }).ok, true, '号主全开含群→群');
  assert.equal(appoint.checkPermission({ sourcePeer: 'g:1', targetPeer: 'g:2' }).ok, false, '群友禁群→群');
  assert.match(appoint.checkPermission({ sourcePeer: 'g:1', targetPeer: 'g:2' }).error, /另一个群/);
  assert.equal(appoint.checkPermission({ sourcePeer: 'g:1', targetPeer: 'p:10086' }).ok, true, '群友→私聊可以');
  assert.equal(appoint.checkPermission({ sourcePeer: 'p:10086', targetPeer: 'g:1' }).ok, true, '好友→群可以');
  assert.equal(appoint.checkPermission({ sourcePeer: 'p:10086', targetPeer: 'p:10086' }).ok, true, '就地可以');
});

test('set_appointment 跨会话：号主在群里设"私聊叫我"→ targetPeer=owner，发回私聊', async () => {
  const dueAt = new Date(NOW + 3600_000).toISOString();
  const r = await brain.runTool('set_appointment', { dueAt, text: '跨会话私聊叫我独有', target: '私聊' }, { isOwner: true, peerKey: 'g:8888', name: '号主' });
  assert.match(r, /去 owner 说/, '口头告知说清发到哪');
  const j = readTasks().filter((t) => t.type === 'appointment' && t.originText === '跨会话私聊叫我独有').at(-1);
  assert.equal(j.peer, 'g:8888', '来源是群');
  assert.equal(j.targetPeer, 'owner', '目标改成私聊');
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

test('连着 N 天：响满第 N 个自然日自动停；没到就推进；days 上限 30', async () => {
  llmQueue.length = 0; llmCalls.length = 0;
  for (const t of readTasks().filter((x) => isJobLike(x) && x.status === 'pending')) store.updateTask(t.id, { status: 'cancelled' });

  // 第 3 天（从 startedAt 跨了 2 个自然日）这次响完就停
  llmQueue.push({ content: '到点啦' });
  const d3 = appoint.addJob({ at: NOW - 60_000, kind: 'say', peer: 'owner', repeat: 'daily', days: 3, originText: '连着三天叫我', startedAt: NOW - 2 * 86400_000 });
  await appoint.scanDueJobs(NOW);
  let t = readTasks().find((x) => x.id === d3.id);
  assert.equal(t.status, 'cancelled', '响满第3个自然日自动停');
  assert.match(t.cancelReason, /3 天/, '停因写明天数');
  assert.equal(t.days, 3, 'days 落库');

  // 第 2 天（跨 1 个自然日）还挂着，推进到明天，days 沿用
  for (const t2 of readTasks().filter((x) => isJobLike(x) && x.status === 'pending')) store.updateTask(t2.id, { status: 'cancelled' });
  llmQueue.push({ content: '到点啦' });
  const d2 = appoint.addJob({ at: NOW - 60_000, kind: 'say', peer: 'owner', repeat: 'daily', days: 3, originText: '连着三天叫我2', startedAt: NOW - 86400_000 });
  await appoint.scanDueJobs(NOW);
  t = readTasks().find((x) => x.id === d2.id);
  assert.equal(t.status, 'pending', '第2天继续挂着');
  assert.ok(t.at > NOW + 23 * 3600_000, '推进到明天同一时刻');
  assert.equal(t.days, 3, 'days 沿用到下一次');

  // 超过 30 天 clamp 到 30
  const huge = appoint.addJob({ at: NOW + 3600_000, kind: 'say', peer: 'owner', repeat: 'daily', days: 100, originText: '连着一百天' });
  assert.equal(readTasks().find((x) => x.id === huge.id).days, 30, 'days 最多 30');
});

test('set_appointment 连着 N 天：口头告知带天数，落库 days', async () => {
  const dueAt = new Date(NOW + 3600_000).toISOString();
  const r = await brain.runTool('set_appointment', { dueAt, text: '后面三天早上9点叫我', repeat: 'daily', days: 3 }, { isOwner: true, peerKey: 'owner', name: '号主' });
  assert.match(r, /连着 3 天/, '告知带天数');
  assert.ok(!/连着 30 天/.test(r), '说了天数就别再提30天');
  const j = readTasks().filter((t) => t.repeat === 'daily' && t.originText === '后面三天早上9点叫我').at(-1);
  assert.ok(j, '落库了 daily');
  assert.equal(j.days, 3, '落库 days=3');
});

test('scanForAppointments：识别「连着 N 天」并落库 days', async () => {
  llmQueue.length = 0; llmCalls.length = 0; cleanChat();
  seedChat('g:9003', [
    { name: '卷心菜', text: '哦鲸鲸，连着三天早上9点找我' },
    { name: '路人甲', text: '今天天气不错' }, { name: '路人乙', text: '是啊' },
    { name: '路人丙', text: '晚上吃什么' }, { name: '路人丁', text: '随便' },
  ]);
  for (const t of readTasks().filter((x) => isJobLike(x) && x.status === 'pending')) store.updateTask(t.id, { status: 'cancelled' });
  llmQueue.push({ content: JSON.stringify({
    appointments: [{ text: '连着三天早上9点找我', dueAt: new Date(NOW + 86400_000).toISOString(), who: '卷心菜', msgId: '1', repeat: 'daily', days: 3 }],
    stops: [],
  }) });
  await appoint.scanForAppointments({ now: NOW });
  assert.ok(readTasks().some((x) => x.repeat === 'daily' && x.days === 3 && /连着三天/.test(x.originText)), '连着3天落库 days=3');
});

test('scanForAppointments：群友不叫昵称、只说「后面三天早上九点@我一下」也能扫描识别', async () => {
  llmQueue.length = 0; llmCalls.length = 0; cleanChat();
  seedChat('g:9009', [
    { name: '萌胶带', text: '后面三天早上九点@我一下' },
    { name: '路人甲', text: '今天天气不错' },
    { name: '路人乙', text: '是啊挺热的' },
    { name: '路人甲', text: '晚上吃什么' },
    { name: '路人乙', text: '随便吧' },
    { name: '路人丙', text: '我也随便' },
  ]);
  llmQueue.push({ content: JSON.stringify({ appointments: [{ text: '后面三天早上九点@我一下', dueAt: new Date(NOW + 86400_000).toISOString(), who: '萌胶带', msgId: '1', repeat: 'daily', days: 3 }] }) });
  await appoint.scanForAppointments({ now: NOW });
  assert.ok(llmCalls.length > 0, '不叫昵称的约定句式也触发了扫描（放宽生效）');
  const aps = readTasks().filter((t) => t.type === 'appointment' && t.peer === 'g:9009' && /后面三天/.test(t.originText || ''));
  assert.equal(aps.length, 1, '群友约定落库');
  assert.equal(aps[0].days, 3, '连着3天落库');
  assert.equal(aps[0].who, '萌胶带', '记发言者（到点@他）');
});
