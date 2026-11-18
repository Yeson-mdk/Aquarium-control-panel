/* 蓝色大肥鱼 · 养鱼面板 —— 零依赖单页应用 */
'use strict';

// ─── 基础工具 ──────────────────────────────────────────────
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const img = (u, size) => {
  if (!u) return '';
  let s = String(u).replace(/^http:/, 'https:');
  if (s.startsWith('//')) s = 'https:' + s;
  return size && /hdslb\.com/.test(s) && !s.includes('@') ? `${s}@${size}.webp` : s;
};
const fmtNum = (n) => {
  n = Number(n || 0);
  return n >= 1e8 ? (n / 1e8).toFixed(1) + '亿' : n >= 1e4 ? (n / 1e4).toFixed(1) + '万' : String(n);
};
const fmtSec = (s) => {
  s = Math.round(Number(s) || 0);
  if (s < 60) return s + '秒';
  if (s < 3600) return Math.floor(s / 60) + '分' + (s % 60 ? String(s % 60).padStart(2, '0') + '秒' : '');
  return Math.floor(s / 3600) + '小时' + Math.round((s % 3600) / 60) + '分';
};
const fmtDur = (s) => {
  if (typeof s === 'string' && s.includes(':')) return s;
  s = Number(s) || 0;
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};
const pad = (n) => String(n).padStart(2, '0');
const localDate = (d = new Date()) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const hm = (t) => { const d = new Date(t); return `${pad(d.getHours())}:${pad(d.getMinutes())}`; };
const ago = (t) => {
  const ms = typeof t === 'number' && t < 1e12 ? t * 1000 : new Date(t).getTime();
  const s = (Date.now() - ms) / 1000;
  if (s < 60) return '刚刚';
  if (s < 3600) return Math.floor(s / 60) + ' 分钟前';
  if (s < 86400) return Math.floor(s / 3600) + ' 小时前';
  if (s < 86400 * 7) return Math.floor(s / 86400) + ' 天前';
  const d = new Date(ms);
  return `${d.getMonth() + 1}月${d.getDate()}日`;
};
const dayLabel = (d) => {
  const today = localDate();
  const y = localDate(new Date(Date.now() - 86400000));
  if (d === today) return '今天';
  if (d === y) return '昨天';
  const [, m, dd] = d.split('-');
  return `${Number(m)}月${Number(dd)}日`;
};

async function api(path, body) {
  const opt = body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
  const r = await fetch(path, opt);
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || 'HTTP ' + r.status);
  return j;
}

function toast(msg, kind = 'ok') {
  const el = $('#toast');
  el.textContent = msg;
  el.className = 'toast show ' + kind;
  clearTimeout(el._t);
  el._t = setTimeout(() => (el.className = 'toast'), 3200);
}

function confirmBox(title, text, yes = '确定') {
  return new Promise((resolve) => {
    const m = $('#modal');
    $('#modalTitle').textContent = title;
    $('#modalText').textContent = text;
    $('#modalYes').textContent = yes;
    m.classList.add('show');
    const done = (v) => { m.classList.remove('show'); $('#modalYes').onclick = $('#modalNo').onclick = null; resolve(v); };
    $('#modalYes').onclick = () => done(true);
    $('#modalNo').onclick = () => done(false);
  });
}

/** 按钮执行期间禁用，出错就 toast */
async function busy(btn, fn) {
  if (btn) btn.disabled = true;
  try { return await fn(); } catch (e) { toast(e.message, 'err'); } finally { if (btn) { btn.disabled = false; } }
}

// ─── 图标 ──────────────────────────────────────────────────
const I = {
  home: '<path d="M3 11l9-7 9 7v9a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z"/>',
  list: '<path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01"/>',
  bolt: '<path d="M13 2L4 14h7l-1 8 9-12h-7z"/>',
  play: '<rect x="3" y="5" width="18" height="14" rx="3"/><path d="M10 9l5 3-5 3z"/>',
  chat: '<path d="M21 12a8 8 0 0 1-11.6 7.1L4 20l1-4.6A8 8 0 1 1 21 12z"/>',
  check: '<path d="M9 11l3 3 8-8"/><path d="M20 12v7a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h9"/>',
  book: '<path d="M4 4h10a4 4 0 0 1 4 4v12H8a4 4 0 0 1-4-4z"/><path d="M4 16a4 4 0 0 1 4-4h10"/>',
  layers: '<path d="M12 3l9 5-9 5-9-5z"/><path d="M3 13l9 5 9-5"/>',
  scan: '<circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3"/><path d="M11 8v6M8 11h6"/>',
  sliders: '<path d="M4 6h16M4 12h16M4 18h16"/><circle cx="9" cy="6" r="2"/><circle cx="15" cy="12" r="2"/><circle cx="7" cy="18" r="2"/>',
  shield: '<path d="M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z"/><path d="M9 12l2 2 4-4"/>',
  image: '<rect x="3" y="5" width="18" height="14" rx="3"/><circle cx="9" cy="10" r="1.6"/><path d="M5 18l5-5 3 3 3-3 3 3"/>',
};
const icon = (k) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${I[k]}</svg>`;

const PAGES = [
  { id: 'overview', name: '总览', icon: 'home' },
  { id: 'activity', name: '活动记录', icon: 'list' },
  { id: 'autopilot', name: '自动养号', icon: 'bolt' },
  { id: 'explore', name: '刷视频', icon: 'play' },
  { id: 'inbox', name: '消息', icon: 'chat', badge: 'inbox' },
  { id: 'review', name: '待审 · 派活', icon: 'check', badge: 'review' },
  { id: 'memory', name: '记忆', icon: 'layers' },
  { id: 'stickers', name: '表情包', icon: 'image' },
  { id: 'tuning', name: '手感调参', icon: 'sliders' },
  { id: 'gate', name: '插嘴裁决', icon: 'shield' },
  { id: 'botscore', name: '谁像bot', icon: 'scan' },
  { id: 'diary', name: '养鱼日记', icon: 'book' },
];

const KIND = {
  watch: ['📺', '看视频'], view: ['👀', '打开视频'], like: ['❤️', '点赞'], share: ['↗️', '分享'], coin: ['🪙', '投币'],
  comment: ['💬', '评论'], reply_comment: ['↩️', '回复评论'], dm_send: ['✉️', '私信'], search: ['🔍', '搜索'],
  feed: ['🏠', '刷推荐'], hot: ['🔥', '看热门'], task: ['📋', '派任务'], task_done: ['✅', '完成任务'],
  session_start: ['🐟', '开始刷'], session_end: ['🏁', '刷完了'], draft: ['📝', '起草'], diary: ['📔', '发日记'],
  cooldown: ['🧊', '风控冷却'], pause: ['⏸', '号主叫停'], health: ['🩺', 'QQ 接入'], qq: ['💬', 'QQ 小号'], error: ['⚠️', '出错'], wake: ['☀️', '醒来'], autopilot: ['⚙️', '设置'],
  login: ['🔑', '登录'], notify: ['📮', 'QQ 提醒'], favorite: ['⭐', '收藏'], vip_new: ['🌟', '特别关注更新'], dyn_like: ['👍', '动态点赞'], vip: ['🌟', '特别关注'], follow: ['➕', '关注'],
  mind: ['💭', '心里想'], dig: ['🕳️', '顺藤摸瓜'], gate: ['🎯', '插嘴裁决'],
  join: ['🗨️', '评论区搭话'], social: ['📬', '看回复'], reply_like: ['👍', '评论点赞'],
  appointment: ['📅', '约定'], appointment_set: ['⏰', '约定'],
};
const SOURCE = { auto: ['自动', 'blue'], panel: ['面板', 'violet'], bot: ['QQ里的她', 'pink'] };

// ─── 全局状态 ──────────────────────────────────────────────
const S = { page: 'overview', ov: null, badges: { inbox: 0, review: 0 } };

// ─── 导航 ──────────────────────────────────────────────────
function renderNav() {
  const html = PAGES.map((p) => {
    const b = p.badge && S.badges[p.badge] ? `<span class="badge">${S.badges[p.badge]}</span>` : '';
    return `<button class="nav ${S.page === p.id ? 'on' : ''}" data-go="${p.id}">${icon(p.icon)}<span>${p.name}</span>${b}</button>`;
  }).join('');
  $('#nav').innerHTML = html;
  $('#mnav').innerHTML = html;
}
document.addEventListener('click', (e) => {
  const go = e.target.closest('[data-go]');
  if (go) { location.hash = '#/' + go.dataset.go; }
  const v = e.target.closest('[data-bvid]');
  if (v && !e.target.closest('button,a,textarea,input')) openVideo(v.dataset.bvid);
});
window.addEventListener('hashchange', route);
function route() {
  const id = (location.hash.match(/^#\/(\w+)/) || [])[1] || 'overview';
  S.page = PAGES.some((p) => p.id === id) ? id : 'overview';
  closeDrawer();
  renderNav();
  const main = $('#main');
  main.innerHTML = '';
  main.scrollTop = 0;
  window.scrollTo(0, 0);
  ({ overview: pageOverview, activity: pageActivity, autopilot: pageAutopilot, explore: pageExplore, inbox: pageInbox, review: pageReview, memory: pageMemory, stickers: pageStickers, tuning: pageTuning, gate: pageGate, botscore: pageBotscore, diary: pageDiary })[S.page](main);
}

function head(title, desc, right = '') {
  return `<div class="page-head"><div><h1>${title}</h1>${desc ? `<p>${desc}</p>` : ''}</div><div class="row wrap">${right}</div></div>`;
}

// ─── 总览 ──────────────────────────────────────────────────
const LV_EXP = [0, 1, 200, 1500, 4500, 10800, 28800];

async function loadOverview() {
  S.ov = await api('/api/overview');
  const u = S.ov.unread || {};
  S.badges.inbox = (u.reply || 0) + (u.at || 0) + (u.dm || 0);
  S.badges.review = S.ov.reviewPending || 0;
  const ap = S.ov.autopilot;
  renderLoginBanner(S.ov.account);
  renderHealthBanner(S.ov.health);
  $('#footStatus').innerHTML = S.ov.account && !S.ov.account.loggedIn ? '<a href="#" id="footLogin" style="color:var(--red)">⚠️ 掉登录了 · 扫码</a>' : ap.live.running
    ? '<span class="pulse"></span> 她正在刷B站'
    : ap.config.enabled ? '自动养号 · 开' : '自动养号 · 关';
  renderNav();
  return S.ov;
}

function dailyExpRate(ap) {
  const c = ap.config;
  // 登录 5 + 观看 5 + 分享 5 + 投币（新号每天只送 1 枚币，最多 10）
  return 10 + (c.share.daily ? 5 : 0) + (c.coin.enabled && !ap.coinLock ? 10 * Math.min(1, c.coin.dailyMax) : 0);
}

function etaText(acct, ap) {
  if (acct.level >= 6) return '已经满级啦';
  const need = LV_EXP[6] - (acct.exp || 0);
  const rate = dailyExpRate(ap);
  const days = Math.ceil(need / rate);
  const d = new Date(Date.now() + days * 86400000);
  const next = LV_EXP[(acct.level || 0) + 1];
  const daysNext = next ? Math.ceil((next - acct.exp) / rate) : 0;
  return `按每天 ${rate} 经验：Lv${acct.level + 1} 还要约 ${daysNext} 天，Lv6 约 ${days} 天（${d.getFullYear()}年${d.getMonth() + 1}月）`;
}

async function pageOverview(main) {
  main.innerHTML = head('总览', '她今天在B站过得怎么样') + '<div class="empty"><span class="fish">🐟</span>加载中…</div>';
  let ov;
  try { ov = await loadOverview(); } catch (e) { main.innerHTML = head('总览') + `<div class="card err">${esc(e.message)}</div>`; return; }
  if (S.page !== 'overview') return;
  const a = ov.account || {};
  const x = ov.exp || {};
  const ap = ov.autopilot;
  const t = ov.today || {};
  const todayS = ov.series[ov.series.length - 1] || {};
  const pct = a.expNext && a.expNext > 0 ? Math.min(100, ((a.exp - a.expMin) / (a.expNext - a.expMin)) * 100) : 100;

  const acctCard = a.error || !a.loggedIn
    ? `<div class="card span-2"><div class="hero"><div class="avatar" style="display:grid;place-items:center;font-size:32px">🔑</div>
        <div><h2>B站 掉登录了</h2>
        <div class="small muted">${a.error ? '账号连不上：' + esc(a.error) : '改密码、改密保、异地登录之后，B站 会让旧的登录失效。'}自动养号会停着，扫个码就好。</div>
        <div class="row" style="margin-top:12px"><button class="btn primary" id="ovLogin">📱 扫码登录</button></div></div></div></div>`
    : `<div class="card span-2">
        <div class="hero">
          <img class="avatar" src="${esc(img(a.face, '144w_144h'))}" alt="" onerror="this.style.visibility='hidden'">
          <div style="min-width:0">
            <h2>${esc(a.uname)} <span class="lv l${a.level}">LV${a.level}</span>${a.vip ? '<span class="chip pink">大会员</span>' : ''}</h2>
            <div class="small muted">UID ${esc(a.uid)} · <a href="https://space.bilibili.com/${esc(a.uid)}" target="_blank" rel="noopener">B站主页 ↗</a></div>
            <div style="margin-top:10px" class="row"><div class="bar" style="flex:1"><i style="width:${pct}%"></i></div><span class="small num">${a.exp} / ${a.expNext > 0 ? a.expNext : '满级'}</span></div>
            <div class="hint">${esc(etaText(a, ap))}</div>
            <div class="kvs">
              <span>硬币 <b class="num">${a.coins}</b></span>
              <span title="myinfo 里的 moral 字段。正式会员一般就是 70，不是满分 100 的那种信用分">节操值 <b class="num">${a.moral ?? '?'}</b></span>
              <span>手机 <b>${a.mobileVerified ? '已绑' : '未绑'}</b></span>
              <span>邮箱 <b>${a.emailVerified ? '已绑' : '未绑'}</b></span>
            </div>
          </div>
        </div>
      </div>`;

  const chk = (ok, name, sub, cls = '') => `<div class="check ${ok ? 'ok' : ''} ${cls}"><div class="t">${name}</div><div class="s">${ok ? '✓ ' : ''}${sub}</div></div>`;
  const coinCls = ap.coinLock ? 'lock' : '';
  const expCard = `<div class="card span-2">
      <div class="card-h"><h2>今日经验<span class="sub">每天 0 点重置</span></h2><span class="chip">${(x.login ? 5 : 0) + (x.watch ? 5 : 0) + (x.share ? 5 : 0) + (x.coinsExp || 0)} 经验</span></div>
      <div class="checks">
        ${chk(x.login, '登录 +5', x.login ? '已领' : '未领')}
        ${chk(x.watch, '看视频 +5', x.watch ? '已领' : '等她去看')}
        ${chk(x.share, '分享 +5', x.share ? '已领' : '自动养号会顺手分享')}
        ${chk(!ap.coinLock && (x.coinsExp || 0) >= 10, '投币 +10/枚', `${x.coinsExp || 0} / 50${ap.coinLock ? ' · 🔒 已上锁' : ''}`, coinCls)}
      </div>
      ${oneTimeTips(x)}
    </div>`;

  const stat = (k, v, unit, d) => `<div class="card stat"><div class="k">${k}</div><div class="v num">${v}<small>${unit}</small></div><div class="d">${d}</div></div>`;
  const stats = `<div class="grid g-4">
      ${stat('📺 今天看了', t.watch || 0, '个视频', `共 ${fmtSec(todayS.seconds)}`)}
      ${stat('❤️ 点赞', t.like || 0, '', `上限 ${ap.config.like.dailyMax}/天`)}
      ${stat('💬 评论', (t.comment || 0) + (t.reply_comment || 0) + (t.join || 0), '', `${ov.reviewPending ? ov.reviewPending + ' 条待审' : '上限 ' + ap.config.comment.dailyMax + '/天'}`)}
      ${stat('🔔 未读', ov.unread ? (ov.unread.reply + ov.unread.at + ov.unread.dm) : '–', '', ov.unread ? `回复 ${ov.unread.reply} · @ ${ov.unread.at} · 私信 ${ov.unread.dm}` : '查不到')}
    </div>`;

  main.innerHTML = head('总览', '她今天在B站过得怎么样',
      `<button class="btn" id="ovRefresh">刷新</button>`) +
    `<div class="grid g-4">${acctCard}${expCard}</div>
     <div style="height:16px"></div>${stats}<div style="height:16px"></div>
     <div class="grid g-3">
       <div class="span-2 grid">
         <div class="card" id="apCard"></div>
         <div class="card" id="ovDay"></div>
         <div class="card"><div class="card-h"><h2>近 14 天看视频数</h2><span class="small muted">鼠标移上去看当天明细</span></div><div id="ovChart" class="chart"></div></div>
       </div>
       <div class="grid">
         <div class="card" id="ovWish" style="display:none"></div>
         <div class="card"><div class="card-h"><h2>最近动态</h2><a href="#/activity" class="small">全部 →</a></div><div id="ovRecent"></div></div>
       </div>
     </div>`;
  renderWishes($('#ovWish'));

  $('#ovRefresh').onclick = () => route();
  const ol = $('#ovLogin');
  if (ol) ol.onclick = () => openLogin();
  renderApCard($('#apCard'), ap);
  renderDay($('#ovDay'));
  renderChart($('#ovChart'), ov.series);
  const r = await api('/api/actions?limit=6').catch(() => ({ list: [] }));
  $('#ovRecent').innerHTML = r.list.length ? `<ul class="tl compact">${r.list.map((x) => tlItem(x, true)).join('')}</ul>` : '<div class="empty">还没有动作</div>';
}

// 她的一天：心情、着迷的东西、今天心里想过的、最近的她
async function renderDay(el) {
  let d;
  try { d = await api('/api/mind'); } catch (e) { el.innerHTML = `<div class="err">${esc(e.message)}</div>`; return; }
  const m = d.mind;
  if (!d.llm || !d.enabled) {
    el.innerHTML = `<div class="card-h"><h2>🐟 她的一天</h2></div><div class="empty">${d.llm ? '「内心」关着（autopilot.json 里 mind.enabled）' : '配了模型（自动养号 → 模型设置）她才会有自己的心思'}</div>`;
    return;
  }
  const state = [['心情', m.mood], ['最近着迷', m.obsession], ['还在想', m.thought], ['小目标', m.goal]]
    .filter(([, v]) => v).map(([k, v]) => `<div><span class="k">${k}</span>${esc(v)}</div>`).join('');
  const grown = m.interests.length ? `<div class="tags" style="margin-top:8px">${m.interests.map((x) => `<span class="chip violet" title="${esc(x.at)} 迷上的">${esc(x.kw)}</span>`).join('')}</div>` : '';
  const lines = [...d.thoughts.map((t) => ({ ts: t.ts, html: `<b>《${esc(t.title)}》</b>${t.dug ? ' <span class="chip">顺藤摸瓜</span>' : ''}${t.heard ? `<div class="small muted">🎧 ${esc(t.heard)}${t.up ? ` · UP：${esc(t.up)}` : ''}</div>` : ''}<div class="thought">💭 ${esc(t.thought)} <span class="muted">${'♥'.repeat(t.score || 0)}</span></div>`, bvid: t.bvid })),
    ...d.moments.filter((x) => x.kind !== 'dig').map((x) => ({ ts: x.ts, html: esc(x.detail) }))].sort((a, b) => (a.ts < b.ts ? -1 : 1));
  const last = m.selfHistory[m.selfHistory.length - 1];
  el.innerHTML = `<div class="card-h"><h2>🐟 她的一天</h2><span class="small muted">${m.updatedAt ? '更新于 ' + hm(m.updatedAt) : ''}</span></div>
    ${d.sky ? `<div class="small muted" style="margin-bottom:8px">🪟 ${esc(d.sky)}</div>` : ''}
    <div class="mind-state">${state || '<span class="muted">还没刷过，心里空空的</span>'}</div>${grown}
    ${lines.length ? `<ul class="tl compact" style="margin-top:10px">${lines.map((l) => `<li ${l.bvid ? `data-bvid="${esc(l.bvid)}" style="cursor:pointer"` : ''}><div class="time num">${hm(l.ts)}</div><div class="ico">•</div><div class="body">${l.html}</div></li>`).join('')}</ul>` : '<div class="empty">今天还没有心里话</div>'}
    ${m.self ? `<details style="margin-top:10px"><summary class="small">最近的她${last?.changed ? ` · ${esc(last.date)}：${esc(last.changed)}` : ''}</summary><p class="small">${esc(m.self)}</p>
      ${m.selfHistory.length > 1 ? `<div class="small muted">${m.selfHistory.slice(-8, -1).reverse().map((h) => `${esc(h.date)}${h.changed ? '：' + esc(h.changed) : ''}`).join('<br>')}</div>` : ''}</details>` : ''}
    ${d.lingo?.length ? `<div class="small" style="margin-top:8px"><span class="k">学会的说法</span> ${d.lingo.map((w) => `<span class="chip" title="${esc(w.meaning)}${w.example ? '\n例：' + esc(w.example) : ''}\n${esc(w.at)} 学会，碰到过 ${w.n} 次">${esc(w.phrase)}</span>`).join(' ')}</div>` : ''}
    <a href="#/memory" style="display:flex;align-items:center;gap:8px;margin-top:10px;padding:8px 12px;border:1px solid var(--line);border-radius:10px;background:var(--card2);text-decoration:none;color:inherit">
      <span>🧠 她的记忆</span><span class="muted">在记 ${(d.memory?.total || 0) - (d.memory?.gistCount || 0)} · 印象 ${d.memory?.gistCount || 0} · 淡忘档案 ${d.memory?.archive?.rows || 0}</span><span class="spacer"></span><span class="muted">去记忆页 →</span></a>`;
}

// 记忆分三层展示：印象（她概括的）/ 在记（还记得的零碎）/ 淡忘档案（忘了但搜得回来）
const MEM_KIND = { watch: '📺', session: '🐟', social: '💬', self: '🌙', gist: '🧩', chat: '🗨️', fact: '👤' };
// 计划反馈（阶段三）现在靠开头认；B段会给新记忆加 tag 字段，两条路都认
const memIcon = (e) => (e.tag === 'plan' || /^今天的计划里/.test(e.text || '') ? '📋' : MEM_KIND[e.kind] || '•');
const memRow = (e) => `<li><div style="flex:1;min-width:0" class="small">${memIcon(e)} ${esc(e.text)}
    <div class="muted">${ago(e.ts)} · 重要 ${e.imp}/5${e.from ? ` · ${e.from} 条合成的` : ''}${e.n ? ` · 想起过 ${e.n} 次` : ''}${e.edited ? ' · 你改过' : ''}</div></div>
    <button class="btn sm ghost" data-memedit="${esc(e.id)}" title="改这条">✎</button>
    <button class="btn sm ghost" data-memdel="${esc(e.id)}" title="删掉这条">✕</button></li>`;
// 「她自己的」分四个子标签：日子（经历，按天分组）/ 想法（洞察与内心）/ 印象·日结（压缩层）/ 档案（淡忘原文搜索）
function renderMemories(box, mem) {
  if (!box) return;
  const gists = mem?.gists || [];
  const impr = gists.filter((e) => e.kind !== 'chat');   // 她自己概括的印象
  const chats = gists.filter((e) => e.kind === 'chat');  // 每晚的对话日结（号主/群/好友）
  const keep = (mem?.recent || []).filter((e) => e.kind !== 'gist' && e.kind !== 'chat');
  const ideas = mem?.insights || keep.filter((e) => e.kind === 'self'); // 洞察 + 反思结论（活着的；B段起日间复盘/发呆也进这）
  const days = keep.filter((e) => e.kind !== 'self');    // 日子：发生过的经历（B站、计划执行、别的零碎）
  const chatShow = chats.slice(0, 12); // 日结条数多，只列最近的，老的几天后会合成印象
  const list = [...gists, ...keep]; // 改 / 删按钮按 id 找条目用
  const pend = mem?.insightPending || []; // 审核池（mind.insightReview 开着才有）：放行才进流
  const retired = mem?.retiredInsights || []; // 被推翻的洞察：折叠留着，错了还能翻回来
  S.memSub = S.memSub || 'days';

  // 日子按天分组：今天/昨天摊开，更早的按天折叠（条目本身已是新→旧）
  const groups = [];
  for (const e of days) {
    const d = new Date(e.ts);
    const k = `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
    if (!groups.length || groups.at(-1).k !== k) groups.push({ k, ts: e.ts, rows: [] });
    groups.at(-1).rows.push(e);
  }
  const dayTitle = (ts) => {
    const d = new Date(ts), t = new Date(), y = new Date(Date.now() - 86400_000);
    const same = (a, b) => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
    return same(d, t) ? '今天' : same(d, y) ? '昨天' : `${d.getMonth() + 1}月${d.getDate()}日`;
  };
  const daysHtml = groups.length ? groups.map((g) => {
    const title = dayTitle(g.ts);
    const rows = `<ul class="vip-list">${g.rows.map(memRow).join('')}</ul>`;
    return title === '今天' || title === '昨天'
      ? `<div class="small" style="margin:10px 0 4px"><span class="k">${title}</span> <span class="muted">${g.rows.length} 条</span></div>${rows}`
      : `<details style="margin-top:6px"><summary class="small muted">${title} · ${g.rows.length} 条</summary>${rows}</details>`;
  }).join('') : '<div class="empty">还没有她的经历，等她刷起来、计划跑起来就有了</div>';

  const ideasHtml = `${pend.length ? `<div class="small" style="margin:10px 0 4px"><span class="k">💭 待审洞察</span> <span class="muted">审核池开着：你放行才进她的记忆流</span></div>
    <ul class="vip-list">${pend.map((p, i) => `<li><div style="flex:1;min-width:0" class="small">💭 ${esc(p.text)}<div class="muted">${esc(p.at || '')}</div></div>
      <button class="btn sm" data-insok="${i}">放行</button><button class="btn sm ghost" data-insno="${i}">丢掉</button></li>`).join('')}</ul>` : ''}
    ${ideas.length ? `<div class="small" style="margin:10px 0 4px"><span class="k">洞察与想法</span> <span class="muted">她自己归纳的结论和内心活动——是猜想不是观测；recall 打分自带折扣，不会盖过真事</span></div>
    <ul class="vip-list">${ideas.map(memRow).join('')}</ul>` : '<div class="empty">还没有想法，每晚反思之后会有</div>'}
    ${retired.length ? `<details style="margin-top:8px"><summary class="small muted">被推翻的洞察 ${retired.length} 条（折叠留着，错了还能翻回来）</summary><ul class="vip-list">${retired.map((e) => `<li><div style="flex:1;min-width:0" class="small muted">💭 ${esc(e.text)}<div class="muted">${ago(e.ts)}</div></div></li>`).join('')}</ul></details>` : ''}`;

  const zone = (t, d, rows) => rows.length ? `<div class="small" style="margin:10px 0 4px"><span class="k">${t}</span> <span class="muted">${d}</span></div>
    <ul class="vip-list">${rows.map(memRow).join('')}</ul>` : '';
  const gistHtml = `${zone('印象', '她自己把零碎事概括成的', impr)}
    ${zone('对话日结', `号主 / 群 / 好友私聊每晚结的${chats.length > chatShow.length ? `，只列最近 ${chatShow.length} 条（共 ${chats.length} 条，更早的几天后会合成印象）` : '，几天后会合成印象'}`, chatShow)}
    ${!gists.length ? '<div class="empty">还没有印象，零碎记够几天会自己合成</div>' : ''}
    <div class="row" style="margin-top:8px"><button class="btn sm ghost" id="memTidy">现在整理一下</button><span class="small muted">每晚睡前反思完会自己整理：零碎的合成印象，太久没想起的忘掉</span></div>`;

  const archHtml = `<div class="row" style="margin:8px 0"><span class="chip">在记 ${(mem.total || 0) - (mem.gistCount || 0)} 条</span><span class="chip">印象 ${mem.gistCount || 0} 条</span><span class="chip">淡忘档案 ${mem.archive?.rows || 0} 条</span>${mem.archive && !mem.archive.ready ? '<span class="chip">⚠️ 档案库没起来</span>' : ''}</div>
    <p class="small muted" style="margin-top:0">忘掉的不会自己想起来，但原文一直留在档案里，搜得到。</p>
    <div class="row"><input id="memArchQ" placeholder="翻淡忘档案：忘掉的原文还在，搜得回来" style="flex:1"><button class="btn sm" id="memArch">翻一翻</button></div><div id="memArchOut"></div>`;

  box.innerHTML = `<div class="seg" id="memSubSeg"><button data-v="days" class="${S.memSub === 'days' ? 'on' : ''}">日子（${days.length}）</button><button data-v="ideas" class="${S.memSub === 'ideas' ? 'on' : ''}">想法（${ideas.length + retired.length}）</button><button data-v="gist" class="${S.memSub === 'gist' ? 'on' : ''}">印象·日结（${gists.length}）</button><button data-v="arch" class="${S.memSub === 'arch' ? 'on' : ''}">档案（${mem.archive?.rows || 0}）</button></div>
    <div>${S.memSub === 'days' ? daysHtml : S.memSub === 'ideas' ? ideasHtml : S.memSub === 'gist' ? gistHtml : archHtml}</div>`;
  $$('#memSubSeg button', box).forEach((b) => (b.onclick = () => { S.memSub = b.dataset.v; renderMemories(box, mem); }));
  const tidyBtn = $('#memTidy', box); // 只在「印象·日结」子标签里
  if (tidyBtn) tidyBtn.onclick = (ev) => busy(ev.target, async () => {
    const r = await api('/api/memory/tidy', {});
    const x = r.result || {};
    toast(x.merged || x.forgot ? `合并 ${x.merged || 0} 条成 ${x.into || 0} 条，忘掉 ${x.forgot || 0} 条` : '没什么要整理的');
    renderMemories(box, r);
  });
  const arch = () => busy($('#memArch', box), async () => {
    const q = $('#memArchQ', box).value.trim();
    const out = $('#memArchOut', box);
    if (!q) { out.innerHTML = ''; return; }
    const r = await api('/api/memdb/search', { q }).catch(() => ({ hits: [] }));
    const hits = r.hits || [];
    out.innerHTML = hits.length
      ? `<div class="small" style="margin-top:6px"><span class="k">淡忘档案</span> 搜到 ${hits.length} 条 <span class="muted">（想不太清了的原文，不会自己想起来，但你翻得到）</span></div>
      <ul class="vip-list">${hits.slice(0, 20).map((e) => `<li><div style="flex:1;min-width:0" class="small">${MEM_KIND[e.kind] || '•'} ${esc(e.text)}<div class="muted">${e.kind === 'fact' ? `记于 ${esc(e.ts || '')}` : `${ago(e.ts)} · 重要 ${e.imp}/5${e.seen ? ' · 忘掉前想起过' : ''}`}</div></div></li>`).join('')}</ul>`
      : '<div class="empty" style="margin-top:6px">档案里也没有</div>';
  });
  const archBtn = $('#memArch', box); // 只在「档案」子标签里
  if (archBtn) {
    archBtn.onclick = arch;
    $('#memArchQ', box).onkeydown = (ev) => { if (ev.key === 'Enter') arch(); };
  }
  $$('[data-memedit]', box).forEach((b) => (b.onclick = () => {
    const e = list.find((x) => x.id === b.dataset.memedit);
    const text = prompt('改成什么？', e.text);
    if (text === null) return;
    const imp = prompt('重要程度 1~5（越重要记得越久）', String(e.imp));
    if (imp === null) return;
    busy(b, async () => { renderMemories(box, await api('/api/memory/update', { id: e.id, text, imp: Number(imp) })); toast('改好了'); });
  }));
  $$('[data-memdel]', box).forEach((b) => (b.onclick = () => busy(b, async () => {
    renderMemories(box, await api('/api/memory/delete', { id: b.dataset.memdel }));
  })));
  $$('[data-insok]', box).forEach((b) => (b.onclick = () => busy(b, async () => {
    renderMemories(box, await api('/api/memory/insight/approve', { i: Number(b.dataset.insok) })); toast('放行了，进她的记忆流');
  })));
  $$('[data-insno]', box).forEach((b) => (b.onclick = () => busy(b, async () => {
    renderMemories(box, await api('/api/memory/insight/reject', { i: Number(b.dataset.insno) }));
  })));
}

