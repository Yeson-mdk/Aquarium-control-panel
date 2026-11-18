/**
 * 插嘴闸标注集 + 跑分（架构升级批次 C1）
 *
 * 决策日志本身早就在 actions.jsonl（kind=gate，meta 带 score/status/reasons/text/peer）——
 * 「她为什么没回」从那份账里查。本模块补的是另一半：攒一份「该回/不该回」的人工标注集，
 * 改权重前后各跑一遍，看翻案数，别凭感觉调 topic 那堆数字。
 *
 *   node panel/gate-labels.mjs import           从 actions 的 gate 日志导候选消息（去重）
 *   node panel/gate-labels.mjs label <id> 1|0   标注该回(1)/不该回(0)，0 也可传 '' 清空
 *   node panel/gate-labels.mjs score            用当前 tuning 权重重跑，输出一致率/翻案数
 *   node panel/gate-labels.mjs list             看标注集
 *
 * 数据：data/gate-labels.jsonl（一行一条，人能直接编辑 label 字段）
 */
import { existsSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { DATA, readActions, nowIso } from './store.mjs';
import { topicScoreMessage } from './qq/brain.mjs';

const FILE = join(DATA, 'gate-labels.jsonl');
const norm = (t) => String(t || '').replace(/\s+/g, ' ').trim().slice(0, 120);
const nextId = (rows) => {
  let n = rows.reduce((m, r) => Math.max(m, Number(String(r.id || '').replace(/^L/, '')) || 0), 0);
  return 'L' + String(n + 1).padStart(3, '0');
};

export function readLabels() {
  try {
    return readFileSync(FILE, 'utf-8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  } catch { return []; }
}
function writeLabels(rows) {
  const tmp = FILE + '.tmp';
  writeFileSync(tmp, rows.map((r) => JSON.stringify(r)).join('\n') + (rows.length ? '\n' : ''));
  renameSync(tmp, FILE);
  return rows;
}

/** 从 actions.jsonl 的 gate 裁决日志导候选消息；已标注过的（按 text 去重）不动 */
export function importFromActions({ limit = 200 } = {}) {
  const rows = readLabels();
  const seen = new Set(rows.map((x) => x.text));
  const gates = readActions().filter((a) => a.kind === 'gate' && a.meta?.text);
  const added = [];
  for (const a of gates.reverse()) { // 老的先入，新的排在后面
    const text = norm(a.meta.text);
    if (!text || seen.has(text)) continue;
    seen.add(text);
    added.push({
      id: '', ts: nowIso(), text,
      peer: a.meta.peer || '',
      scoreAt: Number(a.meta.score) || 0,
      statusAt: a.meta.status || '',
      reasonsAt: Array.isArray(a.meta.reasons) ? a.meta.reasons.slice(0, 8) : [],
      label: null, note: '',
    });
    if (added.length >= limit) break;
  }
  for (const r of added) r.id = nextId([...rows, ...added.slice(0, added.indexOf(r))]);
  if (added.length) writeLabels([...rows, ...added]);
  return { added: added.length, total: rows.length + added.length };
}

/** 标一条：label=true 该回 / false 不该回 / null 撤销标注 */
export function setLabel(id, label, note = '') {
  const rows = readLabels();
  const r = rows.find((x) => x.id === id);
  if (!r) return null;
  r.label = label === true || label === 1 || label === '1' ? true
    : label === false || label === 0 || label === '0' ? false : null;
  r.note = String(note || '').slice(0, 200);
  r.labeledAt = nowIso();
  writeLabels(rows);
  return r;
}

export function removeLabel(id) {
  const rows = readLabels();
  const next = rows.filter((x) => x.id !== id);
  if (next.length === rows.length) return false;
  writeLabels(next);
  return true;
}

/** 用当前 tuning 权重重跑每条标注：一致率 + 翻案数（标注 vs 现在判的），改权重前后各跑一次看差值 */
export function score({ onlyLabeled = true } = {}) {
  const all = readLabels();
  const rows = onlyLabeled ? all.filter((x) => typeof x.label === 'boolean') : all;
  const details = rows.map((x) => {
    const d = topicScoreMessage(x.text, x.peer || 'owner', false, [], { replay: true });
    const nowReply = d.status !== 'skip'; // review 也进池，跟闸的口径一致
    const labeledReply = x.label === true;
    return {
      id: x.id, text: x.text.slice(0, 40),
      was: x.statusAt, now: d.status,
      wasScore: x.scoreAt, nowScore: d.score,
      reasons: d.reasons,
      label: x.label, ok: nowReply === labeledReply,
    };
  });
  const flips = details.filter((d) => !d.ok).length;
  return { total: rows.length, agree: details.length - flips, flips, details };
}

const CLI = process.argv[1] && /gate-labels\.mjs$/.test(process.argv[1].replace(/\\/g, '/'));
if (CLI) {
  const [, , cmd, ...args] = process.argv;
  try {
    if (cmd === 'import') {
      const r = importFromActions({ limit: Number(args[0]) || 200 });
      console.log(`导入候选 ${r.added} 条，标注集共 ${r.total} 条`);
    } else if (cmd === 'label') {
      const r = setLabel(args[0], args[1], args.slice(2).join(' '));
      console.log(r ? `已标 ${r.id}: ${r.label === true ? '该回' : r.label === false ? '不该回' : '撤销'}「${r.text}」` : '没找到这条 id');
    } else if (cmd === 'remove') {
      console.log(removeLabel(args[0]) ? '已删' : '没找到这条 id');
    } else if (cmd === 'score') {
      const r = score({ onlyLabeled: args[0] !== 'all' });
      console.log(`标注 ${r.total} 条：一致 ${r.agree}，翻案 ${r.flips}${r.total ? `（一致率 ${(r.agree / r.total * 100).toFixed(0)}%）` : ''}`);
      for (const d of r.details) console.log(`  ${d.ok ? '✓' : '✗'} ${d.id} [${d.label ? '该回' : '不该回'}] 现在判 ${d.now}(${d.nowScore}) ${d.text}`);
    } else if (cmd === 'list') {
      const rows = readLabels();
      console.log(rows.length ? rows.map((r) => `${r.id} ${r.label === true ? '该回' : r.label === false ? '不该回' : '待标'} ${r.text}`).join('\n') : '（标注集还是空的，先 import）');
    } else {
      console.log('用法：import | label <id> 1|0 | remove <id> | score | list');
    }
  } catch (e) { console.error('gate-labels 出错：', e.message); process.exitCode = 1; }
}
