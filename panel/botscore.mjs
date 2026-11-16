/**
 * 谁像 bot（botscore）：从群聊记录里给每个发言账号算一份「像脚本的程度」
 *
 * 不是判别模型——几条看得懂的规则加分制，输出是「怀疑名单」不是判决，盖章靠人翻聊天记录。
 * 数据就是 qq-chat-g_*.jsonl（本来就在记）：时间戳、群名片、内容。零额外成本、不调模型、纯读。
 *
 * 两套分并排输出，方便对比观察、慢慢切：
 *  - score/verdict/flags（v1，原样不动）：面向「僵硬脚本」——作息覆盖、凌晨、间隔变异、全局同文、
 *    长度整齐、人类痕迹（语音/文件）一刀压 30 分。链式刷屏号它抓得准。
 *  - score2/verdict2/flags2（v2，2026-11-09 加）：面向「养鱼号」——话术会打散变体、真人挂机洗白：
 *      · 短窗口近似重复：归一（去标点/表情/空白）后在最近 12 条里找重影，改一两个字躲不过
 *      · 时间熵：不看覆盖几个钟头，看分布均不均匀——人有作息聚簇，养鱼铺满全天
 *      · 自说自话：活群里只抛不接（前面一条永远是自己的话）。按「别人在场的机会」归一，
 *        死群里自言自语不硬判；别人几乎不在场就输出 null
 *      · 引流词轻扫（纯正则）：加我/扫码/福利/日结……只是辅助加分，一句「你微信多少」不定罪
 *      · 卡片/明文链接算风险（转发分享是引流高频），不再当人类痕迹洗白；语音/文件降为弱洗白（-12）
 *      · 置信衰减：条数刚过线的账号分数按 conf 压低，样本越小越不轻易定罪
 *      · 对话号维度（伴聊挂机 AI，句句不重样、会接话，上面的养鱼规则全抓不到）：
 *        回应延迟 P90≤15s 且 8 秒内接话≥70%（触发即回，人的慢尾会推开 P90）、张口「主人」、
 *        被点名必回。这组不吃 conf（延迟统计自带 ≥12 样本门槛），但阈值就是
 *        校准值——拿真实分布定的，不是硬规则；判读以旗子为准，分数线只是展示分桶。
 *        「名字带 .by作者」只亮提示不加分——名字是身份不是行为，不拿它定罪。
 *        标点率/短句率这类风格特征测过：不同作者调的号两极分化，真人重叠大，故意不用。
 *
 * ⚠️ 已知盲区：纯图/纯视频消息在收条时就被剥掉不落记录（qq/index.mjs），图墙号在这份数据里是隐形的；
 *    要抓得改收条先记图片数，这里先不做。
 * ⚠️ 记录里只存群名片不存 QQ 号（qq/index.mjs 收条时没带 user_id），
 *    一键拉黑要的 QQ 靠 friends 档案反查；查不到的页面会标出来，只能去设置里手动填。
 *    名字对上但群对不上时 qq 给低置信标记（qqConf: 'low'），别静默当查准了。
 */
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { DATA, readJsonl } from './store.mjs';
import * as friends from './friends.mjs';

