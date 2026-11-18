import './_env.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';

const groups = await import('../group-names.mjs');

test('noteGroup：收消息记群号；事件带群名只填一次，不盖号主手填的', () => {
  groups.noteGroup('g:9003', { name: '自动群名', memberCount: 12 });
  let g = groups.listGroups().find((x) => x.peer === 'g:9003');
  assert.ok(g, '群号记下了');
  assert.equal(g.name, '自动群名');
  assert.equal(g.members, 12);

  // 再收到不同群名：不覆盖自动填的第一个
  groups.noteGroup('g:9003', { name: '换个名字' });
  g = groups.listGroups().find((x) => x.peer === 'g:9003');
  assert.equal(g.name, '自动群名', '不覆盖已填的名');

  // 号主手填：盖掉
  groups.setGroupName('g:9003', '号主起的名');
  g = groups.listGroups().find((x) => x.peer === 'g:9003');
  assert.equal(g.name, '号主起的名', '手填优先');
  groups.noteGroup('g:9003', { name: '事件又来' });
  assert.equal(groups.listGroups().find((x) => x.peer === 'g:9003').name, '号主起的名', '手填不被事件盖掉');
});

test('findGroupByName：精确/包含唯一命中返回群号；多名歧义返回列表', () => {
  groups.noteGroup('g:9003', {});
  groups.setGroupName('g:9003', '测试群');
  groups.noteGroup('g:9004', {});
  groups.setGroupName('g:9004', '测试群'); // 同名，制造歧义
  groups.noteGroup('g:9005', {});
  groups.setGroupName('g:9005', '摸鱼专用');

  assert.deepEqual(groups.findGroupByName('测试群'), { ambiguous: ['g:9003', 'g:9004'] }, '同名返回歧义');
  assert.deepEqual(groups.findGroupByName('摸鱼'), { peer: 'g:9005' }, '部分匹配唯一命中');
  assert.deepEqual(groups.findGroupByName('群:摸鱼专用'), { peer: 'g:9005' }, '去掉「群:」前缀');
  assert.equal(groups.findGroupByName('不存在的群'), null, '没这个群');
});

test('私聊/坏群号不进表', () => {
  assert.equal(groups.noteGroup('p:10086', { name: '某人' }), false, '私聊不记');
  assert.equal(groups.noteGroup('瞎写的', { name: 'x' }), false, '坏格式不记');
  assert.equal(groups.setGroupName('p:10086', 'x'), false, '私聊不能填');
  assert.ok(!groups.listGroups().some((x) => x.peer === 'p:10086'));
});
