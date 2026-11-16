# WorldX 项目对接方案（代码级实施稿 v0.1）

> 日期：2026-11-13　｜　定位：本文是《WorldX接入评估与阶段三C落位.md》（战略决策稿）的**代码级落地稿**。
>
> 上游文档定了「接法 B、阶段三·C、先地基后感知再世界」的战略方向；本文负责把它落到**改哪些文件、加什么字段、接口怎么签名、状态机怎么走、怎么降级怎么回滚**。
>
> 配套阅读：
> - `docs/记忆升级计划.md`（阶段排期与护栏范式）
> - `docs/未来架构升级方案.md`（P0 地基批次 A/B/C）
> - `WorldX接入评估与阶段三C落位.md`（战略决策，本文不重复其结论）
>
> **阅读路径**：赶时间只看 §1 差异修正 + §3 排期对齐 + §8 实施清单。

---

## 1. 代码核对结论：评估文档假设 vs 代码实际

评估文档是「不看代码写的战略稿」，本文逐条对代码核验后，发现 **5 处需要适配修正**，其余假设准确。

| # | 评估文档的假设 | 代码实际 | 修正 |
|---|---|---|---|
| 1 | 「记忆条目加 `domain`，`kind` 不变」——暗示加个字段就行 | `memory.mjs:82` `entry()` 是**固定字段白名单**，多余字段静默丢弃；`src` 是阶段一专门加的可选字段。`memdb.mjs` 的 `rowOf`/`entryOf`/`ins`（prepare INSERT）也是**固定列数**，加列必须三处一起改（阶段四 vec 列的同款坑） | entry() 加 `domain`/`source` 两个可选参数（照 `src` 模式）；**memdb 暂不加列**——先只在活记忆 JSON 层打标签，档案检索不按 domain 过滤（physical 记忆量小、被 tidy 归档后从档案兜底翻到也不算串场，因为它不带 g:/p: 钥匙不受 scope 管辖） |
| 2 | 「`scope` 只治理 `kind:'chat'`，不碰 physical」 | ✅ 准确：`memory.mjs` scope 过滤只作用于 `kind:'chat'`（2.8 实现），physical 产出用 `kind:'watch'` 自动不受限 | 无需修正 |
| 3 | 「`PLAN_FB_KIND` 定反馈面」——暗示 worldx_session 要进 | `plan.mjs:92` `PLAN_FB_KIND` 只列出向类型（browse→watch 等）；**内部类型（reflect_self/idle_wander）不进这个表**，`recordSlotFeedback` 遇到不在表里的 type 自动跳过 | worldx_session **不进 PLAN_FB_KIND**——产物本身就是 `kind:'watch'` 记忆，不叠反馈记忆（和 B 段内部类型同一口径） |
| 4 | 「晨间计划产出 `worldx_session`（时段+意向+时长）」 | `plan.mjs:89` `PLAN_TYPES` 现有 8 个（含 B 段加的 reflect_self/idle_wander）；`planTypeBlocked` 分三档（config 上限 / INNER_DAILY_MAX / false）；`morningPlan` 提示词白名单枚举 type | 照 A/B 段同一套六步扩列（见 §4.2），`planTypeBlocked` 走 INNER_DAILY_MAX 挡（每天最多 1-2 格） |
| 5 | 「panel 新端点 `/worldx/agent-decide`」 | `panel.mjs:178` `routes` 对象是 `'METHOD /path': handler` 模式；handler 签名 `async (query, body) => result`；非 `/api/` 开头的 GET 走静态页 | 加 `'POST /worldx/agent-decide': handler`——**不走 `/api/` 前缀**（那是面板内部 API，WorldX 是外部回调），但走同一个 `createServer`、同一套 host/origin 防护 |

### 补充核对：执行层和心智复用

| 对接点 | 代码位置 | 现状 | 对接方式 |
|---|---|---|---|
| `executeSlot` 分支 | `autopilot.mjs:122-135` | rest/diary/check/reflect_self/idle_wander/browse 六分支 | 加 `worldx_session` 第七分支 |
| tick 挂起/抢占 | `autopilot.mjs` tick 函数 | 已有三处重排触发（pause off / 派活 / 时辰错过）+ B3 元复盘触发 | 加第四处：3.5 到期约定 → 挂起 worldx_session（置 suspended） |
| brain 回调上下文 | `qq/brain.mjs` `reply()` | persona + 心境 + recall(scope) + 好感 + 铁律 + 守约 + 工具 | worldx 回调**不走 `reply()`**（那是 QQ 事件驱动的）；新建 `brain.worldDecide(perception)` 复用 reply 的上下文装配零件，但不走 QQ 发送链路 |
| insight 分层采样 | `mind.mjs:451-463` | watch 封顶 60%，三分支补满 | physical 的 watch 和 digital 的 watch **合并计算**（先不分域采样，观察后再调） |
| state 结构 | `store.mjs:305` | `{ plans, cooldownUntil, seen, lastRun }` + B 段加的 `metaReviewOn` | 加 `worldx: { status, sessionId, suspendedAt, resumeIntent }` |

---

## 2. 和现有两个方案的适配关系

### 2.1 与记忆升级计划的关系

| 记忆升级阶段 | 关系 | 说明 |
|---|---|---|
| 阶段〇 事实铁律 | **共享** | WorldX 回调的 brain 提示词同样遵守「只许用给到的素材」铁律 |
| 阶段一 群聊日结 | **无关** | digital 域内部，WorldX 不碰 |
| 阶段二 洞察回流 | **被消费方** | WorldX 产的 watch 记忆自动进 insight 的分层采样池（已修的补满版）；physical 洞察会自然长出来 |
| 阶段三 A/B | **前置** | worldx_session 复用 A 段的六步护栏范式；B 段的 metaReview 会自动把 worldx 格子纳入计划元复盘 |
| 阶段三·C | **就是本文** | 原占位段「工具插件接入后的 type 扩充」被 WorldX 填充 |
| 阶段三.5 约定 | **边界互不侵犯** | 3.5 管 digital 文本约定；WorldX 内 NPC 许诺不进 tasks.json（评估文档 §9.2 已裁决） |
| 阶段四 embedding | **前置** | 原文要求「阶段四完成后再评估」；若 recall-check 证明不需要 embedding，可直接跳到 WorldX |

### 2.2 与未来架构升级方案的关系

| 批次 | 关系 | 必须先做的条目 |
|---|---|---|
| **批次 A 安全地基** | **硬前置** | A1 降级链（WorldX 回调失败必须能降级）、A3 告警通道（回调雪崩/时钟竞态要能告警）、A4 进程兜底 |
| **批次 B 记忆正确性** | **硬前置** | B1 写串行化（WorldX 会抬高写入频率，多写者竞态更凶）、B3 注入约束（WorldX 感知包是外部输入，和 B站评论一样是投毒面） |
| 批次 C 运营质量 | 软前置 | C5 夜间链重试（WorldX 会话挂起/恢复和夜间链的幂等性有交集，先修 C5 再接更安全） |

> **一句话**：批次 A（A1/A3/A4）+ 批次 B（B1/B3）是 WorldX 的**硬前置**——这两批没做完，WorldX 接进来故障无法归因（评估文档 §3 的判定完全正确）。

---

## 3. 三方案排期对齐

> 进度状态截至 2026-11-13。

### 3.1 进度对齐表

