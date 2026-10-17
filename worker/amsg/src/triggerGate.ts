/**
 * 触发闸：到点发之前，先问 Zeabur 上的判断服务（trigger-service）现在该不该发。
 *
 * - 守望任务（补充灵感里带 [守望]）：问 /gate。服务说"现在该找她"才发，否则每分钟再问；
 *   超过窗口还没触发就放弃这一次（重复任务会自动排到下一次，不影响明天）。
 * - 其余非即时任务（比如 TA 睡前给自己排的早安）：问 /allow。她还在睡觉（睡眠专注开着）就推迟，
 *   起床后再发。这里**只能 defer，不能 skip**——skip 会把一次性任务消费掉。
 * - 没配 TRIGGER_URL / TRIGGER_TOKEN：完全不介入，行为和以前一样。
 *
 * 守望任务放行时，服务会说明"为什么该找她"（失联多久、念头、之前几次没回），
 * 这里把它整理成一小段提示，等 onBeforeFire 拼提示词时用 takeGateNote(taskId) 取走，让 TA 知道为什么想找她。
 *
 * 判断服务连不上时：守望任务推迟（到窗口结束自然放弃），普通任务最多多等 15 分钟就放行，
 * 绝不让早安因为服务挂了而丢。
 */

export const WATCH_MARK = '[守望]';
/** 守望窗口：名义触发时刻之后多久还没等到"该找她"，就放弃这一次。 */
export const WATCH_WINDOW_MS = 90 * 60_000;
/** 普通任务因为"在睡觉 / 刚聊完"最多被推迟多久，超过就放行（不让消息丢）。 */
export const ALLOW_MAX_HOLD_MS = 3 * 3_600_000;
/** 判断服务连不上时，普通任务最多多等多久就放行。 */
export const SERVICE_DOWN_MAX_HOLD_MS = 15 * 60_000;
/** 每次推迟多久再问。 */
export const GATE_DEFER_MS = 60_000;
const REQUEST_TIMEOUT_MS = 4_000;

let cfg: { url: string; token: string } | null = null;

/** 在 buildWorkerConfig 里调用一次，把 Worker 环境变量交进来。两个都配了才启用。 */
export const configureTriggerGate = (env: { TRIGGER_URL?: string; TRIGGER_TOKEN?: string }): void => {
  const url = env.TRIGGER_URL?.trim().replace(/\/+$/, '');
  const token = env.TRIGGER_TOKEN?.trim();
  cfg = url && token ? { url, token } : null;
};

/** 任务指令或补充灵感里带 [守望] 就是守望任务。 */
export const isWatchTask = (...texts: Array<unknown>): boolean =>
  texts.some((t) => typeof t === 'string' && t.includes(WATCH_MARK));

type GateInfo = {
  reason: string;
  unanswered: number;
  gapHours: number | null;
  localHour: number | null;
  missedMeal: boolean;
  asleep: boolean;
  wakeId: number | null;
  why: string | null;
  openItems: string[];
};
type Answer = { ok: true; yes: boolean; info: GateInfo } | { ok: false };

