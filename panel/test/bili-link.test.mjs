import './_env.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';

const bili = await import('../bili.mjs');

test('resolveBv：裸 BV 号直接认', async () => {
  assert.equal(await bili.resolveBv('BV1xx411c7mD'), 'BV1xx411c7mD');
});

test('resolveBv：长链里提 BV', async () => {
  assert.equal(await bili.resolveBv('https://www.bilibili.com/video/BV1Yx411c7mZ?spm_id_from=333'), 'BV1Yx411c7mZ');
});

test('resolveBv：短链跟随跳转到长链再提 BV', async () => {
  const fakeFetch = async (url) => ({ url: url.includes('b23.tv') ? 'https://www.bilibili.com/video/BV1Kx411c7mQ' : '' });
  assert.equal(await bili.resolveBv('【养了两个月的鲸鲸，死了】 https://b23.tv/p1xDtr2', { fetchFn: fakeFetch }), 'BV1Kx411c7mQ');
});

test('resolveBv：非 B站 链接 / 跳转后没 BV → 空串，不瞎猜', async () => {
  const fakeFetch = async () => ({ url: 'https://example.com/somewhere' });
  assert.equal(await bili.resolveBv('看看这个 https://example.com/foo', { fetchFn: fakeFetch }), '');
  assert.equal(await bili.resolveBv('随便说句话', { fetchFn: fakeFetch }), '');
});
