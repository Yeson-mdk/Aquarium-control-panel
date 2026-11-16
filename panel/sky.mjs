/**
 * 她的窗（sky）
 *
 * 以前她只知道「现在是 21 点」。这里给她开一扇窗：外面天黑没黑、太阳几点落的、今晚什么月亮、
 * 下没下雨、冷不冷。这些都是此刻真的天，不是编的：
 *
 *  - 太阳高度、日出日落按经纬度现算（够准到一两分钟），星星什么时候出来就看太阳在不在地平线下 6° 以下；
 *  - 月相按日月黄经差算，给名字和亮面百分比；
 *  - 天气用高德（免费 Key，面板「她的窗」里填），一小时最多查一次，查不到就只说时间和日照。
 *
 * 地点在面板「自动养号 → 她的窗」里填城市名，保存时查成经纬度；没填就只有时间。
 * 拼出来的一段话喂给 mind.mjs：刷之前想看什么、刷完心情怎么变、睡前反思，都能跟着天走。
 */
import { readFileSync, writeFileSync, renameSync } from 'node:fs';
import { FILES, readConfig, readSecrets, nowIso } from './store.mjs';

const RAD = Math.PI / 180;
const DAY = 86400_000;
const J2000 = Date.UTC(2000, 0, 1, 12);

/** 太阳高度角（度）。低精度太阳历，误差在 0.1° 以内，够用了 */
export function sunAltitude(date, lat, lon) {
  const d = (date.getTime() - J2000) / DAY;
  const g = (357.529 + 0.98560028 * d) * RAD;
  const q = 280.459 + 0.98564736 * d;
  const L = (q + 1.915 * Math.sin(g) + 0.020 * Math.sin(2 * g)) * RAD;
  const e = (23.439 - 0.00000036 * d) * RAD;
  const ra = Math.atan2(Math.cos(e) * Math.sin(L), Math.cos(L));
  const dec = Math.asin(Math.sin(e) * Math.sin(L));
  const gmst = 18.697374558 + 24.06570982441908 * d; // 小时
  const H = (gmst * 15 + lon) * RAD - ra;
  return Math.asin(Math.sin(lat * RAD) * Math.sin(dec) + Math.cos(lat * RAD) * Math.cos(dec) * Math.cos(H)) / RAD;
}

/** 本地这一天的日出、日落（太阳上沿碰地平线，-0.833°）。极昼极夜返回 null */
export function sunTimes(date, lat, lon) {
  const start = new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
  const H0 = -0.833;
  const at = (t) => sunAltitude(new Date(t), lat, lon) - H0;
  const find = (a, b) => {
    for (let i = 0; i < 30; i++) { const m = (a + b) / 2; if ((at(a) < 0) === (at(m) < 0)) a = m; else b = m; }
    return new Date(Math.round((a + b) / 2));
  };
  let rise = null;
  let set = null;
  const step = 10 * 60_000;
  for (let t = start; t < start + DAY; t += step) {
    const a = at(t);
    const b = at(t + step);
    if (a < 0 && b >= 0 && !rise) rise = find(t, t + step);
    if (a >= 0 && b < 0 && !set) set = find(t, t + step);
  }
  return { rise, set };
}

const SYNODIC = 29.530588853;
// 朔、望、上下弦只算前后一天左右，其余是蛾眉、盈凸、亏凸、残月 —— 不然亮了九成多就叫满月，早了两天
const PHASES = [[1, '新月'], [6.38, '蛾眉月'], [8.38, '上弦月'], [13.77, '盈凸月'], [15.76, '满月'], [21.15, '亏凸月'], [23.15, '下弦月'], [28.53, '残月'], [Infinity, '新月']];

/**
 * 月相：按太阳、月亮的视黄经差（低精度月历，主要摄动项都带上）算，
 * 亮面比例误差在 1% 左右。返回月龄（天，按黄经差折算）、名字、亮面比例 0~1
 */
