/**
 * 触发闸：到点发之前，先问 Zeabur 上的判断服务（trigger-service）现在该不该发。
 *
 * - 守望任务（补充灵感里带 [守望]）：问 /gate。服务说"现在该找他"才发，否则每分钟再问；
 *   超过窗口还没触发就放弃这一次（重复任务会自动排到下一次，不影响明天）。
 * - 其余非即时任务（比如 TA 睡前给自己排的早安）：问 /allow。他还在睡觉（睡眠专注开着）就推迟，
 *   起床后再发。这里**只能 defer，不能 skip**——skip 会把一次性任务消费掉。
 * - 没配 TRIGGER_URL / TRIGGER_TOKEN：完全不介入，行为和以前一样。
 *
 * 守望任务放行时，服务会说明"为什么该找他"（失联多久、念头、之前几次没回），
 * 这里把它整理成一小段提示，等 onBeforeFire 拼提示词时用 takeGateNote(taskId) 取走，让 TA 知道为什么想找他。
 *
 * 判断服务连不上时：守望任务推迟（到窗口结束自然放弃），普通任务最多多等 15 分钟就放行，
 * 绝不让早安因为服务挂了而丢。
 */

export const WATCH_MARK = '[守望]';
/** 守望窗口：名义触发时刻之后多久还没等到"该找他"，就放弃这一次。 */
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
  openItems: string[];
};
type Answer = { ok: true; yes: boolean; info: GateInfo } | { ok: false };

const ask = async (endpoint: '/gate' | '/allow', lastUserMessageAt: number | null): Promise<Answer> => {
  if (!cfg) return { ok: false };
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(`${cfg.url}${endpoint}`, {
      method: 'POST',
      headers: { 'X-Token': cfg.token, 'content-type': 'application/json' },
      body: JSON.stringify({ lastUserMessageAt }),
      signal: ctrl.signal,
    });
    if (!res.ok) return { ok: false };
    const j = (await res.json()) as {
      fire?: unknown;
      allow?: unknown;
      reason?: unknown;
      unanswered?: unknown;
      context?: { gapHours?: unknown; localHour?: unknown; missedMeal?: unknown; openItems?: unknown } | null;
    };
    const c = j.context ?? {};
    return {
      ok: true,
      yes: j.fire === true || j.allow === true,
      info: {
        reason: typeof j.reason === 'string' ? j.reason : '',
        unanswered: typeof j.unanswered === 'number' ? j.unanswered : 0,
        gapHours: typeof c.gapHours === 'number' ? c.gapHours : null,
        localHour: typeof c.localHour === 'number' ? c.localHour : null,
        missedMeal: c.missedMeal === true,
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

/** 把服务给的"为什么该找他"整理成一小段提示，接在提示词末尾。没有可说的就返回空串。 */
const buildNote = (i: GateInfo): string => {
  const lines: string[] = [];
  if (i.reason === 'long-silence') {
    lines.push(
      i.gapHours !== null
        ? `他已经大约 ${i.gapHours} 小时没有消息、也没见到他的动静了${i.missedMeal ? '，中间还错过了饭点' : ''}。`
        : '他已经很久没有消息了。',
    );
  } else if (i.reason === 'late-night-active') {
    lines.push('这么晚了，他的手机或电脑还一直有动静，像是还没睡。');
  } else if (i.reason === 'overflow') {
    lines.push('你这阵子一直惦记着他，想他的念头攒满了。');
  }
  if (i.localHour !== null) lines.push(`他那边现在大约是 ${i.localHour} 点。`);
  if (i.openItems.length) lines.push(`你心里还挂着这些事：${i.openItems.join('；')}。`);
  if (i.unanswered > 0) {
    lines.push(`你之前已经主动找过他 ${i.unanswered} 次，他都还没回。这次语气收着点，别追问，也别重复上次说过的话。`);
  }
  if (!lines.length) return '';
  return `\n\n【这次你为什么想找他（只供你参考）】\n${lines.map((l) => `- ${l}`).join('\n')}\n请自然地把这份心情带进你要说的话里；不要提"系统""判断""阈值"这类词，也不要把上面的话原样念出来。`;
};

const NOTE_TTL_MS = 10 * 60_000;
const notes = new Map<string, { text: string; at: number }>();

const rememberNote = (taskId: string, text: string, nowMs: number): void => {
  for (const [k, v] of notes) if (nowMs - v.at > NOTE_TTL_MS) notes.delete(k);
  if (taskId && text) notes.set(taskId, { text, at: nowMs });
  else if (taskId) notes.delete(taskId);
};

/** 取走（并清掉）这个任务本次放行时留下的"为什么找他"提示；没有就是空串。拼提示词时接在末尾。 */
export const takeGateNote = (taskId: string): string => {
  const n = notes.get(taskId);
  notes.delete(taskId);
  return n && Date.now() - n.at < NOTE_TTL_MS ? n.text : '';
};

export type GateAction =
  | { kind: 'pass'; why: string }
  | { kind: 'defer'; afterMs: number; why: string }
  | { kind: 'skip'; why: string };

export const decideGate = async (opts: {
  instant: boolean;
  isWatch: boolean;
  occurrenceMs: number;
  nowMs: number;
  lastUserMessageAt: number | null;
  /** 任务 id，用来把"为什么找他"的提示交给后面拼提示词的地方。 */
  taskId?: string;
}): Promise<GateAction> => {
  if (!cfg) return { kind: 'pass', why: 'gate-off' };
  if (opts.instant) return { kind: 'pass', why: 'instant' };
  const waited = opts.nowMs - opts.occurrenceMs;

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