// ─── 记忆页：她自己的（日子/想法/印象/档案四个子标签）+ 关于号主的事 + 朋友们 ──
async function pageMemory(main) {
  const intro = '同一条记忆流，按性质分开看。「她自己的」里：日子（她的经历，按天分组）→ 想法（洞察与内心，猜想不是事实）→ 印象·日结（压缩层）→ 档案（忘掉的原文，翻得回来）';
  main.innerHTML = head('记忆', intro) + '<div class="empty">加载中…</div>';
  const [mem, q, fr] = await Promise.all([api('/api/memory'), api('/api/qq').catch(() => ({})), api('/api/friends').catch(() => ({}))]);
  if (S.page !== 'memory') return;
  const facts = q.facts || [];
  const friends = fr.list || [];
  S.memTab = S.memTab || 'mine';
  main.innerHTML = head('记忆', intro) +
    `<div class="seg" id="memSeg"><button data-v="mine" class="${S.memTab === 'mine' ? 'on' : ''}">她自己的（${mem.total || 0}）</button><button data-v="owner" class="${S.memTab === 'owner' ? 'on' : ''}">关于你的事（${facts.length}）</button><button data-v="friends" class="${S.memTab === 'friends' ? 'on' : ''}">朋友们（${friends.length}）</button></div>
     <div class="card" id="memCard"></div>`;
  const FACT_SRC = { nightly: '每晚整理记的', chat: '聊天时记的', dsh: '从 DSH 带来的' };
  const renderTab = () => {
    const card = $('#memCard', main);
    if (S.memTab === 'owner') {
      card.innerHTML = `<div class="card-h"><h2>她记得的关于你的事</h2><span class="small muted">聊天时和每晚整理记的；删了她就忘了</span></div>
        ${facts.length ? `<ul class="vip-list">${facts.slice().reverse().map((f) => `<li><div style="flex:1;min-width:0" class="small"><span class="chip">${esc(f.kind)}</span> ${esc(f.text)}<div class="muted">${esc(f.at)} · ${FACT_SRC[f.source] || f.source || ''}</div></div>
          <button class="btn sm ghost" data-fact="${esc(f.id)}" title="让她忘掉这条">×</button></li>`).join('')}</ul>` : '<div class="empty">还没记什么，聊着聊着就有了</div>'}`;
      $$('[data-fact]', card).forEach((b) => (b.onclick = () => busy(b, async () => { await api('/api/qq/fact/delete', { id: b.dataset.fact }); pageMemory(main); })));
    } else if (S.memTab === 'friends') {
      const soc = fr.social;
      card.innerHTML = `<div class="card-h"><h2>她的朋友们</h2><span class="small muted">群里和私聊里认识的人，一人一份小档案；互不串场，也不进她跟号主的印象</span></div>
        ${soc?.text ? `<p class="small" style="margin-top:0">💬 朋友圈近况（${esc(soc.date || '')}）：${esc(soc.text)}</p>` : ''}
        ${friends.length ? `<ul class="vip-list friend-list">${friends.map((f) => {
          const groups = f.groups || [];
          const groupText = groups.slice(0, 3).join('、') + (groups.length > 3 ? ` +${groups.length - 3}` : '');
          return `<li><div class="friend-item small">
            <div class="friend-title"><b>${esc(f.name || f.qq || '没记住名字')}</b>${f.fav ? `<span class="chip">好感 ${f.fav.fav}%</span>` : ''}${groups.length ? `<span class="chip friend-groups" title="全部群：${esc(groups.join('、'))}">群 ${esc(groupText)}</span>` : ''}</div>
            <div class="muted">最近活跃 ${ago(f.lastSeen)}</div>
            <div class="friend-notes">${(f.notes || []).slice().reverse().map((n) => `<div>${esc(n.text)} <span class="muted">${esc(n.at)}</span></div>`).join('')}</div>
            <button class="btn-mini friend-del" data-qq="${esc(f.qq || '')}" title="删掉这个人的全部数据（不可恢复）">删掉这个人</button>
          </div></li>`;
        }).join('')}</ul>` : '<div class="empty">还没认识谁，去群里聊聊或有人私聊她之后，每晚整理会建档</div>'}`;
    } else {
      card.innerHTML = `<div class="card-h"><h2>她自己的</h2><span class="small muted">日子 = 经历 · 想法 = 洞察与内心 · 印象·日结 = 压缩层 · 档案 = 淡忘的原文</span></div>
        <div id="memPageList"></div>`;
      renderMemories($('#memPageList', card), mem);
    }
  };
  $$('#memSeg button', main).forEach((b) => (b.onclick = () => { S.memTab = b.dataset.v; $$('#memSeg button', main).forEach((x) => x.classList.toggle('on', x === b)); renderTab(); }));
  $$('.friend-del', main).forEach((b) => (b.onclick = () => deleteFriendFlow(b.dataset.qq, renderTab)));
  renderTab();
}

// C4：删某人全部数据——先看清单，再输 QQ 二次确认，删完刷新列表
async function deleteFriendFlow(qq, refresh) {
  if (!qq) { toast('这个人还没对上 QQ 号，暂时删不了'); return; }
  const pv = await api('/api/friends/purge-preview?qq=' + encodeURIComponent(qq)).catch(() => null);
  if (!pv?.allowed) { toast(pv?.reason || '拉删除清单失败'); return; }
  const lines = (pv.items || []).filter((x) => x.count).map((x) => `· ${x.label}：${x.count}${x.detail ? `（${x.detail}）` : ''}`);
  if (!lines.length) { toast('这人没有可删的数据'); return; }
  const ok = await confirmBox(`删掉 ${pv.name || qq} 的全部数据？`,
    `下面是会清掉的清单（不可恢复，删了找不回来）：\n\n${lines.join('\n')}\n\n群里的聊天记录是整群的，不在这次删除范围内。`, '看清楚了，继续');
  if (!ok) return;
  const typed = prompt(`最后确认：请输入这个人的 QQ 号「${qq}」才会真删（输错就不删）：`);
  if (typed !== qq) { toast('确认串不对，什么都没删'); return; }
  const r = await api('/api/friends/purge', { qq, confirm: qq }).catch((e) => ({ ok: false, error: e.message }));
  if (!r?.ok) { toast(r?.error || '删除失败'); return; }
  toast(`删干净了：档案 ${r.removed.friends.length}、好感 ${r.removed.fav}、记忆 ${r.removed.memory}、聊天文件 ${r.removed.chat}`);
  refresh?.();
}

// 点赞 / 分享被 B站 拦着时她想点的视频：你在自己浏览器里点，B站 认真浏览器
async function renderWishes(el) {
  if (!el) return;
  const { list } = await api('/api/wishes').catch(() => ({ list: [] }));
  if (!el.isConnected) return;
  if (!list.length) { el.style.display = 'none'; return; }
  el.style.display = '';
  const name = { like: '❤️ 点赞', share: '↗️ 分享' };
  el.innerHTML = `<div class="card-h"><h2>🖱️ 等你帮她点</h2><button class="btn sm ghost" id="wishAll">全部清掉</button></div>
    <p class="small muted" style="margin-top:0">接口点赞 / 分享被 B站 拦着，这些是她看完想点的。点标题会开一个<b>她专用的浏览器窗口</b>（直接用她现在的登录，不用再登录，也不会把这边挤掉），点一下就好（分享 = 点分享按钮复制链接）。<br>别在你自己的浏览器里登录她的号，那样会把面板这边挤掉线。</p>
    <ul class="vip-list">${list.map((w) => `<li><div style="flex:1;min-width:0"><a href="#" data-wopen="${esc(w.bvid)}" title="在她的浏览器里打开">${esc(w.title || w.bvid)}</a>
      <div class="small muted">${name[w.kind] || w.kind}${w.owner ? ' · ' + esc(w.owner) : ''} · ${ago(w.ts)}</div></div>
      <button class="btn sm ghost" data-wdone="${esc(w.id)}" title="点过了">✓</button></li>`).join('')}</ul>`;
  $$('[data-wopen]', el).forEach((a) => (a.onclick = (e) => {
    e.preventDefault();
    busy(null, async () => { await api('/api/browser/open', { bvid: a.dataset.wopen }); toast('在她的浏览器里打开了，去那个窗口点吧'); });
  }));
  $$('[data-wdone]', el).forEach((b) => (b.onclick = () => busy(b, async () => { await api('/api/wishes/done', { id: b.dataset.wdone }); renderWishes(el); })));
  $('#wishAll', el).onclick = (e) => busy(e.target, async () => { await api('/api/wishes/done', { id: '*' }); renderWishes(el); });
}

function oneTimeTips(x) {
  const tips = [];
  if (!x.email) tips.push('绑定邮箱 +20');
  if (!x.safeQuestion) tips.push('设置密保问题 +30');
  if (!x.identify) tips.push('实名认证 +50');
  if (!tips.length) return '';
  return `<div class="hint" style="margin-top:12px">💡 一次性经验还没领：${tips.join('、')}。这些得你自己去 B站「账号设置」里弄，脚本不碰。</div>`;
}

// 今天模型用了多少：后台的跟预算比，你点的单独算
function usageLine(u) {
  if (!u) return '';
  const k = (n) => (n >= 1000 ? `${Math.round(n / 1000)}k` : String(n));
  const lim = (used, max) => (max > 0 ? `${k(used)} / ${k(max)}` : `${k(used)}（不限）`);
  const NAME = { mind: '内心', social: '评论区社交', comment: '评论', memory: '整理记忆', reply: '回复', diary: '日记', task: '派活', test: '测试', reflect_self: '日间复盘', idle_wander: '发呆', meta_review: '计划复盘', appointment: '约定', other: '其他' };
  const tags = Object.entries(u.byTag || {}).sort((a, b) => b[1].tokens - a[1].tokens)
    .map(([t, x]) => `${NAME[t] || t} ${x.calls} 次`).join(' · ');
  return `<div class="hint" style="margin-top:8px">今天：后台 ${lim(u.bg.calls, u.limit.calls)} 次、${lim(u.bg.tokens, u.limit.tokens)} tokens；一共 ${u.calls} 次 ${k(u.tokens)} tokens${u.hitAt ? ` · <b>${hm(u.hitAt)} 用完了</b>` : ''}${tags ? `<br>${tags}` : ''}</div>`;
}

function slotClass(s) { return s ? s.status : ''; }

