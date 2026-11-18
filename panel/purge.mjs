/**
 * 删掉一个人的全部数据（架构升级批次 C4）
 *
 * 面板「记忆 → 朋友们 → 删掉这个人」用：先 preview 列清单给号主过目，确认后才 purge 实删。
 * 清的是「这个人专属」的四份数据：
 *   1. friends 档案（含 n:名字 占位档、并档后的旧 key）
 *   2. fav 好感记录
 *   3. 记忆条目里 keys 含 p:QQ（跟他的私聊日结/印象）——走 memory.removeByKeys，连 memdb/FTS/向量一起清
 *   4. 私聊聊天原文 qq-chat-p_QQ.jsonl（+滚动摘要+备份）
 *
 * 不动的（故意）：g:群号 的群日结是整群的数据，删一个人不能把别人在群里的记录一起清掉；
 * 号主本人（owner）不许删。群数据整体清理走 purgePeer('g:群号')，不在「朋友们」页暴露。
 */
import * as friends from './friends.mjs';
import * as fav from './fav.mjs';
import * as memory from './memory.mjs';
import * as owner from './qq/owner.mjs';
import { logAction } from './store.mjs';

const isOwnerKey = (qq) => !qq || String(qq) === 'owner';

/** 这个人有哪些数据可删——清单（含每类条数与样例），执行前给号主过目 */
export function previewPerson(qq) {
  const q = String(qq || '');
  if (isOwnerKey(q)) return { qq: q, allowed: false, reason: '号主本人的数据不能删', items: [] };
  const f = friends.readFriends().friends;
  const files = Object.entries(f)
    .filter(([key, x]) => key === q || x.qq === q || (x.name && key === 'n:' + x.name))
    .map(([key, x]) => ({ key, name: x.name || '', notes: (x.notes || []).length }));
  const favRec = fav.readFav().users?.[q] || null;
  const memHits = memory.allEntries().filter((e) => (e.keys || []).includes('p:' + q));
  const chat = owner.readChat('p:' + q);
  const items = [
    { kind: 'friends', label: '朋友档案', count: files.length, detail: files.map((x) => x.name || x.key).slice(0, 3).join('、') },
    { kind: 'fav', label: '好感记录', count: favRec ? 1 : 0, detail: favRec ? `好感 ${favRec.fav}` : '' },
    { kind: 'memory', label: '关于他的记忆', count: memHits.length, detail: memHits.slice(0, 2).map((e) => String(e.text).slice(0, 24)).join(' / ') },
    { kind: 'chat', label: '私聊原文', count: chat.length, detail: chat.length ? `${chat.length} 条消息` : '' },
  ];
  return { qq: q, allowed: true, name: files.find((x) => x.name)?.name || '', items, total: items.reduce((n, x) => n + x.count, 0) };
}

/** 按清单实删（执行前号主已看过 preview）。返回每一类实际删掉的量，便于前端显示「删干净了」。 */
export function purgePerson(qq) {
  const pv = previewPerson(qq);
  if (!pv.allowed) return { ok: false, error: pv.reason };
  const q = pv.qq;
  const removed = {
    friends: friends.deleteFriend(q),
    fav: fav.deleteUser(q) ? 1 : 0,
    memory: memory.removeByKeys(['p:' + q]).length,
    chat: owner.purgeChat('p:' + q).length,
  };
  const after = previewPerson(q);
  const ok = after.total === 0;
  logAction({ kind: 'purge', source: 'panel', ok, detail: `🗑 删掉 ${q}${pv.name ? `（${pv.name}）` : ''} 的全部数据：档案 ${removed.friends.length}、好感 ${removed.fav}、记忆 ${removed.memory}、聊天文件 ${removed.chat}${ok ? '' : '（删完仍有残留，见面板）'}` });
  return { ok, qq: q, removed, after: after.total };
}

/** 按对话整体清（群：g:群号 / 好友：p:QQ），只清记忆+聊天原文，不碰 friends 档案。留作将来群数据清理用。 */
export function purgePeer(peer, { log = true } = {}) {
  const p = String(peer || '');
  if (!/^[pg]:/.test(p)) return { ok: false, error: '只认 p:QQ 或 g:群号' };
  const mem = memory.removeByKeys([p]).length;
  const chat = owner.purgeChat(p).length;
  if (log) logAction({ kind: 'purge', source: 'panel', detail: `🗑 清空对话 ${p}：记忆 ${mem}、聊天文件 ${chat}` });
  return { ok: true, peer: p, removed: { memory: mem, chat } };
}
