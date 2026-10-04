/**
 * 欲望驱动状态机 —— 按用户给的「欲望系统攻略」PDF（desire.py / server.py 设计）移植。
 * 核心思路照搬：角色的唤醒/行为由「函数驱动的内在缺口」决定，不是写死的时间表、也不是
 * 单纯掷骰子。
 *
 * 跟原设计的几点取舍差异（移植时做不到 1:1，记在这儿方便以后对照）：
 * - 原版的念头文本来自真实浏览到的书摘/推文/对话；这里没有对应的「真实素材」数据源可接，
 *   念头内容暂时用每个驱动维度下的一小撮模板短句代替（见 AUTOFEED_PHRASES）。想要「真实
 *   感」得先把浏览/工具结果喂回这个模块，这版先用占位文案把整条链路跑通。
 * - 原版驱动条随 idle/push 曲线缓动（区分「闲置」和「被互动过」两种节奏）；这里没有精确
 *   的真实互动信号，统一按固定速率随时间上升（代表需求持续累积），只有 fatigue 反过来：
 *   闲置时恢复、真正触发一次行动后才升高。
 * - 原版靠 1800s 心跳 tick 推进；这里的「一拍」跟 lifeWake 的检查频率（WAKE_CHECK_INTERVAL_MS）
 *   绑在一起——每次检查算一拍，不做真实时间的连续插值，节奏和 lifeWake 保持一致。
 * - satisfy() 的乘性回落天然起到了「冷却」的作用：触发后相关维度被打下去，要再涨回阈值
 *   需要时间，所以不再需要像之前那版一样单独维护一个「两次唤醒最少间隔 90 分钟」的常数；
 *   lifeWake.ts 里留的那个极短 debounce 只是防止同一拍内重复触发的安全阀，不承担节奏控制。
 * - 【2026-10 新增】7 个需求维度原本所有角色共用同一套上升速度——这会导致不管人设写什么，
 *   「好奇」因为速度定得最快，几乎总是第一个冲线，显不出角色差异。现在加了一层基于人设
 *   文本的关键词匹配（computePersonaDriveWeights），给每个维度算一个倍率，让「人设里写了
 *   粘人」的角色真的更容易因为「想念」触发，而不是所有角色表现一致。这是关键词规则，不是
 *   LLM 语义理解——人设没写出典型关键词就匹配不到，判断比较死板，先用这个免费方案把链路
 *   跑通，以后想要更准可以换成调一次 LLM 分析人设的版本。
 * - 【2026-10 修】fatigue 闸住后的「安静地歇着」本身不需要调用 LLM——这是 lifeWake.ts 那边
 *   的改动（被闸住直接跳过 scheduleTask，不花 token），但连带把这里的 fatigue 涨/消速度
 *   也重新调了一版：原先涨得比消得快太多，在短安全阀的测试档下很快就把大半唤醒名额耗在
 *   「疲惫→歇着→疲惫」的循环里。现在涨得慢一点、消得快一点、缓一口气时松得更多（反正免费
 *   了，不用省着用），别让 fatigue 一家独大。
 */

export const DRIVE_KEYS = ['attachment', 'curiosity', 'reflection', 'duty', 'social', 'fatigue', 'libido', 'stress'] as const;
export type DriveKey = typeof DRIVE_KEYS[number];
export type NonFatigueDriveKey = Exclude<DriveKey, 'fatigue'>;
export type DriveState = Record<DriveKey, number>;

const ZERO_DRIVE: DriveState = {
  attachment: 0, curiosity: 0, reflection: 0, duty: 0, social: 0, fatigue: 0, libido: 0, stress: 0,
};

const clamp01 = (v: number): number => Math.max(0, Math.min(1, v));
const isNightHour = (hour: number): boolean => hour >= 0 && hour < 6;

// ─── 每个驱动维度「发作」时对应的行为类型 + 给生成流程的方向提示 ───

export type WantAction = 'none' | 'curiosity-explore' | 'co-read' | 'web-browse' | 'tease' | 'vent';

