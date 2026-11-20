/**
 * QQ 小号接入（面板进程里跑）
 *
 * 配置在 autopilot.json 的 qq 段（面板「自动养号 → QQ 连接」），token 在 secrets.json。
 * mode = onebot 时：连 NapCat → 只理号主（ownerQQ）的私聊 → brain.reply → 发回去。
 * 只认号主（默认）：别人私聊一律不理（只记一笔），群消息不看。
* 公共模式（qq.audience = 'public'）：好友私聊都聊，群里被@才回（回时带上@）。
 *
 * notify.mjs 发提醒、汇报、分享时也走这里（sendOwner）：小号能主动发，不用等号主先开口。
 */
import { randomUUID } from 'node:crypto';
import { OneBot, seg, readMessage, imageSegments, atMe, resolveReplyName } from './onebot.mjs';
import * as brain from './brain.mjs';
import * as sqmusic from './sqmusic.mjs';
import * as dsh from './dsh.mjs';
import * as owner from './owner.mjs';
import { tuning } from './tuning.mjs';
import { jitterDelay, gateJitter } from './jitter.mjs';
import { decideRate, calmMs, exemptKey } from './rate.mjs';
import { pokeFresh, pokeWindowMs, lastRealChatTs } from './poke-fresh.mjs';
import * as memory from '../memory.mjs';
import * as recallCheck from '../recall-check.mjs';
import * as fav from '../fav.mjs';
import * as friends from '../friends.mjs';
import * as llm from '../llm.mjs';
import * as memeimg from '../memeimg.mjs';
import { readConfig, readSecrets, readState, writeState, logAction, localDate, nowIso } from '../store.mjs';

let bot = null;
const convs = new Map(); // 每个对话一套：'owner'（号主）/ 'p:QQ号'（好友私聊）/ 'g:群号'（群）→ { queue, timer, busy, lastQq }
const userFreeRate = new Map(); // 自由插嘴按人限流的记账：'peer:QQ号' → 最近几次过闸的时间戳（内存态，重启清零没关系）
const herFreeRate = new Map(); // 她自己的熔断记账：peer → 她最近几次自由插嘴的时间戳（防跟别的模型对刷，内存态）
const exemptDaily = new Map(); // C2 每日豁免上限：'peer:QQ号:日期' → 今天点名叫她已放行几次（跨天换 key 自动清零）
const attackHits = new Map();  // C2 冷静窗：'peer:QQ号' → 最近几次怼/复读的时间戳
const calmUntil = new Map();   // C2 冷静窗：'peer:QQ号' → 冷静到几毫秒（期间自由插嘴全拦）
const conv = (peer) => { if (!convs.has(peer)) convs.set(peer, { queue: [], timer: null, busy: false, lastQq: null, seenImgs: [] }); return convs.get(peer); };
// 防抖延时加可控抖动：默认参数下原样返回目标值，零回归。配置关着时连随机都不消耗。
const debounceMs = (base) => jitterDelay(base, gateJitter(tuning().gate));
// 她看过的图按对话留 3 分钟：人家常常发完图、隔一句才说「存成表情包」，那时图也得还在手上
const rememberImgs = (peer, imgs) => {
  if (!imgs.length) return;
  const c = conv(peer);
  c.seenImgs = [...c.seenImgs, ...imgs.map((buf) => ({ buf, ts: Date.now() }))].slice(-6);
};
const freshImgs = (c) => c.seenImgs.filter((x) => Date.now() - x.ts < 3 * 60_000).map((x) => x.buf).slice(-3);
// 号主这个对话也走 convs，跟别人的互不耽误
let ticker = null;
const strangers = new Set();

export const directOn = (cfg = readConfig().qq) => cfg.mode === 'onebot' && !!cfg.ownerQQ;
export const connected = () => !!bot?.state.connected;

export function start() {
  stop();
  const cfg = readConfig().qq;
  if (!directOn(cfg)) return;
  bot = new OneBot({ url: cfg.wsUrl, token: readSecrets().onebotToken || '' });
  bot.on('ready', (r) => logAction({ kind: 'qq', source: 'auto', detail: `QQ 小号连上了（${r?.nickname || ''} ${r?.user_id || ''}）` }));
  bot.on('close', () => {
    logAction({ kind: 'qq', source: 'auto', ok: false, detail: 'QQ 小号断开了，会自己重连' });
    import('../alert.mjs').then((m) => m.alert('qq:ws-close', 'QQ 小号断开了（会自重重连；6 小时内不重复提醒）')).catch(() => {});
  });
  bot.on('message', (ev) => onMessage(ev).catch((e) => console.error('[qq]', e)));
  bot.on('event', (ev) => {
    onRequest(ev).catch((e) => console.error('[qq] 申请', e));
    onNotice(ev).catch((e) => console.error('[qq] 拍一拍', e));
  });
  bot.start();
  ticker = setInterval(() => tick().catch((e) => console.error('[qq] tick', e.message)), 60_000);
}

export function stop() {
  bot?.stop();
  bot = null;
  clearInterval(ticker);
  ticker = null;
}

export function status() {
  const cfg = readConfig().qq;
  const last = owner.lastFrom('owner');
  return {
    mode: cfg.mode, on: directOn(cfg), connected: connected(), selfId: bot?.state.selfId || null,
    since: bot?.state.since || null, error: bot?.state.error || '', startedAt: bot?.state.startedAt || null,
    lastOwnerAt: last ? Date.parse(last.ts) : null, hasToken: !!readSecrets().onebotToken,
    facts: owner.readFacts(),
    dsh: dsh.status(),
  };
}

/** NapCat 有时把同一个申请推好几遍（重连、多端同步），按 flag 去重：处理过的 10 分钟内不再碰 */
const seenReq = new Map();
const onceReq = (flag) => {
  if (!flag) return true;
  const now = Date.now();
  for (const [k, t] of seenReq) if (now - t > 600_000) seenReq.delete(k);
  if (seenReq.has(flag)) return false;
  seenReq.set(flag, now);
  return true;
};

