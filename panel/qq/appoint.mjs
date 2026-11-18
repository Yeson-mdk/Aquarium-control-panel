/**
 * 定时任务（job）—— 阶段三.5 约定升级版（2026-11-18 一期）
 *
 * 约定是 job 的一种：到点执行一个动作。三种 kind：
 *  - say：到点说一句（原「赴约/号主闹钟」，peer='owner' 直发 / 'g:'/'p:' 发回会话，带 [TO:who] @ 约你的人）
 *  - watch：到点看指定 B站 视频（仅号主，runSession directive）
 *  - task：到点交后台干活（runTask，report 回 QQ）
 *
 * 兼容阶段三.5：旧 type:'appointment'、无 kind 的记录照旧当 say 处理，读时间兼容 dueAt/at；
 * 旧函数 addAppointment / scanDueAppointments / listAppointments 全部保留转调新实现，老测试与线上数据都不炸。
 *
 * 数据层零改 store.mjs：job = tasks.jsonl 一条 executor:'bot'，jsonl 追加 + Map merge 天然吃新字段。
 *
 * 护栏：过期超 1 小时不发；识别挂低峰不挂每条消息；赴约次数不设上限；watch 仅号主。
 */
import { readTasks, addTask, updateTask, localDate, nowIso, logAction, readConfig, readPause, readState } from '../store.mjs';
import * as llm from '../llm.mjs';
import * as memory from '../memory.mjs';
import { readChat, digestCandidates } from './owner.mjs';

// 指向判定（照 brain.mjs:242 复用，认名字那几个词——只认叫她名字/回她的话，先紧后松）
const DIRECT_RE = /哦鲸鲸|鲸鲸|鲸鱼|大肥鱼|肥鱼/;
// 夜间约定扫描专用：放宽"指向她"的判断——叫昵称，或含明确的约定/时间句式都算。
// 号主裁决 2026-11-18：群友说「后面三天早上九点@我一下」没叫昵称也得认，否则约定永远漏。
// 只做粗筛丢给 LLM 二次判定（LLM 那层"只抽含明确时间的"兜着），误伤有限；brain.mjs 的搭腔正则不动。
// 注意别放裸「天天」：会命中「今天天气」这种闲聊（2026-11-18 测试抓到）；「天天叫我」靠同句的叫我/几点命中
const APPOINT_HINT_RE = /每天|每个?周|早上|晚上|中午|下午|明早|明天|今晚|到点|几点|\d点|提醒|叫我|喊我|@我|催我|连着\s*\d+\s*天|后面\s*\d+\s*天|接下来\s*\d+\s*天|星期[一二三四五六日天]|周[一二三四五六日天]/;

const STALE_MS = 3600_000;    // 过期超 1 小时不发
const RUN_STALE_MS = 15 * 60_000; // 看视频任务标「在看」后超过 15 分钟还没结果 = 进程崩了，放回 pending 重排
const DAY_MS = 86400_000;
const FUTURE_LIMIT_MS = 30 * DAY_MS; // 定时任务时间不超 30 天（号主裁决：任务保留 30 天）
const DAILY_MAX_AGE_MS = 30 * DAY_MS; // daily 任务从首次触发起最多连跑 30 天，到点自动停（没写 days 的老任务走这条）
const DAILY_MAX_DAYS = 30;           // 「连着 N 天」的 N 上限（号主裁决：最多 30 天，按自然日）
const DAILY_MAX_COUNT = 20;          // 同时活着的 daily 任务总量上限，防无限累积

// ─── 数据层（addTask 的薄封装）─────────────────────────────

/**
 * 存一条定时任务（job）。新接口，兼容旧约定字段。
 * @param kind  say(说一句) / watch(看指定视频) / task(交后台干活)，缺省 say
 * @param at    到点时间戳(ms)；也认旧名 dueAt
 * @param targetPeer 去哪执行/回复（旧版没有=用 peer）
 * @param sourcePeer 谁在哪下的令（跨会话判权限用）
 */
