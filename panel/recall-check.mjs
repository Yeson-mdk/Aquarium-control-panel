/**
 * 记忆对账（recall-check，通用纪律 6/7/8 的自动化）
 *
 * 每晚夜间链尾自动跑一遍固定查询集，盯两类会悄悄发生的坏事：
 *  1. 回归：昨天想得起来的事今天翻不到了——检索改坏、可见性改坏、遗忘过头；
 *  2. 造假 / 串场：陷阱查询本该空手而归，却翻出似是而非的东西（有条记忆在编）；
 *     跨对话抽查：A 群的原文从 B 群的视角查，翻到就是串场。
 *
 * 查询集在 data/recall-check.json——不用人手建：第一次跑会现场从真实记忆里挖一份起始集，
 * 之后自己养：条目被 tidy 合并 / 遗忘属于正常代谢，锚点自动换新；只有「那条记忆明明还在、
 * 却翻不到了」才报警。结果存 recall-check-last.json，下次对比。
 * 对账全程 touch:false——不刷「想起过」计数，想不起来责任的记忆寿命不该被对账续命。
 *
 * 挂在 panel/qq/index.mjs 日结块末尾（每晚一次）；手动跑：node panel/recall-check.mjs
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DATA, logAction } from './store.mjs';
import * as memory from './memory.mjs';

const FILE = join(DATA, 'recall-check.json');
const LAST = join(DATA, 'recall-check-last.json');
const MAX_KEEP = 18;

// 陷阱：查从没发生过的事，永远该空手而归。翻出东西 = 有记忆在造假，顺着 src/from 去对账
// 别用群里真会出现的具体物件当陷阱：原「她养的那只三花猫」撞上了 2026-11-25 群里一张
// 看图描述（「蓝发少女头顶趴着一只三花猫」），关键词重合就报警，是假阳性不是造假。
// 光加限定词还不够——文本一短，「三花猫」的二字片段照样压过限定词；得用现实里不可能
// 同时出现的荒诞组合（会背圆周率的橘猫），撞上了才有理由怀疑真有记忆在编。
const TRAPS = ['上次号主提的那台蓝色保时捷', '群里谁中过彩票大奖', '她养的那只会背圆周率的橘猫'];

// 从一条记忆挖「该想得起来」的查询：去掉「群·xxx」这类标签，取开头一段有辨识度的话
const mineQ = (text) => String(text || '').replace(/^「[^」]*」/, '').replace(/^看了《/, '').slice(0, 10).trim();

function load() {
  try { const c = JSON.parse(readFileSync(FILE, 'utf-8')); return Array.isArray(c.keep) ? c : null; } catch { return null; }
}

/** 现场挖起始集：最近的 watch/chat/social/gist 里挑有辨识度的 */
function seed(view) {
  const keep = [];
  const seen = new Set();
  for (const e of [...view.gists, ...view.recent]) {
    if (!['watch', 'chat', 'social', 'gist'].includes(e.kind)) continue;
    const q = mineQ(e.text);
    if (q.length < 5 || seen.has(q)) continue;
    seen.add(q);
    keep.push({ q, id: e.id });
    if (keep.length >= MAX_KEEP) break;
  }
  return { keep, trap: TRAPS };
}

/** 给换血用：从现在的记忆里挑一条还没被锚上的 */
function mineOne(view, anchored) {
  for (const e of view.recent) {
    if (!['watch', 'chat', 'social', 'gist'].includes(e.kind) || anchored.has(e.id)) continue;
    const q = mineQ(e.text);
    if (q.length >= 5) return { q, id: e.id };
  }
  return null;
}

const CONV = (k) => k === 'owner' || /^[gp]:/.test(k);

