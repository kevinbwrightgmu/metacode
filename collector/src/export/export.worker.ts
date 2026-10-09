// ── Export worker ─────────────────────────────────────────────────────────────
// Builds export files off the main thread, reading IndexedDB itself, so a
// large export doesn't freeze the dashboard. Message in: { id, request };
// message out: { id, ok: true, result } or { id, ok: false, error }.

import { CollectorStore } from '../store/db';
import { buildExport, type ExportRequest } from './run';

let storePromise: Promise<CollectorStore> | null = null;
const scope = self as unknown as { onmessage: ((e: MessageEvent) => void) | null; postMessage: (msg: unknown) => void };

scope.onmessage = async (e: MessageEvent) => {
  const { id, request } = (e.data || {}) as { id: number; request: ExportRequest };
  try {
    storePromise ??= CollectorStore.open();
    const result = await buildExport(await storePromise, request);
    scope.postMessage({ id, ok: true, result });
  } catch (err) {
    scope.postMessage({ id, ok: false, error: err instanceof Error ? err.message : String(err) });
  }
};
