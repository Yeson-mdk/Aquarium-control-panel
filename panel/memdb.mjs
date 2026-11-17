/**
 * 记忆档案库（memdb）：memories.json 的「从不遗忘」镜像 + 全文索引
 *
 * memories.json 还是唯一权威（人能直接读、直接改，出了问题删掉 memory.db 就回到从前）。
 * 这里用 Node 自带的 node:sqlite（零 npm 依赖，容器不用装任何东西）存一份全量副本：
 *   - syncAll 只增改不删：tidy 的合并、遗忘、挤掉，都只动 json；被清掉的原文在档案库里永远留着
 *   - purge 才真删：面板里手动删除的记忆连档案一起清掉（隐私优先，删就是删）
 *   - FTS5 trigram 索引 + LIKE 兜底：三个字以上走索引，两个字也能搜到
 *   - recall 想不够数时，memory.mjs 会来这翻「其实经历过、只是淡了」的旧事
 *
 * 任何失败（磁盘满、SQLite 打不开……）都静默降级：ready=false，一切函数变空操作，
 * 聊天和记忆照旧走 JSON，绝不在对话路径上抛错。
 */
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DATA } from './store.mjs';

// node:sqlite 是 Node 24 才稳定的内置模块；旧 Node 直接 import 会在启动时把整个面板带崩。
// 用 createRequire 兜住：没有就降级成空操作，记忆照旧走 JSON（和文件头说的「任何失败都静默降级」一致）。
let DatabaseSync = null;
try { ({ DatabaseSync } = createRequire(import.meta.url)('node:sqlite')); } catch { DatabaseSync = null; }

const FILE = join(DATA, 'memory.db');
const SRC = join(DATA, 'memories.json');

let db = null;
let ready = false;
let lastError = '';

export function init() {
  if (!DatabaseSync) {
    if (!lastError) console.error('[memdb] 当前 Node 没有 node:sqlite（需要 Node 24+），档案库跳过，记忆照旧走 JSON');
    lastError = '当前 Node 没有 node:sqlite（需要 Node 24+）';
    return false;
  }
  if (db) return ready;
  try {
    db = new DatabaseSync(FILE);
    db.exec('PRAGMA journal_mode = WAL;');
    db.exec('CREATE TABLE IF NOT EXISTS mem (id TEXT PRIMARY KEY, ts TEXT, kind TEXT, imp INTEGER, text TEXT, keys TEXT, seen TEXT, n INTEGER, dead INTEGER, vec TEXT)');
    // 2.3 老库迁移：建表语句改了列，IF NOT EXISTS 不会给已有的表补列，得 ALTER（列已存在就跳过）
    try { db.exec('ALTER TABLE mem ADD COLUMN dead INTEGER'); } catch { /* 列已经在了 */ }
    // 4.2 阶段四：向量列（JSON 数组存 TEXT）。老库同样要 ALTER 补列
    try { db.exec('ALTER TABLE mem ADD COLUMN vec TEXT'); } catch { /* 列已经在了 */ }
    db.exec("CREATE VIRTUAL TABLE IF NOT EXISTS mem_fts USING fts5(text, tokenize='trigram')");
    db.exec('CREATE TABLE IF NOT EXISTS fact (id TEXT PRIMARY KEY, kind TEXT, text TEXT, at TEXT)'); // 被自动挤掉的号主 facts 留底
    ready = true; // 先标起来：下面 syncAll(seed) 会回调 init()，ready 还是 false 的话会被自己挡回去、首次搬家搬不进来
    if (((db.prepare('SELECT COUNT(*) AS c FROM mem').get()) || {}).c === 0) {
      // 首次启用：把现有 memories.json 原样搬进来（幂等，之后每次 save 都会增量同步）
      let seed = [];
      try { seed = JSON.parse(readFileSync(SRC, 'utf-8')); } catch { seed = []; }
      if (Array.isArray(seed) && seed.length) syncAll(seed);
    }
  } catch (e) {
    lastError = e.message;
    console.error('[memdb] 没起来，记忆照旧走 JSON：', e.message);
    db = null;
  }
  return ready;
}

// rowOf / ins / entryOf / 建表 四处列数必须一致——加列漏一处就是静默不存（2.3 和 4.2 的同一个坑）
// vec 例外：rowOf 带上它只为 INSERT 新行时落库；DO UPDATE SET 里刻意不放 vec——
// syncAll 是全量覆盖，UPDATE 子句若带 vec 会把已补好的向量全刷回 null（4.2 写入侧坑）
const rowOf = (e) => [String(e.id), String(e.ts || ''), String(e.kind || ''), Number(e.imp) || 3, String(e.text || ''), JSON.stringify(e.keys || []), e.seen || null, Number(e.n) || 0, e.dead ? 1 : 0, e.vec ? JSON.stringify(e.vec) : null];

