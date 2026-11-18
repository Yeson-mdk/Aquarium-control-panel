/**
 * 活记忆写串行锁（批次 B1）
 *
 * memories.json 是面板、QQ 机器人、recall.mjs CLI 三个进程共用的，
 * 每处都是 load() → 改 → save() 的读-改-写序列，无锁时两个进程各读一份、
 * 各自写回，后写的把先写的整段覆盖掉（丢记忆）。锁必须包住整个事务，
 * 只在 save 内部加锁没用——读的那一步已经在锁外了。
 *
 * 实现：O_EXCL 原子创建锁文件拿到锁，拿不到就忙等重试（函数全是同步的，
 * 不能 async wait）；锁文件带时间戳，超过 STALE_MS 视为进程崩了留下的死锁，
 * 接管重写。同进程重入用 depth 计数器放行，避免自己等自己。
 *
 * 任何异常都不让主路径停下：超时则 logAction 告警后降级无锁执行
 * （宁可极小概率丢一次并发更新，也不让聊天/面板卡死）；这里也是 A3 告警的接入点。
 */
import { openSync, writeSync, closeSync, readFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { DATA, logAction } from './store.mjs';

const LOCK = join(DATA, 'memories.json.lock');
const STALE_MS = 5000; // 超过 5 秒视为死锁，接管
const TIMEOUT_MS = 6000; // 略大于 STALE_MS：等得到死锁被接管，不至于先降级
const sleepBuf = new Int32Array(new SharedArrayBuffer(4));
const sleepSync = (ms) => { Atomics.wait(sleepBuf, 0, 0, ms); };

let depth = 0; // 同进程重入深度
let stats = { waits: 0, staleRecovered: 0, degraded: 0 };
export function lockStats() { return { ...stats }; }
export function resetLockStats() { stats = { waits: 0, staleRecovered: 0, degraded: 0 }; }

function isStale() {
  try {
    const txt = readFileSync(LOCK, 'utf-8').trim().split(/\s+/);
    const ts = Number(txt[1]);
    return !Number.isFinite(ts) || Date.now() - ts > STALE_MS;
  } catch { return true; } // 读不到（正好被别人删了）→ 当可抢
}

/** 包住整个 read-modify-write 事务。fn 同步执行，返回其返回值。 */
export function withLock(fn, { timeoutMs = TIMEOUT_MS } = {}) {
  // 同进程重入（如 add 内嵌别的写）：直接放行，但别在里层释放锁
  if (depth > 0) {
    depth++;
    try { return fn(); } finally { depth--; }
  }

  const deadline = Date.now() + timeoutMs;
  let got = false;
  while (!got) {
    try {
      const fd = openSync(LOCK, 'wx'); // O_EXCL：原子创建，成功即拿到锁
      try { writeSync(fd, `${process.pid} ${Date.now()}`); } finally { closeSync(fd); }
      got = true;
    } catch (e) {
      if (e.code !== 'EEXIST') throw e; // 真错误（权限、磁盘）照抛
      stats.waits++;
      if (isStale()) {
        try { unlinkSync(LOCK); } catch { /* 被别人先删了，下一轮 open 决定 */ }
        stats.staleRecovered++;
        continue;
      }
      if (Date.now() >= deadline) {
        stats.degraded++;
        try {
          logAction({ kind: 'error', source: 'auto', detail: '记忆写锁超时，降级无锁写入（可能丢一次并发更新）', ok: false });
        } catch { /* 日志不挡正事 */ }
        return fn(); // 降级：不让聊天/面板卡死
      }
      sleepSync(12);
    }
  }

  depth = 1;
  try {
    return fn();
  } finally {
    depth = 0;
    try { unlinkSync(LOCK); } catch { /* 已经没了，无所谓 */ }
  }
}
