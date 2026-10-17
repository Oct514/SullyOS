import { getReplyRunBySignal } from './chatReplyCancellation';

/**
 * 工具调用卡片（轻量版）：char 每调一次 MCP 工具，在单聊里落一条灰色居中小胶囊
 * 「✓ xxx 执行成功 / ✗ xxx 执行失败」。
 *
 * 实现取巧：用现成的 role:'system' 文本消息（聊天页本来就把它画成灰色胶囊），
 * 所以不用改渲染层。metadata.toolCard 作标记：
 *  - utils/chatContextRange.ts 据此把它挡在 AI 上下文外；
 *  - utils/chatMessageVisibility.ts 据此让它不被「隐藏系统日志」藏掉。
 *
 * 只在由 createReplyRun 发起的单聊/主动消息回复里记录；群聊和其它调用点
 * 拿不到 ReplyRun，自然不记录。
 */

const clip = (text: string, max: number): string => {
    const oneLine = String(text || '').replace(/\s+/g, ' ').trim();
    return oneLine.length > max ? `${oneLine.slice(0, max)}…` : oneLine;
};

/** 记一张卡片；任何失败都吞掉，绝不影响工具调用本身。 */
export async function recordToolCallCard(
    signal: AbortSignal | undefined,
    toolName: string,
    success: boolean,
    error?: string,
): Promise<void> {
    try {
        const run = getReplyRunBySignal(signal);
        if (!run) return;
        const name = clip(toolName, 60) || '工具';
        const text = success
            ? `✓ ${name} 执行成功`
            : `✗ ${name} 执行失败${error ? `：${clip(error, 40)}` : ''}`;
        await run.saveMessage({
            charId: run.charId,
            role: 'system',
            type: 'text',
            content: `[系统: ${text}]`,
            metadata: { toolCard: true, tool: toolName, ok: success },
        });
    } catch { /* 被用户中断、库写失败等：不记卡片，工具照常 */ }
}
