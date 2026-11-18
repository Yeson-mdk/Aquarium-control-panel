import test from 'node:test';
import assert from 'node:assert/strict';
import './_env.mjs';
import * as friends from '../friends.mjs';
import * as fav from '../fav.mjs';
import * as memory from '../memory.mjs';
import * as owner from '../qq/owner.mjs';
import * as purge from '../purge.mjs';

function seed(qq) {
  friends.touch(qq, '小王', 'g:999');
  friends.addNote(qq, '他要被叫小王');
  fav.applyDelta(qq, 2, '被夸了');
  memory.add({ kind: 'chat', imp: 3, text: `「私·${qq}」聊的主要是：周末打球`, keys: ['p:' + qq], src: [] });
  memory.add({ kind: 'chat', imp: 3, text: '「群·999」聊的主要是：今晚吃火锅', keys: ['g:999'], src: [] }); // 别人的群数据，不该删
  owner.logChat({ from: 'owner', text: '周末打球不', peer: 'p:' + qq });
  owner.logChat({ from: 'owner', text: '群里聊吃火锅', peer: 'g:999' });
}

test('C4.1 preview 列清单：四类数据齐全，群数据不算进来', () => {
  const QQ = '10001';
  seed(QQ);
  const pv = purge.previewPerson(QQ);
  assert.equal(pv.allowed, true);
  assert.equal(pv.name, '小王');
  const by = (k) => pv.items.find((x) => x.kind === k).count;
  assert.equal(by('friends'), 1, '一份朋友档案');
  assert.equal(by('fav'), 1, '一条好感');
  assert.equal(by('memory'), 1, '只有 p:QQ 的记忆，g:999 不算');
  assert.equal(by('chat'), 1, '只有私聊原文');
  assert.ok(pv.total >= 4);
});

test('C4.2 purge 实删：清单里的都删干净，群记忆/群原文不动', () => {
  const QQ = '10002';
  seed(QQ);
  const r = purge.purgePerson(QQ);
  assert.equal(r.ok, true, '删完清单归零');
  assert.equal(r.removed.friends.length, 1);
  assert.equal(r.removed.fav, 1);
  assert.equal(r.removed.memory, 1);
  assert.equal(r.removed.chat >= 1, true, '删掉了私聊原文文件');
  assert.equal(r.after, 0, '删完复查没有残留');
  // 别人的群数据还在
  const mem = memory.allEntries();
  assert.ok(mem.some((e) => (e.keys || []).includes('g:999')), '群日结没被误删');
  assert.ok(owner.readChat('g:999').some((e) => e.text.includes('火锅')), '群原文没被误删');
  // 档案也没了
  assert.equal(Object.values(friends.readFriends().friends).some((f) => f.qq === QQ), false);
  assert.equal(fav.readFav().users?.[QQ], undefined);
});

test('C4.3 号主不许删，重复删返回空清单', () => {
  const QQ = '10003';
  assert.equal(purge.previewPerson('owner').allowed, false);
  assert.equal(purge.purgePerson('owner').ok, false);
  const r = purge.purgePerson(QQ); // 从没建过，空清单
  assert.ok(r.removed.friends.length === 0 && r.removed.memory === 0, '第二次没东西可删');
});

test('C4.4 purgePeer 按对话整体清（群），只清记忆+原文不碰档案', () => {
  friends.touch('20000', '群友', 'g:777');
  memory.add({ kind: 'chat', imp: 3, text: '「群·777」聊的主要是：旅行', keys: ['g:777'], src: [] });
  owner.logChat({ from: 'owner', text: '要去旅行', peer: 'g:777' });
  const r = purge.purgePeer('g:777', { log: false });
  assert.equal(r.ok, true);
  assert.ok(r.removed.memory >= 1);
  assert.ok(r.removed.chat >= 1);
  assert.ok(friends.readFriends().friends['20000'], 'friends 档案没被 purgePeer 动');
  assert.equal(purge.purgePeer('bad').ok, false);
});