export function addJob({ at, dueAt, kind = 'say', peer, targetPeer, sourcePeer, originText, originMsgId = '', who = '', whoQq = '', payload = {}, repeat = 'once', days, note, type, startedAt, logDetail: customLog } = {}) {
  const when = at || dueAt;
  const label = (originText || payload?.taskNote || '').slice(0, 40);
  const isDaily = repeat === 'daily';
  // 连着 N 天：只有在 daily 下才有意义；clamp 到 1..30（号主裁决最多 30 天）。非法/没给 → 不写 days，走老的 30 天逻辑
  const runDays = isDaily && Number.isFinite(Number(days)) && Number(days) >= 1
    ? Math.min(DAILY_MAX_DAYS, Math.floor(Number(days))) : 0;
  // daily 总量上限：活着的（pending）daily 太多就不再建，防每天越攒越多
  if (isDaily) {
    const live = readTasks().filter((t) => isJob(t) && t.repeat === 'daily' && t.status === 'pending');
    if (live.length >= DAILY_MAX_COUNT) {
      logAction({ kind: 'appointment', source: 'auto', ok: false, detail: `每天的任务攒到 ${DAILY_MAX_COUNT} 条了，先停一停，这条没记` });
      return null;
    }
  }
  return addTask({
    // 约定继续写 type:'appointment'（老测试与线上按 type 过滤的读法都不变）；新动作写 'job'
    type: type || (kind === 'say' ? 'appointment' : 'job'),
    executor: 'bot', source: 'auto', note: note || `定时任务：${label}`, payload: {},
    // 新字段 + 旧字段都写：老代码读 dueAt/peer 照旧能读，新代码读 at/kind
    at: when, dueAt: when, kind, repeat,
    // daily：startedAt = 首次触发的基准时刻（用于到期），只在第一次建时写，推进时沿用
    ...(isDaily ? { startedAt: startedAt || when, ...(runDays ? { days: runDays } : {}) } : {}),
    peer, targetPeer: targetPeer || peer, sourcePeer: sourcePeer || peer,
    originText, originMsgId, who, whoQq, jobPayload: payload,
    // 建任务只写 appointment_set，不写 kind:'task' 的「派任务」，面板不重复
    logKind: 'appointment_set', logDetail: customLog || (kind === 'say' ? `📅 认出个约定：${who || '号主'}约「${label}」` : `📅 记了个${kind === 'watch' ? '看视频' : '定时任务'}：${who || '号主'}「${label}」`),
  });
}

/** 旧接口保留：约定 → 一条 kind:'say' 的 job（老测试/老调用不炸，仍写 type:'appointment'） */
export function addAppointment({ dueAt, peer, originText, originMsgId = '', who = '' }) {
  return addJob({ at: dueAt, kind: 'say', peer, originText, originMsgId, who });
}

/** 一条记录是不是定时任务（新 job 或老 appointment 都算） */
const isJob = (t) => t?.executor === 'bot' && (t.type === 'appointment' || t.type === 'job');
/** 兼容读时间：新字段 at 优先，退回旧 dueAt */
const jobTime = (t) => t.at || t.dueAt;
/** 兼容读动作：新字段 kind 优先，老约定没 kind 当 say */
const jobKind = (t) => t.kind || 'say';

// ─── 跨会话：目标解析 + 权限矩阵（三期）────────────────────

/**
 * 把"目标会话"翻成 peer。号主说"去测试群/发给我"时用。
 * @returns { peer } | { ambiguous: string[] } | { error: string } | null（没说目标=用来源会话）
 */
