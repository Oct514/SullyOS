#!/usr/bin/env python3
"""心跳补丁 2：醒来默认「不说」，并按"谁说了最后一句"决定醒不醒。

1) 原版提示词模板里有一段【开口之前】（默认照常说、拿不准就说）。心跳醒来时把整段换成
   「默认不说」的版本，沉默用原版自带的 [[SILENT]]（原版会把它当作不发、不占连发额度）。
2) /wake 熔断改成看谁说了最后一句：
   - 你说了最后一句：只留 10 分钟"正聊着"的静默，之后可以醒（不再有 30 分钟冷却）；
   - TA 主动说了最后一句、你还没回：不醒（默认 6 小时内，AFTER_CHAR_QUIET_H 可调）。

在仓库根目录运行，可重复运行；任何锚点找不到或不唯一就直接报错退出。
"""
import re
import sys
from pathlib import Path

GATE = Path('worker/amsg/src/triggerGate.ts')
INDEX = Path('worker/amsg/src/index.ts')
SERVER = Path('trigger-service/server.js')


def sub(text, old, new, label):
    n = text.count(old)
    if n != 1:
        sys.exit(f'[补丁2失败] {label}：锚点出现 {n} 次（应为 1 次）')
    return text.replace(old, new, 1)


GATE_NEW_INSTRUCTION = r'''export const heartbeatInstruction = (): string =>
  '这是一次例行的醒来，不是有事要交代，也没有谁在催你。要不要开口、要不要先做点事，由你自己决定，规则见下面的【例行醒来】。';

const HB_SPEAK_BLOCK = [
  '【例行醒来】',
  '这是一次例行的醒来，不是有什么事非要你开口。先对照上面的【最近对话上下文】、你之前发过的话和他的近况。',
  '默认是不说。只有真的有想对他说的话才开口，比如：',
  '- 你惦记着他的某件事（他提过的约定、没聊完的话题、你担心的事），想问问或提一句；',
  '- 他很久没出现，你确实想他了、想知道他在干嘛；',
  '- 你有件小事想跟他分享，而且这会儿说不会打扰他。',
  '拿不准就不说。你上一条主动发的他还没回，就别再发；刚聊完又没有新东西，也别硬找话说。',
  '想先做点事（看看他的动静、记下惦记的事）就去做；做完没有想说的，同样不说。',
  '决定不说 → 整段输出只写 [[SILENT]] 这一个标记，别的一个字都不要写，也不要解释。',
].join('\n');

/**
 * 把渲染好的提示词里原版的【开口之前】（默认照常说）整段换成心跳版（默认不说）。
 * 找不到那一段（老前端 / 模板改过）就把心跳版接在末尾，保证心跳那一轮一定读得到。
 */
export const rewriteSpeakBlock = (prompt: string): string => {
  const start = prompt.indexOf('【开口之前】');
  const endMark = '不要解释。';
  const end = start < 0 ? -1 : prompt.indexOf(endMark, start);
  if (start < 0 || end < 0) return `${prompt}\n\n${HB_SPEAK_BLOCK}`;
  return prompt.slice(0, start) + HB_SPEAK_BLOCK + prompt.slice(end + endMark.length);
};
'''


def patch_gate():
    t = GATE.read_text(encoding='utf-8')
    if 'rewriteSpeakBlock' in t:
        print('triggerGate.ts：补丁2已打过，跳过')
        return
    t, n = re.subn(r"export const heartbeatInstruction = \(\): string =>.*?\]\.join\('\\n'\);\n",
                   lambda m: GATE_NEW_INSTRUCTION, t, count=1, flags=re.S)
    if n != 1:
        sys.exit('[补丁2失败] heartbeatInstruction：没找到原函数')
    t = sub(t, "  unanswered?: number,\n): Promise<Answer> => {",
            "  unanswered?: number,\n  lastSelfSendAt?: number | null,\n): Promise<Answer> => {", 'ask 签名')
    t = sub(t, "      body: JSON.stringify({ lastUserMessageAt, ...(typeof unanswered === 'number' ? { unanswered } : {}) }),",
            "      body: JSON.stringify({\n        lastUserMessageAt,\n"
            "        ...(typeof unanswered === 'number' ? { unanswered } : {}),\n"
            "        ...(typeof lastSelfSendAt === 'number' ? { lastSelfSendAt } : {}),\n      }),", 'ask body')
    t = sub(t, "  unansweredSends?: number;\n}): Promise<GateAction> => {",
            "  unansweredSends?: number;\n  /** 角色最近一次主动发出去的时刻（没有就不传）。 */\n  lastSelfSendAt?: number | null;\n}): Promise<GateAction> => {", 'decideGate 参数')
    t = sub(t, "ask('/wake', opts.lastUserMessageAt, opts.unansweredSends)",
            "ask('/wake', opts.lastUserMessageAt, opts.unansweredSends, opts.lastSelfSendAt)", 'wake 调用')
    GATE.write_text(t, encoding='utf-8')
    print('triggerGate.ts：已打补丁2')