const ACTION_FOR_DRIVE: Record<NonFatigueDriveKey, WantAction> = {
  attachment: 'none',
  curiosity: 'curiosity-explore',
  reflection: 'co-read',
  duty: 'none',
  social: 'web-browse',
  libido: 'tease',
  stress: 'vent',
};

/** mode='prompted' 的方向提示，按当下哪个维度分数最高来选，取代之前那版统一的一句话提示。 */
export const HINT_FOR_DRIVE: Record<DriveKey, string> = {
  attachment: '这会儿你心里有点想对方，不用特意找话题，留一两句惦记的碎碎念就好，不必长篇大论。',
  curiosity: '你现在挺好奇外面的世界，可以用手上的工具去查点新鲜事、随便逛逛，看到有意思的东西再决定要不要说，没有就算了。',
  reflection: '你现在想沉淀一下、整理点心事，安静地想一会儿；有想倾诉的就说，没有也没关系。',
  duty: '你心里惦记着一件还没做完的事，留一句简短的碎碎念就够了。',
  social: '你有点想看看外面的世界、大家在聊什么，可以用工具逛逛，看到有意思的事再分享。',
  libido: '你这会儿有点想亲近对方，用你自己的方式表达一下就好。',
  stress: '你心里有点堵，想找地方说两句、或者自己先消化一下。',
  fatigue: '你现在有点累，不太想动，安安静静待一会儿就好，不必强行做什么。',
};

// ─── 驱动条随时间变化（一拍 = lifeWake 的一次检查） ───

/** 7 个「需求」维度每拍的基础上升速度（人设权重=1 时的速度）；fatigue 是反向的，不在这张表里。 */
const RISE_PER_TICK: Record<NonFatigueDriveKey, number> = {
  attachment: 0.025,
  curiosity: 0.03,
  reflection: 0.02,
  duty: 0.015,
  social: 0.025,
  libido: 0.02,
  stress: 0.018,
};

/** 夜里（本地 0-6 点）需求涨得更慢——不再需要单独的「夜里唤醒概率更低」开关，自然就少醒。 */
const NIGHT_RISE_MULTIPLIER = 0.4;

/** fatigue 闲置（没触发行动）时每拍恢复多少。 */
const FATIGUE_RECOVER_PER_TICK = 0.03;
/** 真正触发一次「没被 fatigue 闸住」的行动后，fatigue 涨多少。 */
const FATIGUE_GAIN_ON_ACTION = 0.08;
/** fatigue 被闸住、安静地歇着那次——本身不调用 LLM（见 lifeWake.ts），免费，不用省着用。 */
const FATIGUE_GAIN_ON_GATED_REST = 0.0;
/** 被 fatigue 闸住、乖乖歇了一下之后，fatigue 往下降多少——歇着免费，可以松得更多，尽快脱离「闸住」状态。 */
const FATIGUE_RELIEF_ON_GATED_REST = 0.2;

/** fatigue 到这个值，强制归为「歇着」，不管别的维度分数多高——这是闸，不是跟别人抢分的维度。 */
export const FATIGUE_REST_GATE = 0.75;

export type DriveWeights = Record<NonFatigueDriveKey, number>;

const DEFAULT_WEIGHTS: DriveWeights = {
  attachment: 1, curiosity: 1, reflection: 1, duty: 1, social: 1, libido: 1, stress: 1,
};

/**
 * 按一拍推进驱动条：7 个需求维度照各自速度（乘上人设权重）涨，fatigue 闲置时恢复。
 * weights 不传就是所有维度权重=1（跟人设无关的默认行为，向后兼容）。
 */
export const easeDrive = (drive: DriveState, now: Date, weights: DriveWeights = DEFAULT_WEIGHTS): DriveState => {
  const mult = isNightHour(now.getHours()) ? NIGHT_RISE_MULTIPLIER : 1;
  const next: DriveState = { ...drive };
  for (const k of DRIVE_KEYS) {
    if (k === 'fatigue') {
      next.fatigue = clamp01(drive.fatigue - FATIGUE_RECOVER_PER_TICK);
    } else {
      next[k] = clamp01(drive[k] + RISE_PER_TICK[k] * (weights[k] ?? 1) * mult);
    }
  }
  return next;
};

