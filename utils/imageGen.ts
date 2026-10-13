import JSZip from 'jszip';
import type { Preset } from './imageGenStore';

export type ImageGenProvider = 'openai' | 'novelai';
export type SizeKey = 'portrait' | 'landscape' | 'square';

// 两套设置完全独立。provider 只是「当前显示哪一套」的开关，不共享任何字段。
export interface ImageGenConfig {
  provider: ImageGenProvider;
  openai: {
    baseUrl: string;
    apiKey: string;
    model: string;
    quality: 'auto' | 'low' | 'medium' | 'high';
    highFidelity: boolean; // 带参考图时请求 input_fidelity=high
    activePresetId: string;
  };
  novelai: {
    baseUrl: string;
    token: string;
    model: string;
    steps: number;
    scale: number;
    sampler: string;
    refStrength: number; // 角色参考（Precise Reference）Strength
    refFidelity: number; // 角色参考 Fidelity
    activePresetId: string;
  };
}

export const DEFAULT_CONFIG: ImageGenConfig = {
  provider: 'openai',
  openai: {
    baseUrl: 'https://api.openai.com/v1',
    apiKey: '',
    model: 'gpt-image-1',
    quality: 'auto',
    highFidelity: true,
    activePresetId: '',
  },
  novelai: {
    baseUrl: 'https://image.novelai.net',
    token: '',
    model: 'nai-diffusion-4-5-full',
    steps: 28,
    scale: 5,
    sampler: 'k_euler_ancestral',
    refStrength: 1,
    refFidelity: 1,
    activePresetId: '',
  },
};

const CFG_KEY = 'sullyos_imagegen_config_v1';

export function loadConfig(): ImageGenConfig {
  try {
    const raw = localStorage.getItem(CFG_KEY);
    if (!raw) return DEFAULT_CONFIG;
    const p = JSON.parse(raw);
    return {
      provider: p.provider === 'novelai' ? 'novelai' : 'openai',
      openai: { ...DEFAULT_CONFIG.openai, ...(p.openai || {}) },
      novelai: { ...DEFAULT_CONFIG.novelai, ...(p.novelai || {}) },
    };
  } catch {
    return DEFAULT_CONFIG;
  }
}

export function saveConfig(cfg: ImageGenConfig): void {
  try {
    localStorage.setItem(CFG_KEY, JSON.stringify(cfg));
  } catch {
    /* ignore */
  }
}

export interface GenResult {
  url: string; // 可直接放进 <img src>
  blob?: Blob;
}

// 多角色：每个角色有自己的提示词、负面提示词、位置（5x5 格）和可选的参考图
export interface CharSlot {
  prompt: string;
  uc: string;
  auto: boolean; // true = 位置由 AI 自选
  col: number; // 0~4
  row: number; // 0~4
  ref?: Blob;
}

export interface GenOptions {
  cfg: ImageGenConfig;
  prompt: string; // 单人时是完整提示词；多人时是整体/场景提示词
  negative: string;
  size: SizeKey;
  n: number;
  refs: Blob[]; // 单人锁脸参考图；空数组 = 不锁脸
  characters?: CharSlot[]; // 非空 = 多人模式
  preset?: Preset; // 当前选中的预设（注入提示词 + NovelAI 的 vibe）
  onVibeEncoded?: (vibeId: string, key: string, b64: string) => void;
  signal?: AbortSignal;
}

const OPENAI_SIZES: Record<SizeKey, string> = {
  portrait: '1024x1536',
  landscape: '1536x1024',
  square: '1024x1024',
};

const NAI_SIZES: Record<SizeKey, [number, number]> = {
  portrait: [832, 1216],
  landscape: [1216, 832],
  square: [1024, 1024],
};

// NovelAI V4/V4.5 的 5x5 位置格：格子中心坐标为 0.1 / 0.3 / 0.5 / 0.7 / 0.9
function gridCenter(col: number, row: number): { x: number; y: number } {
  return { x: Number((0.1 + 0.2 * col).toFixed(1)), y: Number((0.1 + 0.2 * row).toFixed(1)) };
}

async function readError(res: Response): Promise<string> {
  const text = await res.text();
  try {
    const j = JSON.parse(text);
    return `${res.status} ${j?.error?.message || j?.message || text.slice(0, 300)}`;
  } catch {
    return `${res.status} ${text.slice(0, 300)}`;
  }
}

function wrapNetworkError(e: unknown, hint: string): Error {
  if (e instanceof DOMException && e.name === 'AbortError') return new Error('已取消');
  if (e instanceof TypeError) return new Error(`网络请求失败（${e.message}）。${hint}`);
  return e instanceof Error ? e : new Error(String(e));
}

