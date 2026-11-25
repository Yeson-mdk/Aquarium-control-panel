/**
 * 阶段四 4A 验收：「换说法」探针（一次性脚本，不改任何记忆）
 *
 * 为什么需要：recall-check 用「原文前 10 个字」查自己，必然全绿，证明不了「换个说法想不想得起来」。
 * 这个脚本反过来——从真实记忆里挑 10 条，让主模型把每条改写成一句**不含原词**的随口问法，
 * 再分别用「纯关键词」和「关键词 + 向量」各召回一次，看目标条目在不在 top-3。
 * 向量命中 ≥7/10 = 阶段四值得留；向量和关键词差不多 = 这 10 条换说法不够换，或向量没真启用。
 *
 * 跑法（在 NAS 上）：
 *   node ops/probe-semantic.mjs              # 默认抽 10 条，问法模型默认 deepseek-chat（稳）
 *   node ops/probe-semantic.mjs 20           # 抽 20 条（更慢，更准）
 *   node ops/probe-semantic.mjs 10 --model auto  # 换回面板里日常聊天的主模型生成问法
 *
 * 关于问法模型：默认 deepseek-chat 只影响探针的「换说法」质量，不改面板日常聊天的主模型。
 * 用环境变量 YANGYU_PROBE_MODEL 可永久改默认值。
 *
 * 前提：面板「向量模型」已配 + ModelScope 令牌已填 + 跑过 backfill-vec.mjs。
 * 没配也没关系：脚本会照常跑出关键词基线，并明确告诉你向量这一列为什么没生效。
 *
 * 只读：不写 memories.json / memory.db，不刷新 seen（recall 全程 touch:false）。
 * 注入 chatFn/embedFn/recallFn/loadFn 供测试用假接口，生产一律走真模块。
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DATA, readConfig } from '../panel/store.mjs';
import * as llm from '../panel/llm.mjs';
import * as memory from '../panel/memory.mjs';
import * as memdb from '../panel/memdb.mjs';

const FILE = join(DATA, 'memories.json');
const DEFAULT_COUNT = 10;
const PASS_LINE = 7; // ≥7/10 才算「换说法也想得起来」
// 探针问法模型：默认用非 flash 的稳定档。deepseek-flash 高频调用会返 200 空正文，
// 拿它生成换说法会污染命中率。只影响探针，不改面板日常聊天的主模型。
// 可用 --model 覆盖；--model auto 表示回到面板主模型；环境变量可永久改默认。
const DEFAULT_REWRITE_MODEL = process.env.YANGYU_PROBE_MODEL || 'deepseek-chat';

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

/**
 * 识别「数数型」废话：模型被 prompt 里的字数要求带偏，认真去数「谁1 给2 好3」或复述任务要求。
 * 这种不是换说法查询，混进召回只会拉低命中率、误导判断，直接判无效。
 * 只当作无效信号，不拦真实查询（真实问法不会带 1)2) 序号或「数一下字数」）。
 */
