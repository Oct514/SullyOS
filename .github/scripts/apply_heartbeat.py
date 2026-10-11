#!/usr/bin/env python3
"""心跳链补丁：每 30 分钟醒一次，由 TA 自己决定说不说。

在仓库根目录运行。可重复运行（已打过补丁的文件会跳过）；任何一个锚点找不到或不唯一就直接报错退出，
不会写出改到一半的文件。
"""
import sys
from pathlib import Path

GATE = Path('worker/amsg/src/triggerGate.ts')
INDEX = Path('worker/amsg/src/index.ts')
SERVER = Path('trigger-service/server.js')


def sub(text, old, new, label):
    n = text.count(old)
    if n != 1:
        sys.exit(f'[补丁失败] {label}：锚点出现 {n} 次（应为 1 次）')
    return text.replace(old, new, 1)


# ───────────────────────── triggerGate.ts ─────────────────────────
GATE_APPEND = r'''
// ───────────────────────── 心跳链 ─────────────────────────
// 起点任务（每天重复、补充灵感里写 [心跳]）到点 → 先排好 30 分钟后的下一次（链不断）→ 问 Zeabur /wake
// 做熔断预检（不调模型）→ 过了才让角色自己决定说不说。回复 [沉默] = 这一轮什么都不发。

export const HEARTBEAT_MARK = '[心跳]';
/** 每隔多久醒一次。 */
export const HEARTBEAT_EVERY_MS = 30 * 60_000;
/** 排下一次时离现在至少多远（上游不收"时间太近"的排程）。 */
const HEARTBEAT_MIN_LEAD_MS = 5 * 60_000;

export const isHeartbeatTask = (...texts: Array<unknown>): boolean =>
  texts.some((t) => typeof t === 'string' && t.includes(HEARTBEAT_MARK));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyFn = (...args: any[]) => any;

/** 同一个角色、同一个时刻永远得到同一个 uuid：重跑、起点任务和链同时排同一格，都只会建出一条。 */
const hbUuid = async (charId: string, slotMs: number): Promise<string> => {
  const d = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`hb|${charId}|${slotMs}`)));
  d[6] = (d[6] & 0x0f) | 0x40;
  d[8] = (d[8] & 0x3f) | 0x80;
  const h = Array.from(d.slice(0, 16), (b) => b.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
};

/** 排下一次心跳（落在每 30 分钟的整点/半点格子上）。返回一句话结果，只用来打日志。 */
export const scheduleNextHeartbeat = async (a: {
  scheduleTask: AnyFn | undefined;
  charId: string;
  occurrenceMs: number;
  nowMs: number;
  tzId: string;
  instruction: unknown;
}): Promise<string> => {
  if (!cfg) return 'gate-off';
  if (typeof a.scheduleTask !== 'function') return 'no-schedule-api';
  const slot =
    Math.ceil(Math.max(a.occurrenceMs + HEARTBEAT_EVERY_MS, a.nowMs + HEARTBEAT_MIN_LEAD_MS) / HEARTBEAT_EVERY_MS) *
    HEARTBEAT_EVERY_MS;
  const iso = new Date(slot).toISOString();
  const uuid = await hbUuid(a.charId, slot);
  const base = typeof a.instruction === 'string' ? a.instruction : '';
  try {
    const r = await a.scheduleTask({
      firstSendTime: iso,
      recurrenceType: 'none',
      messageType: 'auto',
      uuid,
      tzId: a.tzId,
      metadata: {
        charId: a.charId,
        source: 'active_msg_2',
        amsgMode: 'auto',
        amsgClientTaskId: `${uuid}-c`,
        amsgExpirePolicy: 'expire',
        amsgTaskInstruction: base.includes(HEARTBEAT_MARK) ? base : `${base}\n${HEARTBEAT_MARK}`.trim(),
        amsgSelfScheduled: true,
      },
    });
    return r && r.created === false ? `exists:${iso}` : `scheduled:${iso}`;
  } catch (e) {
    return `failed:${e instanceof Error ? e.message : String(e)}`.slice(0, 160);
  }
};

/** 心跳醒来时放进"本次任务"槽位的话：替掉"请发一条消息"那种口吻，让角色自己决定。 */
export const heartbeatInstruction = (): string =>
  [
    '这是一次例行的醒来，不是谁在催你发消息。你自己决定要不要做点什么：',
    '- 想主动跟他说点什么，就直接写出来，像平时那样说话；',
    '- 想先做点事（看看他的动静、记下惦记的事、查点东西），就去做；',
    '- 现在没什么想说的，或者不该打扰他，就只回复 [沉默]，这一轮什么都不会发出去。',
    '别因为"到点了"硬凑一句；说了之后他还没回，就不要重复同样的话。不要提"心跳""例行醒来""系统"这些词。',
  ].join('\n');

const HB_SCRATCH_KEY = '__heartbeat';

/** 放行后在这一次 fire 的 scratch 上做个记号，onLLMOutput 靠它认出"这是心跳那一轮"。 */
export const flagHeartbeat = (scratch: Record<string, unknown> | undefined): void => {
  if (scratch) scratch[HB_SCRATCH_KEY] = true;
};

const SILENT_RE = /^[\[【(（]\s*沉默\s*[\]】)）][。.!！\s]*$/;

/** 心跳那一轮里，角色只回了 [沉默]：这一轮不发。 */
export const isSilentHeartbeat = (scratch: Record<string, unknown> | undefined, content: string): boolean =>
  scratch?.[HB_SCRATCH_KEY] === true && SILENT_RE.test(content.trim());
'''


