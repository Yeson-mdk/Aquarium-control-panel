import test from 'node:test';
import assert from 'node:assert/strict';
import { pickCandidates, semanticProbe, formatReport, extractQuery, isCountingJunk, hasOriginalLeak } from '../../ops/probe-semantic.mjs';

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

// 回归：deepseek-flash 爱吐「可包含…」「换了个说法」「用户说不要数数」这类元话语，
// 曾被当成有效查询计入分母，把命中率从 4/4 拉成 5/10 冤枉向量模型。
test('元话语废话判废、被埋的真提问能捞回，真查询不误伤', () => {
  const junk = [
    '可包含"那个谁""', '换了个说法', '用户说不要数数、不要数几个字，但可以出现时间"一',
    '不要"数', '可包含"', '具体都叫',
  ];
  const good = [
    '群里是不是有人周末去杭州说要捎龙井，谁家', '哎，那个说在非洲看银河',
    '那个白切鸡/广州店/限量/店员凶/华侨回国/半夜',
  ];
  for (const s of junk) assert.equal(isCountingJunk(extractQuery(s)), true, `应判废：${s}`);
  for (const s of good) assert.equal(isCountingJunk(extractQuery(s)), false, `不应误伤：${s}`);
  assert.equal(extractQuery('可以用"半画幅多叠好多张是不是能压过全画'), '半画幅多叠好多张是不是能压过全画');
});

test('hasOriginalLeak：照抄原文长词段/英数 token 判泄漏，保留人名不算', () => {
  assert.equal(hasOriginalLeak('那个纳米比亚星空的片子，一分半左右刚出星星那段', '看了《纳米比亚星空》（阿五在路上）：91秒刚出星星'), true);
  assert.equal(hasOriginalLeak('记忆含每天最多记八条', '看了《六个插件》：每天最多记八条'), true);
  assert.equal(hasOriginalLeak('a6400', '看了《堆栈：后期方法 | a6400》'), true);
  // 只保留 UP 主人名、换了核心词——算干净换说法
  assert.equal(hasOriginalLeak('那个圆脸然老师拍荒野星空的视频，是不是开头追落日', '看了《纳米比亚异原荒野，银河铺满》（圆脸然老师）：追落日'), false);
  assert.equal(hasOriginalLeak('群里有谁要去杭州带点茶叶回来', '群里萌胶带周五去杭州还说要带龙井回来'), false);
});

test('semanticProbe：rewriteModel 透传给生成模型、只影响问法不改主配置', async () => {
  let seenModel = null;
  const r = await semanticProbe({
    count: 2, rewriteModel: 'deepseek-chat',
    loadFn: () => MEM.slice(0, 2),
    chatFn: async (_msgs, opts) => { seenModel = opts.model; return '她之前接触过什么'; },
    embedFn: async (qs) => qs.map(() => [1, 0]),
    recallFn: () => [{ id: 'a' }],
  });
  assert.equal(seenModel, 'deepseek-chat'); // 模型名确实传到了 chat
  assert.equal(r.rewriteModel, 'deepseek-chat'); // 报告能看到用的哪个模型
});

test('formatReport：已指定问法模型时不重复提示换模型（死循环提示回归）', async () => {
  const arr = Array.from({ length: 6 }, (_, i) => ({
    id: 'm' + i, text: `看了《测试视频${i}》这是一条足够长的记忆内容用来做换说法检索`, kind: 'watch', imp: 3,
  }));
  // 问答全成功、但 3 条照抄原词（后面带「测试视频」原文片段）——已指定 deepseek-chat
  const says = [
    '那个讲一条足够长的记忆内容的片子', '那条足够长的记忆内容是什么', '一条足够长的记忆内容讲的啥',
    '她最近接触过什么新鲜事', '她之前了解过别的什么', '有没有类似的事发生',
  ];
  let i = 0;
  const r = await semanticProbe({
    count: 6, rewriteModel: 'deepseek-chat', loadFn: () => arr,
    chatFn: async () => says[i++],
    embedFn: async (qs) => qs.map(() => [1, 0]),
    recallFn: () => [{ id: 'm0' }],
  });
  const rep = formatReport(r);
  assert.match(rep, /问法模型 deepseek-chat/);
  assert.ok(r.leaked >= 3, `应识别出照抄原词的条目，实得 ${r.leaked}`);
  // 关键：已经是指定模型了，报告不该再让用户「换 deepseek-chat / 单独指定稳模型」
  assert.doesNotMatch(rep, /单独指定稳模型|换它跑一次/);
  assert.match(rep, /照抄原词/);
});

test('semanticProbe：netGain 只数干净样本里「关键词翻不到、向量翻到」的条数', async () => {
  const r = await semanticProbe({
    count: 2,
    loadFn: () => MEM.slice(0, 2),
    chatFn: async () => '她之前接触过什么', // 不含原文词，干净
    embedFn: async (qs) => qs.map(() => [1, 0, 0]),
    recallFn: (q, opts) => opts.queryVec ? [{ id: 'a' }, { id: 'b' }] : [], // 只有向量翻到
  });
  assert.equal(r.netGain, 2);
  assert.match(formatReport(r), /向量净贡献：2 条/);
});

test('semanticProbe：废话条目判废剔除、不进分母，报告区分废话与空回话', async () => {
  const arr = Array.from({ length: 6 }, (_, i) => ({
    id: 'm' + i, text: `废话组记忆编号${i}这是一条足够长的测试记忆内容用来做换说法检索`, kind: 'watch', imp: 3,
  }));
  const r = await semanticProbe({
    count: 6,
    loadFn: () => arr,
    chatFn: async () => '可包含"那个谁"', // 每条都吐元话语
    embedFn: async (qs) => qs.map(() => [1, 0]),
    recallFn: () => [{ id: 'm0' }],
  });
  assert.equal(r.ok, true);
  assert.equal(r.junkDropped, 6);
  assert.equal(r.noQuery, 0); // 废话不算空回话
  assert.equal(r.done, 0);
  assert.equal(r.pass, false);
  assert.match(r.reason, /元话语/);
  assert.match(formatReport(r), /（废话）/);
});