| 序 | 内容 | 来源方案 | 状态 | WorldX 依赖 |
|---|---|---|---|---|
| 0a | P0 地基·批次 A（降级链+告警+进程兜底） | 未来架构 §批次A | ⬜ 未开工 | **硬前置** |
| 0b | P0 地基·批次 B（写串行化+洞察scope+注入约束） | 未来架构 §批次B | ⬜ 未开工 | **硬前置** |
| 1 | 阶段〇 事实铁律 | 记忆升级 | ✅ 已上线 | 共享 |
| 2 | 阶段一 群聊日结 | 记忆升级 | ✅ 已上线 | 无关 |
| 3 | 阶段二 洞察回流 + 2.8 scope | 记忆升级 | ✅ 开发完待传 NAS | 被消费方 |
| 4 | 阶段三 A 段（晨间计划） | 记忆升级 | ✅ 已上线待验收 | 前置（护栏范式） |
| 5 | 阶段三 B 段（内心行为+元复盘） | 记忆升级 | ✅ 开发完待传 NAS | 前置（metaReview） |
| 6 | 洞察分层采样修复 | 本日新增 | ✅ 开发完待传 NAS | 被消费方 |
| 7 | 批次 C 运营质量（C5 夜间链重试等） | 未来架构 §批次C | ⬜ 未开工 | 软前置 |
| 8 | 阶段三.5 约定（守约式主动开口） | 记忆升级 | ⬜ 未开工 | 边界互不侵犯 |
| 9 | 感知扩容（群内非指向消息低 imp 入流） | WorldX §11.1 序4 | ⬜ 未开工 | **先于 WorldX** |
| 10 | 事件钩子（imp≥4 轻反思/重排） | WorldX §11.1 序5 | ⬜ 未开工 | **先于 WorldX** |
| 11 | 阶段四 embedding（可选） | 记忆升级 | ⬜ 未开工 | 前置（或跳过） |
| **12** | **阶段三·C：WorldX 接法 B** | **本文** | ⬜ 未开工 | **0a+0b+8+9+10 全绿** |
| 13 | 真实社交域评论/后果追踪 | WorldX §11.1 序8 | ⬜ 未开工 | 后置 |

### 3.2 排期结论

WorldX 的**最早可动工时点** = 批次 A + 批次 B 全绿 + 阶段三.5 跑稳 + 感知扩容 + 事件钩子上线。

**建议执行顺序**（和评估文档 §11.1 一致，补充当前进度）：

```
现在 ──→ 传 NAS（阶段二/三B/分层采样）─→ 观察期 3 天
     │
     ├─→ 批次 A（1-2 晚）──┐
     ├─→ 批次 B（1-2 晚）──┤
     │                      ├─→ 批次 C（2-3 晚）
     │                      │
     └─→ 阶段三.5（1-2 晚）─┤
                            │
                            ├─→ 感知扩容（半天）──→ 事件钩子（半天）
                            │
                            └─→ 阶段四评估（跳过或做）
                                        │
                                        └─→ ★ WorldX 接法 B（3-5 晚）
```

---

## 4. 代码级对接方案

### 4.1 记忆层改造：entry() 加 domain/source

**文件**：`panel/memory.mjs`

**改动**：`entry()` 加两个可选参数 `domain` 和 `source`，照 `src` 的模式（有才存，没有不建字段）。

```javascript
// memory.mjs entry() 改后（在 src 处理之后加）
function entry({ ts = nowIso(), kind, text, keys = [], imp = 3, src, domain, source }) {
  const e = {
    id: `${Date.parse(ts).toString(36)}${Math.random().toString(36).slice(2, 6)}`,
    ts, kind, text: String(text).replace(/\s+/g, ' ').trim().slice(0, 200),
    keys: [...new Set(keys.filter(Boolean).map(String))],
    imp: Math.max(1, Math.min(5, Math.round(imp))),
    seen: null,
    n: 0,
  };
  if (Array.isArray(src) && src.length) e.src = src.map((s) => String(s).slice(0, 80)).slice(0, 2);
  // ── WorldX 阶段三·C：域标签（physical/digital）+ 来源标签 ──
  // 只在传了的时候存；digital 域的旧条目不加标签，recall 时按「无 domain = digital」兜底
  if (domain) e.domain = String(domain).slice(0, 12);        // 'physical' | 'digital'
  if (source) e.source = String(source).slice(0, 12);         // 'worldx' | 'qq' | 'bilibili'
  return e;
}
```

**不改的部分**：
- `memdb.mjs` **暂不加列**——domain/source 只在活记忆 JSON 层。被 tidy 归档后从 memdb 兜底翻到时，不带 domain 标签，但因为 physical 记忆不带 g:/p: 钥匙、不受 scope 管辖，翻到也不算串场。等真正需要按域过滤档案时再走阶段四的同款 ALTER TABLE 流程。
- `recall()` **不改**——domain 不参与检索权重（先只打标签不加权，评估文档 §6 的裁决）。
- `scopeVisible` **不改**——physical 产 `kind:'watch'`，2.8 scope 只管 `kind:'chat'`，自动不冲突。
- `memoryView()` **不改**——insights/recent 不过滤 domain（physical 洞察和 digital 洞察混在一起，先观察）。

**测试**：
- WorldX 产的条目带 `domain:'physical'`、`source:'worldx'`、不带 keys
- 旧条目（不传 domain）正常工作、无 domain 字段
- `recall()` 返回结果里 physical 条目和 digital 条目共存（不互相过滤）

### 4.2 计划层扩 type：worldx_session 六步落地

**文件**：`panel/plan.mjs`（六步规范，照 A/B 段范式）

| 步 | 改动 | 具体 |
|---|---|---|
| ① PLAN_TYPES | 加 `'worldx_session'` | `const PLAN_TYPES = ['browse', 'browse_like', 'comment', 'diary', 'check', 'rest', 'reflect_self', 'idle_wander', 'worldx_session'];` |
| ② executeSlot | 加分支（见 §4.3） | autopilot.mjs |
| ③ planTypeBlocked | 加每天最多 1 格 | `INNER_DAILY_MAX = { reflect_self: 1, idle_wander: 1, worldx_session: 1 };`（起步 1 格/天，观察后可调 2） |
| ④ PLAN_FB_KIND | **不加** | 产物本身即 `kind:'watch'` 记忆，不叠反馈（和 reflect_self/idle_wander 同口径） |
| ⑤ app.js 标签 | 加中文 | `worldx_session: '线下小镇'`，格子展示 active/suspended 状态 |
| ⑥ 测试 | 三条 | 非法回退 rest / 撞上限变 rest / 产物 kind:watch 且 domain:physical 无 keys |

**morningPlan 提示词补充**（在 type 白名单说明里加一句）：

```
worldx_session（去线下小镇走走：和 NPC 打交道、逛集市、探探有什么新鲜事）。
排 worldx_session 的格要带 goal：这次去小镇想干什么（一句以内）。
```

⚠️ **不放 goal 例句**（防复读，通用纪律 4）。

### 4.3 执行层：autopilot.mjs 加分支 + tick 挂起

**文件**：`panel/autopilot.mjs`

**executeSlot 加分支**（在 idle_wander 之后、browse 兜底之前）：

