import { openDB } from 'idb';

const DB_NAME = 'ebook-reader';
const DB_VERSION = 1;

const dbPromise = openDB(DB_NAME, DB_VERSION, {
  upgrade(db) {
    if (!db.objectStoreNames.contains('books')) {
      // Lightweight metadata for the library list (no heavy payload here).
      db.createObjectStore('books', { keyPath: 'id' });
    }
    if (!db.objectStoreNames.contains('content')) {
      // Heavy parsed content (chapters / page images) keyed by book id.
      db.createObjectStore('content', { keyPath: 'id' });
    }
  },
});

export async function saveBook(meta, content) {
  const db = await dbPromise;
  const tx = db.transaction(['books', 'content'], 'readwrite');
  await Promise.all([
    tx.objectStore('books').put(meta),
    tx.objectStore('content').put({ id: meta.id, ...content }),
    tx.done,
  ]);
}

export async function listBooks() {
  const db = await dbPromise;
  const books = await db.getAll('books');
  // Newest first.
  return books.sort((a, b) => b.addedAt - a.addedAt);
}

export async function getBookContent(id) {
  const db = await dbPromise;
  return db.get('content', id);
}

export async function getBookMeta(id) {
  const db = await dbPromise;
  return db.get('books', id);
}

export async function updateProgress(id, progress) {
  const db = await dbPromise;
  const meta = await db.get('books', id);
  if (!meta) return;
  meta.progress = progress;
  meta.lastReadAt = Date.now();
  await db.put('books', meta);
}

export async function deleteBook(id) {
  const db = await dbPromise;
  const tx = db.transaction(['books', 'content'], 'readwrite');
  await Promise.all([
    tx.objectStore('books').delete(id),
    tx.objectStore('content').delete(id),
    tx.done,
  ]);
}
