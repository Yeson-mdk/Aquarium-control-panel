/**
 * 序 9 感知扩容：群聊「非指向她」的消息，实时低 imp 写进记忆流。
 *
 * 背景：此前群消息只写聊天记录（owner.logChat → qq-chat*.jsonl），3 天窗口一过就滚掉；
 * 真正提炼进记忆流的只有每晚群日结——隔夜、有损、只留热聊话题。于是群里没 @ 她、
 * 她也没回的那些事（某人身又感冒了、随口说下周交稿、两人拌了几句嘴），当天的反思和
 * 第二天的晨间计划都看不见，过几天 recall 也翻不到——记忆流里压根没进过。
 *
 * 本模块把这些「背景」以低 imp（1~2）实时写进记忆流：低分是刻意的，这类信息不能跟
 * 号主私话、她亲身经历抢权重，寿命公式（10 天 × imp × (1+被想起次数)）让它们几天后
 * 自然淡掉，只留个「她好像听说过」的底子。
 *
 * 判定口径（宁可漏，别刷屏）：
 *  - 只管群聊非指向消息：@ 她 / 叫名字 / 短指令 / 怼她 / 回她的话都不写（那些走正常回复，进日结）
 *  - 纯情绪、纯图片占位、太短无信息的跳过
 *  - 机器人名单里的不写（互刷的垃圾）
 *  - 去重：同一群同一人 10 分钟内说的同一句话不重复写
 *
 * 纯函数为主，写记忆和日志都在调用方做，方便单测。
 */
import * as memory from '../memory.mjs';
import { logAction } from '../store.mjs';

const NAME_RE = /哦鲸鲸|鲸鲸|鲸鱼|大肥鱼|肥鱼/;            // 叫她名字 = 指向她
const ATTACK_RE = /[蠢笨傻呆坏懒憨]鱼|(?:只会)?找茬|破防|骂谁/; // 怼她 = 指向她
const CMD_RE = /^(唱|跳|来一首|来一个|来一张|说两句|唱一个|唱一下|来段语音|来个表情)$/i;
const EMOTION_RE = /^(哈哈|啊这|笑死|离谱|牛啊|好家伙|神了|急了|哭了|好笑|好耶|草|qwq|x_x|orz|略略|太强了|这波|233)+$/i;
// 有信息量的生活事件（复用打分闸的 freshEvent 词表思路）：命中给 imp=2，其余有内容的给 imp=1
const EVENT_RE = /(生病|病倒|发烧|感冒|住院|手术|出院|搬家|搬走|入住|新房|分手|离婚|复合|脱单|相亲|结婚|订婚|领证|怀孕|生了|满月|入职|离职|辞职|跳槽|失业|被裁|考过|考上|落榜|挂科|毕业|开学|迟到|请假|加班|出差|旅行|旅游|回家|到家|出发|丢了|掉了|坏了|碎了|修好|中奖|被偷|摔倒|受伤|崴脚|牙疼|头疼|肚子疼|体检|复查|打针|接种|猫|狗|兔|鸟|娃|宝宝|宠物|主子|下周|明天|周末|约了|打算|准备|计划|下周交)/;

const dedup = new Map(); // `${peer}:${qq}` → [{ text, at }]，10 分钟内同文不重复写
const DEDUP_MS = 10 * 60_000;
const DEDUP_MAX = 20; // 每人最多留几条（防 Map 无限涨）

/**
 * 判一条群消息该不该作为「背景」入记忆流。
 * @param {object} o
 * @param {string} o.text 正文（已剥图片占位、已 trim）
 * @param {boolean} o.at 是否 @ 了她
 * @param {boolean} o.isBot 说话人是否在机器人名单
 * @param {boolean} o.replyToMe 是否在回她刚说的话
 * @returns {{write:boolean, imp:number, why:string}} write=是否写，imp=重要度，why=日志用的判定理由
 */
export function judge({ text = '', at = false, isBot = false, replyToMe = false } = {}) {
  const skip = (why) => ({ write: false, imp: 0, why });
  if (!text) return skip('空消息');
  if (isBot) return skip('机器人');
  if (at) return skip('@她'); // 指向她，走正常回复路径
  if (NAME_RE.test(text)) return skip('叫名字');
  if (ATTACK_RE.test(text)) return skip('怼她');
  if (CMD_RE.test(text.trim())) return skip('短指令');
  if (replyToMe) return skip('回她的话');
  if (EMOTION_RE.test(text.trim())) return skip('纯情绪');
  const clean = text.replace(/\s+/g, ' ').trim();
  if (clean.length < 6) return skip('太短无信息'); // 「哦」「好的呀」这种不值得记
  if (EVENT_RE.test(clean)) return { write: true, imp: 2, why: '生活事件' };
  return { write: true, imp: 1, why: '群背景' };
}