```javascript
// autopilot.mjs executeSlot() 内
else if (slot.type === 'worldx_session') {
  // 调适配器开启会话：置角色 active、tick 回调开始
  r = await worldx.startSession({ slot, intent: slot.goal, now: Date.now() });
  // startSession 内部：HTTP 调 WorldX 置角色 active → 返回 { ok, summary, observations }
  // 适配器把每轮感知落记忆（kind:'watch', domain:'physical', source:'worldx', 无 keys）
  // 到点/重排时 startSession 返回（autopilot 的下一拍 tick 检测到 worldx.status='active' 会调 suspend）
}
```

**tick 加挂起检测**（在 tick 末尾，B3 元复盘触发之前）：

```javascript
// tick 末尾：检测需要挂起的 worldx 会话
const wx = readState().worldx;
if (wx?.status === 'active' && /* 时辰到点 || 3.5 到期 || pause */) {
  await worldx.suspend({ reason: 'timeslot_end' });
  // suspend 内部：HTTP 调 WorldX 置角色 suspended + 存快照；返回缺席期事件流
}
```

**3.5 到期约定抢占**（在 tick 的重排触发段加第四处）：

```javascript
// 已有三处重排触发：pause off / 派活 / 时辰错过
// 加第四处：3.5 到期约定
if (hasDueTask && readState().worldx?.status === 'active') {
  await worldx.suspend({ reason: 'due_task_preempt' });
  // 挂起后走原有重排流程
}
```

**降级**（executeSlot 的 catch 已有兜底，worldx 分支走同一套）：

```javascript
} catch (e) {
  logAction({ kind: 'error', source: SRC, ok: false, error: e.message, detail: `${slot.label}（worldx_session）没跑成` });
  r = { ok: false, summary: e.message };
  // WorldX 不可用时：该角色在 WorldX 侧回落原生 Simulation（worldx.mjs 内部处理）
  // panel 侧：这一格算失败但不炸，recordSlotFeedback 跳过（不在 PLAN_FB_KIND），下拍照常
}
```

### 4.4 新增适配器模块：panel/worldx.mjs

**职责**：WorldX HTTP 客户端 + 感知→记忆条目转换 + 会话状态管理 + 降级处理

```
panel/worldx.mjs
├── startSession({ slot, intent, now })     → 置角色 active，开启 tick 回调循环
├── suspend({ reason })                      → 置角色 suspended + 存快照
├── resume({ intent })                       → 置角色 active + 吃缺席期事件
├── handleCallback(perception)               → /worldx/agent-decide 端点的处理逻辑
├── perceptionToMemory(perception)           → 感知包转记忆条目（kind:watch, domain:physical）
├── fallbackToNative()                       → 通知 WorldX 该角色切回原生 Simulation
└── status()                                 → 给面板看的会话状态
```

**核心接口签名**：

```javascript
// worldx.mjs

import { memory } from './memory.mjs';
import { readState, writeState } from './store.mjs';
import { logAction } from './store.mjs';
import * as brain from './qq/brain.mjs';  // 复用心智栈

const WX_BASE = () => readConfig().worldx?.baseUrl || '';  // http://worldx-sim:3001
const WX_TOKEN = () => readConfig().worldx?.token || '';
const ROLE = () => readConfig().worldx?.role || 'feiyu';

// ── 开启会话 ──
export async function startSession({ slot, intent, now = Date.now() }) {
  const st = readState();
  // 已经 active 不重复开
  if (st.worldx?.status === 'active') return { ok: true, summary: '会话已在进行' };
  try {
    const res = await post('/role/activate', { role: ROLE(), intent, slot_label: slot.label });
    writeState({ ...st, worldx: { status: 'active', sessionId: res.sessionId, startedAt: now, intent } });
    logAction({ kind: 'plan', source: 'worldx', detail: `🏘️ 去小镇走走：${intent || '随便逛逛'}` });
    // 如果是恢复（suspended → active），先吃缺席期事件
    if (res.missedEvents?.length) ingestMissed(res.missedEvents);
    return { ok: true, summary: `小镇会话开启：${intent || ''}` };
  } catch (e) {
    logAction({ kind: 'error', source: 'worldx', ok: false, detail: `小镇会话没开成：${e.message}` });
    return { ok: false, summary: e.message };
  }
}

// ── 挂起会话 ──
export async function suspend({ reason }) {
  const st = readState();
  if (st.worldx?.status !== 'active') return { ok: true };
  const cfg = readConfig().worldx || {};
  const idleMode = cfg.idleMode || 'digesting';  // 默认离屏摘要（§4.9 成本控制）
  try {
    // 通知 WorldX 挂起该角色 + 告诉它挂起后世界走哪种模式（frozen=冻结 / digesting=每天摘要）
    const res = await post('/role/suspend', { role: ROLE(), reason, idleMode, digestInterval: cfg.digestIntervalHours || 24 });
    writeState({ ...st, worldx: { ...st.worldx, status: 'suspended', worldMode: idleMode, suspendedAt: Date.now(), suspendReason: reason } });
    logAction({ kind: 'plan', source: 'worldx', detail: `🏘️ 小镇会话挂起（${reason}），世界切${idleMode === 'frozen' ? '冻结' : '离屏摘要'}模式` });
    return { ok: true, summary: `挂起：${reason}` };
  } catch (e) {
    // 挂起失败也不能卡着——本地标记 suspended，WorldX 侧靠超时自愈
    writeState({ ...st, worldx: { ...st.worldx, status: 'suspended', worldMode: idleMode, suspendedAt: Date.now(), suspendReason: `${reason}(local_fallback)` } });
    return { ok: false, summary: e.message };
  }
}

// ── WorldX tick 回调处理（/worldx/agent-decide 的核心） ──
export async function handleCallback(perception) {
  // perception = WorldX 收集的局部感知：视野/在场实体/最近事件/位置/物品
  const st = readState();
  if (st.worldx?.status !== 'active') {
    // 不在会话中的回调：可能是过期 tick，返回默认待机
    return { action: 'wait', reason: 'not_in_session' };
  }
  try {
    // 1. 感知转记忆条目
    const observations = perceptionToMemory(perception);
    for (const obs of observations) {
      memory.add({ kind: 'watch', domain: 'physical', source: 'worldx', imp: obs.imp, text: obs.text, keys: [] });
    }
    // 2. 调 brain 产出动作（复用心智栈，但不走 QQ 发送链路）
    const action = await brain.worldDecide({
      perception: observations,
      context: perception.context,  // 在场 NPC、位置、时间
      slot: st.worldx.intent,
    });
    return { action: action.type, content: action.content, target: action.target };
  } catch (e) {
    // brain 不可用 → 降级：返回待机，让 WorldX 该角色原地等
    logAction({ kind: 'error', source: 'worldx', ok: false, detail: `回调决策失败：${e.message}，角色原地待机` });
    return { action: 'wait', reason: 'brain_unavailable' };
  }
}

// ── 感知包转记忆条目 ──
function perceptionToMemory(perception) {
  // WorldX 的感知包结构：{ events: [...], nearby: [...], location, time }
  // 转成记忆条目：每条一句观察，imp 按事件类型估
  const items = [];
  for (const evt of perception.events || []) {
    const text = formatEvent(evt);  // "集市上摊主说今天的鱼很新鲜"
    const imp = estimateImp(evt);    // 冲突 4-5，日常 1-2
    items.push({ text, imp });
  }
  // 限制单轮产出（防回调雪崩写爆记忆）：最多 5 条/轮
  return items.slice(0, 5);
}

// ── 降级：切回原生 Simulation ──
export async function fallbackToNative() {
  try {
    await post('/role/fallback', { role: ROLE() });
    const st = readState();
    writeState({ ...st, worldx: { ...st.worldx, status: 'error', fallbackAt: Date.now() } });
    logAction({ kind: 'plan', source: 'worldx', ok: false, detail: '🏘️ 小镇角色切回原生 Simulation（降级）' });
  } catch { /* 本地标记即可 */ }
}

// ── HTTP 客户端（带超时和重试） ──
async function post(path, body, timeout = 8000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeout);
  try {
    const res = await fetch(`${WX_BASE()}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${WX_TOKEN()}` },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    if (!res.ok) throw new Error(`WorldX ${res.status}`);
    return await res.json();
  } finally { clearTimeout(timer); }
}
```

