import './_env.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DATA } from './_env.mjs';
const botscore = await import('../botscore.mjs');
const { writeConfig, readConfig } = await import('../store.mjs');

// ─── 造一份 25 天的群记录：一个像脚本的号 vs 一个正常人 ─────────
const DAY = 86400_000;
const now = Date.now();
const at = (d, h, m, s) => { const x = new Date(now - d * DAY); x.setHours(h, m, s, 0); return x.getTime(); };
const line = (name, text, ts) => JSON.stringify({ ts: new Date(ts).toISOString(), from: 'owner', text, name });

const rows = [];
// 阿白：全天每个钟头都在、短间隔稳定、两句话轮着说（同文）、长度整齐、零语音 → 各项全中
for (let d = 1; d <= 25; d++) for (let h = 0; h < 24; h++) {
  rows.push(line('阿白', '好的呢这个话题很有意思呀', at(d, h, 10, 0)));
  rows.push(line('阿白', '确实是的我也这么觉得呢', at(d, h, 10, 5)));
}
// 小张：只在晚上 8-11 点冒泡、间隔忽长忽短、句句不一样、发过语音 → 各项都不中，还有人类痕迹
for (let i = 0; i < 40; i++) {
  const d = 1 + (i % 24);
  const text = i === 5 ? '[语音]' : `今天${'挺'.repeat(1 + (i % 9))}累的，随便说说${i}号的事`;
  rows.push(line('小张', text, at(d, 20 + (i % 4), 5, i % 2 ? 0 : 1).valueOf() + (i % 2 ? 0 : 2000)));
}
// 她自己的话、系统事件、重置标记：都不该进榜单
rows.push(JSON.stringify({ ts: new Date(now - DAY).toISOString(), from: 'her', text: '我在呢', name: '肥鱼' }));
rows.push(JSON.stringify({ ts: new Date(now - DAY).toISOString(), from: 'owner', text: '（拍了拍你）', name: '小张' }));
rows.push(JSON.stringify({ ts: new Date(now - DAY).toISOString(), from: 'owner', kind: 'reset', text: '', name: '' }));
writeFileSync(join(DATA, 'qq-chat-g_9002.jsonl'), rows.join('\n') + '\n');
// 朋友圈档案里有阿白的 QQ，反查要能对上
writeFileSync(join(DATA, 'friends.json'), JSON.stringify({ friends: { 12345: { qq: 12345, name: '阿白', names: [], firstMet: '', groups: ['g:9002'], notes: [] } } }));

test('listGroups：扫得出有记录的群', () => {
  const g = botscore.listGroups();
  assert.equal(g[0].peer, 'g:9002');
  assert.ok(g[0].n > 0);
});

test('scoreGroup：像脚本的排榜首、正常人有痕迹压底，QQ 反查、排除她自己和系统事件', () => {
  const rows = botscore.scoreGroup('g:9002', { days: 30, now });
  assert.equal(rows.length, 2, '只有阿白和小张，她自己的/拍一拍/重置都不算');
  const bot = rows.find((x) => x.name === '阿白');
  const human = rows.find((x) => x.name === '小张');
  assert.equal(bot.verdict, '高度疑似');
  assert.ok(bot.flags.includes('全天在线') && bot.flags.includes('间隔稳定') && bot.flags.includes('同文重复'), `命中的规则要对：${bot.flags.join('、')}`);
  assert.equal(bot.qq, '12345', '群名片靠朋友圈档案反查出 QQ');
  assert.equal(human.verdict, '像人', '人类痕迹 + 作息聚簇 + 间隔散 → 不中规则');
  assert.ok(human.flags.includes('有语音/文件'));
  assert.ok(bot.score > human.score, '榜单按怀疑分降序');
  assert.ok(rows[0].name === '阿白');
});

test('数据不足的潜水员不评分', () => {
  writeFileSync(join(DATA, 'qq-chat-g_9003.jsonl'), [
    line('路人', '冒个泡', now - DAY),
    line('路人', '再冒个', now - DAY + 60000),
  ].join('\n') + '\n');
  const rows = botscore.scoreGroup('g:9003', { days: 30, now });
  assert.equal(rows[0].verdict, '数据不足');
  assert.equal(rows[0].score, null);
});