function renderApCard(el, ap) {
  const c = ap.config;
  const now = new Date();
  const curH = now.getHours();
  const planBy = Object.fromEntries((ap.plan || []).map((s) => [s.key, s]));
  const dial = ap.shichen.map((sc) => {
    const s = planBy[sc.key];
    const isNow = sc.start === 23 ? curH >= 23 || curH < 1 : curH >= sc.start && curH < sc.end;
    const title = s ? `${sc.label} · ${s.status === 'pending' ? '计划 ' + hm(s.at) : { done: '已刷完', skipped: '今天随机跳过', missed: '错过了（电脑在睡觉）', running: '正在刷', failed: '中断了' }[s.status] || s.status}` : sc.label;
    return `<div class="h ${s ? 'sel' : ''} ${slotClass(s)} ${isNow ? 'now' : ''}" title="${esc(title)}">${sc.key}<small>${s && s.status === 'pending' ? hm(s.at) : pad(sc.start)}</small></div>`;
  }).join('');
  const next = (ap.plan || []).filter((s) => s.status === 'pending' && s.at > Date.now()).sort((a, b) => a.at - b.at)[0];
  const live = ap.live;
  const liveHtml = live.running
    ? `<div class="live">${live.video ? `<img src="${esc(img(live.video.pic, '172w_108h'))}" alt="">` : ''}
        <div style="min-width:0;flex:1">
          <div class="row small"><span class="pulse"></span><b>${esc(live.step || '刷B站中')}</b><span class="muted">第 ${Math.min(live.done + 1, live.planned || 1)} / ${live.planned || '?'} 个</span></div>
          ${live.video ? `<div class="t" style="margin-top:4px">${esc(live.video.title)}</div>
          <div class="row" style="margin-top:6px"><div class="bar pink" style="flex:1"><i style="width:${Math.min(100, (live.video.played / live.video.target) * 100)}%"></i></div><span class="small num">${fmtSec(live.video.played)} / ${fmtSec(live.video.target)}</span></div>` : ''}
        </div>
        <button class="btn sm danger" id="apStop">叫停</button></div>`
    : '';
  el.innerHTML = `
    <div class="card-h"><h2>自动养号</h2>
      <label class="row small" style="gap:8px">${c.enabled ? '<span class="chip green">运行中</span>' : '<span class="chip">已关闭</span>'}
        <span class="switch"><input type="checkbox" id="apToggle" ${c.enabled ? 'checked' : ''}><span></span></span></label></div>
    ${liveHtml}
    <div class="dial" style="margin-top:${live.running ? 12 : 0}px">${dial}</div>
    <div class="row wrap small" style="justify-content:space-between">
      <span class="muted">${ap.pause ? `⏸ 号主叫停了${ap.pause.reason ? `（${esc(ap.pause.reason)}）` : ''}，${ap.pause.untilResume ? `等他说好了（最晚 ${hm(ap.pause.until)}）` : `到 ${hm(ap.pause.until)}`}` : ap.cooldownUntil ? `🧊 风控冷却到 ${hm(ap.cooldownUntil)}` : !c.enabled ? '打开后，会在蓝色的时辰里随机挑时间去刷' : next ? `下一轮：${next.label.slice(0, 2)} ${hm(next.at)}` : '今天的计划都跑完了'}
      ${ap.lastRun ? ` · 上一轮 ${ago(ap.lastRun.at)}` : ''}
      ${(ap.blocks || []).length ? `<br>⏸ 暂停中：${ap.blocks.map((b) => `${esc(b.name)}（到 ${new Date(b.until).getMonth() + 1}/${new Date(b.until).getDate()} ${hm(b.until)}）`).join('、')}` : ''}</span>
      <span class="row">${ap.pause ? '<button class="btn sm" id="apResume">恢复</button>' : ''}${ap.cooldownUntil ? '<button class="btn sm" id="apCool">解除冷却</button>' : ''}
        <button class="btn sm" ${live.running ? 'disabled' : ''} id="apRun">现在刷一轮</button>
        <a class="btn sm ghost" href="#/autopilot">设置</a></span>
    </div>`;
  $('#apToggle', el).onchange = (e) => busy(null, async () => {
    await api('/api/autopilot/config', { enabled: e.target.checked });
    toast(e.target.checked ? '自动养号已打开' : '自动养号已关闭');
    route();
  });
  const run = $('#apRun', el);
  if (run) run.onclick = () => busy(run, async () => { await api('/api/autopilot/run', {}); toast('她去刷B站了'); pollLive(); });
  const stop = $('#apStop', el);
  if (stop) stop.onclick = () => busy(stop, async () => { await api('/api/autopilot/stop', {}); toast('已叫停，这个视频看完当前心跳就停'); });
  const cool = $('#apCool', el);
  if (cool) cool.onclick = () => busy(cool, async () => { await api('/api/autopilot/clear-cooldown', {}); route(); });
  const resume = $('#apResume', el);
  if (resume) resume.onclick = () => busy(resume, async () => { await api('/api/pause/clear', {}); toast('她接着过自己的日子了'); route(); });
}

let liveTimer = null;
function pollLive() {
  clearTimeout(liveTimer);
  liveTimer = setTimeout(async () => {
    try {
      const ap = await api('/api/autopilot');
      const el = $('#apCard');
      if (el && S.page === 'overview') renderApCard(el, ap);
      $('#footStatus').innerHTML = ap.live.running ? '<span class="pulse"></span> 她正在刷B站' : ap.config.enabled ? '自动养号 · 开' : '自动养号 · 关';
      if (ap.live.running) pollLive();
      else if (S.page === 'overview') route();
    } catch { /* ignore */ }
  }, 3000);
}

// 单系列柱状图：每天看了几个视频（今天用粉色）。悬停显示当天明细。
function renderChart(el, series) {
  const W = 700, H = 190, P = { l: 28, r: 8, t: 10, b: 24 };
  const max = Math.max(4, ...series.map((d) => d.watch));
  const step = Math.ceil(max / 4);
  const top = step * 4;
  const iw = W - P.l - P.r, ih = H - P.t - P.b;
  const bw = iw / series.length;
  const y = (v) => P.t + ih - (v / top) * ih;
  let g = '';
  for (let i = 0; i <= 4; i++) {
    const v = i * step;
    g += `<line class="grid-l" x1="${P.l}" x2="${W - P.r}" y1="${y(v)}" y2="${y(v)}"/><text class="ax" x="${P.l - 6}" y="${y(v) + 4}" text-anchor="end">${v}</text>`;
  }
  const today = localDate();
  series.forEach((d, i) => {
    const x = P.l + i * bw;
    const h = Math.max(0, ih - (y(d.watch) - P.t));
    const w = Math.min(28, bw - 6);
    const bx = x + (bw - w) / 2;
    const r = Math.min(4, h / 2);
    const path = h > 0 ? `M${bx},${P.t + ih} V${P.t + ih - h + r} Q${bx},${P.t + ih - h} ${bx + r},${P.t + ih - h} H${bx + w - r} Q${bx + w},${P.t + ih - h} ${bx + w},${P.t + ih - h + r} V${P.t + ih} Z` : '';
    const lab = i % 2 === series.length % 2 || d.date === today ? `<text class="ax" x="${x + bw / 2}" y="${H - 6}" text-anchor="middle">${d.date === today ? '今天' : Number(d.date.slice(8))}</text>` : '';
    g += `<g data-i="${i}"><rect class="hit" x="${x}" y="${P.t}" width="${bw}" height="${ih}"/>${path ? `<path class="barm ${d.date === today ? 'today' : ''}" d="${path}"/>` : ''}${lab}</g>`;
  });
  el.innerHTML = `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" aria-label="近14天每天看视频数">${g}</svg>`;
  const tip = $('#tip');
  $$('g[data-i]', el).forEach((n) => {
    n.addEventListener('mousemove', (e) => {
      const d = series[Number(n.dataset.i)];
      tip.innerHTML = `<b>${dayLabel(d.date)}</b><br>看视频 ${d.watch} 个 · ${fmtSec(d.seconds)}<br>点赞 ${d.like} · 评论 ${d.comment} · 分享 ${d.share}`;
      tip.style.left = e.clientX + 'px';
      tip.style.top = e.clientY - 8 + 'px';
      tip.style.position = 'fixed';
      tip.classList.add('show');
    });
    n.addEventListener('mouseleave', () => tip.classList.remove('show'));
  });
}

// ─── 活动记录 ──────────────────────────────────────────────
function tlItem(a, compact) {
  const [ico, name] = KIND[a.kind] || ['•', a.kind];
  const src = SOURCE[a.source || 'panel'] || ['?', ''];
  const vid = /^BV/i.test(a.target || '') ? a.target : '';
  const text = a.detail || a.title || a.target || name;
  return `<li class="${a.ok ? '' : 'bad'}" ${vid ? `data-bvid="${esc(vid)}" style="cursor:pointer"` : ''}>
    <div class="time num">${hm(a.ts)}</div>
    <div class="ico ${esc(a.kind)}">${ico}</div>
    <div class="body"><div class="x">${esc(compact ? text.slice(0, 60) : text)}</div>
      ${a.meta?.thought ? `<div class="thought">💭 ${esc(a.meta.thought)}${a.meta.score ? ` <span class="muted">${'♥'.repeat(a.meta.score)}</span>` : ''}</div>` : ''}
      <div class="m"><span class="chip ${src[1]}">${src[0]}</span>${compact ? '' : `<span>${name}</span>`}${a.error ? `<span class="err">${esc(a.error)}</span>` : ''}</div></div>
  </li>`;
}

async function pageActivity(main) {
  const F = (S.actF ||= { source: '', kind: '', date: '', q: '' });
  main.innerHTML = head('活动记录', '她每一次看、赞、评、发，都记在这里（自动养号 / 面板操作 / QQ 里的她）') +
    `<div class="card">
      <div class="filters">
        <div class="seg" id="srcSeg">${[['', '全部'], ['auto', '自动'], ['panel', '面板'], ['bot', 'QQ里的她']].map(([k, n]) => `<button data-v="${k}" class="${F.source === k ? 'on' : ''}">${n}</button>`).join('')}</div>
        <select id="kindSel" style="width:auto">
          <option value="">所有动作</option>
          <option value="watch">看视频</option><option value="like">点赞</option><option value="comment,reply_comment,join">评论 / 回复</option><option value="social,join,reply_like">评论区社交</option>
          <option value="share,coin">分享 / 投币</option><option value="dm_send">私信</option><option value="session_start,session_end">每一轮</option>
          <option value="mind,dig">心里想 / 顺藤摸瓜</option><option value="error,cooldown">出错 / 风控</option>
        </select>
        <input type="date" id="dateIn" value="${esc(F.date)}" style="width:auto">
        <input id="qIn" placeholder="搜标题 / 内容" value="${esc(F.q)}" style="width:200px">
        <span class="spacer"></span><span class="small muted" id="actTotal"></span>
      </div>
      <div id="actList"><div class="empty">加载中…</div></div>
    </div>`;
  $('#kindSel').value = F.kind;
  const load = async () => {
    const qs = new URLSearchParams({ limit: 400, ...Object.fromEntries(Object.entries(F).filter(([, v]) => v)) });
    try {
      const r = await api('/api/actions?' + qs);
      $('#actTotal').textContent = `共 ${r.total} 条`;
      if (!r.list.length) { $('#actList').innerHTML = '<div class="empty"><span class="fish">🫧</span>这里还空空的</div>'; return; }
      let html = '', cur = '';
      for (const a of r.list) {
        const d = localDate(new Date(a.ts));
        if (d !== cur) { if (cur) html += '</ul>'; html += `<div class="tl-day">${dayLabel(d)} · ${d}</div><ul class="tl">`; cur = d; }
        html += tlItem(a);
      }
      $('#actList').innerHTML = html + '</ul>';
    } catch (e) { $('#actList').innerHTML = `<div class="err">${esc(e.message)}</div>`; }
  };
  $$('#srcSeg button').forEach((b) => (b.onclick = () => { F.source = b.dataset.v; $$('#srcSeg button').forEach((x) => x.classList.toggle('on', x === b)); load(); }));
  $('#kindSel').onchange = (e) => { F.kind = e.target.value; load(); };
  $('#dateIn').onchange = (e) => { F.date = e.target.value; load(); };
  let qt; $('#qIn').oninput = (e) => { clearTimeout(qt); qt = setTimeout(() => { F.q = e.target.value.trim(); load(); }, 300); };
  load();
}

// ─── 插嘴裁决：群消息打分闸的专属账本 ──────────────────────
const GATE_VERDICT = { '过闸': 'green', '仲裁放行': 'blue', '仲裁拦下': 'amber', '拦下': '', '没接': '', '限流': 'violet' };
function gateRow(a) {
  const m = a.meta || {};
  const verdict = m.verdict || /插嘴(过闸|仲裁放行|仲裁拦下|拦下|限流)/.exec(a.detail || '')?.[1] || '？';
  const color = GATE_VERDICT[verdict];
  const score = m.score ?? (/([\d.]+) 分/.exec(a.detail || '')?.[1] ?? '');
  const reasons = (m.reasons || []).join('、') || /（(.+?)）/.exec(a.detail || '')?.[1] || '';
  const text = m.text || /「(.*)」/.exec(a.detail || '')?.[1] || a.detail || '';
  const peer = m.peer ? (String(m.peer).startsWith('g:') ? `群 ${String(m.peer).slice(2)}` : '私聊') : '';
  return `<li>
    <div class="time num">${hm(a.ts)}</div>
    <div class="ico">${verdict === '限流' ? '🚦' : '🎯'}</div>
    <div class="body"><div class="x">${esc(text)}</div>
      <div class="m"><span class="chip ${color}">${verdict}</span>${score !== '' ? `<span class="num">${score} 分</span>` : ''}<span class="muted">${esc(reasons)}</span>${peer ? `<span class="chip">${esc(peer)}</span>` : ''}</div></div>
  </li>`;
}
async function pageGate(main) {
  const F = (S.gateF ||= { verdict: '', date: '', q: '' });
  main.innerHTML = head('插嘴裁决', '群里每句没 @ 她的话都过一遍打分闸：几分、命中了什么、拦没拦——调手感全靠这份账') +
    `<div class="card">
      <div class="filters">
        <div class="seg" id="vSeg">${[['', '全部'], ...Object.keys(GATE_VERDICT).map((k) => [k, k])].map(([k, n]) => `<button data-v="${k}" class="${F.verdict === k ? 'on' : ''}">${n}</button>`).join('')}</div>
        <input type="date" id="gDate" value="${esc(F.date)}" style="width:auto">
        <input id="gQ" placeholder="搜消息 / 命中项" value="${esc(F.q)}" style="width:200px">
        <span class="spacer"></span><span class="small muted" id="gStat"></span>
      </div>
      <div id="gateList"><div class="empty">加载中…</div></div>
    </div>`;
  const load = async () => {
    const qs = new URLSearchParams({ kind: 'gate', limit: 400, ...Object.fromEntries(Object.entries(F).filter(([, v]) => v)) });
    try {
      const r = await api('/api/actions?' + qs);
      let list = r.list;
      if (F.verdict) list = list.filter((a) => (a.meta?.verdict || /插嘴(过闸|仲裁放行|仲裁拦下|拦下|限流)/.exec(a.detail || '')?.[1] || '') === F.verdict);
      const cnt = {};
      for (const a of list) { const v = a.meta?.verdict || '旧记录'; cnt[v] = (cnt[v] || 0) + 1; }
      $('#gStat').textContent = `共 ${r.total} 条` + (Object.keys(cnt).length > 1 ? ` · ${Object.entries(cnt).map(([k, n]) => `${k} ${n}`).join(' / ')}` : '');
      if (!list.length) { $('#gateList').innerHTML = '<div class="empty"><span class="fish">🫧</span>这里还空空的</div>'; return; }
      let html = '', cur = '';
      for (const a of list) {
        const d = localDate(new Date(a.ts));
        if (d !== cur) { if (cur) html += '</ul>'; html += `<div class="tl-day">${dayLabel(d)} · ${d}</div><ul class="tl">`; cur = d; }
        html += gateRow(a);
      }
      $('#gateList').innerHTML = html + '</ul>';
    } catch (e) { $('#gateList').innerHTML = `<div class="err">${esc(e.message)}</div>`; }
  };
  $$('#vSeg button').forEach((b) => (b.onclick = () => { F.verdict = b.dataset.v; $$('#vSeg button').forEach((x) => x.classList.toggle('on', x === b)); load(); }));
  $('#gDate').onchange = (e) => { F.date = e.target.value; load(); };
  let qt; $('#gQ').oninput = (e) => { clearTimeout(qt); qt = setTimeout(() => { F.q = e.target.value.trim(); load(); }, 300); };
  load();
}

// ─── 谁像bot：群聊记录算的怀疑榜单 + 一键进/出机器人名单（检测手动触发，不自动跑）─────────
const BS_VERDICT = { '高度疑似': 'pink', '可疑': 'blue', '像人': 'green', '数据不足': '' };
const BS_HINT = '检测不自动跑——数据是实时的，选好群和天数，点「检测」才算最新一轮';
function bsRow(x, marked) {
  const chip = `<span class="chip ${BS_VERDICT[x.verdict2] || ''}" title="新规则：养鱼号（变体话术、自说自话、引流词、卡片链接）">${x.verdict2}${x.score2 != null ? ` ${x.score2}` : ''}</span>` +
    `<span class="chip" title="旧规则：链式刷屏脚本，留着对比观察">${x.verdict}${x.score != null ? ` ${x.score}` : ''}</span>` +
    (x.qqConf === 'low' ? '<span class="chip" title="档案里同名的人在别的群，可能串号——拉黑前翻一下聊天记录">⚠️ QQ低置信</span>' : '');
  const fl = x.flags2.length ? x.flags2 : x.flags;
  const flags = fl.length ? `<span class="small muted">${fl.map(esc).join(' · ')}</span>` : '';
  const nums = `<div class="small muted num">${x.n} 条 · 活跃 ${x.hourSpan} 个钟头 · 时间熵 ${x.timeEnt}${x.latP90 != null ? ` · 回前条P90 ${x.latP90}s` : ''}${x.gapCv != null ? ` · 间隔CV ${x.gapCv}` : ''}${x.windowDupShare >= 0.12 ? ` · 窗口同文 ${Math.round(x.windowDupShare * 100)}%` : ''}${x.selfTalkShare != null && x.selfTalkShare >= 0.6 ? ` · 自说自话 ${Math.round(x.selfTalkShare * 100)}%` : ''}${x.dupShare >= 0.15 ? ` · 同文(旧) ${Math.round(x.dupShare * 100)}%` : ''}${x.riskTrace ? ' · 卡片/链接' : ''}${x.drainHit ? ' · 引流词' : ''}${x.traces ? ' · 有语音/文件' : ''}</div>`;
  const btn = !x.qq
    ? `<button class="btn sm" disabled title="聊天记录里只存了群名片，档案里对不上QQ——去「自动养号 → 机器人名单」手动填">对不上QQ</button>`
    : marked
      ? `<button class="btn sm ghost" data-block="0" data-qq="${esc(x.qq)}" data-name="${esc(x.name)}">移出名单</button>`
      : `<button class="btn sm" data-block="1" data-qq="${esc(x.qq)}" data-name="${esc(x.name)}">拉黑</button>`;
  return `<div class="row wrap" style="padding:9px 0;border-bottom:1px solid var(--line)">
    <div style="min-width:150px"><b>${esc(x.name)}</b>${x.qq ? `<div class="small muted num">${esc(x.qq)}</div>` : ''}</div>
    <div style="flex:1;min-width:220px"><div class="row" style="gap:6px;flex-wrap:wrap">${chip}${flags}</div>${nums}</div>
    <div class="row">${marked ? '<span class="chip">已在名单</span>' : ''}${btn}</div>
  </div>`;
}
async function pageBotscore(main) {
  const F = (S.bsF ||= { group: '', days: 30 });
  main.innerHTML = head('谁像bot', '从群聊记录算的「像脚本/养鱼号程度」：两套分并排（新的抓养鱼号——变体话术、自说自话、引流词、卡片链接；旧的抓链式脚本），只出怀疑名单不下判决，盖章靠你翻聊天记录。拉黑进的就是「机器人名单」——那人只有 @ 她、叫她名字、点她干活/怼她，她才接话') +
    `<div class="card">
      <div class="filters">
        <div class="seg" id="bsGroup"><span class="empty" style="padding:4px 10px">加载中…</span></div>
        <div class="seg" id="bsDays">${[14, 30, 90].map((d) => `<button data-d="${d}" class="${F.days === d ? 'on' : ''}">${d} 天</button>`).join('')}</div>
        <button class="btn sm primary" id="bsScan">🔍 检测最新数据</button>
        <span class="spacer"></span><span class="small muted" id="bsStat"></span>
      </div>
      <div id="bsList"><div class="empty">${BS_HINT}</div></div>
    </div>`;
  const load = async (scan = false) => {
    try {
      const r = await api('/api/botscore?' + new URLSearchParams({ ...(F.group ? { group: F.group } : {}), days: F.days, ...(scan ? { scan: 1 } : {}) }));
      $('#bsGroup').innerHTML = r.groups.length
        ? r.groups.map((g) => `<button data-g="${esc(g.peer)}" class="${F.group === g.peer ? 'on' : ''}">群 ${esc(g.peer.slice(2))} <span class="muted">${g.n}</span></button>`).join('')
        : '';
      if (!r.groups.length) { $('#bsList').innerHTML = '<div class="empty"><span class="fish">🫧</span>还没有群聊记录（公共模式开了、群里有人说过话才会有）</div>'; return; }
      if (!F.group) { F.group = r.groups[0].peer; await load(false); return; } // 第一次进来选上最热的群，但不算分——等点「检测」
      if (!r.rows) { $('#bsStat').textContent = `名单里 ${r.botQQs.length} 个`; $('#bsList').innerHTML = `<div class="empty">${BS_HINT}</div>`; return; }
      $('#bsStat').textContent = `${r.rows.length} 个账号 · 检测于 ${new Date().toLocaleTimeString('zh-CN', { hour12: false }).slice(0, 5)} · 名单里 ${r.botQQs.length} 个`;
      const marks = new Set(r.botQQs);
      $('#bsList').innerHTML = r.rows.map((x) => bsRow(x, marks.has(x.qq))).join('') || '<div class="empty">这段时间没有别人说话</div>';
      $$('#bsList [data-block]').forEach((b) => (b.onclick = () => busy(b, async () => {
        await api(`/api/botscore/${b.dataset.block === '1' ? 'block' : 'unblock'}`, { qq: b.dataset.qq, name: b.dataset.name });
        toast(b.dataset.block === '1' ? '已进机器人名单' : '已移出机器人名单');
        load(true);
      })));
    } catch (e) { $('#bsList').innerHTML = `<div class="err">${esc(e.message)}</div>`; }
  };
  $('#bsGroup').onclick = (e) => { const b = e.target.closest('[data-g]'); if (b) { F.group = b.dataset.g; load(false); } };
  $$('#bsDays button').forEach((b) => (b.onclick = () => { F.days = Number(b.dataset.d); $$('#bsDays button').forEach((x) => x.classList.toggle('on', x === b)); load(false); }));
  $('#bsScan').onclick = () => busy($('#bsScan'), () => load(true));
  load(false);
}

