import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  shouldWakeNow,
  maybeTriggerLifeWake,
  readLifeWakeState,
  markLifeWaked,
  readLifeWakeLog,
  clearLifeWakeLog,
  MIN_WAKE_INTERVAL_MS,
  LIFE_WAKE_PROMPT_HINT,
} from './lifeWake';

const dayNoon = (day = 15) => new Date(2026, 5, day, 12, 0, 0); // 白天，非边界
const nightThreeAm = (day = 15) => new Date(2026, 5, day, 3, 0, 0); // 夜里

beforeEach(() => {
  localStorage.clear();
  vi.restoreAllMocks();
});

describe('shouldWakeNow', () => {
  it('距上次唤醒不到最短间隔时，无论概率骰到多少都不醒', () => {
    const now = dayNoon();
    const lastWakeAt = now.getTime() - (MIN_WAKE_INTERVAL_MS - 1000);
    expect(shouldWakeNow(now, lastWakeAt, 0)).toBe(false);
  });

  it('过了最短间隔、骰子够小（白天）时会醒', () => {
    const now = dayNoon();
    const lastWakeAt = now.getTime() - MIN_WAKE_INTERVAL_MS - 1000;
    expect(shouldWakeNow(now, lastWakeAt, 0.01)).toBe(true);
  });

  it('过了最短间隔但骰子偏大时不醒', () => {
    const now = dayNoon();
    const lastWakeAt = now.getTime() - MIN_WAKE_INTERVAL_MS - 1000;
    expect(shouldWakeNow(now, lastWakeAt, 0.99)).toBe(false);
  });

  it('夜里同样的骰子结果，命中概率应该比白天低（同一个骰子值白天过、夜里不过）', () => {
    const lastWakeAt = 0;
    const roll = 0.06; // 落在 [NIGHT_CHANCE, DAY_CHANCE) 之间
    expect(shouldWakeNow(dayNoon(), lastWakeAt, roll)).toBe(true);
    expect(shouldWakeNow(nightThreeAm(), lastWakeAt, roll)).toBe(false);
  });

  it('从没醒过（lastWakeAt=0）时，只要过了最短间隔就按正常概率判断', () => {
    const farFuture = new Date(dayNoon().getTime() + MIN_WAKE_INTERVAL_MS + 60_000);
    expect(shouldWakeNow(farFuture, 0, 0.01)).toBe(true);
  });
});

describe('readLifeWakeState / markLifeWaked', () => {
  it('从没写过时返回 lastWakeAt=0', () => {
    expect(readLifeWakeState('char-a')).toEqual({ lastWakeAt: 0 });
  });

  it('markLifeWaked 之后 readLifeWakeState 能读回同一个时间戳', () => {
    markLifeWaked('char-a', 12345);
    expect(readLifeWakeState('char-a')).toEqual({ lastWakeAt: 12345 });
  });

  it('不同角色的状态互不影响', () => {
    markLifeWaked('char-a', 111);
    markLifeWaked('char-b', 222);
    expect(readLifeWakeState('char-a').lastWakeAt).toBe(111);
    expect(readLifeWakeState('char-b').lastWakeAt).toBe(222);
  });

  it('localStorage 里存的是损坏数据时，安全退回 0 而不是抛错', () => {
    localStorage.setItem('lifeWake_state_char-a', '{not json');
    expect(readLifeWakeState('char-a')).toEqual({ lastWakeAt: 0 });
  });
});

