// 触发判断服务：零依赖，Node 18+。只做"判断"，不调用模型、不发推送。
// 推送由已部署的 AMSG Worker 负责，Worker 在发之前来问 POST /gate（守望任务）或 POST /allow（早安等普通任务）。
// Worker 问的时候会在 body 里带 {"lastUserMessageAt": 毫秒时间戳}，服务据此同步"用户最后一次开口"，
// 所以不需要单独接 /event/chat。
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { handleRpc } from './mcp.js';

const env = process.env;
const TOKEN = env.TOKEN;
if (!TOKEN) { console.error('请设置环境变量 TOKEN'); process.exit(1); }

const hm = (s) => { const [h, m] = s.split(':').map(Number); return h * 60 + m; };
const CFG = {
  tz: env.TZ_NAME || 'Asia/Shanghai',            // 改成你自己所在的时区
  nightStart: hm(env.NIGHT_START || '01:30'),   // 深夜窗口
  nightEnd: hm(env.NIGHT_END || '08:00'),
  meals: (env.MEALS || '12:30,18:30').split(',').map(hm),
  gapMealH: +(env.GAP_MEAL_H || 4),             // 失联超过 N 小时且跨过饭点
  gapMaxH: +(env.GAP_MAX_H || 10),              // 或单纯失联超过 N 小时
  flickerCount: +(env.FLICKER_COUNT || 6),      // 深夜 30 分钟内手机活动次数
  chatActiveMin: +(env.CHAT_ACTIVE_MIN || 10),  // 聊天刚结束 N 分钟内：绝对静默
  chatCooldownMin: +(env.CHAT_COOLDOWN_MIN || 30),
  fireCooldownMin: +(env.FIRE_COOLDOWN_MIN || 90),
  maxFiresPerDay: +(env.MAX_FIRES_PER_DAY || 4),
  missRate: +(env.MISS_RATE || 12),             // 心绪值每小时增长
  threshold: +(env.THRESHOLD || 100),
  jitter: +(env.JITTER || 0.25),                // 阈值随机抖动 ±25%
  itemTtlH: +(env.ITEM_TTL_H || 72),            // 念头多久没被提起就自己淡掉
  maxAiItems: +(env.MAX_AI_ITEMS || 8),         // TA 自己最多同时记几条
  wakeMinGapMin: +(env.WAKE_MIN_GAP_MIN || 20), // 两次醒来至少隔多久（防起点任务和链撞在同一格）
  maxWakesPerDay: +(env.MAX_WAKES_PER_DAY || 40), // 一天最多醒几次（每次醒来都可能调一次模型）
  afterCharQuietH: +(env.AFTER_CHAR_QUIET_H || 6), // TA 主动说了最后一句、你没回：这么多小时内不再醒
};

const FILE = path.join(env.DATA_DIR || './data', 'state.json');
const fresh = () => ({
  lastChat: 0, lastAct: 0, lastFire: 0, sleeping: false, sleepAt: 0,
  miss: 0, missAt: Date.now(), threshold: CFG.threshold, unanswered: 0,
  fires: { day: '', n: 0 }, phoneActs: [], pcActs: [], items: [], seq: 1,
});
let S = fresh();
try { S = { ...S, ...JSON.parse(fs.readFileSync(FILE, 'utf8')) }; } catch {}
const save = () => {
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  fs.writeFileSync(FILE + '.tmp', JSON.stringify(S));
  fs.renameSync(FILE + '.tmp', FILE);
};

const fmt = new Intl.DateTimeFormat('en-GB', {
  timeZone: CFG.tz, hour12: false, year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit',
});
const local = (ts) => {
  const p = Object.fromEntries(fmt.formatToParts(ts).map((x) => [x.type, x.value]));
  const h = +p.hour % 24, m = +p.minute;
  return { min: h * 60 + m, day: `${p.year}-${p.month}-${p.day}`, hour: h };
};
const inWin = (x, s, e) => (s <= e ? x >= s && x < e : x >= s || x < e);
const MIN = 60000, HOUR = 3600000;

// 还有效的念头：超过 itemTtlH 小时的自动淡掉；没有时间戳的老数据从现在起算。
const liveItems = (now) => S.items.filter((i) => now - (i.at ??= now) < CFG.itemTtlH * HOUR);

// 醒来记录 / 日记：一条一条存，保留 14 天、最多 400 条。给 GET /log 和之后的「醒来记录」App 用。
const logAdd = (e) => {
  S.log ??= []; S.logSeq ??= 1;
  const entry = { id: S.logSeq++, at: Date.now(), ...e };
  S.log.push(entry);
  const cutoff = Date.now() - 14 * 24 * HOUR;
  S.log = S.log.filter((x) => x.at > cutoff).slice(-400);
  return entry;
};
const whenStr = (ts) => { const l = local(ts); return `${l.day} ${String(Math.floor(l.min / 60)).padStart(2, '0')}:${String(l.min % 60).padStart(2, '0')}`; };

