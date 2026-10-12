import JSZip from 'jszip';

export type ImageGenProvider = 'openai' | 'novelai';
export type SizeKey = 'portrait' | 'landscape' | 'square';

export interface ImageGenConfig {
  provider: ImageGenProvider;
  openai: {
    baseUrl: string;
    apiKey: string;
    model: string;
    quality: 'auto' | 'low' | 'medium' | 'high';
    highFidelity: boolean; // 带参考图时请求 input_fidelity=high（更像参考图的脸）
  };
  novelai: {
    baseUrl: string;
    token: string;
    model: string;
    steps: number;
    scale: number;
    sampler: string;
    refStrength: number; // 角色参考强度 0~1
    refFidelity: number; // 角色参考保真度 0~1
  };
  prefix: string; // 固定提示词前缀（画风/质量词）
  suffix: string; // 固定提示词后缀
  negativeDefault: string; // 默认负面提示词
}

export const DEFAULT_CONFIG: ImageGenConfig = {
  provider: 'openai',
  openai: {
    baseUrl: 'https://api.openai.com/v1',
    apiKey: '',
    model: 'gpt-image-1',
    quality: 'auto',
    highFidelity: true,
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
  },
  prefix: '',
  suffix: '',
  negativeDefault: 'lowres, bad anatomy, bad hands, text, error, worst quality, jpeg artifacts',
};

const CFG_KEY = 'sullyos_imagegen_config_v1';

export function loadConfig(): ImageGenConfig {
  try {
    const raw = localStorage.getItem(CFG_KEY);
    if (!raw) return DEFAULT_CONFIG;
    const p = JSON.parse(raw);
    return {
      ...DEFAULT_CONFIG,
      ...p,
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

export interface GenOptions {
  cfg: ImageGenConfig;
  prompt: string;
  negative: string;
  size: SizeKey;
  n: number;
  refs: Blob[]; // 锁脸参考图；空数组 = 不锁脸
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

// ---------------- OpenAI 兼容（gpt-image-1 等） ----------------

const LOCK_PREFIX =
  'Use the provided reference image(s) as the exact identity of the character: keep the same face, facial features, hairstyle, hair color and eye color. ';

async function generateOpenAI(o: GenOptions): Promise<GenResult[]> {
  const c = o.cfg.openai;
  if (!c.apiKey) throw new Error('先在右上角 ⚙️ 里填 OpenAI 兼容接口的 API Key');
  const base = c.baseUrl.replace(/\/+$/, '');
  const headers: Record<string, string> = { Authorization: `Bearer ${c.apiKey}` };
  let prompt = o.prompt;
  if (o.negative.trim()) prompt += `\n\nAvoid: ${o.negative.trim()}`;

  let res: Response;
  try {
    if (o.refs.length > 0) {
      const fd = new FormData();
      fd.append('model', c.model);
      fd.append('prompt', LOCK_PREFIX + prompt);
      fd.append('n', String(o.n));
      fd.append('size', OPENAI_SIZES[o.size]);
      if (c.quality !== 'auto') fd.append('quality', c.quality);
      if (c.highFidelity) fd.append('input_fidelity', 'high');
      o.refs.forEach((b, i) => fd.append('image[]', b, `ref${i}.png`));
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
  const dataUrl: string = await new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(fr.result as string);
    fr.onerror = () => reject(fr.error);
    fr.readAsDataURL(png);
  });
  return dataUrl.split(',')[1];
}

async function generateNovelAI(o: GenOptions): Promise<GenResult[]> {
  const c = o.cfg.novelai;
  if (!c.token) throw new Error('先在右上角 ⚙️ 里填 NovelAI 的 Token（Persistent API Token）');
  const base = c.baseUrl.replace(/\/+$/, '');
  const [width, height] = NAI_SIZES[o.size];

  const refB64: string[] = [];
  for (const b of o.refs) refB64.push(await toNaiReference(b));

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
      use_coords: false,
      legacy_uc: false,
      normalize_reference_strength_multiple: true,
      inpaintImg2ImgStrength: 1,
      seed,
      negative_prompt: o.negative,
      characterPrompts: [],
      v4_prompt: {
        caption: { base_caption: o.prompt, char_captions: [] },
        use_coords: false,
        use_order: true,
      },
      v4_negative_prompt: {
        caption: { base_caption: o.negative, char_captions: [] },
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
  const full: GenOptions = {
    ...o,
    prompt: [o.cfg.prefix.trim(), o.prompt.trim(), o.cfg.suffix.trim()].filter(Boolean).join(', '),
  };
  return o.cfg.provider === 'novelai' ? generateNovelAI(full) : generateOpenAI(full);
}