/** 增量同步（save 的唯一漏斗都走这）：只增改不删，被 json 遗忘/挤掉的条目留档 */
export function syncAll(all) {
  if (!init() || !Array.isArray(all)) return false;
  try {
    db.exec('BEGIN');
    // ⚠️ DO UPDATE SET 里绝不能加 vec = excluded.vec：syncAll 每次全量刷，会把 setVec 补好的向量冲掉
    const ins = db.prepare('INSERT INTO mem (id, ts, kind, imp, text, keys, seen, n, dead, vec) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET ts = excluded.ts, kind = excluded.kind, imp = excluded.imp, text = excluded.text, keys = excluded.keys, seen = excluded.seen, n = excluded.n, dead = excluded.dead');
    const selRid = db.prepare('SELECT rowid AS rid FROM mem WHERE id = ?');
    const delFts = db.prepare('DELETE FROM mem_fts WHERE rowid = ?');
    const insFts = db.prepare('INSERT INTO mem_fts (rowid, text) VALUES (?, ?)');
    for (const e of all) {
      if (!e?.id) continue;
      ins.run(...rowOf(e));
      const r = selRid.get(String(e.id));
      if (r) {
        delFts.run(r.rid);
        if (e.text) insFts.run(r.rid, String(e.text));
      }
    }
    db.exec('COMMIT');
    return true;
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch { /* 连接已经坏了就算了 */ }
    lastError = e.message;
    console.error('[memdb] 同步失败（不影响 JSON）：', e.message);
    return false;
  }
}

/** 被自动挤掉的「关于号主的事」留个底（只增不改不删；面板手动删的不进这张表） */
export function syncFacts(list) {
  if (!init() || !Array.isArray(list)) return false;
  try {
    db.exec('BEGIN');
    const ins = db.prepare('INSERT INTO fact (id, kind, text, at) VALUES (?, ?, ?, ?) ON CONFLICT(id) DO NOTHING');
    for (const f of list) if (f?.id && f?.text) ins.run(String(f.id), String(f.kind || ''), String(f.text), String(f.at || ''));
    db.exec('COMMIT');
    return true;
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch { /* 连接已经坏了就算了 */ }
    lastError = e.message;
    return false;
  }
}

/** 真删：面板里手动删的记忆连档案一起清掉 */
export function purge(id) {
  if (!init() || !id) return false;
  try {
    const r = db.prepare('SELECT rowid AS rid FROM mem WHERE id = ?').get(String(id));
    if (r) db.prepare('DELETE FROM mem_fts WHERE rowid = ?').run(r.rid);
    db.prepare('DELETE FROM mem WHERE id = ?').run(String(id));
    return true;
  } catch (e) {
    lastError = e.message;
    return false;
  }
}

const vecOf = (v) => { try { const a = JSON.parse(v); return Array.isArray(a) && a.length ? a : null; } catch { return null; } };
const entryOf = (r) => ({ id: r.id, ts: r.ts, kind: r.kind, imp: r.imp, text: r.text, keys: JSON.parse(r.keys || '[]'), seen: r.seen || null, n: r.n || 0, dead: !!r.dead, vec: vecOf(r.vec) });

/** 余弦相似度：返回 -1~1，任一向量为空/维度不符返回 0（当不相关，不炸） */
export function cosine(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length || !a.length) return 0;
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    const x = Number(a[i]) || 0, y = Number(b[i]) || 0;
    dot += x * y; na += x * x; nb += y * y;
  }
  return na && nb ? dot / Math.sqrt(na * nb) : 0;
}

/** 4.2 单条补向量：独立写，绝不经过 syncAll（否则被全量覆盖刷掉）。返回是否成功 */
export function setVec(id, vec) {
  if (!init() || !id || !Array.isArray(vec) || !vec.length) return false;
  try {
    db.prepare('UPDATE mem SET vec = ? WHERE id = ?').run(JSON.stringify(vec.map(Number)), String(id));
    return true;
  } catch (e) { lastError = e.message; return false; }
}

/** 回填用：扫出 vec 为空的行 id（分页游标是 id，断点续传靠它） */
export function missingVecIds(afterId = '', limit = 500) {
  if (!init()) return [];
  try {
    return db.prepare('SELECT id FROM mem WHERE vec IS NULL AND id > ? ORDER BY id LIMIT ?').all(String(afterId), Number(limit) || 500).map((r) => r.id);
  } catch (e) { lastError = e.message; return []; }
}

export function vecStats() {
  if (!init()) return { total: 0, withVec: 0 };
  try {
    const r = db.prepare('SELECT COUNT(*) AS total, COUNT(vec) AS withVec FROM mem').get();
    return { total: r?.total || 0, withVec: r?.withVec || 0 };
  } catch { return { total: 0, withVec: 0 }; }
}

