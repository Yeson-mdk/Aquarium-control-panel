/**
 * OneBot v11 客户端（连 QQ 小号）
 *
 * 小号登在 Docker 里的 QQ 上（panel/qq/napcat），NapCat 把它变成一个 OneBot v11 服务（正向 WebSocket，默认 ws://127.0.0.1:3001）。
 * 图片、语音都用 base64 发：容器看不到本机的文件路径。
 * 这里连上去：收私聊消息，发文字 / 图片 / 语音。断了就自己重连（3 秒起，最多隔 1 分钟）。
 *
 * 不依赖 DSH，也不依赖任何 npm 包：Node ≥ 22 自带 WebSocket。
 */
import { EventEmitter } from 'node:events';

export class OneBot extends EventEmitter {
  constructor({ url, token = '', WebSocketImpl = globalThis.WebSocket } = {}) {
    super();
    this.url = url;
    this.token = token;
    this.WS = WebSocketImpl;
    this.ws = null;
    this.pending = new Map(); // echo → { resolve, reject, timer }
    this.seq = 0;
    this.backoff = 3000;
    this.stopped = true;
    this.state = { connected: false, selfId: null, since: null, lastEventAt: null, error: '', startedAt: null };
  }

  start() {
    if (!this.stopped) return;
    if (!this.WS) throw new Error('这个 Node 没有内置 WebSocket（要 Node ≥ 22）');
    this.stopped = false;
    this.state.startedAt = Date.now();
    this.#connect();
  }

  stop() {
    this.stopped = true;
    clearTimeout(this.retry);
    try { this.ws?.close(); } catch { /* 已经关了 */ }
    this.ws = null;
    this.state.connected = false;
  }

  #connect() {
    if (this.stopped) return;
    const u = new URL(this.url);
    if (this.token) u.searchParams.set('access_token', this.token);
    let ws;
    try { ws = new this.WS(u.toString()); } catch (e) { this.#fail(e); return; }
    this.ws = ws;
    ws.onopen = () => {
      this.backoff = 3000;
      Object.assign(this.state, { connected: true, since: Date.now(), error: '' });
      this.emit('open');
      this.call('get_login_info').then((r) => { this.state.selfId = r?.user_id ?? null; this.emit('ready', r); }).catch(() => {});
    };
    ws.onmessage = (ev) => {
      let j;
      try { j = JSON.parse(typeof ev.data === 'string' ? ev.data : Buffer.from(ev.data).toString('utf-8')); } catch { return; }
      this.state.lastEventAt = Date.now();
      if (j.echo !== undefined && this.pending.has(j.echo)) {
        const p = this.pending.get(j.echo);
        this.pending.delete(j.echo);
        clearTimeout(p.timer);
        if (j.status === 'failed' || (j.retcode && j.retcode !== 0)) p.reject(new Error(j.message || j.wording || `OneBot 报错 ${j.retcode}`));
        else p.resolve(j.data);
        return;
      }
      if (j.self_id) this.state.selfId = j.self_id;
      if (j.post_type === 'message') this.emit('message', j);
      else if (j.post_type === 'meta_event') this.emit('meta', j);
      else if (j.post_type) this.emit('event', j);
    };
    ws.onerror = (ev) => { this.state.error = ev?.message || ev?.error?.message || '连接出错'; };
    ws.onclose = () => {
      const was = this.state.connected;
      this.state.connected = false;
      for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(new Error('连接断了')); }
      this.pending.clear();
      if (was) this.emit('close');
      this.#schedule();
    };
  }

  #fail(e) {
    this.state.error = e.message;
    this.#schedule();
  }

  #schedule() {
    if (this.stopped) return;
    clearTimeout(this.retry);
    this.retry = setTimeout(() => this.#connect(), this.backoff);
    this.backoff = Math.min(this.backoff * 2, 60_000);
  }

  /** 调一个 OneBot 动作，等它回话 */
  call(action, params = {}, timeoutMs = 15000) {
    if (!this.state.connected || !this.ws) return Promise.reject(new Error('QQ 小号没连上'));
    const echo = `yy${++this.seq}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(echo); reject(new Error(`${action} 超时`)); }, timeoutMs);
      this.pending.set(echo, { resolve, reject, timer });
      this.ws.send(JSON.stringify({ action, params, echo }));
    });
  }

  sendPrivate(userId, message, timeoutMs) {
    return this.call('send_private_msg', { user_id: Number(userId), message }, timeoutMs);
  }
  sendGroup(groupId, message, timeoutMs) {
    return this.call('send_group_msg', { group_id: Number(groupId), message }, timeoutMs);
  }
}

/** 消息里的图片段（图片都算——QQ 给梗图打的 summary 标签不靠谱，一律下载让她自己看；商城大表情 mface 是另一段，不算） */
export function imageSegments(ev) {
  if (!Array.isArray(ev.message)) {
    return [...String(ev.message || '').matchAll(/\[CQ:image,([^\]]*)\]/g)].map((m) => {
      const kv = Object.fromEntries(m[1].split(',').map((x) => [x.slice(0, x.indexOf('=')), x.slice(x.indexOf('=') + 1).replace(/&amp;/g, '&').replace(/&#44;/g, ',')]));
      return { url: kv.url, file: kv.file };
    });
  }
  return ev.message.filter((s) => s.type === 'image').map((s) => ({ url: s.data?.url, file: s.data?.file }));
}

// ─── 消息段 ────────────────────────────────────────────────
export const seg = {
  text: (text) => ({ type: 'text', data: { text } }),
  image: (b64) => ({ type: 'image', data: { file: `base64://${b64}` } }),
  record: (b64) => ({ type: 'record', data: { file: `base64://${b64}` } }),
  at: (qq) => ({ type: 'at', data: { qq: String(qq) } }),
};

