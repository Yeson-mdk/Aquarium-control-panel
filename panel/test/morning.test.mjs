import './_env.mjs';
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';

// ─── 假的模型接口：按顺序吐预先排好的回复（照 insight.test.mjs 那套）─────
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
  windows: ['辰', '午', '酉'],
  morningPlan: true,
});
store.writeSecrets({ llmApiKey: 'test' });

const auto = await import('../autopilot.mjs');
const memory = await import('../memory.mjs');
const mind = await import('../mind.mjs');

// ─── 铺一张今天的时辰表：三个时辰，一个已到点、一个快到、一个还在下午 ─────
const NOW = Date.now();
const today = store.localDate(new Date(NOW));
function seedSlots() {
  const mk = (key, label, start, end, at) => ({ key, label, start, end, at, status: 'pending' });
  const slots = [
    mk('辰', '辰时', NOW - 3600_000, NOW + 3600_000, NOW - 60_000),
    mk('午', '午时', NOW - 1800_000, NOW + 5400_000, NOW + 60_000),
    mk('酉', '酉时', NOW + 3600_000, NOW + 10800_000, NOW + 5400_000),
  ];
  const st = store.readState();
  st.plans = { [today]: slots };
  st.plannedOn = null; // 每个用例自己管「今天生成过没有」
  st.replanCount = {};
  store.writeState(st);
  return slots;
}

test('3.1 晨间计划：白名单外的类型该格回退、撞日上限的类型变 rest、合法的带着 goal 落位', async () => {
  seedSlots();
  memory.add({ kind: 'self', imp: 5, text: '星轨教程看着热闹，拍出来都一个样' });
  for (let i = 0; i < 3; i++) store.logAction({ kind: 'comment', source: 'auto', detail: '垫满今天的评论上限' });
  llmQueue.push({ content: JSON.stringify({ slots: [
    { key: '辰', type: 'social_init', goal: '主动找人说话' }, // 白名单外（没有这个类型）→ 该时辰按默认随缘刷
    { key: '午', type: 'comment', goal: '去评论区唠两句' },   // 评论上限满了 → 歇着
    { key: '酉', type: 'browse', goal: '顺着星轨再看看' },
  ] }) });
  const plan = await auto.morningPlan();
  const [chen, wu, you] = plan;
  assert.equal(chen.type, undefined, '编出来的类型不许落位，该时辰回退纯时辰表');
  assert.equal(chen.goal, undefined, '类型被拒 goal 也别留');
  assert.equal(wu.type, 'rest', '评论撞日上限：排成歇着');
  assert.equal(wu.goal, undefined, '歇着的格子不留 goal');
  assert.equal(you.type, 'browse');
  assert.equal(you.goal, '顺着星轨再看看');
  // plannedOn 防重复：今天再来一次不调模型
  const calls = llmCalls.length;
  await auto.morningPlan();
  assert.equal(llmCalls.length, calls, '今天生成过就不再生成');
  assert.equal(store.readState().plannedOn, today);
  // 提示词：素材（洞察/昨日量）在，白名单列全，不放例句
  const sent = JSON.stringify(llmCalls[0]);
  assert.match(sent, /星轨教程/, '她的洞察进了提示词');
  assert.match(sent, /browse_like/, '六种类型列全');
  assert.match(sent, /昨天/, '带昨天的量');
  assert.doesNotMatch(sent, /主动找人说话/, '不放例句（例句会被复读）');
});

test('3.1 模型胡说八道：整表回退默认 + 落一条日志（带原文好排查）+ 今天不再重试', async () => {
  seedSlots();
  llmQueue.push({ content: '今天天气不错呀' });
  const plan = await auto.morningPlan();
  assert.ok(plan.every((s) => !s.type), '全部按默认随缘跑');
  const last = store.readActions().at(-1);
  assert.equal(last.kind, 'plan');
  assert.match(last.detail, /失败|没解析出来/);
  assert.match(last.detail, /今天天气不错/, '日志带上模型原话，排查不用猜');
  assert.equal(store.readState().plannedOn, today, '失败也盖章：别 30 秒一重试烧预算');
  const n = llmCalls.length;
  await auto.morningPlan();
  assert.equal(llmCalls.length, n, '失败过也不再调模型');
});

