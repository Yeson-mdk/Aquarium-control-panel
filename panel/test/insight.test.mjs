import './_env.mjs';
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';

// ─── 假的模型接口：按顺序吐预先排好的回复（照 evolve.test.mjs 那套）─────
const llmQueue = [];
const llmCalls = [];
const server = createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    try { llmCalls.push(JSON.parse(body)); } catch { /* 记录不挡正事 */ }
    const msg = llmQueue.shift() || { content: '{}' };
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', ...msg } }], usage: { total_tokens: 100 } }));
  });
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
after(() => server.close());

const store = await import('../store.mjs');
store.writeConfig({
  llm: { baseUrl: `http://127.0.0.1:${server.address().port}`, model: 'fake' },
  mind: { enabled: true, personaDays: 0 },
});
store.writeSecrets({ llmApiKey: 'test' });

const mind = await import('../mind.mjs');
const memory = await import('../memory.mjs');

// 洞察的输入要 ≥5 条记忆才值得归纳，每个用例先铺几条
const seed = (n, kw) => { for (let i = 0; i < n; i++) memory.add({ kind: 'watch', imp: 3, text: `铺垫${kw}第${i}条：刷到个普通的视频` }); };

test('2.1 洞察写回流：带 id 依据、kind self / imp 5、上限 2 条、非法 from 整条忽略', async () => {
  seed(4, '甲');
  const a = memory.add({ kind: 'chat', imp: 4, keys: ['g:9301'], text: '「群·9301」小零 又在问周末球局怎么约' });
  const b = memory.add({ kind: 'chat', imp: 4, keys: ['g:9301'], text: '「群·9301」小零 说已经约到人打球了' });
  llmQueue.push({ content: JSON.stringify({ insights: [
    { text: '小零 最近在张罗球局', from: [a.id, b.id], why: '连着两天都在提打球' },
    { text: '凭空的人说了不存在的话', from: ['垃圾id'], why: 'x' },
    { text: '第三条该被上限压掉', from: [a.id], why: 'x' },
  ], retire: [] }) });
  const r = await mind.insight();
  assert.ok(r, '跑成了');
  assert.equal(r.added.length, 1, '非法 from 的整条忽略（合法的在前 2 条里只有 1 条）');
  const e = r.added[0];
  assert.equal(e.kind, 'self');
  assert.equal(e.imp, 5);
  assert.match(e.text, /小零.*球局/);
  assert.match(e.text, /依据/, 'text 里带上给人看的依据');
  assert.ok((e.src || []).some((s) => /球局/.test(s)), 'src 带支撑原句（人工对账用）');
  assert.deepEqual(e.keys, ['g:9301'], 'B2：洞察继承证据来源的 keys，才在本对话里想得起来');
  assert.ok(memory.memoryView(50).insights.some((x) => x.id === e.id), '进了洞察栏');
  // 提示词纪律：每条记忆带 id、不放例句、有「只许归纳上面给的」硬规则
  const sent = JSON.stringify(llmCalls.at(-1));
  assert.match(sent, new RegExp(a.id), '记忆条目带 id，模型才给得出 from');
  assert.doesNotMatch(sent, /小零在攒局/, '不放例句（例句会被复读着造假洞察）');
  assert.match(sent, /一律不许写/, '带「只用给到的素材」的事实硬规则');
  assert.match(store.readActions().at(-1).detail, /💭 今晚的洞察：1 条/, '2.7 落 💭 日志');
});

test('2.1 洞察 B2：继承来源 keys 但去掉 owner（号主私事不因归纳漏给外人）', async () => {
  seed(5, '丁');
  const a = memory.add({ kind: 'chat', imp: 4, keys: ['g:9302', 'owner'], text: '「群·9302」小蓝 说周末想去露营' });
  const b = memory.add({ kind: 'chat', imp: 4, keys: ['g:9302'], text: '「群·9302」小蓝 问谁有帐篷' });
  llmQueue.push({ content: JSON.stringify({ insights: [
    { text: '小蓝 在张罗露营', from: [a.id, b.id], why: '连着提' },
  ], retire: [] }) });
  const r = await mind.insight();
  assert.equal(r.added.length, 1);
  assert.deepEqual(r.added[0].keys, ['g:9302'], '并集里去掉 owner，只留群钥匙');
});

