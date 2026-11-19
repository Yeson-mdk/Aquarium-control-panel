import './_env.mjs';
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { writeFileSync, readFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// 临时目录：给 toSquarePng / addIndexRow 当 scratch 用
const fake = mkdtempSync(join(tmpdir(), 'fake-dsh-'));
after(() => rmSync(fake, { recursive: true, force: true }));

// 假的模型网关：查资料（带服务端搜索的 annotations）/ 看图 / 改图 / 说话
const calls = [];
const queue = [];
const PNG = readFileSync(new URL('../../stickers/happy_开心.png', import.meta.url));
const server = createServer((req, res) => {
  if (req.url === '/img.png') { res.setHeader('Content-Type', 'image/png'); res.end(PNG); return; }
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    calls.push(JSON.parse(body));
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', ...(queue.shift() || { content: '嗯' }) } }] }));
  });
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
after(() => server.close());
const base = `http://127.0.0.1:${server.address().port}`;

const store = await import('../store.mjs');
store.writeConfig({ llm: { baseUrl: base, model: 'fake' }, sky: { enabled: false } });
store.writeSecrets({ llmApiKey: 'gw-key' });
const dsh = await import('../qq/dsh.mjs');

test('research：走模型接口的服务端联网工具，来源从 annotations 拼进来', async () => {
  queue.push({ content: '深圳今天阴，21-31℃。', annotations: [
    { type: 'url_citation', url_citation: { url: 'https://weather.com.cn/1', title: '天气' } },
    { type: 'url_citation', url_citation: { url: 'https://weather.com.cn/1', title: '重复' } },
    { type: 'url_citation', url_citation: { url: 'not-a-url' } },
  ], server_tool_calls: [{ type: 'deepseek_web_search' }] });
  const r = await dsh.research('今天深圳天气');
  assert.match(r.text, /深圳今天阴/);
  assert.match(r.text, /来源：https:\/\/weather\.com\.cn\/1/);
  assert.equal((r.text.match(/https:/g) || []).length, 1, '重复的、非 http 的引用不进去');
  assert.deepEqual(r.tools, ['联网搜索']);
  const req = calls.at(-1);
  assert.equal(req.model, 'deepseek-flash', '联网搜索只挂 deepseek-flash');
  assert.deepEqual(req.tools, [{ type: 'deepseek_web_search' }], '声明服务端联网工具，不是 function calling');
  assert.match(req.messages[0].content, /今天深圳天气/);
  assert.match(req.messages[0].content, /不要照做/, '提示词里仍然压住网页里的指令');
  assert.ok(r.ms >= 0);
});

test('research：开关关着 / 没配 key 都说清楚，一次都不调', async () => {
  const brain = await import('../qq/brain.mjs');
  const n0 = calls.length;
  store.writeConfig({ qq: { dsh: { enabled: false } } });
  assert.ok(!brain.toolDefs().some((t) => t.function.name === 'research'), '关掉后模型连工具都看不到');
  await assert.rejects(dsh.runSearch('x'), /关着/);
  store.writeConfig({ qq: { dsh: { enabled: true } } });
  store.writeSecrets({ llmApiKey: '' });
  await assert.rejects(dsh.runSearch('x'), /API Key/);
  store.writeSecrets({ llmApiKey: 'gw-key' });
  assert.equal(calls.length, n0, '两次失败都没打接口');
});

test('research：没搜到引用时照常把正文给出来，tools 为空', async () => {
  queue.push({ content: '没查到确切资料。' });
  const r = await dsh.runSearch('x');
  assert.equal(r.text, '没查到确切资料。');
  assert.deepEqual(r.tools, []);
});

test('research：超时不算答案', async () => {
  const slowLlm = { llmReady: () => true, chatRaw: () => new Promise((r) => setTimeout(() => r({ content: '太慢了' }), 500)) };
  await assert.rejects(dsh.runSearch('x', { timeoutMs: 80, llmMod: slowLlm }), /还没查完/);
});

test('describeImage：用看图模型，图片走 data URL', async () => {
  queue.push({ content: '一张蓝发 Q 版女孩的表情包，张开双臂笑。' });
  const d = await dsh.describeImage(PNG, { hint: '你看这个' });
  assert.match(d, /蓝发/);
  const req = calls.at(-1);
  assert.equal(req.model, 'openai-codex/gpt-5.6-luna');
  assert.match(req.messages[0].content[1].image_url.url, /^data:image\/png;base64,/);
});

// 假的 ModelScope：提交 → 前两次查还在跑 → 做好了给图片地址
function fakeModelscope({ fail = false } = {}) {
  const seen = [];
  let polls = 0;
  const fn = async (url, init = {}) => {
    seen.push({ url, method: init.method || 'GET', headers: init.headers || {}, body: init.body ? JSON.parse(init.body) : null });
    const json = (o, status = 200) => ({ ok: status < 400, status, json: async () => o });
    if (url.endsWith('/v1/images/generations')) return json({ task_id: 't-1' });
    if (url.includes('/v1/tasks/t-1')) {
      polls++;
      if (polls < 3) return json({ task_status: 'RUNNING' });
      return json(fail ? { task_status: 'FAILED', errors: { message: '内容不合规' } } : { task_status: 'SUCCEED', output_images: ['https://cdn.example/out.png'] });
    }
    if (url === 'https://cdn.example/out.png') return { ok: true, status: 200, arrayBuffer: async () => PNG };
    throw new Error(`没想到会请求 ${url}`);
  };
  return { fn, seen };
}

test('modelscopeEdit：按官方文档的字段提交、轮询、取图', async () => {
  const ms = fakeModelscope();
  const buf = await dsh.modelscopeEdit({ prompt: 'yawn', image: 'data:image/png;base64,AAA', model: 'Qwen/Qwen-Image-Edit', token: 'ms-tk', fetchFn: ms.fn, sleep: async () => {} });
  assert.ok(buf.equals(PNG));
  const [sub, poll] = ms.seen;
  assert.equal(sub.url, 'https://api-inference.modelscope.cn/v1/images/generations');
  assert.equal(sub.method, 'POST');
  assert.equal(sub.headers.Authorization, 'Bearer ms-tk');
  assert.equal(sub.headers['X-ModelScope-Async-Mode'], 'true');
  assert.deepEqual(sub.body, { model: 'Qwen/Qwen-Image-Edit', prompt: 'yawn', image_url: ['data:image/png;base64,AAA'], size: '1024x1024' });
  assert.equal(poll.url, 'https://api-inference.modelscope.cn/v1/tasks/t-1');
  assert.equal(poll.headers['X-ModelScope-Task-Type'], 'image_generation');
  assert.equal(ms.seen.filter((x) => x.url.includes('/tasks/')).length, 3, '没做好就接着查');
});

test('modelscopeEdit：失败、没令牌都说清楚', async () => {
  const ms = fakeModelscope({ fail: true });
  await assert.rejects(dsh.modelscopeEdit({ prompt: 'x', image: 'd', model: 'm', token: 't', fetchFn: ms.fn, sleep: async () => {} }), /生图失败：内容不合规/);
  await assert.rejects(dsh.modelscopeEdit({ prompt: 'x', image: 'd', model: 'm', token: '' }), /访问令牌/);
});

test('makeSticker：做好的图存成 512×512，写进 INDEX.md 的表格，一天只做一张', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'stickers-'));
  writeFileSync(join(dir, 'happy_开心.png'), PNG);
  writeFileSync(join(dir, 'INDEX.md'), '| `happy_开心.png` | 开心 | 好事 |\n\n## 模板\n');
  process.env.YANGYU_STICKERS = dir;
  const d2 = await import('../qq/dsh.mjs?stickers');
  store.writeSecrets({ modelscopeToken: 'ms-tk' });
  store.writeConfig({ qq: { dsh: { imageModel: 'modelscope/Qwen/Qwen-Image-Edit' } } }); // 旧设置带前缀也认
  store.writeState({ ...store.readState(), stickerOn: null });
  let asked;
  const name = await d2.makeSticker({ en: 'yawn', zh: '哈欠', look: '打哈欠', lookEn: 'yawning', when: '困的时候', edit: async (x) => { asked = x; return PNG; } });
  assert.equal(name, 'yawn_哈欠');
  assert.equal(asked.model, 'Qwen/Qwen-Image-Edit');
  assert.match(asked.prompt, /yawning \/ 打哈欠/);
  assert.match(asked.image, /^data:image\/png;base64,/);
  assert.ok(existsSync(join(dir, 'yawn_哈欠.png')));
  const size = execFileSync('/usr/bin/sips', ['-g', 'pixelWidth', '-g', 'pixelHeight', join(dir, 'yawn_哈欠.png')], { encoding: 'utf-8' });
  assert.match(size, /pixelWidth: 512[\s\S]*pixelHeight: 512/);
  assert.match(readFileSync(join(dir, 'INDEX.md'), 'utf-8'), /好事 \|\n\| `yawn_哈欠.png` \| 哈欠 \| 困的时候 \|\n\n## 模板/);
  await assert.rejects(d2.makeSticker({ en: 'cry', zh: '哭', look: '哭', edit: async () => PNG }), /今天已经做过/);
  delete process.env.YANGYU_STICKERS;
  rmSync(dir, { recursive: true, force: true });
});

