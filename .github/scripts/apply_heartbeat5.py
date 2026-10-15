#!/usr/bin/env python3
"""心跳补丁 5：醒来记录 + 日记工具 + 称呼修正。

1) 写给角色的提示词（triggerGate.ts、mcp.js）里指"用户"的「他」统一改成「她」（用户是女生，角色自己用"你"称呼）。
2) Zeabur 服务：
   - 每次 /wake 都记一条（醒了 / 跳过 + 原因）；Worker 醒来结束后回报结果（发了 / 静默 / 只做了动作 / 工具名）；
   - 新增 MCP 工具 write_diary / read_diary，让角色自己记日记、接着上次想；
   - GET /log 返回合并后的记录（最新在前），POST /log/clear 清空。给之后的「醒来记录」App 用。
3) Worker：心跳那一轮放行时记下 wakeId，每轮工具调用收集工具名，结束时把结果回报给 /wake/result。

在仓库根目录运行，可重复运行；任何锚点找不到或不唯一就直接报错退出。
"""
import re
import sys
from pathlib import Path

GATE = Path('worker/amsg/src/triggerGate.ts')
INDEX = Path('worker/amsg/src/index.ts')
SERVER = Path('trigger-service/server.js')
MCP = Path('trigger-service/mcp.js')

# 「他」→「她」：避开"其他""吉他""他们""他人"
HE = re.compile(r'(?<![其吉])他(?![们人])')


def sub(text, old, new, label):
    n = text.count(old)
    if n != 1:
        sys.exit(f'[补丁5失败] {label}：锚点出现 {n} 次（应为 1 次）')
    return text.replace(old, new, 1)


# ───────────────────────── triggerGate.ts ─────────────────────────
GATE_REPORT = r'''const HB_WAKE_ID_KEY = '__hbWakeId';
const HB_TOOLS_KEY = '__hbTools';

/** 放行后在这一次 fire 的 scratch 上做个记号（并记下这次醒来的编号），onLLMOutput 靠它认出"这是心跳那一轮"。 */
export const flagHeartbeat = (scratch: Record<string, unknown> | undefined, wakeId?: number | null): void => {
  if (!scratch) return;
  scratch[HB_SCRATCH_KEY] = true;
  if (typeof wakeId === 'number') scratch[HB_WAKE_ID_KEY] = wakeId;
};

/** 心跳那一轮里，模型这一圈要调的工具名（多圈累加），结束时一起回报。 */
export const noteHeartbeatTools = (scratch: Record<string, unknown> | undefined, names: string[]): void => {
  if (!scratch || scratch[HB_SCRATCH_KEY] !== true) return;
  const prev = Array.isArray(scratch[HB_TOOLS_KEY]) ? (scratch[HB_TOOLS_KEY] as string[]) : [];
  scratch[HB_TOOLS_KEY] = [...prev, ...names].slice(0, 20);
};

/** 心跳那一轮结束时把结果回报给 Zeabur（给「醒来记录」看）。失败只吞掉，绝不影响发送。 */
export const reportHeartbeat = async (
  scratch: Record<string, unknown> | undefined,
  result: { outcome: string; reason?: string; text?: string },
): Promise<void> => {
  if (!cfg || !scratch || scratch[HB_SCRATCH_KEY] !== true) return;
  const wakeId = scratch[HB_WAKE_ID_KEY];
  if (typeof wakeId !== 'number') return;
  const tools = Array.isArray(scratch[HB_TOOLS_KEY]) ? (scratch[HB_TOOLS_KEY] as string[]) : [];
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 3_000);
  try {
    await fetch(`${cfg.url}/wake/result`, {
      method: 'POST',
      headers: { 'X-Token': cfg.token, 'content-type': 'application/json' },
      body: JSON.stringify({ wakeId, ...result, tools }),
      signal: ctrl.signal,
    });
  } catch {
    // 回报不到就算了
  } finally {
    clearTimeout(timer);
  }
};
'''


