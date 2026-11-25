import './_env.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

// 前端没有 DOM 测试环境，但这条约束可以静态守：
// .switch 的原生 checkbox 是 0×0 隐形的（style.css），点击全靠外层 label 转发——
// 哪个 switch 忘了包 label，哪个就是「点了没反应」的死开关（2026-11-13 总开关关不掉的根因）。
const src = readFileSync(join(fileURLToPath(new URL('../public/app.js', import.meta.url)), ), 'utf-8');

test('UI：app.js 里每个 switch 开关都包在 label 里（不包=点不到的死开关）', () => {
  let idx = 0, count = 0;
  while ((idx = src.indexOf('<span class="switch">', idx)) !== -1) {
    count++;
    const before = src.slice(Math.max(0, idx - 300), idx);
    const lastOpen = before.lastIndexOf('<label');
    const lastClose = before.lastIndexOf('</label>');
    assert.ok(lastOpen !== -1 && lastOpen > lastClose,
      `第 ${count} 个 switch（源码偏移 ${idx}）没包在 label 里——原生 checkbox 是隐形的，这个开关点了不会有任何反应`);
    idx += 1;
  }
  assert.ok(count >= 3, `应该至少有 3 个开关（总览总开关/tog/设置页总开关），实际只找到 ${count} 个——模板改了的话测试跟着改`);
});

test('UI：不能用局部 busy 变量遮蔽 busy(btn, fn)，否则任务箱/约定取消按钮点了没反应', () => {
  assert.match(src, /async function busy\(btn, fn\)/, 'busy() 按钮助手应该还在');
  assert.doesNotMatch(src, /\b(?:const|let|var)\s+busy\b/,
    'app.js 里出现了局部 busy 绑定；点击处理器里的 busy(btn, fn) 会变成把布尔值当函数调用，取消按钮会静默失效');
});

// 群聊感知三合一（2026-11-25）：群背景从活动记录挪走、大事件进活动记录。
// 前端没 DOM 环境，静态守住这层意图，防止以后改回归到「群背景刷屏 / 大事件看不到」。
test('UI：群聊感知页三个 tab 齐全（裁决 / 群背景 / 大事件）', () => {
  assert.match(src, /\[\['gate',\s*'[^']*插嘴裁决'\],\s*\['perceive',\s*'[^']*群背景'\],\s*\['big_event',\s*'[^']*大事件'\]\]/,
    'pageGate 的 TABS 必须是裁决/群背景/大事件三项，少一项就有一个账本看不到');
});

test('活动记录：剔除 perceive 群背景（防刷屏），但保留 big_event 大事件', () => {
  const panelSrc = readFileSync(join(fileURLToPath(new URL('../panel.mjs', import.meta.url))), 'utf-8');
  const filterLine = panelSrc.split('\n').find((l) => l.includes("a.kind !== 'perceive'"));
  assert.ok(filterLine, 'GET /api/actions 默认过滤必须剔掉 perceive');
  assert.doesNotMatch(filterLine, /a\.kind !== 'big_event'/, 'big_event 大事件必须留在活动记录，不能跟群背景一起被剔');
});

test('记忆页「日子」必须读后端全量 days，不能从被挤爆的 recent 里筛', () => {
  assert.match(src, /const days = mem\?\.days \|\| keep\.filter/,
    'renderMemories 的 days 必须优先读 mem.days；退回 recent 筛会让刷视频经历被高频群背景挤出窗口');
  const memSrc = readFileSync(join(fileURLToPath(new URL('../memory.mjs', import.meta.url))), 'utf-8');
  assert.match(memSrc, /days: live\.filter\(\(e\) => EXPERIENCE\.has\(e\.kind\)\)\.reverse\(\)/,
    'memoryView 必须给面板提供独立的全量经历列表 days');
});

test('记忆页「印象·日结」读后端全量 gistsAll，前端分页而非截断', () => {
  assert.doesNotMatch(src, /chatShow\.slice\(0,\s*12\)/, '不能再有 chatShow 只取最近 12 条的截断');
  assert.match(src, /const gists = mem\?\.gistsAll \|\| mem\?\.gists \|\| \[\]/, '优先读后端全量 gistsAll，老面板退回 gists');
  assert.match(src, /data-memmore=/, '必须有「再显示」分页按钮，不一次性铺开全量');
  assert.match(src, /box\.onclick = \(ev\) => \{/, '改/删/放行/丢掉走事件委托，追加的条目才带操作');
  assert.match(src, /next\.map\(memRow\)\.join\(''\)/, '分页追加的条目走同一套 memRow 渲染');
  const memSrc = readFileSync(join(fileURLToPath(new URL('../memory.mjs', import.meta.url))), 'utf-8');
  assert.match(memSrc, /gistsAll: live\.filter\(isGist\)\.reverse\(\)/, 'memoryView 必须给面板提供独立全量 gistsAll');
  assert.match(memSrc, /gists: live\.filter\(isGist\)\.slice\(-n\)\.reverse\(\)/, 'gists 的 n 条窗口语义要保留给内部链路');
});

test('序9/序10 记忆用独立 kind，不挤占 chat 对话日结', () => {
  const pSrc = readFileSync(join(fileURLToPath(new URL('../qq/perceive.mjs', import.meta.url))), 'utf-8');
  assert.match(pSrc, /kind: 'background'/, '群背景必须是 background kind');
  assert.match(pSrc, /kind: 'big_event'/, '大事件必须是 big_event kind，不再用 chat');
});
