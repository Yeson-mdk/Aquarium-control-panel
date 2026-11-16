import './_env.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as memdb from '../memdb.mjs';
import * as memory from '../memory.mjs';

test('档案库：起得来，现有记忆自动全量搬进来', () => {
  assert.equal(memdb.init(), true);
  assert.ok(memdb.stats().ready, 'ready');
  assert.ok(memdb.stats().rows >= memory.memoryView().total, '档案 >= 现存（只多不少）');
});

test('search：三个字走索引、两个字走 LIKE 兜底，中文都命中', () => {
  const e = memory.add({ kind: 'watch', text: '看了《周易入门》的视频，讲得挺有意思', imp: 4, keys: ['up:国学小站'] });
  assert.ok(e, '记进去了');
  assert.ok(memdb.search('周易入门').some((x) => x.id === e.id), '三字命中（FTS）');
  assert.ok(memdb.search('周易').some((x) => x.id === e.id), '两字兜底（LIKE）');
  assert.equal(memdb.search('完全无关的词xyzzy').length, 0, '不相关的查不到');
});

test('面板里删的是真删：档案里也不留（隐私优先）', () => {
  const e = memory.add({ kind: 'session', text: '一条待删除的隐私记忆标记qzx', imp: 2 });
  assert.ok(memdb.search('隐私记忆标记qzx').length >= 1, '先确认在档');
  memory.remove(e.id);
  assert.equal(memdb.search('隐私记忆标记qzx').length, 0, 'remove 连档案一起清');
});

test('遗忘的不丢：json 里没了档案里还在；recall 想不够数能翻出来', () => {
  // 直接往档案塞一条从来没进过 json 的旧事（模拟被 tidy 遗忘/挤掉的原文）
  memdb.syncAll([{ id: 'arch-test-1', ts: '2026-08-01T10:00:00', kind: 'watch', text: '八月份存过的冷门蓝调歌单blueb', imp: 2, keys: [], seen: null, n: 0 }]);
  assert.ok(memdb.search('蓝调歌单blueb').length >= 1, '档案里有');
  const lines = memory.recallText('蓝调歌单blueb', { k: 3 });
  assert.match(lines, /蓝调歌单blueb/, '想的时候翻出来了');
  assert.match(lines, /久远/, '带着「想不太清」的标记');
});

test('syncAll 只增改不删：之后的同步不会把档案条目冲掉', () => {
  assert.ok(memdb.search('蓝调歌单blueb').length >= 1);
  memdb.syncAll([]); // 空 all 也不许删
  assert.ok(memdb.search('蓝调歌单blueb').length >= 1, '档案条目保得住');
  assert.equal(memdb.stats().rows >= 1, true);
});

test('号主 facts 留底：挤掉的进档案，facts:true 才搜得到（她的 recall 不带出）', () => {
  memdb.syncFacts([{ id: 'fact-fd1', kind: '近况', text: '他那天说想吃火锅配麻酱', at: '2026-10-01' }]);
  assert.ok(memdb.search('火锅配麻酱', { facts: true }).some((e) => e.kind === 'fact' && e.text.includes('火锅')));
  assert.equal(memdb.search('火锅配麻酱').length, 0, '默认不搜 facts，她的 recall 不会翻出号主的事');
});

test('2.3 dead：retire 过的档案条目 search 不放出来（retire 不同步到档案的话，兜底会把它翻回来）', () => {
  memdb.syncAll([{ id: 'dead-t1', ts: '2026-09-01T00:00:00', kind: 'self', text: '一条被推翻的旧洞察标记dqzx', imp: 5, keys: [], seen: null, n: 0, dead: true }]);
  assert.equal(memdb.search('旧洞察标记dqzx').length, 0, 'dead 的检索不放行');
  memdb.syncAll([{ id: 'alive-t1', ts: '2026-09-01T00:00:00', kind: 'self', text: '一条还活着的旧洞察标记aqzx', imp: 5, keys: [], seen: null, n: 0 }]);
  assert.ok(memdb.search('旧洞察标记aqzx').length >= 1, '没 dead 的照常');
});

test('2.3 老库迁移：旧 schema（八列没 dead）init 不炸、旧条目照常、dead 能写能滤', async () => {
  const { mkdtempSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { pathToFileURL } = await import('node:url');
  const { execFileSync } = await import('node:child_process');
  const { createRequire } = await import('node:module');
  const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite');
  const dir = mkdtempSync(join(tmpdir(), 'yangyu-mig-'));
  const old = new DatabaseSync(join(dir, 'memory.db')); // 手工造一个 2.3 之前的老库
  old.exec('CREATE TABLE mem (id TEXT PRIMARY KEY, ts TEXT, kind TEXT, imp INTEGER, text TEXT, keys TEXT, seen TEXT, n INTEGER)');
  old.exec("CREATE VIRTUAL TABLE mem_fts USING fts5(text, tokenize='trigram')");
  old.prepare("INSERT INTO mem (id, ts, kind, imp, text, keys, seen, n) VALUES ('old1','2026-08-01T00:00:00','watch',3,'老库里的旧记忆marklv','[]',NULL,0)").run();
  old.close();
  const script = `
    const memdb = await import(process.env.MEMDB_SRC_URL);
    if (!memdb.init()) { console.error('init failed'); process.exit(1); }
    if (!memdb.search('旧记忆marklv').some((e) => e.id === 'old1')) { console.error('old row lost'); process.exit(1); }
    memdb.syncAll([{ id: 'nd1', ts: '2026-09-01T00:00:00', kind: 'self', text: '迁移后写入的新洞察marknw', imp: 5, keys: [], seen: null, n: 0, dead: true }]);
    if (memdb.search('新洞察marknw').length !== 0) { console.error('dead not filtered'); process.exit(1); }
    console.log('MIG-OK');
  `;
  const out = execFileSync(process.execPath, ['--input-type=module', '-e', script], {
    env: { ...process.env, YANGYU_DATA: dir, MEMDB_SRC_URL: pathToFileURL(join(import.meta.dirname, '..', 'memdb.mjs')).href },
  }).toString();
  assert.match(out, /MIG-OK/, '老库 init 不炸、旧行还在、dead 列补上且过滤生效');
});