test('3.1b JSON 截在半个字段也能救回完整的时辰（2026-11-18 14:22 回归）', async () => {
  seedSlots();
  // 第一个时辰完整、第二个截在 goal 中途、后面全丢——老代码 JSON.parse 直接抛「Unexpected end of JSON input」
  llmQueue.push({ content: '{"slots":[{"key":"辰","type":"browse","goal":"顺星轨看看"},{"key":"午","type":"res' });
  const plan = await auto.morningPlan();
  const chen = plan.find((s) => s.key === '辰');
  assert.equal(chen.type, 'browse', '完整的前一条救回');
  assert.equal(chen.goal, '顺星轨看看');
  const wu = plan.find((s) => s.key === '午');
  assert.ok(wu.type !== 'res', '截坏的半条不生效（res 不在白名单/或不完整）');
  const acts = store.readActions().filter((a) => a.kind === 'plan' && a.ok === false);
  assert.ok(!acts.some((a) => /Unexpected end of JSON/.test(a.error || '')), '不再弹晦涩的 JSON 解析错误');
});

test('3.2 重排：只动还没跑的时辰、跑过的照旧、每天最多 2 次', async () => {
  const slots = seedSlots();
  slots[0].status = 'done'; slots[0].type = 'browse';
  slots[2].status = 'done'; slots[2].type = 'rest';
  const st = store.readState();
  st.plans[today] = slots;
  st.plannedOn = today; // 今天生成过，走重排这条路
  store.writeState(st);

  llmQueue.push({ content: JSON.stringify({ slots: [{ key: '午', type: 'diary', goal: '把星轨那事写进日记' }] }) });
  const plan = await auto.morningPlan({ replan: true });
  assert.equal(plan[1].type, 'diary');
  assert.equal(plan[1].replanned, true, '重排过的格子有记号');
  assert.equal(plan[0].type, 'browse', '跑过的格子不动');
  assert.equal(plan[2].type, 'rest');

  llmQueue.push({ content: JSON.stringify({ slots: [{ key: '午', type: 'check' }] }) });
  await auto.morningPlan({ replan: true });
  assert.equal(store.readState().replanCount[today], 2);

  llmQueue.push({ content: JSON.stringify({ slots: [{ key: '午', type: 'rest' }] }) });
  const n = llmCalls.length;
  await auto.morningPlan({ replan: true });
  assert.equal(llmCalls.length, n, '第 3 次重排直接挡掉，不调模型');
  assert.match(store.readActions().at(-1).detail, /原计划/);
  assert.equal(store.readState().plans[today][1].type, 'check', '被挡的那次不许改动');
});

test('3.1 带 goal 的时辰跑完写一条反馈记忆（不挂人）；没 goal 不写', () => {
  const before = memory.memoryView(100).total;
  auto.recordSlotFeedback({ key: '午', label: '午时', type: 'browse', goal: '顺着星轨再看看' }, '看了 3 个，都是教程');
  let v = memory.memoryView(100);
  assert.equal(v.total, before + 1);
  let e = v.recent[0];
  assert.equal(e.kind, 'watch');
  assert.equal(e.imp, 2);
  assert.ok(!e.keys?.length, '不挂人：这是她自己的经历，不是谁的事');
  assert.match(e.text, /顺着星轨/);
  assert.match(e.text, /看了 3 个/);

  auto.recordSlotFeedback({ key: '酉', label: '酉时', type: 'comment', goal: '去评论区唠两句' }, '评论了 1 条');
  v = memory.memoryView(100);
  e = v.recent[0];
  assert.equal(e.kind, 'social', '评论的反馈记成社交一面');
  auto.recordSlotFeedback({ key: '亥', label: '亥时', type: 'browse' }, '随缘刷了一轮');
  assert.equal(memory.memoryView(100).total, before + 2, '没 goal 不写');
});

test('3.1 排成 rest 的时辰：到点不刷不调模型，直接记完成', async () => {
  const n = llmCalls.length;
  const r = await auto.executeSlot({ key: '午', label: '午时', type: 'rest' });
  assert.equal(r.ok, true);
  assert.equal(r.summary, '按计划歇着');
  assert.equal(llmCalls.length, n, '不调模型');
  assert.match(store.readActions().at(-1).detail, /歇/);
});

