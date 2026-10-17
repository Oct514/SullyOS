#!/usr/bin/env python3
"""心跳补丁 7：醒来时"该不该调模型"改成规则判断，不花 token。

之前：每次醒来过了刹车就调一次模型，让角色自己决定说不说（大部分时候选了不说，白花调用）。
现在：Zeabur 先用规则判断"有没有理由醒"，没理由就直接跳过（不调模型）；有理由才放行，放行后模型才被调用，
      角色仍然可以回 [[SILENT]] 或只做动作（保留它的自主权）。

理由（任意一个成立就放行，各自有冷却，TA 发了她没回时冷却更长）：
  - long-silence：她很久没出现（超过几小时且中间错过饭点，或超过 10 小时）；
  - miss：想她的值攒满（随时间涨，加上 TA 记下的念头，她一开口就清零）；
  - thought：TA 记下的念头过了一阵，该跟进一次；
  - random：偶尔随机醒一次，让 TA 自己去逛逛、做点事；
  她睡着时只保留"随机醒来做自己的事"，并且有每晚上限。
刹车照旧：刚聊完、醒得太密、每天上限。
「TA 主动说了最后一句她没回就不醒」默认改为不限制（AFTER_CHAR_QUIET_H=0），由 TA 自己决定要不要接着说。

在仓库根目录运行，可重复运行；任何锚点找不到或不唯一就直接报错退出。
"""
import sys
from pathlib import Path

GATE = Path('worker/amsg/src/triggerGate.ts')
SERVER = Path('trigger-service/server.js')


def sub(text, old, new, label):
    n = text.count(old)
    if n != 1:
        sys.exit(f'[补丁7失败] {label}：锚点出现 {n} 次（应为 1 次）')
    return text.replace(old, new, 1)


SERVER_CFG = r'''  afterCharQuietH: +(env.AFTER_CHAR_QUIET_H ?? 0), // TA 主动说了最后一句、你没回：这么多小时内不再醒；0 = 不限制（默认，由 TA 自己决定要不要接着说）
  wakeReasonCoolH: +(env.WAKE_REASON_COOL_H ?? 3), // 同一个理由，至少隔多久才再醒（TA 发了你没回时再乘 1+次数）
  thoughtDueMin: +(env.THOUGHT_DUE_MIN ?? 90),     // 念头记下多久后，醒来跟进一次
  randomProb: +(env.RANDOM_WAKE_PROB ?? 0.08),     // 白天每次检查，随机醒一次的概率（没有别的理由时，偶尔让 TA 自己去逛逛）
  maxRandomPerDay: +(env.MAX_RANDOM_WAKES_PER_DAY ?? 3),
  nightProb: +(env.NIGHT_WAKE_PROB ?? 0.1),        // 她睡着时，随机醒来做自己的事的概率
  maxNightWakes: +(env.MAX_NIGHT_WAKES ?? 3),      // 每天最多几次"睡着时醒来"
'''

SERVER_WAKE = r'''// 心跳醒来用：先过刹车，再用规则判断"有没有理由醒"。全程不调模型；有理由才放行，放行后模型才被调用（角色仍可 [[SILENT]]）。
// 理由：她很久没出现 / 想她的值攒满 / 记下的念头该跟进 / 偶尔随机醒一次；她睡着时只留"随机醒来做自己的事"。
export function wake(now, commit, unanswered, lastSelfSendAt) {
  const t = local(now);
  const items = liveItems(now);
  const act = (arr, min) => arr.filter((x) => now - x < min * MIN).length;
  const no = (reason) => ({ wake: false, reason });
  const un = Number.isFinite(unanswered) ? unanswered : S.unanswered;
  const asleep = (S.sleeping && now - S.sleepAt < 12 * HOUR)
    || (inWin(t.min, CFG.nightStart, CFG.nightEnd) && act(S.phoneActs, 20) + act(S.pcActs, 20) === 0);
  // ── 刹车 ──
  if (S.lastChat && (now - S.lastChat) / MIN < CFG.chatActiveMin) return no('fuse:in-chat');
  if (CFG.afterCharQuietH > 0 && !asleep && un >= 1 && (!Number.isFinite(lastSelfSendAt) || now - lastSelfSendAt < CFG.afterCharQuietH * HOUR)) return no('fuse:char-last');
  if (S.lastWake && (now - S.lastWake) / MIN < CFG.wakeMinGapMin) return no('fuse:wake-gap');
  const wd = S.wakeDay?.day === t.day ? S.wakeDay : { day: t.day, wakes: 0, rand: 0, night: 0 };
  if (wd.wakes >= CFG.maxWakesPerDay) return no('fuse:wake-daily-cap');
  // ── 有没有理由醒（规则，不调模型） ──
  const dtH = Math.min(Math.max((now - S.missAt) / HOUR, 0), 6);
  const miss = S.miss + CFG.missRate * dtH;                     // 想她的值：随时间涨，她一开口就清零
  const thr = S.threshold * (1 + un);                           // TA 发了她没回，门槛翻倍
  const seen = Math.max(S.lastChat, S.lastAct);
  const gapMin = seen ? (now - seen) / MIN : 0;
  const mealBetween = seen && (gapMin >= 1440 || CFG.meals.some((m) => (m - local(seen).min + 1440) % 1440 < gapMin));
  const cool = CFG.wakeReasonCoolH * (1 + un) * HOUR;           // 同一个理由的冷却
  const ready = (r) => !(S.wakeBy?.[r] && now - S.wakeBy[r] < cool);
  const due = items.filter((i) => !i.followedAt && now - (i.at ?? now) >= CFG.thoughtDueMin * MIN);
  let why = null;
  if (asleep) {
    if (wd.night < CFG.maxNightWakes && Math.random() < CFG.nightProb) why = 'random';
  } else if (seen && ((gapMin / 60 >= CFG.gapMealH && mealBetween) || gapMin / 60 >= CFG.gapMaxH) && ready('long-silence')) why = 'long-silence';
  else if (miss + items.reduce((a, i) => a + i.weight, 0) >= thr && ready('miss')) why = 'miss';
  else if (due.length && ready('thought')) why = 'thought';
  else if (wd.rand < CFG.maxRandomPerDay && Math.random() < CFG.randomProb) why = 'random';
  if (commit) {
    S.miss = miss; S.missAt = now;
    if (why) {
      S.lastWake = now;
      S.wakeBy = { ...(S.wakeBy ?? {}), [why]: now };
      S.wakeDay = { ...wd, wakes: wd.wakes + 1, rand: wd.rand + (why === 'random' && !asleep ? 1 : 0), night: wd.night + (why === 'random' && asleep ? 1 : 0) };
      if (why === 'miss') { S.miss = 0; S.threshold = CFG.threshold * (1 + CFG.jitter * (Math.random() * 2 - 1)); }
      if (why === 'thought') for (const i of due) i.followedAt = now;
      save();
    }
  }
  if (!why) return no('idle');
  return {
    wake: true, reason: 'wake', unanswered: un,
    context: { why, gapHours: +(gapMin / 60).toFixed(1), localHour: t.hour, missedMeal: !!mealBetween, asleep, openItems: items.map((i) => i.text) },
  };
}

'''