def patch_gate():
    t = GATE.read_text(encoding='utf-8')
    if 'scheduleNextHeartbeat' in t:
        print('triggerGate.ts：已打过补丁，跳过')
        return
    t = sub(t, "const ask = async (endpoint: '/gate' | '/allow', lastUserMessageAt: number | null): Promise<Answer> => {",
            "const ask = async (\n  endpoint: '/gate' | '/allow' | '/wake',\n  lastUserMessageAt: number | null,\n  unanswered?: number,\n): Promise<Answer> => {", 'ask 签名')
    t = sub(t, "      body: JSON.stringify({ lastUserMessageAt }),",
            "      body: JSON.stringify({ lastUserMessageAt, ...(typeof unanswered === 'number' ? { unanswered } : {}) }),", 'ask body')
    t = sub(t, "      fire?: unknown;\n      allow?: unknown;", "      fire?: unknown;\n      allow?: unknown;\n      wake?: unknown;", 'ask 响应类型')
    t = sub(t, "      yes: j.fire === true || j.allow === true,", "      yes: j.fire === true || j.allow === true || j.wake === true,", 'ask yes')
    t = sub(t, "  } else if (i.reason === 'overflow') {",
            "  } else if (i.reason === 'wake') {\n"
            "    if (i.gapHours !== null && i.gapHours >= 1) {\n"
            "      lines.push(`距离他上次出现已经大约 ${i.gapHours} 小时${i.missedMeal ? '，中间还错过了饭点' : ''}。`);\n"
            "    }\n"
            "  } else if (i.reason === 'overflow') {", 'buildNote wake')
    t = sub(t, "  taskId?: string;\n}): Promise<GateAction> => {",
            "  taskId?: string;\n"
            "  /** 心跳任务：问 /wake（只做睡觉 / 刚聊完 / 深夜这类熔断，说不说由角色自己定）。 */\n"
            "  isHeartbeat?: boolean;\n"
            "  /** 角色已经主动找过他几次、他都没回（让提示词收着点）。 */\n"
            "  unansweredSends?: number;\n"
            "}): Promise<GateAction> => {", 'decideGate 参数')
    t = sub(t, "  const waited = opts.nowMs - opts.occurrenceMs;\n\n  if (opts.isWatch) {",
            "  const waited = opts.nowMs - opts.occurrenceMs;\n\n"
            "  if (opts.isHeartbeat) {\n"
            "    // 下一次已经排好了，所以这里放心 skip；服务连不上就不醒（宁可少醒，也别半夜盲调模型）。\n"
            "    const a = await ask('/wake', opts.lastUserMessageAt, opts.unansweredSends);\n"
            "    if (!a.ok) return { kind: 'skip', why: 'wake-gate-down' };\n"
            "    if (!a.yes) return { kind: 'skip', why: `wake-skip:${a.info.reason}` };\n"
            "    rememberNote(opts.taskId ?? '', buildNote(a.info), opts.nowMs);\n"
            "    return { kind: 'pass', why: 'wake' };\n"
            "  }\n\n"
            "  if (opts.isWatch) {", 'decideGate 心跳分支')
    t = t.rstrip('\n') + '\n' + GATE_APPEND
    GATE.write_text(t, encoding='utf-8')
    print('triggerGate.ts：已打补丁')