test('3.4 回滚开关：morningPlan 关掉就不生成，时辰表照旧', async () => {
  seedSlots();
  store.writeConfig({ morningPlan: false });
  const n = llmCalls.length;
  const plan = await auto.morningPlan();
  assert.equal(llmCalls.length, n, '不调模型');
  assert.ok(plan.every((s) => !s.type), '时辰表还是纯时间表');
  assert.equal(store.readState().plannedOn, null, '没生成就不盖章');
});

test('markExpired：过期格子统一由它标（今天的也在内），标记数驱动重排——ensurePlan 不许抢先静默标（2026-11-13 验收发现：电脑睡着醒来后错过重排没触发，就是被 ensurePlan 提前标掉、missed 永远不亮）', async () => {
  const plan = await import('../plan.mjs');
  const NOW = Date.now();
  const yd = store.localDate(new Date(NOW - 86400_000));
  const st = store.readState();
  st.plans = {
    [yd]: [{ key: '子', label: '子时', start: NOW - 86400_000, end: NOW - 82800_000, at: NOW - 86000_000, status: 'pending' }], // 昨天跨午夜漏跑的
    [today]: [
      { key: '辰', label: '辰时', start: NOW - 3600_000, end: NOW + 3600_000, at: NOW - 60_000, status: 'pending' }, // 还在窗口里：不许动
      { key: '午', label: '午时', start: NOW - 7200_000, end: NOW - 1800_000, at: NOW - 7000_000, status: 'pending' }, // 今天过期的
      { key: '酉', label: '酉时', start: NOW - 7200_000, end: NOW - 1800_000, at: NOW - 7000_000, status: 'done' }, // 跑过的过期不算
    ],
  };
  // ensurePlan（面板/生成入口用）：不许标错过——标记的活儿归 markExpired，tick 拿标记数触发重排
  const untouched = JSON.parse(JSON.stringify(st.plans));
  plan.ensurePlan(st, today);
  assert.equal(st.plans[today].find((s) => s.key === '午').status, 'pending', 'ensurePlan 不再静默标错过');
  assert.deepEqual(st.plans[yd], untouched[yd], "昨天的格子也不动");
  const n = plan.markExpired(st, [yd, today]);
  assert.equal(n, 2, '昨天子时 + 今天午时，两格新标');
  assert.equal(st.plans[today].find((s) => s.key === '午').status, 'missed', '今天过期的标上了');
  assert.equal(st.plans[today].find((s) => s.key === '酉').status, 'done', '跑过的不动');
  assert.equal(st.plans[today].find((s) => s.key === '辰').status, 'pending', '窗口内的不许动');
  assert.equal(plan.markExpired(st, [yd, today]), 0, '重复标记不计数');
});

// ─── 阶段三·B段：内心行为（reflect_self / idle_wander / meta_review） ────────
// 三件都是内部产出：不刷B站不对外说话，产 kind:self 且不带 keys。非 essential：预算用完静默跳过。
// 每个用例开头清空 llmQueue：前面 3.2 重排测试第3次被挡时 push 的项没被消费会残留，不清空会让 B 段 shift 到错的回复

test('B1 reflect_self：产一条 kind:self 想法，不带 keys；成功才计数', async () => {
  llmQueue.length = 0;
  memory.add({ kind: 'watch', imp: 3, text: '看了个星轨拍摄的教程' });
  memory.add({ kind: 'watch', imp: 2, text: '刷到个猫片，挺可爱' });
  memory.add({ kind: 'social', imp: 3, text: '在评论区跟人聊了几句' });
  const before = memory.memoryView(100).total;
  const cnt = store.todayCounts()['reflect_self'] || 0;
  llmQueue.push({ content: JSON.stringify({ thought: '最近看的星轨教程有点意思，但拍出来都一个样' }) });
  const r = await mind.reflectSelf({ key: '午', label: '午时', type: 'reflect_self' });
  assert.equal(r.ok, true);
  const v = memory.memoryView(100);
  assert.equal(v.total, before + 1, '写了一条记忆');
  const e = v.recent[0];
  assert.equal(e.kind, 'self', '产物是 kind:self');
  assert.ok(!e.keys?.length, '不带 keys：是她自己的想法，不是哪个对话的事');
  assert.match(e.text, /星轨/);
  assert.equal(store.todayCounts()['reflect_self'], cnt + 1, '成功才计数（planTypeBlocked 查这个挡每天1格）');
});