// ─── 自动养号设置 ──────────────────────────────────────────
// ─── 手感调参：插嘴打分权重 / 限流 / 防抖，全部外置在 data/tuning.json，存了立刻生效 ───
const TUNE_LABELS = {
  topic: [['base', '底分'], ['pass', '直接过闸 ≥'], ['review', '进仲裁 ≥'], ['image', '带图'], ['memeImg', '梗图分'], ['direct', '指向她'], ['asks', '带提问'], ['cmd', '短指令'], ['attack', '被点名怼'], ['continuation', '话题延续'], ['replyToMe', '回她的话'], ['replyWindowMin', '「回她的话」窗口（分）'], ['overlapBase', '接续起步'], ['overlapStep', '接续步进'], ['overlapCap', '接续封顶'], ['emotion', '纯情绪'], ['shortOnly', '短句无信息'], ['repeatText', '重复表述'], ['cooldownRepeat', '冷却期重复'], ['noInfo', '无新信息'], ['cooldownSec', '冷却期（秒）']],
  gate: [['debounceGroupMs', '群防抖（毫秒）'], ['debouncePrivateMs', '私聊防抖（毫秒）'], ['userRateWindowMin', '限流窗口（分钟）'], ['userRateMax', '窗口内最多回（次）'], ['herRateWindowMin', '她的熔断窗口（分钟）'], ['herRateMax', '窗口内她最多自由插嘴（句）']],
  fav: [['msgMax', '单条消息上限（±分）'], ['dayMax', '单日净分上限'], ['amp', '当天情绪放大倍数'], ['minDays', '老朋友α下限（天）'], ['lo', '好感下界'], ['hi', '好感上界'], ['decayEveryDays', '淡忘间隔（天）'], ['decayPer', '每次淡几分'], ['decayMax', '断太久一次最多淡'], ['keepDays', '走势留多少天']],
  ctx: [['days', '聊天原文带几天（1~30）']],
  sticker: [['ownerEvery', '号主私聊几条配一图'], ['friendEvery', '好友私聊几条配一图'], ['groupEvery', '群聊几条配一图']],
};
const TUNE_SEC_TITLE = { topic: '打分权重（加多少分 / 减多少分）', gate: '闸口与限流', fav: '好感（涨多快 · 淡多快）', ctx: '记忆窗口（原文带几天，更早的归摘要和记忆层）', sticker: '表情包频率（几条消息配一张，1~10，写进她的说明书）' };
async function pageTuning(main) {
  main.innerHTML = head('手感调参', '她的手感全在这调：插嘴打分权重、限流、防抖，还有好感涨多快淡多快。改完点保存立刻生效，不用重启；插嘴的拿不准就先用「试算」看这句话会怎么判。',
    '<button class="btn sm ghost" id="tuningResetAll">恢复默认</button>') +
    `<div class="grid g-3">
      <div class="card span-2">
        <div class="card-h"><h2>试算</h2><span class="small muted">拿一句群友可能说的话走一遍真打分（试算前会先保存下面填的值）</span></div>
        <div class="row"><input id="topicTry" placeholder="比如：今天中午吃什么好" style="flex:1" autocomplete="off"><button class="btn sm" id="topicTryBtn">算一下</button></div>
        <div class="hint" id="topicTryMsg">改完权重，拿同一句话再算一遍，看分数怎么动。</div>
        <div class="cfg-grid qq-grid" id="tuningGrid" style="margin-top:10px"><div class="small muted">加载中…</div></div>
        <div class="row" style="margin-top:12px"><button class="btn sm" id="tuningSave">保存</button><span class="small muted" id="tuningMsg"></span></div>
      </div>
      <div class="card">
        <div class="card-h"><h2>改过哪些</h2></div>
        <div id="tuneDiff" class="small" style="margin-bottom:12px">…</div>
        <div class="card-h"><h2>直接编 JSON</h2></div>
        <div class="hint" style="margin-bottom:6px">会一点格式的可以直接改这份（跟左边表格同步），应用时同样只认数字键。</div>
        <textarea id="tuneRaw" rows="18" style="width:100%;font-family:monospace;font-size:11px" spellcheck="false"></textarea>
        <div class="row" style="margin-top:8px"><button class="btn sm" id="tuneRawApply">按这份应用</button><span class="small muted" id="tuneRawMsg"></span></div>
      </div>
    </div>`;
  const render = (cur, defaults) => {
    $('#tuningGrid').innerHTML = Object.entries(TUNE_LABELS).map(([sec, items]) =>
      `<div class="wide" style="font-weight:700;font-size:12px;color:var(--muted);padding-top:8px">${TUNE_SEC_TITLE[sec] || sec}</div>` +
      items.map(([k, label]) => `<div><label class="f">${label}</label><input type="number" step="0.1" data-tune="${sec}.${k}" value="${cur[sec][k]}" autocomplete="off"></div>`).join('')
    ).join('');
    const diff = [];
    for (const sec of Object.keys(defaults)) for (const [k, d] of Object.entries(defaults[sec])) if (cur[sec][k] !== d) diff.push(`${TUNE_LABELS[sec]?.find(([kk]) => kk === k)?.[1] || `${sec}.${k}`}：${d} → ${cur[sec][k]}`);
    $('#tuneDiff').innerHTML = diff.length ? diff.map((d) => `· ${esc(d)}`).join('<br>') : '<span class="muted">还没改过，全是默认手感</span>';
    $('#tuneRaw').value = JSON.stringify({ topic: cur.topic, gate: cur.gate, fav: cur.fav, ctx: cur.ctx, sticker: cur.sticker }, null, 2);
    $('#tuningMsg').textContent = '';
  };
  let defaults = null;
  const load = async () => { const r = await api('/api/tuning'); defaults = r.defaults; render(r.current, r.defaults); };
  await load().catch((err) => { $('#tuningGrid').innerHTML = `<span class="muted">参数读不到：${esc(err.message || err)}<br>（面板还在用旧版 panel.mjs 就是这个样子——上传新版并重启容器后再试）</span>`; });
  const collect = () => {
    const body = { topic: {}, gate: {}, fav: {}, ctx: {}, sticker: {} };
    document.querySelectorAll('[data-tune]').forEach((inp) => { const [sec, k] = inp.dataset.tune.split('.'); const v = Number(inp.value); if (Number.isFinite(v)) body[sec][k] = v; });
    return body;
  };
  $('#tuningSave').onclick = (e) => busy(e.target, async () => {
    const r = await api('/api/tuning/save', collect());
    render(r.current, defaults);
    $('#tuningMsg').textContent = '✓ 存了，立刻生效，不用重启';
    toast('手感已保存');
  });
  $('#tuningResetAll').onclick = (e) => busy(e.target, async () => {
    if (!(await confirmBox('恢复默认手感？', '现在改过的值都会丢，回到出厂手感。', '恢复'))) return;
    const r = await api('/api/tuning/reset', {});
    render(r.current, defaults);
    toast('已恢复默认');
  });
  $('#tuneRawApply').onclick = (e) => busy(e.target, async () => {
    let body;
    try { body = JSON.parse($('#tuneRaw').value); } catch (err) { $('#tuneRawMsg').textContent = `JSON 写坏了：${err.message}`; return; }
    const r = await api('/api/tuning/save', body);
    render(r.current, defaults);
    $('#tuneRawMsg').textContent = '✓ 应用上了';
  });
  $('#topicTryBtn').onclick = (e) => busy(e.target, async () => {
    const text = $('#topicTry').value.trim();
    if (!text) { $('#topicTryMsg').textContent = '先写句话呀'; return; }
    await api('/api/tuning/save', collect()); // 试算按当前填的值来，先存再算
    const r = await api('/api/qq/topic-preview', { text });
    const favLine = r.favErr ? `⚠ 好感没判出来：${esc(r.favErr)} —— 这是调用失败不是结果，重试或查模型配置`
      : r.fav == null ? '⚠ 好感没判出来：模型回了话但格式没认出来，再算一次试试'
      : r.fav.d === 0 ? '好感：本句话好感无变动（判过了，平平无奇不记分）'
      : `好感：${r.fav.d > 0 ? '+' : ''}${r.fav.d}（${esc(r.fav.why)}）`;
    $('#topicTryMsg').innerHTML = `${r.score} 分 → ${r.status === 'pass' ? '直接过闸' : r.status === 'review' ? '交给仲裁拿主意' : '不接，潜水'}（${r.reasons.join('、')}）<br>${favLine}`;
    const cur = await api('/api/tuning'); render(cur.current, defaults);
  });
}

