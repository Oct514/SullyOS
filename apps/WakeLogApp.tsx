import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { useOS } from '../context/OSContext';
import { ArrowLeft, ArrowClockwise, GearSix, Moon, Notebook, WarningCircle, Wrench, Trash, Pulse } from '@phosphor-icons/react';

// 「醒来记录」：看 TA 每次醒来做了什么。
// 数据来自 Zeabur 上的触发判断服务（GET /log）；服务地址和令牌只保存在这台设备的 localStorage 里。

type LogEntry = {
    id: number;
    at: number;
    kind: 'wake' | 'diary';
    decision?: 'pass' | 'skip';
    reason?: string;
    asleep?: boolean;
    gapHours?: number;
    localHour?: number;
    outcome?: string;
    skipReason?: string;
    tools?: string[];
    text?: string;
};

type Cfg = { url: string; token: string };

const CFG_KEY = 'sully_wakelog_cfg_v1';
const REFRESH_MS = 60_000;

const loadCfg = (): Cfg => {
    try {
        const raw = localStorage.getItem(CFG_KEY);
        if (raw) {
            const p = JSON.parse(raw);
            return { url: String(p?.url || ''), token: String(p?.token || '') };
        }
    } catch { /* ignore */ }
    return { url: '', token: '' };
};
const saveCfg = (c: Cfg) => {
    try { localStorage.setItem(CFG_KEY, JSON.stringify(c)); } catch { /* ignore */ }
};
const normUrl = (u: string) => u.trim().replace(/\/+$/, '');

const SKIP_LABEL: Record<string, string> = {
    'idle': '没有理由醒（没花钱）',
    'fuse:in-chat': '她正在聊天',
    'fuse:wake-gap': '刚醒过，隔得太近',
    'fuse:wake-daily-cap': '今天醒够次数了',
    'fuse:char-last': 'TA 刚发过，等她回',
};
const WHY_LABEL: Record<string, string> = {
    'long-silence': '她很久没出现',
    'miss': '想她了',
    'thought': '惦记的事该跟进',
    'random': '随便醒来逛逛',
    'back': '她回来了',
    'wake': '例行醒来',
};
const OUTCOME: Record<string, { label: string; cls: string }> = {
    'sent': { label: '发了消息', cls: 'bg-emerald-100 text-emerald-700' },
    'silent': { label: '选择不说', cls: 'bg-slate-100 text-slate-500' },
    'actions-only': { label: '只做了动作', cls: 'bg-sky-100 text-sky-700' },
    'skipped': { label: '没发', cls: 'bg-amber-100 text-amber-700' },
};

const prettyTool = (n: string) => (n.includes('__') ? (n.split('__').pop() || n) : n);
const pad2 = (n: number) => String(n).padStart(2, '0');
const dayKey = (t: number) => {
    const d = new Date(t);
    return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
};
const dayLabel = (key: string, todayKey: string, yesterdayKey: string) =>
    key === todayKey ? '今天' : key === yesterdayKey ? '昨天' : `${Number(key.slice(5, 7))}月${Number(key.slice(8, 10))}日`;
const hhmm = (t: number) => {
    const d = new Date(t);
    return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
};

