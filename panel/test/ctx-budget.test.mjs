import test from 'node:test';
import assert from 'node:assert/strict';
import './_env.mjs';
import * as owner from '../qq/owner.mjs';

const texts = (arr) => arr.map((e) => String(e.text).slice(0, 3));
function seed(peer, n, len = 10) {
  for (let i = 0; i < n; i++) {
    owner.logChat({ from: i % 2 ? 'her' : 'owner', peer, text: String(i).padStart(3, '0') + 'x'.repeat(len) });
  }
}

test('C3.1 不传预算：退回纯条数上限', () => {
  const peer = 'g:b1';
  seed(peer, 10, 5);
  const r = owner.recentChatDays(5, 4, peer);
  assert.equal(r.length, 4);
  assert.deepEqual(texts(r), ['006', '007', '008', '009'], '取最近 4 条');
});

test('C3.2 字符预算：从最旧截断，保留最近的', () => {
  const peer = 'g:b2';
  seed(peer, 10, 10); // 每条 3 位编号 + 10 个 x = 13 字符
  // 预算 40 → 最近 3 条 = 39 字符，第 4 条 52 超了
  const r = owner.recentChatDays(5, 400, peer, 40);
  assert.equal(r.length, 3);
  assert.deepEqual(texts(r), ['007', '008', '009']);
  const total = r.reduce((n, e) => n + e.text.length, 0);
  assert.ok(total <= 40);
});

test('C3.3 单条就超预算：至少留最后一条', () => {
  const peer = 'g:b3';
  seed(peer, 5, 10);
  const r = owner.recentChatDays(5, 400, peer, 1);
  assert.equal(r.length, 1);
  assert.deepEqual(texts(r), ['004'], 'seed 5 条（000~004），单条超预算留最后一条');
});

test('C3.4 条数上限和字符预算一起生效：先条数后字符', () => {
  const peer = 'g:b4';
  seed(peer, 10, 10);
  // 先取最近 5 条（005~009），再按字符预算 28（每条13）留最近 2 条
  const r = owner.recentChatDays(5, 5, peer, 28);
  assert.deepEqual(texts(r), ['008', '009']);
});

test('C3.5 reset 之后的才算，且预算在 reset 窗口内生效', () => {
  const peer = 'g:b5';
  owner.resetContext(peer);
  owner.logChat({ from: 'owner', peer, text: 'aaa' + 'y'.repeat(20) });
  owner.logChat({ from: 'owner', peer, text: 'bbb' + 'z'.repeat(20) });
  const all = owner.recentChatDays(5, 400, peer);
  assert.deepEqual(texts(all).map((t) => t.slice(0, 1)), ['a', 'b']);
  const r = owner.recentChatDays(5, 400, peer, 25);
  assert.equal(r.length, 1, '23 字符一条，预算 25 只留最近一条');
  assert.ok(texts(r)[0].startsWith('bbb'));
});
