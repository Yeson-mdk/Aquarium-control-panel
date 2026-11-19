/**
 * 她自己的记忆流（memory）
 *
 * DSH 的记忆插件只把「当天」的记忆带进对话，三周前刷到的那个 UP 主、上个月在评论区聊过的人，她就想不起来了。
 * 这里学 Generative Agents：每段经历都记一条，要用的时候按三样打分，挑最该想起的几条：
 *
 *  - 多久以前（recency）：按「上次想起」算，半衰期 7 天；被想起一次就又清楚一点。
 *  - 重不重要（importance）：1~5。看视频用她打的喜欢分，反思、跟人聊天更重一点。
 *  - 跟眼下有多相关（relevance）：关键词命中（UP主、某个人）+ 中文二字片段的重合度。
 *    不用向量模型，因为面板里配的接口不一定有 embedding。
 *
 * 相关度太低的不参与排名，免得一条很重要但八竿子打不着的记忆每次都冒出来。
 *
 * 每晚整理一次（tidy，跟着睡前反思跑）：
 *  - 合并：几天前的、同一个 UP 主 / 同一个人 / 差不多一回事的好几条，让她自己概括成一条「印象」（kind: gist）。
 *  - 遗忘：每条有个寿命 = 10 天 × 重要程度 ×（1 + 被想起的次数，最多算 5 次），过了寿命还没被想起就忘掉。
 *    喜欢分 1 的视频十来天就忘，常被想起的、合并出来的印象能留很久；睡前反思（self）不忘。
 *  - 塞满了（MAX 条）先挤掉最淡的，不是最老的。
 * 数据在 data/memories.json（人能直接读、直接改）。QQ 里的她想不起来时跑 recall.mjs 查。
 */