const ask = async (
  endpoint: '/gate' | '/allow' | '/wake',
  lastUserMessageAt: number | null,
  unanswered?: number,
  lastSelfSendAt?: number | null,
): Promise<Answer> => {
  if (!cfg) return { ok: false };
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(`${cfg.url}${endpoint}`, {
      method: 'POST',
      headers: { 'X-Token': cfg.token, 'content-type': 'application/json' },
      body: JSON.stringify({
        lastUserMessageAt,
        ...(typeof unanswered === 'number' ? { unanswered } : {}),
        ...(typeof lastSelfSendAt === 'number' ? { lastSelfSendAt } : {}),
      }),
      signal: ctrl.signal,
    });
    if (!res.ok) return { ok: false };
    const j = (await res.json()) as {
      fire?: unknown;
      allow?: unknown;
      wake?: unknown;
      id?: unknown;
      reason?: unknown;
      unanswered?: unknown;
      context?: {
        gapHours?: unknown;
        localHour?: unknown;
        missedMeal?: unknown;
        asleep?: unknown;
        why?: unknown;
        openItems?: unknown;
      } | null;
    };
    const c = j.context ?? {};
    return {
      ok: true,
      yes: j.fire === true || j.allow === true || j.wake === true,
      info: {
        reason: typeof j.reason === 'string' ? j.reason : '',
        unanswered: typeof j.unanswered === 'number' ? j.unanswered : 0,
        gapHours: typeof c.gapHours === 'number' ? c.gapHours : null,
        localHour: typeof c.localHour === 'number' ? c.localHour : null,
        missedMeal: c.missedMeal === true,
        asleep: c.asleep === true,
        wakeId: typeof j.id === 'number' ? j.id : null,
        why: typeof c.why === 'string' ? c.why : null,
        openItems: Array.isArray(c.openItems)
          ? c.openItems.filter((x): x is string => typeof x === 'string').slice(0, 5)
          : [],
      },
    };
  } catch {
    return { ok: false };
  } finally {
    clearTimeout(timer);
  }
};

/** 把服务给的"为什么该找她"整理成一小段提示，接在提示词末尾。没有可说的就返回空串。 */
const buildNote = (i: GateInfo): string => {
  const lines: string[] = [];
  if (i.reason === 'long-silence') {
    lines.push(
      i.gapHours !== null
        ? `她已经大约 ${i.gapHours} 小时没有消息、也没见到她的动静了${i.missedMeal ? '，中间还错过了饭点' : ''}。`
        : '她已经很久没有消息了。',
    );
  } else if (i.reason === 'late-night-active') {
    lines.push('这么晚了，她的手机或电脑还一直有动静，像是还没睡。');
  } else if (i.reason === 'wake') {
    if (i.why === 'miss') lines.push('你这阵子一直惦记着她，想她的念头攒满了。');
    if (i.why === 'thought') lines.push('你之前记下的事，该跟进一下了。');
    if (i.why === 'random') {
      lines.push('没有特别的原因，只是例行醒来：你可以随意逛逛、看看她的动静，或者做点自己想做的事。');
    }
    if (i.gapHours !== null && i.gapHours >= 1) {
      lines.push(`距离她上次出现已经大约 ${i.gapHours} 小时${i.missedMeal ? '，中间还错过了饭点' : ''}。`);
    }
  } else if (i.reason === 'overflow') {
    lines.push('你这阵子一直惦记着她，想她的念头攒满了。');
  }
  if (i.asleep) {
    lines.push(
      '服务这边的记录显示她可能在睡觉（深夜没有手机动静，或睡眠专注开着），这只是推测，她到底醒着还是睡着，你可以用自己查手机的工具确认。'
        + '如果她像是睡着了，别发消息吵醒她，除非真的有急事。'
        + '这段时间是你自己的：可以思考、查资料、联网、用工具做点自己想做的事；想跟她说的话先记下来（有记念头的工具就用它），留到她醒了再说。'
        + '不发消息的话，整段输出只写 [[SILENT]]。',
    );
  }
  if (i.localHour !== null) lines.push(`她那边现在大约是 ${i.localHour} 点。`);
  if (i.openItems.length) lines.push(`你心里还挂着这些事：${i.openItems.join('；')}。`);
  if (i.unanswered > 0) {
    lines.push(`你之前已经主动找过她 ${i.unanswered} 次，她都还没回。这次语气收着点，别追问，也别重复上次说过的话。`);
  }
  if (i.reason === 'wake') {
    lines.push('如果这次醒来做了点什么（查了什么、想到了什么），用 write_diary 记一两句，她在「醒来记录」里能看到。');
  }
  if (!lines.length) return '';
  if (i.reason === 'wake') {
    return `\n\n【此刻的情况（只供你参考）】\n${lines.map((l) => `- ${l}`).join('\n')}\n这些只是背景，说不说、做不做都由你定；不要提"系统""判断""阈值"这类词，也不要把上面的话原样念出来。`;
  }
  return `\n\n【这次你为什么想找她（只供你参考）】\n${lines.map((l) => `- ${l}`).join('\n')}\n请自然地把这份心情带进你要说的话里；不要提"系统""判断""阈值"这类词，也不要把上面的话原样念出来。`;
};

