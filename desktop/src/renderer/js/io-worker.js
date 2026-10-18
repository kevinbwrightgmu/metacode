// @ts-check
// ── Import and export off the window's thread ─────────────────────────────────
// Reading an .xlsx or a large CSV takes a while; doing it here keeps the
// window responsive and lets it show progress. Nothing in a file is run:
// formulas are calculated by the spreadsheet engine, macros are ignored.
import '../vendor/reliability-stats.js';
import { readXlsx, writeXlsx, exportNotes } from '../../shared/io/xlsx.js';
import { readCsv } from '../../shared/io/csv.js';
import { browserCodec } from '../../shared/io/zip.js';
import { serialize, parseFile } from '../../shared/engine/file.js';

/** @param {any} msg */
const post = msg => /** @type {any} */ (self).postMessage(msg);

self.onmessage = async (/** @type {MessageEvent} */ ev) => {
  const { id, type } = ev.data;
  try {
    if (type === 'import') {
      const bytes = /** @type {Uint8Array} */ (ev.data.bytes);
      const name = String(ev.data.name || 'Imported');
      const base = name.replace(/\.[^.]+$/, '');
      const isZip = bytes[0] === 0x50 && bytes[1] === 0x4B;
      let wb, notes, extra = {};
      if (isZip || /\.xls[xm]$/i.test(name)) {
        const r = await readXlsx(bytes, { inflate: browserCodec.inflate, name: base, onProgress: (f, message) => post({ id, progress: f, message }) });
        wb = r.workbook; notes = r.notes;
      } else {
        if (/\.xls$/i.test(name)) throw new Error('Old Excel files (.xls) can\'t be opened. Save the file as .xlsx in Excel, then import it.');
        const r = readCsv(bytes, { name: base, delimiter: ev.data.delimiter || undefined, formulas: !!ev.data.formulas });
        wb = r.workbook; notes = r.notes;
        extra = { delimiter: r.delimiter, encoding: r.encoding, rows: r.rows };
        wb.name = base;
      }
      post({ id, done: true, text: serialize(wb), notes, name: base, extra });
    } else if (type === 'exportXlsx') {
      const wb = parseFile(ev.data.text);
      const bytes = await writeXlsx(wb, { deflate: browserCodec.deflate });
      post({ id, done: true, bytes, notes: exportNotes(wb) });
    } else throw new Error('Unknown request');
  } catch (e) {
    post({ id, error: e && /** @type {any} */ (e).message ? String(/** @type {any} */ (e).message) : 'The file couldn\'t be read.' });
  }
};
