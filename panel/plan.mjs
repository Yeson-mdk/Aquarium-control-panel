/**
 * 计划：时辰表（几点刷）+ 晨间计划（那个时辰干什么）。
 * 从 autopilot.mjs 拆出来（2026-11-13）：autopilot 留调度和执行（executeSlot/runSession），这里管「今天排什么」。
 * 消费方：autopilot 的 tick（经 import）和 panel.mjs（经 autopilot 转出口）；测试也从 autopilot 拿，转出口兜住。
 */
import * as llm from './llm.mjs';
import * as mind from './mind.mjs';
import * as memory from './memory.mjs';
import {
  SHICHEN, localDate, logAction, todayCounts, readTasks, readConfig, readState, writeState,
  readJsonl, FILES,
} from './store.mjs';

const SRC = 'auto';
// rand/chance 和 autopilot 各留一份（一行的事，互相 import 反而会造成环）
const rand = (a, b) => a + Math.random() * (b - a);
const chance = (p) => Math.random() < p;

// ─── 今日计划 ──────────────────────────────────────────────
function windowRange(date, sc) {
  const [y, m, d] = date.split('-').map(Number);
  const start = new Date(y, m - 1, d, sc.start, 0, 0).getTime();
  const end = start + 2 * 3600_000; // 每个时辰 2 小时（子时跨到次日 01:00）
  return { start, end };
}

export function makePlan(date, cfg = readConfig()) {
  const slots = [];
  for (const key of cfg.windows) {
    const sc = SHICHEN.find((s) => s.key === key);
    if (!sc) continue;
    const { start, end } = windowRange(date, sc);
    const skip = !chance(cfg.windowChance);
    // 时间点落在时辰内，留出最后 20 分钟让这一轮刷完
    const at = Math.round(rand(start + 3 * 60_000, end - 20 * 60_000));
    slots.push({ key, label: sc.label, start, end, at, status: skip ? 'skipped' : 'pending' });
  }
  return slots.sort((a, b) => a.start - b.start);
}

export function ensurePlan(state, date) {
  if (!state.plans[date]) state.plans[date] = makePlan(date);
  // 注意：这里不标「过期错过」——标记统一归 markExpired，tick 拿它的计数触发重排。
  // 以前这里抢先静默标掉，tick 循环就永远看不到 pending→missed 的跳变，错过重排成了死路（2026-11-13 验收发现）
  // 只留最近 7 天的计划
  for (const d of Object.keys(state.plans).sort().slice(0, -7)) delete state.plans[d];
  return state.plans[date];
}

/** 把过完窗口还没跑的格子标成错过（电脑睡着、总开关关着都会造成），返回新标的格数——tick 拿这个数触发错过重排 */
export function markExpired(state, dates) {
  let n = 0;
  const now = Date.now();
  for (const d of dates) {
    for (const s of state.plans[d] || []) {
      if (s.status === 'pending' && now >= s.end) { s.status = 'missed'; n++; }
    }
  }
  return n;
}

export function todayPlan() {
  const state = readState();
  const date = localDate();
  const plan = ensurePlan(state, date);
  writeState(state);
  return plan;
}

/** 配置改了（换了时辰）之后，重新抽今天还没到的时间点 */
export function replanToday() {
  const state = readState();
  const date = localDate();
  const old = state.plans[date] || [];
  const fresh = makePlan(date);
  const now = Date.now();
  state.plans[date] = fresh.map((s) => {
    const prev = old.find((o) => o.key === s.key);
    if (prev && (prev.status !== 'pending' || prev.end < now)) return prev; // 已发生的不改
    if (s.end < now) return { ...s, status: 'missed' };
    if (s.at < now) s.at = Math.round(rand(now + 60_000, Math.max(now + 120_000, s.end - 20 * 60_000)));
    return s;
  });
  writeState(state);
  return state.plans[date];
}