// 用户最后一次开口的时间（Worker 带来的）。比已知的新 = 他刚聊过：清零"没人理"和心绪。
function syncChat(ts, now) {
  if (!Number.isFinite(ts) || ts <= 0 || ts > now + MIN) return;
  if (ts > S.lastChat) {
    S.lastChat = ts; S.lastAct = Math.max(S.lastAct, ts);
    S.unanswered = 0; S.miss = 0; S.missAt = now;
    save();
  }
}

// 核心：先熔断 → 再现实偏离 → 最后心绪阈值。commit=false 时只看不改。
export function decide(now, commit) {
  const t = local(now);
  const back = 1 + S.unanswered;                       // 没人理就越来越克制
  const dtH = Math.min((now - S.missAt) / HOUR, 6);
  const miss = S.miss + CFG.missRate * dtH;
  const items = liveItems(now);
  const itemsW = items.reduce((a, i) => a + i.weight, 0);
  const eff = miss + itemsW;
  const thr = S.threshold * back;
  const base = { miss: Math.round(eff), threshold: Math.round(thr), unanswered: S.unanswered };
  if (commit) { S.miss = miss; S.missAt = now; S.items = items; }
  const no = (reason) => ({ fire: false, reason, ...base });

  // —— 硬熔断 ——
  const sinceChat = (now - S.lastChat) / MIN;
  if (S.lastChat && sinceChat < CFG.chatActiveMin) return no('fuse:in-chat');
  if (S.lastChat && sinceChat < CFG.chatCooldownMin) return no('fuse:post-chat-cooldown');
  if (S.lastFire && (now - S.lastFire) / MIN < CFG.fireCooldownMin) return no('fuse:fire-cooldown');
  const fires = S.fires.day === t.day ? S.fires.n : 0;
  if (fires >= CFG.maxFiresPerDay) return no('fuse:daily-cap');
  if (S.sleeping && now - S.sleepAt < 12 * HOUR) return no('fuse:sleeping');
  const night = inWin(t.min, CFG.nightStart, CFG.nightEnd);
  const act = (arr, min) => arr.filter((x) => now - x < min * MIN).length;
  if (night && act(S.phoneActs, 20) + act(S.pcActs, 20) === 0) return no('fuse:night-quiet');

  // —— 现实偏离 ——
  const seen = Math.max(S.lastChat, S.lastAct);
  const gapMin = seen ? (now - seen) / MIN : 0;
  const mealBetween = seen && (gapMin >= 1440 || CFG.meals.some((m) => (m - local(seen).min + 1440) % 1440 < gapMin));
  let reason = null;
  if (night && (act(S.phoneActs, 30) >= CFG.flickerCount || act(S.pcActs, 30) >= 20)) reason = 'late-night-active';
  else if (seen && ((gapMin / 60 >= CFG.gapMealH * back && mealBetween) || gapMin / 60 >= CFG.gapMaxH * back))
    reason = 'long-silence';
  // —— 心绪溢出 ——
  else if (eff >= thr) reason = 'overflow';
  if (!reason) return no('idle');

  const ctx = {
    gapHours: +(gapMin / 60).toFixed(1), localHour: t.hour, missedMeal: !!mealBetween,
    openItems: items.map((i) => i.text),
  };
  if (commit) {
    S.lastFire = now; S.miss = 0; S.missAt = now; S.unanswered++;
    S.threshold = CFG.threshold * (1 + CFG.jitter * (Math.random() * 2 - 1));
    S.fires = { day: t.day, n: fires + 1 };
    // TA 自己记的念头：这次说过了就淡一半，淡到很轻就不再算；你手动加的保持不变。
    S.items = S.items.map((i) => (i.src === 'ai' ? { ...i, weight: Math.floor(i.weight / 2) } : i)).filter((i) => i.weight >= 3);
    save();
  }
  return { fire: true, reason, context: ctx, ...base };
}