const NOTE_TTL_MS = 10 * 60_000;
const notes = new Map<string, { text: string; at: number }>();

const rememberNote = (taskId: string, text: string, nowMs: number): void => {
  for (const [k, v] of notes) if (nowMs - v.at > NOTE_TTL_MS) notes.delete(k);
  if (taskId && text) notes.set(taskId, { text, at: nowMs });
  else if (taskId) notes.delete(taskId);
};

/** 取走（并清掉）这个任务本次放行时留下的"为什么找她"提示；没有就是空串。拼提示词时接在末尾。 */
export const takeGateNote = (taskId: string): string => {
  const n = notes.get(taskId);
  notes.delete(taskId);
  return n && Date.now() - n.at < NOTE_TTL_MS ? n.text : '';
};

export type GateAction =
  | { kind: 'pass'; why: string; wakeId?: number | null }
  | { kind: 'defer'; afterMs: number; why: string }
  | { kind: 'skip'; why: string };

export const decideGate = async (opts: {
  instant: boolean;
  isWatch: boolean;
  occurrenceMs: number;
  nowMs: number;
  lastUserMessageAt: number | null;
  /** 任务 id，用来把"为什么找她"的提示交给后面拼提示词的地方。 */
  taskId?: string;
  /** 心跳任务：问 /wake（只做睡觉 / 刚聊完 / 深夜这类熔断，说不说由角色自己定）。 */
  isHeartbeat?: boolean;
  /** 角色已经主动找过她几次、她都没回（让提示词收着点）。 */
  unansweredSends?: number;
  /** 角色最近一次主动发出去的时刻（没有就不传）。 */
  lastSelfSendAt?: number | null;
}): Promise<GateAction> => {
  if (!cfg) return { kind: 'pass', why: 'gate-off' };
  if (opts.instant) return { kind: 'pass', why: 'instant' };
  const waited = opts.nowMs - opts.occurrenceMs;

  if (opts.isHeartbeat) {
    // 下一次已经排好了，所以这里放心 skip；服务连不上就不醒（宁可少醒，也别半夜盲调模型）。
    const a = await ask('/wake', opts.lastUserMessageAt, opts.unansweredSends, opts.lastSelfSendAt);
    if (!a.ok) return { kind: 'skip', why: 'wake-gate-down' };
    if (!a.yes) return { kind: 'skip', why: `wake-skip:${a.info.reason}` };
    rememberNote(opts.taskId ?? '', buildNote(a.info), opts.nowMs);
    return { kind: 'pass', why: 'wake', wakeId: a.info.wakeId };
  }

  if (opts.isWatch) {
    if (waited > WATCH_WINDOW_MS) return { kind: 'skip', why: 'watch-window-over' };
    const a = await ask('/gate', opts.lastUserMessageAt);
    if (!a.ok) return { kind: 'defer', afterMs: GATE_DEFER_MS, why: 'gate-down' };
    if (a.yes) {
      rememberNote(opts.taskId ?? '', buildNote(a.info), opts.nowMs);
      return { kind: 'pass', why: `watch:${a.info.reason}` };
    }
    return { kind: 'defer', afterMs: GATE_DEFER_MS, why: `watch-wait:${a.info.reason}` };
  }

  const a = await ask('/allow', opts.lastUserMessageAt);
  if (!a.ok) {
    return waited > SERVICE_DOWN_MAX_HOLD_MS
      ? { kind: 'pass', why: 'allow-down-release' }
      : { kind: 'defer', afterMs: GATE_DEFER_MS, why: 'allow-down' };
  }
  if (a.yes) return { kind: 'pass', why: 'allow' };
  return waited > ALLOW_MAX_HOLD_MS
    ? { kind: 'pass', why: `allow-max-hold:${a.info.reason}` }
    : { kind: 'defer', afterMs: GATE_DEFER_MS, why: `allow-wait:${a.info.reason}` };
};

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
  '这是一次例行的醒来，不是有事要交代，也没有谁在催你。要不要开口、要不要先做点事，由你自己决定，规则见下面的【例行醒来】。';