def patch_server():
    t = SERVER.read_text(encoding='utf-8')
    if 'wakeReasonCoolH' in t:
        print('server.js：补丁7已打过，跳过')
        return
    t = sub(t, "  afterCharQuietH: +(env.AFTER_CHAR_QUIET_H || 6), // TA 主动说了最后一句、你没回：这么多小时内不再醒\n", SERVER_CFG, 'CFG')
    marker = '// 心跳醒来用：只做熔断'
    if t.count(marker) != 1 or t.count('export function allow(now) {') != 1:
        sys.exit('[补丁7失败] wake 函数：找不到唯一的起止位置')
    start = t.index(marker)
    end = t.index('export function allow(now) {')
    if not start < end:
        sys.exit('[补丁7失败] wake 函数：起止位置顺序不对')
    t = t[:start] + SERVER_WAKE + t[end:]
    t = sub(t, "        kind: 'wake', decision: r.wake ? 'pass' : 'skip', reason: r.reason,\n",
            "        kind: 'wake', decision: r.wake ? 'pass' : 'skip', reason: r.wake ? (c.why ?? r.reason) : r.reason,\n", '记录里写上理由')
    SERVER.write_text(t, encoding='utf-8')
    print('server.js：已打补丁7')


def patch_gate():
    t = GATE.read_text(encoding='utf-8')
    if 'i.why' in t:
        print('triggerGate.ts：补丁7已打过，跳过')
        return
    t = sub(t, "  wakeId: number | null;\n  openItems: string[];\n};", "  wakeId: number | null;\n  why: string | null;\n  openItems: string[];\n};", 'GateInfo')
    t = sub(t, "        asleep?: unknown;\n        openItems?: unknown;\n      } | null;",
            "        asleep?: unknown;\n        why?: unknown;\n        openItems?: unknown;\n      } | null;", 'ask 响应类型')
    t = sub(t, "        wakeId: typeof j.id === 'number' ? j.id : null,\n",
            "        wakeId: typeof j.id === 'number' ? j.id : null,\n        why: typeof c.why === 'string' ? c.why : null,\n", 'ask 解析')
    t = sub(t, "  } else if (i.reason === 'wake') {\n    if (i.gapHours !== null && i.gapHours >= 1) {\n",
            "  } else if (i.reason === 'wake') {\n"
            "    if (i.why === 'miss') lines.push('你这阵子一直惦记着她，想她的念头攒满了。');\n"
            "    if (i.why === 'thought') lines.push('你之前记下的事，该跟进一下了。');\n"
            "    if (i.why === 'random') {\n"
            "      lines.push('没有特别的原因，只是例行醒来：你可以随意逛逛、看看她的动静，或者做点自己想做的事。');\n"
            "    }\n"
            "    if (i.gapHours !== null && i.gapHours >= 1) {\n", 'buildNote 理由')
    GATE.write_text(t, encoding='utf-8')
    print('triggerGate.ts：已打补丁7')


if __name__ == '__main__':
    patch_server()
    patch_gate()