// ─── 2.8 对话级可见性：memory.recall 主路和这边的档案兜底共用同一道闸 ──────────
// 她自己的事（watch/social/session）全局可见——谁都能想起她刷过的 B站 生活，不含别人的私聊/群聊；
// 带对话钥匙的条目（每晚的 chat 日结、tidy 合成的 gist 印象）只在钥匙全落在当前对话里才可见：
// owner、别的 g:、别的 p: 一律不返回，宁可少想起来，不能串场。没带对话钥匙、又不是她自己的事的
// （self 洞察这类猜想），非号主看不见。
const CONV_KEY = (k) => k === 'owner' || /^[gp]:/.test(k);
const OWN_LIFE = new Set(['watch', 'social', 'session']);
/** scope 传 Set（当前对话的钥匙），不传/null = 不限（号主、面板、CLI 用） */
export function scopeVisible(e, scope) {
  if (!scope) return true;
  if (OWN_LIFE.has(e.kind)) return true;
  const conv = (e.keys || []).filter(CONV_KEY);
  return conv.length > 0 && conv.every((k) => scope.has(k));
}

/**
 * 按一句话翻档案（含已被 tidy 遗忘/合并的原文）。三个字以上走 FTS 索引，
 * LIKE 兜住两个字的重叠；exclude 传当前还「记得」的 id，翻出来的就不重复。
 * 返回原始条目（形状和 memories.json 里的一样），怎么打分排序由调用方定。
 */
export function search(query, { k = 50, exclude = new Set(), facts = false, kinds, scope, queryVec } = {}) {
  if (!init()) return [];
  const q = String(query || '').trim();
  if (!q && !queryVec) return [];
  const rids = new Set();
  const semByRid = new Map(); // rid → 余弦分，只有向量召回命中的才有；给 recall 混分用
  // 关键词两路：q 为空（纯向量召回）时跳过，别用 LIKE '%%' 把全表都当关键词命中
  if (q) {
    try {
      const hit = db.prepare('SELECT rowid AS rid FROM mem_fts WHERE mem_fts MATCH ? LIMIT 300').all('"' + q.replace(/"/g, '""') + '"');
      for (const r of hit) rids.add(r.rid);
    } catch { /* 查询串不合法就只走 LIKE */ }
    try {
      const like = db.prepare("SELECT rowid AS rid FROM mem WHERE text LIKE ? ESCAPE '\\' LIMIT 300").all('%' + q.replace(/[\\%_]/g, '\\$&') + '%');
      for (const r of like) rids.add(r.rid);
    } catch (e) { lastError = e.message; }
  }
  // 4A 向量召回：扫全表有 vec 的行算余弦（1500 条量级，本地点积很快），够相似的进候选。
  // 这一步是「换说法翻得到」的关键——关键词命中不了「吃的→烧腊饭」，余弦能。
  if (queryVec) {
    try {
      const scored = [];
      for (const r of db.prepare('SELECT rowid AS rid, vec FROM mem WHERE vec IS NOT NULL').all()) {
        const v = vecOf(r.vec);
        if (!v) continue;
        const c = cosine(queryVec, v);
        if (c > 0.2) scored.push([r.rid, c]);
      }
      scored.sort((a, b) => b[1] - a[1]);
      for (const [rid, c] of scored.slice(0, 100)) { rids.add(rid); semByRid.set(rid, c); }
    } catch (e) { lastError = e.message; }
  }
  const byRid = db.prepare('SELECT * FROM mem WHERE rowid = ?');
  const out = [];
  for (const rid of rids) {
    const r = byRid.get(rid);
    // kinds / scope 是防串场的最后一道（recall 翻不够数来这兜底时带着限定）：不传就全放行（面板搜索用默认）
    // ⚠️ 向量召回的候选和关键词候选共用这道闸：语义再像，B 群/号主的事也不许从这个 scope 漏出去
    if (r && !exclude.has(r.id) && r.text && (!kinds || kinds.includes(r.kind))
      && !r.dead // 2.3：被推翻的洞察（retire）不放出来——不同步到这的话，兜底检索会把错洞察翻回来
      && scopeVisible({ kind: r.kind, keys: JSON.parse(r.keys || '[]') }, scope)) {
      const e = entryOf(r);
      const sem = semByRid.get(rid);
      if (sem !== undefined) e._sem = sem; // 挂上余弦分，recall 按 kwW/vecW 混合
      out.push(e);
    }
    if (out.length >= k) break;
  }
  if (facts) {
    // 号主 facts 的留底：面板搜索框才带（她的 recall 走默认，不翻号主的事）
    try {
      const fs = db.prepare("SELECT id, kind, text, at FROM fact WHERE text LIKE ? ESCAPE '\\' LIMIT 20").all('%' + q.replace(/[\\%_]/g, '\\$&') + '%');
      for (const f of fs) if (!exclude.has(f.id)) out.push({ id: f.id, ts: f.at || '', kind: 'fact', imp: 3, text: `关于号主［${f.kind}］${f.text}`, keys: [], seen: null, n: 0 });
    } catch (e) { lastError = e.message; }
  }
  return out;
}

export function stats() {
  const rows = ready && db ? ((db.prepare('SELECT COUNT(*) AS c FROM mem').get()) || {}).c : 0;
  const withVec = ready && db ? ((db.prepare('SELECT COUNT(vec) AS c FROM mem').get()) || {}).c : 0;
  return { ready, rows, withVec, file: FILE, lastError };
}
