import './_env.mjs';
import { DATA } from './_env.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

// 这个文件必须在 import memdb 之前把 memories.json 写好——测的就是「进程第一次启动、档案库还是空的时候，
// 已有的 memories.json 会不会被搬进来」。memdb 是进程级单例，所以单开一个测试文件（node --test 每个文件一个进程）。
writeFileSync(join(DATA, 'memories.json'), JSON.stringify([
  { id: 'seed-1', ts: '2026-08-01T10:00:00', kind: 'watch', text: '八月份看过的周易入门，讲得挺有意思', imp: 4, keys: ['up:国学小站'], seen: null, n: 0 },
]));

test('首次启动：已有的 memories.json 自动搬进档案库', async () => {
  const memdb = await import('../memdb.mjs');
  assert.equal(memdb.init(), true, '档案库起得来');
  assert.ok(memdb.stats().rows >= 1, '不是空库');
  assert.ok(memdb.search('周易入门').some((e) => e.id === 'seed-1'), '原来的记忆能搜到');
});
