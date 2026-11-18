import test from 'node:test';
import assert from 'node:assert/strict';
import './_env.mjs';
import { decideRate, calmMs, exemptKey } from '../qq/rate.mjs';
import { DEFAULTS } from '../qq/tuning.mjs';

const g = { ...DEFAULTS.gate, exemptPerDay: 12, calmTrigger: 4, calmWindowMin: 10, userRateMax: 3 };

test('C2.1 点名叫她：每天前 N 次豁免，超了也拦', () => {
  const called = { called: true, reasons: ['指向你'] };
  assert.equal(decideRate({ ...called, exemptUsed: 0, g }).allow, true);
  assert.equal(decideRate({ ...called, exemptUsed: 0, g }).exempt, true);
  const over = decideRate({ ...called, exemptUsed: 12, g });
  assert.equal(over.allow, false);
  assert.equal(over.verdict, '豁免用尽');
  assert.equal(over.exempt, false, '用尽后不再记豁免');
});

test('C2.2 普通自由插嘴：按人窗口限流', () => {
  const plain = { called: false, reasons: ['话题延续'] };
  assert.equal(decideRate({ ...plain, rateHits: 2, g }).allow, true);
  const over = decideRate({ ...plain, rateHits: 3, g });
  assert.equal(over.allow, false);
  assert.equal(over.verdict, '限流');
});

test('C2.3 怼/复读累计到阈值触发冷静窗，冷静期内全拦', () => {
  const hit = { called: true, reasons: ['被点名怼'] };
  assert.equal(decideRate({ ...hit, attackHits: 2, g }).allow, true, '没到阈值先放行');
  const trig = decideRate({ ...hit, attackHits: 3, g }); // +1=4 达标
  assert.equal(trig.allow, false);
  assert.equal(trig.verdict, '冷静·触发');
  assert.equal(trig.calm, true, '开新冷静窗');
  // 冷静窗内：任何自由插嘴（哪怕点名）都拦，但不续期、不记豁免
  const inCalm = decideRate({ ...hit, calmUntil: Date.now() + 60000, g });
  assert.equal(inCalm.allow, false);
  assert.equal(inCalm.verdict, '冷静窗');
  assert.equal(inCalm.calm, false, '冷静期内不续期');
  const expired = decideRate({ ...hit, calmUntil: Date.now() - 1000, g });
  assert.equal(expired.verdict, '', '过期后恢复正常');
});

test('C2.4 攻击识别只认「被点名怼」，复读/普通话题不算（2026-11-18 收窄：复读打分层已拦，冷静窗只管真怼）', () => {
  const plain = decideRate({ called: false, reasons: ['话题延续', '带提问'], rateHits: 0, g });
  assert.equal(plain.attack, false);
  const repeat = decideRate({ called: false, reasons: ['重复表述', '冷却期重复'], rateHits: 0, g });
  assert.equal(repeat.attack, false, '跟风刷梗不进冷静窗');
  const attack = decideRate({ called: false, reasons: ['被点名怼'], rateHits: 0, g });
  assert.equal(attack.attack, true);
});

test('C2.5 calmMs / exemptKey 工具函数', () => {
  assert.equal(calmMs(g), 10 * 60_000);
  assert.equal(calmMs({ calmWindowMin: 0 }), 10 * 60_000, '非法值兜底默认 10 分钟');
  const k = exemptKey('g:123', '456');
  assert.ok(k.startsWith('g:123:456:'), '带日期后缀，跨天自动分桶');
});