test('2.1 洞察：模型把 id 连着展示格式（[id]/引号）抄回来，也该认——别整晚全拒', async () => {
  seed(5, '丙');
  const a = memory.add({ kind: 'chat', imp: 4, keys: ['g:9301'], text: '「群·9301」阿黄 连着三天问代购的事' });
  llmQueue.push({ content: JSON.stringify({ insights: [
    { text: '阿黄 在张罗代购', from: [`[${a.id}]`], why: '连着三天在问' },
  ], retire: [] }) });
  const r = await mind.insight();
  assert.equal(r.added.length, 1, '带方括号的 id 也是那个 id，不该当「依据全对不上」拒掉');
  assert.ok((r.added[0].src || []).length, '依据还接得上原文');
});

test('2.1 洞察：空数组不写条目、坏 JSON 不炸、记忆太少不空跑', async () => {
  seed(5, '乙');
  store.logAction({ kind: 'test', detail: '垫一条非洞察日志' });
  llmQueue.push({ content: JSON.stringify({ insights: [], retire: [] }) });
  let r = await mind.insight();
  assert.deepEqual(r.added, [], '空洞察合法，不硬凑');
  assert.ok(!store.readActions().at(-1).detail.includes('💭'), '都空就不记日志（最后一条还是垫的那条）');
  llmQueue.push({ content: '今天天气不错呀' }); // 坏 JSON
  r = await mind.insight();
  assert.equal(r, null, '坏 JSON：整晚跳过不炸（明晚再说）');
  assert.match(store.readActions().at(-1).detail, /洞察没跑成/, '失败要留 💭 日志——静默吞掉的话，线上连挂 N 晚日志上都一片安静，没法排查');
  // 模型给了洞察但依据 id 全对不上：另一种静默死法，也要留痕（不然和「模型没给」分不开）
  llmQueue.push({ content: JSON.stringify({ insights: [{ text: '一条依据对不上的洞察', from: ['垃圾id'], why: 'x' }], retire: [] }) });
  r = await mind.insight();
  assert.deepEqual(r.added, [], '依据全无效的整条忽略');
  assert.match(store.readActions().at(-1).detail, /依据.*对不上/, 'id 全对不上要留 💭 日志');
  // 记忆清空后（<5 条）不调模型
  const { writeFileSync } = await import('node:fs');
  const { join } = await import('node:path');
  const { DATA } = await import('./_env.mjs');
  writeFileSync(join(DATA, 'memories.json'), '[]');
  const n = llmQueue.length;
  assert.equal(await mind.insight(), null, '记忆太少不值得归纳');
  assert.equal(llmQueue.length, n, '不空跑模型');
});

test('2.3 洞察可推翻：retire 只认现有洞察的有效 id，别的一律忽略', async () => {
  seed(4, '丙');
  const old = memory.add({ kind: 'self', imp: 5, text: '洞察：Yeson 最近在攒钱换电脑（依据：他提过预算）' });
  memory.add({ kind: 'self', imp: 5, text: '洞察：另一条不相干的旧洞察' });
  const fresh = memory.add({ kind: 'chat', imp: 4, keys: ['g:9302'], text: '「群·9302」Yeson 说电脑已经买完了' });
  llmQueue.push({ content: JSON.stringify({ insights: [], retire: [old.id, '垃圾id', fresh.id] }) });
  const r = await mind.insight();
  assert.equal(r.retired, 1, '只有现有洞察的 id 生效（fresh 是记忆不是洞察，垃圾 id 无效）');
  assert.ok(!memory.memoryView(50).insights.some((e) => e.id === old.id), '被推翻的出了洞察栏');
  assert.match(store.readActions().at(-1).detail, /推翻 1 条旧的/, '日志带推翻数');
});

