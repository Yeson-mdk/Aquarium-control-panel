/**
 * 她的工具箱：工具菜单（toolDefs）+ 执行分发（runTool）+ 表情包/歌曲/语音的辅助。
 * 从 brain.mjs 拆出来（2026-11-13）：brain 留打分闸和回复管线，这里管「她能做什么」。
 * 消费方：qq/index.mjs（经 brain 转出口）和 brain.reply 自己；外部引用一律走 brain.mjs 的转出口，别直接 import 这里。
 */
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import * as llm from '../llm.mjs';
import * as memory from '../memory.mjs';
import * as owner from './owner.mjs';
import * as meme from './meme.mjs';
import * as dsh from './dsh.mjs';
import { edgeTtsMp3 } from './etts.mjs';
import {
  ROOT, readConfig, readReview, readTasks, addTask, updateTask, readState, setPause, clearPause,
  localDate, logAction,
} from '../store.mjs';

const STICKERS = join(ROOT, 'stickers');
// 曲库：项目根 music/ 放成品音频（文件名就是歌名；同名有「xx_鱼版」的优先发——以后 RVC 换声的预制版就这么放）
const MUSIC_EXTS = /\.(mp3|wav|m4a|flac|ogg)$/i;
const musicDir = () => process.env.YANGYU_MUSIC || join(ROOT, 'music');
export function songList() {
  try { return readdirSync(musicDir()).filter((f) => MUSIC_EXTS.test(f)); } catch { return []; }
}
export function songNames(files = songList()) {
  return [...new Set(files.map((f) => f.replace(MUSIC_EXTS, '').replace(/_鱼版$/, '')))]; // 鱼版和原唱算一首
}

