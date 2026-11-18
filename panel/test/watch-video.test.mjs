import './_env.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';

const store = await import('../store.mjs');
store.writeConfig({ llm: { baseUrl: 'http://127.0.0.1:1', model: 'fake' }, enabled: true });
store.writeSecrets({ llmApiKey: 'test' });

const auto = await import('../autopilot.mjs');
const brain = await import('../qq/brain.mjs');
const { readTasks } = store;

// ── 假 B站 / 假模型：全部离线 ──────────────────────────────
const fakeBili = {
  browseVideo: async (bvid) => ({
    bvid, cid: 123, title: `标题-${bvid}`, owner: '某UP',
    desc: '一个真拍出来的星空教程', comments: [{ text: '参数写得挺全' }],
  }),
  videoSubtitle: async () => ({ lines: [{ text: '先讲器材' }, { text: '再讲堆栈参数' }] }),
  watchVideo: async () => { fakeBili.watched.push(1); },
  watched: [],
};
let chats = [];
const fakeChat = async (msgs) => {
  chats.push(msgs);
  return '这视频把星轨堆栈的参数讲全了，我先记下来。';
};

test('watchAndSummarize：锁定指定 bvid、真看一遍、拉字幕 summarise，产出一条总结', async () => {
  fakeBili.watched = []; chats = [];
  const r = await auto.watchAndSummarize({ bvid: 'BV1Kx411c7mQ', request: '总结下讲了啥', deps: { bili: fakeBili, chat: fakeChat, watchVideo: fakeBili.watchVideo } });
  assert.equal(r.ok, true);
  assert.equal(r.bvid, 'BV1Kx411c7mQ');
  assert.match(r.summary, /堆栈/);
  assert.equal(fakeBili.watched.length, 1, '真看了一遍（心跳）');
  assert.ok(chats.length >= 1, '调了模型写总结');
  const all = JSON.stringify(chats);
  assert.match(all, /堆栈参数/, '字幕进了素材');
  assert.match(all, /参数写得挺全/, '热评进了素材');
  assert.match(all, /总结下讲了啥/, '号主要求进了素材');
});

test('watchAndSummarize：坏 bvid 直接拒绝，不碰 B站', async () => {
  const r = await auto.watchAndSummarize({ bvid: '瞎写的', deps: { bili: fakeBili, chat: fakeChat } });
  assert.equal(r.ok, false);
  assert.match(r.summary, /没认出来/);
});

test('watchAndSummarize：拉字幕失败也照常总结（简介兜底），不中断', async () => {
  const broken = { ...fakeBili, videoSubtitle: async () => { throw new Error('无字幕'); } };
  const r = await auto.watchAndSummarize({ bvid: 'BV1Kx411c7mQ', deps: { bili: broken, chat: fakeChat, watchVideo: broken.watchVideo } });
  assert.equal(r.ok, true);
  assert.match(r.summary, /堆栈/);
});

test('watch_video 工具：号主能建、别人被挡；短链/裸 BV 都能锁定', async () => {
  for (const t of readTasks()) store.updateTask(t.id, { status: 'cancelled' }); // 清场，避免去重挡住
  const out = { isOwner: true, peerKey: 'owner' };
  const r = await brain.runTool('watch_video', { url: 'BV1Aa4y1b7cD', request: '总结下这个视频' }, out);
  assert.match(r, /锁定这条/);
  const t = readTasks().filter((x) => x.type === 'watch_video').at(-1);
  assert.equal(t.payload.bvid, 'BV1Aa4y1b7cD');
  assert.equal(t.report, 'qq', '做完汇报一次');
  assert.equal(await brain.runTool('watch_video', { url: 'BV1Aa4y1b7cD', request: 'x' }, { isOwner: false, peerKey: 'g:8888' }), '这个只有号主能用');
});

test('watch_video 工具：同一会话看待执行中的同 bvid 不重复建（号主催也不连环报）', async () => {
  for (const t of readTasks()) store.updateTask(t.id, { status: 'cancelled' });
  const out = { isOwner: true, peerKey: 'owner' };
  // 直接铺一条待执行的，避开 runTask 异步执行把状态改成 failed（新规则 failed 有意放行重建）
  store.addTask({
    type: 'watch_video', note: '总结下', payload: { bvid: 'BV1Dedu11c7m', request: '总结下' },
    executor: 'panel', source: 'bot', report: 'qq', status: 'pending', peer: 'owner', reportPeers: ['owner'],
  });
  const second = await brain.runTool('watch_video', { url: 'BV1Dedu11c7m', request: '再说一遍' }, out);
  assert.match(second, /正在看着|不用再交代/);
  const n = readTasks().filter((x) => x.type === 'watch_video' && x.payload?.bvid === 'BV1Dedu11c7m' && x.status !== 'cancelled').length;
  assert.equal(n, 1, '只建了一条');
});