/** 好友申请 / 群邀请：公共模式她自己通过（想交朋友嘛）；只认号主模式就不动，留着号主手机上自己点 */
async function onRequest(ev) {
  if (ev.post_type !== 'request') return;
  if (!onceReq(String(ev.flag || ''))) return;
  const pub = readConfig().qq.audience === 'public';
  if (ev.request_type === 'friend') {
    const who = `${ev.user_id}${ev.comment ? `（验证消息：${String(ev.comment).slice(0, 40)}）` : ''}`;
    if (!pub) { logAction({ kind: 'qq', source: 'auto', detail: `有人申请加好友，没理（现在只认号主）：${who}` }); return; }
    try {
      await bot.call('set_friend_add_request', { flag: ev.flag, approve: true });
      logAction({ kind: 'qq', source: 'auto', detail: `🤝 通过了好友申请：${who}` });
    } catch (e) { logAction({ kind: 'qq', source: 'auto', ok: false, error: e.message, detail: `通过好友申请没成：${who}` }); }
    return;
  }
  if (ev.request_type === 'group' && ev.sub_type === 'invite') { // add 是别人申请进她管的群，她不是管理，管不了
    if (!pub) { logAction({ kind: 'qq', source: 'auto', detail: `${ev.user_id} 想拉她进群 ${ev.group_id}，没理（现在只认号主）` }); return; }
    try {
      await bot.call('set_group_add_request', { flag: ev.flag, sub_type: ev.sub_type, approve: true });
      logAction({ kind: 'qq', source: 'auto', detail: `👥 ${ev.user_id} 拉她进群 ${ev.group_id}，去了` });
    } catch (e) { logAction({ kind: 'qq', source: 'auto', ok: false, error: e.message, detail: `进群 ${ev.group_id} 没成` }); }
  }
}

// ─── 拍一拍（notify.poke） ────────────────────────────────────
const pokeLast = new Map(); // 同一个人连拍：60 秒内只当一次，免得被人拍着玩刷屏
const friendName = (qq) => friends.readFriends().friends?.[String(qq)]?.name || String(qq);
/** 拍一拍时间闸：上一句话距今太久就当随手戳一下，不回看旧账。返回 true=该忽略。
 *  取上一句要在 queue() 写「拍了拍」占位符之前——所以调用点必须排在入队前。 */
function pokeTooStale(peer, who) {
  const g = tuning().gate;
  const windowMs = pokeWindowMs(g);
  if (!(windowMs > 0)) return false; // 闸关着：老行为，照回
  const lastTs = lastRealChatTs(owner.recentChat(12, Date.now(), peer));
  const d = pokeFresh({ lastTs, now: Date.now(), windowMs });
  if (!d.allow) {
    try { logAction({ kind: 'gate', source: 'auto', detail: `🫵 拍一拍没回：上一句距今 ${Math.round(d.gapMs / 1000)} 秒，超过这次的 ${Math.round(d.windowMs / 1000)} 秒窗口`, meta: { verdict: '拍得太晚', peer, who, gapMs: d.gapMs, windowMs: d.windowMs } }); } catch { /* 日志不挡正事 */ }
    return true;
  }
  return false;
}
/** 拍到她身上就当她被 @ 了一下，让她接一嘴；拍别人的只在群日志里记一笔当背景。私聊拍一拍也认（号主随时，好友要公共模式） */
async function onNotice(ev) {
  if (ev.post_type !== 'notice' || ev.notice_type !== 'notify' || ev.sub_type !== 'poke') return;
  const me = String(bot?.state.selfId ?? '');
  const from = String(ev.user_id ?? '');
  if (!me || !from || from === me) return; // 她自己拍的不算
  const cfg = readConfig().qq;
  const pub = cfg.audience === 'public';
  const toMe = String(ev.target_id ?? '') === me;
  const POKE = (name) => `（${name ? name + '拍了拍你' : '拍了拍你'}）`;
  // 拍一拍不当对话内容、不对拍本身做反应：它是喊她回头看刚才没接的话，没有可接的就应一声（2026-11-10 号主定的）
  const POKE_INPUT = (name) => `${POKE(name)}——拍一拍是喊你回头看一眼刚才的话，不是让你评价这一下：有没接上的就接那句，真没有就应一声`;
  const queue = (peer, name, qq) => {
    const fid = randomUUID();
    owner.logChat({ from: 'owner', text: POKE(name), peer, name, fid });
    const c = conv(peer);
    if (qq) c.lastQq = qq;
    c.queue.push({ text: POKE_INPUT(name), ts: Date.now(), name, fid });
    clearTimeout(c.timer);
    c.timer = setTimeout(() => flush(peer).catch((e) => console.error("[qq] flush", e)), debounceMs(tuning().gate.debouncePrivateMs));
  };
  if (ev.group_id) {
    if (!pub) return; // 只认号主时，群里的动静整个不看
    const peer = 'g:' + ev.group_id;
    const name = friendName(from);
    if (!toMe) { owner.logChat({ from: 'owner', text: `（${name}拍了拍${friendName(ev.target_id)}）`, peer, name }); return; } // 拍别人：记一笔就行，不接茬
    const key = `${peer}:${from}`;
    if (Date.now() - (pokeLast.get(key) || 0) < 60_000) return;
    if (pokeTooStale(peer, name)) return; // 上一句太久没接：不回看旧账
    pokeLast.set(key, Date.now());
    queue(peer, name, ev.user_id);
    return;
  }
  if (!toMe) return;
  if (!pub && from !== String(cfg.ownerQQ)) return; // 只认号主：别人拍也不理
  const dpeer = from === String(cfg.ownerQQ) ? 'owner' : 'p:' + from;
  const key = `poke:${from}`;
  if (Date.now() - (pokeLast.get(key) || 0) < 60_000) return;
  if (pokeTooStale(dpeer, from === String(cfg.ownerQQ) ? '号主' : friendName(from))) return;
  pokeLast.set(key, Date.now());
  queue(dpeer, '', null);
}

