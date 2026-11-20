/**
 * 拍一拍「回头看」的新鲜度判定（纯函数，便于离线单测；index.mjs 连 NapCat 测不进去）。
 *
 * 拍一拍是喊她回头看刚才没接的话。上一句话都过去老半天了还拍，多半是随手戳一下，
 * 没必要翻旧账——所以按「上一句距今多久」判：够近才回看上下文并回，太远就当没看见。
 * 判定阈值带一点随机抖动，免得每次都卡在同一秒、行为像定时开关（防固化）。
 *
 * 三个入口：
 *  - lastRealChatTs(entries)：从聊天记录里找最后一句「真话」的时间戳（跳过系统占位）。
 *  - pokeWindowMs(g, rng)：算这次判定实际用的窗口毫秒数（基准 ±抖动，钳在上下界内）。
 *  - pokeFresh({lastTs, now, windowMs})：给出 allow / verdict / gapMs。
 */
import { jitterDelay } from './jitter.mjs';

/** 从聊天记录里倒着找最后一句真话的时间戳（毫秒）。跳过拍一拍/@了/reset/空行这些系统占位。 */
export function lastRealChatTs(entries = [], now = Date.now()) {
  const n = Number.isFinite(Number(now)) ? Number(now) : Date.now();
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i] || {};
    const text = String(e.text || '');
    if (!text.trim()) continue;
    if (e.kind === 'reset') continue;
    // 系统占位符：（X拍了拍你）/（拍了拍你）/（X拍了拍Y）/（@了你，什么都没说）
    if (/^（[^）]{0,40}(?:拍了拍|@了你)/.test(text)) continue;
    const ts = Date.parse(e.ts || 0);
    if (Number.isFinite(ts) && ts <= n + 60_000) return ts; // 未来超过一分钟的脏数据当无效
  }
  return 0;
}

/**
 * 这次判定实际用的窗口（毫秒）：pokeFreshSec 基准 ± pokeJitterRatio 抖动，钳在 [min,max]。
 * 抖动固定 frequency=1（每次判都抖一下，阈值不固化）；幅度 0 时 jitterDelay 原样返回基准。
 * min/max 是护栏、始终生效（即便不抖，也把离谱的基准钳住）；写反了自动交换。
 * 返回 0 表示闸关着（窗口<=0），调用方按「不设时间闸」处理。
 */
export function pokeWindowMs(g = {}, rng = Math.random) {
  const base = Math.max(0, Number(g.pokeFreshSec) || 0) * 1000;
  if (!(base > 0)) return 0;
  const amplitude = Math.max(0, Math.min(1, Number(g.pokeJitterRatio) || 0));
  const jittered = jitterDelay(base, { amplitude, frequency: 1 }, rng);
  let lo = Math.max(0, Number(g.pokeFreshMinSec) || 0) * 1000;
  let hi = Math.max(0, Number(g.pokeFreshMaxSec) || 0) * 1000;
  // 只有两边都设了（非 0）才判写反；一边是 0（没设）时另一边照常单边生效
  if (lo > 0 && hi > 0 && lo > hi) [lo, hi] = [hi, lo];
  let out = jittered;
  if (lo > 0) out = Math.max(lo, out);
  if (hi > 0) out = Math.min(hi, out);
  return Math.max(0, Math.round(out));
}

/**
 * 判定一次拍一拍要不要回看。
 * @param lastTs 上一句真话的时间戳（毫秒；0/无效=没有上一句）
 * @param now    当前时间戳（毫秒）
 * @param windowMs 本次窗口（pokeWindowMs 的结果）
 * @returns {{allow:boolean, verdict:string, gapMs:number|null, windowMs:number}}
 *   verdict: 'off'(闸关着) | 'no-last'(没上一句) | 'fresh'(够近，回看) | 'stale'(太远，忽略)
 */
export function pokeFresh({ lastTs = 0, now = Date.now(), windowMs = 0 } = {}) {
  const w = Number(windowMs);
  if (!(w > 0)) return { allow: true, verdict: 'off', gapMs: null, windowMs: 0 }; // 关闸：老行为，照回
  const last = Number(lastTs);
  if (!Number.isFinite(last) || last <= 0) return { allow: true, verdict: 'no-last', gapMs: null, windowMs: w }; // 没上一句：无从判断远近，老行为
  const n = Number.isFinite(Number(now)) ? Number(now) : Date.now();
  const gap = Math.max(0, n - last); // 时钟回拨/未来时间戳：间隔按 0（刚发生）算
  const allow = gap <= w; // 正好压线算「够近」
  return { allow, verdict: allow ? 'fresh' : 'stale', gapMs: gap, windowMs: w };
}