test('bili_task 带链接：也锁指定视频走专用通道，不再排日常排班的队', async () => {
  for (const t of readTasks()) store.updateTask(t.id, { status: 'cancelled' });
  const bv = 'BV1Bili141c7';
  const r = await brain.runTool('bili_task', { request: `【养了两个月的鲸鲸，死了】 https://www.bilibili.com/video/${bv}`, type: 'custom' }, { isOwner: true, peerKey: 'owner' });
  const t = readTasks().find((x) => x.type === 'watch_video' && x.payload?.bvid === bv && x.status !== 'cancelled');
  assert.ok(t, 'bili_task 带链接建的是 watch_video 专用任务，不是 custom 派活');
  assert.match(r, /锁定这条/);
});

test('watch_video 任务不等 live.running 那把锁：日常正在看视频也能立刻看这条', async () => {
  for (const t of readTasks()) store.updateTask(t.id, { status: 'cancelled' });
  let called = false;
  const task = store.addTask({
    type: 'watch_video', note: '总结下', payload: { bvid: 'BV1xx411c7mD', request: '总结下' },
    executor: 'panel', source: 'bot', report: 'qq',
  });
  // 模拟日常排班占着锁（isRunning 一直 true）；如果 runTask 去等锁，这个测试会挂住
  const started = Date.now();
  await auto.runTask(task, {
    isRunning: () => true,
    watchAndSummarize: async () => { called = true; return { ok: true, summary: '看完了，讲的星轨', watched: [{ title: '星轨' }] }; },
  });
  assert.equal(called, true, '即使 live.running=true 也调用了观看');
  assert.ok(Date.now() - started < 2000, '没有卡在 while(live.running) 等待');
  assert.equal(readTasks().find((t) => t.id === task.id).status, 'done');
});

// ── 三期裁决：群里派的发群里 / 去重按会话 / 失败静默 + 催促 ────
test('落库记来源会话：watch_video 带 peer/reportPeers，群里派单记 g:群号', async () => {
  for (const t of readTasks()) store.updateTask(t.id, { status: 'cancelled' });
  const out = { isOwner: true, peerKey: 'g:9003', name: '号主' };
  await brain.runTool('watch_video', { url: 'BV1Peer01c7m', request: '群里总结下' }, out);
  const t = readTasks().find((x) => x.type === 'watch_video' && x.payload?.bvid === 'BV1Peer01c7m' && x.status !== 'cancelled');
  assert.ok(t, '群里派单建了任务');
  assert.equal(t.peer, 'g:9003', '记录来源会话');
  assert.deepEqual(t.reportPeers, ['g:9003'], '汇报目标是来源群');
});

test('去重按会话隔离：私聊待看的不挡群里派；同一会话重复派才拦', async () => {
  for (const t of readTasks()) store.updateTask(t.id, { status: 'cancelled' });
  const bv = 'BV1Sepa01c7m';
  const ownerOut = { isOwner: true, peerKey: 'owner', name: '号主' };
  const groupOut = { isOwner: true, peerKey: 'g:9003', name: '号主' };
  // 铺一条私聊待看的任务（pending，避免异步 runTask 变 failed 后放行）
  store.addTask({
    type: 'watch_video', note: '总结下', payload: { bvid: bv, request: '总结下' },
    executor: 'panel', source: 'bot', report: 'qq', status: 'pending', peer: 'owner', reportPeers: ['owner'],
  });
  // 群里派同一条：待看的那条在别的会话，不该拦 → 新建群任务
  const r2 = await brain.runTool('watch_video', { url: bv, request: '群里也要' }, groupOut);
  assert.match(r2, /锁定这条|交给我/, '不同会话不被去重拦住');
  // 同一会话（私聊）再派：拦
  const r3 = await brain.runTool('watch_video', { url: bv, request: '再说一遍' }, ownerOut);
  assert.match(r3, /正在看着|不用再交代/);
  const n = readTasks().filter((x) => x.type === 'watch_video' && x.payload?.bvid === bv && x.status !== 'cancelled').length;
  assert.equal(n, 2, '私聊一条 + 群里一条，各建各的');
});

test('失败放行重看：failed 的旧任务不挡新会话重建', async () => {
  for (const t of readTasks()) store.updateTask(t.id, { status: 'cancelled' });
  const bv = 'BV1Fail01c7m';
  const ownerOut = { isOwner: true, peerKey: 'owner', name: '号主' };
  await brain.runTool('watch_video', { url: bv, request: '看这个' }, ownerOut);
  const first = readTasks().find((x) => x.type === 'watch_video' && x.payload?.bvid === bv && x.status !== 'cancelled');
  store.updateTask(first.id, { status: 'failed', resultNote: '接口没回', failedAt: new Date().toISOString() });
  const r = await brain.runTool('watch_video', { url: bv, request: '再看一遍' }, ownerOut);
  assert.match(r, /锁定这条|交给我/, '失败的任务放行重建');
});