// ─── 收 ────────────────────────────────────────────────────
async function onMessage(ev) {
  const cfg = readConfig().qq;
  const pub = cfg.audience === 'public';
  // 群里（公共模式）：所有消息都记进她的群日志（@ 别人时她接话才接得上，不然跟谁都聊岔），
  // @ 到她的按 groupAt 回；没 @ 的只有开了 groupFree 才送到她眼前，让她自己定要不要插嘴。只认号主时群消息整个不看。
  if (ev.message_type === 'group') {
    if (!pub) return;
    // 顺手记群号（群名表用，跨会话执行要按名字翻 g:群号）；失败不挡收消息
    try {
      const groups = await import('../group-names.mjs');
      groups.noteGroup('g:' + ev.group_id, { name: ev.group_name || '' });
    } catch { /* 记不住不影响聊天 */ }
    const at = atMe(ev, bot?.state.selfId);
    // 带上「引用/回复谁」的前缀（@ 她自己那段由 atMe 判，这里跳过），别让模型把回别人的话当成冲她。
    // NapCat 的 reply 段只有消息 id，先反查原消息 sender 拿名字；查不到照旧标「引用了一条消息」，不挡收消息。
    const replyName = await resolveReplyName(bot, ev, friendName);
    let text = readMessage(ev, bot?.state.selfId, friendName, replyName);
    // @ 带图才看（跟私聊一样走「看图模型」）；开了插嘴就没@的图也看——她既然在旁边听大家聊，看不见图就接不上话。视频不看
    const vmod = String(cfg.visionModel || '').trim();
    let imgs = [];
    let metas = [];
    if (text.includes('[图片]') && vmod && (at || cfg.groupFree)) ({ text, imgs, metas } = await seeImages(ev, text));
    rememberImgs('g:' + ev.group_id, imgs);
    // 剩下的 [图片]/[视频] 占位符剥掉，免得她盯着「[图片]」说看不清；剥完没剩字就不记（表情包摘要留着，能自然接梗）
    text = text.replace(/\[图片\]|\[视频\]/g, '').replace(/\s+/g, ' ').trim();
    if (!text && at) text = '（@了你，什么都没说）'; // 光 @ 不出声也是在叫她，别剥完占位符就当没听见
    const name = ev.sender?.card || ev.sender?.nickname || '';
    const peer = 'g:' + ev.group_id;
    const fid = randomUUID();
    // 号主在群里发 /new：只重置这个群的上下文（跟私聊 /new 一样）——大改人格卡后，历史里
    // 全是她旧风格的回复，会压过新卡的比例控制，重开一次才从新卡起跑
    if (/^\/(new|重来|清空)$/.test(text) && String(ev.user_id) === String(cfg.ownerQQ)) {
      owner.resetContext(peer);
      await sendText('好，那我们重新开始聊～', 'report', peer).catch(() => {});
      return;
    }
    if (text) {
      owner.logChat({ from: 'owner', text, peer, name, fid });
      friends.touch(ev.user_id, name, peer); // 群里说话的人也进朋友圈档案，群里群外对得上号
    }
    if (!text) return;
    // 回不回的两个开关：groupAt 管「@了回不回」，groupFree 管「没@也让模型自己看要不要插嘴」
    const wantAt = at && cfg.groupAt !== false;
    const wantFree = !at && !!cfg.groupFree;
    if (!wantAt && !wantFree) return;
    // 机器人名单：群里其他模型的消息有问有答、句句像「该接的」，权重怎么调都会互刷。
    // 2026-11-19 号主改口径：名单里的人只有 @ 她才接；叫名字 / 短指令 / 怼她都不再放行。
    // 提前到打分前拦，连 review 仲裁的模型调用都不烧。
    const botList = String(Array.isArray(cfg.botQQs) ? cfg.botQQs.join(',') : cfg.botQQs || '').split(/[,，\s]+/).filter(Boolean).map(String);
    const isBot = botList.includes(String(ev.user_id));
    if (isBot && !at) {
      try { logAction({ kind: 'gate', source: 'auto', detail: `🤖 机器人名单：${name || ev.user_id} 没 @ 她，不接「${text.slice(0, 30)}」`, meta: { verdict: '拦下', text: String(text || '').slice(0, 60), peer, who: name || String(ev.user_id), bot: true } }); } catch { /* 日志不挡正事 */ }
      return;
    }
    let decision = null; // 自由插嘴的打分结果：闸里用，下面的限流豁免也用（不走过闸就是 null）
    if (!at && cfg.groupFree) {
      decision = brain.topicScoreMessage(text, peer, !!imgs.length, metas);
      // 每条自由插嘴的判定都落日志：分数、命中项、走没走仲裁——调参时全靠这份账。
      // kind=gate 独立成类（面板「插嘴裁决」板块），meta 带结构化字段方便板块直接画
      const logGate = (verdict, extra = '') => {
        try { logAction({ kind: 'gate', source: 'auto', detail: `🎯 插嘴${verdict}：${decision.score} 分（${decision.reasons.join('、')}）${extra}「${text.slice(0, 30)}」`, meta: { verdict, score: decision.score, status: decision.status, reasons: decision.reasons, text: String(text || '').slice(0, 120), peer } }); } catch { /* 日志不挡正事 */ }
      };
      if (decision.status === 'skip') {
        logGate('拦下');
        return; // 低价值情绪 / 低新鲜度 / 无新信息：直接排除，不刷屏
      }
      // review（2.8~4.8 分）拿不准：配了 reviewModel 就让模型再筛一道，说「不接」才放走；
      // 没配 / 模型没回话都照旧进池——这道闸只减误插嘴，不添装死
      if (decision.status === 'review' && !(await brain.reviewJoin(text, peer))) { logGate('仲裁拦下', '· 仲裁说不接 '); return; }
      logGate(decision.status === 'review' ? '仲裁放行' : '过闸');
    }
    // （她自己的熔断不在收条时判了：那会儿还不知道她会不会 SKIP，热群里光看不说也会把名额耗光。
    //  挪到 flush 里出手前判、真说了才计数——见 flush()。名单里已提前硬拦，这道兜的是名单外模型的互刷）
    // 按人限流（独立于打分的硬兜底，防「每 30 秒一句蠢鱼」的钓鱼刷屏）：同一人在窗口期内
    // 只能让她自由插嘴这么多次；@ 她的、私聊、点名叫她的（指向你/被点名怼/短指令）不受限——
    // 那是点名不是刷屏，限流把「鲸鲸！」「不理我了」这种连着叫她的也拦掉，就成了当面装死
    if (!at) {
      const reasons = (decision?.reasons || []);
      const called = !wantFree || reasons.some((r) => /指向你|被点名怼|短指令/.test(r));
      const G = tuning().gate;
      const rk = `${peer}:${ev.user_id}`;
      const nowTs = Date.now();
      // C2 记账快照：攻击/怼按冷静窗长度内的计数（旧的自动过期），豁免按当天，限流按人窗口
      const attacks = (attackHits.get(rk) || []).filter((t) => nowTs - t < calmMs(G));
      const d = decideRate({
        called, reasons, g: G,
        exemptUsed: exemptDaily.get(exemptKey(peer, ev.user_id)) || 0,
        rateHits: (userFreeRate.get(rk) || []).filter((t) => nowTs - t < G.userRateWindowMin * 60_000).length,
        calmUntil: calmUntil.get(rk) || 0,
        attackHits: attacks.length,
      });
      // 落账：豁免次数、怼/复读时间戳、开新冷静窗
      if (d.exempt) { const k = exemptKey(peer, ev.user_id); exemptDaily.set(k, (exemptDaily.get(k) || 0) + 1); }
      if (d.attack) { attacks.push(nowTs); attackHits.set(rk, attacks); }
      if (d.calm) { calmUntil.set(rk, nowTs + calmMs(G)); attackHits.delete(rk); }
      if (d.allow && !called) { // 放行且是普通自由插嘴：记一次按人限流窗口（called 的不占这个名额）
        const hits = (userFreeRate.get(rk) || []).filter((t) => nowTs - t < G.userRateWindowMin * 60_000);
        hits.push(nowTs); userFreeRate.set(rk, hits);
      }
      if (!d.allow) {
        const label = { '冷静窗': '冷静窗里先不搭', '冷静·触发': '总怼/复读，歇一会儿', '豁免用尽': '今天叫她太多次了', '限流': `${G.userRateWindowMin} 分钟已回 ${G.userRateMax} 次` }[d.verdict] || d.verdict;
        try { logAction({ kind: 'gate', source: 'auto', detail: `🎯 ${label}：${name || ev.user_id} 这句不接了「${text.slice(0, 30)}」`, meta: { verdict: d.verdict, text: String(text || '').slice(0, 60), peer, who: name || String(ev.user_id) } }); } catch { /* 日志不挡正事 */ }
        return;
      }
    }
    const c = conv(peer);
    c.lastQq = ev.user_id;
    c.queue.push({ text, ts: Date.now(), name, fid, imgs, qq: ev.user_id, free: !at }); // free 的批次她可以选择不吭声（SKIP）；qq 记说话的人，好感单人批次才记分用
    clearTimeout(c.timer);
    // 群聊节奏快，防拆条等 1.2 秒就够（等久了回复落地时又被新消息超过，永远慢一拍）；私聊他爱连发，仍等 2.5 秒
    c.timer = setTimeout(() => flush(peer).catch((e) => console.error("[qq] flush", e)), debounceMs(tuning().gate.debounceGroupMs));
    return;
  }
  if (ev.message_type !== 'private') return;
  const isOwner = String(ev.user_id) === String(cfg.ownerQQ);
  // 只认号主：别人私聊一律不理，一天只记一次
  if (!isOwner && !pub) {
    const key = `${localDate()}:${ev.user_id}`;
    if (!strangers.has(key)) { strangers.add(key); logAction({ kind: 'qq', source: 'auto', detail: `有人（${ev.user_id}）私聊小号，没理` }); }
    return;
  }
  const replyName = await resolveReplyName(bot, ev, friendName);
  let text = readMessage(ev, bot?.state.selfId, friendName, replyName);
  if (!text) return;
  // 图片先让能看图的模型看一眼，把「[图片]」换成她看到的样子：开了 DSH 走 DSH，没开就走「看图模型」直连接口
  const vmod = String(cfg.visionModel || '').trim();
  if (text.includes('[图片]') && !vmod) console.error('[qq] 收到图片，但「看图模型」是空的，直接不看图（面板「QQ 连接 → 看图模型」里填）');
  let imgs = [];
  if (text.includes('[图片]') && vmod) ({ text, imgs } = await seeImages(ev, text)); // 看图只看「看图模型」配没配（固定走 ModelScope），不看 DSH 开关
  const peer = isOwner ? 'owner' : 'p:' + ev.user_id;
  rememberImgs(peer, imgs);
  const c = conv(peer);
  if (isOwner && /^\/(new|重来|清空)$/.test(text)) {
    owner.resetContext();
    await sendText('好，那我们重新开始聊～');
    return;
  }
  const fid = randomUUID();
  owner.logChat({ from: 'owner', text, peer, fid });
  if (!isOwner) friends.touch(ev.user_id, ev.sender?.card || ev.sender?.nickname || ''); // 好友也进朋友圈档案
  c.queue.push({ text, ts: Date.now(), name: ev.sender?.card || ev.sender?.nickname || '', fid, imgs }); // 好感档案记名字用，多人时不至于一排裸 QQ 号
  // 他常常一句话分几条发：等 2.5 秒没新的再一起回
  clearTimeout(c.timer);
  c.timer = setTimeout(() => flush(peer).catch((e) => console.error("[qq] flush", e)), debounceMs(tuning().gate.debouncePrivateMs));
}

