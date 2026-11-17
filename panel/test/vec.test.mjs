import './_env.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as memdb from '../memdb.mjs';
import * as memory from '../memory.mjs';
import * as llm from '../llm.mjs';

// 阶段四 4A 回归。假向量手写小维度，不联网、不碰真数据。
const V = { 吃: [1, 0, 0], 烧腊饭: [0.95, 0.1, 0], 猫: [0, 1, 0], 狗: [0.1, 0.95, 0] };

test('0. 前置：档案库起得来', () => {
  assert.equal(memdb.init(), true);
});

test('1. setVec / vecOf：写入后 search 带回向量与余弦分', () => {
  const e = memory.add({ kind: 'watch', text: '今晚吃了烧腊饭记得标记vecmeal', imp: 3 });
  assert.ok(e, '记进去了');
  assert.ok(memdb.setVec(e.id, V.烧腊饭), 'setVec 成功');
  const hit = memdb.search('vecmeal').find((x) => x.id === e.id);
  assert.ok(hit?.vec?.length, 'search 带回 vec');
  assert.ok(hit._sem === undefined, '纯关键词检索不带 _sem');
});

test('2. ⚠️ syncAll 全量覆盖不冲掉 vec（写入侧坑的核心回归）', () => {
  const e = memory.add({ kind: 'watch', text: '向量不能被覆盖标记veckeep', imp: 3 });
  memdb.setVec(e.id, V.猫);
  // 模拟任何一条新记忆落库触发的全量 syncAll（memory.add 内部就会调）
  memory.add({ kind: 'watch', text: '另一条新记忆vecother', imp: 2 });
  const hit = memdb.search('veckeep').find((x) => x.id === e.id);
  assert.ok(hit?.vec?.length, '再怎么 syncAll，已补的 vec 必须还在');
  assert.deepEqual(hit.vec, V.猫, 'vec 值没被刷回 null');
});

test('3. recall 不传 queryVec：行为与 4A 之前一致（同步调用方零改动）', () => {
  const e = memory.add({ kind: 'watch', text: '纯关键词召回标记vecplain', imp: 3 });
  const lines = memory.recallText('vecplain', { k: 3 });
  assert.match(lines, /vecplain/, '不传 queryVec 照旧能查到');
  // 不传 queryVec 时，即使某条有向量，也不该冒出 _sem 语义分路径
  assert.ok(!memory.recall('完全不相干的查询词zzz', { k: 3 }).some((x) => x._sem !== undefined), '无 queryVec 时没有 _sem');
  assert.ok(e);
});

test('4. queryVec 语义召回：换说法也能翻到（吃的→烧腊饭）', () => {
  const e = memory.add({ kind: 'watch', text: '今晚吃了烧腊饭，很好吃 semantmeal', imp: 3 });
  memdb.setVec(e.id, V.烧腊饭);
  // 查询文本里根本没有「烧腊饭」三个字，只有向量相似
  const hits = memory.recall('想吃点什么 semantmeal', { k: 5, queryVec: V.吃 });
  assert.ok(hits.some((x) => x.id === e.id), '纯靠余弦把烧腊饭翻出来了');
});

test('5. queryVec 过 scope：语义再像，别的对话/号主的事也不许漏', () => {
  const e = memory.add({ kind: 'chat', text: '群里聊到烧腊饭 scopevec', imp: 3, keys: ['g:111'] });
  memdb.setVec(e.id, V.烧腊饭);
  // 从别的群视角查，scope 不含 g:111 → 即使向量几乎一样也不该返回
  const hits = memory.recall('吃的 scopevec', { k: 5, scope: ['g:222'], queryVec: V.吃 });
  assert.ok(!hits.some((x) => x.id === e.id), '别的群视角翻不到 g:111 的语义候选');
  // 本群视角翻得到
  const own = memory.recall('吃的 scopevec', { k: 5, scope: ['g:111'], queryVec: V.吃 });
  assert.ok(own.some((x) => x.id === e.id), '本群视角翻得到');
});

test('6. missingVecIds：补过的跳过，没补的还在（断点续传）', () => {
  const e = memory.add({ kind: 'watch', text: '断点续传标记vecresume', imp: 2 });
  assert.ok(memdb.missingVecIds('', 500).includes(e.id), '新条目缺向量');
  memdb.setVec(e.id, V.猫);
  assert.ok(!memdb.missingVecIds('', 500).includes(e.id), '补过的不在缺失列表');
  assert.ok(memdb.stats().withVec >= 1, 'stats 带 vec 覆盖数');
});

test('7. backfill 假接口：分批补、跳过已有、接口挂了不炸', async () => {
  const { backfill } = await import('../backfill-vec.mjs');
  const a = memory.add({ kind: 'watch', text: '回填测试A vecbf1', imp: 2 });
  const b = memory.add({ kind: 'watch', text: '回填测试B vecbf2', imp: 2 });
  const calls = [];
  const r = await backfill({ embedFn: async (texts) => { calls.push(texts); return texts.map(() => V.猫); } });
  assert.ok(r.filled >= 2, '至少补了这两条');
  assert.ok(memdb.search('vecbf1').find((x) => x.id === a.id)?.vec?.length, 'A 补上了');
  assert.ok(memdb.search('vecbf2').find((x) => x.id === b.id)?.vec?.length, 'B 补上了');
  // 再跑一遍：已补的跳过，不再调 embed
  const calls2 = [];
  const r2 = await backfill({ embedFn: async (texts) => { calls2.push(texts); return texts.map(() => V.猫); } });
  assert.equal(r2.filled, 0, '第二遍没有新补的');
  // 接口返回 null：先造一条新的缺失记忆，确保 backfill 真的走到 embed 那步
  memory.add({ kind: 'watch', text: '接口挂了测试 vecfail', imp: 2 });
  const r3 = await backfill({ embedFn: async () => null });
  assert.ok(r3.failed >= 1 && r3.reason, '接口挂了给出 reason，不抛异常');
  assert.ok(calls.length >= 1);
});

test('8. embedReady / embed：没配模型时返回 null 不联网', async () => {
  // _env 里没有 key、没有 embeddingModel
  assert.equal(llm.embedReady(), false, '没配 → false');
  assert.equal(await llm.embed(['测试']), null, '没配 → embed 返回 null，不联网');
});

test('9. contextText 预取失败静默退回：不抛、past 走纯关键词', async () => {
  const { contextText } = await import('../qq/brain.mjs');
  const e = memory.add({ kind: 'watch', text: '热路径退回标记ctxvec', imp: 3 });
  // 没配 embedding 模型时 llm.embedReady()=false，contextText 不预取向量，也不该抛
  const ctx = await contextText('ctxvec', '10001', 'owner');
  assert.ok(typeof ctx === 'string', '返回字符串不抛');
  assert.match(ctx, /ctxvec/, '纯关键词召回照旧');
  assert.ok(e);
});
