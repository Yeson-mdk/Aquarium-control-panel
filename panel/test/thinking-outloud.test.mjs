import test from 'node:test';
import assert from 'node:assert/strict';
import './_env.mjs';
import { isThinkingOutLoud, isMetaSelfTalk, tidyReply, punHint, toolDefs } from '../qq/brain.mjs';
import * as prompts from '../qq/prompts.mjs';

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

test('复述抑制 1：带字梗图的生成点提示给正向动作、不教她审视自己的输出', () => {
  const h = punHint('[图片：图上文字：WHALEDeepSeek；蓝发少女身穿印有鲸鱼元素的卫衣，比出爱心手势。]');
  assert.match(h, /别把画面描述原样念一遍/);
  assert.match(h, /看懂了就直接接意思/);
  assert.doesNotMatch(h, /脑子里|别在话里交代/, '元指令会诱发「这回复什么格式」式自我审视');
});

test('复述抑制 2：search_meme 工具说明只给正向动作', () => {
  const t = toolDefs().find((x) => x.function.name === 'search_meme');
  assert.ok(t, '工具单里有 search_meme');
  assert.match(t.function.description, /查不到就按意思直接接住他/);
  assert.doesNotMatch(t.function.description, /说出口|给你自己看的/);
});

test('元自我审视 1：线上原句整段吞掉，不发出去', () => {
  const line = '这回复我发出去时是这个格式吗？不太确定。要不要我换成更自然点的话？';
  assert.equal(isMetaSelfTalk(line), true);
  assert.equal(tidyReply(line), '', 'tidyReply 出路口也要清掉');
});

test('元自我审视 2：同一条回复里先是正文、后是自我审视——只删审视那行，正文照发', () => {
  const out = tidyReply('大清早能听见你这声要早安，我心里还挺乐呵的。\n这回复我发出去时是这个格式吗？不太确定。要不要我换成更自然点的话？');
  assert.equal(out, '大清早能听见你这声要早安，我心里还挺乐呵的。');
});

test('元自我审视 3：变体都认——格式 / 发出去 / 更自然点的话', () => {
  for (const t of [
    '这条回复发出去是什么格式？',
    '我刚说的那句是不是太硬了，要不要换成更自然点的话',
    '我写出去的东西自然吗，不太确定',
  ]) assert.equal(isMetaSelfTalk(t), true, `该吞：${t}`);
});

test('元自我审视 4：不误伤——正常聊天里的「换说法」「合不合适」照发', () => {
  for (const t of [
    '好呀，我换个说法跟你讲',
    '我刚才那句说得不好，重来一遍哈',
    '这样回他合不合适呀',
    '你觉得我这么说行不行',
  ]) assert.equal(isMetaSelfTalk(t), false, `不该吞：${t}`);
});

test('数图片次数：线上原句「这嘴张第二回了」当元信息滤掉，整行不发出去', () => {
  const line = '这嘴张第二回了，等着谁给你塞一口呀';
  assert.equal(isMetaSelfTalk(line), true, '翻聊天记录数出的遍数该吞');
  assert.equal(tidyReply(line), '', 'tidyReply 统一出路口也清掉');
  for (const t of [
    '这张图我看了三回还是觉得好看',
    '你第二次放我鸽子我可记着呢',
    '这个表情包发过两回我都存了', // 虽然带「发过两回」，但少「第N回」+「发/张/出现」紧邻结构，不误伤
  ]) assert.equal(isMetaSelfTalk(t), false, `正常计数不该吞：${t}`);
});

test('提示层：三份 HOW 都明确要求别数图片/表情的重复遍数', () => {
  const { HOW, HOW_PUBLIC, HOW_GROUP } = prompts;
  for (const [name, p] of [['号主私聊', HOW], ['陌生人', HOW_PUBLIC], ['群聊', HOW_GROUP]]) {
    assert.match(p, /别数图片\/表情的次数/, `${name} 提示有「别数次数」小节`);
    assert.match(p, /第几回|发过两次了/, `${name} 提示点名了「第几回」这类话术`);
  }
});
