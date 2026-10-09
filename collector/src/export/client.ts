// ── Running exports from the dashboard ────────────────────────────────────────
import type { CollectorStore } from '../store/db';
import { buildExport, type ExportRequest, type ExportResult } from './run';

let worker: Worker | null = null;
let nextId = 1;
const pending = new Map<number, { resolve: (r: ExportResult) => void; reject: (e: Error) => void }>();

function getWorker(): Worker | null {
  if (worker) return worker;
  if (typeof Worker === 'undefined') return null;
  try {
    worker = new Worker(new URL('./export.worker.ts', import.meta.url), { type: 'module', name: 'collector-export' });
  } catch {
    return null;
  }
  worker.onmessage = (e: MessageEvent) => {
    const { id, ok, result, error } = e.data || {};
    const p = pending.get(id);
    if (!p) return;
    pending.delete(id);
    if (ok) p.resolve(result); else p.reject(new Error(error || 'The export failed.'));
  };
  worker.onerror = e => {
    pending.forEach(p => p.reject(new Error('The export worker failed: ' + (e.message || 'unknown error'))));
    pending.clear();
    worker?.terminate();
    worker = null;
  };
  return worker;
}

/** Builds the export in a Web Worker (or here, where workers aren't available). */
export function runExport(request: ExportRequest, store: CollectorStore): Promise<ExportResult> {
  const w = getWorker();
  if (!w) return buildExport(store, request);
  const id = nextId++;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    w.postMessage({ id, request });
  });
}

export function stopExportWorker(): void {
  worker?.terminate();
  worker = null;
  pending.forEach(p => p.reject(new Error('Cancelled')));
  pending.clear();
}

/** Saves a file to the user's downloads. */
export function download(file: { name: string; blob: Blob }): void {
  const url = URL.createObjectURL(file.blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = file.name;
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
}