const EntryRow: React.FC<{ e: LogEntry }> = ({ e }) => {
    const time = (
        <div className="w-11 shrink-0 text-right text-[11px] text-slate-400 pt-1 tabular-nums">{hhmm(e.at)}</div>
    );

    if (e.kind === 'diary') {
        return (
            <div className="flex gap-3">
                {time}
                <div className="flex-1 min-w-0 rounded-2xl bg-amber-50 border border-amber-100 px-3 py-2.5">
                    <div className="flex items-center gap-1.5 text-[11px] font-bold text-amber-700 mb-1">
                        <Notebook size={13} weight="fill" /> TA 的日记
                    </div>
                    <p className="text-[13px] text-slate-700 leading-relaxed whitespace-pre-wrap break-words">{e.text}</p>
                </div>
            </div>
        );
    }

    if (e.decision !== 'pass') {
        const label = SKIP_LABEL[e.reason || ''] || e.reason || '没醒';
        return (
            <div className="flex gap-3 items-center">
                {time}
                <div className="flex-1 min-w-0 text-[12px] text-slate-400">没醒 · {label}</div>
            </div>
        );
    }

    const outcome = e.outcome ? (OUTCOME[e.outcome] || { label: e.outcome, cls: 'bg-slate-100 text-slate-500' }) : null;
    const why = WHY_LABEL[e.reason || ''] || e.reason || '醒了';
    const tools = (e.tools || []).map(prettyTool);
    const uniqueTools = Array.from(new Set(tools));

    return (
        <div className="flex gap-3">
            {time}
            <div className="flex-1 min-w-0 rounded-2xl bg-white border border-slate-200 px-3 py-2.5 shadow-sm">
                <div className="flex flex-wrap items-center gap-1.5">
                    <span className="text-[13px] font-bold text-slate-800">醒了 · {why}</span>
                    {outcome ? (
                        <span className={`text-[10px] font-bold px-2 py-0.5 rounded-full ${outcome.cls}`}>{outcome.label}</span>
                    ) : (
                        <span className="text-[10px] font-bold px-2 py-0.5 rounded-full bg-amber-100 text-amber-700">结果未回报</span>
                    )}
                    {e.asleep && (
                        <span className="text-[10px] font-bold px-2 py-0.5 rounded-full bg-indigo-100 text-indigo-600 inline-flex items-center gap-1">
                            <Moon size={10} weight="fill" /> 她在睡觉
                        </span>
                    )}
                </div>
                {e.outcome === 'skipped' && e.skipReason && (
                    <p className="text-[11px] text-slate-400 mt-1">原因：{e.skipReason}</p>
                )}
                {uniqueTools.length > 0 && (
                    <div className="flex flex-wrap items-center gap-1 mt-1.5">
                        <Wrench size={11} weight="bold" className="text-slate-400" />
                        {uniqueTools.map((t) => (
                            <span key={t} className="text-[10px] px-1.5 py-0.5 rounded-md bg-slate-100 text-slate-500">{t}</span>
                        ))}
                    </div>
                )}
                {e.text && (
                    <div className="mt-2 rounded-xl bg-emerald-50 border border-emerald-100 px-2.5 py-2 text-[13px] text-slate-700 leading-relaxed whitespace-pre-wrap break-words">
                        {e.text}
                    </div>
                )}
            </div>
        </div>
    );
};

