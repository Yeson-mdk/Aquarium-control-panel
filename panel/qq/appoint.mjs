/**
 * 约定（守约式主动开口）—— 阶段三.5
 *
 * 两件事：
 *  1. 别人约她她赴约（入口B）：夜间链扫当天聊天，认出指向她的约定，存进 tasks.jsonl
 *  2. 到点兑现（触发层）：autopilot tick 每拍扫到期约定，分两条路径发——
 *     - 号主闹钟（peer='owner'）：notify.rawSend 直发，不过仲裁
 *     - 赴约（peer='g:'/'p:'）：qq.sendText 发回原 peer，带人设约束
 *
 * 数据层零改 store.mjs：约定 = tasks.jsonl 一条 type:'appointment' + executor:'bot'，
 * jsonl 追加 + Map merge 天然支持 dueAt/peer/originText 等新字段。
 *
 * 护栏：每天最多兑现 2 条（todayCounts 计数挡）；过期超 1 小时不发；识别挂低峰不挂每条消息。
 */
import { readTasks, addTask, updateTask, todayCounts, localDate, nowIso, logAction, readConfig } from '../store.mjs';
import * as llm from '../llm.mjs';
import * as memory from '../memory.mjs';
import { readChat, digestCandidates } from './owner.mjs';

// 指向判定（照 brain.mjs:242 复用，认名字那几个词——只认叫她名字/回她的话，先紧后松）
const DIRECT_RE = /哦鲸鲸|鲸鲸|鲸鱼|大肥鱼|肥鱼/;

const DAILY_MAX = 2;          // 每天最多兑现 2 条
const STALE_MS = 3600_000;    // 过期超 1 小时不发
const FUTURE_LIMIT_MS = 7 * 86400_000; // 约定时间不超 7 天

// ─── 数据层（addTask 的薄封装）─────────────────────────────

/** 存一条约定。peer='owner' 是号主闹钟，'g:群号'/'p:QQ号' 是赴约 */
export function addAppointment({ dueAt, peer, originText, originMsgId = '', who = '' }) {
  return addTask({
    type: 'appointment', executor: 'bot', source: 'auto', note: '', payload: {},
    dueAt, peer, originText, originMsgId, who,
  });
}

// ─── 触发层（autopilot tick 每拍调）─────────────────────────

/**
 * 扫到期约定，逐条兑现。不受自动养号开关影响（照 notify.flushPending 范式）。
 * 挂在 autopilot.mjs tick 开头，notify.flushPending 之后。
 */
export async function scanDueAppointments(now = Date.now()) {
  const cfg = readConfig();
  if (cfg.appoint?.enabled === false) return; // 开关默认开（不设或 true 都跑）
  const due = readTasks().filter((t) =>
    t.type === 'appointment' && t.status === 'pending' &&
    t.dueAt && t.dueAt <= now && now - t.dueAt < STALE_MS,
  );
  if (!due.length) return;
  const cnt = (todayCounts(localDate(new Date(now))).appointment) || 0;
  let fired = 0;
  for (const a of due) {
    if (cnt + fired >= DAILY_MAX) {
      logAction({ kind: 'appointment', source: 'auto', detail: `⏰ 今天已兑现 ${DAILY_MAX} 条，剩下的不发了：${a.originText?.slice(0, 40) || ''}` });
      break;
    }
    try {
      await fulfillAppointment(a);
      fired++;
    } catch (e) {
      console.error('[appoint] 兑现失败', e.message);
      logAction({ kind: 'appointment', source: 'auto', ok: false, detail: `赴约失败：${e.message}`, target: a.id });
    }
  }
}

// ─── 发送层（分两条路径）────────────────────────────────────

async function fulfillAppointment(a) {
  const { peer, originText, who } = a;
  let text;
  if (!peer || peer === 'owner') {
    // 号主闹钟：不过仲裁，直发
    text = await draftOwnerLine(originText);
    const { rawSend } = await import('../notify.mjs');
    await rawSend(text);
  } else {
    // 赴约：带人设约束，发回原 peer
    text = await draftHonorLine({ originText, who, peer });
    const qq = await import('./index.mjs'); // 动态 import 破循环依赖
    await qq.sendText(text, 'appointment', peer);
  }
  updateTask(a.id, { status: 'fired', firedAt: nowIso() });
  logAction({ kind: 'appointment', source: 'auto', ok: true, detail: `📮 赴约：${text.slice(0, 60)}`, target: a.id, meta: { peer, who } });
}

/** 号主闹钟：让她写一句提醒的话 */
async function draftOwnerLine(originText) {
  if (!llm.llmReady()) return `到点啦～（${originText}）`;
  const out = await llm.chat([
    { role: 'system', content: `${llm.PERSONA}\n到点了，号主之前让你提醒他：${originText}。用你的口吻说一句，简短、像微信提醒，别像系统通知。一到两句就够。` },
  ], { maxTokens: 100, tag: 'mind' });
  return String(out).trim().slice(0, 200) || `到点啦～`;
}