test('机器人名单的进与出（写 config 的数组要整体替换，不能并成字符串）', () => {
  writeConfig({ qq: { botQQs: ['10001'] } });
  writeConfig({ qq: { botQQs: ['10001', '12345'] } });
  assert.deepEqual(readConfig().qq.botQQs, ['10001', '12345']);
});

// ─── v2 养鱼号指标：近似重复 / 自说自话 / 引流词 / 卡片链接 / 置信衰减 ───────
// 小变：每天同一套话术的三个变体（改标点/空格/加表情）+ 一张卡片——完全同文的字符串一条都没有，
// v1 的全局去重抓瞎；v2 的滑动窗口归一比对 + 引流词 + 卡片该抓住。
// 群友甲/乙正常聊天穿插（互相接得上话），乙顺口提了一句「微信」——引流词只是辅助，不能凭一句定罪。
const rows4 = [];
for (let d = 1; d <= 25; d++) {
  rows4.push(line('群友甲', `早啊第${d}天来聊`, at(d, 8, 55, 0)));
  rows4.push(line('群友乙', `微信上跟你说第${d}集有点拖`, at(d, 8, 58, 0)));
  rows4.push(line('群友甲', `吃了那剧看到哪了${d}`, at(d, 9, 1, 0)));
  rows4.push(line('群友乙', `看到第${d}集了还行`, at(d, 9, 3, 0)));
  rows4.push(line('小变', `福利来了，加我微信abc${d}领红包！`, at(d, 9, 5, 0)));
  rows4.push(line('小变', `福利来了～加我微信abc${d}领红包`, at(d, 9, 6, 0)));
  rows4.push(line('小变', `福利来了 加我微信abc${d}领红包`, at(d, 9, 7, 0)));
  rows4.push(line('小变', `分享[卡片]第${d}期`, at(d, 9, 8, 0)));
  rows4.push(line('群友甲', `那我不看了明天再说${d}`, at(d, 9, 12, 0)));
  rows4.push(line('群友乙', `哈哈明天再说${d}`, at(d, 9, 15, 0)));
}
writeFileSync(join(DATA, 'qq-chat-g_9004.jsonl'), rows4.join('\n') + '\n');
// 小变二号：一模一样的套路，但只出现 10 天（40 条）——样本小，v2 分数该被置信度压低
writeFileSync(join(DATA, 'qq-chat-g_9006.jsonl'), rows4.slice(0, 100).join('\n') + '\n');
// 独白哥：死群里自言自语一个月——别人几乎不在场，「自说自话」根本判不了，不许硬判
const rows5 = [line('路人', '路过', at(20, 12, 0, 0))];
for (let d = 1; d <= 30; d++) {
  rows5.push(line('独白哥', `今天也说点自己的事${d}`, at(d, 12, 0, 0)));
  rows5.push(line('独白哥', `再说一句${d}`, at(d, 12, 1, 0)));
}
writeFileSync(join(DATA, 'qq-chat-g_9005.jsonl'), rows5.join('\n') + '\n');
// 群友甲的档案挂在别的群：名字对得上但群对不上 → QQ 低置信，不许静默当查准了
writeFileSync(join(DATA, 'friends.json'), JSON.stringify({ friends: {
  12345: { qq: 12345, name: '阿白', names: [], firstMet: '', groups: ['g:9002'], notes: [] },
  22222: { qq: 22222, name: '群友甲', names: [], firstMet: '', groups: ['g:9999'], notes: [] },
} }));

