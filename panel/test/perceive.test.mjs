import './_env.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import * as perceive from '../qq/perceive.mjs';
import * as memory from '../memory.mjs';
import { readActions } from '../store.mjs';

// 全量测试同进程跑、模块缓存共享：别的测试文件可能 import 过 autopilot（它在加载时注册了序10真实钩子）。
// 本文件要精确验证钩子触发次数，先解除它，测完再解除，杜绝测试顺序导致的误触发。
memory.setImportantHook(null);

test('序9 judge：非指向、有信息的群背景才写，纯情绪/叫名字/怼/指令/回她/机器人都跳过', () => {
  const J = perceive.judge;
  // 该写的
  assert.equal(J({ text: '小王刚说下周一要交稿，他最近加班挺狠' }).write, true, '有信息量的背景');
  assert.equal(J({ text: '我猫今天生病了，带去医院看了' }).imp, 2, '生活事件 imp2');
  assert.equal(J({ text: '他俩为排班的事拌了几句嘴' }).write, true, '拌嘴背景');
  // 不该写的
  assert.equal(J({ text: '哈哈哈哈笑死' }).write, false, '纯情绪');
  assert.equal(J({ text: '鲸鲸你看这个' }).write, false, '叫名字=指向她');
  assert.equal(J({ text: '蠢鱼又来了' }).write, false, '怼她');
  assert.equal(J({ text: '来一张' }).write, false, '短指令');
  assert.equal(J({ text: '好的', replyToMe: true }).write, false, '回她的话');
  assert.equal(J({ text: '今天天气不错大家早安啊各位', at: true }).write, false, '@她');
  assert.equal(J({ text: '我在我在我在', isBot: true }).write, false, '机器人');
  assert.equal(J({ text: '哦' }).write, false, '太短');
});

test('序9 perceiveGroup：写低 imp 群背景进记忆流，带群钥匙，10 分钟内同文去重', () => {
  const before = memory.memoryView(200).recent.length;
  const args = { peer: 'g:9527', qq: '44001', name: '小周', text: '小周说下周要去出差，周三回来', at: false, isBot: false, replyToMe: false };
  const e1 = perceive.perceiveGroup(args);
  assert.ok(e1, '写了第一条');
  assert.equal(e1.imp, 2, '出差是生活事件，imp2');
  assert.ok(e1.keys.includes('g:9527'), '带群钥匙，scope 隔离');
  assert.match(e1.text, /群·9527.*小周/, '文本带群号和发言人');
  const e2 = perceive.perceiveGroup(args);
  assert.equal(e2, null, '10 分钟内同一句话不重复写');
  perceive.perceiveGroup({ ...args, text: '小周说他周末打算去露营，帐篷都买好了' });
  const after = memory.memoryView(200).recent.length;
  assert.equal(after - before, 2, '不同内容照样写，只去重同文');
});

test('群背景日志带结构化 meta，落在 perceive 类（供「群聊感知」页读，不混进活动记录）', () => {
  const args = { peer: 'g:8888', qq: '45001', name: '小吴', text: '小吴说他家下周搬新房子了，忙得团团转', at: false, isBot: false, replyToMe: false };
  perceive.perceiveGroup(args);
  const hit = readActions().filter((a) => a.kind === 'perceive').at(-1);
  assert.ok(hit, '写了 perceive 类日志');
  assert.equal(hit.meta?.peer, 'g:8888', 'meta 带群号');
  assert.equal(hit.meta?.name, '小吴', 'meta 带发言人');
  assert.equal(hit.meta?.imp, 2, 'meta 带重要度');
  assert.match(hit.meta?.why || '', /生活事件|群背景/, 'meta 带判定理由');
  assert.match(hit.meta?.text || '', /搬新房/, 'meta 带原文');
});

test('序10 isBigEvent：只有真·大事才认，日常事件不算', () => {
  assert.equal(perceive.isBigEvent({ text: '我爸昨天住院了，要做手术' }), true, '住院手术');
  assert.equal(perceive.isBigEvent({ text: '他俩吵架了' }), false, '拌嘴不算大事');
  assert.equal(perceive.isBigEvent({ text: '我下周要去出差' }), false, '出差不算大事');
  assert.equal(perceive.isBigEvent({ text: '我猫生病了' }), false, '宠物生病不算');
  assert.equal(perceive.isBigEvent({ text: '我撑不住了，最近真的崩溃' }), true, '崩溃');
  assert.equal(perceive.isBigEvent({ text: '住院了', isBot: true }), false, '机器人不算');
});

test('序10 perceiveBig：写 imp4 + hook:true 的记忆，30 分钟内同文去重', () => {
  const args = { peer: 'g:9527', qq: '44002', name: '小李', text: '小李说她妈住院了，情况不太好', isBot: false };
  const e1 = perceive.perceiveBig(args);
  assert.ok(e1, '写了大事');
  assert.equal(e1.imp, 4, 'imp4');
  assert.equal(e1.hook, undefined, 'hook 是入参标志，不写进条目本身（entry 不带该字段）');
  const e2 = perceive.perceiveBig(args);
  assert.equal(e2, null, '同文去重');
  const hit = readActions().filter((a) => a.kind === 'big_event').at(-1);
  assert.ok(hit, '大事件写进了活动记录（big_event 类）');
  assert.equal(hit.meta?.peer, 'g:9527', 'meta 带群号');
  assert.match(hit.detail, /大事件/, '日志文本可辨');
});

test('序10 hook:true 才触发钩子：普通 imp4 条目不该触发（防内部产出/测试样本误触发）', async () => {
  const calls = [];
  memory.setImportantHook((e) => { calls.push(e.text); });
  try {
    memory.add({ kind: 'chat', imp: 4, text: '普通的高分记忆甲' });
    assert.equal(calls.length, 0, '不带 hook 的 imp4 不触发');
    memory.add({ kind: 'chat', imp: 2, hook: true, text: '低分带 hook 乙' });
    assert.equal(calls.length, 0, '带 hook 但 imp<4 不触发');
    const e = memory.add({ kind: 'chat', imp: 4, hook: true, text: '大事带 hook 丙' });
    assert.ok(e, '写进去了');
    assert.equal(calls.length, 1, 'imp≥4 且 hook:true 触发一次');
    assert.match(calls[0], /大事带 hook 丙/);
  } finally {
    memory.setImportantHook(null); // 还原，别污染别的测试
  }
});