async function flush(peer = 'owner') {
  const c = conv(peer);
  if (c.busy || !c.queue.length) return;
  c.busy = true;
  const batch = c.queue;
  c.queue = [];
  try {
    const t = peerTarget(peer);
    if (t.qq) bot?.call('set_input_status', { user_id: Number(t.qq), event_type: 1 }).catch(() => {}); // NapCat：「对方正在输入」
    if (!llm.llmReady()) { await sendText('（面板里还没配模型，她现在没法想事情）', undefined, peer); return; }
    let out;
    const free = peer.startsWith('g:') && batch.every((b) => b.free); // 整批都没人@她：她只是在旁边看，想不想搭腔她自己定
    // 她自己的熔断：出手前判、真说了才计数。短时间内在同一个群自由插嘴太多句就歇会儿——防两个模型
    // 对着刷屏（名单漏网也兜得住）；SKIP 的批次不占名额，不然热群里光看不说就把熔断数耗光了
    if (free) {
      const G = tuning().gate;
      const nowTs = Date.now();
      const mine = (herFreeRate.get(peer) || []).filter((t) => nowTs - t < G.herRateWindowMin * 60_000);
      if (mine.length >= G.herRateMax) {
        try { logAction({ kind: 'gate', source: 'auto', detail: `🔥 连发熔断：这个群 ${G.herRateWindowMin} 分钟内她已经自由插嘴 ${mine.length} 句，歇一会儿「${batch.map((b) => b.text).join(' / ').slice(0, 30)}」`, meta: { verdict: '限流', text: batch.map((b) => b.text).join(' / ').slice(0, 60), peer } }); } catch { /* 日志不挡正事 */ }
        return;
      }
    }
    // 这批是不是从头到尾只有一个人在说：自由插嘴她开了口、而且就一个人在说话，好感才记分（几个人混说记谁头上都不公平）
    const solo = batch.every((b) => b.qq) && new Set(batch.map((b) => b.qq)).size === 1;
    try {
      // 群里 2.5 秒内可能攒下好几个人的话：带上 [名字] 一起给她，她才分得清谁问了什么
      const joined = peer.startsWith('g:')
        ? batch.map((b) => `[${b.name || '群友'}] ${b.text}`).join('\n')
        : batch.map((b) => b.text).join('\n');
      const cur = batch.flatMap((b) => b.imgs || []).slice(0, 3); // 这批消息自己带的图；一条没带就用最近看过的（「存成表情包」往往隔一句才说）
      out = await brain.reply(joined, { fids: batch.map((b) => b.fid), imgs: cur.length ? cur : freshImgs(c), model: readConfig().qq.model || undefined, qq: t.qq || c.lastQq || undefined, peer, name: String(batch.at(-1).name || ''), free, solo });
    } catch (e) {
      logAction({ kind: 'qq', source: 'auto', ok: false, error: e.message, detail: '想回你的时候脑子卡了' });
      if (!free) await sendText('诶，我脑子卡了一下 qwq 你再说一遍？', undefined, peer); // 自由插嘴没想成就算了，别硬刷存在感
      return;
    }
    await deliver(out, peer);
    if (free && (out?.text || out?.voice || out?.sticker)) { // 她真开口了才记熔断名额（SKIP 不算）
      const G = tuning().gate;
      const mine = (herFreeRate.get(peer) || []).filter((t) => Date.now() - t < G.herRateWindowMin * 60_000);
      mine.push(Date.now());
      herFreeRate.set(peer, mine);
    } else if (free) {
      // 过了裁决她最后还是没吭声（SKIP）：也落一笔——不然号主看到「过闸」却等不到回话，不知道卡在哪
      try { logAction({ kind: 'gate', source: 'auto', detail: `🤫 过了裁决，她想了想没搭话「${batch.map((b) => b.text).join(' / ').slice(0, 30)}」`, meta: { verdict: '没接', text: batch.map((b) => b.text).join(' / ').slice(0, 60), peer } }); } catch { /* 日志不挡正事 */ }
    }
  } finally {
    c.busy = false;
    if (c.queue.length) setTimeout(() => flush(peer).catch(() => {}), 300);
  }
}
/** 这个对话回给谁：群是 { group }，私聊是 { qq } */
function peerTarget(peer) {
  if (peer.startsWith('g:')) return { group: Number(peer.slice(2)), qq: null };
  if (peer === 'owner') return { group: null, qq: readConfig().qq.ownerQQ };
  return { group: null, qq: peer.slice(2) };
}