def patch_gate():
    t = GATE.read_text(encoding='utf-8')
    if 'reportHeartbeat' in t:
        print('triggerGate.ts：补丁5已打过，跳过')
        return
    t = sub(t, "  asleep: boolean;\n  openItems: string[];\n};", "  asleep: boolean;\n  wakeId: number | null;\n  openItems: string[];\n};", 'GateInfo')
    t = sub(t, "      wake?: unknown;\n", "      wake?: unknown;\n      id?: unknown;\n", 'ask 响应类型')
    t = sub(t, "        asleep: c.asleep === true,\n", "        asleep: c.asleep === true,\n        wakeId: typeof j.id === 'number' ? j.id : null,\n", 'ask 解析')
    t = sub(t, "  | { kind: 'pass'; why: string }", "  | { kind: 'pass'; why: string; wakeId?: number | null }", 'GateAction')
    t = sub(t, "    return { kind: 'pass', why: 'wake' };", "    return { kind: 'pass', why: 'wake', wakeId: a.info.wakeId };", '心跳放行带 wakeId')
    old_flag = ("/** 放行后在这一次 fire 的 scratch 上做个记号，onLLMOutput 靠它认出\"这是心跳那一轮\"。 */\n"
                "export const flagHeartbeat = (scratch: Record<string, unknown> | undefined): void => {\n"
                "  if (scratch) scratch[HB_SCRATCH_KEY] = true;\n};\n")
    t = sub(t, old_flag, GATE_REPORT, 'flagHeartbeat')
    t = sub(t, "  if (!lines.length) return '';\n",
            "  if (i.reason === 'wake') {\n"
            "    lines.push('如果这次醒来做了点什么（查了什么、想到了什么），用 write_diary 记一两句，她在「醒来记录」里能看到。');\n"
            "  }\n"
            "  if (!lines.length) return '';\n", '醒来提示加日记提醒')
    t = HE.sub('她', t)
    GATE.write_text(t, encoding='utf-8')
    print('triggerGate.ts：已打补丁5')


# ───────────────────────── index.ts ─────────────────────────
INDEX_REPORT = r'''
    // 心跳那一轮：收集工具名，结束时把结果回报给 Zeabur（给「醒来记录」看）。
    if (decision.decision === 'tool-request') {
      noteHeartbeatTools(ctx.scratch, decision.toolCalls.map((tc) => tc.function.name));
    } else {
      await reportHeartbeat(ctx.scratch, {
        outcome:
          decision.decision === 'finish'
            ? 'sent'
            : decision.reason === 'declined'
              ? 'silent'
              : decision.reason === 'side-effects-only'
                ? 'actions-only'
                : 'skipped',
        reason: decision.decision === 'skip-push' ? String(decision.reason) : undefined,
        text: decision.decision === 'finish' ? content.slice(0, 300) : undefined,
      });
    }
'''


def patch_index():
    t = INDEX.read_text(encoding='utf-8')
    if 'reportHeartbeat' in t:
        print('index.ts：补丁5已打过，跳过')
        return
    t = sub(t, "  rewriteSpeakBlock,\n", "  noteHeartbeatTools,\n  reportHeartbeat,\n  rewriteSpeakBlock,\n", 'import')
    t = sub(t, "      if (isHb && gate.kind === 'pass') flagHeartbeat(ctx.scratch);\n",
            "      if (isHb && gate.kind === 'pass') flagHeartbeat(ctx.scratch, gate.wakeId);\n", '记下 wakeId')
    t = sub(t, "        pushes: decision.decision === 'finish' ? decision.pushPayloads.length : 0,\n      });\n    }\n",
            "        pushes: decision.decision === 'finish' ? decision.pushPayloads.length : 0,\n      });\n    }\n" + INDEX_REPORT, '结果回报')
    INDEX.write_text(t, encoding='utf-8')
    print('index.ts：已打补丁5')


# ───────────────────────── server.js ─────────────────────────
SERVER_LOG = r'''
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
'''