function b64ToBlob(b64: string, type = 'image/png'): Blob {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Blob([bytes], { type });
}

function blobToResult(blob: Blob): GenResult {
  return { blob, url: URL.createObjectURL(blob) };
}

async function blobToB64(blob: Blob): Promise<string> {
  const dataUrl: string = await new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(fr.result as string);
    fr.onerror = () => reject(fr.error);
    fr.readAsDataURL(blob);
  });
  return dataUrl.split(',')[1];
}

function bytesToB64(bytes: Uint8Array): string {
  let s = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    s += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + chunk)));
  }
  return btoa(s);
}

// ---------------- OpenAI 兼容（gpt-image-1 等） ----------------

const LOCK_PREFIX =
  'Use the provided reference image(s) as the exact identity of the character: keep the same face, facial features, hairstyle, hair color and eye color. ';

function positionWords(c: CharSlot): string {
  if (c.auto) return '';
  const h = c.col <= 1 ? 'on the left' : c.col >= 3 ? 'on the right' : 'in the center';
  return ` Position: ${h} of the frame.`;
}

async function generateOpenAI(o: GenOptions): Promise<GenResult[]> {
  const c = o.cfg.openai;
  if (!c.apiKey) throw new Error('先在右上角 ⚙️ 里填 OpenAI 兼容接口的 API Key');
  const base = c.baseUrl.replace(/\/+$/, '');
  const headers: Record<string, string> = { Authorization: `Bearer ${c.apiKey}` };

  const chars = (o.characters ?? []).filter((x) => x.prompt.trim());
  let prompt = o.prompt;
  let refBlobs: Blob[] = o.refs;
  let lockText = LOCK_PREFIX;

  if (chars.length > 0) {
    // 多人：每个角色写成一条，指定了参考图的就告诉模型“这个人用第 N 张参考图”
    refBlobs = [];
    const lines = chars.map((ch, i) => {
      let refNote = '';
      if (ch.ref) {
        let idx = refBlobs.indexOf(ch.ref);
        if (idx < 0) {
          refBlobs.push(ch.ref);
          idx = refBlobs.length - 1;
        }
        refNote = ` (this is the person in reference image ${idx + 1}: keep the same face, hairstyle and features)`;
      }
      return `- Character ${i + 1}${refNote}: ${ch.prompt.trim()}${positionWords(ch)}`;
    });
    prompt = `${o.prompt}\n\nThe image contains ${chars.length} separate characters:\n${lines.join('\n')}`;
    lockText = refBlobs.length > 0 ? 'Each character that has a reference image must keep that reference image\'s identity. ' : '';
    const avoid = [o.negative, ...chars.map((x) => x.uc)].map((s) => s.trim()).filter(Boolean).join('; ');
    if (avoid) prompt += `\n\nAvoid: ${avoid}`;
  } else if (o.negative.trim()) {
    prompt += `\n\nAvoid: ${o.negative.trim()}`;
  }

  let res: Response;
  try {
    if (refBlobs.length > 0) {
      const fd = new FormData();
      fd.append('model', c.model);
      fd.append('prompt', lockText + prompt);
      fd.append('n', String(o.n));
      fd.append('size', OPENAI_SIZES[o.size]);
      if (c.quality !== 'auto') fd.append('quality', c.quality);
      if (c.highFidelity) fd.append('input_fidelity', 'high');
      refBlobs.forEach((b, i) => fd.append('image[]', b, `ref${i}.png`));
      res = await fetch(`${base}/images/edits`, { method: 'POST', headers, body: fd, signal: o.signal });
    } else {
      const body: Record<string, unknown> = {
        model: c.model,
        prompt,
        n: o.n,
        size: OPENAI_SIZES[o.size],
      };
      if (c.quality !== 'auto') body.quality = c.quality;
      res = await fetch(`${base}/images/generations`, {
        method: 'POST',
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: o.signal,
      });
    }
  } catch (e) {
    throw wrapNetworkError(e, '多半是接口不允许浏览器直接访问（跨域），换个支持跨域的中转地址试试。');
  }
  if (!res.ok) throw new Error(await readError(res));

  const json = await res.json();
  const out: GenResult[] = [];
  for (const item of json?.data ?? []) {
    if (item.b64_json) {
      out.push(blobToResult(b64ToBlob(item.b64_json)));
    } else if (item.url) {
      try {
        const r = await fetch(item.url, { signal: o.signal });
        out.push(blobToResult(await r.blob()));
      } catch {
        out.push({ url: item.url }); // 拿不到二进制就直接显示链接图（无法存历史）
      }
    }
  }
  if (!out.length) throw new Error('接口返回里没有图片');
  return out;
}

