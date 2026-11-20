import test from 'node:test';
import assert from 'node:assert/strict';
import './_env.mjs';
import { probeDeps } from '../health-deps.mjs';

const probes = (over = {}) => ({
  modelscope: async () => ({ status: 'ok', detail: '通' }),
  edgeTts: async () => ({ status: 'skipped', detail: '没配' }),
  sqmusic: async () => ({ status: 'ok', detail: '通' }),
  bilibili: async () => ({ status: 'ok', detail: '登录中' }),
  ...over,
});

test('C6.1 全通/跳过都没有 problems', async () => {
  const r = await probeDeps({ probes: probes() });
  assert.equal(r.problems.length, 0);
  assert.equal(r.results.modelscope.status, 'ok');
  assert.equal(r.results.edgeTts.status, 'skipped');
});

test('C6.2 配了却坏了 → problem 带 code/text/fix；一项挂不拖垮其他', async () => {
  const r = await probeDeps({ probes: probes({
    bilibili: async () => { throw new Error('Cookie 掉登录了'); },
    sqmusic: async () => { throw new Error('HTTP 500'); },
  }) });
  assert.equal(r.problems.length, 2);
  assert.ok(r.problems.some((p) => p.code === 'dep:bilibili' && /Cookie/.test(p.text) && p.fix));
  assert.ok(r.problems.some((p) => p.code === 'dep:sqmusic'));
  // 没挂的两项照常出结果
  assert.equal(r.results.modelscope.status, 'ok');
});

test('C6.3 单项超时被兜住，不抛到调用方', async () => {
  const r = await probeDeps({
    probes: probes({ modelscope: () => new Promise(() => {}) }), // 永不 settle
    timeoutMs: 30,
  });
  assert.equal(r.results.modelscope.status, 'error');
  assert.ok(r.problems.some((p) => p.code === 'dep:modelscope'));
  assert.equal(r.results.bilibili.status, 'ok', '其他项不受影响');
});

test('C6.4 refreshDeps 节流 + 只在「新」失败时告警（用 health 模块的状态机）', async () => {
  const health = await import('../health.mjs');
  let calls = 0;
  const run = async () => {
    calls++;
    return { results: {}, problems: calls === 1 ? [{ code: 'dep:x', text: 'x 挂了', fix: '修' }] : [], checkedAt: Date.now() };
  };
  const alerts = [];
  // 通过注入 run 验证节流；alert 走真实模块会 fire-and-forget，这里只验证 calls
  const t0 = Date.now();
  await health.refreshDeps({ run, now: t0 });
  assert.equal(calls, 1);
  await health.refreshDeps({ run, now: t0 + 1000 }); // 1 小时后内不重探
  assert.equal(calls, 1, '24h 内只探一次');
  const st = health.depsStatus();
  assert.equal(st.problems.length, 1, '保留了上次的失败状态供横幅显示');
});

test('C6.5 force=true 绕过 24h 节流立刻重探（面板「再查一次」恢复后横幅能消）', async () => {
  const health = await import('../health.mjs');
  let calls = 0;
  const run = async () => { calls++; return { results: {}, problems: [], checkedAt: Date.now() }; };
  const t0 = Date.now();
  await health.refreshDeps({ run, now: t0, force: true }); // 先 force 真探一次，覆盖上次状态并刷新 checkedAt
  assert.equal(calls, 1);
  await health.refreshDeps({ run, now: t0 + 2000 });     // 不 force：24h 内被挡
  assert.equal(calls, 1, '普通调用仍被节流');
  await health.refreshDeps({ run, now: t0 + 2000, force: true }); // force：立刻重探
  assert.equal(calls, 2, 'force 绕过节流重探了');
  assert.equal(health.depsStatus().problems.length, 0, '恢复后失败状态被清掉，横幅可消');
});