describe('maybeTriggerLifeWake', () => {
  it('还在冷却期内时不会调用 scheduleTask、不写状态、也不记日志', async () => {
    const now = dayNoon();
    markLifeWaked('char-a', now.getTime()); // 刚醒过
    const scheduleTask = vi.fn().mockResolvedValue(undefined);
    const result = await maybeTriggerLifeWake({ charId: 'char-a', now, scheduleTask });
    expect(result).toEqual({ triggered: false, reason: 'not-due' });
    expect(scheduleTask).not.toHaveBeenCalled();
    expect(readLifeWakeLog('char-a')).toEqual([]);
  });

  it('过了冷却期但骰子没中：不调用 scheduleTask、不标记已唤醒，但记一条 missed 日志', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.99); // 确保不中
    const now = new Date(dayNoon().getTime() + MIN_WAKE_INTERVAL_MS + 60_000);
    const scheduleTask = vi.fn().mockResolvedValue(undefined);
    const result = await maybeTriggerLifeWake({ charId: 'char-a', now, scheduleTask });
    expect(result).toEqual({ triggered: false, reason: 'missed' });
    expect(scheduleTask).not.toHaveBeenCalled();
    expect(readLifeWakeState('char-a').lastWakeAt).toBe(0);
    expect(readLifeWakeLog('char-a')).toEqual([{ charId: 'char-a', at: now.getTime(), reason: 'missed' }]);
  });

  it('scheduleTask 成功时标记为已触发、把 lastWakeAt 更新为本次时间，并记一条 triggered 日志', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.001); // 确保命中
    const now = new Date(dayNoon().getTime() + MIN_WAKE_INTERVAL_MS + 60_000);
    const scheduleTask = vi.fn().mockResolvedValue(undefined);
    const result = await maybeTriggerLifeWake({ charId: 'char-a', now, scheduleTask });
    expect(result).toEqual({ triggered: true, reason: 'scheduled' });
    expect(scheduleTask).toHaveBeenCalledWith(LIFE_WAKE_PROMPT_HINT);
    expect(readLifeWakeState('char-a').lastWakeAt).toBe(now.getTime());
    expect(readLifeWakeLog('char-a')).toEqual([{ charId: 'char-a', at: now.getTime(), reason: 'triggered' }]);
  });

  it('scheduleTask 失败时不标记已触发（方便下个判断窗口重试），但记一条 schedule-failed 日志', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.001);
    const now = new Date(dayNoon().getTime() + MIN_WAKE_INTERVAL_MS + 60_000);
    const scheduleTask = vi.fn().mockRejectedValue(new Error('network down'));
    const result = await maybeTriggerLifeWake({ charId: 'char-a', now, scheduleTask });
    expect(result).toEqual({ triggered: false, reason: 'schedule-failed' });
    expect(readLifeWakeState('char-a').lastWakeAt).toBe(0);
    expect(readLifeWakeLog('char-a')).toEqual([{ charId: 'char-a', at: now.getTime(), reason: 'schedule-failed' }]);
  });
});

describe('readLifeWakeLog / clearLifeWakeLog', () => {
  it('按时间倒序返回，且可以只看某个角色的', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.001);
    const base = dayNoon().getTime() + MIN_WAKE_INTERVAL_MS + 60_000;
    const scheduleTask = vi.fn().mockResolvedValue(undefined);
    await maybeTriggerLifeWake({ charId: 'char-a', now: new Date(base), scheduleTask });
    await maybeTriggerLifeWake({ charId: 'char-b', now: new Date(base + MIN_WAKE_INTERVAL_MS + 1000), scheduleTask });

    const all = readLifeWakeLog();
    expect(all.map((e) => e.charId)).toEqual(['char-b', 'char-a']); // 倒序：最新的在前

    const onlyA = readLifeWakeLog('char-a');
    expect(onlyA).toHaveLength(1);
    expect(onlyA[0].charId).toBe('char-a');
  });

  it('clearLifeWakeLog 不传 charId 清空全部；传 charId 只清那一个角色的', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.001);
    const base = dayNoon().getTime() + MIN_WAKE_INTERVAL_MS + 60_000;
    const scheduleTask = vi.fn().mockResolvedValue(undefined);
    await maybeTriggerLifeWake({ charId: 'char-a', now: new Date(base), scheduleTask });
    await maybeTriggerLifeWake({ charId: 'char-b', now: new Date(base), scheduleTask });

    clearLifeWakeLog('char-a');
    expect(readLifeWakeLog('char-a')).toEqual([]);
    expect(readLifeWakeLog('char-b')).toHaveLength(1);

    clearLifeWakeLog();
    expect(readLifeWakeLog()).toEqual([]);
  });

  it('localStorage 里存的是损坏数据时，安全退回空数组而不是抛错', () => {
    localStorage.setItem('lifeWake_log', '{not json');
    expect(readLifeWakeLog()).toEqual([]);
  });
});