export function isCountingJunk(q) {
  const s = String(q || '');
  if (/数[一一下]|字数|[0-9]+\s*个?字|let'?s count|count\s*:|数：/.test(s)) return true;
  // 「谁1 给2」「那(1)个2」「群1里2是3」：数字夹在词间当序号，出现 2 次以上即判数数
  if ((s.match(/[\u4e00-\u9fa5][（(]?\d+[）)]?/g) || []).length >= 2) return true;
  // 复述任务：「要求不要照抄」「查询应问它」「只输出这」「注意要」
  if (/要求.*(不要|照抄|查询|输出)|查询.*(应|应该|须)|^(注意|要像|提问应该|例子)/.test(s)) return true;
  // 复述 prompt 本身：「用户说不要数数」「不要数几个字」「但可以出现时间」「照着例子」「直接给提问」
  if (/用户说|不要数|数几个字|出现时间|照着例子|直接给提问|改写后的?提问|不要照抄/.test(s)) return true;
  // 抄 few-shot 例子里的具体名词（烧腊饭/机械键盘）——它在复述示范，不是真改写
  if (/烧腊饭|机械键盘|打字用的东西/.test(s)) return true;
  // 元话语起头没剥干净：「可包含…」「可以用…」「换了个说法」「具体都叫」
  if (/^(可包含|可以用|可以出现|可写成|可改为|换了个说法|具体都叫|不要数)/.test(s)) return true;
  // 残句碎渣：开头还挂着引号「” 「」，或以「注意/要/这/那/的/了」起头又太短，都没成问句
  if (/^[”"』」』]/.test(s)) return true;
  if (s.length < 6 && /^(注意|要|这|那|的|了|是|在|有|像)/u.test(s)) return true;
  // 过短不成查询：真·换说法至少 5 字。「那个谁」「不要"数」这类碎渣直接判废
  if (s.length < 5) return true;
  return false;
}

/**
 * 从模型的啰嗦输出里捞出真正的提问。
 * 常见形态（实测）：「要像忘了原话：那个给大肥鱼插件装灵魂的视频」「提问应该像"还记得那个拍银河的片子吗"」
 *策略：先剥引号/元话语前缀 → 取冒号后最后一段 → 再退而取引号里最长的一句。捞不到就返回原样让后续校验判废。
 */
export function extractQuery(text) {
  let s = String(text || '').trim().replace(/\s+/g, ' ');
  if (!s) return '';
  // 1) 剥掉层层元话语前缀：「要像忘了原话：」「提问应该像」「注意"」「例子把"」……循环剥，直到剥不动
  const LEAD = /^(?:可包含|可以用|可以出现|可写成|可改为|用户说不要|用户说|换了个说法|具体都叫|要像|像是|像|好比|例如|比如|提问(?:应该|可能|可以是|是)?|查询(?:应该|应|可以是|是)?|问题(?:是|应该)?|改写(?:后|的)?(?:的)?(?:提问|问题|查询)?|注意|记住|答案|结果|好[的呀]?[，,]?|例子[把是]?|这基本复述|这个(?:是|应该)?)\s*[:：是为，,]?\s*["'「『“”]?\s*/i;
  for (let i = 0; i < 6; i++) {
    const next = s.replace(LEAD, '').trim();
    if (next === s) break;
    s = next;
  }
  // 2) 若还带冒号（元话语没列全），取冒号后最后一段——提问通常在冒号后
  const parts = s.split(/[:：]/).map((x) => x.trim()).filter(Boolean);
  if (parts.length > 1) s = parts[parts.length - 1];
  // 3) 去尾部成对引号和句号；引号里若包着更完整的一句，优先取引号内容
  const quoted = s.match(/["'「『“]([^"'」』”]{4,40})["'」』”]/);
  if (quoted) s = quoted[1];
  s = s.replace(/^["'「『“]+|["'」』”。.！!？?]+$/g, '').trim();
  return s.slice(0, 40);
}

// 默认走 chatRaw：能拿到 finish_reason / reasoning_content，空回话时好判断是限流、截断还是推理模型只吐思考。
// 注入的 chatFn 仍返回字符串，保持测试兼容。
async function defaultParaphraseChat(msgs, opts) {
  const r = await llm.chatRaw(msgs, opts);
  const reasoning = String(r?.raw?.reasoning_content || '');
  const content = String(r?.content || '');
  // 推理模型（R1/Qwen3-thinking 之类）偶尔把答案全塞进 reasoning、content 空——拿思考的末句兜底。
  const text = content || (reasoning ? reasoning.split(/[。！？\n]/).filter(Boolean).slice(-1)[0] || '' : '');
  return { text, finish: String(r?.finish || ''), hadReasoning: !!reasoning };
}

/**
 * 原词泄漏：查询直接抄了原文的词段，就不算「换说法」——关键词也能中，命中不作数。
 * 连续 4 个中文字相同（纳米比亚星空 / 每天最多记八条）、或独立英数 token 相同（a6400）。
 */
export function hasOriginalLeak(query, text) {
  const strip = (s) => String(s || '').replace(/[\s，。、！？：""''《》（）()]/g, '');
  const q = strip(query); const t = strip(text);
  if (!q || !t) return false;
  // 滑动窗口：查询里任意连续 6 个中文字出现在原文 = 照抄（5 字会误伤「圆脸然老师」这类人名）
  for (const seg of q.match(/[\u4e00-\u9fa5]{6,}/g) || []) {
    for (let i = 0; i + 6 <= seg.length; i++) if (t.includes(seg.slice(i, i + 6))) return true;
  }
  // 独立英数 token（a6400）原文也有
  for (const tok of String(query || '').match(/[a-zA-Z][a-zA-Z0-9]{2,}|\d{3,}/g) || []) {
    if (t.toLowerCase().includes(tok.toLowerCase())) return true;
  }
  return false;
}

/** 让主模型把一条记忆改写成「换了个说法」的查询。只输出一句话；失败返回 null。 */
export async function makeParaphrase(mem, chatFn = defaultParaphraseChat, onJunk, model = '') {
  const prompt = `把下面这条记忆，改写成一句「换了个说法」的随口提问——就像你忘了原话、只留个模糊印象，用别的词去问出来。
照着例子做，直接给提问本身，不要解释、不要数数、不要数几个字：
- 记着「中午吃了烧腊饭」→ 她最近吃过什么
- 记着「买了机械键盘轴体」→ 打字用的东西换过没

要改写的记忆：${llm.fence(String(mem.text || ''), 220)}
改写后的提问：`;
  try {
    // maxTokens 提到 200：推理模型要把 token 花在思考上，80 太小容易被截断成空正文。
    const out = await chatFn([{ role: 'user', content: prompt }], { maxTokens: 200, temperature: 0.6, tag: 'test', essential: true, ...(model ? { model } : {}) });
    // 兼容两种返回：注入的假函数给字符串；默认 chatRaw 给 {text,finish,hadReasoning}
    const raw = out && typeof out === 'object' && !Array.isArray(out) ? out : { text: out };
    // 模型爱把元话语/例子/冒号引子一起吐出来，先尽力捞出真正的提问再校验
    let q = extractQuery(raw.text);
    if (q.length < 3) {
      const hint = raw.finish === 'length' ? '被 max_tokens 截断' : raw.hadReasoning ? '推理模型只吐了思考' : '接口限流/降级';
      lastChatErr = `主模型回了空内容（${hint}${raw.finish ? '，finish=' + raw.finish : ''}）；若持续如此，点面板「测试聊天模型」核对 key/模型名`;
      return null;
    }
    if (isCountingJunk(q)) {
      try { onJunk?.(q.slice(0, 20)); } catch { /* 回调只做统计，失败不影响主流程 */ }
      lastChatErr = `主模型在数数/复述任务或吐元话语而不是改写（"${q.slice(0, 16)}…"）——这条判废、不计入命中`;
      return null;
    }
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
  rewriteModel = '', // 生成换说法用的模型：留空 = 主模型；填了只影响探针，不改日常聊天
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
    ok: true, total: Array.isArray(all) ? all.length : 0, picked: picked.length, rewriteModel,
    embedReady, vecCovered: vs.withVec, vecTotal: vs.total, topK, rows: [],
    kwHits: 0, vecHits: 0, pass: false, reason: '',
  };

  // 1) 每条造一句换说法（串行，量小；失败的那条标 null，不计入命中）
  for (const e of picked) out.rows.push({ id: e.id, text: String(e.text || ''), imp: e.imp || 3, query: null, kwHit: false, kwRank: 0, vecHit: false, vecRank: 0, noVec: false });
  const byId = new Map(picked.map((e) => [e.id, e]));
  for (const row of out.rows) row.query = await makeParaphrase(byId.get(row.id), chatFn, (frag) => { row.junk = frag; }, rewriteModel);
  // 补跑：flash 档的 200 空回话是间歇性的，第一轮空的重试一次常能成——不然 10 条空 4 条，
  // 剩下的再准也够不到判定线，白冤枉向量模型。只对 query 为空的条目补，不浪费成功的。
  const missing = out.rows.filter((r) => !r.query);
  if (missing.length) {
    await new Promise((r) => setTimeout(r, 1500));
    for (const row of missing) {
      row.junk = ''; // 补跑前清掉上轮的废话标记——补跑成功就算有效，不算废话
      row.query = await makeParaphrase(byId.get(row.id), chatFn, (frag) => { row.junk = frag; }, rewriteModel);
    }
  }
  // 原词泄漏标记：查询照抄了原文词段（纳米比亚星空/a6400），关键词也能中，不算真·换说法
  for (const row of out.rows) row.leak = row.query ? hasOriginalLeak(row.query, row.text) : false;

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
  // 向量净贡献：干净样本里「关键词没翻到、只有向量翻到」的条数——这才是向量真正多带来的价值。
  out.netGain = out.rows.filter((r) => r.query && !r.noVec && !r.leak && r.vecHit && !r.kwHit).length;
  out.junkDropped = out.rows.filter((r) => !r.query && r.junk).length; // 判为废话的条数（元话语/数数/复述 prompt）
  out.noQuery = out.rows.filter((r) => !r.query && !r.junk).length; // 纯空回话的条数（flash 降级）
  // 分母只算「既生成了问法、又打成了向量」的条目；没生成出来的不算分母，否则 flash 空几条就永远过不了线。
  // 但仍要求最少 3 条有效样本才有统计意义，且达标按 70% 比例——不放水，只是不让空回话冤枉向量。
  const done = out.rows.filter((r) => r.query && !r.noVec).length;
  out.done = done;
  // 照抄原词的条目不算真·换说法：关键词也能中，证明不了向量。判定只用干净样本。
  out.leaked = out.rows.filter((r) => r.query && !r.noVec && r.leak).length;
  const cleanRows = out.rows.filter((r) => r.query && !r.noVec && !r.leak);
  out.clean = cleanRows.length;
  out.cleanVecHits = cleanRows.filter((r) => r.vecHit).length;
  const need = Math.max(1, Math.ceil(Math.min(DEFAULT_COUNT, done) * PASS_LINE / DEFAULT_COUNT));
  out.need = need;
  // 旧判定留着供简单场景；真实判定看干净样本的向量命中
  const legacyPass = done >= Math.min(3, out.picked) && out.vecHits >= need;
  const cleanNeed = Math.max(1, Math.ceil(Math.min(DEFAULT_COUNT, out.clean) * PASS_LINE / DEFAULT_COUNT));
  out.cleanNeed = cleanNeed;
  out.pass = legacyPass && out.clean >= Math.min(3, out.picked) && out.cleanVecHits >= cleanNeed;

  if (!done) out.reason = `主模型没能生成任何有效换说法——${lastChatErr || '点面板「测试聊天模型」看具体报错'}（这一列全空时向量列必然也是 0，先修主模型再跑本探针）`;
  else if (out.noQuery || out.junkDropped) {
    const bits = [];
    if (out.noQuery) bits.push(`${out.noQuery} 条没生成出问法（flash 空回话，已自动补跑一次仍失败）`);
    if (out.junkDropped) bits.push(`${out.junkDropped} 条吐的是元话语/复述废话（已判废剔除）`);
    out.reason = `${bits.join('、')}，按剩余 ${done} 条真实问法判定；这些不计入分母`;
  }
  else if (!embedReady) out.reason = '没配向量模型：这一轮向量列等于关键词列，先去「模型设置 → 向量模型」填一个 embedding 模型 ID';
  else if (out.vecCovered === 0) out.reason = '向量还没回填：去 NAS 跑一次 node ops/backfill-vec.mjs，再重跑本探针';
  else if (out.rows.some((r) => r.noVec)) out.reason = '部分查询没打成向量（接口抖动），结果偏保守，可以重跑一次';
  return out;
}

/** 人类可读报告 */
export function formatReport(r) {
  if (!r.ok) return `🔬 换说法探针：跑不了——${r.reason}`;
  const lines = [];
  lines.push(`🔬 换说法探针：抽 ${r.picked} 条真实记忆，让主模型改写成不含原词的问法，再各召回一次`);
  const eff = r.done ?? r.picked; // 有效样本（生成了问法且打成向量）
  const clean = r.clean ?? eff; // 干净样本（没照抄原词）
  const modelNote = r.rewriteModel ? `｜问法模型 ${r.rewriteModel}` : '';
  lines.push(`   记忆库 ${r.total} 条｜向量模型 ${r.embedReady ? '已配' : '未配'}｜库内已补向量 ${r.vecCovered}/${r.vecTotal}｜有效 ${eff}/${r.picked}｜干净 ${clean}｜判定线 ≥${r.cleanNeed ?? r.need ?? Math.ceil(eff * 7 / 10)}/${clean}${modelNote}`);
  lines.push('');
  lines.push('   #  换说法问法                          关键词  向量   原记忆（前 22 字）');
  r.rows.forEach((x, i) => {
    let label = x.junk ? `（废话）${x.junk}` : x.query || '（没生成出来）';
    if (x.leak && !x.junk) label = `（抄原词）${label}`;
    const q = label.padEnd(24, ' ').slice(0, 24);
    const kw = x.query ? (x.kwHit ? `✓top${x.kwRank}` : '✗') : '—';
    const vec = x.noVec ? '无向量' : x.query ? (x.vecHit ? `✓top${x.vecRank}` : '✗') : '—';
    lines.push(`   ${String(i + 1).padStart(2)}  ${q}  ${kw.padEnd(6)}  ${vec.padEnd(6)}  ${x.text.slice(0, 22)}`);
  });
  lines.push('');
  const dropped = [];
  if (r.noQuery) dropped.push(`${r.noQuery} 条空回话`);
  if (r.junkDropped) dropped.push(`${r.junkDropped} 条元话语废话`);
  if (r.leaked) dropped.push(`${r.leaked} 条照抄原词`);
  lines.push(`   关键词命中：${r.kwHits}/${eff}    向量命中：${r.vecHits}/${eff}    干净样本向量：${r.cleanVecHits ?? r.vecHits}/${clean}    向量净贡献：${r.netGain ?? 0} 条${dropped.length ? `（另有 ${dropped.join('、')}，未计入判定）` : ''}`);
  if (r.reason) lines.push(`   ⚠️  ${r.reason}`);
  if (r.pass) {
    const small = r.picked < DEFAULT_COUNT ? `（只抽了 ${r.picked} 条，样本偏小，建议跑 \`node ops/probe-semantic.mjs\` 抽满 10 条复核）` : '';
    lines.push(`   ✅ 达标（干净样本向量 ${r.cleanVecHits ?? r.vecHits}/${clean}）——向量粗排留着，阶段四 4A 可以验收${small}`);
  } else if (r.embedReady && r.vecCovered > 0) {
    const pinned = r.rewriteModel ? `（本轮问法模型 ${r.rewriteModel}）` : '';
    if (r.noQuery || r.junkDropped) {
      // 还有空回话/废话才提示换模型；已经指定了模型就别再重复这句死循环提示
      if (!r.rewriteModel) {
        lines.push(`   ⚠️ 未达标${pinned}，本轮有空回话/废话拖累问法质量——给探针单独指定稳模型（不碰日常聊天）：`);
        lines.push('        node ops/probe-semantic.mjs 10 --model deepseek-chat');
      } else {
        lines.push(`   ⚠️ 未达标${pinned}，本轮仍有空回话/废话；已是指定模型还这样就重跑一次（接口抖动），调 vecW 救不了问法质量。`);
      }
    } else if (r.leaked) {
      // 问法全生成、只是照抄了原词：换模型没用，是这类「看了《…》」记忆的标题词天然难换
      lines.push(`   ⚠️ 未达标${pinned}，但这 ${r.leaked} 条是照抄原词的问法（不是向量没翻到）——已剔除、不计入判定。`);
      lines.push('      看「干净样本向量」那一项才是真实水平；这几条抄原词换模型也救不了，调 vecW 更没用。');
    } else {
      lines.push(`   ⚠️ 未达标${pinned}，问法干净、向量也没翻到——这时才考虑把 tuning 的 vecW 调高（面板可调），再跑一次。`);
    }
  }
  return lines.join('\n');
}

// 手动跑：node ops/probe-semantic.mjs [条数] [--model 模型名]
//   --model 只换「生成换说法」用的模型，不改面板里日常聊天的主模型。
//   默认 deepseek-chat（稳）；--model auto = 回到面板主模型。
//   例：node ops/probe-semantic.mjs 10 --model deepseek-chat
if (process.argv[1] && process.argv[1].replace(/\\/g, '/').endsWith('/probe-semantic.mjs')) {
  memdb.init();
  const a = process.argv.slice(2);
  const mi = a.indexOf('--model');
  const rawModel = mi >= 0 ? String(a[mi + 1] || '').trim() : DEFAULT_REWRITE_MODEL;
  const rewriteModel = rawModel === 'auto' ? '' : rawModel; // auto = 用面板主模型
  const n = Number(a.find((x) => /^\d+$/.test(x))) || DEFAULT_COUNT;
  const r = await semanticProbe({ count: n, rewriteModel });
  if (r.ok) r.rewriteModel = rewriteModel;
  console.log(formatReport(r));
  process.exitCode = r.ok && r.pass ? 0 : 1;
}
