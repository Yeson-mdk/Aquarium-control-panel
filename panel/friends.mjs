/**
 * 朋友档案（friends）
 *
 * 她有朋友圈：每个跟她聊过的人（好友私聊、群里说话的）一份小档案——这人是谁、叫什么、聊过什么、
 * 有什么要注意的（比如「他要被叫小王」）。跟谁聊就把谁的档案带上，互不串场；
 * 号主的上下文里只带一份名录，她可以自然提起「最近认识了个人」。
 *
 * - touch(qq, name, group)：这人说话了——没有档案就建，有了就刷新名字和最近活跃
 * - addNote(key, text)：往某人档案里记一笔（每晚整理时从聊天里提炼）
 * - notesText(qq)：跟这人私聊时带的档案
 * - rosterText(group)：群聊时带的「这个群里的人你知道的」
 * - friendsText()：号主上下文里的朋友圈名录（带好感 + 最近的朋友圈近况）
 * - digest({since})：每晚对这段窗口里活跃的私聊和群各跑一次小模型，提炼关于人的事实（只进档案）
 * - socialText()：最近的朋友圈近况——从记忆流的群/私聊日结总括（记忆升级阶段一）拼出来，
 *   不再单独小结：老的每日小结只看得到名单和条数、看不到内容，还反刍自己的上一次输出，天天同一句
 *
 * 只在群里见到名字、还没对上 QQ 号的人，先用「n:名字」占位建档；等这人自己跟她搭上话
 * （touch 带上 qq）就把占位档并过去。号主不进朋友圈（他有专门的 owner facts）。
 * 数据：data/friends.json。每人 notes 封顶 30 条，满了挤最旧的。
 */