// ---------------- NovelAI ----------------

// NovelAI 角色参考要求图片放在这三种画布之一，空白处填黑
async function toNaiReference(blob: Blob): Promise<string> {
  const bmp = await createImageBitmap(blob);
  const targets: [number, number][] = [
    [1024, 1536],
    [1536, 1024],
    [1472, 1472],
  ];
  const ar = bmp.width / bmp.height;
  let best = targets[0];
  let bestDiff = Infinity;
  for (const t of targets) {
    const d = Math.abs(Math.log(ar / (t[0] / t[1])));
    if (d < bestDiff) {
      bestDiff = d;
      best = t;
    }
  }
  const [W, H] = best;
  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('浏览器不支持 canvas');
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, W, H);
  const scale = Math.min(W / bmp.width, H / bmp.height);
  const w = bmp.width * scale;
  const h = bmp.height * scale;
  ctx.drawImage(bmp, (W - w) / 2, (H - h) / 2, w, h);
  const png: Blob = await new Promise((resolve, reject) =>
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('参考图转换失败'))), 'image/png'),
  );
  return blobToB64(png);
}

// V4 以上的 vibe 要先让服务器“编码”一次（POST /ai/encode-vibe），拿到的字节再当作 reference_image_multiple 传回去。
// 请求格式参考 NekoAI-API 的 examples/requests/vibe-encode.py。
async function encodeVibe(
  base: string,
  token: string,
  model: string,
  blob: Blob,
  info: number,
  signal?: AbortSignal,
): Promise<string> {
  let res: Response;
  try {
    res = await fetch(`${base}/ai/encode-vibe`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ image: await blobToB64(blob), information_extracted: info, model }),
      signal,
    });
  } catch (e) {
    throw wrapNetworkError(e, '如果是跨域被拦，需要把接口地址换成你自己的代理（Worker）。');
  }
  if (!res.ok) throw new Error(`vibe 编码失败：${await readError(res)}`);
  return bytesToB64(new Uint8Array(await res.arrayBuffer()));
}

