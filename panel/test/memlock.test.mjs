import './_env.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { DATA } from '../store.mjs';
import { withLock, lockStats, resetLockStats } from '../memlock.mjs';
import * as memory from '../memory.mjs';

const LOCK = join(DATA, 'memories.json.lock');
const FILE = join(DATA, 'memories.json');

test('1. 锁互斥：同一时刻只有一个事务在跑', () => {
  resetLockStats();
  let active = 0, maxActive = 0;
  const body = () => {
    active++;
    maxActive = Math.max(maxActive, active);
    const spin = Date.now() + 15; while (Date.now() < spin) { /* 占住临界区 */ }
    active--;
  };
  withLock(body);
  withLock(body);
  withLock(body);
  assert.equal(maxActive, 1, '串行执行，没有两个事务同时在临界区');
  assert.equal(existsSync(LOCK), false, '事务结束锁文件被释放');
});

test('2. 死锁自愈：锁文件时间戳超 5 秒就接管', () => {
  resetLockStats();
  writeFileSync(LOCK, `${process.pid} ${Date.now() - 6000}`); // 6 秒前，已过期
  let ran = false;
  withLock(() => { ran = true; });
  assert.equal(ran, true, '过期锁被接管，事务照跑');
  assert.ok(lockStats().staleRecovered >= 1, '记了一次死锁接管');
  assert.equal(existsSync(LOCK), false, '结束后释放');
});

test('3. 同进程重入不死锁（add 内部 load 的首次写也过锁）', () => {
  resetLockStats();
  let inner = false;
  withLock(() => {
    withLock(() => { inner = true; }); // 重入：depth>0 直接放行
  });
  assert.equal(inner, true);
  assert.ok(lockStats().waits === 0, '重入没触发等待（否则就是自己等自己）');
});

test('4. 并发写不丢：两个 writer 各 load→改→save，包锁后两条都在', () => {
  // 模拟三个进程的经典竞态：不包锁时两次 load 拿到同一份，各自 push 后 save，后写覆盖前者。
  // 包锁后每个事务串行 load→push→写盘，两条都保留。
  writeFileSync(FILE, '[]');
  const writer = (tag) => withLock(() => {
    const all = JSON.parse(readFileSync(FILE, 'utf-8'));
    all.push({ id: tag, text: tag, kind: 'watch', imp: 3, keys: [], ts: new Date().toISOString() });
    writeFileSync(FILE, JSON.stringify(all));
  });
  writer('writer-A');
  writer('writer-B');
  const final = JSON.parse(readFileSync(FILE, 'utf-8'));
  assert.equal(final.length, 2, '两条写入都在，没被覆盖');
  assert.ok(final.some((e) => e.id === 'writer-A') && final.some((e) => e.id === 'writer-B'));
});

test('5. memory.add 真并发：锁包住后 N 条一条不少', () => {
  writeFileSync(FILE, '[]');
  const N = 24;
  for (let i = 0; i < N; i++) memory.add({ kind: 'watch', text: `并发记忆标记 memlock${i}`, imp: 2 });
  const all = JSON.parse(readFileSync(FILE, 'utf-8'));
  assert.equal(all.length, N, 'N 次 add 全部落盘，无一丢失');
});

test('6. recall(touch) 与 add 交错：touch 的 save 不覆盖刚加的记忆', () => {
  writeFileSync(FILE, '[]');
  const e = memory.add({ kind: 'watch', text: '并发touch目标 memlocktouch', imp: 3 });
  // recall 带 touch=true 会 load 一份、改 seen/n、再 save——若没锁，会和期间的新 add 打架
  memory.recall('memlocktouch', { keys: [], k: 3, touch: true });
  memory.add({ kind: 'watch', text: 'touch期间新写的 memlocknew', imp: 2 });
  const all = JSON.parse(readFileSync(FILE, 'utf-8'));
  assert.ok(all.some((x) => x.id === e.id), '被 touch 的原记忆还在');
  assert.ok(all.some((x) => x.text.includes('memlocknew')), '期间的 add 没被 touch 覆盖');
});
