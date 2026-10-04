import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  maybeTriggerLifeWake,
  readLifeWakeState,
  markLifeWaked,
  readLifeWakeLog,
  clearLifeWakeLog,
  attachLifeWakeExcerpt,
  MIN_WAKE_INTERVAL_MS,
} from './lifeWake';
import {
  writeDriveState,
  readDriveState,
  FATIGUE_REST_GATE,
  WAKE_SCORE_THRESHOLD,
  type DriveState,
} from './desireSystem';

const ZERO: DriveState = {
  attachment: 0, curiosity: 0, reflection: 0, duty: 0, social: 0, fatigue: 0, libido: 0, stress: 0,
};

const dayNoon = (day = 15) => new Date(2026, 5, day, 12, 0, 0);

beforeEach(() => {
  localStorage.clear();
  vi.restoreAllMocks();
  // 压掉欲望状态机 autofeed 那一小撮随机性，让这个文件的测试只关心
  // "分数够不够门槛" 这条主线，不被念头池的随机冒头干扰。
  vi.spyOn(Math, 'random').mockReturnValue(0.99);
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
  it('还在安全阀期内时：不推进状态机判断、不调用 scheduleTask、不记日志', async () => {
    const now = dayNoon();
    markLifeWaked('char-a', now.getTime());
    const scheduleTask = vi.fn().mockResolvedValue(undefined);
    const result = await maybeTriggerLifeWake({ charId: 'char-a', now, scheduleTask });
    expect(result).toEqual({ triggered: false, reason: 'not-due' });
    expect(scheduleTask).not.toHaveBeenCalled();
    expect(readLifeWakeLog('char-a')).toEqual([]);
  });

  it('过了安全阀，但驱动分数还没攒够门槛（全新角色从 0 开始）：不触发，记一条 missed 日志', async () => {
    const now = new Date(dayNoon().getTime() + MIN_WAKE_INTERVAL_MS + 1000);
    const scheduleTask = vi.fn().mockResolvedValue(undefined);
    const result = await maybeTriggerLifeWake({ charId: 'char-a', now, scheduleTask });
    expect(result.triggered).toBe(false);
    expect(result.reason).toBe('missed');
    expect(result.score).toBeLessThan(WAKE_SCORE_THRESHOLD);
    expect(scheduleTask).not.toHaveBeenCalled();
    const log = readLifeWakeLog('char-a');
    expect(log).toHaveLength(1);
    expect(log[0].reason).toBe('missed');
    expect(log[0].driveKey).toBeDefined();
  });

  it('某个维度分数够门槛时：用对应维度的方向提示触发排程，成功后标记已唤醒、该维度回落', async () => {
    writeDriveState('char-a', { ...ZERO, social: 0.9 });
    const now = new Date(dayNoon().getTime() + MIN_WAKE_INTERVAL_MS + 1000);
    const scheduleTask = vi.fn().mockResolvedValue(undefined);
    const result = await maybeTriggerLifeWake({ charId: 'char-a', now, scheduleTask });
    expect(result.triggered).toBe(true);
    expect(result.driveKey).toBe('social');
    expect(scheduleTask).toHaveBeenCalledTimes(1);
    const [hint] = scheduleTask.mock.calls[0];
    expect(typeof hint).toBe('string');
    expect(hint.length).toBeGreaterThan(0);
    expect(readLifeWakeState('char-a').lastWakeAt).toBe(now.getTime());
    expect(readDriveState('char-a').social).toBeLessThan(0.9); // satisfy 回落了
    const log = readLifeWakeLog('char-a');
    expect(log[0].reason).toBe('triggered');
    expect(log[0].driveKey).toBe('social');
  });

  it('fatigue 过线时：不调用 scheduleTask（省token），记一条 rested 日志，fatigue 缓一口气', async () => {
    writeDriveState('char-a', { ...ZERO, curiosity: 0.95, fatigue: 0.95 });
    const now = new Date(dayNoon().getTime() + MIN_WAKE_INTERVAL_MS + 1000);
    const scheduleTask = vi.fn().mockResolvedValue(undefined);
    const result = await maybeTriggerLifeWake({ charId: 'char-a', now, scheduleTask });
    expect(result.triggered).toBe(false);
    expect(result.reason).toBe('rested');
    expect(result.driveKey).toBe('fatigue');
    expect(scheduleTask).not.toHaveBeenCalled(); // 歇着不花 token
    expect(readLifeWakeState('char-a').lastWakeAt).toBe(now.getTime()); // 安全阀照样更新
    const after = readDriveState('char-a');
    expect(after.curiosity).toBeGreaterThan(0.9); // 没被 satisfy 打下去（只自然涨了一点）
    expect(after.fatigue).toBeLessThan(0.95); // 缓了一口气
    expect(after.fatigue).toBeGreaterThanOrEqual(FATIGUE_REST_GATE - 0.2);
    const log = readLifeWakeLog('char-a');
    expect(log[0].reason).toBe('rested');
    expect(log[0].driveKey).toBe('fatigue');
  });

  it('scheduleTask 失败时不标记已唤醒（下一拍还会再评估），但记一条 schedule-failed 日志', async () => {
    writeDriveState('char-a', { ...ZERO, social: 0.9 });
    const now = new Date(dayNoon().getTime() + MIN_WAKE_INTERVAL_MS + 1000);
    const scheduleTask = vi.fn().mockRejectedValue(new Error('network down'));
    const result = await maybeTriggerLifeWake({ charId: 'char-a', now, scheduleTask });
    expect(result.triggered).toBe(false);
    expect(result.reason).toBe('schedule-failed');
    expect(readLifeWakeState('char-a').lastWakeAt).toBe(0);
    const log = readLifeWakeLog('char-a');
    expect(log[0].reason).toBe('schedule-failed');
    expect(log[0].driveKey).toBe('social');
  });
});

