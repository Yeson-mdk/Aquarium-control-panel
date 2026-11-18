/**
 * 失败告警通道（批次 A3）
 *
 * 关键任务挂了要主动让号主知道：夜间链某环节、洞察没跑成、QQ 断连、模型连续失败。
 * 统一走 notify.rawSend 发到号主 QQ（绕开自动养号开关，和赴约同一条直发通道）。
 *
 * 去抖：同一个 key 6 小时内只报一次，防止 tick 每 30 秒扫一遍把同一件事刷屏。
 * 全程 try/catch——告警本身失败绝不能反过来弄挂主流程。
 * 状态落 DATA/alert.json（人能读）；发信用动态 import 破 qq→alert→notify→qq 的环。
 */
import { readFileSync, writeFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { DATA, logAction, nowIso } from './store.mjs';

const STATE = join(DATA, 'alert.json');
const DEFAULT_WINDOW_MS = 6 * 60 * 60 * 1000;

function readState() {
  try { return JSON.parse(readFileSync(STATE, 'utf-8')); } catch { return { last: {} }; }
}
function writeState(s) {
  const tmp = STATE + '.tmp';
  writeFileSync(tmp, JSON.stringify(s, null, 2));
  renameSync(tmp, STATE);
}

/**
 * 报一次警。同 key 在 windowMs 内只发一次。
 * @returns {Promise<boolean>} 是否真的发出去了（被去抖拦下/发送失败都返回 false）
 */
export async function alert(key, text, { windowMs = DEFAULT_WINDOW_MS, now = Date.now, send, log = false } = {}) {
  const k = String(key || 'general');
  try {
    const st = readState();
    const last = Number((st.last || {})[k] || 0);
    if (last && now() - last < windowMs) return false; // 去抖：窗口内报过了
    st.last = { ...(st.last || {}), [k]: now() };
    // 留一份人能读的历史（不写 actions.jsonl，免得污染「最后一条日志」那类契约）；只留最近 30 条
    st.log = [...(st.log || []), { ts: nowIso(), key: k, text: String(text).slice(0, 160) }].slice(-30);
    writeState(st);
    if (log) {
      try { logAction({ kind: 'alert', source: 'auto', target: k, detail: String(text).slice(0, 160), ok: false }); } catch { /* 日志不挡 */ }
    }
    const msg = `⚠️ ${text}`;
    if (send) await send(msg); // 测试注入
    else {
      const notify = await import('./notify.mjs');
      await notify.rawSend(msg, 'alert');
    }
    return true;
  } catch (e) {
    // 告警失败绝不影响主流程；只留一条日志
    try { logAction({ kind: 'alert', source: 'auto', target: k, detail: '告警发送失败', ok: false, error: String(e?.message || e) }); } catch { /* 彻底静默 */ }
    return false;
  }
}

/** 清掉一个 key 的去抖（测试用，或号主处理完后想立刻再收到） */
export function clearAlert(key) {
  try {
    const st = readState();
    if (st.last) { delete st.last[String(key)]; writeState(st); }
  } catch { /* 无所谓 */ }
}
