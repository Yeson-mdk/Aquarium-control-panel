import test from 'node:test';
import assert from 'node:assert/strict';
import './_env.mjs';
import { isThinkingOutLoud, tidyReply } from '../qq/brain.mjs';

test('思考泄漏 1：线上原句——自述+末尾 SKIP（中文句号）该吞', () => {
  const line = '他还在“？”我，我上句接的是存不存图片那事，已经翻篇了。这会儿没什么新的，SKIP。';
  assert.equal(isThinkingOutLoud(line), true);
  assert.equal(tidyReply(line), '', 'tidyReply 统一出路口也要清掉');
});

test('思考泄漏 2：SKIP 各种变体——大小写 / 英文标点 / 引号 / 行首行尾 / 前面带自言自语', () => {
  for (const t of [
    'SKIP',
    'skip',
    'Skip。',
    '那就算了，不说了。 SKIP',
    '这会儿没什么新的…SKIP！',
    '先不搭了（SKIP）',
    '"SKIP"',
    '他还在？我。\nSKIP',
  ]) {
    assert.equal(isThinkingOutLoud(t), true, `该吞：${t}`);
  }
});

test('思考泄漏 3：不误伤——正常聊天里 skip 不是独立决策词时不吞', () => {
  for (const t of [
    '好呀，我马上来',
    '今天 NBA 有个 skip 传球特别帅', // 后面跟了别的字，不是句尾决策词
    'skipping 这个词怎么念',           // 嵌在别的词里
    '他刚才说 skip 的时候在笑',        // 句中提到，后面还有内容
  ]) {
    assert.equal(isThinkingOutLoud(t), false, `不该吞：${t}`);
  }
});

test('思考泄漏 4：tidyReply 对纯思考段落与其他标记的联合处理', () => {
  assert.equal(tidyReply('他还在“？”我，已经翻篇了。这会儿没什么新的，SKIP。'), '');
  assert.equal(tidyReply('好呀[FAV:{"d":1,"why":"开心"}]'), '好呀'); // 正常回复照旧剥 FAV，保留正文
});

test('占位标记复读 1：线上原句——表情包摘要+@占位符，整段清掉', () => {
  assert.equal(tidyReply('[卷心菜] （@了你，什么都没说）'), '', '整行标记+占位符 → 空');
  assert.equal(tidyReply('[表情包卷心菜]'), '', '带前缀的输入标记也清掉');
  assert.equal(tidyReply('（@了你，什么都没说）'), '', '光占位符 → 空');
  assert.equal(tidyReply('（卷心菜拍了拍你）'), '', '拍一拍占位符 → 空');
});

test('占位标记复读 2：不误伤——正常讲话里带括号/方括号', () => {
  assert.equal(tidyReply('你说[笑哭]那个，我笑死了'), '你说[笑哭]那个，我笑死了', '话里带方括号照发');
  assert.equal(tidyReply('他@了你（真的），你去看看'), '他@了你（真的），你去看看', '话里带括号照发');
  assert.equal(tidyReply('来啦 [卷心菜] 哈哈'), '来啦 [卷心菜] 哈哈', '标记不在整行、有真实内容 → 保留');
});