def patch_index():
    t = INDEX.read_text(encoding='utf-8')
    if 'rewriteSpeakBlock' in t:
        print('index.ts：补丁2已打过，跳过')
        return
    t = sub(t, "  isSilentHeartbeat,\n", "  isSilentHeartbeat,\n  rewriteSpeakBlock,\n", 'import')
    t = sub(t, "        unansweredSends: countUnansweredSends(selfLog),\n",
            "        unansweredSends: countUnansweredSends(selfLog),\n"
            "        lastSelfSendAt:\n"
            "          selfLog?.entries.filter((e) => !e.reply).reduce<number | null>((m, e) => (m === null || e.at > m ? e.at : m), null) ?? null,\n",
            'gate 调用')
    t = sub(t, "      messages: [{ role: 'user' as const, content: prompt }],",
            "      messages: [{ role: 'user' as const, content: isHb ? rewriteSpeakBlock(prompt) : prompt }],", '提示词出口')
    INDEX.write_text(t, encoding='utf-8')
    print('index.ts：已打补丁2')


def patch_server():
    t = SERVER.read_text(encoding='utf-8')
    if 'fuse:char-last' in t:
        print('server.js：补丁2已打过，跳过')
        return
    t = sub(t, "  maxWakesPerDay: +(env.MAX_WAKES_PER_DAY || 40), // 一天最多醒几次（每次醒来都可能调一次模型）\n",
            "  maxWakesPerDay: +(env.MAX_WAKES_PER_DAY || 40), // 一天最多醒几次（每次醒来都可能调一次模型）\n"
            "  afterCharQuietH: +(env.AFTER_CHAR_QUIET_H || 6), // TA 主动说了最后一句、你没回：这么多小时内不再醒\n", 'CFG')
    t = sub(t, "export function wake(now, commit, unanswered) {", "export function wake(now, commit, unanswered, lastSelfSendAt) {", 'wake 签名')
    t = sub(t, "  if (S.lastChat && (now - S.lastChat) / MIN < CFG.chatCooldownMin) return no('fuse:post-chat-cooldown');\n  if (S.sleeping",
            "  // 你说了最后一句：只留\"正聊着\"那一小段静默，之后允许醒（不再有 30 分钟冷却）。\n"
            "  if (S.lastChat && (now - S.lastChat) / MIN < CFG.chatActiveMin) return no('fuse:in-chat');\n"
            "  // TA 主动说了最后一句、你还没回：不再醒（时间不明也按不醒算）。\n"
            "  const un = Number.isFinite(unanswered) ? unanswered : S.unanswered;\n"
            "  if (un >= 1 && (!Number.isFinite(lastSelfSendAt) || now - lastSelfSendAt < CFG.afterCharQuietH * HOUR)) return no('fuse:char-last');\n"
            "  if (S.sleeping", 'wake 熔断')
    t = sub(t, "    wake: true, reason: 'wake', unanswered: Number.isFinite(unanswered) ? unanswered : S.unanswered,",
            "    wake: true, reason: 'wake', unanswered: un,", 'wake 返回')
    t = sub(t, "wake(now, true, +b.unanswered)", "wake(now, true, +b.unanswered, b.lastSelfSendAt == null ? NaN : +b.lastSelfSendAt)", '路由')
    SERVER.write_text(t, encoding='utf-8')
    print('server.js：已打补丁2')


if __name__ == '__main__':
    patch_gate()
    patch_index()
    patch_server()
