// 插嘴手感参数：默认值写在下面这份 DEFAULTS 里；data/tuning.json 里写了的数字覆盖默认。
// 面板「QQ 连接 → 插嘴手感」改的就是那个文件，按 mtime 缓存、改完热生效，不用重启。
// 只放「手感」类数字（打分权重、限流、防抖）；行为开关仍在 config.json，别往这里塞。
import { readFileSync, writeFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { DATA } from '../store.mjs';

export const DEFAULTS = {
  topic: {
    base: 1.8,          // 底分：普通闲聊不该 0 分起步，不然平淡两句全被拦成装死
    pass: 4.8,          // ≥ 这个分数直接过闸
    review: 2.8,        // ≥ 这个（且没到 pass）交给仲裁模型拿主意
    image: 2.2,         // 带图
    memeImg: 0.3,       // 梗图的图像分（内容图是 image 那格）：一点点，可正可负微调。别超过 0.5，不然冷发梗图会蹭进仲裁
    direct: 3.4,        // 指向她=只认叫名字（鲸鲸、肥鱼、哦鲸鲸、大肥鱼）。「你/你觉得/你说」不算指向
    asks: 4.2,          // 带提问
    cmd: 3.4,           // 短指令（唱/来一首/来个表情…）
    attack: 4.0,        // 被点名怼（蠢鱼/找茬/破防/骂谁）
    continuation: 1.8,  // 接着群里在聊的话题
    replyToMe: 2.5,     // 别人在回她刚说的话
    replyWindowMin: 15, // 「回她的话」只认这个窗口（分钟）：群聊节奏快，隔一小时没人还在接她的话
    overlapBase: 0.8,   // 主题接续起步分
    overlapStep: 0.5,   // 每多一个共词加多少
    overlapCap: 2.6,    // 主题接续封顶
    emotion: -3.6,      // 纯情绪（哈哈哈/草/233）
    shortOnly: -0.6,    // 短句且谁也没指向
    repeatText: -2.7,   // 跟上一条几乎同文
    cooldownRepeat: -2.2, // 冷却期内同主题再来
    noInfo: -0.8,       // 什么新信息都没有
    cooldownSec: 120,   // 冷却期多长（秒）
  },
  gate: {
    debounceGroupMs: 1200,   // 群聊防抖：等这么久没新消息才一起回
    debouncePrivateMs: 2500, // 私聊防抖（号主爱连发）
    userRateWindowMin: 0.5,  // 同一人限流：这个窗口内（分钟，0.5=半分钟）
    userRateMax: 3,          // 最多让她自由插嘴回几次（@ 和私聊不受限）
    herRateWindowMin: 3,     // 她自己的熔断窗口（分钟）：防跟群里其他模型对刷
    herRateMax: 5,           // 窗口内她在这个群最多自由插嘴几句（被@/叫名字不受限）
  },
  fav: {
    msgMax: 2,           // 单条消息加减分上限
    dayMax: 5,           // 单日净分上限
    amp: 6,              // 当天情绪放大倍数（当天净分 × 这个往目标值推）
    minDays: 30,         // α 下限对应天数：老朋友一天至少能动 1/30，冻不死
    lo: 5,               // 好感下界（别真读到 0）
    hi: 95,              // 好感上界（别真读到 100）
    decayEveryDays: 7,   // 每隔几天没来往淡一次
    decayPer: 1,         // 每次淡几分
    decayMax: 5,         // 断太久一次补齐，最多淡几分
    keepDays: 200,       // 好感走势 history 留多少条
  },
  memory: {
    selfDiscount: 0.7,   // 2.4 洞察（kind self）在 recall 打分上的折扣：猜想不该和亲历同权重出场；
                         // 洞察把观测挤下去时调低它（0=彻底想不起来，别真设 0）
    kwW: 0.4,            // 4A 语义混合：关键词分权重。余弦和关键词分值域未必对齐，向量一上线就把这条碾压时调高它
    vecW: 0.6,           // 4A 语义混合：向量余弦权重。发现跨记忆拼接幻觉（两件只是像的事揉一起）时调低它
  },
  ctx: {
    days: 5,             // 聊天原文带几天：5 天内全带原文，更早的交给滚动摘要/记忆层。
                         // 号主想 A/B 记忆窗口就改这里（1~30），热生效不用重启（2026-11-10 面板化）
  },
  sticker: {
    ownerEvery: 2,       // 表情包频率（几条消息配一张），写进说明书的数字，钳 1~10。
    friendEvery: 2,      // 三个场景各一份：号主私聊 / 好友私聊 / 群聊（2026-11-10 面板化）
    groupEvery: 3,
  },
};

const FILE = () => join(DATA, 'tuning.json');
let cache = { mtime: -1, t: null };

// 只认数字、且只认 DEFAULTS 里认识的键：写坏文件、塞私货都不至于把打分搞炸
const merge = (base, over) => {
  const out = { ...base };
  for (const k of Object.keys(base)) {
    const v = Number(over?.[k]);
    if (Number.isFinite(v)) out[k] = v;
  }
  return out;
};

/** 当前生效参数（默认 ← tuning.json 覆盖）。读盘按 mtime 缓存，面板保存后下一秒就生效 */
export function tuning() {
  try {
    const m = statSync(FILE()).mtimeMs;
    if (cache.t && m === cache.mtime) return cache.t;
    let raw = {};
    try { raw = JSON.parse(readFileSync(FILE(), 'utf8')); } catch { /* 没写过/写坏了：全按默认 */ }
    const t = { topic: merge(DEFAULTS.topic, raw.topic), gate: merge(DEFAULTS.gate, raw.gate), fav: merge(DEFAULTS.fav, raw.fav), memory: merge(DEFAULTS.memory, raw.memory), ctx: merge(DEFAULTS.ctx, raw.ctx), sticker: merge(DEFAULTS.sticker, raw.sticker) };
    cache = { mtime: m, t };
    return t;
  } catch {
    // 文件不存在等异常：返回默认（深拷贝一份，免得调用方改到 DEFAULTS）
    return { topic: { ...DEFAULTS.topic }, gate: { ...DEFAULTS.gate }, fav: { ...DEFAULTS.fav }, memory: { ...DEFAULTS.memory }, ctx: { ...DEFAULTS.ctx }, sticker: { ...DEFAULTS.sticker } };
  }
}

/** 面板保存用：全量写入（面板会先把各段都发齐），写完清缓存立即生效 */
export function writeTuning({ topic, gate, fav, memory, ctx, sticker } = {}) {
  const t = tuning();
  writeFileSync(FILE(), JSON.stringify({
    topic: merge(t.topic, topic),
    gate: merge(t.gate, gate),
    fav: merge(t.fav, fav),
    memory: merge(t.memory, memory),
    ctx: merge(t.ctx, ctx),
    sticker: merge(t.sticker, sticker),
  }, null, 2));
  cache = { mtime: -1, t: null };
}

/** 恢复默认：把覆盖文件清空（保留空对象，mtime 变一下好让缓存失效） */
export function resetTuning() {
  writeFileSync(FILE(), JSON.stringify({ topic: {}, gate: {}, fav: {}, memory: {}, ctx: {}, sticker: {} }));
  cache = { mtime: -1, t: null };
}
