import './_env.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DATA } from '../store.mjs';
import { alert, clearAlert } from '../alert.mjs';

const H = 6 * 60 * 60 * 1000;

function freshState() {
  clearAlert('k1'); clearAlert('k2'); clearAlert('sendfail'); clearAlert('log-off'); clearAlert('ttl');
}

test('1. 首次告警真发出，带 ⚠️ 前缀', async () => {
  freshState();
  const sent = [];
  const ok = await alert('k1', '洞察没跑成', { send: async (msg) => sent.push(msg), now: () => 100000 });
  assert.equal(ok, true);
  assert.equal(sent.length, 1);
  assert.match(sent[0], /^⚠️ 洞察没跑成$/);
});

test('2. 去抖：同 key 6 小时内只发一次，不同 key 各发一次', async () => {
  freshState();
  const sent = [];
  const send = async (msg) => sent.push(msg);
  let t = 100000;
  const now = () => t;
  await alert('k2', '消息A', { send, now });
  t += H - 1;
  await alert('k2', '消息A又来', { send, now }); // 窗口内，拦下
  t += 2;
  await alert('k2', '消息A超时后', { send, now }); // 超 6 小时，放行
  await alert('ttl', '另一个key', { send, now }); // 不同 key 独立
  assert.equal(sent.length, 3, '首条 + 超时后一条 + 另一key一条');
  assert.ok(sent[1].includes('消息A超时后'));
  assert.ok(sent[2].includes('另一个key'));
});

test('3. 发送失败不影响主流程：返回 false，不抛', async () => {
  freshState();
  const ok = await alert('sendfail', '发不出去也别炸', {
    now: () => 200000,
    send: async () => { throw new Error('QQ 没连上'); },
  });
  assert.equal(ok, false);
});

test('4. 去抖状态落盘 alert.json（人能读）', async () => {
  freshState();
  await alert('k1', '落盘看看', { send: async () => {}, now: () => 300000 });
  const st = JSON.parse(readFileSync(join(DATA, 'alert.json'), 'utf-8'));
  assert.equal(st.last.k1, 300000);
});

test('5. clearAlert 后能立刻再发', async () => {
  freshState();
  const sent = [];
  const send = async (m) => sent.push(m);
  await alert('k2', '第一次', { send, now: () => 400000 });
  await alert('k2', '被拦', { send, now: () => 400100 });
  clearAlert('k2');
  await alert('k2', '清了再发', { send, now: () => 400200 });
  assert.equal(sent.length, 2);
  assert.ok(sent[1].includes('清了再发'));
});
