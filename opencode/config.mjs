// ── Configuration of MetaCode's OpenCode service ──────────────────────────────
// Which AI providers the service offers and how it reaches them, in OpenCode's
// own (v1) config format, the format emis-models.json already uses:
//
//   opencode/opencode.json   MetaCode's defaults (committed): the AI gateway (EMIS) and OpenCode Zen
//   OPENCODE_CONFIG          an operator's file merged over it: provider.<id> objects are merged
//                            key by key; model, enabled_providers and disabled_providers replace
//
// In string values, {env:VAR} becomes that environment variable ("" when it's
// unset) and {file:path} the text of that file (relative to the config file,
// ~/ = the home folder, trimmed). An empty baseURL means the provider's
// default; an empty apiKey means "no key". Only these keys are read; anything
// else gets one warning and is ignored:
//
//   provider.<id>: npm, name, options {baseURL, apiKey, headers, transport, models_file},
//                  models {<model id>: {name, tool_call, reasoning, attachment, temperature,
//                  limit {context, output}, status}}, whitelist [], blacklist []
//   model, enabled_providers [], disabled_providers []
//
// Provider kinds: the id "opencode" is OpenCode Zen (its models come from the
// catalog, catalog.mjs); any other id with npm "@ai-sdk/openai-compatible" is
// an OpenAI-compatible provider (providers/openai-compatible.mjs); anything
// else is skipped with a warning. enabled_providers is an allow-list and
// disabled_providers a deny-list, as in OpenCode; OPENCODE_DISABLED_PROVIDERS
// (a comma list in .env) switches more providers off.
//
// The provider "emis" (MetaCode's AI gateway) gets the settings it had before
// the service existed: the address EMIS_DEFAULT_BASE_URL when baseURL is empty,
// the models file options.models_file → EMIS_MODELS_FILE (left empty otherwise:
// the provider then reads <repo>/emis-models.json and doesn't warn when it's
// missing), and the transport options.transport → EMIS_TRANSPORT → auto.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const shared = require('./shared.js');

export const DEFAULT_CONFIG_PATH = fileURLToPath(new URL('./opencode.json', import.meta.url));
export const EMIS_DEFAULT_BASE_URL = 'https://emis.zxs-is-very.cool/v1';
export const OPENAI_COMPATIBLE_NPM = '@ai-sdk/openai-compatible';

// What opencode/opencode.json says, for when that file is missing or damaged
const BUILT_IN = {
  provider: {
    emis: { npm: OPENAI_COMPATIBLE_NPM, name: 'AI gateway', options: { baseURL: '{env:EMIS_BASE_URL}', apiKey: '{env:EMIS_API_KEY}' } },
    opencode: { name: 'OpenCode Zen', options: { apiKey: '{env:OPENCODE_API_KEY}' } }
  }
};

const TOP_KEYS = new Set(['$schema', 'provider', 'model', 'enabled_providers', 'disabled_providers']);
const PROVIDER_KEYS = new Set(['npm', 'name', 'options', 'models', 'whitelist', 'blacklist']);
const OPTION_KEYS = new Set(['baseURL', 'apiKey', 'headers', 'transport', 'models_file']);
const MODEL_KEYS = new Set(['name', 'tool_call', 'reasoning', 'attachment', 'temperature', 'limit', 'status']);
const LIMIT_KEYS = new Set(['context', 'output']);
const PROVIDER_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

const isObject = v => !!v && typeof v === 'object' && !Array.isArray(v);
const expandHome = p => (p === '~' ? os.homedir() : p.startsWith('~/') ? path.join(os.homedir(), p.slice(2)) : p);

// {env:VAR} / {file:path} inside every string value of one config file
function substitute(value, ctx) {
  if (typeof value === 'string') {
    return value.replace(/\{(env|file):([^{}]+)\}/g, (all, kind, name) => {
      const ref = name.trim();
      if (kind === 'env') return ctx.env[ref] === undefined || ctx.env[ref] === null ? '' : String(ctx.env[ref]);
      const file = path.resolve(ctx.dir, expandHome(ref));
      try { return fs.readFileSync(file, 'utf8').trim(); }
      catch (e) {
        ctx.warnings.push('{file:' + ref + '} in ' + ctx.label + ' couldn\'t be read (' + (e.code || e.message) + '); an empty value is used.');
        return '';
      }
    });
  }
  if (Array.isArray(value)) return value.map(v => substitute(v, ctx));
  if (isObject(value)) {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = substitute(v, ctx);
    return out;
  }
  return value;
}