test('v2 抓变体复读养鱼号：v1 全局同文漏掉的，窗口近似重复 + 引流词 + 卡片抓得住', () => {
  const rows = botscore.scoreGroup('g:9004', { days: 30, now });
  const x = rows.find((r) => r.name === '小变');
  assert.ok(x, '小变在榜单里');
  assert.ok(x.windowDupShare >= 0.5, `三个变体归一后该算重复：${x.windowDupShare}`);
  assert.equal(x.drainHit, true, '话术里有 加我/微信/福利');
  assert.equal(x.riskTrace, true, '每天甩一张卡片');
  assert.ok(x.flags2.includes('短窗口近似重复') && x.flags2.includes('命中引流词') && x.flags2.includes('带链接/卡片'), `v2 命中的规则要对：${x.flags2.join('、')}`);
  assert.equal(x.verdict, '像人', `旧分看不出（完全同文一条都没有）：${x.score}`);
  assert.equal(x.verdict2, '高度疑似', `新分该抓住：${x.score2}`);
});

test('自说自话：活群里插不进话的算，聊得起来的不算，死群独白不硬判', () => {
  const rows = botscore.scoreGroup('g:9004', { days: 30, now });
  const jia = rows.find((r) => r.name === '群友甲');
  const x = rows.find((r) => r.name === '小变');
  assert.ok(jia.selfTalkShare !== null && jia.selfTalkShare <= 0.3, `正常聊天的人接话率该高：${jia.selfTalkShare}`);
  assert.ok(!jia.flags2.includes('自说自话'));
  assert.ok(x.selfTalkShare >= 0.6, `话术号在活群里只抛不接：${x.selfTalkShare}`);
  assert.ok(x.flags2.includes('自说自话'));
  const dead = botscore.scoreGroup('g:9005', { days: 30, now }).find((r) => r.name === '独白哥');
  assert.equal(dead.selfTalkShare, null, '别人几乎不在场，这个比例根本统计不出来');
  assert.ok(!dead.flags2.includes('自说自话'), '死群独白不许硬判');
});

test('引流词只是辅助：正常聊天顺口提一句「微信」不能定罪', () => {
  const rows = botscore.scoreGroup('g:9004', { days: 30, now });
  const yi = rows.find((r) => r.name === '群友乙');
  assert.equal(yi.drainHit, true, '词是命中了');
  assert.equal(yi.verdict2, '像人', `但单独一个词不推人进可疑：${yi.score2}`);
});

test('样本置信衰减：一模一样的套路，条数少的分数要被压低', () => {
  const full = botscore.scoreGroup('g:9004', { days: 30, now }).find((r) => r.name === '小变');
  const none = botscore.scoreGroup('g:99999', { days: 30, now }); // 防呆：没有记录文件的群也不该炸
  assert.deepEqual(none, []);
  const fewX = botscore.scoreGroup('g:9006', { days: 30, now }).find((r) => r.name === '小变');
  assert.ok(full.score2 > fewX.score2, `25 天的比 10 天的分高：${full.score2} vs ${fewX.score2}`);
});

test('QQ 反查带置信度：群对上的 high，只对上名字的 low，别静默抓错人', () => {
  const rows4r = botscore.scoreGroup('g:9004', { days: 30, now }).find((r) => r.name === '群友甲');
  assert.equal(rows4r.qq, '22222', '名字对上还是能给（要拉黑有得用）');
  assert.equal(rows4r.qqConf, 'low', '但档案挂在别的群，要标低置信');
  const rows2r = botscore.scoreGroup('g:9002', { days: 30, now }).find((r) => r.name === '阿白');
  assert.equal(rows2r.qqConf, 'high');
  assert.equal(rows2r.qq, '12345');
});

