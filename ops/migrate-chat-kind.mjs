/**
 * 一次性迁移：把改造前写成 chat 的群聊逐句原文 / 大事件，归位到 background / big_event。
 *
 * 背景（2026-11-25）：
 *   序9/序10 之后，新的感知写法是
 *     perceiveGroup → kind:'background'（群背景逐句原文，imp 1/2）
 *     perceiveBig   → kind:'big_event'（大事件，imp 4）
 *   改造前写的老条目仍是 kind:'chat'，于是被面板「印象·日结」的 gistsAll 全量拉出来，
 *   塞满"对话日结"分区——看着像一堆逐句原文，真日结（聊的主要是…）反而被淹了。
 *
 * 本脚本只改 kind 字段，text / ts / imp / id / keys / seen / n / src 一律不动。
 *
 * 用法（在面板进程所在机器、同一个数据目录）：
 *   node ops/migrate-chat-kind.mjs            # 预演：只报告，不写
 *   node ops/migrate-chat-kind.mjs --apply    # 实际写入（自动备份、抢锁、同步档案库）
 *   YANGYU_DATA=/path/to/data node ops/migrate-chat-kind.mjs --apply
 */
import { readFileSync, writeFileSync, renameSync, copyFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { DATA } from '../panel/store.mjs';
import { withLock } from '../panel/memlock.mjs';
import * as memdb from '../panel/memdb.mjs';

const FILE = join(DATA, 'memories.json');
const APPLY = process.argv.includes('--apply');

/**
 * 判定一条 chat 该归到哪类。返回：
 *   { kind:'background'|'big_event', why }  → 可迁移
 *   { skip:true, why }                     → 看着像但证据不足，不碰
 *   null                                   → 不是老感知条目
 *
 * 证据来自当前代码的两种写入格式：
 *   perceiveBig:   「群·gid」某人说的大事：xxx / 号主说的大事：xxx
 *   perceiveGroup: 「群·gid」某人：逐句原文
 * 真日结（owner.digestGroup）是「群·gid」聊的主要是：xxx 或第三人称概括 + src 原话锚点，
 * 这些必须留在 chat，不能误迁。
 */
export function classify(e) {
  if (!e || e.kind !== 'chat') return null;
  const t = String(e.text || '');

  // 大事件：锁定"整条前缀是某人说的大事"，避免误伤概括正文里恰好出现这四个字的日结
  if (/^(?:号主说的大事|「群·[^」]+」[^：:]{1,24}说的大事)[：:]/u.test(t)) {
    return { kind: 'big_event', why: '大事前缀' };
  }

  // 群背景：「群·gid」某人：原话
  const m = t.match(/^「群·[^」]+」([^：:]{1,24})[：:]/u);
  if (!m) return null;
  if (m[1] === '聊的主要是') return null; // 真正的群日结摘要，留着
  // 真日结要点带 src 原话锚点（prompt 强制要求），老逐句原文没有
  if (Array.isArray(e.src) && e.src.length) return { skip: true, why: '带原话锚点，疑似真日结要点' };
  if (Number(e.imp) > 3) return { skip: true, why: `重要度 ${e.imp} 偏高，疑似真日结要点` };
  return { kind: 'background', why: '逐句原文' };
}

function main() {
  if (!existsSync(FILE)) {
    console.error(`没找到记忆文件：${FILE}`);
    process.exitCode = 1;
    return;
  }
  let all;
  try { all = JSON.parse(readFileSync(FILE, 'utf-8')); }
  catch (err) { console.error(`记忆文件读不出来（可能已损坏，别硬改）：${err.message}`); process.exitCode = 1; return; }
  if (!Array.isArray(all)) { console.error('记忆文件不是数组，拒绝处理'); process.exitCode = 1; return; }

  const moves = [];
  const skips = [];
  const kept = []; // 分类为 null 的 chat：apply 后会留在「对话日结」里的真日结
  const counts = { chat: 0, background: 0, big_event: 0 };
  for (const e of all) {
    if (counts[e.kind] !== undefined) counts[e.kind]++;
    const r = classify(e);
    if (!r) { if (e.kind === 'chat') kept.push(e); continue; }
    if (r.skip) skips.push({ e, why: r.why });
    else moves.push({ e, kind: r.kind, why: r.why });
  }
  const byKind = moves.reduce((o, m) => (o[m.kind] = (o[m.kind] || 0) + 1, o), {});

  console.log(`数据文件：${FILE}`);
  console.log(`当前：chat ${counts.chat} 条 / background ${counts.background} 条 / big_event ${counts.big_event} 条`);
  console.log(`判定可迁移：background ${byKind.background || 0} 条、big_event ${byKind.big_event || 0} 条`);
  console.log(`低置信度跳过：${skips.length} 条${skips.length ? '（保留 chat，不碰）' : ''}`);
  if (moves.length) {
    console.log('\n迁移样例（最多 8 条）：');
    for (const m of moves.slice(0, 8)) console.log(`  → ${m.kind}（${m.why}）${String(m.e.text).slice(0, 70)}`);
  }
  if (skips.length) {
    console.log('\n跳过样例（最多 5 条）：');
    for (const s of skips.slice(0, 5)) console.log(`  ! ${s.why}：${String(s.e.text).slice(0, 70)}`);
  }
  console.log(`\n保留为 chat（apply 后仍在「对话日结」）：${kept.length} 条`);
  if (kept.length) {
    for (const e of kept.slice(0, 8)) console.log(`  · ${String(e.text).slice(0, 70)}`);
    if (kept.length > 8) console.log(`  … 其余 ${kept.length - 8} 条未列出`);
  }

  if (!APPLY) {
    console.log('\n这是预演，文件没动。确认上面判定无误后加 --apply 实际写入。');
    return;
  }
  if (!moves.length) { console.log('\n没有要迁移的条目，文件没动。'); return; }

  const bak = `${FILE}.bak-${new Date().toISOString().replace(/[:.]/g, '-')}`;
  withLock(() => {
    copyFileSync(FILE, bak); // 先备份，写入失败也能整文件捞回
    const fresh = JSON.parse(readFileSync(FILE, 'utf-8'));
    const byId = new Map(moves.map((m) => [m.e.id, m.kind]));
    let done = 0;
    for (const e of fresh) {
      const k = byId.get(e.id);
      if (k) { e.kind = k; done++; }
    }
    const tmp = FILE + '.tmp';
    writeFileSync(tmp, JSON.stringify(fresh, null, 1));
    renameSync(tmp, FILE);
    // 档案库也存了 kind，同步过去（syncAll 只增改不删，vec 列不会被冲掉）
    try {
      memdb.syncAll(fresh);
      console.log('档案库 kind 已同步');
    } catch (err) {
      console.warn(`档案库同步失败（json 已改，档案库 kind 可能仍是旧值）：${err.message}`);
    }
    console.log(`\n已迁移 ${done} 条，备份在 ${bak}`);
    console.log('面板前端 Ctrl+F5 后可见；无需重启（memoryView 每次从文件读）。');
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