export function moonPhase(date) {
  const d = (date.getTime() - J2000) / DAY;
  const n = (x) => ((x % 360) + 360) % 360;
  const Ls = n(280.459 + 0.98564736 * d);
  const Ms = n(357.529 + 0.98560028 * d) * RAD;
  const sunLon = Ls + 1.915 * Math.sin(Ms) + 0.020 * Math.sin(2 * Ms);
  const Lm = n(218.316 + 13.176396 * d);
  const Mm = n(134.963 + 13.064993 * d) * RAD;
  const D = n(297.850 + 12.190749 * d) * RAD;
  const F = n(93.272 + 13.229350 * d) * RAD;
  const moonLon = Lm + 6.289 * Math.sin(Mm) + 1.274 * Math.sin(2 * D - Mm) + 0.658 * Math.sin(2 * D)
    + 0.214 * Math.sin(2 * Mm) - 0.186 * Math.sin(Ms) - 0.114 * Math.sin(2 * F);
  const elong = n(moonLon - sunLon);
  const age = (elong / 360) * SYNODIC;
  return { age, name: PHASES.find(([x]) => age < x)[1], lit: (1 - Math.cos(elong * RAD)) / 2 };
}

const p2 = (n) => String(n).padStart(2, '0');
const hm = (d) => `${p2(d.getHours())}:${p2(d.getMinutes())}`;
const WEEK = '日一二三四五六';

/** 一天里的哪个时候：有经纬度就看太阳，没有就看钟 */
export function partOfDay(date, alt = null) {
  const h = date.getHours();
  if (alt === null) {
    if (h < 5) return '深夜';
    if (h < 7) return '清早';
    if (h < 9) return '早上';
    if (h < 11) return '上午';
    if (h < 13) return '中午';
    if (h < 18) return '下午';
    if (h < 23) return '晚上';
    return '深夜';
  }
  if (alt > 0) return h < 9 ? '早上' : h < 11 ? '上午' : h < 13 ? '中午' : h < 17 ? '下午' : '傍晚';
  if (alt > -6) return h < 12 ? '天快亮了' : '天刚黑';
  if (h >= 23 || h < 4) return '深夜';
  return h < 12 ? '凌晨' : '晚上';
}

// ─── 天气（缓存一小时） ─────────────────────────────────────
function readCache() {
  try { return JSON.parse(readFileSync(FILES.sky, 'utf-8')); } catch { return null; }
}

export async function weather(lat, lon, { now = Date.now(), fetchFn = fetch } = {}) {
  const key = readSecrets().amapKey; // 高德 Key 没填就不看天气，日照月相照旧
  if (!key) return null;
  const c = readCache();
  if (c && c.lat === lat && c.lon === lon && now - c.at < 3600_000) return c.now;
  try {
    let city = c?.adcode || null; // 天气按高德的区域编码查，之前查到过就接着用
    if (!city && Number.isFinite(lat) && Number.isFinite(lon)) {
      // 老配置只存了经纬度：先用经纬度反查一次区域编码（高德要「经度,纬度」）
      const rg = await (await fetchFn(`https://restapi.amap.com/v3/geocode/regeo?key=${key}&location=${lon},${lat}`, { signal: AbortSignal.timeout(6000) })).json();
      if (String(rg.status) !== '1') throw new Error(rg.info || 'regeo 没查到');
      city = rg.regeocode?.addressComponent?.adcode || null;
    }
    if (!city) return null;
    const wj = await (await fetchFn(`https://restapi.amap.com/v3/weather/weatherInfo?key=${key}&city=${city}&extensions=base`, { signal: AbortSignal.timeout(6000) })).json();
    const live = wj.lives?.[0];
    if (String(wj.status) !== '1' || !live) throw new Error(wj.info || '天气没查到');
    const hu = Number(live.humidity); // 有的城市不给湿度（空串）
    const w = { temp: Math.round(Number(live.temperature) || 0), humidity: live.humidity && Number.isFinite(hu) ? hu : null, text: live.weather };
    const tmp = FILES.sky + '.tmp';
    writeFileSync(tmp, JSON.stringify({ at: now, lat, lon, adcode: city, now: w, savedAt: nowIso() }));
    renameSync(tmp, FILES.sky);
    return w;
  } catch {
    return c && c.lat === lat && c.lon === lon && now - c.at < 6 * 3600_000 ? c.now : null; // 查不到就用几小时内的旧的
  }
}