const HB_SPEAK_BLOCK = [
  '【例行醒来】',
  '这是一次例行的醒来，不是有什么事非要你开口。先对照上面的【最近对话上下文】、你之前发过的话和她的近况。',
  '默认是不说。只有真的有想对她说的话才开口，比如：',
  '- 你惦记着她的某件事（她提过的约定、没聊完的话题、你担心的事），想问问或提一句；',
  '- 她很久没出现，你确实想她了、想知道她在干嘛；',
  '- 你有件小事想跟她分享，而且这会儿说不会打扰她。',
  '拿不准就不说。你上一条主动发的她还没回的话，别重复同样的话；如果有新的、想说的事，可以接着说。刚聊完又没有新东西，就别硬找话说。',
  '想先做点事（看看她的动静、记下惦记的事）就去做；做完没有想说的，同样不说。',
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

const HB_SCRATCH_KEY = '__heartbeat';

const HB_WAKE_ID_KEY = '__hbWakeId';
const HB_TOOLS_KEY = '__hbTools';

/** 放行后在这一次 fire 的 scratch 上做个记号（并记下这次醒来的编号），onLLMOutput 靠它认出"这是心跳那一轮"。 */
export const flagHeartbeat = (scratch: Record<string, unknown> | undefined, wakeId?: number | null): void => {
  if (!scratch) return;
  scratch[HB_SCRATCH_KEY] = true;
  if (typeof wakeId === 'number') scratch[HB_WAKE_ID_KEY] = wakeId;
};

/** 心跳那一轮里，模型这一圈要调的工具名（多圈累加），结束时一起回报。 */
export const noteHeartbeatTools = (scratch: Record<string, unknown> | undefined, names: string[]): void => {
  if (!scratch || scratch[HB_SCRATCH_KEY] !== true) return;
  const prev = Array.isArray(scratch[HB_TOOLS_KEY]) ? (scratch[HB_TOOLS_KEY] as string[]) : [];
  scratch[HB_TOOLS_KEY] = [...prev, ...names].slice(0, 20);
};

/** 心跳那一轮结束时把结果回报给 Zeabur（给「醒来记录」看）。失败只吞掉，绝不影响发送。 */
export const reportHeartbeat = async (
  scratch: Record<string, unknown> | undefined,
  result: { outcome: string; reason?: string; text?: string },
): Promise<void> => {
  if (!cfg || !scratch || scratch[HB_SCRATCH_KEY] !== true) return;
  const wakeId = scratch[HB_WAKE_ID_KEY];
  if (typeof wakeId !== 'number') return;
  const tools = Array.isArray(scratch[HB_TOOLS_KEY]) ? (scratch[HB_TOOLS_KEY] as string[]) : [];
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 3_000);
  try {
    await fetch(`${cfg.url}/wake/result`, {
      method: 'POST',
      headers: { 'X-Token': cfg.token, 'content-type': 'application/json' },
      body: JSON.stringify({ wakeId, ...result, tools }),
      signal: ctrl.signal,
    });
  } catch {
    // 回报不到就算了
  } finally {
    clearTimeout(timer);
  }
};

const SILENT_RE = /^[\[【(（]\s*沉默\s*[\]】)）][。.!！\s]*$/;

/** 心跳那一轮里，角色只回了 [沉默]：这一轮不发。 */
export const isSilentHeartbeat = (scratch: Record<string, unknown> | undefined, content: string): boolean =>
  scratch?.[HB_SCRATCH_KEY] === true && SILENT_RE.test(content.trim());