async function pageAutopilot(main) {
  main.innerHTML = head('自动养号', '她会在你选的时辰里，随机挑个时间去刷B站：真的看视频（留下观看记录）、随缘点赞、分享、评论') + '<div class="empty">加载中…</div>';
  const ap = await api('/api/autopilot');
  if (S.page !== 'autopilot') return;
  const c = structuredClone(ap.config);
  const planBy = Object.fromEntries((ap.plan || []).map((s) => [s.key, s]));
  const num = (path, label, opt = {}) => {
    const v = path.split('.').reduce((o, k) => o[k], c);
    const shown = opt.pct ? Math.round(v * 100) : v;
    return `<div><label class="f">${label}</label><input type="number" data-path="${path}" ${opt.pct ? 'data-pct="1"' : ''} value="${shown}" min="${opt.min ?? 0}" max="${opt.max ?? 9999}" step="${opt.step ?? 1}">${opt.hint ? `<div class="hint">${opt.hint}</div>` : ''}</div>`;
  };
  const sel = (path, label, options, hint) => {
    const v = path.split('.').reduce((o, k) => o[k], c);
    return `<div><label class="f">${label}</label><select data-path="${path}">${options.map(([k, n]) => `<option value="${k}" ${k === v ? 'selected' : ''}>${n}</option>`).join('')}</select>${hint ? `<div class="hint">${hint}</div>` : ''}</div>`;
  };
  const tog = (path, label, hint) => {
    const v = path.split('.').reduce((o, k) => o[k], c);
    return `<div><label class="f">${label}</label><label class="row"><span class="switch"><input type="checkbox" data-path="${path}" ${v ? 'checked' : ''}><span></span></span><span class="small muted">${hint || ''}</span></label></div>`;
  };
  const llmNote = ap.llmReady ? '<span class="chip green">已配置</span>' : '<span class="chip amber">未配置：评论会交给 QQ 里的她</span>';

  main.innerHTML = head('自动养号', '她会在你选的时辰里，随机挑个时间去刷B站：真的看视频（留下观看记录）、随缘点赞、分享、评论',
      // 必须包 label：原生 checkbox 是 0×0 隐形的，点击靠 label 转发——不包就是死开关（2026-11-13 总开关关不掉的根因）
      `<label class="row"><span class="small muted">总开关</span><span class="switch"><input type="checkbox" data-path="enabled" ${c.enabled ? 'checked' : ''}><span></span></span></label>`) +
    `<div class="grid g-3">
     <div class="card span-2">
      <div class="cfg-sec">
        <h3>什么时候刷</h3>
        <p>点选时辰（蓝色 = 会去刷）。每个时辰里随机挑一个时间点，还会按概率随机跳过几次，不像打卡机。电脑睡着时错过的就错过了，醒来时辰还没过会补上。</p>
        <div class="dial pick" id="dialPick">${ap.shichen.map((sc) => {
          const s = planBy[sc.key];
          return `<div class="h ${c.windows.includes(sc.key) ? 'sel' : ''}" data-k="${sc.key}" title="${esc(sc.label)}">${sc.key}<small>${pad(sc.start)}–${pad(sc.end)}</small></div>`;
        }).join('')}</div>
        <div class="cfg-grid">${num('windowChance', '每个时辰去刷的概率 %', { pct: 1, max: 100, hint: '85% ≈ 每周偶尔偷懒一两次' })}
          ${tog('morningPlan', '晨间计划：给每个时辰派「干什么」', '每天开刷前按她最近的洞察和状态排：随缘刷 / 刷+点赞 / 刷+评论 / 写日记 / 看消息 / 歇着。排不出来或排坏了就自动回退成上面的纯时辰表')}</div>
      </div>
      <div class="cfg-sec">
        <h3>怎么看视频</h3>
        <p>用网页播放器同款心跳（每 15 秒一次）上报进度，B站历史记录里能看到「看到第几秒」，也算每日观看经验。</p>
        <div class="cfg-grid">
          ${num('session.videosMin', '每轮最少看几个', { min: 1, max: 20 })}
          ${num('session.videosMax', '每轮最多看几个', { min: 1, max: 20 })}
          ${num('session.watchRatioMin', '最少看完 %', { pct: 1, max: 100 })}
          ${num('session.watchRatioMax', '最多看完 %', { pct: 1, max: 100 })}
          ${num('session.maxWatchSec', '单个视频最多看（秒）', { min: 30, max: 3600, hint: '长视频看一段就走' })}
          ${num('session.skipChance', '刷到不感兴趣直接划走 %', { pct: 1, max: 100 })}
          ${num('session.gapMinSec', '视频间隔最短（秒）', { max: 600 })}
          ${num('session.gapMaxSec', '视频间隔最长（秒）', { max: 600 })}
          ${num('session.maxDurationSec', '不看超过多少秒的视频', { min: 60, max: 7200 })}
        </div>
        <div class="field" style="margin-top:14px"><label class="f">她的兴趣（会拿来搜视频，回车添加，点一下删除）</label>
          <div class="tags" id="tags">${c.interests.map((t) => `<span class="chip blue" data-t="${esc(t)}">${esc(t)} ×</span>`).join('')}<input id="tagIn" placeholder="加一个…"></div></div>
        <div class="cfg-grid">
          ${num('session.sourceWeights.feed', '挑视频：首页推荐 权重', { max: 10 })}
          ${num('session.sourceWeights.interest', '兴趣搜索 权重', { max: 10 })}
          ${num('session.sourceWeights.hot', '热门榜 权重', { max: 10 })}
        </div>
      </div>
      <div class="cfg-sec">
        <h3>互动</h3>
        <p>每日上限对所有来源合并计算（自动 + 面板 + QQ 里的她），账号只有一个。</p>
        <div class="cfg-grid">
          ${num('like.chance', '看完后点赞概率 %', { pct: 1, max: 100 })}
          ${num('like.dailyMax', '每天最多点赞', { max: 100 })}
          ${tog('share.daily', '每天分享一次', '+5 经验')}
          ${sel('comment.mode', '评论方式', [['off', '不评论'], ['task', '交给 QQ 里的她写'], ['llm', 'AI 起草（用下面的模型）']], '「交给她」= 投到任务箱，你下次在 QQ 跟她说话时她会去写')}
          ${num('comment.chance', '看完后想评论的概率 %', { pct: 1, max: 100 })}
          ${num('comment.dailyMax', '每天最多评论', { max: 20 })}
          ${tog('comment.review', 'AI 评论先给我审', '强烈建议开着')}
        </div>
      </div>
      <div class="cfg-sec">
        <h3>🪟 她的窗</h3>
        <p>给她开一扇窗：此刻外面天黑没黑、太阳几点落的、今晚什么月亮、下没下雨。日照和月相按经纬度现算，天气用高德一小时查一次。
        她刷之前想看什么、刷完心情怎么变、睡前反思都会看一眼窗外。不填地点就只知道几点。</p>
        <div class="cfg-grid">
          ${tog('sky.enabled', '让她看窗外')}
          <div><label class="f">住在哪个城市</label><input data-path="sky.place" value="${esc(c.sky.place || '')}" placeholder="比如：深圳" autocomplete="off"><div class="hint">${Number.isFinite(c.sky.lat) ? `已定位：${esc(c.sky.label || c.sky.place)}（${c.sky.lat}, ${c.sky.lon}）` : '保存时用高德查成经纬度；天气服务只会收到城市名'}</div></div>
          <div><label class="f">高德 Key</label><input type="password" id="amapKey" placeholder="${ap.hasAmapKey ? '已保存（留空不改）' : '32 位那串'}" autocomplete="new-password"><div class="hint">lbs.amap.com 注册（个人免费）→ 应用管理 → 添加 Key，服务平台选「Web服务」；查天气和经纬度都用它</div></div>
        </div>
      </div>
      <div class="cfg-sec">
        <h3>🗨️ 评论区社交 ${ap.llmReady ? '' : '<span class="chip amber">要先配模型</span>'}</h3>
        <p>看完视频翻评论区，看到真想接的热评就在楼里回一句；有人回她 / @她，她隔一阵看一眼，结合那串楼前面聊了啥、跟这个人熟不熟、自己现在的心情，<b>自己决定</b>回一句、只点个赞，还是不理。
        同一串楼回够次数就收住。发之前要不要审跟着上面「AI 评论先给我审」走，都计入评论的保险丝。只有<b>自动养号开着</b>时才会自己去看。</p>
        <div class="cfg-grid">
          ${tog('social.enabled', '启用评论区社交')}
          ${tog('social.join', '主动去热评下搭话')}
          ${num('social.joinChance', '看完后去搭话的概率 %', { pct: 1, max: 100, hint: '喜欢的视频更高，1~2 分的不搭' })}
          ${num('social.joinDailyMax', '每天最多搭话', { max: 20 })}
          ${tog('social.reply', '有人回她，自己决定回不回')}
          ${num('social.replyDailyMax', '每天最多回复', { max: 50 })}
          ${num('social.checkMin', '多久看一眼回复（分钟）', { min: 10, max: 600, hint: '会抖动；刷完一轮也会瞄一眼' })}
          ${num('social.threadMax', '同一串楼最多回几次', { min: 1, max: 20 })}
          ${num('social.likeChance', '顺手给对方评论点赞 %', { pct: 1, max: 100 })}
          ${num('social.quietStart', '深夜不回（从几点）', { max: 23 })}
          ${num('social.quietEnd', '深夜不回（到几点）', { max: 23 })}
        </div>
      </div>
      <div class="cfg-sec">
        <h3>⭐ 特别关注</h3>
        <p>名单在右边。TA 发了新视频，她会优先去看（认真看 75%~100%），然后点赞、收藏、投币（受下面的投币开关和锁约束）、评论；发了图文/文字动态就顺手点个赞，再去看看 TA 最近没看过的视频。只有<b>自动养号开着</b>时才会自己去查。</p>
        <div class="cfg-grid">
          ${tog('vip.enabled', '启用特别关注')}
          ${tog('vip.asap', '有更新就尽快去看', '几分钟内；关掉则等下一个时辰顺路看')}
          ${num('vip.quietStart', '深夜不去（从几点）', { max: 23 })}
          ${num('vip.quietEnd', '深夜不去（到几点）', { max: 23 })}
          ${num('vip.checkMin', '多久看一眼动态（分钟）', { min: 10, max: 240, hint: '会随机抖动' })}
          ${num('vip.maxAgeHours', '只追多少小时内发的', { min: 1, max: 720 })}
          ${num('vip.dailyMax', '一天最多追几个视频', { min: 1, max: 30 })}
          ${num('vip.maxWatchSec', '单个视频最多看（秒）', { min: 60, max: 7200 })}
          ${tog('vip.like', '点赞')}
          ${tog('vip.favorite', '收藏', '进默认收藏夹')}
          ${tog('vip.coin', '投币', '优先投给 TA')}
          ${tog('vip.comment', '评论', '按上面的评论方式，计入每日上限')}
          ${tog('vip.likeDynamic', '给 TA 的动态点赞')}
        </div>
      </div>
      <div class="cfg-sec">
        <h3>投币</h3>
        <p>每枚 +10 经验，但新号每天只送 1 枚币。<b>接口投币只要失败一次就永久上锁</b>，免得反复失败把号搞成异常。</p>
        ${ap.coinLock ? `<div class="live" style="background:var(--amber-soft);margin-bottom:12px"><div style="flex:1"><b>🔒 投币已上锁</b><div class="small muted">${esc(ap.coinLock.reason || '')} · ${esc(String(ap.coinLock.at || '').slice(0, 16).replace('T', ' '))}</div></div><button class="btn sm" id="unlockCoin">我确认，解锁</button></div>` : ''}
        <div class="cfg-grid">
          ${tog('coin.enabled', '自动投币', ap.coinLock ? '上锁时不会投' : '只投给她点过赞的视频')}
          ${num('coin.dailyMax', '每天最多投几枚', { min: 1, max: 5 })}
        </div>
      </div>
      <div class="cfg-sec">
        <h3>养鱼日记</h3>
        <p>每晚到点她自己写今天的日记（公开动态），从她当天心里想过的话往下写，不用你每天提醒。开着「先给我审」就进待审，你下次在 QQ 说话时她会问你；关掉就直接发。</p>
        <div class="cfg-grid">
          ${sel('diary.mode', '日记方式', [['off', '不写'], ['task', '交给 QQ 里的她写'], ['llm', 'AI 起草']])}
          ${num('diary.hour', '每晚几点以后写', { min: 18, max: 23, hint: '今晚还有没刷完的时辰就等它刷完；23:30 后不等' })}
          ${tog('diary.review', 'AI 日记先给我审', '动态是公开的')}
        </div>
      </div>
      <div class="cfg-sec">
        <h3>模型（可选）${llmNote}</h3>
        <p>任意 OpenAI 兼容接口，默认 DeepSeek 官方。Key 只存在本机 <code>panel/data/secrets.json</code>，不会进 git、也不会传回页面。</p>
        <div class="cfg-box">
          <div class="sub-h">聊天模型（后台草稿、打分、日记都用它）</div>
          <div class="cfg-grid">
            <div><label class="f">接口地址</label><input data-path="llm.baseUrl" value="${esc(c.llm.baseUrl)}"></div>
            <div><label class="f">模型名</label><input data-path="llm.model" list="modelList" value="${esc(c.llm.model)}" autocomplete="off"><datalist id="modelList"></datalist><div class="hint">DeepSeek 官方填 deepseek-chat；本地网关一般是「提供方/模型」</div></div>
            <div><label class="f">API Key</label><input type="password" id="llmKey" placeholder="${ap.hasKey ? '已保存（留空不改）' : 'sk-…'}" autocomplete="new-password"></div>
          </div>
          <div class="row"><button class="btn sm" id="llmModels">列出可用模型</button><button class="btn sm" id="llmTest">测试聊天模型</button><span class="small muted" id="llmMsg"></span></div>
        </div>
        <div class="cfg-box">
          <div class="sub-h">向量模型（记忆语义检索，选填）</div>
          <div class="cfg-grid">
            <div><label class="f">接口地址</label><input data-path="llm.embeddingBaseUrl" value="${esc(c.llm.embeddingBaseUrl || '')}" placeholder="留空 = 魔搭官方" autocomplete="off"><div class="hint">任意 OpenAI 兼容的 embedding 服务都行：留空走魔搭（<code>api-inference.modelscope.cn/v1</code>），或填硅基流动 <code>https://api.siliconflow.cn/v1</code>、百炼 <code>https://dashscope.aliyuncs.com/compatible-mode/v1</code>、本地 Ollama <code>http://localhost:11434/v1</code> 等。<b>填基础地址就行</b>，带不带 <code>/embeddings</code> 都能认；DeepSeek 官方没有向量接口，别填它。</div></div>
            <div><label class="f">模型 ID</label><input data-path="llm.embeddingModel" value="${esc(c.llm.embeddingModel || '')}" placeholder="留空 = 只用关键词" autocomplete="off"><div class="hint">embedding 模型的 ID，如魔搭 <code>Qwen/Qwen3-Embedding-0.6B</code>、硅基流动 <code>BAAI/bge-large-zh-v1.5</code>、百炼 <code>text-embedding-v3</code>。留空或填错都自动退回关键词，不影响聊天。</div></div>
            <div><label class="f">向量接口密钥</label><input type="password" id="embeddingApiKey" placeholder="${ap.hasEmbedKey ? '已保存（留空不改）' : 'sk-…'}" autocomplete="new-password"><div class="hint">上面接口的 Key。留空 = 复用「QQ 连接」里的 ModelScope 令牌（走魔搭时用）。只存本机，不回传页面。</div></div>
          </div>
          <div class="row"><button class="btn sm" id="embedTest" title="真打一条向量，看接口、模型 ID 和密钥能不能用">测试向量模型</button><span class="small muted" id="embedMsg"></span><span class="small muted" style="margin-left:auto">实际请求：<code>${esc(ap.embeddingUrl)}</code></span></div>
          <div class="hint">换模型或换接口后，去 NAS 跑一次 <code>node panel/backfill-vec.mjs</code> 给旧记忆重打向量（不同模型维度不一样，旧向量对不上；可反复跑、断点续传）。</div>
        </div>
        <div class="sub-h">用量限制</div>
        <div class="cfg-grid">
          ${num('llm.dailyCalls', '后台每天最多调几次', { max: 5000, hint: '内心、评论区社交、自动评论算在里面；0 = 不限' })}
          ${num('llm.dailyTokens', '后台每天最多用多少 tokens', { max: 50000000, step: 10000, hint: '到了就按老习惯随缘刷，第二天恢复' })}
        </div>
        ${usageLine(ap.llmUsage)}
      </div>
      <div class="cfg-sec">
        <h3>💬 QQ 连接 <span id="qqState"></span></h3>
        <div class="small muted" id="qqPersona" style="padding:0 0 8px"></div>
        <p><b>官方机器人</b>：DSH + dsh-im-connect 插件，安全但限制多（只能在你说话后一小时内回，DSH 升级插件跟不上就掉线）。
        <b>她自己的小号</b>：Docker 里跑 NapCat（容器里的 QQ 登小号），面板自己当大脑，能主动找你、发真的语音，不依赖 DSH。用非官方框架，<b>小号有被冻结的风险</b>。装法见 <code>panel/qq/README.md</code>。</p>
        <div class="sub-h">连接</div>
        <div class="cfg-grid qq-grid">
          ${sel('qq.mode', '用哪个', [['official', '官方机器人（DSH 插件）'], ['onebot', '她自己的 QQ 小号（NapCat）']])}
          <div><label class="f">你的 QQ 号</label><input data-path="qq.ownerQQ" value="${esc(c.qq.ownerQQ || '')}" placeholder="她只跟你说话" autocomplete="off"></div>
        </div>
        <details class="cfg-fold only-onebot">
          <summary>NapCat 连接（小号模式，配一次就不用动）</summary>
          <div class="cfg-grid qq-grid">
            <div><label class="f">NapCat 地址</label><input data-path="qq.wsUrl" value="${esc(c.qq.wsUrl)}" autocomplete="off"><div class="hint">NapCat 里建的「WebSocket 服务器」</div></div>
            <div><label class="f">NapCat token</label><input type="password" id="onebotToken" placeholder="留空不改" autocomplete="new-password"></div>
          </div>
        </details>
        <div class="sub-h">聊天行为</div>
        <div class="cfg-grid qq-grid">
          ${sel('qq.audience', '跟谁聊', [['owner', '只认号主（别人不理，群不看）'], ['public', '公共模式（好友私聊都聊，群里被@才回）']])}
          ${tog('qq.groupAt', '群里被@时回话', '公共模式：有人@她才接话（关掉后群里@了也不吭声）')}
          ${tog('qq.groupFree', '群里没@也让她插嘴', '开了她会看大家聊天，想搭腔就搭一句，跟得上连续对话；要不要插、插多密全由她自己定（活跃群会增加模型调用量）')}
          <div><label class="f">机器人名单</label><input data-path="qq.botQQs" value="${esc(Array.isArray(c.qq.botQQs) ? c.qq.botQQs.join(', ') : c.qq.botQQs || '')}" placeholder="群里其他机器人的 QQ，逗号隔开" autocomplete="off"><div class="hint">名单里的人发消息，只有 @ 她、叫她名字、点她干活/怼她才接——几个模型在群里互相对话刷屏就是这么断掉的</div></div>
          <div><label class="f">聊天模型</label><input data-path="qq.model" value="${esc(c.qq.model || '')}" placeholder="留空 = 跟主模型同款" autocomplete="off"><div class="hint">只管她开口回话用的模型（私聊、被@、插嘴都算），想聊天用好模型、总结打分日记这些后台活继续用便宜主模型，就填这里。留空＝跟主模型一样</div></div>
          <div><label class="f">备用聊天模型</label><input data-path="qq.modelFallback" value="${esc(c.qq.modelFallback || '')}" placeholder="留空 = 不降档" autocomplete="off"><div class="hint">聊天主模型的 Key 失效、模型名/地址写错、余额不足时，自动换这个模型回话一次（会提醒你，6 小时不重复）。429/网络抖动不用它——主模型自己会重试。留空＝不降档</div></div>
          <div><label class="f">插嘴仲裁模型</label><input data-path="qq.reviewModel" value="${esc(c.qq.reviewModel || '')}" placeholder="deepseek-chat，留空 = 不仲裁" autocomplete="off"><div class="hint">插嘴打分拿不准的消息（2.8~4.8 分）先让这个便宜模型问一句「接不接」，说「不接」才拦下；留空就全放行。走主模型接口的 key，DeepSeek 官方填 deepseek-chat 就行</div><div class="row" style="margin-top:6px"><button class="btn sm" id="reviewTest">测试仲裁</button><span class="small muted" id="reviewMsg"></span></div></div>
        </div>
        <div class="hint" style="margin-top:8px">打分权重、限流、防抖这些手感参数在「<a href="#/tuning">手感调参</a>」页调，改完即存即生效。</div>
        <div class="sub-h">主动来找你</div>
        <div class="cfg-grid qq-grid">
          <div class="wide">${tog('qq.reachOut', '白天会主动找你', '隔了很久没听到你说话，她自己想要不要找你')}</div>
          <div class="qq-nums">
            ${num('qq.reachOutMax', '一天最多找几次', { max: 10 })}
            ${num('qq.silentHours', '多久没说话才找（小时）', { min: 1, max: 24 })}
            ${num('qq.activeStart', '从几点', { max: 23 })}
            ${num('qq.activeEnd', '到几点', { max: 24 })}
          </div>
        </div>
        <div class="sub-h">她的嗓音</div>
        <div class="cfg-grid qq-grid">
          ${sel('qq.ttsVoice', '她的嗓音', [
            ['', '默认（晓晓·温柔，撒娇时换音色）'],
            ['zh-CN-XiaoyiNeural', '晓伊（甜软）'],
            ['zh-CN-XiaomengNeural', '晓梦（自然松弛）'],
            ['zh-CN-XiaoqiuNeural', '晓秋（知性）'],
            ['zh-CN-XiaorouNeural', '晓柔（轻柔）'],
            ['zh-CN-XiaoxuanNeural', '晓璇（明亮活泼）'],
            ['zh-CN-XiaohanNeural', '晓涵（温暖）'],
            ['zh-CN-XiaochenNeural', '晓尘（沉稳）'],
            ['zh-CN-YunxiNeural', '云希（男声·少年）'],
            ['zh-CN-YunjianNeural', '云健（男声·有力）'],
            ['zh-CN-liaoning-XiaobeiNeural', '晓北（东北话）'],
          ], '选了就全程用这一个嗓音；选完点保存，再按「试听」听听看')}
          <div><label class="f">试听嗓音</label><div class="row"><button class="btn sm" id="voiceTest">🔊 用这个嗓音说一句</button><span class="small muted" id="voiceMsg"></span></div><div class="hint">走 edge-tts 合成，要能访问微软的接口；不满意换一个再试</div></div>
        </div>
        <div class="sub-h">💗 她对大家的好感</div>
        <div id="favList">…</div>
        <div class="hint">每天聊天的感受会攒成好感，晚上结算；不聊天不掉。名单按好感排序，人多时先看前几个。</div>
        <details class="cfg-fold">
          <summary>看图 · 做表情 · 唱歌（ModelScope / SqMusic，配一次就不用动）</summary>
          <div class="cfg-grid qq-grid">
            <div class="wide"><label class="f">看图模型</label><input data-path="qq.visionModel" value="${esc(c.qq.visionModel || '')}" placeholder="Qwen/Qwen3.5-27B，留空不看图" autocomplete="off"><div class="hint">你和好友发的图交给这个 ModelScope 视觉模型看（跟做表情共用一个访问令牌，不走主模型接口）</div><div class="row" style="margin-top:6px"><button class="btn sm" id="visionTest">测试看图</button><span class="small muted" id="visionMsg"></span></div></div>
            <div class="wide"><label class="f">梗图指纹库</label><div class="row" style="margin-top:2px"><button class="btn sm" id="memeLibBtn">翻梗图库</button><span class="small muted" id="memeLibMsg"></span></div><div id="memeLibBox"></div><div class="hint">同一张梗图第二次不再调视觉模型；看错了可以在这里改描述，改完下次命中就用新的（只存指纹和文字，不存原图）。</div></div>
            <div><label class="f">做表情用的改图模型（ModelScope）</label><input data-path="qq.dsh.imageModel" value="${esc(String(c.qq.dsh.imageModel).replace(/^modelscope\//, ''))}" autocomplete="off"><div class="hint">ModelScope 上的模型 ID</div></div>
            <div><label class="f">ModelScope 访问令牌</label><input type="password" id="modelscopeToken" placeholder="留空不改" autocomplete="new-password"><div class="hint">modelscope.cn/my/myaccesstoken 生成；账号要绑阿里云、过实名认证</div></div>
            <div><label class="f">SqMusic 地址</label><input data-path="qq.sqMusicUrl" value="${esc(c.qq.sqMusicUrl || '')}" placeholder="http://192.168.x.x:8096，留空 = 不能自己学歌" autocomplete="off"><div class="hint">SqMusic（simple_sq_music_plus，要 3.1.0 以上）的网页地址；填了之后有人点她不会的歌，她会自己下载进曲库再唱</div></div>
            <div><label class="f">SqMusic 账号 / 密码</label><div class="row"><input data-path="qq.sqMusicUser" value="${esc(c.qq.sqMusicUser || 'admin')}" autocomplete="off"><input type="password" data-path="qq.sqMusicPass" value="${esc(c.qq.sqMusicPass || '')}" placeholder="admin" autocomplete="new-password"></div><div class="hint">SqMusic 里设置的登录账号，没改过就是 admin / admin</div></div>
          </div>
        </details>
        <details class="cfg-fold">
          <summary>外挂：查资料（DSH）</summary>
          <div class="cfg-grid qq-grid">
            ${tog('qq.dsh.enabled', '外挂：查资料', '借 DSH：查资料走她专用的 DSH 配置（看图、做表情不走它，直连 ModelScope）')}
          </div>
          <div class="small muted" id="qqDsh" style="padding:0 12px 10px"></div>
        </details>
        <div class="row" style="margin-top:12px"><button class="btn sm only-onebot" id="qqTest">用小号发一条测试</button><button class="btn sm" id="qqImport">从 DSH 带记忆过来</button><span class="small muted" id="qqMsg"></span></div>
      </div>
      <div class="cfg-sec">
        <h3>📮 QQ 提醒 <span id="ntState"></span></h3>
        <p>起草好要你审的东西（今晚的日记、想发的评论、想回的话），她会在 QQ 里主动跟你说。你直接回「可以」她就发，回「改成……」就按你的改，「算了」就丢掉。
        用的是 QQ 官方机器人的<b>主动消息</b>，平台有条数限额；没发出去也没关系，下次你找她聊天时她会先问你。</p>
        <div class="cfg-grid">
          ${tog('notify.enabled', '在 QQ 里提醒我')}
          ${sel('notify.source', '用哪个机器人', [['dsh', '用 DSH 里接的那个'], ['manual', '手动填 AppID / Secret']], '凭证只在本机用，不会传回页面')}
          ${num('notify.dailyMax', '每天最多提醒几次', { min: 1, max: 10 })}
          ${num('notify.quietStart', '免打扰（从几点）', { max: 23 })}
          ${num('notify.quietEnd', '免打扰（到几点）', { max: 23 })}
          ${tog('notify.kinds.diary', '日记')}
          ${tog('notify.kinds.comment', '评论')}
          ${tog('notify.kinds.reply', '回复别人')}
        </div>
        <div class="cfg-grid" id="ntManual">
          <div><label class="f">AppSecret</label><input type="password" id="qqAppSecret" placeholder="留空不改" autocomplete="new-password"><div class="hint">QQ 开放平台 → 你的机器人 → 开发设置。DSH 不把它存成明文，这里得填一次</div></div>
          <div><label class="f">AppID</label><input id="qqAppId" placeholder="留空 = 用 DSH 的" autocomplete="off"></div>
          <div><label class="f">你的 openid</label><input id="qqOpenId" placeholder="留空 = 用 DSH 的" autocomplete="off"></div>
        </div>
        <div class="row" style="margin-top:10px"><button class="btn sm" id="ntTest">发一条测试</button><span class="small muted" id="ntMsg"></span></div>
      </div>
      <div class="cfg-sec">
        <h3>风控</h3>
        <p>遇到 -352 / -412 / -799 这类风控码，这一轮立刻停，然后歇一段时间。<br>
        点赞、分享、收藏这类动作只要被 B站 拒一次（比如 -403「账号异常」），就<b>单独暂停这个动作</b> 24 小时（连着再被拒：3 天、7 天），视频照样看。</p>
        ${(ap.blocks || []).map((b) => `<div class="live" style="background:var(--amber-soft);margin-bottom:8px"><div style="flex:1"><b>⏸ ${esc(b.name)}暂停到 ${new Date(b.until).toLocaleString('zh-CN', { hour12: false }).slice(5, -3)}</b><div class="small muted">B站 回的是「${esc(b.error)}」· 第 ${b.strikes} 次</div></div><button class="btn sm" data-unblock="${esc(b.kind)}">恢复</button></div>`).join('')}
        <div class="cfg-grid">${num('cooldownMin', '冷却多久（分钟）', { min: 10, max: 1440 })}</div>
      </div>
      <div class="save-bar"><button class="btn primary" id="saveCfg">保存设置</button></div>
     </div>
     <div>
      <div class="card"><div class="card-h"><h2>今天的计划</h2><button class="btn sm" id="replan" title="重抽还没跑的时辰时间点，并重排它们的类型和意图">重新抽签</button></div>
        ${(ap.plan || []).length ? `<ul class="tl">${ap.plan.map((s) => `<li><div class="time num">${hm(s.at)}</div><div class="ico">${{ done: '✅', skipped: '💤', missed: '🌙', running: '🐟', failed: '⚠️', pending: '⏳' }[s.status] || '•'}</div>
          <div class="body"><div class="x">${esc(s.label)}</div><div class="m">${{ done: '刷完了', skipped: '随机偷懒', missed: '错过了（电脑睡着）', running: '正在刷', failed: '中断', pending: '等着' }[s.status] || s.status}${s.type ? ' · ' + ({ browse: '随缘刷', browse_like: '刷+点赞', comment: '刷+评论', diary: '写日记', check: '看消息', rest: '歇着', reflect_self: '想想事', idle_wander: '发呆' }[s.type] || s.type) : ''}${s.goal ? `「${esc(s.goal)}」` : ''}${s.replanned ? '（重排过）' : ''}${s.summary ? ' · ' + esc(s.summary) : ''}</div></div></li>`).join('')}</ul>` : '<div class="empty">没有选时辰</div>'}
        <div class="hint">${c.enabled ? '' : '⚠️ 总开关还没开，计划不会执行。'}</div>
      </div>
      <div style="height:16px"></div>
      <div class="card" id="vipCard"><div class="card-h"><h2>⭐ 特别关注</h2></div><div class="empty">加载中…</div></div>
      <div style="height:16px"></div>
      <div class="card" id="socialCard"></div>
      <div style="height:16px"></div>
      <div class="card"><div class="card-h"><h2>为什么这样设计</h2></div>
        <div class="small" style="color:var(--text2)">
          <p style="margin-top:0">· <b>经验上限是死的</b>：登录 5 + 观看 5 + 分享 5 + 投币 ≤ 50。不投币时一天最多 15，刷再多也没用，反而像机器人。</p>
          <p>· <b>Lv6 要 28800 经验</b>，按每天 15 大约 5 年，每天投 1 枚币（25/天）约 3 年。没有捷径，「快速升级」的都是在拿号冒险。</p>
          <p>· <b>节操值 70</b> 是正式会员的常见值。保持它的关键是：不发违规内容、不被举报、不刷屏。</p>
          <p style="margin-bottom:0">· 所有动作都带随机间隔和随机时长，每天总量很小，接近一个普通人下班刷十几分钟B站。</p>
        </div>
      </div>
     </div>
    </div>`;

  $$('#dialPick .h').forEach((h) => (h.onclick = () => {
    const k = h.dataset.k;
    c.windows = c.windows.includes(k) ? c.windows.filter((x) => x !== k) : [...c.windows, k];
    h.classList.toggle('sel');
  }));
  const tags = $('#tags');
  tags.onclick = (e) => { const t = e.target.closest('[data-t]'); if (t) { c.interests = c.interests.filter((x) => x !== t.dataset.t); t.remove(); } };
  $('#tagIn').onkeydown = (e) => {
    if (e.key !== 'Enter') return;
    const v = e.target.value.trim();
    if (v && !c.interests.includes(v)) {
      c.interests.push(v);
      e.target.insertAdjacentHTML('beforebegin', `<span class="chip blue" data-t="${esc(v)}">${esc(v)} ×</span>`);
    }
    e.target.value = '';
  };
  const collect = () => {
    for (const el of $$('[data-path]', main)) {
      const keys = el.dataset.path.split('.');
      let o = c;
      for (const k of keys.slice(0, -1)) o = o[k];
      const last = keys[keys.length - 1];
      if (el.type === 'checkbox') o[last] = el.checked;
      else if (el.type === 'number') o[last] = el.dataset.pct ? Number(el.value) / 100 : Number(el.value);
      else o[last] = el.value;
    }
    if (c.session.videosMin > c.session.videosMax) c.session.videosMax = c.session.videosMin;
    if (c.session.watchRatioMin > c.session.watchRatioMax) c.session.watchRatioMax = c.session.watchRatioMin;
    const order = ap.shichen.map((s) => s.key);
    c.windows.sort((a, b) => order.indexOf(a) - order.indexOf(b));
    return c;
  };
  const save = async (extra = {}) => {
    const body = { ...collect(), ...extra };
    if (body.vip) delete body.vip.users; // 名单走单独的接口，别被这个页面里的旧名单覆盖
    const k = $('#llmKey').value.trim();
    if (k) body.llmApiKey = k;
    for (const id of ['qqAppId', 'qqAppSecret', 'qqOpenId', 'onebotToken', 'modelscopeToken', 'embeddingApiKey', 'amapKey']) {
      const v = $('#' + id)?.value.trim();
      if (v) body[id] = v;
    }
    await api('/api/autopilot/config', body);
  };
  $('#saveCfg').onclick = (e) => busy(e.target, async () => { await save(); toast('设置已保存'); route(); });
  $('[data-path="enabled"]', main).onchange = (e) => busy(null, async () => { await save({ enabled: e.target.checked }); toast(e.target.checked ? '自动养号已打开' : '已关闭'); route(); });
  $('#replan').onclick = (e) => busy(e.target, async () => { await save(); await api('/api/autopilot/replan', {}); toast('重抽好了，没跑的时辰连类型和意图一起重排'); route(); });
  // 测试前先保存，测的就是框里现在填的
  $('#llmTest').onclick = (e) => busy(e.target, async () => {
    await save();
    const r = await api('/api/autopilot/llm-test', {});
    $('#llmMsg').textContent = '✓ 聊天模型连上了，回复：' + r.reply;
    toast('聊天模型连上了');
  });
  // 向量连通：先保存（测的是刚填的向量模型名），再真打一条 embedding。
  // 未配 / 接口挂了时后端返回 ok:false + 人话原因，这里照原样显示，别吞掉。
  // 结果写进独立的 #embedMsg，别跟聊天模型的 #llmMsg 串台。
  $('#embedTest').onclick = (e) => busy(e.target, async () => {
    await save();
    $('#embedMsg').textContent = '正在测向量模型…';
    const r = await api('/api/autopilot/embed-test', {});
    $('#embedMsg').textContent = r.ok
      ? `✓ 向量通了：${r.dim} 维，耗时 ${r.ms} ms（配好后记得去 NAS 跑一次 backfill-vec）`
      : `✗ ${r.error}`;
    if (r.ok) toast('向量模型连上了');
  });
  $('#reviewTest').onclick = (e) => busy(e.target, async () => {
    await save(); // 测的就是框里现在填的
    const r = await api('/api/qq/review-test', {});
    $('#reviewMsg').textContent = `✓ ${r.model} 通了：样例「${r.sample}」打了 ${r.score} 分（${r.status} 档），仲裁说「${r.join ? '接' : '不接'}」`;
    toast('插嘴仲裁已生效');
  });
  $('#visionTest').onclick = (e) => busy(e.target, async () => {
    await save(); // 测的就是框里现在填的
    const r = await api('/api/qq/vision-test', {});
    $('#visionMsg').textContent = r.expect
      ? `✓ ${r.model}：把测试图看成「${r.desc}」${r.hit ? '，字认对了' : `，没认出「${r.expect}」，这个模型认字不行`}`
      : `✓ ${r.model} 通了：看成「${r.desc}」（测试图没字，只测了连通）`;
    toast(r.hit || !r.expect ? '看图正常' : '看图通了，但认字不准');
  });
  // 梗图指纹库：看错了能改描述（只存指纹+文字，不存原图）
  const loadMemeLib = async () => {
    const r = await api('/api/meme-lib'); // GET：传 {} 会走 POST，后端只有 GET 路由，会 404
    const entries = r.entries || [];
    const box = $('#memeLibBox');
    $('#memeLibMsg').textContent = entries.length ? `共 ${entries.length} 张` : '';
    box.innerHTML = entries.length
      ? `<ul class="vip-list">${entries.slice(0, 50).map((e) => `<li><div style="flex:1;min-width:0" class="small">${e.textOnImage ? `<b>「${esc(e.textOnImage)}」</b> ` : ''}${esc(e.desc || e.scene || '')}<div class="muted">见过 ${e.count || 1} 次${e.peers?.length ? ` · ${esc(e.peers.slice(-2).join('、'))}` : ''} · ${esc(String(e.hash || '').slice(0, 8))}</div></div><button class="btn sm ghost" data-ml-edit="${esc(e.hash)}">✎</button><button class="btn sm ghost" data-ml-del="${esc(e.hash)}">✕</button></li>`).join('')}</ul>${entries.length > 50 ? '<div class="small muted">只列最近 50 张</div>' : ''}`
      : '<div class="empty">还没存过梗图</div>';
    $$('[data-ml-edit]', box).forEach((b) => (b.onclick = () => busy(b, async () => {
      const e = entries.find((x) => x.hash === b.dataset.mlEdit);
      const desc = prompt('改成什么？（保留「图上文字：…；」开头，下次她查梗百科还用得上）', e?.desc || '');
      if (desc === null) return;
      await api('/api/meme-lib/update', { hash: b.dataset.mlEdit, desc });
      await loadMemeLib();
      toast('改好了');
    })));
    $$('[data-ml-del]', box).forEach((b) => (b.onclick = () => busy(b, async () => {
      if (!confirm('从梗图库删掉这张？下次再发会重新看一遍。')) return;
      await api('/api/meme-lib/delete', { hash: b.dataset.mlDel });
      await loadMemeLib();
    })));
  };
  $('#memeLibBtn').onclick = (e) => busy(e.target, loadMemeLib);
  $('#llmModels').onclick = (e) => busy(e.target, async () => {
    await save();
    const { models } = await api('/api/autopilot/llm-models', {});
    $('#modelList').innerHTML = models.map((m) => `<option value="${esc(m)}">`).join('');
    $('#llmMsg').textContent = models.length ? `有 ${models.length} 个模型，点「模型名」输入框就能选` : '接口没返回模型列表，只能手填';
    const inp = $('[data-path="llm.model"]', main);
    if (models.length && !models.includes(inp.value.trim())) { inp.value = ''; inp.focus(); }
  });
  $$('[data-unblock]', main).forEach((b) => (b.onclick = async () => {
    if (!(await confirmBox('恢复这个动作？', 'B站 刚拒过它。恢复后如果再被拒，会暂停更久。', '恢复'))) return;
    busy(b, async () => { await api('/api/blocks/clear', { kind: b.dataset.unblock }); toast('已恢复'); route(); });
  }));
  renderVipCard($('#vipCard'));
  renderSocialCard($('#socialCard'), ap.social);
  // QQ 提醒
  const ntRefresh = () => api('/api/notify').then((n) => {
    $('#ntState').innerHTML = n.ready ? '<span class="chip green">机器人可用</span>' : `<span class="chip amber">${esc(n.why || '未配置')}</span>`;
    const last = n.log[0];
    $('#ntMsg').textContent = `今天提醒了 ${n.sentToday} 次` +
      (n.direct ? ' · 用小号发，随时能说' : n.windowOpen ? ` · 回复窗口开着（到 ${hm(n.windowUntil)}）` : ' · 你最近一小时没在 QQ 说话，提醒会等你开口再发') +
      (n.pending ? ` · ${n.pending} 条排队中` : '') +
      (last ? ` · 最近一次${last.ok ? '成功' : '失败：' + (last.error || '')}` : '');
  }).catch(() => {});
  ntRefresh();
  $('#ntTest').onclick = (e) => busy(e.target, async () => {
    await save();
    await api('/api/notify/test', {});
    toast('发出去了，看看 QQ');
    ntRefresh();
  });
  // QQ 连接
  const qqRender = (q) => {
    $('#qqState').innerHTML = q.mode !== 'onebot' ? '<span class="chip">官方机器人</span>'
      : q.connected ? `<span class="chip green">小号在线 ${esc(String(q.selfId || ''))}</span>` : `<span class="chip amber">${q.on ? '小号没连上' : '还没填你的 QQ 号'}</span>`;
    $('#qqMsg').textContent = q.mode === 'onebot' ? [q.error && !q.connected ? `上次的错：${q.error}` : '', q.lastOwnerAt ? `你上次说话 ${ago(q.lastOwnerAt)}` : ''].filter(Boolean).join(' · ') : '';
    const pi = q.persona;
    if (pi) $('#qqPersona').innerHTML = pi.fallback
      ? '<span class="chip amber">没读到角色卡，在用 AGENTS.md 顶着——检查卡是不是传错了位置</span>'
      : pi.sections < 8 // 2026-11-09 卡重写后就是 8 节（三节说话规矩并成一节）；卡再改结构时这里要跟着动
        ? `<span class="chip amber">角色卡只抓到 ${pi.sections} 节（该有 8 节），可能传了旧版或缺节</span>`
        : `人格卡：${pi.sections} 节 · ${pi.chars} 字 · 改于 ${esc(pi.updated)}${pi.patch ? ` · 进化补丁 ${pi.patch} 字` : ''}`;
    const d = q.dsh || {};
    $('#qqDsh').textContent = !d.enabled ? '外挂关着' : !d.cli ? '⚠️ 没找到 DSH 的命令行，查资料用不了' : !d.profile ? `⚠️ DSH 里还没有「她专用」的配置，查资料用不了（见 panel/qq/README.md）` : `外挂就绪：查资料走她专用的 DSH · ${d.hasModelscopeToken ? '做表情包：令牌已填' : '做表情包：还没填 ModelScope 令牌'}${d.stickerOn ? ` · 今天（${d.stickerOn}）做过新表情了` : ''}`;
    // 「她记得的关于你的事」搬到记忆页了（pageMemory 的「关于你的事」标签，可以切换着看）
  };
  api('/api/qq').then(qqRender).catch(() => {});
// 好感分级：文案跟 fav.mjs 的 feel() 保持一致，面板上看到的和她心里想的对得上
const favTier = (f) =>
  f >= 80 ? { label: '很喜欢', chip: 'pink', grad: 'linear-gradient(135deg,#ff9fbd,#f45d8c)' } :
  f >= 65 ? { label: '挺喜欢', chip: 'pink', grad: 'linear-gradient(135deg,#ffb0c6,#f87ba2)' } :
  f >= 50 ? { label: '有些好感', chip: 'blue', grad: 'linear-gradient(135deg,#7db5ff,#2f7cf6)' } :
  f >= 35 ? { label: '有点烦', chip: 'amber', grad: 'linear-gradient(135deg,#f2c96b,#c98200)' } :
  { label: '挺嫌弃', chip: 'red', grad: 'linear-gradient(135deg,#ff9a9f,#e0444f)' };
// 最近半个月的走势小折线
const favSpark = (vals) => {
  const v = vals.filter((x) => typeof x === 'number').slice(-14);
  if (v.length < 2) return { svg: '', trend: v.length ? String(v[v.length - 1]) : '—' };
  const lo = Math.min(...v), hi = Math.max(...v);
  const pts = v.map((x, i) => `${Math.round((i / (v.length - 1)) * 54 + 3)},${Math.round(15 - (hi === lo ? 0.5 : (x - lo) / (hi - lo)) * 12)}`).join(' ');
  return { svg: `<svg class="fav-spark" viewBox="0 0 60 18" aria-hidden="true"><polyline points="${pts}"/></svg>`, trend: v.join(' → ') };
};
let favAll = false; // 好感名单展开状态：人多了默认只看前几个，点一下再看全部
const FAV_PAGE = 8;
const favRender = async () => {
  const box = $('#favList');
  if (!box) return;
  try {
    const [r, qcfg] = await Promise.all([api('/api/fav'), api('/api/qq').catch(() => ({}))]);
    const oq = String(qcfg?.ownerQQ ?? qcfg?.qq?.ownerQQ ?? '');
    const us = Object.entries(r.users || {}).sort((a, b) => (b[1].fav || 0) - (a[1].fav || 0));
    const shown = favAll ? us : us.slice(0, FAV_PAGE);
    box.innerHTML = us.length ? shown.map(([qq, u]) => {
      const f = Math.max(0, Math.min(100, u.fav || 0));
      const t = favTier(f);
      const dl = (u.today && u.today.deltas) || [];
      const net = dl.reduce((sm, x) => sm + (x.d || 0), 0);
      const today = net ? ` <b class="${net > 0 ? 'up' : 'down'}">${net > 0 ? '+' + net : String(net)}</b>` : '';
      // 单句明细：平时只露最近 3 条（±分 + 她给的原因），悬停看全天每一笔
      const one = (x) => `${x.d > 0 ? '+' : ''}${x.d} ${x.why || ''}`.trim();
      const at = (x) => (x.t ? `${new Date(x.t).toTimeString().slice(0, 5)} ` : '');
      const detail = dl.length ? `<span class="small muted" title="${esc(dl.map((x) => at(x) + one(x)).join('\n'))}">· ${esc(dl.slice(-3).map(one).join('、'))}${dl.length > 3 ? ` 等 ${dl.length} 笔` : ''}</span>` : '';
      const sp = favSpark((u.history || []).map((h) => h.favAfter));
      const mine = String(qq) === oq ? '<span class="chip violet">号主</span>' : '';
      return `<div class="fav-row" title="QQ ${esc(String(qq))} · 最近：${esc(sp.trend)}">
<span class="fav-av" style="background:${t.grad}">${esc((u.nickname || String(qq))[0] || '鱼')}</span>
<div class="fav-main">
<div class="fav-top"><b class="fav-name">${esc(u.nickname || String(qq))}</b>${mine}<span class="chip ${t.chip}">${t.label}</span></div>
<div class="fav-bar"><i style="width:${f}%;background:${t.grad}"></i></div>
<div class="fav-meta"><b class="num">${f}</b><span class="pct">%</span>${today}${detail}<span>· 认识 ${u.activeDays || 1} 天</span>${sp.svg}</div>
</div>
</div>`;
    }).join('') + (us.length > FAV_PAGE ? `<button class="btn sm ghost" id="favToggle" style="margin-top:6px">${favAll ? '收起' : `展开全部（还有 ${us.length - FAV_PAGE} 人）`}</button>` : '') : '<div class="empty"><span class="fish">🐟</span>她还没记过谁</div>';
    const tg = $('#favToggle'); if (tg) tg.onclick = () => { favAll = !favAll; favRender(); };
  } catch (e) { box.textContent = ' '; }
};
favRender();

  // 官方模式藏掉小号专属的（NapCat 折叠块、测试按钮），切回小号模式再露出来
  const qqModeVis = () => {
    const onebot = $('[data-path="qq.mode"]', main)?.value === 'onebot';
    document.querySelectorAll('.only-onebot').forEach((el) => { el.style.display = onebot ? '' : 'none'; });
  };
  $('[data-path="qq.mode"]', main)?.addEventListener('change', qqModeVis);
  qqModeVis();

  $('#qqTest').onclick = (e) => busy(e.target, async () => {
    await save();
    await new Promise((r) => setTimeout(r, 1500)); // 刚改设置的话等它连上
    await api('/api/qq/test', {});
    toast('发出去了，看看 QQ');
    qqRender(await api('/api/qq'));
  });
  $('#qqImport').onclick = (e) => busy(e.target, async () => {
    const r = await api('/api/qq/import-dsh', {});
    toast(r.why || `带过来 ${r.added} 条，现在一共记得 ${r.total} 条`);
    qqRender(r);
  });
  $('#voiceTest').onclick = (e) => busy(e.target, async () => {
    const msg = $('#voiceMsg');
    try {
      msg.textContent = '合成中…';
      const v = document.querySelector('[data-path="qq.ttsVoice"]')?.value || '';
      const r = await api('/api/qq/voice-test', { voice: v });
      await new Audio(`data:audio/mpeg;base64,${r.audio}`).play();
      msg.textContent = '就是刚才这句';
    } catch (e2) { msg.textContent = e2.message.includes('音频') ? '微软接口没连上' : '没成：' + e2.message; }
  });
  const un = $('#unlockCoin');
  if (un) un.onclick = async () => {
    if (!(await confirmBox('解锁投币？', '之前接口投币失败过。解锁后如果再失败会自动重新上锁。\n建议先在浏览器里确认这个号投币正常，再解锁。', '解锁'))) return;
    busy(un, async () => { await api('/api/coin/unlock', {}); toast('已解锁'); route(); });
  };
}

