/**
 * 好感度：她对每个聊过天的人，心里都有一杆秤
 *
 * 分两层，别混：
 *   today.deltas —— 今天的零碎加减分（回复末尾的 [FAV:{"d":1,"why":"被夸了"}] 尾巴，brain 剥掉后记进来），
 *                   只影响今天的语气；一条最多 ±2。
 *   fav          —— 长期好感，每天结算一次，当天净分按「聊过的天数」定分量揉进去：
 *                     d   = clamp(当天净分, -5, +5)      一天最多算 5 分，防刷也防一吵定乾坤
 *                     T   = clamp(fav + d×6, 0, 100)    当天情绪放大成目标值
 *                     a   = 1 / min(天数+1, 30)          新朋友变化快、老朋友稳定但不冻死
 *                     fav = clamp(fav×(1-a) + T×a, 5, 95)
 *
 * 没聊天的日子不算天数也不结算——不聊天不掉好感。半夜没结算也没事：
 * 下次记分发现跨天了会先把前一天结算掉（懒结算），每晚 tick 的 settleAll 再兜底扫一遍。
 * 数据在 DATA/fav.json，先写临时文件再改名，跟 store.mjs 一个习惯。
 */
import { readFileSync, writeFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { DATA, localDate, nowIso, logAction } from './store.mjs';
import { tuning } from './qq/tuning.mjs';

const FILE = join(DATA, 'fav.json');
const TMP = `${FILE}.tmp`;

// 手感参数挪进 data/tuning.json（面板「手感调参」页改）：msgMax/dayMax/amp/minDays/lo/hi/decayEveryDays/decayPer/decayMax/keepDays。
// 这里每次用时现读（tuning 按 mtime 缓存，改完即生效），改参数不用重启
const KEEP_TODAY = 60; // today.deltas 留多少条（内部账本，不算手感）

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const k = (qq) => String(qq);
const round1 = (v) => Math.round(v * 10) / 10;

export function readFav() {
  try { return JSON.parse(readFileSync(FILE, 'utf-8')); } catch { return { users: {} }; }
}

function writeFav(data) {
  writeFileSync(TMP, JSON.stringify(data, null, 2));
  renameSync(TMP, FILE);
  return data;
}

/** 删掉这个人的好感记录（C4）。返回 true=确实删了 */
export function deleteUser(qq) {
  const d = readFav();
  const key = k(qq);
  if (!d.users[key]) return false;
  delete d.users[key];
  writeFav(d);
  return true;
}

export function ensureUser(qq) {
  const data = readFav();
  if (!data.users[k(qq)]) {
    data.users[k(qq)] = { fav: 50, activeDays: 0, firstSeen: nowIso(), nickname: '', today: { date: '', deltas: [] }, history: [] };
    writeFav(data);
  }
  return data.users[k(qq)];
}

function saveUser(qq, u) {
  const data = readFav();
  data.users[k(qq)] = u;
  writeFav(data);
  return u;
}

/** 当天净分（没聊过就是 0） */
export function todayNet(qq) {
  const u = readFav().users[k(qq)];
  return u?.today?.deltas?.length ? u.today.deltas.reduce((s, x) => s + (Number(x.d) || 0), 0) : 0;
}

/** 结算一个人攒着的那一天（没有净分就不动天数）。返回结算后的记录。 */
export function settleUser(qq) {
  const u = ensureUser(qq);
  const deltas = u.today?.deltas || [];
  if (deltas.length) {
    const F = tuning().fav;
    const d = clamp(deltas.reduce((s, x) => s + (Number(x.d) || 0), 0), -F.dayMax, F.dayMax);
    const T = clamp(u.fav + d * F.amp, 0, 100);
    const a = 1 / Math.min((u.activeDays || 0) + 1, F.minDays);
    u.fav = round1(clamp(u.fav * (1 - a) + T * a, F.lo, F.hi));
    u.activeDays = (u.activeDays || 0) + 1;
    u.history = [...(u.history || []), { date: u.today.date, d, favAfter: u.fav }].slice(-F.keepDays);
  }
  u.today = { date: '', deltas: [] };
  return saveUser(qq, u);
}

/** 记一条加减分；发现攒的是昨天的分，先结算掉 */
export function applyDelta(qq, d, why = '', { nickname, now = new Date() } = {}) {
  let u = ensureUser(qq);
  const today = localDate(now);
  if (u.today?.date && u.today.date !== today) u = settleUser(qq);
  if (nickname) u.nickname = String(nickname).slice(0, 40);
  if (!u.today || u.today.date !== today) u.today = { date: today, deltas: [] };
  u.lastTouch = today; // 有来往的日子：淡忘从这天起算
  const dd = clamp(Number(d) || 0, -tuning().fav.msgMax, tuning().fav.msgMax);
  if (dd !== 0) u.today.deltas.push({ t: nowIso(), d: dd, why: String(why || '').slice(0, 60) });
  u.today.deltas = u.today.deltas.slice(-KEEP_TODAY);
  return saveUser(qq, u);
}

/** 每晚 tick 调：把攒着的旧一天结算掉；断聊超过一周的按周淡忘（防「舔狗」：三个月不见还 80% 好感） */
export function settleAll(now = new Date()) {
  const today = localDate(now);
  const done = [];
  const faded = [];
  for (const qq of Object.keys(readFav().users)) {
    const u = readFav().users[qq];
    if (u.today?.deltas?.length && u.today.date !== today) { settleUser(qq); done.push(qq); continue; }
    if (!u.lastTouch) { // 老档案第一次见到这个字段：补上今天起算，不追溯旧账
      const x = ensureUser(qq); x.lastTouch = today; saveUser(qq, x); continue;
    }
    const gap = Math.floor((Date.parse(today) - Date.parse(u.lastTouch)) / 86400_000);
    const F = tuning().fav;
    if (gap >= F.decayEveryDays && u.fav > F.lo) {
      // 每满 decayEveryDays 天没来往淡 decayPer 分，断太久一次补齐，最多淡 decayMax 分
      const dec = Math.min(Math.floor(gap / F.decayEveryDays) * F.decayPer, F.decayMax);
      const x = ensureUser(qq);
      x.fav = round1(Math.max(F.lo, x.fav - dec));
      x.lastTouch = today; // 淡过重新起算，之后一个周期一淡
      x.history = [...(x.history || []), { date: today, d: 0, decay: dec, favAfter: x.fav }].slice(-F.keepDays);
      saveUser(qq, x);
      faded.push(`${u.nickname || qq} −${dec}`);
    }
  }
  // 结算账目落一条日志：好感异常时好排查（谁结算了、淡忘了谁）
  if (done.length || faded.length) {
    try {
      logAction({ kind: 'qq', source: 'auto', detail: `💝 好感夜间结算：${done.length ? `结算 ${done.length} 人（${done.map((q) => readFav().users[q]?.nickname || q).join('、')}）` : '今天没人要结算'}${faded.length ? `；淡忘 ${faded.length} 人（${faded.join('、')}）` : ''}` });
    } catch { /* 日志不挡正事 */ }
  }
  return done;
}

const feel = (f) => (f >= 80 ? '很喜欢' : f >= 65 ? '挺喜欢' : f >= 50 ? '有些好感' : f >= 35 ? '有点烦' : '挺嫌弃');
// 好感不是只让模型知道一个数字：每个档位给一句「该怎么开口」，不然 80 和 50 在 prompt 里只差一个词。
// 80 也看聊过几天：手动把数字调高、其实没聊熟的人，别一上来就黏。
const vibe = (f, days = 0) => (f >= 80 && days >= 2
  ? '你在这个人面前是放松的：可以主动黏一句、撒个小娇、关心直接说；别只回「？/行/哦」这种干巴巴的。'
  : f >= 80 ? '你对他印象很好，但你们还没聊几天：可以亲近一点，别一上来就黏。'
  : f >= 65 ? '你跟他聊得开：会接他的话，偶尔撒个小娇，被夸会真的开心。'
  : f >= 50 ? '你对他有好感，但还没到黏人的程度：自然、友好，别太快掏心。'
  : f >= 35 ? '你对他有点保留：话少一点，别主动热络。'
  : '你不太想搭理他：短、淡，但别伤人。');

/** 今天的单句记分流水（面板「手感调参」页看）：所有人的 today.deltas 摊平按时间倒序。
 *  只覆盖今天——过了半夜结算完就归档成一条净分进 history，明细不保留。 */
export function todayDeltas(limit = 40) {
  const out = [];
  for (const [qq, u] of Object.entries(readFav().users)) {
    for (const x of u.today?.deltas || []) out.push({ t: x.t, qq, name: u.nickname || qq, d: x.d, why: x.why || '' });
  }
  return out.sort((a, b) => String(b.t).localeCompare(String(a.t))).slice(0, limit);
}
const felt = (net) => (net >= 3 ? '特别开心' : net >= 1 ? '挺舒服' : net === 0 ? '平平淡淡' : net >= -2 ? '有点憋着气' : '有点烦他');

/** 给大脑的一节：现在对说话的这个人什么感觉，语气跟着走 */
export function favText(qq, { now = new Date() } = {}) {
  const u = readFav().users[k(qq)];
  if (!u) return '';
  const today = localDate(now);
  if (u.lastTouch !== today) { // 见到这个人说话也算有来往（哪怕当天没记分）：淡忘从今天起算，一天最多写一次盘
    const d = readFav(); const x = d.users[k(qq)];
    if (x) { x.lastTouch = today; saveUser(qq, x); }
  }
  const lines = [`长期好感 ${u.fav}%（聊过 ${u.activeDays} 天），你${feel(u.fav)}这个人。`];
  if (u.today?.date === localDate(now) && u.today.deltas?.length) lines.push(`今天聊下来${felt(todayNet(qq))}。`);
  lines.push(vibe(u.fav, u.activeDays));
  lines.push('这是长期相处攒下来的感觉，跟着它走；别把这个数字念出来。');
  return `## 你对说话的这个人\n${lines.join('\n')}`;
}
