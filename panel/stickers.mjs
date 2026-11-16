/**
 * 表情包管理（面板「表情包」页用）：列清单 / 改场合备注 / 传新图 / 删图。
 * 口径和 qq/brain.mjs 一套：stickers/ 目录 + notes.json 是唯一事实源——她挑表情看的就是备注，
 * 改完立刻生效，不用重启。自拍糊弄池的标记是备注里的「send_selfie」字样（brain.selfiePool 认它），
 * 面板上勾「自拍池」就是在备注里拼/剥这段标记，展示时剥掉免得号主编辑时把标记抄重。
 */
import { join } from 'node:path';
import { readdirSync, readFileSync, writeFileSync, rmSync, existsSync, statSync } from 'node:fs';
import { ROOT, logAction } from './store.mjs';

export const DIR = join(ROOT, 'stickers');
const NOTES = join(DIR, 'notes.json');
const IMG = /\.(png|jpe?g|gif)$/i;
const SELFIE_MARK = '（走 send_selfie 随机，别自己挑）';
const MAX_STICKERS = 60; // 和 brain 里 save_sticker 的上限一个口径

const readNotes = () => { try { return JSON.parse(readFileSync(NOTES, 'utf-8')) || {}; } catch { return {}; } };
const writeNotes = (nt) => writeFileSync(NOTES, JSON.stringify(nt, null, 2));
const imgFiles = () => (existsSync(DIR) ? readdirSync(DIR).filter((f) => IMG.test(f)) : []);
const nameOf = (f) => f.slice(0, f.lastIndexOf('.'));

// 名字必须是 en_zh 形式（小写英文数字开头 + 下划线 + 中文/数字尾巴，存图起名同一个约定），杜绝路径穿越
const safeName = (n) => /^[a-z0-9]{1,16}_[\w一-鿿]{1,8}$/.test(n) && !n.includes('..');

// 「走 send_selfie」那截是池子标记：括号形式和旧的逗号形式都要剥得掉（roundtrip 不叠加）
const stripSelfieMark = (s) => String(s || '')
  .replace(/[（(]走 send_selfie[^）)]*[）)]/g, '')
  .replace(/[,，]?\s*走 send_selfie[^）)，,]*/g, '')
  .replace(/[,，]\s*$/, '')
  .trim();

const composeNote = (note, selfie) => {
  const base = stripSelfieMark(note).slice(0, 40);
  if (!base && !selfie) throw new Error('写一句什么时候用——没备注的图她不知道什么时候发');
  return selfie ? `${base}${SELFIE_MARK}` : base;
};

export function listStickers() {
  const nt = readNotes();
  return imgFiles().sort().map((f) => {
    const name = nameOf(f);
    const raw = String(nt[name] || '');
    return { name, file: f, note: stripSelfieMark(raw), selfie: raw.includes('send_selfie'), kb: Math.round(statSync(join(DIR, f)).size / 1024) };
  });
}

export function setNote(name, note, selfie = false) {
  if (!safeName(name) || !imgFiles().some((f) => nameOf(f) === name)) throw new Error('没有这张表情包');
  const nt = readNotes(); // 读原始文件：别的机器上还没传齐的图的备注不能被这里吞掉
  nt[name] = composeNote(note, selfie);
  writeNotes(nt);
  logAction({ kind: 'qq', detail: `表情包管理：号主改了 ${name} 的备注` });
  return nt[name];
}

export function uploadSticker({ name, note = '', selfie = false, data = '' }) {
  if (!safeName(name)) throw new Error('名字用 英文_中文（字母数字下划线加中文，不带空格）');
  const buf = Buffer.from(String(data || ''), 'base64');
  if (!buf || buf.length < 8) throw new Error('图是空的');
  if (buf.length > 8 * 1024 * 1024) throw new Error('图太大了（限 8MB）');
  const ext = (buf[0] === 0x89 && buf[1] === 0x50) ? 'png' : (buf[0] === 0xff && buf[1] === 0xd8) ? 'jpg' : (buf[0] === 0x47 && buf[1] === 0x49) ? 'gif' : null;
  if (!ext) throw new Error('只认 png / jpg / gif');
  if (imgFiles().length >= MAX_STICKERS) throw new Error(`表情包够多了（上限 ${MAX_STICKERS}），先删几张再传`);
  const f = `${name}.${ext}`;
  if (imgFiles().some((x) => nameOf(x) === name)) throw new Error('已经有这个名字了，换一个'); // 按名字判，换个后缀也不算新图
  writeFileSync(join(DIR, f), buf);
  const nt = readNotes();
  nt[name] = composeNote(note, selfie);
  writeNotes(nt);
  logAction({ kind: 'qq', detail: `表情包管理：号主传了 ${f}` });
  return f;
}

export function deleteSticker(name) {
  const f = imgFiles().find((x) => nameOf(x) === name);
  if (!f) throw new Error('没有这张表情包');
  rmSync(join(DIR, f));
  const nt = readNotes();
  delete nt[name];
  writeNotes(nt);
  logAction({ kind: 'qq', detail: `表情包管理：号主删了 ${f}` });
}

/** 面板预览用：/stickers/文件名 → 图（只放行目录里的图片文件，不递归不穿越） */
export function readStickerFile(fileName) {
  const f = String(fileName || '');
  if (!IMG.test(f) || f.includes('/') || f.includes('\\') || f.includes('..')) return null;
  const file = join(DIR, f);
  if (!file.startsWith(DIR) || !existsSync(file) || !statSync(file).isFile()) return null;
  return readFileSync(file);
}