export async function resolveTarget(targetText, { isOwner = false, sourcePeer = '' } = {}) {
  const t = String(targetText || '').trim();
  if (!t || t === '这里' || t === '这儿') return null; // 没说目标/就地执行
  // 明确的目标 peer（面板/工具直接给的 g:xxx / p:xxx / owner）
  if (/^(g:\d+|p:\d+|owner)$/.test(t)) return { peer: t };
  // "我/号主/私聊我" → owner（号主视角）；别人说"私聊我"要用他的 QQ
  if (/^(我|号主|私聊|私聊我)$/.test(t)) return isOwner ? { peer: 'owner' } : { error: '没认出你的 QQ，说清楚发给谁' };
  // 纯数字：群名表里见过这个群号就当群（号主说「发到 1124893144 这个群」），否则当 QQ 号 p:xxx
  if (/^\d{5,12}$/.test(t)) {
    const groups = await import('../group-names.mjs');
    if (groups.readGroups()['g:' + t]) return { peer: 'g:' + t };
    return { peer: 'p:' + t };
  }
  // 群名 → 查表
  const groups = await import('../group-names.mjs');
  const hit = groups.findGroupByName(t);
  if (hit?.peer) return { peer: hit.peer };
  if (hit?.ambiguous) return { ambiguous: hit.ambiguous, error: `有几个群都叫这个名（${hit.ambiguous.join('、')}），说清楚是哪个` };
  return { error: `没找到叫「${t}」的群，让号主在面板「群名表」里填一下` };
}

/**
 * 权限矩阵（号主裁决）：号主全开；好友/群友只能群↔私，禁群跨群、禁冒用他人私聊。
 * @returns { ok: true } | { ok: false, error }
 */
export function checkPermission({ isOwner = false, sourcePeer = '', targetPeer = '' } = {}) {
  if (!targetPeer || targetPeer === sourcePeer) return { ok: true }; // 就地/没跨
  if (isOwner || sourcePeer === 'owner') return { ok: true }; // 号主全开（含群→群）
  const srcGroup = /^g:/.test(sourcePeer);
  const srcPrivate = /^p:/.test(sourcePeer);
  const tgtGroup = /^g:/.test(targetPeer);
  const tgtPrivate = /^p:/.test(targetPeer) || targetPeer === 'owner';
  if (srcGroup && tgtGroup) return { ok: false, error: '不能从一个群发到另一个群' };
  if (srcGroup && tgtPrivate) return { ok: true }; // 群友：群→私（自己）
  if (srcPrivate && (tgtGroup || tgtPrivate)) return { ok: true }; // 好友：私↔群/私
  return { ok: false, error: '这个跨法不让' };
}

// ─── 触发层（autopilot tick 每拍调）─────────────────────────

/**
 * 扫到期定时任务，按 kind 分发动作。不受自动养号开关影响。
 * 挂在 autopilot.mjs tick 开头，notify.flushPending 之后。
 */
export async function scanDueJobs(now = Date.now()) {
  const cfg = readConfig();
  if (cfg.appoint?.enabled === false) return; // 开关默认开（不设或 true 都跑）
  // 号主叫停了：不发闹钟不赴约（2026-11-18 号主裁决）——「先别吵」就是别主动开口。
  // 窗口内的任务保持 pending，解除后 30 秒内照常补发；超 1 小时的自然错过（和时辰错过同一语义）
  if (readPause(now)) return;
  // 崩在中途的「在看」任务：超过 15 分钟没结果就放回 pending，免得永远卡在执行中
  for (const t of readTasks()) {
    if (isJob(t) && t.status === 'in_progress' && t.kind === 'watch') {
      const since = Date.parse(t.claimedAt || t.firedAt || 0);
      if (Number.isFinite(since) && now - since > RUN_STALE_MS) {
        updateTask(t.id, { status: 'pending', claimedAt: null });
        logAction({ kind: 'appointment', source: 'auto', ok: false, detail: `看视频任务中断超过 15 分钟，重新排队：${(t.originText || '').slice(0, 30)}`, target: t.id });
      }
    }
  }
  const due = readTasks().filter((t) => {
    if (!isJob(t) || t.status !== 'pending') return false;
    const at = jobTime(t);
    return at && at <= now && now - at < STALE_MS;
  });
  if (!due.length) return;
  for (const j of due) {
    try {
      await fulfillJob(j, now);
    } catch (e) {
      console.error('[appoint] 兑现失败', e.message);
      logAction({ kind: 'appointment', source: 'auto', ok: false, detail: `定时任务失败：${e.message}`, target: j.id });
    }
  }
}