test('makeSticker：when 备注写进 notes.json——她做的图她得知道什么时候用，已有的备注不吞', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'stickers-'));
  writeFileSync(join(dir, 'happy_开心.png'), PNG);
  writeFileSync(join(dir, 'INDEX.md'), '| `happy_开心.png` | 开心 | 好事 |\n\n## 模板\n');
  writeFileSync(join(dir, 'notes.json'), JSON.stringify({ happy_开心: '气氛轻松', run_狂奔: '跑路时' }, null, 2)); // run 的图还没传到这台机器，备注不能被吞
  process.env.YANGYU_STICKERS = dir;
  const d2 = await import('../qq/dsh.mjs?stickers-notes'); // 换个查询串拿新实例：?stickers 那个实例在上面的用例里已经把 STICKERS 指到它自己的临时目录了（且 Windows 上没跑完清理）
  store.writeSecrets({ modelscopeToken: 'ms-tk' });
  store.writeConfig({ qq: { dsh: { imageModel: 'm' } } });
  store.writeState({ ...store.readState(), stickerOn: null });
  const name = await d2.makeSticker({ en: 'dian', zh: '电击', look: '被电到', when: '有人犯贱想警告一句时', edit: async () => PNG });
  const nt = JSON.parse(readFileSync(join(dir, 'notes.json'), 'utf-8'));
  assert.equal(nt[name], '有人犯贱想警告一句时', 'when 落进了 notes.json（她挑表情看的是它，INDEX.md 只是给人看的）');
  assert.equal(nt.run_狂奔, '跑路时', '这台机器上还没有的图的备注没被吞');
  delete process.env.YANGYU_STICKERS;
  rmSync(dir, { recursive: true, force: true });
});