import { readFileSync, writeFileSync, renameSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import * as llm from './llm.mjs';
import * as fav from './fav.mjs';
import * as memory from './memory.mjs';
import * as owner from './qq/owner.mjs';
import { DATA, localDate, nowIso } from './store.mjs';

const FILE = join(DATA, 'friends.json');
const NOTES_MAX = 30;
const norm = (t) => String(t || '').replace(/\s+/g, ' ').trim().slice(0, 120);

export function readFriends() {
  try { return JSON.parse(readFileSync(FILE, 'utf-8')); } catch { return { friends: {} }; }
}
function writeFriends(d) {
  const tmp = FILE + '.tmp';
  writeFileSync(tmp, JSON.stringify(d, null, 2));
  renameSync(tmp, FILE);
  return d;
}

/** 这人说话了：建档案 / 刷新名字和最近活跃；群号记下来，群名录靠它 */
export function touch(qq, name = '', group = '') {
  const k = String(qq || '');
  if (!k) return '';
  const d = readFriends();
  let f = d.friends[k];
  // 以前只从群聊的只言片语里记过这人（n:名字），现在对上 QQ 号了 → 并档
  if (!f && name && d.friends['n:' + name]) {
    f = d.friends[k] = d.friends['n:' + name];
    delete d.friends['n:' + name];
    f.qq = k;
  }
  if (!f) f = d.friends[k] = { qq: k, name: '', names: [], firstMet: nowIso(), groups: [], notes: [] };
  const n = String(name || '').slice(0, 30);
  if (n && f.name !== n) {
    if (f.name && !f.names.includes(f.name)) f.names = [...f.names, f.name].slice(-4); // 旧名字留着，改群名片也对得上
    f.name = n;
  }
  f.lastSeen = nowIso();
  if (group && !f.groups.includes(group)) f.groups = [...f.groups, group].slice(-4);
  writeFriends(d);
  return k;
}

/** 记一笔关于这人的（key 是 qq 或「n:名字」）。差不多的已经有了就不重复记 */
export function addNote(key, text) {
  const t = norm(text);
  if (t.length < 3 || llm.looksInjected(t)) return null;
  const d = readFriends();
  let f = d.friends[key];
  if (!f && key.startsWith('n:') && norm(key.slice(2))) {
    f = d.friends[key] = { qq: '', name: norm(key.slice(2)), names: [], firstMet: nowIso(), groups: [], notes: [] };
  }
  if (!f) return null;
  if (f.notes.some((x) => x.text.includes(t) || t.includes(x.text))) return { existed: true };
  f.notes = [...f.notes, { at: localDate(), text: t }].slice(-NOTES_MAX);
  f.lastSeen = f.lastSeen || nowIso();
  writeFriends(d);
  return f.notes.at(-1);
}

/** 私聊时带的：这个人你知道的 */
export function notesText(qq) {
  const f = readFriends().friends[String(qq || '')];
  if (!f) return '';
  const lines = f.notes.slice(-6).map((n) => `- ${n.text}`);
  if (f.groups?.length) lines.push(`- 在${f.groups.map((g) => '群 ' + g.slice(2)).join('、')}跟你聊过`);
  if (!lines.length) return '';
  return `## 这个人你知道的（${f.name || '还没记住名字'}）\n${lines.join('\n')}`;
}

/** 群聊时带的：这个群里的人你知道的（最近活跃的几个，一人一行） */
export function rosterText(group, k = 6) {
  const g = String(group || '');
  const list = Object.values(readFriends().friends)
    .filter((f) => f.groups?.includes(g))
    .sort((a, b) => String(b.lastSeen || '').localeCompare(String(a.lastSeen || '')))
    .slice(0, k);
  if (!list.length) return '';
  const lines = list.map((f) => `- ${f.name || '（没记住名字）'}：${f.notes.at(-1)?.text || '聊过，还没记住什么'}`);
  return `## 这个群里的人你知道的（名字后面是他/她的事，接话别张冠李戴）\n${lines.join('\n')}`;
}

/** 号主上下文里的朋友圈名录：她可以自然提起「最近认识了个人」，别念好感数字 */
export function friendsText(k = 8) {
  const favs = fav.readFav().users || {};
  const list = Object.values(readFriends().friends)
    .filter((f) => f.notes.length || favs[f.qq]?.activeDays)
    .sort((a, b) => String(b.lastSeen || '').localeCompare(String(a.lastSeen || '')))
    .slice(0, k);
  if (!list.length) return '';
  const lines = list.map((f) => {
    const u = favs[f.qq];
    return `- ${f.name || f.qq}${u ? `（${u.fav >= 60 ? '处得来' : u.fav >= 45 ? '还行' : '不太对付'}）` : ''}${f.notes.at(-1) ? `：${f.notes.at(-1).text}` : ''}`;
  });
  return `## 你的朋友圈（别人，不是号主）\n${socialText() ? `最近：${socialText()}\n` : ''}${lines.join('\n')}`;
}

/** 给面板「朋友们」页签看：名录（带好感）+ 最近的朋友圈近况 */
export function friendsView() {
  const d = readFriends();
  const favs = fav.readFav().users || {};
  const list = Object.values(d.friends)
    .filter((f) => f.notes.length || favs[f.qq]?.activeDays)
    .sort((a, b) => String(b.lastSeen || '').localeCompare(String(a.lastSeen || '')))
    .map((f) => ({
      qq: f.qq, name: f.name, groups: (f.groups || []).map((g) => String(g).slice(2)),
      firstMet: f.firstMet, lastSeen: f.lastSeen,
      fav: favs[f.qq] ? { fav: favs[f.qq].fav, days: favs[f.qq].activeDays } : null,
      notes: f.notes.slice(-10),
    }));
  return { count: list.length, social: recentSocial() || null, list };
}

// ─── 每晚：从今天的聊天里提炼关于人的事实 ──────────────────────
/** 有聊天记录的对话（qq-chat-p_xxx / qq-chat-g_xxx.jsonl，号主的 qq-chat.jsonl 不算） */
function chatPeers() {
  try {
    return readdirSync(DATA).filter((f) => /^qq-chat-(.+)\.jsonl$/.test(f)).map((f) => f.slice(8, -6).replace('_', ':'));
  } catch { return []; }
}

/** 群里这人叫这名吗（名字或群名片对得上就算） */
function matchMember(group, name) {
  const n = norm(name);
  if (!n) return '';
  const cand = Object.entries(readFriends().friends).filter(([, f]) => f.groups?.includes(group) && f.name);
  const hit = cand.find(([, f]) => f.name === n) || cand.find(([, f]) => f.name.includes(n) || n.includes(f.name));
  return hit ? hit[0] : '';
}

async function ask(user, opts = {}) {
  const out = await llm.chat([
    { role: 'system', content: `${llm.PERSONA}\n整理记录。只输出 JSON。` },
    { role: 'user', content: user },
  ], { tag: 'qq', essential: true, temperature: 0.3, ...opts });
  return llm.looseJson(out);
}

export async function digest({ since, now = Date.now() } = {}) {
  // 窗口按「上次日结的时间戳」切、不按自然日（照 owner.digestGroup 的范式，跨午夜不断档）；
  // 第一次跑从今天零点起，不回溯历史
  const sinceTs = Date.parse(since);
  const start = Number.isFinite(sinceTs) && sinceTs > 0 ? sinceTs : new Date(now).setHours(0, 0, 0, 0);
  const out = { groups: 0, friends: 0, notes: 0 };
  for (const peer of chatPeers()) {
    const lines = owner.readChat(peer).filter((e) => e.kind !== 'reset' && Date.parse(e.ts) > start);
    if (lines.length < 2) continue;
    const chat = lines.slice(-80).map((e) => `${e.name ? `[${e.name}] ` : ''}${e.from === 'her' ? '我' : (e.name || '对方')}：${e.text}`).join('\n').slice(-6000);
    if (peer.startsWith('g:')) {
      // 群：提炼关于具体某个人的事实（外号、身份、喜好），记到那人名下
      const known = Object.values(readFriends().friends).filter((f) => f.groups?.includes(peer) && f.name).map((f) => f.name).join('、') || '（都还没档案）';
      const j = await ask(`下面是一个群里最近这段的聊天（你是群里的「蓝色大肥鱼」）。挑出**关于具体某个人**的、以后还用得上的事实（他要被叫什么外号、他说过他是干什么的、他喜欢什么），别记聊天内容本身，也别记你自己。
群里你认识的人：${known}

${chat}

输出：{"people":[{"name":"那个人的名字或群名片","notes":["一句话，第三人称，比如「他要被叫小王」"]}]}
没对上名字的不硬记；没有值得记的就空数组。`, { maxTokens: 600 });
      for (const p of Array.isArray(j?.people) ? j.people : []) {
        const key = matchMember(peer, p?.name);
        if (!key) continue;
        for (const n of Array.isArray(p.notes) ? p.notes.slice(0, 2) : []) { const r = addNote(key, n); if (r && !r.existed) out.notes++; }
      }
      out.groups++;
    } else {
      // 私聊：这份对话的主人自己（以前聊过但还没建档的，顺手补上）
      const qq = peer.slice(2);
      if (!readFriends().friends[qq]) touch(qq, lines.map((e) => e.name).filter(Boolean).at(-1) || '');
      const f = readFriends().friends[qq];
      const known = f?.notes.slice(-6).map((n) => `- ${n.text}`).join('\n') || '（还不熟）';
      const j = await ask(`整理一下最近这段跟这个人（${f?.name || qq}）私聊聊了什么。只输出 JSON。

已经记着的关于他的：
${known}

这段时间的聊天：
${chat}

输出：{"notes":["关于他的、以后还用得上的事，一句话，第三人称（比如「他喜欢被叫小王」）"]}
只记新的、确实成立的；玩笑闲聊、隐私敏感的不记。没有就空数组。`, { maxTokens: 500 });
      for (const n of Array.isArray(j?.notes) ? j.notes.slice(0, 2) : []) { const r = addNote(qq, n); if (r && !r.existed) out.notes++; }
      out.friends++;
    }
  }
  return out;
}

// ─── 最近的朋友圈近况：从记忆流取（记忆升级阶段一后同源），不再每晚单独小结 ─────────────
/** 一周内群/私聊的近况拼成一句；没有就 null。
 *  认钥匙（g:/p:）不认「聊的主要是」字样：tidy 三天后会把日结总括行合并成 gist（模型概括的印象，
 *  不带那个字样），只认字样的话群一安静近况就断流。带对话钥匙的 gist 也算；明细条（单条概括）不进。 */
function recentSocial(days = 7) {
  const cut = Date.now() - days * 86400_000;
  // memoryView 的 recent 是「新的在前」：先取最近 3 条，再按时间正序拼（原来的 slice(-3) 取到的是最老的 3 条）
  const lines = memory.memoryView(80).recent
    .filter((e) => {
      if (Date.parse(e.ts) <= cut) return false;
      const keyed = (e.keys || []).some((k) => /^[gp]:/.test(k)) || /^「(群|私)·/.test(e.text); // 升级前的老条目没钥匙，按开头认
      return keyed && (e.kind === 'gist' || /聊的主要是/.test(e.text));
    })
    .slice(0, 3)
    .reverse();
  if (!lines.length) return null;
  return { at: lines.at(-1).ts, date: localDate(new Date(lines.at(-1).ts)), text: lines.map((e) => (e.kind === 'chat' ? e.text.replace('」聊的主要是：', '」聊了') : e.text)).join('；').slice(0, 150) };
}

/** 最近的朋友圈近况（一周内的），给号主上下文带一句 */
export function socialText(days = 7) {
  return recentSocial(days)?.text || '';
}
