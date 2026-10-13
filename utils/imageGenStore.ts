// 生图 App 的本地存储（独立 IndexedDB，不碰 SullyOS 主数据库）。
// GPT 和 NovelAI 两套完全分开存：参考图、历史、预设各自一份，互不共用。

const DB_NAME = 'sullyos-imagegen';
const STORE = 'kv';

export type ProviderKey = 'openai' | 'novelai';

export interface StoredRef {
  id: string;
  name: string;
  blob: Blob;
}

export interface StoredHistory {
  id: string;
  createdAt: number;
  prompt: string;
  blob: Blob;
}

// NovelAI 氛围迁移（vibe）。cache 里存着已经编码过的结果（key = 模型:information_extracted），
// 官方说明 V4 以上每次编码会收 2 Anlas，所以缓存下来不重复编码。
export interface VibeItem {
  id: string;
  name: string;
  blob: Blob;
  strength: number; // 0~1
  info: number; // information extracted 0~1
  enabled: boolean;
  cache?: Record<string, string>;
}

// 一套预设 = 注入提示词（前缀/后缀/负面）+（NovelAI）一组 vibe。
// NovelAI 里前缀就是画师串。
export interface Preset {
  id: string;
  name: string;
  prefix: string;
  suffix: string;
  negative: string;
  vibes: VibeItem[];
}

export const NAI_DEFAULT_NEGATIVE = 'lowres, bad anatomy, bad hands, text, error, worst quality, jpeg artifacts';

export const uid = () => Math.random().toString(36).slice(2) + Date.now().toString(36);

export function newPreset(provider: ProviderKey, name = '默认'): Preset {
  return {
    id: uid(),
    name,
    prefix: '',
    suffix: '',
    negative: provider === 'novelai' ? NAI_DEFAULT_NEGATIVE : '',
    vibes: [],
  };
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      req.result.createObjectStore(STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function kvGet<T>(key: string): Promise<T | undefined> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readonly');
    const r = tx.objectStore(STORE).get(key);
    r.onsuccess = () => resolve(r.result as T | undefined);
    r.onerror = () => reject(r.error);
  });
}

async function kvSet(key: string, value: unknown): Promise<void> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).put(value, key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function load<T>(key: string): Promise<T[]> {
  try {
    return (await kvGet<T[]>(key)) ?? [];
  } catch {
    return [];
  }
}

async function save(key: string, value: unknown): Promise<void> {
  try {
    await kvSet(key, value);
  } catch {
    /* 存不下就算了，本次会话里仍可用 */
  }
}

export const loadRefs = (p: ProviderKey) => load<StoredRef>(`refs:${p}`);
export const saveRefs = (p: ProviderKey, v: StoredRef[]) => save(`refs:${p}`, v);
export const loadHistory = (p: ProviderKey) => load<StoredHistory>(`history:${p}`);
export const saveHistory = (p: ProviderKey, v: StoredHistory[]) => save(`history:${p}`, v);
export const loadPresets = (p: ProviderKey) => load<Preset>(`presets:${p}`);
export const savePresets = (p: ProviderKey, v: Preset[]) => save(`presets:${p}`, v);