/** 消息里的图：先用 OneBot 给的地址下载，下不来再问 NapCat 要；看不了的就留着 [图片]。
 *  看图前先查梗图指纹库（layer 2）：同一张图第二次零视觉调用，描述跟第一次一致。
 *  下载成功的原图带出去——她看上能存成表情包；metas 是给插嘴闸的结构化字段（没看全就留空，闸门回退措辞正则） */
async function seeImages(ev, text) {
  const hint = text.replace(/\[图片\]/g, '').trim();
  const ownerQQ = String(readConfig().qq.ownerQQ);
  const peer = ev.message_type === 'group' ? `g:${ev.group_id}` : (String(ev.user_id) === ownerQQ ? 'owner' : `p:${ev.user_id}`);
  const imgs = [];
  const metas = [];
  for (const img of imageSegments(ev).slice(0, 3)) {
    let desc = null, bufLen = 0;
    try {
      const buf = await fetchImage(img);
      bufLen = buf?.length || 0;
      if (buf) {
        desc = await memeimg.cachedSee(buf, {
          peer,
          describe: () => llm.seeImage(buf, { hint, tag: String(img.data?.summary || '').trim(), model: readConfig().qq.visionModel }),
        });
        imgs.push(buf);
        if (desc?.kind) metas.push(desc);
      }
    } catch (e) { console.error('[qq] 看图', e.message); }
    if (!desc) console.error(`[qq] 这张图没看成：图下载=${bufLen}字节${bufLen ? '，接口没给描述或报错了' : '，图根本没下载下来（NAS 拉不到 QQ 的图床）'}`);
    const d = desc?.desc || '';
    text = text.replace('[图片]', d ? `[图片：${d}]` : '[图片（没看清）]');
  }
  // 有一张没拿到结构化字段就整批回退措辞正则：别拿半套字段把另一张的语义带偏
  return { text, imgs, metas: metas.length === imgs.length ? metas : [] };
}

async function fetchImage({ url, file }) {
  const get = async (u) => {
    const r = await fetch(u, { signal: AbortSignal.timeout(20000) });
    const b = Buffer.from(await r.arrayBuffer());
    return r.ok && dsh.isImage(b) ? b : null;
  };
  if (url) { const b = await get(url).catch(() => null); if (b) return b; }
  const r = await bot?.call('get_image', { file }).catch(() => null);
  if (r?.base64) return Buffer.from(r.base64, 'base64');
  if (r?.url) return get(r.url).catch(() => null);
  return null;
}

// ─── 发 ────────────────────────────────────────────────────
// 每个对话一条发送链：这个对话的所有发送（回复、语音、歌、后台汇报）严格按入链顺序排队，
// 一个发完再发下一个。回复生成本来就有 busy 锁不并发，但学歌/查资料的汇报是独立后台任务，
// 完成时刻是随机的——不串链就会跟正在逐条发的回复文字交错着冒出来。
const sendChain = new Map();
function chainSend(peer, fn) {
  const run = (sendChain.get(peer) || Promise.resolve()).then(() => fn());
  sendChain.set(peer, run.then(() => {}, () => {})); // 链上把错误吞掉，前面挂了后面照发
  return run;
}

/** 她调了语音又把同样的话打了一遍字吗（文字语音一个意思就算重）：重了就只发语音 */
export function voiceDupsText(text, voiceText) {
  const a = String(text || '').replace(/\s+/g, '');
  const b = String(voiceText || '').replace(/\s+/g, '');
  if (!a || !b) return false;
  return a.includes(b) || b.includes(a) || owner.overlap(a, b) > 0.8;
}
/** [TO:名字] 找群里这个人：先精确对名片，再模糊（小名/变体对得上就算），找不到返回空 */
function findGroupMember(peer, name) {
  const want = String(name || '').trim();
  if (!want) return '';
  const list = Object.values(friends.readFriends().friends).filter((f) => f.groups?.includes(peer));
  const f = list.find((x) => x.name === want)
    || list.find((x) => (x.name && (want.includes(x.name) || x.name.includes(want))))
    || list.find((x) => (x.name || '').slice(0, 2) === want.slice(0, 2));
  return f?.qq || '';
}

