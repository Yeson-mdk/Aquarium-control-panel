/**
 * 聊天上下文拼装（从 brain.mjs 拆出，架构升级批次 C7）
 *
 * 纯拼装：读一堆现成模块的状态/文本，拼成给模型的一段 system 提示。不调模型、不写状态、不 send。
 * 唯一例外是 contextText 里顺手 prefetch 了一把 query 向量（阶段四 4A 的搭车点）——那是读接口，不算副作用。
 * 拆出来的理由：brain.mjs 职责过载（P3-16），这块边界清晰、依赖现成，改动面最小。
 * brain 仍转出口 contextText，外部（index / 测试）照旧从 brain 拿，不受影响。
 */
import * as llm from '../llm.mjs';
import * as memory from '../memory.mjs';
import * as mind from '../mind.mjs';
import * as sky from '../sky.mjs';
import * as owner from './owner.mjs';
import * as friends from '../friends.mjs';
import * as fav from '../fav.mjs';
import * as groups from '../group-names.mjs';
import * as lingo from '../lingo.mjs';
import * as meme from './meme.mjs';
import { tuning } from './tuning.mjs';
import { readConfig, readReview, readTasks, readPause, localDate } from '../store.mjs';

const hm = (ts) => new Date(ts).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false });

/** 今天她自己的经历（刷了什么、跟谁聊了），给她聊天时自然提起 */
function todayLife(today = localDate()) {
  return memory.memoryView(40).recent
    .filter((e) => localDate(new Date(e.ts)) === today && e.kind !== 'chat')
    .slice(0, 8).map((e) => `- ${hm(e.ts)} ${e.text}`).join('\n');
}

export async function contextText(message = '', qq = readConfig().qq.ownerQQ, peer = 'owner') {
  const m = mind.readMind();
  const pause = readPause();
  const pending = readReview().filter((r) => r.status === 'pending').length;
  const allTasks = readTasks();
  const busy = allTasks.filter((t) => t.report === 'qq' && (t.status === 'pending' || t.status === 'in_progress')).length;
  // 本会话点播失败、还静默着的视频：对方任何提及（链接/「看了吗」「怎么样」）就让她照实说进度
  const stalledHere = allTasks.filter((t) => (t.type === 'watch_video' || (t.type === 'job' && t.kind === 'watch'))
    && t.status === 'failed' && t.failedAt
    && t.progressReported !== true && !(t.reportPeers || [t.peer || 'owner']).every((p) => p !== peer)).slice(-3);
  const isOwner = String(qq) === String(readConfig().qq.ownerQQ);
  const isGroup = String(peer).startsWith('g:');
  // 别人说话时按对话钥匙翻记忆（2.8）：她自己的事（B站生活）照旧全局可见，本群/本私聊的日结和
  // 合成印象放行，号主的、别的对话的一律不进上下文（不然「老大」这类称呼会安到陌生人头上）
  // 阶段四 4A：热路径预取 query 向量（async 搭车点），拿到才启用语义召回；没配模型/接口挂了 → 不传，
  // recall 自动退回纯关键词。queryVec 只是排序输入，scope/dead 的可见性闸在 recall 里照旧先过。
  let queryVec;
  if (message && llm.embedReady()) {
    try { const v = await llm.embed([message]); if (v?.[0]) queryVec = v[0]; } catch { /* 静默退回关键词 */ }
  }
  const past = message ? memory.recallText(message, isOwner ? { k: 3, queryVec } : { k: 3, scope: [String(peer)], queryVec }) : '';
  // 群里带一份群友名录（谁是谁、聊过什么，免得张冠李戴）；私聊好友带他自己的档案；号主带他的事 + 朋友圈名录
  const who = isGroup
    ? (friends.rosterText(peer) || `## 这个群里的人\n（都还不熟，看 [名字] 分辨是谁在说话）`)
    : `${isOwner ? '## 关于号主（最熟的那个人）你知道的' : '## 现在跟你聊的这个人'}\n${isOwner ? owner.factsText() : friends.notesText(qq) || '（这不是号主。号主的私事你知道也别说出去；对方是谁你还不熟，聊着聊着就知道了）'}`;
  return [
    `## 此刻\n${await sky.skyText().catch(() => `现在是 ${new Date().getHours()} 点。`)}`,
    `## 你自己\n${mind.stateText(m)}`,
    `## 你今天自己的经历（刷 B站 这些是你自己的事，不是他的）\n${todayLife() || '（今天还没刷）'}`,
    past && `## 跟这句话有关、你想起来的\n${past}`,
    who,
    // 群名表只在号主面前展开（群友不该看到号主有哪些群、叫什么）。她说「发到 X 群」「转发到 X 群」时照这个认目标。
    isOwner && (() => {
      const gl = groups.listGroups().filter((g) => g.name);
      return gl.length ? `## 你知道的群（号主在面板填的名字，说「发到 X 群 / 转发到 X 群」就照这个认群号）
${gl.map((g) => `- ${g.peer} = ${g.name}`).join('\n')}` : '';
    })(),
    fav.favText(qq),
    // 号主在群里说话：HOW 那份是「直接跟号主私聊」的口吻，不点破会把「私聊发给我」当成就地发/字面调侃。
    // 悄悄告诉他这是号主本人（别在群里露称呼），他要说「私聊发给我/发我私聊」就是发到你们俩私聊窗口。
    isGroup && isOwner && `## 悄悄说一句\n现在在群里说话的这个是号主本人——别在群里喊破他的身份、也别用你们私聊才用的称呼。他要是说「私聊发给我 / 发我私聊 / 私聊里发句话」，是让你把东西发到你俩的私聊窗口（工具 target 填「私聊」），不是就地发在群里、更不是让他自己过来。`,
    !isGroup && isOwner && friends.friendsText(),
    !isGroup && isOwner && [pause && `- 他叫停了你${pause.reason ? `（${pause.reason}）` : ''}，后台的活都停着`, pending && `- 有 ${pending} 条待审等他点头`, busy && `- 后台还有 ${busy} 件他交代的活在做`].filter(Boolean).join('\n'),
    stalledHere.length && `## 你答应看却没看成的视频（对方要是提到，就照实说进度，别装没这回事）
${stalledHere.map((t) => `- ${t.payload?.bvid || ''} ${String(t.note || '').slice(0, 30)}：${String(t.resultNote || '还没看成').slice(0, 60)}`).join('\n')}
（对方问「看了吗/怎么样了」或又发了这条链接，就用你自己的话说明还没看成、原因是什么，说你记着、再发一次就重看；没提就别主动抖出来）`,
  ].filter(Boolean).join('\n\n');
}