test('2.4 审核池：开着先挂起不进流，放行才入库、丢掉就没了；默认关着直接进流', async () => {
  seed(4, '丁');
  const a = memory.add({ kind: 'chat', imp: 4, keys: ['g:9303'], text: '「群·9303」卷心菜 连着三天来群里逗她玩' });
  store.writeConfig({ mind: { enabled: true, personaDays: 0, insightReview: true } });
  llmQueue.push({ content: JSON.stringify({ insights: [{ text: '卷心菜 爱逗她但没恶意', from: [a.id], why: '连着几天来玩' }], retire: [] }) });
  let r = await mind.insight();
  assert.equal(r.added.length, 0, '审核池开着：不直接进流');
  assert.equal(r.held, 1, '挂起了 1 条');
  assert.ok(!memory.memoryView(50).insights.some((e) => /卷心菜/.test(e.text)), '记忆流里还没有');
  assert.equal(mind.readMind().insightPending.length, 1, '挂在 mind.insightPending');
  // 放行 → 入库；再丢一条 → 没了
  assert.ok(await mind.approveInsight(0), '放行成功');
  assert.ok(memory.memoryView(50).insights.some((e) => /卷心菜/.test(e.text)), '放行后进了记忆流');
  assert.equal(mind.readMind().insightPending.length, 0);
  llmQueue.push({ content: JSON.stringify({ insights: [{ text: '又一条要审的洞察', from: [a.id], why: 'y' }], retire: [] }) });
  await mind.insight();
  assert.ok(await mind.rejectInsight(0), '丢掉成功');
  assert.ok(!memory.memoryView(50).insights.some((e) => /又一条要审的/.test(e.text)), '丢掉的没进流');
  assert.equal(mind.readMind().insightPending.length, 0);
  // 默认（关）：直接进流
  store.writeConfig({ mind: { enabled: true, personaDays: 0, insightReview: false } });
  llmQueue.push({ content: JSON.stringify({ insights: [{ text: '直进的一条洞察', from: [a.id], why: 'y' }], retire: [] }) });
  r = await mind.insight();
  assert.equal(r.added.length, 1, '默认不开审核：直接写回流');
  assert.ok(memory.memoryView(50).insights.some((e) => /直进的一条洞察/.test(e.text)));
});

test('洞察输入分层采样：watch 刷屏时不把聊天/朋友记忆挤出去——洞察全长在B站上是自我强化循环（号主 2026-11-14 发现 7 条洞察 6 条在B站）', async () => {
  // 先铺 5 条群聊记忆，再铺 30 条 watch：按纯「最近 25 条」，群聊全被挤出去
  const social = [];
  for (let i = 0; i < 5; i++) social.push(memory.add({ kind: 'chat', imp: 3, keys: ['g:9301'], text: `「群·9301」小零 第${i}次提周末球局` }).id);
  seed(30, '乙');
  llmQueue.push({ content: '{}' });
  await mind.insight();
  const prompt = JSON.stringify(llmCalls.at(-1));
  const shown = social.filter((id) => prompt.includes(id)).length;
  assert.ok(shown >= 2, `被挤出去的群聊记忆应该捞回来至少 2 条（实际 ${shown}）——不然洞察的原料里只剩刷视频`);
});

test('洞察输入分层采样：非watch极少（2条）时全进feed且feed补满25——不浪费归纳素材位置', async () => {
  llmQueue.length = 0;
  // 清掉前面测试铺的记忆，保证 pool 里只有这次铺的数据
  const { writeFileSync } = await import('node:fs');
  const { join } = await import('node:path');
  const { DATA } = await import('./_env.mjs');
  writeFileSync(join(DATA, 'memories.json'), '[]');
  // 仅 2 条社交记忆 + 30 条 watch：非watch(2) 远不够配额(10)，走补满分支
  const social = [];
  for (let i = 0; i < 2; i++) social.push(memory.add({ kind: 'chat', imp: 3, keys: ['g:9301'], text: `「群·9301」小零 第${i}次提球局` }).id);
  seed(30, '戊');
  llmQueue.push({ content: '{}' });
  await mind.insight();
  const prompt = JSON.stringify(llmCalls.at(-1));
  assert.equal(social.filter((id) => prompt.includes(id)).length, 2, '仅有的 2 条社交记忆全进 feed');
  // feed 补满 25：数 prompt 里「最近的记忆」段落的 [id] 条目数（feed 每条都是 [id] 开头）
  const feedIds = social.concat(
    // 30 条 watch 的 id 没记下来——换个数法：数 prompt 里所有 [xxxx] 格式的展示条目
    [],
  );
  const idLines = (prompt.match(/\[[a-z0-9]{6,}\]/g) || []).length;
  assert.ok(idLines >= 20, `feed 补满到接近 25 条（实际 ${idLines} 个 [id] 条目）——非watch不够时用watch补满，不空着位置`);
});

test('洞察的输出预算 ≥800：400 时 flash 前置吃完就没地方写 JSON——「今晚的洞察没跑成：没有 JSON」的根因（2026-11-16 周日实测）', async () => {
  seed(6, '丙');
  llmQueue.push({ content: '{}' });
  const before = llmCalls.length;
  await mind.insight();
  const sent = llmCalls.slice(before).at(-1);
  assert.ok(sent, '调了模型');
  assert.ok(sent.max_tokens >= 800, `max_tokens 要 ≥800（实际 ${sent.max_tokens}）——洞察回包带 from/why，400 装不下`);
});
