/**
 * 定时唤醒（"后台生活"）：不聊天时，由欲望驱动状态机（见 utils/desireSystem.ts）决定要不要
 * 给角色一次自由发挥的机会。
 *
 * 这个文件现在是「欲望状态机」和「主动消息排程」之间的胶水层：每次检查先让状态机推进一拍
 * （desireSystem.tickDesire），算出此刻最该发作的维度，分数够了才真的去排程；排程成功后
 * 调 desireSystem.satisfyAfterAction 让相关维度回落。判断逻辑本身（状态机那部分）在
 * desireSystem.ts 里是纯函数、有自己的单测；这个文件只负责「要不要去问一次」+ 跟外部排程
 * 接口对接 + 记日志，依然不 import activeMsgClient 或任何 CharacterProfile 之类的应用类型，
 * 只认 charId 这个字符串。
 *
 * 对外接口形状基本没变（maybeTriggerLifeWake 多了一个可选的 personaText 参数，不传就是
 * 旧行为），所以接入 context/OSContext.tsx 的那段代码大体不用跟着改——只有想真正用上
 * 「按人设调整驱动速度」这个新功能时，才需要在调用处多传一个 personaText。
 *
 * v1 范围：唤醒之后走的还是已有的主动消息生成流程（mode='prompted'，能用工具），不是
 * 另开一条通道；这次唤醒最终会不会真的发出一条消息，由那条流程自己判断——这里只负责
 * 「要不要去问一次」+「往哪个方向问」，不负责「问完必须说话」。
 *
 * ⚠️ WAKE_CHECK_INTERVAL_MS 和 desireSystem 里的分数门槛/上升速度目前都是「测试档」，为了
 * 在部署出来的测试站上几分钟内就能看到效果调快了。正式长期使用前应该放慢，不然角色会醒得
 * 过于频繁。
 */

import {
  tickDesire,
  satisfyAfterAction,
  relieveAfterGatedRest,
  HINT_FOR_DRIVE,
  WAKE_SCORE_THRESHOLD,
  type DriveKey,
  type NonFatigueDriveKey,
} from './desireSystem';

/** 每个角色「刚判断过」的极短安全阀，只防止同一拍/相邻两拍重复触发，不承担节奏控制——
 *  真正的节奏由欲望状态机的涨落 + satisfy 回落决定。测试档：2 分钟。 */
export const MIN_WAKE_INTERVAL_MS = 2 * 60_000;

/** 判断窗口建议值：调用方大概多久检查一次「现在要不要醒」。测试档：1 分钟（正式值建议 15 分钟）。 */
export const WAKE_CHECK_INTERVAL_MS = 60_000;

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

const isWakeDue = (now: Date, lastWakeAt: number): boolean =>
  now.getTime() - lastWakeAt >= MIN_WAKE_INTERVAL_MS;

export interface TriggerLifeWakeResult {
  triggered: boolean;
  reason: 'scheduled' | 'not-due' | 'missed' | 'schedule-failed';
  /** 这次判断里分数最高/被闸住的维度，方便调用方（日志）展示；安全阀没过时为 undefined。 */
  driveKey?: DriveKey;
  score?: number;
}

// ─── 唤醒日志（唤醒日志 App 读这份；技术记录 + 事后补上的内容摘要） ───

const LOG_KEY = 'lifeWake_log';
/** 日志条数上限，超出后丢最旧的；纯调试用途，不需要无限堆积。 */
const LOG_MAX_ENTRIES = 200;

export type LifeWakeLogReason = 'triggered' | 'missed' | 'schedule-failed';

export interface LifeWakeLogEntry {
  charId: string;
  /** 本次判断的时间戳（epoch ms）。 */
  at: number;
  reason: LifeWakeLogReason;
  /** 这次判断里分数最高/被闸住的维度（欲望状态机接入后新增，方便在日志里看出「为什么」）。 */
  driveKey?: DriveKey;
  /** 该维度此刻的分数（0..1 左右，执念加成可能让它略超 1）。 */
  score?: number;
  /**
   * 触发成功后，角色实际说了什么/做了什么的摘录（由调用方事后读聊天记录回填，见
   * attachLifeWakeExcerpt）。写日志这一刻还不知道角色会不会说话/说什么——排程只是把
   * 生成任务扔出去，真正生成是异步的——所以这个字段一开始总是空的。
   */
  excerpt?: string;
}

const isDriveKeyLike = (v: unknown): v is DriveKey =>
  typeof v === 'string' && ['attachment', 'curiosity', 'reflection', 'duty', 'social', 'fatigue', 'libido', 'stress'].includes(v);

const isLifeWakeLogReason = (v: unknown): v is LifeWakeLogReason =>
  v === 'triggered' || v === 'missed' || v === 'schedule-failed';

const isLifeWakeLogEntry = (v: any): v is LifeWakeLogEntry =>
  !!v && typeof v.charId === 'string' && typeof v.at === 'number' && isLifeWakeLogReason(v.reason)
  && (v.excerpt === undefined || typeof v.excerpt === 'string')
  && (v.driveKey === undefined || isDriveKeyLike(v.driveKey))
  && (v.score === undefined || typeof v.score === 'number');

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

const writeAllLogEntriesRaw = (list: LifeWakeLogEntry[]): void => {
  try {
    localStorage.setItem(LOG_KEY, JSON.stringify(list));
  } catch {
    /* 写不进去就算了，只影响「唤醒日志」App 的展示 */
  }
};