/** 赴约：让她写一句赴约的话，带跟这个人的近期记忆防串场 */
async function draftHonorLine({ originText, who, peer }) {
  if (!llm.llmReady()) return `嗯，${originText?.slice(0, 30) || '来了'}`;
  // 拿跟这个人的近期记忆（只带这个 peer 的，防串场）
  const recent = memory.memoryView(80).recent
    .filter((e) => (e.keys || []).includes(peer))
    .slice(0, 3)
    .map((e) => e.text)
    .join('；');
  const ctx = recent ? `\n\n最近跟他聊过的：${recent}` : '';
  const where = peer.startsWith('g:') ? '群里' : '私聊里';
  const out = await llm.chat([
    { role: 'system', content: `${llm.PERSONA}\n${who || '有人'}之前约你：「${originText}」。到点了，你在${where}主动说一句，赴约。简短、像真人开口，别像系统通知。只聊跟这个人有关的事，别串到别的。${ctx}` },
  ], { maxTokens: 120, tag: 'mind' });
  return String(out).trim().slice(0, 200) || `嗯，来了`;
}

// ─── 识别层（入口B：别人约她她赴约，夜间链调）──────────────────

/**
 * 扫当天活跃对话里指向她的约定。照 digestGroup 调度范式：取活跃对话 → 逐个扫。
 * 挂夜间链（qq/index.mjs 的 qqDigestOn 段，groupDigestRound 之后）。
 */
export async function scanForAppointments({ now = Date.now() } = {}) {
  const cfg = readConfig();
  if (cfg.appoint?.enabled === false) return;
  if (!llm.llmReady()) return;
  const today = localDate(new Date(now));
  const candidates = digestCandidates(today, { top: 3 });
  if (!candidates.length) return;
  for (const { peer } of candidates) {
    try {
      await scanPeer(peer, now);
    } catch (e) {
      console.error('[appoint] 扫', peer, e.message);
    }
  }
}

/** 扫一个对话里指向她的约定 */
async function scanPeer(peer, now) {
  // 只要别人说的、最近 24 小时内的、指向她的（复用 brain.mjs:242 direct 正则）
  const cut = now - 86400_000;
  const directed = readChat(peer).filter((e) =>
    e.from !== 'her' && e.kind !== 'reset' &&
    Date.parse(e.ts) > cut &&
    DIRECT_RE.test(String(e.text || '')),
  );
  if (directed.length < 1) return; // 指向她的都没有就不扫
  const lines = directed.map((e, i) => `${i + 1}. ${e.name || '有人'}：${String(e.text).slice(0, 100)}`).join('\n');
  const out = await llm.chat([
    { role: 'system', content: `${llm.PERSONA}\n从下面的聊天里挑出指向你的约定——含明确时间（明天几点/今晚/明早/做完X找我）或明确事件的句子。只输出 JSON。` },
    { role: 'user', content: `当前时间：${new Date(now).toLocaleString('zh-CN')}\n聊天（${peer}）：\n${lines}\n\n挑出指向你的约定，每条：{"text":"对方原话","dueAt":"ISO时间字符串","who":"说话人","msgId":"上面的序号"}\n只抽含明确时间的；没约定给空数组；时间算不准的不抽。dueAt 必须是未来的时间。\n输出：{"appointments":[...]}` },
  ], { maxTokens: 400, tag: 'mind' });
  let j = null;
  try { j = llm.looseJson(out); } catch { return; } // 坏 JSON 不炸
  const items = (j && Array.isArray(j.appointments) ? j.appointments : [])
    .map((x) => ({
      text: String(x.text || '').slice(0, 200),
      dueAt: parseDueAt(x.dueAt, now),
      who: String(x.who || '').slice(0, 30),
      msgId: String(x.msgId || ''),
    }))
    .filter((x) => x.text && x.dueAt && x.dueAt > now && x.dueAt < now + FUTURE_LIMIT_MS);
  for (const x of items) {
    addAppointment({ dueAt: x.dueAt, peer, originText: x.text, originMsgId: x.msgId, who: x.who });
    logAction({ kind: 'appointment', source: 'auto', ok: true, detail: `📅 认出个约定：${x.who}约「${x.text.slice(0, 40)}」`, meta: { peer, dueAt: x.dueAt } });
  }
}

/** 时间解析：ISO 字符串 / 数字 → 时间戳 */
function parseDueAt(s, now) {
  if (!s) return 0;
  if (typeof s === 'number') return s;
  const t = Date.parse(s);
  return Number.isFinite(t) ? t : 0;
}

// ─── 面板用：读约定列表 ──────────────────────────────────

/** 面板 /api/appointments 用：返回待兑现/已兑现/已过期 */
export function listAppointments() {
  const now = Date.now();
  const all = readTasks().filter((t) => t.type === 'appointment');
  return {
    pending: all.filter((t) => t.status === 'pending' && t.dueAt > now - STALE_MS),
    fired: all.filter((t) => t.status === 'fired').slice(-20),
    expired: all.filter((t) => t.status === 'pending' && t.dueAt <= now - STALE_MS),
  };
}