// ─── 扫码登录 ──────────────────────────────────────────────
function renderLoginBanner(acct) {
  let el = $('#loginBanner');
  const out = acct && !acct.loggedIn;
  if (!out) { el?.remove(); return; }
  if (!el) {
    el = document.createElement('div');
    el.id = 'loginBanner';
    el.className = 'login-banner';
    document.body.prepend(el);
  }
  el.innerHTML = '⚠️ B站 掉登录了，自动养号和所有操作都停着 <button class="btn sm primary">扫码登录</button>';
  $('button', el).onclick = () => openLogin();
  const f = $('#footLogin');
  if (f) f.onclick = (e) => { e.preventDefault(); openLogin(); };
}

// QQ 接入断了（DSH 升级后插件跟不上、网关没起来）：她在 QQ 里没法告诉你，只能挂在这儿
function renderHealthBanner(h) {
  let el = $('#healthBanner');
  if (!h || h.ok) { el?.remove(); return; }
  if (!el) {
    el = document.createElement('div');
    el.id = 'healthBanner';
    el.className = 'login-banner';
    document.body.prepend(el);
  }
  el.innerHTML = h.problems.map((p) => `<span>⚠️ ${esc(p.text)}<br><span class="small" style="font-weight:400">${esc(p.fix)}</span></span>`).join('')
    + ' <button class="btn sm">修好了，再查一次</button>';
  $('button', el).onclick = (e) => busy(e.target, async () => { renderHealthBanner(await api('/api/health?fresh=1')); });
}

let loginTimer = null;
async function openLogin() {
  openDrawer('扫码登录 B站', '<div class="empty">取二维码…</div>');
  clearTimeout(loginTimer);
  let q;
  try { q = await api('/api/login/qr', {}); } catch (e) { $('#drawerBody').innerHTML = `<div class="err">${esc(e.message)}</div>`; return; }
  $('#drawerBody').innerHTML = `
    <div class="qr-box">
      <div class="qr">${q.svg}</div>
      <div id="qrMsg" class="qr-msg">用手机 <b>B站 App</b> 扫一扫（首页左上角头像旁边 / 「我的」右上角），然后点确认登录</div>
      <div class="hint">要登录的是她的号「yeson的在逃肥鱼公主」，别扫成你自己的号。二维码大约 3 分钟过期。</div>
      <button class="btn sm" id="qrNew" style="margin-top:10px">换一张</button>
    </div>`;
  $('#qrNew').onclick = () => openLogin();
  const poll = async () => {
    if (!$('#drawer').classList.contains('show') || !$('#qrMsg')) return; // 抽屉关了就别再查
    let r;
    try { r = await api('/api/login/poll?key=' + encodeURIComponent(q.key)); } catch (e) { r = { status: 'waiting', net: e.message }; }
    const msg = $('#qrMsg');
    if (!msg) return;
    if (r.status === 'ok') {
      msg.innerHTML = '✅ 登录成功！';
      toast('重新登录好了');
      setTimeout(() => { closeDrawer(); route(); }, 900);
      return;
    }
    if (r.status === 'expired' || Date.now() > q.expiresAt + 10_000) {
      msg.innerHTML = '二维码过期了 <button class="btn sm primary" id="qrAgain">再来一张</button>';
      $('#qrAgain').onclick = () => openLogin();
      $('.qr').style.opacity = 0.25;
      return;
    }
    if (r.status === 'scanned') msg.innerHTML = '📱 扫到了，在手机上点「确认登录」';
    if (r.status === 'error') msg.innerHTML = `<span style="color:var(--red)">${esc(r.message)}</span> <button class="btn sm" id="qrAgain">重来</button>`;
    if (r.status === 'error') { $('#qrAgain').onclick = () => openLogin(); return; }
    loginTimer = setTimeout(poll, 2000);
  };
  loginTimer = setTimeout(poll, 2000);
}

// ─── 特别关注名单 ──────────────────────────────────────────
function renderSocialCard(el, s) {
  if (!el || !s) return;
  const when = (t) => (t ? new Date(t).toLocaleString('zh-CN', { hour12: false }).slice(5, -3) : '—');
  el.innerHTML = `<div class="card-h"><h2>🗨️ 评论区的熟人</h2><button class="btn sm" id="socialCheck" ${s.on ? '' : 'disabled'}>现在看一眼回复</button></div>
    <div class="small muted" style="margin-bottom:8px">今天搭话 ${s.today.join} · 回复 ${s.today.reply} · 上次看 ${when(s.lastCheck)} · 下次约 ${when(s.nextCheck)}${s.busy ? ' · 正在看…' : ''}</div>
    ${s.people.length ? `<ul class="vip-list">${s.people.map((p) => `<li><a href="https://space.bilibili.com/${esc(p.uid)}" target="_blank" rel="noopener">${esc(p.name)}</a><span class="small muted">聊过 ${p.n} 次 · ${when(p.last)}</span></li>`).join('')}</ul>` : '<div class="empty">还没跟谁聊过</div>'}`;
  const btn = $('#socialCheck', el);
  if (btn) btn.onclick = (e) => busy(e.target, async () => { const r = await api('/api/social/check', {}); toast(r.note); renderSocialCard(el, r.social); });
}

async function renderVipCard(el, data) {
  if (!el) return;
  let vip;
  let users;
  try {
    [vip, users] = data ? [data, data.users] : await Promise.all([api('/api/vip'), api('/api/vip/users').then((r) => r.users)]);
    users ??= (await api('/api/vip/users')).users;
  } catch (e) { el.innerHTML = `<div class="card-h"><h2>⭐ 特别关注</h2></div><div class="err">${esc(e.message)}</div>`; return; }
  if (!el.isConnected) return;
  const q = vip.queue || [];
  el.innerHTML = `<div class="card-h"><h2>⭐ 特别关注</h2><button class="btn sm" id="vipImport" title="把你在 B站 设的「特别关注」分组导进来">从B站导入</button></div>
    <div class="row" style="margin-bottom:10px"><input id="vipIn" placeholder="UID 或空间链接" style="flex:1;min-width:0"><button class="btn sm primary" id="vipAdd">添加</button></div>
    ${users.length ? `<ul class="vip-list">${users.map((u) => `<li>
        <img src="${esc(img(u.face, '48w_48h'))}" alt="" onerror="this.style.visibility='hidden'">
        <div style="flex:1;min-width:0"><a href="https://space.bilibili.com/${esc(u.uid)}" target="_blank" rel="noopener"><b>${esc(u.name)}</b></a>
          <div class="small muted">${esc(u.uid)} · ${u.following === false ? '<span style="color:var(--amber)">还没关注，动态流里看不到 TA</span>' : u.following ? '已关注' : '关注状态未知'}</div></div>
        ${u.following === false ? `<button class="btn sm" data-follow="${esc(u.uid)}" data-name="${esc(u.name)}">关注</button>` : ''}
        <button class="btn sm ghost" data-rm="${esc(u.uid)}" title="移出特别关注">×</button></li>`).join('')}</ul>` : '<div class="empty small">还没有人。加个 UID，或者从 B站 的特别关注分组导入。</div>'}
    <div class="small muted" style="margin-top:10px">${!vip.autopilotOn ? '⚠️ 自动养号没开，不会自己去查' : vip.lastCheck ? `上次查看 ${ago(vip.lastCheck)}${vip.nextCheck ? ` · 下次约 ${hm(vip.nextCheck)}` : ''}` : '还没查过'} · 今天追了 ${vip.doneToday}/${vip.config.dailyMax}</div>
    ${q.length ? `<div class="vip-q">${q.map((x) => x.type === 'video'
        ? `<div>📺 <a href="#" data-open="${esc(x.bvid)}">${esc(x.title)}</a> <span class="muted">· ${esc(x.name)}${x.why ? ' · ' + esc(x.why) : ''}</span></div>`
        : `<div>👍 <span class="muted">${esc(x.name)} 的动态：</span>${esc(x.text || '（图片）')}</div>`).join('')}
      ${vip.runAt ? `<div class="small muted">打算 ${hm(vip.runAt)} 去看</div>` : ''}</div>` : ''}
    <div class="row" style="margin-top:10px"><button class="btn sm" id="vipCheck">现在查一下</button>${q.length ? '<button class="btn sm primary" id="vipRun">现在就去看</button>' : ''}</div>`;

  const redraw = (r) => renderVipCard(el, r.users ? r : undefined);
  $('#vipAdd', el).onclick = (e) => busy(e.target, async () => {
    const r = await api('/api/vip/add', { uid: $('#vipIn', el).value });
    toast('加进特别关注了');
    redraw(r);
  });
  $('#vipIn', el).onkeydown = (e) => { if (e.key === 'Enter') $('#vipAdd', el).click(); };
  $('#vipImport', el).onclick = (e) => busy(e.target, async () => {
    const r = await api('/api/vip/import', {});
    toast(r.total ? `B站 分组里有 ${r.total} 个，新导入 ${r.imported} 个` : 'B站 的特别关注分组是空的');
    redraw(r);
  });
  $$('[data-rm]', el).forEach((b) => (b.onclick = () => busy(b, async () => redraw(await api('/api/vip/remove', { uid: b.dataset.rm })))));
  $$('[data-follow]', el).forEach((b) => (b.onclick = () => busy(b, async () => {
    await api('/api/vip/follow', { uid: b.dataset.follow, name: b.dataset.name });
    toast('关注了');
    renderVipCard(el);
  })));
  $$('[data-open]', el).forEach((a) => (a.onclick = (e) => { e.preventDefault(); openVideo(a.dataset.open); }));
  $('#vipCheck', el).onclick = (e) => busy(e.target, async () => {
    const r = await api('/api/vip/check', {});
    toast(r.found ? `发现 ${r.found} 条新动态` : '没有新东西');
    renderVipCard(el);
  });
  const run = $('#vipRun', el);
  if (run) run.onclick = () => busy(run, async () => { await api('/api/vip/run', {}); toast('她去看特别关注了，进度在总览里'); });
}

