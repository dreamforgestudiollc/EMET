import type { Remembered, RememberedStore } from './vault.js';

const DB = 'emet-console';
const ROWS = 'remembered';
const KEYS = 'device-keys';

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(ROWS)) db.createObjectStore(ROWS);
      if (!db.objectStoreNames.contains(KEYS)) db.createObjectStore(KEYS);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function request<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export function browserRememberedStore(): RememberedStore {
  return {
    async put(serverId, row) {
      const db = await openDb();
      const tx = db.transaction(ROWS, 'readwrite');
      await request(tx.objectStore(ROWS).put(row, serverId));
    },
    async get(serverId) {
      const db = await openDb();
      const tx = db.transaction(ROWS, 'readonly');
      const row = await request(tx.objectStore(ROWS).get(serverId));
      return row ?? null;
    },
    async delete(serverId) {
      const db = await openDb();
      const tx = db.transaction([ROWS, KEYS], 'readwrite');
      tx.objectStore(ROWS).delete(serverId);
      tx.objectStore(KEYS).delete(serverId);
      await new Promise((resolve, reject) => {
        tx.oncomplete = () => resolve(undefined);
        tx.onerror = () => reject(tx.error);
      });
    }
  };
}

export async function saveDeviceKey(serverId: string, key: CryptoKeyPair, publicEncoded: string): Promise<void> {
  const db = await openDb();
  const tx = db.transaction(KEYS, 'readwrite');
  await request(tx.objectStore(KEYS).put({ key, publicEncoded }, serverId));
}

export async function loadDeviceKey(serverId: string): Promise<{ key: CryptoKeyPair; publicEncoded: string } | null> {
  const db = await openDb();
  const tx = db.transaction(KEYS, 'readonly');
  const row = await request(tx.objectStore(KEYS).get(serverId));
  return row ?? null;
}

export type { Remembered };
