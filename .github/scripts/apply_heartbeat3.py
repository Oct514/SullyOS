#!/usr/bin/env python3
"""心跳补丁 3：夜里不再勿扰。

之前：深夜没手机动静、或睡眠专注开着 → 直接不醒。
现在：照常醒，醒来只是被告知"他多半在睡觉"——别发消息吵醒他，这是你自己的时间，
可以思考、调工具、联网、记下想说的话；不发消息就只输出 [[SILENT]]。
睡着时也不再受"TA 主动说了最后一句"那条限制（醒来本来就不是为了发消息）。

在仓库根目录运行，可重复运行；任何锚点找不到或不唯一就直接报错退出。
"""
import sys
from pathlib import Path

GATE = Path('worker/amsg/src/triggerGate.ts')
SERVER = Path('trigger-service/server.js')


def sub(text, old, new, label):
    n = text.count(old)
    if n != 1:
        sys.exit(f'[补丁3失败] {label}：锚点出现 {n} 次（应为 1 次）')
    return text.replace(old, new, 1)


def patch_gate():
    t = GATE.read_text(encoding='utf-8')
    if 'asleep' in t:
        print('triggerGate.ts：补丁3已打过，跳过')
        return
    t = sub(t, "  missedMeal: boolean;\n  openItems: string[];\n};",
            "  missedMeal: boolean;\n  asleep: boolean;\n  openItems: string[];\n};", 'GateInfo')
    t = sub(t, "context?: { gapHours?: unknown; localHour?: unknown; missedMeal?: unknown; openItems?: unknown } | null;",
            "context?: {\n        gapHours?: unknown;\n        localHour?: unknown;\n        missedMeal?: unknown;\n        asleep?: unknown;\n"
            "        openItems?: unknown;\n      } | null;", 'ask 响应类型')
    t = sub(t, "        missedMeal: c.missedMeal === true,\n", "        missedMeal: c.missedMeal === true,\n        asleep: c.asleep === true,\n", 'ask 解析')
    t = sub(t, "  if (i.localHour !== null) lines.push(",
            "  if (i.asleep) {\n"
            "    lines.push(\n"
            "      '他现在多半在睡觉（深夜、手机也没动静，或者开着睡眠专注）。别发消息吵醒他，除非真的有急事。'\n"
            "        + '这段时间是你自己的：可以思考、查资料、联网、用工具做点自己想做的事；想跟他说的话先记下来（有记念头的工具就用它），留到他醒了再说。'\n"
            "        + '不发消息的话，整段输出只写 [[SILENT]]。',\n"
            "    );\n"
            "  }\n"
            "  if (i.localHour !== null) lines.push(", 'buildNote 睡着提示')
    t = sub(t, "  if (!lines.length) return '';\n",
            "  if (!lines.length) return '';\n"
            "  if (i.reason === 'wake') {\n"
            "    return `\\n\\n【此刻的情况（只供你参考）】\\n${lines.map((l) => `- ${l}`).join('\\n')}\\n"
            "这些只是背景，说不说、做不做都由你定；不要提\"系统\"\"判断\"\"阈值\"这类词，也不要把上面的话原样念出来。`;\n"
            "  }\n", 'buildNote 心跳口吻')
    GATE.write_text(t, encoding='utf-8')
    print('triggerGate.ts：已打补丁3')


def patch_server():
    t = SERVER.read_text(encoding='utf-8')
    if 'const asleep' in t:
        print('server.js：补丁3已打过，跳过')
        return
    t = sub(t,
            "  const un = Number.isFinite(unanswered) ? unanswered : S.unanswered;\n"
            "  if (un >= 1 && (!Number.isFinite(lastSelfSendAt) || now - lastSelfSendAt < CFG.afterCharQuietH * HOUR)) return no('fuse:char-last');\n"
            "  if (S.sleeping && now - S.sleepAt < 12 * HOUR) return no('fuse:sleeping');\n"
            "  if (inWin(t.min, CFG.nightStart, CFG.nightEnd) && act(S.phoneActs, 20) + act(S.pcActs, 20) === 0) return no('fuse:night-quiet');\n",
            "  const un = Number.isFinite(unanswered) ? unanswered : S.unanswered;\n"
            "  // 睡着 / 深夜没动静：不再拦着不醒——这是角色自己的时间（思考、调工具、联网），只提醒它别发消息吵醒你。\n"
            "  const asleep = (S.sleeping && now - S.sleepAt < 12 * HOUR)\n"
            "    || (inWin(t.min, CFG.nightStart, CFG.nightEnd) && act(S.phoneActs, 20) + act(S.pcActs, 20) === 0);\n"
            "  // 睡着时醒来不是为了发消息，所以不受上面\"TA 主动说了最后一句\"的限制。\n"
            "  if (!asleep && un >= 1 && (!Number.isFinite(lastSelfSendAt) || now - lastSelfSendAt < CFG.afterCharQuietH * HOUR)) return no('fuse:char-last');\n",
            'wake 熔断')
    t = sub(t, "localHour: t.hour, missedMeal: !!mealBetween, openItems: items.map((i) => i.text) },",
            "localHour: t.hour, missedMeal: !!mealBetween, asleep, openItems: items.map((i) => i.text) },", 'wake 返回')
    SERVER.write_text(t, encoding='utf-8')
    print('server.js：已打补丁3')


if __name__ == '__main__':
    patch_gate()
    patch_server()
