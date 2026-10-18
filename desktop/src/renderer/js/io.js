// @ts-check
// ── Talking to the import/export worker ───────────────────────────────────────
/** @type {Worker | null} */
let worker = null;
let seq = 0;
/** @type {Map<number, { resolve: (v: any) => void, reject: (e: Error) => void, onProgress?: (f: number, m: string) => void }>} */
const pending = new Map();

function getWorker() {
  if (worker) return worker;
  worker = new Worker(new URL('./io-worker.js', import.meta.url), { type: 'module' });
  worker.onmessage = ev => {
    const d = ev.data;
    const p = pending.get(d.id);
    if (!p) return;
    if (d.progress !== undefined) { if (p.onProgress) p.onProgress(d.progress, d.message); return; }
    pending.delete(d.id);
    if (d.error) p.reject(new Error(d.error)); else p.resolve(d);
  };
  worker.onerror = () => {
    for (const p of pending.values()) p.reject(new Error('The import/export helper stopped. Try again.'));
    pending.clear();
    worker = null;
  };
  return worker;
}

/** @param {any} msg @param {Transferable[]} transfer @param {(f: number, m: string) => void} [onProgress] */
function call(msg, transfer, onProgress) {
  return new Promise((resolve, reject) => {
    const id = ++seq;
    pending.set(id, { resolve, reject, onProgress });
    getWorker().postMessage(Object.assign({ id }, msg), transfer);
  });
}

/** @param {Uint8Array} bytes @param {string} name @param {{ delimiter?: string, formulas?: boolean, onProgress?: (f: number, m: string) => void }} [o] */
export function importFile(bytes, name, o = {}) {
  const copy = bytes.slice();
  return call({ type: 'import', bytes: copy, name, delimiter: o.delimiter, formulas: o.formulas }, [copy.buffer], o.onProgress);
}
/** @param {string} mcsheetText @returns {Promise<{ bytes: Uint8Array, notes: string[] }>} */
export function exportXlsx(mcsheetText) { return /** @type {any} */ (call({ type: 'exportXlsx', text: mcsheetText }, [])); }