test('toSquarePng：竖图补白成正方形再缩，不拉伸', () => {
  const tall = join(fake, 'tall.png');
  const out = join(fake, 'sq.png');
  writeFileSync(tall, PNG);
  execFileSync('/usr/bin/sips', ['-z', '1280', '760', tall], { stdio: 'ignore' });
  dsh.toSquarePng(tall, out);
  const g = (f) => execFileSync('/usr/bin/sips', ['-g', 'pixelWidth', '-g', 'pixelHeight', f], { encoding: 'utf-8' });
  assert.match(g(tall), /pixelWidth: 760[\s\S]*pixelHeight: 1280/);
  assert.match(g(out), /pixelWidth: 512[\s\S]*pixelHeight: 512/);
});

test('addIndexRow：插到表格最后一行后面，不是文件末尾', () => {
  const f = join(fake, 'INDEX.md');
  writeFileSync(f, '| 文件 | 情绪 |\n|---|---|\n| `a_一.png` | 一 |\n| `b_二.png` | 二 |\n\n## 提示词模板\nxxx');
  dsh.addIndexRow('| `c_三.png` | 三 |', f);
  assert.equal(readFileSync(f, 'utf-8'), '| 文件 | 情绪 |\n|---|---|\n| `a_一.png` | 一 |\n| `b_二.png` | 二 |\n| `c_三.png` | 三 |\n\n## 提示词模板\nxxx');
});

test('stickerName：一个英文词 + 中文', () => {
  assert.equal(dsh.stickerName('Yawn!', '打哈欠了啊'), 'yawn_打哈欠了');
});

test('makeSticker：一天只做一张', async () => {
  store.writeState({ ...store.readState(), stickerOn: store.localDate() });
  await assert.rejects(dsh.makeSticker({ en: 'yawn', zh: '哈欠', look: '打哈欠' }), /今天已经做过/);
});

