import test from 'node:test';
import assert from 'node:assert/strict';
import { BAGU, baguHits, baguScore, baguRewrite } from '../qq/bagu.mjs';

test('bagu：八类特征各自的样本都能命中', () => {
  const cases = [
    ['签收腔', '这事就这样，这个账我记住了'],
    ['接话腔', '这句接住了，说得挺对'],
    ['比重量', '声音没抖，但比刚才稳。'],
    ['定调收尾', '你自己掂量'],
    ['定调收尾', '行。'],
    ['降维断言', '说白了，这事不归你管'],
    ['降维断言', '不是不想去，而是去不了'],
    ['三连排比', '放下、放下、放下，就过去了'],
    ['标点堆叠', '他说：这事“就这样”——就没了'],
    ['开放式邀请', '如果你愿意，我们可以下次一起玩'],
  ];
  for (const [cat, text] of cases) {
    assert.ok(baguHits(text).includes(cat), `${cat} 应命中：${text}`);
  }
});

test('bagu：正常聊天不误报', () => {
  const ok = [
    '行吧，那就这样，我去吃饭啦',
    '不是我不理你，是今天太累啦',
    '今天比昨天还热，真的假的',
    '好的呢，等我五分钟',
    '一起去吃火锅呀',
    '如果你有空帮我看看这个？',
    '好的好的好的，知道啦',
    '嗯嗯，在呢，怎么了',
  ];
  for (const t of ok) assert.equal(baguScore(t), 0, `不该命中任何类：${t} → ${baguHits(t).join('+')}`);
});

test('bagu：≥2 类才算八股，单类不触发（阈值口径）', () => {
  assert.equal(baguScore('说白了，这个账我记住了'), 2, '降维断言 + 签收腔');
  assert.equal(baguScore('这话我记下了'), 1, '单类签收腔不算八股');
  assert.equal(baguScore('不是我不帮你，而是帮不了，这个账我记住了'), 2, '公式断言 + 签收腔');
});

test('bagu：baguRewrite 降权成大意，长文截断', () => {
  const short = baguRewrite('说白了，这个账我记住了');
  assert.match(short, /^（有一次说得比较僵，大意是：说白了，这个账我记住了）$/);
  const long = baguRewrite('啊'.repeat(80));
  assert.ok(long.endsWith('…）'), '超 50 字截断带省略号');
  assert.ok(long.length < 70, '降权后足够短，当不成逐字范文');
});

test('bagu：特征表本身没写坏（每类都带 cat 和正则）', () => {
  for (const p of BAGU) {
    assert.ok(p.cat, '每条有类别名');
    assert.ok(p.re instanceof RegExp, '每条是正则');
    assert.doesNotThrow(() => '测试串'.replace(p.re, ''), '正则可安全执行');
  }
});
