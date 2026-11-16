/**
 * SqMusic（simple_sq_music_plus）客户端：她「学歌」用
 *
 * 面板里填了 SqMusic 地址（qq.sqMusicUrl）后，learn_song 走这里：
 * 登录拿令牌 → 搜歌 → 拿下载直链 → 自己下进曲库（music/，文件名 = 歌名.mp3）。
 * 不走 SqMusic 自己的下载任务：那要轮询等它下完、文件还落在它的目录结构里（歌手/专辑分层），
 * 拿直链自己下，文件名干净、下完立刻能唱。API 是 3.1.0 才加的，旧容器会登不上——报错原样带给她。
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT, readConfig } from '../store.mjs';

let token = ''; // 登录令牌。SqMusic 返回的 tokenTimeout = -1（不失效），存内存就行
let tokenBase = ''; // 令牌是对着哪个地址登的：面板里换了地址，旧令牌作废重登

const cfg = () => {
  const q = readConfig().qq || {};
  return {
    base: String(q.sqMusicUrl || '').trim().replace(/\/+$/, ''),
    user: String(q.sqMusicUser || 'admin'),
    pass: String(q.sqMusicPass || 'admin'),
  };
};

async function api(path, { method = 'GET', body, relogin = true } = {}) {
  const c = cfg();
  if (!c.base) throw new Error('SqMusic 还没连（面板里没填地址）');
  if (token && tokenBase !== c.base) token = '';
  if (!token) {
    const r = await fetch(`${c.base}/api/config/login`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: c.user, password: c.pass, device: 'web' }), // device 跟网页端一样填 web，别让接口挑理
    });
    const j = await r.json().catch(() => null);
    const d = j?.data;
    token = (d && (d.tokenValue || d.token)) || (typeof d === 'string' ? d : '');
    tokenBase = c.base;
    if (!token) throw new Error(`SqMusic 登录失败：${j?.msg || j?.message || `没发令牌（HTTP ${r.status}），账号密码对吗`}`);
  }
  const r = await fetch(c.base + path, {
    method,
    headers: { sqmusic: token, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  if ((r.status === 401 || r.status === 403) && relogin) { token = ''; return api(path, { method, body, relogin: false }); } // 令牌过期/失效，重登一次再试
  const j = await r.json().catch(() => null);
  if (!r.ok || (j && j.code && j.code !== 200)) throw new Error(j?.msg || j?.message || `SqMusic 接口报错 ${r.status}`); // 它的错误字段叫 msg（AjaxResult.MSG_TAG），只读 message 会把真话吞掉
  return j?.data;
}

/** 从音质列表里挑：QQ 语音反正要压一遍，320k 的 mp3 够了还小；没 mp3 才将就别的 */
function pickBr(brs) {
  const b = Array.isArray(brs) ? brs : [];
  return b.find((x) => /MP3_320/.test(x)) || b.find((x) => /MP3_(192|256)/.test(x)) || b.find((x) => /MP3/.test(x)) || b[0] || '';
}

/**
 * 学一首歌：搜 → 拿直链 → 下进曲库。返回 { name, file, size }；学不了就 throw（message 是能直接说出口的原因）。
 * 学下来的文件名就是歌名（搜索结果里的原名，可能跟他说的不完全一样——学会了按真名报）。
 */
export async function learnSong(songName) {
  const keyword = String(songName || '').trim();
  if (!keyword) throw new Error('没说要学哪首');
  const data = await api(`/api/music/searchSong?plugName=kw&keyword=${encodeURIComponent(keyword)}&pageSize=10&pageIndex=1`); // pageIndex 不传后端直接空指针，pageSize 顺手带上
  const records = Array.isArray(data?.records) ? data.records : [];
  if (!records.length) throw new Error('SqMusic 没搜到这首歌');
  const hit = records.find((r) => String(r.name || '').includes(keyword) || keyword.includes(String(r.name || ''))) || records[0];
  const br = pickBr(hit.brTypes);
  if (!br) throw new Error('这首歌没有能下的音质');
  const dl = await api('/api/music/getDownloadUrl', { method: 'POST', body: { ...hit, brType: br } }); // 要的是整个搜索结果对象（brTypes 在里面，缺了它空指针）+ 手选码率
  const url = typeof dl === 'string' ? dl : dl?.url; // 返回是 {url, errorMsg}，旧文档写的纯字符串也兼容
  if (!url) throw new Error(dl?.errorMsg || 'SqMusic 没给下载链接');
  const res = await fetch(url);
  if (!res.ok) throw new Error(`下载失败（${res.status}）`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length < 1024) throw new Error('下下来的文件是空的，可能链接过期了');
  if (buf.length > 20 * 1024 * 1024) throw new Error('下下来的文件超 20MB，发不动');
  const dir = process.env.YANGYU_MUSIC || join(ROOT, 'music');
  mkdirSync(dir, { recursive: true });
  const name = String(hit.name || keyword).replace(/[/\\:*?"<>|]/g, '').trim().slice(0, 60) || keyword;
  writeFileSync(join(dir, `${name}.mp3`), buf);
  return { name, file: `${name}.mp3`, size: buf.length };
}