# ───────────────────────── index.ts ─────────────────────────
INDEX_CHAIN = r'''    // 心跳：先把 30 分钟后的下一次排好（这一轮沉默、跳过、失败，链都不会断），再往下走各道闸。
    // 放在"关了主动消息 2.0"那道跳过之后：用户关掉 2.0 就不再续链。
    const isHb = !instant && isHeartbeatTask(
      taskMeta.amsgTaskInstruction,
      (taskBrief as { promptHint?: unknown } | null | undefined)?.promptHint,
    );
    if (isHb) {
      const hbNext = await scheduleNextHeartbeat({
        scheduleTask: ctx.scheduleTask,
        charId,
        occurrenceMs,
        nowMs,
        tzId: pack.tzId,
        instruction: taskMeta.amsgTaskInstruction,
      });
      console.log('[amsg:heartbeat]', { taskId: ctx.task.id, next: hbNext });
    }

'''

INDEX_SILENT = r'''
    // 心跳那一轮里角色只回了 [沉默]：这一轮不发（下一次已经排好了）。
    if (isSilentHeartbeat(ctx.scratch, content)) {
      return { decision: 'skip-push', reason: 'heartbeat-silent' } as const;
    }
'''


def patch_index():
    t = INDEX.read_text(encoding='utf-8')
    if 'scheduleNextHeartbeat' in t:
        print('index.ts：已打过补丁，跳过')
        return
    t = sub(t, "import { configureTriggerGate, decideGate, isWatchTask, takeGateNote } from './triggerGate';",
            "import {\n  configureTriggerGate,\n  decideGate,\n  flagHeartbeat,\n  heartbeatInstruction,\n  isHeartbeatTask,\n"
            "  isSilentHeartbeat,\n  isWatchTask,\n  scheduleNextHeartbeat,\n  takeGateNote,\n} from './triggerGate';", 'import')
    t = sub(t, "    const maxUnansweredSends = limits.maxUnansweredSends;\n",
            INDEX_CHAIN + "    const maxUnansweredSends = limits.maxUnansweredSends;\n", '链排程插入点')
    t = sub(t, "        taskId: String(ctx.task.id ?? ''),\n      });\n",
            "        taskId: String(ctx.task.id ?? ''),\n        isHeartbeat: isHb,\n        unansweredSends: countUnansweredSends(selfLog),\n      });\n", 'gate 调用')
    t = sub(t, "      if (gate.kind === 'skip') return { skip: true } as const;\n",
            "      if (gate.kind === 'skip') return { skip: true } as const;\n      if (isHb && gate.kind === 'pass') flagHeartbeat(ctx.scratch);\n", 'gate 放行标记')
    t = sub(t, "renderFirePack(pack, ctx.now.getTime(), taskMeta.amsgTaskInstruction as string, {",
            "renderFirePack(pack, ctx.now.getTime(), (isHb ? heartbeatInstruction() : taskMeta.amsgTaskInstruction) as string, {", '提示词指令')
    t = sub(t, "    const content = stripReasoningTags(ctx.llmOutputText || '').trim();\n",
            "    const content = stripReasoningTags(ctx.llmOutputText || '').trim();\n" + INDEX_SILENT, '沉默判定')
    INDEX.write_text(t, encoding='utf-8')
    print('index.ts：已打补丁')