test('多会话 fan-out：reportResultToPeers 分别发 owner 和群，一个失败不连累另一个', async () => {
  const notify = await import('../notify.mjs');
  const called = [];
  // 小号 sendText 打桩：通过 qq 模块无法直接替换，用 reportResultToPeers 的 peers 参数验证分段结果结构
  const task = { id: 'fanout-test', note: '总结下', reportPeers: ['owner', 'g:9003'] };
  // 模型没 ready + 小号没开 → 两段都会失败，但都各自返回，不抛
  const res = await notify.reportResultToPeers(task, { ok: true, note: '总结', watched: [] }, ['owner', 'g:9003']);
  assert.ok(res.owner && res['g:9003'], '两个会话各自有结果');
  assert.notEqual(res.owner.sent, undefined, 'owner 段返回了 sent 字段');
  assert.notEqual(res['g:9003'].sent, undefined, '群段返回了 sent 字段');
});

test('失败静默 + 超时扫描：runTask 失败不立即报、标 failedAt；15 分钟后被扫出', async () => {
  const notify = await import('../notify.mjs');
  for (const t of readTasks()) store.updateTask(t.id, { status: 'cancelled' });
  const task = store.addTask({
    type: 'watch_video', note: '看这个', payload: { bvid: 'BV1Sil011c7m', request: '看' },
    executor: 'panel', source: 'bot', report: 'qq', peer: 'owner', reportPeers: ['owner'],
  });
  // 用 deps 注入失败
  await auto.runTask(task, { isRunning: () => false, watchAndSummarize: async () => ({ ok: false, summary: 'B站接口没回' }) });
  const after = readTasks().find((t) => t.id === task.id);
  assert.equal(after.status, 'failed');
  assert.ok(after.failedAt, '标了失败时刻');
  assert.equal(after.progressReported, false, '默认未汇报');
  // 10 分钟：不扫出
  assert.equal(notify.scanStalledWatches(Date.parse(after.failedAt) + 10 * 60_000, [after]).length, 0);
  // 16 分钟：扫出
  assert.equal(notify.scanStalledWatches(Date.parse(after.failedAt) + 16 * 60_000, [after]).length, 1);
});

test('定时 watch 失败也进超时扫描，成功走 reportPeers 汇报', async () => {
  const notify = await import('../notify.mjs');
  const t = { type: 'job', kind: 'watch', status: 'failed', failedAt: new Date(Date.now() - 20 * 60_000).toISOString(), progressReported: false };
  assert.equal(notify.scanStalledWatches(Date.now(), [t]).length, 1, '定时 watch 失败也被扫出');
});

test('催促注入：contextText 把本会话失败的视频带进上下文', async () => {
  for (const t of readTasks()) store.updateTask(t.id, { status: 'cancelled' });
  store.addTask({
    type: 'watch_video', note: '看鲸鱼视频', payload: { bvid: 'BV1Whale11c7m', request: '看' },
    status: 'failed', failedAt: new Date().toISOString(), resultNote: 'B站没回', progressReported: false,
    peer: 'owner', reportPeers: ['owner'],
  });
  const ctx = await brain.contextText('看了吗', String(store.readConfig().qq.ownerQQ || ''), 'owner');
  assert.match(ctx, /没看成|B站没回/, '失败视频进了上下文供模型回应催促');
});

test('群名注入：contextText 给号主带群名表，群友看不到', async () => {
  const groups = await import('../group-names.mjs');
  groups.noteGroup('g:1124893144', {}); groups.setGroupName('g:1124893144', '鲸鲸群');
  const owner = String(store.readConfig().qq.ownerQQ || '');
  const ctxOwner = await brain.contextText('把总结发到鲸鲸群', owner, 'owner');
  assert.match(ctxOwner, /g:1124893144 = 鲸鲸群/, '号主能看到群名对照');
  const ctxGuest = await brain.contextText('你好', '999999', 'g:1124893144');
  assert.doesNotMatch(ctxGuest, /g:1124893144 = 鲸鲸群/, '群友看不到号主的群名表');
});

test('send_report：号主专属、解析群名/群号目标，没有总结时给提示不瞎发', async () => {
  for (const t of readTasks()) store.updateTask(t.id, { status: 'cancelled' });
  const out = { isOwner: true, peerKey: 'owner' };
  // 没有已完成的总结 → 明确提示，不报错、不乱发
  const none = await brain.runTool('send_report', { target: '鲸鲸群' }, out);
  assert.match(none, /没有刚写完|说清楚/, '没总结时不瞎发');
  // 别人不能用
  const denied = await brain.runTool('send_report', { target: '鲸鲸群' }, { isOwner: false, peerKey: 'g:1124893144' });
  assert.match(denied, /只有号主/, '非号主被门禁挡住');
});
