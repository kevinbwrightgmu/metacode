// @ts-check
// The Lab's errors: a machine-readable type, an HTTP status and a message
// written for the user. Raw provider errors never reach the browser as-is.

class LabError extends Error {
  /**
   * @param {string} type
   * @param {string} message
   * @param {{ status?: number, retryAfterSeconds?: number | null, extra?: Record<string, unknown> | null }} [opts]
   */
  constructor(type, message, opts) {
    super(message);
    const o = opts || {};
    this.name = 'LabError';
    this.type = type;
    this.status = o.status || 400;
    this.retryAfterSeconds = o.retryAfterSeconds || null;
    this.extra = o.extra || null;
  }
}

/** @param {unknown} e @returns {e is LabError} */
const isLabError = e => e instanceof LabError;

const notFound = /** @param {string} what */ what => new LabError('not_found', what + ' doesn\'t exist (or was deleted).', { status: 404 });
const invalid = /** @param {string} message */ message => new LabError('invalid_request', message, { status: 400 });

module.exports = { LabError, isLabError, notFound, invalid };