# ───────────────────────── server.js ─────────────────────────
SERVER_WAKE = r'''// 心跳醒来用：只做熔断（刚聊完 / 睡觉 / 深夜没动静 / 醒得太密 / 当天醒太多次），说不说由角色自己定。
export function wake(now, commit, unanswered) {
  const t = local(now);
  const items = liveItems(now);
  const act = (arr, min) => arr.filter((x) => now - x < min * MIN).length;
  const no = (reason) => ({ wake: false, reason });
  if (S.lastChat && (now - S.lastChat) / MIN < CFG.chatCooldownMin) return no('fuse:post-chat-cooldown');
  if (S.sleeping && now - S.sleepAt < 12 * HOUR) return no('fuse:sleeping');
  if (inWin(t.min, CFG.nightStart, CFG.nightEnd) && act(S.phoneActs, 20) + act(S.pcActs, 20) === 0) return no('fuse:night-quiet');
  if (S.lastWake && (now - S.lastWake) / MIN < CFG.wakeMinGapMin) return no('fuse:wake-gap');
  const wakes = S.wakes?.day === t.day ? S.wakes.n : 0;
  if (wakes >= CFG.maxWakesPerDay) return no('fuse:wake-daily-cap');
  const seen = Math.max(S.lastChat, S.lastAct);
  const gapMin = seen ? (now - seen) / MIN : 0;
  const mealBetween = seen && (gapMin >= 1440 || CFG.meals.some((m) => (m - local(seen).min + 1440) % 1440 < gapMin));
  if (commit) { S.lastWake = now; S.wakes = { day: t.day, n: wakes + 1 }; save(); }
  return {
    wake: true, reason: 'wake', unanswered: Number.isFinite(unanswered) ? unanswered : S.unanswered,
    context: { gapHours: +(gapMin / 60).toFixed(1), localHour: t.hour, missedMeal: !!mealBetween, openItems: items.map((i) => i.text) },
  };
}

'''


def patch_server():
    t = SERVER.read_text(encoding='utf-8')
    if 'export function wake(' in t:
        print('server.js：已打过补丁，跳过')
        return
    t = sub(t, "  maxAiItems: +(env.MAX_AI_ITEMS || 8),         // TA 自己最多同时记几条\n",
            "  maxAiItems: +(env.MAX_AI_ITEMS || 8),         // TA 自己最多同时记几条\n"
            "  wakeMinGapMin: +(env.WAKE_MIN_GAP_MIN || 20), // 两次醒来至少隔多久（防起点任务和链撞在同一格）\n"
            "  maxWakesPerDay: +(env.MAX_WAKES_PER_DAY || 40), // 一天最多醒几次（每次醒来都可能调一次模型）\n", 'CFG')
    t = sub(t, "export function allow(now) {", SERVER_WAKE + "export function allow(now) {", 'wake 函数')
    t = sub(t, "  if ((parts[0] === 'gate' || parts[0] === 'allow') && req.method === 'POST') {",
            "  if ((parts[0] === 'gate' || parts[0] === 'allow' || parts[0] === 'wake') && req.method === 'POST') {", '路由条件')
    t = sub(t, "    return send(200, parts[0] === 'gate' ? decide(now, true) : allow(now));",
            "    return send(200, parts[0] === 'gate' ? decide(now, true) : parts[0] === 'wake' ? wake(now, true, +b.unanswered) : allow(now));", '路由处理')
    SERVER.write_text(t, encoding='utf-8')
    print('server.js：已打补丁')


if __name__ == '__main__':
    patch_gate()
    patch_index()
    patch_server()