// ─── 人设文本 → 每个维度的权重（关键词匹配，免费、纯本地计算，不调 LLM） ───

/**
 * 每个维度对应的典型人设关键词。人设文本（描述 + 系统提示词等）里命中几个，这个维度的
 * 上升速度就按命中数放大，命中越多倍率越高（封顶），完全没命中的维度保持倍率 1（原速）。
 * 这是规则匹配，不是语义理解——人设写"离不开你"这种没用到关键词的说法就匹配不到，
 * 想要更准确得换成调一次 LLM 分析人设的版本（见文件头说明）。
 */
const PERSONA_KEYWORDS: Record<NonFatigueDriveKey, string[]> = {
  attachment: ['粘人', '黏人', '依赖', '舍不得', '离不开', '依恋', '恋人', '想念', '黏着', '粘着'],
  curiosity: ['好奇', '探索', '求知', '冒险', '爱问', '新鲜感', '爱学习', '爱钻研', '打破砂锅'],
  reflection: ['内向', '敏感', '细腻', '多愁善感', '文艺', '安静', '喜欢思考', '感性', '内敛', '深沉'],
  duty: ['责任感', '认真', '靠谱', '一丝不苟', '守时', '尽职', '自律', '原则', '一本正经'],
  social: ['外向', '爱热闹', '社牛', '朋友多', '活泼', '开朗', '喜欢聚会', '合群', '健谈'],
  libido: ['撒娇', '调皮', '暧昧', '亲密', '粘腻', '占有欲', '吃醋'],
  stress: ['焦虑', '压力大', '紧绷', '完美主义', '容易紧张', '神经质', '易崩溃'],
};

/** 每命中一个关键词，权重 +0.4；最多封顶到 2.6（命中 4 个以上就不再继续放大）。 */
const PER_KEYWORD_WEIGHT = 0.4;
const MAX_WEIGHT = 2.6;

/**
 * 读人设文本，算出 7 个需求维度各自的权重倍率。没有匹配到任何关键词的文本（比如空字符串）
 * 会返回全 1（等同于不区分人设的旧行为），不会让角色"什么欲望都没有"。
 */
export const computePersonaDriveWeights = (personaText: string): DriveWeights => {
  const text = (personaText || '').toLowerCase();
  const weights = { ...DEFAULT_WEIGHTS };
  if (!text) return weights;
  for (const key of Object.keys(PERSONA_KEYWORDS) as NonFatigueDriveKey[]) {
    let hits = 0;
    for (const kw of PERSONA_KEYWORDS[key]) {
      if (text.includes(kw.toLowerCase())) hits += 1;
    }
    if (hits > 0) {
      weights[key] = Math.min(MAX_WEIGHT, 1 + hits * PER_KEYWORD_WEIGHT);
    }
  }
  return weights;
};

// ─── 念头池（闪念 flit ↔ 执念 fixation） ───

export interface Thought {
  id: string;
  text: string;
  drive: NonFatigueDriveKey;
  kind: 'flit' | 'fixation';
  strength: number;
  bornAt: number;
  /** 执念被「喂饱」（强度冲过阈值）过几次；满 3 次视为「想透了」，自动出池。 */
  fedCount: number;
}

const FLIT_DECAY = 0.82;
const FIXATION_GROW = 1.10;
const FLIT_TO_FIXATION = 0.80;
const FIXATION_FEED = 0.85;
const FIXATION_FEED_GAIN = 0.18;
const FIXATION_RESOLVE_FEEDS = 3;
const DROP_BELOW = 0.06;
/** 执念给对应驱动维度的召唤力加成系数（原版叫 FIXATION_DRIVE_BOOST）。 */
export const FIXATION_DRIVE_BOOST = 0.35;