test('B1 reflect_self：非法输出（空 thought / 坏 JSON）不写记忆不炸，失败不计数', async () => {
  llmQueue.length = 0;
  const before = memory.memoryView(100).total;
  const cnt = store.todayCounts()['reflect_self'] || 0;
  llmQueue.push({ content: JSON.stringify({ thought: '无' }) }); // str() 把「无」过滤成空
  let r = await mind.reflectSelf({ key: '午', label: '午时', type: 'reflect_self' });
  assert.equal(r.ok, true, '空 thought 不算失败，只是没什么想复盘');
  assert.equal(memory.memoryView(100).total, before, '空 thought 不写记忆');
  llmQueue.push({ content: '今天天气不错呀' }); // 坏 JSON：looseJson 找不到 { 抛错 → catch 返回 ok:false
  r = await mind.reflectSelf({ key: '午', label: '午时', type: 'reflect_self' });
  assert.equal(r.ok, false, '坏 JSON 返回失败');
  assert.equal(memory.memoryView(100).total, before, '坏 JSON 不写记忆');
  assert.equal(store.todayCounts()['reflect_self'], cnt, '失败不计当天名额');
});

test('B2 idle_wander：产一小段 kind:self 遐想，不带 keys；成功才计数', async () => {
  llmQueue.length = 0;
  const before = memory.memoryView(100).total;
  const cnt = store.todayCounts()['idle_wander'] || 0;
  llmQueue.push({ content: JSON.stringify({ wander: '要是鱼能上岸看看就好了，就一眼' }) });
  const r = await mind.idleWander({ key: '酉', label: '酉时', type: 'idle_wander' });
  assert.equal(r.ok, true);
  const v = memory.memoryView(100);
  assert.equal(v.total, before + 1, '写了一条记忆');
  const e = v.recent[0];
  assert.equal(e.kind, 'self', '产物是 kind:self');
  assert.ok(!e.keys?.length, '不带 keys');
  assert.match(e.text, /发呆/);
  assert.equal(store.todayCounts()['idle_wander'], cnt + 1, '成功才计数');
});

test('B2 idle_wander：坏 JSON 不写记忆不炸', async () => {
  llmQueue.length = 0;
  const before = memory.memoryView(100).total;
  llmQueue.push({ content: '胡言乱语' });
  const r = await mind.idleWander({ key: '酉', label: '酉时', type: 'idle_wander' });
  assert.equal(r.ok, false, '坏 JSON 返回失败');
  assert.equal(memory.memoryView(100).total, before, '坏 JSON 不写记忆');
});

test('B1/B2 planTypeBlocked：今天成功跑过 reflect_self/idle_wander，晨间计划再排就变 rest（每天最多1格）', async () => {
  llmQueue.length = 0;
  seedSlots();
  store.writeConfig({ morningPlan: true }); // 恢复：3.4 回滚开关测试把 morningPlan 改成 false 没恢复，这里扶正
  // 垫满：今天已各成功一次（前面测试 + 这里显式垫，双保险）
  store.logAction({ kind: 'reflect_self', source: 'auto', detail: '今天复盘过了' });
  store.logAction({ kind: 'idle_wander', source: 'auto', detail: '今天发呆过了' });
  llmQueue.push({ content: JSON.stringify({ slots: [
    { key: '辰', type: 'reflect_self', goal: '再想想' },  // 今天已用过 → rest
    { key: '午', type: 'idle_wander', goal: '再发呆' },   // 今天已用过 → rest
    { key: '酉', type: 'browse', goal: '随便刷' },
  ] }) });
  const plan = await auto.morningPlan();
  assert.equal(plan[0].type, 'rest', 'reflect_self 今天已用过，换 rest');
  assert.equal(plan[1].type, 'rest', 'idle_wander 今天已用过，换 rest');
  assert.equal(plan[0].goal, undefined, 'rest 不留 goal');
  assert.equal(plan[2].type, 'browse');
});

