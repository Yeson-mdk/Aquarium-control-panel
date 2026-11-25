/**
 * 鱼味账本：线上观测她回复里的鱼八股特征。
 *
 * 用法：
 *   node ops/fugao-stats.mjs                 # 扫本仓库 data/ 和 panel/data/
 *   node ops/fugao-stats.mjs /path/to/dir    # 扫指定目录（比如从 NAS 拷下来的 data 文件夹）
 *   node ops/fugao-stats.mjs a.jsonl b.jsonl # 也可以直接点文件
 *
 * 统计口径（只看她说出口的，不看模型内部）：
 *   分母 = from=her 且 kind 非 sticker/voice/song/selfie/video 的「发出去的文本消息」
 *   指标 = 鱼八股特征（panel/qq/bagu.mjs 的分类正则，与重roll/历史降权共用一份）——
 *          按类计数看哪类高发；单类命中可能是正常白话，≥2 类才算八股并留样本。
 *
 * 说明：腹稿标记穿帮、文言虚词收尾这两项曾是为「文言两步法」准备的探测项，
 *       该方案未上线，已从账本移除，避免零意义指标和「顺耳/兽耳」这类白话误报。
 *
 * 阈值参考：八股特征 ≥2 类消息占比持续 >5%，说明提示词层压制失效，
 *           考虑收紧角色卡黑名单或开启 frequency_penalty / presence_penalty。
 */
import { readdirSync, statSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { baguHits } from '../panel/qq/bagu.mjs';

const args = process.argv.slice(2);
let paths = args.length ? args.map((p) => resolve(p)) : ['data', 'panel/data'].map((p) => resolve(p));
const files = [];
const walk = (p, depth = 0) => {
  if (depth > 3) return; // 防止误指根目录扫穿整个盘
  let st;
  try { st = statSync(p); } catch { return; }
  if (st.isFile()) { if (/qq-chat.*\.jsonl$/.test(p)) files.push(p); return; }
  if (!st.isDirectory()) return;
  let names = [];
  try { names = readdirSync(p); } catch { return; }
  for (const n of names) walk(join(p, n), depth + 1);
};
paths.forEach(walk);
if (!files.length) { console.log('没找到任何 qq-chat*.jsonl（把 NAS 上 data 目录拷下来后传路径再跑）'); process.exit(0); }

const SKIP_KIND = /^(sticker|voice|song|selfie|video)$/;
let total = 0, badLines = 0, oldest = null, newest = null;
const baguByCat = {}; const baguSamples = [], singleSamples = []; let baguMsgs = 0;
for (const f of files) {
  const lines = readFileSync(f, 'utf-8').split('\n');
  for (const line of lines) {
    if (!line.trim()) continue;
    let e;
    try { e = JSON.parse(line); } catch { badLines++; continue; }
    if (e.from !== 'her' || !e.text || (e.kind && SKIP_KIND.test(e.kind))) continue;
    total++;
    if (!oldest || e.ts < oldest) oldest = e.ts;
    if (!newest || e.ts > newest) newest = e.ts;
    // 鱼八股特征：按类统计（哪类高发一目了然），≥2 类的留样本
    const hits = baguHits(e.text);
    if (hits.length) {
      if (hits.length >= 2) baguMsgs++;
      for (const c of hits) baguByCat[c] = (baguByCat[c] || 0) + 1;
      if (hits.length >= 2 && baguSamples.length < 8) baguSamples.push(`  [${hits.join('+')}] ${JSON.stringify(e.text).slice(0, 110)}`);
      else if (hits.length === 1 && singleSamples.length < 5) singleSamples.push(`  [${hits[0]}] ${JSON.stringify(e.text).slice(0, 110)}`);
    }
  }
}

const pct = (n) => total ? (n * 100 / total).toFixed(2) + '%' : '—';
console.log(`扫描 ${files.length} 个记录文件${badLines ? `（跳过 ${badLines} 行坏数据）` : ''}`);
console.log(`时间范围：${oldest || '—'} ~ ${newest || '—'}`);
console.log(`她发出去的文本消息：${total} 条`);
console.log('');
console.log(`鱼八股特征：命中 ≥2 类的 ${baguMsgs} 条（${pct(baguMsgs)}）  ← 高发类优先回头修角色卡`);
for (const [c, n] of Object.entries(baguByCat).sort((a, b) => b[1] - a[1])) console.log(`  ${c}: ${n} 条`);
baguSamples.forEach((s) => console.log(s));
if (singleSamples.length) {
  console.log('  单类命中样本（按阈值不算八股，仅供复核）：');
  singleSamples.forEach((s) => console.log(s));
}