/** 歌名归一化：版本括号、空格、标点刨掉再比（「晴天（Live）」当「晴天」） */
const songCore = (s) => String(s || '').toLowerCase()
  .replace(/[（【(\[].*?[）\]）】]/g, '')
  .replace(/[\s·・'"'"'~～!！?？,，.。、_\-—《》]/g, '');
/** 他点的和曲库里的名字，归一化后谁包含谁就算命中 */
function songMatch(names, want) {
  const w = songCore(want);
  if (!w) return undefined;
  return names.find((n) => { const c = songCore(n); return c && (c.includes(w) || w.includes(c)); });
}
/** 唱哪个文件：有换声版优先换声版 */
function songFile(files, name) {
  return files.find((f) => f.startsWith(name + '_鱼版.')) || files.find((f) => f.replace(MUSIC_EXTS, '') === name);
}
/**
 * 点的歌名和曲库字面对不上时，让模型认一认是不是**同一个作品的另一个名字**（官方别名/译名/梗名改写，如「曼波的酒」=「朋友的酒」）。
 * 口径从严：同歌手的其他歌、翻唱、风格像都不算，拿不准就回无；答案去引号后必须和曲库名对得上才认——认错会把该学的歌岔过去唱旧的。
 */
async function aliasPick(want, names) {
  if (!want || want.length < 2 || !names.length) return '';
  try {
    const r = await llm.chatRaw([
      { role: 'user', content: `有人点歌：《${want}》\n会唱的歌：${names.join('、')}\n这里面有没有跟《${want}》是同一首歌、只是名字不同的（官方别名、译名、改名重发、梗名改写，比如「曼波的酒」就是「朋友的酒」）？\n注意：同一个歌手的其他歌、翻唱的版本、风格或主题像的，都不算。\n有就只回那首歌名；没有、或拿不准，就只回：无` },
    ], { maxTokens: 200, temperature: 0, tag: 'qq', essential: true }); // flash 前置消耗大，30 会整个回空串
    const a = String(r.content || '').trim();
    return names.find((n) => songCore(n) === songCore(a)) || '';
  } catch { return ''; }
}
export function songB64(file) {
  const buf = readFileSync(join(musicDir(), file));
  if (buf.length > 20 * 1024 * 1024) throw new Error('音频太大（超 20MB），发不动');
  return buf.toString('base64');
}
const VOICES = ['Meijia', 'Flo', 'Eddy'];
// 公共模式（好友/群）能用的工具：菜单（toolDefs 发哪些）和门禁（runTool 放哪些）都认这一份，别再各写各的
export const PUBLIC_TOOLS = ['send_sticker', 'send_selfie', 'save_sticker', 'send_voice', 'search_meme', 'recall_time', 'list_songs', 'sing_song', 'learn_song', 'send_text', 'set_appointment']; // recall_time 只翻当前对话自己的历史（群里的翻群、好友翻好友），不碰号主私聊；唱歌发的是曲库本地文件，不花钱；学歌就是下个 mp3 进曲库（有 200 首的上限兜底）——都放行。set_appointment 放行给群友，但 case 里限死只能约本群、@发起人本人（号主裁决 2026-11-18）
// 号主钦点的「被要自拍」糊弄图：代码随机抽一张，不让她自己挑（自己挑会有偏好，老是同一张）。
// 池子不写死名单：notes.json 里备注带了「send_selfie」的那几张就是糊弄图——加自拍=丢图+写备注，不用改代码
export const selfiePool = () => Object.entries(stickerNotes()).filter(([, w]) => w.includes('send_selfie')).map(([n]) => n);

// ─── 工具 ──────────────────────────────────────────────────
function stickerNames() {
  try { return readdirSync(STICKERS).filter((f) => /\.(png|jpe?g|gif)$/i.test(f)).map((f) => f.slice(0, f.lastIndexOf('.'))).sort(); } catch { return []; }
}
// 她自己存的表情包带的「场合备注」（存图时顺手写的什么时候用），挑表情包时看得见
const STICKER_NOTES = join(STICKERS, 'notes.json');
function stickerNotes() {
  try { const n = JSON.parse(readFileSync(STICKER_NOTES, 'utf-8')); const have = new Set(stickerNames()); return Object.fromEntries(Object.entries(n).filter(([k]) => have.has(k))); } catch { return {}; }
}

const fn = (name, description, properties = {}, required = []) => ({ type: 'function', function: { name, description, parameters: { type: 'object', properties, required } } });

export function toolDefs() {
  const names = stickerNames();
  return [
    fn('send_sticker', `发一张表情包（跟你的回复一起发）。你情绪外露的正经渠道就是它——想让动作被看见就发一张，别在文字里写动作括号。所有表情一视同仁，按当下场合挑最贴的一张（备注里写 send_selfie 的那几张只能走 send_selfie 随机，不许自己挑）：${Object.entries(stickerNotes()).map(([n, w]) => `${n}=${w}`).join(' · ')}${'\n'}号主说「把这张表情发到 X 群」时填 target，会专门发过去（面板能看到进度，发到那边直接看得到，不用你再报）：${Object.entries(stickerNotes()).map(([n, w]) => `${n}=${w}`).join(' · ')}`, { name: { type: 'string', enum: names, description: '表情包名' }, target: { type: 'string', description: '号主指定发到别的会话时填：群名、群号或「私聊」；就地发就不填' } }, ['name']),
    fn('send_selfie', '被要自拍、又想糊弄一下时调这个（随机甩一张糊弄图，不用也不许自己挑；不想发就别调，嘴硬混过去）。别用 send_sticker 发自拍类的图。号主私聊说「把自拍发到 X 群」才填 target 专门发过去；群里/别人要自拍不许填 target，就地糊弄或嘴硬——自拍只给号主一个人看', { target: { type: 'string', description: '只有号主在私聊指定发到别的会话时才填（群名/群号）；其他情况一律不填' } }),
    fn('save_sticker', '把你最近看过的那张图（3 分钟内，一般是对方刚发的）存成自己的表情包，存好以后 send_sticker 就能发（en_zh 命名）。只存表情包味的图，风景照、截图别存。备注必写：说不上来什么时候用，就说明这张不值得存', {
      en: { type: 'string', description: '一个英文小写词，比如 meng' }, zh: { type: 'string', description: '一两个中文字，比如 萌' },
      when: { type: 'string', description: '什么心情或场合用这张，一句话 20 字内。写宽一点，像「委屈想撒娇的时候」——别写成「只有被问到X才用」的窄触发，那样你日常永远轮不上它；以后你挑表情包看的就是它' },
    }, ['en', 'zh', 'when']),
    fn('send_voice', '发一条语音（跟你的回复一起发）。text 是要说的话，像说话，30 秒内，不要表情符号。语音本身就是那条消息：说了语音，回复文字里就别再把同样的话打一遍（写了也一样，程序只发语音）', {
      text: { type: 'string' }, voice: { type: 'string', enum: VOICES, description: '默认 Meijia，偏温柔' },
    }, ['text']),
    fn('remember', '记住一件关于号主的事（以后每次聊天都会带着）。一句话、第三人称', {
      text: { type: 'string' }, kind: { type: 'string', enum: owner.KINDS },
    }, ['text']),
    fn('fix_fact', '改正 / 删掉一条记错了的号主的事（id 是事实前面 # 后面那串）。text 留空就是删掉', { id: { type: 'string' }, text: { type: 'string' } }, ['id']),
    fn('recall', '翻翻自己的记忆：以前刷过的视频、跟谁聊过、以前跟号主聊过的话', { query: { type: 'string' } }, ['query']),
    fn('recall_time', '按时间段翻这个对话的聊天原文（直接去翻历史文件，不是翻记忆）。他问「中午/昨天/上周/周六/23点」聊了啥、上文里又翻不到时用这个。别自己凭印象答，翻完照实说', {
      period: { type: 'string', description: '时间段，原话照抄或转成「10月31日 23:05」这种。支持：刚才/昨天/前天/上周、周几（上周六）、几月几号、31号（不带月）、几点几分、23点之后，可组合' },
    }, ['period']),
    fn('bili_task', '把 B站 的泛活交给后台（泛泛刷视频、点赞收藏、评论、看新消息、写日记）。做完后台会在 QQ 里跟号主汇报。注意：号主发了具体视频链接让你看/总结时用 watch_video，别用这个——这个不认具体视频，会随手挑一个', {
      request: { type: 'string', description: '号主的原话' }, type: { type: 'string', enum: ['custom', 'check', 'diary'], description: 'check=看新评论私信，diary=写今天的日记，其他都是 custom' },
    }, ['request']),
    fn('list_songs', '看看自己曲库里都会唱什么歌。他问你会唱什么、没点具体歌时用这个；点了具体歌名就直接 sing_song，别用这个'),
    fn('sing_song', '他让你唱某首歌时必调这个（唱/来一首/唱一下都算点歌）。你会什么以曲库为准、你自己的印象不可信——先查再说，查了不会的连着 SqMusic 会直接转去学。音频先发出去、你再回话，所以用唱完了的语气就对。号主说「去 X 群唱首歌」填 target 专门发过去；群里别人点歌就发在群里（填「这里」或不填），音乐谁点都能发', { song_name: { type: 'string' }, target: { type: 'string', description: '号主指定发到别的会话时填群名/群号/「私聊」；群里别人点歌填「这里」或不填就发现在这个群' } }, ['song_name']),
    fn('learn_song', '去把一首还不会的歌学下来（SqMusic 下载，后台去做，下完你自己会来说）。他非要点你不会的歌、又连着 SqMusic 时用这个', { song_name: { type: 'string' } }, ['song_name']),
    fn('bili_tasks', '看看交给后台的活做到哪了'),
    fn('pause', '号主要你先停（打游戏、开会）：后台不刷、不回评论、不主动找他', { reason: { type: 'string' }, hours: { type: 'number', description: '他说了多久就填，没说就不填' } }),
    fn('resume', '号主说好了，接着过自己的日子'),
    fn('research', '联网查资料（交给 DSH 去搜、去看网页），查到了会让你自己告诉号主。要等十几秒到一两分钟', {
      question: { type: 'string', description: '要查的问题，写清楚，带上时间地点这些' },
    }, ['question']),
    fn('search_meme', '查网络梗、流行语、缩写、黑话是什么意思、怎么接（cnmeme.wiki 梗百科，查不到用本地词库兜底）。梗图上的词一律先查再接，聊天里没把握的词也查，别硬猜；查到优先照「怎么用」接梗，别当词典念；查不到就说不知道，别编', {
      query: { type: 'string', description: '要查的词，尽量短（8 字内），比如「大水理论」' },
    }, ['query']),
    fn('learn_slang', '号主教了你一个词（黑话 / 梗 / 绰号），记进小词库，以后查得到', {
      name: { type: 'string', description: '那个词，2-16 个字' },
      meaning: { type: 'string', description: '什么意思，一句话' },
    }, ['name', 'meaning']),
    fn('make_sticker', '给自己做一张新表情包：拿一张现有的当底图，只改表情和动作。一天最多一张，做好了会自己发给号主', {
      en: { type: 'string', description: '一个英文小写词，比如 yawn' }, zh: { type: 'string', description: '一两个中文字，比如 打哈欠' },
      look: { type: 'string', description: '想要的样子，比如「捂着嘴打哈欠，眼角有泪花」' },
      look_en: { type: 'string', description: '同样的意思用英文写一遍（生图模型对英文更准），比如 yawning with a hand over mouth, teary eyes' },
      when: { type: 'string', description: '什么心情或场合用这张，写宽点（像「困了想撒娇的时候」），别写成只有特定情况才用的窄触发' },
      base: { type: 'string', enum: stickerNames(), description: '拿哪张当底图，默认 happy_开心' },
    }, ['en', 'zh', 'look']),
    fn('reviews', '看看有哪些等号主点头的待审（日记、评论、回复）'),
    fn('review_decide', '处理一条待审', {
      id: { type: 'string', description: '待审 id 的前 6 位' }, action: { type: 'string', enum: ['approve', 'reject'] }, text: { type: 'string', description: '号主要改成的内容，不改就不填' },
    }, ['id', 'action']),
    fn('set_appointment', '有人让你到点提醒/叫他/催他时调这个（明早8点叫我、工作日11点催睡觉、每天8点叫我、后面三天早上9点@我一下之类）。到点她会主动开口说一句。号主能约到任意会话；群友只能约在自己那个群、到点@约的人本人。时间算成 ISO 字符串', {
      dueAt: { type: 'string', description: '到点时间，ISO 字符串如 2026-11-18T08:00:00；重复的话填最近的那个未来时刻（第一次）' },
      text: { type: 'string', description: '对方原话或提醒内容，比如「明早8点叫我起床」' },
      repeat: { type: 'string', enum: ['once', 'daily'], description: '说「每天/天天/每天几点」或「连着N天/后面N天」都填 daily；「明天/今晚」填 once。不填默认 once' },
      days: { type: 'integer', description: '连着叫几天（按自然日，说了才算，如「后面三天」填 3、「连着一周」填 7，最多 30）。只在 repeat=daily 时填；只说「每天」没说天数就不填' },
      target: { type: 'string', description: '号主说「去X群提醒我/在私聊叫我」才填群名或「私聊」；群友不填（只能约在本群）。本会话提醒就不填' },
    }, ['dueAt', 'text']),
    fn('watch_video', '号主发了 B站 链接（b23.tv 短链或 bilibili.com 长链都行）让你「看看/总结下/讲讲这个视频」时用这个——只有号主能用。她会锁定这条、认真看完，再用自己的话回一条总结。短链直接把整条链接填进来，不用你提 BV 号', {
      url: { type: 'string', description: '号主发的 B站 链接原样填，b23.tv/… 或 bilibili.com/video/BV… 都行；也可能是裸 BV 号' },
      request: { type: 'string', description: '号主要你看完做什么，比如「总结下讲了啥」「看看是不是真的」「讲讲讲了什么」；原话照抄' },
      dueAt: { type: 'string', description: '号主说了具体时间才填（「十分钟后看」「晚上8点看」），ISO 字符串；没说时间就别填——立刻就去看' },
    }, ['url', 'request']),
    fn('send_report', '号主让你把「刚才那条总结 / 刚看完的视频总结」转发到某个会话时用这个（「把总结发到X群」「转到群里给大家看」「发一份到XX群」）。只有号主能用。默认取最近一条你写完的视频总结原文发过去；号主另给了话就用 text。target 填群名、群号或「私聊」，不填就发回当前会话', {
      target: { type: 'string', description: '发到哪：群名（如「鲸鲸群」）、群号（如「1124893144」）或「私聊」。不填就发回当前会话' },
      text: { type: 'string', description: '号主另指定了要发的话才填；不填就自动取最近一条你看完视频写的总结原文' },
    }),
    fn('send_text', '有人让你「私聊发句话 / 把这句话发到 X 群 / 发到私聊 / 跟他说一声」，或号主在群里说「私聊发给我」却没指定发啥时先问「发啥呀」——真要发话时用这个把一句话发到指定会话。号主能发到任意会话；别人只能用这个发到自己私聊（target 填「私聊」）。会建任务、面板看得到、发好自己说一声，别嘴上答应不发', {
      text: { type: 'string', description: '要发出去的那句话，照对方要说的写' },
      target: { type: 'string', description: '发到哪：「私聊」＝发给说话人本人的私聊（号主在群里说私聊发给我就填这个）、群名、群号。不填就发回当前会话' },
    }, ['text']),
    fn('schedule_task', '号主让你「过一会儿/某个点去做件事」时调这个（几分钟后交后台干活、到点去把某视频看了）。只有号主能用。时间算成 ISO 字符串。注意：号主发链接让你看/总结视频优先用 watch_video，它自己会解析链接、也能定时', {
      kind: { type: 'string', enum: ['watch', 'task'], description: 'watch=看号主发的B站视频（填 bvid）；task=交后台干活（填 taskNote）' },
      dueAt: { type: 'string', description: '到点时间，ISO 字符串如 2026-11-18T20:00:00；号主说「现在/马上」就填当前时间往后一两分钟' },
      bvid: { type: 'string', description: 'kind=watch 时填，B站视频的 BV 号（如 BV1xx411c7mD），从号主发的链接里取' },
      taskNote: { type: 'string', description: 'kind=task 时填，要干的活在句话，比如「去特别关注那儿看看新动态」' },
      text: { type: 'string', description: '号主的原话或任务说明，留在赴约上下文里' },
    }, ['kind', 'dueAt', 'text']),
  ];
}

/**
 * 跨会话发媒体（表情包/自拍/歌）：建 send_media 后台任务，面板可见、发完汇报。
 * 裁决：号主说发到 X 群就真发；群友索要音乐可发（群里点歌发现群、说「私聊发给我」发他本人）；
 *       自拍只给号主——群友/群里要自拍一律就地糊弄或嘴硬，不建跨会话任务、不发私聊。
 * @returns 给模型的话术（tool result）
 */
async function queueMedia(kind, targetText, media, out) {
  const isOwner = !!(out && out.isOwner);
  const source = (out && out.peerKey) || 'owner'; // 群友的来源会话是 g:xxx（权限判断要用真来源），别写成 owner
  const speakerQq = out && out.speakerQq;

  // 自拍：非号主一律不许跨会话（人设：自拍只给号主一个人看）
  if (kind === 'selfie' && !isOwner) return null; // 交回调用方就地糊弄

  // 解析目标会话。话/表情包/歌要发给「私聊」时，群里按发言者 QQ 定位他本人（号主私聊那条 speakerQq 是 owner QQ）
  const { resolveTarget, checkPermission } = await import('./appoint.mjs');
  let resolved;
  const t = String(targetText || '').trim();
  if (/^(私聊|我|私聊我|发给我|私聊发给我|发我私聊)$/.test(t)) {
    // 号主说「私聊」= 你们的私聊窗口 owner（不管他此刻在群里还是私聊里）；群友说「私聊」= 发回他本人 p:QQ
    resolved = speakerQq ? { peer: isOwner ? 'owner' : 'p:' + speakerQq } : { error: '没认出你的 QQ，说清楚发给谁' };
  } else {
    resolved = await resolveTarget(targetText, { isOwner, sourcePeer: source });
  }
  if (resolved?.error) return resolved.error;
  let targetPeer = resolved?.peer || source;
  // 非号主只能发到自己私聊：群友不许把话/表情包发到别的会话，撞了就按就地处理（返回 null 交回调用方）
  if (!isOwner && source.startsWith('g:') && targetPeer !== 'p:' + speakerQq) return null;
  const perm = checkPermission({ isOwner, sourcePeer: source, targetPeer });
  if (!perm.ok) return perm.error;

  const label = kind === 'song' ? `歌《${media.songName || ''}》` : kind === 'selfie' ? '自拍' : kind === 'text' ? '话' : '表情包';

  // 私聊里让人发到群里：群里的人得知道是谁叫发的，不然平白冒出一句/一首歌很突兀。
  // 只标「谁让我发的」，不带号主身份称呼（群里不喊破）。
  let attribution = '';
  if (!String(source).startsWith('g:') && String(targetPeer).startsWith('g:')) {
    const who = String(out?.name || '').trim() || (isOwner ? '号主' : '有人');
    attribution = `${who}让我发的`;
  }

  // 去重：号主催一句「发送了吗/没看到」就再派一遍，会连着建好几条同样的发送任务。
  // 同一发起人 + 同一目标 + 同一种媒体（歌按歌名、图按图名）+ 10 分钟内，还活着（pending/in_progress）就拦；
  // failed/done 放行（没发成的要能重发，发过的再派也重发一次——跟点播视频去重口径区分开）。
  const now = Date.now();
  // 注意：调用方传进来的 media 没有 kind 字段（kind 是单独的参数），指纹必须按外层 kind 算，
  // 别用 p.kind——否则新活的指纹恒为 undefined，去重永远不命中（2026-11-18 踩过）
  const fingerprint = (p) => kind === 'song' ? p.songName : kind === 'sticker' || kind === 'selfie' ? p.stickerName : p.text;
  const recent = readTasks().find((t) =>
    t.type === 'send_media' && (t.status === 'pending' || t.status === 'in_progress') &&
    t.sourcePeer === source && t.payload?.targetPeer === targetPeer &&
    t.payload?.kind === kind && fingerprint(t.payload) === fingerprint(media) &&
    Date.parse(t.ts) > now - 10 * 60_000,
  );
  if (recent) return `刚才那条${label}已经在往 ${targetPeer} 送了，等着就行，别重复递`;

  const task = addTask({
    type: 'send_media', executor: 'panel', source: 'bot', report: 'qq',
    note: `把${label}发到 ${targetPeer}`,
    peer: source, sourcePeer: source, reportPeers: [source],
    payload: { ...media, kind, targetPeer, ...(attribution ? { attribution } : {}) },
  });
  // 关键：建完必须立刻跑，否则 executor='panel' 的任务没人认领，永远停在 pending
  // （2026-11-18 发歌那次：面板三条「派任务」都不动，就是漏了这一句）
  const auto = await import('../autopilot.mjs');
  auto.runTask(task).catch((e) => updateTask(task.id, { status: 'failed', resultNote: e.message }));
  out.task = task.id;
  return `记下了，这就把${label}发到 ${targetPeer}；这条应一句就行，别提前说发好了——发到那边你直接看得到，我不来回汇报了`;
}

/**
 * 看号主指定的一个视频：解析 b23.tv 短链 → 去重 → 定时或立刻建任务。
 * 走 watchAndSummarize 安静链路（不等 live.running 那把日常排班的锁），所以日常正在看视频也挡不住它。
 * watch_video 工具和 bili_task 里带链接的情况共用这一份。
 */
async function queueWatchVideo(input, out) {
  const bili = await import('../bili.mjs');
  const bvid = await bili.resolveBv(input.url || input.bvid || '');
  if (!bvid) return '这条链接里没认出视频号，让它把 B站 链接重新发一遍（b23.tv 的短链也行）';
  const request = String(input.request || '').trim().slice(0, 200);

  // 去重按会话隔离：同一会话 30 分钟内同一 bvid 才拦，防号主催一句就多建一条、连环汇报；
  // 不同会话各算各的：群里和私聊派同一条都各自建任务、各自收到总结（观看过程在下面复用，不真看两遍）。
  // failed 的旧任务放行重建（裁决：失败不算结果，第二个会话来派就重看一次）。
  const DUP_MS = 30 * 60_000;
  const peer = (out && out.isOwner && out.peerKey) || 'owner';
  const isWatchTask = (t) => t.type === 'watch_video' || (t.type === 'job' && t.kind === 'watch');
  const sameVideo = (t) => (t.payload?.bvid || t.jobPayload?.bvid) === bvid && Date.parse(t.ts) > Date.now() - DUP_MS && t.status !== 'cancelled';
  const inThisPeer = (t) => (t.reportPeers || [t.peer || t.sourcePeer || 'owner']).includes(peer);
  const recent = readTasks().find((t) => isWatchTask(t) && sameVideo(t) && t.status !== 'failed' && inThisPeer(t));
  if (recent) return '这条我正在看着呢，看完会用我自己的话跟你说，别急、不用再交代一遍';

  // 观看过程复用：别的会话 30 分钟内已经看过同一 bvid 且有总结 → 只用它的结果，给当前会话补发一条，不真看第二遍。
  // 已完成的才算（failed/in_progress 不算，失败要让新会话重看、在看的让它自己看完）。
  const doneSame = readTasks().find((t) => isWatchTask(t) && sameVideo(t) && t.status === 'done' && t.resultNote);
  if (doneSame) {
    const notify = await import('../notify.mjs');
    await notify.reportResultToPeers({ ...doneSame, note: doneSame.originText || doneSame.note },
      { ok: true, note: doneSame.resultNote, watched: doneSame.watched || [] }, [peer]).catch(() => {});
    // 记一笔：这条会话也收到了结果，后续同会话再派不再重复补发
    updateTask(doneSame.id, { reportPeers: [...new Set([...(doneSame.reportPeers || [doneSame.peer || 'owner']), peer])] });
    return '这条我刚看过，总结我发你这儿了，不用再等；应一声就行';
  }

  const { addJob } = await import('./appoint.mjs');
  const dueAt = input.dueAt ? Date.parse(input.dueAt) : 0;
  if (Number.isFinite(dueAt) && dueAt > Date.now() + 60_000) {
    addJob({
      at: dueAt, kind: 'watch', peer, sourcePeer: peer, originText: request || bvid,
      who: (out && out.isOwner && out.name) || '号主',
      payload: { bvid, title: bvid, request },
      reportPeers: [peer],
      note: `定时看视频：${bvid}`,
    });
    return `记下了，${new Date(dueAt).toLocaleString('zh-CN')}把这条看了，看完跟你说；应一声就行`;
  }

  const task = addTask({
    type: 'watch_video', note: request || `看《${bvid}》`, payload: { bvid, request },
    executor: 'panel', source: 'bot', report: 'qq',
    peer, sourcePeer: peer, reportPeers: [peer],
  });
  const auto = await import('../autopilot.mjs');
  auto.runTask(task).catch((e) => updateTask(task.id, { status: 'failed', resultNote: e.message }));
  out.task = task.id;
  return '交给我了，我锁定这条认真看，看完用我自己的话跟你说讲了啥；应一声就行';
}

/** 执行一个工具调用；返回给模型看的结果（字符串），顺便把要发的东西塞进 out */
export async function runTool(name, args, out) {
  // 号主在群里说话也算号主（isOwner=true）：放行号主专属工具（约定赴约要能记成发回这个群）。
  // 别人在群里/私聊一律只放 PUBLIC_TOOLS：发/存表情包、语音、查梗，花钱的和动号主数据的都不放。
  if (out && !out.isOwner && out.peerKey && out.peerKey !== 'owner' && !PUBLIC_TOOLS.includes(name)) return '这个只有号主能用';
  const a = args || {};
  switch (name) {
    case 'send_sticker': {
      if (!stickerNames().includes(a.name)) return `没有「${a.name}」这张`;
      if (selfiePool().includes(a.name)) return '这张是糊弄图专用，想发它就调 send_selfie（随机抽的，不许自己挑）'; // 硬闸：提示词那句「不许自己挑」模型会忘，闸不能忘
      if (a.target) {
        const r = await queueMedia('sticker', a.target, { stickerName: a.name }, out);
        if (r !== null) return r;
      }
      if (out.sticker) return '这次已经有一张了，一次最多一张';
      out.sticker = a.name;
      return '好，会跟回复一起发';
    }
    case 'send_selfie': {
      if (out.sticker) return '这次已经有一张了，一次最多一张';
      const pool = selfiePool(); // 备注写了 send_selfie 的那几张（stickerNotes 已按现存文件过滤，没存上的自动跳过）
      if (!pool.length) {
        // 空池不留痕的话她只会现场嘴硬编借口（2026-11-13「image 又没折腾出来」），谁也不知道池子空了
        try { logAction({ kind: 'qq', source: 'bot', ok: false, detail: '🤳 有人要自拍，但糊弄池是空的：notes.json 里没有「文件存在 + 备注 带 send_selfie」的图——去面板表情包页检查图在不在、自拍池勾了没' }); } catch { /* 日志不挡正事 */ }
        return '糊弄图还没存上，嘴硬混过去吧';
      }
      const pick = pool[Math.floor(Math.random() * pool.length)]; // 随机抽，她挑的算
      if (a.target) {
        const r = await queueMedia('selfie', a.target, { stickerName: pick }, out);
        if (r !== null) return r; // 号主跨会话：已建任务；null=群友要自拍，落回就地糊弄
      }
      out.sticker = pick;
      return `好，随机发这张糊弄：${out.sticker}`;
    }
    case 'save_sticker': {
      const buf = (out.imgs || []).at(-1); // 最近看过的最后一张（本批带的图优先，没有就用 3 分钟内看过的）
      if (!buf) return '这条消息里没图（或者没下载下来），存不了';
      const when = String(a.when || '').trim().slice(0, 20);
      if (!when) return '什么时候用都说不上来（when），这张就先别存啦'; // 没备注的图她挑表情包时看不见，等于白存
      if (stickerNames().length >= 60) return '表情包够多了，先不存啦';
      const hash = createHash('sha1').update(buf).digest('hex');
      try {
        for (const f of readdirSync(STICKERS)) {
          if (createHash('sha1').update(readFileSync(join(STICKERS, f))).digest('hex') === hash) return `这张早就存过啦：${f.slice(0, f.lastIndexOf('.'))}`;
        }
      } catch { /* 目录读不了就跳过查重 */ }
      const en = String(a.en || '').toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 16) || 'sticker';
      const zh = String(a.zh || '').replace(/[/\\:*?"<>|\s]/g, '').slice(0, 4) || '表情';
      const ext = (buf[0] === 0x89 && buf[1] === 0x50) ? 'png' : (buf[0] === 0xff && buf[1] === 0xd8) ? 'jpg' : (buf[0] === 0x47 && buf[1] === 0x49) ? 'gif' : 'png';
      let name = `${en}_${zh}`;
      if (stickerNames().includes(name)) name = `${en}_${zh}_${Date.now() % 1000}`; // 重名就带个尾号
      writeFileSync(join(STICKERS, `${name}.${ext}`), buf);
      // 场合备注：写的时候读原始文件（不过滤），不然图还没传齐的机器上一轮就把别的图的备注吞了
      let nt = {};
      try { nt = JSON.parse(readFileSync(STICKER_NOTES, 'utf-8')) || {}; } catch { /* 没有就新建 */ }
      nt[name] = when; // 发的时候带着
      writeFileSync(STICKER_NOTES, JSON.stringify(nt, null, 2));
      dsh.addIndexRow(`| \`${name}.${ext}\` | ${zh} | ${String(when).replace(/\|/g, '／').slice(0, 40)} |`, join(STICKERS, 'INDEX.md')); // INDEX.md 表格也跟上：save/make 两条链路都两边写
      return `存好了：${name}（以后 send_sticker 用这个名字发）`;
    }
    case 'send_voice': {
      const text = String(a.text || '').replace(/[*_#`]/g, '').trim().slice(0, 140);
      if (!text) return '没有要说的话';
      out.voice = { text, voice: VOICES.includes(a.voice) ? a.voice : 'Meijia' };
      return '好，会跟回复一起发';
    }
    case 'list_songs': {
      const names = songNames();
      if (!names.length) return '你翻了一圈曲库，一首歌都没有。怎么跟他说都行——嘴硬（「鱼只能吐泡泡，唱什么歌」）、坦白还没学过、顺势让他给你投喂歌，挑你当时想当的那个你，一两句就够，别像系统报错。';
      return `你查了曲库，会唱这些：${names.join('、')}。\n像聊天里随口带出来（一两句就够），别摆成清单；想让他挑就随口问一句，别催。`;
    }
    case 'sing_song': {
      const want = String(a.song_name || '').trim();
      const files = songList();
      const names = songNames(files);
      let hit = songMatch(names, want);
      if (!hit && want) hit = await aliasPick(want, names); // 字面对不上，让模型认认是不是同一首歌的别名（口径从严，认不出就当真不会）
      if (!hit) {
        // 点不中但 SqMusic 连着：不报歌单，直接转成去学（下完她自己来说）。没连着才退回报菜名那套。
        if (want && String(readConfig().qq?.sqMusicUrl || '').trim() && files.length < 200) {
          // 号主指定了发到别的会话：记下目标 peer，学完直接唱到那边（面板也能看到进度）
          let learnTarget = '';
          if (a.target && !/^(这里|这儿|本群|就地)$/.test(String(a.target).trim())) {
            const { resolveTarget, checkPermission } = await import('./appoint.mjs');
            const isOwner = !!(out && out.isOwner);
            const source = (isOwner && out.peerKey) || 'owner';
            const resolved = await resolveTarget(a.target, { isOwner, sourcePeer: source });
            if (!resolved?.error && checkPermission({ isOwner, sourcePeer: source, targetPeer: resolved.peer }).ok) learnTarget = resolved.peer;
          }
          out.learnTask = { song: want, at: Date.now(), targetPeer: learnTarget };
          return `曲库里没有《${want}》，你顺手就去学了（后台在下，下完直接唱给${learnTarget ? '那边' : '他'}）。\n应一声就够，怎么应随你，别每次一个腔调。学完会自己开口，现在别说满话，也别把会唱的都报出来。`;
        }
        return `曲库里没有《${want || '这首歌'}》。你会唱的（这份名单心里有数就行，别报出来）：${names.join('、') || '现在还什么都不会'}。\n怎么回都行：没听过这歌就好奇问一句是什么，听过的就遗憾一下或者嘴硬，别每次都嘲讽；想换一首就随口提一个，别摆清单。他要是非听不可：能调 learn_song 就顺手去学（下完自己会说），学不了就让他把音频文件丢进你服务器的 music 文件夹。`;
      }
      const file = songFile(files, hit); // 有换声版优先唱换声版
      if (a.target && !/^(这里|这儿|本群|就地)$/.test(String(a.target).trim())) {
        const r = await queueMedia('song', a.target, { songFile: file, songName: hit }, out);
        if (r !== null) return r;
      }
      out.singingTask = { song: hit, file };
      return `《${hit}》找到了，音频会先发出去，等歌到了你再说这句——所以用唱完了的语气就对，别说「这就去唱」。\n回一句短短的、你自己的小反应就行——小得意、假装勉强，两个字带过都可以，别每次一个腔调；偶尔磨蹭一句（「就一遍啊，听完要说好听」）也挺像你，但别回回磨蹭。别说「跑调」「破音」——发出去的是学来的原曲，质量没得挑。`;
    }
    case 'learn_song': {
      const want = String(a.song_name || '').trim();
      const files = songList();
      const names = songNames(files);
      const hit = songMatch(names, want);
      if (hit) return `《${hit}》你早就会了，直接调 sing_song 唱就行。`;
      const alias = await aliasPick(want, names); // 学之前先认认：是不是已会歌曲的别名（口径从严），别学重了
      if (alias) {
        out.singingTask = { song: alias, file: songFile(files, alias) };
        return `你认出来了：《${want}》其实就是你会的《${alias}》，直接唱这首就行。`;
      }
      if (!String(readConfig().qq?.sqMusicUrl || '').trim()) return 'SqMusic 还没连上（面板里没填地址），学不了新歌。跟他说还不会这首就行——想学让他把音频丢 music 文件夹，别装会。';
      if (files.length >= 200) return '曲库塞满 200 首了，先不学。跟他说一声，想学新的就先删两首旧的。';
      if (!want) return '没说要学哪首，先问清楚歌名。';
      out.learnTask = { song: want, at: Date.now() };
      return `《${want}》你去学了（后台在下，下完直接唱给他）。\n应一声就够，怎么应随你——应下来、小期待、嘟囔一声都行，别每次一个腔调。下载要一会儿，学完会自己开口，现在别说满话。`;
    }
    case 'remember': {
      const f = owner.addFact({ text: a.text, kind: a.kind });
      return f ? (f.existed ? `本来就记着：${f.text}` : `记下了（#${f.id}）`) : '这条不记';
    }
    case 'fix_fact': {
      const f = owner.updateFact(a.id, a.text || '');
      return f ? (f.removed ? '删掉了' : `改好了：${f.text}`) : '没找到这条';
    }
    case 'recall': {
      const q = String(a.query || '');
      const mine = memory.recall(q, { keys: [`up:${q}`, q], k: 5 }).map(memory.recallLine);
      // 聊天原文按「相关度 × 新鲜度」排——上周聊的和俩月前聊的，先想起上周的，越久远越沉底（模拟遗忘）
      const nowMs = Date.now();
      const said = owner.readChat().filter((e) => e.text && e.kind !== 'reset' && owner.overlap(e.text, q) > 0.3)
        .map((e) => {
          const age = nowMs - Date.parse(e.ts);
          const fresh = age > 20 * 86400_000 ? 0.1 : age > 10 * 86400_000 ? 0.3 : age > 5 * 86400_000 ? 0.6 : 1;
          return { e, s: owner.overlap(e.text, q) * fresh };
        })
        .sort((x, y) => y.s - x.s).slice(0, 5)
        .map(({ e }) => `- ${memory.ago(e.ts)}${e.from === 'owner' ? '他说' : '我说'}：${e.text.slice(0, 80)}`);
      return [...mine, ...said].join('\n') || `想不起来跟「${q}」有关的事`;
    }
    case 'recall_time': {
      // 按时间段捞原文：上下文窗口有限，「昨天中午聊了啥」这种可能已被挤出窗口，得真去翻当前对话的历史文件。
      // 人问时间就那几种说法，都得接得住：昨天/前天/上周、周几（上周六）、具体日期（10月31日）、几点几分（23:05）。
      const period = String(a.period || '');
      const peer = (out && out.peerKey) || 'owner';
      const now = new Date();
      const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
      const DAY = 86400_000;
      // 先定哪一天：具体日期 ＞ 周几（可叠「上周」再退一周）＞ 昨天/前天；都没提就今天
      let day = null;
      const md = period.match(/(\d{1,2})\s*[月.\-/]\s*(\d{1,2})/);
      if (md && Number(md[1]) >= 1 && Number(md[1]) <= 12 && Number(md[2]) >= 1 && Number(md[2]) <= 31) {
        const y = Number(md[1]) - 1, d2 = Number(md[2]);
        day = new Date(now.getFullYear(), y, d2).getTime();
        if (day > todayStart) day = new Date(now.getFullYear() - 1, y, d2).getTime(); // 问「1月2号」这种还没到的＝去年的
      }
      if (day === null) {
        const bd = period.match(/(?:^|[^\d月])(\d{1,2})\s*[号日]/); // 「31号」「31日」不带月份：就近取过去那个月的这一天（本月没有 31 号会自动滚到上月）
        if (bd && Number(bd[1]) >= 1 && Number(bd[1]) <= 31) {
          day = new Date(now.getFullYear(), now.getMonth(), Number(bd[1])).getTime();
          if (day > todayStart) day = new Date(now.getFullYear(), now.getMonth() - 1, Number(bd[1])).getTime();
        }
      }
      if (day === null) {
        const wd = period.match(/周([一二三四五六日天])/);
        if (wd) {
          const w = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 日: 0, 天: 0 }[wd[1]];
          day = todayStart - (((now.getDay() - w + 7) % 7) + (/上周/.test(period) ? 7 : 0)) * DAY;
        } else if (/前天/.test(period)) day = todayStart - 2 * DAY;
        else if (/昨天/.test(period)) day = todayStart - DAY;
      }
      let startMs, endMs;
      if (!day && /刚才|刚刚/.test(period)) {
        startMs = now.getTime() - 2 * 3600_000; endMs = now.getTime();
      } else if (!day && /上周/.test(period)) {
        startMs = todayStart - 14 * DAY; endMs = todayStart - 7 * DAY;
      } else {
        const base = day ?? todayStart;
        // 再定几点：明确的钟点优先（「晚上11点」换算成 23 点），到分钟给前后 35 分钟，只到点给这一个小时；没有才落到上午/中午大档，再没有全天
        const tm = period.match(/(\d{1,2})\s*[:：]\s*(\d{1,2})/) || period.match(/(\d{1,2})\s*点\s*(\d{1,2})\s*分?/) || period.match(/(\d{1,2})\s*点/);
        if (tm) {
          let h = Number(tm[1]);
          if (/下午|傍晚|晚上|夜里/.test(period) && h >= 1 && h <= 11) h += 12;
          const t = base + h * 3600_000 + (tm[2] !== undefined ? Number(tm[2]) * 60_000 : 0);
          if (/之后|以后|往后/.test(period)) { startMs = t; endMs = base + 24 * 3600_000; } // 「23点之后」＝从那点翻到当天结束
          else if (tm[2] !== undefined) { startMs = t - 35 * 60_000; endMs = t + 35 * 60_000; }
          else { startMs = t; endMs = t + 3600_000; }
        } else {
          const h = /早上|早晨|上午/.test(period) ? [5, 11] : /中午/.test(period) ? [11, 14] : /下午|傍晚/.test(period) ? [14, 18] : /晚上|夜里/.test(period) ? [18, 24] : [0, 24];
          startMs = base + h[0] * 3600_000; endMs = base + h[1] * 3600_000;
        }
      }
      // 返回里带上实际翻的时间段：她嘴上说的和真翻的要对得上账，也免得把日子翻错了还理直气壮
      const fmt = (ms) => { const d = new Date(ms); return `${d.getMonth() + 1}月${d.getDate()}日 ${d.getHours()}:${String(d.getMinutes()).padStart(2, '0')}`; };
      const rangeStr = `${fmt(startMs)} 到 ${fmt(endMs)}`;
      const chunk = owner.readChat(peer).filter((e) => e.kind !== 'reset' && e.text && Date.parse(e.ts) >= startMs && Date.parse(e.ts) <= endMs);
      try { logAction({ kind: 'qq', source: 'bot', ok: true, detail: `recall_time「${period}」→ 实际翻 ${rangeStr}，翻到 ${chunk.length} 条` }); } catch { /* 日志不挡正事 */ }
      if (!chunk.length) return `翻了一圈，实际翻的是 ${rangeStr}，这个对话里没聊过什么（没落下记录）`;
      return `【${period || '那段时间'}的聊天原文（实际翻的是 ${rangeStr}）】：\n` + chunk.slice(-20).map((e) => {
        const d = new Date(e.ts);
        return `[${d.getMonth() + 1}月${d.getDate()}日 ${d.getHours()}:${String(d.getMinutes()).padStart(2, '0')}] ${e.from === 'owner' ? '他' : '我'}：${e.text.slice(0, 120)}`;
      }).join('\n');
    }
    case 'search_meme': {
      const q = cleanMemeQuery(a.query);
      if (!q) return '要查的词是空的';
      try {
        const r = await meme.lookup(q);
        // 记一笔进活动记录：号主看得见她查没查、走的是在线还是本地兜底（NAS 连不上 cnmeme.wiki 时这里会一直显示「本地词库兜底」）
        const via = r.startsWith('【群内黑话】') ? '群内黑话' : r.includes('没有收录') ? '没收录' : r.includes('（本地词库）') ? '本地词库兜底' : '在线查到';
        try { logAction({ kind: 'qq', source: 'bot', detail: `📖 梗百科「${q.slice(0, 16)}」：${via}` }); } catch { /* 日志不挡正事 */ }
        return r;
      } catch (e) { console.error('[meme] 查询', e.message); return '梗词库暂时查不了，先按字面理解或说不知道'; }
    }
    case 'learn_slang': {
      const r = meme.addTerm(a.name, a.meaning, '号主');
      return r.ok ? `记下了「${String(a.name || '').trim()}」，以后查得到` : r.msg;
    }
    case 'bili_task': {
      if (readState().cooldownUntil > Date.now()) return '风控冷却中，B站 现在先别碰，跟他说一声晚点再去';
      // 带 B站 链接 / BV 号的「看这个视频、总结下」意图：转专用安静链路，锁定这条、不等日常排班的锁。
      // 之前它走 custom → runSession → while(live.running)，日常正在看视频时就一直卡着看不了。
      const reqText = String(a.request || '');
      const bili = await import('../bili.mjs');
      const linkBv = await bili.resolveBv(reqText);
      if (linkBv && out?.isOwner !== false) {
        return queueWatchVideo({ url: linkBv, request: reqText }, out);
      }
      const auto = await import('../autopilot.mjs');
      const type = ['check', 'diary'].includes(a.type) ? a.type : 'custom';
      const task = addTask({ type, note: reqText.slice(0, 200), executor: 'panel', source: 'bot', report: 'qq' });
      auto.runTask(task).catch((e) => updateTask(task.id, { status: 'failed', resultNote: e.message }));
      out.task = task.id;
      return '交给后台了，做完会自己跟他说；你这条回复应一声就行';
    }
    case 'bili_tasks': {
      const mine = readTasks().filter((t) => t.report === 'qq').slice(0, 5);
      const S = { pending: '排队', in_progress: '在做', done: '做完了', failed: '没做成', cancelled: '取消了' };
      return mine.map((t) => `[${S[t.status] || t.status}] ${t.note}${t.resultNote ? ` → ${t.resultNote}` : ''}`).join('\n') || '后台没有他交代的活';
    }
    case 'pause': {
      const p = setPause({ reason: a.reason || '', hours: a.hours, source: 'bot' });
      return `停了${p.untilResume ? '，等他说好了' : `，到 ${new Date(p.until).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}`}`;
    }
    case 'resume': return clearPause({ source: 'bot' }) ? '恢复了' : '本来就没停';
    case 'research': {
      const q = String(a.question || '').trim().slice(0, 300);
      if (!q) return '要查什么？';
      if (!readConfig().qq.dsh.enabled) return '查资料这个功能关着，跟他说一声';
      out.research = q;
      return '交给 DSH 去查了，查到了会让你自己告诉他；这条回复应一声让他稍等，别编答案';
    }
    case 'make_sticker': {
      if (readState().stickerOn === localDate()) return '今天已经做过一张了，明天再说';
      out.makeSticker = { en: a.en, zh: a.zh, look: a.look, lookEn: a.look_en, when: a.when, base: stickerNames().includes(a.base) ? a.base : 'happy_开心' };
      return '开始做了，做好了会自己发给他；这条回复可以说一声「等我给自己画张新表情」';
    }
    case 'reviews': {
      const list = readReview().filter((r) => r.status === 'pending').slice(0, 6);
      const K = { diary: '日记', comment: '评论', reply: '回复' };
      return list.map((r) => `#${r.id.slice(0, 6)}［${K[r.kind] || r.kind}］${r.text.slice(0, 100)}`).join('\n') || '没有待审的';
    }
    case 'review_decide': {
      const auto = await import('../autopilot.mjs');
      try {
        if (a.action === 'reject') { auto.rejectReview(a.id, 'bot'); return '丢掉了'; }
        await auto.approveReview(a.id, a.text || undefined, 'bot');
        return a.text ? '按他改的发了' : '发了';
      } catch (e) { return `没成：${e.message}`; }
    }
    case 'set_appointment': {
      const text = String(a.text || '').trim().slice(0, 200);
      if (!text) return '提醒什么没说';
      const dueAt = Date.parse(a.dueAt);
      if (!Number.isFinite(dueAt)) return '时间没认出来，让它再说清楚点';
      const now = Date.now();
      if (dueAt <= now) return '那个时间已经过了，让它重说一个';
      if (dueAt > now + 30 * 86400_000) return '太远了，最多约 30 天内的';
      const isOwner = !!(out && out.isOwner);
      // 号主私聊→owner；号主在群里说→发回那个群。群友→约在他发言的那个会话（这里就是本群）。
      const peer = (out && out.peerKey) || 'owner';
      const who = (out && out.name) || (isOwner ? '号主' : '有人');
      const whoQq = (!isOwner && out && out.speakerQq) || '';
      const repeat = a.repeat === 'daily' ? 'daily' : 'once';
      const { addJob, resolveTarget, checkPermission } = await import('./appoint.mjs');
      // 号主：可跨会话（"去X群/私聊叫我"）。群友：只能约在本会话，填了 target 也不放行（禁跨群/跨会话）。
      let targetPeer = peer;
      if (a.target && isOwner) {
        const resolved = await resolveTarget(a.target, { isOwner: true, sourcePeer: peer });
        if (resolved?.error) return resolved.error;
        targetPeer = resolved?.peer || peer;
      }
      const perm = checkPermission({ isOwner, sourcePeer: peer, targetPeer });
      if (!perm.ok) return perm.error;
      const rawDays = Number(a.days);
      const days = repeat === 'daily' && Number.isFinite(rawDays) && rawDays >= 1 ? Math.min(30, Math.floor(rawDays)) : 0;
      const job = addJob({
        at: dueAt, kind: 'say', peer, sourcePeer: peer, targetPeer, repeat, days,
        originText: text, who, whoQq,
        note: `${targetPeer !== peer ? '跨会话提醒' : peer === 'owner' ? '提醒号主' : '群里赴约'}：${text.slice(0, 40)}`,
        logDetail: `⏰ 设了个${repeat === 'daily' ? days ? `连着 ${days} 天` : '每天' : ''}提醒：${text.slice(0, 40)} → ${new Date(dueAt).toLocaleString('zh-CN')}`,
      });
      if (!job) return '每天的任务攒太多了，先停一停，这条没记下';
      // 口头告知：给她一句人话，自然带上"连着N天/每天+30天"，别像客服确认
      const hm = new Date(dueAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false });
      const where = targetPeer !== peer ? `，到点去 ${targetPeer} 说` : '';
      const cadence = days ? `连着 ${days} 天` : '连着 30 天';
      return repeat === 'daily'
        ? `记下了，每天 ${hm} 提醒${isOwner ? '你' : who}${where}，${cadence}，到日子我自己会停；这条照你平时说话的样子应一声就行，别回得像客服`
        : `记下了，到点会提醒${isOwner ? '你' : who}${where}：${text}`;
    }
    case 'watch_video': {
      // 号主专属（没进 PUBLIC_TOOLS，门禁已挡其他人）
      return queueWatchVideo(a, out);
    }
    case 'send_text': {
      const say = String(a.text || '').trim().slice(0, 500);
      if (!say) return '要发啥还没说呢';
      // 空指令兜底：号主在群里只说「私聊发给我」没给内容，让模型回头问一句，别建空任务
      const target = String(a.target || '').trim();
      if (!target && out && out.isOwner && out.peerKey && out.peerKey.startsWith('g:')) {
        return '他没说要发啥，先问一句「发啥呀」，问清了再用 send_text 发（target 填「私聊」）';
      }
      const r = await queueMedia('text', target || (out && out.peerKey) || 'owner', { text: say }, out);
      if (r === null) return '这个只能发到私聊，他没说发到哪就先问清楚';
      return r;
    }
    case 'send_report': {
      // 号主专属（没进 PUBLIC_TOOLS，门禁已挡其他人）：把最近一条看完视频写的总结转发到指定会话。
      // 之前没这个工具，号主说「把总结发到X群」她只能嘴上答应或塞进后台普通任务，实际什么都不发。
      const notify = await import('../notify.mjs');
      const { resolveTarget, checkPermission } = await import('./appoint.mjs');
      const source = (out && out.isOwner && out.peerKey) || 'owner';
      const resolved = await resolveTarget(a.target, { isOwner: true, sourcePeer: source });
      if (resolved?.error) return resolved.error;
      const targetPeer = resolved?.peer || source;
      const perm = checkPermission({ isOwner: true, sourcePeer: source, targetPeer });
      if (!perm.ok) return perm.error;

      // 取要发的内容：号主另给了话就用，否则找最近一条写完的视频总结原文
      let text = String(a.text || '').trim().slice(0, 1500);
      if (!text) {
        const recent = readTasks().find((t) =>
          (t.type === 'watch_video' || (t.type === 'job' && t.kind === 'watch'))
          && (t.status === 'done' || t.status === 'fired') && t.resultNote);
        if (!recent) return '我手头没有刚写完的视频总结，让他说清楚要发哪句';
        text = recent.resultNote;
        out.forwardBvid = recent.payload?.bvid || recent.jobPayload?.bvid || '';
      }
      // 私聊里叫转到群里：群里得知道是谁让发的
      if (!String(source).startsWith('g:') && String(targetPeer).startsWith('g:')) {
        const who = String(out?.name || '').trim() || '号主';
        text = `（${who}让我发的）${text}`;
      }
      const results = await notify.reportResultToPeers(
        { id: 'forward-' + Date.now(), note: text },
        { ok: true, note: text, raw: true },
        [targetPeer],
      );
      if (results?.[targetPeer]?.sent) return `把那条总结发到 ${targetPeer} 了，你应一声就行`;
      // 群/好友走小号；窗口关了号主那条会排队，也算发出去
      if (results?.[targetPeer]?.why === 'deferred') return `记账了，等你下次开口就把总结发到 ${targetPeer}，你应一声就行`;
      return `往 ${targetPeer} 发总结没成（${results?.[targetPeer]?.why || '没发出去'}），跟他说一声`;
    }
    case 'schedule_task': {
      // 号主专属工具（没进 PUBLIC_TOOLS，门禁在上面已挡其他人）
      const kind = a.kind === 'watch' || a.kind === 'task' ? a.kind : '';
      if (!kind) return '没说清要干嘛，看视频还是交后台干活';
      const text = String(a.text || '').trim().slice(0, 200);
      const dueAt = Date.parse(a.dueAt);
      if (!Number.isFinite(dueAt)) return '时间没认出来，让它再说清楚点';
      const now = Date.now();
      if (dueAt <= now - 60_000) return '那个时间已经过了，让它重说一个';
      if (dueAt > now + 30 * 86400_000) return '太远了，最多约 30 天内的';
      const bvid = String(a.bvid || '').trim().toUpperCase();
      if (kind === 'watch' && !/^BV[0-9A-Z]{10}$/.test(bvid)) return '视频号没认出来，让它把 BV 号发全（BV 开头 12 位）';
      const taskNote = String(a.taskNote || '').trim().slice(0, 200);
      if (kind === 'task' && !taskNote) return '要说清到点干什么活';
      const at = Math.max(dueAt, now + 1000); // 号主说「现在/马上」= 一两分钟后就做
      const peer = (out && out.isOwner && out.peerKey) || 'owner';
      const { addJob } = await import('./appoint.mjs');
      addJob({
        at, kind, peer, sourcePeer: peer, originText: text || taskNote || bvid,
        who: (out && out.isOwner && out.name) || '号主',
        payload: kind === 'watch' ? { bvid, title: bvid } : { taskNote, taskType: 'custom' },
        note: `${kind === 'watch' ? '定时看视频' : '定时任务'}：${(text || taskNote || bvid).slice(0, 40)}`,
      });
      const when = new Date(at).toLocaleString('zh-CN');
      return kind === 'watch'
        ? `记下了，${when}去把《${bvid}》看了，看完跟你说；这条应一声就行`
        : `记下了，${when}去办「${taskNote.slice(0, 20)}」，办完跟你说；这条应一声就行`;
    }
    default: return `没有 ${name} 这个工具`;
  }
}


/** 梗百科查询清洗：模型可能把「图上文字：…；」整段塞进来，只取那行字 */
export function cleanMemeQuery(raw) {
  let q = String(raw || '').trim();
  const m = q.match(/图上文字[：:]\s*([^；;，,。\n]+)/);
  if (m) q = m[1];
  else q = q.replace(/^\[?图片[：:]?/, '').replace(/[“”"「」『』\[\]]/g, '').trim();
  return q.slice(0, 40);
}

// ─── 语音：edge-tts → mp3（NapCat 自己转成 QQ 的语音格式） ────────
export async function voiceB64(text, voice = 'Meijia') {
  return (await edgeTtsMp3(text, voice)).toString('base64');
}

export function stickerB64(name) {
  const f = readdirSync(STICKERS).find((x) => x.slice(0, x.lastIndexOf('.')) === name && /\.(png|jpe?g|gif)$/i.test(x));
  if (!f) throw new Error(`没有「${name}」这张表情`);
  return readFileSync(join(STICKERS, f)).toString('base64');
}
