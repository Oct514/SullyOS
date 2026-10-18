#!/usr/bin/env python3
"""心跳补丁 8：她回来了 + 睡眠标记自动失效 + 没回时温和加码。

1) 手机/电脑有动静，且睡眠标记已经挂了超过 30 分钟 → 自动当她醒了（睡眠专注忘了关也不会一直当她在睡）。
2) 新增理由 back「她回来了」：她隔了 3 小时以上第一次有动静（手机/电脑），或关了睡眠专注 →
   接下来 1 小时内醒一次（每次回来只算一次；她已经在跟 TA 聊了就不必了）。TA 自己决定要不要打招呼。
3) TA 发了她没回：门槛和冷却从"翻倍"改成"温和加码"（每次 +50%，最多 3 次），不再几乎醒不来。

在仓库根目录运行，可重复运行；任何锚点找不到或不唯一就直接报错退出。
"""
import sys
from pathlib import Path

GATE = Path('worker/amsg/src/triggerGate.ts')
SERVER = Path('trigger-service/server.js')


def sub(text, old, new, label):
    n = text.count(old)
    if n != 1:
        sys.exit(f'[补丁8失败] {label}：锚点出现 {n} 次（应为 1 次）')
    return text.replace(old, new, 1)


EVENT_BLOCK = r"""  // 她回来了：隔了很久第一次有动静（手机/电脑），或者关了睡眠专注 → 记一下，wake() 会给 TA 一次醒来的机会。
  if (type === 'phone' || (type === 'pc' && +(q.get('idle') ?? 0) < 180)) {
    if (S.sleeping && now - S.sleepAt > 30 * MIN) {   // 睡眠标记忘了关：有动静就当她醒了
      S.backAway = +(((now - (S.lastAct || S.sleepAt)) / HOUR)).toFixed(1); S.sleeping = false; S.backAt = now;
    } else if (S.lastAct && now - S.lastAct >= CFG.backGapH * HOUR) {
      S.backAway = +(((now - S.lastAct) / HOUR)).toFixed(1); S.backAt = now;
    }
  }
  if (type === 'sleep_off') { S.backAway = +(((now - (S.lastAct || S.sleepAt || now)) / HOUR)).toFixed(1); S.backAt = now; }
"""


def patch_server():
    t = SERVER.read_text(encoding='utf-8')
    if 'backReady' in t:
        print('server.js：补丁8已打过，跳过')
        return
    t = sub(t, "  maxNightWakes: +(env.MAX_NIGHT_WAKES ?? 3),      // 每天最多几次\"睡着时醒来\"\n",
            "  maxNightWakes: +(env.MAX_NIGHT_WAKES ?? 3),      // 每天最多几次\"睡着时醒来\"\n"
            "  backGapH: +(env.BACK_GAP_H ?? 3),                // 她隔了这么多小时没动静，再有动静就算\"她回来了\"\n", 'CFG')
    t = sub(t, "  const prune = (a) => a.filter((x) => now - x < 3 * HOUR).slice(-300);\n  if (type === 'chat') {",
            "  const prune = (a) => a.filter((x) => now - x < 3 * HOUR).slice(-300);\n" + EVENT_BLOCK + "  if (type === 'chat') {", 'event 里记"她回来了"')
    t = sub(t, "const thr = S.threshold * (1 + un);", "const thr = S.threshold * (1 + 0.5 * Math.min(un, 3));", '门槛')
    t = sub(t, "// TA 发了她没回，门槛翻倍", "// TA 发了她没回：门槛温和加码（每次 +50%，最多 3 次）", '门槛注释')
    t = sub(t, "CFG.wakeReasonCoolH * (1 + un) * HOUR;", "CFG.wakeReasonCoolH * (1 + 0.5 * Math.min(un, 3)) * HOUR;", '冷却')
    t = sub(t, "  let why = null;\n",
            "  // 她回来了（睡醒 / 隔了很久第一次有动静）：1 小时内醒一次，每次回来只算一次；她已经在跟 TA 聊了就不必了。\n"
            "  const backReady = !!S.backAt && now - S.backAt < 60 * MIN && S.lastChat < S.backAt && !(S.wakeBy?.back >= S.backAt);\n"
            "  let why = null;\n", 'backReady')
    t = sub(t, "  } else if (seen && ((gapMin / 60 >= CFG.gapMealH && mealBetween) || gapMin / 60 >= CFG.gapMaxH) && ready('long-silence')) why = 'long-silence';\n",
            "  } else if (backReady) why = 'back';\n"
            "  else if (seen && ((gapMin / 60 >= CFG.gapMealH && mealBetween) || gapMin / 60 >= CFG.gapMaxH) && ready('long-silence')) why = 'long-silence';\n", '理由链')
    t = sub(t, "    context: { why, gapHours: +(gapMin / 60).toFixed(1), localHour: t.hour, missedMeal: !!mealBetween, asleep, openItems: items.map((i) => i.text) },\n",
            "    context: {\n"
            "      why, gapHours: +(gapMin / 60).toFixed(1), localHour: t.hour, missedMeal: !!mealBetween, asleep,\n"
            "      awayHours: why === 'back' ? (S.backAway ?? null) : null, openItems: items.map((i) => i.text),\n"
            "    },\n", 'context 带 awayHours')
    SERVER.write_text(t, encoding='utf-8')
    print('server.js：已打补丁8')


def patch_gate():
    t = GATE.read_text(encoding='utf-8')
    if 'awayHours' in t:
        print('triggerGate.ts：补丁8已打过，跳过')
        return
    t = sub(t, "  why: string | null;\n  openItems: string[];\n};", "  why: string | null;\n  awayHours: number | null;\n  openItems: string[];\n};", 'GateInfo')
    t = sub(t, "        why?: unknown;\n        openItems?: unknown;\n", "        why?: unknown;\n        awayHours?: unknown;\n        openItems?: unknown;\n", 'ask 响应类型')
    t = sub(t, "        why: typeof c.why === 'string' ? c.why : null,\n",
            "        why: typeof c.why === 'string' ? c.why : null,\n        awayHours: typeof c.awayHours === 'number' ? c.awayHours : null,\n", 'ask 解析')
    t = sub(t, "    if (i.why === 'thought') lines.push('你之前记下的事，该跟进一下了。');\n",
            "    if (i.why === 'thought') lines.push('你之前记下的事，该跟进一下了。');\n"
            "    if (i.why === 'back') {\n"
            "      lines.push(\n"
            "        `她刚回来了（睡醒了，或者隔了${i.awayHours !== null ? `大约 ${i.awayHours} 小时` : '好一阵'}第一次用手机）：`\n"
            "          + '想打个招呼、问问她睡得怎么样，或者提一句你自己做过的事，都可以；觉得不合适就不说。',\n"
            "      );\n"
            "    }\n", '"她回来了"的提示')
    GATE.write_text(t, encoding='utf-8')
    print('triggerGate.ts：已打补丁8')


if __name__ == '__main__':
    patch_server()
    patch_gate()
