// Библиотека в IndexedDB: books — краткие сведения о книге, texts — её разделы.
// Разделены, чтобы список книг не тянул за собой мегабайты текста.
// Позиция чтения и настройки — в localStorage (пишутся часто и весят мало).

const Library = (() => {
  let dbPromise;

  function open() {
    dbPromise ||= new Promise((resolve, reject) => {
      const req = indexedDB.open('fastreader', 1);
      req.onupgradeneeded = () => {
        req.result.createObjectStore('books', { keyPath: 'id' });
        req.result.createObjectStore('texts', { keyPath: 'id' });
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    return dbPromise;
  }

  async function run(stores, mode, fn) {
    const db = await open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(stores, mode);
      const req = fn(tx);
      tx.oncomplete = () => resolve(req?.result);
      tx.onerror = () => reject(tx.error);
    });
  }

  return {
    list: () => run('books', 'readonly', (tx) => tx.objectStore('books').getAll()),
    getSections: async (id) => (await run('texts', 'readonly', (tx) => tx.objectStore('texts').get(id)))?.sections,
    save: (meta, sections) => run(['books', 'texts'], 'readwrite', (tx) => {
      tx.objectStore('texts').put({ id: meta.id, sections });
      tx.objectStore('books').put(meta);
    }),
    touch: (meta) => run('books', 'readwrite', (tx) => tx.objectStore('books').put(meta)),
    remove: (id) => run(['books', 'texts'], 'readwrite', (tx) => {
      tx.objectStore('texts').delete(id);
      tx.objectStore('books').delete(id);
    }),
  };
})();

const store = {
  get(key) {
    try { return JSON.parse(localStorage.getItem(key)); } catch { return null; }
  },
  set(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* ignore */ }
  },
  remove(key) {
    try { localStorage.removeItem(key); } catch { /* ignore */ }
  },
};