// ─── 晨间计划（阶段三）：时辰表从「几点刷」长出「这个时辰干什么」 ──────
const PLAN_TYPES = ['browse', 'browse_like', 'comment', 'diary', 'check', 'rest', 'reflect_self', 'idle_wander'];
// 带 goal 的时辰跑完，反馈记忆记成哪一面（不挂人：是她自己的经历）
// reflect_self / idle_wander 不进这张表：内部类型的产物本身就是一条 kind:self 记忆，不再叠反馈记忆（recordSlotFeedback 见到没映射就跳过）
const PLAN_FB_KIND = { browse: 'watch', browse_like: 'watch', comment: 'social', diary: 'social', check: 'social' };
const REPLAN_MAX_PER_DAY = 2;
// 内部行为类 type 每天最多几格（今天 todayCounts 里该 kind 的成功次数挡）
const INNER_DAILY_MAX = { reflect_self: 1, idle_wander: 1 };

/** 类型撞今天的日上限就别排了（生成时挡一道；真跑的时候 todayCounts 还会再挡一道） */
/** 今天日记发过没有（排 diary 时辰的闸之一；autopilot 的 maybeDiary 也用） */
export function diaryPublishedToday() {
  const today = localDate();
  return readJsonl(FILES.diary).some((e) => e.type === 'published' && e.date === today);
}

function planTypeBlocked(type, cfg = readConfig()) {
  const c = todayCounts();
  if (type === 'browse_like') return (c.like || 0) >= cfg.like.dailyMax;
  if (type === 'comment') return (c.comment || 0) >= cfg.comment.dailyMax;
  if (type === 'diary') return diaryPublishedToday();
  // 内部行为类：每天最多 1 格（今天成功跑过一次就别再排了，把时辰留给出向类型）
  if (INNER_DAILY_MAX[type]) return (c[type] || 0) >= INNER_DAILY_MAX[type];
  return false;
}

/**
 * 晨间计划：今天还没跑的时辰各派一个类型 + 可选 goal。
 * replan=true 是重排（叫停解除 / 号主派新活 / 有时辰错过了），只动还没跑的格子，每天最多 2 次。
 * 护栏：白名单外的类型该格回退纯时辰表；撞日上限的类型改 rest；模型没回话/胡说整表回退。
 * 失败也盖 plannedOn 章：别每 30 秒重试烧预算，明天再说。
 * 并发锁：tick 和面板按钮可能同一时刻各触发一次（2026-11-16 一次点击出两条日志的根因）——
 * 生成进行中，别的触发让路、拿在跑这轮的结果，不再并发打两次模型。
 */
let genInFlight = null;
export function morningPlan(opts = {}) {
  if (genInFlight) return genInFlight; // 已有一轮在跑：等它、复用它的结果（同一时刻的输入等价）
  genInFlight = runMorningPlan(opts).finally(() => { genInFlight = null; });
  return genInFlight;
}

