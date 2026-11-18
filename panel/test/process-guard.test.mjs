import './_env.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { installProcessGuard, resetGuardForTest } from '../guard.mjs';

test('1. 两个进程事件都注册，回调兜住异常不抛', () => {
  resetGuardForTest();
  const handlers = {};
  const on = (name, fn) => { handlers[name] = fn; };
  const ok = installProcessGuard({ onUncaught: on, onRejection: on, alert: async () => {} });
  assert.equal(ok, true);
  assert.ok(handlers.uncaughtException, '注册了 uncaughtException');
  assert.ok(handlers.unhandledRejection, '注册了 unhandledRejection');
  assert.doesNotThrow(() => handlers.uncaughtException(new Error('测试未捕获')));
  assert.doesNotThrow(() => handlers.unhandledRejection(Promise.reject(new Error('测试拒绝')).catch((e) => e)));
});

test('2. 告警文案写明建议重启容器，key 区分两类', async () => {
  resetGuardForTest();
  const handlers = {};
  const alerts = [];
  installProcessGuard({
    onUncaught: (n, f) => { handlers[n] = f; },
    onRejection: (n, f) => { handlers[n] = f; },
    alert: async (k, t) => alerts.push([k, t]),
  });
  handlers.uncaughtException(new Error('炸了A'));
  handlers.unhandledRejection(new Error('炸了B'));
  await new Promise((r) => setTimeout(r, 20)); // 等 fire-and-forget 跑完
  assert.equal(alerts.length, 2);
  for (const [, t] of alerts) assert.match(t, /建议重启容器/, '告警提示状态可能不干净');
  assert.ok(alerts.some(([k]) => k === 'guard:未捕获异常'));
  assert.ok(alerts.some(([k]) => k === 'guard:未处理的 Promise 拒绝'));
});

test('3. 幂等：重复安装不再注册第二套', () => {
  resetGuardForTest();
  let count = 0;
  const on = () => { count++; };
  installProcessGuard({ onUncaught: on, onRejection: on, alert: async () => {} });
  const second = installProcessGuard({ onUncaught: on, onRejection: on, alert: async () => {} });
  assert.equal(second, false, '第二次安装返回 false');
  assert.equal(count, 2, '只注册了两个事件，没变成四个');
});

test('4. 告警模块本身抛错也不影响兜底回调', () => {
  resetGuardForTest();
  const handlers = {};
  installProcessGuard({
    onUncaught: (n, f) => { handlers[n] = f; },
    onRejection: (n, f) => { handlers[n] = f; },
    alert: () => { throw new Error('告警也挂了'); },
  });
  assert.doesNotThrow(() => handlers.uncaughtException(new Error('主异常')));
});
