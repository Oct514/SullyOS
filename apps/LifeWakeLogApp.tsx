import React, { useCallback, useEffect, useState } from 'react';
import { useOS } from '../context/OSContext';
import { readLifeWakeLog, clearLifeWakeLog, type LifeWakeLogEntry } from '../utils/lifeWake';

const REASON_LABEL: Record<LifeWakeLogEntry['reason'], string> = {
  triggered: '触发了自由活动',
  missed: '判断过，没触发',
  'schedule-failed': '想触发，但排程失败了',
};

const REASON_STYLE: Record<LifeWakeLogEntry['reason'], string> = {
  triggered: 'text-emerald-600 bg-emerald-50',
  missed: 'text-slate-400 bg-slate-100',
  'schedule-failed': 'text-red-500 bg-red-50',
};

const formatTime = (ts: number): string => {
  const d = new Date(ts);
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  const time = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  const isToday = d.toDateString() === now.toDateString();
  return isToday ? time : `${d.getMonth() + 1}/${d.getDate()} ${time}`;
};

const BackIcon: React.FC = () => (
  <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={2.5} stroke="currentColor" className="w-5 h-5">
    <path strokeLinecap="round" strokeLinejoin="round" d="M15.75 19.5 8.25 12l7.5-7.5" />
  </svg>
);

const LifeWakeLogApp: React.FC = () => {
  const { closeApp, characters, addToast } = useOS();
  const [entries, setEntries] = useState<LifeWakeLogEntry[]>([]);

  const reload = useCallback(() => {
    setEntries(readLifeWakeLog());
  }, []);

  useEffect(() => {
    reload();
  }, [reload]);

  const nameFor = (charId: string) => characters.find((c) => c.id === charId)?.name || '（角色已删除）';

  const handleClear = () => {
    clearLifeWakeLog();
    reload();
    addToast('日志已清空', 'success');
  };

  return (
    <div className="h-full flex flex-col bg-gradient-to-b from-indigo-50 to-white">
      <div
        className="flex items-center justify-between px-4 py-3 border-b border-slate-100 shrink-0"
        style={{ paddingTop: 'max(0.75rem, var(--safe-top))' }}
      >
        <div className="flex items-center gap-1">
          <button onClick={closeApp} className="w-8 h-8 flex items-center justify-center text-slate-400 active:scale-90 transition-transform">
            <BackIcon />
          </button>
          <h1 className="text-base font-bold text-slate-800 ml-1">唤醒日志</h1>
        </div>
        {entries.length > 0 && (
          <button onClick={handleClear} className="text-[11px] text-slate-400 active:text-red-400 px-2 py-1">
            清空
          </button>
        )}
      </div>

      <div className="flex-1 overflow-y-auto px-4 py-3 space-y-2 min-h-0">
        {entries.length === 0 ? (
          <div className="flex flex-col items-center px-4 py-14 text-center space-y-3 opacity-70">
            <div className="text-4xl">🌙</div>
            <p className="text-sm text-slate-500 font-bold">还没有唤醒记录</p>
            <p className="text-[11px] text-slate-400 leading-relaxed max-w-[240px]">
              开着某个已开启"主动消息2.0"的角色的聊天页面一段时间，这里会记录每次后台判断
              "要不要让 ta 自由活动"的结果，包括判断过但没有触发的次数。
            </p>
          </div>
        ) : (
          entries.map((e, i) => (
            <div
              key={`${e.charId}-${e.at}-${i}`}
              className="bg-white rounded-2xl border border-slate-100 p-3 flex items-center justify-between shadow-sm"
            >
              <div className="min-w-0">
                <p className="text-xs font-bold text-slate-700 truncate">{nameFor(e.charId)}</p>
                <span className={`inline-block mt-1 text-[10px] px-2 py-0.5 rounded-full font-medium ${REASON_STYLE[e.reason]}`}>
                  {REASON_LABEL[e.reason]}
                </span>
              </div>
              <span className="text-[10px] text-slate-300 shrink-0 ml-2">{formatTime(e.at)}</span>
            </div>
          ))
        )}
      </div>
    </div>
  );
};

export default LifeWakeLogApp;
