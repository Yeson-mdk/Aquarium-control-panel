// 每个测试文件第一个 import 它：把数据目录指到临时目录、去掉模型 Key，保证不碰真数据、不联网
import { mkdtempSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.YANGYU_DATA = mkdtempSync(join(tmpdir(), 'yangyu-test-'));
delete process.env.LLM_API_KEY;
export const DATA = process.env.YANGYU_DATA;

// 产品代码里的 console.log/error/warn（[qq] 这张图没看成、[fav] 记分 这些）不刷测试输出：
// 全部落到本进程临时目录的 test-console.log，要看的时候去翻文件（2026-11-10 号主要求静默）。
// node:test 自己的进度和结果走独立上报通道，不受影响
const sink = join(DATA, 'test-console.log');
const toFile = (level) => (...a) => {
  try {
    appendFileSync(sink, `[${level}] ${a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' ')}\n`);
  } catch { /* 文件都写不进就真静默，别让日志炸测试 */ }
};
console.log = toFile('log');
console.error = toFile('error');
console.warn = toFile('warn');
