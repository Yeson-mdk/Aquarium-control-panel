import test from 'node:test';
import assert from 'node:assert/strict';
import './_env.mjs';
import { writeConfig, writeSecrets } from '../store.mjs';
import * as mind from '../mind.mjs';
import * as context from '../qq/context.mjs';
import * as brain from '../qq/brain.mjs';

writeSecrets({ llmApiKey: 'sk-test' });
writeConfig({ qq: { ownerQQ: '999' } });

test('C7.1 brain 转出口 == context 实现，外部调用不变', async () => {
  assert.equal(brain.contextText, context.contextText);
});

test('C7.2 contextText 拼装出各段，且按对话 scope 区分', async () => {
  const ownerCtx = await context.contextText('你好', '999', 'owner');
  assert.ok(ownerCtx.includes('## 此刻') || ownerCtx.includes('现在是'), '带此刻');
  assert.ok(ownerCtx.includes('## 你自己'), '带自己的状态');
  // 号主对话带他的事；外人对话不带（防串场）
  assert.ok(ownerCtx.includes('关于号主'), '号主对话带号主的事');
  const guestCtx = await context.contextText('你好', '88888', 'p:88888');
  assert.ok(guestCtx.includes('现在跟你聊的这个人'), '外人对话带对方档案段');
});

test('C7.3 纯拼装：不写 mind 状态，不写记忆（调用前后快照一致）', async () => {
  const before = JSON.stringify(mind.readMind());
  await context.contextText('随便问我点什么', '999', 'owner');
  const after = JSON.stringify(mind.readMind());
  assert.equal(after, before, 'contextText 只读不写');
});

test('C7.4 群名表只在号主面前展开', async () => {
  const { writeConfig } = await import('../store.mjs');
  const groups = await import('../group-names.mjs');
  groups.setGroupName('g:123', '鲸鲸群');
  const ownerCtx = await context.contextText('发到鲸鲸群', '999', 'owner');
  assert.ok(ownerCtx.includes('你知道的群') && ownerCtx.includes('鲸鲸群'));
});
