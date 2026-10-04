import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  easeDrive,
  tickThoughts,
  feedThought,
  computeScores,
  pickIntent,
  satisfy,
  tickDesire,
  satisfyAfterAction,
  relieveAfterGatedRest,
  readDriveState,
  writeDriveState,
  readThoughts,
  writeThoughts,
  computePersonaDriveWeights,
  FATIGUE_REST_GATE,
  FIXATION_DRIVE_BOOST,
  type DriveState,
  type Thought,
} from './desireSystem';

const ZERO: DriveState = {
  attachment: 0, curiosity: 0, reflection: 0, duty: 0, social: 0, fatigue: 0, libido: 0, stress: 0,
};

const dayNoon = () => new Date(2026, 5, 15, 12, 0, 0);
const nightThreeAm = () => new Date(2026, 5, 15, 3, 0, 0);

beforeEach(() => {
  localStorage.clear();
  vi.restoreAllMocks();
});

describe('easeDrive', () => {
  it('白天：7 个需求维度都往上涨，fatigue 往下降', () => {
    const next = easeDrive(ZERO, dayNoon());
    expect(next.attachment).toBeGreaterThan(0);
    expect(next.curiosity).toBeGreaterThan(0);
    expect(next.fatigue).toBe(0); // 已经是 0，不会降到负的
  });

  it('夜里涨得比白天慢', () => {
    const dayNext = easeDrive(ZERO, dayNoon());
    const nightNext = easeDrive(ZERO, nightThreeAm());
    expect(nightNext.curiosity).toBeLessThan(dayNext.curiosity);
    expect(nightNext.curiosity).toBeGreaterThan(0); // 变慢不是停止
  });

  it('封顶在 1，不会溢出', () => {
    const almostFull: DriveState = { ...ZERO, curiosity: 0.999 };
    const next = easeDrive(almostFull, dayNoon());
    expect(next.curiosity).toBeLessThanOrEqual(1);
  });

  it('fatigue 恢复有下限 0，不会变负', () => {
    const next = easeDrive({ ...ZERO, fatigue: 0.001 }, dayNoon());
    expect(next.fatigue).toBeGreaterThanOrEqual(0);
  });

  it('不传 weights 时，等同于所有维度权重=1（旧行为不变）', () => {
    const withDefault = easeDrive(ZERO, dayNoon());
    const withExplicit1 = easeDrive(ZERO, dayNoon(), {
      attachment: 1, curiosity: 1, reflection: 1, duty: 1, social: 1, libido: 1, stress: 1,
    });
    expect(withDefault).toEqual(withExplicit1);
  });

  it('某个维度权重更高时，那个维度涨得更快，其它维度不受影响', () => {
    const boosted = easeDrive(ZERO, dayNoon(), {
      attachment: 2, curiosity: 1, reflection: 1, duty: 1, social: 1, libido: 1, stress: 1,
    });
    const baseline = easeDrive(ZERO, dayNoon());
    expect(boosted.attachment).toBeCloseTo(baseline.attachment * 2, 5);
    expect(boosted.curiosity).toBeCloseTo(baseline.curiosity, 5); // 没加权的维度不变
  });
});

describe('computePersonaDriveWeights', () => {
  it('空文本时所有维度权重都是 1（不影响旧行为）', () => {
    const weights = computePersonaDriveWeights('');
    expect(Object.values(weights).every((w) => w === 1)).toBe(true);
  });

  it('没命中任何关键词的文本，所有维度权重都是 1', () => {
    const weights = computePersonaDriveWeights('一个普通的角色，喜欢喝咖啡。');
    expect(Object.values(weights).every((w) => w === 1)).toBe(true);
  });

  it('命中"粘人"这类词，attachment 权重变高，其它维度不受影响', () => {
    const weights = computePersonaDriveWeights('性格粘人，很黏人，总是舍不得对方离开。');
    expect(weights.attachment).toBeGreaterThan(1);
    expect(weights.curiosity).toBe(1);
    expect(weights.social).toBe(1);
  });

  it('命中多个关键词时权重更高，但不会无限涨（有上限）', () => {
    // 这几个词都在 attachment 关键词表里
    const weights = computePersonaDriveWeights('粘人 黏人 依赖 舍不得 离不开 依恋 恋人 想念 黏着 粘着');
    expect(weights.attachment).toBeLessThanOrEqual(2.6);
  });

  it('不同维度的关键词可以同时命中，互不冲突', () => {
    const weights = computePersonaDriveWeights('外向爱热闹，同时又有点焦虑、压力大。');
    expect(weights.social).toBeGreaterThan(1);
    expect(weights.stress).toBeGreaterThan(1);
    expect(weights.attachment).toBe(1);
  });
});