async function runMorningPlan({ now = Date.now(), replan = false } = {}) {
  const cfg = readConfig();
  const date = localDate(new Date(now));
  const state = readState();
  const slots = state.plans[date] || [];
  if (!cfg.morningPlan || !slots.length) return slots;
  if (!replan && state.plannedOn === date) return slots; // 今天生成过（或失败过）就不重来
  const targets = slots.filter((s) => s.status === 'pending');
  if (!targets.length) return slots;
  if (replan) {
    state.replanCount = state.replanCount || {};
    const used = state.replanCount[date] || 0;
    if (used >= REPLAN_MAX_PER_DAY) {
      logAction({ kind: 'plan', source: SRC, detail: `今天重排过 ${used} 次了，剩下的照原计划跑` });
      writeState(state);
      return slots;
    }
  }

  const m = mind.readMind();
  const insights = memory.memoryView(10).insights.slice(0, 5).map((x) => x.text);
  const yesterday = todayCounts(localDate(new Date(now - 86400_000)));
  const todos = readTasks().filter((t) => t.status === 'pending')
    .map((t) => `${t.type}：${(t.note || '').slice(0, 40)}`).slice(0, 5);
  const listed = targets.map((s) => `${s.key}（${new Date(s.at).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}）`).join('、');

  let out = null;
  try {
    out = await llm.chat([
      { role: 'system', content: `你在给一条B站账号排今天刷B站的计划。今天要安排的时辰：${listed}。每个时辰从这几种里挑一个：browse（随缘刷视频）、browse_like（刷 + 多点赞）、comment（刷 + 评论）、diary（写养鱼日记）、check（看回复和@）、rest（这个时辰歇着不发不刷）、reflect_self（想想最近的事、在心里归纳一下，不刷B站不对外说话）、idle_wander（发呆放空遐想一会，不刷B站不对外说话）。reflect_self 和 idle_wander 每天各最多排一个，多了就换成 rest。昨天做得多的今天排 rest 缓一缓。只输出 JSON：{"slots":[{"key":"时辰","type":"类型","goal":"这个时辰她想干什么，一句以内，没想法就空串"}]}。type 只能是上面八个之一，不许编别的。goal 写她自己的动机，不写命令、不提任何人的名字。` },
      { role: 'user', content: `她最近的样子：${(m.persona?.text || '').slice(0, 200) || '（还没长出来）'}\n她最近的洞察：${insights.join('；') || '（还没有）'}\n昨天各做了几次：${JSON.stringify(yesterday)}\n待办：${todos.join('；') || '（没有）'}` },
    ], { maxTokens: 1600, temperature: 0.7, tag: 'plan' }); // 1600：一格带 60 字 goal 约 75 token，时辰加到 7 个再加 flash 前置就超 800（2026-11-16 实测截断），翻倍留余量
  } catch (e) {
    logAction({ kind: 'plan', source: SRC, ok: false, detail: '计划生成失败，今天按纯时辰表跑', error: e.message });
  }
  state.plannedOn = date;
  if (replan) { state.replanCount = state.replanCount || {}; state.replanCount[date] = (state.replanCount[date] || 0) + 1; }

  let changed = 0;
  let parseFail = false;
  if (out) {
    try {
      const obj = JSON.parse(out.slice(out.indexOf('{'), out.lastIndexOf('}') + 1));
      for (const x of obj.slots || []) {
        const s = targets.find((t) => t.key === String(x.key || '').trim());
        if (!s) continue;
        const type = PLAN_TYPES.includes(x.type) ? x.type : null;
        if (!type) continue; // 白名单外（编造的类型）→ 该时辰按默认随缘刷
        s.type = planTypeBlocked(type, cfg) ? 'rest' : type;
        const goal = s.type === 'rest' ? '' : String(x.goal || '').trim().slice(0, 60);
        if (goal) s.goal = goal; else delete s.goal; // 歇着的格子不留 goal
        if (replan) s.replanned = true;
        changed++;
      }
    } catch (e) {
      parseFail = true;
      logAction({ kind: 'plan', source: SRC, ok: false, error: e.message, detail: `计划没解析出来，今天按纯时辰表跑。模型原话：${String(out).slice(0, 120)}` });
    }
  }
  writeState(state);
  if (changed) {
    logAction({
      kind: 'plan', source: SRC,
      detail: `${replan ? '重排' : '晨间'}计划：${slots.filter((s) => s.type).map((s) => `${s.label}=${s.type}${s.goal ? `「${s.goal}」` : ''}${s.replanned ? '（重排）' : ''}`).join('，')}`,
    });
  } else if (!parseFail) {
    // 零命中静默是排查黑洞（2026-11-16 周末两天零晨间计划，和「开关关着」完全无法区分）：跑了但没排上也留痕
    logAction({ kind: 'plan', source: SRC, ok: false, detail: `${replan ? '重排' : '晨间'}计划跑了，但模型没给出能用的安排（${out ? `时辰全对不上，原话：${String(out).slice(0, 80)}` : '没回话'}），今天按纯时辰表跑` });
  }
  return slots;
}

/** 带 goal 的时辰跑完，把「想干什么 → 实际怎样」写回她的记忆 */
export function recordSlotFeedback(slot, note) {
  if (!slot?.goal || !PLAN_FB_KIND[slot.type]) return;
  try {
    memory.add({ kind: PLAN_FB_KIND[slot.type], imp: 2, text: `今天的计划里这个时辰想「${slot.goal}」，跑完是：${String(note || '').slice(0, 80)}` });
  } catch { /* 记忆写不进不挡正事 */ }
}