/** 点歌：先把音频真正发出去，再说那句说明——群里先看到「唱啦」、几十秒后才见歌会像说空话（2026-11-18）。
 *  歌走 slow 不占会话链；返回的 Promise 自己跑完，调用方不用 await（await 会把整个会话卡在转码上）。
 *  say(ok)：歌发出去了才说原话，没发成说兜底句——别让「唱啦」配着一首根本没出现的歌。 */
export async function singThenSay(task, say, deps = {}) {
  const b64 = deps.songB64 ? deps.songB64(task.file) : brain.songB64(task.file);
  const send = deps.sendSeg || sendSeg;
  let ok = true;
  try {
    await send([seg.record(b64)], `♪ ${task.song}`, 'song', deps.peer || 'owner', 180_000, true);
  } catch (e) {
    ok = false;
    console.error('[qq] 唱歌', e.message);
  }
  await say(ok);
}

async function deliver(out, peer = 'owner') {
  // 她要指明回谁（回的不是刚说话的人）时会在开头缀 [TO:名字]：剥掉标记、换成真的 @ 段跟第一条一起发，
  // 句子本身不用喊名字。私聊里标了就只剥掉；群里名字对不上人就当没标，裸发。
  // 模型偶尔把 O 写成 0（字形混淆，线上出过 [T0:...]）——T[O0] 两种都认，标记才剥得掉
  let at = '';
  let text = out.text;
  const to = String(text || '').match(/^\s*\[T[O0]:([^\]]+)\]\s*/);
  if (to) {
    text = String(text).slice(to[0].length);
    if (peer.startsWith('g:')) at = findGroupMember(peer, to[1]) || '';
  }
  const t = out.voice && voiceDupsText(text, out.voice.text) ? '' : text;
  // 点歌时那句「唱啦」必须排在音频后面：交给 singThenSay 在歌真正发出去后再发，
  // 这里先别发文字——不然群里先看到话、几十秒后才听到歌，像说了空话（2026-11-18）。
  if (t && !out.singingTask) await sendChatLines(t, peer, at);
  if (out.research) doResearch(out.research, peer);
  if (out.makeSticker) doSticker(out.makeSticker);
  if (out.sticker) {
    try {
      await sendSeg([seg.image(brain.stickerB64(out.sticker))], out.sticker, 'sticker', peer);
    } catch (e) {
      // 只 console.error 的话线上就是静默吞图：文字照发、表情消失、聊天记录也没有痕迹，
      // 和「模型没调表情包」长得一模一样（2026-11-10 群里实测零表情，先让失败看得见
      console.error('[qq] 表情包', e.message);
      try { logAction({ kind: 'qq', source: 'auto', ok: false, error: e.message, detail: `🖼️ 她想发「${out.sticker}」但没发出去（图缺了或发送失败）` }); } catch { /* 日志不挡正事 */ }
    }
  }
  if (out.voice) {
    // 语音合成 + NapCat 转格式要好几秒，文字已经先发出去了：这步不压着 busy（不然下一批的回复
    // 得等语音转完才开始想），合成完进发送链自己追上来；发不出去再打字补上
    brain.voiceB64(out.voice.text, out.voice.voice)
      .then((b64) => sendSeg([seg.record(b64)], out.voice.text, 'voice', peer))
      .catch(async (e) => {
        console.error('[qq] 语音', e.message);
        await sendText(out.voice.text, undefined, peer).catch(() => {}); // 语音发不出去就打字说
      });
  }
  if (out.singingTask) {
    // 整首歌 NapCat 要先用 ffmpeg 转成 QQ 语音格式，几十秒起步——slow 不占会话链，别让后面的话干等。
    // 那句「唱啦」等歌真的发出去再说（singThenSay），别先说话后出歌造成歧义。
    singThenSay(out.singingTask, (ok) => (ok && t ? sendChatLines(t, peer, at) : Promise.resolve()), { peer });
  }
  // 学歌交给后台：下载要几十秒，别让她干等着（谁点的就在哪儿说学会了）
  if (out.learnTask) doLearn(out.learnTask, peer);
}

// ─── 外挂：后台做，做完她自己说 ───────────────────────────────
/** 查资料结果回哪：从哪问发回哪，群里问 @ 号主本人。research 只有号主能用，问的人一定是号主 */
export function researchBack(peer = 'owner', ownerQQ = readConfig().qq.ownerQQ) {
  const backPeer = peer || 'owner';
  return { peer: backPeer, at: backPeer.startsWith('g:') ? String(ownerQQ || '') : '' };
}

/** 查资料：从哪问的发回哪（群里问发回群、私聊问发回私聊），群里 @ 号主本人。research 只有号主能用 */
function doResearch(question, peer = 'owner') {
  const { peer: backPeer, at: atQq } = researchBack(peer);
  logAction({ kind: 'qq', source: 'auto', detail: `🔎 联网查资料：${question.slice(0, 60)}`, meta: { peer: backPeer } });
  dsh.research(question)
    .then(async (r) => {
      logAction({ kind: 'qq', source: 'auto', detail: `🔎 查到了（${Math.round(r.ms / 1000)} 秒，用了 ${[...new Set(r.tools)].join('、') || '没用工具'}）`, meta: { question, peer: backPeer } });
      const line = await brain.researchReply(question, r.text, backPeer).catch(() => r.text.slice(0, 600));
      await sendText(line || r.text.slice(0, 600), 'report', backPeer, atQq);
    })
    .catch(async (e) => {
      logAction({ kind: 'qq', source: 'auto', ok: false, error: e.message, detail: `🔎 没查成：${question.slice(0, 40)}`, meta: { peer: backPeer } });
      await sendText('呜，我去查了一圈没查成 qwq 晚点再帮你看看？', 'report', backPeer, atQq).catch(() => {});
    });
}