const WakeLogApp: React.FC = () => {
    const { closeApp, addToast } = useOS();
    const [cfg, setCfg] = useState<Cfg>(loadCfg);
    const [draft, setDraft] = useState<Cfg>(loadCfg);
    const [editing, setEditing] = useState<boolean>(() => !loadCfg().url);
    const [entries, setEntries] = useState<LogEntry[]>([]);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [showSkips, setShowSkips] = useState(false);
    const [loadedAt, setLoadedAt] = useState<number | null>(null);
    const configured = !!cfg.url && !!cfg.token;

    const load = useCallback(async () => {
        if (!cfg.url || !cfg.token) return;
        setLoading(true);
        setError(null);
        try {
            const res = await fetch(
                `${normUrl(cfg.url)}/log?limit=300&token=${encodeURIComponent(cfg.token.trim())}`,
                { cache: 'no-store' },
            );
            if (res.status === 401) throw new Error('令牌不对（要和 Zeabur 里设的 TOKEN 一致）');
            if (!res.ok) throw new Error(`服务返回 ${res.status}`);
            const data = await res.json();
            setEntries(Array.isArray(data?.entries) ? (data.entries as LogEntry[]) : []);
            setLoadedAt(Date.now());
        } catch (err) {
            const msg = err instanceof Error ? err.message : '';
            setError(/^(令牌|服务返回)/.test(msg) ? msg : '连不上：请检查地址、令牌，以及 Zeabur 上的服务是否在线');
        } finally {
            setLoading(false);
        }
    }, [cfg]);

    useEffect(() => {
        if (!configured) return;
        void load();
        const timer = window.setInterval(() => {
            if (document.visibilityState === 'visible') void load();
        }, REFRESH_MS);
        return () => window.clearInterval(timer);
    }, [configured, load]);

    const saveSettings = () => {
        let url = draft.url.trim();
        if (url && !/^https?:\/\//i.test(url)) url = `https://${url}`;
        const next: Cfg = { url: normUrl(url), token: draft.token.trim() };
        setCfg(next);
        setDraft(next);
        saveCfg(next);
        setEditing(false);
        addToast('已保存', 'success');
    };

    const clearLog = async () => {
        if (!window.confirm('清空所有醒来记录和 TA 的日记？这会删掉服务器上保存的记录。')) return;
        try {
            const res = await fetch(
                `${normUrl(cfg.url)}/log/clear?token=${encodeURIComponent(cfg.token.trim())}`,
                { method: 'POST' },
            );
            if (!res.ok) throw new Error('clear failed');
            setEntries([]);
            addToast('已清空', 'success');
        } catch {
            addToast('清空失败', 'error');
        }
    };

    const todayKey = dayKey(Date.now());
    const yesterdayKey = dayKey(Date.now() - 86_400_000);

    const stats = useMemo(() => {
        const today = entries.filter((e) => e.kind === 'wake' && dayKey(e.at) === todayKey);
        return {
            woke: today.filter((e) => e.decision === 'pass').length,
            sent: today.filter((e) => e.outcome === 'sent').length,
            skipped: today.filter((e) => e.decision !== 'pass').length,
        };
    }, [entries, todayKey]);

    const groups = useMemo(() => {
        const visible = entries.filter((e) => showSkips || e.kind === 'diary' || e.decision === 'pass');
        const map = new Map<string, LogEntry[]>();
        for (const e of visible) {
            const k = dayKey(e.at);
            if (!map.has(k)) map.set(k, []);
            map.get(k)!.push(e);
        }
        return Array.from(map.entries());
    }, [entries, showSkips]);

    return (
        <div className="h-full w-full bg-slate-50 flex flex-col text-slate-900">
            {/* 顶栏 */}
            <div className="bg-white/90 backdrop-blur border-b border-slate-200 shrink-0 sticky top-0 z-10" style={{ paddingTop: 'var(--safe-top)' }}>
                <div className="flex items-center gap-2 px-4 py-3">
                    <button onClick={closeApp} className="p-2 -ml-2 rounded-full hover:bg-black/5 active:scale-90 transition-transform">
                        <ArrowLeft size={22} weight="bold" className="text-slate-700" />
                    </button>
                    <h1 className="text-lg font-bold text-slate-800 flex items-center gap-2">
                        <Pulse size={20} weight="bold" className="text-indigo-500" /> 醒来记录
                    </h1>
                    <div className="ml-auto flex items-center gap-1">
                        {configured && (
                            <button
                                onClick={() => void load()}
                                disabled={loading}
                                className="p-2 rounded-full hover:bg-black/5 active:scale-90 transition-transform disabled:opacity-40"
                                title="刷新"
                            >
                                <ArrowClockwise size={20} weight="bold" className={`text-slate-600 ${loading ? 'animate-spin' : ''}`} />
                            </button>
                        )}
                        <button
                            onClick={() => { setDraft(cfg); setEditing((v) => !v); }}
                            className="p-2 rounded-full hover:bg-black/5 active:scale-90 transition-transform"
                            title="连接设置"
                        >
                            <GearSix size={20} weight="bold" className="text-slate-600" />
                        </button>
                    </div>
                </div>
            </div>

            <div className="flex-1 overflow-y-auto no-scrollbar px-4 pb-24">
                {/* 连接设置 */}
                {editing && (
                    <div className="mt-4 rounded-2xl bg-white border border-slate-200 p-4 space-y-3 shadow-sm">
                        <p className="text-[12px] text-slate-500 leading-relaxed">
                            填你 Zeabur 上「触发判断服务」的地址和令牌。只保存在这台设备上，不会上传到别处。
                        </p>
                        <label className="block">
                            <span className="text-[11px] font-bold text-slate-500">服务地址</span>
                            <input
                                value={draft.url}
                                onChange={(ev: React.ChangeEvent<HTMLInputElement>) => setDraft({ ...draft, url: ev.target.value })}
                                placeholder="https://xxxx.zeabur.app"
                                autoCapitalize="none"
                                autoCorrect="off"
                                spellCheck={false}
                                className="mt-1 w-full rounded-xl border border-slate-200 bg-slate-50 px-3 py-2 text-[13px] outline-none focus:border-indigo-300"
                            />
                        </label>
                        <label className="block">
                            <span className="text-[11px] font-bold text-slate-500">令牌（Zeabur 里的 TOKEN）</span>
                            <input
                                type="password"
                                value={draft.token}
                                onChange={(ev: React.ChangeEvent<HTMLInputElement>) => setDraft({ ...draft, token: ev.target.value })}
                                autoComplete="off"
                                className="mt-1 w-full rounded-xl border border-slate-200 bg-slate-50 px-3 py-2 text-[13px] outline-none focus:border-indigo-300"
                            />
                        </label>
                        <div className="flex gap-2 pt-1">
                            <button
                                onClick={saveSettings}
                                disabled={!draft.url.trim() || !draft.token.trim()}
                                className="flex-1 rounded-xl bg-indigo-500 text-white text-[13px] font-bold py-2.5 active:scale-95 transition-transform disabled:opacity-40"
                            >
                                保存
                            </button>
                            {configured && (
                                <button
                                    onClick={() => setEditing(false)}
                                    className="px-4 rounded-xl bg-slate-100 text-slate-600 text-[13px] font-bold active:scale-95 transition-transform"
                                >
                                    取消
                                </button>
                            )}
                        </div>
                    </div>
                )}

                {configured && !editing && (
                    <>
                        {/* 今日概览 */}
                        <div className="mt-4 grid grid-cols-3 gap-2">
                            {[
                                { n: stats.woke, t: '今天醒了' },
                                { n: stats.sent, t: '发了消息' },
                                { n: stats.skipped, t: '没醒（省下）' },
                            ].map((s) => (
                                <div key={s.t} className="rounded-2xl bg-white border border-slate-200 py-3 text-center shadow-sm">
                                    <div className="text-xl font-black text-slate-800 tabular-nums">{s.n}</div>
                                    <div className="text-[10px] text-slate-400 mt-0.5">{s.t}</div>
                                </div>
                            ))}
                        </div>

                        <div className="mt-3 flex items-center justify-between">
                            <label className="flex items-center gap-2 text-[12px] text-slate-500 select-none">
                                <input type="checkbox" checked={showSkips} onChange={(ev: React.ChangeEvent<HTMLInputElement>) => setShowSkips(ev.target.checked)} />
                                显示没醒的记录
                            </label>
                            {loadedAt && (
                                <span className="text-[10px] text-slate-400">更新于 {hhmm(loadedAt)}</span>
                            )}
                        </div>

                        {error && (
                            <div className="mt-3 rounded-2xl bg-red-50 border border-red-100 text-red-600 text-[12px] leading-relaxed px-3 py-2.5 flex gap-2">
                                <WarningCircle size={16} weight="fill" className="shrink-0 mt-0.5" />
                                <span>{error}</span>
                            </div>
                        )}

                        {!error && !loading && groups.length === 0 && (
                            <div className="text-center text-slate-400 text-sm py-16 leading-relaxed">
                                还没有记录。<br />等 TA 下一次醒来，这里就会出现。
                            </div>
                        )}

                        <div className="mt-4 space-y-5">
                            {groups.map(([key, list]) => (
                                <section key={key}>
                                    <h2 className="text-[12px] font-bold text-slate-500 mb-2">{dayLabel(key, todayKey, yesterdayKey)}</h2>
                                    <div className="space-y-2.5">
                                        {list.map((e) => (
                                            <EntryRow key={`${e.kind}-${e.id}`} e={e} />
                                        ))}
                                    </div>
                                </section>
                            ))}
                        </div>

                        {entries.length > 0 && (
                            <div className="mt-8 text-center">
                                <p className="text-[10px] text-slate-400">共 {entries.length} 条 · 服务器保留最近 14 天</p>
                                <button
                                    onClick={() => void clearLog()}
                                    className="mt-2 inline-flex items-center gap-1 text-[11px] text-slate-400 hover:text-red-500 active:scale-95 transition-transform"
                                >
                                    <Trash size={12} /> 清空记录
                                </button>
                            </div>
                        )}
                    </>
                )}
            </div>
        </div>
    );
};

export default WakeLogApp;
