#!/usr/bin/env node
/**
 * 蓝色大肥鱼 · B站养鱼管理面板
 *
 * 零依赖本地 Web 服务：
 *  - 托管 public/ 下的单页 UI
 *  - 提供 /api/*：账号与经验、活动记录、自动养号、刷视频、消息中心、待审、日记
 *  - 进程内跑自动养号调度器（autopilot.mjs）
 *
 * 启动：node panel.mjs → http://127.0.0.1:8899
 */
import { createServer } from 'node:http';
import * as fav from './fav.mjs';
import * as memdb from './memdb.mjs';
import * as memeimg from './memeimg.mjs';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join, extname, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as bili from './bili.mjs';
import * as llm from './llm.mjs';
import * as tuningMod from './qq/tuning.mjs';
import * as auto from './autopilot.mjs';
import * as notify from './notify.mjs';
import * as mind from './mind.mjs';
import * as memory from './memory.mjs';
import * as friends from './friends.mjs';
import * as botscore from './botscore.mjs';
import * as stickers from './stickers.mjs';
import * as social from './social.mjs';
import * as sky from './sky.mjs';
import * as health from './health.mjs';
import * as qq from './qq/index.mjs';
import * as owner from './qq/owner.mjs';
import { openAsHer } from './browser.mjs';
import {
  FILES, SHICHEN, localDate, logAction, readActions, readTasks, addTask, updateTask,
  readReview, updateReview, readConfig, writeConfig, readSecrets, writeSecrets,
  readState, writeState, readJsonl, todayCounts, nowIso,
  readBlocks, clearBlock, withBlock, ACTION_NAMES, readVip, writeVip, readWishes, finishWish, readPause, clearPause,
} from './store.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const PUBLIC = join(here, 'public');
const PORT = Number(process.env.PANEL_PORT || 8899);
const HOST = process.env.PANEL_HOST || '127.0.0.1'; // 容器/NAS 部署时设 PANEL_HOST=0.0.0.0

// ─── B站数据缓存：面板每 30 秒刷新，但别每次都去敲 B站 ──────
// 一个号每 15 秒查一次 nav + 经验 + 未读，本身就很不像真人。
const cache = new Map();
async function cached(key, ttlMs, fn) {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < ttlMs) return hit.value;
  const value = await fn();
  cache.set(key, { at: Date.now(), value });
  return value;
}
const bust = (...keys) => keys.forEach((k) => cache.delete(k));

// ─── 统计 ──────────────────────────────────────────────────
function dailySeries(days = 14) {
  const out = [];
  const byDay = {};
  for (const a of readActions()) {
    if (!a.ok) continue;
    const d = localDate(new Date(a.ts));
    const o = (byDay[d] ||= { watch: 0, like: 0, comment: 0, share: 0, seconds: 0 });
    if (a.kind === 'watch') { o.watch++; o.seconds += Number(a.meta?.played || 0); }
    else if (a.kind === 'like') o.like++;
    else if (a.kind === 'comment' || a.kind === 'reply_comment') o.comment++;
    else if (a.kind === 'share') o.share++;
  }
  for (let i = days - 1; i >= 0; i--) {
    const d = localDate(new Date(Date.now() - i * 86400_000));
    out.push({ date: d, ...(byDay[d] || { watch: 0, like: 0, comment: 0, share: 0, seconds: 0 }) });
  }
  return out;
}

function autopilotView() {
  const cfg = readConfig();
  const state = readState();
  let plan = [];
  try { plan = auto.todayPlan(); } catch { /* ignore */ }
  return {
    config: cfg,
    shichen: SHICHEN,
    plan,
    live: auto.liveStatus(),
    lastRun: state.lastRun || null,
    cooldownUntil: state.cooldownUntil && state.cooldownUntil > Date.now() ? state.cooldownUntil : null,
    pause: readPause(),
    llmReady: llm.llmReady(),
    llmUsage: llm.usageView(),
    hasKey: !!readSecrets().llmApiKey,
    hasAmapKey: !!readSecrets().amapKey,
    coinLock: bili.coinLock(),
    social: social.socialView(),
    blocks: Object.entries(readBlocks()).map(([kind, b]) => ({ kind, name: ACTION_NAMES[kind] || kind, ...b })),
  };
}

// 特别关注名单 + 我是否已关注 TA（动态流里只有关注了的人）
async function vipUsers() {
  const users = readConfig().vip.users;
  return cached('vipRel:' + users.map((u) => u.uid).join(','), 10 * 60_000, async () => {
    const out = [];
    for (const u of users) {
      const rel = await bili.relationWith(u.uid).catch(() => null);
      out.push({ ...u, following: rel ? rel.following : null });
    }
    return out;
  });
}