SERVER_DIARY = r'''  diaryAdd(text) { const e = logAdd({ kind: 'diary', text: String(text).slice(0, 300) }); save(); return e; },
  diaryList(n) { return (S.log ?? []).filter((x) => x.kind === 'diary').slice(-n).map((e) => ({ ...e, when: whenStr(e.at) })); },
'''

SERVER_ROUTES = r'''  if (parts[0] === 'wake' && parts[1] === 'result' && req.method === 'POST') {
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
'''

SERVER_WAKE_ROUTE = r'''    if (parts[0] === 'wake') {
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
'''


def patch_server():
    t = SERVER.read_text(encoding='utf-8')
    if 'const logAdd' in t:
        print('server.js：补丁5已打过，跳过')
        return
    t = sub(t, "const liveItems = (now) => S.items.filter((i) => now - (i.at ??= now) < CFG.itemTtlH * HOUR);\n",
            "const liveItems = (now) => S.items.filter((i) => now - (i.at ??= now) < CFG.itemTtlH * HOUR);\n" + SERVER_LOG, 'logAdd')
    t = sub(t, "  list() { return liveItems(Date.now()); },\n", "  list() { return liveItems(Date.now()); },\n" + SERVER_DIARY, 'diary 接口')
    t = sub(t, "  if ((parts[0] === 'gate' || parts[0] === 'allow' || parts[0] === 'wake') && req.method === 'POST') {",
            SERVER_ROUTES + "  if ((parts[0] === 'gate' || parts[0] === 'allow' || parts[0] === 'wake') && req.method === 'POST') {", '新路由')
    t = sub(t, "    return send(200, parts[0] === 'gate' ? decide(now, true) : parts[0] === 'wake' ? wake(now, true, +b.unanswered, "
               "b.lastSelfSendAt == null ? NaN : +b.lastSelfSendAt) : allow(now));\n",
            SERVER_WAKE_ROUTE, 'wake 路由')
    SERVER.write_text(t, encoding='utf-8')
    print('server.js：已打补丁5')


# ───────────────────────── mcp.js ─────────────────────────
MCP_TOOLS = r'''    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'write_diary',
    description:
      '醒来之后，把你这次做了什么、查到了什么、想到了什么，用一两句话记进日记。她打开「醒来记录」就能看到。' +
      '静默醒来（没发消息）时尤其要记，不然她不知道你做过什么。别写长，一次一两句。',
    inputSchema: {
      type: 'object',
      properties: { text: { type: 'string', description: '一两句话，例如"查了今天的天气，明天降温，想提醒她加衣服"' } },
      required: ['text'],
    },
  },
  {
    name: 'read_diary',
    description: '看看你最近记的日记（最近 10 条），接着上次的事往下想。',
    inputSchema: { type: 'object', properties: {} },
  },
];'''

MCP_CALLS = r'''  if (name === 'list_thoughts') return text(fmt(api.list()));
  if (name === 'write_diary') {
    const t = typeof a.text === 'string' ? a.text.trim() : '';
    if (!t) return text('日记不能是空的，写一两句就好。', true);
    api.diaryAdd(t);
    return text('已记进日记。她打开「醒来记录」就能看到。');
  }
  if (name === 'read_diary') {
    const items = api.diaryList(10);
    return text(items.length ? items.map((e) => `${e.when}　${e.text}`).join('\n') : '（日记还是空的）');
  }
'''


def patch_mcp():
    t = MCP.read_text(encoding='utf-8')
    if 'write_diary' in t:
        print('mcp.js：补丁5已打过，跳过')
        return
    t = sub(t, "    inputSchema: { type: 'object', properties: {} },\n  },\n];", MCP_TOOLS, '工具表')
    t = sub(t, "  if (name === 'list_thoughts') return text(fmt(api.list()));\n", MCP_CALLS, '工具调用')
    t = HE.sub('她', t)
    MCP.write_text(t, encoding='utf-8')
    print('mcp.js：已打补丁5')


if __name__ == '__main__':
    patch_gate()
    patch_index()
    patch_server()
    patch_mcp()