/** 去重：同一群同一人 10 分钟内说同一句话不重复写。true=是新话，记过 */
export function fresh(peer, qq, text, now = Date.now()) {
  const key = `${peer}:${qq}`;
  let arr = dedup.get(key) || [];
  arr = arr.filter((x) => now - x.at < DEDUP_MS);
  if (arr.some((x) => x.text === text)) { dedup.set(key, arr); return false; }
  arr.push({ text, at: now });
  dedup.set(key, arr.slice(-DEDUP_MAX));
  return true;
}

// ─── 序10 实时事件入口：imp≥4 的外来大事 ────────────────────────────
// 只有"真的像件大事"才写，宁可漏：压得低了钩子天天烧钱、重排抽风。
// 词表比上面的 EVENT_RE 严得多——生病住院/出事/崩溃这类，不含"猫/下周/打算"这种日常。
const BIG_RE = /(住院|手术|出事|出了事|事故|车祸|去世|走了|失恋|分手|离婚|被裁|裁员|失业|崩溃|撑不住|熬不住|抑郁症|确诊|病危|抢救|家人生病|家里出事|被欺负|被骗|被骗|被偷|丢工作|挂了|没了|丧失|葬礼|临终|自杀|轻生)/;
const bigDedup = new Map(); // `${peer}` → [{ text, at }]，同群/同人 30 分钟内同一件大事不重复触发
const BIG_DEDUP_MS = 30 * 60_000;

/** 判一条消息是不是"值得即时唤起她"的大事。号主私聊和群里指向她的话都算，纯背景不算 */
export function isBigEvent({ text = '', isBot = false } = {}) {
  if (isBot || !text) return false;
  return BIG_RE.test(text);
}

/**
 * 实时记一件大事并打上 hook 旗：memory.add 看到 imp≥4 + hook:true 就触发序10 钩子
 * （轻反思 + 重排今日计划，由 autopilot 注入）。不抛错。
 * @returns {object|null}
 */
export function perceiveBig({ peer, qq, name, text, isBot }) {
  if (!isBigEvent({ text, isBot })) return null;
  const key = String(peer || 'owner');
  const now = Date.now();
  const arr = (bigDedup.get(key) || []).filter((x) => now - x.at < BIG_DEDUP_MS);
  if (arr.some((x) => x.text === text)) { bigDedup.set(key, arr); return null; }
  arr.push({ text, at: now });
  bigDedup.set(key, arr.slice(-10));
  const label = String(name || qq || (peer === 'owner' ? '号主' : '某人')).slice(0, 20);
  const prefix = peer === 'owner' ? '号主说的大事' : `「群·${String(peer).replace(/^g:/, '')}」${label}说的大事`;
  const full = `${prefix}：${text}`;
  // 独立 kind：大事件不再挤占「对话日结」（chat）分类，也不占记忆页 recent 的 50 条窗口
  const entry = memory.add({ kind: 'big_event', imp: 4, hook: true, keys: [String(peer)], text: full });
  // 大事件进活动记录（低频高价值，跟刷屏的群背景不同）：面板「群聊感知 → 大事件」也读这条
  if (entry) {
    logAction({
      kind: 'big_event',
      source: 'auto',
      detail: `⚡ 大事件：${full.slice(0, 60)}`,
      meta: { peer: String(peer || 'owner'), name: label, text: String(text).slice(0, 200) },
    });
  }
  return entry;
}

/**
 * 感知一条群消息：判定 + 去重 + 写记忆流。不抛错（记忆写失败不该挡收消息）。
 * @returns {object|null} 写进去的记忆条目，或 null（没写）
 */
export function perceiveGroup({ peer, qq, name, text, at, isBot, replyToMe }) {
  const d = judge({ text, at, isBot, replyToMe });
  if (!d.write) return null;
  if (!fresh(peer, qq, text)) return null;
  const gid = String(peer || '').replace(/^g:/, '') || '?';
  const who = String(name || qq || '某人').slice(0, 20);
  // 独立 kind：群背景高频，不能挤占「对话日结」（chat）分类和记忆页 recent 的 50 条窗口
  // （曾因此把「日子」里的刷视频经历挤出可视范围，只剩 1 条）
  const entry = memory.add({
    kind: 'background',
    imp: d.imp,
    keys: [String(peer)],
    text: `「群·${gid}」${who}：${text}`,
  });
  if (entry) {
    // 群背景高频，不进活动记录（会刷屏）：面板「群聊感知 → 群背景」按 kind=perceive 单独读这一份
    logAction({
      kind: 'perceive',
      source: 'auto',
      detail: `👂 记下群背景（imp ${d.imp}·${d.why}）：${text.slice(0, 40)}`,
      meta: { peer: String(peer || ''), name: who, imp: d.imp, why: d.why, text: String(text).slice(0, 200) },
    });
  }
  return entry;
}
