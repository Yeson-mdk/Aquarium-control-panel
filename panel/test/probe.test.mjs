import test from 'node:test';
import assert from 'node:assert/strict';
import { pickCandidates, semanticProbe, formatReport } from '../probe-semantic.mjs';

const MEM = [
  { id: 'a', text: '昨天中午去楼下吃了一份烧腊饭，味道还行', imp: 4, kind: 'watch' },
  { id: 'b', text: '新买的机械键盘轴体是青轴的，敲起来很响', imp: 3, kind: 'watch' },
  { id: 'c', text: '短', imp: 5, kind: 'watch' },
  { id: 'd', text: '这是一条被推翻的旧洞察，不该进候选', imp: 5, kind: 'self' },
];

test('pickCandidates：过滤太短/self/dead，imp 高的在前', () => {
  const got = pickCandidates([...MEM, { id: 'e', text: '这条已经失效了不要选我进来', imp: 5, dead: true }], 10);
  assert.deepEqual(got.map((x) => x.id), ['a', 'b']);
});

test('semanticProbe：读不到库返回 ok:false 不抛', async () => {
  const r = await semanticProbe({ loadFn: () => { throw new Error('no file'); } });
  assert.equal(r.ok, false);
  assert.match(r.reason, /读不到/);
});

test('semanticProbe：向量把换说法翻到、关键词翻不到 → 计入 vecHits 且 pass', async () => {
  const r = await semanticProbe({
    count: 2,
    loadFn: () => MEM.slice(0, 2),
    chatFn: async () => '她之前接触过什么', // 固定换说法，不含原文词
    embedFn: async (qs) => qs.map(() => [1, 0, 0]),
    recallFn: (q, opts) => opts.queryVec ? [{ id: 'a' }, { id: 'b' }] : [], // 关键词翻不到，向量翻得到
  });
  assert.equal(r.ok, true);
  assert.equal(r.kwHits, 0);
  assert.equal(r.vecHits, 2);
  assert.equal(r.pass, true);
  assert.match(formatReport(r), /向量命中：2\/2/);
  assert.match(formatReport(r), /达标/);
});

test('semanticProbe：embed 返回 null 时该条标 noVec，不误判命中，不抛', async () => {
  const r = await semanticProbe({
    count: 2,
    loadFn: () => MEM.slice(0, 2),
    chatFn: async () => '她之前接触过什么',
    embedFn: async () => null,
    recallFn: () => [{ id: 'a' }],
  });
  assert.equal(r.ok, true);
  assert.ok(r.rows.every((x) => x.noVec));
  assert.equal(r.vecHits, 0);
});

test('semanticProbe：chatFn 抛错 → query=null，不炸整轮', async () => {
  const r = await semanticProbe({
    count: 2,
    loadFn: () => MEM.slice(0, 2),
    chatFn: async () => { throw new Error('接口挂了'); },
    embedFn: async (qs) => qs.map(() => [1, 0]),
    recallFn: () => [{ id: 'a' }],
  });
  assert.equal(r.ok, true);
  assert.ok(r.rows.every((x) => x.query === null));
  assert.match(r.reason, /没能生成/);
});
