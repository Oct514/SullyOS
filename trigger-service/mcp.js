// MCP（Streamable HTTP，无状态 JSON）：让 TA 自己往"念头池"记惦记的事、办完划掉。
// 只提供三个工具；握手、列表、调用都按标准 JSON-RPC 回，和 Sully 现有的 MCP 接法一致。
const VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26'];

export const TOOLS = [
  {
    name: 'remember_thought',
    description:
      '记下一件你惦记着、还没了结、和他有关的事（他提过的约定、没聊完的话题、你担心的事）。' +
      '记下后，之后你想主动找他的时候会带上它。只记真正会让你想找他的事，别把闲聊都记下来；最多同时记 8 条，几天后自动淡掉。',
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string', description: '一句话说清惦记什么，例如"他下午要面试，想问问结果"' },
        weight: { type: 'integer', minimum: 5, maximum: 25, description: '有多惦记：5 轻、15 中、25 重，默认 15' },
      },
      required: ['text'],
    },
  },
  {
    name: 'resolve_thought',
    description: '某件惦记的事有了结果、或不用再惦记了，就把它划掉。需要 id（记下时会返回，也可用 list_thoughts 查）。',
    inputSchema: { type: 'object', properties: { id: { type: 'integer', description: '要划掉的念头 id' } }, required: ['id'] },
  },
  {
    name: 'list_thoughts',
    description: '看看你现在记着哪些惦记的事。',
    inputSchema: { type: 'object', properties: {} },
  },
];

const text = (t, isError = false) => ({ content: [{ type: 'text', text: t }], ...(isError ? { isError: true } : {}) });
const fmt = (items) => (items.length ? items.map((i) => `id ${i.id}：${i.text}`).join('\n') : '（现在没有惦记的事）');

function callTool(name, a, api) {
  if (name === 'remember_thought') {
    const t = typeof a.text === 'string' ? a.text.trim() : '';
    if (!t) return text('要写清楚惦记什么（text 不能为空）。', true);
    const r = api.add(t, a.weight);
    if (r.full) return text(`念头已经记满 ${r.max} 条了，先用 resolve_thought 划掉已经了结的：\n${fmt(r.items)}`, true);
    return text(`已记下（id ${r.item.id}）：${r.item.text}。之后想找他的时候会带上这件事；了结了记得用 resolve_thought 划掉。`);
  }
  if (name === 'resolve_thought') {
    const id = Math.trunc(Number(a.id));
    if (!Number.isFinite(id)) return text('需要提供念头的 id。', true);
    return api.done(id)
      ? text(`已划掉 id ${id}。`)
      : text(`没有 id ${id} 这条（可能已经划掉或自己淡掉了）。可以先用 list_thoughts 看看。`, true);
  }
  if (name === 'list_thoughts') return text(fmt(api.list()));
  return null;
}

// 返回 JSON-RPC 响应对象；通知 / 对方的响应不需要回，返回 null。
export function handleRpc(msg, api) {
  if (!msg || typeof msg !== 'object' || typeof msg.method !== 'string') return null;
  const { id, method, params } = msg;
  if (id === undefined || id === null) return null;
  const ok = (result) => ({ jsonrpc: '2.0', id, result });
  const err = (code, message) => ({ jsonrpc: '2.0', id, error: { code, message } });
  if (method === 'initialize') {
    const v = params?.protocolVersion;
    return ok({
      protocolVersion: VERSIONS.includes(v) ? v : '2025-06-18',
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: 'thought-pool', title: '念头池', version: '1.0.0' },
    });
  }
  if (method === 'ping') return ok({});
  if (method === 'tools/list') return ok({ tools: TOOLS });
  if (method === 'tools/call') {
    const r = callTool(params?.name, params?.arguments && typeof params.arguments === 'object' ? params.arguments : {}, api);
    return r ? ok(r) : err(-32602, `未知工具: ${params?.name}`);
  }
  return err(-32601, 'Method not found');
}