async function generateNovelAI(o: GenOptions): Promise<GenResult[]> {
  const c = o.cfg.novelai;
  if (!c.token) throw new Error('先在右上角 ⚙️ 里填 NovelAI 的 Token（Persistent API Token）');
  const base = c.baseUrl.replace(/\/+$/, '');
  const [width, height] = NAI_SIZES[o.size];

  const chars = (o.characters ?? []).filter((x) => x.prompt.trim());
  let refBlobs: Blob[] = o.refs;
  if (chars.length > 0) {
    const distinct = Array.from(new Set(chars.map((x) => x.ref).filter((r): r is Blob => !!r)));
    // NovelAI 官方说明：多张角色参考会把几个人的脸混在一起，而不是分开对应
    if (distinct.length > 1) {
      throw new Error(
        'NovelAI 官方说明：同时用多张角色参考会把几个人的脸混在一起，不会分开对应。请只给其中一个角色选参考图，或者改用 GPT 那一套。',
      );
    }
    refBlobs = distinct;
  }

  const vibes = (o.preset?.vibes ?? []).filter((v) => v.enabled);
  // NovelAI 官方说明：Vibe Transfer 和 Precise Reference（角色参考）目前不能同时使用
  if (vibes.length > 0 && refBlobs.length > 0) {
    throw new Error(
      'NovelAI 官方说明：氛围迁移（vibe）和角色参考目前不能同时使用。请关掉一个：去掉「启用锁脸」，或在预设里取消勾选 vibe。',
    );
  }

  const refB64: string[] = [];
  for (const b of refBlobs) refB64.push(await toNaiReference(b));

  const vibeB64: string[] = [];
  for (const v of vibes) {
    const key = `${c.model}:${v.info}`;
    let enc = v.cache?.[key];
    if (!enc) {
      enc = await encodeVibe(base, c.token, c.model, v.blob, v.info, o.signal);
      o.onVibeEncoded?.(v.id, key, enc);
    }
    vibeB64.push(enc);
  }

  // 角色提示词：结构参考 NekoAI 对 NovelAI 接口的封装（characterPrompts + v4_prompt.char_captions）
  const charPrompts = chars.map((ch) => ({
    prompt: ch.prompt.trim(),
    uc: ch.uc.trim(),
    center: ch.auto ? { x: 0.5, y: 0.5 } : gridCenter(ch.col, ch.row),
    enabled: true,
  }));
  const useCoords = chars.some((ch) => !ch.auto);

  const out: GenResult[] = [];
  // NovelAI 一次请求只出一张，多张就循环发（每张不同 seed）
  for (let i = 0; i < o.n; i++) {
    const seed = Math.floor(Math.random() * 4294967295);
    const parameters: Record<string, unknown> = {
      params_version: 3,
      width,
      height,
      scale: c.scale,
      sampler: c.sampler,
      steps: c.steps,
      n_samples: 1,
      ucPreset: 0,
      qualityToggle: true,
      autoSmea: false,
      dynamic_thresholding: false,
      controlnet_strength: 1,
      legacy: false,
      add_original_image: true,
      cfg_rescale: 0,
      noise_schedule: 'karras',
      legacy_v3_extend: false,
      skip_cfg_above_sigma: null,
      use_coords: useCoords,
      legacy_uc: false,
      normalize_reference_strength_multiple: true,
      inpaintImg2ImgStrength: 1,
      seed,
      negative_prompt: o.negative,
      characterPrompts: charPrompts,
      v4_prompt: {
        caption: {
          base_caption: o.prompt,
          char_captions: charPrompts.map((p) => ({ char_caption: p.prompt, centers: [p.center] })),
        },
        use_coords: useCoords,
        use_order: true,
      },
      v4_negative_prompt: {
        caption: {
          base_caption: o.negative,
          char_captions: charPrompts.map((p) => ({ char_caption: p.uc, centers: [p.center] })),
        },
        legacy_uc: false,
      },
      deliberate_euler_ancestral_bug: false,
      prefer_brownian: true,
    };
    if (refB64.length > 0) {
      parameters.director_reference_images = refB64;
      parameters.director_reference_descriptions = refB64.map(() => ({
        caption: { base_caption: 'character&style', char_captions: [] },
        legacy_uc: false,
      }));
      parameters.director_reference_information_extracted = refB64.map(() => 1);
      parameters.director_reference_strength_values = refB64.map(() => c.refStrength);
      parameters.director_reference_secondary_strength_values = refB64.map(() => 1 - c.refFidelity);
    }
    if (vibeB64.length > 0) {
      // V4 以上：传的是编码后的 vibe，information_extracted 已经在编码时用过，不再重复传（参考 NekoAI 的做法）
      parameters.reference_image_multiple = vibeB64;
      parameters.reference_strength_multiple = vibes.map((v) => v.strength);
    }

    let res: Response;
    try {
      res = await fetch(`${base}/ai/generate-image`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${c.token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ input: o.prompt, model: c.model, action: 'generate', parameters }),
        signal: o.signal,
      });
    } catch (e) {
      throw wrapNetworkError(e, '如果是跨域被拦，需要把接口地址换成你自己的代理（Worker）。');
    }
    if (!res.ok) throw new Error(await readError(res));

    const zip = await JSZip.loadAsync(await res.arrayBuffer());
    const names = Object.keys(zip.files)
      .filter((n) => /\.(png|webp|jpe?g)$/i.test(n))
      .sort();
    for (const name of names) {
      const raw = await zip.files[name].async('blob');
      out.push(blobToResult(new Blob([raw], { type: 'image/png' })));
    }
  }
  if (!out.length) throw new Error('接口返回里没有图片');
  return out;
}

export async function generateImages(o: GenOptions): Promise<GenResult[]> {
  const p = o.preset;
  const pre = (p?.prefix ?? '').trim();
  const suf = (p?.suffix ?? '').trim();
  const pneg = (p?.negative ?? '').trim();
  const mine = o.prompt.trim();
  const myNeg = o.negative.trim();

  if (o.cfg.provider === 'novelai') {
    return generateNovelAI({
      ...o,
      prompt: [pre, mine, suf].filter(Boolean).join(', '),
      negative: [myNeg, pneg].filter(Boolean).join(', '),
    });
  }
  // GPT：注入提示词可以很长，用空行隔开，不做任何长度截断
  return generateOpenAI({
    ...o,
    prompt: [pre, mine, suf].filter(Boolean).join('\n\n'),
    negative: [myNeg, pneg].filter(Boolean).join('; '),
  });
}

// 粗略估算 NovelAI 的 T5 token 数（仅作参考，不是精确值）。官方上限：基础提示词 + 所有角色提示词合计约 512。
export function estimateTokens(text: string): number {
  const m = text.match(/[A-Za-z]+|[0-9]+|[^\sA-Za-z0-9]/g);
  return m ? Math.ceil(m.length * 1.3) : 0;
}