describe('tickThoughts', () => {
  const mkThought = (overrides: Partial<Thought>): Thought => ({
    id: 't1', text: '随便', drive: 'curiosity', kind: 'flit', strength: 0.5, bornAt: 0, fedCount: 0,
    ...overrides,
  });

  it('闪念正常衰减', () => {
    const { thoughts } = tickThoughts([mkThought({ strength: 0.5 })]);
    expect(thoughts).toHaveLength(1);
    expect(thoughts[0].strength).toBeCloseTo(0.5 * 0.82, 5);
  });

  it('闪念衰减到低于阈值就被清掉', () => {
    const { thoughts } = tickThoughts([mkThought({ strength: 0.06 })]);
    expect(thoughts).toHaveLength(0);
  });

  it('执念持续加强，冲过反哺线就反哺驱动维度、自己松一档、计一次喂饱', () => {
    const { thoughts, feedback } = tickThoughts([mkThought({ kind: 'fixation', strength: 0.8, fedCount: 0 })]);
    expect(feedback.curiosity).toBeCloseTo(0.18, 5);
    expect(thoughts).toHaveLength(1);
    expect(thoughts[0].fedCount).toBe(1);
    expect(thoughts[0].strength).toBeLessThan(0.8 * 1.10); // 反哺后自己松了一档
  });

  it('执念喂饱 3 次后「想透了」，自动出池', () => {
    let thoughts: Thought[] = [mkThought({ kind: 'fixation', strength: 0.82, fedCount: 2 })];
    const result = tickThoughts(thoughts);
    expect(result.thoughts).toHaveLength(0); // 第 3 次喂饱，出池
  });
});

describe('feedThought', () => {
  it('喂一条新念头，建一条闪念', () => {
    const thoughts = feedThought([], '想她了', 'attachment', 1000, 0.4);
    expect(thoughts).toHaveLength(1);
    expect(thoughts[0]).toMatchObject({ text: '想她了', drive: 'attachment', kind: 'flit', strength: 0.4 });
  });

  it('同样的文本再喂一次会加强，而不是建新的一条', () => {
    let thoughts = feedThought([], '想她了', 'attachment', 1000, 0.4);
    thoughts = feedThought(thoughts, '想她了', 'attachment', 2000, 0.4);
    expect(thoughts).toHaveLength(1);
    expect(thoughts[0].strength).toBeCloseTo(0.6, 5);
  });

  it('反复喂同一条，强度冲过阈值后自动升级成执念', () => {
    let thoughts = feedThought([], '想她了', 'attachment', 1000, 0.7);
    thoughts = feedThought(thoughts, '想她了', 'attachment', 2000, 0.7); // 0.7+0.2=0.9 > 0.8
    expect(thoughts[0].kind).toBe('fixation');
  });
});

describe('computeScores / pickIntent', () => {
  it('没有执念时，分数就是驱动条本身', () => {
    const drive: DriveState = { ...ZERO, curiosity: 0.4, social: 0.3 };
    const scores = computeScores(drive, []);
    expect(scores.curiosity).toBeCloseTo(0.4, 5);
    expect(scores.social).toBeCloseTo(0.3, 5);
  });

  it('执念给对应维度加分', () => {
    const drive: DriveState = { ...ZERO, curiosity: 0.2 };
    const thought: Thought = { id: 't1', text: 'x', drive: 'curiosity', kind: 'fixation', strength: 0.5, bornAt: 0, fedCount: 0 };
    const scores = computeScores(drive, [thought]);
    expect(scores.curiosity).toBeCloseTo(0.2 + FIXATION_DRIVE_BOOST * 0.5, 5);
  });

  it('选分数最高的维度，并映射到对应的 wantAction', () => {
    const drive: DriveState = { ...ZERO, curiosity: 0.1, social: 0.5, stress: 0.2 };
    const intent = pickIntent(drive, []);
    expect(intent.driveKey).toBe('social');
    expect(intent.wantAction).toBe('web-browse');
    expect(intent.gated).toBe(false);
  });

  it('fatigue 过线时直接短路成「歇着」，不管别的维度分数多高', () => {
    const drive: DriveState = { ...ZERO, curiosity: 0.9, fatigue: FATIGUE_REST_GATE };
    const intent = pickIntent(drive, []);
    expect(intent.gated).toBe(true);
    expect(intent.driveKey).toBe('fatigue');
    expect(intent.wantAction).toBe('none');
  });
});

