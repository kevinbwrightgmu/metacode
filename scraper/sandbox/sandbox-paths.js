// @ts-check
// ── Sandbox engine files and platform checks ──────────────────────────────────
// Shared by the two parents that start sandbox processes: the scraper's
// custom-code runner (custom-runner.js) and the AI Coding Lab's experiment
// runner (ai-lab/code-sandbox.js). Each child may read only the files listed
// here (Node's --allow-fs-read); everything else on disk is refused by the
// permission model. Each parent keeps its own wording for the checks.

const path = require('path');
const fs = require('fs');

const CHILD = path.join(__dirname, 'sandbox-child.js');
const PY_CHILD = path.join(__dirname, 'python-child.js');

/**
 * Directory of an installed package (walks up from its entry point).
 * @param {string} name
 * @returns {string}
 */
function packageRoot(name) {
  let dir = path.dirname(require.resolve(name));
  for (let i = 0; i < 6; i++) {
    try {
      const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
      if (pkg.name === name) return dir;
    } catch (e) { /* keep walking */ }
    dir = path.dirname(dir);
  }
  throw new Error('Package root not found for ' + name);
}

// QuickJS (JavaScript / TypeScript): the child, the engine packages and the
// WebAssembly builds. Throws when the engine isn't installed.
/** @type {{ entry: string, dirs: string[] } | null} */
let readablePaths = null;
/** @returns {{ entry: string, dirs: string[] }} */
function sandboxReadablePaths() {
  if (!readablePaths) {
    const qjs = packageRoot('quickjs-emscripten');
    const core = packageRoot('quickjs-emscripten-core');
    const jitl = path.dirname(packageRoot('@jitl/quickjs-wasmfile-release-sync'));
    readablePaths = { entry: require.resolve('quickjs-emscripten'), dirs: [CHILD, qjs, core, jitl] };
  }
  return readablePaths;
}

// Pyodide (Python): its entry file and package directory. Callers add the
// child itself and anything else their child needs to read. Throws when
// Pyodide isn't installed.
/** @type {{ entry: string, dir: string, root: string } | null} */
let pyEngine = null;
/** @returns {{ entry: string, dir: string, root: string }} */
function pythonEnginePaths() {
  if (!pyEngine) {
    const root = packageRoot('pyodide');
    pyEngine = { entry: path.join(root, 'pyodide.js'), dir: root + path.sep, root };
  }
  return pyEngine;
}

// Node's permission model (--permission) is the process wall around both engines.
/** @returns {boolean} */
function permissionModelAvailable() {
  const flags = process.allowedNodeEnvironmentFlags;
  return !!flags && flags.has('--permission');
}

// The Python child's network lock-down uses synchronous module hooks.
/** @returns {boolean} */
function moduleHooksAvailable() {
  return typeof require('node:module').registerHooks === 'function';
}

// TypeScript is turned into JavaScript by Node itself (types stripped in place).
/** @returns {boolean} */
function typeScriptAvailable() {
  return typeof require('node:module').stripTypeScriptTypes === 'function';
}

module.exports = {
  CHILD, PY_CHILD, packageRoot, sandboxReadablePaths, pythonEnginePaths,
  permissionModelAvailable, moduleHooksAvailable, typeScriptAvailable
};
