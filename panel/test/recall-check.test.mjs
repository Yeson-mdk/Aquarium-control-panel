import './_env.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';

// recall-check 不调模型，不用配假 LLM；直接对着记忆流测判定逻辑
const store = await import('../store.mjs');
const memory = await import('../memory.mjs');
const rc = await import('../recall-check.mjs');

const { readFileSync, writeFileSync, existsSync } = await import('node:fs');
const { join } = await import('node:path');
const { DATA } = await import('./_env.mjs');
const CHECK = join(DATA, 'recall-check.json');
const LAST = join(DATA, 'recall-check-last.json');

test('首跑：从真实记忆现场挖查询集、全绿落 🔍 日志、结果存档', async () => {
  for (let i = 0; i < 6; i++) memory.add({ kind: 'watch', imp: 3, text: `看了《深夜食堂第${i}夜》：老板炖的汤看饿了`, keys: ['up:美食家'] });
  memory.add({ kind: 'chat', imp: 4, keys: ['g:9401'], text: '「群·9401」小零 说周末约了羽毛球局' });
  memory.add({ kind: 'chat', imp: 4, keys: ['g:9402'], text: '「群·9402」Yeson 在讨论机械键盘轴体' });
  store.logAction({ kind: 'test', detail: '垫一条' });
  const r = await rc.runRecallCheck();
  assert.ok(existsSync(CHECK), '查询集自动生成了（不用人手建）');
  const file = JSON.parse(readFileSync(CHECK, 'utf-8'));
  assert.ok(file.keep.length >= 3, '起始集从真实记忆里挖的');
  assert.ok(file.trap.length >= 3, '陷阱用例在里面');
  assert.equal(r.flags.length, 0, '正常情况不报警');
  assert.ok(r.traps >= file.trap.length, '陷阱全跑过');
  assert.ok(r.cross?.ok, '跨对话抽查通过（A 群原文 B 群视角翻不到、自己视角翻得到）');
  assert.ok(existsSync(LAST), '结果存档，下次好对比');
  assert.match(store.readActions().at(-1).detail, /🔍 记忆对账/, '落 🔍 日志');
  // 想起次数不该被对账污染（seen/n 只该在她真想起来时动）
  const n0 = memory.memoryView(50).recent.find((e) => /羽毛球局/.test(e.text))?.n;
  assert.ok(!n0, '对账用 touch:false，不刷「想起过」计数');
});

test('陷阱踩中要报警：查不存在的事翻出东西 = 有记忆在造假', async () => {
  memory.add({ kind: 'chat', imp: 4, keys: ['g:9401'], text: '「群·9401」卷心菜 念叨上次群里中彩票大奖的事' });
  const r = await rc.runRecallCheck();
  assert.ok(r.flags.some((f) => f.includes('陷阱') && f.includes('彩票')), '陷阱命中落 flag');
  assert.match(store.readActions().at(-1).detail, /⚠️ 记忆对账/, '报警日志带 ⚠️');
});

test('跨对话抽查的探针查询不带对话标签：长群号 + 同群一批新日结，不该误报「视角丢了」', async () => {
  // 复刻 2026-11-10 线上误报：群号 10 位，「群·xxxxx」标签本身就把 slice(0,12) 占满，
  // 查询只剩群号零内容 → 同群条目相关度全并列 → 低 imp 的最新一条挤不进 top3 → 误报视角丢了
  memory.add({ kind: 'chat', imp: 4, keys: ['g:9402'], text: '「群·9402」Yeson 在讨论机械键盘轴体' }); // 第二个对话钥匙：跨对话抽查才会真的跑（先加，保证目标群是最新的那个 ka）
  for (let i = 0; i < 3; i++) memory.add({ kind: 'chat', imp: 5, keys: ['g:1124893144'], text: `「群·1124893144」老朋友${i} 说下周去钓鱼露营，装备都买好了` });
  memory.add({ kind: 'chat', imp: 2, keys: ['g:1124893144'], text: '「群·1124893144」小绿 分享了个手冲咖啡的教程链接' });
  const r = await rc.runRecallCheck();
  assert.ok(!r.flags.some((f) => f.includes('视角丢了')), '探针查询该用内容而不是群号标签，不该误报');
  assert.ok(r.cross?.ok, '自己视角翻得到自己的原文');
});

test('真回归要报警：那条记忆还在记忆里，却翻不到了', async () => {
  const file = JSON.parse(readFileSync(CHECK, 'utf-8'));
  const victim = memory.add({ kind: 'watch', imp: 3, text: '看了《冰岛极光延时》：绿得发紫，想存壁纸' });
  file.keep.push({ q: '一个跟这条记忆毫无重叠的查询词qqzz', id: victim.id }); // 记忆在、查询却对不上——模拟打分/可见性改坏
  writeFileSync(CHECK, JSON.stringify(file));
  const r = await rc.runRecallCheck();
  assert.ok(r.flags.some((f) => f.includes('翻不到了')), '条目还在却想不起来 = 真回归');
});

test('正常代谢不报警：合并/遗忘的档案还答得上；真删掉的锚点自动换新', async () => {
  const file = JSON.parse(readFileSync(CHECK, 'utf-8'));
  const merged = memory.add({ kind: 'chat', imp: 3, keys: ['g:9401'], text: '「群·9401」小零 问了下天气就跑了' });
  file.keep.push({ q: '问了下天气就跑了', id: merged.id });
  writeFileSync(CHECK, JSON.stringify(file));
  // ① 被 tidy 遗忘/合并：json 里没了但档案库还在（只增不删）——档案兜底答得上，不报警
  const all = JSON.parse(readFileSync(join(DATA, 'memories.json'), 'utf-8'));
  writeFileSync(join(DATA, 'memories.json'), JSON.stringify(all.filter((e) => e.id !== merged.id)));
  let r = await rc.runRecallCheck();
  assert.ok(!r.flags.some((f) => f.includes('天气')), '合并/遗忘不算回归（档案兜底还答得上）');
  // ② 面板里手动删的连档案一起清：锚点真死了，换新，不留给明天误报
  const gone = memory.add({ kind: 'chat', imp: 3, keys: ['g:9402'], text: '「群·9402」Yeson 换了新键盘轴' });
  const f2 = JSON.parse(readFileSync(CHECK, 'utf-8'));
  f2.keep.push({ q: '换了新键盘轴', id: gone.id });
  writeFileSync(CHECK, JSON.stringify(f2));
  await rc.runRecallCheck(); // 先跑一遍确认在档（save 已镜像进 memdb）
  memory.remove(gone.id); // 面板删除 = 隐私删除，档案也不留
  r = await rc.runRecallCheck();
  assert.ok(!r.flags.some((f) => f.includes('键盘轴')), '真删掉的不报警');
  const f3 = JSON.parse(readFileSync(CHECK, 'utf-8'));
  assert.ok(!f3.keep.some((k) => k.id === gone.id), '死锚点被换掉');
});