// ─── 刷视频 ────────────────────────────────────────────────
async function pageExplore(main) {
  const tab = (S.exTab ||= 'feed');
  main.innerHTML = head('刷视频', '在这里看到的和她看到的一样；点开视频可以让她去看、点赞、评论') +
    `<div class="card">
      <div class="filters">
        <div class="seg" id="exSeg">${[['feed', '首页推荐'], ['hot', '热门'], ['search', '搜索'], ['history', '观看历史']].map(([k, n]) => `<button data-v="${k}" class="${tab === k ? 'on' : ''}">${n}</button>`).join('')}</div>
        <span class="spacer"></span>
        <div class="row" id="exSearch" style="display:${tab === 'search' ? 'flex' : 'none'}"><input id="kw" placeholder="搜点什么" value="${esc(S.kw || '')}" style="width:220px"><button class="btn primary" id="kwGo">搜索</button></div>
        <button class="btn" id="exReload">换一批</button>
        <div class="row"><input id="bvIn" placeholder="BV号直达" style="width:150px"><button class="btn" id="bvGo">打开</button></div>
      </div>
      <div id="exOut"><div class="empty">加载中…</div></div>
    </div>`;
  const out = $('#exOut');
  const card = (v, extra = '') => `<div class="vcard" data-bvid="${esc(v.bvid)}">
      <div class="cover"><img src="${esc(img(v.pic, '336w_210h_1c'))}" loading="lazy" alt="" onerror="this.style.visibility='hidden'">
        ${v.duration || v.durationSec ? `<span class="dur">${fmtDur(v.duration || v.durationSec)}</span>` : ''}${extra}</div>
      <div class="tt">${esc(v.title)}</div>
      <div class="mm">${esc(v.owner || v.author || '')}${v.view != null ? ' · ▶ ' + fmtNum(v.view) : ''}</div></div>`;
  const load = async () => {
    out.innerHTML = '<div class="empty">加载中…</div>';
    try {
      if (S.exTab === 'search') {
        if (!S.kw) { out.innerHTML = '<div class="empty">输入关键词搜一搜</div>'; return; }
        const r = await api('/api/search?q=' + encodeURIComponent(S.kw));
        out.innerHTML = r.list.length ? `<div class="vgrid">${r.list.map((v) => card(v)).join('')}</div>` : '<div class="empty">没搜到</div>';
      } else if (S.exTab === 'history') {
        const r = await api('/api/history');
        out.innerHTML = r.list.length ? `<div class="vgrid">${r.list.map((v) => {
          const p = v.progress < 0 ? 100 : v.duration ? Math.min(100, (v.progress / v.duration) * 100) : 0;
          return card({ ...v, view: null, owner: `${v.owner} · ${ago(v.viewAt)} · ${v.progress < 0 ? '看完了' : '看到 ' + fmtSec(v.progress)}` }, `<span class="prog" style="width:${p}%"></span>`);
        }).join('')}</div>` : '<div class="empty">B站历史记录是空的</div>';
      } else {
        const r = await api(S.exTab === 'hot' ? '/api/hot' : '/api/feed');
        out.innerHTML = `<div class="vgrid">${r.list.map((v) => card(v)).join('')}</div>`;
      }
    } catch (e) { out.innerHTML = `<div class="err">${esc(e.message)}</div>`; }
  };
  $$('#exSeg button').forEach((b) => (b.onclick = () => {
    S.exTab = b.dataset.v;
    $$('#exSeg button').forEach((x) => x.classList.toggle('on', x === b));
    $('#exSearch').style.display = S.exTab === 'search' ? 'flex' : 'none';
    load();
  }));
  const doSearch = () => { S.kw = $('#kw').value.trim(); load(); };
  $('#kwGo').onclick = doSearch;
  $('#kw').onkeydown = (e) => e.key === 'Enter' && doSearch();
  $('#exReload').onclick = load;
  const bv = () => { const v = $('#bvIn').value.trim().match(/BV[0-9A-Za-z]{10}/); v ? openVideo(v[0]) : toast('BV 号不对', 'err'); };
  $('#bvGo').onclick = bv;
  $('#bvIn').onkeydown = (e) => e.key === 'Enter' && bv();
  load();
}

// ─── 视频抽屉 ──────────────────────────────────────────────
function openDrawer(title, html) {
  $('#drawerTitle').textContent = title;
  $('#drawerBody').innerHTML = html;
  $('#drawer').classList.add('show');
  $('#drawerMask').classList.add('show');
  $('#drawerBody').scrollTop = 0;
}
function closeDrawer() { $('#drawer').classList.remove('show'); $('#drawerMask').classList.remove('show'); }
$('#drawerMask').onclick = closeDrawer;
$('#drawerClose').onclick = closeDrawer;
document.addEventListener('keydown', (e) => e.key === 'Escape' && closeDrawer());

function cmtHtml(c, ctx) {
  return `<div class="cmt"><img class="av" src="${esc(img(c.face, '68w_68h'))}" alt="" loading="lazy" onerror="this.style.visibility='hidden'">
    <div style="min-width:0"><div class="u">${esc(c.user)} <span class="muted">${c.ctime ? ago(c.ctime) : ''} · 👍 ${fmtNum(c.like)}</span></div>
      <div class="c">${esc(c.text)}</div>
      ${c.subs?.length ? `<div class="subs">${c.subs.map((s) => `<div><b>${esc(s.user)}</b>：${esc(s.text)}</div>`).join('')}${c.subCount > c.subs.length ? `<div class="muted">共 ${c.subCount} 条回复</div>` : ''}</div>` : ''}
      <div class="acts"><button class="btn sm ghost" data-reply="${esc(c.rpid)}" data-user="${esc(c.user)}" data-text="${esc(c.text.slice(0, 200))}">回复</button></div>
      <div class="reply-box" id="rb-${esc(c.rpid)}"></div>
    </div></div>`;
}

/** 通用回复框：AI 起草（可选）+ 发送。onSend(text) 返回 Promise */
function composer(el, { placeholder, context, message, kind = 'comment', onSend }) {
  if (el.innerHTML) { el.innerHTML = ''; return; }
  el.innerHTML = `<div class="composer"><textarea placeholder="${esc(placeholder)}"></textarea>
    <div class="row" style="margin-top:8px"><button class="btn sm" data-ai>✨ 让她想一句</button><span class="spacer"></span><button class="btn sm ghost" data-cancel>取消</button><button class="btn sm primary" data-send>发送</button></div></div>`;
  const ta = $('textarea', el);
  ta.focus();
  $('[data-cancel]', el).onclick = () => (el.innerHTML = '');
  $('[data-ai]', el).onclick = (e) => busy(e.target, async () => {
    const r = await api('/api/ai/reply', { context, message, kind });
    ta.value = r.text;
  });
  $('[data-send]', el).onclick = (e) => busy(e.target, async () => {
    const t = ta.value.trim();
    if (!t) throw new Error('写点什么再发');
    await onSend(t);
    el.innerHTML = '';
  });
}

async function openVideo(bvid) {
  openDrawer('视频', '<div class="empty">打开中…</div>');
  let v;
  try { v = (await api('/api/video?bvid=' + encodeURIComponent(bvid))).video; } catch (e) { $('#drawerBody').innerHTML = `<div class="err">${esc(e.message)}</div>`; return; }
  const locked = S.ov?.autopilot?.coinLock;
  $('#drawerBody').innerHTML = `
    <div class="vhead"><a href="https://www.bilibili.com/video/${esc(v.bvid)}" target="_blank" rel="noopener"><img src="${esc(img(v.pic, '672w_378h_1c'))}" alt=""></a>
      <h3>${esc(v.title)}</h3>
      <div class="row small" style="gap:8px"><img src="${esc(img(v.ownerFace, '48w_48h'))}" style="width:22px;height:22px;border-radius:50%" alt="" onerror="this.remove()"><b>${esc(v.owner)}</b><span class="muted">${esc(v.tname)} · ${fmtDur(v.duration)} · ${esc(v.bvid)}</span>${v.ownerUid ? '<button class="btn sm ghost" id="vVip" title="TA 一发新视频就优先去看">⭐ 特别关注 TA</button>' : ''}</div>
      <div class="stats" style="margin-top:8px"><span>▶ ${fmtNum(v.stat.view)}</span><span>💬 ${fmtNum(v.stat.reply)}</span><span>❤️ ${fmtNum(v.stat.like)}</span><span>🪙 ${fmtNum(v.stat.coin)}</span><span>⭐ ${fmtNum(v.stat.favorite)}</span><span>↗️ ${fmtNum(v.stat.share)}</span></div>
      ${v.desc ? `<div class="desc">${esc(v.desc)}</div>` : ''}
    </div>
    <div class="row wrap" style="margin-top:14px">
      <button class="btn primary" id="vWatch">📺 让她看这个</button>
      <button class="btn" id="vLike">❤️ 点赞</button>
      <button class="btn" id="vShare">↗️ 分享</button>
      <button class="btn" id="vFav">⭐ 收藏</button>
      <button class="btn" id="vCoin" ${locked ? 'disabled title="投币已上锁"' : ''}>🪙 投币${locked ? '（锁）' : ''}</button>
    </div>
    <div class="cfg-sec" style="margin-top:16px">
      <h3>发条评论</h3>
      ${v.noReply ? '<p>这个视频关闭了评论</p>' : `<textarea id="vCmt" placeholder="写点真实的感想…"></textarea>
      <div class="row" style="margin-top:8px"><button class="btn sm" id="vAi">✨ 让她想一句</button><span class="spacer"></span><button class="btn sm primary" id="vPost">发布评论</button></div>`}
    </div>
    <div class="cfg-sec"><h3>热评 <span class="muted small">${fmtNum(v.stat.reply)} 条</span></h3><div id="vCmts">${(v.comments || []).map((c) => cmtHtml(c)).join('') || '<div class="empty">没有评论</div>'}</div></div>`;

  $('#vWatch').onclick = (e) => busy(e.target, async () => {
    await api('/api/autopilot/run', { bvid: v.bvid });
    toast('她开始看这个视频了，进度在总览里');
    pollLive();
  });
  $('#vLike').onclick = (e) => busy(e.target, async () => { await api('/api/like', { bvid: v.bvid, title: v.title }); toast('点赞了'); });
  $('#vShare').onclick = (e) => busy(e.target, async () => { await api('/api/share', { bvid: v.bvid, title: v.title }); toast('分享了（+5 经验）'); });
  $('#vFav').onclick = (e) => busy(e.target, async () => { const r = await api('/api/favorite', { bvid: v.bvid, title: v.title }); toast(r.already ? '早就收藏过了' : '收藏了'); });
  const vv = $('#vVip');
  if (vv) vv.onclick = () => busy(vv, async () => { await api('/api/vip/add', { uid: v.ownerUid }); toast(`「${v.owner}」加进特别关注了`); });
  $('#vCoin').onclick = async (e) => {
    if (!(await confirmBox('投 1 个币？', '失败一次就会永久锁住投币。确定？', '投'))) return;
    busy(e.target, async () => { await api('/api/coin', { bvid: v.bvid, title: v.title }); toast('投币成功'); });
  };
  if (!v.noReply) {
    $('#vAi').onclick = (e) => busy(e.target, async () => { $('#vCmt').value = (await api('/api/ai/comment', { bvid: v.bvid })).text; });
    $('#vPost').onclick = (e) => busy(e.target, async () => {
      const t = $('#vCmt').value.trim();
      if (!t) throw new Error('写点什么再发');
      await api('/api/comment', { bvid: v.bvid, title: v.title, message: t });
      $('#vCmt').value = '';
      toast('评论发出去了');
    });
  }
  $('#vCmts').onclick = (e) => {
    const b = e.target.closest('[data-reply]');
    if (!b) return;
    composer($('#rb-' + b.dataset.reply), {
      placeholder: '回复 @' + b.dataset.user,
      context: '视频《' + v.title + '》',
      message: b.dataset.text,
      onSend: async (t) => { await api('/api/comment', { bvid: v.bvid, title: v.title, message: t, rootRpid: b.dataset.reply, parentRpid: b.dataset.reply }); toast('回复了'); },
    });
  };
}

// ─── 消息 ──────────────────────────────────────────────────
async function refreshUnread() {
  try {
    const u = await api('/api/inbox/unread');
    S.badges.inbox = (u.reply || 0) + (u.at || 0) + (u.dm || 0);
    renderNav();
    $$('#inSeg button').forEach((b) => {
      const n = u[b.dataset.v] || 0;
      const badge = $('.badge', b);
      if (!n && badge) badge.remove();
      else if (n && badge) badge.textContent = n;
    });
  } catch { /* ignore */ }
}

async function pageInbox(main) {
  const tab = (S.inTab ||= 'reply');
  const u = await api('/api/inbox/unread').catch(() => ({}));
  if (S.page !== 'inbox') return;
  const tabs = [['reply', '回复我的', u.reply], ['at', '@我', u.at], ['like', '收到的赞', u.like], ['dm', '私信', u.dm]];
  main.innerHTML = head('消息', '别人回复她、@她、给她点赞、私信她，都在这；可以直接替她回') +
    `<div class="filters"><div class="seg" id="inSeg">${tabs.map(([k, n, c]) => `<button data-v="${k}" class="${tab === k ? 'on' : ''}">${n}${c ? ` <span class="badge">${c}</span>` : ''}</button>`).join('')}</div>
     <span class="spacer"></span><a class="btn ghost sm" href="https://message.bilibili.com/" target="_blank" rel="noopener">在B站打开 ↗</a></div>
     <div id="inOut"></div>`;
  $$('#inSeg button').forEach((b) => (b.onclick = () => { S.inTab = b.dataset.v; route(); }));
  const out = $('#inOut');
  if (tab === 'dm') return renderDm(out);
  out.innerHTML = '<div class="card"><div class="empty">加载中…</div></div>';
  try {
    const r = await api('/api/inbox/' + tab);
    refreshUnread();
    if (!r.list.length) { out.innerHTML = '<div class="card"><div class="empty"><span class="fish">📭</span>还没有消息</div></div>'; return; }
    if (tab === 'like') {
      out.innerHTML = `<div class="card">${r.list.map((x) => `<div class="cmt"><img class="av" src="${esc(img(x.face, '68w_68h'))}" alt="" onerror="this.style.visibility='hidden'">
        <div><div class="u">${esc(x.users.slice(0, 3).join('、'))}${x.count > 1 ? ` 等 ${x.count} 人` : ''} <span class="muted">赞了她 · ${ago(x.time)}</span></div>
        <div class="q">${esc(x.title || x.desc)}</div></div></div>`).join('')}</div>`;
      return;
    }
    out.innerHTML = `<div class="card">${r.list.map((x, i) => `<div class="cmt"><img class="av" src="${esc(img(x.face, '68w_68h'))}" alt="" onerror="this.style.visibility='hidden'">
      <div style="min-width:0"><div class="u">${esc(x.user)} <span class="muted">${tab === 'at' ? '@了她' : '回复了她'} · ${ago(x.time)}</span></div>
        <div class="c">${esc(x.text)}</div>
        ${x.myText ? `<div class="q">她的原话：${esc(x.myText)}</div>` : ''}
        <div class="q">📺 ${x.uri ? `<a href="${esc(x.uri)}" target="_blank" rel="noopener">${esc(x.title)}</a>` : esc(x.title)}</div>
        <div class="acts"><button class="btn sm" data-i="${i}">回复</button></div>
        <div id="ib-${i}"></div></div></div>`).join('')}</div>`;
    out.onclick = (e) => {
      const b = e.target.closest('[data-i]');
      if (!b) return;
      const x = r.list[Number(b.dataset.i)];
      composer($('#ib-' + b.dataset.i), {
        placeholder: '回复 @' + x.user,
        context: `视频/动态《${x.title}》${x.myText ? '；她之前说：' + x.myText : ''}`,
        message: x.text,
        onSend: async (t) => {
          await api('/api/comment', { oid: x.oid, type: x.type, message: t, rootRpid: x.root, parentRpid: x.rpid, title: x.title });
          toast('回复了');
        },
      });
    };
  } catch (e) { out.innerHTML = `<div class="card err">${esc(e.message)}</div>`; }
}

async function renderDm(out) {
  out.innerHTML = `<div class="card dm"><div class="dm-list" id="dmList"><div class="empty">加载中…</div></div>
    <div class="dm-pane"><div class="dm-msgs" id="dmMsgs"><div class="empty">选一个会话</div></div>
      <div class="dm-input"><textarea id="dmIn" placeholder="回复私信…（Enter 发送，Shift+Enter 换行）"></textarea>
        <div style="display:flex;flex-direction:column;gap:6px"><button class="btn sm" id="dmAi">✨</button><button class="btn primary" id="dmSend">发送</button></div></div></div></div>
    <div class="row" style="margin-top:8px"><button class="btn sm" id="dmReadAll">全部标为已读</button><span class="spacer"></span></div>
    <div class="hint" style="margin-top:8px">⚠️ 私信是直接对陌生人说话，发出去收不回。广告、引流、奇怪搭讪别回。</div>`;
  let cur = null, sessions = [];
  const openS = async (s) => {
    cur = s;
    $$('.dm-item').forEach((x) => x.classList.toggle('on', x.dataset.id === s.talkerId));
    const box = $('#dmMsgs');
    box.innerHTML = '<div class="empty">加载中…</div>';
    try {
      const r = await api('/api/messages/list?talkerId=' + s.talkerId);
      let last = 0;
      box.innerHTML = r.list.map((m) => {
        const t = (m.ts || 0) * 1000;
        const sep = t - last > 600000 ? `<div class="bubble-time">${new Date(t).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</div>` : '';
        last = t;
        return `${sep}<div class="bubble ${m.mine ? 'me' : ''}"><div>${esc(m.text)}</div></div>`;
      }).join('') || '<div class="empty">还没有消息</div>';
      box.scrollTop = box.scrollHeight;
      if (s.unread) {
        const seqno = Math.max(0, ...r.list.map((m) => m.seqno || 0));
        await api('/api/messages/read', { talkerId: s.talkerId, seqno }).catch(() => {});
        s.unread = 0;
        $(`.dm-item[data-id="${s.talkerId}"] .badge`)?.remove();
        refreshUnread();
      }
    } catch (e) { box.innerHTML = `<div class="err">${esc(e.message)}</div>`; }
  };
  try {
    sessions = (await api('/api/messages/sessions')).list;
    $('#dmList').innerHTML = sessions.length ? sessions.map((s) => `<div class="dm-item" data-id="${esc(s.talkerId)}">
      <img src="${esc(img(s.face, '80w_80h'))}" alt="" onerror="this.style.visibility='hidden'">
      <div style="min-width:0"><div class="n">${esc(s.name || 'UID ' + s.talkerId)}${s.system ? ' <span class="chip">系统</span>' : ''}</div><div class="l">${esc(s.lastMsg)}</div></div>
      <div style="text-align:right"><div class="small muted">${s.time ? ago(s.time) : ''}</div>${s.unread ? `<span class="badge">${s.unread}</span>` : ''}</div></div>`).join('') : '<div class="empty">没有私信</div>';
    $('#dmList').onclick = (e) => { const it = e.target.closest('.dm-item'); if (it) openS(sessions.find((s) => s.talkerId === it.dataset.id)); };
  } catch (e) { $('#dmList').innerHTML = `<div class="err" style="padding:14px">${esc(e.message)}</div>`; }
  $('#dmReadAll').onclick = (e) => busy(e.target, async () => {
    const unread = sessions.filter((s) => s.unread);
    if (!unread.length) return toast('没有未读私信');
    for (const s of unread) {
      await api('/api/messages/read', { talkerId: s.talkerId });
      s.unread = 0;
      $(`.dm-item[data-id="${s.talkerId}"] .badge`)?.remove();
    }
    toast(`${unread.length} 个会话已标为已读`);
    refreshUnread();
  });
  const send = (btn) => busy(btn, async () => {
    if (!cur) throw new Error('先选一个会话');
    const t = $('#dmIn').value.trim();
    if (!t) throw new Error('写点什么');
    await api('/api/messages/send', { uid: cur.talkerId, name: cur.name, text: t });
    $('#dmIn').value = '';
    toast('发出去了');
    openS(cur);
  });
  $('#dmSend').onclick = (e) => send(e.target);
  $('#dmIn').onkeydown = (e) => { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); send($('#dmSend')); } };
  $('#dmAi').onclick = (e) => busy(e.target, async () => {
    if (!cur) throw new Error('先选一个会话');
    const msgs = $$('#dmMsgs .bubble:not(.me) div');
    const last = msgs[msgs.length - 1]?.textContent || '';
    if (!last) throw new Error('对方还没说话');
    $('#dmIn').value = (await api('/api/ai/reply', { message: last, kind: 'dm' })).text;
  });
}