/** 群消息里有没有 @ 到她（消息段数组和 CQ 码字符串都认） */
export function atMe(ev, selfId) {
  const me = String(selfId ?? '');
  if (!me) return false;
  const m = ev.message;
  if (Array.isArray(m)) return m.some((s) => s.type === 'at' && String(s.data?.qq) === me);
  if (typeof m === 'string') return m.split('[CQ:at,').slice(1).some((p) => p.split(']')[0].includes('qq=' + me));
  return false;
}

/** reply 段的消息 id（数组/CQ 码都认）。NapCat 的 reply 段只有 id，没有 qq/name，得拿它反查原消息。 */
export function replyRefId(ev) {
  const m = ev?.message;
  if (Array.isArray(m)) {
    const r = m.find((s) => s?.type === 'reply');
    const id = r?.data?.id ?? r?.data?.seq;
    return id == null ? '' : String(id);
  }
  if (typeof m === 'string') return (m.match(/\[CQ:reply,[^\]]*\bid=(\d+)/) || [])[1] || '';
  return '';
}

/**
 * 反查被回复者名字：reply 段只有消息 id，调 get_msg 拿原消息 sender。
 * 段里若已带 qq/name（某些 NapCat 版本）就直接跳过——readMessage 自己能标。
 * 查不到返回空串，上层照旧降级标「（引用了一条消息）」，不挡收消息。
 */
export async function resolveReplyName(bot, ev, nameOf = (qq) => String(qq)) {
  const m = ev?.message;
  if (Array.isArray(m)) {
    const r = m.find((s) => s?.type === 'reply');
    if (r && (r.data?.qq || r.data?.user_id || r.data?.name)) return ''; // 段里已有名字，不用查
  }
  const id = replyRefId(ev);
  if (!id || !bot?.state?.connected) return '';
  try {
    const mid = Number(id);
    const r = await bot.call('get_msg', { message_id: Number.isFinite(mid) ? mid : id }, 3000);
    const qq = r?.sender?.user_id ?? r?.user_id;
    // 群名片 > 昵称 > 好友档案 > 裸号（跟日志里别人的 name 口径一致，认得出是谁）
    const name = r?.sender?.card || r?.sender?.nickname || (qq ? nameOf(qq) : '') || '';
    return String(name).slice(0, 20);
  } catch {
    return '';
  }
}

