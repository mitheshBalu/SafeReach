(function (global) {
  const DB_NAME = "shelter-finder";
  const DB_VERSION = 2;
  const FACILITIES = "facilities";
  const META = "meta";

  function open() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(FACILITIES)) {
          db.createObjectStore(FACILITIES, { keyPath: "id" });
        }
        if (!db.objectStoreNames.contains(META)) {
          db.createObjectStore(META, { keyPath: "key" });
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  async function putAll(records) {
    const db = await open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(FACILITIES, "readwrite");
      const store = tx.objectStore(FACILITIES);
      store.clear();
      records.forEach((r) => store.put(r));
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  async function putOne(record) {
    const db = await open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(FACILITIES, "readwrite");
      tx.objectStore(FACILITIES).put(record);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  async function getAll() {
    const db = await open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(FACILITIES, "readonly");
      const req = tx.objectStore(FACILITIES).getAll();
      req.onsuccess = () =>
        resolve(req.result.sort((a, b) => a.distance_miles - b.distance_miles));
      req.onerror = () => reject(req.error);
    });
  }

  async function setMeta(key, value) {
    const db = await open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(META, "readwrite");
      tx.objectStore(META).put({ key, value });
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  async function getMeta(key) {
    const db = await open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(META, "readonly");
      const req = tx.objectStore(META).get(key);
      req.onsuccess = () => resolve(req.result ? req.result.value : null);
      req.onerror = () => reject(req.error);
    });
  }

  global.Store = { putAll, putOne, getAll, setMeta, getMeta };
})(typeof self !== "undefined" ? self : window);
