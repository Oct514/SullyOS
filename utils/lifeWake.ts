/**
 * 定时唤醒（"后台生活"）：不聊天时，按时间窗口 + 概率决定要不要给角色一次自由发挥的机会。
 *
 * 判断本身是纯函数、不碰浏览器状态以外的东西，方便单测；真正触发生成/排程那一步由调用方
 * 注入（见 maybeTriggerLifeWake 的 scheduleTask 参数）。这个文件不 import activeMsgClient
 * 或任何 CharacterProfile 之类的应用类型，只认 charId 这个字符串——判断逻辑和排程接口的
 * 具体形状不焊死在一起，以后排程那边怎么改都不会牵连到这儿。
 *
 * v1 范围：只做「要不要现在唤醒」的判断 + 给一句方向提示。唤醒之后走的是已有的主动消息
 * 生成流程（mode='prompted'，同样能用工具），不是另开一条通道；这次唤醒最终会不会真的
 * 发出一条消息，由那条流程自己判断——这里只负责「要不要去问一次」，不负责「问完必须说话」。
 *
 * 还没接进 App 里跑：这个文件目前只是待接入的判断逻辑 + 单测，真正的定时调用（多久 tick
 * 一次、从哪个组件的哪个角色列表跑）留在下一步一起接，避免这一步就动现有组件。
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

/**
 * 这一次判断该不该唤醒。
 *
 * @param now 当前时间
 * @param lastWakeAt 上次唤醒的时间戳（0 = 从没醒过）
 * @param roll 0..1 的随机数；测试时传固定值，正常调用不传，内部用 Math.random()
 */
export const shouldWakeNow = (
  now: Date,
  lastWakeAt: number,
  roll: number = Math.random(),
): boolean => {
  if (now.getTime() - lastWakeAt < MIN_WAKE_INTERVAL_MS) return false;
  const chance = isNightHour(now.getHours()) ? NIGHT_WAKE_CHANCE : DAY_WAKE_CHANCE;
  return roll < chance;
};

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
  reason: 'scheduled' | 'not-due' | 'schedule-failed';
}

/**
 * 判断 + （命中的话）真正触发一次。
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
  if (!shouldWakeNow(now, lastWakeAt)) {
    return { triggered: false, reason: 'not-due' };
  }
  try {
    await args.scheduleTask(LIFE_WAKE_PROMPT_HINT);
  } catch (error) {
    // 排程失败不标记「已唤醒」：下一个判断窗口还会再试一次，别因为一次网络抖动
    // 就把这个角色晾整整一个 MIN_WAKE_INTERVAL_MS。
    console.warn('[lifeWake] 排程失败，下次判断窗口再试', args.charId, error);
    return { triggered: false, reason: 'schedule-failed' };
  }
  markLifeWaked(args.charId, now.getTime());
  return { triggered: true, reason: 'scheduled' };
};
