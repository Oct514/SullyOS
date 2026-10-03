import React, { useCallback, useEffect, useState } from 'react';
import { useOS } from '../context/OSContext';
import { readLifeWakeLog, clearLifeWakeLog, type LifeWakeLogEntry } from '../utils/lifeWake';
import type { DriveKey } from '../utils/desireSystem';

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

/** 驱动维度的中文名，日志里按这个显示，比看英文 key 直观。 */
const DRIVE_LABEL: Record<DriveKey, string> = {
  attachment: '想念',
  curiosity: '好奇',
  reflection: '沉淀',
  duty: '挂念',
  social: '社交',
  fatigue: '疲惫',
  libido: '亲近',
  stress: '压力',
};

const formatTime = (ts: number): string => {
  const d = new Date(ts);
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  const time = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  const isToday = d.toDateString() === now.toDateString();
  return isToday ? time : `${d.getMonth() + 1}/${d.getDate()} ${time}`;
};

const formatScore = (score?: number): string => {
  if (typeof score !== 'number') return '';
  return score.toFixed(2);
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
    // 内容摘要是触发几分钟后才异步回填的（见 OSContext 的 attachLifeWakeExcerpt 调用），
    // 日志面板开着的这段时间里定时刷新一次，免得用户得手动关了再开才能看到摘要补上。
    const timer = setInterval(reload, 20_000);
    return () => clearInterval(timer);
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
              开着某个已开启"主动消息2.0"的角色的聊天页面一段时间，这里会记录每次欲望状态机
              判断"要不要让 ta 自由活动"的结果，包括判断过但分数还没攒够门槛的次数。
            </p>
          </div>
        ) : (
          entries.map((e, i) => (
            <div
              key={`${e.charId}-${e.at}-${i}`}
              className="bg-white rounded-2xl border border-slate-100 p-3 shadow-sm"
            >
              <div className="flex items-center justify-between">
                <div className="min-w-0">
                  <p className="text-xs font-bold text-slate-700 truncate">{nameFor(e.charId)}</p>
                  <div className="flex items-center gap-1.5 mt-1 flex-wrap">
                    <span className={`inline-block text-[10px] px-2 py-0.5 rounded-full font-medium ${REASON_STYLE[e.reason]}`}>
                      {REASON_LABEL[e.reason]}
                    </span>
                    {e.driveKey && (
                      <span className="inline-block text-[10px] px-2 py-0.5 rounded-full font-medium text-indigo-500 bg-indigo-50">
                        {DRIVE_LABEL[e.driveKey]} {formatScore(e.score)}
                      </span>
                    )}
                  </div>
                </div>
                <span className="text-[10px] text-slate-300 shrink-0 ml-2">{formatTime(e.at)}</span>
              </div>
              {e.excerpt && (
                <p className="mt-2 text-[11px] text-slate-500 leading-snug border-t border-slate-50 pt-2">
                  "{e.excerpt}"
                </p>
              )}
              {e.reason === 'triggered' && !e.excerpt && (
                <p className="mt-2 text-[10px] text-slate-300 leading-snug border-t border-slate-50 pt-2">
                  还没取到内容（可能还在生成，或者这次选择了沉默）
                </p>
              )}
            </div>
          ))
        )}
      </div>
    </div>
  );
};

export default LifeWakeLogApp;