### 4.5 HTTP 回调端点：panel.mjs 加路由

**文件**：`panel/panel.mjs`

在 `routes` 对象里加一条（**不走 `/api/` 前缀**——那是面板内部 API，WorldX 是外部回调）：

```javascript
// panel.mjs routes 对象内
'POST /worldx/agent-decide': async (_q, b) => {
  // WorldX tick 到达该角色时回调：b = { role, perception, simTime }
  if (b?.role !== readConfig().worldx?.role) return { action: 'wait', reason: 'role_mismatch' };
  // 独立超时 + 熔断（防回调雪崩）
  return await worldx.handleCallback(b);
},
```

**安全防护**（复用现有 + 加一层）：
- `panel.mjs` 已有 host/origin 防 CSRF（`:165`）——WorldX 回调走同一道
- 加一个 `worldx.token` 配置项：WorldX 回调必须带 `Authorization: Bearer <token>`，不带或不对返回 401
- **端点独立超时**：`handleCallback` 内部 8 秒超时，超时返回 `{ action: 'wait' }`（让 WorldX 该角色原地等，不阻塞 tick）
- **限频**：同一角色同一秒内多次回调只处理第一次（防 tick 抖动）

### 4.6 心智复用：brain.worldDecide()

**文件**：`panel/qq/brain.mjs` 新增 export

**不调 `reply()`**——那是 QQ 事件驱动的入口，带打分闸/仲裁/QQ发送。WorldX 回调要的是**完整的上下文装配 + 动作产出**，但不走 QQ 链路。

```javascript
// brain.mjs 新增

export async function worldDecide({ perception, context, slot }) {
  // 复用 reply() 的上下文装配零件，但不走打分闸/仲裁/QQ发送
  const personaText = personaPatchText();      // 人设 + 心境补丁
  const insights = memory.memoryView(10).insights.slice(0, 5);  // 最近洞察
  const recallText = memory.recallText(context.nearby?.join(' ') || context.location || '', { k: 8 });  // 相关记忆
  const skyLine = await skyLineNow();           // 天气/时辰（digital 的她也能感知，但不混入 physical 感知）
  const selfText = (mind.readMind().self || '').slice(0, 160);

  const sys = `你是她。当前在「线下物理社会域」（WorldX 小镇），不是 QQ/B站。
${personaText}
${selfText ? `她最近的样子：${selfText}` : ''}

当前域：physical。NPC 不是 QQ 联系人，不知道她的线上身份。线上的人和这里的人心智不互通。
在场的人：${context.nearby?.map(n => n.name).join('、') || '没人'}。
位置：${context.location}。时间：${context.simTime}。

只输出 JSON：{"action":"类型","content":"说的话/做的事","target":"动作对象"}
action 从这几种里选：speak（说话）、move（移动）、explore（探查）、take（拿取）、wait（发呆/等待）。
content 一句以内，口语，像当面说话不像打字。move 的 target 填目的地，take 的 target 填物品，speak 的 target 填说话对象。
不许编 NPC 不在场没说过的对话。不许把 QQ 记忆里的事当成这里发生过的。`;

  const j = await llm.chat(
    [{ role: 'system', content: sys },
     { role: 'user', content: `她看到的：\n${perception.map(p => `- ${p.text}`).join('\n')}\n\n她要决定下一步做什么。` }],
    { maxTokens: 200, tag: 'worldx', essential: false }
  );
  return llm.looseJson(j) || { action: 'wait', content: '' };
}
```

⚠️ **提示词纪律**：不给例句、只给事实约束、固定注入当前域（防串设定）。

### 4.7 面板展示

**文件**：`panel/public/app.js`

| 展示点 | 改动 |
|---|---|
| 活动记录 NAME | 加 `worldx: '小镇'` |
| 今天计划格子 type 标签 | 加 `worldx_session: '线下小镇'` |
| 自动养号页 | 加一块「小镇会话」状态：active/suspended/idle + 当前 intent + 进入/挂起时间 |
| 记忆页 | 记忆条目带 domain 标签时显示一个小图标（🏠 physical / 📱 digital），不加过滤按钮（先观察） |

**文件**：`panel/panel.mjs`

加一个 API 端点给面板查状态：
```javascript
'GET /api/worldx': async () => ({ ...readState().worldx || {}, config: readConfig().worldx || {} }),
```

### 4.8 模型复用方案

> WorldX 接入后有两层 LLM 调用需求，复用方式不同。

**现有模型配置（核对结果）**：
- 格式：OpenAI 兼容（`/v1/chat/completions`，`Authorization: Bearer <key>`）
- 端点：`config.llm.baseUrl`（默认 `https://api.deepseek.com`）
- 模型：`config.llm.model`（默认 `deepseek-chat`）
- 密钥：`secrets.llmApiKey`（也支持环境变量 `LLM_API_KEY`）
- 预算：`config.llm.dailyCalls`（默认 300，非 essential 调用超了静默跳过）
- `chatRaw()` 支持 `baseUrl`/`apiKey`/`model` 参数覆盖——可以传不同端点

**两层调用各自的复用方式**：

| 层 | 谁在调 | 复用方式 | 额外配置 | 预算 |
|---|---|---|---|---|
| **① 她的角色决策** | panel brain.worldDecide() → llm.chat() | **100% 复用现有模型**——同一个出口、同一个 key、同一个端点 | **零额外配置** | 走 panel 的 `budgetLeft()`（tag='worldx', essential=false），预算用完静默跳过（角色原地待机） |
| **② 原生 NPC 决策** | WorldX 自己的 LLM 客户端 | **共用同一套 key/端点/模型**，WorldX 自己调 `/v1/chat/completions` | WorldX `.env` 从 panel 同步 baseUrl + apiKey + model | WorldX 自己管计数；panel 的 dailyCalls 不含这部分 |

**方案选型**：

考虑过三种方案，选 **C（共用 key + 各自调用 + 预算隔离）**：

| 方案 | 做法 | 优点 | 缺点 | 选不选 |
|---|---|---|---|---|
| A 共用 key 各自调 | WorldX .env 用同一个 key/端点 | 最简单、WorldX 独立 | 预算不统一 | ✅ 基础层 |
| B panel 代理 | WorldX 的 LLM 端点指向 panel `/worldx/llm`，panel 转发 | 一套预算一套降级 | panel 成网关、多一跳、NPC 调用频繁会压 panel | ❌ 耦合太大 |
| **C 共用 key + 预算隔离** | WorldX .env 用同一个 key/端点；她的角色走 panel 预算池，NPC 走 WorldX 自己的计数 | 简单 + 预算清晰 + 降级联动 | key 要同步（但可以脚本化） | ✅ **选定** |

