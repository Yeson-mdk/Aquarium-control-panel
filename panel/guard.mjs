/**
 * 进程兜底（批次 A4）
 *
 * 单进程耦合，uncaughtException / unhandledRejection 过去会让整个面板+养号进程裸退，
 * 容器重启前 QQ 断线、夜间链全停。这里兜住：记日志 + 报号主 + 继续活（不 process.exit）。
 *
 * ⚠️ 兜底后进程状态可能已经不干净（比如半截的 SQLite 事务、卡住的锁），
 * 所以告警里明确写「建议重启容器」，不静默带伤跑。去抖交给 alert（同 key 6 小时一次）。
 *
 * 用 install() 幂等安装，可注入 deps 便于测试。
 */
import { logAction } from './store.mjs';

let installed = false;

export function installProcessGuard({
  onUncaught = process.on.bind(process),
  onRejection = process.on.bind(process),
  alert = null, // 传入 (key, text) => Promise；默认动态 import 破环
  now = () => Date.now(),
} = {}) {
  if (installed) return false;
  installed = true;

  const report = (kind, err) => {
    const msg = String(err?.stack || err?.message || err).slice(0, 300);
    try { logAction({ kind: 'error', source: 'auto', target: `guard:${kind}`, ok: false, error: msg, detail: `${kind} 已兜住，进程没退（建议重启容器）` }); } catch { /* 日志不挡 */ }
    const text = `${kind}：${String(err?.message || err).slice(0, 80)}——我已兜住没退出，但状态可能不干净，建议重启容器`;
    const doAlert = alert || ((k, t) => import('./alert.mjs').then((m) => m.alert(k, t)).catch(() => {}));
    try { Promise.resolve(doAlert(`guard:${kind}`, text)).catch(() => {}); } catch { /* 彻底静默 */ }
  };

  onUncaught('uncaughtException', (err) => report('未捕获异常', err));
  onRejection('unhandledRejection', (err) => report('未处理的 Promise 拒绝', err));
  return true;
}

/** 测试用：重置幂等标记 */
export function resetGuardForTest() { installed = false; }
