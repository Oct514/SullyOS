import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useOS } from '../context/OSContext';
import {
  CharSlot,
  ImageGenConfig,
  ImageGenProvider,
  GenResult,
  SizeKey,
  estimateTokens,
  generateImages,
  loadConfig,
  saveConfig,
} from '../utils/imageGen';
import {
  Preset,
  StoredHistory,
  StoredRef,
  VibeItem,
  loadHistory,
  loadPresets,
  loadRefs,
  newPreset,
  saveHistory,
  savePresets,
  saveRefs,
  uid,
} from '../utils/imageGenStore';

const SIZES: { k: SizeKey; label: string }[] = [
  { k: 'portrait', label: '竖图' },
  { k: 'landscape', label: '横图' },
  { k: 'square', label: '方图' },
];

const MAX_CHARS = 4;
const NAI_TOKEN_LIMIT = 512; // 官方：基础提示词 + 所有角色提示词合计约 512 T5 tokens

interface CharState {
  id: string;
  prompt: string;
  uc: string;
  auto: boolean;
  col: number;
  row: number;
  refId: string; // '' = 不指定参考图
}

const newChar = (i: number): CharState => ({
  id: uid(),
  prompt: '',
  uc: '',
  auto: false,
  col: i === 0 ? 1 : 3,
  row: 2,
  refId: '',
});

const inputCls =
  'w-full rounded-xl bg-white border border-slate-200 px-3 py-2 text-sm outline-none focus:border-violet-400';

const Field: React.FC<{ label: string; children: React.ReactNode }> = ({ label, children }) => (
  <label className="block">
    <div className="text-[11px] font-bold text-slate-500 mb-1">{label}</div>
    {children}
  </label>
);

const PosGrid: React.FC<{ col: number; row: number; onPick: (col: number, row: number) => void; disabled?: boolean }> = ({
  col,
  row,
  onPick,
  disabled,
}) => (
  <div className={`grid grid-cols-5 gap-0.5 w-[110px] ${disabled ? 'opacity-30 pointer-events-none' : ''}`}>
    {Array.from({ length: 25 }).map((_, i) => {
      const c = i % 5;
      const r = Math.floor(i / 5);
      const on = c === col && r === row;
      return (
        <button
          key={i}
          type="button"
          onClick={() => onPick(c, r)}
          className={`h-5 rounded ${on ? 'bg-violet-500' : 'bg-slate-200 active:bg-slate-300'}`}
        />
      );
    })}
  </div>
);

// ============ 一套独立的工作区：GPT 和 NovelAI 各自一个实例，状态/参考图/历史/预设全部分开 ============

