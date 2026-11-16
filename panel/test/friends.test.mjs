import './_env.mjs';
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';

// ─── 假的模型接口：按顺序吐预先排好的回复（照 qq.test.mjs 那套）─────
const llmQueue = [];
const server = createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    const msg = llmQueue.shift() || { content: '{"people":[]}' };
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', ...msg } }], usage: { total_tokens: 100 } }));
  });
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
after(() => server.close());

const store = await import('../store.mjs');
store.writeConfig({ llm: { baseUrl: `http://127.0.0.1:${server.address().port}`, model: 'fake' } });
store.writeSecrets({ llmApiKey: 'test' });

const friends = await import('../friends.mjs');
const owner = await import('../qq/owner.mjs');
const memory = await import('../memory.mjs');

test('档案基础：touch 建档、addNote 不重复、n:占位档等本人来了就并过去', () => {
  friends.touch(20002, '小王', 'g:777');
  friends.touch(20003, '阿猫', 'g:777');
  friends.touch(20004, '路人', '');
  const r = friends.addNote(20002, '他要被叫小王');
  assert.ok(r && !r.existed, '记上了');
  assert.equal(friends.addNote(20002, '他要被叫小王').existed, true, '一样的不重复记');
  friends.addNote(20003, '他喜欢猫');
  // 群名录：两个人都在，一人一行
  const roster = friends.rosterText('g:777');
  assert.match(roster, /小王：他要被叫小王/);
  assert.match(roster, /阿猫：他喜欢猫/);
  // 私聊档案：只带本人的
  assert.match(friends.notesText(20002), /他要被叫小王/);
  assert.ok(!friends.notesText(20002).includes('喜欢猫'), '别人的事不串进来');
  assert.equal(friends.notesText(20004), '', '没记过什么就没有档案段');
  // 只在群里见过名字的人（n:占位档），本人私聊来了一次就对上号
  friends.addNote('n:神秘人', '他说他下周生日');
  friends.touch(20005, '神秘人', '');
  assert.match(friends.notesText(20005), /下周生日/);
  // 号主上下文里的朋友圈名录
  assert.match(friends.friendsText(), /小王/);
  assert.match(friends.friendsText(), /神秘人/);
});

test('每晚整理（群）：关于某个人的事实记到那人名下', async () => {
  // 今天的群聊：A 让大家叫 B 为小王
  owner.logChat({ from: 'owner', peer: 'g:777', name: 'A哥', text: '以后都叫B为小王哈' });
  owner.logChat({ from: 'owner', peer: 'g:777', name: '小王', text: '好嘞' });
  owner.logChat({ from: 'her', peer: 'g:777', text: '记住啦' });
  llmQueue.push({ content: JSON.stringify({ people: [{ name: '小王', notes: ['他要被叫小王'] }] }) });
  const out = await friends.digest();
  assert.equal(out.groups, 1);
  assert.equal(out.notes, 0, '跟已有的一条重复，不算新记');
  friends.addNote(20002, '他在准备考研');
  llmQueue.push({ content: JSON.stringify({ people: [{ name: '小王', notes: ['他在准备考研', '他不喜欢别人叫他全名'] }] }) });
  const out2 = await friends.digest();
  assert.ok(out2.notes >= 1, '新的一条记上了');
  assert.match(friends.notesText(20002), /不喜欢别人叫他全名/);
  // 对不上名字的不硬记
  llmQueue.push({ content: JSON.stringify({ people: [{ name: '不认识的人', notes: ['他不存在'] }] }) });
  const out3 = await friends.digest();
  assert.equal(out3.notes, 0);
});

test('每晚整理（私聊）：好友自己的档案 + 她自己的印象', async () => {
  owner.logChat({ from: 'owner', peer: 'p:20003', name: '阿猫', text: '我今天心情不太好' });
  owner.logChat({ from: 'her', peer: 'p:20003', text: '怎么啦，跟我说说' });
  owner.logChat({ from: 'owner', peer: 'p:20003', name: '阿猫', text: '没事，聊聊就好多了' });
  // digest 会把今天的群和私聊各跑一遍（g_777 排在 p_20003 前面），群那边没新东西
  llmQueue.push({ content: JSON.stringify({ people: [] }) });
  llmQueue.push({ content: JSON.stringify({ notes: ['他心情不好时喜欢有人陪着聊'], memory: '他今天心情不太好，聊了一会儿好多了。' }) });
  const out = await friends.digest();
  assert.ok(out.friends >= 1);
  assert.match(friends.notesText(20003), /心情不好时喜欢有人陪着聊/);
  // 朋友的事不进她跟号主那套记忆/印象
  assert.ok(!memory.memoryView(50).recent.some((e) => e.kind === 'social'), '不写进她的记忆');
});

test('朋友圈近况：认对话钥匙（g:/p:）不认字样，tidy 合成的印象也不断流', async () => {
  // 老的 reflect（只看名单条数、天天反券同一句）下线了，近况改从阶段一日结写的总括行取
  assert.equal(friends.reflect, undefined, 'reflect 没了');
  memory.add({ kind: 'chat', imp: 3, keys: ['g:777'], text: '「群·777」聊的主要是：他们在约周末打球' });
  memory.add({ kind: 'chat', imp: 3, keys: ['owner'], text: '跟号主聊天：今天聊了搬家的事' });
  memory.add({ kind: 'chat', imp: 4, keys: ['g:777'], text: '「群·777」小王：他说要开始复习考研了' });
  assert.match(friends.socialText(), /打球/, '近况来自日结总括行');
  assert.ok(!friends.socialText().includes('跟号主聊天'), '号主的日结不进朋友圈近况');
  assert.ok(!friends.socialText().includes('考研'), '只有总括行（聊的主要是）进近况，明细条不进');
  assert.match(friends.friendsText(), /最近：/, '号主那边的朋友圈名录带一句近况');
  assert.ok(friends.friendsView().social, '面板朋友页还有近况行');
  // tidy 三天后会把总括行合并成 gist（模型概括，不带「聊的主要是」字样）：认钥匙的话近况不断流
  memory.add({ kind: 'gist', imp: 3, keys: ['g:778'], text: '群里连着几天在约周末打球' });
  assert.match(friends.socialText(), /约周末打球/, '带对话钥匙的印象（gist）也算近况');
});

test('friendsView：给面板看的名录，带好感和近况', () => {
  const v = friends.friendsView();
  assert.ok(v.count >= 2);
  const w = v.list.find((f) => f.name === '小王');
  assert.ok(w, '小王在名录里');
  assert.ok(Array.isArray(w.notes) && w.notes.some((n) => /小王/.test(n.text)), '档案条目在');
  assert.deepEqual(w.groups, ['777'], '群号剥掉 g: 前缀');
});

test('群聊上下文：带群友名录，不带号主的事', async () => {
  const brain = await import('../qq/brain.mjs');
  const ctx = await brain.contextText('在吗', 20002, 'g:777');
  assert.match(ctx, /这个群里的人你知道的/);
  assert.match(ctx, /小王/);
  assert.ok(!ctx.includes('关于号主'), '群里不能带号主的事');
  // 好友私聊：带他自己的档案
  const ctx2 = await brain.contextText('在吗', 20003, 'p:20003');
  assert.match(ctx2, /这个人你知道的/);
  assert.match(ctx2, /心情不好时喜欢有人陪着聊/);
  assert.ok(!ctx2.includes('关于号主'), '跟别人聊也不带号主的事');
});