/** 旧入口保留：autopilot 里挂的是这个，转调新实现 */
export async function scanDueAppointments(now = Date.now()) {
  return scanDueJobs(now);
}

// ─── 发送层（分两条路径）────────────────────────────────────

/** 按 kind 分发动作；旧 fulfillAppointment 语义 = say */
async function fulfillJob(j, now = Date.now()) {
  const kind = jobKind(j);
  // 单条动作失败不往外抛：一次性任务标 fired 就结（别无限重试刷屏），daily 照样推进到明天——
  // 今天没发成是今天的事，不该把每天的任务永远卡在 pending（旧逻辑一抛错就卡死了）
  // 看视频耗时较久，先标「在看」+认领时刻，面板能显示进度，崩了也有兜底重排
  if (kind === 'watch') updateTask(j.id, { status: 'in_progress', claimedAt: nowIso() });
  let done;
  try {
    done = kind === 'watch' ? await doWatch(j)
      : kind === 'task' ? await doTask(j)
        : await doSay(j);
  } catch (e) {
    done = { note: `执行失败：${e.message}` };
  }
  // 看视频失败：静默、标 failedAt 让超时扫描/催促兜底；其它动作失败照旧 fired 结掉
  const watchFailed = kind === 'watch' && done.ok === false;
  updateTask(j.id, {
    status: watchFailed ? 'failed' : 'fired',
    ...(watchFailed ? { failedAt: nowIso(), progressReported: false } : { firedAt: nowIso() }),
    resultNote: done.note || '',
  });
  logAction({ kind: 'appointment', source: 'auto', ok: !watchFailed, detail: `📮 定时任务(${kind})：${done.note || done.text || ''}`.slice(0, 120), target: j.id, meta: { peer: j.peer, targetPeer: j.targetPeer, who: j.who, kind } });
  // 重复任务：不终结，推进到下一次（30 天到期自动停）
  if (j.repeat === 'daily') advanceDaily(j, now);
}

async function doSay(j) {
  const originText = j.originText;
  const who = j.who;
  const whoQq = j.whoQq;
  const target = j.targetPeer || j.peer; // 跨会话：发往目标会话；旧数据没 targetPeer=peer，照旧
  let text;
  if (!target || target === 'owner') {
    // 号主闹钟：不过仲裁，直发
    text = await draftOwnerLine(originText);
    const { rawSend } = await import('../notify.mjs');
    await rawSend(text);
  } else {
    // 赴约：@ 约你的人（认人，不广泛赴约）；群里用 [TO:]，sendText 自动转 @
    // 跨会话时约你的人不一定在目标群，硬 @ 会落空——不缀 [TO:]，让话自己说清是冲谁
    const crossSession = j.sourcePeer && j.sourcePeer !== target;
    text = await draftHonorLine({ originText, who, peer: crossSession ? j.sourcePeer : target });
    const at = !crossSession && (who || whoQq) ? `[TO:${who || whoQq}] ` : '';
    const qq = await import('./index.mjs'); // 动态 import 破循环依赖
    await qq.sendText(at + text, 'appointment', target);
  }
  return { text, note: text };
}

/** 看指定 B站 视频（仅号主建这种任务，建的地方已挡；这里再兜一层）
 *  走安静专用链路：只认真看这一条 + 拉字幕总结，不评论/分享、不碰日常排班的锁。
 *  看完自己发一条 QQ 汇报（去重在工具层按 bvid 做）——不再连环报「看错了/等下补」。 */
/** 定时看视频前给时辰会话让路：B站 登录态和播放心跳是共享的，并发互踩。
 *  最多等 10 分钟——刻意小于 15 分钟的 stale 重排窗（RUN_STALE_MS），等待中不会被误判「崩了」放回 pending。
 *  等满上限还忙就并发看（watchAndSummarize 本来就是单视频轻量链路）。依赖可注入，测试用。 */
export async function waitTurnForBili({ isBusy, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), maxMs = 10 * 60_000, stepMs = 10_000 } = {}) {
  const auto = await import('../autopilot.mjs');
  const busy = isBusy || (() => auto.liveStatus().running);
  const t0 = Date.now();
  while (busy() && Date.now() - t0 < maxMs) await sleep(stepMs);
}

