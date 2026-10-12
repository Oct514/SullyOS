import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useOS } from '../context/OSContext';
import {
  ImageGenConfig,
  ImageGenProvider,
  GenResult,
  SizeKey,
  generateImages,
  loadConfig,
  saveConfig,
} from '../utils/imageGen';
import {
  StoredHistory,
  StoredRef,
  loadHistory,
  loadRefs,
  saveHistory,
  saveRefs,
  uid,
} from '../utils/imageGenStore';

const SIZES: { k: SizeKey; label: string }[] = [
  { k: 'portrait', label: '竖图' },
  { k: 'landscape', label: '横图' },
  { k: 'square', label: '方图' },
];

const inputCls =
  'w-full rounded-xl bg-white border border-slate-200 px-3 py-2 text-sm outline-none focus:border-violet-400';

const Field: React.FC<{ label: string; children: React.ReactNode }> = ({ label, children }) => (
  <label className="block">
    <div className="text-[11px] font-bold text-slate-500 mb-1">{label}</div>
    {children}
  </label>
);

const ImageGenApp: React.FC = () => {
  const { closeApp } = useOS();
  const [cfg, setCfg] = useState<ImageGenConfig>(() => loadConfig());
  const [refs, setRefs] = useState<StoredRef[]>([]);
  const [history, setHistory] = useState<StoredHistory[]>([]);
  const [lockOn, setLockOn] = useState(true);
  const [prompt, setPrompt] = useState('');
  const [negative, setNegative] = useState(() => loadConfig().negativeDefault);
  const [size, setSize] = useState<SizeKey>('portrait');
  const [n, setN] = useState(1);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [results, setResults] = useState<GenResult[]>([]);
  const [tab, setTab] = useState<'make' | 'history'>('make');
  const [showSettings, setShowSettings] = useState(false);
  const [preview, setPreview] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    loadRefs().then(setRefs);
    loadHistory().then(setHistory);
  }, []);

  const refUrls = useMemo(() => refs.map((r) => URL.createObjectURL(r.blob)), [refs]);
  useEffect(() => () => refUrls.forEach((u) => URL.revokeObjectURL(u)), [refUrls]);
  const histUrls = useMemo(() => history.map((h) => URL.createObjectURL(h.blob)), [history]);
  useEffect(() => () => histUrls.forEach((u) => URL.revokeObjectURL(u)), [histUrls]);

  const patch = (p: Partial<ImageGenConfig>) => {
    const next = { ...cfg, ...p };
    setCfg(next);
    saveConfig(next);
  };
  const patchOpenAI = (p: Partial<ImageGenConfig['openai']>) => patch({ openai: { ...cfg.openai, ...p } });
  const patchNai = (p: Partial<ImageGenConfig['novelai']>) => patch({ novelai: { ...cfg.novelai, ...p } });

  const addRefs = async (files: FileList | null) => {
    if (!files || !files.length) return;
    const added: StoredRef[] = Array.from(files).map((f) => ({ id: uid(), name: f.name, blob: f }));
    const next = [...refs, ...added].slice(0, 4);
    setRefs(next);
    saveRefs(next);
    setLockOn(true);
    if (fileRef.current) fileRef.current.value = '';
  };

  const removeRef = (id: string) => {
    const next = refs.filter((r) => r.id !== id);
    setRefs(next);
    saveRefs(next);
  };

  const useAsRef = (blob?: Blob) => {
    if (!blob) return;
    const next = [...refs, { id: uid(), name: 'generated.png', blob }].slice(0, 4);
    setRefs(next);
    saveRefs(next);
    setLockOn(true);
    setTab('make');
  };

  const run = async () => {
    if (!prompt.trim()) {
      setError('先写点提示词');
      return;
    }
    setBusy(true);
    setError('');
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    try {
      const imgs = await generateImages({
        cfg,
        prompt,
        negative,
        size,
        n,
        refs: lockOn ? refs.map((r) => r.blob) : [],
        signal: ctrl.signal,
      });
      setResults(imgs);
      const fresh: StoredHistory[] = imgs
        .filter((i) => i.blob)
        .map((i) => ({
          id: uid(),
          createdAt: Date.now(),
          prompt,
          provider: cfg.provider,
          blob: i.blob as Blob,
        }));
      const merged = [...fresh, ...history].slice(0, 40);
      setHistory(merged);
      saveHistory(merged);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
      abortRef.current = null;
    }
  };

  const removeHistory = (id: string) => {
    const next = history.filter((h) => h.id !== id);
    setHistory(next);
    saveHistory(next);
  };

  return (
    <div
      className="w-full h-full flex flex-col bg-slate-50 text-slate-800"
      style={{ paddingTop: 'var(--chrome-top, 1.5rem)' }}
    >
      {/* 顶栏 */}
      <div className="flex items-center justify-between px-4 py-3 bg-white/80 backdrop-blur border-b border-slate-200">
        <button onClick={closeApp} className="text-sm font-bold text-slate-500 active:scale-95">
          返回
        </button>
        <div className="flex gap-1 bg-slate-100 rounded-full p-0.5 text-xs font-bold">
          {(['make', 'history'] as const).map((t) => (
            <button
              key={t}
              onClick={() => setTab(t)}
              className={`px-3 py-1 rounded-full ${tab === t ? 'bg-white shadow text-violet-600' : 'text-slate-500'}`}
            >
              {t === 'make' ? '生图' : `历史 ${history.length}`}
            </button>
          ))}
        </div>
        <button onClick={() => setShowSettings((s) => !s)} className="text-lg active:scale-95">
          ⚙️
        </button>
      </div>

      <div className="flex-1 overflow-y-auto px-4 py-4 space-y-4">
        {/* 设置 */}
        {showSettings && (
          <div className="rounded-2xl bg-white border border-slate-200 p-4 space-y-3">
            <div className="flex gap-2">
              {(['openai', 'novelai'] as ImageGenProvider[]).map((p) => (
                <button
                  key={p}
                  onClick={() => patch({ provider: p })}
                  className={`flex-1 py-2 rounded-xl text-sm font-bold border ${
                    cfg.provider === p ? 'bg-violet-500 text-white border-violet-500' : 'bg-white text-slate-500 border-slate-200'
                  }`}
                >
                  {p === 'openai' ? 'OpenAI 兼容' : 'NovelAI'}
                </button>
              ))}
            </div>

            {cfg.provider === 'openai' ? (
              <>
                <Field label="接口地址（Base URL）">
                  <input className={inputCls} value={cfg.openai.baseUrl} onChange={(e) => patchOpenAI({ baseUrl: e.target.value })} />
                </Field>
                <Field label="API Key">
                  <input className={inputCls} type="password" value={cfg.openai.apiKey} onChange={(e) => patchOpenAI({ apiKey: e.target.value })} />
                </Field>
                <Field label="模型">
                  <input className={inputCls} value={cfg.openai.model} onChange={(e) => patchOpenAI({ model: e.target.value })} />
                </Field>
                <Field label="质量">
                  <select className={inputCls} value={cfg.openai.quality} onChange={(e) => patchOpenAI({ quality: e.target.value as ImageGenConfig['openai']['quality'] })}>
                    <option value="auto">auto</option>
                    <option value="low">low</option>
                    <option value="medium">medium</option>
                    <option value="high">high</option>
                  </select>
                </Field>
                <label className="flex items-center gap-2 text-sm">
                  <input type="checkbox" checked={cfg.openai.highFidelity} onChange={(e) => patchOpenAI({ highFidelity: e.target.checked })} />
                  锁脸时用高保真（input_fidelity=high，更像参考图；中转不支持就关掉）
                </label>
              </>
            ) : (
              <>
                <Field label="接口地址">
                  <input className={inputCls} value={cfg.novelai.baseUrl} onChange={(e) => patchNai({ baseUrl: e.target.value })} />
                </Field>
                <Field label="Token（Persistent API Token）">
                  <input className={inputCls} type="password" value={cfg.novelai.token} onChange={(e) => patchNai({ token: e.target.value })} />
                </Field>
                <Field label="模型">
                  <input className={inputCls} value={cfg.novelai.model} onChange={(e) => patchNai({ model: e.target.value })} />
                </Field>
                <div className="grid grid-cols-2 gap-2">
                  <Field label={`步数 ${cfg.novelai.steps}`}>
                    <input type="range" min={10} max={50} value={cfg.novelai.steps} onChange={(e) => patchNai({ steps: Number(e.target.value) })} className="w-full" />
                  </Field>
                  <Field label={`提示词相关度 ${cfg.novelai.scale}`}>
                    <input type="range" min={1} max={10} step={0.5} value={cfg.novelai.scale} onChange={(e) => patchNai({ scale: Number(e.target.value) })} className="w-full" />
                  </Field>
                  <Field label={`参考强度 ${cfg.novelai.refStrength}`}>
                    <input type="range" min={0} max={1} step={0.05} value={cfg.novelai.refStrength} onChange={(e) => patchNai({ refStrength: Number(e.target.value) })} className="w-full" />
                  </Field>
                  <Field label={`参考保真度 ${cfg.novelai.refFidelity}`}>
                    <input type="range" min={0} max={1} step={0.05} value={cfg.novelai.refFidelity} onChange={(e) => patchNai({ refFidelity: Number(e.target.value) })} className="w-full" />
                  </Field>
                </div>
              </>
            )}

            <Field label="固定前缀（每次自动加在提示词前，比如画风/质量词）">
              <input className={inputCls} value={cfg.prefix} onChange={(e) => patch({ prefix: e.target.value })} />
            </Field>
            <Field label="固定后缀">
              <input className={inputCls} value={cfg.suffix} onChange={(e) => patch({ suffix: e.target.value })} />
            </Field>
            <Field label="默认负面提示词">
              <input className={inputCls} value={cfg.negativeDefault} onChange={(e) => patch({ negativeDefault: e.target.value })} />
            </Field>
          </div>
        )}

        {tab === 'make' ? (
          <>
            {/* 锁脸参考图 */}
            <div className="rounded-2xl bg-white border border-slate-200 p-4">
              <div className="flex items-center justify-between mb-2">
                <div className="text-sm font-bold">锁脸参考图（最多 4 张）</div>
                <label className="flex items-center gap-1 text-xs text-slate-500">
                  <input type="checkbox" checked={lockOn} onChange={(e) => setLockOn(e.target.checked)} />
                  启用锁脸
                </label>
              </div>
              <div className="flex gap-2 flex-wrap">
                {refs.map((r, i) => (
                  <div key={r.id} className="relative w-16 h-16">
                    <img src={refUrls[i]} className={`w-16 h-16 object-cover rounded-xl border ${lockOn ? 'border-violet-400' : 'border-slate-200 opacity-50'}`} />
                    <button onClick={() => removeRef(r.id)} className="absolute -top-1.5 -right-1.5 w-5 h-5 rounded-full bg-slate-700 text-white text-[10px]">
                      ✕
                    </button>
                  </div>
                ))}
                {refs.length < 4 && (
                  <button onClick={() => fileRef.current?.click()} className="w-16 h-16 rounded-xl border-2 border-dashed border-slate-300 text-slate-400 text-2xl active:scale-95">
                    +
                  </button>
                )}
              </div>
              <input ref={fileRef} type="file" accept="image/*" multiple className="hidden" onChange={(e) => addRefs(e.target.files)} />
              <div className="text-[11px] text-slate-400 mt-2">传一张清晰的正脸/半身图，生成时会尽量保持同一张脸。</div>
            </div>

            {/* 提示词 */}
            <div className="rounded-2xl bg-white border border-slate-200 p-4 space-y-3">
              <Field label="提示词">
                <textarea className={inputCls} rows={4} value={prompt} onChange={(e) => setPrompt(e.target.value)} placeholder="想画什么就写什么……" />
              </Field>
              <Field label="负面提示词（不想出现的）">
                <textarea className={inputCls} rows={2} value={negative} onChange={(e) => setNegative(e.target.value)} />
              </Field>
              <div className="flex items-center gap-2">
                {SIZES.map((s) => (
                  <button
                    key={s.k}
                    onClick={() => setSize(s.k)}
                    className={`flex-1 py-1.5 rounded-xl text-xs font-bold border ${size === s.k ? 'bg-violet-500 text-white border-violet-500' : 'bg-white text-slate-500 border-slate-200'}`}
                  >
                    {s.label}
                  </button>
                ))}
                <select className="rounded-xl border border-slate-200 bg-white px-2 py-1.5 text-xs" value={n} onChange={(e) => setN(Number(e.target.value))}>
                  {[1, 2, 3, 4].map((k) => (
                    <option key={k} value={k}>
                      {k} 张
                    </option>
                  ))}
                </select>
              </div>
              {error && <div className="text-xs text-red-500 whitespace-pre-wrap break-all select-text">{error}</div>}
              {busy ? (
                <button onClick={() => abortRef.current?.abort()} className="w-full py-3 rounded-2xl bg-slate-400 text-white font-bold text-sm">
                  生成中…点这里取消
                </button>
              ) : (
                <button onClick={run} className="w-full py-3 rounded-2xl bg-gradient-to-r from-violet-500 to-fuchsia-500 text-white font-bold text-sm shadow active:scale-95 transition-transform">
                  生成{lockOn && refs.length > 0 ? '（锁脸）' : ''}
                </button>
              )}
            </div>

            {/* 结果 */}
            {results.length > 0 && (
              <div className="grid grid-cols-2 gap-2">
                {results.map((r, i) => (
                  <div key={i} className="rounded-2xl overflow-hidden bg-white border border-slate-200">
                    <img src={r.url} className="w-full object-cover" onClick={() => setPreview(r.url)} />
                    {r.blob && (
                      <button onClick={() => useAsRef(r.blob)} className="w-full py-1.5 text-[11px] font-bold text-violet-600 active:bg-violet-50">
                        设为参考图
                      </button>
                    )}
                  </div>
                ))}
                <div className="col-span-2 text-[11px] text-slate-400 text-center">点图放大，长按图片可保存到相册</div>
              </div>
            )}
          </>
        ) : (
          <div className="grid grid-cols-2 gap-2">
            {history.length === 0 && <div className="col-span-2 text-center text-sm text-slate-400 py-10">还没有历史</div>}
            {history.map((h, i) => (
              <div key={h.id} className="rounded-2xl overflow-hidden bg-white border border-slate-200">
                <img src={histUrls[i]} className="w-full object-cover" onClick={() => setPreview(histUrls[i])} />
                <div className="px-2 py-1 text-[10px] text-slate-400 line-clamp-2">{h.prompt}</div>
                <div className="flex">
                  <button onClick={() => useAsRef(h.blob)} className="flex-1 py-1.5 text-[11px] font-bold text-violet-600">
                    设为参考
                  </button>
                  <button onClick={() => removeHistory(h.id)} className="flex-1 py-1.5 text-[11px] font-bold text-slate-400">
                    删除
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {preview && (
        <div className="fixed inset-0 z-[80] bg-black/85 flex items-center justify-center p-4" onClick={() => setPreview(null)}>
          <img src={preview} className="max-w-full max-h-full rounded-xl" />
        </div>
      )}
    </div>
  );
};

export default ImageGenApp;
