/**
 * 防抖抖动的纯函数：在可控范围内对目标毫秒数加随机偏移，让回复时机不再每次都一样。
 *
 * 为什么单独成模块：index.mjs 连着 NapCat，没法离线单测；这里做成注入随机源的纯函数，
 * 既可验证边界，也便于面板调参（参数走 tuning().gate，热生效）。
 *
 * 三个旋钮：
 *  - amplitude（幅度，0~1）：相对目标值的 ±比例。0.25 = 目标 1200ms 时落在 900~1500ms。
 *  - minMs/maxMs（范围，毫秒）：钳制边界，0 表示不钳那一边；防止幅度配太大抖出离谱值。
 *  - frequency（频率，0~1）：只有这个比例的消息真抖，其余照目标值——保留一部分"准点"回复，
 *    不然每条都偏反而像机器人在故意错开。1 = 条条抖，0 = 完全不抖（等于关闭）。
 *
 * 默认 amplitude=0、frequency=0：纯函数原样返回目标值，线上行为与加抖动前一模一样。
 */
export function jitterDelay(baseMs, cfg = {}, rng = Math.random) {
  const base = Number(baseMs);
  if (!Number.isFinite(base) || base < 0) return 0;
  const a = Number(cfg?.amplitude) || 0;
  const f = Number(cfg?.frequency) || 0;
  // 关着的两种情形都原样返回，保证零回归
  if (!(a > 0) || !(f > 0)) return base;

  // 频率：这次到底抖不抖
  const r = Number(rng());
  if (!Number.isFinite(r) || r < 0 || r >= Math.min(1, f)) return base;

  // 幅度：±a 比例的均匀偏移。clamp 幅度到 [0,1]，防止写坏配置抖成负数或翻倍
  const amp = Math.max(0, Math.min(1, a));
  const delta = (Number(rng()) * 2 - 1) * amp * base; // [-amp*base, +amp*base)
  let out = base + delta;

  // 范围：钳制到 [minMs, maxMs]，0 表示该边不设限；最后保底不为负
  const lo = Number(cfg?.minMs) || 0;
  const hi = Number(cfg?.maxMs) || 0;
  if (lo > 0) out = Math.max(lo, out);
  if (hi > 0) out = Math.min(hi, out);
  return Math.max(0, Math.round(out));
}

/** 从 tuning().gate 取抖动配置：字段名集中在这里，index 和面板都不用散着记 */
export function gateJitter(g) {
  return {
    amplitude: Number(g?.jitterAmplitude) || 0,
    frequency: Number(g?.jitterFrequency) || 0,
    minMs: Number(g?.jitterMinMs) || 0,
    maxMs: Number(g?.jitterMaxMs) || 0,
  };
}
