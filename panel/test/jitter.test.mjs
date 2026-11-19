import './_env.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { jitterDelay, gateJitter } from '../qq/jitter.mjs';

// 固定随机源：把 rng 换成可控序列，验证幅度/频率/钳制的精确边界
const seq = (...vals) => { let i = 0; return () => vals[Math.min(i++, vals.length - 1)]; };

test('抖动关闭时逐毫秒零回归：默认参数、amplitude=0、frequency=0 都原样返回', () => {
  assert.equal(jitterDelay(1200), 1200, '完全默认');
  assert.equal(jitterDelay(1200, {}), 1200, '空配置');
  assert.equal(jitterDelay(2500, { amplitude: 0.3, frequency: 0 }), 2500, '频率 0 = 不抖');
  assert.equal(jitterDelay(2500, { amplitude: 0, frequency: 1 }), 2500, '幅度 0 = 不抖');
  // 关着的时候连随机源都不该消耗（保证线上零开销）
  let called = 0;
  jitterDelay(1200, {}, () => { called++; return 0.5; });
  assert.equal(called, 0, '关闭时没调 rng');
});

test('频率：只有命中比例内的消息才抖，其余照目标值', () => {
  // frequency=0.5：rng 第一发 0.7（≥0.5）→ 不抖；另一条 0.2 → 抖
  assert.equal(jitterDelay(1000, { amplitude: 0.2, frequency: 0.5 }, seq(0.7, 0.5)), 1000, '没命中，原值');
  const hit = jitterDelay(1000, { amplitude: 0.2, frequency: 0.5 }, seq(0.1, 0)); // 第 2 发是幅度 rng，取 0 打下界
  assert.equal(hit, 800, '命中了，偏移到下界 800');
  // frequency=1：任何 rng 第一发都抖
  assert.equal(jitterDelay(1000, { amplitude: 0.2, frequency: 1 }, seq(0.99, 0)), 800, '频率 1 条条抖');
});

test('幅度：偏移落在 ±amplitude 比例内，方向由 rng 决定', () => {
  // amplitude=0.25, base=1200 → ±300 → [900,1500]
  assert.equal(jitterDelay(1200, { amplitude: 0.25, frequency: 1 }, seq(0, 0)), 900, 'rng=0 → 下界 900');
  assert.equal(jitterDelay(1200, { amplitude: 0.25, frequency: 1 }, seq(0, 0.999999)), 1500, 'rng≈1 → 上界 1500');
  assert.equal(jitterDelay(1200, { amplitude: 0.25, frequency: 1 }, seq(0, 0.5)), 1200, 'rng=0.5 → 正中，不偏');
});

test('范围：minMs/maxMs 钳制，幅度写坏也不抖出界', () => {
  // 幅度想抖到 400，但 minMs=800 兜住
  assert.equal(jitterDelay(1000, { amplitude: 0.9, frequency: 1, minMs: 800 }, seq(0, 0)), 800, '下限钳制');
  // 幅度想抖到 1600，但 maxMs=1300 兜住
  assert.equal(jitterDelay(1000, { amplitude: 0.9, frequency: 1, maxMs: 1300 }, seq(0, 1)), 1300, '上限钳制');
  // 极端坏配置：amplitude>1 被钳到 1，不会抖成负数
  assert.ok(jitterDelay(1000, { amplitude: 99, frequency: 1 }, seq(0, 0)) >= 0, '幅度不会抖成负数');
});

test('边界：非法目标值返回 0，频率/幅度写坏不当成开', () => {
  assert.equal(jitterDelay(-5), 0, '负数目标值');
  assert.equal(jitterDelay('abc'), 0, '非数字目标值');
  assert.equal(jitterDelay(1000, { amplitude: 0.2, frequency: -1 }), 1000, '负频率当 0');
});

test('gateJitter 从 gate 配置取四个旋钮，缺省补 0', () => {
  assert.deepEqual(gateJitter({}), { amplitude: 0, frequency: 0, minMs: 0, maxMs: 0 });
  assert.deepEqual(gateJitter({ jitterAmplitude: 0.3, jitterFrequency: 0.6, jitterMinMs: 800, jitterMaxMs: 1800 }),
    { amplitude: 0.3, frequency: 0.6, minMs: 800, maxMs: 1800 });
});