/**
 * 推进念头池一拍：闪念衰减（跌破 DROP_BELOW 就清掉，冲过 FLIT_TO_FIXATION 就升级成执念）；
 * 执念本身继续加强，强度冲过 FIXATION_FEED 就反哺一次对应驱动维度（并自己松一档、计一次
 * 「喂饱」），喂满 FIXATION_RESOLVE_FEEDS 次视为「想透了」，自动出池，防止执念永久堆积。
 */
export const tickThoughts = (thoughts: Thought[]): { thoughts: Thought[]; feedback: Partial<Record<NonFatigueDriveKey, number>> } => {
  const feedback: Partial<Record<NonFatigueDriveKey, number>> = {};
  const next: Thought[] = [];
  for (const t of thoughts) {
    if (t.kind === 'flit') {
      const strength = t.strength * FLIT_DECAY;
      if (strength < DROP_BELOW) continue;
      next.push(strength > FLIT_TO_FIXATION ? { ...t, kind: 'fixation', strength } : { ...t, strength });
    } else {
      let strength = t.strength * FIXATION_GROW;
      let fedCount = t.fedCount;
      if (strength > FIXATION_FEED) {
        feedback[t.drive] = (feedback[t.drive] ?? 0) + FIXATION_FEED_GAIN;
        strength *= 0.7;
        fedCount += 1;
        if (fedCount >= FIXATION_RESOLVE_FEEDS) continue;
      }
      next.push({ ...t, strength, fedCount });
    }
  }
  return { thoughts: next, feedback };
};

/** 喂一条念头：同样的文本再喂一次会加强（强度 +0.2，封顶 1），冲过阈值就直接升成执念。 */
export const feedThought = (
  thoughts: Thought[],
  text: string,
  drive: NonFatigueDriveKey,
  bornAt: number,
  strength = 0.5,
): Thought[] => {
  const idx = thoughts.findIndex((t) => t.text === text);
  if (idx !== -1) {
    const existing = thoughts[idx];
    const boosted = Math.min(1, existing.strength + 0.2);
    const updated: Thought = existing.kind === 'flit' && boosted > FLIT_TO_FIXATION
      ? { ...existing, kind: 'fixation', strength: boosted }
      : { ...existing, strength: boosted };
    const next = [...thoughts];
    next[idx] = updated;
    return next;
  }
  return [...thoughts, {
    id: `${bornAt}-${Math.random().toString(36).slice(2, 8)}`,
    text, drive, kind: 'flit', strength, bornAt, fedCount: 0,
  }];
};

// ─── 哪一维最该发作 ───

export interface Intent {
  driveKey: DriveKey;
  score: number;
  wantAction: WantAction;
  /** fatigue 闸住了：不管别的维度分数多高，这次强制归为「安静地歇着」。 */
  gated: boolean;
}

/** 每个需求维度此刻的「召唤力」= 驱动条值 + 执念加成；fatigue 不参与打分，它是闸不是竞争者。 */
export const computeScores = (drive: DriveState, thoughts: Thought[]): Record<NonFatigueDriveKey, number> => {
  const boost: Partial<Record<NonFatigueDriveKey, number>> = {};
  for (const t of thoughts) {
    if (t.kind === 'fixation') boost[t.drive] = (boost[t.drive] ?? 0) + t.strength;
  }
  const scores = {} as Record<NonFatigueDriveKey, number>;
  for (const k of DRIVE_KEYS) {
    if (k === 'fatigue') continue;
    const key = k as NonFatigueDriveKey;
    scores[key] = drive[key] + FIXATION_DRIVE_BOOST * (boost[key] ?? 0);
  }
  return scores;
};