// ─── 待审 · 派活 ───────────────────────────────────────────
async function pageReview(main) {
  const QUICK = [['browse', '随便刷刷'], ['browse_like', '刷+点赞'], ['comment', '去评论'], ['diary', '写日记'], ['check', '查新消息']];
  const ST = { pending: ['等她', 'amber'], in_progress: ['在做', 'blue'], done: ['做完', 'green'], failed: ['没做成', 'red'], cancelled: ['取消', ''] };
  let queueTab = 'tasks';

  main.innerHTML = head(
    '待审 · 派活',
    'AI 起草的评论、回复和日记在这里等你点头；派的活面板会直接去做',
    `<span class="chip" id="rvStat">待审 0</span><span class="chip" id="taskStat">任务 0</span>`
  ) +
    `<div class="review-layout">
      <section class="card review-main">
        <div class="card-h"><h2>待审</h2><span class="small muted">改一改再发，或者直接丢掉</span></div>
        <div id="rvList"><div class="empty">加载中…</div></div>
        <details class="review-history" id="rvHistory" hidden>
          <summary>处理过的 <span class="chip" id="rvDoneCount">0</span></summary>
          <div id="rvDone"></div>
        </details>
      </section>

      <aside class="review-side">
        <section class="card quick-dispatch">
          <div class="card-h"><h2>派活给她</h2><span class="small muted">点一下就去做</span></div>
          <div class="row wrap quick-actions">${QUICK.map(([k, n]) => `<button class="btn sm" data-task="${k}">${n}</button>`).join('')}</div>
          <div class="field quick-custom">
            <textarea id="taskNote" placeholder="或者直接说要干嘛…" rows="2"></textarea>
            <div class="row" style="margin-top:6px">
              <label class="row small muted quick-target" title="不让面板做，进任务箱等你在 QQ 里叫她"><input type="checkbox" id="taskBot"> 交给 QQ 里的她</label>
              <span class="spacer"></span>
              <button class="btn sm primary" id="taskCustom">派出去</button>
            </div>
            <div class="hint">比如：搜「猫」看两个，喜欢就点赞收藏；找个天文视频看完分享；看三个，别评论。</div>
          </div>
        </section>

        <section class="card queue-card">
          <div class="card-h"><h2>任务与约定</h2><span class="small muted" id="queueStat">加载中…</span></div>
          <div class="seg queue-tabs" id="queueTabs" role="tablist">
            <button class="on" data-queue="tasks" role="tab" aria-selected="true">任务箱 <span class="badge" id="taskCount">0</span></button>
            <button data-queue="appointments" role="tab" aria-selected="false">约定 <span class="badge" id="apptCount">0</span></button>
            <button data-queue="groups" role="tab" aria-selected="false">群名表</button>
          </div>
          <div class="queue-pane" id="taskPane"><div class="empty">加载中…</div></div>
          <div class="queue-pane" id="apptPane" hidden><div class="empty">加载中…</div></div>
          <div class="queue-pane" id="groupPane" hidden><div class="empty">加载中…</div></div>
        </section>
      </aside>
    </div>`;

  const switchQueue = (which) => {
    queueTab = which;
    $$('#queueTabs button').forEach((b) => {
      const on = b.dataset.queue === which;
      b.classList.toggle('on', on);
      b.setAttribute('aria-selected', on ? 'true' : 'false');
    });
    $('#taskPane').hidden = which !== 'tasks';
    $('#apptPane').hidden = which !== 'appointments';
    $('#groupPane').hidden = which !== 'groups';
    if (which === 'groups') loadGroups();
  };
  $$('#queueTabs button').forEach((b) => (b.onclick = () => switchQueue(b.dataset.queue)));

  // 群名表：群号收消息自动带出，群名号主手填（跨会话执行靠它把"去测试群"翻成 g:群号）
  const loadGroups = async () => {
    const { groups = [] } = await api('/api/group-names').catch(() => ({ groups: [] }));
    $('#groupPane').innerHTML = groups.length
      ? `<div class="small muted" style="margin-bottom:8px">群号是收到群消息时自动记下的；群名你来填，她才能听懂"去XX群"。</div>
         <div class="tl queue-list">${groups.map((g) => `<div class="row" style="gap:8px;align-items:center;padding:7px 0;border-bottom:1px solid var(--line)">
           <code class="small">${esc(g.peer)}</code>
           <input class="gname" data-peer="${esc(g.peer)}" value="${esc(g.name)}" placeholder="填群名…" maxlength="60" style="flex:1;min-width:0">
           <button class="btn sm" data-save-group="${esc(g.peer)}">存</button>
         </div>`).join('')}</div>`
      : '<div class="empty">还没收到过群消息；群里 @ 她一次，群号就会自己出现在这里</div>';
    $$('[data-save-group]').forEach((b) => (b.onclick = () => busy(b, async () => {
      const peer = b.dataset.saveGroup;
      const input = $(`.gname[data-peer="${CSS.escape(peer)}"]`);
      await api('/api/group-names', { peer, name: input ? input.value : '' });
      toast('群名存好了');
      loadGroups();
    })));
  };

  const loadRv = async () => {
    const r = await api('/api/review');
    const pending = r.list.filter((x) => x.status === 'pending');
    const done = r.list.filter((x) => x.status !== 'pending').slice(0, 10);
    S.badges.review = pending.length; renderNav();
    $('#rvStat').textContent = `待审 ${pending.length}`;
    $('#rvList').innerHTML = pending.length ? pending.map((x) => `<div class="rv" data-id="${esc(x.id)}">
        <div class="row small"><span class="chip ${x.kind === 'diary' ? 'violet' : x.kind === 'reply' ? 'pink' : 'blue'}">${x.kind === 'diary' ? '📔 日记（公开动态）' : x.kind === 'reply' ? '↩️ 回复 @' + esc(x.payload?.user || '') : '💬 评论'}</span>
          ${x.kind === 'reply' ? `<span class="muted" style="min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">TA 说：${esc(x.payload?.said || '')}</span>` : ''}
          ${x.payload?.bvid ? `<a data-bvid="${esc(x.payload.bvid)}" style="cursor:pointer" class="small">《${esc(x.payload.title)}》</a>` : ''}<span class="spacer"></span><span class="muted">${ago(x.ts)}</span></div>
        <textarea>${esc(x.text)}</textarea>
        <div class="row review-actions" style="justify-content:flex-end"><button class="btn sm ghost danger" data-rej>不要了</button><button class="btn sm primary" data-ok>${x.kind === 'diary' ? '发动态' : '发出去'}</button></div></div>`).join('')
      : '<div class="empty"><span class="fish">🫧</span>没有待审的。AI 起草需要在「自动养号」里配置模型</div>';
    $('#rvDoneCount').textContent = String(done.length);
    $('#rvHistory').hidden = !done.length;
    $('#rvDone').innerHTML = done.length ? `<ul class="tl compact">${done.map((x) => `<li><div class="time">${hm(x.updatedAt || x.ts)}</div><div class="ico">${x.status === 'posted' ? '✅' : '🗑️'}</div><div class="body"><div class="x">${esc(x.text.slice(0, 80))}</div><div class="m">${x.status === 'posted' ? '已发' : '丢掉了'}</div></div></li>`).join('')}</ul>` : '';
    $$('#rvList .rv').forEach((el) => {
      const id = el.dataset.id;
      $('[data-ok]', el).onclick = async (e) => {
        const isDiary = el.querySelector('.chip.violet');
        if (isDiary && !(await confirmBox('发到B站动态？', '动态是公开的，所有人都能看到。'))) return;
        busy(e.target, async () => { await api('/api/review/approve', { id, text: $('textarea', el).value }); toast('发出去了'); loadRv(); });
      };
      $('[data-rej]', el).onclick = (e) => busy(e.target, async () => { await api('/api/review/reject', { id }); loadRv(); });
    });
  };

  const taskRow = (t) => `<li><div class="time">${hm(t.ts)}</div><div class="ico">${t.type === 'send_media' ? '📤' : '📋'}</div>
      <div class="body"><div class="x">${esc(t.note || t.type)}</div><div class="m"><span class="chip ${ST[t.status]?.[1] || ''}">${ST[t.status]?.[0] || t.status}</span>${t.type === 'send_media' && t.payload?.targetPeer ? `<span class="chip blue">发到 ${esc(t.payload.targetPeer)}</span>` : ''}${t.source === 'auto' ? '<span class="chip blue">自动派的</span>' : ''}${t.executor === 'bot' && t.source !== 'auto' ? '<span class="chip pink">QQ里的她</span>' : ''}${t.resultNote ? `<span class="queue-note">${esc(t.resultNote)}</span>` : ''}
      ${t.status === 'pending' ? `<button class="btn sm ghost" data-cancel="${esc(t.id)}">取消</button>` : ''}</div></div></li>`;
  const JOB_KIND = { say: ['💬', '说一句'], watch: ['📺', '看视频'], task: ['🛠️', '后台活'] };
  const apptRow = (a, fired = false) => {
    const at = a.at || a.dueAt;
    const due = at ? new Date(at).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }) : '';
    const kind = a.kind || 'say';
    const [ico, label] = JOB_KIND[kind] || JOB_KIND.say;
    const body = a.originText || a.jobPayload?.taskNote || a.note || '';
    const repeat = a.repeat === 'daily' ? `<span class="chip blue">${a.days >= 1 ? `连着 ${a.days} 天` : '每天'}</span>` : '';
    const watching = !fired && a.status === 'in_progress';
    const bvid = a.jobPayload?.bvid;
    // 已执行看视频：把看的 BV 号和总结一并显示，不用再翻 QQ
    const doneDetail = fired && bvid ? `<div class="m"><span class="chip">${esc(bvid)}</span>${a.resultNote ? `<span class="queue-note">${esc(a.resultNote)}</span>` : ''}</div>` : '';
    return `<li><div class="time">${fired ? hm(a.firedAt || a.ts) : due}</div><div class="ico">${fired ? '✅' : watching ? '👀' : ico}</div>
      <div class="body"><div class="x">${esc(body)}</div><div class="m"><span class="chip ${fired ? 'green' : watching ? 'blue' : 'amber'}">${fired ? '已执行' : watching ? '在看' : '待执行'}</span><span class="chip">${label}</span>${repeat}${a.who ? `<span class="chip">${esc(a.who)}</span>` : ''}${a.peer && a.peer !== 'owner' ? `<span class="chip blue">${esc(a.peer)}</span>` : ''}${!fired && a.status === 'pending' ? `<button class="btn sm ghost" data-acancel="${esc(a.id)}">取消</button>` : ''}</div>${doneDetail}</div></li>`;
  };

  const loadTasks = async () => {
    const [r, ap] = await Promise.all([
      api('/api/tasks'),
      api('/api/appointments').catch(() => ({ pending: [], fired: [] })),
    ]);
    const tasks = r.tasks || [];
    const pendingTasks = tasks.filter((t) => t.status === 'pending');
    const pendingAps = ap.pending || [];
    const firedAps = (ap.fired || []).slice(0, 5);
    $('#taskCount').textContent = String(pendingTasks.length);
    $('#apptCount').textContent = String(pendingAps.length);
    $('#taskStat').textContent = `任务 ${pendingTasks.length}`;
    $('#queueStat').textContent = `${tasks.length} 条任务 · ${pendingAps.length} 条待执行`;

    const open = tasks.slice(0, 8);
    const rest = tasks.slice(8);
    $('#taskPane').innerHTML = tasks.length ? `<ul class="tl queue-list">${open.map(taskRow).join('')}</ul>${rest.length ? `<details class="queue-more"><summary>还有 ${rest.length} 条</summary><ul class="tl queue-list">${rest.map(taskRow).join('')}</ul></details>` : ''}` : '<div class="empty">暂时没派的活</div>';
    $('#apptPane').innerHTML = (pendingAps.length || firedAps.length)
      ? `${pendingAps.length ? `<div class="tl-day">待执行</div><ul class="tl queue-list">${pendingAps.map((a) => apptRow(a)).join('')}</ul>` : ''}${firedAps.length ? `<div class="tl-day">已执行</div><ul class="tl queue-list">${firedAps.map((a) => apptRow(a, true)).join('')}</ul>` : ''}`
      : '<div class="empty">还没有定时任务</div>';
    switchQueue(queueTab);
    $$('[data-cancel]').forEach((b) => (b.onclick = () => busy(b, async () => { await api('/api/tasks/cancel', { id: b.dataset.cancel }); loadTasks(); })));
    $$('[data-acancel]').forEach((b) => (b.onclick = () => busy(b, async () => { await api('/api/appointments/cancel', { id: b.dataset.acancel }); loadTasks(); })));
    // 面板在做的活 + 约定栏正在看的视频：隔几秒刷新一下进度
    clearTimeout(S.taskTimer);
    const busy = tasks.some((t) => t.status === 'in_progress' && t.executor === 'panel')
      || pendingAps.some((a) => a.status === 'in_progress');
    if (busy) S.taskTimer = setTimeout(() => { if (S.page === 'review') loadTasks(); }, 8000);
  };

  const executor = () => ($('#taskBot').checked ? 'bot' : 'panel');
  const afterSend = () => {
    switchQueue('tasks');
    toast(executor() === 'bot' ? '进任务箱了，下次在 QQ 叫她' : '她去做了，结果会写在任务箱里');
    loadTasks();
    if (executor() === 'panel') { pollLive(); setTimeout(loadTasks, 4000); }
  };
  $$('[data-task]').forEach((b) => (b.onclick = () => busy(b, async () => { await api('/api/tasks', { type: b.dataset.task, executor: executor() }); afterSend(); })));
  $('#taskCustom').onclick = (e) => busy(e.target, async () => {
    const note = $('#taskNote').value.trim();
    if (!note) throw new Error('写点内容');
    await api('/api/tasks', { type: 'custom', note, executor: executor() });
    $('#taskNote').value = '';
    afterSend();
  });
  loadRv().catch((e) => ($('#rvList').innerHTML = `<div class="err">${esc(e.message)}</div>`));
  loadTasks();
}


// ─── 养鱼日记 ──────────────────────────────────────────────
async function pageDiary(main) {
  main.innerHTML = head('养鱼日记', '她在B站的小杂谈，发出去是公开动态。只写B站上看到的事，别写私事') + '<div class="empty">加载中…</div>';
  const r = await api('/api/diary');
  if (S.page !== 'diary') return;
  main.innerHTML = head('养鱼日记', '她在B站的小杂谈，发出去是公开动态。只写B站上看到的事，别写私事') +
    `<div class="grid g-3"><div class="card"><div class="card-h"><h2>替她写一条</h2>${r.publishedToday ? '<span class="chip green">今天已发</span>' : ''}</div>
      <textarea id="dyText" style="min-height:180px" placeholder="像发朋友圈那样写，不是写周报…"></textarea>
      <div class="hint">一天一条就够。内容干净，别擦边、别带链接。</div>
      <div class="row" style="margin-top:10px;justify-content:flex-end"><button class="btn primary" id="dyPub">发到B站动态</button></div></div>
     <div class="card span-2"><div class="card-h"><h2>写过的</h2></div>
      ${r.drafts.length ? r.drafts.map((d) => `<div class="rv"><div class="row small"><b>${dayLabel(d.date)}</b><span class="muted">${d.date} ${hm(d.ts)}</span><span class="spacer"></span>
        ${d.dynId ? `<a href="https://t.bilibili.com/${esc(d.dynId)}" target="_blank" rel="noopener" class="chip green">已发布 ↗</a>` : '<span class="chip">草稿</span>'}</div>
        <div style="white-space:pre-wrap;margin-top:8px;color:var(--text2)">${esc(d.draft)}</div></div>`).join('') : '<div class="empty">还没写过</div>'}
     </div></div>`;
  $('#dyPub').onclick = async (e) => {
    const t = $('#dyText').value.trim();
    if (!t) return toast('写点什么', 'err');
    if (!(await confirmBox('发到B站动态？', (r.publishedToday ? '今天已经发过一条了，' : '') + '动态是公开的，所有人都能看到。'))) return;
    busy(e.target, async () => {
      const res = await api('/api/diary/publish', { text: t });
      toast('发出去了');
      if (res.url) window.open(res.url, '_blank', 'noopener');
      route();
    });
  };
}

// ─── 主题 / 启动 ───────────────────────────────────────────
$('#themeBtn').onclick = () => {
  const cur = document.documentElement.dataset.theme || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
  const next = cur === 'dark' ? 'light' : 'dark';
  document.documentElement.dataset.theme = next;
  try { localStorage.setItem('theme', next); } catch { /* ignore */ }
};

route();
loadOverview().catch(() => {});
setInterval(() => {
  if (document.hidden) return;
  if (S.page === 'overview' && !$('#drawer').classList.contains('show')) pageOverview($('#main'));
  else loadOverview().catch(() => {});
}, 60000);
// 打开时如果她正在刷，就跟着刷新进度
api('/api/autopilot').then((ap) => ap.live.running && pollLive()).catch(() => {});

// ─── 表情包 ────────────────────────────────────────────────
// 她的表情包在这管：场合备注就是她挑表情的依据（stickers/notes.json），改完立刻生效；
// 「自拍池」勾选＝备注里带 send_selfie 标记（被要自拍时随机糊弄的那几张，brain.selfiePool 认它）。
async function pageStickers(main) {
  main.innerHTML = head('表情包', '她的表情包和自拍糊弄图都在这管：场合备注就是她挑表情的依据，改完立刻生效，不用重启。传新图（批量）、删不想要的也在这。') + `
    <div class="card" style="margin-bottom:14px">
      <div class="card-h"><h2>备注怎么写（她挑表情就看这个）</h2></div>
      <div class="hint" style="line-height:1.9">
        ✅ 写宽的情绪/场合，日常对上就能发：<b>「委屈、想求安慰的时候」</b> <b>「开心到起飞、想溜的时候」</b> <b>「围观吃瓜、等你开口」</b><br>
        ❌ 写成触发开关的，她几乎永远轮不上这张：<s>「被说 token 没了时」</s> <s>「被问还活着吗时」</s> <s>「被夸装乖时」</s><br>
        <span class="muted">一句里带 1~2 个宽场景最好；表情之间别写成一样的，得各有各的地盘。</span>
      </div>
    </div>
    <div class="grid g-3">
      <div class="card span-2">
        <div class="card-h"><h2>全部表情（<span id="stkCount">…</span> 张）</h2><span class="small muted">改完点「存备注」才生效；备注写宽点的情绪/场合（「开心、来劲的时候」），别写成「只有被问到X才发」——太窄的备注她日常轮不上这张</span></div>
        <div id="stkGrid" style="display:grid;grid-template-columns:repeat(auto-fill,minmax(170px,1fr));gap:10px"><span class="muted">加载中…</span></div>
      </div>
      <div class="card">
        <div class="card-h"><h2>传新的</h2><span class="small muted">名字用 英文_中文，比如 proud_骄傲</span></div>
        <input type="file" id="stkFiles" accept=".png,.jpg,.jpeg,.gif" multiple style="width:100%">
        <div id="stkQueue" style="margin-top:10px"></div>
        <div class="row" style="margin-top:10px"><button class="btn sm primary" id="stkUpload" style="display:none">全部上传</button><span class="small muted" id="stkMsg"></span></div>
      </div>
    </div>`;
  let list = [];
  const render = () => {
    $('#stkCount').textContent = list.length;
    $('#stkGrid').innerHTML = list.length ? list.map((x, i) => `
      <div style="border:1px solid var(--line);border-radius:10px;padding:8px;display:flex;flex-direction:column;gap:6px">
        <img src="/stickers/${encodeURIComponent(x.file)}" loading="lazy" alt="${esc(x.name)}" style="width:100%;height:110px;object-fit:contain">
        <div class="small" style="font-weight:700">${esc(x.name)} <span class="muted">${x.kb}KB${x.selfie ? ' · 自拍池' : ''}</span></div>
        <input data-ni="${i}" value="${esc(x.note)}" placeholder="什么心情/场合用，写宽点：开心、来劲的时候" maxlength="40">
        <label class="small" style="display:flex;gap:4px;align-items:center"><input type="checkbox" data-si="${i}" ${x.selfie ? 'checked' : ''}> 自拍池（被要自拍随机发）</label>
        <div class="row" style="gap:6px"><button class="btn sm" data-save="${i}">存备注</button><button class="btn sm ghost" data-del="${i}">删</button></div>
      </div>`).join('') : '<span class="muted">还没有表情包</span>';
  };
  const reload = async () => { list = (await api('/api/stickers')).list; render(); };
  await reload().catch((err) => { $('#stkGrid').innerHTML = `<span class="muted">读不到：${esc(err.message || err)}<br>（面板还是旧版 panel.mjs 时会这样——上传新版并重启容器后再试）</span>`; });
  $('#stkGrid').onclick = (e) => {
    const s = e.target.closest('[data-save]'); const d = e.target.closest('[data-del]');
    if (s) {
      const i = Number(s.dataset.save);
      busy(s, async () => {
        try {
          list = (await api('/api/stickers/note', { name: list[i].name, note: document.querySelector(`[data-ni="${i}"]`).value, selfie: document.querySelector(`[data-si="${i}"]`).checked })).list;
          toast('备注存了，立刻生效');
        } catch (err) { toast(err.message || err, 'err'); }
      });
    } else if (d) {
      const i = Number(d.dataset.del); const x = list[i];
      confirmBox(`删掉 ${x.name}？`, '图和备注一起删，她以后不能再发这张。', '删').then(async (yes) => {
        if (!yes) return;
        try { list = (await api('/api/stickers/delete', { name: x.name })).list; render(); toast('删了'); } catch (err) { toast(err.message || err, 'err'); }
      });
    }
  };
  let queue = [];
  $('#stkFiles').onchange = (e) => {
    queue = [...e.target.files];
    $('#stkUpload').style.display = queue.length ? '' : 'none';
    $('#stkQueue').innerHTML = queue.map((f, i) => {
      const guess = f.name.replace(/\.[a-z0-9]+$/i, '').toLowerCase().replace(/[^a-z0-9\u4e00-\u9fff]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 20);
      return `<div style="border:1px dashed var(--line);border-radius:8px;padding:6px;margin-bottom:6px">
        <div class="small" style="font-weight:700">${esc(f.name)} <span class="muted">${Math.round(f.size / 1024)}KB</span></div>
        <div class="row" style="gap:6px;margin-top:4px"><input data-qn="${i}" value="${esc(guess)}" placeholder="名字 en_中文" style="width:120px"><input data-qo="${i}" placeholder="什么心情/场合用，写宽点：开心、来劲的时候" maxlength="40" style="flex:1"></div>
        <label class="small" style="display:flex;gap:4px;align-items:center;margin-top:2px"><input type="checkbox" data-qs="${i}"> 自拍池</label>
      </div>`;
    }).join('');
  };
  const readFile = (f) => new Promise((ok) => { const r = new FileReader(); r.onload = () => ok(String(r.result).split(',')[1] || ''); r.readAsDataURL(f); });
  $('#stkUpload').onclick = (e) => busy(e.target, async () => {
    const errs = [];
    for (let i = 0; i < queue.length; i++) {
      const name = document.querySelector(`[data-qn="${i}"]`).value.trim();
      const note = document.querySelector(`[data-qo="${i}"]`).value.trim();
      const selfie = document.querySelector(`[data-qs="${i}"]`).checked;
      try { await api('/api/stickers/upload', { name, note, selfie, data: await readFile(queue[i]) }); } catch (err) { errs.push(`${name || queue[i].name}：${err.message || err}`); }
    }
    queue = []; $('#stkFiles').value = ''; $('#stkQueue').innerHTML = ''; $('#stkUpload').style.display = 'none';
    await reload().catch(() => {});
    if (errs.length) { $('#stkMsg').textContent = `有 ${errs.length} 张没传上`; toast(errs[0], 'err'); } else { $('#stkMsg').textContent = ''; toast('传好了'); }
  });
}