async function doWatch(j) {
  // 风控冷却期间不碰 B站（2026-11-18 号主裁决）：冷却中打接口只会加重风控。
  // 不看 + 告知号主（QQ 说不上——比如他一小时没说话——也不挡，面板活动里有记录兜底）
  const st = readState();
  if (st.cooldownUntil && Date.now() < st.cooldownUntil) {
    const until = new Date(st.cooldownUntil).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false });
    try { logAction({ kind: 'appointment', source: 'auto', ok: false, detail: `⚠️ 风控冷却挡下了定时看视频「${(j.originText || j.jobPayload?.bvid || '').slice(0, 30)}」（冷却到 ${until}），没看`, target: j.id }); } catch { /* 日志不挡正事 */ }
    try {
      const { rawSend } = await import('../notify.mjs');
      await rawSend(`⏳ 到点想看的视频没看成：B站 风控冷却中（到 ${until}），冷却完了想看再叫我一声`);
    } catch { /* 号主最近没在 QQ 说话，机器人主动开口被 QQ 拦了；面板活动里已经留了记录 */ }
    return { ok: false, note: `风控冷却中（到 ${until}），没看，QQ 里说了一声` };
  }
  if (j.sourcePeer !== 'owner' && j.peer !== 'owner') {
    return { note: '看视频任务只对号主开放，跳过' };
  }
  const bvid = String(j.jobPayload?.bvid || '');
  if (!bvid) return { note: '没记下要看的视频号，跳过' };
  await waitTurnForBili(); // 时辰会话在刷就先让路（共享登录态/心跳，并发互踩；最多 10 分钟）
  const auto = await import('../autopilot.mjs');
  const r = await auto.watchAndSummarize({ bvid, request: j.originText || j.jobPayload?.request || '' });
  if (r.ok) {
    const notify = await import('../notify.mjs');
    await notify.reportTask(
      { id: j.id, note: j.originText || `看《${bvid}》`, reportPeers: j.reportPeers || [j.peer || j.sourcePeer || 'owner'] },
      { ok: true, note: r.summary, watched: r.watched || [] },
    ).catch(() => {});
  }
  // 失败静默：带 ok=false 回去让 fulfillJob 标失败态 + failedAt，交给超时扫描/催促兜底
  return { note: r.summary, ok: r.ok };
}

/** 交后台干活，做完让 notify.reportTask 回报 QQ */
async function doTask(j) {
  const auto = await import('../autopilot.mjs');
  const { addTask, updateTask: ut } = await import('../store.mjs');
  const t = addTask({ type: j.jobPayload?.taskType || 'custom', note: String(j.jobPayload?.taskNote || j.originText || '').slice(0, 200), executor: 'panel', source: 'bot', report: 'qq' });
  try {
    await auto.runTask(t);
    return { note: `后台活做完了：${t.type}` };
  } catch (e) {
    return { note: `后台活没做成：${e.message}` };
  }
}

/** 起止两个时间戳之间跨了几个自然日（按本地日历天算，跨天即 +1，跟响没响成无关） */
function naturalDays(startMs, nowMs) {
  const a = new Date(startMs), b = new Date(nowMs);
  return Math.round((Date.UTC(b.getFullYear(), b.getMonth(), b.getDate()) - Date.UTC(a.getFullYear(), a.getMonth(), a.getDate())) / DAY_MS);
}

/** daily 任务推进到明天同一时刻，到日子自动停：
 *  - 写了 days（连着 N 天，号主裁决最多 30 天、按自然日）：从 startedAt 自然日起算，第 N 天这次响完就停
 *  - 没写 days（老任务/老的"每天"）：沿用满 30 天自动停 */