import { readFileSync, writeFileSync, renameSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { DATA, readActions, nowIso, logAction } from './store.mjs';
import * as llm from './llm.mjs';
import * as memdb from './memdb.mjs';
import { tuning } from './qq/tuning.mjs';
import { withLock } from './memlock.mjs';

const { looksInjected } = llm;

const FILE = join(DATA, 'memories.json');
const MAX = 1500;
const HALF_LIFE_DAYS = 7;
const W = { recency: 1, importance: 1, relevance: 2 };
const MIN_REL = 0.12; // 二字片段重合低于这个、又没有关键词命中，就当不相关

// 每次都从文件读：面板进程和 QQ 里跑的 recall.mjs 会同时碰它，别各拿一份缓存互相覆盖
function load() {
  try {
    return JSON.parse(readFileSync(FILE, 'utf-8'));
  } catch {
    // 文件存在但 JSON 坏了（断电/磁盘）：先改名留档再返回空，绝不能让下一次 add() 把坏文件覆盖成空表——
    // 那样 1500 条记忆无声蒸发（2026-11-19 查出来的坑）。留档用时间戳，跟 bili.unlockCoin 一个范式。
    if (existsSync(FILE)) {
      const kept = `${FILE}.corrupt-${Date.now()}`;
      try {
        renameSync(FILE, kept); // 改名成功才告警：确认原始内容还在，方便人工捞
        console.error('[memory] memories.json 坏了，已改名留档 ' + kept + '，先用空表重建（旧内容没删，可捞回）');
        try { logAction({ kind: 'autopilot', source: 'auto', ok: false, detail: `🧠 记忆本子损坏，已改名留档（${kept.split('/').pop()}），暂用空表重建——旧内容没删，可从留档捞回` }); } catch { /* 日志不挡正事 */ }
      } catch (e) {
        // 改名都失败（只读盘/权限）：宁可返回空也别硬读，但这支会重建覆盖——告警让人知道盘有问题
        console.error('[memory] memories.json 坏了且改名留档失败：' + e.message + '，这次用空表，原文件可能仍被覆盖');
        try { logAction({ kind: 'autopilot', source: 'auto', ok: false, error: e.message, detail: '🧠 记忆本子损坏且改名留档失败，原文件可能被空表覆盖——检查磁盘/权限' }); } catch { /* 日志不挡正事 */ }
      }
      return [];
    }
    const all = backfill();
    if (all.length) withLock(() => save(all)); // 首次重建也要抢锁，别两个进程同写 FILE.tmp
    return all;
  }
}

function save(all) {
  if (all.length > MAX) {
    const now = Date.now();
    const keep = new Set([...all].sort((a, b) => strength(b, now) - strength(a, now)).slice(0, MAX));
    const dropped = all.filter((e) => !keep.has(e));
    all = all.filter((e) => keep.has(e));
    if (dropped.length) {
      try { logAction({ kind: 'autopilot', source: 'auto', detail: `🧠 记忆本子塞满了（${all.length + dropped.length} 条上限 ${MAX}），挤掉 ${dropped.length} 条最淡的：${dropped.map((e) => String(e.text || '').slice(0, 12)).join('、')}` }); } catch { /* 日志不挡正事 */ }
    }
  }
  const tmp = FILE + '.tmp';
  writeFileSync(tmp, JSON.stringify(all, null, 1));
  renameSync(tmp, FILE);
  memdb.syncAll(all); // 增量镜像进档案库（只增改不删，遗忘的留档）
}

const DAY = 86400_000;
const idleDays = (e, now) => (now - Date.parse(e.seen || e.ts)) / DAY;
/** 寿命（天）：重要的、常被想起的活得久 */
export const lifeDays = (e) => 10 * e.imp * (1 + Math.min(e.n || 0, 5));
/** 还剩多清楚：0~5，给「塞满了先挤掉谁」用 */
const strength = (e, now) => (e.kind === 'self' ? 99 : e.imp * 0.5 ** (idleDays(e, now) / lifeDays(e)));

/** 第一次用：从活动记录里把以前的内心独白捞回来，不然记忆是从今天才开始的 */
function backfill() {
  return readActions()
    .filter((a) => a.kind === 'watch' && a.meta?.thought)
    .map((a) => entry({
      ts: a.ts, kind: 'watch', imp: a.meta.score || 2,
      text: `看了《${a.title}》（${a.meta.owner || '某UP'}）：${a.meta.thought}`,
      keys: [a.meta.owner && `up:${a.meta.owner}`, a.target && `bv:${a.target}`],
    }));
}

function entry({ ts = nowIso(), kind, text, keys = [], imp = 3, src }) {
  const e = {
    id: `${Date.parse(ts).toString(36)}${Math.random().toString(36).slice(2, 6)}`,
    ts, kind, text: String(text).replace(/\s+/g, ' ').trim().slice(0, 200),
    keys: [...new Set(keys.filter(Boolean).map(String))],
    imp: Math.max(1, Math.min(5, Math.round(imp))),
    seen: null, // 上次被想起的时间
    n: 0, // 被想起过几次
  };
  // 原话锚点（记忆升级阶段一）：日结条目带上支撑它的原话片段，人工排查「她记的是不是编的」时对账用
  if (Array.isArray(src) && src.length) e.src = src.map((s) => String(s).slice(0, 80)).slice(0, 2);
  return e;
}

/**
 * 4.3 旁路打向量：落库后 fire-and-forget，回来单条 setVec（不经过 syncAll，避免被全量覆盖冲掉）。
 * 没配向量模型 / 接口挂了 / 断网 → 静默不动，vec 留 null，检索走纯关键词（上线分界线）。
 * 只碰 SQLite 档案库的 vec 列，不写 json——权威还是 memories.json，向量只是检索加速。
 */
function embedAside(id, text) {
  if (!llm.embedReady()) return;
  Promise.resolve(llm.embed([text])).then((vecs) => {
    if (vecs?.[0]) memdb.setVec(id, vecs[0]);
  }).catch(() => { /* 向量是锦上添花，失败不惊动记忆主路径 */ });
}

/** 记一条。keys 用「up:UP主名」「uid:123」「bv:BV...」这种前缀，方便精确命中 */
export function add(x) {
  if (!x?.text || looksInjected(x.text)) return null;
  const e = entry(x);
  withLock(() => {
    const all = load();
    all.push(e);
    save(all);
  });
  embedAside(e.id, e.text); // 落库后再打向量，add 的同步签名和返回值都不变
  return e;
}

// 中文按二字片段、英文数字按词切，拿来算重合度
function grams(text) {
  const out = new Set();
  const t = String(text || '').toLowerCase();
  for (const w of t.match(/[a-z0-9]{2,}/g) || []) out.add(w);
  for (const run of t.match(/[一-鿿]+/g) || []) {
    if (run.length === 1) out.add(run);
    for (let i = 0; i < run.length - 1; i++) out.add(run.slice(i, i + 2));
  }
  return out;
}

function overlap(a, b) {
  if (!a.size || !b.size) return 0;
  let n = 0;
  for (const g of a) if (b.has(g)) n++;
  return n / Math.sqrt(a.size * b.size);
}

/** 一条候选的 S 得分（recency + imp + relevance，self 洞察再打折）——主路和向量补路共用，口径一致 */
function scoreOf(e, rel, now, t) {
  const age = (now - Date.parse(e.seen || e.ts)) / 86400_000;
  const recency = 0.5 ** (Math.max(0, age) / HALF_LIFE_DAYS);
  // 2.4 洞察（self）是猜想不是观测：整体打分乘折扣（tuning.memory.selfDiscount 可调），
  // 不然一条高 imp 的假洞察会以同等权重污染聊天、反思、以后的所有行为
  const disc = e.kind === 'self' ? t.memory.selfDiscount : 1;
  return (W.recency * recency + W.importance * (e.imp / 5) + W.relevance * rel) * disc;
}

/**
 * 想起最相关的几条。query 是眼下在想的事（标题、对方说的话……），keys 是能精确命中的线索。
 * 想起的会刷新「上次想起」时间（touch=false 只看不碰，给面板用）。
 * scope（2.8 对话级召回）传当前对话的钥匙（如 ['g:群号']）：她自己的事全局可见，
 * 带对话钥匙的 chat/gist 只在钥匙全落在本对话里才可见——见 memdb.scopeVisible。
 *
 * queryVec（阶段四 4A）：聊天热路径预取好的 query 向量。传了才启用语义混合——
 * 不传时下面的打分/过滤/兜底与 4A 之前逐字一致（CLI、测试、recall-check、mind 全是同步调用，零改动）。
 */
export function recall(query, opts = {}) {
  // touch=true 的 recall 会 load→改 seen/n→save，和 add/面板写同一份文件，必须串行（B1）
  return withLock(() => recallLocked(query, opts));
}

function recallLocked(query, { keys = [], k = 3, kinds, scope, exclude = [], touch = true, now = Date.now(), queryVec } = {}) {
  const q = grams(query);
  // 短查询（「猫」「土星 UP主」）切不出几个二字片段，按词直接找
  const words = String(query || '').split(/[\s,，、。！？!?;；]+/).filter((w) => w && w.length <= 6);
  const want = new Set(keys.filter(Boolean).map(String));
  const skip = new Set(exclude);
  const scopeSet = scope?.length ? new Set(scope.map(String)) : null;
  const all = load();
  const t = tuning();
  const semMode = Array.isArray(queryVec) && queryVec.length > 0;
  const kwW = Number.isFinite(t.memory.kwW) ? t.memory.kwW : 0.4;
  const vecW = Number.isFinite(t.memory.vecW) ? t.memory.vecW : 0.6;

  // 语义路（只在有 queryVec 时跑）：从档案库拿全量语义候选，建 id→余弦；
  // 被遗忘的旧事（不在 json 活记忆里）单独留着，稍后和主路一起排序。
  // memdb.search 内部已过 kinds/scope/dead 闸，这里再按 skip 排一次。
  let semMap = new Map();
  let vecArchived = [];
  if (semMode) {
    for (const v of memdb.search('', { k: 60, exclude: skip, kinds, scope: scopeSet, queryVec })) {
      if (typeof v._sem === 'number') semMap.set(v.id, v._sem);
      if (!all.some((e) => e.id === v.id)) vecArchived.push(v);
    }
  }

  const scored = [];
  for (const e of all) {
    if (kinds && !kinds.includes(e.kind)) continue;
    if (e.dead) continue; // 被推翻的洞察：标记失效不删（错了还能翻回来），但不再「被想起来」
    if (scopeSet && !memdb.scopeVisible(e, scopeSet)) continue;
    if (e.keys.some((x) => skip.has(x))) continue;
    const hit = e.keys.some((x) => want.has(x));
    const hay = `${e.text} ${e.keys.join(' ')}`;
    const wordHit = words.length ? (0.6 * words.filter((w) => hay.includes(w)).length) / words.length : 0;
    const kwRel = Math.min(1, Math.max(overlap(q, grams(hay)), wordHit) + (hit ? 0.5 : 0));
    const sem = semMode ? (semMap.get(e.id) || 0) : 0;
    // 无 queryVec：rel 就是关键词分（原样）。有 queryVec：按 kwW/vecW 混合。
    const rel = semMode ? (kwW * kwRel + vecW * sem) : kwRel;
    // MIN_REL 过滤：keys 精确命中照旧无条件放行；语义路里余弦够高（≥0.35）的也算「换说法命中」
    if (!hit && (semMode ? (rel < MIN_REL && sem < 0.35) : kwRel < MIN_REL)) continue;
    scored.push({ e, score: scoreOf(e, rel, now, t) });
  }
  // 被遗忘的旧事：只有语义路够相似（≥0.35）才让它进候选，避免向量把一堆八竿子打不着的档案翻出来
  if (semMode) {
    for (const v of vecArchived) {
      if ((v._sem || 0) < 0.35) continue;
      scored.push({ e: v, score: scoreOf(v, vecW * v._sem, now, t), archived: true });
    }
  }
  const ranked = scored.sort((a, b) => b.score - a.score).slice(0, k);
  const top = ranked.map((x) => x.e);
  if (touch && top.length) {
    const nowIsoStr = nowIso();
    for (const x of ranked) {
      if (x.archived) continue; // 旧事不在活记忆里，touch 不到，别白改
      const e = x.e; e.seen = nowIsoStr; e.n = (e.n || 0) + 1;
    }
    save(all);
  }
  // 想的不够数：去档案库翻翻被遗忘的旧事（合并/遗忘前的原文都留在那），最多补到 3 条。
  // kinds / scope 必须原样传下去：上面「非号主只看自己事 + 本对话」的防串场要是漏到兜底这步，
  // 归档里的号主聊天日结、别的群的日结照样会冒给陌生人（2.8：档案兜底和主路同一道闸）。
  // 这里不传 queryVec——语义候选已在上面统一排过序，兜底这条只管纯关键词翻旧事，职责单一。
  if (top.length < Math.min(k, 3)) {
    const known = new Set(all.map((e) => e.id));
    for (const old of memdb.search(query, { k: Math.min(k, 3) - top.length, exclude: known, kinds, scope: scopeSet })) top.push({ ...old, archived: true });
  }
  return top;
}

export function ago(ts, now = Date.now()) {
  const d = Math.floor((now - Date.parse(ts)) / 86400_000);
  if (d <= 0) return '今天';
  if (d === 1) return '昨天';
  if (d < 14) return `${d} 天前`;
  if (d < 60) return `${Math.round(d / 7)} 周前`;
  return `${Math.round(d / 30)} 个月前`;
}

/** 一条记忆翻成给模型看的一行。
 *  self 条目（反思/洞察）是她的猜想不是观测：标注出来，免得被当史实往外说、越传越歪（阶段一防幻觉）；
 *  归档库翻出来的旧事也标一下。这道护栏 recallText、recall 工具（brain）、CLI（recall.mjs）共用——
 *  别处各自拼行的话标注就丢了（号主一问「以前」她就拿猜想当史实说）。 */
export function recallLine(e) {
  return `- ${ago(e.ts)}${e.kind === 'self' ? '（自己的想法，不一定是事实）' : ''}${e.archived ? '（有点久远，想不太清了）' : ''}：${e.text}`;
}

/** 拼成给模型看的几行；什么都没想起来就返回空字符串 */
export function recallText(query, opts) {
  return recall(query, opts).map(recallLine).join('\n');
}

/** 给面板：印象（她自己概括的 gist + 每晚聊天日结）单拎出来展示，档案给个规模；recent 仍是全部（今天的事给模型看用） */
/** 全部活记忆的只读快照（面板删除清单/审计用，别改返回值） */
export function allEntries() { return load().map((e) => ({ ...e })); }

export function memoryView(n = 30) {
  const all = load();
  const live = all.filter((e) => !e.dead); // dead = 被推翻的洞察，不进给模型看的任何一路
  const isGist = (e) => e.kind === 'gist' || e.kind === 'chat';
  memdb.init(); // 拿档案规模要连一下库（起来之后是空操作）
  return {
    total: live.length,
    gistCount: live.filter(isGist).length,
    recent: live.slice(-n).reverse(),
    gists: live.filter(isGist).slice(-n).reverse(),
    // 2.6 洞察栏：她自己归纳的结论（kind self）；被 retire 的单列（面板灰显/折叠用，别真藏死——错了还能翻回来）
    insights: live.filter((e) => e.kind === 'self').slice(-n).reverse(),
    retiredInsights: all.filter((e) => e.kind === 'self' && e.dead).slice(-n).reverse(),
    archive: memdb.stats(), // 淡忘档案：被合并 / 遗忘的原文都留在里面
  };
}

/** 推翻一条洞察（2.3）：置 dead 标记，recall / view / 档案检索都不再放它出来；
 *  条目本身留在 memories.json 和档案里——错了还能翻回来，是标记不是删除。 */
export function retire(id) {
  return withLock(() => {
    const all = load();
    const e = all.find((x) => x.id === id);
    if (!e) return false;
    e.dead = true;
    e.seen = null;
    save(all); // save 会同步镜像进 memdb，档案检索那边的 dead 过滤靠它
    return true;
  });
}

/** 你在面板里改：记错了的改正文、调重要程度。改过的算她刚想起来，寿命重新算 */
export function update(id, { text, imp } = {}) {
  let result = null;
  withLock(() => {
    const all = load();
    const e = all.find((x) => x.id === id);
    if (!e) return;
    if (text !== undefined) {
      const t = String(text).replace(/\s+/g, ' ').trim().slice(0, 200);
      if (!t || looksInjected(t)) return;
      e.text = t;
    }
    if (imp !== undefined) e.imp = Math.max(1, Math.min(5, Math.round(Number(imp)) || e.imp));
    e.seen = nowIso();
    e.edited = true;
    save(all);
    result = e;
  });
  if (result && text !== undefined) embedAside(result.id, result.text); // 正文改了，旧向量作废，重打一次覆盖
  return result;
}

export function remove(id) {
  return withLock(() => {
    const all = load();
    const i = all.findIndex((e) => e.id === id);
    if (i < 0) return false;
    all.splice(i, 1);
    memdb.purge(id); // 面板里删的，档案里也不留
    save(all);
    return true;
  });
}

/** 按对话钥匙批量删记忆（C4 删某人全部数据）：keys 里含任一给定钥匙的条目全删，连 memdb 一起。
 *  返回删掉的条目（给删除清单/审计用）；同样过写锁，跟 remove 一个事务口径。 */
export function removeByKeys(wanted) {
  const keys = (Array.isArray(wanted) ? wanted : [wanted]).map(String).filter(Boolean);
  if (!keys.length) return [];
  return withLock(() => {
    const all = load();
    const doomed = all.filter((e) => (e.keys || []).some((k) => keys.includes(String(k))));
    if (!doomed.length) return [];
    const ids = new Set(doomed.map((e) => e.id));
    save(all.filter((e) => !ids.has(e.id)));
    for (const id of ids) memdb.purge(id);
    return doomed;
  });
}

// ─── 每晚整理：合并、遗忘 ───────────────────────────────────
const MERGE_AFTER_DAYS = 3; // 太新的先留着细节，过几天再概括
const MERGE_MIN = 3; // 至少几条才值得合并
const MERGE_GROUPS = 6; // 一晚最多合几组（一次模型调用全概括完）
const MERGEABLE = new Set(['watch', 'social', 'session', 'chat']); // chat = 每晚的聊天日结，攒几天也该合成一条印象

/** 钥匙翻成人话，给合并概括的提示词看 */
const keyName = (k) => k.startsWith('up:') ? `UP主 ${k.slice(3)}` : k.startsWith('uid:') ? '同一个人' : k === 'owner' ? '跟号主的聊天' : k.startsWith('g:') ? `群 ${k.slice(2)} 的聊天` : k.startsWith('p:') ? `和 ${k.slice(2)} 的私聊` : k;

/** 挑出要合并的几组：先按同一个 UP 主 / 同一个人 / 同一段对话，剩下的按内容像不像 */
export function mergeGroups(all, now = Date.now()) {
  const old = all.filter((e) => MERGEABLE.has(e.kind) && (now - Date.parse(e.ts)) / DAY >= MERGE_AFTER_DAYS);
  const used = new Set();
  const groups = [];
  const byKey = new Map();
  for (const e of old) {
    const k = e.kind === 'social' ? e.keys.find((x) => x.startsWith('uid:')) : e.kind === 'watch' ? e.keys.find((x) => x.startsWith('up:')) : e.kind === 'chat' ? e.keys.find((x) => x === 'owner' || /^[gp]:/.test(x)) : null;
    if (k) byKey.set(k, [...(byKey.get(k) || []), e]);
  }
  for (const [key, list] of byKey) {
    if (list.length >= MERGE_MIN) { groups.push({ key, list }); list.forEach((e) => used.add(e.id)); }
  }
  const rest = old.filter((e) => !used.has(e.id) && e.kind !== 'social');
  const g = new Map(rest.map((e) => [e.id, grams(e.text)]));
  for (const seed of rest) {
    if (used.has(seed.id)) continue;
    const list = rest.filter((e) => !used.has(e.id) && (e === seed || overlap(g.get(seed.id), g.get(e.id)) >= 0.3));
    if (list.length >= MERGE_MIN) { groups.push({ key: null, list }); list.forEach((e) => used.add(e.id)); }
  }
  return groups.sort((a, b) => b.list.length - a.list.length).slice(0, MERGE_GROUPS);
}

/** 过了寿命、又没被想起的 */
export function forgettable(all, now = Date.now()) {
  return all.filter((e) => e.kind !== 'self' && idleDays(e, now) > lifeDays(e));
}

async function summarize(groups) {
  const body = groups.map((gr, i) => `[${i}]${gr.key ? `（都跟 ${keyName(gr.key)} 有关）` : ''}\n${gr.list.map((e) => `- ${ago(e.ts)}：${e.text}`).join('\n')}`).join('\n\n');
  const out = await llm.chat([
    { role: 'system', content: `${llm.PERSONA}\n睡前翻翻自己的记忆，把零零碎碎的几条概括成一条印象。只输出 JSON。` },
    { role: 'user', content: `下面每组是你记得的几件差不多的事：
${body}

每组概括成一句第一人称的印象（60字内）：留下具体的名字、UP主、标题里的关键词和你的感受，别写成流水账，也别加原来没有的事。
{"gists":[{"i":组号,"text":"概括"}]}` },
  ], { maxTokens: 900, tag: 'memory', essential: true });
  const j = llm.looseJson(out);
  return new Map((Array.isArray(j.gists) ? j.gists : [])
    .map((x) => [Number(x.i), String(x.text || '').replace(/\s+/g, ' ').trim().slice(0, 120)])
    .filter(([i, t]) => groups[i] && t.length >= 6 && !looksInjected(t)));
}

/**
 * 整理一次。合并要调模型（没配、出错就只做遗忘）；调模型那会儿别的地方可能又记了新的，
 * 所以最后重新读一遍文件，只删掉这次处理过的那几条，再把印象加进去。
 */
export async function tidy({ now = Date.now(), useLlm = llm.llmReady() } = {}) {
  const snap = load();
  const groups = useLlm ? mergeGroups(snap, now) : [];
  let gists = new Map();
  if (groups.length) {
    try { gists = await summarize(groups); } catch { /* 明晚再合 */ }
  }
  const drop = new Set();
  const added = [];
  for (const [i, text] of gists) {
    const list = groups[i].list;
    list.forEach((e) => drop.add(e.id));
    const last = list.reduce((a, b) => (a.ts > b.ts ? a : b));
    const seen = list.map((e) => e.seen).filter(Boolean).sort().pop() || null;
    added.push({
      ...entry({
        ts: last.ts, kind: 'gist', text,
        keys: list.flatMap((e) => e.keys).filter((k) => !k.startsWith('bv:')),
        imp: Math.min(5, Math.max(...list.map((e) => e.imp)) + (list.length >= 5 ? 1 : 0)),
        // 原话锚点跟着进印象：被合并的条目 tidy 后只活在档案库里（那边没 src 列），印象不继承的话锚点就断在这里
        src: list.flatMap((e) => e.src || []).slice(0, 2),
      }),
      seen, n: list.reduce((s, e) => s + (e.n || 0), 0), from: list.length,
    });
  }
  const forgot = forgettable(snap, now).filter((e) => !drop.has(e.id));
  forgot.forEach((e) => drop.add(e.id));
  if (!drop.size && !added.length) return { merged: 0, into: 0, forgot: 0, total: snap.length };

  // 末尾这段重新 load→拼→save 是真正的读-改-写窗口（await 调模型那会儿不能持同步锁）。
  // 重新 load 放在锁内，才不会把模型思考期间别人写进来的新记忆覆盖掉（B1）。
  let all;
  withLock(() => {
    const fresh = load().filter((e) => !drop.has(e.id));
    all = [...fresh, ...added].sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0));
    save(all);
  });
  return { merged: drop.size - forgot.length, into: added.length, forgot: forgot.length, total: all.length, gists: added.map((e) => e.text) };
}
