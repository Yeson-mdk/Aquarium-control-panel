#!/usr/bin/env node
/**
 * 用面板里配的向量接口 + 密钥，实测「到底哪些 embedding 模型能用」。
 *
 * 为什么不只查 /v1/models：
 *   魔搭那个端点是公开的（不带令牌也返回），列的是平台全部聊天/生图模型，
 *   跟你的令牌权限无关，而且根本不含 embedding。真正的答案只能靠真打一条 /embeddings。
 *
 * 跑法（在 NAS 上，项目根目录）：
 *   node ops/probe-ms-models.mjs                      # 测面板当前配的接口 + 一组常见候选
 *   node ops/probe-ms-models.mjs BAAI/bge-m3 ...       # 追加/替换要测的模型 ID
 *   node ops/probe-ms-models.mjs --base https://api.siliconflow.cn/v1   # 临时换接口
 *
 * 默认读面板配置：接口 config.llm.embeddingBaseUrl（留空=魔搭）、
 * 密钥 secrets.embeddingApiKey（留空回退 modelscopeToken）。命令行参数只临时覆盖，不写盘。
 * 脚本不打印密钥、不写日志，只直连接口。
 */
import { readConfig, readSecrets } from '../panel/store.mjs';
import { embedUrl } from '../panel/llm.mjs';

const MS_BASE = 'https://api-inference.modelscope.cn/v1';

// 内置候选：当前常见的 embedding 模型。自定义接口下也照测，能用就用。
const BUILTIN = [
  'Qwen/Qwen3-Embedding-0.6B',
  'Qwen/Qwen3-Embedding-4B',
  'BAAI/bge-large-zh-v1.5',
  'BAAI/bge-m3',
];

// ─── 解析命令行 ───────────────────────────────────────────
const args = process.argv.slice(2);
let baseOverride = '';
const models = [];
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--base' && args[i + 1]) baseOverride = args[++i];
  else models.push(args[i]);
}

const cfg = readConfig().llm;
const sec = readSecrets();
const base = String(baseOverride || cfg.embeddingBaseUrl || '').trim() || MS_BASE;
const token = String(sec.embeddingApiKey || sec.modelscopeToken || '').trim();
const candidates = [...new Set([...(models.length ? models : BUILTIN), ...(cfg.embeddingModel ? [cfg.embeddingModel] : [])])];

if (!token) {
  console.error('没找到向量接口密钥。先在面板「向量模型 → 向量接口密钥」或「QQ 连接 → ModelScope 令牌」填好保存，再跑这个脚本。');
  process.exit(1);
}

const SAMPLE = '蓝色的大肥鱼今天吃了烧腊饭';
const url = embedUrl(baseOverride || cfg.embeddingBaseUrl);

function humanError(status, j) {
  const msg = j?.errors?.message || j?.error?.message || j?.message;
  if (status === 401) return '令牌无效/过期（面板里重新填 key）';
  if (status === 403) return '没权限（有些服务要实名/开通模型）';
  if (status === 404) return '接口或模型不存在（检查接口地址和模型 ID）';
  if (status === 429) return '限流了，等会儿再试';
  return msg || `HTTP ${status}`;
}

async function probe(model) {
  const t0 = Date.now();
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ model, input: [SAMPLE] }),
      signal: AbortSignal.timeout(30000),
    });
    const j = await res.json().catch(() => ({}));
    if (!res.ok) return { model, ok: false, note: humanError(res.status, j) };
    const v = Array.isArray(j.data) ? j.data.find((r) => r?.embedding)?.embedding : null;
    if (!Array.isArray(v) || !v.length) return { model, ok: false, note: '返回里没有向量' };
    return { model, ok: true, dim: v.length, ms: Date.now() - t0 };
  } catch (e) {
    return { model, ok: false, note: e?.cause?.code || e?.message || '网络错误' };
  }
}

console.log(`向量接口：${url}`);
console.log(`候选模型：${candidates.length} 个（真打一条，不猜）\n`);

const results = [];
for (const m of candidates) {
  process.stdout.write(`  测 ${m} … `);
  const r = await probe(m);
  results.push(r);
  console.log(r.ok ? `通了（${r.dim} 维，${r.ms} ms）` : `不行（${r.note}）`);
}

const ok = results.filter((r) => r.ok);
console.log('\n===== 结果 =====');
if (ok.length) {
  console.log(`能用的 embedding 模型 ${ok.length} 个，面板「模型 ID」可填：`);
  ok.forEach((r) => console.log(`  ✓ ${r.model}  （${r.dim} 维）`));
  console.log('\n填好保存后点面板「测试向量模型」复核，再去 NAS 跑一次 node ops/backfill-vec.mjs 给旧记忆补向量。');
} else {
  const auth = results.find((r) => /令牌|权限|实名|无效/.test(r.note));
  if (auth) console.log('看着像密钥/权限问题：' + auth.note);
  else console.log('这些候选都没通。可能这个接口不支持 embedding，或模型 ID 不对——把你想测的模型 ID 跟在命令后面再试。');
}