// 学歌：SqMusic 后台下载进曲库，下完当场唱出来（在谁那儿点的就在谁那儿唱）
function doLearn(t, peer) {
  logAction({ kind: 'qq', source: 'auto', detail: `🎧 去学《${t.song}》（SqMusic 下载）` });
  sqmusic.learnSong(t.song)
    .then(async (r) => {
      logAction({ kind: 'qq', source: 'auto', detail: `🎧 《${r.name}》学下来了（${(r.size / 1048576).toFixed(1)}MB）` });
      const line = await brain.learnReply(t.song, true, r.name, peer, t.at).catch(() => '')
        || [`《${r.name}》学会啦，唱给你～`, `嗯，学好了，听听`, `《${r.name}》会了，唱啦`][Math.floor(Math.random() * 3)]; // 模型没回上就随手挑一句，别哑了也别老同一句；歌先发，这儿用唱完的语气
      // 光说「学会了想听随时点」还得他再点一次，多余——直接唱。
      // 歌先发、那句「学会啦/听听」等歌真发出去再说（跟点歌一个道理，别先说话后出歌）。
      // 号主指定了别的会话（t.targetPeer）就唱到那边，话仍说在点的这个会话。
      const to = t.targetPeer || peer;
      await singThenSay({ song: r.name, file: r.file }, (ok) => (ok ? sendText(line, 'report', peer) : Promise.resolve()), { peer: to });
    })
    .catch(async (e) => {
      logAction({ kind: 'qq', source: 'auto', ok: false, error: e.message, detail: `🎧 《${t.song}》没学下来` });
      const line = await brain.learnReply(t.song, false, e.message, peer, t.at).catch(() => '')
        || `呜，《${t.song}》没学下来 qwq（${brain.humanErr(e.message)}）`;
      await sendText(line, 'report', peer).catch(() => {});
    });
}

function doSticker(x) {
  dsh.makeSticker(x)
    .then(async (name) => {
      await bot.sendPrivate(readConfig().qq.ownerQQ, [seg.image(brain.stickerB64(name))]);
      owner.logChat({ from: 'her', text: name, kind: 'sticker' });
      await sendText(`嘿嘿，给自己画了张新表情：${x.zh}`, 'report');
    })
    .catch((e) => logAction({ kind: 'qq', source: 'auto', ok: false, error: e.message, detail: '想给自己做张新表情（' + (x.zh || '') + '），没做成' }));
}

export async function sendText(text, kind, peer = 'owner', atQq = '') {
  if (!bot) throw new Error('QQ 小号没开');
  // 模型在汇报类消息里也可能带 [TO:名字]（learnReply 那些继承了群聊规矩），在这儿统一剥掉换 @，
  // 免得标记原样发出去；deliver() 那份转换管不到这条路。T[O0]：模型偶发把 O 写成 0，同样要剥
  // atQq：调用方已经知道要 @ 谁时（比如群里问的号主，查完 @ 回他）直接传 QQ 号，不走名字反查
  let at = atQq && peer.startsWith('g:') ? String(atQq) : '';
  let body = String(text || '');
  const to = body.match(/^\s*\[T[O0]:([^\]]+)\]\s*/);
  if (to) {
    body = body.slice(to[0].length);
    if (peer.startsWith('g:') && !at) at = findGroupMember(peer, to[1]) || '';
  }
  if (!body.trim()) return; // 空内容发出去 QQ 会显示「该消息类型暂不支持查看」，干脆不发
  await chainSend(peer, async () => {
    const t = peerTarget(peer);
    if (t.group != null) await bot.sendGroup(t.group, at ? [seg.at(at), seg.text(' ' + body)] : [seg.text(body)]); // 群里裸发文字，不带 @（号主嫌显示出来啰嗦）
    else await bot.sendPrivate(t.qq, [seg.text(body)]);
    owner.logChat({ from: 'her', text: body, kind, peer });
  });
}

/** 她聊天的回复按换行拆开连着发（像真人连发短句）：最多三条，多的并进最后一条。汇报、提醒那些整段的不走这个。
 *  at 有值时第一条带 @ 段（[TO:名字] 解析来的），后面几条照常裸发 */
async function sendChatLines(text, peer, at = '') {
  const lines = String(text).split('\n').map((l) => l.trim()).filter(Boolean);
  if (lines.length < 2 && !at) return sendText(text, undefined, peer);
  const rest = lines.slice(2).join(' ');
  const parts = (rest ? lines.slice(0, 2).concat([rest]) : lines).slice(0, 3); // 两行就是两条，别多拼一条空的出去
  const start = Date.now(); // 连发是模拟打字，条与条之间隔几秒：他要是趁这个空档插了话，排在后面的旧条就成了答非所问
  for (let i = 0; i < parts.length; i++) {
    // 条和条之间像在打字：下一句多长就歇多久（一个字 ~80ms 起步 1.2 秒，再带点随机），顶多 5.5 秒
    if (i) await new Promise((r) => setTimeout(r, Math.min(1200 + parts[i].length * 80 + Math.random() * 1000, 5500)));
    // 私聊里他中途说话了就别再把旧条发完（她那轮没听见这句，硬发就像没在听）：新话自有新一轮回复去接。
    // 群里不这么砍——别人插话不该打断她正回着 A 的话，砍了反而像话说一半
    if (i && !peer.startsWith('g:')) {
      const interject = owner.lastFrom('owner', peer);
      if (interject && Date.parse(interject.ts) > start) {
        try { logAction({ kind: 'qq', source: 'auto', detail: `✂️ 连发被打断：他说「${String(interject.text).slice(0, 20)}」，剩下的 ${parts.length - i} 条旧话不发了` }); } catch { /* 日志不挡正事 */ }
        break;
      }
    }
    if (!i && at) { await sendSeg([seg.at(at), seg.text(' ' + parts[i])], parts[i], 'text', peer); continue; } // @ 后面垫个空格，别跟话黏一块
    await sendText(parts[i], undefined, peer);
  }
}
/** 表情包、语音这种带段的消息：私聊直接发，群里不带 @ 直接发。timeoutMs 默认 15 秒。
 *  slow=true 的（整首歌）：NapCat 转格式要几十秒到几分钟，不走发送链——不然后面所有文字都得排在它后面，
 *  会话又被卡成「几分钟前的旧回复」。语音气泡晚点冒出来没关系，文字顺序才是要保的。 */
async function sendSeg(message, logText, kind, peer = 'owner', timeoutMs, slow = false) {
  if (!bot) throw new Error('QQ 小号没开');
  const fire = async () => {
    const t = peerTarget(peer);
    if (t.group != null) await bot.sendGroup(t.group, message, timeoutMs);
    else await bot.sendPrivate(t.qq, message, timeoutMs);
    owner.logChat({ from: 'her', text: logText, kind, peer });
  };
  if (slow) return fire();
  return chainSend(peer, fire);
}

/** 跨会话发媒体（表情包/自拍/歌）到指定会话：后台 send_media 任务执行用。
 *  stickerName 走表情包池、songFile 走曲库；返回 { ok, kind, name }。发不出去由调用方记失败。 */
