/**
 * 阶段四 4A 验收：「换说法」探针（一次性脚本，不改任何记忆）
 *
 * 为什么需要：recall-check 用「原文前 10 个字」查自己，必然全绿，证明不了「换个说法想不想得起来」。
 * 这个脚本反过来——从真实记忆里挑 10 条，让主模型把每条改写成一句**不含原词**的随口问法，
 * 再分别用「纯关键词」和「关键词 + 向量」各召回一次，看目标条目在不在 top-3。
 * 向量命中 ≥7/10 = 阶段四值得留；向量和关键词差不多 = 这 10 条换说法不够换，或向量没真启用。
 *
 * 跑法（在 NAS 上）：
 *   node panel/probe-semantic.mjs              # 默认抽 10 条
 *   node panel/probe-semantic.mjs 20           # 抽 20 条（更慢，更准）
 *
 * 前提：面板「向量模型」已配 + ModelScope 令牌已填 + 跑过 backfill-vec.mjs。
 * 没配也没关系：脚本会照常跑出关键词基线，并明确告诉你向量这一列为什么没生效。
 *
 * 只读：不写 memories.json / memory.db，不刷新 seen（recall 全程 touch:false）。
 * 注入 chatFn/embedFn/recallFn/loadFn 供测试用假接口，生产一律走真模块。
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DATA, readConfig } from './store.mjs';
import * as llm from './llm.mjs';
import * as memory from './memory.mjs';
import * as memdb from './memdb.mjs';

const FILE = join(DATA, 'memories.json');
const DEFAULT_COUNT = 10;
const PASS_LINE = 7; // ≥7/10 才算「换说法也想得起来」

/** 挑候选：活记忆里长度适中、有具体内容的观测（self 洞察/太短的跳过），imp 高的优先，id 稳定排序保证可复现 */
export function pickCandidates(all, count = DEFAULT_COUNT) {
  const pool = (Array.isArray(all) ? all : [])
    .filter((e) => e && !e.dead && e.kind !== 'self' && typeof e.text === 'string'
      && e.text.length >= 14 && e.text.length <= 220)
    .sort((a, b) => (Number(b.imp) || 3) - (Number(a.imp) || 3) || String(a.id).localeCompare(String(b.id)));
  return pool.slice(0, Math.max(1, count));
}

let lastChatErr = '';
/** 最近一次改写失败的原因（主模型 chat 抛错/空回话），CLI 报告里直接显示，别再只说「没生成出来」 */
export function chatError() { return lastChatErr; }