// 早安等普通任务用：只看"在睡觉 / 刚聊完"，不记账、不管失联和心绪。
// 心跳醒来用：只做熔断（刚聊完 / 睡觉 / 深夜没动静 / 醒得太密 / 当天醒太多次），说不说由角色自己定。
export function wake(now, commit, unanswered, lastSelfSendAt) {
  const t = local(now);
  const items = liveItems(now);
  const act = (arr, min) => arr.filter((x) => now - x < min * MIN).length;
  const no = (reason) => ({ wake: false, reason });
  // 你说了最后一句：只留"正聊着"那一小段静默，之后允许醒（不再有 30 分钟冷却）。
  if (S.lastChat && (now - S.lastChat) / MIN < CFG.chatActiveMin) return no('fuse:in-chat');
  // TA 主动说了最后一句、你还没回：不再醒（时间不明也按不醒算）。
  const un = Number.isFinite(unanswered) ? unanswered : S.unanswered;
  // 睡着 / 深夜没动静：不再拦着不醒——这是角色自己的时间（思考、调工具、联网），只提醒它别发消息吵醒你。
  const asleep = (S.sleeping && now - S.sleepAt < 12 * HOUR)
    || (inWin(t.min, CFG.nightStart, CFG.nightEnd) && act(S.phoneActs, 20) + act(S.pcActs, 20) === 0);
  // 睡着时醒来不是为了发消息，所以不受上面"TA 主动说了最后一句"的限制。
  if (!asleep && un >= 1 && (!Number.isFinite(lastSelfSendAt) || now - lastSelfSendAt < CFG.afterCharQuietH * HOUR)) return no('fuse:char-last');
  if (S.lastWake && (now - S.lastWake) / MIN < CFG.wakeMinGapMin) return no('fuse:wake-gap');
  const wakes = S.wakes?.day === t.day ? S.wakes.n : 0;
  if (wakes >= CFG.maxWakesPerDay) return no('fuse:wake-daily-cap');
  const seen = Math.max(S.lastChat, S.lastAct);
  const gapMin = seen ? (now - seen) / MIN : 0;
  const mealBetween = seen && (gapMin >= 1440 || CFG.meals.some((m) => (m - local(seen).min + 1440) % 1440 < gapMin));
  if (commit) { S.lastWake = now; S.wakes = { day: t.day, n: wakes + 1 }; save(); }
  return {
    wake: true, reason: 'wake', unanswered: un,
    context: { gapHours: +(gapMin / 60).toFixed(1), localHour: t.hour, missedMeal: !!mealBetween, asleep, openItems: items.map((i) => i.text) },
  };
}

export function allow(now) {
  if (S.sleeping && now - S.sleepAt < 12 * HOUR) return { allow: false, reason: 'sleeping' };
  if (S.lastChat && (now - S.lastChat) / MIN < CFG.chatActiveMin) return { allow: false, reason: 'in-chat' };
  return { allow: true, reason: 'ok' };
}

function event(type, q, now) {
  const prune = (a) => a.filter((x) => now - x < 3 * HOUR).slice(-300);
  if (type === 'chat') { S.lastChat = now; S.lastAct = now; S.unanswered = 0; S.miss = 0; S.missAt = now; }
  else if (type === 'phone') { S.phoneActs = prune([...S.phoneActs, now]); S.lastAct = now; }
  else if (type === 'pc') {
    if (+(q.get('idle') ?? 0) < 180) { S.pcActs = prune([...S.pcActs, now]); S.lastAct = now; }
  }
  else if (type === 'sleep_on') { S.sleeping = true; S.sleepAt = now; }
  else if (type === 'sleep_off') { S.sleeping = false; S.lastAct = now; S.phoneActs = prune([...S.phoneActs, now]); }
  else return false;
  save();
  return true;
}

// 给 MCP 工具用的念头池接口（TA 自己记 / 划掉 / 看）。
const mcpApi = {
  add(text, weight) {
    const now = Date.now(), items = liveItems(now), t = text.slice(0, 200);
    const w = Math.min(Math.max(Math.trunc(+weight) || 15, 5), 25);
    const dup = items.find((i) => i.text === t);
    if (dup) { dup.weight = Math.max(dup.weight, w); dup.at = now; S.items = items; save(); return { item: dup }; }
    if (items.filter((i) => i.src === 'ai').length >= CFG.maxAiItems) return { full: true, max: CFG.maxAiItems, items };
    const item = { id: S.seq++, text: t, weight: w, at: now, src: 'ai' };
    S.items = [...items, item]; save(); return { item };
  },
  done(id) { const n = S.items.length; S.items = S.items.filter((i) => i.id !== id); save(); return S.items.length < n; },
  list() { return liveItems(Date.now()); },
  diaryAdd(text) { const e = logAdd({ kind: 'diary', text: String(text).slice(0, 300) }); save(); return e; },
  diaryList(n) { return (S.log ?? []).filter((x) => x.kind === 'diary').slice(-n).map((e) => ({ ...e, when: whenStr(e.at) })); },
};