function advanceDaily(j, now = Date.now()) {
  const at = jobTime(j);
  const started = j.startedAt || at; // 老数据没 startedAt：以首次（当前）触发时刻为基准
  if (j.days >= 1) {
    // 第 1 天：started 当天，响完算跨 0 个自然日；第 N 天：跨了 N-1 个自然日 → 这次响完就停
    if (naturalDays(started, now) >= j.days - 1) {
      updateTask(j.id, { status: 'cancelled', cancelledAt: nowIso(), firedAt: null, cancelReason: `连着 ${j.days} 天到期自动停` });
      logAction({ kind: 'appointment', source: 'auto', detail: `每天的任务连着跑了 ${j.days} 天，自己停了：${(j.originText || '').slice(0, 30)}`, target: j.id });
      return;
    }
  } else if (now - started >= DAILY_MAX_AGE_MS) {
    updateTask(j.id, { status: 'cancelled', cancelledAt: nowIso(), firedAt: null, cancelReason: 'daily 满 30 天自动停' });
    logAction({ kind: 'appointment', source: 'auto', detail: `每天的任务连着跑了 30 天，自己停了：${(j.originText || '').slice(0, 30)}`, target: j.id });
    return;
  }
  const next = at + DAY_MS;
  updateTask(j.id, { status: 'pending', at: next, dueAt: next, nextAt: next, firedAt: null, startedAt: started });
}

/** 中止入口：把某人某来源会话下的 daily 任务停掉（被赴约人喊"不用继续了"时调）。
 *  只动 daily、只动同一发起人+来源会话，不碰一次性约定、不误伤别人。返回停掉的条数。 */
export function cancelDaily({ peer, who = '', whoQq = '' } = {}) {
  const live = readTasks().filter((t) => isJob(t) && t.repeat === 'daily' && t.status === 'pending');
  let n = 0;
  for (const t of live) {
    // 来源会话匹配：优先 sourcePeer，退回 peer
    const src = t.sourcePeer || t.peer;
    if (peer && src !== peer) continue;
    // 发起人匹配：有 who 时对上 who / whoQq；都没记就宽松放过（老数据缺字段不能因此停不掉）
    if (who || whoQq) {
      const hit = [t.who, t.whoQq].some((v) => v && (v === who || v === whoQq));
      if (!hit) continue;
    }
    updateTask(t.id, { status: 'cancelled', cancelledAt: nowIso(), cancelReason: '被发起人中止' });
    n++;
  }
  return n;
}