// ─── 对话号维度：触发即回的挂机 AI（不是引流养鱼，是伴聊 bot）─────────
// 快手bot：每天在磨叽人说完后 4 秒内接话（触发即回）、名字带 .by、时不时「主人」、被点名秒回
// 磨叽人：隔了一夜才回（慢尾把 P90 推上去）、名字普通、没人点名 → 一个旗子都不该中
// 名字号：名字带 .by 但回话慢 → 名字只当提示，不够定罪
const rows7 = [];
for (let d = 1; d <= 13; d++) {
  rows7.push(line('磨叽人', d % 2 ? `快手bot在吗，问个事${d}` : `看到了说两句${d}`, at(d, 20, 0, 0)));
  rows7.push(line('快手bot.by码农', d % 5 === 1 ? `主人我在的` : `马上就回`, at(d, 20, 0, 4)));
  rows7.push(line('磨叽人', `你怎么回这么快${d}`, at(d, 20, 0, 8)));
  rows7.push(line('快手bot.by码农', `因为我在呀`, at(d, 20, 0, 12)));
  rows7.push(line('名字号.by测试', `慢慢想一下再回${d}`, at(d, 20, 1, 0)));
  rows7.push(line('名字号.by测试', `再补一句${d}`, at(d, 20, 1, 30)));
  rows7.push(line('会语音bot.by某人', d % 2 ? `[语音]` : `在的呀`, at(d, 20, 1, 4))); // 快而稳的多模态号：会发语音
  rows7.push(line('会语音bot.by某人', `收到`, at(d, 20, 1, 34)));
}
writeFileSync(join(DATA, 'qq-chat-g_9007.jsonl'), rows7.join('\n') + '\n');
// 数据不足的挂机号（13 条）：分数照旧不算，但时序旗子要亮出来给提示
const rows8 = [];
for (let d = 1; d <= 13; d++) {
  rows8.push(line('话少的甲', `今天说点${d}`, at(d, 21, 0, 0)));
  rows8.push(line('小话痨.by某人', `来了来了`, at(d, 21, 0, 3)));
}
writeFileSync(join(DATA, 'qq-chat-g_9008.jsonl'), rows8.join('\n') + '\n');

test('对话号维度：触发即回的快而稳、名字带.by、张口主人、点名必回', () => {
  const rows = botscore.scoreGroup('g:9007', { days: 30, now });
  const bot = rows.find((r) => r.name === '快手bot.by码农');
  const slow = rows.find((r) => r.name === '磨叽人');
  const bynm = rows.find((r) => r.name === '名字号.by测试');
  assert.ok(bot.flags2.includes('回应又快又稳'), `延迟形态：${bot.flags2.join('、')}`);
  assert.ok(bot.flags2.includes('名字带.by作者'));
  assert.ok(bot.flags2.includes('张口主人'));
  assert.ok(bot.flags2.includes('点名必回'));
  assert.equal(bot.verdict2, '可疑', `对话号四连该进可疑：${bot.score2}`);
  assert.ok(!slow.flags2.includes('回应又快又稳'), '隔夜才回的没有快而稳');
  assert.ok(!slow.flags2.includes('张口主人'));
  assert.equal(slow.verdict2, '像人', `正常人一个不中：${slow.score2} ${slow.flags2.join('、')}`);
  assert.ok(bynm.flags2.includes('名字带.by作者'), '名字特征要亮出来');
  assert.ok(bynm.score2 < 10, `名字本身一分不加分，只剩行为分：${bynm.score2}`);
  assert.equal(bynm.verdict2, '像人', `名字不加分，行为不够就不定罪：${bynm.score2}`);
  assert.ok(bot.score2 >= 40, `对话号的行为分要能独立立住（不靠名字）：${bot.score2}`);
});

test('数据不足的挂机号：不判分，但提示旗子照亮', () => {
  const row = botscore.scoreGroup('g:9008', { days: 30, now }).find((r) => r.name === '小话痨.by某人');
  assert.equal(row.verdict2, '数据不足');
  assert.equal(row.score2, null);
  assert.ok(row.flags2.includes('回应又快又稳') && row.flags2.includes('名字带.by作者'), `旗子要亮：${row.flags2.join('、')}`);
});

test('挂机号也会发语音：快而稳的号上语音不是人证，不许再洗白', () => {
  const rows = botscore.scoreGroup('g:9007', { days: 30, now });
  const voice = rows.find((r) => r.name === '会语音bot.by某人');
  assert.ok(voice.score2 >= 30, `语音不该扣它的分（行为分该原样保留）：${voice.score2}`);
  assert.ok(!voice.flags2.includes('有语音/文件'), '洗白旗子不该亮');
});