// One config file → its substituted content (null when unusable, with a warning)
function readConfigFile(file, label, env, warnings) {
  let json;
  try { json = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, '')); }
  catch (e) {
    const why = e.code ? 'it couldn\'t be read (' + e.code + ')' : 'it isn\'t valid JSON';
    warnings.push(label + ' (' + file + ') is ignored: ' + why + '.');
    return null;
  }
  if (!isObject(json)) { warnings.push(label + ' (' + file + ') is ignored: it isn\'t a JSON object.'); return null; }
  const dir = path.dirname(file);
  const out = substitute(json, { env, dir, label, warnings });
  // a models file named in this file is relative to this file
  if (isObject(out.provider)) {
    for (const p of Object.values(out.provider)) {
      const mf = isObject(p) && isObject(p.options) ? p.options.models_file : undefined;
      if (typeof mf === 'string' && mf.trim() && !shared.isOff(mf)) p.options.models_file = path.resolve(dir, expandHome(mf.trim()));
    }
  }
  return out;
}

// Objects merge key by key; arrays and plain values replace
function deepMerge(a, b) {
  if (!isObject(a) || !isObject(b)) return b === undefined ? a : b;
  const out = Object.assign({}, a);
  for (const [k, v] of Object.entries(b)) out[k] = deepMerge(a[k], v);
  return out;
}

function mergeConfigs(base, over) {
  const out = Object.assign({}, base);
  for (const [k, v] of Object.entries(over)) {
    if (k === 'provider' && isObject(v) && isObject(base.provider)) {
      out.provider = Object.assign({}, base.provider);
      for (const [id, p] of Object.entries(v)) out.provider[id] = deepMerge(base.provider[id], p);
    } else out[k] = v;
  }
  return out;
}

// Keeps only the supported keys of one provider entry; a warning per thing left out
function cleanProvider(id, raw, warn) {
  const at = 'provider.' + id;
  const out = {};
  const text = (where, v) => {
    if (v === undefined || v === null) return undefined;
    if (typeof v === 'string') return v.trim();
    warn('"' + where + '" must be text; it is ignored.');
    return undefined;
  };
  const list = (where, v) => {
    if (v === undefined || v === null) return undefined;
    if (Array.isArray(v) && v.every(x => typeof x === 'string')) return v.map(x => x.trim()).filter(Boolean);
    warn('"' + where + '" must be a list of model ids; it is ignored.');
    return undefined;
  };
  for (const k of Object.keys(raw)) if (!PROVIDER_KEYS.has(k)) warn('"' + at + '.' + k + '" isn\'t supported by MetaCode\'s OpenCode service and is ignored.');

  const npm = text(at + '.npm', raw.npm);
  if (npm) out.npm = npm;
  const name = text(at + '.name', raw.name);
  if (name) out.name = name.slice(0, 80);

  out.options = {};
  if (raw.options !== undefined && !isObject(raw.options)) warn('"' + at + '.options" must be an object; it is ignored.');
  else if (raw.options) {
    for (const [k, v] of Object.entries(raw.options)) {
      if (!OPTION_KEYS.has(k)) { warn('"' + at + '.options.' + k + '" isn\'t supported by MetaCode\'s OpenCode service and is ignored.'); continue; }
      if (k === 'headers') {
        if (!isObject(v) || !Object.values(v).every(x => typeof x === 'string')) { warn('"' + at + '.options.headers" must be an object of text values; it is ignored.'); continue; }
        out.options.headers = Object.assign({}, v);
      } else {
        const s = text(at + '.options.' + k, v);
        if (s !== undefined) out.options[k] = s;
      }
    }
  }

  if (raw.models !== undefined && !isObject(raw.models)) warn('"' + at + '.models" must be an object; it is ignored.');
  else if (raw.models) {
    out.models = {};
    for (const [mid, m] of Object.entries(raw.models)) {
      if (!isObject(m)) { warn('"' + at + '.models.' + mid + '" must be an object; it is ignored.'); continue; }
      const model = {};
      for (const [k, v] of Object.entries(m)) {
        if (!MODEL_KEYS.has(k)) { warn('"' + at + '.models.*.' + k + '" isn\'t supported by MetaCode\'s OpenCode service and is ignored.'); continue; }
        if (k === 'name' || k === 'status') { const s = text(at + '.models.*.' + k, v); if (s) model[k] = s; }
        else if (k === 'limit') {
          if (!isObject(v)) { warn('"' + at + '.models.*.limit" must be an object; it is ignored.'); continue; }
          const limit = {};
          for (const [lk, lv] of Object.entries(v)) {
            if (!LIMIT_KEYS.has(lk)) warn('"' + at + '.models.*.limit.' + lk + '" isn\'t supported by MetaCode\'s OpenCode service and is ignored.');
            else if (Number.isInteger(lv) && lv > 0) limit[lk] = lv;
            else warn('"' + at + '.models.*.limit.' + lk + '" must be a whole number above 0; it is ignored.');
          }
          if (Object.keys(limit).length) model.limit = limit;
        } else if (typeof v === 'boolean') model[k] = v;
        else warn('"' + at + '.models.*.' + k + '" must be true or false; it is ignored.');
      }
      out.models[mid] = model;
    }
  }
  const white = list(at + '.whitelist', raw.whitelist);
  if (white) out.whitelist = white;
  const black = list(at + '.blacklist', raw.blacklist);
  if (black) out.blacklist = black;
  return out;
}

