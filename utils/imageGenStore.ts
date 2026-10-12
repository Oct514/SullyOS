// 生图 App 的本地存储：参考图（锁脸用）和历史图都存在独立的 IndexedDB 里，
// 不碰 SullyOS 主数据库，也不会被主库的导入/清理逻辑误伤。

const DB_NAME = 'sullyos-imagegen';
const STORE = 'kv';

export interface StoredRef {
  id: string;
  name: string;
  blob: Blob;
}

export interface StoredHistory {
  id: string;
  createdAt: number;
  prompt: string;
  provider: string;
  blob: Blob;
}

export const uid = () => Math.random().toString(36).slice(2) + Date.now().toString(36);

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

export async function loadRefs(): Promise<StoredRef[]> {
  try {
    return (await kvGet<StoredRef[]>('refs')) ?? [];
  } catch {
    return [];
  }
}

export async function saveRefs(refs: StoredRef[]): Promise<void> {
  try {
    await kvSet('refs', refs);
  } catch {
    /* 存不下就算了，本次会话里仍可用 */
  }
}

export async function loadHistory(): Promise<StoredHistory[]> {
  try {
    return (await kvGet<StoredHistory[]>('history')) ?? [];
  } catch {
    return [];
  }
}

export async function saveHistory(items: StoredHistory[]): Promise<void> {
  try {
    await kvSet('history', items);
  } catch {
    /* ignore */
  }
}
