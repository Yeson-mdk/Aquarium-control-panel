/**
 * 关于号主的事 + 跟号主的聊天记录
 *
 * 以前这些全靠 DSH 的记忆插件。换成小号以后面板自己当大脑，所以自己记：
 *
 *  - 号主的事（data/owner.json）：称呼、偏好、计划、口头禅、近况这类「三个月后大概还成立」的事，
 *    一条一句话。每次聊天都整份带上（够短）；她聊着聊着用 remember 工具记，每晚再从当天聊天里补一遍。
 *    记错了号主一纠正就改。
 *  - 聊天记录（data/qq-chat.jsonl）：她和号主说过的每句话（含她主动说的、后台汇报），给下一轮当上下文。
 *  - 从 DSH 带过来（importDsh）：一次性把 DSH 记忆里关于号主的事提炼进来，只读，不动 DSH 的文件；
 *    开发排查、工程笔记这类不是号主的事，不带。
 */
import { readFileSync, writeFileSync, renameSync, existsSync, readdirSync, unlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { DATA, ROOT, nowIso, localDate, readJsonl, appendJsonl, logAction, readState, writeState } from '../store.mjs';
import * as memdb from '../memdb.mjs';
import * as llm from '../llm.mjs';

const FACTS = join(DATA, 'owner.json');
export const CHAT = join(DATA, 'qq-chat.jsonl');
export const KINDS = ['称呼', '身份', '偏好', '作息', '计划', '口头禅', '近况', '规矩', '其他'];
const MAX_FACTS = 80;

// ─── 号主的事 ──────────────────────────────────────────────
export function readFacts() {
  try { return JSON.parse(readFileSync(FACTS, 'utf-8')).facts || []; } catch { return []; }
}
// 称呼 / 身份 / 规矩是「他是谁、他定了什么规矩」级别的事，不参与自动淘汰；近况这类会过时的才挤
const KEEP_KINDS = new Set(['称呼', '身份', '规矩']);

/** 超过上限时从最旧的开始挤，重要的永远留着；返回挤掉的（给淡忘档案留底用） */
export function squeezeFacts(facts, max = MAX_FACTS) {
  if (facts.length <= max) return { facts, overflow: [] };
  const keep = [];
  const overflow = [];
  for (let i = facts.length - 1; i >= 0; i--) {
    const f = facts[i];
    if (keep.length < max || KEEP_KINDS.has(f.kind)) keep.push(f);
    else overflow.push(f);
  }
  return { facts: keep.reverse(), overflow };
}

function writeFacts(facts) {
  const sq = squeezeFacts(facts);
  // 档案库没写成（磁盘/ SQLite 临时故障）就先别挤：宁可 owner.json 多留几条，也不能让「留底」变成真丢
  const kept = sq.overflow.length && !memdb.syncFacts(sq.overflow) ? facts : sq.facts;
  const tmp = FACTS + '.tmp';
  writeFileSync(tmp, JSON.stringify({ facts: kept }, null, 2));
  renameSync(tmp, FACTS);
}
const norm = (t) => String(t || '').replace(/\s+/g, ' ').trim().slice(0, 120);
const shortId = () => crypto.randomUUID().slice(0, 6);

/** 记一条；差不多的已经有了就不重复记（同一类、字面上大半一样） */
export function addFact({ text, kind = '其他', source = 'chat' }) {
  const t = norm(text);
  if (t.length < 3 || llm.looksInjected(t)) return null;
  const facts = readFacts();
  const k = KINDS.includes(kind) ? kind : '其他';
  const dup = facts.find((f) => f.text === t || (f.kind === k && overlap(f.text, t) > 0.8));
  if (dup) return { ...dup, existed: true };
  const f = { id: shortId(), kind: k, text: t, at: localDate(), source };
  writeFacts([...facts, f]);
  return f;
}

export function updateFact(id, text) {
  const facts = readFacts();
  const f = facts.find((x) => x.id === String(id).replace(/^#/, ''));
  if (!f) return null;
  if (!norm(text)) { writeFacts(facts.filter((x) => x !== f)); return { ...f, removed: true }; }
  f.text = norm(text);
  f.at = localDate();
  writeFacts(facts);
  return f;
}

export function removeFact(id) { return updateFact(id, ''); }

/** 两句话字面上有多像（两字片段的重合比例） */
export function overlap(a, b) {
  const grams = (s) => { const g = new Set(); for (let i = 0; i < s.length - 1; i++) g.add(s.slice(i, i + 2)); return g; };
  const A = grams(String(a)); const B = grams(String(b));
  if (!A.size || !B.size) return 0;
  let n = 0;
  for (const x of A) if (B.has(x)) n++;
  return n / Math.min(A.size, B.size);
}

export function factsText(facts = readFacts()) {
  if (!facts.length) return '（还不太了解他，聊着聊着记）';
  return facts.map((f) => `- #${f.id}［${f.kind}］${f.text}`).join('\n');
}

// ─── 聊天记录 ──────────────────────────────────────────────
// from: owner / her；kind: text（默认）/ sticker / voice / proactive（她主动找的）/ report（后台汇报）/ notice（提醒）
/** 每个对话一份记录：号主还是 qq-chat.jsonl，别人的是 qq-chat-p_10086.jsonl 这种 */
function chatFile(peer = 'owner') {
  if (!peer || peer === 'owner') return CHAT;
  return join(DATA, 'qq-chat-' + String(peer).replace(/[^a-z0-9_-]/gi, '_') + '.jsonl');
}
export function logChat({ from, text, kind, peer = 'owner', name, fid }) {
  const e = { ts: nowIso(), from, text: String(text || '').slice(0, 2000) };
  if (fid) e.fid = fid; // 同一条消息：日志一份、待回批次一份，拼上下文时靠它认出来只给模型一遍
  if (kind && kind !== 'text') e.kind = kind;
  if (name) e.name = String(name).slice(0, 30);
  appendJsonl(chatFile(peer), e);
  return e;
}

export function readChat(peer = 'owner') { return readJsonl(chatFile(peer)); }

/** 删掉这段对话的聊天原文 + 滚动摘要（及其备份），返回实际删掉的文件名（C4 删某人用）。号主的不许删。 */
export function purgeChat(peer = 'owner') {
  if (!peer || peer === 'owner') return [];
  const base = chatFile(peer);
  const removed = [];
  for (const f of [base, base + '.ctx.json', base + '.ctx.json.bak']) {
    try { if (existsSync(f)) { unlinkSync(f); removed.push(f.split(/[\\/]/).at(-1)); } } catch { /* 删不掉就报给调用方核对 */ }
  }
  return removed;
}

/** 最近的对话（/new 之后的、3 天内的、最多 n 条） */
export function recentChat(n = 24, now = Date.now(), peer = 'owner') {
  const all = readChat(peer);
  const cut = now - 3 * 86400_000;
  let start = 0;
  for (let i = all.length - 1; i >= 0; i--) if (all[i].kind === 'reset') { start = i + 1; break; }
  return all.slice(start).filter((e) => e.kind !== 'reset' && Date.parse(e.ts) >= cut).slice(-n);
}

/** 最近 N 天的对话全带（追加式上下文）：5 天外的交给遗忘那套（日结/印象/档案），这层只管连续感。号主/好友/群各用各的，互不串。
 *  charBudget>0 时再加一道字符闸门（C3）：按条数取完后，从最旧往前累计字符，超预算就把前面的砍掉——
 *  高频群一晚上几百条短消息也会撑爆窗口，条数上限挡不住，字符才是上下文体积的代理。至少留最后一条。 */
export function recentChatDays(days = 5, max = 400, peer = 'owner', charBudget = 0) {
  const all = readChat(peer);
  const cut = Date.now() - days * 86400_000;
  let start = 0;
  for (let i = all.length - 1; i >= 0; i--) if (all[i].kind === 'reset') { start = i + 1; break; }
  const win = all.slice(start).filter((e) => e.kind !== 'reset' && Date.parse(e.ts) >= cut).slice(-max);
  if (!(charBudget > 0)) return win;
  let sum = 0, from = win.length;
  for (let i = win.length - 1; i >= 0; i--) {
    sum += String(win[i].text || '').length;
    if (sum > charBudget) { from = i + 1; break; }
    from = i;
  }
  return win.slice(Math.min(from, Math.max(0, win.length - 1))); // 单条就超预算也留最后一条，别给个空窗口
}

/** 最近一次 /new 的时间（滚动摘要盖到 reset 之后就该作废） */
export function lastResetTs(peer = 'owner') {
  const all = readChat(peer);
  for (let i = all.length - 1; i >= 0; i--) if (all[i].kind === 'reset') return all[i].ts;
  return null;
}

// 追加式上下文的滚动摘要（qq-chat-xxx.jsonl.ctx.json）：upto 之前的话已压进 text，跟窗口同寿（5 天外作废，/new 之后也作废）
export function readCtxSum(peer = 'owner') {
  try { return JSON.parse(readFileSync(chatFile(peer) + '.ctx.json', 'utf-8')); } catch { return null; }
}
export function writeCtxSum(peer = 'owner', x) {
  try {
    // 压新的之前把旧的挪一份 .bak：摘要要是写跑偏了，至少能回滚到上一版，不至于一路错下去
    try { renameSync(chatFile(peer) + '.ctx.json', chatFile(peer) + '.ctx.json.bak'); } catch { /* 第一次写没有旧的可挪 */ }
    writeFileSync(chatFile(peer) + '.ctx.json', JSON.stringify(x, null, 2));
  } catch { /* 写不进就算了，下次再压 */ }
}

export function lastFrom(who, peer = 'owner') {
  const all = readChat(peer);
  for (let i = all.length - 1; i >= 0; i--) if (all[i].from === who && all[i].kind !== 'reset') return all[i];
  return null;
}

export function resetContext(peer = 'owner') { appendJsonl(chatFile(peer), { ts: nowIso(), from: 'owner', kind: 'reset', text: '' }); }

// ─── 每晚：从最近的聊天里补记 ───────────────────────────────
// 窗口按「上次日结的时间戳」切、不按自然日（照下面 digestGroup 的范式）：过了日结点之后聊的话，
// 按自然日当晚结不上、第二天也不再补，深夜的聊天就只活在 5 天上下文里、进不了长期记忆
export async function digestToday({ since, remember, now = Date.now() } = {}) {
  const sinceTs = Date.parse(since);
  const start = Number.isFinite(sinceTs) && sinceTs > 0 ? sinceTs : new Date(now).setHours(0, 0, 0, 0);
  const lines = readChat().filter((e) => e.kind !== 'reset' && Date.parse(e.ts) > start)
    .map((e) => `${e.from === 'owner' ? '他' : '我'}：${e.text}`);
  if (lines.length < 2) return null;
  const out = await llm.chat([
    { role: 'system', content: `${llm.PERSONA}\n整理一下最近这段跟号主（最熟的那个人）聊了什么。只输出 JSON。` },
    { role: 'user', content: `已经记着的他的事：\n${factsText()}\n\n这段时间的聊天：\n${lines.slice(-80).join('\n').slice(-6000)}

输出：
{"facts":[{"kind":"${KINDS.join('/')}","text":"关于他的、以后还用得上的事，一句话，第三人称（比如「他在做国学视频」）"}],
"fix":[{"id":"上面已记着的某条的 id（不带#）","text":"改成什么；这条不对了就空字符串"}],
"memory":"第一人称一两句：这段时间跟他聊了什么、我什么感觉（60字内）"}
只记新的、确实成立的；随口的玩笑、一次性的闲聊、密码身份证银行卡这类不记。没有就给空数组。` },
  ], { maxTokens: 700, tag: 'qq', essential: true });
  const j = llm.looseJson(out);
  const added = (Array.isArray(j.facts) ? j.facts : []).map((f) => addFact({ text: f.text, kind: f.kind, source: 'nightly' })).filter((f) => f && !f.existed);
  for (const x of Array.isArray(j.fix) ? j.fix : []) if (x?.id) updateFact(x.id, x.text);
  const memo = norm(j.memory);
  if (memo && remember) remember(memo);
  return { added: added.length, memory: memo };
}

// ─── 每晚：群聊/好友私聊日结（记忆升级阶段一） ──────────────
// 跟上面那个 digestToday 是两回事：那个记「号主的事」（owner facts），这个把群/私聊里发生的事
// 记进她自己的记忆流（memory.add kind:'chat'）。窗口按「上次日结的时间戳」切、不按自然日——
// 跨午夜的热聊不会被劈成两半；第一次跑从今天零点起，不回溯历史。
const NOISE = /^(\[[^\]]*\]|[哈嘿嗯哦啊呀啦喂6！!?？~～\s…·。.]+)$/; // 纯表情/图片标记/刷屏字符：不算聊过天
/** 「某某说了」这类称呼后面跟的动词，抓编造人名用的 */
const SAID = /([一-鿿]{2,4})(说了|说要|说：|问道|问：|问了一句|提到|吐槽|表示|回答说|喊)/g;
/** 人名校验：概括得至少锚上一个当天真说过话的人，且「某某说了」里的某某得是真人——凭空多出来的人=编的，整条丢 */
function fakeNames(text, src, speakers) {
  const hay = `${text} ${src.join(' ')}`;
  if (!speakers.some((s) => hay.includes(s))) return true;
  for (const m of hay.matchAll(SAID)) {
    const w = m[1];
    if (!speakers.some((s) => s.includes(w) || w.includes(s))) return true;
  }
  return false;
}

/**
 * 日结一个群/一段私聊。返回统计（没得结返回 null），记忆条目经 remember({kind,imp,text,src}) 写入。
 * 防水楼：同文和纯表情过滤后不足 6 条不结；防热群：同人连发并成一行、超 150 条只留最近的；
 * 防编造：人名校验 + src 原话锚点；items 超 8 条按重要程度留最高的。
 */
export async function digestGroup(peer, { since, remember, now = Date.now() } = {}) {
  const isGroup = String(peer).startsWith('g:');
  const label = `${isGroup ? '群' : '私'}·${String(peer).slice(2)}`; // 群名没地方存，先用群号/QQ号，认得出是哪个
  // 有上次日结的时间戳就从那切（跨午夜不断档）；没有（第一次跑）才从今天零点起，不回溯历史
  const sinceTs = Date.parse(since);
  const start = Number.isFinite(sinceTs) && sinceTs > 0 ? sinceTs : new Date(now).setHours(0, 0, 0, 0);
  const seen = new Set();
  const talk = [];
  for (const e of readChat(peer)) {
    if (e.kind === 'reset' || e.from === 'her' || Date.parse(e.ts) <= start) continue; // 只看别人说的、窗口内的
    const text = String(e.text || '').trim();
    if (!text || NOISE.test(text)) continue;
    const k = text.slice(0, 40);
    if (seen.has(k)) continue; // 同文刷屏只算一条
    seen.add(k);
    talk.push({ name: String(e.name || (isGroup ? '群友' : '他')), text });
  }
  if (talk.length < 6) return null;
  const rows = [];
  for (const e of talk) { // 同人连着说的并成一行（3 句以上标出来）
    const last = rows[rows.length - 1];
    if (last && last.name === e.name) { last.n++; last.text = `${last.text}；${e.text}`.slice(0, 120); } // 拼起来留前 120 字：话题的开头不能丢
    else rows.push({ name: e.name, text: e.text, n: 1 });
  }
  const cut = rows.slice(-150); // 超了只留最近的：晚间的话题最该结
  const speakers = [...new Set(cut.map((r) => r.name))];
  const lines = cut.map((r) => `${r.name}${r.n >= 3 ? `（连说了${r.n}句）` : ''}：${r.text.slice(0, 120)}`);
  // 聊天正文封顶：187 条 × 每行 120 字 = 上万字，网关对这种超长 prompt 直接空回包
  // （2026-11-25 群·1124893144 实测：6 次请求全空，同一分钟洞察/复盘/朋友都正常）。
  // 从尾部按整行取最近 6000 字——晚间话题最该结，也不切断任何一行。
  const CHAT_CAP = 6000;
  const tail = [];
  let tailLen = 0;
  for (let i = lines.length - 1; i >= 0; i--) {
    const add = lines[i].length + 1;
    if (tailLen + add > CHAT_CAP && tail.length) break;
    tail.unshift(lines[i]);
    tailLen += add;
  }
  const chatBody = tail.join('\n');
  const makeMessages = (body) => [
    { role: 'system', content: `${llm.PERSONA}\n整理一下${isGroup ? '群里' : '私聊里'}这一段聊天，挑出以后还值得她记住的事。只输出 JSON。` },
    { role: 'user', content: `聊天记录（${label}）：
${body}

从中挑出值得记的事，最多 8 条，每条：一句话、第三人称、写清是谁的事——名字只能用上面出现过的，没用过的人名不许出现。每条标重要程度：1=随口闲聊，3=有点意思，5=对她重要、会想再提起。
每条带 src：支撑它的原话片段（从上面原样抄，最多 2 条）。
无法确认是谁说了什么的，不补全、不猜测，直接不写这条。凑不出值得记的就给空数组。
输出：{"memory":"这段主要聊了什么，一两句（40字内）","items":[{"text":"概括","imp":3,"src":["原话片段"]}]}` },
  ];
  // 超长 prompt + 高温度时网关偶发回纯文字/空回包，looseJson 直接抛「没有 JSON」。
  // 旧代码静默吞掉 → 日志只显示"记了 0 条"，分不清模型真判空还是调用失败（2026-11-25 排障）。
  // 低温 + 阶梯重试：第一次用封顶后的全文，再失败逐级砍半（只留更近的聊天），避开网关冷却窗，
  // 彻底失败打一条带原始输出 + prompt 字数的告警，方便事后核对（2026-11-26 补）。
  let j = null, out = '', parseErr = null, promptLen = 0, usedAttempt = 0;
  for (let attempt = 0; ; attempt++) {
    const budget = Math.max(600, Math.ceil(chatBody.length / (2 ** attempt)));
    const body = chatBody.slice(-budget);
    promptLen = body.length;
    usedAttempt = attempt + 1;
    try {
      out = String(await llm.chat(makeMessages(body), { maxTokens: 700, temperature: 0.15, tag: 'qq', essential: true }) || '');
      j = llm.looseJson(out);
      break;
    } catch (e) {
      parseErr = e;
      if (/预算用完|额度用完/.test(String(e?.message || ''))) break;
      if (attempt >= 2) break; // 最多 3 次
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
  if (parseErr && !j) {
    // 全失败：保留 0 条的旧行为不炸，但把原始输出和 prompt 规模露出来，下次看日志就能判是长度顶住还是真没得结
    try { logAction({ kind: 'qq', source: 'auto', ok: false, detail: `⚠️ ${label} 日结没能解析（读了 ${talk.length} 条，prompt ${promptLen} 字第 ${usedAttempt} 次）：${String(parseErr.message || parseErr).slice(0, 60)}｜原文：${out.slice(0, 160) || '（空回包）'}` }); } catch { /* 日志不挡日结 */ }
  }
  const dropped = [];
  const items = (j && Array.isArray(j.items) ? j.items : [])
    .map((x) => ({
      text: norm(x.text),
      imp: Math.min(5, Math.max(1, Math.round(Number(x.imp) || 3))), // 越界/非数字钳回 1-5，缺省 3
      src: (Array.isArray(x.src) ? x.src : []).map((s) => String(s).slice(0, 80)).slice(0, 2),
    }))
    .filter((x) => x.text && x.text.length >= 6)
    .filter((x) => { const bad = fakeNames(x.text, x.src, speakers); if (bad) dropped.push(x.text); return !bad; })
    .sort((a, b) => b.imp - a.imp)
    .slice(0, 8); // 提示词限了 8 条，这里兜底：超了留重要程度最高的
  const memo = j ? norm(j.memory) : '';
  // keys 带上对话钥匙（g:群号 / p:QQ号）：合成印象按对话归组全靠它（没有钥匙就永远凑不成一组），
  // 性格演化也靠它把「朋友改变不了她性格」的那部分挡出去
  if (memo && remember) remember({ kind: 'chat', imp: 3, keys: [String(peer)], text: `「${label}」聊的主要是：${memo}` });
  for (const x of items) remember({ kind: 'chat', imp: x.imp, keys: [String(peer)], text: `「${label}」${x.text}`, ...(x.src.length ? { src: x.src } : {}) });
  if (dropped.length) logAction({ kind: 'qq', source: 'auto', detail: `⚠️ ${label} 日结丢了 ${dropped.length} 条像编的：${dropped.map((t) => t.slice(0, 20)).join('、')}` });
  return { peer, label, read: talk.length, items: items.length, meanImp: items.length ? +(items.reduce((s, x) => s + x.imp, 0) / items.length).toFixed(1) : 0 };
}

/** 群/私聊日结的调度单：扫出今天真聊过的对话（她自己的话不算），按条数排、取前几个；冷清的这儿就筛掉 */
export function digestCandidates(today, { top = 3 } = {}) {
  try {
    return readdirSync(DATA).filter((f) => /^qq-chat-[gp]_.*\.jsonl$/.test(f))
      .map((f) => f.slice('qq-chat-'.length, -'.jsonl'.length))
      .map((k) => k[0] + ':' + k.slice(2))
      .map((peer) => ({ peer, n: readChat(peer).filter((e) => e.kind !== 'reset' && e.from !== 'her' && localDate(new Date(e.ts)) === today).length }))
      .filter((x) => x.n >= 6)
      .sort((a, b) => b.n - a.n)
      .slice(0, top);
  } catch { return []; }
}

/** 群/好友日结跑一轮（阶段一）。原本写在 index.mjs 的 tick 里，挪出来是因为那边连着 NapCat 进程、
 *  测试进不去——调度本身不依赖连接。距上次 <20h 的跳过（容器半夜重启不重复结）；标记先写再干活，
 *  中途崩的代价只是这段少结一次；单群失败跳过、不拖垮后面的群。 */
export async function groupDigestRound({ now = Date.now(), candidates = digestCandidates(localDate(new Date(now))), digest = digestGroup, remember = () => {}, log = logAction, alertFn = null } = {}) {
  const done = [];
  for (const { peer } of candidates) {
    const since = (readState().groupDigest || {})[peer] || '';
    if (now - Date.parse(since || '') < 20 * 3600_000) continue;
    // C5：改成「跑成才写」——原来先写时间戳再跑，跑挂了这段窗口 20 小时内都不再结。
    // 现在成功后才落标记；失败不写，下一班 tick 会重捡（digest 按 since 切窗口，不会重复记）。
    try {
      const r = await digest(peer, { since, remember });
      writeState({ ...readState(), groupDigest: { ...(readState().groupDigest || {}), [peer]: nowIso() } });
      if (r) {
        log({ kind: 'qq', source: 'auto', detail: `📔 ${r.label} 日结：${r.read} 条 → 记了 ${r.items} 条${r.items ? `（imp 均值 ${r.meanImp}）` : ''}` });
        done.push(r);
      }
    } catch (e) {
      console.error(`[qq] ${peer} 的日结没跑成：`, e.message);
      done.push({ peer, error: e.message });
      // A3 告警：动态 import 破环（alert → notify → qq/index → owner），fire-and-forget
      const send = alertFn || ((await import('../alert.mjs')).alert);
      send('digest:' + peer, `${peer} 日结没跑成，下一班再试：${String(e.message || e).slice(0, 60)}`).catch(() => {});
    }
  }
  return done;
}

// ─── 从 DSH 带过来 ─────────────────────────────────────────
const DSH_MEM = join(homedir(), '.dsh', 'memory');
const DSH_WS = join(DSH_MEM, 'workspaces', `--${ROOT.replace(/\//g, '-')}--`);
// 一看就是工程排查的行：不是号主的事
const DEV = /(根因|插件|npm|peerDep|gateway|网关|\.json|\.mjs|\.md\b|~\/|\/Users\/|launchd|commit|报错|排查|升级到|rc\.\d|DSH|cookie|SESSDATA|配置文件|bilibili-mcp)/i;

/** 读 DSH 里能找到的记忆原文（只读），去掉明显的工程笔记 */
export function dshSources({ days = 14 } = {}) {
  const parts = [];
  const read = (f) => { try { return readFileSync(f, 'utf-8'); } catch { return ''; } };
  const push = (label, text) => {
    const keep = text.split('\n').filter((l) => l.trim() && !DEV.test(l)).join('\n').trim();
    if (keep) parts.push(`【${label}】\n${keep}`);
  };
  push('全局记忆', read(join(DSH_MEM, 'MEMORY.md')));
  if (existsSync(DSH_WS)) {
    push('这个工作区的记忆', read(join(DSH_WS, 'MEMORY.md')));
    const daily = readdirSync(DSH_WS).filter((f) => /^\d{4}-\d{2}-\d{2}\.md$/.test(f)).sort().slice(-days);
    for (const f of daily) push(`日志 ${f.slice(0, 10)}`, read(join(DSH_WS, f)));
    const refl = join(DSH_WS, 'reflections');
    if (existsSync(refl)) for (const f of readdirSync(refl).filter((x) => x.endsWith('.md')).sort().slice(-days)) push(`反思 ${f.slice(0, 10)}`, read(join(refl, f)));
  }
  return parts;
}

export async function importDsh() {
  const parts = dshSources();
  if (!parts.length) return { added: 0, why: '没找到 DSH 的记忆文件' };
  // 太长就分几段让模型看（每段 ~6000 字）
  const chunks = [];
  let cur = '';
  for (const p of parts) {
    if ((cur + p).length > 6000 && cur) { chunks.push(cur); cur = ''; }
    cur += `${p.slice(0, 6000)}\n\n`;
  }
  if (cur) chunks.push(cur);
  let added = 0;
  for (const c of chunks) {
    const out = await llm.chat([
      { role: 'system', content: '你在帮「蓝色大肥鱼」（一个 AI 伙伴）整理她对号主（她最熟的那个人）的了解。只输出 JSON。' },
      { role: 'user', content: `下面是以前的记忆笔记，里面混着号主的事、她自己刷 B站 的经历、还有一些工程笔记。
只挑**关于号主本人**、以后聊天还用得上的事（称呼、身份、在做什么、偏好、作息、计划、口头禅、近况、他定的规矩），每条一句话、第三人称。
她自己刷 B站 的经历、工程/排查/配置的东西、密码身份证这类都不要。

${c}

输出：{"facts":[{"kind":"${KINDS.join('/')}","text":"……"}]}` },
    ], { maxTokens: 1500, tag: 'qq', essential: true, temperature: 0.3 });
    const j = llm.looseJson(out);
    for (const f of Array.isArray(j.facts) ? j.facts : []) { const r = addFact({ text: f.text, kind: f.kind, source: 'dsh' }); if (r && !r.existed) added++; }
  }
  logAction({ kind: 'qq', source: 'panel', detail: `从 DSH 的记忆里带过来 ${added} 条关于你的事` });
  return { added, total: readFacts().length };
}