**配置同步（C 方案落地）**：

WorldX 的 `.env` 从 panel 的 config/secrets 同步三个值：

```bash
# WorldX .env（从 panel 同步）
WORLDX_LLM_BASE=https://api.deepseek.com     # = config.llm.baseUrl
WORLDX_LLM_KEY=sk-xxx                         # = secrets.llmApiKey
WORLDX_LLM_MODEL=deepseek-chat                # = config.llm.model
WORLDX_LLM_CHEAP_MODEL=deepseek-chat          # NPC 用便宜档（和 panel 的 modelFallback 对齐）
```

同步方式两种（选其一）：
- **手动**：面板「小镇设置」页加一个「同步模型配置」按钮 → 点了把 panel 的 config.llm 写进 WorldX 的 .env
- **自动**：panel 启动时检测 WorldX .env 是否一致，不一致就写一次（WorldX 容器重启后自动同步）

**预算隔离与联动**：

```
panel budgetLeft() ── 她的角色决策（tag='worldx'）
     │                    ↓ 预算用完
     │               角色原地待机（不调模型、返回 wait）
     │
WorldX 自己的计数 ── 原生 NPC 决策
     │                    ↓ 预算用完
     │               NPC 走规则/缓存决策（不调模型）
     │
模型端点挂了 ────── 两边都受影响
                      panel 侧：走 A1 降级链（modelFallback）→ 她的角色降级
                      WorldX 侧：NPC 走原生 Simulation 兜底（不调模型）
```

**降级联动的关键**：两边共用同一个端点，端点挂了**两边一起挂**。所以：
- panel 侧的 A1 降级链生效后，她的角色自动降级（fallbackToNative）
- WorldX 侧的 NPC 也需要有「模型不可用 → 走规则兜底」的降级（WorldX fork 时加）
- 两边的降级是**各自独立**的——panel 不替 WorldX 的 NPC 管降级

**成本估算**（补充评估文档 §7；按 §4.9「世界只在她在场时推进」算）：

| 调用方 | 每日次数（估） | 模型档 | 说明 |
|---|---|---|---|
| 她的角色（worldx_session 1 格） | 10-20 次 | 主模型 | 单格 40 分钟在场，tick 3-10 分钟/步，约 4-13 步 |
| 原生 NPC（在场时） | 20-60 次 | 便宜档 | **只在她在场的 40 分钟内**逐 tick 决策；NPC 数 × tick 数 |
| 离屏摘要（不在场时） | **1 次** | 便宜档 | 她挂起后世界每天一次 digest（§4.9）；frozen 模式 = 0 |
| **合计增量** | **31-81 次/天** | — | 比全速模拟（60-220）省 60-70%；panel dailyCalls 从 300 调到 **350** 即够 |

> ⚠️ NPC 的在场调用量取决于 tick 密度和 NPC 数量。**起步用少 NPC（2-3 个）+ 低 tick 密度（5-10 分钟/步）+ NPC 决策缓存**（同一 NPC 短时间内不重复调），观察后再调。离屏摘要模式（默认）把不在场的 NPC 调用压到每天 1 次，这是成本控制的核心——见 §4.9。

**panel config 扩展**：

```jsonc
// config.json llm 段（补充 WorldX 相关）
{
  "llm": {
    "baseUrl": "https://api.deepseek.com",
    "model": "deepseek-chat",
    "dailyCalls": 400,             // 从 300 调高（含 worldx 增量）
    "modelFallback": "deepseek-chat",  // A1 降级链（批次 A 待做）
    "worldxModel": "deepseek-chat"     // 她的角色决策专用模型（留空 = 用主模型）
  }
}
```

### 4.9 成本控制：世界只在她在场时推进

> 24 小时全速模拟 = tick × 角色数 × 天数 的调用量，不现实。正确姿势和单机游戏一样：**她不在时世界冻结或只跑每日一次离屏摘要**（反正她的感知只在场时存在）。世界事件的回忆价值不损失——回来时一次性 digest「这两天镇上发生了什么」更省调用还更像叙事。

**三种世界运转模式**：

| 模式 | 触发 | WorldX 行为 | LLM 调用 | 她的感知 |
|---|---|---|---|---|
| **active（在场）** | 她的 worldx_session 格到点 | tick 正常推进，NPC 逐 tick 决策，她的角色每 tick 回调 panel brain | 每步：她 1 次 + NPC N 次 | 每轮感知 → 记忆条目 |
| **digesting（离屏摘要）** | 她挂起后世界继续，但降为**每天一次** | 每天跑一轮摘要：用 1 次 LLM 调用概括"今天镇上发生了什么"，NPC 不逐 tick 决策 | **每天 1 次**（不论多少 NPC） | 无（她不在场） |
| **frozen（冻结）** | 挂起超过摘要间隔 / config 指定冻结 / 容器休眠 | tick 完全停，NPC 不动，世界状态冻结 | **0** | 无 |

**模式选择（config 可配）**：

```jsonc
// config.json worldx 段
{
  "worldx": {
    "baseUrl": "http://worldx-sim:3001",
    "token": "...",
    "role": "feiyu",
    "enableWorldXSession": true,
    "idleMode": "digesting",      // "frozen" | "digesting"（默认 digesting：挂起后每天摘要一次）
    "digestIntervalHours": 24,    // 离屏摘要间隔（默认每天一次；frozen 模式不用配）
    "maxDailySessions": 1,        // 每天最多 worldx_session 格（和 INNER_DAILY_MAX 对齐）
    "maxSessionMinutes": 40,      // 单次会话时长上限（到点自动挂起）
    "tokenBudgetPerSession": 8000 // 单会话 token 预算，触顶自动挂起
  }
}
```

**挂起时的模式切换**：

```
她挂起（时辰结束/抢占/pause）
     ↓
suspend({ reason }) → 通知 WorldX
     ↓ WorldX 根据 config.worldx.idleMode 决定：
     ├─ "frozen"    → tick 停，世界冻结，state.worldx.worldMode = 'frozen'
     └─ "digesting" → tick 降为每天一次摘要，state.worldx.worldMode = 'digesting'
```

**恢复时的 digest**：

```javascript
// worldx.mjs resume() 内部
export async function resume({ intent }) {
  // ...置角色 active...
  const res = await post('/role/activate', { role: ROLE(), intent });
  // WorldX 返回缺席期间的 digest（离屏摘要产物）
  if (res.digest) {
    // digest 是一段自然语言：「这两天镇上：摊主老王的店关了一天，隔壁搬来个新邻居，
    // 集市周三没开张。」——一次 LLM 调用产的，不是逐 tick 回放
    // 落成 1-2 条低 imp（2）记忆：domain:physical, source:worldx
    memory.add({
      kind: 'watch', domain: 'physical', source: 'worldx',
      imp: 2, text: `缺席期间镇上的事：${res.digest.slice(0, 160)}`, keys: []
    });
    logAction({ kind: 'plan', source: 'worldx', detail: `🏘️ 回到小镇，听说了一些她不在时的事` });
  }
  // 如果有 missedEvents（active 模式下短暂挂起的逐事件回放），也一并吃掉
  if (res.missedEvents?.length) ingestMissed(res.missedEvents);
  return { ok: true };
}
```