/**
 * 引用的那条消息是回谁的 → 正文前缀。QQ「回复」功能在消息段里带 reply（NapCat 标准只带 id，
 * 被回复者名字由 resolveReplyName 反查后从 resolvedName 传进来；某些版本段里直接带 qq/name 也能认）。
 * CQ 码格式一般只带 id。不说出来，日志和上下文里就只剩裸正文（「你又懂了」），她会以为「你」在叫她。
 * 一条消息里 reply 和 @ 常同时出现（回复时自动 @），只标一次、reply 优先。@ 她自己那段由 atMe 单独判，跳过。
 */
function replyRef(ev, selfId = '', nameOf = (qq) => String(qq), resolvedName = '') {
  const me = String(selfId || '');
  const m = ev?.message;
  const label = (qq, fallback = '') => {
    const q = String(qq || '');
    if (q && q === me) return '你';
    if (q) { try { return String(nameOf(q) || q).slice(0, 20); } catch { return q.slice(0, 20); } }
    return String(fallback || '').slice(0, 20);
  };
  if (Array.isArray(m)) {
    const r = m.find((s) => s?.type === 'reply');
    if (r) {
      const d = r.data || {};
      const who = resolvedName || label(d.qq ?? d.user_id ?? d.user_id_str, d.name);
      return who ? `（回复${who}）` : '（引用了一条消息）';
    }
    const a = m.find((s) => s?.type === 'at' && String(s.data?.qq || '') !== me && s.data?.qq);
    if (a) return `（@${label(a.data.qq)}）`;
    return '';
  }
  if (typeof m === 'string') {
    if (/\[CQ:reply,/.test(m)) {
      const q = (m.match(/\[CQ:reply,[^\]]*qq=(\d+)/) || [])[1] || (m.match(/\[CQ:reply,[^\]]*user_id=(\d+)/) || [])[1];
      const who = resolvedName || label(q);
      return who ? `（回复${who}）` : '（引用了一条消息）';
    }
    const a = [...m.matchAll(/\[CQ:at,qq=(\d+)/g)].map((x) => x[1]).find((q) => q !== me);
    if (a) return `（@${label(a)}）`;
  }
  return '';
}

/**
 * 收到的消息 → 一句给她看的文字。她看不了图、听不了语音，就如实写成 [图片] [语音]，别让她装作看见了。
 * message 可能是消息段数组，也可能是 CQ 码字符串（看 NapCat 的消息格式设置）。
 * selfId / nameOf 只在群消息里传（私聊不需要）：用来把「回复了谁」标在正文前面，报名字好认。
 * resolvedName 是入口反查到的被回复者名字（NapCat reply 段只有 id），有就用它，没就降级标「引用了一条消息」。
 */
export function readMessage(ev, selfId = '', nameOf = (qq) => String(qq), resolvedName = '') {
  const ref = replyRef(ev, selfId, nameOf, resolvedName);
  const m = ev.message;
  if (typeof m === 'string') {
    return ref + m.replace(/\[CQ:image[^\]]*\]/g, '[图片]').replace(/\[CQ:record[^\]]*\]/g, '[语音]').replace(/\[CQ:face[^\]]*\]/g, '[表情]')
      .replace(/\[CQ:[^\]]*\]/g, '').replace(/&#91;/g, '[').replace(/&#93;/g, ']').replace(/&amp;/g, '&').trim();
  }
  if (!Array.isArray(m)) return ref + String(ev.raw_message || '').trim();
  return ref + m.map((s) => {
    if (s.type === 'text') return s.data?.text || '';
    if (s.type === 'image') return '[图片]'; // QQ 给梗图打的 summary 标签不靠谱，统一当图片走看图，让她自己认
    if (s.type === 'mface') return `[表情包${s.data?.summary || ''}]`;
    if (s.type === 'record') return '[语音]';
    if (s.type === 'video') return '[视频]';
    if (s.type === 'face') return '[表情]';
    if (s.type === 'file') return `[文件 ${s.data?.name || ''}]`;
    if (s.type === 'json') return '[卡片]';
    return '';
  }).join('').trim();
}