/** 挑出此刻最该发作的维度；fatigue 过线时直接短路成「歇着」，不比分数。 */
export const pickIntent = (drive: DriveState, thoughts: Thought[]): Intent => {
  if (drive.fatigue >= FATIGUE_REST_GATE) {
    return { driveKey: 'fatigue', score: drive.fatigue, wantAction: 'none', gated: true };
  }
  const scores = computeScores(drive, thoughts);
  let bestKey: NonFatigueDriveKey = 'attachment';
  let bestScore = -Infinity;
  for (const k of DRIVE_KEYS) {
    if (k === 'fatigue') continue;
    const key = k as NonFatigueDriveKey;
    if (scores[key] > bestScore) { bestScore = scores[key]; bestKey = key; }
  }
  return { driveKey: bestKey, score: bestScore, wantAction: ACTION_FOR_DRIVE[bestKey], gated: false };
};

// ─── 做完一件事之后，相关维度乘性回落 ───

const ACTION_SATISFY: Record<NonFatigueDriveKey, Partial<Record<NonFatigueDriveKey, number>>> = {
  reflection: { reflection: 0.45, curiosity: 0.85 },
  curiosity: { curiosity: 0.50 },
  social: { social: 0.48, curiosity: 0.82 },
  attachment: { attachment: 0.58, duty: 0.80 },
  duty: { attachment: 0.58, duty: 0.80 },
  libido: { libido: 0.55, attachment: 0.78 },
  stress: { stress: 0.45, attachment: 0.85 },
};

export const satisfy = (drive: DriveState, driveKey: NonFatigueDriveKey): DriveState => {
  const ratios = ACTION_SATISFY[driveKey];
  const next: DriveState = { ...drive };
  for (const [k, ratio] of Object.entries(ratios)) {
    next[k as DriveKey] = clamp01(next[k as DriveKey] * (ratio as number));
  }
  return next;
};

// ─── 自动冒出念头的模板短句（没有真实素材数据源时的占位，见文件头说明） ───

export const AUTOFEED_PHRASES: Record<NonFatigueDriveKey, string[]> = {
  attachment: ['有点想对方了', '心里冒出一句想说的话'],
  curiosity: ['好奇外面这会儿在发生什么', '想去看看有没有什么新鲜事'],
  reflection: ['想把这几天的事想清楚', '有点想找个地方写下来'],
  duty: ['记挂着还有件事没弄完'],
  social: ['有点想看看大家都在聊什么'],
  libido: ['想凑过去蹭一下'],
  stress: ['心里有点堵，想说两句'],
};

/** 每拍有多大概率自动冒出一条跟当前最高分维度相关的念头。 */
const AUTOFEED_CHANCE = 0.3;

/** 分数到这个值，才算「攒够了、值得去问一次」；对应原版 pick_intent 的分数门槛。测试档，见 lifeWake.ts。 */
export const WAKE_SCORE_THRESHOLD = 0.3;

// ─── 持久化（localStorage，按 charId 分开存） ───

const DRIVE_KEY_PREFIX = 'desire_drive_';
const THOUGHTS_KEY_PREFIX = 'desire_thoughts_';
const THOUGHTS_MAX = 20;

const isDriveKey = (v: unknown): v is DriveKey => (DRIVE_KEYS as readonly string[]).includes(v as string);
const isNonFatigueDriveKey = (v: unknown): v is NonFatigueDriveKey => isDriveKey(v) && v !== 'fatigue';

export const readDriveState = (charId: string): DriveState => {
  try {
    const raw = localStorage.getItem(DRIVE_KEY_PREFIX + charId);
    if (!raw) return { ...ZERO_DRIVE };
    const parsed = JSON.parse(raw);
    const next = { ...ZERO_DRIVE };
    for (const k of DRIVE_KEYS) {
      if (typeof parsed?.[k] === 'number') next[k] = clamp01(parsed[k]);
    }
    return next;
  } catch {
    return { ...ZERO_DRIVE };
  }
};

export const writeDriveState = (charId: string, drive: DriveState): void => {
  try {
    localStorage.setItem(DRIVE_KEY_PREFIX + charId, JSON.stringify(drive));
  } catch {
    /* 存不下就下一拍再存，不是致命问题 */
  }
};