describe('satisfy', () => {
  it('做完事之后，相关维度乘性回落，不相关的维度不变', () => {
    const drive: DriveState = { ...ZERO, reflection: 0.8, curiosity: 0.6, social: 0.5 };
    const next = satisfy(drive, 'reflection');
    expect(next.reflection).toBeCloseTo(0.8 * 0.45, 5);
    expect(next.curiosity).toBeCloseTo(0.6 * 0.85, 5);
    expect(next.social).toBe(0.5); // 不相关，不动
  });
});

describe('tickDesire / satisfyAfterAction / relieveAfterGatedRest（持久化整合）', () => {
  it('从没记录过的角色，第一拍会从 0 开始往上涨', () => {
    const { drive } = tickDesire('char-a', dayNoon());
    expect(drive.curiosity).toBeGreaterThan(0);
    expect(readDriveState('char-a').curiosity).toBeCloseTo(drive.curiosity, 5);
  });

  it('多拍下来，分数持续累积（不会每拍都被重置）', () => {
    for (let i = 0; i < 5; i++) tickDesire('char-a', dayNoon());
    const drive = readDriveState('char-a');
    expect(drive.curiosity).toBeGreaterThan(0.05); // 5 拍比 1 拍高
  });

  it('传入人设文本时，对应维度涨得更快——不再是所有角色都「好奇」赢', () => {
    const now = dayNoon();
    const withoutPersona = tickDesire('char-plain', now);
    const withPersona = tickDesire('char-clingy', now, '这个角色很粘人，特别黏人，总是舍不得。');
    // 两边都是全新角色、同一时刻推进一拍：有人设加成的 attachment 应该比没加成的角色的
    // attachment 涨得更多（同样起点 0，速度更快）。
    expect(withPersona.drive.attachment).toBeGreaterThan(withoutPersona.drive.attachment);
  });

  it('satisfyAfterAction 会让相关维度回落、fatigue 升高，并持久化', () => {
    writeDriveState('char-a', { ...ZERO, social: 0.8 });
    satisfyAfterAction('char-a', 'social');
    const drive = readDriveState('char-a');
    expect(drive.social).toBeLessThan(0.8);
    expect(drive.fatigue).toBeGreaterThan(0);
  });

  it('relieveAfterGatedRest 会让 fatigue 降一点', () => {
    writeDriveState('char-a', { ...ZERO, fatigue: 0.8 });
    relieveAfterGatedRest('char-a');
    expect(readDriveState('char-a').fatigue).toBeLessThan(0.8);
  });

  it('不同角色的状态互不影响', () => {
    writeDriveState('char-a', { ...ZERO, curiosity: 0.9 });
    writeDriveState('char-b', { ...ZERO, curiosity: 0.1 });
    expect(readDriveState('char-a').curiosity).toBeCloseTo(0.9, 5);
    expect(readDriveState('char-b').curiosity).toBeCloseTo(0.1, 5);
  });

  it('localStorage 数据损坏时安全退回零状态/空念头池，而不是抛错', () => {
    localStorage.setItem('desire_drive_char-a', '{not json');
    localStorage.setItem('desire_thoughts_char-a', '{not json');
    expect(readDriveState('char-a')).toEqual(ZERO);
    expect(readThoughts('char-a')).toEqual([]);
  });

  it('念头池条数超过上限会裁掉最旧的', () => {
    const many: Thought[] = Array.from({ length: 30 }, (_, i) => ({
      id: `t${i}`, text: `t${i}`, drive: 'curiosity', kind: 'flit', strength: 0.5, bornAt: i, fedCount: 0,
    }));
    writeThoughts('char-a', many);
    expect(readThoughts('char-a').length).toBeLessThanOrEqual(20);
  });
});