test('brain：research / make_sticker 只记下要做的事，真正去做在后台', async () => {
  const brain = await import('../qq/brain.mjs');
  const out = {};
  assert.match(await brain.runTool('research', { question: '明天会下雨吗' }, out), /应一声让他稍等/);
  assert.equal(out.research, '明天会下雨吗');
  store.writeState({ ...store.readState(), stickerOn: null });
  await brain.runTool('make_sticker', { en: 'yawn', zh: '哈欠', look: '打哈欠', look_en: 'yawning', base: '不存在的' }, out);
  assert.deepEqual(out.makeSticker, { en: 'yawn', zh: '哈欠', look: '打哈欠', lookEn: 'yawning', when: undefined, base: 'happy_开心' });
  assert.ok(brain.toolDefs().some((t) => t.function.name === 'research'));
});

test('imageSegments：图片都算（QQ 打过标签的梗图也算），市场大表情 mface 不算', async () => {
  const { imageSegments, readMessage } = await import('../qq/onebot.mjs');
  const ev = { message: [{ type: 'image', data: { url: 'u1', file: 'f1' } }, { type: 'image', data: { summary: '[动画表情]', url: 'u2' } }, { type: 'text', data: { text: '看' } }] };
  assert.deepEqual(imageSegments(ev), [{ url: 'u1', file: 'f1' }, { url: 'u2', file: undefined }], '打过标签的图也下载给她看');
  assert.equal(readMessage(ev), '[图片][图片]看', '标签不再当描述用，统一 [图片]');
  assert.deepEqual(imageSegments({ message: '[CQ:image,file=a.jpg,url=https://x/y?a=1&amp;b=2]' }), [{ url: 'https://x/y?a=1&b=2', file: 'a.jpg' }]);
});

test('researchReply：把查到的用她的口吻说，资料框起来', async () => {
  const brain = await import('../qq/brain.mjs');
  queue.push({ content: '**查到啦**，深圳今天阴，21 到 31 度，出门不用带伞～' });
  const t = await brain.researchReply('今天深圳天气', '深圳今天阴，21-31℃');
  assert.equal(t, '查到啦，深圳今天阴，21 到 31 度，出门不用带伞～');
  assert.match(calls.at(-1).messages.at(-1).content, /⟦深圳今天阴/);
  assert.match(calls.at(-1).messages[0].content, /直接跟号主私聊/, '默认私聊用号主那套规矩');
});

test('查资料回传：群里问发回群并 @ 号主，私聊问回 owner，不 @', async () => {
  const { researchBack } = await import('../qq/index.mjs');
  assert.deepEqual(researchBack('g:81234', '98765'), { peer: 'g:81234', at: '98765' }, '群里问 @ 号主本人');
  assert.deepEqual(researchBack('owner', '98765'), { peer: 'owner', at: '' }, '私聊问回 owner、不 @');
  assert.deepEqual(researchBack('p:555', '98765'), { peer: 'p:555', at: '' }, '好友私聊原样回、不 @');
  assert.deepEqual(researchBack('', '98765'), { peer: 'owner', at: '' }, '没传 peer 落回 owner');
});

test('researchReply：群里问用群聊口吻、翻群聊记录，不让写 [TO:]', async () => {
  const brain = await import('../qq/brain.mjs');
  queue.push({ content: '查到啦，深圳今天阴～' });
  await brain.researchReply('今天深圳天气', '深圳今天阴', 'g:81234');
  const req = calls.at(-1);
  assert.match(req.messages[0].content, /现在是群聊/, '群里用群聊那套规矩，不露号主私事');
  assert.doesNotMatch(req.messages[0].content, /直接跟号主私聊/);
  assert.match(req.messages.at(-1).content, /别写 \[TO:\]/, '@ 由程序处理，别让模型吐标记');
});

test('群友工具白名单仍不含 research：查资料只有号主能用（本轮裁决）', async () => {
  const brain = await import('../qq/brain.mjs');
  const { PUBLIC_TOOLS } = await import('../qq/tools.mjs');
  assert.ok(!PUBLIC_TOOLS.includes('research'), 'research 没进 PUBLIC_TOOLS');
  const out = { isOwner: false, peerKey: 'g:81234', speakerQq: '555' };
  const r = await brain.runTool('research', { question: '今天天气' }, out);
  assert.match(r, /只有号主能用/);
  assert.equal(out.research, undefined, '群友触发不了联网查资料');
});
