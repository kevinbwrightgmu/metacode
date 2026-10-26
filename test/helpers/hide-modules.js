// Preload (node --require): makes the packages named in HIDE_MODULES
// (comma-separated) unresolvable, as on a server whose node_modules predates
// them ("git pull" without "npm install").
const Module = require('module');
const hidden = new Set(String(process.env.HIDE_MODULES || '').split(',').filter(Boolean));
const resolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
  const name = request.startsWith('@') ? request.split('/').slice(0, 2).join('/') : request.split('/')[0];
  if (hidden.has(name)) { const e = /** @type {Error & { code?: string }} */ (new Error('Cannot find module \'' + request + '\'')); e.code = 'MODULE_NOT_FOUND'; throw e; }
  return resolve.call(this, request, ...rest);
};
