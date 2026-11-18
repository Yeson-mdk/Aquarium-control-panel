import test from 'node:test';
import assert from 'node:assert/strict';
import './_env.mjs';
import { writeConfig, writeSecrets, logAction, readState, writeState, nowIso } from '../store.mjs';
import * as mind from '../mind.mjs';
import * as owner from '../qq/owner.mjs';

writeSecrets({ llmApiKey: 'sk-test' }); // 让 llmReady() 为真，mindOn() 才过
writeConfig({ mind: { enabled: true, reflectHour: 0 } });

test('C5.1 reflect 失败：不写 reflectedOn、发告警，下一班可重试', async () => {
  const alerts = [];
  const alertFn = async (k, t) => { alerts.push({ k, t }); };
  await mind.maybeReflect({ reflectFn: async () => false, alertFn });
  assert.ok(!mind.readMind().reflectedOn, '没跑成不落标记');
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].k, 'mind:reflect');
  // 再来一次仍会进（标记没写），这次成功 → 落标记
  await mind.maybeReflect({ reflectFn: async () => true, alertFn });
  const today = new Date().toISOString().slice(0, 10);
  assert.equal(String(mind.readMind().reflectedOn).slice(0, 10), today);
  // 第三次：已落标记，直接跳过（reflectFn 不该再被调）
  let calls = 0;
  await mind.maybeReflect({ reflectFn: async () => { calls++; return true; }, alertFn });
  assert.equal(calls, 0, '当天跑过就不重复');
});

test('C5.2 日结跑成才写时间戳；失败不写、告警、下一班重捡', async () => {
  const peer = 'g:retry';
  // 造够 6 条聊天让 digest 有得跑
  for (let i = 0; i < 8; i++) owner.logChat({ from: 'owner', peer, text: `今天第${i}句话聊点正经的` });
  const alerts = [];
  const alertFn = async (k, t) => { alerts.push({ k, t }); };

  // 第一次：digest 抛错 → 不写时间戳、告警
  const r1 = await owner.groupDigestRound({
    now: Date.now(), candidates: [{ peer }],
    digest: async () => { throw new Error('模型挂了'); },
    remember: () => {}, log: () => {}, alertFn,
  });
  assert.equal(r1.length, 1);
  assert.ok(r1[0].error);
  assert.equal((readState().groupDigest || {})[peer], undefined, '失败不写标记');
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].k, 'digest:' + peer);

  // 第二次：digest 成功 → 写时间戳
  await owner.groupDigestRound({
    now: Date.now(), candidates: [{ peer }],
    digest: async () => ({ peer, label: '群·retry', read: 8, items: 1, meanImp: 3 }),
    remember: () => {}, log: () => {}, alertFn,
  });
  assert.ok((readState().groupDigest || {})[peer], '跑成写标记');

  // 第三次：20h 内跳过，digest 不该再被调
  let calls = 0;
  await owner.groupDigestRound({
    now: Date.now(), candidates: [{ peer }],
    digest: async () => { calls++; return null; }, alertFn,
  });
  assert.equal(calls, 0, '标记在，跳过');
});

test('C5.3 没得结（digest 返回 null）也写标记，别反复空跑', async () => {
  const peer = 'p:quiet';
  owner.logChat({ from: 'owner', peer, text: '随便说一句' });
  await owner.groupDigestRound({
    now: Date.now(), candidates: [{ peer }],
    digest: async () => null, remember: () => {}, log: () => {}, alertFn: async () => {},
  });
  assert.ok((readState().groupDigest || {})[peer], '没得结也算跑完，落标记');
});
