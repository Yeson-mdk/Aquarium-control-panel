import './_env.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
const sky = await import('../sky.mjs');
const { writeSecrets } = await import('../store.mjs');

// 深圳；时间都用带时区的字符串，跟跑测试的机器在哪无关（日出日落按本地「这一天」找，所以只比时刻差）
const SZ = [22.54, 114.06];
const near = (a, b, min) => Math.abs(a.getTime() - b.getTime()) <= min * 60_000;

test('sunTimes：深圳 2026-10-21 日出 06:24、日落 17:52，误差两分钟内', { skip: new Date().getTimezoneOffset() !== -480 && '只在东八区跑' }, () => {
  const t = sky.sunTimes(new Date('2026-10-21T12:00:00+08:00'), ...SZ);
  assert.ok(near(t.rise, new Date('2026-10-21T06:24:00+08:00'), 2), String(t.rise));
  assert.ok(near(t.set, new Date('2026-10-21T17:52:00+08:00'), 2), String(t.set));
});

test('sunAltitude：中午在头顶附近，半夜在地平线下很深', () => {
  assert.ok(sky.sunAltitude(new Date('2026-10-21T12:07:00+08:00'), ...SZ) > 50);
  assert.ok(sky.sunAltitude(new Date('2026-10-22T00:07:00+08:00'), ...SZ) < -60);
});

test('moonPhase：日食那刻是新月，2026-10-26 满月，上弦附近一半亮', () => {
  assert.equal(sky.moonPhase(new Date('2024-04-08T18:21:00Z')).name, '新月');
  const full = sky.moonPhase(new Date('2026-10-26T04:11:00Z'));
  assert.equal(full.name, '满月');
  assert.ok(full.lit > 0.99);
  assert.equal(sky.moonPhase(new Date('2026-10-24T12:53:00Z')).name, '盈凸月', '离满月还有一天半');
  const q = sky.moonPhase(new Date('2026-10-18T16:13:00Z')); // 上弦
  assert.ok(Math.abs(q.lit - 0.5) < 0.05, String(q.lit));
});

test('geocode：高德查城市，经纬度别拿反、带上区域编码；没 Key 时说清楚', async () => {
  writeSecrets({ amapKey: '' });
  await assert.rejects(() => sky.geocode('深圳'), /高德 Key/);
  writeSecrets({ amapKey: 'k' });
  const fetchFn = async () => ({ json: async () => ({ status: '1', geocodes: [{ location: '114.057868,22.543099', adcode: '440300', city: '深圳市', province: '广东省', district: [] }] }) });
  const g = await sky.geocode('深圳', { fetchFn });
  assert.equal(g.lat, 22.54); // 高德给的是「经度,纬度」
  assert.equal(g.lon, 114.06);
  assert.equal(g.adcode, '440300');
  assert.match(g.label, /深圳市/);
  const none = async () => ({ json: async () => ({ status: '1', geocodes: [] }) });
  await assert.rejects(() => sky.geocode('不存在的地方吧', { fetchFn: none }), /找不到/);
});

// 高德的两个接口：regeo 拿区域编码，weatherInfo 拿实况；只数天气那次，方便断言「一小时只查一次」
const fakeAmap = (calls) => async (url) => {
  if (url.includes('/weather/weatherInfo')) { calls.n++; return { json: async () => ({ status: '1', lives: [{ weather: '小雨', temperature: '18', humidity: '80', reporttime: '2026-10-21 21:00:00' }] }) }; }
  if (url.includes('/geocode/regeo')) return { json: async () => ({ status: '1', regeocode: { addressComponent: { adcode: '440300' } } }) };
  throw new Error('unexpected ' + url);
};

test('skyText：有地点就说天气、日落、月亮；天气一小时只查一次', async () => {
  writeSecrets({ amapKey: 'k' });
  const calls = { n: 0 };
  const cfg = { lat: SZ[0], lon: SZ[1], label: '深圳' };
  const now = new Date('2026-10-21T21:45:00+08:00');
  const t = await sky.skyText({ now, cfg, fetchFn: fakeAmap(calls) });
  assert.match(t, /深圳/);
  assert.match(t, /小雨，18°C，湿度 80%/);
  assert.match(t, /落山/);
  assert.match(t, /盈凸月/);
  await sky.skyText({ now: new Date(now.getTime() + 20 * 60_000), cfg, fetchFn: fakeAmap(calls) });
  assert.equal(calls.n, 1);
});

test('skyText：天气查不到也照样说时间；没地点只说时间', async () => {
  const boom = async () => { throw new Error('offline'); };
  const t = await sky.skyText({ now: new Date('2026-10-21T12:00:00+08:00'), cfg: { lat: 30, lon: 120 }, fetchFn: boom });
  assert.match(t, /^现在是 10月21日/);
  assert.match(t, /太阳还挂着/);
  const bare = await sky.skyText({ now: new Date(2026, 9, 21, 9, 30), cfg: { place: '' } });
  assert.equal(bare, '现在是 10月21日 周三 上午 09:30。');
});

test('weather：没填高德 Key 就不看天气；只存了经纬度的老配置会先反查一次区域编码', async () => {
  const calls = { n: 0 };
  writeSecrets({ amapKey: '' });
  assert.equal(await sky.weather(31.2, 121.5, { fetchFn: fakeAmap(calls) }), null);
  assert.equal(calls.n, 0);
  writeSecrets({ amapKey: 'k' });
  const w = await sky.weather(31.2, 121.5, { fetchFn: fakeAmap(calls) });
  assert.deepEqual(w, { temp: 18, humidity: 80, text: '小雨' });
  assert.equal(calls.n, 1); // regeo + weatherInfo，天气只数一次
});

test('partOfDay：天刚黑、深夜', () => {
  assert.equal(sky.partOfDay(new Date(2026, 9, 21, 18, 5), -3), '天刚黑');
  assert.equal(sky.partOfDay(new Date(2026, 9, 21, 23, 30), -60), '深夜');
  assert.equal(sky.partOfDay(new Date(2026, 9, 21, 5, 50), -3), '天快亮了');
});
