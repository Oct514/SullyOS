/**
 * 定时唤醒（"后台生活"）：不聊天时，按时间窗口 + 概率决定要不要给角色一次自由发挥的机会。
 *
 * 判断本身是纯函数、不碰浏览器状态以外的东西，方便单测；真正触发生成/排程那一步由调用方
 * 注入（见 maybeTriggerLifeWake 的 scheduleTask 参数）。这个文件不 import activeMsgClient
 * 或任何 CharacterProfile 之类的应用类型，只认 charId 这个字符串——判断逻辑和排程接口的
 * 具体形状不焊死在一起，以后排程那边怎么改都不会牵连到这儿。
 *
 * v1 范围：只做「要不要现在唤醒」的判断 + 给一句方向提示 + 记一份技术日志（唤醒日志
 * App 读这份日志）。唤醒之后走的是已有的主动消息生成流程（mode='prompted'，同样能用
 * 工具），不是另开一条通道；这次唤醒最终会不会真的发出一条消息，由那条流程自己判断——
 * 这里只负责「要不要去问一次」，不负责「问完必须说话」。
 *
 * 已接入 context/OSContext.tsx：每 WAKE_CHECK_INTERVAL_MS 对每个开了「主动消息2.0」的
 * 角色跑一遍 maybeTriggerLifeWake。
 */

/** 每个角色的唤醒状态，存在 localStorage，key 里带 charId，值只有一个时间戳。 */
interface LifeWakeState {
  /** 上一次唤醒是什么时候（epoch ms）。0 = 从没唤醒过。 */
  lastWakeAt: number;
}

const STATE_KEY = (charId: string) => `lifeWake_state_${charId}`;

export const readLifeWakeState = (charId: string): LifeWakeState => {
  try {
    const raw = localStorage.getItem(STATE_KEY(charId));
    if (!raw) return { lastWakeAt: 0 };
    const parsed = JSON.parse(raw);
    return { lastWakeAt: typeof parsed?.lastWakeAt === 'number' ? parsed.lastWakeAt : 0 };
  } catch {
    return { lastWakeAt: 0 };
  }
};

export const markLifeWaked = (charId: string, at: number): void => {
  try {
    localStorage.setItem(STATE_KEY(charId), JSON.stringify({ lastWakeAt: at } satisfies LifeWakeState));
  } catch {
    /* 存不下就下次判断窗口再判一遍，最多多唤醒一次，不是致命问题 */
  }
};

// ─── 唤醒概率 ───

/** 两次唤醒之间最少隔多久，防止判断跑得勤就把角色吵得很勤。 */
export const MIN_WAKE_INTERVAL_MS = 90 * 60_000; // 90 分钟

/** 判断窗口建议值：够久没醒的角色，调用方大概多久检查一次「现在要不要醒」。 */
export const WAKE_CHECK_INTERVAL_MS = 15 * 60_000; // 15 分钟

/** 白天（本地 6:00-24:00）单次判断的命中概率。 */
const DAY_WAKE_CHANCE = 0.12;
/** 夜里（本地 0:00-6:00）单次判断的命中概率，明显调低，别半夜把人吵醒。 */
const NIGHT_WAKE_CHANCE = 0.04;

const isNightHour = (hour: number): boolean => hour >= 0 && hour < 6;

/** 是否已经过了「冷却期」，到了可以认真判断一次的时间点（不管概率结果如何）。 */
export const isWakeDue = (now: Date, lastWakeAt: number): boolean =>
  now.getTime() - lastWakeAt >= MIN_WAKE_INTERVAL_MS;

const rollHits = (now: Date, roll: number): boolean => {
  const chance = isNightHour(now.getHours()) ? NIGHT_WAKE_CHANCE : DAY_WAKE_CHANCE;
  return roll < chance;
};

/**
 * 这一次判断该不该唤醒（= 过了冷却期 且 概率骰中）。
 *
 * @param now 当前时间
 * @param lastWakeAt 上次唤醒的时间戳（0 = 从没醒过）
 * @param roll 0..1 的随机数；测试时传固定值，正常调用不传，内部用 Math.random()
 */
export const shouldWakeNow = (
  now: Date,
  lastWakeAt: number,
  roll: number = Math.random(),
): boolean => isWakeDue(now, lastWakeAt) && rollHits(now, roll);

// ─── 方向提示 ───

/**
 * 给到点生成流程的方向提示（mode='prompted' 时的 promptHint）。
 *
 * 刻意不要求「必须说话」：唤醒只是给一次自由活动的机会，说不说、说什么交给生成流程自己
 * 判断（它能调用工具去查东西，也可以这次什么都不发）。写得太硬性（"必须联系用户"）只会
 * 导致每次唤醒都硬凑一句无意义的话，跟这次改造想解决的问题背道而驰。
 */