describe('attachLifeWakeExcerpt', () => {
  it('能给一条已有的日志条目回填摘要', async () => {
    writeDriveState('char-a', { ...ZERO, social: 0.9 });
    const now = new Date(dayNoon().getTime() + MIN_WAKE_INTERVAL_MS + 1000);
    const scheduleTask = vi.fn().mockResolvedValue(undefined);
    await maybeTriggerLifeWake({ charId: 'char-a', now, scheduleTask });
    attachLifeWakeExcerpt('char-a', now.getTime(), '去逛了逛');
    const log = readLifeWakeLog('char-a');
    expect(log[0].excerpt).toBe('去逛了逛');
  });

  it('找不到对应条目时什么也不做（不抛错）', () => {
    expect(() => attachLifeWakeExcerpt('char-x', 123, '摘要')).not.toThrow();
    expect(readLifeWakeLog('char-x')).toEqual([]);
  });
});

describe('readLifeWakeLog / clearLifeWakeLog', () => {
  it('按时间倒序返回，且可以只看某个角色的', async () => {
    writeDriveState('char-a', { ...ZERO, social: 0.9 });
    writeDriveState('char-b', { ...ZERO, social: 0.9 });
    const base = dayNoon().getTime() + MIN_WAKE_INTERVAL_MS + 1000;
    const scheduleTask = vi.fn().mockResolvedValue(undefined);
    await maybeTriggerLifeWake({ charId: 'char-a', now: new Date(base), scheduleTask });
    await maybeTriggerLifeWake({ charId: 'char-b', now: new Date(base + 1000), scheduleTask });

    const all = readLifeWakeLog();
    expect(all.map((e) => e.charId)).toEqual(['char-b', 'char-a']); // 倒序：最新的在前

    const onlyA = readLifeWakeLog('char-a');
    expect(onlyA).toHaveLength(1);
    expect(onlyA[0].charId).toBe('char-a');
  });

  it('clearLifeWakeLog 不传 charId 清空全部；传 charId 只清那一个角色的', async () => {
    writeDriveState('char-a', { ...ZERO, social: 0.9 });
    writeDriveState('char-b', { ...ZERO, social: 0.9 });
    const base = dayNoon().getTime() + MIN_WAKE_INTERVAL_MS + 1000;
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
