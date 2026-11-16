/**
 * 梗百科（简化版）：她聊天遇到不懂的梗，先查号主教的小词库（黑话），再上 cnmeme.wiki 在线查，
 * 在线没有（或连不上）就用随仓库带的全量词库快照兜底（memes.db，node:sqlite 只读）。
 *
 * 借鉴 astrbot_plugin_memewiki：词条给模型看时「怎么用」放前面方便接梗，出处只用来理解；
 * 在线查过的详情落盘缓存，没查到的词 10 分钟内不重复联网。
 * 不搬它的：图片卡片渲染、LLM 守门人闸门、网搜兜底——查不查、怎么接，交给模型自己调 search_meme。
 */
import { readFileSync, writeFileSync, renameSync, mkdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { DATA, nowIso } from '../store.mjs';

const API = 'https://cnmeme.wiki/api/v1/public/memes';
const TERMS = join(DATA, 'meme-terms.json'); // 号主教的黑话 { 名称: { meaning, by, at } }
const CACHE_DIR = join(DATA, 'meme-cache');  // 在线词条详情缓存
// 全量快照：数据目录优先（想换新的就往 DATA 放一份），没有就用随仓库带的这份
const DB_CANDIDATES = [join(DATA, 'memes.db'), join(dirname(fileURLToPath(import.meta.url)), 'memes.db')];
const MISS_TTL = 10 * 60_000;
const miss = new Map(); // 查过没有的词 → 过期时间，别反复打接口

const clip = (s, n) => { const t = String(s || '').trim(); return t.length > n ? t.slice(0, n) + '…' : t; };
const readJson = (f, fb) => { try { return JSON.parse(readFileSync(f, 'utf8')); } catch { return fb; } };
const writeJson = (f, o) => { const t = `${f}.tmp`; writeFileSync(t, JSON.stringify(o)); renameSync(t, f); };

// ─── 号主教的黑话 ──────────────────────────────────────────
const readTerms = () => readJson(TERMS, {});

export function addTerm(name, meaning, by = '号主') {
  const n = String(name || '').trim(), m = String(meaning || '').trim();
  if (n.length < 2 || n.length > 16) return { ok: false, msg: '名称要 2-16 个字' };
  if (!m || m.length > 200) return { ok: false, msg: '含义要 1-200 个字' };
  const terms = readTerms();
  const existed = n in terms;
  terms[n] = { meaning: m, by, at: nowIso() };
  writeJson(TERMS, terms);
  miss.delete(n);
  return { ok: true, existed, count: Object.keys(terms).length };
}

export function delTerm(name) {
  const n = String(name || '').trim();
  const terms = readTerms();
  if (!(n in terms)) return false;
  delete terms[n];
  writeJson(TERMS, terms);
  return true;
}

export function listTerms() {
  return Object.entries(readTerms()).map(([n, e]) => `${n}：${e.meaning}（${e.by} 记的）`);
}

/** 黑话只认精确命中，或「完整词出现在句子里」（2 字以上，取最长） */
function findTerm(q) {
  const terms = readTerms();
  if (q in terms) return [q, terms[q]];
  let best = null;
  for (const n of Object.keys(terms)) if (n.length >= 2 && q.includes(n) && (!best || n.length > best.length)) best = n;
  return best ? [best, terms[best]] : null;
}

// ─── 本地全量词库（只读快照）─────────────────────────────────
let db = null;
function localDb() {
  if (db !== null) return db;
  const path = DB_CANDIDATES.find((p) => existsSync(p));
  db = path ? new DatabaseSync(path, { readOnly: true }) : false; // false = 两处都没有快照
  return db;
}

/** 只认完整标题：等于查询，或完整出现在查询里（取最长）。「你是什么」不许命中「你是什么冠军」这种前缀不算 */
function localMatch(q) {
  const d = localDb();
  if (!d) return null;
  let r = d.prepare('SELECT title FROM memes WHERE title = ?').get(q);
  if (r) return r.title;
  r = d.prepare('SELECT title FROM memes WHERE length(title) >= 2 AND instr(?, title) > 0 ORDER BY length(title) DESC LIMIT 1').get(q);
  return r ? r.title : null;
}

// ─── 在线（cnmeme.wiki 公开接口，不用 Key）───────────────────
async function api(url) {
  const res = await fetch(url, { headers: { 'User-Agent': 'yangyu-memewiki/1.0', Accept: 'application/json' }, signal: AbortSignal.timeout(8000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

const detailFile = (slug) => join(CACHE_DIR, `${encodeURIComponent(slug)}.json`);

async function detail(slug) {
  const cached = readJson(detailFile(slug), null);
  if (cached?.item) return cached.item;
  const j = await api(`${API}/${encodeURIComponent(slug)}`).catch(() => null);
  if (!j?.item) return null;
  try { mkdirSync(CACHE_DIR, { recursive: true }); writeJson(detailFile(slug), j); } catch { /* 缓存写不上不影响查询 */ }
  return j.item;
}

/** 词条正文（HTML）转纯文本：小标题转 ## 前缀，方便下面按节拆 */
function htmlText(raw) {
  return String(raw || '')
    .replace(/<h2[^>]*>/gi, '\n## ').replace(/<li[^>]*>/gi, '\n- ')
    .replace(/<\/?p[^>]*>|<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, '') // <p> 开标签也要换行，不然小标题和正文粘一起
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, ' ')
    .replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
}

/** 按小标题把正文拆成「怎么用 / 出处 / 其它」 */
function sections(text) {
  const usage = [], origin = [], other = [];
  for (const part of ('\n' + text).split('\n## ')) {
    const p = part.trim();
    if (!p) continue;
    const i = p.indexOf('\n');
    const head = (i < 0 ? p : p.slice(0, i)).trim();
    const rest = i < 0 ? '' : p.slice(i + 1).trim();
    if (/用法|怎么用|如何用|例句|接梗/.test(head)) usage.push(rest || head);
    else if (/来源|出处|背景|起源|介绍/.test(head)) origin.push(rest || head);
    else other.push(rest ? `${head}\n${rest}` : head);
  }
  return { usage: usage.join('\n').trim(), origin: origin.join('\n').trim(), other: other.join('\n').trim() };
}

/**
 * 拼成给模型看的一段：用法在前（方便接梗），出处在后（只用来理解）。
 * isLocal=true 时 item 是 memes.db 的行（usage/origin/other 都是现成文本）；
 * 否则 item 是在线详情（content_html 要现拆）。
 */
function entryText(item, q, note, isLocal = false) {
  let usage = '', origin = '', other = '';
  if (isLocal) {
    usage = item.usage || ''; origin = item.origin || ''; other = item.other || '';
  } else {
    const body = htmlText(item.content_html) || clip(item.summary || '', 400);
    const s = sections(body);
    usage = s.usage; origin = s.origin;
    other = (!s.usage && !s.origin) ? body : s.other;
  }
  const lines = [`【梗百科】${item.title || q}`];
  if (note) lines.push(note);
  const tags = Array.isArray(item.tags) ? item.tags : String(item.tags || '').split('、').filter(Boolean);
  if (tags.length) lines.push(`标签：${tags.slice(0, 6).join('、')}`);
  if (usage) lines.push(`【怎么用 / 怎么接】\n${clip(usage, 600)}`);
  if (origin) lines.push(`【出处（只用来理解，别照搬）】\n${clip(origin, 450)}`);
  if (other) lines.push(clip(other, 400));
  lines.push(`cnmeme.wiki/词条/${item.slug || ''}${isLocal ? '（本地词库）' : ''}`);
  return lines.join('\n');
}

function localEntry(title, q) {
  const d = localDb();
  if (!d) return null;
  const r = d.prepare('SELECT title, slug, tags, usage, origin, other, summary FROM memes WHERE title = ?').get(title);
  if (!r) return null;
  const row = { ...r, other: (!r.usage && !r.origin) ? (r.other || r.summary || '') : (r.other || '') };
  return entryText(row, q, title === q ? '' : `（没有同名条目，这条标题是「${title}」）`, true);
}

// ─── 对外：查一个词 ────────────────────────────────────────
export async function lookup(query) {
  const q = String(query || '').trim().slice(0, 40);
  if (!q) return '要查的词是空的';
  const hit = findTerm(q);
  if (hit) { const [n, e] = hit; return `【群内黑话】${n}\n${e.meaning}\n（${e.by} 教的）`; }
  if ((miss.get(q) || 0) > Date.now()) return `词库里没有「${q}」（刚查过，没有）`;

  // ① 在线：搜索 + 详情（详情落盘缓存）。只认「标题等于查询」或「完整标题出现在查询里」
  let online = null;
  try {
    const items = (await api(`${API}?q=${encodeURIComponent(q)}&limit=5`)).items || [];
    const exact = items.find((it) => String(it.title || '').trim() === q);
    const picked = exact || items.find((it) => { const t = String(it.title || '').trim(); return t.length >= 2 && q.includes(t); }) || null;
    if (picked) {
      const item = (await detail(picked.slug)) || picked;
      online = entryText(item, q, exact ? '' : `（没有同名条目，这条标题是「${picked.title}」）`);
    }
  } catch { online = null; }
  if (online) return online;

  // ② 在线没有 / 连不上：本地全量词库兜底
  const lt = localMatch(q);
  if (lt) return localEntry(lt, q);

  miss.set(q, Date.now() + MISS_TTL);
  return `词库里没有收录「${q}」。可能是新梗、自造词或拼写不对，不确定就老实说不知道，别编`;
}
