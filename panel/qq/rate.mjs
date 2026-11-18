/**
 * 插嘴限流 / 豁免治理的纯判定（架构升级批次 C2）
 *
 * index.mjs 的 onMessage 里原本就有两道内存限流：按人的（userFreeRate）和她自己的熔断（herFreeRate）。
 * 本模块补两件治理，判定抽成纯函数便于离线单测（index 那段连着 NapCat，测试进不去）：
 *  1. 每日豁免上限：点名叫她（指向你/被怼/短指令）的消息本不受按人限流，但每人每天最多放行 N 次，
 *     超了也照普通消息限——防「鲸鲸！鲸鲸！」连着叫她烧 token，又不至于一次都不回成当面装死。
 *  2. 冷静窗：某人反复怼她（reasons 命中「被点名怼」）达到阈值，
 *     这个对话进冷静窗 N 分钟，期间自由插嘴全拦；窗口按最后一条触发时间顺延，@ 她的不受影响（点名不是刷屏）。
 *     复读不进冷静窗（2026-11-18 收窄）：复读在打分层已是负分不会回复，拦它没省 token 还误伤跟风刷梗。
 *
 * 记账全在 index.mjs 的内存 Map（重启清零没关系，跟现有 userFreeRate 一致），本模块只算不存。
 */
import { localDate } from '../store.mjs';

/** 判定一条「没 @ 她」的群消息放不放行。
 * @param opts.called    是否点名叫她（指向你/被点名怼/短指令）——这类原不受按人限流
 * @param opts.reasons   topicScoreMessage 的命中项数组
 * @param opts.exemptUsed 这个人今天已经豁免放行过几次
 * @param opts.rateHits  这个人当前限流窗口内已回几次
 * @param opts.calmUntil 这个对话冷静窗到第几毫秒（0=不在冷静窗）
 * @param opts.attackHits 这个人冷静窗判定窗口内已怼/复读几次
 * @returns {{ allow:boolean, verdict:string, exempt:boolean, attack:boolean, calm:boolean }}
 *   verdict: '冷静窗' | '冷静·触发' | '豁免用尽' | '限流' | ''（放行）
 *   exempt=要不要记一次每日豁免；attack=要不要记一次怼/复读；calm=要不要开新冷静窗
 */
export function decideRate({ called, reasons = [], exemptUsed = 0, rateHits = 0, calmUntil = 0, attackHits = 0, g }) {
  const now = Date.now();
  if (calmUntil > now) return { allow: false, verdict: '冷静窗', exempt: false, attack: false, calm: false };
  // 只认「被点名怼」：复读/重复表述在打分层已是负分、根本不会回复，冷静窗拦它没省 token，
  // 反而误伤跟风刷梗的正常人（2026-11-18 收窄，原正则含「重复表述|复读」）
  const attack = reasons.some((r) => /被点名怼/.test(String(r)));
  const trigger = Math.max(1, Number(g.calmTrigger) || 4);
  if (attack && attackHits + 1 >= trigger) {
    return { allow: false, verdict: '冷静·触发', exempt: false, attack: true, calm: true };
  }
  if (called) {
    if (exemptUsed >= (Number(g.exemptPerDay) || 12)) {
      return { allow: false, verdict: '豁免用尽', exempt: false, attack, calm: false };
    }
    return { allow: true, verdict: '', exempt: true, attack, calm: false };
  }
  if (rateHits >= (Number(g.userRateMax) || 3)) {
    return { allow: false, verdict: '限流', exempt: false, attack, calm: false };
  }
  return { allow: true, verdict: '', exempt: false, attack, calm: false };
}

/** 冷静窗长度（毫秒），index 用来算 until */
export function calmMs(g) { return (Number(g?.calmWindowMin) > 0 ? Number(g.calmWindowMin) : 10) * 60_000; }

/** 每日豁免记账的 key：按「对话:人:日期」，跨天自动清零，不用扫 */
export const exemptKey = (peer, uid) => `${peer}:${uid}:${localDate()}`;