/** 城市名 → 经纬度 + 区域编码（面板保存设置时用；高德 Key 填在面板「她的窗」里） */
export async function geocode(name, { fetchFn = fetch } = {}) {
  const key = readSecrets().amapKey;
  if (!key) throw new Error('还没填高德 Key（面板「她的窗」里填；lbs.amap.com 注册就有，个人免费）');
  const url = `https://restapi.amap.com/v3/geocode/geo?key=${key}&address=${encodeURIComponent(name)}`;
  const j = await (await fetchFn(url, { signal: AbortSignal.timeout(8000) })).json();
  const g = j.geocodes?.[0];
  if (String(j.status) !== '1' || !g) throw new Error(`找不到「${name}」这个地方，换个写法试试（比如「深圳」「杭州市」）`);
  const [lon, lat] = String(g.location || ',').split(',').map(Number); // 高德给的是「经度,纬度」，别拿反
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) throw new Error('高德给的坐标不对，先不存');
  const who = (Array.isArray(g.city) ? '' : String(g.city || '')) || String(g.district || '') || String(name); // 直辖市的 city 是空数组
  return { lat: Math.round(lat * 100) / 100, lon: Math.round(lon * 100) / 100, adcode: g.adcode || null, label: [who, String(g.province || '')].filter((x, i, a) => x && a.indexOf(x) === i).join('，') };
}

/**
 * 拼成给她看的一段，比如：
 * 「现在是 10月21日 周三 晚上 21:45。外面晴，29°C（体感 31°），湿度 59%；太阳 17:51 就落山了，今晚是盈凸月，亮了 86%。」
 */
export async function skyText({ now = new Date(), cfg = readConfig().sky, fetchFn } = {}) {
  const date = `${now.getMonth() + 1}月${now.getDate()}日 周${WEEK[now.getDay()]}`;
  const has = cfg?.enabled !== false && Number.isFinite(cfg?.lat) && Number.isFinite(cfg?.lon);
  if (!has) return `现在是 ${date} ${partOfDay(now)} ${hm(now)}。`;

  const alt = sunAltitude(now, cfg.lat, cfg.lon);
  const { rise, set } = sunTimes(now, cfg.lat, cfg.lon);
  const parts = [];
  const w = await weather(cfg.lat, cfg.lon, { now: now.getTime(), fetchFn });
  if (w) parts.push(`外面${w.text || ''}，${w.temp}°C${w.humidity != null ? `，湿度 ${w.humidity}%` : ''}`);
  if (alt > 0) parts.push(set && set > now ? `太阳还挂着，${hm(set)} 落山` : '太阳还挂着');
  else if (rise && now < rise) parts.push(`天还没亮，${hm(rise)} 日出`);
  else if (set) parts.push(`太阳 ${hm(set)} 就落山了${alt < -6 ? '' : '，天边还有点亮'}`);
  if (alt < -6) {
    const m = moonPhase(now);
    parts.push(m.name === '新月' ? '今晚没月亮' : `今晚是${m.name}，亮了 ${Math.round(m.lit * 100)}%`);
  }
  return `现在是 ${date} ${partOfDay(now, alt)} ${hm(now)}${cfg.label ? `，你在${cfg.label}` : ''}。${parts.join('；')}${parts.length ? '。' : ''}`;
}