// ─── HTTP 工具 ─────────────────────────────────────────────
function json(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(obj));
}
async function readBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const raw = Buffer.concat(chunks).toString('utf-8');
  if (!raw) return {};
  try { return JSON.parse(raw); } catch { return {}; }
}
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png',
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp',
  '.ico': 'image/x-icon', '.json': 'application/json',
};
function serveStatic(res, p) {
  const rel = normalize(p === '/' ? '/index.html' : p).replace(/^(\.\.[/\\])+/, '');
  const file = join(PUBLIC, rel);
  if (!file.startsWith(PUBLIC) || !existsSync(file)) return false;
  res.writeHead(200, { 'Content-Type': MIME[extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
  res.end(readFileSync(file));
  return true;
}

/**
 * 防跨站：面板只给本机浏览器用。别的网页可以往 127.0.0.1 发请求（CSRF / DNS rebinding），
 * 所以校验 Host，写操作还要求 JSON（跨站发 JSON 会触发 CORS 预检，被浏览器拦下）且 Origin 匹配。
 */
// 局域网也能用：允许本机 + 内网/组网私网 IP 的 Host（10.x / 172.16-31.x / 192.168.x / 100.64-127.x）。
// 公网域名和公网 IP 一律拒 —— 面板没有登录保护，只能内网用，别往公网转发。
function hostOK(h) {
  let s = String(h || '');
  if (s.startsWith('[') && s.includes(']')) s = s.slice(1, s.indexOf(']'));
  const c = s.lastIndexOf(':');
  if (c > 0 && s.indexOf(':') === c) s = s.slice(0, c);
  if (s === 'localhost' || s === '::1') return true;
  // 极空间远程访问（zconnect.cn）：官方账号门禁的中转，放行；其他公网域名依旧全拒
  if (s === 'zconnect.cn' || s.endsWith('.zconnect.cn')) return true;
  const parts = s.split('.');
  if (parts.length !== 4) return false;
  const n = [];
  for (const p of parts) {
    const v = Number(p);
    if (!Number.isInteger(v) || v < 0 || v > 255 || String(v) !== p) return false;
    n.push(v);
  }
  return n[0] === 127 || n[0] === 10 || (n[0] === 192 && n[1] === 168) || (n[0] === 172 && n[1] >= 16 && n[1] <= 31) || (n[0] === 100 && n[1] >= 64 && n[1] <= 127);
}

function allowed(req) {
  if (!hostOK(req.headers.host)) return false;
  if (req.method === 'GET') return true;
  const origin = String(req.headers.origin || '');
  if (origin) {
    const bare = origin.startsWith('http://') ? origin.slice(7) : origin.startsWith('https://') ? origin.slice(8) : origin;
    if (!hostOK(bare)) return false;
  }
  return String(req.headers['content-type'] || '').includes('application/json');
}

const routes = {
  // 总览：账号、经验、今日、未读、自动养号、近 14 天
  'GET /api/overview': async () => {
    const [account, exp, unread] = await Promise.all([
      cached('account', 120_000, bili.getAccountStatus).catch((e) => ({ error: e.message })),
      cached('exp', 120_000, bili.getExpStatus).catch((e) => ({ error: e.message })),
      cached('unread', 90_000, bili.unreadCounts).catch(() => null),
    ]);
    return {
      account, exp, unread,
      today: todayCounts(),
      series: dailySeries(14),
      tasksPending: readTasks().filter((t) => t.status === 'pending').length,
      reviewPending: readReview().filter((r) => r.status === 'pending').length,
      autopilot: autopilotView(),
      health: health.status(),
    };
  },
  'GET /api/health': async (q) => (q.get('fresh') ? health.check() : health.status()),
  'GET /api/fav': async () => ({ users: fav.readFav().users }),
  'GET /api/fav/recent': async () => ({ list: fav.todayDeltas(40) }), // 手感调参页：今天的单句记分流水
  'GET /api/memdb': async () => memdb.stats(),
  'POST /api/memdb/search': async (_q, b) => ({ stats: memdb.stats(), hits: memdb.search(String(b?.q || ''), { k: 30, facts: true }) }), // 号主 facts 的留底一起搜（她的 recall 不带）
  'GET /api/memory': async () => ({ ...memory.memoryView(50), insightPending: mind.readMind().insightPending || [] }), // 记忆页：在记 / 印象 / 洞察各拉 50 条 + 档案规模 + 待审洞察
  'GET /api/friends': async () => friends.friendsView(), // 记忆页「朋友们」：档案 + 好感 + 朋友圈近况
  // 谁像bot：纯读的怀疑榜单（规则加分制，不是判决）+ 一键进/出机器人名单。
  // 名单的行为在 qq/index.mjs（只有 @ 她、叫她名字、点她干活/怼她才接），这里只管名单本身。
  // 检测不自动跑：打开页面只拿群列表和名单，rows 要带 scan=1（点了「检测」按钮）才算——数据是实时的，算分交给号主手动触发
  'GET /api/botscore': async (q) => {
    const group = q.get('group');
    return {
      groups: botscore.listGroups(),
      botQQs: String(readConfig().qq.botQQs ?? '').split(/[,，\s]+/).filter(Boolean),
      ...(group && q.get('scan') === '1' ? { rows: botscore.scoreGroup(group, { days: Number(q.get('days')) || 30 }) } : {}),
    };
  },
  'POST /api/botscore/block': async (_q, b) => {
    const qq = String(b?.qq || '').trim();
    if (!qq) throw new Error('没定位到 QQ，去「自动养号 → 机器人名单」里手动填');
    const cur = String(readConfig().qq.botQQs ?? '').split(/[,，\s]+/).filter(Boolean);
    const next = [...new Set([...cur, qq])];
    writeConfig({ qq: { botQQs: next } });
    logAction({ kind: 'qq', source: 'panel', detail: `把 ${b?.name || qq} 加进了机器人名单（谁像bot 页）` });
    return { ok: true, botQQs: next };
  },
  'POST /api/botscore/unblock': async (_q, b) => {
    const qq = String(b?.qq || '').trim();
    const next = String(readConfig().qq.botQQs ?? '').split(/[,，\s]+/).filter(Boolean).filter((x) => x !== qq);
    writeConfig({ qq: { botQQs: next } });
    logAction({ kind: 'qq', source: 'panel', detail: `把 ${b?.name || qq} 移出了机器人名单（谁像bot 页）` });
    return { ok: true, botQQs: next };
  },

  // 扫码登录（掉登录时用）
  'POST /api/login/qr': async () => bili.qrLoginStart(),
  'GET /api/login/poll': async (q) => {
    const key = q.get('key');
    if (!key) throw new Error('缺 key');
    const r = await bili.qrLoginPoll(key);
    if (r.status === 'ok') {
      cache.clear(); // 旧账号状态全作废
      logAction({ kind: 'login', target: r.uid, detail: '扫码重新登录了 B站' });
    }
    return r;
  },

  // 活动记录（插嘴裁决有专属板块，这里不掺：不带 kind 查询时把 gate 类和旧记录里混着的裁决一并剔掉）
  'GET /api/actions': async (q) => {
    let list = readActions();
    const kind = q.get('kind'); const source = q.get('source'); const date = q.get('date'); const s = q.get('q');
    if (kind) { const ks = kind.split(','); list = list.filter((a) => ks.includes(a.kind) || (ks.includes('gate') && a.kind === 'qq' && /插嘴/.test(a.detail || ''))); } // gate 单独板块：旧记录混在 qq 类里，按 🎯 前缀捞回来
    else list = list.filter((a) => a.kind !== 'gate' && !(a.kind === 'qq' && /插嘴|连发熔断|机器人消息只接点名/.test(a.detail || '')));
    if (source) list = list.filter((a) => a.source === source || (!a.source && source === 'panel'));
    if (date) list = list.filter((a) => localDate(new Date(a.ts)) === date);
    if (s) list = list.filter((a) => `${a.title} ${a.detail} ${a.target}`.includes(s));
    const limit = Number(q.get('limit') || 200);
    return { total: list.length, list: list.slice(-limit).reverse() };
  },

  // 任务箱
  'GET /api/tasks': async () => ({ tasks: readTasks().slice(0, 80) }),
  'POST /api/tasks': async (_q, b) => {
    const map = {
      browse: '随便刷刷B站，看到有意思的点个赞、写两句感想',
      browse_like: '刷B站，挑喜欢的点赞',
      comment: '挑几个视频留两句真实感想',
      diary: '把今天刷到的写进养鱼日记，晚上发动态',
      check: '看看有没有新评论和私信要回',
    };
    if (!map[b.type] && !b.note) throw new Error('未知任务类型');
    const executor = b.executor === 'bot' ? 'bot' : 'panel';
    // QQ 里的她（panel/bg.mjs）交给后台的活带 report: 'qq'，做完由后台在 QQ 里汇报
    const fromBot = b.report === 'qq';
    const task = addTask({
      type: b.type || 'custom', note: b.note || map[b.type], payload: b.payload, executor,
      source: fromBot ? 'bot' : 'panel', report: fromBot ? 'qq' : undefined,
    });
    if (executor === 'panel') {
      if (readState().cooldownUntil > Date.now()) {
        updateTask(task.id, { status: 'failed', resultNote: '风控冷却中，先别派活' });
        throw new Error('风控冷却中，先在总览里解除冷却');
      }
      auto.runTask(task).then(() => bust('exp', 'account'));
    }
    return { ok: true, task };
  },
  'POST /api/tasks/cancel': async (_q, b) => { updateTask(b.id, { status: 'cancelled', doneAt: nowIso() }); return { ok: true }; },
  // 约定（阶段三.5）：待兑现/已兑现/已过期
  'GET /api/appointments': async () => { const { listAppointments } = await import('./qq/appoint.mjs'); return listAppointments(); },
  'POST /api/appointments/cancel': async (_q, b) => { updateTask(String(b?.id || ''), { status: 'cancelled', doneAt: nowIso() }); return { ok: true }; },

  // 自动养号
  'GET /api/autopilot': async () => autopilotView(),
  'POST /api/autopilot/config': async (_q, b) => {
    const { llmApiKey, qqAppId, qqAppSecret, qqOpenId, onebotToken, modelscopeToken, amapKey, ...patch } = b;
    if (typeof modelscopeToken === 'string' && modelscopeToken.trim()) writeSecrets({ modelscopeToken: modelscopeToken.trim() });
    if (typeof amapKey === 'string' && amapKey.trim()) writeSecrets({ amapKey: amapKey.trim() }); // 高德 Key（天气 + 经纬度），只存本机 secrets.json，留空不改
    if (typeof llmApiKey === 'string') writeSecrets({ llmApiKey: llmApiKey.trim() });
    if (typeof onebotToken === 'string' && onebotToken.trim()) writeSecrets({ onebotToken: onebotToken.trim() });
    // QQ 提醒的凭证：只存本机 secrets.json，留空表示不改
    for (const [k, v] of Object.entries({ qqAppId, qqAppSecret, qqOpenId })) {
      if (typeof v === 'string' && v.trim()) writeSecrets({ [k]: v.trim() });
    }
    const before = readConfig();
    // 她的窗：城市名变了就用高德查一下经纬度和区域编码；清空就不看天了
    if (patch.sky && typeof patch.sky.place === 'string') {
      const place = patch.sky.place.trim();
      if (!place) Object.assign(patch.sky, { place: '', label: '', lat: null, lon: null, adcode: null });
      else if (place !== before.sky.place || !Number.isFinite(before.sky.lat)) {
        // 查经纬度连不上（比如 NAS 出不了外网）也不能拦着保存：先只存城市名，天气暂时不看
        try { Object.assign(patch.sky, { place, ...(await sky.geocode(place)) }); }
        catch (e) { Object.assign(patch.sky, { place, label: '', lat: null, lon: null, adcode: null }); logAction({ kind: 'error', source: 'panel', ok: false, error: e.message, detail: `查「${place}」的经纬度没查成，先只存了城市名，天气暂时不看` }); }
      }
      else Object.assign(patch.sky, { lat: before.sky.lat, lon: before.sky.lon, label: before.sky.label, adcode: before.sky.adcode ?? null });
    }
    const cfg = writeConfig(patch);
    if (JSON.stringify(before.windows) !== JSON.stringify(cfg.windows) || before.windowChance !== cfg.windowChance) auto.replanToday();
    if (before.enabled !== cfg.enabled) logAction({ kind: 'autopilot', detail: cfg.enabled ? '打开了自动养号' : '关掉了自动养号' });
    // QQ 连接的设置变了（或者换了 token）就重连
    const qqKeys = (c) => JSON.stringify([c.qq.mode, c.qq.wsUrl, c.qq.ownerQQ]);
    if (qqKeys(before) !== qqKeys(cfg) || onebotToken) {
      qq.start();
      if (before.qq.mode !== cfg.qq.mode) logAction({ kind: 'qq', detail: cfg.qq.mode === 'onebot' ? 'QQ 换成了她自己的小号' : 'QQ 换回了官方机器人（DSH 插件）' });
    }
    return autopilotView();
  },
  // 重新抽签（面板按钮）：重抽没跑格子的时间点，再顺势跑一次晨间计划重排类型/意图——
  // 没有可动的格子时 morningPlan 自己空转（不烧重排次数）；改时辰配置触发的 auto.replanToday() 不走这，不连带调模型
  'POST /api/autopilot/replan': async () => { auto.replanToday(); await auto.morningPlan({ replan: true }).catch(() => {}); return autopilotView(); },
  'POST /api/autopilot/run': async (_q, b) => {
    const st = readState();
    if (st.cooldownUntil && st.cooldownUntil > Date.now()) throw new Error('风控冷却中，先在总览里解除冷却');
    if (auto.liveStatus().running) throw new Error('她已经在刷了');
    const videos = b.bvid ? [{ bvid: b.bvid }] : undefined;
    auto.runSession({ reason: b.bvid ? '面板点播' : '面板手动', videos }).then(() => bust('exp', 'account'));
    await new Promise((r) => setTimeout(r, 300));
    return autopilotView();
  },
  'POST /api/autopilot/stop': async () => { auto.stopSession(); return { ok: true }; },
  'POST /api/pause/clear': async () => { clearPause({ source: 'panel' }); return autopilotView(); },
  'POST /api/autopilot/clear-cooldown': async () => {
    const s = readState(); s.cooldownUntil = null; writeState(s);
    logAction({ kind: 'autopilot', detail: '手动解除了风控冷却' });
    return autopilotView();
  },
  'POST /api/autopilot/llm-test': async () => ({ ok: true, reply: await llm.ping() }),
  // 测插嘴仲裁这道闸：验证 reviewModel 本身能通（不通会抛错，面板直接显示原因），
  // 再拿一句恒定 3.6 分（review 档）的样例走一遍真评分 + 真仲裁，看它说接还是不接
  'POST /api/qq/review-test': async () => {
    const model = String(readConfig().qq?.reviewModel || '').trim();
    if (!model) throw new Error('「插嘴仲裁模型」还没填，先填再测');
    const brain = await import('./qq/brain.mjs');
    await llm.chat([{ role: 'user', content: '只输出「接」一个字' }], { maxTokens: 5, temperature: 0, model, tag: 'topic', essential: true });
    const sample = '天气不错，适合睡觉';
    const s = brain.topicScoreMessage(sample, 'g:review-test'); // 没历史的群分数恒定：1.8 底 + 1.8 天气 − 0.6 短句 = 3.0，必落 review
    const join = await brain.reviewJoin(sample, 'g:review-test');
    return { ok: true, model, sample, score: s.score, status: s.status, join };
  },
  // 测看图这条链：拿她自己的「无语」表情包真喂一次视觉模型，看它能不能把图上的字认准（不喂 QQ 标签，纯考认字）。
  // 表情包不在（比如没上传 stickers）就退回纯色小方块，只能测通不通
  'POST /api/qq/vision-test': async () => {
    const model = String(readConfig().qq?.visionModel || '').trim();
    if (!model) throw new Error('「看图模型」还没填，先填再测');
    let buf, expect = '无语';
    try { buf = readFileSync(join(here, '..', 'stickers', 'speechless_无语.png')); }
    catch { buf = llm.makeTestPng(); expect = ''; }
    const raw = await llm.seeImage(buf, { model });
    if (!raw) throw new Error('模型通了但没给描述，看看 ModelScope 令牌和模型名');
    // 兼容旧版 seeImage 返回字符串（容器里 llm.mjs 没更新时，新面板读 .desc 会变成空串）
    const text = llm.visionText(raw) || (typeof raw === 'object' ? String(raw.textOnImage || '') : '');
    if (!text) throw new Error('模型通了但描述是空的，看看看图模型是不是没按 JSON 回包');
    const fieldText = typeof raw === 'string' ? '' : String(raw.textOnImage || '');
    const hit = !!expect && (fieldText.includes(expect) || text.includes(expect));
    return { ok: true, model, desc: text, fields: raw, expect, hit };
  },
  // 梗图指纹库（看图 2.0）：同一张图不用反复看；描述看错了面板能改，改完下次命中就用新的
  'GET /api/meme-lib': async () => ({ entries: memeimg.list() }),
  'POST /api/meme-lib/update': async (_q, b) => ({ ok: !!memeimg.update(String(b?.hash || ''), b || {}), entries: memeimg.list() }),
  'POST /api/meme-lib/delete': async (_q, b) => ({ ok: memeimg.remove(String(b?.hash || '')), entries: memeimg.list() }),
  // 手感参数（插嘴 + 好感）：面板「手感调参」页读写的都是这里。tuning.mjs 只认数字键，文件写坏也炸不到打分
  // GET 版是给排查用的：浏览器地址栏直接开 /api/tuning 就能看到参数 JSON（写操作仍只收 POST）
  'GET /api/tuning': async () => ({ defaults: tuningMod.DEFAULTS, current: tuningMod.tuning() }),
  'POST /api/tuning': async () => ({ defaults: tuningMod.DEFAULTS, current: tuningMod.tuning() }),
  'POST /api/tuning/save': async (_q, b) => { tuningMod.writeTuning({ topic: b?.topic || {}, gate: b?.gate || {}, fav: b?.fav || {}, ctx: b?.ctx || {}, sticker: b?.sticker || {} }); return { current: tuningMod.tuning() }; },
  'POST /api/tuning/reset': async () => { tuningMod.resetTuning(); return { current: tuningMod.tuning() }; },
  // 插嘴试算：拿一句话走一遍真打分。用没有历史的会话名，分数可复现，改完权重即改即看
  'POST /api/qq/topic-preview': async (_q, b) => {
    const text = String(b?.text || '').slice(0, 200);
    if (!text.trim()) throw new Error('先写句要试的话');
    const brain = await import('./qq/brain.mjs');
    let fav = null, favErr = ''; // 单句好感预判：调用失败（预算/接口）跟「判了是 0 分」是两回事，分开报
    try { fav = await brain.favPreview(text); } catch (e) { favErr = String(e.message || e).slice(0, 80); }
    return { ok: true, ...brain.topicScoreMessage(text, 'g:试算'), fav, favErr };
  },
  'POST /api/autopilot/llm-models': async () => ({ models: await llm.listModels() }),
  'POST /api/blocks/clear': async (_q, b) => {
    clearBlock(b.kind);
    logAction({ kind: 'autopilot', detail: `手动恢复了「${ACTION_NAMES[b.kind] || b.kind}」` });
    return autopilotView();
  },

  // 特别关注
  'GET /api/vip': async () => auto.vipView(),
  'POST /api/vip/add': async (_q, b) => {
    const uid = String(b.uid || '').match(/\d{1,20}/)?.[0];
    if (!uid) throw new Error('填 UID，或者贴 TA 的空间链接（space.bilibili.com/数字）');
    const cfg = readConfig();
    if (cfg.vip.users.some((u) => u.uid === uid)) throw new Error('已经在特别关注里了');
    const card = (await bili.userCards([uid]))[uid] || {};
    if (!card.name) throw new Error('查不到这个 UID');
    writeConfig({ vip: { users: [...cfg.vip.users, { uid, name: card.name, face: card.face || '' }] } });
    // 以前加过又删掉的：忘掉当时处理过的动态，重新按「最近 N 小时」来追
    const vq = readVip();
    vq.handled = Object.fromEntries(Object.entries(vq.handled || {}).filter(([, h]) => h.uid !== uid));
    writeVip(vq);
    logAction({ kind: 'vip', target: uid, detail: `把「${card.name}」加进了特别关注` });
    return { ...auto.vipView(), users: await vipUsers() };
  },
  'POST /api/vip/remove': async (_q, b) => {
    const cfg = readConfig();
    const u = cfg.vip.users.find((x) => x.uid === String(b.uid));
    writeConfig({ vip: { users: cfg.vip.users.filter((x) => x.uid !== String(b.uid)) } });
    const vq = readVip();
    vq.queue = vq.queue.filter((q) => q.uid !== String(b.uid));
    writeVip(vq);
    if (u) logAction({ kind: 'vip', target: u.uid, detail: `把「${u.name}」移出了特别关注` });
    return { ...auto.vipView(), users: await vipUsers() };
  },
  'POST /api/vip/import': async () => {
    const list = await bili.specialFollowings();
    const cfg = readConfig();
    const fresh = list.filter((u) => !cfg.vip.users.some((x) => x.uid === u.uid));
    if (fresh.length) writeConfig({ vip: { users: [...cfg.vip.users, ...fresh] } });
    return { ...auto.vipView(), users: await vipUsers(), imported: fresh.length, total: list.length };
  },
  'GET /api/vip/users': async () => ({ users: await vipUsers() }),
  'POST /api/vip/follow': async (_q, b) => {
    await withBlock('follow', () => bili.followUser(String(b.uid)));
    for (const k of cache.keys()) if (k.startsWith('vipRel')) cache.delete(k);
    logAction({ kind: 'follow', target: String(b.uid), title: b.name, detail: `关注了「${b.name || b.uid}」` });
    return { users: await vipUsers() };
  },
  'POST /api/vip/check': async () => {
    const r = await auto.checkVip({ force: true });
    return { ...auto.vipView(), found: r.found };
  },
  'POST /api/vip/run': async () => {
    const st = readState();
    if (st.cooldownUntil && st.cooldownUntil > Date.now()) throw new Error('风控冷却中，先在总览里解除冷却');
    if (auto.liveStatus().running) throw new Error('她已经在刷了');
    if (!auto.vipView().queue.length) throw new Error('特别关注暂时没有新东西');
    auto.runSession({ reason: '面板 · 特别关注', vipOnly: true }).then(() => bust('exp', 'account'));
    await new Promise((r) => setTimeout(r, 300));
    return autopilotView();
  },
  'POST /api/coin/unlock': async () => {
    bili.unlockCoin();
    logAction({ kind: 'autopilot', detail: '手动解锁了投币' });
    return autopilotView();
  },

  // 经验
  'GET /api/exp': async () => cached('exp', 60_000, bili.getExpStatus),

  // 刷视频
  'GET /api/feed': async () => {
    const list = await bili.feedVideos(12);
    logAction({ kind: 'feed', detail: `刷了刷首页推荐（${list.length} 条）` });
    return { list };
  },
  'GET /api/hot': async () => ({ list: await cached('hot', 300_000, () => bili.hotVideos(30)) }),
  'GET /api/search': async (q) => {
    const kw = q.get('q') || '';
    if (!kw) throw new Error('缺关键词');
    const list = await bili.searchVideo(kw, q.get('order') || 'totalrank');
    logAction({ kind: 'search', target: kw, detail: `搜「${kw}」，${list.length} 条` });
    return { list };
  },
  'GET /api/video': async (q) => {
    const bvid = q.get('bvid');
    if (!bvid) throw new Error('缺 bvid');
    const video = await bili.browseVideo(bvid);
    logAction({ kind: 'view', target: bvid, title: video.title, detail: `打开了《${video.title}》` });
    return { video };
  },
  'GET /api/comments': async (q) => bili.videoComments(q.get('bvid'), q.get('aid'), Number(q.get('page') || 1)),
  'GET /api/history': async () => ({ list: await cached('history', 60_000, () => bili.watchHistory(30)) }),

  'POST /api/like': async (_q, b) => {
    await withBlock('like', () => bili.likeVideo(b.bvid, b.like !== false));
    logAction({ kind: 'like', target: b.bvid, title: b.title, detail: b.like !== false ? `给《${b.title || b.bvid}》点了赞` : '取消赞' });
    return { ok: true };
  },
  'POST /api/share': async (_q, b) => {
    await withBlock('share', () => bili.shareVideo(b.bvid));
    bust('exp');
    logAction({ kind: 'share', target: b.bvid, title: b.title, detail: `分享了《${b.title || b.bvid}》` });
    return { ok: true };
  },
  'POST /api/favorite': async (_q, b) => {
    const r = await withBlock('favorite', () => bili.favoriteVideo(b.bvid));
    if (!r.already) logAction({ kind: 'favorite', target: b.bvid, title: b.title, detail: `收藏了《${b.title || b.bvid}》` });
    return { ok: true, already: r.already };
  },
  'POST /api/coin': async (_q, b) => {
    try {
      const r = await bili.coinVideo(b.bvid, 1);
      bust('exp', 'account');
      logAction({ kind: 'coin', target: b.bvid, title: b.title, detail: `给《${b.title || b.bvid}》投了 1 个币` });
      return r;
    } catch (e) {
      logAction({ kind: 'coin', ok: false, target: b.bvid, error: e.message, detail: '投币失败' });
      throw e;
    }
  },
  'POST /api/comment': async (_q, b) => {
    const { bvid, oid, type, message, rootRpid, parentRpid, title } = b;
    if (!message || (!bvid && !oid)) throw new Error('缺视频或内容');
    const r = await bili.postComment({ bvid, oid, type, message, rootRpid, parentRpid });
    logAction({ kind: rootRpid ? 'reply_comment' : 'comment', target: bvid || oid, title, detail: message.slice(0, 120) });
    bust('replyFeed');
    return { ok: true, rpid: r.rpid };
  },

  // 消息中心
  'GET /api/inbox/unread': async () => cached('unread', 30_000, bili.unreadCounts),
  'GET /api/inbox/reply': async () => { const list = await cached('replyFeed', 30_000, bili.replyFeed); bust('unread'); return { list }; },
  'GET /api/inbox/at': async () => { const list = await cached('atFeed', 30_000, bili.atFeed); bust('unread'); return { list }; },
  'GET /api/inbox/like': async () => { const list = await cached('likeFeed', 60_000, bili.likeFeed); bust('unread'); return { list }; },
  'GET /api/messages/sessions': async () => ({ list: await cached('sessions', 20_000, bili.listSessions) }),
  'GET /api/messages/list': async (q) => {
    const talkerId = q.get('talkerId');
    if (!talkerId) throw new Error('缺 talkerId');
    return { list: await bili.listMessages(talkerId) };
  },
  'POST /api/messages/read': async (_q, b) => {
    if (!b.talkerId) throw new Error('缺 talkerId');
    await bili.markSessionRead(b.talkerId, b.seqno);
    bust('sessions', 'unread');
    return { ok: true };
  },
  'POST /api/messages/send': async (_q, b) => {
    if (!b.uid || !b.text) throw new Error('缺 uid 或 text');
    const r = await bili.sendPrivateMessage(b.uid, b.text);
    logAction({ kind: 'dm_send', target: b.uid, title: b.name, detail: b.text.slice(0, 120) });
    bust('sessions');
    return { ok: true, msgKey: r.msgKey };
  },

  // AI 起草回复（只起草，不发）
  'POST /api/ai/reply': async (_q, b) => {
    const text = await llm.draftReply({ context: b.context, message: b.message, kind: b.kind });
    if (!text) throw new Error('她没想好怎么回（或者内容没过安全检查），自己写一句吧');
    return { text };
  },
  'POST /api/ai/comment': async (_q, b) => {
    const video = await bili.browseVideo(b.bvid);
    const text = await llm.draftComment(video, { essential: true });
    if (!text) throw new Error('她觉得这个视频没什么想说的');
    return { text };
  },

  // 待审
  'GET /api/review': async () => ({ list: readReview().slice(0, 60) }),
  'POST /api/review/approve': async (_q, b) => {
    const r = await auto.approveReview(b.id, b.text, 'panel');
    bust('replyFeed');
    return { ok: true, ...r };
  },
  'POST /api/review/reject': async (_q, b) => { auto.rejectReview(b.id, 'panel'); return { ok: true }; },

  // 接口被拦、等你在「她的浏览器」里点的
  'GET /api/wishes': async () => ({ list: readWishes() }),
  'POST /api/wishes/done': async (_q, b) => { finishWish(b.id || '*'); return { list: readWishes() }; },
  // 在「她的浏览器」里打开：共用引擎的登录态，不用（也不能）在浏览器里重新登录她的号
  'POST /api/browser/open': async (_q, b) => {
    if (!/^BV\w{10}$/.test(b.bvid || '')) throw new Error('要给 BV 号');
    return openAsHer(`https://www.bilibili.com/video/${b.bvid}`);
  },

  // 她的内心
  'GET /api/mind': async () => mind.dayViewWithSky(),
  // 她的记忆流：记错了的可以删
  'POST /api/memory/delete': async (_q, b) => ({ ok: memory.remove(String(b.id || '')), ...memory.memoryView(50) }),
  'POST /api/memory/update': async (_q, b) => {
    if (!memory.update(String(b.id || ''), { text: b.text, imp: b.imp })) throw new Error('没改成：找不到这条，或者内容是空的 / 没过安全检查');
    return memory.memoryView(50);
  },
  'POST /api/memory/tidy': async () => ({ result: await mind.tidyMemory(), ...memory.memoryView(50) }),
  // 洞察审核池（mind.insightReview 开着才有待审）：放行 → 转正进记忆流；丢掉 → 不进
  'POST /api/memory/insight/approve': async (_q, b) => { if (!mind.approveInsight(Number(b.i))) throw new Error('没这条待审的'); return { ...memory.memoryView(50), insightPending: mind.readMind().insightPending || [] }; },
  'POST /api/memory/insight/reject': async (_q, b) => { if (!mind.rejectInsight(Number(b.i))) throw new Error('没这条待审的'); return { ...memory.memoryView(50), insightPending: mind.readMind().insightPending || [] }; },
  'POST /api/social/check': async () => {
    if (!social.socialOn()) throw new Error('先打开「评论区社交」并配好模型');
    const r = await social.checkInbox({ essential: true });
    bust('unread', 'replyFeed');
    return { note: r.note, social: social.socialView() };
  },

  // QQ 提醒
  'POST /api/notify/test': async () => ({ ok: true, ...(await notify.sendOwner('🐟 测试一下：以后有要你审的东西，我会在这里叫你～')) }),
  'GET /api/notify': async () => notify.status(),

  // 表情包管理（面板「表情包」页）：备注就是她挑表情的依据，改完立刻生效
  'GET /api/stickers': async () => ({ list: stickers.listStickers() }),
  'POST /api/stickers/upload': async (_q, b) => { stickers.uploadSticker({ name: b.name, note: b.note, selfie: !!b.selfie, data: b.data }); return { list: stickers.listStickers() }; },
  'POST /api/stickers/note': async (_q, b) => { stickers.setNote(String(b.name || ''), String(b.note || ''), !!b.selfie); return { list: stickers.listStickers() }; },
  'POST /api/stickers/delete': async (_q, b) => { stickers.deleteSticker(String(b.name || '')); return { list: stickers.listStickers() }; },

  // QQ 小号
  'GET /api/qq': async () => ({ ...qq.status(), persona: (await import('./qq/brain.mjs')).personaInfo() }),
  'POST /api/qq/test': async () => qq.test(),
  'POST /api/qq/import-dsh': async () => ({ ...(await owner.importDsh()), ...qq.status() }),
  'POST /api/qq/fact/delete': async (_q, b) => { owner.removeFact(String(b.id || '')); return qq.status(); },
  'POST /api/qq/fact/update': async (_q, b) => { owner.updateFact(String(b.id || ''), String(b.text || '')); return qq.status(); },
  // 试听嗓音：面板「她的嗓音」旁边点一下，用 edge-tts 合成一句现场放（voice 传微软音色 id，空 = 默认）
  'POST /api/qq/voice-test': async (_q, b) => {
    const { edgeTtsMp3 } = await import('./qq/etts.mjs');
    const buf = await edgeTtsMp3(String(b.text || '你好呀，我是蓝色大肥鱼，听听我的新声音～'), b.voice || '');
    return { audio: buf.toString('base64') };
  },

  // 日记
  'GET /api/diary': async () => {
    const all = readJsonl(FILES.diary);
    const published = all.filter((e) => e.type === 'published');
    const drafts = all.filter((e) => e.type === 'draft').reverse().slice(0, 30).map((d) => ({
      ...d, dynId: published.find((p) => p.date === d.date && p.ts >= d.ts)?.dynId || null,
    }));
    return { drafts, publishedToday: published.some((p) => p.date === localDate()) };
  },
  'POST /api/diary/publish': async (_q, b) => {
    const text = String(b.text || '').trim();
    if (!text) throw new Error('写点什么再发');
    return auto.publishDiary(text, 'panel', { force: true });
  },
};

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${HOST}:${PORT}`);
  const p = url.pathname;
  if (!allowed(req)) return json(res, 403, { error: 'forbidden' });

  if (req.method === 'GET' && !p.startsWith('/api/')) {
    if (p.startsWith('/stickers/')) { // 表情包预览：只放行 stickers 目录里的图片文件
      let buf = null;
      try { buf = stickers.readStickerFile(decodeURIComponent(p.slice('/stickers/'.length))); } catch { buf = null; }
      if (buf) {
        res.writeHead(200, { 'Content-Type': MIME[extname(p).toLowerCase()] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
        return res.end(buf);
      }
      return json(res, 404, { error: 'not found' });
    }
    if (serveStatic(res, p)) return;
    return json(res, 404, { error: 'not found' });
  }
  const handler = routes[`${req.method} ${p}`];
  if (!handler) return json(res, 404, { error: 'not found' });
  try {
    const body = req.method === 'POST' ? await readBody(req) : {};
    return json(res, 200, await handler(url.searchParams, body));
  } catch (err) {
    const msg = String(err?.message || err);
    if (req.method === 'POST') logAction({ kind: 'error', ok: false, error: msg, detail: `${p} 失败` });
    return json(res, 500, { error: msg, code: err?.code ?? null });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`\n🐟 养鱼面板已启动：http://${HOST}:${PORT}\n`);
  auto.startScheduler();
  qq.start(); // 用小号时连 NapCat；用官方机器人时什么都不做
  // QQ 接入体检：DSH 自动升级后插件跟不上会静悄悄掉线，5 分钟看一眼
  setTimeout(() => health.check(), 60_000);
  setInterval(() => health.check(), 5 * 60_000);
});
