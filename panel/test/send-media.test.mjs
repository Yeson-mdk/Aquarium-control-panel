import './_env.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';

const store = await import('../store.mjs');
store.writeConfig({ llm: { baseUrl: 'http://127.0.0.1:1', model: 'fake' }, enabled: true });
store.writeSecrets({ llmApiKey: 'test' });

const brain = await import('../qq/brain.mjs');
const auto = await import('../autopilot.mjs');
const groups = await import('../group-names.mjs');
const llm = await import('../llm.mjs');
const { readTasks } = store;

const clearTasks = () => { for (const t of readTasks()) store.updateTask(t.id, { status: 'cancelled' }); };

test('send_sticker 带 target：号主跨会话建 send_media 任务，记目标 peer、面板可见、汇报回发起人', async () => {
  clearTasks();
  groups.noteGroup('g:81234', {}); groups.setGroupName('g:81234', '测试群');
  const out = { isOwner: true, peerKey: 'owner', name: '号主' };
  const r = await brain.runTool('send_sticker', { name: 'happy_开心', target: '测试群' }, out);
  assert.match(r, /发到|记下了/, '返回交办话术');
  const task = readTasks().find((t) => t.type === 'send_media' && t.status !== 'cancelled');
  assert.ok(task, '建了 send_media 任务');
  assert.equal(task.payload.targetPeer, 'g:81234', '目标是解析出的群号');
  assert.equal(task.payload.stickerName, 'happy_开心', '记了表情包');
  assert.deepEqual(task.reportPeers, ['owner'], '汇报回发起人（号主私聊）');
  assert.equal(task.report, 'qq', '做完会在 QQ 汇报');
});

test('send_selfie 带 target：号主可跨会话；群友带 target 一律就地糊弄、不发私聊（人设硬闸）', async () => {
  clearTasks();
  // 造一个带 send_selfie 备注的糊弄图池
  const fs = await import('node:fs');
  const path = await import('node:path');
  const notesPath = path.join(store.ROOT, 'stickers', 'notes.json');
  const old = fs.readFileSync(notesPath, 'utf-8');
  try {
    const nt = JSON.parse(old);
    nt['happy_开心'] = '被要自拍才发，走 send_selfie 随机，别自己挑';
    fs.writeFileSync(notesPath, JSON.stringify(nt, null, 2));

    // 号主私聊：填 target → 建任务
    const ownerOut = { isOwner: true, peerKey: 'owner' };
    await brain.runTool('send_selfie', { target: '测试群' }, ownerOut);
    const mediaTask = readTasks().find((t) => t.type === 'send_media' && t.status !== 'cancelled');
    assert.ok(mediaTask, '号主能建自拍跨会话任务');

    // 群友：即使填了 target=私聊，也落回就地糊弄（out.sticker 被设，没有新任务）
    clearTasks();
    const guestOut = { isOwner: false, peerKey: 'g:81234', speakerQq: '55555' };
    await brain.runTool('send_selfie', { target: '私聊' }, guestOut);
    assert.equal(guestOut.sticker, 'happy_开心', '群友自拍就地糊弄一张');
    assert.equal(readTasks().filter((t) => t.type === 'send_media' && t.status !== 'cancelled').length, 0, '群友自拍没建跨会话任务');
  } finally {
    fs.writeFileSync(notesPath, old);
  }
});

