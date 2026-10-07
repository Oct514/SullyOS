/**
 * 触发闸：到点发之前，先问 Zeabur 上的判断服务（trigger-service）现在该不该发。
 *
 * - 守望任务（补充灵感里带 [守望]）：问 /gate。服务说"现在该找他"才发，否则每分钟再问；
 *   超过窗口还没触发就放弃这一次（重复任务会自动排到下一次，不影响明天）。
 * - 其余非即时任务（比如 TA 睡前给自己排的早安）：问 /allow。他还在睡觉（睡眠专注开着）就推迟，
 *   起床后再发。这里**只能 defer，不能 skip**——skip 会把一次性任务消费掉。
 * - 没配 TRIGGER_URL / TRIGGER_TOKEN：完全不介入，行为和以前一样。
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

type Answer = { ok: true; yes: boolean; reason: string } | { ok: false };

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
    const j = (await res.json()) as { fire?: unknown; allow?: unknown; reason?: unknown };
    return { ok: true, yes: j.fire === true || j.allow === true, reason: typeof j.reason === 'string' ? j.reason : '' };
  } catch {
    return { ok: false };
  } finally {
    clearTimeout(timer);
  }
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
}): Promise<GateAction> => {
  if (!cfg) return { kind: 'pass', why: 'gate-off' };
  if (opts.instant) return { kind: 'pass', why: 'instant' };
  const waited = opts.nowMs - opts.occurrenceMs;

  if (opts.isWatch) {
    if (waited > WATCH_WINDOW_MS) return { kind: 'skip', why: 'watch-window-over' };
    const a = await ask('/gate', opts.lastUserMessageAt);
    if (!a.ok) return { kind: 'defer', afterMs: GATE_DEFER_MS, why: 'gate-down' };
    return a.yes
      ? { kind: 'pass', why: `watch:${a.reason}` }
      : { kind: 'defer', afterMs: GATE_DEFER_MS, why: `watch-wait:${a.reason}` };
  }

  const a = await ask('/allow', opts.lastUserMessageAt);
  if (!a.ok) {
    return waited > SERVICE_DOWN_MAX_HOLD_MS
      ? { kind: 'pass', why: 'allow-down-release' }
      : { kind: 'defer', afterMs: GATE_DEFER_MS, why: 'allow-down' };
  }
  if (a.yes) return { kind: 'pass', why: 'allow' };
  return waited > ALLOW_MAX_HOLD_MS
    ? { kind: 'pass', why: `allow-max-hold:${a.reason}` }
    : { kind: 'defer', afterMs: GATE_DEFER_MS, why: `allow-wait:${a.reason}` };
};
