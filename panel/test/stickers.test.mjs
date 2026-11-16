import './_env.mjs';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT } from '../store.mjs';
import * as stickers from '../stickers.mjs';

// 模块直接操作仓库根的 stickers/（线上同款目录），照 qq.test.mjs 的规矩：拍快照、测完还原
const DIR = join(ROOT, 'stickers');
const NOTES = join(DIR, 'notes.json');
let snap = new Set();
let origNotes = '';
before(() => {
  snap = new Set(readdirSync(DIR));
  origNotes = readFileSync(NOTES, 'utf-8');
});
after(() => {
  for (const f of readdirSync(DIR)) if (!snap.has(f)) rmSync(join(DIR, f));
  writeFileSync(NOTES, origNotes);
});

const PNG = Buffer.from('89504e470d0a1a0a' + 'ab'.repeat(64), 'hex'); // png 头 + 填充
const JPG = Buffer.from('ffd8ff' + 'cd'.repeat(64), 'hex');

test('list：文件+备注合成清单，selfie 从备注原文识别（展示时剥掉标记）', () => {
  writeFileSync(join(DIR, 'pool_池.png'), PNG);
  const nt = JSON.parse(readFileSync(NOTES, 'utf-8'));
  nt['pool_池'] = '被要自拍才发，走 send_selfie 随机，别自己挑';
  writeFileSync(NOTES, JSON.stringify(nt, null, 2));
  const list = stickers.listStickers();
  const happy = list.find((x) => x.name === 'happy_开心');
  assert.ok(happy, '原生表情在清单里');
  assert.match(happy.note, /气氛轻松/, '备注拼进来了');
  assert.ok(!happy.selfie, '普通表情不标 selfie');
  const pool = list.find((x) => x.name === 'pool_池');
  assert.ok(pool.selfie, '备注带 send_selfie 的标出来（brain.selfiePool 认的就是这个）');
  assert.ok(!pool.note.includes('send_selfie'), '给号主看的备注里剥掉标记，编辑不会把标记抄重');
  assert.ok(list.every((x) => x.file && !/[\\/]/.test(x.file)), 'file 是纯文件名');
});

test('setNote：改备注即改她挑表情的依据；空备注拦下；selfie 勾选拼回标记', () => {
  writeFileSync(join(DIR, 'edit_改.jpg'), JPG);
  stickers.setNote('edit_改', '被夸的时候', false);
  let nt = JSON.parse(readFileSync(NOTES, 'utf-8'));
  assert.equal(nt['edit_改'], '被夸的时候');
  assert.ok(!nt['happy_开心'].includes('send_selfie'), '别的备注没被波及（写路径读原始文件）');
  stickers.setNote('edit_改', '被要自拍时顶上', true);
  nt = JSON.parse(readFileSync(NOTES, 'utf-8'));
  assert.match(nt['edit_改'], /被要自拍时顶上/);
  assert.match(nt['edit_改'], /send_selfie/, '勾了自拍池，标记拼回备注——brain.selfiePool 认它');
  // 再存一次不带勾：标记要能剥干净，不能越叠越多
  stickers.setNote('edit_改', '被要自拍时顶上', false);
  nt = JSON.parse(readFileSync(NOTES, 'utf-8'));
  assert.ok(!nt['edit_改'].includes('send_selfie'), '取消勾选后标记剥干净了');
  assert.throws(() => stickers.setNote('edit_改', '  ', false), /什么时候用/, '空备注不给存——没备注的图她不知道什么时候发');
  assert.throws(() => stickers.setNote('不存在的图', 'x', false), /没有这张/);
  assert.throws(() => stickers.setNote('../notes', 'x', false), /没有这张/, '路径穿越的名字进不来');
});

test('upload：base64 落盘 + 写备注；重名/坏图/超大名字都拦', () => {
  const f = stickers.uploadSticker({ name: 'new_新图', note: '开心到跳舞时', data: PNG.toString('base64') });
  assert.equal(f, 'new_新图.png', '按魔数认 png');
  assert.ok(readdirSync(DIR).includes('new_新图.png'), '文件真落盘了');
  const nt = JSON.parse(readFileSync(NOTES, 'utf-8'));
  assert.equal(nt['new_新图'], '开心到跳舞时', '备注一起写了');
  assert.throws(() => stickers.uploadSticker({ name: 'new_新图', note: 'x', data: JPG.toString('base64') }), /重名|已经有/, '重名拦下');
  assert.throws(() => stickers.uploadSticker({ name: 'bad_坏图', note: 'x', data: Buffer.from('hello world ！！').toString('base64') }), /png|jpg|gif/, '不是图的不给传');
  assert.throws(() => stickers.uploadSticker({ name: '../evil', note: 'x', data: PNG.toString('base64') }), /名字/, '路径穿越拦下');
  assert.throws(() => stickers.uploadSticker({ name: 'noext', note: 'x', data: PNG.toString('base64') }), /名字/, '不带下划线的怪名字拦下（en_zh 是约定）');
});

test('delete：图和备注一起清，别的备注不动', () => {
  stickers.uploadSticker({ name: 'del_删我', note: '临时', data: PNG.toString('base64') });
  stickers.deleteSticker('del_删我');
  assert.ok(!readdirSync(DIR).some((f) => f.startsWith('del_删我')), '图没了');
  const nt = JSON.parse(readFileSync(NOTES, 'utf-8'));
  assert.ok(!('del_删我' in nt), '备注也没了');
  assert.ok('happy_开心' in nt, '别的还在');
  assert.throws(() => stickers.deleteSticker('del_删我'), /没有这张/);
});
