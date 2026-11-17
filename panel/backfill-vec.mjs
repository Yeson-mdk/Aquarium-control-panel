/**
 * 阶段四 4A：存量记忆向量回填（一次性 / 可反复跑）
 *
 * 为什么需要：4A 上线时 memories.json 里已有的记忆 vec 都是 null（新记忆走 memory.add 的旁路补），
 * 这些旧条目不补向量就享受不到语义召回。这个脚本把它们的向量补齐。
 *
 * 设计要点（见 记忆升级计划.md 4.2）：
 *  - 权威数据读 memories.json（不依赖 memdb 镜像内容），要补的 id 从 memdb.missingVecIds 拿
 *  - 分批 ≤20：一次 embed 最多 20 条，接口压力大；批间不 sleep（个人项目，跑完就完）
 *  - 断点续传：只补 vec 为空的行；跑一半挂了，重跑接着来，已经补过的自动跳过
 *  - 失败静默：没配向量模型 / 接口挂了 → 说明原因就退出，不炸、不半途留下脏数据
 *  - 单条写走 memdb.setVec，绝不调 syncAll（否则全量覆盖会把补好的刷回 null）
 *
 * 跑法：node panel/backfill-vec.mjs
 * 向量模型名在面板「模型设置 → 向量模型」填（config.llm.embeddingModel），留空=不跑。
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DATA, logAction } from './store.mjs';
import * as llm from './llm.mjs';
import * as memdb from './memdb.mjs';

const BATCH = 20;
const FILE = join(DATA, 'memories.json');

/** 一批一批补。embedFn 可注入（测试用假接口）；返回 { scanned, filled, failed, skipped } */
export async function backfill({ embedFn = (texts) => llm.embed(texts), batch = BATCH, sleepFn = (ms) => new Promise((r) => setTimeout(r, ms)) } = {}) {
  const stats = { scanned: 0, filled: 0, failed: 0, skipped: 0 };
  if (!llm.embedReady() && embedFn === llm.embed) {
    return { ...stats, reason: '没配向量模型（config.llm.embeddingModel 为空）或没填向量接口密钥（面板「向量模型」的密钥，或「QQ 连接」的 ModelScope 令牌）' };
  }
  let all = [];
  try { all = JSON.parse(readFileSync(FILE, 'utf-8')); } catch { return { ...stats, reason: '读不到 memories.json' }; }
  if (!Array.isArray(all)) return { ...stats, reason: 'memories.json 格式不对' };
  const byId = new Map(all.map((e) => [String(e.id), e]));

  // 游标翻页：每批从上一批最后的 id 之后取（id > after）。
  // ⚠️ 别再每轮都从 '' 取：档案库里可能留着「被遗忘/挤掉、没有正文」的旧条目，它们永远补不上 vec，
  //    会一直占着最前面。旧写法 filter 掉它们后要么 todo 空直接 break、要么 ids 空 break，
  //    结果排在它们后面的一大片有正文的记忆全被漏掉（实测 453 条只补 178 条的坑）。
  // 现在无论这批能不能补，游标都越过整批往前走；没正文的跳过、补失败的留下次重跑（仍为 NULL，会被重新扫到）。
  let after = '';
  for (;;) {
    const ids = memdb.missingVecIds(after, batch);
    if (!ids.length) break;
    after = ids[ids.length - 1]; // 先推进游标，越过整批（含没正文/补失败的），保证不会卡在同批空转
    // 只留 json 里还在、且拿得到正文的（档案库留着已被遗忘的旧事，没正文就跳过）
    const todo = [];
    for (const id of ids) {
      const e = byId.get(id);
      if (!e?.text) { stats.skipped++; continue; }
      todo.push({ id, text: e.text });
    }
    if (!todo.length) continue; // 整批都没正文，接着翻下一批，别 break
    stats.scanned += todo.length;
    let vecs = null;
    try { vecs = await embedFn(todo.map((x) => x.text)); } catch { vecs = null; }
    if (!vecs || vecs.length < todo.length) {
      // 限流/抖动很常见：歇一下重试一次，整批全废太可惜。还不行才认失败，并把人话原因带出来。
      const firstErr = llm.embedError();
      await sleepFn(2000);
      let retry = null;
      try { retry = await embedFn(todo.map((x) => x.text)); } catch { retry = null; }
      if (retry && retry.length >= todo.length) vecs = retry;
      else {
        stats.failed += todo.length;
        stats.reason = `向量接口没回完整结果（${llm.embedError() || firstErr || '接口抖动/限流'}）——本批 ${todo.length} 条留着下次重跑；地址 ${llm.embedUrl()}`;
        break;
      }
    }
    let roundFilled = 0;
    todo.forEach((x, i) => {
      if (memdb.setVec(x.id, vecs[i])) { stats.filled++; roundFilled++; }
      else { stats.failed++; } // setVec 失败仍是 NULL，下次重跑自动重试
    });
    if (!roundFilled) break; // 一个都没补上（库出问题了），别转死循环
  }
  return stats;
}

// 手动跑：node panel/backfill-vec.mjs
if (process.argv[1] && process.argv[1].replace(/\\/g, '/').endsWith('/backfill-vec.mjs')) {
  memdb.init();
  const before = memdb.vecStats();
  const r = await backfill();
  const after = memdb.vecStats();
  const line = `🧬 向量回填：补 ${r.filled} 条，跳过 ${r.skipped} 条，失败 ${r.failed} 条（库内 ${before.withVec}→${after.withVec}/${after.total}）${r.reason ? '｜' + r.reason : ''}`;
  console.log(line);
  try { logAction({ kind: 'memory', source: 'panel', detail: line }); } catch { /* 日志不挡回填 */ }
}