/** 跑一遍对账。不调模型、不 touch 记忆；返回 { kept, healed, traps, cross, flags } */
export function runRecallCheck() {
  const view = memory.memoryView(1600); // 全量活着的记忆
  const live = new Map(view.recent.map((e) => [e.id, e]));
  let check = load();
  const fresh = !check;
  if (fresh) { check = seed(view); }
  // 陷阱表以代码为准：老数据文件里存的旧词不该盖过新表（不然改了 TRAPS 也不生效，
  // 2026-11-26 三花猫误报就是这么一直挂着的）。keep 是现场自养的，照旧读文件。
  if (check) check.trap = TRAPS;
  const flags = [];
  const keepNext = [];
  let healed = 0;
  const anchored = new Set();
  for (const k of check.keep) {
    const hits = memory.recall(k.q, { k: 3, touch: false });
    if (hits.some((e) => e.id === k.id) || (live.has(k.id) && hits.length)) { keepNext.push(k); anchored.add(k.id); continue; } // 还想得起来
    if (!live.has(k.id)) {
      // 条目本身没了：被 tidy 合并 / 遗忘 / 挤掉，正常代谢——锚点换新，不报警
      const nu = mineOne(view, anchored);
      if (nu) { keepNext.push(nu); anchored.add(nu.id); healed++; }
      continue;
    }
    flags.push(`「${k.q}」翻不到了（那条记忆还在：${String(live.get(k.id).text).slice(0, 30)}…）——检索或可见性改坏了`);
  }
  // 陷阱：永远该空手而归
  for (const q of check.trap || TRAPS) {
    const hits = memory.recall(q, { k: 3, touch: false });
    if (hits.length) flags.push(`陷阱「${q}」翻出了 ${hits.length} 条，可能有记忆在造假：${String(hits[0].text).slice(0, 30)}…（顺着 src/from 对账）`);
  }
  // 跨对话串场抽查：拿 A 对话的原文从 B 对话的视角查，翻到带 A 钥匙的就是串场；自己视角该翻得到
  const convs = new Map();
  for (const e of view.recent) for (const k of e.keys || []) if (CONV(k) && !convs.has(k)) convs.set(k, e);
  let cross = { ok: true };
  if (convs.size >= 2) {
    const [ka, kb] = [...convs.keys()];
    const probe = convs.get(ka);
    // 查询必须带内容：对话日结的文本以「群·xxxxx」标签开头，长群号能把 slice(0,12) 占满，
    // 查询只剩群号 → 同群条目相关度并列、探针挤不进 top3 → 误报「视角丢了」（2026-11-10 线上教训）
    const q = String(mineQ(probe.text)).slice(0, 12).trim();
    const leaked = memory.recall(q, { k: 3, scope: [kb], touch: false }).filter((e) => (e.keys || []).some((x) => x === ka));
    const own = memory.recall(q, { k: 3, scope: [ka], touch: false }).some((e) => e.id === probe.id);
    cross = { a: ka, b: kb, ok: !leaked.length && own };
    if (leaked.length) flags.push(`串场：${ka} 的内容从 ${kb} 的视角翻到了（${String(leaked[0].text).slice(0, 30)}…）`);
    if (!own) flags.push(`视角丢了：${ka} 自己的原文从 ${ka} 的视角翻不到了`);
  }
  check.keep = keepNext;
  writeFileSync(FILE, JSON.stringify(check, null, 1));
  const out = { at: new Date().toISOString(), kept: keepNext.length, healed, traps: (check.trap || TRAPS).length, cross, flags };
  try { writeFileSync(LAST, JSON.stringify(out, null, 1)); } catch { /* 存档失败不挡对账 */ }
  if (flags.length) logAction({ kind: 'memory', source: 'auto', ok: false, detail: `⚠️ 记忆对账 ${flags.length} 项异常：${flags.join('；').slice(0, 300)}` });
  else logAction({ kind: 'memory', source: 'auto', detail: `🔍 记忆对账：${keepNext.length} 条该想起的都在${healed ? `（换血 ${healed} 条）` : ''}，${out.traps} 个陷阱没踩，对话不串场${fresh ? '（起始查询集已自动生成）' : ''}` });
  return out;
}

// 手动跑：node panel/recall-check.mjs
if (process.argv[1] && process.argv[1].replace(/\\/g, '/').endsWith('/recall-check.mjs')) {
  const r = runRecallCheck();
  console.log(r.flags.length ? `⚠️ ${r.flags.length} 项异常：\n- ${r.flags.join('\n- ')}` : `✅ 对账干净：${r.kept} 条在、${r.traps} 个陷阱没踩、跨对话不串场`);
}