export async function sendMediaTo(peer, { kind = 'sticker', stickerName = '', songFile = '', songName = '', text = '', attribution = '' } = {}) {
  if (!bot) throw new Error('QQ 小号没开');
  // 从私聊发到群里的：群友得知道是谁叫发的（歌/图表里塞不下字，就先单独说一句）
  const by = attribution ? `（${attribution}）` : '';
  if (kind === 'text') {
    if (!text) throw new Error('要发的话没写');
    await sendText(`${by}${text}`, 'report', peer);
    return { ok: true, kind: 'text' };
  }
  if (by) await sendText(by, 'report', peer);
  if (kind === 'song') {
    if (!songFile) throw new Error('歌曲文件没找到');
    const b64 = brain.songB64(songFile);
    await sendSeg([seg.record(b64)], `♪ ${songName || songFile}`, 'song', peer, 180_000, true);
    return { ok: true, kind, name: songName || songFile };
  }
  if (!stickerName) throw new Error('表情包没找到');
  const b64 = brain.stickerB64(stickerName);
  await sendSeg([seg.image(b64)], stickerName, 'sticker', peer);
  return { ok: true, kind: 'sticker', name: stickerName };
}

/** 给 notify.mjs：主动给号主发一句（汇报、提醒、分享） */
export async function sendOwner(text, kind = 'notice') {
  if (!connected()) throw new Error('QQ 小号没连上');
  await sendText(text, kind);
  return { id: '' };
}

// ─── 每分钟：主动找他、每晚整理聊天 ───────────────────────────
async function tick(now = Date.now()) {
  if (!connected()) return;
  const cfg = readConfig();
  const st = readState();
  const today = localDate(new Date(now));

    // 过了午夜：把大家昨天攒的好感结算掉（半夜没开也不怕，记分时会懒结算）
  const sF = readState();
  if (sF.favSettledOn !== today) {
    writeState({ ...sF, favSettledOn: today });
    try {
      const done = fav.settleAll(new Date(now));
      if (done.length) logAction({ kind: 'qq', source: 'auto', detail: `💗 结算了 ${done.length} 个人的今日好感` });
    } catch (e) { console.error('[fav] 结算', e.message); }
  }
// 每晚整理一次最近的聊天：补记他的事，写一句进她自己的记忆。
// 窗口一律按「上次日结的时间戳」切、不按自然日（照 digestGroup 的范式）——不然过了日结点之后聊的话
// 当晚结不上、第二天也不再补，深夜的聊天就只活在 5 天上下文里。标记先写再干活：中途崩了宁可这段
// 少结一次，也不重复灌条目（qqDigestOn 的日期闸门只管「今晚过没过」，窗口起点是 qqDigestAt 时间戳）
  if (new Date(now).getHours() >= cfg.mind.reflectHour && st.qqDigestOn !== today && llm.llmReady()) {
    const ownerSince = st.qqDigestAt || '';
    writeState({ ...st, qqDigestOn: today, qqDigestAt: nowIso() });
    let r = null;
    try {
      r = await owner.digestToday({ since: ownerSince, remember: (t) => memory.add({ kind: 'chat', imp: 3, keys: ['owner'], text: `跟号主聊天：${t}` }) });
    } catch (e) { console.error('[qq] 今晚的日结没跑成：', e.message); }
    if (r?.added) logAction({ kind: 'qq', source: 'auto', detail: `🌙 翻了翻最近跟你聊的，多记住了 ${r.added} 件关于你的事` });
    // 号主的日结完了接着翻别人的：群友、好友各自提炼一笔进朋友圈档案（窗口同样按时间戳切）
    try {
      const sFr = readState();
      const frSince = sFr.friendsDigestAt || '';
      writeState({ ...sFr, friendsDigestAt: nowIso() });
      const fr = await friends.digest({ since: frSince });
      if (fr.notes) logAction({ kind: 'qq', source: 'auto', detail: `👥 翻了翻最近跟别人聊的，多记住了 ${fr.notes} 条关于朋友的事` });
    } catch (e) { console.error('[friends] 今晚的朋友日结没跑成：', e.message); }
    // （老的「朋友圈小结」下线了：它看不到聊天内容、只反刍自己的上一次输出，天天同一句塑料话；
    //   近况改从阶段一日结写进记忆流的总括行取，见 friends.socialText）
    // 群聊/好友私聊也各结一次进她的记忆流（记忆升级阶段一）：今天最活跃的前 3 个对话，
    // 窗口按上次日结的时间戳切、20 小时内不重复、单群失败不拖垮后面（调度细节见 owner.groupDigestRound）
    try {
      await owner.groupDigestRound({ now, remember: (x) => memory.add(x) });
    } catch (e) { console.error('[qq] 群日结没跑成：', e.message); }
    // 约定识别（阶段三.5）：扫当天聊天里指向她的约定，存下来等到点赴约
    try {
      const { scanForAppointments } = await import('./appoint.mjs');
      await scanForAppointments({ now });
    } catch (e) { console.error('[appoint] 约定识别没跑成：', e.message); }
    // 夜里链尾最后一件事：记忆对账（通用纪律 6/7/8）——该想起的还想起、陷阱空着、对话不串场。
    // 不调模型不 touch 记忆；查询集不用人手建，首跑自动从真实记忆里挖，之后每晚自己养
    try {
      recallCheck.runRecallCheck();
    } catch (e) { console.error('[qq] 记忆对账没跑成：', e.message); }
    return;
  }

  if (!brain.reachOutDue(now, cfg.qq, st) || conv('owner').busy || conv('owner').queue.length || !llm.llmReady() || Math.random() > 0.5) return;
  const s2 = readState();
  const prev = s2.reachOut?.date === today ? s2.reachOut : { date: today, n: 0 };
  writeState({ ...s2, reachOut: { ...prev, triedAt: now } });
  const line = await brain.reachOutLine(now).catch(() => null);
  if (!line) return;
  await sendText(line, 'proactive');
  const s3 = readState();
  writeState({ ...s3, reachOut: { ...prev, n: prev.n + 1, triedAt: now } });
  logAction({ kind: 'notify', source: 'auto', detail: `主动找你：${line.slice(0, 60)}`, meta: { proactive: true } });
}

/** 面板「发条测试」 */
export async function test() {
  await sendText('🐟 测试一下：以后我用这个号跟你说话啦');
  return { ok: true };
}