const Workspace: React.FC<{
  provider: ImageGenProvider;
  cfg: ImageGenConfig;
  onCfg: (next: ImageGenConfig) => void;
}> = ({ provider, cfg, onCfg }) => {
  const isNai = provider === 'novelai';
  const sec = isNai ? cfg.novelai : cfg.openai;

  const [loaded, setLoaded] = useState(false);
  const [refs, setRefs] = useState<StoredRef[]>([]);
  const [history, setHistory] = useState<StoredHistory[]>([]);
  const [presets, setPresets] = useState<Preset[]>([]);
  const [lockOn, setLockOn] = useState(true);
  const [multi, setMulti] = useState(false);
  const [chars, setChars] = useState<CharState[]>([newChar(0), newChar(1)]);
  const [prompt, setPrompt] = useState('');
  const [negative, setNegative] = useState('');
  const [size, setSize] = useState<SizeKey>('portrait');
  const [n, setN] = useState(1);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [results, setResults] = useState<GenResult[]>([]);
  const [tab, setTab] = useState<'make' | 'presets' | 'history'>('make');
  const [showSettings, setShowSettings] = useState(false);
  const [preview, setPreview] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const vibeFileRef = useRef<HTMLInputElement>(null);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    (async () => {
      const [r, h, p] = await Promise.all([loadRefs(provider), loadHistory(provider), loadPresets(provider)]);
      setRefs(r);
      setHistory(h);
      setPresets(p.length ? p : [newPreset(provider)]);
      setLoaded(true);
    })();
  }, [provider]);

  // 预设改动后防抖保存
  useEffect(() => {
    if (!loaded) return;
    const t = setTimeout(() => savePresets(provider, presets), 400);
    return () => clearTimeout(t);
  }, [presets, loaded, provider]);

  const activePreset = presets.find((p) => p.id === sec.activePresetId) ?? presets[0];

  const refUrls = useMemo(() => refs.map((r) => URL.createObjectURL(r.blob)), [refs]);
  useEffect(() => () => refUrls.forEach((u) => URL.revokeObjectURL(u)), [refUrls]);
  const histUrls = useMemo(() => history.map((h) => URL.createObjectURL(h.blob)), [history]);
  useEffect(() => () => histUrls.forEach((u) => URL.revokeObjectURL(u)), [histUrls]);
  const vibes = activePreset?.vibes ?? [];
  const vibeUrls = useMemo(() => vibes.map((v) => URL.createObjectURL(v.blob)), [vibes.map((v) => v.id).join(',')]);
  useEffect(() => () => vibeUrls.forEach((u) => URL.revokeObjectURL(u)), [vibeUrls]);

  const setSection = (p: Partial<typeof sec>) =>
    onCfg(isNai ? { ...cfg, novelai: { ...cfg.novelai, ...p } } : { ...cfg, openai: { ...cfg.openai, ...p } });
  const setOpenAI = (p: Partial<ImageGenConfig['openai']>) => onCfg({ ...cfg, openai: { ...cfg.openai, ...p } });
  const setNai = (p: Partial<ImageGenConfig['novelai']>) => onCfg({ ...cfg, novelai: { ...cfg.novelai, ...p } });

  const patchPreset = (p: Partial<Preset>) => {
    if (!activePreset) return;
    setPresets((list) => list.map((x) => (x.id === activePreset.id ? { ...x, ...p } : x)));
  };
  const patchVibe = (id: string, p: Partial<VibeItem>) =>
    patchPreset({
      vibes: vibes.map((v) => (v.id === id ? { ...v, ...p, ...(p.info !== undefined ? { cache: {} } : {}) } : v)),
    });

  const addPreset = () => {
    const p = newPreset(provider, `预设 ${presets.length + 1}`);
    setPresets([...presets, p]);
    setSection({ activePresetId: p.id });
  };
  const dupPreset = () => {
    if (!activePreset) return;
    const copy: Preset = {
      ...activePreset,
      id: uid(),
      name: `${activePreset.name} 副本`,
      vibes: activePreset.vibes.map((v) => ({ ...v, id: uid() })),
    };
    setPresets([...presets, copy]);
    setSection({ activePresetId: copy.id });
  };
  const delPreset = () => {
    if (!activePreset || presets.length <= 1) return;
    const rest = presets.filter((p) => p.id !== activePreset.id);
    setPresets(rest);
    setSection({ activePresetId: rest[0].id });
  };

  const addVibes = (files: FileList | null) => {
    if (!files || !files.length || !activePreset) return;
    const added: VibeItem[] = Array.from(files).map((f) => ({
      id: uid(),
      name: f.name.replace(/\.[^.]+$/, ''),
      blob: f,
      strength: 0.6,
      info: 1,
      enabled: true,
    }));
    patchPreset({ vibes: [...vibes, ...added] });
    if (vibeFileRef.current) vibeFileRef.current.value = '';
  };

  const patchChar = (id: string, p: Partial<CharState>) =>
    setChars((list) => list.map((c) => (c.id === id ? { ...c, ...p } : c)));

  const addRefs = (files: FileList | null) => {
    if (!files || !files.length) return;
    const added: StoredRef[] = Array.from(files).map((f) => ({ id: uid(), name: f.name, blob: f }));
    const next = [...refs, ...added].slice(0, 4);
    setRefs(next);
    saveRefs(provider, next);
    setLockOn(true);
    if (fileRef.current) fileRef.current.value = '';
  };
  const removeRef = (id: string) => {
    const next = refs.filter((r) => r.id !== id);
    setRefs(next);
    saveRefs(provider, next);
    setChars((list) => list.map((c) => (c.refId === id ? { ...c, refId: '' } : c)));
  };
  const useAsRef = (blob?: Blob) => {
    if (!blob) return;
    const next = [...refs, { id: uid(), name: 'generated.png', blob }].slice(0, 4);
    setRefs(next);
    saveRefs(provider, next);
    setLockOn(true);
    setTab('make');
  };

  const run = async () => {
    if (!prompt.trim() && !multi) {
      setError('先写点提示词');
      return;
    }
    let characters: CharSlot[] | undefined;
    if (multi) {
      characters = chars
        .filter((c) => c.prompt.trim())
        .map((c) => ({
          prompt: c.prompt,
          uc: c.uc,
          auto: c.auto,
          col: c.col,
          row: c.row,
          ref: lockOn ? refs.find((r) => r.id === c.refId)?.blob : undefined,
        }));
      if (!characters.length) {
        setError('多人模式至少要给一个角色写提示词');
        return;
      }
    }
    setBusy(true);
    setError('');
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    try {
      const imgs = await generateImages({
        cfg: { ...cfg, provider },
        prompt,
        negative,
        size,
        n,
        refs: !multi && lockOn ? refs.map((r) => r.blob) : [],
        characters,
        preset: activePreset,
        onVibeEncoded: (vibeId, key, b64) =>
          setPresets((list) =>
            list.map((p) => ({
              ...p,
              vibes: p.vibes.map((v) => (v.id === vibeId ? { ...v, cache: { ...(v.cache || {}), [key]: b64 } } : v)),
            })),
          ),
        signal: ctrl.signal,
      });
      setResults(imgs);
      const fresh: StoredHistory[] = imgs
        .filter((i) => i.blob)
        .map((i) => ({
          id: uid(),
          createdAt: Date.now(),
          prompt: multi ? `${prompt} | ${characters?.map((c) => c.prompt).join(' | ')}` : prompt,
          blob: i.blob as Blob,
        }));
      const merged = [...fresh, ...history].slice(0, 40);
      setHistory(merged);
      saveHistory(provider, merged);
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
    saveHistory(provider, next);
  };

  // 长度提示：NovelAI 显示 token 估算（官方上限约 512），GPT 只显示字数（这边不做任何截断）
  const allText = [
    activePreset?.prefix ?? '',
    prompt,
    activePreset?.suffix ?? '',
    ...(multi ? chars.map((c) => c.prompt) : []),
  ].join(' ');
  const tokenEst = estimateTokens(allText);
  const lengthHint = isNai ? (
    <div className={`text-[11px] ${tokenEst > NAI_TOKEN_LIMIT ? 'text-red-500 font-bold' : tokenEst > NAI_TOKEN_LIMIT * 0.9 ? 'text-amber-600' : 'text-slate-400'}`}>
      估算约 {tokenEst} / {NAI_TOKEN_LIMIT} token（预设前后缀 + 提示词 + 角色合计；NovelAI 模型自己的上限，改不了）
    </div>
  ) : (
    <div className="text-[11px] text-slate-400">共 {allText.trim().length} 字（这边不限长度，上限由你用的接口决定）</div>
  );

  if (!loaded) return <div className="flex-1 flex items-center justify-center text-sm text-slate-400">加载中…</div>;

  return (
    <>
      <div className="flex items-center justify-between px-4 py-2 bg-white/60 border-b border-slate-200">
        <div className="flex gap-1 bg-slate-100 rounded-full p-0.5 text-xs font-bold">
          {(
            [
              ['make', '生图'],
              ['presets', isNai ? '串/vibe' : '注入提示词'],
              ['history', `历史 ${history.length}`],
            ] as const
          ).map(([k, label]) => (
            <button
              key={k}
              onClick={() => setTab(k)}
              className={`px-3 py-1 rounded-full ${tab === k ? 'bg-white shadow text-violet-600' : 'text-slate-500'}`}
            >
              {label}
            </button>
          ))}
        </div>
        <button onClick={() => setShowSettings((s) => !s)} className="text-lg active:scale-95">
          ⚙️
        </button>
      </div>

      <div className="flex-1 overflow-y-auto px-4 py-4 space-y-4">
        {/* 设置：只显示当前这一套的接口参数 */}
        {showSettings && (
          <div className="rounded-2xl bg-white border border-slate-200 p-4 space-y-3">
            <div className="text-xs font-bold text-violet-600">{isNai ? 'NovelAI' : 'GPT（OpenAI 兼容）'} 设置（与另一套互不关联）</div>
            {!isNai ? (
              <>
                <Field label="接口地址（Base URL）">
                  <input className={inputCls} value={cfg.openai.baseUrl} onChange={(e) => setOpenAI({ baseUrl: e.target.value })} />
                </Field>
                <Field label="API Key">
                  <input className={inputCls} type="password" value={cfg.openai.apiKey} onChange={(e) => setOpenAI({ apiKey: e.target.value })} />
                </Field>
                <Field label="模型">
                  <input className={inputCls} value={cfg.openai.model} onChange={(e) => setOpenAI({ model: e.target.value })} />
                </Field>
                <Field label="质量">
                  <select className={inputCls} value={cfg.openai.quality} onChange={(e) => setOpenAI({ quality: e.target.value as ImageGenConfig['openai']['quality'] })}>
                    <option value="auto">auto</option>
                    <option value="low">low</option>
                    <option value="medium">medium</option>
                    <option value="high">high</option>
                  </select>
                </Field>
                <label className="flex items-center gap-2 text-sm">
                  <input type="checkbox" checked={cfg.openai.highFidelity} onChange={(e) => setOpenAI({ highFidelity: e.target.checked })} />
                  锁脸时用高保真（input_fidelity=high；中转不支持就关掉）
                </label>
              </>
            ) : (
              <>
                <Field label="接口地址">
                  <input className={inputCls} value={cfg.novelai.baseUrl} onChange={(e) => setNai({ baseUrl: e.target.value })} />
                </Field>
                <Field label="Token（Persistent API Token）">
                  <input className={inputCls} type="password" value={cfg.novelai.token} onChange={(e) => setNai({ token: e.target.value })} />
                </Field>
                <Field label="模型">
                  <input className={inputCls} value={cfg.novelai.model} onChange={(e) => setNai({ model: e.target.value })} />
                </Field>
                <div className="grid grid-cols-2 gap-2">
                  <Field label={`步数 ${cfg.novelai.steps}`}>
                    <input type="range" min={10} max={50} value={cfg.novelai.steps} onChange={(e) => setNai({ steps: Number(e.target.value) })} className="w-full" />
                  </Field>
                  <Field label={`提示词相关度 ${cfg.novelai.scale}`}>
                    <input type="range" min={1} max={10} step={0.5} value={cfg.novelai.scale} onChange={(e) => setNai({ scale: Number(e.target.value) })} className="w-full" />
                  </Field>
                  <Field label={`角色参考 Strength ${cfg.novelai.refStrength}`}>
                    <input type="range" min={0} max={1} step={0.05} value={cfg.novelai.refStrength} onChange={(e) => setNai({ refStrength: Number(e.target.value) })} className="w-full" />
                  </Field>
                  <Field label={`角色参考 Fidelity ${cfg.novelai.refFidelity}`}>
                    <input type="range" min={0} max={1} step={0.05} value={cfg.novelai.refFidelity} onChange={(e) => setNai({ refFidelity: Number(e.target.value) })} className="w-full" />
                  </Field>
                </div>
              </>
            )}
          </div>
        )}

        {/* 预设选择（生图页和预设页都能切） */}
        {tab !== 'history' && (
          <div className="rounded-2xl bg-white border border-slate-200 p-3 flex items-center gap-2">
            <div className="text-[11px] font-bold text-slate-500 shrink-0">{isNai ? '当前串预设' : '当前注入'}</div>
            <select className={inputCls} value={activePreset?.id ?? ''} onChange={(e) => setSection({ activePresetId: e.target.value })}>
              {presets.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </div>
        )}

        {tab === 'presets' && activePreset && (
          <div className="rounded-2xl bg-white border border-slate-200 p-4 space-y-3">
            <div className="flex gap-2">
              <input className={inputCls} value={activePreset.name} onChange={(e) => patchPreset({ name: e.target.value })} placeholder="预设名称" />
              <button onClick={addPreset} className="px-3 rounded-xl bg-violet-500 text-white text-xs font-bold shrink-0">
                新建
              </button>
              <button onClick={dupPreset} className="px-3 rounded-xl bg-slate-100 text-slate-600 text-xs font-bold shrink-0">
                复制
              </button>
              <button onClick={delPreset} disabled={presets.length <= 1} className="px-3 rounded-xl bg-slate-100 text-red-500 text-xs font-bold shrink-0 disabled:opacity-30">
                删除
              </button>
            </div>
            <Field label={isNai ? '画师串 / 前缀（每次自动加在提示词前）' : '注入提示词（前缀，可以很长）'}>
              <textarea className={`${inputCls} resize-y`} rows={isNai ? 4 : 10} value={activePreset.prefix} onChange={(e) => patchPreset({ prefix: e.target.value })} />
            </Field>
            <Field label="后缀（每次自动加在提示词后）">
              <textarea className={`${inputCls} resize-y`} rows={isNai ? 2 : 5} value={activePreset.suffix} onChange={(e) => patchPreset({ suffix: e.target.value })} />
            </Field>
            <Field label="负面提示词">
              <textarea className={`${inputCls} resize-y`} rows={3} value={activePreset.negative} onChange={(e) => patchPreset({ negative: e.target.value })} />
            </Field>
            {lengthHint}

            {isNai && (
              <div className="space-y-2">
                <div className="text-xs font-bold text-slate-600">氛围迁移（vibe）——跟随这套预设保存</div>
                <div className="text-[11px] text-slate-400 leading-relaxed">
                  官方说明：V4 以上每张图第一次编码成 vibe 收 2 Anlas，改 Info 需要重新编码；这里会把编码结果缓存在本机，不重复收费。vibe 与角色参考目前不能同时用。
                </div>
                {vibes.map((v, i) => (
                  <div key={v.id} className="rounded-xl border border-slate-200 bg-slate-50 p-2 flex gap-2">
                    <img src={vibeUrls[i]} className={`w-16 h-16 object-cover rounded-lg shrink-0 ${v.enabled ? '' : 'opacity-40'}`} />
                    <div className="flex-1 space-y-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <input type="checkbox" checked={v.enabled} onChange={(e) => patchVibe(v.id, { enabled: e.target.checked })} />
                        <input className="flex-1 min-w-0 bg-transparent text-xs font-bold outline-none" value={v.name} onChange={(e) => patchVibe(v.id, { name: e.target.value })} />
                        <button onClick={() => patchPreset({ vibes: vibes.filter((x) => x.id !== v.id) })} className="text-[11px] text-slate-400">
                          删除
                        </button>
                      </div>
                      <div className="flex items-center gap-2 text-[11px] text-slate-500">
                        <span className="w-16 shrink-0">Strength {v.strength}</span>
                        <input type="range" min={0} max={1} step={0.05} value={v.strength} onChange={(e) => patchVibe(v.id, { strength: Number(e.target.value) })} className="flex-1" />
                      </div>
                      <div className="flex items-center gap-2 text-[11px] text-slate-500">
                        <span className="w-16 shrink-0">Info {v.info}</span>
                        <input type="range" min={0} max={1} step={0.05} value={v.info} onChange={(e) => patchVibe(v.id, { info: Number(e.target.value) })} className="flex-1" />
                      </div>
                    </div>
                  </div>
                ))}
                <button onClick={() => vibeFileRef.current?.click()} className="w-full py-2 rounded-xl border-2 border-dashed border-slate-300 text-slate-400 text-sm active:scale-95">
                  + 添加 vibe 图
                </button>
                <input ref={vibeFileRef} type="file" accept="image/*" multiple className="hidden" onChange={(e) => addVibes(e.target.files)} />
              </div>
            )}
          </div>
        )}

        {tab === 'make' && (
          <>
            {/* 参考图（锁脸） */}
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
                    <div className="absolute bottom-0 left-0 px-1 rounded-tr-lg rounded-bl-xl bg-black/60 text-white text-[10px]">{i + 1}</div>
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
              <div className="text-[11px] text-slate-400 mt-2">
                {multi ? '多人模式：在下面每个角色里选用哪张参考图。' : '传一张清晰的正脸/半身图，生成时会尽量保持同一张脸。'}
                {isNai && ' （NovelAI 角色参考只支持 V4.5 模型，且不能和 vibe 同时用）'}
              </div>
            </div>

            {/* 提示词 */}
            <div className="rounded-2xl bg-white border border-slate-200 p-4 space-y-3">
              <div className="flex gap-2">
                {[false, true].map((m) => (
                  <button
                    key={String(m)}
                    onClick={() => setMulti(m)}
                    className={`flex-1 py-1.5 rounded-xl text-xs font-bold border ${multi === m ? 'bg-violet-500 text-white border-violet-500' : 'bg-white text-slate-500 border-slate-200'}`}
                  >
                    {m ? '多人' : '单人'}
                  </button>
                ))}
              </div>

              <Field label={multi ? '整体提示词（场景、画风、人数标签）' : '提示词'}>
                <textarea
                  className={`${inputCls} resize-y`}
                  rows={multi ? 4 : 8}
                  value={prompt}
                  onChange={(e) => setPrompt(e.target.value)}
                  placeholder={multi ? '例如：2girls, indoors, side-by-side（人数标签写这里）' : '想画什么就写什么……'}
                />
              </Field>
              {lengthHint}

              {multi && (
                <div className="space-y-3">
                  <div className="text-[11px] text-slate-400 leading-relaxed">
                    每个角色单独写提示词，这样不容易串脸串服装。NovelAI 的规则：人数标签（如 2girls、1boy1girl）写在整体提示词里，角色框里只写 girl / boy（不带数字）。按从上到下、从左到右的顺序排人。
                  </div>
                  {chars.map((c, i) => (
                    <div key={c.id} className="rounded-xl border border-slate-200 p-3 space-y-2 bg-slate-50">
                      <div className="flex items-center justify-between">
                        <div className="text-xs font-bold text-violet-600">角色 {i + 1}</div>
                        {chars.length > 1 && (
                          <button onClick={() => setChars((l) => l.filter((x) => x.id !== c.id))} className="text-[11px] text-slate-400">
                            删除
                          </button>
                        )}
                      </div>
                      <textarea
                        className={`${inputCls} resize-y`}
                        rows={3}
                        value={c.prompt}
                        onChange={(e) => patchChar(c.id, { prompt: e.target.value })}
                        placeholder="例如：girl, red hair, red dress, smile"
                      />
                      <input
                        className={inputCls}
                        value={c.uc}
                        onChange={(e) => patchChar(c.id, { uc: e.target.value })}
                        placeholder="这个角色不要的东西（串脸/串服装时用，可空）"
                      />
                      <div className="flex gap-3 items-start">
                        <div>
                          <div className="text-[11px] font-bold text-slate-500 mb-1">位置</div>
                          <PosGrid col={c.col} row={c.row} disabled={c.auto} onPick={(col, row) => patchChar(c.id, { col, row })} />
                          <label className="flex items-center gap-1 text-[11px] text-slate-500 mt-1">
                            <input type="checkbox" checked={c.auto} onChange={(e) => patchChar(c.id, { auto: e.target.checked })} />
                            AI 自选
                          </label>
                        </div>
                        <div className="flex-1">
                          <div className="text-[11px] font-bold text-slate-500 mb-1">用哪张参考图</div>
                          <select className={inputCls} value={c.refId} onChange={(e) => patchChar(c.id, { refId: e.target.value })}>
                            <option value="">不指定</option>
                            {refs.map((r, k) => (
                              <option key={r.id} value={r.id}>
                                参考图 {k + 1}
                              </option>
                            ))}
                          </select>
                        </div>
                      </div>
                    </div>
                  ))}
                  {chars.length < MAX_CHARS && (
                    <button onClick={() => setChars((l) => [...l, newChar(l.length)])} className="w-full py-2 rounded-xl border-2 border-dashed border-slate-300 text-slate-400 text-sm active:scale-95">
                      + 加一个角色
                    </button>
                  )}
                  {isNai && (
                    <div className="text-[11px] text-amber-600 leading-relaxed">
                      NovelAI 官方说明：同时用多张角色参考会把几个人的脸混在一起，所以这里只能给一个角色选参考图；想两个人都锁脸，请用 GPT 那一套。
                    </div>
                  )}
                </div>
              )}

              <Field label="本次额外负面提示词（会和预设里的负面提示词合并）">
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
        )}

        {tab === 'history' && (
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
    </>
  );
};

const ImageGenApp: React.FC = () => {
  const { closeApp } = useOS();
  const [cfg, setCfg] = useState<ImageGenConfig>(() => loadConfig());

  const update = (next: ImageGenConfig) => {
    setCfg(next);
    saveConfig(next);
  };

  return (
    <div
      className="w-full h-full flex flex-col bg-slate-50 text-slate-800"
      style={{ paddingTop: 'var(--chrome-top, 1.5rem)' }}
    >
      <div className="flex items-center justify-between px-4 py-3 bg-white/80 backdrop-blur border-b border-slate-200">
        <button onClick={closeApp} className="text-sm font-bold text-slate-500 active:scale-95">
          返回
        </button>
        <div className="flex gap-1 bg-slate-100 rounded-full p-0.5 text-xs font-bold">
          {(
            [
              ['openai', 'GPT'],
              ['novelai', 'NovelAI'],
            ] as const
          ).map(([k, label]) => (
            <button
              key={k}
              onClick={() => update({ ...cfg, provider: k })}
              className={`px-4 py-1 rounded-full ${cfg.provider === k ? 'bg-white shadow text-violet-600' : 'text-slate-500'}`}
            >
              {label}
            </button>
          ))}
        </div>
        <div className="w-8" />
      </div>
      {/* key = provider：切换时整套工作区重建，两边的提示词、参考图、历史、预设互不干扰 */}
      <Workspace key={cfg.provider} provider={cfg.provider} cfg={cfg} onCfg={update} />
    </div>
  );
};

export default ImageGenApp;
