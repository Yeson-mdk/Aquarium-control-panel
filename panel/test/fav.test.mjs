import './_env.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';

const fav = await import('../fav.mjs');
const day = (n, h = 12) => new Date(2026, 9, 20 + n, h); // 2026-10-20 起

test('第一次说话：建档 50 分、还没聊满一天', () => {
  fav.applyDelta(111, 1, '被夸了', { now: day(0) });
  const u = fav.readFav().users['111'];
  assert.equal(u.fav, 50);
  assert.equal(u.activeDays, 0);
  assert.equal(u.today.deltas.length, 1);
});

test('applyDelta 带名字：档案里记的是人', () => {
  fav.applyDelta(112, 1, '', { nickname: '小明', now: day(0) });
  assert.equal(fav.readFav().users['112'].nickname, '小明');
});

test('单条封顶 ±2、单日封顶 ±5；首日好感被当天定调', () => {
  fav.applyDelta(222, 9, '狂夸', { now: day(0) });
  for (let i = 0; i < 5; i++) fav.applyDelta(222, 2, '夸', { now: day(0, 13) });
  assert.equal(fav.todayNet(222), 12);
  fav.settleAll(day(1));
  const u = fav.readFav().users['222'];
  assert.equal(u.activeDays, 1);
  assert.equal(u.fav, 80); // 首日 α=1：T = 50 + 5×6
  assert.equal(u.history[0].d, 5);
  assert.equal(u.history[0].favAfter, 80);
});

test('次日起按天数加权', () => {
  fav.applyDelta(333, 1, '', { now: day(0) });
  fav.settleAll(day(1));
  assert.equal(fav.readFav().users['333'].fav, 56);
  fav.applyDelta(333, -1, '', { now: day(1) });
  fav.settleAll(day(2));
  const u = fav.readFav().users['333'];
  assert.equal(u.activeDays, 2);
  assert.equal(u.fav, 53); // (56 + 50) / 2
});

test('老朋友吵一周架，好感照样掉（不冻死）', () => {
  for (let i = 0; i < 150; i++) {
    fav.applyDelta(444, 2, '', { now: day(i) });
    fav.settleAll(day(i + 1));
  }
  let u = fav.readFav().users['444'];
  assert.equal(u.fav, 95);
  for (let i = 150; i < 157; i++) {
    fav.applyDelta(444, -2, '', { now: day(i) });
    fav.settleAll(day(i + 1));
  }
  u = fav.readFav().users['444'];
  assert.ok(u.fav <= 93, `掉了才 ${u.fav}`);
});

test('一直讨厌，也就停在 5，不会到 0', () => {
  fav.applyDelta(555, -2, '', { now: day(0) });
  fav.settleAll(day(1));
  for (let i = 1; i < 45; i++) {
    fav.applyDelta(555, -2, '', { now: day(i) });
    fav.settleAll(day(i + 1));
  }
  assert.equal(fav.readFav().users['555'].fav, 5);
});

test('懒结算：隔天再聊，昨天的账先结掉', () => {
  fav.applyDelta(666, 1, '', { now: day(0) });
  fav.applyDelta(666, 1, '', { now: day(2) });
  const u = fav.readFav().users['666'];
  assert.equal(u.activeDays, 1);
  assert.equal(u.fav, 56);
  assert.equal(u.today.deltas.length, 1);
});

test('没聊天就不算天数', () => {
  fav.ensureUser(777);
  fav.settleAll(day(5));
  const u = fav.readFav().users['777'];
  assert.equal(u.activeDays, 0);
  assert.equal(u.fav, 50);
});

test('favText：给大脑看的口气', () => {
  fav.applyDelta(888, 2, '', { now: day(0) });
  const t = fav.favText(888, { now: day(0, 13) });
  assert.match(t, /长期好感 50%/);
  assert.match(t, /聊过 0 天/);
  assert.match(t, /今天聊下来挺舒服/);
});

test('断聊淡忘：一周没来往开始淡，长断一次最多补 5 分', () => {
  fav.applyDelta(777, 1, '', { now: day(0) });
  fav.settleAll(day(1));
  const base = fav.readFav().users['777'].fav; // 56（首日 α=1）
  fav.settleAll(day(16)); // 16 天没来往：floor(16/7)=2 → 淡 2 分
  let u = fav.readFav().users['777'];
  assert.equal(u.fav, base - 2, '每满 7 天淡 1 分');
  assert.equal(u.history.at(-1).decay, 2, '淡忘也记进历史');
  fav.settleAll(day(23)); // 又过 7 天：再淡 1
  u = fav.readFav().users['777'];
  assert.equal(u.fav, base - 3, '淡过重新起算，之后一周一淡');
});

test('没断聊就不淡：有来往的日子重置计时', () => {
  fav.applyDelta(888, 1, '', { now: day(0) });
  fav.settleAll(day(1));
  const before = fav.readFav().users['888'].fav;
  fav.applyDelta(888, 0, '', { now: day(1) }); // 当天有来往，没记分也不算断
  fav.settleAll(day(2));
  fav.settleAll(day(3));
  assert.equal(fav.readFav().users['888'].fav, before, '有来往就不淡');
});
