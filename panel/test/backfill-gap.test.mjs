import './_env.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DATA } from './_env.mjs';
import * as memdb from '../memdb.mjs';
import { backfill } from '../../ops/backfill-vec.mjs';

// 回归：档案库里有一批「没正文」的旧条目排在最前面时，回填必须越过它们把后面有正文的补齐。
// 旧写法从 '' 贪心取、todo 空就 break，导致 453 条只补 178 条（漏 255 条）。
const V = [1, 0, 0];

test('回填跳过前排空正文条目，不漏掉后面的有正文记忆', async () => {
  // 20 条没正文（模拟被遗忘/挤掉只剩档案的旧条目），id 排最前；后面 45 条有正文
  const noText = Array.from({ length: 20 }, (_, i) => ({ id: `a-gap-${String(i).padStart(3, '0')}`, text: '' }));
  const withText = Array.from({ length: 45 }, (_, i) => ({ id: `b-ok-${String(i).padStart(3, '0')}`, text: `有正文的记忆${i}` }));
  writeFileSync(join(DATA, 'memories.json'), JSON.stringify([...noText, ...withText]));

  memdb.init();
  assert.equal(memdb.vecStats().total, 65);

  const r = await backfill({ embedFn: async (texts) => texts.map(() => V), batch: 20 });

  assert.equal(r.failed, 0, '不该有失败');
  assert.equal(r.skipped, 20, '20 条空正文被跳过');
  assert.equal(r.filled, 45, '45 条有正文的全部补上——旧代码这里只会补到 0，后面的全漏');
  assert.equal(memdb.vecStats().withVec, 45, '库内最终 45 条带向量');
  // 确认最后一条（排序最末）确实补上了，证明游标翻到了底
  assert.ok(memdb.search('有正文的记忆44').some((x) => Array.isArray(x.vec) && x.vec.length), '末尾条目也补上了');
});

test('二次回填幂等：已满的不再重复补', async () => {
  const r = await backfill({ embedFn: async (texts) => texts.map(() => V), batch: 20 });
  assert.equal(r.filled, 0, '没有新补的');
});