/** 旧入口转调：约定 = say */
async function fulfillAppointment(a) {
  return fulfillJob({ ...a, kind: 'say' });
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
    { role: 'system', content: `${llm.PERSONA}\n${who || '有人'}之前约你：「${originText}」。到点了，你在${where}主动说一句，赴约。简短、像真人开口，别像系统通知。只对约你的${who || '这个人'}说、冲着他来，不是群公告、别对着一群人广泛喊话；只聊跟这个人有关的事，别串到别的。${ctx}` },
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
  // 别人说的、最近 24 小时内的、指向她的：叫昵称，或含明确约定/时间句式都算（放宽后群友不叫昵称也认）
  const cut = now - 86400_000;
  const directed = readChat(peer).filter((e) =>
    e.from !== 'her' && e.kind !== 'reset' &&
    Date.parse(e.ts) > cut &&
    (DIRECT_RE.test(String(e.text || '')) || APPOINT_HINT_RE.test(String(e.text || ''))),
  );
  if (directed.length < 1) return; // 指向她的都没有就不扫
  const lines = directed.map((e, i) => `${i + 1}. ${e.name || '有人'}：${String(e.text).slice(0, 100)}`).join('\n');
  const out = await llm.chat([
    { role: 'system', content: `${llm.PERSONA}\n从下面的聊天里挑出两样东西：① 指向你的约定（含明确时间/事件的句子）；② 有人喊停每日任务的话（"不用叫了/别提醒了/取消每天那个"）。只输出 JSON。` },
    { role: 'user', content: `当前时间：${new Date(now).toLocaleString('zh-CN')}\n聊天（${peer}）：\n${lines}\n\n两类分开抽：
A. 约定，每条：{"text":"对方原话","dueAt":"ISO时间字符串","who":"说话人","msgId":"序号","repeat":"daily或once","days":"连着几天","target":"目标会话"}
   - "每天几点/每个工作日几点/天天叫我" → repeat 填 daily，dueAt 填今天或最近的那个未来时刻（作为第一次），days 不填
   - "连着N天/后面N天/接下来N天每天几点" → repeat 填 daily，days 填 N（最多30），dueAt 填第一次的未来时刻
   - "明天几点/今晚/明早" 一次性 → repeat 填 once
   - target：对方明确说了"去X群/在X群发/私聊我"才填群名或"私聊"，没说就不填（就地回这句所在的会话）
   - 只抽含明确时间的；时间算不准的不抽；dueAt 必须是未来。
B. 喊停每日任务，每条：{"stopWho":"说话人","msgId":"序号"}——只有明确说"别再叫了/取消每天提醒/不用继续了"才抽，普通闲聊别抽。
输出：{"appointments":[...],"stops":[...]}` },
  ], { maxTokens: 500, tag: 'mind' });
  let j = null;
  try { j = llm.looseJson(out); } catch { return; } // 坏 JSON 不炸
  // 二期B：先处理喊停——只停这个会话里、这个发言人的 daily，不碰一次性约定
  const stops = Array.isArray(j?.stops) ? j.stops : [];
  for (const s of stops) {
    const stopWho = String(s.stopWho || '').slice(0, 30);
    const n = cancelDaily({ peer, who: stopWho });
    if (n) logAction({ kind: 'appointment', source: 'auto', detail: `${stopWho || '有人'}说不用继续了，停了 ${n} 条每天的任务`, target: peer });
  }
  const items = (j && Array.isArray(j.appointments) ? j.appointments : [])
    .map((x) => ({
      text: String(x.text || '').slice(0, 200),
      dueAt: parseDueAt(x.dueAt, now),
      who: String(x.who || '').slice(0, 30),
      msgId: String(x.msgId || ''),
      repeat: x.repeat === 'daily' ? 'daily' : 'once',
      days: Number(x.days) >= 1 ? Math.min(DAILY_MAX_DAYS, Math.floor(Number(x.days))) : 0,
      target: String(x.target || '').slice(0, 60),
    }))
    .filter((x) => x.text && x.dueAt && x.dueAt > now && x.dueAt < now + FUTURE_LIMIT_MS);
  for (const x of items) {
    // 跨会话：群友/好友的目标解析 + 权限校验；解析不了就不建（宁可问一句，别发错群）
    let targetPeer = peer;
    if (x.target) {
      const resolved = await resolveTarget(x.target, { isOwner: false, sourcePeer: peer });
      if (resolved?.peer) targetPeer = resolved.peer;
      else { logAction({ kind: 'appointment', source: 'auto', ok: false, detail: `跨会话约定没建：${resolved?.error || '目标没认出来'}`, target: peer }); continue; }
      const perm = checkPermission({ isOwner: false, sourcePeer: peer, targetPeer });
      if (!perm.ok) { logAction({ kind: 'appointment', source: 'auto', ok: false, detail: `跨会话约定没建：${perm.error}`, target: peer }); continue; }
    }
    addJob({ at: x.dueAt, kind: 'say', peer, sourcePeer: peer, targetPeer, repeat: x.repeat, days: x.days, originText: x.text, originMsgId: x.msgId, who: x.who });
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

/** 面板 /api/appointments 用：返回待兑现/已兑现/已过期（新旧任务都认，带 kind 供面板显示动作类型） */
export function listAppointments() {
  const now = Date.now();
  const all = readTasks().filter(isJob).map((t) => ({ ...t, kind: jobKind(t), at: jobTime(t) }));
  return {
    // 在看（in_progress 的 watch）也列进待执行区，前端按 status 显示「在看」
    pending: all.filter((t) => (t.status === 'pending' || (t.status === 'in_progress' && jobKind(t) === 'watch')) && (t.at || 0) > now - STALE_MS),
    fired: all.filter((t) => t.status === 'fired').slice(-20),
    expired: all.filter((t) => t.status === 'pending' && t.at <= now - STALE_MS),
  };
}
