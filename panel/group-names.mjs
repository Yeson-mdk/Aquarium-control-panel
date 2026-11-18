/**
 * 群号↔群名 对照表（跨会话执行用）—— 阶段三.5 三期
 *
 * 号主裁决：群号自动带出（收消息时顺手记），群名由号主在面板里填。初期方案，后期再想更省的。
 * 数据存 data/group-names.json，人能直接读：{ "g:9003": { "name": "测试群", "seenAt": "...", "members": 12 } }
 *
 * 只管群（g:），私聊（p:）不走这张表——私聊目标直接用 QQ 号。
 */
import { readFileSync, writeFileSync, existsSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { DATA, nowIso } from './store.mjs';

const FILE = join(DATA, 'group-names.json');

export function readGroups() {
  try { return JSON.parse(readFileSync(FILE, 'utf-8')); } catch { return {}; }
}

function write(obj) {
  const tmp = FILE + '.tmp';
  writeFileSync(tmp, JSON.stringify(obj, null, 2));
  renameSync(tmp, FILE);
}

/** 收群消息时顺手记下群号；带了群名就补上（不覆盖号主手填的名）。返回是否有变化 */
export function noteGroup(peer, { name = '', memberCount } = {}) {
  if (!/^g:\d+$/.test(String(peer || ''))) return false;
  const all = readGroups();
  const old = all[peer] || {};
  const next = { ...old, seenAt: nowIso() };
  // 群名只在没填过时用事件带来的填（号主手填的优先，不被自动覆盖）
  if (name && !old.name) next.name = String(name).slice(0, 60);
  if (Number.isFinite(memberCount)) next.members = memberCount;
  all[peer] = next;
  write(all);
  return true;
}

/** 面板手填群名：号主写什么就是什么，自动盖掉之前自动带出的名 */
export function setGroupName(peer, name) {
  if (!/^g:\d+$/.test(String(peer || ''))) return false;
  const all = readGroups();
  const old = all[peer] || {};
  if (!name && !old.seenAt) return false; // 没见过这群又不给名，不建空条目
  all[peer] = { ...old, name: String(name || '').slice(0, 60), namedAt: nowIso() };
  write(all);
  return true;
}

/**
 * 按名字找群号：精确 > 包含，唯一命中才返回 peer；多个命中返回歧义列表让模型问一句。
 * @returns { peer } | { ambiguous: ['g:1','g:2'] } | null
 */
export function findGroupByName(query) {
  const q = String(query || '').trim().replace(/^群[:：]?/, '');
  if (!q) return null;
  const all = readGroups();
  const entries = Object.entries(all).filter(([, v]) => v.name);
  const exact = entries.filter(([, v]) => v.name === q);
  if (exact.length === 1) return { peer: exact[0][0] };
  if (exact.length > 1) return { ambiguous: exact.map(([p]) => p) };
  const partial = entries.filter(([, v]) => v.name.includes(q) || q.includes(v.name));
  if (partial.length === 1) return { peer: partial[0][0] };
  if (partial.length > 1) return { ambiguous: partial.map(([p]) => p) };
  return null;
}

/** 列出所有群（面板渲染用），按最近见到排序 */
export function listGroups() {
  const all = readGroups();
  return Object.entries(all)
    .map(([peer, v]) => ({ peer, name: v.name || '', seenAt: v.seenAt || '', members: v.members || 0 }))
    .sort((a, b) => (a.seenAt < b.seenAt ? 1 : -1));
}
