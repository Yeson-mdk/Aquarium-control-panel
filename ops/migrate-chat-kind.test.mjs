import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const SCRIPT = join(HERE, 'migrate-chat-kind.mjs');
const { classify } = await import(pathToFileURL(SCRIPT).href);

test('老群逐句原文 → background', () => {
  assert.deepEqual(classify({ kind: 'chat', imp: 1, text: '「群·1124893144」Yeson：去看了三分钟奥特曼' }),
    { kind: 'background', why: '逐句原文' });
  assert.deepEqual(classify({ kind: 'chat', imp: 2, text: '「群·1124893144」小零同学：[图片：图上文字…]' }),
    { kind: 'background', why: '逐句原文' });
});

test('老大事件（群 / 号主）→ big_event', () => {
  assert.equal(classify({ kind: 'chat', imp: 4, text: '「群·1124893144」银世-墨染说的大事：无法接受' }).kind, 'big_event');
  assert.equal(classify({ kind: 'chat', imp: 4, text: '号主说的大事：今晚不回来了' }).kind, 'big_event');
});

test('真日结摘要 / 带锚点要点 / 高重要度 → 一律不动', () => {
  assert.equal(classify({ kind: 'chat', imp: 3, text: '「群·1124893144」聊的主要是：天文摄影和脱水蔬菜' }), null);
  assert.equal(classify({ kind: 'chat', imp: 1, text: '「私·12345」聊的主要是：周末安排' }), null);
  assert.equal(classify({ kind: 'chat', imp: 1, text: '跟号主聊天：聊了新梗和日常' }), null);
  assert.deepEqual(classify({ kind: 'chat', imp: 3, text: '「群·1124893144」Yeson：最近迷上天文', src: ['我最近在看火箭发射'] }),
    { skip: true, why: '带原话锚点，疑似真日结要点' });
  assert.deepEqual(classify({ kind: 'chat', imp: 5, text: '「群·1124893144」Yeson：这条很重要' }),
    { skip: true, why: '重要度 5 偏高，疑似真日结要点' });
});

test('非 chat 不碰；概括正文里出现"说的大事"不误伤', () => {
  assert.equal(classify({ kind: 'gist', text: '「群·1」某人：原话' }), null);
  assert.equal(classify({ kind: 'background', text: '「群·1」某人：原话' }), null);
  assert.equal(classify({ kind: 'chat', imp: 3, text: '「群·1」聊的主要是：谁说的大事其实是玩笑' }), null);
  assert.equal(classify({ kind: 'chat', imp: 3, text: '「群·1」某人提到说的大事其实是玩笑' }), null);
});

test('端到端：预演不写、--apply 备份并只改 kind', () => {
  const dir = mkdtempSync(join(tmpdir(), 'migrate-chat-'));
  try {
    const mem = [
      { id: 'a', kind: 'chat', imp: 1, text: '「群·1」甲：今天吃了啥', keys: ['g:1'], seen: '2026-11-20T00:00:00.000Z', n: 2 },
      { id: 'b', kind: 'chat', imp: 4, text: '「群·1」乙说的大事：要搬走了', keys: ['g:1'], seen: null, n: 0 },
      { id: 'c', kind: 'chat', imp: 3, text: '「群·1」聊的主要是：吃饭和搬家', keys: ['g:1'] },
      { id: 'd', kind: 'chat', imp: 3, text: '「群·1」丙 最近迷上做饭', keys: ['g:1'], src: ['我在学做饭'] },
      { id: 'e', kind: 'gist', imp: 5, text: '一条印象', keys: [] },
    ];
    const file = join(dir, 'memories.json');
    writeFileSync(file, JSON.stringify(mem, null, 1));
    const env = { ...process.env, YANGYU_DATA: dir };

    const dry = spawnSync(process.execPath, [SCRIPT], { env, encoding: 'utf-8' });
    assert.equal(dry.status, 0, dry.stderr);
    assert.match(dry.stdout, /这是预演/);
    assert.match(dry.stdout, /保留为 chat[^\n]*：2 条/, '预演要列出保留项，便于核对真日结没被误迁');
    assert.deepEqual(JSON.parse(readFileSync(file, 'utf-8')), mem, '预演绝不能改文件');

    const applied = spawnSync(process.execPath, [SCRIPT, '--apply'], { env, encoding: 'utf-8' });
    assert.equal(applied.status, 0, applied.stderr);
    assert.match(applied.stdout, /已迁移 2 条/);

    const after = JSON.parse(readFileSync(file, 'utf-8'));
    assert.equal(after[0].kind, 'background');
    assert.equal(after[1].kind, 'big_event');
    assert.equal(after[2].kind, 'chat');
    assert.equal(after[3].kind, 'chat');
    assert.equal(after[4].kind, 'gist');
    // 除 kind 外，原有字段一个都不能变
    for (let i = 0; i < mem.length; i++) {
      const before = { ...mem[i], kind: after[i].kind };
      assert.deepEqual(after[i], before, `第 ${i} 条除 kind 外被改动了`);
    }
    assert.ok(readdirSync(dir).some((f) => f.startsWith('memories.json.bak-')), '应生成备份');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