const readBody = (req) => new Promise((ok) => {
  let b = ''; req.on('data', (c) => (b += c)); req.on('end', () => { try { ok(JSON.parse(b || '{}')); } catch { ok({}); } });
});

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://x');
  const cors = {
    'access-control-allow-origin': '*',
    'access-control-allow-methods': 'GET,POST,DELETE,OPTIONS',
    'access-control-allow-headers': 'content-type,authorization,x-token,accept,mcp-session-id,mcp-protocol-version',
    'access-control-expose-headers': 'Mcp-Session-Id',
  };
  const send = (code, obj) => { res.writeHead(code, { ...cors, 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };
  if (req.method === 'OPTIONS') { res.writeHead(204, cors); return res.end(); }
  if (u.pathname === '/') return send(200, { ok: true });
  const bearer = /^Bearer\s+(.+)$/i.exec(req.headers.authorization || '')?.[1];
  const tok = req.headers['x-token'] || bearer || u.searchParams.get('token');
  if (tok !== TOKEN) return send(401, { error: 'unauthorized' });
  const now = Date.now();
  const parts = u.pathname.split('/').filter(Boolean);

  if (parts[0] === 'mcp') {
    if (req.method !== 'POST') { res.writeHead(405, { ...cors, allow: 'POST' }); return res.end(); }
    const raw = await readBody(req);
    const msgs = Array.isArray(raw) ? raw : [raw];
    const out = msgs.map((m) => handleRpc(m, mcpApi)).filter(Boolean);
    if (!out.length) { res.writeHead(202, cors); return res.end(); }
    return send(200, Array.isArray(raw) ? out : out[0]);
  }
  if (parts[0] === 'event' && req.method === 'POST') return event(parts[1], u.searchParams, now) ? send(200, { ok: true }) : send(404, { error: 'unknown event' });
  if (parts[0] === 'wake' && parts[1] === 'result' && req.method === 'POST') {
    const b = await readBody(req);
    const e = (S.log ?? []).find((x) => x.id === +b.wakeId);
    if (e) {
      e.outcome = String(b.outcome || '').slice(0, 20);
      if (b.reason) e.skipReason = String(b.reason).slice(0, 60);
      e.tools = Array.isArray(b.tools) ? b.tools.filter((x) => typeof x === 'string').slice(0, 20) : [];
      if (b.text) e.text = String(b.text).slice(0, 300);
      save();
    }
    return send(200, { ok: !!e });
  }
  if (parts[0] === 'log' && parts[1] === 'clear' && req.method === 'POST') { S.log = []; save(); return send(200, { ok: true }); }
  if (parts[0] === 'log' && req.method === 'GET') {
    const n = Math.min(Math.max(+u.searchParams.get('limit') || 100, 1), 400);
    return send(200, { entries: (S.log ?? []).slice(-n).reverse(), now });
  }
  if ((parts[0] === 'gate' || parts[0] === 'allow' || parts[0] === 'wake') && req.method === 'POST') {
    const b = await readBody(req);
    syncChat(+b.lastUserMessageAt, now);
    if (parts[0] === 'wake') {
      const r = wake(now, true, +b.unanswered, b.lastSelfSendAt == null ? NaN : +b.lastSelfSendAt);
      const c = r.context ?? {};
      const e = logAdd({
        kind: 'wake', decision: r.wake ? 'pass' : 'skip', reason: r.reason,
        ...(r.wake ? { asleep: !!c.asleep, gapHours: c.gapHours, localHour: c.localHour } : {}),
      });
      save();
      return send(200, { ...r, id: e.id });
    }
    return send(200, parts[0] === 'gate' ? decide(now, true) : allow(now));
  }
  if (parts[0] === 'status') return send(200, { ...decide(now, false), allow: allow(now), items: liveItems(now), sleeping: S.sleeping, lastChat: S.lastChat, lastAct: S.lastAct, lastFire: S.lastFire });
  if (parts[0] === 'item' && req.method === 'POST') {
    const b = await readBody(req);
    if (parts[1] === 'done') { S.items = S.items.filter((i) => i.id !== b.id); save(); return send(200, { ok: true }); }
    if (!b.text) return send(400, { error: 'text required' });
    const item = { id: S.seq++, text: String(b.text).slice(0, 200), weight: Math.min(Math.max(+b.weight || 10, 1), 60), at: now, src: 'manual' };
    S.items.push(item); save(); return send(200, item);
  }
  send(404, { error: 'not found' });
});

if (process.argv[1] && import.meta.url.endsWith(path.basename(process.argv[1]))) {
  server.listen(+(env.PORT || 8080), () => console.log('trigger-service on', env.PORT || 8080));
}
export const _test = { get S() { return S; }, set S(v) { S = v; }, event, fresh, syncChat };