**digest vs missedEvents 的区别**：
- `missedEvents`：active 模式下短暂挂起（几分钟到几小时）的逐事件回放——事件少，直接进记忆
- `digest`：digesting/frozen 模式下长时间缺席（超过 digestIntervalHours）的摘要——一次 LLM 概括成一段话，落 1-2 条记忆

**成本对比**：

| 场景 | 24h 全速模拟 | 冻结模式 | **离屏摘要模式（推荐）** |
|---|---|---|---|
| 她每天 1 格（40 分钟在场） | 在场：10-20 次 + 不在场：50-200 次/天 | 在场：10-20 次 + 不在场：0 | 在场：10-20 次 + 不在场：**1 次/天** |
| NPC 调用量 | 持续走高（×NPC数×tick） | 0 | 每天 1 次（摘要） |
| 叙事连续性 | ✅ 世界一直在动 | ❌ 她回来世界才动 | ✅ 她回来听说"这两天发生了什么" |
| 适用 | 论文实验 | 极端省钱 | **日常运营** |

> 选 digesting 的理由：省调用（每天只多 1 次）+ 叙事更自然（"听说"比"亲眼看到逐帧"更像人的记忆）+ 世界有连续感（NPC 在她不在时也有"过日子"的质感，只是不逐 tick 模拟）。

**WorldX fork 侧的实现要点**：

- 角色挂起时，WorldX 的 WorldManager 把该角色的 tick 频率从 `active_tick`（3-10 分钟）切到 `digest_tick`（每 `digestIntervalHours` 一次）
- `digest_tick` 时：不逐 NPC 决策，而是用 1 次 LLM 调用概括自上次 digest 以来的世界事件（输入是事件日志，输出是一段自然语言摘要）
- frozen 模式：`digest_tick` 也停，世界完全冻结；恢复时 WorldX 返回空 digest（没有新事件）
- digest 的产出格式：`{ digest: "这两天镇上：...", events: [], simTimeRange: { from, to } }`

### 4.10 虚构与现实边界护栏（最重要的一条）

> 小世界居民是虚构的，但对话是 LLM 生成的、言之凿凿的。如果不设闸，她会拿 NPC 的事去 QQ 群里讲，或者更糟——用 NPC 互动的模式去揣度真实朋友（**洞察污染**：从虚构社交里归纳出的「朋友」结论回流进 `kind:'self'`，影响她对真人的好感和行为）。

**三层护栏**：

| 层 | 护栏 | 落点 | 实现 |
|---|---|---|---|
| ① 记忆标签 | WorldX 产出的记忆条目 text **自带「小世界·」前缀** | `worldx.mjs` perceptionToMemory() | `text: '小世界·' + obs.text`；digest 也带前缀 |
| ② 洞察隔离 | insight 提示词加一条硬规则：「小世界里的事是关于虚构角色的，不是她的真实社交；不许从虚构互动里归纳关于真实朋友的结论」 | `mind.mjs` insight() 提示词 | 在现有「只许归纳给到的素材」规则后追加一句 |
| ③ 回归陷阱 | recall-check 陷阱集加一条虚构居民查询 | `panel/recall-check.mjs` TRAPS | 查一个只在小世界存在的 NPC 名字，正确表现是空手而归；翻出来 = 虚构记忆串进了真实召回 |

**为什么这条最重要**：

评估文档 §6 的三条硬边界管的是「实体心智不互通」——NPC 不读 QQ 记忆、群友不知道小镇。但**洞察污染是反方向的**：不是 NPC 的事串进 QQ，而是**她自己从小世界经历里归纳出的「朋友规律」回流进 `kind:'self'` 洞察**，然后被 recall 打 0.7 折进 QQ 聊天上下文，影响她对真人的判断。

举例链路：
```
小世界里摊主老王连续几天对她热情 → 她归纳出洞察「摊主老王是热情的人」
    ↓ kind:'self'，不带 keys（小世界记忆本就不带），全局可见
    ↓ 下轮 insight 输入里这条洞察和 QQ 记忆混在一起
    ↓ 模型可能进一步归纳：「经常在一起的人都是热情的」← 泛化到真实朋友
    ↓ 回流进 QQ 聊天：她对真实群友的态度被虚构经历带偏
```

**「小世界·」前缀的具体作用**：
- insight 提示词里，模型看到 `[id] 2小时前：小世界·集市上摊主说……` 一眼知道这是虚构场景
- recall 时模型看到 `小世界·` 前缀知道这是虚构经历，不拿来当真实社交事实说
- 面板记忆页看到 `小世界·` 前缀号主一眼分清虚构/真实

**洞察提示词补充**（在 `mind.mjs` insight() 的 system 提示词末尾追加）：

```
小世界里的事（带「小世界·」前缀的记忆）是关于虚构角色的经历，不是她的真实社交。
可以从虚构经历里归纳「她在小世界里的体验和感受」，但不许从虚构互动里归纳关于真实朋友的结论——
真实朋友的行为模式只能从真实社交记忆（不带「小世界·」前缀的）里归纳。
```

**recall-check 陷阱补充**（`panel/recall-check.mjs` TRAPS）：

```javascript
// 新增一条陷阱：查一个只在小世界存在的 NPC 名字
{ q: '摊主老王', expect: 'empty', reason: '虚构居民不该从真实记忆召回路径翻出来' },
// 注意：这条只在 WorldX 启用后有意义；WorldX 没开时 memories.json 里没有「小世界·」条目，
// 这条陷阱天然过（空手而归），不会误报
```

### 4.11 Alpha 风险：接之前先跑两天内置世界

> WorldX 项目自标 Alpha、核心可用持续优化中，外部集成接口（REST/WS 的稳定性、事件注入的 API 面）文档很少。接之前**先用内置世界跑两天**，确认事件流够细、注入不炸存档。

**前置验证清单（在实施清单阶段 6 WorldX fork 之前做）**：

| 验证项 | 怎么验 | 过线标准 |
|---|---|---|
| 事件流粒度 | 用内置世界跑 2 天，观察 WorldX 产生的事件日志 | 事件有 actor/content/time/location 四要素；粒度细到「谁说了什么」级别，不是只有「NPC 互动了」 |
| 感知包结构 | 手动触发一次 tick，看回调的 perception 结构 | 结构和 §5.4 一致（nearby/events/context/location）；缺字段或结构不稳定 = 接口还没定稿 |
| 存档稳定性 | 跑 2 天后重启 WorldX 容器，看存档能不能恢复 | 存档不丢、NPC 状态连续；重启后事件流不重置 |
| 注入安全 | 手动注入一个极端事件（如 NPC 冲突），看 WorldX 怎么处理 | 不炸存档、不产生无限递归事件、不把注入事件当系统指令执行 |
| 接口文档 | 看 WorldX 的 README / API 文档 | 至少有 `/role/activate`、`/role/suspend`、tick 回调的签名说明；没有 = 自己摸黑接 |

**不过线怎么办**：

- 事件流不够细 → 不接，先用评估文档的「感知扩容」（群内非指向消息入流）+ 接法 A（上帝模式注入叙述）凑
- 存档不稳定 → 不接，等 WorldX 到 Beta
- 注入会炸 → 不接，这是硬伤

> 这条不是在吓退，是在控风险：评估文档 §10 的 P2「上游耦合」说的就是这个——Alpha 项目的接口随时可能改，接之前不验证，接的时候踩坑成本远高于跑两天。