/** 让主模型把一条记忆改写成「换了个说法」的查询。只输出一句话；失败返回 null。 */
export async function makeParaphrase(mem, chatFn = (msgs, opts) => llm.chat(msgs, opts)) {
  const prompt = `你在帮一个记忆系统做检索测试。它记住了一件事，请写一句「换了个说法」的查询——就像你忘了原话、只留了个模糊印象，用别的词去把它问出来。
要求：
- **不要照抄原文里的具体名词**（菜名、地名、UP主名、品牌、专有词），换成更笼统、更日常的说法。比如原文是「中午吃了烧腊饭」，你要写「她最近吃过什么」；原文是「机械键盘轴体」，你要写「打字用的东西」。
- 8～25 个字，像随口一问，别写「查询：」这类前缀。
- 只输出这一句话，别的话都不要。

它记住的是：${llm.fence(String(mem.text || ''), 220)}`;
  try {
    const out = await chatFn([{ role: 'user', content: prompt }], { maxTokens: 80, temperature: 0.6, tag: 'test', essential: true });
    const q = String(out || '').trim().replace(/^["'「『]|["'」』]$/g, '').replace(/\s+/g, ' ').slice(0, 40);
    if (q.length < 3) { lastChatErr = '主模型回了空内容（接口限流/降级的已知行为，或 key 失效）'; return null; }
    lastChatErr = '';
    return q;
  } catch (e) {
    lastChatErr = e?.message || String(e); // 401/余额/网络等真实原因，报告里露出
    return null;
  }
}

/**
 * 主探针。返回结构化结果，CLI 和面板/测试都能用。
 * 不写任何文件；recall 全程 touch:false。
 */
export async function semanticProbe({
  count = DEFAULT_COUNT,
  loadFn = () => JSON.parse(readFileSync(FILE, 'utf-8')),
  chatFn,
  embedFn = (texts) => llm.embed(texts),
  recallFn = (query, opts) => memory.recall(query, opts),
  topK = 3,
} = {}) {
  let all = [];
  try { all = loadFn(); } catch (e) {
    return { ok: false, reason: `读不到记忆库（${e.message}）。在 NAS 上跑，或用 YANGYU_DATA 指到数据目录` };
  }
  const picked = pickCandidates(all, count);
  if (!picked.length) return { ok: false, reason: '记忆库里没有够格的条目（>=14 字、非 self 洞察）' };
  lastChatErr = '';

  const embedReady = llm.embedReady();
  const vs = memdb.vecStats();
  const out = {
    ok: true, total: Array.isArray(all) ? all.length : 0, picked: picked.length,
    embedReady, vecCovered: vs.withVec, vecTotal: vs.total, topK, rows: [],
    kwHits: 0, vecHits: 0, pass: false, reason: '',
  };

  // 1) 每条造一句换说法（串行，量小；失败的那条标 null，不计入命中）
  for (const e of picked) out.rows.push({ id: e.id, text: String(e.text || ''), imp: e.imp || 3, query: null, kwHit: false, kwRank: 0, vecHit: false, vecRank: 0, noVec: false });
  for (const row of out.rows) {
    const target = picked.find((e) => e.id === row.id);
    row.query = await makeParaphrase(target, chatFn);
  }

  // 2) 一次性把所有有效查询打成向量（批量，省网络往返）；失败数组逐条 null
  const valid = out.rows.filter((r) => r.query);
  let vecs = [];
  if (valid.length) {
    try { vecs = (await embedFn(valid.map((r) => r.query))) || []; } catch { vecs = []; }
  }
  const vecByIndex = new Map(valid.map((r, i) => [r.id, Array.isArray(vecs[i]) ? vecs[i] : null]));

  // 3) 每条各查两遍：纯关键词 vs 向量混合，看目标 id 在不在 topK
  for (const row of out.rows) {
    if (!row.query) continue;
    const qv = vecByIndex.get(row.id);
    row.noVec = !qv || !qv.length;
    try {
      const kw = recallFn(row.query, { k: topK, touch: false });
      const rank = kw.findIndex((x) => x.id === row.id) + 1;
      row.kwRank = rank; row.kwHit = rank > 0 && rank <= topK;
    } catch { /* 单条查询失败不算命中，不炸整轮 */ }
    // 没打成向量的行不能算「向量命中」——否则 queryVec=null 走的就是关键词路，
    // 会把关键词的功劳记到向量头上，报告虚高。
    if (!row.noVec) {
      try {
        const hy = recallFn(row.query, { k: topK, touch: false, queryVec: qv });
        const rank = hy.findIndex((x) => x.id === row.id) + 1;
        row.vecRank = rank; row.vecHit = rank > 0 && rank <= topK;
      } catch { /* 同上 */ }
    }
  }

  out.kwHits = out.rows.filter((r) => r.kwHit).length;
  out.vecHits = out.rows.filter((r) => r.vecHit).length;
  const done = out.rows.filter((r) => r.query && !r.noVec).length;
  // 达标线按 70% 比例：10 条抽满就是 ≥7/10；样本少于 10 时按同口径算，但报告会标注「样本偏小仅供参考」。
  // done 必须抽满候选数（有查询没打成功向量的那几条不算数，避免虚高分母）。
  out.pass = done > 0 && done >= Math.min(DEFAULT_COUNT, out.picked) && out.vecHits / done >= PASS_LINE / DEFAULT_COUNT;

  if (!done) out.reason = `主模型没能生成任何换说法——${lastChatErr || '点面板「测试聊天模型」看具体报错'}（这一列全空时向量列必然也是 0，先修主模型再跑本探针）`;
  else if (!embedReady) out.reason = '没配向量模型：这一轮向量列等于关键词列，先去「模型设置 → 向量模型」填一个 embedding 模型 ID';
  else if (out.vecCovered === 0) out.reason = '向量还没回填：去 NAS 跑一次 node panel/backfill-vec.mjs，再重跑本探针';
  else if (out.rows.some((r) => r.noVec)) out.reason = '部分查询没打成向量（接口抖动），结果偏保守，可以重跑一次';
  return out;
}

/** 人类可读报告 */
export function formatReport(r) {
  if (!r.ok) return `🔬 换说法探针：跑不了——${r.reason}`;
  const lines = [];
  lines.push(`🔬 换说法探针：抽 ${r.picked} 条真实记忆，让主模型改写成不含原词的问法，再各召回一次`);
  const need = Math.ceil(r.picked * PASS_LINE / DEFAULT_COUNT);
  lines.push(`   记忆库 ${r.total} 条｜向量模型 ${r.embedReady ? '已配' : '未配'}｜库内已补向量 ${r.vecCovered}/${r.vecTotal}｜判定线 ≥${need}/${r.picked}`);
  lines.push('');
  lines.push('   #  换说法问法                          关键词  向量   原记忆（前 22 字）');
  r.rows.forEach((x, i) => {
    const q = (x.query || '（没生成出来）').padEnd(24, ' ').slice(0, 24);
    const kw = x.query ? (x.kwHit ? `✓top${x.kwRank}` : '✗') : '—';
    const vec = x.noVec ? '无向量' : x.query ? (x.vecHit ? `✓top${x.vecRank}` : '✗') : '—';
    lines.push(`   ${String(i + 1).padStart(2)}  ${q}  ${kw.padEnd(6)}  ${vec.padEnd(6)}  ${x.text.slice(0, 22)}`);
  });
  lines.push('');
  lines.push(`   关键词命中：${r.kwHits}/${r.picked}    向量命中：${r.vecHits}/${r.picked}`);
  if (r.reason) lines.push(`   ⚠️  ${r.reason}`);
  if (r.pass) {
    const small = r.picked < DEFAULT_COUNT ? `（只抽了 ${r.picked} 条，样本偏小，建议跑 \`node panel/probe-semantic.mjs\` 抽满 10 条复核）` : '';
    lines.push(`   ✅ 达标（${r.vecHits}/${r.picked}）——向量粗排留着，阶段四 4A 可以验收${small}`);
  } else if (r.embedReady && r.vecCovered > 0) {
    lines.push('   ⚠️ 未达标。先核对上面「换说法」列是不是真的换了词；');
    lines.push('      如果换说法确实不含原词还翻不到，把 tuning 的 vecW 调高（面板可调），再跑一次。');
  }
  return lines.join('\n');
}

// 手动跑：node panel/probe-semantic.mjs [条数]
if (process.argv[1] && process.argv[1].replace(/\\/g, '/').endsWith('/probe-semantic.mjs')) {
  memdb.init();
  const n = Number(process.argv[2]) || DEFAULT_COUNT;
  const r = await semanticProbe({ count: n });
  console.log(formatReport(r));
  process.exitCode = r.ok && r.pass ? 0 : 1;
}
