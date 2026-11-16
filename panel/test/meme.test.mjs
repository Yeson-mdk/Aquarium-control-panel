import './_env.mjs';
import { DATA } from './_env.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';

// 测试自己的迷你词库（数据目录优先于随仓库带的快照，所以真快照不会被碰到）
const tdb = new DatabaseSync(join(DATA, 'memes.db'));
tdb.exec('CREATE TABLE memes (title TEXT PRIMARY KEY, slug TEXT, tags TEXT, usage TEXT, origin TEXT, other TEXT, summary TEXT)');
tdb.prepare('INSERT INTO memes VALUES (?,?,?,?,?,?,?)').run('本地梗', 'ben-di', '测试、本地', '本地梗的用法说明', '本地梗的出处说明', '', '');
tdb.close();

const meme = await import('../qq/meme.mjs');

// 假的 cnmeme.wiki：搜索按词给不同结果，详情给带小标题的 HTML
let calls = 0;
const realFetch = globalThis.fetch;
globalThis.fetch = async (url) => {
  calls++;
  const u = String(url);
  const json = (o) => ({ ok: true, status: 200, json: async () => o });
  if (u.includes('?q=')) return json({ items: decodeURIComponent(u).includes('在线梗') ? [{ title: '在线梗', slug: 'zai-xian' }] : [{ title: '不相干的', slug: 'nope' }] });
  if (u.endsWith('/zai-xian')) return json({ item: { title: '在线梗', slug: 'zai-xian', tags: ['网络'], content_html: '<h2>怎么用</h2><p>用来接话的用法</p><h2>出处</h2><p>某个直播间</p>' } });
  return json({ item: { title: '不相干的', slug: 'nope', content_html: '' } });
};

test('黑话优先：号主教的词直接命中，句子里的完整词也算', async () => {
  const r = meme.addTerm('烧钱', '形容某项爱好花费极高');
  assert.equal(r.ok, true);
  assert.match(await meme.lookup('烧钱'), /【群内黑话】烧钱/);
  assert.match(await meme.lookup('这游戏也太烧钱了吧'), /【群内黑话】烧钱/);
  assert.equal(meme.listTerms().length, 1);
  assert.equal(meme.addTerm('这个标题长得离谱肯定超过十六个字了吧', 'x').ok, false);
  assert.equal(meme.delTerm('没有的词'), false);
});

test('在线命中：按「怎么用/出处」拆节，详情落盘后第二次不再拉详情', async () => {
  const n0 = calls;
  const t = await meme.lookup('在线梗');
  assert.match(t, /【梗百科】在线梗/);
  assert.match(t, /【怎么用 \/ 怎么接】\n用来接话的用法/);
  assert.match(t, /【出处（只用来理解，别照搬）】\n某个直播间/);
  assert.match(t, /cnmeme\.wiki\/词条\/zai-xian$/);
  assert.equal(calls, n0 + 2, '搜索 + 详情各一次');
  const t2 = await meme.lookup('在线梗');
  assert.equal(calls, n0 + 3, '第二次只搜索，详情走本地缓存');
  assert.match(t2, /怎么用/);
});

test('在线没有 → 本地全量词库兜底（完整标题出现在句子里也算）', async () => {
  const t = await meme.lookup('这什么本地梗啊');
  assert.match(t, /【梗百科】本地梗/);
  assert.match(t, /没有同名条目，这条标题是「本地梗」/);
  assert.match(t, /本地梗的用法说明/);
  assert.match(t, /（本地词库）$/);
  const exact = await meme.lookup('本地梗'); // 精确命中就不带「没有同名条目」注
  assert.match(exact, /【梗百科】本地梗/);
  assert.doesNotMatch(exact, /没有同名条目/);
});

test('在线连不上 → 本地兜底；本地也没有 → 未收录 + 10 分钟不重查', async () => {
  globalThis.fetch = async () => { throw new Error('网络炸了'); };
  assert.match(await meme.lookup('说个本地梗'), /【梗百科】本地梗/);
  assert.match(await meme.lookup('查无此词xyz'), /没有收录「查无此词xyz」/);
  let net = 0;
  globalThis.fetch = async () => { net++; throw new Error('网络炸了'); };
  await meme.lookup('查无此词xyz');
  assert.equal(net, 0, '刚查过没有的词不打接口');
  globalThis.fetch = realFetch;
});
