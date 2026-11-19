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