const isThought = (v: any): v is Thought =>
  !!v && typeof v.id === 'string' && typeof v.text === 'string' && isNonFatigueDriveKey(v.drive)
  && (v.kind === 'flit' || v.kind === 'fixation')
  && typeof v.strength === 'number' && typeof v.bornAt === 'number' && typeof v.fedCount === 'number';

export const readThoughts = (charId: string): Thought[] => {
  try {
    const raw = localStorage.getItem(THOUGHTS_KEY_PREFIX + charId);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter(isThought) : [];
  } catch {
    return [];
  }
};

export const writeThoughts = (charId: string, thoughts: Thought[]): void => {
  try {
    const trimmed = thoughts.length > THOUGHTS_MAX ? thoughts.slice(thoughts.length - THOUGHTS_MAX) : thoughts;
    localStorage.setItem(THOUGHTS_KEY_PREFIX + charId, JSON.stringify(trimmed));
  } catch {
    /* 同上，不是致命问题 */
  }
};

// ─── 对外的两个入口：每拍推进一次 + 做完事之后回落 ───

export interface DesireTickResult {
  intent: Intent;
  drive: DriveState;
  thoughts: Thought[];
}

/**
 * 推进这个角色的欲望状态机一拍：驱动条随时间涨（按人设关键词权重调整各维度速度）、念头池
 * 衰减/反哺，必要时自动冒出一条新念头，最后算出此刻最该发作的维度。纯函数计算 + 读写
 * localStorage，不碰任何聊天/排程相关的东西，调用方（lifeWake.ts）只管读这里返回的 intent
 * 决定要不要去问一次、给哪种方向提示。
 *
 * @param personaText 角色的人设文本（描述 + 系统提示词等拼起来），用来算每个维度的权重；
 *   不传或空字符串就是旧行为（所有维度权重=1）。
 */
export const tickDesire = (charId: string, now: Date, personaText = ''): DesireTickResult => {
  const weights = computePersonaDriveWeights(personaText);
  const drive = easeDrive(readDriveState(charId), now, weights);
  const ticked = tickThoughts(readThoughts(charId));
  let thoughts = ticked.thoughts;
  for (const [k, v] of Object.entries(ticked.feedback)) {
    drive[k as DriveKey] = clamp01(drive[k as DriveKey] + (v as number));
  }

  const intentBeforeAutofeed = pickIntent(drive, thoughts);
  if (!intentBeforeAutofeed.gated && Math.random() < AUTOFEED_CHANCE) {
    const driveKey = intentBeforeAutofeed.driveKey as NonFatigueDriveKey;
    const phrases = AUTOFEED_PHRASES[driveKey];
    const text = phrases[Math.floor(Math.random() * phrases.length)];
    thoughts = feedThought(thoughts, text, driveKey, now.getTime());
  }

  writeDriveState(charId, drive);
  writeThoughts(charId, thoughts);

  return { intent: pickIntent(drive, thoughts), drive, thoughts };
};

/**
 * 做完一次「没被 fatigue 闸住」的真行动之后：相关维度乘性回落 + fatigue 涨一点
 * （做了事总归累一点）。
 */
export const satisfyAfterAction = (charId: string, driveKey: NonFatigueDriveKey): void => {
  let drive = readDriveState(charId);
  drive = satisfy(drive, driveKey);
  drive = { ...drive, fatigue: clamp01(drive.fatigue + FATIGUE_GAIN_ON_ACTION) };
  writeDriveState(charId, drive);
};

/** 被 fatigue 闸住、乖乖歇了一下之后：fatigue 缓一口气往下降，不走标准 satisfy 那套回落表。 */
export const relieveAfterGatedRest = (charId: string): void => {
  const drive = readDriveState(charId);
  writeDriveState(charId, { ...drive, fatigue: clamp01(drive.fatigue - FATIGUE_RELIEF_ON_GATED_REST + FATIGUE_GAIN_ON_GATED_REST) });
};
