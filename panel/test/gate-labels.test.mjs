import test from 'node:test';
import assert from 'node:assert/strict';
import './_env.mjs';

const { appendJsonl, FILES } = await import('../store.mjs');
const gl = await import('../../ops/gate-labels.mjs');

function seedGates() {
  const mk = (text, verdict, score, peer = 'g:1') => ({
    ts: new Date().toISOString(), kind: 'gate', source: 'auto', ok: true, detail: '', target: '', title: '', error: '',
    meta: { verdict, score, status: verdict === '拦下' ? 'skip' : 'pass', reasons: ['话题延续'], text, peer },
  });
  appendJsonl(FILES.actions, mk('今天打球去不去', '过闸', 6.6));
  appendJsonl(FILES.actions, mk('今天打球去不去', '过闸', 6.6)); // 重复，应去重
  appendJsonl(FILES.actions, mk('哈哈哈', '拦下', 1.8));
}

test('C1.1 从 gate 日志导候选，按 text 去重、id 递增', () => {
  seedGates();
  const r = gl.importFromActions();
  assert.equal(r.added, 2);
  const rows = gl.readLabels();
  assert.equal(rows.length, 2);
  assert.deepEqual(rows.map((x) => x.id), ['L001', 'L002']);
  // 再导一次不新增
  assert.equal(gl.importFromActions().added, 0);
});

test('C1.2 标注：该回/不该回/撤销，note 留痕', () => {
  let rows = gl.readLabels();
  const id = rows[0].id;
  let r = gl.setLabel(id, true, '真该接');
  assert.equal(r.label, true);
  assert.equal(r.note, '真该接');
  assert.ok(r.labeledAt);
  r = gl.setLabel(id, false);
  assert.equal(r.label, false);
  r = gl.setLabel(id, null);
  assert.equal(r.label, null);
});

test('C1.3 跑分：只算已标注的，一致率/翻案数正确', () => {
  const rows = gl.readLabels();
  const ball = rows.find((x) => x.text.includes('打球'));
  const haha = rows.find((x) => x.text === '哈哈哈');
  // 按当前判定的实际口径标（无上下文时打球=review 进池、哈哈哈=skip）
  gl.setLabel(ball.id, true);
  gl.setLabel(haha.id, false);
  const r = gl.score();
  assert.equal(r.total, 2);
  assert.equal(r.flips, 0, `期望全一致，实际翻案：${JSON.stringify(r.details)}`);
  assert.equal(r.agree, 2);
  // 故意标反一条 → 翻案 +1
  gl.setLabel(ball.id, false);
  const r2 = gl.score();
  assert.equal(r2.flips, 1);
  assert.equal(r2.agree, 1);
});

test('C1.4 remove 删一条，id 不变其余保留', () => {
  const before = gl.readLabels();
  assert.equal(gl.removeLabel(before[0].id), true);
  const after = gl.readLabels();
  assert.equal(after.length, before.length - 1);
  assert.equal(gl.removeLabel('L999'), false);
});