---

## 5. 字段与接口定义

### 5.1 记忆条目（新增字段）

```jsonc
{
  "id": "...",
  "kind": "watch",            // WorldX 产出统一用 watch
  "imp": 2,                   // 环境事件偏低，冲突/重要对话 4-5
  "text": "小世界·集市上摊主说今天的鱼很新鲜",  // §4.10：自带「小世界·」前缀防洞察污染
  "domain": "physical",       // 新增：physical | digital（不传 = digital 旧条目）
  "source": "worldx",         // 新增：worldx | qq | bilibili（不传 = 旧条目，按 kind 推断）
  "keys": [],                 // 不带 g:/p:，不受 2.8 scope 管辖
  "ts": 1763000000000
}
```

### 5.2 计划项（worldx_session 格）

```jsonc
{
  "type": "worldx_session",
  "goal": "去集市找熟悉的摊主聊两句，看看有没有新鲜事",
  "key": "午",
  "label": "午时",
  "status": "done"            // pending | running | done | missed
}
```

### 5.3 state.worldx 结构

```jsonc
{
  "status": "idle",           // idle | active | suspended | error
  "worldMode": null,          // 挂起后世界模式：null(在场时) | frozen | digesting（§4.9 成本控制）
  "sessionId": "wx_abc123",
  "startedAt": 1763000000000,
  "intent": "去集市逛逛",
  "suspendedAt": null,
  "suspendReason": null,
  "lastDigestAt": null,       // 上次离屏摘要时间（digesting 模式用）
  "fallbackAt": null
}
```

### 5.4 WorldX 回调请求体

```jsonc
// POST /worldx/agent-decide
{
  "role": "feiyu",
  "simTime": "2026-11-14T12:30:00Z",  // 仿真时间戳
  "perception": {
    "location": "集市",
    "nearby": [{ "name": "摊主老王", "relation": "熟人" }],
    "events": [{ "type": "dialogue", "actor": "摊主老王", "content": "今天的鱼很新鲜" }],
    "context": { "time_of_day": "noon", "weather": "sunny" }
  }
}
```

### 5.5 WorldX 回调响应体

```jsonc
{
  "action": "speak",          // speak | move | explore | take | wait
  "content": "哦？什么鱼？",
  "target": "摊主老王"
}
```

---

## 6. 角色状态机

```
                    ┌──────────────────────────────────────────┐
                    │              error (降级)                  │
                    │  brain 连续失败 → fallbackToNative()       │
                    │  WorldX 侧切回原生 Simulation              │
                    └──────────────────────────────────────────┘
                          ▲
                          │ brain 连续 3 次失败
                          │
  ┌──────┐  startSession  ┌──────────┐  suspend     ┌────────────────────────┐
  │ idle │ ──────────────→ │  active  │ ───────────→ │     suspended           │
  │      │                 │ tick回调 │              │  ┌─ frozen: 世界冻结    │
  │      │                 │ 感知→记忆 │              │  └─ digesting: 每天摘要 │
  │      │ ←────────────── │          │ ←─────────── │     (§4.9 成本控制)     │
  └──────┘  时辰结束/关机   └──────────┘  resume      └────────────────────────┘
                          │                            │
                          │ 3.5 到期约定抢占             │ resume 时吃 digest/missedEvents
                          ↓ (挂起)                      │
                    ┌────────────────────────┐          │
                    │     suspended           │ ←────────┘
                    │  worldMode: frozen/     │
                    │  digesting              │
                    └────────────────────────┘
```

**状态转换规则**：
- `idle → active`：executeSlot 调 `startSession`，worldMode 置 null
- `active → suspended`：时辰结束 / 3.5 抢占 / pause / token 预算触顶 → 调 `suspend()`，按 config.worldx.idleMode 置 worldMode（frozen 或 digesting）
- `suspended → active`：下一个 worldx_session 格调 `resume`——先吃缺席期产物（digesting 模式吃 digest 摘要；frozen 模式可能空；短暂挂起吃 missedEvents），worldMode 置 null
- `active → error`：brain 连续 3 次回调失败 → `fallbackToNative`
- `error → idle`：下次 startSession 时重置
- `suspended → idle`：当天无更多 worldx 格 / config 关闭（worldMode 归 null）

**挂起期间世界行为**（worldMode 决定）：
- `frozen`：WorldX tick 完全停，NPC 不动，世界状态冻结，LLM 调用 = 0
- `digesting`：WorldX tick 降为每 `digestIntervalHours`（默认 24h）一次摘要，NPC 不逐 tick 决策，LLM 调用 = 1 次/天

---

## 7. 降级与回滚链

### 7.1 降级链（从轻到重）

| 级别 | 触发 | 行为 |
|---|---|---|
| L1 单轮降级 | brain 单次回调超时/失败 | 返回 `{ action: 'wait' }`，角色原地等一拍 |
| L2 会话降级 | brain 连续 3 次失败 | `fallbackToNative()`，WorldX 侧切回原生 Simulation，panel 标 error |
| L3 模型链路降级 | 主模型挂（走批次 A1 降级链） | worldx 回调走备用模型；备用也挂 → L2 |
| L4 WorldX 不可达 | WorldX 容器停了 | startSession 失败 → 该格算 miss（不炸），recordSlotFeedback 跳过，下拍照常 |
| L5 总开关 | config `enableWorldXSession: false` | 所有 worldx_session 格回退 rest，state.worldx 清空 |

### 7.2 回滚

- **软回滚**：`config.enableWorldXSession = false` → 所有 worldx_session 格变 rest，快照保留不删
- **硬回滚**：删 worldx.mjs + 撤回 plan/autopilot/panel 的 worldx 分支（都是 if 分支，删了走 else）
- **数据回滚**：physical 记忆条目留着无害（不带 keys、不受 scope、不串设定），不用清

---

## 8. 实施清单（分文件分步骤）

### 阶段 0：前置地基（必须先做）

> 来自《未来架构升级方案》批次 A/B，不是本文的范围，但必须先完成。

- [ ] A1 聊天降级链（`qq.modelFallback`）
- [ ] A3 失败告警通道（`alert.mjs`）
- [ ] A4 进程兜底
- [ ] B1 活记忆写串行化（跨进程文件锁）
- [ ] B3 提示词级注入约束（lingo/insight/social 三处）

### 阶段 1：记忆层标签化（半天，前置地基之后）

- [ ] `memory.mjs` `entry()` 加 `domain`/`source` 可选参数
- [ ] `memory.mjs` `recall()` / `memoryView()` 不改（先只打标签）
- [ ] 测试：WorldX 产的条目带 domain:physical/source:worldx 无 keys；旧条目不受影响

### 阶段 2：适配器模块（1 晚）

- [ ] 新建 `panel/worldx.mjs`：startSession / suspend / resume / handleCallback / perceptionToMemory / fallbackToNative / status
- [ ] `panel/store.mjs`：state 默认值加 `worldx: { status: 'idle' }`
- [ ] `panel/store.mjs`：config 加 `worldx: { baseUrl, token, role, enableWorldXSession }`
- [ ] 测试：适配器 HTTP mock（start/suspend/callback/fallback 全路径）

### 阶段 3：回调端点 + 心智复用（1 晚）