export const LIFE_WAKE_PROMPT_HINT = [
  '现在是你的自由时间，不是在回复谁。',
  '你可以做任何这会儿想做的事——用手上的工具去查点感兴趣的东西、随便逛逛，',
  '或者什么都不做，安安静静待一会儿。',
  '不必硬找话题联系对方：只有当你真的有想说的、或者做了什么想告诉 ta 的事，才开口；',
  '没有的话，写一两句简短的自言自语就够了，不必长篇大论。',
].join('');

export interface TriggerLifeWakeResult {
  triggered: boolean;
  reason: 'scheduled' | 'not-due' | 'missed' | 'schedule-failed';
}

// ─── 唤醒日志（唤醒日志 App 读这份；技术记录，不是角色说了什么） ───

const LOG_KEY = 'lifeWake_log';
/** 日志条数上限，超出后丢最旧的；纯调试用途，不需要无限堆积。 */
const LOG_MAX_ENTRIES = 200;

export type LifeWakeLogReason = 'triggered' | 'missed' | 'schedule-failed';

export interface LifeWakeLogEntry {
  charId: string;
  /** 本次判断的时间戳（epoch ms）。 */
  at: number;
  reason: LifeWakeLogReason;
}

const isLifeWakeLogReason = (v: unknown): v is LifeWakeLogReason =>
  v === 'triggered' || v === 'missed' || v === 'schedule-failed';

const isLifeWakeLogEntry = (v: any): v is LifeWakeLogEntry =>
  !!v && typeof v.charId === 'string' && typeof v.at === 'number' && isLifeWakeLogReason(v.reason);

const readAllLogEntriesRaw = (): LifeWakeLogEntry[] => {
  try {
    const raw = localStorage.getItem(LOG_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter(isLifeWakeLogEntry) : [];
  } catch {
    return [];
  }
};

const appendLifeWakeLog = (entry: LifeWakeLogEntry): void => {
  try {
    const list = readAllLogEntriesRaw();
    list.push(entry);
    const trimmed = list.length > LOG_MAX_ENTRIES ? list.slice(list.length - LOG_MAX_ENTRIES) : list;
    localStorage.setItem(LOG_KEY, JSON.stringify(trimmed));
  } catch {
    /* 日志写不进去就算了，只影响「唤醒日志」App 的展示，不影响判断/触发本身 */
  }
};

/** 读取唤醒日志，按时间倒序（最新的在最前）。传 charId 只看某个角色的。 */
export const readLifeWakeLog = (charId?: string): LifeWakeLogEntry[] => {
  const all = readAllLogEntriesRaw();
  const filtered = charId ? all.filter((e) => e.charId === charId) : all;
  return filtered.slice().sort((a, b) => b.at - a.at);
};

/** 清空唤醒日志。传 charId 只清那个角色的，不传清全部。 */
export const clearLifeWakeLog = (charId?: string): void => {
  try {
    if (!charId) {
      localStorage.removeItem(LOG_KEY);
      return;
    }
    const remaining = readAllLogEntriesRaw().filter((e) => e.charId !== charId);
    localStorage.setItem(LOG_KEY, JSON.stringify(remaining));
  } catch {
    /* 忽略：清不掉就留着，不是致命问题 */
  }
};

/**
 * 判断 + （命中的话）真正触发一次；全程往 LifeWakeLog 里记一笔——除了「还在冷却期」
 * 这种高频、不值得看的情况（15 分钟一次全角色跑，冷却期内每次都记会把日志刷满噪音）。
 *
 * @param scheduleTask 真正去排程/生成的函数，由调用方注入——拿的是当下的角色配置、
 *   用户资料这些，这个文件完全不关心它们的具体类型。
 */
export const maybeTriggerLifeWake = async (args: {
  charId: string;
  now?: Date;
  scheduleTask: (promptHint: string) => Promise<void>;
}): Promise<TriggerLifeWakeResult> => {
  const now = args.now ?? new Date();
  const { lastWakeAt } = readLifeWakeState(args.charId);

  if (!isWakeDue(now, lastWakeAt)) {
    return { triggered: false, reason: 'not-due' };
  }

  if (!rollHits(now, Math.random())) {
    appendLifeWakeLog({ charId: args.charId, at: now.getTime(), reason: 'missed' });
    return { triggered: false, reason: 'missed' };
  }

  try {
    await args.scheduleTask(LIFE_WAKE_PROMPT_HINT);
  } catch (error) {
    // 排程失败不标记「已唤醒」：下一个判断窗口还会再试一次，别因为一次网络抖动
    // 就把这个角色晾整整一个 MIN_WAKE_INTERVAL_MS。
    console.warn('[lifeWake] 排程失败，下次判断窗口再试', args.charId, error);
    appendLifeWakeLog({ charId: args.charId, at: now.getTime(), reason: 'schedule-failed' });
    return { triggered: false, reason: 'schedule-failed' };
  }
  markLifeWaked(args.charId, now.getTime());
  appendLifeWakeLog({ charId: args.charId, at: now.getTime(), reason: 'triggered' });
  return { triggered: true, reason: 'scheduled' };
};