const idList = value => String(value || '').split(',').map(s => s.trim()).filter(Boolean);

/**
 * Reads the service's config.
 *
 * @param {object} opts
 * @param {object} opts.env            the service's environment (after .env)
 * @param {string} [opts.configPath]   default opencode/opencode.json
 * @param {string} [opts.repoDir]      where relative env paths start (default: the MetaCode folder)
 * @returns {{providers: object[], model: string|null, warnings: string[], files: string[]}}
 *   providers, in config order: {id, kind: 'zen'|'openai-compatible', name, config, disabled}
 *   config = the merged, cleaned entry ({npm?, name?, options: {…}, models?, whitelist?, blacklist?});
 *   disabled = null, or why the provider is switched off (it is still listed, so the status can say so)
 */
export function loadConfig(opts) {
  const env = opts.env || {};
  const repoDir = opts.repoDir || shared.REPO_DIR;
  const configPath = opts.configPath || DEFAULT_CONFIG_PATH;
  const warnings = [];
  const files = [];
  const seen = new Set();
  const warn = w => { if (!seen.has(w)) { seen.add(w); warnings.push(w); } };

  let cfg = readConfigFile(configPath, 'The service\'s config file', env, warnings);
  if (cfg) files.push(configPath);
  else cfg = substitute(BUILT_IN, { env, dir: path.dirname(configPath), label: 'the built-in config', warnings });

  const operatorPath = String(env.OPENCODE_CONFIG || '').trim();
  if (operatorPath) {
    const file = path.resolve(repoDir, expandHome(operatorPath));
    const over = readConfigFile(file, 'OPENCODE_CONFIG', env, warnings);
    if (over) { cfg = mergeConfigs(cfg, over); files.push(file); }
  }

  for (const k of Object.keys(cfg)) if (!TOP_KEYS.has(k)) warn('"' + k + '" isn\'t supported by MetaCode\'s OpenCode service and is ignored.');
  let model = null;
  if (cfg.model !== undefined && cfg.model !== null) {
    if (typeof cfg.model === 'string' && cfg.model.trim()) model = cfg.model.trim();
    else warn('"model" in the config must be a model id such as "opencode/big-pickle"; it is ignored.');
  }
  const ids = key => {
    const v = cfg[key];
    if (v === undefined || v === null) return null;
    if (Array.isArray(v) && v.every(x => typeof x === 'string')) return v.map(x => x.trim()).filter(Boolean);
    warn('"' + key + '" in the config must be a list of provider ids; it is ignored.');
    return null;
  };
  const enabled = ids('enabled_providers');
  const disabledList = ids('disabled_providers') || [];
  const envDisabled = idList(env.OPENCODE_DISABLED_PROVIDERS);

  const providers = [];
  const entries = isObject(cfg.provider) ? Object.entries(cfg.provider) : [];
  if (cfg.provider !== undefined && !isObject(cfg.provider)) warn('"provider" in the config must be an object; it is ignored.');
  for (const [id, raw] of entries) {
    if (!PROVIDER_ID.test(id)) { warn('The provider id "' + id.slice(0, 40) + '" can only use letters, digits, ".", "_" and "-"; it is skipped.'); continue; }
    if (!isObject(raw)) { warn('"provider.' + id + '" must be an object; it is skipped.'); continue; }
    const config = cleanProvider(id, raw, warn);
    let kind;
    if (id === 'opencode') kind = 'zen';
    else if (config.npm === OPENAI_COMPATIBLE_NPM) kind = 'openai-compatible';
    else {
      warn('The provider "' + id + '" is skipped: only OpenCode Zen and OpenAI-compatible providers (npm "' + OPENAI_COMPATIBLE_NPM + '") are supported' +
        (config.npm ? ', not "' + config.npm.slice(0, 60) + '"' : '') + '.');
      continue;
    }
    if (id === 'emis') {
      if (!config.options.baseURL) config.options.baseURL = EMIS_DEFAULT_BASE_URL;
      const modelsFile = String(env.EMIS_MODELS_FILE || '').trim();
      // ("none" / "off": no models file, the gateway's live list)
      if (!config.options.models_file && modelsFile) config.options.models_file = shared.isOff(modelsFile) ? 'none' : path.resolve(repoDir, expandHome(modelsFile));
      if (!config.options.transport) config.options.transport = String(env.EMIS_TRANSPORT || '').trim().toLowerCase() || 'auto';
    }
    let disabled = null;
    if (envDisabled.includes(id)) disabled = 'Switched off by OPENCODE_DISABLED_PROVIDERS.';
    else if (disabledList.includes(id)) disabled = 'Switched off by disabled_providers in the service\'s config.';
    else if (enabled && !enabled.includes(id)) disabled = 'Switched off: not in enabled_providers in the service\'s config.';
    providers.push({ id, kind, name: config.name || (kind === 'zen' ? 'OpenCode Zen' : id), config, disabled });
  }
  return { providers, model, warnings, files };
}
