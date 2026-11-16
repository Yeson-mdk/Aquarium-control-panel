import './_env.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deflateSync } from 'node:zlib';

// ─── PNG 夹具生成器（8 位 RGB、filter 0）：四象限棋盘图 ────────────────
const CRC_T = (() => { const t = new Int32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c; } return t; })();
const crc32 = (b) => { let c = -1; for (const x of b) c = CRC_T[(c ^ x) & 255] ^ (c >>> 8); return (c ^ -1) >>> 0; };
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const t = Buffer.from(type, 'latin1');
  const c = Buffer.alloc(4); c.writeUInt32BE(crc32(Buffer.concat([t, data])));
  return Buffer.concat([len, t, data, c]);
}
/** 四象限：左上暗、右上亮、左下亮、右下暗（invert 就全反过来） */
function quadPng(size, invert = false) {
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4); ihdr[8] = 8; ihdr[9] = 2;
  const raw = Buffer.alloc(size * (size * 3 + 1));
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const bright = (x >= size / 2) !== (y >= size / 2);
    const v = (invert ? !bright : bright) ? 230 : 20;
    const o = y * (size * 3 + 1) + 1 + x * 3;
    raw[o] = v; raw[o + 1] = v; raw[o + 2] = v;
  }
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

// ─── JPEG 夹具（PowerShell System.Drawing 生成的真实基线 JPEG）────────
// a=64px 四象限 / a-small=32px 同图案 / b=64px 反相。检验解码器对着真 JPEG 码流能干活
const JPG_A = Buffer.from('/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAcFBQYFBAcGBQYIBwcIChELCgkJChUPEAwRGBUaGRgVGBcbHichGx0lHRcYIi4iJSgpKywrGiAvMy8qMicqKyr/2wBDAQcICAoJChQLCxQqHBgcKioqKioqKioqKioqKioqKioqKioqKioqKioqKioqKioqKioqKioqKioqKioqKioqKir/wAARCABAAEADASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwD5tooooAKKKKAP0jooooAKKKKAPzcooooAKKKKAP0jooooAKKKKACiiigAooooA/NyiiigAooooA/SOiiigAooooA/NyiiigAooooA/9k=', 'base64');
const JPG_A_SMALL = Buffer.from('/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAcFBQYFBAcGBQYIBwcIChELCgkJChUPEAwRGBUaGRgVGBcbHichGx0lHRcYIi4iJSgpKywrGiAvMy8qMicqKyr/2wBDAQcICAoJChQLCxQqHBgcKioqKioqKioqKioqKioqKioqKioqKioqKioqKioqKioqKioqKioqKioqKioqKioqKir/wAARCAAgACADASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwD5tooooA/SOiiigAooooA/NyiiigD/2Q==', 'base64');
const JPG_B = Buffer.from('/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAcFBQYFBAcGBQYIBwcIChELCgkJChUPEAwRGBUaGRgVGBcbHichGx0lHRcYIi4iJSgpKywrGiAvMy8qMicqKyr/2wBDAQcICAoJChQLCxQqHBgcKioqKioqKioqKioqKioqKioqKioqKioqKioqKioqKioqKioqKioqKioqKioqKioqKir/wAARCABAAEADASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwD6RooooAKKKKAPzcooooAKKKKAP0jooooAKKKKAPzcooooAKKKKACiiigAooooA/SOiiigAooooA/NyiiigAooooA/SOiiigAooooA/9k=', 'base64');

const memeimg = await import('../memeimg.mjs');

test('解码：PNG 四象限图解出灰度，方位对得上', () => {
  const g = memeimg.decodeGray(quadPng(16));
  assert.equal(g.w, 16);
  assert.equal(g.h, 16);
  const px = (x, y) => g.gray[y * g.w + x];
  assert.ok(px(3, 3) < 80, '左上暗');
  assert.ok(px(12, 3) > 180, '右上亮');
  assert.ok(px(3, 12) > 180, '左下亮');
  assert.ok(px(12, 12) < 80, '右下暗');
});

test('dHash：同图案不同尺寸靠得近，反相离得远（PNG）', () => {
  const a = memeimg.dHash(quadPng(64));
  const small = memeimg.dHash(quadPng(24));
  const inv = memeimg.dHash(quadPng(64, true));
  assert.match(a, /^[0-9a-f]{16}$/, '64 位指纹存成 16 位十六进制');
  assert.ok(memeimg.hamming(a, small) <= 10, `缩放不改指纹（实测 ${memeimg.hamming(a, small)}）`);
  assert.ok(memeimg.hamming(a, inv) > 10, `反相超过同一张阈值（实测 ${memeimg.hamming(a, inv)}）`);
});