const MIN_N = 20; // 消息太少统不出东西
const MIN_GAPS = 15; // 间隔样本太少不算
const MIN_OPP = 8; // 「别人在场」的发言太少，自说自话比例判不了（群太冷不硬判）
const WIN = 12; // 近似重复的滑动窗口：自己的最近 12 条
const TRACE = /\[语音\]|\[文件\]|\[音乐\]|\[链接\]|\[转发\]/; // v1 原样（链接/转发实际不会出现，留着保持 v1 可比）
const GOOD_TRACE = /\[语音\]|\[文件|\[音乐\]/; // 人类痕迹：语音 / 文件（文件段长这样：[文件 xx.jpg]）
const RISK_TRACE = /\[卡片\]|https?:\/\/|www\.|\.(?:com|cn|net|top|xyz)\b/i; // 转发分享 / 明文链接：养鱼引流高频
// 引流词：只做辅助加分。不放 /g（.test 复用会踩 lastIndex 串号）、不放单词「v」这种见字就中的
const DRAIN = /加我|私聊|扫码|加群|威信|微信|vx|v信|福利|领取|日结|兼职|引流|接单|私我/i;

/** 有记录的群，按消息量排 */
export function listGroups() {
  try {
    return readdirSync(DATA).filter((f) => /^qq-chat-g_\d+\.jsonl$/.test(f))
      .map((f) => { const peer = 'g:' + f.slice('qq-chat-g_'.length, -'.jsonl'.length); return { peer, n: readJsonl(join(DATA, f)).length }; })
      .filter((x) => x.n > 0).sort((a, b) => b.n - a.n);
  } catch { return []; }
}

/** 变异系数（标准差/均值）：越小说明越「整齐」 */
function cv(xs) {
  const n = xs.length;
  if (n < 2) return null;
  const m = xs.reduce((s, x) => s + x, 0) / n;
  if (!m) return null;
  return Math.sqrt(xs.reduce((s, x) => s + (x - m) ** 2, 0) / n) / m;
}

/** 时间分布熵（0-1）：越均匀越高。人有作息聚簇熵低，养鱼铺满全天熵高 */
function timeEntropy(hours) {
  if (!hours.length) return 0;
  const cnt = new Array(24).fill(0);
  for (const h of hours) cnt[h]++;
  let e = 0;
  for (const c of cnt) { if (!c) continue; const p = c / hours.length; e -= p * Math.log2(p); }
  return e / Math.log2(24);
}

/** 归一文本：去空白、标点、符号（含 emoji，\p{S} 盖住 \p{So}，且不像 \p{Emoji} 那样误伤数字） */
function normText(s) {
  return String(s || '').replace(/\s+/g, '').replace(/[\p{P}\p{S}]/gu, '').toLowerCase();
}

/** 群名片 → QQ：从朋友圈档案反查（当前名或用过的旧名都认，优先同群的；占位档 n: 没有QQ不算）。
 *  带置信度：群对上 high；只对上名字（同名在别的群 / 多号共用名片）low，页面要标出来别静默拉黑 */
function qqOf(name, peer) {
  const hit = Object.entries(friends.readFriends().friends)
    .filter(([k, f]) => !k.startsWith('n:') && (f.name === name || (f.names || []).includes(name)));
  if (!hit.length) return { qq: null, conf: null };
  const exact = hit.find(([, f]) => (f.groups || []).includes(peer));
  return exact ? { qq: exact[0], conf: 'high' } : { qq: hit[0][0], conf: 'low' };
}

/** 一个群一份榜单：每个发言账号一行（v1/v2 两套分并排），按 v2 怀疑分排。纯读，不改任何数据 */
export function scoreGroup(peer, { days = 30, now = Date.now() } = {}) {
  const cut = now - days * 86400_000;
  const file = join(DATA, `qq-chat-${String(peer).replace(/[^a-z0-9_-]/gi, '_')}.jsonl`);
  const byName = new Map();
  const seq = []; // 全群时间线（自说自话要对着别人的发言看）
  for (const e of readJsonl(file)) {
    if (e.from === 'her' || e.kind === 'reset') continue; // 她自己的话和重置标记不算
    const ts = Date.parse(e.ts);
    if (!(ts > cut)) continue;
    const text = String(e.text || '').trim();
    if (!text || text.startsWith('（拍了拍') || text.startsWith('（@了你')) continue; // 系统事件不算聊天
    const name = String(e.name || '').trim() || '（没名字）';
    const it = { ts, text, name };
    seq.push(it);
    if (!byName.has(name)) byName.set(name, []);
    byName.get(name).push(it);
  }
  seq.sort((a, b) => a.ts - b.ts);
  const idxOf = new Map(seq.map((x, i) => [x, i])); // O(1) 定位，别用 indexOf（大群会平方级）
  return [...byName].map(([name, list]) => {
    list.sort((a, b) => a.ts - b.ts);
    const n = list.length;
    const hours = list.map((x) => new Date(x.ts).getHours());
    const hourSpan = new Set(hours).size;
    const night = hours.filter((h) => h < 7).length / n;
    const gaps = [];
    for (let i = 1; i < list.length; i++) { const g = (list[i].ts - list[i - 1].ts) / 1000; if (g > 0 && g <= 600) gaps.push(g); }
    const gapCv = gaps.length >= MIN_GAPS ? cv(gaps) : null;
    // ── v1 指标（原样不动）──
    const seen = new Set();
    let dup = 0;
    for (const x of list) { const k = x.text.replace(/\s+/g, ' '); if (seen.has(k)) dup++; else seen.add(k); }
    const lenCv = n >= MIN_N ? cv(list.map((x) => x.text.length)) : null;
    const traces = list.some((x) => TRACE.test(x.text));
    const flags = [];
    let score = 0;
    if (n >= MIN_N) {
      if (hourSpan >= 14) { score += 25; flags.push('全天在线'); }
      if (night >= 0.10) { score += 20; flags.push('凌晨活跃'); }
      if (gapCv !== null && gapCv <= 0.9) { score += 20; flags.push('间隔稳定'); }
      if (dup / n >= 0.15) { score += 15; flags.push('同文重复'); }
      if (lenCv !== null && lenCv <= 0.5) { score += 10; flags.push('长度整齐'); }
      if (traces) { score -= 30; flags.push('有语音/文件'); }
      score = Math.max(0, Math.min(100, score));
    }
    // ── v2 指标（面向养鱼号）──
    // 短窗口近似重复：归一后在最近 WIN 条里见过就算（空归一串跳过——不同 emoji 都归成空，别互撞）
    const normed = list.map((x) => normText(x.text));
    let wDup = 0;
    for (let i = 0; i < normed.length; i++) {
      if (!normed[i]) continue;
      for (let j = Math.max(0, i - WIN); j < i; j++) if (normed[j] === normed[i]) { wDup++; break; }
    }
    const windowDupShare = wDup / n;
    // 自说自话：只数「别人 10 分钟内在场」的发言（机会），其中前一条还是自己话的比例。
    // 机会不足 MIN_OPP 说明群太冷，这个比例统计不出来 → null，不硬判
    let opp = 0, follow = 0;
    for (const it of list) {
      const idx = idxOf.get(it);
      let othersNear = false;
      for (let j = idx - 1; j >= 0 && it.ts - seq[j].ts <= 600_000; j--) if (seq[j].name !== name) { othersNear = true; break; }
      if (!othersNear) continue;
      opp++;
      if (seq[idx - 1] && seq[idx - 1].name !== name) follow++;
    }
    const selfTalkShare = opp >= MIN_OPP ? 1 - follow / opp : null;
    // 低信息短句：剥掉非字母数字后只剩 ≤2 字（纯表情/纯标点/俩字水群）
    const lowInfoShare = list.filter((x) => x.text.replace(/[^\p{L}\p{N}]/gu, '').length <= 2).length / n;
    const goodTrace = list.some((x) => GOOD_TRACE.test(x.text));
    const riskTrace = list.some((x) => RISK_TRACE.test(x.text));
    const drainHit = list.some((x) => DRAIN.test(x.text));
    const timeEnt = timeEntropy(hours);
    // ── 对话号维度（2026-11-09 加，抓伴聊挂机 AI——它们句句不重样、会接话，养鱼号规则抓不到）──
    // 延迟 = 距群里前一条消息（任何人）的秒数，不设上限：人回来看完消息才回的慢尾就该把 P90 推上去，
    // 触发即回的号整条分布都贴在几秒上。这组不吃 conf 缩放——延迟统计自带样本门槛（≥12 条）
    const lats = [];
    for (const it of list) { const i = idxOf.get(it); if (i > 0) lats.push((it.ts - seq[i - 1].ts) / 1000); }
    lats.sort((a, b) => a - b);
    const latP90 = lats.length >= 12 ? +lats[Math.floor(lats.length * 0.9)].toFixed(1) : null;
    const fastShare = lats.length ? lats.filter((v) => v <= 8).length / lats.length : 0;
    const fastSteady = latP90 !== null && latP90 <= 15 && fastShare >= 0.7; // 又快又稳：触发即回的形态
    const masterTalk = n >= 12 && list.filter((x) => /主人/.test(x.text)).length / n >= 0.05; // 张口主人：AI 人格号口癖
    const byName = /\.by/i.test(name); // .by作者 后缀：这生态 AI 号的命名惯例——只亮提示，不加分（名字是身份不是行为，别拿它定罪）
    // 点名必回：别人 60 秒内叫名字主干、他 60 秒内必接话——被叫 5 次以上一次不落，人做不到
    const stem = (name.replace(/\(.*?\)/g, '').split(/[.。．·]/)[0] || '').trim();
    let mentions = 0, answered = 0;
    if (stem.length >= 2) {
      for (let i = 0; i < seq.length; i++) {
        const m = seq[i];
        if (m.name === name || !m.text.includes(stem)) continue;
        mentions++;
        for (let j = i + 1; j < seq.length && seq[j].ts - m.ts <= 60_000; j++) if (seq[j].name === name) { answered++; break; }
      }
    }
    const mentionAll = mentions >= 5 && answered / mentions >= 0.9;
    const flags2 = [];
    if (fastSteady) flags2.push('回应又快又稳');
    if (byName) flags2.push('名字带.by作者');
    if (masterTalk) flags2.push('张口主人');
    if (mentionAll) flags2.push('点名必回');
    // 置信衰减：条数刚过线的账号所有加分按 conf 压低，样本越小越不轻易定罪
    const conf = Math.max(0, Math.min(1, (n - MIN_N) / (MIN_N * 3)));
    let score2 = 0;
    if (n >= MIN_N) {
      if (fastSteady) score2 += 30; // 对话号最强信号，不缩放（延迟样本自带门槛）
      if (masterTalk) score2 += 8;
      if (mentionAll) score2 += 8;
      if (hourSpan >= 16) { score2 += 6 * conf; flags2.push('在线钟头多'); }
      if (timeEnt >= 0.78) { score2 += 18 * conf; flags2.push('时间分布太均匀'); }
      if (night >= 0.12) { score2 += 12 * conf; flags2.push('凌晨活跃'); }
      if (gapCv !== null && gapCv <= 0.9) { score2 += 14 * conf; flags2.push('间隔稳定'); }
      if (windowDupShare >= 0.12) { score2 += 18 * conf; flags2.push('短窗口近似重复'); }
      if (lenCv !== null && lenCv <= 0.5) { score2 += 6 * conf; flags2.push('长度整齐'); }
      if (selfTalkShare !== null && selfTalkShare >= 0.6) { score2 += 18 * conf; flags2.push('自说自话'); }
      if (lowInfoShare >= 0.35) { score2 += 8 * conf; flags2.push('低信息短句多'); }
      if (riskTrace) { score2 += 8 * conf; flags2.push('带链接/卡片'); }
      if (drainHit) { score2 += 16 * conf; flags2.push('命中引流词'); }
      if (goodTrace && !fastSteady) { score2 -= 12; flags2.push('有语音/文件'); } // 弱洗白，但快而稳的号上不算——多模态挂机号也会发语音
      score2 = Math.max(0, Math.min(100, score2));
    }
    const { qq, conf: qqConf } = qqOf(name, peer);
    return {
      name, qq, qqConf, n, hourSpan,
      night: +night.toFixed(2),
      gapCv: gapCv === null ? null : +gapCv.toFixed(2),
      dupShare: +(dup / n).toFixed(2),
      lenCv: lenCv === null ? null : +lenCv.toFixed(2),
      traces,
      score: n >= MIN_N ? score : null,
      verdict: n < MIN_N ? '数据不足' : score >= 70 ? '高度疑似' : score >= 45 ? '可疑' : '像人',
      flags,
      // v2 并排字段
      windowDupShare: +windowDupShare.toFixed(2),
      selfTalkShare: selfTalkShare === null ? null : +selfTalkShare.toFixed(2),
      lowInfoShare: +lowInfoShare.toFixed(2),
      timeEnt: +timeEnt.toFixed(2),
      latP90,
      goodTrace, riskTrace, drainHit,
      score2: n >= MIN_N ? +score2.toFixed(1) : null,
      verdict2: n < MIN_N ? '数据不足' : score2 >= 68 ? '高度疑似' : score2 >= 42 ? '可疑' : '像人',
      flags2,
    };
  }).sort((a, b) => (b.score2 ?? -1) - (a.score2 ?? -1) || (b.score ?? -1) - (a.score ?? -1) || b.n - a.n);
}
