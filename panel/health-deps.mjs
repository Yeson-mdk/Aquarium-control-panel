/**
 * 外部依赖探活（架构升级批次 C6）
 *
 * health.mjs 原本只查 QQ 小号连没连上 NapCat。这里补四样她干活要用的外部依赖：
 *   modelscope —— 向量/视觉接口的钥匙（复用 llm.embed）
 *   edge-tts  —— 发语音用的微软朗读接口（speak 一句短的）
 *   sqmusic   —— 学歌用的曲库（登录一次探活）
 *   bilibili  —— B站 Cookie 掉没掉登录（getAccountStatus）
 *
 * 原则：只报「配了却坏了」的，没配的标 skipped（新容器不该一上来四条红）。
 * 每项 probe 可注入（测试用假函数），默认走真模块；单项超时 12 秒，一项挂了不拖垮其他。
 * 节流（每天一次）由 health.mjs 管，本模块只做一次纯探活。
 */
import { readConfig } from './store.mjs';

const withTimeout = (p, ms = 12000) => {
  let timer;
  return Promise.race([
    Promise.resolve(p).finally(() => clearTimeout(timer)), // 正常返回就撤掉计时器，别在事件循环里挂 12 秒
    new Promise((_, rej) => { timer = setTimeout(() => rej(new Error('探活超时')), ms); }),
  ]);
};

const DEFAULTS = {
  modelscope: async () => {
    const llm = await import('./llm.mjs');
    if (!llm.embedReady()) return { status: 'skipped', detail: '没配向量/视觉钥匙' };
    const v = await llm.embed(['探活']);
    if (!v?.[0]?.length) throw new Error(llm.embedError() || '没回有效向量');
    return { status: 'ok', detail: '向量接口通' };
  },
  edgeTts: async () => {
    // 真 synthesize 一句最短的话；接口变了/被墙/证书问题都会在这暴露
    const { edgeTtsMp3 } = await import('./qq/etts.mjs');
    const buf = await edgeTtsMp3('嗯', 'Meijia');
    if (!buf?.length) throw new Error('没拿到音频');
    return { status: 'ok', detail: '语音接口通' };
  },
  sqmusic: async () => {
    const q = readConfig().qq || {};
    const base = String(q.sqMusicUrl || '').trim().replace(/\/+$/, '');
    if (!base) return { status: 'skipped', detail: '没填 SqMusic 地址' };
    // 只探地址通不通，不登录不下歌（api 是私有的，探活不该有副作用）
    const r = await fetch(base + '/api/config/login', { method: 'GET', signal: AbortSignal.timeout(8000) });
    if (!r.ok && r.status !== 405 && r.status !== 404) throw new Error(`HTTP ${r.status}`);
    return { status: 'ok', detail: '曲库地址可达' };
  },
  bilibili: async () => {
    const bili = await import('./bili.mjs');
    const st = await bili.getAccountStatus();
    if (!st.loggedIn) throw new Error('Cookie 掉登录了，去面板扫码重登');
    return { status: 'ok', detail: `登录中（${st.uname || 'B站账号'}）` };
  },
};

/** 跑一轮探活。probes 可覆盖单项实现（测试注入）。返回 { results, problems, checkedAt }
 *  problems 项格式跟 health.mjs 一致：{ code, text, fix }，可直接并进健康横幅。 */
export async function probeDeps({ probes = {}, now = Date.now(), timeoutMs = 12000 } = {}) {
  const all = { ...DEFAULTS, ...probes };
  const names = Object.keys(all);
  const settled = await Promise.all(names.map(async (name) => {
    try {
      const r = await withTimeout(all[name](), timeoutMs);
      return [name, { ok: r.status === 'ok', ...r }];
    } catch (e) {
      return [name, { ok: false, status: 'error', detail: String(e.message || e).slice(0, 120) }];
    }
  }));
  const results = Object.fromEntries(settled);
  const FIX = {
    modelscope: '面板「模型设置」检查向量模型 ID 和接口密钥（或 ModelScope 令牌）',
    edgeTts: '发语音走公网微软接口，检查容器出网/DNS；暂时不用语音就先别管',
    sqmusic: '面板「QQ 连接」检查 SqMusic 地址、账号密码；不用学歌可留空',
    bilibili: '面板登录入口重新扫码（Cookie 失效了），B站刷视频/看评论会断',
  };
  const problems = settled
    .filter(([, r]) => r.status === 'error')
    .map(([name, r]) => ({ code: 'dep:' + name, text: `外部依赖「${name}」不通：${r.detail}`, fix: FIX[name] || '检查配置' }));
  return { results, problems, checkedAt: now };
}