const appendLifeWakeLog = (entry: LifeWakeLogEntry): void => {
  const list = readAllLogEntriesRaw();
  list.push(entry);
  const trimmed = list.length > LOG_MAX_ENTRIES ? list.slice(list.length - LOG_MAX_ENTRIES) : list;
  writeAllLogEntriesRaw(trimmed);
};

/** 读取唤醒日志，按时间倒序（最新的在最前）。传 charId 只看某个角色的。 */
export const readLifeWakeLog = (charId?: string): LifeWakeLogEntry[] => {
  const all = readAllLogEntriesRaw();
  const filtered = charId ? all.filter((e) => e.charId === charId) : all;
  return filtered.slice().sort((a, b) => b.at - a.at);
};

/** 清空唤醒日志。传 charId 只清那个角色的，不传清全部。 */
export const clearLifeWakeLog = (charId?: string): void => {
  if (!charId) {
    try {
      localStorage.removeItem(LOG_KEY);
    } catch {
      /* 忽略 */
    }
    return;
  }
  const remaining = readAllLogEntriesRaw().filter((e) => e.charId !== charId);
  writeAllLogEntriesRaw(remaining);
};

/**
 * 给一条已有的日志条目（按 charId + at 定位，这俩合起来就是写日志时的主键）回填内容摘录。
 * 调用方（OSContext）在触发成功后延迟一段时间，去聊天记录里找角色新发的消息，截一段文字
 * 传进来；这个文件本身不读聊天数据库，保持跟具体消息结构解耦。找不到对应条目就什么也不做
 * （比如日志已经被用户清空了）。
 */
export const attachLifeWakeExcerpt = (charId: string, at: number, excerpt: string): void => {
  const list = readAllLogEntriesRaw();
  const idx = list.findIndex((e) => e.charId === charId && e.at === at);
  if (idx === -1) return;
  list[idx] = { ...list[idx], excerpt };
  writeAllLogEntriesRaw(list);
};

/**
 * 判断 + （命中的话）真正触发一次。
 *
 * 流程：先检查极短安全阀（避免同一拍/相邻拍重复触发）→ 让欲望状态机推进一拍，算出此刻最该
 * 发作的维度和分数 → fatigue 闸住了，直接按「安静地歇着」处理（仍算一次「触发」，用
 * fatigue 对应的方向提示，排程成功后只缓一口气、不走标准 satisfy 回落表）→ 没被闸住但分数
 * 不够门槛，这次不触发（记一条 missed 日志，带上当时的维度和分数，方便看出「攒了多少」）→
 * 分数够了，用对应维度的方向提示去排程，成功就标记已唤醒、让相关维度回落（会让 fatigue
 * 涨一点），失败就只记日志、不标记已唤醒（下一拍还会再评估一次，不会被罚等一整个安全阀周期）。
 *
 * @param scheduleTask 真正去排程/生成的函数，由调用方注入——拿的是当下的角色配置、
 *   用户资料这些，这个文件完全不关心它们的具体类型。
 * @param personaText 角色的人设文本（描述 + 系统提示词等拼起来），传进去会让欲望状态机
 *   按人设关键词调整各维度的上升速度（见 desireSystem.computePersonaDriveWeights）；
 *   不传就是跟人设无关的旧行为。
 */
export const maybeTriggerLifeWake = async (args: {
  charId: string;
  now?: Date;
  scheduleTask: (promptHint: string) => Promise<void>;
  personaText?: string;
}): Promise<TriggerLifeWakeResult> => {
  const now = args.now ?? new Date();
  const { lastWakeAt } = readLifeWakeState(args.charId);

  if (!isWakeDue(now, lastWakeAt)) {
    return { triggered: false, reason: 'not-due' };
  }

  const { intent } = tickDesire(args.charId, now, args.personaText);

  if (!intent.gated && intent.score < WAKE_SCORE_THRESHOLD) {
    appendLifeWakeLog({ charId: args.charId, at: now.getTime(), reason: 'missed', driveKey: intent.driveKey, score: intent.score });
    return { triggered: false, reason: 'missed', driveKey: intent.driveKey, score: intent.score };
  }

  const promptHint = HINT_FOR_DRIVE[intent.driveKey];

  try {
    await args.scheduleTask(promptHint);
  } catch (error) {
    // 排程失败不标记「已唤醒」：下一拍还会再评估一次，别因为一次网络抖动
    // 就把这个角色晾整整一个安全阀周期。
    console.warn('[lifeWake] 排程失败，下次判断窗口再试', args.charId, error);
    appendLifeWakeLog({ charId: args.charId, at: now.getTime(), reason: 'schedule-failed', driveKey: intent.driveKey, score: intent.score });
    return { triggered: false, reason: 'schedule-failed', driveKey: intent.driveKey, score: intent.score };
  }

  if (intent.gated) {
    relieveAfterGatedRest(args.charId);
  } else {
    satisfyAfterAction(args.charId, intent.driveKey as NonFatigueDriveKey);
  }
  markLifeWaked(args.charId, now.getTime());
  appendLifeWakeLog({ charId: args.charId, at: now.getTime(), reason: 'triggered', driveKey: intent.driveKey, score: intent.score });
  return { triggered: true, reason: 'scheduled', driveKey: intent.driveKey, score: intent.score };
};