test('sing_song 群友说「私聊发给我」：解析到发言者本人 p:QQ，建 send_media 任务', async () => {
  clearTasks();
  // 假曲库：YANGYU_MUSIC 指向临时目录，放一个假的晴天.mp3
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'yy-music-'));
  fs.writeFileSync(path.join(dir, '晴天.mp3'), 'fake');
  const oldMusic = process.env.YANGYU_MUSIC;
  process.env.YANGYU_MUSIC = dir;
  try {
    const out = { isOwner: false, peerKey: 'g:81234', speakerQq: '55555', name: 'Yeson' };
    const r = await brain.runTool('sing_song', { song_name: '晴天', target: '私聊' }, out);
    assert.match(r, /记下了|发到/, '返回交办话术');
    const task = readTasks().find((t) => t.type === 'send_media' && t.status !== 'cancelled');
    assert.ok(task, '建了 send_media 任务');
    assert.equal(task.payload.targetPeer, 'p:55555', '发到发言者本人的私聊');
    assert.equal(task.payload.kind, 'song');
    assert.equal(task.payload.songName, '晴天');
  } finally {
    if (oldMusic === undefined) delete process.env.YANGYU_MUSIC; else process.env.YANGYU_MUSIC = oldMusic;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('send_text 群友说「私聊发给我」：目标解析成他本人 p:QQ，群友工具门禁放行', async () => {
  clearTasks();
  const out = { isOwner: false, peerKey: 'g:81234', speakerQq: '55555', name: '小零同学' };
  const r = await brain.runTool('send_text', { text: '你要的那句话', target: '私聊' }, out);
  assert.match(r, /记下了|发到/, '群友也能交办私聊发话，没被门禁挡');
  const task = readTasks().find((t) => t.type === 'send_media' && t.status !== 'cancelled');
  assert.ok(task, '建了 send_media 任务');
  assert.equal(task.payload.targetPeer, 'p:55555', '发到群友本人的私聊，不是号主也不是群里');
  assert.equal(task.payload.kind, 'text');
  assert.notEqual(task.status, 'pending', '建完立刻执行');
});

test('runTask 执行 send_media：不等日常排班的锁，发到目标，发完汇报', async () => {
  clearTasks();
  const task = store.addTask({
    type: 'send_media', executor: 'panel', source: 'bot', report: 'qq',
    note: '把表情包发到 g:81234', peer: 'owner', reportPeers: ['owner'],
    payload: { kind: 'sticker', stickerName: 'happy_开心', targetPeer: 'g:81234' },
  });
  let called = null;
  // isRunning 恒 true：如果 send_media 去等锁，测试会挂住；用注入的 sendMediaTo 观测目标
  await auto.runTask(task, {
    isRunning: () => true,
    sendMediaTo: async (peer, p) => { called = { peer, p }; return { ok: true }; },
  });
  assert.ok(called, '调用了 sendMediaTo');
  assert.equal(called.peer, 'g:81234', '发到目标会话');
  assert.equal(called.p.stickerName, 'happy_开心');
  assert.equal(readTasks().find((t) => t.id === task.id).status, 'done', '任务完成');
});

test('send_text：号主在群里说「私聊发给我」→ 发到 owner；记目标、建 send_media 任务', async () => {
  clearTasks();
  // 号主此刻在群里（peerKey=g:xxx），说私聊发给我 → 目标是 owner，不是就地发群
  const out = { isOwner: true, peerKey: 'g:81234', speakerQq: '88888', name: '号主' };
  const r = await brain.runTool('send_text', { text: '到家跟我说一声', target: '私聊' }, out);
  assert.match(r, /发到|记下了/, '返回交办话术');
  const task = readTasks().find((t) => t.type === 'send_media' && t.status !== 'cancelled');
  assert.ok(task, '建了 send_media 任务');
  assert.equal(task.payload.targetPeer, 'owner', '目标是号主私聊窗口');
  assert.equal(task.payload.kind, 'text', '类型是话');
  assert.equal(task.payload.text, '到家跟我说一声', '记了要发的话');
  assert.deepEqual(task.reportPeers, ['g:81234'], '汇报回发起人所在的群');
});

test('send_text：群友「私聊发给我」→ 只发回他本人 p:QQ，不许发到别的群', async () => {
  clearTasks();
  const guest = { isOwner: false, peerKey: 'g:81234', speakerQq: '55555' };
  await brain.runTool('send_text', { text: '哈喽', target: '私聊' }, guest);
  const task = readTasks().find((t) => t.type === 'send_media' && t.status !== 'cancelled');
  assert.ok(task, '建了任务');
  assert.equal(task.payload.targetPeer, 'p:55555', '发回群友本人');
  // 群友想把话发到别的群 → 被拦（返回 null → runTool 给提示，不建任务）
  const r = await brain.runTool('send_text', { text: '哈喽', target: 'g:99999' }, guest);
  assert.match(r, /只能发到私聊|问清楚/, '群友跨群被挡');
  assert.ok(!readTasks().some((t) => t.type === 'send_media' && t.payload?.targetPeer === 'g:99999'), '没建越权任务');
});

test('send_text：号主在群里只说「私聊发给我」没给内容 → 提示先问发啥，不建空任务', async () => {
  clearTasks();
  const out = { isOwner: true, peerKey: 'g:81234', speakerQq: '88888', name: '号主' };
  const r = await brain.runTool('send_text', {}, out);
  assert.match(r, /发啥|问一句/, '提示先问清楚');
  assert.ok(!readTasks().some((t) => t.type === 'send_media' && t.status !== 'cancelled'), '没建空任务');
});

test('runTask send_media：kind=text 不等日常锁、调 sendMediaTo 发话到目标', async () => {
  clearTasks();
  const task = store.addTask({
    type: 'send_media', executor: 'panel', source: 'bot', report: 'qq',
    note: '把话发到 owner', reportPeers: ['g:81234'],
    payload: { kind: 'text', text: '到家说一声', targetPeer: 'owner' },
  });
  let called = null;
  await auto.runTask(task, {
    isRunning: () => true,
    sendMediaTo: async (peer, p) => { called = { peer, p }; return { ok: true }; },
  });
  assert.ok(called, '调用了 sendMediaTo');
  assert.equal(called.peer, 'owner', '发到目标会话');
  assert.equal(called.p.kind, 'text');
  assert.equal(called.p.text, '到家说一声');
  assert.equal(readTasks().find((t) => t.id === task.id).status, 'done', '任务完成');
});

test('号主在群里：contextText 悄悄标注身份并讲清「私聊发给我=发私聊」，群友看不到', async () => {
  const ownerQq = String(store.readConfig().qq.ownerQQ || '');
  const ctxOwner = await brain.contextText('私聊发个自拍给我吧', ownerQq, 'g:81234');
  assert.match(ctxOwner, /号主本人/, '号主在群里被认出');
  assert.match(ctxOwner, /私聊.*窗口|发到.*私聊/, '讲清私聊发给我=发到私聊窗口');
  const ctxGuest = await brain.contextText('私聊发给我', '55555', 'g:81234');
  assert.doesNotMatch(ctxGuest, /现在在群里说话的这个是号主/, '群友看不到这条标注');
});

test('跨会话发媒体：建完任务立刻触发执行，不再停在 pending（发歌卡住那次的 bug）', async () => {
  clearTasks();
  groups.noteGroup('g:81234', {}); groups.setGroupName('g:81234', '测试群');
  const out = { isOwner: true, peerKey: 'owner', name: '号主' };
  await brain.runTool('send_sticker', { name: 'happy_开心', target: '测试群' }, out);
  const task = readTasks().find((t) => t.type === 'send_media' && t.status !== 'cancelled');
  assert.ok(task, '建了任务');
  // runTask 一进来就标 in_progress（同步那段），所以 runTool 返回时不能还停在 pending
  assert.notEqual(task.status, 'pending', '任务被立刻认领执行，不是停在 pending 没人管');
});

test('号主在群里说「私聊发给我」：发话任务目标是 owner 私聊，不是就地发群里、也不是停在 pending', async () => {
  clearTasks();
  groups.noteGroup('g:81234', {}); groups.setGroupName('g:81234', '测试群');
  const ownerQq = String(store.readConfig().qq?.ownerQQ || '123456');
  const out = { isOwner: true, peerKey: 'g:81234', name: '号主', speakerQq: ownerQq };
  await brain.runTool('send_text', { text: '试试看，收到没', target: '私聊' }, out);
  const task = readTasks().find((t) => t.type === 'send_media' && t.status !== 'cancelled');
  assert.ok(task, '建了 send_media 任务');
  assert.equal(task.payload.kind, 'text', '记了要发的话');
  assert.equal(task.payload.targetPeer, 'owner', '目标是你俩的私聊窗口');
  assert.notEqual(task.status, 'pending', '建完立刻认领执行，不等面板轮询');
});

test('跨会话发送僵尸任务：pending 超 2 分钟 / in_progress 超 15 分钟才补送，正在发的别打断', () => {
  clearTasks();
  const now = Date.now();
  const mk = (status, ageMs, extra = {}) => store.addTask({
    type: 'send_media', executor: 'panel', source: 'bot', report: 'qq', status,
    note: '把话发到 owner', sourcePeer: 'g:81234', reportPeers: ['g:81234'],
    payload: { kind: 'text', text: 'hi', targetPeer: 'owner' },
    ts: new Date(now - ageMs).toISOString(), ...extra,
  });
  const oldPending = mk('pending', 3 * 60_000);
  const freshPending = mk('pending', 20_000);
  const stuck = mk('in_progress', 20 * 60_000, { claimedAt: new Date(now - 20 * 60_000).toISOString() });
  const running = mk('in_progress', 30_000, { claimedAt: new Date(now - 30_000).toISOString() });
  const found = auto.scanOrphanMedia(now, readTasks()).map((t) => t.id);
  assert.equal(found.length, 2, '只认领两条僵尸');
  assert.ok(found.includes(oldPending.id) && found.includes(stuck.id), '扫的是老 pending + 卡死的 in_progress');

  const called = [];
  const opts = { ready: () => true, run: async (t) => { called.push(t.id); } };
  auto.retryOrphanMedia(now, readTasks(), { ...opts, ready: () => false });
  assert.equal(called.length, 0, 'QQ 小号没连上先等着，不把任务判死');
  auto.retryOrphanMedia(now, readTasks(), opts);
  assert.equal(called.length, 2, '连上后补送两条');
  assert.ok(called.includes(oldPending.id) && called.includes(stuck.id));
  assert.ok(!called.includes(freshPending.id) && !called.includes(running.id), '刚建的/正在发的不重复送');
});

test('任务汇报只留一句：模型倒出好几句/分点时砍到第一句，超长交给兜底', () => {
  assert.equal(llm.oneSentence('发好啦～你听听看。顺便说一句，我还想了下要不要给你唱别的。'), '发好啦～你听听看。');
  assert.equal(llm.oneSentence('没做成：B站接口没回。下次再试吧，我先记着。'), '没做成：B站接口没回。');
  assert.equal(llm.oneSentence('第一句；第二句。'), '第一句');
  assert.equal(llm.oneSentence('第一行\n第二行'), '第一行');
  assert.equal(llm.oneSentence('「搞定了呀」'), '搞定了呀');
  assert.equal(llm.oneSentence('这件事我真的想了很久然后说了好多好多话结果一句都说不完你看怎么办呀', 20), '', '超长不截半句');
});

test('私聊叫发到群里：任务记下「谁让我发的」，群里不冒无名消息', async () => {
  clearTasks();
  groups.noteGroup('g:81234', {}); groups.setGroupName('g:81234', '测试群');
  const out = { isOwner: true, peerKey: 'owner', name: 'Yeson' };
  await brain.runTool('send_text', { text: '大家晚上好', target: '测试群' }, out);
  const task = readTasks().find((t) => t.type === 'send_media' && t.status !== 'cancelled');
  assert.ok(task, '建了 send_media 任务');
  assert.equal(task.payload.targetPeer, 'g:81234');
  assert.equal(task.payload.attribution, 'Yeson让我发的', '群里知道是私聊里的谁叫发的');
});

test('跨群发送只回一句：成功不再回报，失败仍报（2026-11-18）', async () => {
  clearTasks();
  const mk = () => store.addTask({
    type: 'send_media', executor: 'panel', source: 'bot', report: 'qq',
    note: '把话发到 g:81234', reportPeers: ['owner'],
    payload: { kind: 'text', text: '到家说一声', targetPeer: 'g:81234' },
  });
  const reports = [];
  const opts = (sendMediaTo) => ({
    isRunning: () => true,
    sendMediaTo,
    reportTask: async (t, r) => { reports.push(r); },
  });
  // 成功：发起会话已经有「这就去发」那句，别再回报一句
  await auto.runTask(mk(), opts(async () => ({ ok: true })));
  assert.equal(reports.length, 0, '发成功不再回报一句');
  assert.equal(readTasks().find((t) => t.type === 'send_media' && t.status === 'done')?.resultNote,
    '已把话发到 g:81234', '成功 note 照旧');
  // 失败：必须报，不然号主以为发成了
  await auto.runTask(mk(), opts(async () => ({ ok: false })));
  assert.equal(reports.length, 1, '没发成仍要报一声');
  assert.equal(reports[0].ok, false, '报的是失败');
  assert.match(reports[0].note, /没把话发到/, '失败 note 说没发成，不说已发到');
});

test('点歌顺序：歌真正发出去之后才说「唱啦」，歌发失败就不说（2026-11-18）', async () => {
  const qq = await import('../qq/index.mjs');
  const calls = [];
  const say = async (ok) => { calls.push('say:' + ok); };
  const deps = { peer: 'g:81234', songB64: () => 'ZmFrZQ==', sendSeg: async () => { calls.push('song'); } };
  await qq.singThenSay({ song: '晴天', file: '晴天_鱼版.mp3' }, say, deps);
  assert.deepEqual(calls, ['song', 'say:true'], '先发歌、再说那句；且是唱完的语气');

  // 歌发不出去（NapCat 转码失败）：不说「唱啦」，免得配着一首根本没出现的歌
  calls.length = 0;
  await qq.singThenSay({ song: '晴天', file: '晴天_鱼版.mp3' }, say,
    { ...deps, sendSeg: async () => { calls.push('song-fail'); throw new Error('转码失败'); } });
  assert.deepEqual(calls, ['song-fail', 'say:false'], '歌没发成，say 收到 ok=false');
});

test('跨会话发媒体：号主催一句不重复建同样的发送任务', async () => {
  clearTasks();
  groups.noteGroup('g:81234', {}); groups.setGroupName('g:81234', '测试群');
  // 铺一条刚建的 pending 任务（模拟上一条还在送）
  store.addTask({
    type: 'send_media', executor: 'panel', source: 'bot', report: 'qq', status: 'pending',
    note: '把表情包发到 g:81234', sourcePeer: 'owner', reportPeers: ['owner'],
    payload: { kind: 'sticker', stickerName: 'happy_开心', targetPeer: 'g:81234' },
  });
  const out = { isOwner: true, peerKey: 'owner', name: '号主' };
  const r = await brain.runTool('send_sticker', { name: 'happy_开心', target: '测试群' }, out);
  assert.match(r, /已经在往|别重复/, '催一句被拦，不重复派');
  const active = readTasks().filter((t) => t.type === 'send_media' && t.status === 'pending' && t.payload?.targetPeer === 'g:81234');
  assert.equal(active.length, 1, '还是原来那一条，没多建');
});
