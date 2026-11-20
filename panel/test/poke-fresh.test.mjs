import './_env.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lastRealChatTs, pokeWindowMs, pokeFresh } from '../qq/poke-fresh.mjs';

const seq = (...vals) => { let i = 0; return () => vals[Math.min(i++, vals.length - 1)]; };
const NOW = Date.parse('2026-11-20T10:00:00.000Z');

test('lastRealChatTs：倒着找最后一句真话，跳过拍一拍/@了/reset/空行', () => {
  const rows = [
    { ts: '2026-11-20T09:50:00.000Z', text: '真话一' },
    { ts: '2026-11-20T09:55:00.000Z', text: '（路人拍了拍你）' }, // 系统占位，跳
    { ts: '2026-11-20T09:56:00.000Z', text: '（@了你，什么都没说）' }, // 跳
    { ts: '2026-11-20T09:57:00.000Z', text: '' }, // 空，跳
    { ts: '2026-11-20T09:58:00.000Z', text: '真话二', kind: 'reset' }, // reset，跳
    { ts: '2026-11-20T09:59:00.000Z', text: '真话三' }, // ← 最后一句真话
  ];
  assert.equal(lastRealChatTs(rows, NOW), Date.parse('2026-11-20T09:59:00.000Z'));
  assert.equal(lastRealChatTs(rows.slice(0, 1), NOW), Date.parse('2026-11-20T09:50:00.000Z'), '只剩一条时也认');
  assert.equal(lastRealChatTs([{ ts: NOW + 3600_000, text: '未来脏数据' }], NOW), 0, '未来超过一分钟当无效');
  assert.equal(lastRealChatTs([], NOW), 0, '空历史返回 0');
});

test('pokeWindowMs：基准秒数 + ±抖动 + 上下界钳制', () => {
  assert.equal(pokeWindowMs({}), 0, '没配窗口 = 闸关着');
  assert.equal(pokeWindowMs({ pokeFreshSec: 0 }), 0, '窗口 0 = 闸关着');
  // 基准 100 秒、幅度 0：原样返回，不调随机源
  let called = 0;
  assert.equal(pokeWindowMs({ pokeFreshSec: 100, pokeJitterRatio: 0 }, () => { called++; return 0.5; }), 100_000);
  assert.equal(called, 0, '不抖时不消耗 rng');
  // 幅度 0.15、基准 100 秒 → ±15 秒；固定 rng 走边界
  const g = { pokeFreshSec: 100, pokeJitterRatio: 0.15, pokeFreshMinSec: 30, pokeFreshMaxSec: 300 };
  assert.equal(pokeWindowMs(g, seq(0, 0)), 85_000, 'rng=0 → 下界 85 秒');
  assert.equal(pokeWindowMs(g, seq(0, 1)), 115_000, 'rng=1 → 上界 115 秒');
  assert.equal(pokeWindowMs(g, seq(0, 0.5)), 100_000, 'rng=0.5 → 正中 100 秒');
});

test('pokeWindowMs：护栏始终生效，min>max 写反自动交换', () => {
  // 基准 100、幅度 0（不抖）但护栏 80~90：仍要钳到 90
  assert.equal(pokeWindowMs({ pokeFreshSec: 100, pokeJitterRatio: 0, pokeFreshMaxSec: 90 }, seq()), 90_000, '不抖也钳上限');
  assert.equal(pokeWindowMs({ pokeFreshSec: 10, pokeJitterRatio: 0, pokeFreshMinSec: 20 }, seq()), 20_000, '不抖也钳下限');
  // min 写反成 300、max 写成 30 → 交换后 [30,300]，抖到 85 秒照单收
  assert.equal(pokeWindowMs({ pokeFreshSec: 100, pokeJitterRatio: 0.15, pokeFreshMinSec: 300, pokeFreshMaxSec: 30 }, seq(0, 0)), 85_000);
});

test('pokeFresh：够近回看、太远忽略、正好压线算够近', () => {
  const w = 100_000;
  assert.deepEqual(pokeFresh({ lastTs: NOW - 99_000, now: NOW, windowMs: w }), { allow: true, verdict: 'fresh', gapMs: 99_000, windowMs: w });
  assert.deepEqual(pokeFresh({ lastTs: NOW - 101_000, now: NOW, windowMs: w }), { allow: false, verdict: 'stale', gapMs: 101_000, windowMs: w });
  assert.equal(pokeFresh({ lastTs: NOW - w, now: NOW, windowMs: w }).verdict, 'fresh', '正好等于窗口 = 够近');
});

test('pokeFresh：关闸 / 没上一句 / 时钟回拨 都放行（保留老行为）', () => {
  assert.deepEqual(pokeFresh({ lastTs: NOW - 999_000, now: NOW, windowMs: 0 }), { allow: true, verdict: 'off', gapMs: null, windowMs: 0 }, '关闸照回');
  assert.equal(pokeFresh({ lastTs: 0, now: NOW, windowMs: 100_000 }).verdict, 'no-last', '没有上一句照回');
  assert.equal(pokeFresh({ now: NOW, windowMs: 100_000 }).verdict, 'no-last', '缺省也当没上一句');
  const future = pokeFresh({ lastTs: NOW + 5000, now: NOW, windowMs: 100_000 });
  assert.equal(future.gapMs, 0, '时钟回拨/未来时间戳按 0 秒算');
  assert.equal(future.allow, true);
});
