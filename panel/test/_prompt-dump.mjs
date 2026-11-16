// 一次性脚本：抓 brain.reply 真实发给模型的完整提示词（三种场景），落成报告。不改任何产品代码。
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
process.env.YANGYU_DATA = mkdtempSync(join(tmpdir(), 'yangyu-dump-'));

import { createServer } from 'node:http';
const bodies = [];
const server = createServer((req, res) => {
  let b = '';
  req.on('data', (c) => (b += c));
  req.on('end', () => {
    bodies.push(JSON.parse(b));
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: '嗯嗯[FAV:{"d":0,"why":"闲聊"}]' }, finish_reason: 'stop' }], usage: { total_tokens: 1 } }));
  });
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));

const store = await import('../store.mjs');
store.writeConfig({
  llm: { baseUrl: `http://127.0.0.1:${server.address().port}`, model: 'dump' },
  sky: { enabled: false },
  qq: { mode: 'onebot', ownerQQ: '10000', audience: 'public', groupFree: true },
});
store.writeSecrets({ llmApiKey: 'x' });

const brain = await import('../qq/brain.mjs');
const owner = await import('../qq/owner.mjs');

// 铺一点群聊历史（10 条），让「历史块」的大小真实；其他动态块（好感/朋友圈/群友名录）本地数据为空，报告里注明
for (let i = 0; i < 10; i++) {
  owner.logChat({ from: 'owner', name: '萌胶带', qq: '2450763590', text: i % 2 ? `第${i}句：今天去逛了卡牌店` : `第${i}句：奶茶刚到一口回魂` });
  owner.logChat({ from: 'her', text: i % 2 ? `回${i}：逛到好东西没` : `回${i}：先喝为敬` });
}

const scenes = [
  ['群聊（好友发言，被@路径）', () => brain.reply('@鲸鲸 喜欢你嘛', { peer: 'g:1091360212', qq: '2450763590', name: '萌胶带', fids: [] })],
  ['好友私聊', () => brain.reply('喜欢你嘛', { peer: 'p:2450763590', qq: '2450763590', name: '萌胶带', fids: [] })],
  ['号主私聊', () => brain.reply('喜欢你嘛', { peer: 'owner', qq: undefined, fids: [] })],
];
const grabs = {};
for (const [label, fn] of scenes) {
  bodies.length = 0;
  await fn();
  grabs[label] = bodies.at(-1);
}

const fmt = (m) => ({ role: m.role, chars: String(m.content).length, content: String(m.content) });
let out = `# 提示词拼接实况（${new Date().toISOString().slice(0, 16)} 抓取）\n\n`;
out += `> 动态块说明：本地数据目录是空的，好感/朋友圈/群友名录/她自己的经历这些块是占位或空——线上这些块更长。\n> 角色卡用的就是仓库根的聚合版卡（线上同款）。\n\n`;
for (const [label, req] of Object.entries(grabs)) {
  const msgs = req.messages;
  const sys = String(msgs[0].content);
  const blocks = sys.split(/\n(?=## )/);
  out += `---\n\n## 场景：${label}\n\n消息条数 ${msgs.length}，总字符 ${msgs.reduce((s, m) => s + String(m.content).length, 0)}\n\n`;
  out += `### 系统提示词分块（共 ${sys.length} 字符）\n\n| 块 | 字符 |\n|---|---|\n`;
  for (const b of blocks) out += `| ${b.split('\n')[0].slice(0, 40)} | ${b.length} |\n`;
  out += `\n### 完整消息列表\n\n`;
  for (const m of msgs) {
    const f = fmt(m);
    out += `#### [${f.role}] ${f.chars} 字符\n\n\`\`\`\n${f.content}\n\`\`\`\n\n`;
  }
  out += `#### 工具（${(req.tools || []).length} 个）：${(req.tools || []).map((t) => t.function.name).join('、')}\n\n`;
}
writeFileSync(join(import.meta.dirname, '../../clone/提示词拼接-20261110.md'), out);
console.log('written, group sys chars:', String(grabs['群聊（好友发言，被@路径）'].messages[0].content).length);
server.close();
process.exit(0);
