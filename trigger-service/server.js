// 触发判断服务：零依赖，Node 18+。只做"判断"，不调用模型、不发推送。
// 推送由已部署的 AMSG Worker 负责，Worker 在发之前来问 POST /gate（守望任务）或 POST /allow（早安等普通任务）。
// Worker 问的时候会在 body 里带 {"lastUserMessageAt": 毫秒时间戳}，服务据此同步"用户最后一次开口"，
// 所以不需要单独接 /event/chat。
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

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
  const itemsW = S.items.reduce((a, i) => a + i.weight, 0);
  const eff = miss + itemsW;
  const thr = S.threshold * back;
  const base = { miss: Math.round(eff), threshold: Math.round(thr), unanswered: S.unanswered };
  if (commit) { S.miss = miss; S.missAt = now; }
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
    openItems: S.items.map((i) => i.text),
  };
  if (commit) {
    S.lastFire = now; S.miss = 0; S.missAt = now; S.unanswered++;
    S.threshold = CFG.threshold * (1 + CFG.jitter * (Math.random() * 2 - 1));
    S.fires = { day: t.day, n: fires + 1 };
    save();
  }
  return { fire: true, reason, context: ctx, ...base };
}

// 早安等普通任务用：只看"在睡觉 / 刚聊完"，不记账、不管失联和心绪。
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

const readBody = (req) => new Promise((ok) => {
  let b = ''; req.on('data', (c) => (b += c)); req.on('end', () => { try { ok(JSON.parse(b || '{}')); } catch { ok({}); } });
});

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://x');
  const send = (code, obj) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };
  if (u.pathname === '/') return send(200, { ok: true });
  const tok = req.headers['x-token'] || u.searchParams.get('token');
  if (tok !== TOKEN) return send(401, { error: 'unauthorized' });
  const now = Date.now();
  const parts = u.pathname.split('/').filter(Boolean);

  if (parts[0] === 'event' && req.method === 'POST') return event(parts[1], u.searchParams, now) ? send(200, { ok: true }) : send(404, { error: 'unknown event' });
  if ((parts[0] === 'gate' || parts[0] === 'allow') && req.method === 'POST') {
    const b = await readBody(req);
    syncChat(+b.lastUserMessageAt, now);
    return send(200, parts[0] === 'gate' ? decide(now, true) : allow(now));
  }
  if (parts[0] === 'status') return send(200, { ...decide(now, false), allow: allow(now), items: S.items, sleeping: S.sleeping, lastChat: S.lastChat, lastAct: S.lastAct, lastFire: S.lastFire });
  if (parts[0] === 'item' && req.method === 'POST') {
    const b = await readBody(req);
    if (parts[1] === 'done') { S.items = S.items.filter((i) => i.id !== b.id); save(); return send(200, { ok: true }); }
    if (!b.text) return send(400, { error: 'text required' });
    const item = { id: S.seq++, text: String(b.text).slice(0, 200), weight: Math.min(Math.max(+b.weight || 10, 1), 60) };
    S.items.push(item); save(); return send(200, item);
  }
  send(404, { error: 'not found' });
});

if (process.argv[1] && import.meta.url.endsWith(path.basename(process.argv[1]))) {
  server.listen(+(env.PORT || 8080), () => console.log('trigger-service on', env.PORT || 8080));
}
export const _test = { get S() { return S; }, set S(v) { S = v; }, event, fresh, syncChat };