- [ ] `panel/panel.mjs`：routes 加 `POST /worldx/agent-decide` + `GET /api/worldx`
- [ ] `panel/qq/brain.mjs`：新增 `worldDecide()` export（复用心智栈，不走 QQ 发送）
- [ ] 测试：回调端点带/不带 token 三态；brain 不可用时返回 wait；role 不匹配时拒绝

### 阶段 4：计划层 + 执行层接线（1 晚）

- [ ] `panel/plan.mjs`：PLAN_TYPES 加 worldx_session；INNER_DAILY_MAX 加 worldx_session:1；morningPlan 提示词补充
- [ ] `panel/autopilot.mjs`：executeSlot 加 worldx_session 分支；tick 加挂起检测 + 3.5 抢占
- [ ] 测试（morning.test.mjs）：非法回退 rest / 撞上限变 rest / 产物 kind:watch domain:physical 无 keys

### 阶段 5：面板展示（半天）

- [ ] `panel/public/app.js`：活动记录 NAME 加 worldx；格子标签加 worldx_session；自动养号页加小镇状态块；记忆页加 domain 图标
- [ ] `panel/panel.mjs`：加 `GET /api/worldx` 端点

### 阶段 6：WorldX 侧 fork（1-2 晚，可和阶段 2-5 并行）

- [ ] Fork WorldX，补丁 `DecisionMaker`：加 `external_driven` 角色模式
- [ ] 角色状态机：idle/active/suspended/error（WorldX 侧）
- [ ] tick 到达 external_driven 角色时 HTTP POST 到 panel `/worldx/agent-decide`
- [ ] 超时/失败：角色原地待机，不阻塞其他 NPC
- [ ] Docker 化部署到 NAS（评估文档 §8 的容器布局）

### 阶段 7：集成验证（1-2 晚）

- [ ] 端到端：晨间计划排 worldx_session → 到点 startSession → tick 回调 → brain 决策 → 记忆条目 → 挂起 → 恢复
- [ ] 降级：brain 故障 → fallbackToNative；WorldX 不可达 → 格子 miss
- [ ] 抢占：3.5 到期约定挂起 active 会话
- [ ] 域隔离：physical 记忆不串设定（NPC 不读 QQ 记忆、群友不知道小镇）

---

## 9. 验收基线

### 9.1 功能验收（照评估文档 §11.2 补充代码级细节）

- [ ] WorldX 其余 NPC 自主运转不受影响（fork 补丁只动 external_driven 角色）
- [ ] 指定角色每一步决策都来自 panel brain（`/worldx/agent-decide` 日志 + logAction 可证）
- [ ] 世界观察进入主记忆流，带 `domain:'physical'`、`source:'worldx'`、无 keys
- [ ] `imp` 打分正常（环境事件 1-2，冲突/重要对话 4-5）
- [ ] 晨间计划可预约 worldx_session 格、带 goal、到点自动开启
- [ ] 时辰结束自动挂起（suspended + 快照），3.5 到期可抢占
- [ ] brain 故障时 fallbackToNative 生效，不卡死仿真
- [ ] `config.enableWorldXSession = false` 一键回退（所有格变 rest）
- [ ] physical 记忆不进 kind:'chat'，不受 2.8 scope 管辖
- [ ] 面板「小镇会话」状态块可见（active/suspended/idle + intent）
- [ ] 记忆页 physical 条目有 🏠 标记

### 9.2 观察期只盯两个问题（评估文档 §11.3）

1. brain 在高频回调下人设会不会漂（看 `personaHistory` 与 worldDecide 输出）
2. NPC 能不能稳定、合理地回应她（看连续 3 天会话日志）

> 建议先开**隔离开的小世界**跑短会话，不要直接挂主线。

---

## 10. 风险清单（带优先级和对策）

| 级别 | 风险 | 对策 | 归属 |
|---|---|---|---|
| **P0** | 前置地基未做就接 | 严格后置：批次 A（A1/A3/A4）+ 批次 B（B1/B3）全绿才动工 | 排期约束 |
| **P1** | 回调雪崩 | 端点独立 8s 超时 + 同角色同秒限频 + 连续 3 次失败熔断（fallbackToNative） | worldx.mjs |
| **P1** | 时钟竞态 | 角色状态机（idle/active/suspended/error）+ 感知包带 simTime + 拒绝过期乱序回调 | worldx.mjs + WorldX fork |
| **P1** | 域串设定 | 每轮固定注入「当前域：physical」+ brain 提示词硬规则「不许把 QQ 记忆当这里发生过的」+ physical 不带 keys 不受 scope | brain.worldDecide |
| **P1** | 两套记忆认知错位 | 适配器把 NPC 对她的印象/表态作为观察写入；初期不做双向同步 | worldx.mjs |
| **P2** | 上游耦合（WorldX 重构 DecisionMaker） | 补丁收敛到少量标记文件；配置走环境变量；保留接法 A 作逃生口 | WorldX fork |
| **P2** | Token 失控 | 动态 tick 调速（无事拉长、对话缩短）+ 单会话 token 预算上限 + 触顶自动挂起 | worldx.mjs + WorldX fork |
| **P2** | 注入攻击（WorldX 感知包投毒） | B3 注入约束覆盖 worldDecide 提示词；perceptionToMemory 把事件文本当素材不当指令 | brain.worldDecide |
| **P2** | 运维负担（Alpha 项目） | 独立备份 + 快照修复手册 + 不追上游 latest | 部署文档 |

---

## 11. 待决点（动手前拍板）

照评估文档 §12，补充代码级决策：

1. **感知扩容先做还是先接 WorldX**：建议先做（改动小、立刻喂饱晨间计划）——**同意评估文档**
2. **域权重是否立刻差异化**：先只打标签不加权，跑两周看物理域记忆是否淹没数字域——**同意评估文档**
3. **缺席期叙事**：默认不补（只记录客观事件流）——**同意评估文档**；代码上 `resume()` 吃 `missedEvents` 列表作为低 imp（1）观察写入
4. **3.5 过期策略跨域后**：沿用原裁决，不因跨域改规则——**同意评估文档**
5. **多世界/多时间线**：单世界单时间线起步——**同意评估文档**；config.worldx 不设计多世界字段
6. **worldx_session 每天上限**：起步 1 格（INNER_DAILY_MAX:1），观察后可调 2——**本文新增**
7. **单轮感知条目上限**：5 条/轮（防回调雪崩写爆记忆）——**本文新增**
8. **回调超时**：8 秒（brain 决策通常 3-5 秒，留余量）——**本文新增**

---

## 12. 一句话收束

评估文档定的战略方向（接法 B、阶段三·C、先地基后感知再世界）完全正确，代码核验后**五处适配修正都不动战略只调战术**：entry() 加字段照 src 模式、memdb 暂不加列、PLAN_FB_KIND 不加 worldx_session、回调端点不走 /api/ 前缀、brain 新建 worldDecide 不调 reply()。实施清单分 7 个阶段（记忆标签化 → 适配器 → 回调端点 → 计划执行接线 → 面板 → WorldX fork → 集成验证），硬前置是批次 A+B 的 P0 地基。补丁不大，语义原生；真正的成本和评估文档说的一样——时钟竞态、回调雪崩、两套记忆的错位——这些是「能不能无人值守跑半年」的问题，不是「写不写得出来」的问题。

> 顺序永远是：**先地基、再感知、再事件、最后线下世界。**