test('B3 meta_review：产一条 kind:self 无 keys，经 insights 流进次日 morningPlan 输入（零接线闭环）', async () => {
  llmQueue.length = 0;
  const slots = [
    { key: '辰', label: '辰时', type: 'browse', goal: '看星轨', status: 'done', summary: '看了3个' },
    { key: '午', label: '午时', type: 'comment', goal: '评论', status: 'done', summary: '评论了1条' },
    { key: '酉', label: '酉时', type: 'rest', status: 'done', summary: '歇着' },
  ];
  const before = memory.memoryView(100).total;
  llmQueue.push({ content: JSON.stringify({ review: '今天 browse 做得多，明天想少排点浏览多看看消息' }) });
  const r = await mind.metaReview(slots);
  assert.equal(r.ok, true);
  const v = memory.memoryView(100);
  assert.equal(v.total, before + 1, '写了一条记忆');
  const e = v.recent[0];
  assert.equal(e.kind, 'self');
  assert.ok(!e.keys?.length, '不带 keys：是她自己对计划执行的复盘');
  assert.match(e.text, /计划复盘/);
  assert.match(e.text, /browse/);
  // 零接线闭环：进了 insights，次日 morningPlan 的 memoryView(10).insights.slice(0,5) 能读到
  assert.ok(memory.memoryView(10).insights.some((x) => x.text.includes('计划复盘')), '元复盘进了 insights，次日 morningPlan 输入读得到');
});

test('B3 meta_review：没跑过格子不炸；坏 JSON 不写记忆', async () => {
  llmQueue.length = 0;
  let r = await mind.metaReview([]);
  assert.equal(r.ok, true);
  assert.match(r.summary, /没跑格子/);
  const before = memory.memoryView(100).total;
  llmQueue.push({ content: '乱七八糟不是JSON' });
  r = await mind.metaReview([{ key: '辰', label: '辰时', type: 'browse', status: 'done', summary: '跑了' }]);
  assert.equal(r.ok, false, '坏 JSON 返回失败');
  assert.equal(memory.memoryView(100).total, before, '坏 JSON 不写记忆');
});

test('晨间计划静默失败要留痕：模型给的时辰全对不上（changed=0）不再无声——2026-11-16 排查周末两天零晨间计划，这条路径什么日志都不留', async () => {
  seedSlots();
  llmQueue.push({ content: JSON.stringify({ slots: [{ key: '不存在的时辰', type: 'browse', goal: 'x' }] }) });
  const plan = await auto.morningPlan();
  assert.equal(store.readState().plannedOn, today, 'plannedOn 照样盖章（当天不重试，这是设计）');
  assert.ok(plan.every((s) => !s.type), '格子全没排上类型');
  assert.ok(store.readActions().slice(-3).some((a) => /一个格子都没排上|没给出能用的安排/.test(a.detail)),
    '动态里必须有痕迹：跑了但没排上，跟「开关关着」「没跑」要能区分');
  // 模型压根没回话（空串，重试后仍空）也一样要留痕
  seedSlots();
  llmQueue.push({ content: '' }, { content: '' }); // 两份：200 空回话会重试一次，两份都空才认
  await auto.morningPlan();
  assert.ok(store.readActions().slice(-3).some((a) => /没回话/.test(a.detail)), '空回话也有痕迹');
});

test('晨间计划的输出预算要装得下 7 个时辰的 JSON：max_tokens ≥ 1600——800 在时辰加多后必截断（2026-11-16 实测 7 格截在「随缘刷」中间）', async () => {
  seedSlots();
  llmQueue.push({ content: '{}' });
  const before = llmCalls.length;
  await auto.morningPlan();
  const sent = llmCalls.slice(before).at(-1);
  assert.ok(sent, '调了模型');
  assert.ok(sent.max_tokens >= 1600, `max_tokens 要 ≥1600（实际 ${sent.max_tokens}）——一格带 goal 约 75 token，7 格加 flash 前置就超 800`);
});

test('morningPlan 并发重入只跑一次：tick 和按钮撞车时（2026-11-16 一次点击出两条日志的根因），进行中别的触发让路', async () => {
  seedSlots();
  llmQueue.push({ content: JSON.stringify({ slots: [{ key: '午', type: 'check' }] }) });
  const before = llmCalls.length;
  const [a, b] = await Promise.all([auto.morningPlan({ replan: true }), auto.morningPlan()]);
  assert.equal(llmCalls.length - before, 1, `并发两个触发只调一次模型（实际 ${llmCalls.length - before} 次）`);
  assert.equal(a[1]?.type || b[1]?.type, 'check', '成功的那个结果正常返回');
});