test('解码：真 JPEG 码流也解得开（基线、灰度单通道）', () => {
  const g = memeimg.decodeGray(JPG_A);
  assert.equal(g.w, 64);
  assert.equal(g.h, 64);
  const a = memeimg.dHash(JPG_A);
  const small = memeimg.dHash(JPG_A_SMALL);
  const b = memeimg.dHash(JPG_B);
  assert.ok(memeimg.hamming(a, small) <= 10, `64px 和 32px 同图案：同一张（实测 ${memeimg.hamming(a, small)}）`);
  assert.ok(memeimg.hamming(a, b) > 10, `反相超过同一张阈值（实测 ${memeimg.hamming(a, b)}）`);
});

test('解不动的图：返回 null 不炸（垃圾字节 / 截断 JPEG / webp）', () => {
  assert.equal(memeimg.dHash(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10])), null, '截断的 JPEG');
  assert.equal(memeimg.dHash(Buffer.alloc(64, 0xab)), null, '垃圾字节');
  assert.equal(memeimg.dHash(Buffer.from('UklGRv', 'base64').subarray(0, 3)), null, 'webp 头：跳过指纹，不挡正事');
});

test('梗图库：记住→再见面认得出，反相的认不出；条目数/见面次数在长', () => {
  const png = quadPng(32);
  const { hash, hit } = memeimg.recognize(png);
  assert.equal(hit, null, '第一次见：库里没有');
  memeimg.remember(hash, { kind: 'meme', textOnImage: '鱼鱼蒸', scene: '一只鱼举着牌子', emotion: '无语', desc: '图上文字：鱼鱼蒸；一只鱼举着牌子，意思是无语' }, 'g:md1');
  memeimg.remember(memeimg.dHash(png), { kind: 'meme', desc: '再见一次' }, 'g:md2'); // 第二次见：算旧账不是新条目
  const r2 = memeimg.recognize(quadPng(32));
  assert.ok(r2.hit, '第二张同款（可能被 QQ 重压缩过）：认出');
  assert.equal(r2.hit.count, 2, '见面次数累加');
  assert.equal(r2.hit.textOnImage, '鱼鱼蒸', '第一次看懂的字还留着');
  assert.ok(r2.hit.peers.includes('g:md1') && r2.hit.peers.includes('g:md2'), '谁常发有记账');
  assert.equal(memeimg.recognize(quadPng(32, true)).hit, null, '反相是另一张图，认不出');
});

test('cachedSee：同一张图第二次零视觉调用；面板改的描述不会被下一次自动描述盖掉', async () => {
  for (const e of memeimg.list()) memeimg.remove(e.hash); // 别受上一个用例的库影响
  let calls = 0;
  const describe = async () => {
    calls++;
    return { kind: 'meme', desc: '图上文字：鱼鱼蒸；一只鱼举着牌子，意思是无语', textOnImage: '鱼鱼蒸', scene: '一只鱼举着牌子', emotion: '无语', motion: '' };
  };
  const png = quadPng(40);
  const a = await memeimg.cachedSee(png, { describe, peer: 'g:aa' });
  assert.equal(a.cached, false);
  assert.equal(calls, 1);
  const b = await memeimg.cachedSee(quadPng(30), { describe, peer: 'g:bb' });
  assert.equal(b.cached, true, '同图案不同尺寸：库认得');
  assert.equal(b.textOnImage, '鱼鱼蒸');
  assert.equal(calls, 1, '第二次没调视觉模型');
  // 面板改了描述：命中时用改后的，且不会触发视觉
  assert.ok(memeimg.update(b.hash, { desc: '图上文字：鱼鱼蒸；改过的描述' }));
  const c = await memeimg.cachedSee(png, { describe });
  assert.equal(c.cached, true);
  assert.match(c.desc, /改过的描述/);
  assert.match(c.desc, /图上文字：鱼鱼蒸/, '题眼还在，梗百科那条路接得上');
  assert.equal(calls, 1);
  assert.ok(memeimg.list().some((x) => x.hash === b.hash), '面板列表能拿到');
  assert.equal(memeimg.remove(b.hash), true);
  assert.equal(memeimg.recognize(png).hit, null, '删掉就认不出');
});

test('cachedSee：老版 seeImage 返回字符串也兼容，字符串没有 kind 不入库', async () => {
  for (const e of memeimg.list()) memeimg.remove(e.hash);
  const r = await memeimg.cachedSee(quadPng(52), { describe: async () => '猫猫瘫倒，意思是摆烂' });
  assert.equal(r.desc, '猫猫瘫倒，意思是摆烂');
  assert.equal(r.kind, null);
  assert.equal(memeimg.list().length, 0, '字符串没有结构化 kind，不往梗图库塞');
});
