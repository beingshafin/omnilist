'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const https = require('https');
const http = require('http');
const readline = require('readline');
const { execFileSync } = require('child_process');

// ---------- provider prefix ----------
// Managed keys are `c-<provider>[-<N>][-<adapter>]` (t3: `c-<provider>[-<N>]-<driver>`):
// lowercase letters/digits only, '-' separator. Names are simplified (see simplifyName).
// Legacy `c_`-style keys are no longer written; cleanup treats them as stale and removes them.
const PREFIX = 'c-';
const LEGACY_PREFIX = 'c_';
const PREFIX_UPPER = 'C_';
// Simplify a provider/adapter/driver name: lowercase, keep [a-z0-9] only.
function simplifyName(s) {
  return String(s == null ? '' : s).toLowerCase().replace(/[^a-z0-9]+/g, '');
}
function providerKey(provider) {
  const p = simplifyName(provider);
  return p.startsWith(PREFIX) ? p : PREFIX + p;
}
// A managed key uses the current `c-` prefix or the legacy `c_` prefix (legacy -> stale, pruned by cleanup).
function isManagedKey(key) {
  return typeof key === 'string' && (key.startsWith(PREFIX) || key.startsWith(LEGACY_PREFIX));
}
// Parse a managed key into { provider, idx, adapter, legacy }. Simplified segments contain
// no '-', so c- keys split unambiguously: c-<provider>[-<N>][-<adapter>] (t3 driver lands in
// `adapter`). Legacy c_ keys are parsed only so cleanup can recognize and prune them as stale.
function parseManagedRestKey(key) {
  if (typeof key !== 'string') return null;
  if (key.startsWith(PREFIX)) {
    const parts = key.slice(PREFIX.length).split('-');
    const provider = parts.shift();
    if (!provider) return null;
    let idx = null; let adapter = null;
    if (parts.length === 1) {
      if (/^\d+$/.test(parts[0])) idx = parseInt(parts[0], 10);
      else adapter = parts[0];
    } else if (parts.length >= 2) {
      if (/^\d+$/.test(parts[0])) idx = parseInt(parts[0], 10);
      adapter = parts.slice(/^\d+$/.test(parts[0]) ? 1 : 0).join('-');
    }
    return { provider, idx, adapter, legacy: false };
  }
  if (key.startsWith(LEGACY_PREFIX)) {
    const rest = key.slice(LEGACY_PREFIX.length);
    let adapter = null;
    let r = rest;
    const cut = r.lastIndexOf('__');
    if (cut !== -1) { adapter = r.slice(cut + 2); r = r.slice(0, cut); }
    let provider = r; let idx = null;
    const m = r.match(/^(.*)_(\d+)$/);
    if (m) { provider = m[1]; idx = parseInt(m[2], 10); }
    if (!provider) return null;
    return { provider, idx, adapter, legacy: true };
  }
  return null;
}

// ---------- config ----------
const home = os.homedir();
// Config is read from config.jsonc next to this script (override the whole
// file via OMNILIST_CONFIG). A legacy config.json is honored if present. Both
// are JSONC — comments allowed. Private overrides live in config.local.jsonc
// (gitignored), which is layered on top and wins over config.jsonc.

const DEFAULTS = {
  paths: {
    models_csv: 'data/models-filtered.csv',
    providers_csv: 'data/providers.csv',
    all_models_csv: 'data/models-all.csv',  // raw catalog (dedup only, pre-filter); '' = <models dir>/models-all.csv
    harness_models_file: 'data/models-<harness>.csv',  // per-harness preview; <harness> -> t3/dsh/opencode/kilo
    opencode_file: '~/.config/opencode/opencode.jsonc',
    kilo_file: '~/.config/kilo/kilo.jsonc',
    t3_settings_file: '',
    t3_data_dir: '~/.t3/userdata',
    t3_logs_dir: '',
    dsh_settings_file: '~/.dsh/settings.yaml',
    dsh_credentials_file: '~/.dsh/.credentials.yaml',
    pi_file: '~/.pi/agent/models.json',
    zcode_file: '~/.zcode/v2/config.json',
    opencodex_file: '~/.opencodex/config.json',
  },
  cli: {
    install_as_command: true,
    command_name: 'omnilist',
  },
  // Fetch behavior for the special "Router" provider.
  //   models_endpoint: full URL to the router's model list. Leave '' to use
  //     <base_url>/models from the Router row in providers.csv.
  fetch: {
    models_endpoint: '',
  },
  // Capability detection when building models-filtered.csv.
  // Each entry lists field names (in priority order) to read from a router model
  // object. Fields are searched at the top level and inside nested objects such
  // as "capabilities" (e.g. capabilities.reasoning). Values become 1 (true),
  // 0 (false), or -1 when none of the fields exist. n_a_defaults controls what
  // sync steps emit when a model is -1.
  capabilities: {
    fields: {
      vision: ['vision', 'supports_vision', 'image', 'input_modalities', 'attachment'],
      reasoning: ['reasoning', 'supports_reasoning', 'thinking', 'supportsThinking'],
      tool: ['tool_call', 'tool_calls', 'supports_tool_call', 'tools', 'tool_calling', 'supports_tool_calling'],
    },
    n_a_defaults: { vision: true, reasoning: true, tool: true },
  },

  // Model-name filter rules.
  // Default behavior: all models are included.
  // Step 1 - block keywords (top-down): models matching any "..." rule are excluded.
  // Step 2 - rescue free models ("*free"): anything ending in "free" is allowed
  //   regardless of earlier block matches.
  // Evaluation is LAST-rule-wins: later rules override earlier ones.
  // Patterns are matched against the full model id (case-insensitive).
  //   "!xxx"  or  "!xxx*" or  "!*xxx*"  -> BLOCK (exclude)
  //   "xxx"  or  "xxx*" or  "*xxx*"  -> ALLOW (include)
  // "*" is a wildcard: "foo*bar" means starts "foo" AND ends "bar".
  // No "*" means substring match.
  model_filters: [
    "!kc/*",
    "!opencode-zen/*",
    "*free",
    "!agy/*",
    "!gemini/*",
    "!no-think",
    "!compatible",
  ],
  // Unified second-stage filters applied on top of models-filtered.csv at sync time.
  // Syntax: "<rule>" (all harnesses) or "<rule>->t3,dsh" (only listed harnesses).
  // Harness ids: opencode (alias oc), kilo, t3, dsh.
  harness_filters: [],
  // Sync-time field overrides, applied when each harness reads models (the CSV
  // files keep the raw router values). Directive syntax mirrors harness_filters:
  //   "(field:value)"            -> all harnesses
  //   "(field:value)->t3,dsh"    -> only the listed harnesses
  // field = models-filtered.csv column: id, input_context, output_context,
  // vision, reasoning, tool. invalid_value_overrides rewrite the field only when
  // the current value is invalid (<= 0 for numeric fields, empty for id);
  // always_overrides rewrite it unconditionally. Later directives win.
  // e.g. [ "(input_context:1000000)->t3,dsh", "(output_context:8192)" ]
  invalid_value_overrides: [],
  always_overrides: [],
  // Which harnesses use the raw catalog (models-all.csv) instead of the filtered
  // models-filtered.csv. "Raw" means dedup-only, before model_filters — these harnesses
  // read models-all.csv and apply only their harness_filters + custom_models.
  raw_catalog_harnesses: [], // e.g. ["dsh"] or ["dsh","t3"]
  // Per-harness model list CSVs (models-<harness>.csv):
  //   "raw"        -> write only for raw_catalog_harnesses, delete strays for others
  //   "all"        -> write for every harness that syncs
  //   "configured" -> write only for harnesses specifically targeted by harness_filters
  //                   ("<rule>->t3,dsh"); rules without "->" apply to all harnesses and
  //                   don't make a harness "configured"
  //   "none"       -> never write, delete any existing preview CSVs
  // (No default key here so a legacy "harness_previews" value isn't shadowed;
  // resolved after load: show_harness_model_list wins over harness_previews.)
  // Custom models to inject into models-filtered.csv on every fetch.
  // Format: { id: "provider/model", in: <input_context>, out: <output_context>,
  //           vision?: 0|1, reasoning?: 0|1, tool?: 0|1 }
  custom_models: [],

  cleanup_default: true,

  // Emit the full hardcoded model template into OpenCode/Kilo provider blocks:
  // every capability flag hardcoded true + "modalities" + "variants", with only
  // the context/output limits taken from models-filtered.csv. When false, capability
  // flags are read from models-filtered.csv and no modalities/variants are emitted.
  follow_hardcoded_model_template: true,

  targets: {
    opencode_solo: true,
    opencode_router: true,
    opencode_rest: false,
    kilo_solo: true,
    kilo_router: true,
    kilo_rest: false,
    kilo_copy_opencode_full_provider_block: false,
    t3_solo: true,
    t3_router: true,
    t3_rest: true,
    dsh_solo: true,
    dsh_router: false,
    dsh_rest: false,
    pi_solo: true,
    pi_router: false,
    pi_rest: false,
    zcode_solo: false,
    zcode_router: false,
    zcode_rest: false,
    opencodex_solo: true,
    opencodex_router: false,
    opencodex_rest: false,
  },

  t3: {
    router_drivers: [
      { driver: 'claudeAgent', '1m': true },
      { driver: 'codex', '1m': false },
    ],
    // dont use codex or any other driver here only claude recommended
    solo_provider_drivers: [
      { driver: 'claudeAgent', '1m': true },
    ],
    rest_provider_drivers: [
      { driver: 'claudeAgent', '1m': true },
    ],
    // Per-driver config strategy for T3 provider instances.
    // claudeAgent connects via ANTHROPIC_* environment variables;
    // codex connects via launchArgs (model_provider / model_providers.* overrides).
    driver_strategy: {
      claudeAgent: { mode: 'env', apiKey: 'ANTHROPIC_API_KEY', baseUrl: 'ANTHROPIC_BASE_URL' },
      codex: { mode: 'launchArgs' },
    },
  },

  // If true, remove script-managed (c-*) providers whose feature flag is false.
  // If true, remove script-managed (c-*) providers that no longer exist in providers.csv.
  cleanup_providers: {
    remove_if_false_provider: true,
    remove_if_provider_doesnt_exist: true,
  },

  opencode: { router_adapters: ['@ai-sdk/openai-compatible'], solo_adapters: ['@ai-sdk/openai-compatible'], rest_adapters: ['@ai-sdk/openai-compatible'] },
  kilo:     { router_adapters: ['@ai-sdk/openai-compatible'], solo_adapters: ['@ai-sdk/openai-compatible'], rest_adapters: ['@ai-sdk/openai-compatible'] },
  pi:       { router_adapters: ['openai-completions'],         solo_adapters: ['openai-completions'],         rest_adapters: ['openai-completions'] },
  zcode:    { router_adapters: ['openai-compatible'],          solo_adapters: ['openai-compatible'],          rest_adapters: ['openai-compatible'] },
  opencodex:{ router_adapters: ['openai-chat'],                solo_adapters: ['openai-chat'],                rest_adapters: ['openai-chat'] },

  dsh: {
    router_adapters: ['openai-completions'],
    solo_adapters: ['openai-completions'],
    rest_adapters: ['openai-completions'],
    model_inputs: 'hardcode',   // 'hardcode' | 'vision' | ["text","image"]
  },

  // Commands to run AFTER all sync targets finish — sequentially: each command
  // runs to completion (cmd.exe /c on Windows, sh -c elsewhere) before the next
  // one starts. Two special entry forms: "sleep <seconds>" pauses the chain,
  // and "bg:<command>" launches detached in the background for servers that
  // never exit, e.g. ["bg:ocx start", "ocx sync", "sleep 5", "ocx claude desktop apply"].
  // A foreground command's output is captured and shown only when it exits
  // non-zero; failures don't stop the chain but make the script exit 1.
  custom_commands: [],
};

// Recursively merge `source` into `target` (arrays are replaced wholesale).
function deepMerge(target, source) {
  for (const key of Object.keys(source)) {
    const sv = source[key];
    const tv = target[key];
    if (sv && typeof sv === 'object' && !Array.isArray(sv) &&
        tv && typeof tv === 'object' && !Array.isArray(tv)) {
      deepMerge(tv, sv);
    } else {
      target[key] = sv;
    }
  }
  return target;
}

const PROJECT_ROOT = path.resolve(__dirname, '..');

// Resolve "~" and relative paths against the project root directory.
function resolvePath(p) {
  if (!p) return '';
  p = p.replace(/^~($|\/|\\)/, home + '$1');
  if (!path.isAbsolute(p)) p = path.join(PROJECT_ROOT, p);
  return path.normalize(p);
}

// Resolve a catalog CSV path (raw catalog or per-harness preview). Absolute
// paths and ~ are used as-is; bare filenames are anchored next to models-filtered.csv so
// all catalog files stay together even when MODELS_TEST overrides its location.
function resolveCatalogPath(name) {
  if (!name) return '';
  if (name.startsWith('~') || path.isAbsolute(name)) return resolvePath(name);
  const norm = name.replace(/\\/g, '/').replace(/^\.\//, '');
  if (norm.startsWith('data/')) {
    return path.normalize(path.join(PROJECT_ROOT, norm));
  }
  return path.normalize(path.join(path.dirname(MODELS_CSV), name));
}

function loadDefaults() {
  const cfg = deepMerge(JSON.parse(JSON.stringify(DEFAULTS)), {});
  const defFile = path.join(PROJECT_ROOT, 'config', 'default.jsonc');
  if (fs.existsSync(defFile)) {
    try {
      const raw = fs.readFileSync(defFile, 'utf8');
      const json = stripJsoncComments(raw).replace(/,\s*([}\]])/g, '$1').trim();
      deepMerge(cfg, JSON.parse(json));
    } catch (e) {
      console.error('Failed to parse ' + defFile + ': ' + e.message + ' (using built-in defaults)');
    }
  }
  return cfg;
}

function loadConfig() {
  const cfg = loadDefaults();
  // Primary: config/config.jsonc (shipped/user config). Fallback to root config.jsonc or config.json.
  let primary = process.env.OMNILIST_CONFIG;
  if (!primary) {
    const p1 = path.join(PROJECT_ROOT, 'config', 'config.jsonc');
    const p2 = path.join(PROJECT_ROOT, 'config.jsonc');
    const p3 = path.join(PROJECT_ROOT, 'config', 'config.json');
    const p4 = path.join(PROJECT_ROOT, 'config.json');
    if (fs.existsSync(p1)) primary = p1;
    else if (fs.existsSync(p2)) primary = p2;
    else if (fs.existsSync(p3)) primary = p3;
    else if (fs.existsSync(p4)) primary = p4;
    else primary = p1;
  }
  const files = [primary];
  if (!process.env.OMNILIST_CONFIG) {
    const l1 = path.join(PROJECT_ROOT, 'config', 'config.local.jsonc');
    const l2 = path.join(PROJECT_ROOT, 'config.local.jsonc');
    if (fs.existsSync(l1)) files.push(l1);
    else if (fs.existsSync(l2)) files.push(l2);
    else files.push(l1);
  }
  for (const file of files) {
    if (!fs.existsSync(file)) continue;
    try {
      const raw = fs.readFileSync(file, 'utf8');
      // JSONC support: strip // and /* */ comments, then allow trailing commas.
      const json = stripJsoncComments(raw).replace(/,\s*([}\]])/g, '$1').trim();
      deepMerge(cfg, JSON.parse(json));
    } catch (e) {
      console.error('Failed to parse ' + file + ': ' + e.message + ' (using defaults)');
    }
  }
  return cfg;
}

const cfg = loadConfig();

// ---------- resolved paths ----------
function resolveProvidersCsv(p) {
  if (process.env.PROVIDERS_CSV) return path.normalize(process.env.PROVIDERS_CSV);
  if (!p) return path.join(PROJECT_ROOT, 'data', 'providers.csv');
  if (path.isAbsolute(p) || p.startsWith('~')) return resolvePath(p);

  const inData = path.join(PROJECT_ROOT, 'data', 'providers.csv');
  const inRoot = path.join(PROJECT_ROOT, 'providers.csv');

  const norm = p.replace(/\\/g, '/').replace(/^\.\//, '');
  if (norm === 'providers.csv' || norm === 'data/providers.csv') {
    if (fs.existsSync(inData)) return inData;
    if (fs.existsSync(inRoot)) return inRoot;
    return inData;
  }

  const resolved = resolvePath(p);
  if (fs.existsSync(resolved)) return resolved;
  return inData;
}

function resolveModelsCsv(p) {
  if (process.env.MODELS_TEST) return path.normalize(process.env.MODELS_TEST);
  if (!p) return path.join(PROJECT_ROOT, 'data', 'models-filtered.csv');
  if (path.isAbsolute(p) || p.startsWith('~')) return resolvePath(p);

  const inData = path.join(PROJECT_ROOT, 'data', 'models-filtered.csv');
  const inRoot = path.join(PROJECT_ROOT, 'models-filtered.csv');

  const norm = p.replace(/\\/g, '/').replace(/^\.\//, '');
  if (norm === 'models-filtered.csv' || norm === 'data/models-filtered.csv') {
    if (fs.existsSync(inData)) return inData;
    if (fs.existsSync(inRoot)) return inRoot;
    return inData;
  }

  const resolved = resolvePath(p);
  if (fs.existsSync(resolved)) return resolved;
  return inData;
}

const MODELS_CSV = path.normalize(resolveModelsCsv(cfg.paths.models_csv));
const PROVIDERS_CSV = path.normalize(resolveProvidersCsv(cfg.paths.providers_csv));
const OPENCODE_FILE = path.normalize(process.env.JSONC_TEST || resolvePath(cfg.paths.opencode_file));
const KILO_FILE = path.normalize(process.env.KILO_TEST || resolvePath(cfg.paths.kilo_file));
// T3 userdata dir. Override with T3_DATA_DIR if T3 keeps its data elsewhere.
const T3_DATA_DIR = path.normalize(process.env.T3_DATA_DIR || resolvePath(cfg.paths.t3_data_dir));
const T3_SETTINGS_FILE = path.normalize(resolvePath(cfg.paths.t3_settings_file) || path.join(T3_DATA_DIR, 'settings.json'));
const T3_LOGS_DIR = path.normalize(resolvePath(cfg.paths.t3_logs_dir) || path.join(T3_DATA_DIR, 'logs'));
const DSH_SETTINGS_FILE = path.normalize(process.env.DSH_SETTINGS_FILE || resolvePath(cfg.paths.dsh_settings_file));
const DSH_CREDENTIALS_FILE = path.normalize(process.env.DSH_CREDENTIALS_FILE || resolvePath(cfg.paths.dsh_credentials_file));
const PI_FILE = path.normalize(process.env.PI_FILE || resolvePath(cfg.paths.pi_file));
const ZCODE_FILE = path.normalize(process.env.ZCODE_FILE || resolvePath(cfg.paths.zcode_file));
const OPENCODEX_FILE = path.normalize(process.env.OPENCODEX_FILE || process.env.OCX_FILE || resolvePath(cfg.paths.opencodex_file));
const ALL_MODELS_CSV = path.normalize(process.env.ALL_MODELS_TEST || resolveCatalogPath(cfg.paths.all_models_csv) || path.join(path.dirname(MODELS_CSV), 'models-all.csv'));

function soloAllCsvPath(provider) {
  const simp = simplifyName(provider);
  return path.join(path.dirname(ALL_MODELS_CSV), `models-all-${simp}.csv`);
}

function soloFilteredCsvPath(provider) {
  const simp = simplifyName(provider);
  return path.join(path.dirname(MODELS_CSV), `models-filtered-${simp}.csv`);
}

// ---------- config shortcuts ----------
const INSTALL_AS_COMMAND = cfg.cli.install_as_command;
const CLI_COMMAND_NAME = cfg.cli.command_name;

const MODELS_ENDPOINT = cfg.fetch.models_endpoint;
const CLEANUP_DEFAULT = cfg.cleanup_default;
const FOLLOW_HARDCODED_MODEL_TEMPLATE = cfg.follow_hardcoded_model_template;

const MODEL_FILTERS = cfg.model_filters;
const HARNESS_FILTERS_RAW = cfg.harness_filters || [];
const INVALID_OVERRIDES_RAW = cfg.invalid_value_overrides || [];
const ALWAYS_OVERRIDES_RAW = cfg.always_overrides || [];
const RAW_CATALOG_RAW = cfg.raw_catalog_harnesses || [];
// Legacy name "harness_previews" is still accepted as a fallback.
const _previewsPref = cfg.show_harness_model_list !== undefined ? cfg.show_harness_model_list : cfg.harness_previews;
const HARNESS_PREVIEWS_MODE = ['raw', 'all', 'configured', 'none'].includes(_previewsPref) ? _previewsPref : 'raw';
const CUSTOM_MODELS = cfg.custom_models;

// ---------- model_sort ----------
// cfg.model_sort orders the filtered model pipeline (models-filtered.csv, harness previews,
// every harness config). Fields use the models-filtered.csv column names; leading '-' = descending;
// comma-separated multi-key allowed; ties always break by id so output is deterministic.
// models-all.csv (raw catalog) stays id-sorted regardless.
const SORT_FIELDS = { id: 'id', input_context: 'in', output_context: 'out', vision: 'vision', reasoning: 'reasoning', tool: 'tool' };
function parseModelSort(spec) {
  if (spec === undefined || spec === null || spec === '') return null;
  if (typeof spec !== 'string') throw new Error(`model_sort must be a string, got ${typeof spec}`);
  const keys = spec.split(',').map((s) => s.trim()).filter(Boolean);
  if (!keys.length) return null;
  const parsed = [];
  for (const k of keys) {
    const desc = k.startsWith('-');
    const name = desc ? k.slice(1) : k;
    const key = SORT_FIELDS[name];
    if (!key) throw new Error(`model_sort: unknown field "${name}" (valid: ${Object.keys(SORT_FIELDS).join(', ')})`);
    parsed.push({ key, desc });
  }
  return parsed;
}
const MODEL_SORT = parseModelSort(cfg.model_sort);
// Sort a model list per MODEL_SORT (default: id ascending — the pre-existing behavior).
function sortModels(rows, sortSpec) {
  const spec = sortSpec || MODEL_SORT;
  const list = rows.slice();
  if (!spec) {
    list.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    return list;
  }
  const cmp = (a, b) => {
    for (const { key, desc } of spec) {
      const av = a[key]; const bv = b[key];
      if (av !== bv) {
        const lt = typeof av === 'string' ? av < bv : av < bv;
        return desc ? (lt ? 1 : -1) : (lt ? -1 : 1);
      }
    }
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  };
  list.sort(cmp);
  return list;
}

const OPENCODE_SOLO = cfg.targets.opencode_solo !== undefined ? !!cfg.targets.opencode_solo : true;
const OPENCODE_ROUTER = !!cfg.targets.opencode_router;
const OPENCODE_REST = !!cfg.targets.opencode_rest;
const KILO_SOLO = cfg.targets.kilo_solo !== undefined ? !!cfg.targets.kilo_solo : true;
const KILO_ROUTER = !!cfg.targets.kilo_router;
const KILO_REST = !!cfg.targets.kilo_rest;
const KILO_COPY_OPENCODE_FULL_PROVIDER_BLOCK = !!cfg.targets.kilo_copy_opencode_full_provider_block;
const T3_SOLO = cfg.targets.t3_solo !== undefined ? !!cfg.targets.t3_solo : true;
const T3_ROUTER = !!cfg.targets.t3_router;
const T3_REST = !!cfg.targets.t3_rest;
const DSH_SOLO = cfg.targets.dsh_solo !== undefined ? !!cfg.targets.dsh_solo : true;
const DSH_ROUTER = !!cfg.targets.dsh_router;
const DSH_REST = !!cfg.targets.dsh_rest;
const PI_SOLO = cfg.targets.pi_solo !== undefined ? !!cfg.targets.pi_solo : true;
const PI_ROUTER = !!cfg.targets.pi_router;
const PI_REST = !!cfg.targets.pi_rest;
const ZCODE_SOLO = !!cfg.targets.zcode_solo;
const ZCODE_ROUTER = !!cfg.targets.zcode_router;
const ZCODE_REST = !!cfg.targets.zcode_rest;
const OPENCODEX_SOLO = cfg.targets.opencodex_solo !== undefined ? !!cfg.targets.opencodex_solo : true;
const OPENCODEX_ROUTER = !!cfg.targets.opencodex_router;
const OPENCODEX_REST = !!cfg.targets.opencodex_rest;

const runtimeModes = {
  hasFlags: false,
  router: false,
  rest: false,
  solo: false,
};

function normalizeHarnessName(name) {
  const n = String(name || '').toLowerCase();
  if (n === 'ocx' || n === 'opencodex') return 'opencodex';
  return n;
}

function isRouterActive(harnessId) {
  if (runtimeModes.hasFlags) return runtimeModes.router;
  const hid = normalizeHarnessName(harnessId);
  return !!cfg.targets[`${hid}_router`];
}

function isSoloActive(harnessId) {
  if (runtimeModes.hasFlags) return runtimeModes.solo;
  const hid = normalizeHarnessName(harnessId);
  if (hid === 'zcode') return !!cfg.targets.zcode_solo;
  return cfg.targets[`${hid}_solo`] !== undefined ? !!cfg.targets[`${hid}_solo`] : true;
}

function isRestActive(harnessId) {
  if (runtimeModes.hasFlags) return runtimeModes.rest;
  const hid = normalizeHarnessName(harnessId);
  return !!cfg.targets[`${hid}_rest`];
}

const HARNESS_SPEC = {
  opencode: { router: 'opencode', rest: 'opencoderest' },
  kilo: { router: 'kilo', rest: 'kilorest', pro: 'kilopro' },
  t3: { router: 't3models', rest: 't3rest' },
  dsh: { router: 'dsh', rest: 'dshrest' },
  pi: { router: 'pi', rest: 'pirest' },
  zcode: { router: 'zcode', rest: 'zcoderest' },
  opencodex: { router: 'opencodex', rest: 'opencodexrest' },
  ocx: { router: 'opencodex', rest: 'opencodexrest' },
};

function targetsForHarness(harnessId) {
  const hid = normalizeHarnessName(harnessId);
  const spec = HARNESS_SPEC[hid];
  if (!spec) return [];
  const t = [];
  if (isRouterActive(hid)) t.push(spec.router);

  let hasSolo = true;
  let hasRest = true;
  if (!runtimeModes.hasFlags) {
    try {
      if (fs.existsSync(PROVIDERS_CSV)) {
        const rows = readProvidersCsv();
        hasSolo = getSoloRows(rows).length > 0;
        hasRest = getRestRows(rows).length > 0;
      }
    } catch (e) {}
  }

  const soloEligible = isSoloActive(hid) && hasSolo;
  const restEligible = isRestActive(hid) && hasRest;

  if (soloEligible || restEligible) {
    t.push(spec.rest);
  }
  if (spec.pro && KILO_COPY_OPENCODE_FULL_PROVIDER_BLOCK && isRouterActive(hid)) t.push(spec.pro);
  return t;
}

const REMOVE_IF_FALSE_PROVIDER = cfg.cleanup_providers.remove_if_false_provider;
const REMOVE_IF_PROVIDER_DOESNT_EXIST = cfg.cleanup_providers.remove_if_provider_doesnt_exist;

const T3_ROUTER_DRIVERS = cfg.t3.router_drivers;
const T3_REST_PROVIDER_DRIVERS = cfg.t3.rest_provider_drivers;
const T3_SOLO_PROVIDER_DRIVERS = (cfg.t3 && cfg.t3.solo_provider_drivers) || cfg.t3.rest_provider_drivers;
const T3_DRIVER_STRATEGY = cfg.t3.driver_strategy;

// Uniform adapter getter — free-form strings, backward-compat for legacy dsh.router_apis/rest_apis, dedup + normalize.
function getAdapters(harness, side, providerName, idx, totalForProvider) {
  // harness: 'opencode'|'kilo'|'pi'|'zcode'|'opencodex'|'dsh'; side: 'router'|'solo'|'rest'
  const blk = (cfg && cfg[harness] && typeof cfg[harness] === 'object') ? cfg[harness] : null;

  // 1) Per-provider adapter override
  if (providerName && blk && blk.provider_adapters && typeof blk.provider_adapters === 'object') {
    let custom = null;
    if (idx !== undefined && idx > 0) {
      custom = blk.provider_adapters[`${providerName}-${idx + 1}`];
    } else {
      custom = blk.provider_adapters[providerName] !== undefined
        ? blk.provider_adapters[providerName]
        : blk.provider_adapters[`${providerName}-1`];
    }
    let customArr = null;
    if (Array.isArray(custom) && custom.length) customArr = custom;
    else if (typeof custom === 'string' && custom.trim()) customArr = [custom.trim()];
    if (customArr && customArr.length) {
      const seen = new Set(); const out = [];
      for (const v of customArr) {
        const s = typeof v === 'string' ? v.trim() : '';
        if (!s || seen.has(s)) continue;
        const simp = simplifyName(s);
        if (!simp || seen.has('simp:' + simp)) continue;
        seen.add(s); seen.add('simp:' + simp); out.push(s);
      }
      if (out.length) return out;
    }
  }

  // 2) Harness side adapters (router, solo, or rest)
  const want = `${side}_adapters`;
  const legacyMap = { dsh: { router: 'router_apis', rest: 'rest_apis', solo: 'rest_apis' } };
  let arr = null;
  if (blk && Array.isArray(blk[want]) && blk[want].length) arr = blk[want];
  else if (side === 'solo' && blk && Array.isArray(blk.rest_adapters) && blk.rest_adapters.length) arr = blk.rest_adapters;
  else if (blk && legacyMap[harness] && Array.isArray(blk[legacyMap[harness][side]])) arr = blk[legacyMap[harness][side]];
  else {
    const def = DEFAULTS[harness] && Array.isArray(DEFAULTS[harness][want]) ? DEFAULTS[harness][want] : null;
    arr = def || [];
  }
  // normalize: non-empty trimmed strings, dedup preserving order (by raw and simplified form —
  // two adapters that simplify to the same key would collide, so the later one is skipped)
  const seen = new Set(); const out = [];
  for (const v of (arr || [])) {
    const s = typeof v === 'string' ? v.trim() : '';
    if (!s || seen.has(s)) continue;
    const simp = simplifyName(s);
    if (!simp || seen.has('simp:' + simp)) {
      if (simp) console.warn(`[warn] adapter "${s}" simplifies to "${simp}" which is already in use; skipping it.`);
      continue;
    }
    seen.add(s); seen.add('simp:' + simp); out.push(s);
  }
  // if empty after normalize, fall back to DEFAULTS for that harness/side
  if (!out.length) {
    const def = DEFAULTS[harness] && Array.isArray(DEFAULTS[harness][want]) ? DEFAULTS[harness][want] : [];
    for (const v of def) { const s = String(v).trim(); if (s && !seen.has(s)) { seen.add(s); out.push(s); } }
  }
  return out;
}
// simplified-adapter suffix: only when adapters.length > 1
function adapterSuffix(adapter, adapters) { return (adapters && adapters.length > 1) ? '-' + simplifyName(adapter) : ''; }
// instance part for duplicate provider rows: first stays bare, second+ -> -2, -3...
function instancePart(idx, totalForProvider) { return (totalForProvider <= 1 || idx === 0) ? '' : `-${idx + 1}`; }
// Managed router keys for a provider: `c-<simplified router>[-<simplified adapter>]` (no instance part).
function routerKeyBase(routerName) { return PREFIX + simplifyName(routerName); }

// ---------- router & solo provider detection ----------
function providerTypeOf(r) {
  if (!r) return 'rest';
  const t = (r.type || '').trim().toLowerCase();
  if (t === 'router') return 'router';
  if (t === 'solo') return 'solo';
  if (t === 'rest') return 'rest';
  const desc = (r.description || '').trim();
  if (desc === 'Router' || desc.toLowerCase() === 'router') return 'router';
  if (desc.toLowerCase() === 'solo') return 'solo';
  return 'rest';
}

function isRouterRow(r) {
  return providerTypeOf(r) === 'router';
}

function isSoloRow(r) {
  return providerTypeOf(r) === 'solo';
}

function isRestRow(r) {
  return providerTypeOf(r) === 'rest';
}

function getRouterRow(rows) {
  if (!rows || !rows.length) return null;
  const routers = rows.filter(isRouterRow);
  if (routers.length > 1) {
    console.error('[error] Multiple providers have description "Router": ' +
      routers.map((r) => r.provider).join(', ') +
      '. Keeping "' + routers[0].provider + '" as the Router and ignoring the rest.');
  }
  return routers[0] || null;
}

function getSoloRows(rows) {
  if (!rows || !rows.length) return [];
  return rows.filter(isSoloRow);
}

function getRestRows(rows) {
  if (!rows || !rows.length) return [];
  return rows.filter(isRestRow);
}

function requireRouterRow(rows) {
  const r = getRouterRow(rows);
  if (!r) throw new Error('No provider with description "Router" found in ' + PROVIDERS_CSV);
  return r;
}

function routerNameOf(rows) {
  const r = getRouterRow(rows);
  return r ? r.provider : null;
}

// ---------- first-run setup ----------
function isInteractive() {
  // OMNILIST_FORCE_SETUP=1 forces the setup prompt even on a non-TTY stdin
  // (used by the test-suite to exercise the interactive bootstrap).
  if (process.env.OMNILIST_FORCE_SETUP === '1') return true;
  try { return Boolean(process.stdin.isTTY); } catch (e) { return false; }
}

// A line reader over stdin that works for both a TTY (lines arrive as the user
// types) and piped input (all lines arrive in one burst, then EOF). readline's
// one-shot `question()` can't be chained on piped input — the whole buffer is
// consumed and the interface auto-closes before later questions are registered —
// so we buffer 'line' events into a queue and hand them out on demand.
//
// Resize safety: the interface is created with `terminal: false` and NO
// `output` stream, so readline installs no prompt-redraw handlers. Prompts are
// printed manually via stdout. Resizing the Windows console mid-question is
// therefore a harmless no-op instead of corrupting or aborting the prompt.
function makeLineReader() {
  const rl = readline.createInterface({ input: process.stdin, terminal: false });
  const queue = [];    // lines received but not yet requested
  const waiters = [];  // nextLine() calls waiting for the next line
  let closed = false;
  rl.on('line', (line) => {
    if (waiters.length) waiters.shift()(line);
    else queue.push(line);
  });
  rl.on('close', () => {
    closed = true;
    while (waiters.length) waiters.shift()(null); // EOF -> null
  });
  return {
    // Resolve with the next line (or null at EOF). Prompts are printed by the
    // caller so a terminal resize can never tear down an active readline prompt.
    nextLine() {
      return new Promise((resolve) => {
        if (queue.length) resolve(queue.shift());
        else if (closed) resolve(null);
        else waiters.push(resolve);
      });
    },
    close() { rl.close(); },
  };
}

// On a fresh install providers.csv doesn't exist (or has no Router row). Prompt
// the user for the provider configuration. If providers.csv has no rows at all,
// ask what kind of provider we are adding (Router or Solo).
// Returns the created provider name, or null when already configured.
async function ensureRouterProvider() {
  const rows = readProvidersCsv();
  if (getRouterRow(rows)) return null; // already configured

  // If there are already solo providers configured and this run doesn't strictly need a router row,
  // we can skip prompting for a router.
  if (rows.length > 0 && getSoloRows(rows).length > 0) {
    return null;
  }

  if (!isInteractive()) {
    // Cannot prompt (piped/no stdin). Give a clear error instead of hanging.
    throw new Error('No provider with description "Router" found in ' + PROVIDERS_CSV +
      '. Run from an interactive terminal to set one up, or edit providers.csv ' +
      'manually (a row whose description is exactly "Router").');
  }

  const reader = makeLineReader();
  const say = (s) => { try { process.stdout.write(s + '\n'); } catch (e) { /* ignore */ } };
  // Ask one question. Returns the trimmed answer, `defaultValue` on an empty
  // line, `defaultValue` on EOF when one is given, and throws on EOF otherwise
  // (so piped input that runs dry aborts instead of looping forever).
  const q = async (question, defaultValue) => {
    const hint = (defaultValue !== undefined && defaultValue !== null && defaultValue !== '')
      ? ' [' + defaultValue + ']' : '';
    try { process.stdout.write(question + hint + ': '); } catch (e) { /* ignore */ }
    const raw = await reader.nextLine();
    if (raw === null || raw === undefined) {
      if (defaultValue !== undefined) return defaultValue;
      throw new Error('Aborted: no input received.');
    }
    const trimmed = raw.trim();
    if (trimmed === '' && defaultValue !== undefined) return defaultValue;
    return trimmed;
  };
  // Validated question with an optional example line and default. Invalid
  // answers re-ask with a hint instead of aborting the whole setup.
  const ask = async (question, opts) => {
    opts = opts || {};
    for (;;) {
      const answer = await q(question + (opts.example ? '\n  e.g. ' + opts.example : ''), opts.def);
      const err = opts.validate ? opts.validate(answer) : null;
      if (!err) return answer;
      say('  ' + err + " Let's try again.");
    }
  };
  const needUrl = (v) => (/^https?:\/\//i.test(v || '')
    ? null : "That doesn't look like a URL — it should start with http:// or https://.");
  const needKey = (v) => ((v || '').length ? null : "API key can't be empty.");
  const needName = (v) => {
    if (!(v || '')) return "Name can't be empty.";
    if (/[,]/.test(v)) return "Names can't contain commas (providers.csv is comma-separated).";
    return null;
  };
  // Numbered choice, Claude-style: one question, examples, Enter for default.
  // Returns 'router', 'solo', or { url } when a URL is pasted directly
  // (kept so piped/automated answers starting with a URL keep working).
  const askProviderType = async () => {
    say('');
    say('  What are we connecting?');
    say('');
    say('    1) Router — one gateway for many models (recommended)');
    say('       e.g. OmniRoute, NineRouter, AgentRouter');
    say('    2) Solo — a single provider, direct');
    say('       e.g. OpenRouter, DeepSeek, Groq');
    say('');
    for (;;) {
      const answer = (await q('  Choice', '1')) || '1';
      const v = answer.trim().toLowerCase();
      if (v === '' || v === '1' || v === '1)' || v === 'router') return 'router';
      if (v === '2' || v === '2)' || v === 'solo') return 'solo';
      if (/^https?:\/\//i.test(v)) return { url: answer.trim() };
      say('  Please enter 1 for Router or 2 for Solo.');
    }
  };

  try {
    let providerName, baseUrl, apiKey, type, desc;

    // If providers.csv has no rows at all, ask what kind of provider to add
    if (rows.length === 0) {
      say('');
      say('  No providers yet — setup takes about 30 seconds.');
      const picked = await askProviderType();

      if (picked && picked.url) {
        // Direct URL entered (e.g. from automated test inputs)
        baseUrl = picked.url;
        apiKey = await ask('  Router API key', { validate: needKey });
        providerName = await ask('  Provider name', { def: 'omniroute', validate: needName });
        type = 'router';
        desc = 'Router';
      } else if (picked === 'solo') {
        providerName = await ask('  Provider name', { example: 'deepseek', def: 'deepseek', validate: needName });
        baseUrl = await ask('  Base URL', { example: 'https://api.deepseek.com/v1', validate: needUrl });
        apiKey = await ask('  API key', { validate: needKey });
        type = 'solo';
        desc = 'Solo';
      } else {
        baseUrl = await ask('  Router base URL', { example: 'http://localhost:20128/v1 (OmniRoute)', validate: needUrl });
        apiKey = await ask('  Router API key', { validate: needKey });
        providerName = await ask('  Provider name', { example: 'omniroute, ninerouter, agentrouter', def: 'omniroute', validate: needName });
        type = 'router';
        desc = 'Router';
      }
    } else {
      say('');
      say('  No Router yet — just the gateway details.');
      baseUrl = await ask('  Router base URL', { example: 'http://localhost:20128/v1 (OmniRoute)', validate: needUrl });
      apiKey = await ask('  Router API key', { validate: needKey });
      providerName = await ask('  Provider name', { example: 'omniroute, ninerouter, agentrouter', def: 'omniroute', validate: needName });
      type = 'router';
      desc = 'Router';
    }

    // Confirm before writing (Enter = yes; piped EOF also yields the default).
    say('');
    say('  Ready to save: ' + desc + ' "' + providerName + '"  →  ' + baseUrl);
    const ok = ((await q('  Save', 'Y')) || '').trim().toLowerCase();
    if (ok !== 'y' && ok !== 'yes') throw new Error('Setup cancelled — nothing was written.');

    let existing = '';
    if (fs.existsSync(PROVIDERS_CSV)) {
      existing = fs.readFileSync(PROVIDERS_CSV, 'utf8').replace(/\r\n/g, '\n').replace(/\n+$/, '');
    }
    const hasContent = existing.trim().length > 0;
    const hasHeader = /^\s*provider\s*,/.test(existing);
    const existingHasType = hasHeader && /,\s*type\s*,/i.test(existing.split('\n')[0]);
    const header = 'provider,base_url,api_key,type,description';
    const line = (!hasContent || existingHasType)
      ? providerName + ',' + baseUrl + ',' + apiKey + ',' + type + ',' + desc
      : providerName + ',' + baseUrl + ',' + apiKey + ',' + desc;
    fs.mkdirSync(path.dirname(PROVIDERS_CSV), { recursive: true });
    let out;
    if (!hasContent) {
      out = header + '\n' + line + '\n';
    } else if (hasHeader) {
      out = existing + '\n' + line + '\n';
    } else {
      out = header + '\n' + existing + '\n' + line + '\n';
    }
    fs.writeFileSync(PROVIDERS_CSV, out, 'utf8');

    console.log('\n' + (hasContent ? 'Added' : 'Created') +
      ' ' + desc + ' provider "' + providerName + '" in ' + PROVIDERS_CSV + '.\n');
    return providerName;
  } finally {
    reader.close();
  }
}

// ---------- helpers ----------
// Read providers.csv into an array of row objects (skips the header).
function readProvidersCsv(file) {
  const p = file || PROVIDERS_CSV;
  if (!fs.existsSync(p)) return [];
  const rawLines = fs.readFileSync(p, 'utf8').split('\n');
  const headerIdx = rawLines.findIndex((l) => {
    const t = l.trim();
    return t && !t.startsWith('#') && !t.startsWith('//');
  });
  if (headerIdx === -1) return [];
  const headers = rawLines[headerIdx].split(',').map((h) => h.trim());
  return rawLines.slice(headerIdx + 1).map((line) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith('//')) return null;
    const vals = line.split(',');
    const row = {};
    headers.forEach((h, i) => { row[h] = (vals[i] || '').trim(); });
    if (!row.type) row.type = providerTypeOf(row);
    return row;
  }).filter((r) => r && r.provider);
}

// Read models-filtered.csv (header: id,input_context,output_context,vision,reasoning,tool)
// into an array of { id, in, out, vision, reasoning, tool }.
function readModelsCsv(file) {
  const p = file || MODELS_CSV;
  if (!fs.existsSync(p)) return [];
  return fs.readFileSync(p, 'utf8')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
    .map((l) => l.split(','))
    .filter((parts) => parts[0] && parts[0] !== 'id') // skip header
    .map((parts) => ({
      id: parts[0],
      in: parseInt(parts[1] || '0', 10),
      out: parseInt(parts[2] || '0', 10),
      vision: parts[3] || -1,
      reasoning: parts[4] || -1,
      tool: parts[5] || -1,
    }));
}

function csvRowsToText(rows) {
  const lines = ['id,input_context,output_context,vision,reasoning,tool'];
  for (const r of rows) lines.push(`${r.id},${r.in},${r.out},${r.vision},${r.reasoning},${r.tool}`);
  return lines.join('\n') + '\n';
}

// Merge custom_models into a model list so custom entries ALWAYS appear in the
// result, even when a filter (model_filters / harness_filters / keep-only)
// would otherwise exclude them. On an id collision with a fetched model, the
// custom entry is authoritative and replaces the fetched copy.
function mergeCustomModels(rows, providerName) {
  const customs = (CUSTOM_MODELS || []).filter((c) => {
    if (!c.provider || c.provider === 'all' || c.provider === '') return true;
    if (!providerName) return false;
    return simplifyName(c.provider) === simplifyName(providerName);
  });
  const out = rows.filter((r) => !customs.some((c) => c.id === r.id));
  for (const c of customs) {
    out.push({
      id: c.id,
      in: c.in || 0,
      out: c.out || 0,
      vision: c.vision !== undefined ? c.vision : 1,
      reasoning: c.reasoning !== undefined ? c.reasoning : 1,
      tool: c.tool !== undefined ? c.tool : 1,
    });
  }
  return out;
}

function harnessModelsPath(harnessId) {
  const template = (cfg.paths && cfg.paths.harness_models_file) || 'data/models-<harness>.csv';
  const name = template.replace(/<harness>/g, harnessId);
  return resolveCatalogPath(name) || path.join(path.dirname(MODELS_CSV), `models-${harnessId}.csv`);
}

// Harnesses specifically targeted by harness_filters entries carrying a
// "->h1,h2" suffix. Entries without "->" apply to all harnesses and are not
// "configured" — no dedicated CSV is written for them under 'configured' mode.
// Computed lazily: normalizeHarnessId's alias table is defined further down.
let _configuredPreviewHarnesses = null;
function configuredPreviewHarnesses() {
  if (!_configuredPreviewHarnesses) {
    _configuredPreviewHarnesses = new Set(
      HARNESS_FILTERS_RAW
        .map((e) => parseHarnessFilterEntry(e))
        .filter((e) => e.targets)
        .flatMap((e) => [...e.targets])
    );
  }
  return _configuredPreviewHarnesses;
}

// Per-harness model list CSVs are governed by cfg.show_harness_model_list:
//   "raw"        -> only harnesses listed in raw_catalog_harnesses get a CSV
//   "all"        -> every harness that syncs writes a CSV
//   "configured" -> only harnesses specifically targeted by harness_filters
//                   ("<rule>->t3,dsh"); rules without "->" target all harnesses
//                   and don't make a harness "configured"
//   "none"       -> no CSVs at all
function previewAllowed(harnessId) {
  if (HARNESS_PREVIEWS_MODE === 'all') return true;
  if (HARNESS_PREVIEWS_MODE === 'none') return false;
  const norm = normalizeHarnessId(harnessId);
  if (HARNESS_PREVIEWS_MODE === 'configured') return configuredPreviewHarnesses().has(norm);
  return RAW_CATALOG.has(norm);
}

const writtenPreviews = new Set();
function writeHarnessPreview(harnessId, rows) {
  if (!previewAllowed(harnessId)) return;
  const norm = normalizeHarnessId(harnessId);
  if (writtenPreviews.has(norm)) return;
  writtenPreviews.add(norm);
  const p = harnessModelsPath(norm);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, csvRowsToText(rows), 'utf8');
  console.log(`Wrote ${norm} preview to ${p}`);
}

// Delete per-harness model list CSVs that shouldn't exist under the current
// show_harness_model_list mode — e.g. a harness no longer in raw_catalog_harnesses,
// no longer targeted by harness_filters, or previews disabled entirely. Only known
// harness ids are touched, so models-filtered.csv and models-all.csv are never deleted.
function cleanupHarnessPreviews() {
  if (HARNESS_PREVIEWS_MODE === 'all') return;
  for (const hid of VALID_HARNESSES) {
    if (previewAllowed(hid)) continue;
    const p = harnessModelsPath(hid);
    if (fs.existsSync(p)) {
      fs.unlinkSync(p);
      console.log(`Removed stale ${hid} preview (${p})`);
    }
  }
}

// Recursively find a field by name inside a router model object, so nested
// capability blocks such as { capabilities: { reasoning: true } } are detected.
function findField(obj, name, depth) {
  if (!obj || typeof obj !== 'object' || depth > 4) return undefined;
  if (Object.prototype.hasOwnProperty.call(obj, name)) return obj[name];
  for (const k of Object.keys(obj)) {
    const v = obj[k];
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      const found = findField(v, name, depth + 1);
      if (found !== undefined) return found;
    }
  }
  return undefined;
}

// Detect a capability value (1 / 0 / -1) from a router model object.
function detectCapability(m, key) {
  const candidates = (cfg.capabilities.fields[key] || []);
  // Vision: derive from modality arrays (image present = vision).
  if (key === 'vision') {
    const arr = m.input_modalities || (m.modalities && m.modalities.input);
    if (Array.isArray(arr)) return arr.includes('image') ? 1 : 0;
  }
  for (const f of candidates) {
    if (f === 'input_modalities') continue; // handled above
    const v = findField(m, f);
    if (v === true) return 1;
    if (v === false) return 0;
    if (Array.isArray(v)) return v.length > 0 ? 1 : 0;
    if (typeof v === 'string') {
      const s = v.trim().toLowerCase();
      if (s === 'true') return 1;
      if (s === 'false') return 0;
      if (s.length > 0) return 1; // e.g. reasoning_effort
    }
    if (v && typeof v === 'object') return 1; // e.g. reasoning config object
  }
  return -1;
}

// Map a models-filtered.csv capability cell (0/1/-1) to a boolean for config output.
function capBool(value, key) {
  if (value === 1 || value === '1' || value === true) return true;
  if (value === 0 || value === '0' || value === false) return false;
  const d = (cfg.capabilities.n_a_defaults || {})[key];
  return d !== undefined ? !!d : true;
}

function getJSON(url, headers) {
  const lib = url.startsWith('https') ? https : http;
  return new Promise((resolve, reject) => {
    // Connection: close so the socket is torn down after the response — a
    // keep-alive socket would keep the process alive after fetch finishes.
    lib.get(url, { headers: Object.assign({ Connection: 'close' }, headers || {}) }, (res) => {
      if (res.statusCode !== 200) {
        reject(new Error('HTTP ' + res.statusCode + ' for ' + url));
        res.resume();
        return;
      }
      let data = '';
      res.setEncoding('utf8');
      res.on('data', (c) => (data += c));
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(e); }
      });
    }).on('error', reject);
  });
}

// ---------- filter helpers ----------
// Each model_filters entry is one statement:  [prefix] <expression>
//
// Rule prefix (the action to take when the expression is TRUE):
//   "!expr"   -> EXCLUDE the model (block)
//   "expr"    -> INCLUDE the model (allow; does not touch non-matches)
//   "=expr"   -> same as "expr"
//   "==expr"  -> ONLY-INCLUDE: keep = expr(model); drop every model that doesn't match
//
// Rules run top-down and the LAST matching rule wins (later rules override earlier ones).
//
// Expression language (C-like boolean logic, zero dependencies):
//   "&&" and   "||" or   "!" not   parentheses group
//   relational (on $field values): "==" "!=" "<=" ">=" "<" ">"
//   precedence:  "!"  >  relational  >  "&&"  >  "||"
//
// Atoms:
//   id pattern (no "$") matches model.id; bare = EXACT, "*" = any run, "?" = one char:
//     "foo" exact   "foo*" prefix   "*foo" suffix   "*foo*" contains
//   "$field" reads a model property; a bare $field is truthy (value != 0):
//     $id  $in/$input_context  $out/$output_context  $vision  $reasoning  $tool
//   "$field == value" compares; values: numbers, true/false (=1/0), or strings.
//
// Examples:
//   "!kc*"                                block ids starting with kc
//   "!(!*kc*)"                            block ids that don't contain "kc"
//   "!(kc* && !*free)"                    block kc ids that don't end in "free"
//   "==*free"                             keep ONLY free models
//   "==$input_context >= 200000"          keep ONLY 200k+ context models
//   "==$vision == 1 || $reasoning == 1"   keep ONLY vision OR reasoning models
const FILTER_FIELDS = {
  id: 'id',
  in: 'in',
  input: 'in',
  input_context: 'in',
  out: 'out',
  output: 'out',
  output_context: 'out',
  vision: 'vision',
  reasoning: 'reasoning',
  tool: 'tool',
};

// Glob match for id patterns: "*" = any run, "?" = one char, bare = exact.
function matchPattern(pattern, text) {
  return globMatch(pattern.toLowerCase(), text.toLowerCase());
}

function globMatch(pat, str, pi = 0, si = 0) {
  while (pi < pat.length) {
    const c = pat[pi];
    if (c === '*') {
      while (pi < pat.length && pat[pi] === '*') pi++;
      if (pi === pat.length) return true;
      for (let k = si; k <= str.length; k++) {
        if (globMatch(pat, str, pi, k)) return true;
      }
      return false;
    }
    if (si >= str.length) return false;
    if (c === '?' || c === str[si]) { pi++; si++; }
    else return false;
  }
  return si === str.length;
}

// Compare a model field value against a relational operator + literal.
// true/false mean 1/0; numbers compare numerically; otherwise string compare.
function compareField(actual, op, value) {
  let expected = value.trim();
  if (/^(true|false)$/i.test(expected)) expected = expected.toLowerCase() === 'true' ? 1 : 0;
  else if (/^-?\d+(\.\d+)?$/.test(expected)) expected = parseFloat(expected);
  switch (op) {
    case '==': return actual == expected;
    case '!=': return actual != expected;
    case '>=': return actual >= expected;
    case '>':  return actual > expected;
    case '<=': return actual <= expected;
    case '<':  return actual < expected;
  }
  return false;
}

function fieldToKey(name) {
  const key = FILTER_FIELDS[name.toLowerCase()];
  if (key === undefined) throw new Error(`unknown model field "$${name}"`);
  return key;
}

// ---------- tokenizer ----------
const OP_CHARS = new Set('!()<>=|&'.split(''));
const TWO_CHAR_OPS = ['==', '!=', '<=', '>=', '&&', '||'];

function tokenize(src) {
  const tokens = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (/\s/.test(c)) { i++; continue; }
    const two = src.slice(i, i + 2);
    if (TWO_CHAR_OPS.includes(two)) { tokens.push(two); i += 2; continue; }
    if (OP_CHARS.has(c)) { tokens.push(c); i++; continue; }
    let j = i;
    while (j < src.length && !OP_CHARS.has(src[j]) && !/\s/.test(src[j])) j++;
    tokens.push(src.slice(i, j));
    i = j;
  }
  return tokens;
}

// ---------- recursive-descent parser ----------
function parseTokens(tokens) {
  let pos = 0;
  const peek = () => tokens[pos];
  const next = () => tokens[pos++];

  function parseOr() {
    let node = parseAnd();
    while (peek() === '||') { next(); node = { type: 'or', left: node, right: parseAnd() }; }
    return node;
  }
  function parseAnd() {
    let node = parseNot();
    while (peek() === '&&') { next(); node = { type: 'and', left: node, right: parseNot() }; }
    return node;
  }
  function parseNot() {
    if (peek() === '!') { next(); return { type: 'not', child: parseNot() }; }
    return parseCmp();
  }
  function parseCmp() {
    const operand = parsePrimary();
    const op = peek();
    if (op && ['==', '!=', '<=', '>=', '<', '>'].includes(op)) {
      if (operand.type !== 'prop') throw new Error(`cannot compare ${operand.type} with "${op}" (only $field values)`);
      next();
      const value = next();
      if (value === undefined) throw new Error(`expected a value after "${op}"`);
      if (value.startsWith('$')) throw new Error('cannot compare to another $field');
      return { type: 'cmp', field: operand.field, op, value };
    }
    return operand;
  }
  function parsePrimary() {
    const tok = peek();
    if (tok === undefined) throw new Error('unexpected end of expression');
    if (tok === '(') {
      next();
      const node = parseOr();
      if (next() !== ')') throw new Error('missing closing ")"');
      return { type: 'paren', child: node };
    }
    if (tok === ')' || tok === '!' || tok === '&&' || tok === '||'
        || tok === '=' || tok === '==' || tok === '!=' || tok === '<='
        || tok === '>=' || tok === '<' || tok === '>') {
      throw new Error(`unexpected token "${tok}"`);
    }
    next();
    if (tok.startsWith('$')) return { type: 'prop', field: fieldToKey(tok.slice(1)) };
    return { type: 'id', pattern: tok };
  }

  const root = parseOr();
  if (pos < tokens.length) throw new Error(`unexpected token "${tokens[pos]}"`);
  return root;
}

function compileExpr(node) {
  switch (node.type) {
    case 'or': {
      const l = compileExpr(node.left), r = compileExpr(node.right);
      return (m) => l(m) || r(m);
    }
    case 'and': {
      const l = compileExpr(node.left), r = compileExpr(node.right);
      return (m) => l(m) && r(m);
    }
    case 'not': {
      const c = compileExpr(node.child);
      return (m) => !c(m);
    }
    case 'id': return (m) => matchPattern(node.pattern, m.id);
    case 'prop': return (m) => m[node.field] != 0;
    case 'cmp': return (m) => compareField(m[node.field], node.op, node.value);
    case 'paren': {
      const c = compileExpr(node.child);
      return (m) => c(m);
    }
    default: throw new Error(`bad AST node "${node.type}"`);
  }
}

// Parse one filter statement:  [==|=|!] expression  ->  { action, fn }
function parseRule(rule) {
  let action = 'include';
  let src = rule;
  if (rule.startsWith('==')) { action = 'only'; src = rule.slice(2); }
  else if (rule.startsWith('=')) { src = rule.slice(1); }
  else if (rule.startsWith('!')) { action = 'block'; src = rule.slice(1); }
  if (!src.trim()) throw new Error('empty expression');
  return { action, fn: compileExpr(parseTokens(tokenize(src))) };
}

// Parse a model_filters entry: "expr" or "expr@provider1,provider2".
// If @targets is omitted (or @all), applies to every provider (providers: null).
// Lines prefixed with '#' or '//' are treated as comments/disabled.
function parseModelFilterEntry(entry) {
  if (typeof entry !== 'string') return { rule: '', providers: null, disabled: false };
  const raw = entry.trim();
  if (raw.startsWith('#') || raw.startsWith('//')) {
    return { rule: '', providers: null, disabled: true, raw };
  }
  const atIdx = raw.lastIndexOf('@');
  if (atIdx === -1) {
    return { rule: raw, providers: null, disabled: false };
  }
  const rulePart = raw.slice(0, atIdx).trim();
  const provPart = raw.slice(atIdx + 1).trim();
  if (!rulePart || !provPart || provPart.toLowerCase() === 'all') {
    return { rule: rulePart || raw, providers: null, disabled: false };
  }
  const provs = provPart.split(',').map((p) => simplifyName(p.trim())).filter(Boolean);
  if (!provs.length) return { rule: rulePart, providers: null, disabled: false };
  return { rule: rulePart, providers: new Set(provs), disabled: false };
}

// applyModelFilters returns the models that are KEPT.
// Top-down: LAST matching rule wins (later rules override earlier ones).
//   "!expr"  block    "expr"/"=expr"  include    "==expr"  only-include
// If providerName is given, rules targeted to other providers are skipped.
function applyModelFilters(candidates, filters, providerName = null) {
  if (!filters || !filters.length) return candidates;
  const targetSimp = providerName ? simplifyName(providerName) : null;
  const rules = [];
  for (const entry of filters) {
    const { rule, providers, disabled } = parseModelFilterEntry(entry);
    if (disabled || !rule) continue;
    if (targetSimp && providers && !providers.has(targetSimp)) {
      continue;
    }
    try {
      rules.push(parseRule(rule));
    } catch (e) {
      throw new Error(`bad model_filters rule "${rule}": ${e.message}`);
    }
  }
  return candidates.filter((model) => {
    let keep = true;
    for (const r of rules) {
      const match = r.fn(model);
      if (r.action === 'only') keep = match;
      else if (match) keep = (r.action === 'include');
    }
    return keep;
  });
}

// ---------- harness filter helpers (unified second-stage) ----------
const HARNESS_VARIANTS = {
  opencode: ['opencode', 'oc', 'open code', 'open-code', 'open_code', 'opc'],
  kilo:     ['kilo', 'kc', 'kilo code', 'kilocode', 'kilo-code', 'kilo_code'],
  dsh:      ['deepseek', 'deepseek_harness', 'deepseek harness', 'ds', 'deepseek-harness', 'dsh'],
  t3:       ['t3', 't3code', 't3-code', 't3_code', 't3 code'],
  pi:       ['pi', 'pi-agent', 'pi_agent', 'pi agent', 'piagent'],
  zcode:    ['zcode', 'z-code', 'z_code', 'z code', 'zc'],
  ocx:      ['ocx', 'opencodex', 'open codex', 'open-codex', 'open_codex', 'ox'],
};
function _canonKey(s) { return String(s).trim().toLowerCase().replace(/[^a-z0-9]+/g, ''); }
const HARNESS_ALIASES = (() => {
  const m = {};
  for (const [canon, variants] of Object.entries(HARNESS_VARIANTS)) for (const v of variants) m[_canonKey(v)] = canon;
  return m;
})();
const VALID_HARNESSES = new Set(Object.keys(HARNESS_VARIANTS));
function normalizeHarnessId(s) {
  const k = _canonKey(s);
  if (HARNESS_ALIASES[k] !== undefined) return HARNESS_ALIASES[k];
  return k;
}
function parseHarnessFilterEntry(entry) {
  if (typeof entry !== 'string') return { rule: '', targets: null, disabled: false };
  const raw = entry.trim();
  if (raw.startsWith('#') || raw.startsWith('//')) {
    return { rule: '', targets: null, disabled: true, raw };
  }
  const idx = raw.lastIndexOf('->');
  if (idx === -1) return { rule: raw, targets: null, disabled: false };
  const rulePart = raw.slice(0, idx).trim();
  const targetPart = raw.slice(idx + 2).trim();
  if (!targetPart) return { rule: raw, targets: null, disabled: false };
  const parts = targetPart.split(',').map((p) => normalizeHarnessId(p.trim())).filter(Boolean);
  const valid = parts.filter((p) => VALID_HARNESSES.has(p));
  if (!valid.length) return { rule: raw, targets: null, disabled: false };
  return { rule: rulePart, targets: new Set(valid), disabled: false };
}
// ---------- sync-time field overrides ----------
// Directive: "(field:value)" or "(field:value)->t3,dsh". field is a
// models-filtered.csv column name; value is the replacement. Entries without
// "->" apply to every harness. invalid_value_overrides only touch rows whose
// current value is invalid (<= 0, or empty for id); always_overrides touch
// every row. Later directives win on field collisions.
const OVERRIDE_FIELDS = {
  id: 'id',
  input_context: 'in',
  output_context: 'out',
  vision: 'vision',
  reasoning: 'reasoning',
  tool: 'tool',
};
function parseOverrideEntry(entry) {
  if (typeof entry !== 'string') return null;
  const { rule, targets } = parseHarnessFilterEntry(entry);
  const m = rule.trim().match(/^\(?([A-Za-z_]+)\s*:\s*([^)]+)\)?$/);
  if (!m) return null;
  const key = OVERRIDE_FIELDS[m[1].trim()];
  if (!key) return null;
  return { key, value: m[2].trim(), targets };
}
function getOverrideEntries(rawList, harnessId) {
  const norm = normalizeHarnessId(harnessId);
  return rawList
    .map((e) => parseOverrideEntry(e))
    .filter((e) => e && (!e.targets || e.targets.has(norm)));
}
function isInvalidFieldValue(key, value) {
  if (key === 'id') return value === undefined || value === null || String(value).trim() === '';
  return !(typeof value === 'number' && value > 0);
}
function coerceOverrideValue(key, raw) {
  if (key === 'id') return raw;
  const n = parseInt(raw, 10);
  return Number.isNaN(n) ? raw : n;
}
// Apply invalid_value_overrides + always_overrides for this harness to a model
// list. Returns new row objects; the CSV on disk is never rewritten.
function applyFieldOverrides(rows, harnessId) {
  const invalid = getOverrideEntries(INVALID_OVERRIDES_RAW, harnessId);
  const always = getOverrideEntries(ALWAYS_OVERRIDES_RAW, harnessId);
  if (!invalid.length && !always.length) return rows;
  return rows.map((r) => {
    let row = r;
    for (const e of invalid) {
      if (!isInvalidFieldValue(e.key, row[e.key])) continue;
      if (row === r) row = { ...r };
      row[e.key] = coerceOverrideValue(e.key, e.value);
    }
    for (const e of always) {
      if (row === r) row = { ...r };
      row[e.key] = coerceOverrideValue(e.key, e.value);
    }
    return row;
  });
}
function getHarnessFilters(harnessId) {
  const norm = normalizeHarnessId(harnessId);
  return HARNESS_FILTERS_RAW
    .map((e) => parseHarnessFilterEntry(e))
    .filter((e) => !e.disabled && (!e.targets || e.targets.has(norm)))
    .map((e) => e.rule)
    .filter((rule) => !parseTopNDirective(rule)); // top-N directives are handled separately
}
// ---------- top/bottom-N directives ----------
// "top100" / "bottom100" / "(top100)" / "( bottom50 )" — parens optional. Usable in
// model_filters (baked into models-filtered.csv) and harness_filters ("(top100)->t3,dsh"
// targets specific harnesses). Optional per-directive sort chain:
// "(top10:-input_context:-output_context)" — same field names/syntax as model_sort,
// colon-separated, leading '-' = descending; the N is taken from THAT order
// (first field is the primary key). Overrides model_sort for this directive only.
// The N is taken from the SORTED list: top = first N, bottom = last N.
// custom_models always survive and don't consume N slots.
function parseTopNDirective(rule) {
  if (typeof rule !== 'string') return null;
  const m = rule.trim().match(/^\(?(top|bottom)(\d+)((?::-[^)\s]+)*)\)?$/i);
  if (!m) return null;
  let sort = null;
  if (m[3]) {
    sort = parseModelSort(m[3].split(':').map((s) => s.trim()).filter(Boolean).join(','));
  }
  return { dir: m[1].toLowerCase(), n: parseInt(m[2], 10), sort };
}
// Last matching directive wins.
function getHarnessTopN(harnessId) {
  const norm = normalizeHarnessId(harnessId);
  let result = null;
  for (const entry of HARNESS_FILTERS_RAW) {
    const { rule, targets, disabled } = parseHarnessFilterEntry(entry);
    if (disabled || !rule) continue;
    const directive = parseTopNDirective(rule);
    if (!directive) continue;
    if (!targets || targets.has(norm)) result = directive;
  }
  return result;
}
// Apply a top/bottom-N rule to a model list (no rule -> unchanged). custom_models
// entries always survive and don't consume N slots; the result stays sorted (by the
// directive's own sort chain when present, else the global model_sort order).
function applyTopNDirective(rows, directive) {
  if (!directive || !directive.n) return rows;
  const customs = CUSTOM_MODELS || [];
  const customsInRows = rows.filter((r) => customs.some((c) => c.id === r.id));
  const fetched = rows.filter((r) => !customs.some((c) => c.id === r.id));
  const ordered = sortModels(fetched, directive.sort);
  const kept = directive.dir === 'top' ? ordered.slice(0, directive.n) : ordered.slice(-directive.n);
  return sortModels([...kept, ...customsInRows], directive.sort);
}
const RAW_CATALOG = new Set((RAW_CATALOG_RAW || []).map((s) => normalizeHarnessId(s)).filter((s) => VALID_HARNESSES.has(s)));

// ---------- DSH api helpers (free-form adapters; legacy helpers kept for cleanup of old keys) ----------
const DSH_API_SUFFIX = {
  'openai-completions': 'completions',
  'openai-responses': 'responses',
  'anthropic-messages': 'messages',
};
// Free-form adapters now; keep helpers for legacy cleanup of old single-underscore keys.
function dshSuffix(api) { return DSH_API_SUFFIX[api] || api; }

// Resolve the DSH model entry "input" field from cfg.dsh.model_inputs.
// Modes: 'hardcode' -> ['text','image']; 'vision' -> depends on model.vision;
// explicit array -> returned as-is.
function dshModelInputs(m) {
  const mode = (cfg.dsh && cfg.dsh.model_inputs) || 'hardcode';
  if (Array.isArray(mode)) return mode.slice();
  if (mode === 'vision') return (m.vision === 1 || m.vision === '1') ? ['text', 'image'] : ['text'];
  return ['text', 'image'];
}

// Parse a managed DSH key (current c- or legacy c_) into
// { provider, idx, suffix, legacy }. Simplified segments contain no '-', so c- keys
// split unambiguously: c-<provider>[-<N>][-<adapter>]. Legacy c_ keys (with __<adapter>
// or _<short suffix>) are parsed only so cleanup can recognize and prune them as stale.
function parseManagedDshKey(key) {
  if (typeof key !== 'string') return null;
  if (key.startsWith(PREFIX)) {
    const parts = key.slice(PREFIX.length).split('-');
    const provider = parts.shift();
    if (!provider) return null;
    let idx = null; let suffix = null;
    if (parts.length === 1) {
      if (/^\d+$/.test(parts[0])) idx = parseInt(parts[0], 10);
      else suffix = parts[0];
    } else if (parts.length >= 2) {
      if (/^\d+$/.test(parts[0])) idx = parseInt(parts[0], 10);
      suffix = parts.slice(/^\d+$/.test(parts[0]) ? 1 : 0).join('-');
    }
    return { provider, idx, suffix, legacy: false };
  }
  if (key.startsWith(LEGACY_PREFIX)) {
    let rest = key.slice(LEGACY_PREFIX.length);
    let adapterSuffix = null;
    const cut = rest.lastIndexOf('__');
    if (cut !== -1) { adapterSuffix = rest.slice(cut + 2); rest = rest.slice(0, cut); }
    let suffix = null;
    let api = null;
    for (const [k, v] of Object.entries(DSH_API_SUFFIX)) {
      if (rest.endsWith('_' + v)) { suffix = v; api = k; break; }
    }
    const withoutSuffix = suffix ? rest.slice(0, -(suffix.length + 1)) : rest;
    const parts = withoutSuffix.split('_');
    const last = parts[parts.length - 1];
    let idx = null;
    let provider;
    if (/^\d+$/.test(last) && parts.length > 1) {
      idx = parseInt(last, 10);
      provider = parts.slice(0, -1).join('_');
    } else {
      provider = withoutSuffix;
    }
    if (!provider) return null;
    return { provider, idx, suffix: adapterSuffix || suffix, api: adapterSuffix || api, legacy: true };
  }
  return null;
}

// Fetch catalog either from models-all.csv or live endpoint depending on harness
// raw_catalog_harnesses ON -> read models-all.csv (raw), fall back to live fetch if file missing.
// raw_catalog_harnesses OFF -> read models-filtered.csv (already model_filters + custom_models).
// opts.applyTopN === false skips the harness top/bottom-N directive — REST provider
// syncs opt out because their N applies to the per-provider prefix-filtered subset,
// not the global catalog (they call applyHarnessTopN on the subset instead).
async function getModelsForHarness(harnessId, minInput = 0, minOutput = 0, opts = {}) {
  const harnessFilters = getHarnessFilters(harnessId);
  const shouldFetchLive = RAW_CATALOG.has(normalizeHarnessId(harnessId));
  let base;
  if (shouldFetchLive && fs.existsSync(ALL_MODELS_CSV)) {
    base = readModelsCsv(ALL_MODELS_CSV);
  } else if (shouldFetchLive) {
    base = await fetchRawModels(0, 0);
  } else {
    base = readModelsCsv();
  }
  // Field overrides run before the min-context filters so a model whose invalid
  // input/output context was overridden still passes -mi/-mo checks. (The live
  // fetch branch also benefits: fetchRawModels(0,0) keeps rows a later -mi/-mo
  // would have dropped before the override could repair them.)
  base = applyFieldOverrides(base, harnessId);
  if (minInput > 0) base = base.filter((m) => m.in >= minInput);
  if (minOutput > 0) base = base.filter((m) => m.out >= minOutput);
  // custom_models always survive harness_filters (re-added last, override collisions)
  let filtered = mergeCustomModels(applyModelFilters(base, harnessFilters));
  filtered = sortModels(filtered);
  if (opts.applyTopN !== false) filtered = applyTopNDirective(filtered, getHarnessTopN(harnessId));
  return filtered;
}
// Apply this harness's top/bottom-N rule to an already-narrowed model subset
// (e.g. one REST provider's prefix-filtered models).
function applyHarnessTopN(rows, harnessId) {
  return applyTopNDirective(rows, getHarnessTopN(harnessId));
}

// Full hardcoded model entry (used when follow_hardcoded_model_template is on):
// every capability flag is true, modalities + variants are always present, and
// only the context/output limits come from models-filtered.csv.
function templateModelEntry(displayName, ctxIn, ctxOut) {
  return {
    name: displayName,
    attachment: true,
    reasoning: true,
    tool_call: true,
    temperature: true,
    limit: { context: ctxIn || 0, output: ctxOut || 0 },
    modalities: { input: ['text', 'image', 'pdf'], output: ['text'] },
    variants: { max: { thinking: { type: 'enabled', budgetTokens: 100000 } } },
  };
}

function buildModelEntry(id, ctxIn, ctxOut, caps) {
  const vision = FOLLOW_HARDCODED_MODEL_TEMPLATE ? 'true' : capBool(caps.vision, 'vision');
  const reasoning = FOLLOW_HARDCODED_MODEL_TEMPLATE ? 'true' : capBool(caps.reasoning, 'reasoning');
  const tool = FOLLOW_HARDCODED_MODEL_TEMPLATE ? 'true' : capBool(caps.tool, 'tool');
  const limit = `          "limit": { "context": ${ctxIn}, "output": ${ctxOut} },`;
  const lines = [
    `        "${id}": {`,
    `          "name": "${id} (custom)",`,
    `          "attachment" : ${vision},`,
    `          "reasoning" : ${reasoning},`,
    `          "tool_call" : ${tool},`,
    `          "temperature": true,`,
    limit,
  ];
  if (FOLLOW_HARDCODED_MODEL_TEMPLATE) {
    lines.push(
      `          "modalities":{`,
      `            "input": ["text", "image", "pdf"],`,
      `            "output": ["text"]`,
      `          },`,
      ``,
      `          "variants":{`,
      `            "max": {`,
      `              "thinking":{`,
      `                "type": "enabled",`,
      `                "budgetTokens" : 100000`,
      `              }`,
      `            }`,
      `          }`,
    );
  }
  lines.push(`        }`);
  return lines.join('\n');
}

// Build codex launchArgs for a given provider (values from providers.csv).
// Format preserved exactly (double spaces between -c segments):
//   -c model_provider=<p>  -c model_providers.<p>.name=<n>  -c model_providers.<p>.base_url=<url>  -c model_providers.<p>.api_key=<key>
function buildLaunchArgs(provider, baseUrl, apiKey, displayName) {
  const name = displayName || provider;
  return `-c model_provider=${provider}  -c model_providers.${provider}.name=${name}  -c model_providers.${provider}.base_url=${baseUrl}  -c model_providers.${provider}.api_key=${apiKey}`;
}

// Build a T3 provider instance for a given driver according to its strategy.
//   claudeAgent -> environment (ANTHROPIC_*)  |  codex -> config.launchArgs
function buildT3DriverInstance(driverName, providerName, displayName, baseUrl, apiKey, customModels, enabled) {
  const strategy = T3_DRIVER_STRATEGY[driverName] || T3_DRIVER_STRATEGY.claudeAgent;
  const inst = {
    driver: driverName,
    displayName: displayName,
    enabled: enabled,
    config: { customModels: customModels },
  };
  if (strategy.mode === 'launchArgs') {
    inst.config.launchArgs = buildLaunchArgs(providerName, baseUrl, apiKey, displayName);
  } else {
    inst.environment = [
      { name: strategy.apiKey, value: apiKey, sensitive: false },
      { name: strategy.baseUrl, value: baseUrl, sensitive: false },
    ];
  }
  return inst;
}

// Raw dedup'd catalog from the Router (before model_filters / custom_models).
async function fetchRawModels(minInput = 0, minOutput = 0) {
  const rows = readProvidersCsv();
  const router = requireRouterRow(rows);
  const base = (router.base_url || '').trim().replace(/\/+$/, '');
  const endpoint = (MODELS_ENDPOINT || '').trim();
  const modelsUrl = endpoint || (base.toLowerCase().endsWith('/models') ? base : base + '/models');
  if (!router.api_key) {
    throw new Error('Router provider "' + router.provider + '" has no api_key in ' + PROVIDERS_CSV);
  }
  console.log('Fetching models from: ' + modelsUrl);
  const json = await getJSON(modelsUrl, { Authorization: 'Bearer ' + router.api_key });
  const seen = new Set();
  const results = [];
  for (const m of (json.data || [])) {
    let id = m.id;
    if (!id) continue;
    if (m.parent != null) continue;
    if (id.includes('__provider_')) {
      const idx = id.indexOf('__provider_');
      const name = id.substring(0, idx);
      const prov = id.substring(idx + '__provider_'.length);
      id = prov + '/' + name;
    } else if (/compatible/.test(id) && m.owned_by) {
      // Replace the "compatible" path segment with <owned_by>, keep any
      // prefix before it and the model name after it.
      // Examples:
      //   openai-compatible-chat-8f526158/agnes-2.5-pro
      //     -> nara/agnes-2.5-pro
      //   no-think/openai-compatible-chat-26e54282/claude-opus-4-6
      //     -> no-think/ocz/claude-opus-4-6
      const match = id.match(/^(.+?\/)?[^/]*compatible[^/]+\/(.+)$/);
      if (match) {
        const prefix = match[1] ? match[1].replace(/\/$/, '') : '';
        const owned = m.owned_by.trim();
        const modelName = match[2].trim();
        id = prefix ? prefix + '/' + owned + '/' + modelName : owned + '/' + modelName;
      }
    }
    if (seen.has(id)) continue;
    seen.add(id);
    const ctxIn = (m.max_input_tokens != null) ? m.max_input_tokens : (m.context_length != null ? m.context_length : 0);
    const ctxOut = (m.max_output_tokens != null) ? m.max_output_tokens : 0;
    if (minInput > 0 && ctxIn < minInput) continue;
    if (minOutput > 0 && ctxOut < minOutput) continue;
    results.push({
      id,
      in: ctxIn,
      out: ctxOut,
      vision: detectCapability(m, 'vision'),
      reasoning: detectCapability(m, 'reasoning'),
      tool: detectCapability(m, 'tool'),
    });
  }
  return results;
}

// Raw dedup'd catalog from a Solo provider (calls row.base_url + '/models').
async function fetchSoloRawModels(row, minInput = 0, minOutput = 0) {
  const base = (row.base_url || '').trim().replace(/\/+$/, '');
  const modelsUrl = base.toLowerCase().endsWith('/models') ? base : base + '/models';
  if (!row.api_key) {
    throw new Error(`Solo provider "${row.provider}" has no api_key in ${PROVIDERS_CSV}`);
  }
  console.log(`[solo:${row.provider}] Fetching models from: ${modelsUrl}`);
  const json = await getJSON(modelsUrl, { Authorization: 'Bearer ' + row.api_key });
  const rawList = Array.isArray(json) ? json : (json.data || json.models || []);
  const seen = new Set();
  const results = [];
  for (const m of rawList) {
    let id = m.id || m.name;
    if (!id) continue;
    if (m.parent != null) continue;
    if (seen.has(id)) continue;
    seen.add(id);
    const ctxIn = (m.max_input_tokens != null) ? m.max_input_tokens : (m.context_length != null ? m.context_length : (m.context_window != null ? m.context_window : 0));
    const ctxOut = (m.max_output_tokens != null) ? m.max_output_tokens : (m.max_tokens != null ? m.max_tokens : 0);
    if (minInput > 0 && ctxIn < minInput) continue;
    if (minOutput > 0 && ctxOut < minOutput) continue;
    results.push({
      id,
      in: ctxIn,
      out: ctxOut,
      vision: detectCapability(m, 'vision'),
      reasoning: detectCapability(m, 'reasoning'),
      tool: detectCapability(m, 'tool'),
    });
  }
  return results;
}

async function fetchSoloModels(row, minInput = 0, minOutput = 0) {
  try {
    const raw = await fetchSoloRawModels(row, minInput, minOutput);
    const sortedRaw = raw.slice().sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    const allFile = soloAllCsvPath(row.provider);
    fs.mkdirSync(path.dirname(allFile), { recursive: true });
    fs.writeFileSync(allFile, csvRowsToText(sortedRaw), 'utf8');
    console.log(`[solo:${row.provider}] Wrote raw catalog to ${allFile}`);

    // Filter rules targeted to this provider or all
    const exprRules = (MODEL_FILTERS || []).filter((rule) => {
      const parsed = parseModelFilterEntry(rule);
      return !parsed.disabled && !parseTopNDirective(parsed.rule);
    });
    let directive = null;
    for (const rule of MODEL_FILTERS || []) {
      const { rule: rRule, providers, disabled } = parseModelFilterEntry(rule);
      if (disabled) continue;
      const d = parseTopNDirective(rRule);
      if (d && (!providers || providers.has(simplifyName(row.provider)))) {
        directive = d;
      }
    }
    let filtered = applyModelFilters(sortedRaw, exprRules, row.provider);
    filtered = mergeCustomModels(filtered, row.provider);
    filtered = applyTopNDirective(sortModels(filtered), directive);
    const filteredFile = soloFilteredCsvPath(row.provider);
    fs.mkdirSync(path.dirname(filteredFile), { recursive: true });
    fs.writeFileSync(filteredFile, csvRowsToText(filtered), 'utf8');
    console.log(`[solo:${row.provider}] Wrote ${filtered.length} models to ${filteredFile}`);
    return filtered.length;
  } catch (e) {
    console.error(`[solo:${row.provider}] Failed to fetch models: ${e.message}`);
    return 0;
  }
}

// ---------- fetchModels: fetch + build models-filtered.csv (DEFAULT target) ----------
// Each line written as:  model-id,context-input,context-output,vision,reasoning,tool
// Fetches the special "Router" provider's OpenAI-compatible {base_url}/models
// (or a full models_endpoint from config) using the api_key as a Bearer token.
// Also fetches any Solo providers marked in providers.csv.
// Writes:
//   models-all.csv — raw dedup'd catalog + custom_models (no model_filters)
//   models-filtered.csv     — model_filters applied on top of models-all.csv
//   models-all-<solo>.csv   — raw dedup'd catalog for solo provider
//   models-filtered-<solo>.csv — model_filters applied for solo provider
//
// Filters:
//   --min-input-context N : skip models with input context < N (0 = no filter)
//   --min-output-limit N   : skip models with output < N (0 = no filter)
async function fetchModels(minInput = 0, minOutput = 0) {
  const rows = readProvidersCsv();
  const router = getRouterRow(rows);
  const routerName = router ? router.provider : null;
  let raw = [];
  if (router) {
    raw = await fetchRawModels(minInput, minOutput);
  } else {
    console.log('No Router configured; skipping router catalog fetch.');
  }
  // custom_models are authoritative: they override any colliding fetched model
  // and are always present in every catalog file, regardless of filters.
  const rawWithCustom = mergeCustomModels(raw, routerName);

  // 1) raw catalog + custom_models -> models-all.csv (before model_filters)
  const sortedRaw = rawWithCustom.slice().sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  fs.mkdirSync(path.dirname(ALL_MODELS_CSV), { recursive: true });
  fs.writeFileSync(ALL_MODELS_CSV, csvRowsToText(sortedRaw), 'utf8');
  console.log('Wrote raw catalog to ' + ALL_MODELS_CSV);

  // 2) model_filters + top-N -> models-filtered.csv (custom_models re-added so they always appear).
  //    top-N directives are sliced off the SORTED list: top = first N, bottom = last N.
  const exprRules = (MODEL_FILTERS || []).filter((rule) => {
    const parsed = parseModelFilterEntry(rule);
    return !parsed.disabled && !parseTopNDirective(parsed.rule);
  });
  let directive = null;
  for (const rule of MODEL_FILTERS || []) {
    const { rule: rRule, providers, disabled } = parseModelFilterEntry(rule);
    if (disabled) continue;
    const d = parseTopNDirective(rRule);
    if (d && (!providers || (routerName && providers.has(simplifyName(routerName))))) {
      directive = d;
    }
  }
  let filtered = mergeCustomModels(applyModelFilters(sortedRaw, exprRules, routerName));
  filtered = applyTopNDirective(sortModels(filtered), directive);
  fs.mkdirSync(path.dirname(MODELS_CSV), { recursive: true });
  fs.writeFileSync(MODELS_CSV, csvRowsToText(filtered), 'utf8');

  // 3) Solo providers: fetch each solo provider's catalog independently
  const soloRows = getSoloRows(rows);
  for (const solo of soloRows) {
    await fetchSoloModels(solo, minInput, minOutput);
  }

  return filtered.length;
}

// ---------- syncModelBlock: update router models via markers (in a given file) ----------
function syncModelBlock(targetFile) {
  if (!fs.existsSync(MODELS_CSV)) {
    throw new Error('models-filtered.csv not found: ' + MODELS_CSV);
  }
  const ids = readModelsCsv();

  const block = ids.map((m, i) => {
    const entry = buildModelEntry(m.id, m.in, m.out, m);
    return i === ids.length - 1 ? entry : entry + ',';
  });

  const lines = fs.readFileSync(targetFile, 'utf8').split('\n');

  const out = [];
  let inModels = false;
  let inBlock = false;
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    // Detect the router "models" object opening
    if (!inModels && /"models"\s*:\s*\{/.test(line)) {
      inModels = true;
      out.push(line);
      i++;
      continue;
    }

    if (inModels && !inBlock) {
      if (/\/\/\s*start-here/.test(line)) {
        inBlock = true;
        out.push(line);
        out.push(...block);
        // skip old lines until end-here
        i++;
        while (i < lines.length) {
          const ll = lines[i];
          if (/\/\/\s*end-here/.test(ll)) {
            out.push(ll);
            inBlock = false;
            i++; // point at line after end-here (e.g. closing "}" of models)
            break;
          }
          i++;
        }
        continue;
      }
      out.push(line);
      i++;
      continue;
    }

    if (inModels && inBlock) {
      // safety: should not normally reach here
      if (/\/\/\s*end-here/.test(line)) {
        out.push(line);
        inBlock = false;
      }
      i++;
      continue;
    }

    out.push(line);
    i++;
  }

  const text = out.join('\n');
  // strip BOM if present to avoid duplication
  const clean = text.charCodeAt(0) === 0xFEFF ? text.slice(1) : text;
  fs.writeFileSync(targetFile, clean, 'utf8');
  return ids.length;
}

// ---------- syncT3Providers: write per-provider claudeAgent instances to t3 settings.json ----------
// Reads providers.csv and models (csv or live per harness_filters/raw_catalog_harnesses).
// Deletes all providerInstances keys starting with the managed prefix (current c- or legacy c_),
// then creates c-<simplified provider>-<n>-<simplified driver>.
async function syncT3Providers() {
  if (!fs.existsSync(PROVIDERS_CSV)) throw new Error('providers.csv not found: ' + PROVIDERS_CSV);

  const rows = readProvidersCsv();
  const routerName = routerNameOf(rows);
  const routerBase = routerName ? routerKeyBase(routerName) : null;
  const modelRows = await getModelsForHarness('t3', 0, 0, { applyTopN: false });
  writeHarnessPreview('t3', modelRows);

  const byProvider = {};
  for (const row of rows) {
    if (!byProvider[row.provider]) byProvider[row.provider] = [];
    byProvider[row.provider].push(row);
  }

  let settings = {};
  if (fs.existsSync(T3_SETTINGS_FILE)) {
    try { settings = JSON.parse(fs.readFileSync(T3_SETTINGS_FILE, 'utf8')); }
    catch (e) { throw new Error('Failed to parse ' + T3_SETTINGS_FILE + ': ' + e.message); }
  }
  if (!settings.providerInstances) settings.providerInstances = {};

  // Snapshot current enabled state BEFORE deleting, so we can restore it.
  const prevEnabled = {};
  for (const key of Object.keys(settings.providerInstances)) {
    if (isManagedKey(key) && !(routerBase && key.startsWith(routerBase + '-'))) {
      prevEnabled[key] = !!settings.providerInstances[key].enabled;
      delete settings.providerInstances[key];
    }
  }

  const activeRestDrivers = T3_REST_PROVIDER_DRIVERS.filter(e => e && typeof e === 'object' && e.driver);
  const activeSoloDrivers = (T3_SOLO_PROVIDER_DRIVERS || activeRestDrivers).filter(e => e && typeof e === 'object' && e.driver);

  let count = 0;
  let totalModels = 0;
  for (const [provider, keys] of Object.entries(byProvider)) {
    if (routerName && provider === routerName) continue;
    const isSolo = isSoloRow(keys[0]);
    if (isSolo && !isSoloActive('t3')) continue;
    if (!isSolo && !isRestActive('t3')) continue;
    let topNFiltered;
    if (isSolo) {
      const soloCsv = soloFilteredCsvPath(provider);
      const soloRows = fs.existsSync(soloCsv) ? readModelsCsv(soloCsv) : [];
      const filtered = getHarnessFilters('t3').length ? applyModelFilters(soloRows, getHarnessFilters('t3'), provider) : soloRows;
      topNFiltered = applyHarnessTopN(filtered, 't3');
    } else {
      const withPrefix = modelRows
        .filter((m) => m.id.startsWith(provider + '/'))
        .map((m) => ({ ...m, fullId: m.id }));
      const filtered = getHarnessFilters('t3').length ? applyModelFilters(withPrefix, getHarnessFilters('t3'), provider) : withPrefix;
      topNFiltered = applyHarnessTopN(filtered, 't3');
    }
    const providerModelsAll = [];
    for (const m of topNFiltered) {
      const name = isSolo ? m.id : m.id.slice(provider.length + 1);
      providerModelsAll.push(name);
      if (m.in >= 1000000) providerModelsAll.push(name + '[1m]');
    }
    keys.forEach((row, idx) => {
      let drivers = isSolo ? activeSoloDrivers : activeRestDrivers;
      if (cfg.t3 && cfg.t3.provider_drivers && typeof cfg.t3.provider_drivers === 'object') {
        let custom = null;
        if (keys.length > 1 && idx > 0) {
          custom = cfg.t3.provider_drivers[`${provider}-${idx + 1}`];
        } else {
          custom = cfg.t3.provider_drivers[provider] !== undefined
            ? cfg.t3.provider_drivers[provider]
            : cfg.t3.provider_drivers[`${provider}-1`];
        }
        if (custom) {
          if (Array.isArray(custom) && custom.length) {
            const filteredCustom = custom.filter(e => e && typeof e === 'object' && e.driver);
            if (filteredCustom.length) drivers = filteredCustom;
          } else if (typeof custom === 'string' && custom.trim()) {
            drivers = [{ driver: custom.trim(), '1m': false }];
          }
        }
      }
      if (drivers.length === 0) return;
      drivers.forEach((driverEntry, driverIdx) => {
        const driverName = driverEntry.driver;
        const supports1m = !!driverEntry['1m'];
        const providerModels = supports1m ? providerModelsAll : providerModelsAll.filter(m => !m.endsWith('[1m]'));
        const simp = simplifyName(provider);
        const driverSimp = simplifyName(driverName);
        const key = `${PREFIX}${simp}-${idx + 1}-${driverSimp}`;
        settings.providerInstances[key] = buildT3DriverInstance(
          driverName,
          provider,
          `${simp}-${idx + 1}`,
          row.base_url,
          row.api_key,
          providerModels,
          prevEnabled.hasOwnProperty(key) ? prevEnabled[key] : false
        );
        count++;
        totalModels += providerModels.length;
      });
    });
  }

  fs.mkdirSync(path.dirname(T3_SETTINGS_FILE), { recursive: true });
  fs.writeFileSync(T3_SETTINGS_FILE, JSON.stringify(settings, null, 2) + '\n', 'utf8');
  return { apis: count, models: totalModels };
}

// Controlled by: --clean / --noclean, default is true (CLEANUP_DEFAULT).
function cleanupStep(doCleanup) {
  if (!doCleanup) {
    console.log('cleanup skipped (--noclean)');
    return 0;
  }
  let removed = 0;
  if (fs.existsSync(T3_LOGS_DIR)) {
    const entries = fs.readdirSync(T3_LOGS_DIR, { withFileTypes: true });
    for (const entry of entries) {
      const full = path.join(T3_LOGS_DIR, entry.name);
      fs.rmSync(full, { recursive: true, force: true });
      removed++;
    }
  }
  if (removed > 0) {
    console.log(`Cleaned up ${removed} item(s) from ${T3_LOGS_DIR}`);
  }
  return removed;
}

// ---------- copyProviderBlockToKilo: copy provider{} block opencode -> kilo ----------
// Extracts the "provider": { ... } block from opencode.jsonc and replaces
// the "provider": { ... } block inside kilo.jsonc (rest of kilo untouched).
function extractProvider(text) {
  const lines = text.split('\n');
  let start = -1;
  let i = 0;
  for (; i < lines.length; i++) {
    if (/^\s*"provider"\s*:\s*\{/.test(lines[i])) { start = i; break; }
  }
  if (start === -1) return null;
  let depth = 0;
  let end = -1;
  for (let j = start; j < lines.length; j++) {
    for (const ch of lines[j]) {
      if (ch === '{') depth++;
      else if (ch === '}') depth--;
    }
    if (depth === 0) { end = j; break; }
  }
  if (end === -1) return null;
  return lines.slice(start, end + 1).join('\n');
}

function copyProviderBlockToKilo() {
  const open = fs.readFileSync(OPENCODE_FILE, 'utf8');
  const providerBlock = extractProvider(open);
  if (!providerBlock) throw new Error('provider{} not found in ' + OPENCODE_FILE);

  fs.mkdirSync(path.dirname(KILO_FILE), { recursive: true });
  let kiloText;
  if (!fs.existsSync(KILO_FILE)) {
    kiloText = providerBlock + '\n';
  } else {
    kiloText = fs.readFileSync(KILO_FILE, 'utf8');
    const kiloProvider = extractProvider(kiloText);
    if (kiloProvider) {
      kiloText = kiloText.split(kiloProvider).join(providerBlock);
    } else {
      // no provider block in kilo yet: append one
      kiloText = kiloText.replace(/\}$/, ',\n' + providerBlock + '\n}');
    }
  }
  const clean = kiloText.charCodeAt(0) === 0xFEFF ? kiloText.slice(1) : kiloText;
  fs.writeFileSync(KILO_FILE, clean, 'utf8');
  return KILO_FILE;
}

// Reads models-filtered.csv and writes model IDs into:
//   settings.json -> providerInstances -> <router driver blocks> -> config -> customModels
// Models with input context >= 1,000,000 also get a "[1m]" variant.
// Active router drivers from T3_ROUTER_DRIVERS become provider instances.
function ensureRouterInstances(settings) {
  if (!settings.providerInstances) settings.providerInstances = {};

  const rows = readProvidersCsv();
  const routerRow = getRouterRow(rows);
  const routerName = routerRow ? routerRow.provider : null;
  const routerBase = routerName ? routerKeyBase(routerName) : null;
  const displayName = routerName;

  if (routerName && settings.providerInstances[routerName]) {
    const mainEnabled = !!settings.providerInstances[routerName].enabled;
    const mainModels = (settings.providerInstances[routerName].config && settings.providerInstances[routerName].config.customModels) || [];
    const prev = { enabled: mainEnabled, customModels: mainModels };
    delete settings.providerInstances[routerName];
  }

  const activeDrivers = T3_ROUTER_DRIVERS.filter(e => e && typeof e === 'object' && e.driver);
  const activeDriverNames = new Set(activeDrivers.map(e => simplifyName(e.driver)));

  for (const key of Object.keys(settings.providerInstances)) {
    if (routerBase && key.startsWith(routerBase + '-')) {
      const driverName = key.slice(routerBase.length + 1);
      if (!activeDriverNames.has(driverName)) {
        delete settings.providerInstances[key];
      }
    }
  }

  if (!routerName) {
    throw new Error('No provider with description "Router" found in ' + PROVIDERS_CSV);
  }
  const apiKey = routerRow.api_key;
  const baseUrl = routerRow.base_url;

  activeDrivers.forEach((entry) => {
    const driverName = entry.driver;
    const key = `${routerBase}-${simplifyName(driverName)}`;
    settings.providerInstances[key] = buildT3DriverInstance(
      driverName,
      routerName,
      displayName,
      baseUrl,
      apiKey,
      [],
      true
    );
  });
}

// Sort providerInstances so that:
//   1. "c_<router>_*" entries are always first
//   2. All non-c_ entries come next (any manually-added ones like claudeAgent, opencode, etc.)
//   3. All remaining c-* entries come last, in reverse creation order (newest first)
function sortProviderInstances(settings) {
  if (!settings.providerInstances) return;
  const rows = readProvidersCsv();
  const routerName = routerNameOf(rows);
  const routerPrefix = routerName ? routerKeyBase(routerName) + '-' : '__none__';
  const keys = Object.keys(settings.providerInstances);
  const routerEntries = keys.filter((k) => routerName && k.startsWith(routerPrefix));
  const others = keys.filter((k) => !isManagedKey(k));
  const customs = keys.filter((k) => isManagedKey(k) && !(routerName && k.startsWith(routerPrefix))).reverse();
  const ordered = [...routerEntries, ...others, ...customs];
  const reordered = {};
  for (const k of ordered) reordered[k] = settings.providerInstances[k];
  settings.providerInstances = reordered;
}

async function syncOpencodeRestProviders() {
  if (!fs.existsSync(PROVIDERS_CSV)) throw new Error('providers.csv not found: ' + PROVIDERS_CSV);
  const needCsv = !RAW_CATALOG.has('opencode');
  if (needCsv && !fs.existsSync(MODELS_CSV)) throw new Error('models-filtered.csv not found: ' + MODELS_CSV);
  if (!fs.existsSync(OPENCODE_FILE)) throw new Error('opencode.jsonc not found: ' + OPENCODE_FILE);

  const rows = readProvidersCsv();
  const routerName = routerNameOf(rows);
  const modelLines = await getModelsForHarness('opencode', 0, 0, { applyTopN: false });

  const byProvider = {};
  for (const row of rows) {
    if (!byProvider[row.provider]) byProvider[row.provider] = [];
    byProvider[row.provider].push(row);
  }

  const restAdapters = getAdapters('opencode', 'rest');

  let config = {};
  if (fs.existsSync(OPENCODE_FILE)) {
    try {
      const raw = fs.readFileSync(OPENCODE_FILE, 'utf8');
      const json = stripJsoncComments(raw).replace(/,\s*([}\]])/g, '$1').trim();
      config = JSON.parse(json);
    } catch (e) {
      throw new Error('Failed to parse ' + OPENCODE_FILE + ': ' + e.message);
    }
  }
  if (!config.provider) config.provider = {};

  for (const [providerName, providerRows] of Object.entries(byProvider)) {
    if (routerName && providerName === routerName) continue;
    const isSolo = isSoloRow(providerRows[0]);
    if (isSolo && !isSoloActive('opencode')) continue;
    if (!isSolo && !isRestActive('opencode')) continue;
    let candidateModels;
    if (isSolo) {
      const soloCsv = soloFilteredCsvPath(providerName);
      candidateModels = fs.existsSync(soloCsv) ? readModelsCsv(soloCsv) : [];
    } else {
      const prefix = providerName + '/';
      candidateModels = modelLines.filter(m => m.id.startsWith(prefix));
    }
    providerRows.forEach((row, idx) => {
      const providerModels = applyHarnessTopN(candidateModels, 'opencode')
        .map(m => {
          const modelId = isSolo ? m.id : m.id.slice(providerName.length + 1);
          return FOLLOW_HARDCODED_MODEL_TEMPLATE
            ? templateModelEntry(modelId, m.in, m.out)
            : {
                name: modelId,
                attachment: capBool(m.vision, 'vision'),
                reasoning: capBool(m.reasoning, 'reasoning'),
                tool_call: capBool(m.tool, 'tool'),
                ...(m.in >= 1000000 ? { variants: { max: { thinking: { type: 'enabled', budgetTokens: 100000 } } } } : {})
              };
        });
      const modelsObj = providerModels.reduce((acc, m) => { acc[m.name] = m; return acc; }, {});
      const providerAdapters = getAdapters('opencode', isSolo ? 'solo' : 'rest', providerName, idx, providerRows.length);
      for (const adapter of providerAdapters) {
        const key = `${PREFIX}${simplifyName(providerName)}${instancePart(idx, providerRows.length)}${adapterSuffix(adapter, providerAdapters)}`;
        config.provider[key] = {
          name: key,
          npm: adapter,
          options: {
            baseURL: row.base_url.replace(/\/$/, ''),
            apiKey: row.api_key
          },
          models: modelsObj
        };
      }
    });
  }

  fs.writeFileSync(OPENCODE_FILE, JSON.stringify(config, null, 2) + '\n', 'utf8');
  const restKeys = Object.keys(config.provider).filter(k => isManagedKey(k) && !(routerName && k.startsWith(routerKeyBase(routerName))));
  let totalModels = 0;
  for (const k of restKeys) totalModels += Object.keys(config.provider[k].models || {}).length;
  return { apis: restKeys.length, models: totalModels };
}

async function syncKiloRestProviders() {
  if (!fs.existsSync(PROVIDERS_CSV)) throw new Error('providers.csv not found: ' + PROVIDERS_CSV);
  const needCsv = !RAW_CATALOG.has('kilo');
  if (needCsv && !fs.existsSync(MODELS_CSV)) throw new Error('models-filtered.csv not found: ' + MODELS_CSV);
  if (!fs.existsSync(KILO_FILE)) throw new Error('kilo.jsonc not found: ' + KILO_FILE);

  const rows = readProvidersCsv();
  const routerName = routerNameOf(rows);
  const modelLines = await getModelsForHarness('kilo', 0, 0, { applyTopN: false });

  const byProvider = {};
  for (const row of rows) {
    if (!byProvider[row.provider]) byProvider[row.provider] = [];
    byProvider[row.provider].push(row);
  }

  const restAdapters = getAdapters('kilo', 'rest');

  let config = {};
  if (fs.existsSync(KILO_FILE)) {
    try {
      const raw = fs.readFileSync(KILO_FILE, 'utf8');
      const json = stripJsoncComments(raw).replace(/,\s*([}\]])/g, '$1').trim();
      config = JSON.parse(json);
    } catch (e) {
      throw new Error('Failed to parse ' + KILO_FILE + ': ' + e.message);
    }
  }
  if (!config.provider) config.provider = {};

  for (const [providerName, providerRows] of Object.entries(byProvider)) {
    if (routerName && providerName === routerName) continue;
    const isSolo = isSoloRow(providerRows[0]);
    if (isSolo && !isSoloActive('kilo')) continue;
    if (!isSolo && !isRestActive('kilo')) continue;
    let candidateModels;
    if (isSolo) {
      const soloCsv = soloFilteredCsvPath(providerName);
      candidateModels = fs.existsSync(soloCsv) ? readModelsCsv(soloCsv) : [];
    } else {
      const prefix = providerName + '/';
      candidateModels = modelLines.filter(m => m.id.startsWith(prefix));
    }
    providerRows.forEach((row, idx) => {
      const providerModels = applyHarnessTopN(candidateModels, 'kilo')
        .map(m => {
          const modelId = isSolo ? m.id : m.id.slice(providerName.length + 1);
          return FOLLOW_HARDCODED_MODEL_TEMPLATE
            ? templateModelEntry(modelId, m.in, m.out)
            : {
                name: modelId,
                attachment: capBool(m.vision, 'vision'),
                reasoning: capBool(m.reasoning, 'reasoning'),
                tool_call: capBool(m.tool, 'tool'),
                ...(m.in >= 1000000 ? { variants: { max: { thinking: { type: 'enabled', budgetTokens: 100000 } } } } : {})
              };
        });
      const modelsObj = providerModels.reduce((acc, m) => { acc[m.name] = m; return acc; }, {});
      const providerAdapters = getAdapters('kilo', isSolo ? 'solo' : 'rest', providerName, idx, providerRows.length);
      for (const adapter of providerAdapters) {
        const key = `${PREFIX}${simplifyName(providerName)}${instancePart(idx, providerRows.length)}${adapterSuffix(adapter, providerAdapters)}`;
        config.provider[key] = {
          name: key,
          npm: adapter,
          options: {
            baseURL: row.base_url.replace(/\/$/, ''),
            apiKey: row.api_key
          },
          models: modelsObj
        };
      }
    });
  }

  fs.writeFileSync(KILO_FILE, JSON.stringify(config, null, 2) + '\n', 'utf8');
  const restKeys = Object.keys(config.provider).filter(k => isManagedKey(k) && !(routerName && k.startsWith(routerKeyBase(routerName))));
  let totalModels = 0;
  for (const k of restKeys) totalModels += Object.keys(config.provider[k].models || {}).length;
  return { apis: restKeys.length, models: totalModels };
}

// ---------- cleanupProviders: reconcile c-* providers in all config files ----------
// For each config file, removes script-managed (c-*) providers per:
//   REMOVE_IF_FALSE_PROVIDER:        remove providers whose feature flag is false
//   REMOVE_IF_PROVIDER_DOESNT_EXIST: remove providers that no longer exist in providers.csv
// Never touches non-c_ entries, so user-added providers are preserved.
// Also renumbers per-provider indices to match providers.csv (1..N). Instances are
// matched to CSV rows by API key, so deleted keys are dropped and indices compacted.
function cleanupProviders() {
  if (!fs.existsSync(PROVIDERS_CSV)) throw new Error('providers.csv not found: ' + PROVIDERS_CSV);

  const csvLines = fs.readFileSync(PROVIDERS_CSV, 'utf8').trim().split('\n');
  const headers = csvLines[0].split(',').map(h => h.trim());
  const rows = csvLines.slice(1).map(line => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith('//')) return null;
    const vals = line.split(',');
    const row = {};
    headers.forEach((h, i) => { row[h] = (vals[i] || '').trim(); });
    return row;
  }).filter(r => r && r.provider);
  const routerName = routerNameOf(rows);
  const routerSimp = routerName ? simplifyName(routerName) : null;

  // Group CSV rows by the simplified provider name — keys carry the simplified name, so
  // grouping must match. Warn when distinct CSV names collapse to the same simplified form.
  const byProvider = {};
  const simpSeen = {};
  for (const row of rows) {
    const s = simplifyName(row.provider);
    if (s && simpSeen[s] && simpSeen[s] !== row.provider) {
      console.warn(`[warn] providers "${simpSeen[s]}" and "${row.provider}" both simplify to "${s}"; they share one key group.`);
    }
    if (!s) continue;
    if (!simpSeen[s]) simpSeen[s] = row.provider;
    if (!byProvider[s]) byProvider[s] = [];
    byProvider[s].push(row);
  }

  let removed = 0;

  const specs = [
    {
      file: OPENCODE_FILE,
      container: 'provider',
      routerFlag: OPENCODE_ROUTER,
      restFlag: OPENCODE_REST,
      labelField: 'name',
      labelFor: (provider, idx) => `${PREFIX}${provider}-${idx}`,
      apiKeyOf: (inst) => inst && inst.options && inst.options.apiKey,
    },
    {
      file: KILO_FILE,
      container: 'provider',
      routerFlag: KILO_ROUTER,
      restFlag: KILO_REST,
      labelField: 'name',
      labelFor: (provider, idx) => `${PREFIX}${provider}-${idx}`,
      apiKeyOf: (inst) => inst && inst.options && inst.options.apiKey,
    },
    {
      file: T3_SETTINGS_FILE,
      container: 'providerInstances',
      routerFlag: T3_ROUTER,
      restFlag: T3_REST,
      labelField: 'displayName',
      labelFor: (provider, idx) => `${provider}-${idx}`,
      apiKeyOf: (inst) => {
        if (!inst || typeof inst !== 'object') return null;
        if (Array.isArray(inst.environment)) {
          const env = inst.environment.find((e) => e && typeof e === 'object' && e.name && /API_KEY/.test(e.name));
          if (env) return env.value;
        }
        if (inst.config && typeof inst.config.launchArgs === 'string') {
          const m = inst.config.launchArgs.match(/model_providers\.[^.\s]+\.api_key=([^\s]+)/);
          if (m) return m[1];
        }
        return null;
      },
    },
  ];

  // Parse a managed key (current c- or legacy c_) into { provider, idx, adapter, legacy };
  // legacy c_ keys are recognized only so they can be evaluated for removal (never rebuilt).
  const parseManagedKey = parseManagedRestKey;

  for (const spec of specs) {
    if (!fs.existsSync(spec.file)) continue;
    let config;
    try {
      const raw = fs.readFileSync(spec.file, 'utf8');
      const json = stripJsoncComments(raw).replace(/,\s*([}\]])/g, '$1').trim();
      config = JSON.parse(json);
    } catch (e) {
      throw new Error('Failed to parse ' + spec.file + ': ' + e.message);
    }
    const container = config[spec.container];
    if (!container || typeof container !== 'object') continue;

    const grouped = {};
    for (const key of Object.keys(container)) {
      const parsed = parseManagedKey(key);
      if (!parsed) continue;
      const provider = parsed.provider;
      if (!grouped[provider]) grouped[provider] = [];
      grouped[provider].push({ key, inst: container[key], parsed });
    }

    for (const provider of Object.keys(grouped)) {
      const isRouter = routerSimp && provider === routerSimp;
      const flag = isRouter ? spec.routerFlag : spec.restFlag;
      const csvRows = byProvider[provider];
      const entries = grouped[provider];

      if (REMOVE_IF_PROVIDER_DOESNT_EXIST && !csvRows) {
        for (const e of entries) { delete container[e.key]; removed++; }
        continue;
      }
      if (REMOVE_IF_FALSE_PROVIDER && !flag) {
        for (const e of entries) { delete container[e.key]; removed++; }
        continue;
      }
      if (!csvRows || isRouter) continue;

      if (spec.file === T3_SETTINGS_FILE) {
        // T3: preserve the -<n>-<driver> shape; just drop rows whose api_key
        // no longer exists in providers.csv (no adapter logic for T3).
        const csvKeys = csvRows.map((r) => r.api_key);
        const kept = entries.filter((e) => {
          if (e.parsed && e.parsed.legacy) return false; // legacy c_ keys are stale, drop them
          const val = spec.apiKeyOf(e.inst);
          return val ? csvKeys.includes(val) : false;
        });
        const built = kept.map((e, i) => {
          const inst = instancePart(i, kept.length);
          const driver = e.parsed ? e.parsed.adapter : '';
          const newKey = `${PREFIX}${provider}${inst}${driver ? '-' + driver : ''}`;
          return { newKey, inst: e.inst };
        });
        const droppedLegacy = entries.length - kept.length;
        if (!droppedLegacy && built.length === entries.length && built.every((b) => container[b.newKey] === b.inst)) continue;
        for (const e of entries) delete container[e.key];
        for (const b of built) container[b.newKey] = b.inst;
        removed += entries.length - built.length;
        continue;
      }

      // Adapter-aware cleanup for opencode/kilo REST (T3 handled above).
      const restAdapters = getAdapters(spec.file === OPENCODE_FILE ? 'opencode' : 'kilo', 'rest');
      const restAdaptersSimp = restAdapters.map((a) => simplifyName(a));
      const csvKeys = csvRows.map((r) => r.api_key);
      const placement = entries.map((e) => ({
        entry: e,
        adapter: (e.parsed && !e.parsed.legacy && e.parsed.adapter) || null,
        rowIdx: csvKeys.indexOf(spec.apiKeyOf(e.inst)),
      }));
      const allowed = new Set(restAdaptersSimp);
      const keptPre = placement.filter((p) => {
        if (p.entry.parsed && p.entry.parsed.legacy) return false; // legacy c_ keys are stale
        if (p.adapter && !allowed.has(p.adapter)) return false;
        if (p.adapter && restAdapters.length === 1) return false;
        return p.rowIdx !== -1;
      });
      const kept = keptPre.sort((a, b) => a.rowIdx - b.rowIdx);
      const staleAdapterCount = placement.filter((p) => {
        if (p.entry.parsed && p.entry.parsed.legacy) return false;
        if (p.adapter && restAdapters.length === 1) return false;
        if (p.adapter && !allowed.has(p.adapter)) return false;
        return true;
      }).length - kept.length;
      const built = [];
      const byRow = new Map();
      for (const p of kept) {
        if (!byRow.has(p.rowIdx)) byRow.set(p.rowIdx, []);
        byRow.get(p.rowIdx).push(p);
      }
      const sortedRowIdxs = [...byRow.keys()].sort((a, b) => a - b);
      let instanceCounter = 0;
      for (const ri of sortedRowIdxs) {
        instanceCounter++;
        const inst = instancePart(instanceCounter - 1, sortedRowIdxs.length);
        const bucket = byRow.get(ri).sort((a, b) => String(a.adapter || '').localeCompare(String(b.adapter || '')));
        for (const p of bucket) {
          // p.adapter is the simplified form; resolve back to the raw adapter for the suffix builder
          const rawAdapter = restAdapters[restAdaptersSimp.indexOf(p.adapter)] || restAdapters[0] || '';
          const suf = adapterSuffix(rawAdapter, restAdapters);
          const newKey = `${PREFIX}${provider}${inst}${suf}`;
          const instObj = p.entry.inst;
          if (spec.labelField && instObj[spec.labelField]) {
            instObj[spec.labelField] = newKey;
          }
          built.push({ newKey, inst: instObj });
        }
      }
      if (built.length === entries.length && !staleAdapterCount && built.every((b) => container[b.newKey] === b.inst)) continue;
      for (const e of entries) delete container[e.key];
      for (const b of built) container[b.newKey] = b.inst;
      removed += (entries.length - kept.length) + staleAdapterCount;
    }

    fs.writeFileSync(spec.file, JSON.stringify(config, null, 2) + '\n', 'utf8');
  }

  // DSH  + pi / zcode / ocx json cleanup
  removed += cleanupDSHProviders(byProvider, routerName);
  removed += cleanupPiProviders(byProvider, routerName);
  removed += cleanupZcodeProviders(byProvider, routerName);
  removed += cleanupOpencodexProviders(byProvider, routerName);

  return removed;
}

function cleanupDSHProviders(byProvider, routerName) {
  if (!fs.existsSync(DSH_SETTINGS_FILE)) return 0;
  let settings;
  try { settings = readYamlFile(DSH_SETTINGS_FILE); } catch (e) { throw new Error('Failed to parse ' + DSH_SETTINGS_FILE + ': ' + e.message); }
  const providers = settings['llm-pi-ai'] && settings['llm-pi-ai'].providers;
  if (!providers || typeof providers !== 'object' || Array.isArray(providers)) return 0;
  let removed = 0;
  const routerSimp = routerName ? simplifyName(routerName) : null;
  // group by simplified provider name; parse both current c- keys and legacy c_ keys (legacy -> stale)
  const grouped = {};
  for (const key of Object.keys(providers)) {
    const parsed = isManagedKey(key) ? parseManagedDshKey(key) : null;
    if (!parsed) continue;
    const p = parsed.provider;
    if (!grouped[p]) grouped[p] = [];
    grouped[p].push({ key, parsed, inst: providers[key] });
  }
  for (const provider of Object.keys(grouped)) {
    const isRouter = routerSimp && provider === routerSimp;
    const csvRows = byProvider[provider];
    const isSolo = csvRows && isSoloRow(csvRows[0]);
    const flag = isRouter ? DSH_ROUTER : (isSolo ? DSH_SOLO : DSH_REST);
    const entries = grouped[provider];
    if (REMOVE_IF_PROVIDER_DOESNT_EXIST && !csvRows) {
      for (const e of entries) { delete providers[e.key]; removed++; }
      continue;
    }
    if (REMOVE_IF_FALSE_PROVIDER && !flag) {
      // target disabled for this side: prune all entries for this provider on this side
      for (const e of entries) { delete providers[e.key]; removed++; }
      continue;
    }
    if (!csvRows) continue;
    if (isRouter) {
      const routerAdapters = getAdapters('dsh', 'router');
      const routerAdaptersSimp = routerAdapters.map((a) => simplifyName(a));
      const allowed = new Set(routerAdaptersSimp);
      for (const e of entries) {
        if (e.parsed.legacy) { delete providers[e.key]; removed++; continue; } // legacy c_ key -> stale
        // Bare key (no adapter segment) => single-adapter default, keep it.
        const adapterSimp = e.parsed.suffix;
        if (adapterSimp == null) continue;
        if (!allowed.has(adapterSimp)) { delete providers[e.key]; removed++; }
      }
      continue;
    }
    // REST: match by apiKeyEnv's env var value in credentials file
    let creds = {};
    try { creds = readCredentialsFile(DSH_CREDENTIALS_FILE); } catch (_) {}
    const csvKeys = csvRows.map(r => r.api_key);
    // map inst apiKeyEnv -> csv row index via creds value
    const placement = entries.map(e => {
      const env = e.inst && e.inst.apiKeyEnv;
      const val = env ? (creds.refs && creds.refs[env]) : null;
      let rowIdx = val ? csvKeys.indexOf(val) : -1;
      // fallback: match by baseURL
      if (rowIdx === -1) {
        const baseURL = e.inst && e.inst.baseURL;
        if (baseURL) rowIdx = csvRows.findIndex(r => (r.base_url || '').replace(/\/$/, '') === String(baseURL).replace(/\/$/, ''));
      }
      return { entry: e, rowIdx };
    });
    const restAdapters = getAdapters('dsh', 'rest');
    const restAdaptersSimp = restAdapters.map((a) => simplifyName(a));
    const allowedRestSuffixes = new Set(restAdaptersSimp);
    for (const p of placement) {
      if (p.rowIdx === -1) continue;
      if (p.entry.parsed.legacy) { p.rowIdx = -1; continue; } // legacy c_ key -> stale
      // current suffix is the simplified adapter segment parsed from the key
      const curSimp = p.entry.parsed.suffix;
      if (curSimp != null && !allowedRestSuffixes.has(curSimp)) p.rowIdx = -1;
    }
    const kept = placement.filter(p => p.rowIdx !== -1).sort((a, b) => a.rowIdx - b.rowIdx || String(a.entry.parsed.suffix || '').localeCompare(String(b.entry.parsed.suffix || '')));
    // rebuild keys as c-<provider>[-<N>][-<adapter>] with compacted instance numbers (first instance bare)
    const byRowIdx = {};
    for (const p of kept) {
      if (!byRowIdx[p.rowIdx]) byRowIdx[p.rowIdx] = [];
      byRowIdx[p.rowIdx].push(p);
    }
    const rowOrder = Object.keys(byRowIdx).map(n => parseInt(n, 10)).sort((a, b) => a - b);
    const built = [];
    rowOrder.forEach((origIdx, newPos) => {
      const bucket = byRowIdx[origIdx].sort((a, b) => String(a.entry.parsed.suffix || '').localeCompare(String(b.entry.parsed.suffix || '')));
      const inst = instancePart(newPos, rowOrder.length);
      for (const p of bucket) {
        // Derive the adapter raw for this placement: prefer the instance's api field, else the first allowed adapter
        const apiForKey = (p.entry.inst && p.entry.inst.api) ? String(p.entry.inst.api).trim() : restAdapters[0] || '';
        const suf = adapterSuffix(apiForKey, restAdapters);
        const newKey = `${PREFIX}${provider}${inst}${suf}`;
        const instObj = p.entry.inst;
        if (instObj.displayName) instObj.displayName = `${provider}${inst}${suf}`;
        built.push({ newKey, inst: instObj, oldKey: p.entry.key });
        // ensure api field is updated to the resolved adapter (helps when narrowing)
        instObj.api = apiForKey || p.entry.parsed.api;
      }
    });
    // prune stale credentials for removed rows/apis
    const keptRowIdxs = new Set(kept.map(p => p.rowIdx));
    // delete all old entries
    for (const e of entries) delete providers[e.key];
    for (const b of built) providers[b.newKey] = b.inst;
    removed += (entries.length - built.length);
    // credentials pruning: remove env vars for rows no longer present
    // handled after loop for all providers
    void keptRowIdxs;
  }
  // prune credentials that are no longer referenced by any remaining dsh provider
  try {
    let creds = readCredentialsFile(DSH_CREDENTIALS_FILE);
    // Build a lowercase lookup so C_ vs c_ env vars match either way.
    const referenced = new Set();
    for (const k of Object.keys(providers)) {
      const inst = providers[k];
      if (inst && inst.apiKeyEnv) {
        referenced.add(inst.apiKeyEnv);
        referenced.add(inst.apiKeyEnv.toLowerCase());
      }
    }
    // only prune C_ env vars we manage (C_<SIMPPROVIDER>[_<N>]_API_KEY)
    let changed = false;
    for (const env of Object.keys(creds.refs)) {
      if (!/_API_KEY$/i.test(env)) continue;
      // if this env is not referenced (case-insensitive) and it matches a provider we grouped, remove
      if (!referenced.has(env) && !referenced.has(env.toLowerCase())) {
        // strip optional CUSTOM_/C_ prefix + optional _<idx> before _API_KEY to find provider
        const prefix = env.replace(/^(?:CUSTOM_|C_)/i, '').replace(/(_\d+)?_API_KEY$/i, '').toLowerCase();
        if (grouped[prefix] || (routerSimp && prefix === routerSimp)) {
          delete creds.refs[env];
          removed++;
          changed = true;
        }
      }
    }
    if (changed) writeCredentialsFile(DSH_CREDENTIALS_FILE, creds);
  } catch (_) {}
  writeYamlFile(DSH_SETTINGS_FILE, settings);
  return removed;
}

function cleanupPiProviders(byProvider, routerName) {
  if (!fs.existsSync(PI_FILE)) return 0;
  let doc;
  try { doc = readJsonSafe(PI_FILE, { providers: {} }); } catch (e) { throw new Error('Failed to parse ' + PI_FILE + ': ' + e.message); }
  const providers = doc.providers;
  if (!providers || typeof providers !== 'object' || Array.isArray(providers)) return 0;
  let removed = 0;
  const routerSimp = routerName ? simplifyName(routerName) : null;
  // group managed keys (c- current / c_ legacy) by simplified provider (c-<provider>[-<idx>])
  const grouped = {};
  for (const key of Object.keys(providers)) {
    const parsed = parseManagedRestKey(key);
    if (!parsed) continue;
    if (!grouped[parsed.provider]) grouped[parsed.provider] = [];
    grouped[parsed.provider].push({ key, inst: providers[key], parsed });
  }
  for (const provider of Object.keys(grouped)) {
    const isRouter = routerSimp && provider === routerSimp;
    const csvRows = byProvider[provider];
    const isSolo = csvRows && isSoloRow(csvRows[0]);
    const flag = isRouter ? PI_ROUTER : (isSolo ? PI_SOLO : PI_REST);
    const entries = grouped[provider];
    if (REMOVE_IF_PROVIDER_DOESNT_EXIST && !csvRows) {
      for (const e of entries) { delete providers[e.key]; removed++; }
      continue;
    }
    if (REMOVE_IF_FALSE_PROVIDER && !flag) {
      for (const e of entries) { delete providers[e.key]; removed++; }
      continue;
    }
    if (!csvRows || isRouter) continue;
    const csvKeys = csvRows.map(r => r.api_key);
    const placement = entries.map(e => ({
      entry: e,
      rowIdx: (e.parsed.legacy ? -1 : csvKeys.indexOf(e.inst && e.inst.apiKey)), // legacy c_ keys are stale
    }));
    const kept = placement.filter(p => p.rowIdx !== -1).sort((a, b) => a.rowIdx - b.rowIdx);
    const built = [];
    for (const p of kept) {
      const newKey = `${PREFIX}${provider}-${built.length + 1}`;
      const inst = p.entry.inst;
      if (inst.name) inst.name = newKey;
      built.push({ newKey, inst });
    }
    if (built.length === entries.length && built.every(b => providers[b.newKey] === b.inst)) continue;
    for (const e of entries) delete providers[e.key];
    for (const b of built) providers[b.newKey] = b.inst;
    removed += entries.length - kept.length;
  }
  if (removed) writeJsonFile(PI_FILE, doc);
  return removed;
}

function cleanupZcodeProviders(byProvider, routerName) {
  if (!fs.existsSync(ZCODE_FILE)) return 0;
  let doc;
  try { doc = readJsonSafe(ZCODE_FILE, { provider: {} }); } catch (e) { throw new Error('Failed to parse ' + ZCODE_FILE + ': ' + e.message); }
  const map = doc.provider;
  if (!map || typeof map !== 'object' || Array.isArray(map)) return 0;
  let removed = 0;
  const routerSimp = routerName ? simplifyName(routerName) : null;
  const grouped = {};
  for (const key of Object.keys(map)) {
    if (key.startsWith('builtin:')) continue;
    const logical = zcodeLogicalName(key, map[key]);
    const parsed = parseManagedRestKey(logical) || parseManagedRestKey(key);
    if (!parsed) continue;
    if (!grouped[parsed.provider]) grouped[parsed.provider] = [];
    grouped[parsed.provider].push({ key, inst: map[key], parsed });
  }
  for (const provider of Object.keys(grouped)) {
    const isRouter = routerSimp && provider === routerSimp;
    const flag = isRouter ? ZCODE_ROUTER : ZCODE_REST;
    const csvRows = byProvider[provider];
    const entries = grouped[provider];
    if (REMOVE_IF_PROVIDER_DOESNT_EXIST && !csvRows) {
      for (const e of entries) { delete map[e.key]; removed++; }
      continue;
    }
    if (REMOVE_IF_FALSE_PROVIDER && !flag) {
      for (const e of entries) { delete map[e.key]; removed++; }
      continue;
    }
    if (!csvRows || isRouter) continue;
    const csvKeys = csvRows.map(r => r.api_key);
    const placement = entries.map(e => ({
      entry: e,
      rowIdx: (e.parsed.legacy ? -1 : csvKeys.indexOf(e.inst && e.inst.options && e.inst.options.apiKey)), // legacy c_ keys are stale
    }));
    const kept = placement.filter(p => p.rowIdx !== -1).sort((a, b) => a.rowIdx - b.rowIdx);
    const built = [];
    for (const p of kept) {
      const newKey = `${PREFIX}${provider}-${built.length + 1}`;
      const inst = p.entry.inst;
      if (inst.name) inst.name = newKey;
      built.push({ newKey, inst });
    }
    if (built.length === entries.length && built.every(b => map[b.newKey] === b.inst)) continue;
    for (const e of entries) delete map[e.key];
    for (const b of built) map[b.newKey] = b.inst;
    removed += (entries.length - kept.length);
  }
  if (removed) writeJsonFile(ZCODE_FILE, doc);
  return removed;
}

function cleanupOpencodexProviders(byProvider, routerName) {
  if (!fs.existsSync(OPENCODEX_FILE)) return 0;
  let doc;
  try { doc = readJsonSafe(OPENCODEX_FILE, {}); } catch (e) { throw new Error('Failed to parse ' + OPENCODEX_FILE + ': ' + e.message); }
  const providers = doc.providers && typeof doc.providers === 'object' && !Array.isArray(doc.providers) ? doc.providers : null;
  if (!providers) return 0;
  let removed = 0;
  const routerSimp = routerName ? simplifyName(routerName) : null;
  // group managed keys by base provider (c-<provider>[-<N>]; legacy c_ recognized as stale)
  const grouped = {};
  for (const key of Object.keys(providers)) {
    const parsed = parseManagedRestKey(key);
    if (!parsed) continue;
    const provider = parsed.provider;
    if (!provider) continue;
    if (!grouped[provider]) grouped[provider] = [];
    grouped[provider].push({ key, inst: providers[key], idx: parsed.idx || 1, parsed });
  }
  let dirtyProviders = false;
  for (const provider of Object.keys(grouped)) {
    const isRouter = routerSimp && provider === routerSimp;
    const flag = isRouter ? OPENCODEX_ROUTER : OPENCODEX_REST;
    const csvRows = byProvider[provider];
    const entries = grouped[provider];
    if (REMOVE_IF_PROVIDER_DOESNT_EXIST && !csvRows) {
      for (const e of entries) { delete providers[e.key]; removed++; dirtyProviders = true; }
      // prune customModels for this provider
      if (Array.isArray(doc.customModels)) {
        const before = doc.customModels.length;
        doc.customModels = doc.customModels.filter((cm) => !cm || cm.provider !== entries[0].key && !entries.some((en) => en.key === cm.provider));
        // also catch stripped naming: any customModels whose provider base matches
        doc.customModels = doc.customModels.filter((cm) => {
          if (!cm || !cm.provider || !cm.provider.startsWith(PREFIX + provider) && !cm.provider.startsWith(LEGACY_PREFIX + provider)) return true;
          // if cm.provider starts with the provider prefix, it belongs to this group
          const cmParsed = parseManagedRestKey(cm.provider);
          return !(cmParsed && cmParsed.provider === provider);
        });
        removed += before - doc.customModels.length;
      }
      continue;
    }
    if (REMOVE_IF_FALSE_PROVIDER && !flag) {
      for (const e of entries) { delete providers[e.key]; removed++; dirtyProviders = true; }
      if (Array.isArray(doc.customModels)) {
        const before = doc.customModels.length;
        doc.customModels = doc.customModels.filter((cm) => !cm || !entries.some((en) => en.key === cm.provider));
        removed += before - doc.customModels.length;
      }
      continue;
    }
    if (!csvRows || isRouter) continue;
    const csvKeys = csvRows.map((r) => r.api_key);
    const placement = entries.map((e) => ({
      entry: e,
      rowIdx: csvKeys.indexOf(e.inst && e.inst.apiKey),
      baseUrlIdx: (() => {
        const bu = e.inst && e.inst.baseUrl;
        if (!bu) return -1;
        return csvRows.findIndex((r) => (r.base_url || '').replace(/\/$/, '') === String(bu).replace(/\/$/, ''));
      })(),
    }));
    // prefer apiKey match, fallback to baseUrl
    for (const p of placement) if (p.rowIdx === -1 && p.baseUrlIdx !== -1) p.rowIdx = p.baseUrlIdx;
    // legacy c_ keys are stale — never kept
    for (const p of placement) if (p.entry.parsed && p.entry.parsed.legacy) p.rowIdx = -1;
    const kept = placement.filter((p) => p.rowIdx !== -1).sort((a, b) => a.rowIdx - b.rowIdx);
    // rebuild compacted keys: c-<provider>, c-<provider>-2, ...
    const built = [];
    for (let i = 0; i < kept.length; i++) {
      const p = kept[i];
      const newKey = `${PREFIX}${provider}${i === 0 ? '' : '-' + (i + 1)}`;
      built.push({ newKey, inst: p.entry.inst, oldKey: p.entry.key, rowIdx: p.rowIdx });
    }
    const needsRebuild = built.length !== entries.length || !built.every((b) => providers[b.newKey] === b.inst && b.newKey === b.oldKey);
    if (!needsRebuild) continue;
    // prune old keys
    for (const e of entries) delete providers[e.key];
    for (const b of built) providers[b.newKey] = b.inst;
    dirtyProviders = true;
    removed += entries.length - kept.length;
    // fix customModels provider references: oldKey -> newKey by rowIdx
    if (Array.isArray(doc.customModels)) {
      const oldToNew = new Map();
      const byRowIdx = new Map(kept.map((p) => [p.entry.key, p.rowIdx]));
      // map oldKey to newKey via rowIdx -> position
      const rowIdxToNewKey = new Map(built.map((b) => [b.rowIdx, b.newKey]));
      for (const e of entries) {
        const ri = byRowIdx.get(e.key);
        if (ri !== undefined && rowIdxToNewKey.has(ri)) oldToNew.set(e.key, rowIdxToNewKey.get(ri));
      }
      const before = doc.customModels.length;
      const next = [];
      for (const cm of doc.customModels) {
        if (!cm || !cm.provider) { next.push(cm); continue; }
        if (oldToNew.has(cm.provider)) {
          next.push({ ...cm, provider: oldToNew.get(cm.provider) });
        } else if (entries.some((en) => en.key === cm.provider)) {
          // was for a removed entry -> drop
          removed++;
          continue;
        } else {
          next.push(cm);
        }
      }
      doc.customModels = next;
      void before;
    }
  }
  // prune customModels whose provider key no longer exists in providers
  if (Array.isArray(doc.customModels)) {
    const liveKeys = new Set(Object.keys(providers));
    const before = doc.customModels.length;
    doc.customModels = doc.customModels.filter((cm) => !cm || !cm.provider || !cm.provider.startsWith(PREFIX) || liveKeys.has(cm.provider));
    removed += before - doc.customModels.length;
  }
  if (removed || dirtyProviders) writeJsonFile(OPENCODEX_FILE, doc);
  return removed;
}

// Router provider block helpers (opencode/kilo write npm; pi/zcode/opencodex get their own routers)
function routerAdaptersFor(harnessId) { return getAdapters(harnessId, 'router'); }
function ocRouterKey(routerName, adapters) {
  // With single adapter -> bare c-<simplified provider>; multi -> one key per adapter with -<simplified adapter>.
  // Router never has instances, so only adapters matter. Caller loops adapters and writes each key.
  return (adapter) => `${routerKeyBase(routerName)}${adapterSuffix(adapter, adapters)}`;
}

// ---------- syncRouterProvider: write router provider block (no markers, full replace) ----------
// Reads providers.csv + models (csv or live per harness), builds complete router block.
async function syncRouterProvider(targetFile, harnessId) {
  const hid = harnessId || 'opencode';
  // Keep hard fail for non-live harnesses that still expect models-filtered.csv
  if (!RAW_CATALOG.has(normalizeHarnessId(hid)) && !fs.existsSync(MODELS_CSV)) throw new Error('models-filtered.csv not found: ' + MODELS_CSV);
  if (!fs.existsSync(PROVIDERS_CSV)) throw new Error('providers.csv not found: ' + PROVIDERS_CSV);
  if (!fs.existsSync(targetFile)) throw new Error('Config file not found: ' + targetFile);

  const rows = readProvidersCsv();
  const routerRow = requireRouterRow(rows);
  const routerName = routerRow.provider;
  const displayName = routerName;

  const modelLines = (await getModelsForHarness(hid)).filter(m => !m.id.endsWith('[1m]'));
  writeHarnessPreview(hid, modelLines);

  const models = {};
  for (const m of modelLines) {
    models[m.id] = FOLLOW_HARDCODED_MODEL_TEMPLATE
      ? templateModelEntry(m.id + ' (custom)', m.in, m.out)
      : {
          name: m.id + ' (custom)',
          attachment: capBool(m.vision, 'vision'),
          reasoning: capBool(m.reasoning, 'reasoning'),
          tool_call: capBool(m.tool, 'tool'),
          temperature: true,
          limit: { context: m.in || 0, output: m.out || 0 }
        };
  }

  let config = {};
  const raw = fs.readFileSync(targetFile, 'utf8');
  const json = stripJsoncComments(raw).replace(/,\s*([}\]])/g, '$1').trim();
  try { config = JSON.parse(json); } catch (e) { throw new Error('Failed to parse ' + targetFile + ': ' + e.message); }
  config.provider = config.provider || {};
  // Router adapters: one provider entry per adapter, key = c-<simplified provider> or c-<simplified provider>-<simplified adapter>.
  // For opencode/kilo the adapter is the npm value; other harnesses have dedicated router sync functions (not this generic one).
  // Name keeps backward-compat bare provider (tests expect "9router" not "c-9router"); for multi-adapter the suffix is added to name.
  const adapters = routerAdaptersFor(hid);
  const effectiveAdapters = adapters.length ? adapters : ['@ai-sdk/openai-compatible'];
  for (const adapter of effectiveAdapters) {
    const key = `${routerKeyBase(routerName)}${adapterSuffix(adapter, adapters)}`;
    const displayName = `${simplifyName(routerName)}${adapterSuffix(adapter, adapters)}`;
    const routerBlock = {
      name: displayName,
      npm: adapter,
      options: {
        baseURL: routerRow.base_url.replace(/\/$/, ''),
        apiKey: routerRow.api_key
      },
      models: models
    };
    config.provider[key] = routerBlock;
  }

  fs.writeFileSync(targetFile, JSON.stringify(config, null, 2) + '\n', 'utf8');
  return { apis: effectiveAdapters.length, models: Object.keys(models).length };
}

function formatApiModels(res, defaultApis = 1, defaultModels = 0) {
  let apis = defaultApis;
  let models = defaultModels;
  if (typeof res === 'object' && res !== null) {
    if (typeof res.apis === 'number') apis = res.apis;
    else if (typeof res.providers === 'number') apis = res.providers;
    if (typeof res.models === 'number') models = res.models;
  } else if (typeof res === 'number') {
    models = res;
  }
  const apiLabel = apis === 1 ? 'api' : 'apis';
  return `${apis} ${apiLabel}, ${models} models`;
}

// ---------- yaml helpers (DSH) — zero-dep minimal ----------
function parseYaml(text) {
  if (!text || !text.trim()) return {};
  const lines = text.split(/\r?\n/);
  const root = {};
  const stack = [{ indent: -1, obj: root, key: null, isArray: false }];
  function countIndent(s) { let n = 0; for (const c of s) { if (c === ' ') n++; else if (c === '\t') n += 2; else break; } return n; }
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const trimmed = raw.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const indent = countIndent(raw);
    // pop to parent
    while (stack.length > 1 && indent <= stack[stack.length - 1].indent) stack.pop();
    const cur = stack[stack.length - 1];
    // array item?
    if (trimmed.startsWith('- ')) {
      const val = trimmed.slice(2).trim();
      const arr = cur.obj;
      if (!Array.isArray(arr)) continue;
      if (!val) {
        const obj = {};
        arr.push(obj);
        stack.push({ indent, obj, key: null, isArray: false });
      } else if (val.includes(':')) {
        const c = val.indexOf(':');
        const k = val.slice(0, c).trim();
        const v = val.slice(c + 1).trim();
        const obj = {};
        obj[k] = parseYamlValue(v);
        arr.push(obj);
        stack.push({ indent, obj, key: null, isArray: false });
      } else {
        arr.push(parseYamlValue(val));
      }
      continue;
    }
    if (trimmed === '-') {
      const arr = cur.obj;
      if (Array.isArray(arr)) { const obj = {}; arr.push(obj); stack.push({ indent, obj, key: null, isArray: false }); }
      continue;
    }
    const colon = trimmed.indexOf(':');
    if (colon === -1) continue;
    const k = trimmed.slice(0, colon).trim();
    const vPart = trimmed.slice(colon + 1).trim();
    // look ahead to decide if value is nested
    let hasNested = false;
    for (let j = i + 1; j < lines.length; j++) {
      const t2 = lines[j].trim();
      if (!t2 || t2.startsWith('#')) continue;
      const ind2 = countIndent(lines[j]);
      if (ind2 > indent) hasNested = true;
      break;
    }
    if (hasNested) {
      // peek next non-empty line to see if it's an array
      let isArr = false;
      for (let j = i + 1; j < lines.length; j++) {
        const t2 = lines[j].trim();
        if (!t2 || t2.startsWith('#')) continue;
        if (t2.startsWith('-')) isArr = true;
        break;
      }
      const child = isArr ? [] : {};
      cur.obj[k] = child;
      stack.push({ indent, obj: child, key: k, isArray: isArr });
    } else {
      cur.obj[k] = parseYamlValue(vPart);
    }
  }
  return root;
}
function parseYamlValue(v) {
  if (!v) return '';
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) return v.slice(1, -1);
  if (v === 'true') return true;
  if (v === 'false') return false;
  if (v === 'null' || v === '~') return null;
  if (/^-?\d+$/.test(v)) return parseInt(v, 10);
  if (/^-?\d*\.\d+$/.test(v)) return parseFloat(v);
  // YAML flow sequence: ["text","image"] → round-trip as a real JS array
  if (/^\[[^\]]*\]$/.test(v.trim())) {
    try { return JSON.parse(v.trim()); } catch (_) { return v; }
  }
  return v;
}
function yamlEscape(s) {
  if (s === '' || /[:#\[\]{}&,*!|>'"%`@\-?]/.test(s[0]) || /:\s/.test(s) || /\s#/.test(s) || /\n/.test(s) || s.trim() !== s) return JSON.stringify(s);
  return s;
}
function stringifyYaml(obj, indent) {
  if (indent === undefined) indent = 0;
  const pad = '  '.repeat(indent);
  if (obj === null || obj === undefined) return pad + 'null\n';
  if (Array.isArray(obj)) {
    if (!obj.length) return pad + '[]\n';
    let out = '';
    for (const v of obj) {
      if (v && typeof v === 'object' && !Array.isArray(v)) {
        const keys = Object.keys(v);
        if (!keys.length) { out += pad + '- {}\n'; continue; }
        out += pad + '- ' + yamlEscape(String(keys[0])) + ': ' + yamlValInline(v[keys[0]]) + '\n';
        for (let i = 1; i < keys.length; i++) out += pad + '  ' + yamlEscape(String(keys[i])) + ': ' + yamlValInline(v[keys[i]]) + '\n';
        // nested objects beyond first level not needed for DSH models
        for (const k of keys) {
          if (v[k] && typeof v[k] === 'object' && !Array.isArray(v[k])) {
            // re-emit nested if needed (not used in DSH flat models)
          }
        }
      } else if (Array.isArray(v)) {
        out += pad + '-\n' + stringifyYaml(v, indent + 1);
      } else {
        out += pad + '- ' + yamlValInline(v) + '\n';
      }
    }
    return out;
  }
  if (typeof obj === 'object') {
    const keys = Object.keys(obj);
    if (!keys.length) return '';
    let out = '';
    for (const k of keys) {
      const v = obj[k];
      if (v && typeof v === 'object') {
        if (Array.isArray(v)) {
          if (!v.length) out += pad + yamlEscape(String(k)) + ': []\n';
          else out += pad + yamlEscape(String(k)) + ':\n' + stringifyYaml(v, indent + 1);
        } else {
          const sub = stringifyYaml(v, indent + 1);
          if (!sub.trim()) out += pad + yamlEscape(String(k)) + ': {}\n';
          else out += pad + yamlEscape(String(k)) + ':\n' + sub;
        }
      } else {
        out += pad + yamlEscape(String(k)) + ': ' + yamlValInline(v) + '\n';
      }
    }
    return out;
  }
  return pad + yamlValInline(obj) + '\n';
}
function yamlValInline(v) {
  if (v === null || v === undefined) return 'null';
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (typeof v === 'number') return String(v);
  if (typeof v === 'string') return yamlEscape(v);
  return JSON.stringify(v);
}
function readYamlFile(file) {
  if (!fs.existsSync(file)) return {};
  const raw = fs.readFileSync(file, 'utf8');
  if (!raw.trim()) return {};
  return parseYaml(raw);
}
function writeYamlFile(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, stringifyYaml(obj), 'utf8');
}
// dsh credentials live under `refs:` (e.g. `version: 1` + `refs: { DEEPSEEK_API_KEY: ... }`).
// readCredentialsFile always returns { version, refs } — legacy root-level *_API_KEY entries
// are folded into refs so they land in the right place on the next write.
function readCredentialsFile(file) {
  if (!fs.existsSync(file)) return { version: 1, refs: {} };
  const raw = fs.readFileSync(file, 'utf8');
  if (!raw.trim()) return { version: 1, refs: {} };
  const doc = parseYaml(raw);
  const out = { version: 1, refs: {} };
  if (doc && typeof doc === 'object' && !Array.isArray(doc)) {
    if (doc.version !== undefined) out.version = doc.version;
    if (doc.refs && typeof doc.refs === 'object' && !Array.isArray(doc.refs)) out.refs = { ...doc.refs };
    for (const k of Object.keys(doc)) {
      if (k === 'refs' || k === 'version') continue;
      if (/_API_KEY$/i.test(k) && !(k in out.refs)) out.refs[k] = doc[k];
    }
  }
  return out;
}
function writeCredentialsFile(file, creds) {
  const doc = { version: (creds && creds.version !== undefined) ? creds.version : 1 };
  doc.refs = (creds && creds.refs && typeof creds.refs === 'object' && !Array.isArray(creds.refs)) ? creds.refs : {};
  writeYamlFile(file, doc);
}

// ---------- pi / zcode helpers ----------
// customKey avoids double-prefix when provider already starts with the prefix.
function customKey(provider) { return providerKey(provider); }
function readJsonSafe(file, fallback) {
  if (!fs.existsSync(file)) return fallback;
  try {
    const raw = fs.readFileSync(file, 'utf8');
    const json = stripJsoncComments(raw).replace(/,\s*([}\]])/g, '$1').trim();
    const parsed = JSON.parse(json || '{}');
    return parsed && typeof parsed === 'object' ? parsed : fallback;
  } catch (_) { return fallback; }
}
function ensureParentDir(file) { fs.mkdirSync(path.dirname(file), { recursive: true }); }
function writeJsonFile(file, obj) { fs.writeFileSync(file, JSON.stringify(obj, null, 2) + '\n', 'utf8'); }
function piModelsForSync(modelRows) {
  return modelRows.map(m => ({ id: m.id, name: m.id, reasoning: true, input: ['text', 'image'], cost: { input: 0, output: 0, cacheRead: 1, cacheWrite: 1 }, contextWindow: m.in, maxTokens: m.out }));
}
// ZCode's config loader requires limit.context and limit.output to be positive numbers
// (zod .positive()); a single zero anywhere rejects the ENTIRE config.json and ZCode
// rebuilds it from scratch on launch, wiping every custom provider. Clamp any
// zero/NaN CSV value to a sane positive default instead of writing it verbatim.
function zcodeSanitizeLimit(context, output) {
  const ctx = Number.isFinite(context) && context > 0 ? context : 999999;
  const out = Number.isFinite(output) && output > 0 ? output : 127777;
  return { context: ctx, output: out };
}
function zcodeModelsForSync(modelRows) {
  const out = {};
  for (const m of modelRows) {
    const key = m.id.includes('/') ? m.id.split('/').pop() : m.id;
    out[key] = { limit: zcodeSanitizeLimit(m.in, m.out), modalities: { input: ['text', 'image', 'video'], output: ['text'] }, zcode: { modalitiesConfigured: true } };
  }
  return out;
}
function zcodeRouterModelsForSync(modelRows) {
  const out = {};
  for (const m of modelRows) out[m.id] = { limit: zcodeSanitizeLimit(m.in, m.out), modalities: { input: ['text', 'image', 'video'], output: ['text'] }, zcode: { modalitiesConfigured: true } };
  return out;
}
function parseZcodeCustomKey(key) {
  const rest = key.slice(PREFIX.length);
  const m = rest.match(/^(.*)-(\d+)$/);
  if (m) return { base: m[1], idx: parseInt(m[2], 10) };
  return { base: rest, idx: 1 };
}

// ---------- opencodex helpers ----------
const crypto = (() => { try { return require('crypto'); } catch (_) { return null; } })();
function rand8hex() {
  if (crypto && crypto.randomUUID) return crypto.randomUUID().replace(/-/g, '').slice(0, 8);
  if (crypto && crypto.randomBytes) return crypto.randomBytes(4).toString('hex');
  return Math.random().toString(16).slice(2, 10).padEnd(8, '0');
}
function uuid4() {
  if (crypto && crypto.randomUUID) return crypto.randomUUID();
  if (crypto && crypto.randomBytes) {
    const b = crypto.randomBytes(16);
    b[6] = (b[6] & 0x0f) | 0x40; b[8] = (b[8] & 0x3f) | 0x80;
    const hex = b.toString('hex');
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  }
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0, v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}
function ocxProviderEntry(row, adapter) {
  return {
    adapter: (adapter && String(adapter).trim()) ? String(adapter).trim() : 'openai-chat',
    baseUrl: (row.base_url || '').replace(/\/$/, ''),
    allowPrivateNetwork: true,
    authMode: 'key',
    apiKey: row.api_key,
    apiKeyPool: [{ id: rand8hex(), key: row.api_key }],
    liveModels: false,
  };
}
function ensureClaudeCodeProxy(doc) {
  if (!doc.claudeCode || typeof doc.claudeCode !== 'object' || Array.isArray(doc.claudeCode)) {
    doc.claudeCode = { authMode: 'proxy' };
    return true;
  }
  if (doc.claudeCode.authMode !== 'proxy') {
    doc.claudeCode.authMode = 'proxy';
    return true;
  }
  return false;
}
function maybeWarnClaudeSettings(didEnsure) {
  // explicit env override for tests: CLAUDE_SETTINGS_FILE
  const settingsPath = process.env.CLAUDE_SETTINGS_FILE || path.join(home, '.claude', 'settings.json');
  const bakPath = settingsPath + '.bak';
  let raw = '';
  try {
    if (!fs.existsSync(settingsPath)) return;
    raw = fs.readFileSync(settingsPath, 'utf8');
  } catch (_) { return; }
  const hit = /ANTHROPIC_BASE_URL|ANTHROPIC_API_KEY|baseUrl|apiUrl|base_url|api_url|custom_api/.test(raw);
  if (!hit) return;
  // warn whenever proxy is set and settings looks risky — didEnsure gated only to avoid double-warn
  // but spec says warn when this block true after running
  console.warn(`[warn] ~/.claude/settings.json contains a custom api/base URL that will shadow claudeCode.authMode:"proxy". Backing up to ${bakPath} and clearing settings.json.`);
  try {
    fs.copyFileSync(settingsPath, bakPath);
  } catch (_) {}
  try {
    fs.writeFileSync(settingsPath, '{}\n', 'utf8');
  } catch (e) {
    console.warn(`[warn] Failed to clear ${settingsPath}: ${e.message}`);
  }
  void didEnsure;
}

// ---------- DSH sync helpers ----------
async function syncDSHRouter() {
  if (!fs.existsSync(PROVIDERS_CSV)) throw new Error('providers.csv not found: ' + PROVIDERS_CSV);
  const rows = readProvidersCsv();
  const routerRow = requireRouterRow(rows);
  const routerName = routerRow.provider;
  const models = (await getModelsForHarness('dsh')).filter(m => !m.id.endsWith('[1m]'));
  writeHarnessPreview('dsh', models);
  const settings = readYamlFile(DSH_SETTINGS_FILE);
  if (!settings['llm-pi-ai'] || typeof settings['llm-pi-ai'] !== 'object') settings['llm-pi-ai'] = {};
  if (!settings['llm-pi-ai'].providers || typeof settings['llm-pi-ai'].providers !== 'object' || Array.isArray(settings['llm-pi-ai'].providers)) settings['llm-pi-ai'].providers = {};
  const providers = settings['llm-pi-ai'].providers;
  const creds = readCredentialsFile(DSH_CREDENTIALS_FILE);
  const envVar = PREFIX_UPPER + simplifyName(routerName).toUpperCase() + '_API_KEY';
  creds.refs[envVar] = routerRow.api_key;
  const routerAdapters = getAdapters('dsh', 'router');
  const routerBase = routerKeyBase(routerName);
  for (const api of routerAdapters) {
    const suf = adapterSuffix(api, routerAdapters);
    const key = `${routerBase}${suf}`;
    const dshModels = models.map(m => {
      const entry = { id: m.id, contextWindow: m.in, maxTokens: m.out, input: dshModelInputs(m) };
      if (!m.out) delete entry.maxTokens;
      return entry;
    });
    providers[key] = {
      displayName: `${simplifyName(routerName)}${suf}`,
      apiKeyEnv: envVar,
      api,
      baseURL: routerRow.base_url.replace(/\/$/, ''),
      models: dshModels,
    };
  }
  writeYamlFile(DSH_SETTINGS_FILE, settings);
  writeCredentialsFile(DSH_CREDENTIALS_FILE, creds);
  return { apis: routerAdapters.length, models: models.length };
}

async function syncDSHRestProviders() {
  if (!fs.existsSync(PROVIDERS_CSV)) throw new Error('providers.csv not found: ' + PROVIDERS_CSV);
  const rows = readProvidersCsv();
  const routerName = routerNameOf(rows);
  const modelRows = await getModelsForHarness('dsh', 0, 0, { applyTopN: false });
  writeHarnessPreview('dsh', modelRows);
  const byProvider = {};
  for (const row of rows) {
    if (routerName && row.provider === routerName) continue;
    if (!byProvider[row.provider]) byProvider[row.provider] = [];
    byProvider[row.provider].push(row);
  }
  const settings = readYamlFile(DSH_SETTINGS_FILE);
  if (!settings['llm-pi-ai'] || typeof settings['llm-pi-ai'] !== 'object') settings['llm-pi-ai'] = {};
  if (!settings['llm-pi-ai'].providers || typeof settings['llm-pi-ai'].providers !== 'object' || Array.isArray(settings['llm-pi-ai'].providers)) settings['llm-pi-ai'].providers = {};
  const providers = settings['llm-pi-ai'].providers;
  const creds = readCredentialsFile(DSH_CREDENTIALS_FILE);
  let count = 0;
  let totalModels = 0;
  const restAdapters = getAdapters('dsh', 'rest');
  for (const [provider, providerRows] of Object.entries(byProvider)) {
    const isSolo = isSoloRow(providerRows[0]);
    if (isSolo && !isSoloActive('dsh')) continue;
    if (!isSolo && !isRestActive('dsh')) continue;
    let providerModelCandidates;
    if (isSolo) {
      const soloCsv = soloFilteredCsvPath(provider);
      const soloRows = fs.existsSync(soloCsv) ? readModelsCsv(soloCsv) : [];
      providerModelCandidates = applyHarnessTopN(soloRows.filter(m => !m.id.endsWith('[1m]')), 'dsh');
    } else {
      const prefix = provider + '/';
      providerModelCandidates = applyHarnessTopN(modelRows.filter(m => m.id.startsWith(prefix) && !m.id.endsWith('[1m]')), 'dsh');
    }
    const simp = simplifyName(provider);
    providerRows.forEach((row, idx) => {
      const providerApis = getAdapters('dsh', isSolo ? 'solo' : 'rest', provider, idx, providerRows.length);
      for (const api of providerApis) {
        const key = `${PREFIX}${simp}${instancePart(idx, providerRows.length)}${adapterSuffix(api, providerApis)}`;
        const envVar = PREFIX_UPPER + (providerRows.length > 1 ? simp.toUpperCase() + '_' + (idx + 1) : simp.toUpperCase()) + '_API_KEY';
        creds.refs[envVar] = row.api_key;
        const dshModels = providerModelCandidates.map(m => {
          const modelId = isSolo ? m.id : m.id.slice(provider.length + 1);
          const entry = { id: modelId, contextWindow: m.in, maxTokens: m.out, input: dshModelInputs(m) };
          if (!m.out) delete entry.maxTokens;
          return entry;
        });
        const inst = instancePart(idx, providerRows.length);
        // displayName: for single instance keep bare provider; multi-instance keep -N; plus -adapter when multi-adapter.
        const instDisplay = (inst === '' ? '' : inst);
        const sufDisplay = adapterSuffix(api, providerApis);
        providers[key] = {
          displayName: `${simp}${instDisplay}${sufDisplay}`,
          apiKeyEnv: envVar,
          api,
          baseURL: row.base_url.replace(/\/$/, ''),
          models: dshModels,
        };
        count++;
        totalModels += dshModels.length;
      }
    });
  }
  writeYamlFile(DSH_SETTINGS_FILE, settings);
  writeCredentialsFile(DSH_CREDENTIALS_FILE, creds);
  return { apis: count, models: totalModels };
}

// ---------- pi sync ----------
// Pipeline: raw_catalog_harnesses OFF for pi -> model_filters -> models-filtered.csv -> harness_filters targeting pi + custom_models | ON -> bypass model_filters -> models-all.csv (or live GET {base_url}/models fallback) -> harness_filters + custom_models — live branch matches fetchRawModels dedup (parent!=null skip, __provider_ rewrite, compatible+owned_by rewrite).
async function syncPiRouter() {
  if (!fs.existsSync(PROVIDERS_CSV)) throw new Error('providers.csv not found: ' + PROVIDERS_CSV);
  const rows = readProvidersCsv();
  const routerRow = requireRouterRow(rows);
  const routerName = routerRow.provider;
  const modelRows = (await getModelsForHarness('pi')).filter(m => !m.id.endsWith('[1m]'));
  writeHarnessPreview('pi', modelRows);
  let doc = readJsonSafe(PI_FILE, { providers: {} });
  doc.providers = doc.providers && typeof doc.providers === 'object' && !Array.isArray(doc.providers) ? doc.providers : {};
  const routerAdapters = getAdapters('pi', 'router');
  for (const adapter of routerAdapters) {
    const key = `${routerKeyBase(routerName)}${adapterSuffix(adapter, routerAdapters)}`;
    doc.providers[key] = { name: key, baseUrl: routerRow.base_url, apiKey: routerRow.api_key, api: adapter, models: piModelsForSync(modelRows) };
  }
  ensureParentDir(PI_FILE); writeJsonFile(PI_FILE, doc); return { apis: routerAdapters.length || 1, models: modelRows.length };
}
async function syncPiRestProviders() {
  if (!fs.existsSync(PROVIDERS_CSV)) throw new Error('providers.csv not found: ' + PROVIDERS_CSV);
  const rows = readProvidersCsv();
  const routerName = routerNameOf(rows);
  const modelRows = (await getModelsForHarness('pi', 0, 0, { applyTopN: false })).filter(m => !m.id.endsWith('[1m]'));
  writeHarnessPreview('pi', modelRows);
  let doc = readJsonSafe(PI_FILE, { providers: {} });
  doc.providers = doc.providers && typeof doc.providers === 'object' && !Array.isArray(doc.providers) ? doc.providers : {};
  const byProvider = {};
  for (const row of rows) {
    if (routerName && row.provider === routerName) continue;
    if (!byProvider[row.provider]) byProvider[row.provider] = [];
    byProvider[row.provider].push(row);
  }
  const restAdapters = getAdapters('pi', 'rest');
  let count = 0;
  let totalModels = 0;
  for (const [providerName, providerRows] of Object.entries(byProvider)) {
    const isSolo = isSoloRow(providerRows[0]);
    if (isSolo && !isSoloActive('pi')) continue;
    if (!isSolo && !isRestActive('pi')) continue;
    let providerModels;
    if (isSolo) {
      const soloCsv = soloFilteredCsvPath(providerName);
      const soloRows = fs.existsSync(soloCsv) ? readModelsCsv(soloCsv) : [];
      providerModels = applyHarnessTopN(soloRows.filter(m => !m.id.endsWith('[1m]')), 'pi');
    } else {
      const prefix = providerName + '/';
      providerModels = applyHarnessTopN(modelRows.filter(m => m.id.startsWith(prefix)), 'pi');
    }
    providerRows.forEach((row, idx) => {
      const models = providerModels.map(m => {
        const modelId = isSolo ? m.id : m.id.slice(providerName.length + 1);
        return {
          id: modelId,
          name: modelId,
          reasoning: true,
          input: ['text', 'image'],
          cost: { input: 0, output: 0, cacheRead: 1, cacheWrite: 1 },
          contextWindow: m.in,
          maxTokens: m.out
        };
      });
      const providerAdapters = getAdapters('pi', isSolo ? 'solo' : 'rest', providerName, idx, providerRows.length);
      for (const adapter of providerAdapters) {
        const key = `${PREFIX}${simplifyName(providerName)}${instancePart(idx, providerRows.length)}${adapterSuffix(adapter, providerAdapters)}`;
        doc.providers[key] = { name: key, baseUrl: row.base_url, apiKey: row.api_key, api: adapter, models };
        count++;
        totalModels += models.length;
      }
    });
  }
  ensureParentDir(PI_FILE); writeJsonFile(PI_FILE, doc);
  return { apis: count, models: totalModels };
}

// ---------- opencodex sync ----------
// Pipeline: raw_catalog_harnesses OFF for ocx -> model_filters -> models-filtered.csv -> harness_filters targeting ocx + custom_models
//           ON -> bypass model_filters -> models-all.csv (or live GET {base_url}/models fallback) -> harness_filters + custom_models
async function syncOpencodexRouter() {
  if (!fs.existsSync(PROVIDERS_CSV)) throw new Error('providers.csv not found: ' + PROVIDERS_CSV);
  const rows = readProvidersCsv();
  const routerRow = requireRouterRow(rows);
  const routerName = routerRow.provider;
  const modelRows = (await getModelsForHarness('ocx')).filter((m) => !m.id.endsWith('[1m]'));
  writeHarnessPreview('ocx', modelRows);
  let doc = readJsonSafe(OPENCODEX_FILE, {});
  if (!doc.providers || typeof doc.providers !== 'object' || Array.isArray(doc.providers)) doc.providers = {};
  if (!Array.isArray(doc.customModels)) doc.customModels = [];
  const routerAdapters = getAdapters('opencodex', 'router');
  const routerKeys = [];
  const routerBase = routerKeyBase(routerName);
  for (const adapter of routerAdapters) {
    const key = `${routerBase}${adapterSuffix(adapter, routerAdapters)}`;
    routerKeys.push(key);
    doc.providers[key] = ocxProviderEntry(routerRow, adapter);
    // upsert customModels for this adapter key (router keeps full id)
    const existing = new Set(doc.customModels.filter((e) => e && e.provider === key).map((e) => e.modelId));
    const keepIds = new Set(modelRows.map((m) => m.id));
    // prune stale for this key
    doc.customModels = doc.customModels.filter((e) => { if (!e || e.provider !== key) return true; return keepIds.has(e.modelId); });
    const now = new Date().toISOString();
    for (const m of modelRows) {
      if (existing.has(m.id) && doc.customModels.some((e) => e.provider === key && e.modelId === m.id)) continue;
      if (existing.has(m.id)) continue;
      doc.customModels.push({ id: uuid4(), provider: key, modelId: m.id, addedAt: now });
    }
  }
  // Prune stale customModels for router keys no longer in routerKeys (adapter removed)
  {
    const live = new Set(routerKeys);
    const before = doc.customModels.length;
    doc.customModels = doc.customModels.filter((e) => { if (!e || !e.provider || !e.provider.startsWith(routerBase)) return true; // not a router key (rest etc.)
      // router key is c-<routerName> or c-<routerName>-<adapter>
      const rest = e.provider.slice(routerBase.length);
      if (rest === '' || rest.startsWith('-')) return live.has(e.provider);
      return true; // not a router adapter key (e.g. c-router-2)
    });
    void before;
  }
  doc.defaultProvider = routerKeys[0] || customKey(routerName);
  const didEnsure = ensureClaudeCodeProxy(doc);
  ensureParentDir(OPENCODEX_FILE);
  writeJsonFile(OPENCODEX_FILE, doc);
  maybeWarnClaudeSettings(didEnsure);
  return { apis: routerAdapters.length || 1, models: modelRows.length };
}

async function syncOpencodexRestProviders() {
  if (!fs.existsSync(PROVIDERS_CSV)) throw new Error('providers.csv not found: ' + PROVIDERS_CSV);
  const rows = readProvidersCsv();
  const routerName = routerNameOf(rows);
  const modelRows = (await getModelsForHarness('ocx', 0, 0, { applyTopN: false })).filter((m) => !m.id.endsWith('[1m]'));
  writeHarnessPreview('ocx', modelRows);
  const byProvider = {};
  for (const row of rows) {
    if (routerName && row.provider === routerName) continue;
    if (!byProvider[row.provider]) byProvider[row.provider] = [];
    byProvider[row.provider].push(row);
  }
  let doc = readJsonSafe(OPENCODEX_FILE, {});
  if (!doc.providers || typeof doc.providers !== 'object' || Array.isArray(doc.providers)) doc.providers = {};
  if (!Array.isArray(doc.customModels)) doc.customModels = [];
  const restAdapters = getAdapters('opencodex', 'rest');
  // create/update providers c_* keys for rest — instance outer, adapter inner
  for (const [provider, providerRows] of Object.entries(byProvider)) {
    const isSolo = isSoloRow(providerRows[0]);
    if (isSolo && !isSoloActive('opencodex')) continue;
    if (!isSolo && !isRestActive('opencodex')) continue;
    let providerModels;
    if (isSolo) {
      const soloCsv = soloFilteredCsvPath(provider);
      const soloRows = fs.existsSync(soloCsv) ? readModelsCsv(soloCsv) : [];
      providerModels = applyHarnessTopN(soloRows.filter((m) => !m.id.endsWith('[1m]')), 'ocx');
    } else {
      const prefix = provider + '/';
      providerModels = applyHarnessTopN(modelRows.filter((m) => m.id.startsWith(prefix)), 'ocx');
    }
    providerRows.forEach((row, idx) => {
      const providerAdapters = getAdapters('opencodex', isSolo ? 'solo' : 'rest', provider, idx, providerRows.length);
      for (const adapter of providerAdapters) {
        const key = `${PREFIX}${simplifyName(provider)}${instancePart(idx, providerRows.length)}${adapterSuffix(adapter, providerAdapters)}`;
        doc.providers[key] = ocxProviderEntry(row, adapter);
        const modelIds = new Set(providerModels.map((m) => isSolo ? m.id : m.id.slice(provider.length + 1)));
        doc.customModels = doc.customModels.filter((e) => {
          if (!e || e.provider !== key) return true;
          return modelIds.has(e.modelId);
        });
        const existing = new Set(doc.customModels.filter((e) => e.provider === key).map((e) => e.modelId));
        const now = new Date().toISOString();
        for (const bare of modelIds) {
          if (existing.has(bare)) continue;
          doc.customModels.push({ id: uuid4(), provider: key, modelId: bare, addedAt: now });
        }
      }
    });
  }
  ensureParentDir(OPENCODEX_FILE);
  writeJsonFile(OPENCODEX_FILE, doc);
  // ensure claudeCode proxy without clobbering — rest should also warn if proxy already set
  const didEnsure = ensureClaudeCodeProxy(doc);
  if (didEnsure) {
    // re-read not needed — doc already mutated and written; just ensure file has proxy
    // rewrite to include proxy if it was added
    writeJsonFile(OPENCODEX_FILE, doc);
  }
  maybeWarnClaudeSettings(didEnsure);
  const routerBase = routerName ? routerKeyBase(routerName) : null;
  const restKeys = Object.keys(doc.providers).filter(k => isManagedKey(k) && !(routerBase && k.startsWith(routerBase)));
  const totalModels = doc.customModels.filter(e => e && e.provider && isManagedKey(e.provider) && !(routerBase && e.provider.startsWith(routerBase))).length;
  return { apis: restKeys.length, models: totalModels };
}

// ---------- zcode sync (insert-if-missing + update; router keeps full id, REST strips its own prefix) ----------
// Matches providers by `name` starting with c- (covers UUID object keys) or by the object key itself.
// Missing providers are created with source:"custom"; legacy c_* names are recognized and renamed to c-*.
function zcodeCustomName(entry) {
  const n = entry && typeof entry.name === 'string' ? entry.name.trim() : '';
  return isManagedKey(n) ? n : '';
}
function zcodeLogicalName(key, entry) { return zcodeCustomName(entry) || key; }

async function syncZcodeRouter() {
  if (!fs.existsSync(PROVIDERS_CSV)) throw new Error('providers.csv not found: ' + PROVIDERS_CSV);
  const rows = readProvidersCsv();
  const routerRow = requireRouterRow(rows);
  const routerName = routerRow.provider;
  const modelRows = (await getModelsForHarness('zcode')).filter(m => !m.id.endsWith('[1m]'));
  writeHarnessPreview('zcode', modelRows);
  let doc = readJsonSafe(ZCODE_FILE, { provider: {} });
  doc.provider = doc.provider && typeof doc.provider === 'object' && !Array.isArray(doc.provider) ? doc.provider : {};
  const routerAdapters = getAdapters('zcode', 'router');
  // Single adapter: update the existing entry in place, or insert it if missing.
  // Multi-adapter: create one entry per adapter (kind = adapter).
  const models = zcodeRouterModelsForSync(modelRows);
  if (routerAdapters.length <= 1) {
    const routerCustom = customKey(routerName);
    const routerLegacy = LEGACY_PREFIX + simplifyName(routerName);
    let targetKey = null;
    if (routerCustom in doc.provider) targetKey = routerCustom;
    else {
      // legacy fallback: existing c_<router> entry gets updated and renamed to the new format
      if (routerLegacy in doc.provider) targetKey = routerLegacy;
      else {
        for (const k of Object.keys(doc.provider)) { if (zcodeLogicalName(k, doc.provider[k]) === routerCustom || zcodeLogicalName(k, doc.provider[k]) === routerLegacy) { targetKey = k; break; } }
        if (!targetKey) {
          const alt = routerCustom + '-1';
          const altLegacy = routerLegacy + '_1';
          if (alt in doc.provider) targetKey = alt;
          else if (altLegacy in doc.provider) targetKey = altLegacy;
          else for (const k of Object.keys(doc.provider)) { if (zcodeLogicalName(k, doc.provider[k]) === alt || zcodeLogicalName(k, doc.provider[k]) === altLegacy) { targetKey = k; break; } }
        }
      }
    }
    // insert if missing: create the router provider entry when no existing key matches
    if (!targetKey) targetKey = routerCustom;
    const adapter = routerAdapters[0] || 'openai-compatible';
    const isNewEntry = !(targetKey in doc.provider);
    const cur = doc.provider[targetKey] || {};
    cur.name = customKey(routerName) + adapterSuffix(adapter, routerAdapters);
    cur.kind = adapter;
    if (isNewEntry) cur.source = 'custom';
    cur.options = cur.options && typeof cur.options === 'object' && !Array.isArray(cur.options) ? cur.options : {};
    cur.options.apiKeyRequired = true;
    cur.options.baseURL = routerRow.base_url;
    cur.options.apiKey = routerRow.api_key;
    cur.models = models;
    doc.provider[targetKey] = cur;
    // rename the object key to the new format if it was found under a legacy/alt key
    if (targetKey !== routerCustom) {
      delete doc.provider[targetKey];
      doc.provider[routerCustom] = cur;
    }
    // if single -> bare key stays; if we added suffix but there was only one adapter now, keep bare (no suffix).
    ensureParentDir(ZCODE_FILE); writeJsonFile(ZCODE_FILE, doc); return { apis: routerAdapters.length || 1, models: modelRows.length };
  }
  // Multi-adapter: create one entry per adapter
  const routerBase = routerKeyBase(routerName);
  for (const adapter of routerAdapters) {
    const key = `${routerBase}${adapterSuffix(adapter, routerAdapters)}`;
    // Try to reuse any existing key with same logical name + same adapter, else create under that key.
    let targetKey = null;
    if (key in doc.provider) targetKey = key;
    else {
      for (const k of Object.keys(doc.provider)) { if (zcodeLogicalName(k, doc.provider[k]) === key) { targetKey = k; break; } }
      if (!targetKey) targetKey = key;
    }
    const cur = doc.provider[targetKey] || {};
    const isNewEntry = !doc.provider[targetKey];
    cur.name = key;
    cur.kind = adapter;
    if (isNewEntry) cur.source = 'custom';
    cur.options = cur.options && typeof cur.options === 'object' && !Array.isArray(cur.options) ? cur.options : {};
    cur.options.apiKeyRequired = true;
    cur.options.baseURL = routerRow.base_url;
    cur.options.apiKey = routerRow.api_key;
    cur.models = models;
    doc.provider[targetKey] = cur;
    // rename the object key to the new format if it was found under a different key
    if (targetKey !== key) {
      delete doc.provider[targetKey];
      doc.provider[key] = cur;
    }
  }
  ensureParentDir(ZCODE_FILE); writeJsonFile(ZCODE_FILE, doc); return { apis: routerAdapters.length || 1, models: modelRows.length };
}
async function syncZcodeRestProviders() {
  if (!fs.existsSync(PROVIDERS_CSV)) throw new Error('providers.csv not found: ' + PROVIDERS_CSV);
  const rows = readProvidersCsv();
  const routerName = routerNameOf(rows);
  const routerCustom = routerName ? customKey(routerName) : '';
  const routerCustom1 = routerCustom ? routerCustom + '-1' : '';
  const modelRows = (await getModelsForHarness('zcode', 0, 0, { applyTopN: false })).filter(m => !m.id.endsWith('[1m]'));
  writeHarnessPreview('zcode', modelRows);
  let doc = readJsonSafe(ZCODE_FILE, { provider: {} });
  doc.provider = doc.provider && typeof doc.provider === 'object' && !Array.isArray(doc.provider) ? doc.provider : {};
  const restAdapters = getAdapters('zcode', 'rest');
  const restAdaptersSimp = restAdapters.map((a) => simplifyName(a));
  // Keyed by simplified provider name — logical key names carry the simplified form.
  const routerSimp = routerName ? simplifyName(routerName) : '';
  const byProvider = {};
  for (const row of rows) {
    if (routerName && row.provider === routerName) continue;
    const s = simplifyName(row.provider);
    if (!s) continue;
    if (!byProvider[s]) byProvider[s] = [];
    byProvider[s].push(row);
  }
  for (const key of Object.keys(doc.provider)) {
    const logical = zcodeLogicalName(key, doc.provider[key]);
    if (!isManagedKey(logical)) continue;
    if (logical === routerCustom || logical === routerCustom1) continue;
    // REST logical is c-<provider>[-<N>][-<adapter>]. Strip adapter suffix first.
    let withoutAdapter = logical;
    let adapterForThisKey = null;
    if (logical.startsWith(PREFIX)) {
      const rest = logical.slice(PREFIX.length);
      for (const simp of [...restAdaptersSimp].sort((a, b) => b.length - a.length)) {
        if (rest.endsWith('-' + simp)) {
          adapterForThisKey = simp;
          withoutAdapter = logical.slice(0, -(simp.length + 1));
          break;
        }
      }
    }
    const { base, idx } = parseZcodeCustomKey(withoutAdapter);
    if (routerSimp && base === routerSimp) continue;
    const group = byProvider[base]; if (!group) continue;
    const row = group[idx - 1]; if (!row) continue;
    const isSolo = isSoloRow(row);
    if (isSolo && !isSoloActive('zcode')) continue;
    if (!isSolo && !isRestActive('zcode')) continue;
    let providerModels;
    if (isSolo) {
      const soloCsv = soloFilteredCsvPath(row.provider);
      const soloRows = fs.existsSync(soloCsv) ? readModelsCsv(soloCsv) : [];
      providerModels = applyHarnessTopN(soloRows.filter(m => !m.id.endsWith('[1m]')), 'zcode');
    } else {
      const prefix = base + '/';
      providerModels = applyHarnessTopN(modelRows.filter(m => m.id.startsWith(prefix)), 'zcode');
    }
    const models = {};
    for (const m of providerModels) {
      const bare = isSolo ? m.id : m.id.slice(base.length + 1);
      const dictKey = bare.includes('/') ? bare.split('/').pop() : bare;
      models[dictKey] = { limit: zcodeSanitizeLimit(m.in, m.out), modalities: { input: ['text', 'image', 'video'], output: ['text'] }, zcode: { modalitiesConfigured: true } };
    }
    const cur = doc.provider[key];
    // keep kind in sync when multiple adapters
    if (adapterForThisKey) {
      const raw = restAdapters[restAdaptersSimp.indexOf(adapterForThisKey)] || restAdapters[0];
      cur.kind = raw;
    }
    else if (restAdapters.length === 1) cur.kind = restAdapters[0];
    cur.options = cur.options && typeof cur.options === 'object' && !Array.isArray(cur.options) ? cur.options : {};
    cur.options.apiKeyRequired = true;
    cur.options.baseURL = row.base_url;
    cur.options.apiKey = row.api_key;
    cur.models = models;
  }
  // Insert pass: create entries for providers.csv rows that have no matching
  // c-* key yet (one entry per rest adapter, same key scheme as above).
  const existingLogicals = new Set(Object.keys(doc.provider).map(k => zcodeLogicalName(k, doc.provider[k])));
  for (const [base, group] of Object.entries(byProvider)) {
    if (routerSimp && base === routerSimp) continue;
    for (let idx = 1; idx <= group.length; idx++) {
      const row = group[idx - 1];
      const withoutAdapter = PREFIX + base + (idx > 1 ? `-${idx}` : '');
      const isSolo = isSoloRow(row);
      const providerAdapters = getAdapters('zcode', isSolo ? 'solo' : 'rest', row.provider, idx - 1, group.length);
      for (const adapter of providerAdapters) {
        const suffix = providerAdapters.length > 1 ? '-' + simplifyName(adapter) : '';
        const logical = withoutAdapter + suffix;
        if (existingLogicals.has(logical)) continue;
        const isSolo = isSoloRow(row);
        let providerModels;
        if (isSolo) {
          const soloCsv = soloFilteredCsvPath(row.provider);
          const soloRows = fs.existsSync(soloCsv) ? readModelsCsv(soloCsv) : [];
          providerModels = applyHarnessTopN(soloRows.filter(m => !m.id.endsWith('[1m]')), 'zcode');
        } else {
          const prefix = base + '/';
          providerModels = applyHarnessTopN(modelRows.filter(m => m.id.startsWith(prefix)), 'zcode');
        }
        const models = {};
        for (const m of providerModels) {
          const bare = isSolo ? m.id : m.id.slice(base.length + 1);
          const dictKey = bare.includes('/') ? bare.split('/').pop() : bare;
          models[dictKey] = { limit: zcodeSanitizeLimit(m.in, m.out), modalities: { input: ['text', 'image', 'video'], output: ['text'] }, zcode: { modalitiesConfigured: true } };
        }
        const objKey = logical in doc.provider ? logical + '-' + Object.keys(doc.provider).length : logical;
        doc.provider[objKey] = {
          name: logical,
          kind: adapter,
          source: 'custom',
          options: { baseURL: row.base_url, apiKey: row.api_key, apiKeyRequired: true },
          models,
        };
        existingLogicals.add(logical);
      }
    }
  }
  ensureParentDir(ZCODE_FILE); writeJsonFile(ZCODE_FILE, doc);
  const restKeys = Object.keys(doc.provider).filter(k => isManagedKey(zcodeLogicalName(k, doc.provider[k])) && !(routerCustom && (zcodeLogicalName(k, doc.provider[k]) === routerCustom || zcodeLogicalName(k, doc.provider[k]) === routerCustom1)));
  let totalModels = 0;
  for (const k of restKeys) {
    totalModels += Object.keys(doc.provider[k].models || {}).length;
  }
  return { apis: restKeys.length, models: totalModels };
}

// Helper: strip JSONC comments while preserving strings
function stripJsoncComments(jsonc) {
  let result = '';
  let inString = false;
  let escape = false;
  for (let i = 0; i < jsonc.length; i++) {
    const char = jsonc[i];
    const next = jsonc[i + 1];
    if (escape) { result += char; escape = false; continue; }
    if (char === '\\' && inString) { result += char; escape = true; continue; }
    if (char === '"' && !escape) { inString = !inString; result += char; continue; }
    if (!inString && char === '/' && next === '/') {
      while (i < jsonc.length && jsonc[i] !== '\n') i++;
      continue;
    }
    if (!inString && char === '/' && next === '*') {
      i += 2;
      while (i < jsonc.length - 1 && !(jsonc[i] === '*' && jsonc[i + 1] === '/')) i++;
      i += 1;
      continue;
    }
    result += char;
  }
  return result;
}

async function syncT3Models(minInput = 0, minOutput = 0) {
  const models = await getModelsForHarness('t3', minInput, minOutput);
  const filtered = models;
  writeHarnessPreview('t3', filtered);

  const customModels = [];
  for (const m of filtered) {
    customModels.push(m.id);
    if (m.in >= 1000000) {
      customModels.push(m.id + '[1m]');
    }
  }

  let settings = {};
  if (fs.existsSync(T3_SETTINGS_FILE)) {
    try {
      settings = JSON.parse(fs.readFileSync(T3_SETTINGS_FILE, 'utf8'));
    } catch (e) {
      throw new Error('Failed to parse ' + T3_SETTINGS_FILE + ': ' + e.message);
    }
  }

  if (!settings.providerInstances) settings.providerInstances = {};
  ensureRouterInstances(settings);
  const rows = readProvidersCsv();
  const routerName = routerNameOf(rows);
  const routerBase = routerName ? routerKeyBase(routerName) : null;
  const routerEntries = Object.entries(settings.providerInstances).filter(([k]) => routerName && k.startsWith(routerBase + '-'));
  for (const [key, instance] of routerEntries) {
    if (!instance.config) instance.config = {};
    const driverSimp = key.slice(routerBase.length + 1);
    const driverEntry = T3_ROUTER_DRIVERS.find(e => e && typeof e === 'object' && simplifyName(e.driver) === driverSimp);
    const supports1m = driverEntry ? !!driverEntry['1m'] : true;
    const modelsForDriver = supports1m
      ? customModels
      : customModels.filter(m => !m.endsWith('[1m]'));
    instance.config.customModels = modelsForDriver;
  }
  sortProviderInstances(settings);

  fs.mkdirSync(path.dirname(T3_SETTINGS_FILE), { recursive: true });
  fs.writeFileSync(T3_SETTINGS_FILE, JSON.stringify(settings, null, 2) + '\n', 'utf8');
  return { apis: routerEntries.length || 1, models: customModels.length };
}

// ---------- run ----------
// Usage:
//   node omnilist.js                 -> DEFAULT: fetch models -> models-filtered.csv only
//   node omnilist.js opencode        -> sync router model block into opencode.jsonc
//   node omnilist.js kilo            -> sync router model block into kilo.jsonc
//   node omnilist.js kilopro         -> copy provider{} block opencode -> kilo
//   node omnilist.js t3              -> sync flat model list into t3 claudeAgent
//   node omnilist.js t3pro           -> t3 flat list + per-provider c-* instances
//   node omnilist.js all             -> fetch + opencode + kilo + t3
//   node omnilist.js allpro          -> fetch + opencode + kilo + kilopro + t3pro
//   node omnilist.js opencode kilo   -> combine targets (space-separated)
//
// Filters (default min-input-context is 200000; pass 0 to disable):
//   node omnilist.js -mi 100000       -> override min input context
//   node omnilist.js --min-output-limit 8192
//
// Help and info:
//   node omnilist.js help             -> print this usage
//   node omnilist.js -h / --help      -> same
//
// Legacy numeric steps still work as hidden aliases:
//   1=fetch  2=opencode+kilo  3=t3  4=t3rest  (1-4)

// ---------- install as command ----------
// INSTALL_AS_COMMAND = true auto-runs this; can also be triggered manually:
//   node omnilist.js install | uninstall
// Runs PowerShell via -EncodedCommand so backslashes / quotes are NEVER
// mangled (a plain -Command string with JSON-escaped paths corrupts the
// User PATH with doubled backslashes).
function runPs(script) {
  const encoded = Buffer.from(script, 'utf16le').toString('base64');
  return execFileSync('powershell.exe', [
    '-NoProfile', '-NonInteractive', '-EncodedCommand', encoded,
  ], { encoding: 'utf8', windowsHide: true });
}

function getUserPath() {
  const out = runPs('[Environment]::GetEnvironmentVariable("Path","User")');
  return (out || '').trim();
}

function setUserPath(value) {
  runPs(`[Environment]::SetEnvironmentVariable("Path", '${value.replace(/'/g, "''")}', "User")`);
}

// Split, trim, collapse any doubled backslashes (self-heal old corruption),
// and dedupe PATH entries.
function normalizePathEntries(userPath) {
  const seen = new Set();
  const cleaned = [];
  for (const raw of (userPath || '').split(';')) {
    const e = raw.trim().replace(/\\{2,}/g, '\\');
    if (e.length === 0 || seen.has(e)) continue;
    seen.add(e);
    cleaned.push(e);
  }
  return cleaned;
}

function buildShimContent() {
  const scriptPath = path.join(PROJECT_ROOT, 'src', 'omnilist.js');
  return '@echo off\r\nnode "' + scriptPath + '" %*\r\n';
}

function shimUpToDate(shimPath) {
  if (!fs.existsSync(shimPath)) return false;
  return fs.readFileSync(shimPath, 'utf8') === buildShimContent();
}

function writeShim(targetDir) {
  const shimPath = path.join(targetDir, CLI_COMMAND_NAME + '.cmd');
  fs.writeFileSync(shimPath, buildShimContent(), 'utf8');
  return shimPath;
}

// quiet = true when auto-run (INSTALL_AS_COMMAND): prints nothing if already installed.
function installAsCommand(quiet) {
  const scriptDir = PROJECT_ROOT;
  const changed = [];
  const unchanged = [];

  const localShim = path.join(scriptDir, CLI_COMMAND_NAME + '.cmd');
  if (shimUpToDate(localShim)) {
    unchanged.push(localShim + ' (already up to date)');
  } else {
    writeShim(scriptDir);
    changed.push(localShim);
  }

  const userPath = getUserPath();
  const entries = normalizePathEntries(userPath);
  const cleaned = entries.join(';');
  if (!entries.includes(scriptDir)) {
    entries.push(scriptDir);
    setUserPath(entries.join(';'));
    changed.push('User PATH += ' + scriptDir);
  } else if (cleaned !== userPath) {
    setUserPath(cleaned);
    changed.push('User PATH normalized');
  } else {
    unchanged.push('User PATH already contains ' + scriptDir);
  }

  const npmDir = path.join(home, 'AppData', 'Roaming', 'npm');
  if (fs.existsSync(npmDir)) {
    const npmShim = path.join(npmDir, CLI_COMMAND_NAME + '.cmd');
    if (shimUpToDate(npmShim)) {
      unchanged.push(npmShim + ' (already up to date)');
    } else {
      writeShim(npmDir);
      changed.push(npmShim);
    }
  }

  if (changed.length > 0) {
    console.log('Installed "' + CLI_COMMAND_NAME + '" command:');
    for (const r of changed) console.log('  - ' + r);
    console.log('Run it from any terminal:  ' + CLI_COMMAND_NAME + ' help');
  } else if (!quiet) {
    console.log('"' + CLI_COMMAND_NAME + '" command is already installed (nothing to do).');
  }
  return changed.length > 0;
}

function uninstallAsCommand() {
  const scriptDir = PROJECT_ROOT;
  const removed = [];

  const localShim = path.join(scriptDir, CLI_COMMAND_NAME + '.cmd');
  if (fs.existsSync(localShim)) { fs.unlinkSync(localShim); removed.push(localShim); }

  const npmShim = path.join(home, 'AppData', 'Roaming', 'npm', CLI_COMMAND_NAME + '.cmd');
  if (fs.existsSync(npmShim)) { fs.unlinkSync(npmShim); removed.push(npmShim); }

  const userPath = getUserPath();
  const entries = normalizePathEntries(userPath).filter((e) => e !== scriptDir);
  const cleaned = entries.join(';');
  if (cleaned !== userPath) setUserPath(cleaned);

  console.log('Uninstalled "' + CLI_COMMAND_NAME + '":');
  for (const r of removed) console.log('  - removed ' + r);
  console.log('  - removed ' + scriptDir + ' from User PATH');
}

// ---------- model clearing & custom commands ----------
function clearModelBlock(targetFile) {
  if (!fs.existsSync(targetFile)) return 0;
  const lines = fs.readFileSync(targetFile, 'utf8').split('\n');
  const out = [];
  let inModels = false;
  let inBlock = false;
  let i = 0;
  let cleared = 0;

  while (i < lines.length) {
    const line = lines[i];

    if (!inModels && /"models"\s*:\s*\{/.test(line)) {
      inModels = true;
      out.push(line);
      i++;
      continue;
    }

    if (inModels && !inBlock) {
      if (/\/\/\s*start-here/.test(line)) {
        inBlock = true;
        out.push(line);
        i++;
        while (i < lines.length) {
          const ll = lines[i];
          if (/\/\/\s*end-here/.test(ll)) {
            out.push(ll);
            inBlock = false;
            i++;
            break;
          }
          cleared++;
          i++;
        }
        continue;
      }
      out.push(line);
      i++;
      continue;
    }

    if (inModels && inBlock) {
      if (/\/\/\s*end-here/.test(line)) {
        out.push(line);
        inBlock = false;
      }
      i++;
      continue;
    }

    out.push(line);
    i++;
  }

  const text = out.join('\n');
  const clean = text.charCodeAt(0) === 0xFEFF ? text.slice(1) : text;
  fs.writeFileSync(targetFile, clean, 'utf8');
  return cleared;
}

async function cleanAllModels() {
  console.log('--- Cleaning all models added by omnilist across harnesses ---');

  // 1. OpenCode
  if (OPENCODE_FILE && fs.existsSync(OPENCODE_FILE)) {
    const n = clearModelBlock(OPENCODE_FILE);
    console.log(`[OpenCode] Cleared models between markers in ${OPENCODE_FILE} (${n} lines removed)`);
  }

  // 2. Kilo
  if (KILO_FILE && fs.existsSync(KILO_FILE)) {
    const n = clearModelBlock(KILO_FILE);
    console.log(`[Kilo] Cleared models between markers in ${KILO_FILE} (${n} lines removed)`);
  }

  // 3. T3
  if (T3_SETTINGS_FILE && fs.existsSync(T3_SETTINGS_FILE)) {
    try {
      const settings = JSON.parse(fs.readFileSync(T3_SETTINGS_FILE, 'utf8'));
      if (settings.providerInstances) {
        const rows = fs.existsSync(PROVIDERS_CSV) ? readProvidersCsv() : [];
        const routerName = routerNameOf(rows);
        const routerBase = routerName ? routerKeyBase(routerName) : null;
        for (const [key, inst] of Object.entries(settings.providerInstances)) {
          if (routerBase && key.startsWith(routerBase + '-') && inst.config) {
            inst.config.customModels = [];
          }
        }
        fs.writeFileSync(T3_SETTINGS_FILE, JSON.stringify(settings, null, 2) + '\n', 'utf8');
        console.log(`[T3] Cleared customModels on router instances in ${T3_SETTINGS_FILE}`);
      }
    } catch (e) {
      console.warn(`[T3] Failed to clear models: ${e.message}`);
    }
  }

  // 4. DSH
  if (DSH_SETTINGS_FILE && fs.existsSync(DSH_SETTINGS_FILE)) {
    try {
      const settings = readYamlFile(DSH_SETTINGS_FILE);
      if (settings['llm-pi-ai'] && settings['llm-pi-ai'].providers) {
        const rows = fs.existsSync(PROVIDERS_CSV) ? readProvidersCsv() : [];
        const routerName = routerNameOf(rows);
        const routerSimp = routerName ? simplifyName(routerName) : null;
        if (routerSimp && settings['llm-pi-ai'].providers[routerSimp]) {
          settings['llm-pi-ai'].providers[routerSimp].models = [];
          writeYamlFile(DSH_SETTINGS_FILE, settings);
          console.log(`[DSH] Cleared router models in ${DSH_SETTINGS_FILE}`);
        }
      }
    } catch (e) {
      console.warn(`[DSH] Failed to clear models: ${e.message}`);
    }
  }

  // 5. pi
  if (PI_FILE && fs.existsSync(PI_FILE)) {
    try {
      const doc = readJsonSafe(PI_FILE, {});
      if (doc.providers) {
        const rows = fs.existsSync(PROVIDERS_CSV) ? readProvidersCsv() : [];
        const routerName = routerNameOf(rows);
        if (routerName && doc.providers[routerName]) {
          doc.providers[routerName].models = [];
          writeJsonFile(PI_FILE, doc);
          console.log(`[pi] Cleared router models in ${PI_FILE}`);
        }
      }
    } catch (e) {
      console.warn(`[pi] Failed to clear models: ${e.message}`);
    }
  }

  // 6. zcode
  if (ZCODE_FILE && fs.existsSync(ZCODE_FILE)) {
    try {
      const doc = readJsonSafe(ZCODE_FILE, {});
      if (doc.provider) {
        const rows = fs.existsSync(PROVIDERS_CSV) ? readProvidersCsv() : [];
        const routerName = routerNameOf(rows);
        if (routerName && doc.provider[routerName]) {
          doc.provider[routerName].models = [];
          writeJsonFile(ZCODE_FILE, doc);
          console.log(`[zcode] Cleared router models in ${ZCODE_FILE}`);
        }
      }
    } catch (e) {
      console.warn(`[zcode] Failed to clear models: ${e.message}`);
    }
  }

  // 7. ocx
  if (OPENCODEX_FILE && fs.existsSync(OPENCODEX_FILE)) {
    try {
      const doc = readJsonSafe(OPENCODEX_FILE, {});
      let changed = false;
      if (Array.isArray(doc.customModels) && doc.customModels.length > 0) {
        doc.customModels = [];
        changed = true;
      }
      const rows = fs.existsSync(PROVIDERS_CSV) ? readProvidersCsv() : [];
      const routerName = routerNameOf(rows);
      if (routerName && doc.providers && doc.providers[routerName]) {
        doc.providers[routerName].models = [];
        changed = true;
      }
      if (changed) {
        writeJsonFile(OPENCODEX_FILE, doc);
        console.log(`[ocx] Cleared router models and customModels in ${OPENCODEX_FILE}`);
      }
    } catch (e) {
      console.warn(`[ocx] Failed to clear models: ${e.message}`);
    }
  }

  // 8. Reconcile script-managed c-* REST providers
  if (fs.existsSync(PROVIDERS_CSV)) {
    try {
      const n = cleanupProviders();
      console.log(`Reconciled script-managed providers (${n} removed)`);
    } catch (e) {
      console.warn(`[cleanupProviders] Warning: ${e.message}`);
    }
  }

  // 9. Remove previews, filtered CSV, and any solo catalog CSVs
  cleanupHarnessPreviews();
  if (fs.existsSync(MODELS_CSV)) {
    try {
      fs.unlinkSync(MODELS_CSV);
      console.log(`Removed filtered catalog CSV: ${MODELS_CSV}`);
    } catch (_) {}
  }
  const csvDir = path.dirname(MODELS_CSV);
  if (fs.existsSync(csvDir)) {
    for (const f of fs.readdirSync(csvDir)) {
      if (/^models-(all|filtered)-.+\.csv$/.test(f)) {
        try {
          fs.unlinkSync(path.join(csvDir, f));
          console.log(`Removed solo catalog CSV: ${f}`);
        } catch (_) {}
      }
    }
  }

  console.log('Finished cleaning all script-added models across harnesses.');
}

async function runCustomCommands() {
  const list = Array.isArray(cfg.custom_commands) ? cfg.custom_commands.filter((s) => typeof s === 'string' && s.trim()) : [];
  if (list.length === 0) {
    console.log('[custom_commands] No custom commands configured.');
    return false;
  }
  console.log(`--- Running ${list.length} custom command(s) ---`);
  let hasFailed = false;
  const sleepMatch = /^sleep\s+([0-9]+(?:\.[0-9]+)?)$/i;
  const bgMatch = /^bg:\s*(.+)$/i;
  for (const entry of list) {
    const trimmed = entry.trim();
    if (trimmed.startsWith('#') || trimmed.startsWith('//')) {
      console.log(`[custom_commands] Skipped disabled command: ${trimmed}`);
      continue;
    }
    try {
      const m = sleepMatch.exec(entry);
      if (m) {
        const secs = parseFloat(m[1]);
        console.log(`[custom_commands] Sleeping for ${secs}s...`);
        await new Promise((r) => setTimeout(r, secs * 1000));
        continue;
      }
      const bg = bgMatch.exec(entry);
      const cmd = bg ? bg[1] : entry;
      console.log(`[custom_commands] ${bg ? 'Launching in background' : 'Running'}: ${cmd}`);
      const { spawn } = require('child_process');
      if (bg) {
        if (process.platform === 'win32') {
          const workingDir = process.cwd();
          const escapedBackticks = cmd.replace(/`/g, '``');
          const inner = `cmd.exe /c "${escapedBackticks}"`;
          const psCmd = `Start-Process cmd -ArgumentList '${inner}' -WindowStyle Hidden -WorkingDirectory '${workingDir}'`;
          const encoded = Buffer.from(psCmd, 'utf16le').toString('base64');
          let psStderr = '';
          const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded], {
            stdio: ['ignore', 'ignore', 'pipe'],
            windowsHide: true,
          });
          child.stderr.on('data', (d) => (psStderr += d));
          const bgExitCode = await new Promise((resolve) => {
            child.on('error', (err) => resolve({ err }));
            child.on('close', (exitCode) => resolve({ exitCode }));
          });
          if (bgExitCode.err) {
            console.error(`[custom_commands] FAILED to start background "${cmd}": ${bgExitCode.err.message}`);
            hasFailed = true;
          } else if (bgExitCode.exitCode !== 0) {
            console.error(`[custom_commands] Background launch wrapper FAILED (exit ${bgExitCode.exitCode}): ${cmd}`);
            if (psStderr.trim()) console.error(`[custom_commands] Wrapper output:\n${psStderr.trim()}`);
            hasFailed = true;
          } else {
            console.log(`[custom_commands] Background launched: ${cmd}`);
          }
          continue;
        } else {
          const child = spawn(cmd, { shell: true, detached: true, stdio: 'ignore' });
          child.unref();
          console.log(`[custom_commands] Background launched: ${cmd}`);
          continue;
        }
      }
      const child = spawn(cmd, { shell: true, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
      const captured = { stdout: '', stderr: '' };
      child.stdout.on('data', (d) => (captured.stdout += d));
      child.stderr.on('data', (d) => (captured.stderr += d));
      const code = await new Promise((resolve) => {
        child.on('error', (err) => resolve({ err }));
        child.on('close', (exitCode) => resolve({ exitCode }));
      });
      if (code.err) {
        hasFailed = true;
        console.error(`[custom_commands] FAILED to start "${cmd}": ${code.err.message}`);
      } else if (code.exitCode !== 0) {
        hasFailed = true;
        console.error(`[custom_commands] FAILED (exit ${code.exitCode}): ${cmd}`);
        const out = (captured.stdout + captured.stderr).trim();
        if (out) console.error(`[custom_commands] Output of "${cmd}":\n${out}`);
      } else {
        console.log(`[custom_commands] OK (exit 0): ${cmd}`);
      }
    } catch (e) {
      hasFailed = true;
      console.warn(`[custom_commands] Failed to launch "${cmd}": ${e.message}`);
    }
  }
  return hasFailed;
}

// ---------- usage ----------
function printUsage() {
  console.log(`
${CLI_COMMAND_NAME} — fetch model catalogs and sync into AI harness configs

Usage:
  ${CLI_COMMAND_NAME} setup                 Initial interactive setup, then offers to run the first sync
  ${CLI_COMMAND_NAME} run [options]         Run the full sync pipeline
  ${CLI_COMMAND_NAME} [targets...] [options] Run specific sync targets
  ${CLI_COMMAND_NAME} start [port]          Start GUI in background and run sync pipeline
  ${CLI_COMMAND_NAME} gui [port]            Start GUI in background only
  ${CLI_COMMAND_NAME} stop [port]           Stop running GUI server
  ${CLI_COMMAND_NAME} restart [port]        Stop and relaunch GUI server in background
  ${CLI_COMMAND_NAME} install               Register "${CLI_COMMAND_NAME}" as a global command
  ${CLI_COMMAND_NAME} uninstall             Remove the registered command
  ${CLI_COMMAND_NAME} -h, --help            Print this help

Harness Targets:
  opencode        Sync OpenCode (configured settings or --router, --solo, --rest)
  kilo            Sync Kilo (configured settings or --router, --solo, --rest)
  t3              Sync T3 (configured settings or --router, --solo, --rest)
  dsh             Sync DSH (configured settings or --router, --solo, --rest)
  pi              Sync pi agent (configured settings or --router, --solo, --rest)
  zcode           Sync zcode (configured settings or --router, --solo, --rest)
  opencodex / ocx Sync opencodex (configured settings or --router, --solo, --rest)

Target Mode Options:
  --router        Sync only router models/providers for selected harness(es)
  --solo          Sync only solo provider models/blocks for selected harness(es)
  --rest          Sync only rest provider models/blocks for selected harness(es)
  (If no mode flag is given, runs all modes enabled in config for that harness)

Other Targets:
  fetch           Fetch models -> models-filtered.csv from Router {base_url}/models
  cleanmodels     Clean models catalog
  cleanupproviders Reconcile script-managed c-* providers
  cleanup         Delete transient files (e.g. T3 logs dir)
  commands        Run configured custom commands
  all             Run all enabled targets

Options:
  -mi, --min-input-context N   Skip models with input context < N (default: 0 = none)
  -mo, --min-output-limit N    Skip models with output < N (default: 0 = none)
  -p,  --port N                Port for the GUI dashboard (default: 55555, auto-increments if busy)
       --clean / --noclean     Enable/disable cleanup step (default: --clean)

Configuration:
  config/config.jsonc     Main active configuration
  config/default.jsonc    Baseline defaults (updated via "Push as Default")
  config/config.local.jsonc Personal overrides (gitignored, layered on top)

Examples:
  ${CLI_COMMAND_NAME} setup                # run initial setup wizard
  ${CLI_COMMAND_NAME} run                  # fetch + sync all enabled targets + cleanup
  ${CLI_COMMAND_NAME} run --solo           # run sync pipeline for solo mode only
  ${CLI_COMMAND_NAME} opencode             # sync OpenCode using configured settings
  ${CLI_COMMAND_NAME} opencode --router    # sync OpenCode router provider only
  ${CLI_COMMAND_NAME} opencode --solo      # sync OpenCode solo providers only
  ${CLI_COMMAND_NAME} opencode --rest      # sync OpenCode REST providers only
  ${CLI_COMMAND_NAME} ocx --solo --rest    # sync opencodex solo and rest providers
  ${CLI_COMMAND_NAME} fetch opencode       # fetch and sync OpenCode
  ${CLI_COMMAND_NAME} gui                  # open web dashboard in background
  ${CLI_COMMAND_NAME} stop                 # stop running GUI server
  ${CLI_COMMAND_NAME} restart              # stop and relaunch GUI server
  setup.cmd                     # initial interactive setup launcher
  node src/${CLI_COMMAND_NAME}.js setup    # run setup directly with node
`);
}


// Atomic targets, in fixed execution order:
function buildOrder() {
  const order = ['fetch', 'cleanup'];
  const harnesses = ['opencode', 'kilo', 't3', 'dsh', 'pi', 'zcode', 'opencodex'];
  for (const h of harnesses) {
    const targets = targetsForHarness(h);
    for (const tgt of targets) {
      const idx = order.indexOf('cleanup');
      order.splice(idx, 0, tgt);
    }
  }
  const cleanupIdx = order.indexOf('cleanup');
  order.splice(cleanupIdx, 0, 'cleanupproviders');
  order.push('commands');
  return order;
}

// CLI word -> atomic targets
const WORD_MAP = {
  fetch: ['fetch'],
  opencode: ['opencode'],
  opencoderest: ['opencoderest'],
  kilo: ['kilo'],
  kilorest: ['kilorest'],
  kilopro: ['kilopro'],
  t3: ['t3models'],
  t3rest: ['t3models', 't3rest'],
  t3models: ['t3models'],
  dsh: ['dsh'],
  dshrest: ['dshrest'],
  dshrouter: ['dsh'],
  pi: ['pi'],
  pirest: ['pirest'],
  zcode: ['zcode'],
  zcoderest: ['zcoderest'],
  opencodex: ['opencodex'],
  opencodexrest: ['opencodexrest'],
  ocx: ['opencodex', 'opencodexrest'],
  ocxrest: ['opencodexrest'],
  cleanup: ['cleanup'],
  cleanupproviders: ['cleanupproviders'],
  cleanmodels: ['cleanmodels'],
  removemodels: ['cleanmodels'],
  commands: ['commands'],
  custom_commands: ['commands'],
  gui: ['gui'],
  stop: ['stop'],
  restart: ['restart'],
  install: ['install'],
  uninstall: ['uninstall'],
  get all() {
    return buildOrder();
  },
  get allpro() {
    return buildOrder();
  },
};

// Legacy numeric step -> atomic targets
const NUM_MAP = {
  1: ['fetch'],
  2: ['opencode', 'kilo'],
  3: ['t3models'],
  4: ['t3models', 't3rest'],
};

function getSavedGuiPort() {
  const portFile = path.join(PROJECT_ROOT, '.gui.port');
  try {
    if (fs.existsSync(portFile)) {
      const p = parseInt(fs.readFileSync(portFile, 'utf8').trim(), 10);
      if (!isNaN(p) && p > 0) return p;
    }
  } catch (e) {}
  return 0;
}

function getSavedGuiPid() {
  const pidFile = path.join(PROJECT_ROOT, '.gui.pid');
  try {
    if (fs.existsSync(pidFile)) {
      const p = parseInt(fs.readFileSync(pidFile, 'utf8').trim(), 10);
      if (!isNaN(p) && p > 0) return p;
    }
  } catch (e) {}
  return 0;
}

function cleanGuiFiles() {
  try {
    const pf = path.join(PROJECT_ROOT, '.gui.port');
    if (fs.existsSync(pf)) fs.unlinkSync(pf);
  } catch (e) {}
  try {
    const pidf = path.join(PROJECT_ROOT, '.gui.pid');
    if (fs.existsSync(pidf)) fs.unlinkSync(pidf);
  } catch (e) {}
}

function findPidByPort(port) {
  try {
    const { execSync } = require('child_process');
    const out = execSync('netstat -ano -p tcp', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    for (const line of out.split(/\r?\n/)) {
      if (line.includes(`:${port}`) && line.includes('LISTENING')) {
        const parts = line.trim().split(/\s+/);
        const pid = parseInt(parts[parts.length - 1], 10);
        if (!isNaN(pid) && pid > 0) return pid;
      }
    }
  } catch (e) {}
  return 0;
}

function checkGuiRunning(port) {
  return new Promise((resolve) => {
    const http = require('http');
    const req = http.get(`http://127.0.0.1:${port}/api/ping`, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => {
        try {
          const j = JSON.parse(data);
          if (j && j.app === 'omnilist') return resolve(j);
        } catch (e) {}
        resolve(res.statusCode >= 200 && res.statusCode < 500);
      });
    });
    req.on('error', () => resolve(false));
    req.setTimeout(1500, () => {
      try { req.destroy(); } catch (e) {}
      resolve(false);
    });
  });
}

function shutdownPort(port, pid) {
  return new Promise((resolve) => {
    const http = require('http');
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port: port,
        path: '/api/shutdown',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': 0,
        },
        timeout: 1500,
      },
      () => {}
    );
    req.on('error', () => {});
    req.on('timeout', () => {
      try { req.destroy(); } catch (e) {}
    });
    req.end();

    let attempts = 0;
    const interval = setInterval(async () => {
      attempts++;
      const stillRunning = await checkGuiRunning(port);
      if (!stillRunning) {
        clearInterval(interval);
        cleanGuiFiles();
        console.log(`\n  Omnilist GUI on port ${port} has been stopped.\n`);
        return resolve(true);
      }
      if (attempts >= 10) { // 1 second
        clearInterval(interval);
        const killPid = pid || getSavedGuiPid() || findPidByPort(port);
        if (killPid) {
          try {
            process.kill(killPid, 'SIGTERM');
          } catch (e) {
            try {
              const { execSync } = require('child_process');
              execSync(`taskkill /F /PID ${killPid}`, { stdio: 'ignore' });
            } catch (err) {}
          }
        }
        cleanGuiFiles();
        console.log(`\n  Omnilist GUI on port ${port} has been stopped.\n`);
        return resolve(true);
      }
    }, 100);
  });
}

async function stopGui(specifiedPort) {
  const savedPort = getSavedGuiPort();
  const portsToCheck = [];
  if (specifiedPort) {
    portsToCheck.push(specifiedPort);
  } else {
    if (savedPort) portsToCheck.push(savedPort);
    if (!portsToCheck.includes(55555)) portsToCheck.push(55555);
  }

  let stoppedAny = false;
  for (const p of portsToCheck) {
    const running = await checkGuiRunning(p);
    if (running) {
      const pid = (typeof running === 'object' && running.pid) || getSavedGuiPid() || findPidByPort(p);
      await shutdownPort(p, pid);
      stoppedAny = true;
    }
  }

  cleanGuiFiles();
  if (!stoppedAny) {
    console.log(`\n  No running Omnilist GUI found.\n`);
    return false;
  }
  return true;
}

async function restartGui(specifiedPort) {
  const savedPort = getSavedGuiPort();
  const targetPort = specifiedPort || savedPort || 55555;

  const portsToCheck = [targetPort];
  if (savedPort && savedPort !== targetPort) portsToCheck.push(savedPort);

  for (const p of portsToCheck) {
    const running = await checkGuiRunning(p);
    if (running) {
      const pid = (typeof running === 'object' && running.pid) || getSavedGuiPid() || findPidByPort(p);
      await shutdownPort(p, pid);
      await new Promise((r) => setTimeout(r, 250));
    }
  }

  cleanGuiFiles();
  console.log(`\n  Relaunching Omnilist GUI...`);
  return await startGuiInBackground({ port: targetPort, forceFresh: true });
}

function startGuiInBackground(opts) {
  const wantedPort = (opts && opts.port) || 55555;
  const forceFresh = !!(opts && opts.forceFresh);
  return new Promise(async (resolve, reject) => {
    if (!forceFresh) {
      const savedPort = getSavedGuiPort();
      const portsToCheck = [];
      if (wantedPort) portsToCheck.push(wantedPort);
      if (savedPort && !portsToCheck.includes(savedPort)) portsToCheck.unshift(savedPort);

      for (const p of portsToCheck) {
        if (await checkGuiRunning(p)) {
          console.log(`\n  Omnilist GUI is already running at:  http://127.0.0.1:${p}\n`);
          return resolve(p);
        }
      }
    }
    cleanGuiFiles();
    const { spawn } = require('child_process');
    let guiScript = path.join(__dirname, 'gui.js');
    if (!fs.existsSync(guiScript)) {
      const candidates = [
        path.join(PROJECT_ROOT, 'src', 'gui.js'),
        path.join(PROJECT_ROOT, 'gui.js'),
      ];
      for (const c of candidates) {
        if (fs.existsSync(c)) {
          guiScript = c;
          break;
        }
      }
    }
    const child = spawn(process.execPath, [guiScript, String(wantedPort)], {
      cwd: PROJECT_ROOT,
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    });
    try { child.unref(); } catch (e) {}

    const portFile = path.join(PROJECT_ROOT, '.gui.port');
    const start = Date.now();
    const checkInterval = setInterval(async () => {
      let activePort = wantedPort;
      try {
        if (fs.existsSync(portFile)) {
          const filePort = parseInt(fs.readFileSync(portFile, 'utf8').trim(), 10);
          if (!isNaN(filePort) && filePort > 0) activePort = filePort;
        }
      } catch (e) {}

      const running = await checkGuiRunning(activePort);
      if (running) {
        clearInterval(checkInterval);
        console.log(`\n  Omnilist GUI running at:  http://127.0.0.1:${activePort} (background)\n`);
        return resolve(activePort);
      }
      if (Date.now() - start > 6000) {
        clearInterval(checkInterval);
        reject(new Error(`Timed out waiting for GUI server to start on port ${wantedPort}`));
      }
    }, 150);
  });
}

function parseArgs() {
  const args = {
    targets: new Set(),
    minInput: 0,
    minOutput: 0,
    cleanup: CLEANUP_DEFAULT,
    port: 0,
    action: 'run',
  };
  const raw = process.argv.slice(2).filter((a) => a.length > 0);

  // Bare invocation with no arguments: show error + help
  if (raw.length === 0) {
    console.error(`error: expected a command or flag\n`);
    printUsage();
    process.exit(1);
  }

  // Pre-scan for mode flags: --router, --solo, --rest
  for (const a of raw) {
    const low = a.toLowerCase();
    if (low === '--router') {
      runtimeModes.router = true;
      runtimeModes.hasFlags = true;
    } else if (low === '--solo') {
      runtimeModes.solo = true;
      runtimeModes.hasFlags = true;
    } else if (low === '--rest') {
      runtimeModes.rest = true;
      runtimeModes.hasFlags = true;
    }
  }

  let hasRunCommand = false;
  const requestedHarnesses = [];

  for (let i = 0; i < raw.length; i++) {
    const a = raw[i];
    const word = a.toLowerCase();

    // Mode flags already handled in pre-scan
    if (word === '--router' || word === '--solo' || word === '--rest') {
      continue;
    }

    // ----- action commands: run, start, gui, stop, restart -----
    if (word === 'gui') {
      args.action = 'gui';
      if (i + 1 < raw.length && /^\d+$/.test(raw[i + 1])) {
        args.port = parseInt(raw[++i], 10);
      }
      continue;
    }
    if (word === 'start') {
      args.action = 'start';
      if (i + 1 < raw.length && /^\d+$/.test(raw[i + 1])) {
        args.port = parseInt(raw[++i], 10);
      }
      continue;
    }
    if (word === 'stop') {
      args.action = 'stop';
      if (i + 1 < raw.length && /^\d+$/.test(raw[i + 1])) {
        args.port = parseInt(raw[++i], 10);
      }
      continue;
    }
    if (word === 'restart') {
      args.action = 'restart';
      if (i + 1 < raw.length && /^\d+$/.test(raw[i + 1])) {
        args.port = parseInt(raw[++i], 10);
      }
      continue;
    }
    if (word === 'setup' || word === 'init') {
      args.action = 'setup';
      continue;
    }
    if (word === 'run') {
      hasRunCommand = true;
      args.action = 'run';
      continue;
    }
    if (word === 'install') {
      args.targets.add('install');
      continue;
    }
    if (word === 'uninstall') {
      args.targets.add('uninstall');
      continue;
    }

    // ----- help -----
    if (word === 'help' || a === '-h' || a === '--help') {
      printUsage();
      process.exit(0);
    }

    // ----- filter flags -----
    let val = null;
    let isMinInput = false;
    let isMinOutput = false;
    let isPort = false;

    if (a === '--min-input-context' || a === '-mi') {
      isMinInput = true;
      val = raw[++i];
    } else if (a === '--min-output-limit' || a === '-mo') {
      isMinOutput = true;
      val = raw[++i];
    } else if (a.startsWith('--min-input-context=')) {
      isMinInput = true;
      val = a.split('=')[1];
    } else if (a.startsWith('--min-output-limit=')) {
      isMinOutput = true;
      val = a.split('=')[1];
    } else if (a === '--port' || a === '-p') {
      isPort = true;
      val = raw[++i];
    } else if (a.startsWith('--port=')) {
      isPort = true;
      val = a.split('=')[1];
    }

    if (val !== null) {
      const n = parseInt(val, 10);
      if (!isNaN(n) && n >= 0) {
        if (isMinInput) args.minInput = n;
        if (isMinOutput) args.minOutput = n;
        if (isPort) args.port = n;
      }
      continue;
    }

    // ----- cleanup flag -----
    if (a === '--clean') {
      args.cleanup = true;
      continue;
    }
    if (a === '--noclean') {
      args.cleanup = false;
      continue;
    }

    // ----- legacy: -a / -all -> allpro -----
    if (a === '-a' || a === '-all') {
      WORD_MAP.allpro.forEach((t) => args.targets.add(t));
      continue;
    }

    // ----- harness targets (opencode, kilo, t3, dsh, pi, zcode, ocx, opencodex) -----
    if (HARNESS_SPEC[word]) {
      requestedHarnesses.push(word);
      const tgts = targetsForHarness(word);
      tgts.forEach((t) => args.targets.add(t));
      continue;
    }

    // ----- named target words -----
    if (WORD_MAP[word]) {
      WORD_MAP[word].forEach((t) => args.targets.add(t));
      continue;
    }

    // ----- legacy numeric steps (single or range like 1-5) -----
    if (/^\d+-\d+$/.test(a)) {
      const [s, e] = a.split('-').map((n) => parseInt(n, 10));
      for (let n = s; n <= e; n++) {
        if (NUM_MAP[n]) NUM_MAP[n].forEach((t) => args.targets.add(t));
      }
      continue;
    }
    const n = parseInt(a, 10);
    if (!isNaN(n) && NUM_MAP[n]) {
      NUM_MAP[n].forEach((t) => args.targets.add(t));
      continue;
    }

    console.error(`error: unknown argument: "${a}"\n`);
    printUsage();
    process.exit(1);
  }

  // If harness(es) were requested but had no active modes enabled:
  if (requestedHarnesses.length > 0 && args.targets.size === 0) {
    console.log(`No active modes (router/solo/rest) enabled for: ${requestedHarnesses.join(', ')}`);
    process.exit(0);
  }

  // If action is run or start, and no specific targets were provided:
  // if 'run' was explicitly passed or start action, run full pipeline;
  // otherwise if only flags were passed with no command/target, show error + help.
  if (args.action === 'run' || args.action === 'start') {
    if (args.targets.size === 0) {
      if (hasRunCommand || args.action === 'start') {
        buildOrder().forEach((t) => args.targets.add(t));
      } else {
        // If neither command nor target was provided, and providers.csv doesn't exist yet:
        // switch to setup mode so first run bootstraps smoothly!
        if (!fs.existsSync(PROVIDERS_CSV) || readProvidersCsv().length === 0) {
          args.action = 'setup';
        } else {
          console.error(`error: expected a command or flag\n`);
          printUsage();
          process.exit(1);
        }
      }
    }
  }

  return args;
}

// Post-setup recap: reports ONLY what this setup run actually did — each line
// reflects a real outcome (added vs already-configured, installed vs already
// installed, started vs already-running, synced vs skipped) — then where to
// customize and what to run next.
function printSetupSummary(opts) {
  const o = opts || {};
  const p = o.port || 55555;
  const say = (s) => console.log(s === '' ? '' : '  ' + s);
  const rows = readProvidersCsv();
  const router = getRouterRow(rows);
  const solos = getSoloRows(rows);
  const primaryConfig = process.env.OMNILIST_CONFIG
    || path.join(PROJECT_ROOT, 'config', 'config.jsonc');

  say('');
  say('Setup complete — here is what was done');
  say('');
  const createdRow = o.providerCreated
    ? rows.find((r) => r.provider === o.providerCreated)
    : null;
  if (createdRow) {
    say('  Provider    added ' + (createdRow.description || 'provider') + ' "' +
      createdRow.provider + '"  →  ' + createdRow.base_url);
  } else if (router) {
    say('  Provider    already configured: Router "' + router.provider + '"  →  ' +
      router.base_url + ' (no changes)');
  } else if (solos.length) {
    say('  Provider    already configured: Solo "' +
      solos.map((r) => r.provider).join('", "') + '" (no Router yet, no changes)');
  } else {
    say('  Provider    (none — add one with `' + CLI_COMMAND_NAME + ' setup`)');
  }
  say('              saved in ' + PROVIDERS_CSV);
  if (o.commandChanged) {
    say('  Command     `' + CLI_COMMAND_NAME + '` installed to User PATH');
    say('              (reopen your terminal, then run it from anywhere)');
  } else {
    say('  Command     already installed (no changes)');
    say('              (run `' + CLI_COMMAND_NAME + ' help` from anywhere)');
  }
  if (o.guiStarted) {
    say('  Dashboard   started in the background:  http://127.0.0.1:' + p);
  } else {
    say('  Dashboard   already running:  http://127.0.0.1:' + p + ' (no changes)');
  }
  say('              `' + CLI_COMMAND_NAME + ' stop` stops it, `' + CLI_COMMAND_NAME + ' gui` reopens it');
  if (o.synced) {
    say('  Sync        ran the full pipeline (catalog fetched + tools updated)');
  } else {
    say('  Sync        skipped — run `' + CLI_COMMAND_NAME + '` anytime to fetch + sync');
  }
  say('');
  say('Customize');
  say('  Config      ' + primaryConfig);
  say('              every key is optional; the dashboard edits this same file');
  if (!process.env.OMNILIST_CONFIG) {
    say('  Overrides    ' + path.join(PROJECT_ROOT, 'config', 'config.local.jsonc') + '  (private, gitignored)');
  }
  say('');
  say('Next');
  say('  ' + CLI_COMMAND_NAME + '             fetch the catalog + sync every enabled tool');
  say('  ' + CLI_COMMAND_NAME + ' gui         visual config for every tab (Run, Models, Providers, …)');
  say('  ' + CLI_COMMAND_NAME + ' --help      all targets and flags');
  say('  Full per-tab guides in docs\\  (docs\\README.md index)');
  say('');
}

// One-off yes/no question for setup ("Do you want to run the script?").
// Non-interactive stdin (pipes, CI, tests) and EOF answer `false`, so scripts
// never hang and never trigger an unexpected sync.
async function askYesNo(question) {
  if (!isInteractive()) return false;
  const reader = makeLineReader();
  try { process.stdout.write(question + ' [Y/n]: '); } catch (e) { /* ignore */ }
  try {
    const raw = await reader.nextLine();
    if (raw === null || raw === undefined) return false;
    const v = raw.trim().toLowerCase();
    return v === '' || v === 'y' || v === 'yes';
  } finally {
    reader.close();
  }
}

// Re-exported for gui.js: the config schema, loader/merger, JSONC parser, and
// filter-expression parsers (all pure/side-effect-free helpers). Assigned
// before the CLI IIFE because gui.js requires this module back (circular), so
// the exports must exist by the time the IIFE's require('./gui') runs.
module.exports = {
  PROJECT_ROOT,
  DEFAULTS,
  loadDefaults,
  loadConfig,
  deepMerge,
  stripJsoncComments,
  resolvePath,
  resolveProvidersCsv,
  resolveModelsCsv,
  parseModelSort,
  parseRule,
  parseModelFilterEntry,
  parseHarnessFilterEntry,
  parseOverrideEntry,
  applyModelFilters,
  parseTopNDirective,
  sortModels,
  providerTypeOf,
  isRouterRow,
  isSoloRow,
  isRestRow,
  getRouterRow,
  getSoloRows,
  getRestRows,
  readProvidersCsv,
  soloAllCsvPath,
  soloFilteredCsvPath,
  checkGuiRunning,
  startGuiInBackground,
  stopGui,
  restartGui,
  getSavedGuiPort,
  getSavedGuiPid,
  shutdownPort,
  cleanGuiFiles,
  findPidByPort,
};

// The CLI entry runs only when the script is invoked directly. gui.js requires
// this module for DEFAULTS/loadConfig/parsers without triggering the sync.
if (require.main === module)
(async () => {
  const args = parseArgs();
  const has = (t) => args.targets.has(t);
  let failed = false;
  let setupOutcome = null; // setup action defers its summary until after the optional sync
  try {
    if (args.action === 'setup') {
      console.log('\n  OmniList setup\n');
      console.log('  One provider powers every tool. About 30 seconds.\n');

      const createdProvider = await ensureRouterProvider();
      if (!createdProvider) console.log('  Already configured: ' + PROVIDERS_CSV + '\n');

      console.log('  Installing ' + CLI_COMMAND_NAME + ' command to User PATH...');
      const commandChanged = installAsCommand(false);

      const port = args.port || 55555;
      // startGuiInBackground() reports "already running" itself; mirror its
      // check (requested port, then saved port) so the summary below is honest.
      let guiWasRunning = !!(await checkGuiRunning(port));
      if (!guiWasRunning) {
        const savedPort = getSavedGuiPort();
        if (savedPort && savedPort !== port) guiWasRunning = !!(await checkGuiRunning(savedPort));
      }
      console.log('\n  Starting OmniList Web Dashboard on port ' + port + '...');
      const livePort = await startGuiInBackground({ port });

      // Offer the first sync now. "No" (or non-interactive stdin) stops here
      // with a summary of what was done. "Yes" falls through to the pipeline
      // below and the summary prints afterwards. The final pause lives in
      // setup.cmd (`pause`), never here.
      console.log('');
      if (await askYesNo('  Do you want to run the script now? (fetch the catalog + sync every enabled tool)')) {
        console.log('');
        buildOrder().forEach((t) => args.targets.add(t));
        setupOutcome = {
          port: livePort || port,
          providerCreated: createdProvider,
          commandChanged,
          guiStarted: !guiWasRunning,
          synced: true,
        };
      } else {
        printSetupSummary({
          port: livePort || port,
          providerCreated: createdProvider,
          commandChanged,
          guiStarted: !guiWasRunning,
          synced: false,
        });
        return;
      }
    }
    if (args.action === 'stop') {
      await stopGui(args.port);
      return;
    }
    if (args.action === 'restart') {
      await restartGui(args.port);
      return;
    }
    if (args.action === 'gui') {
      await startGuiInBackground({ port: args.port });
      return;
    }
    if (args.action === 'start') {
      await startGuiInBackground({ port: args.port });
    }
    if (has('gui')) {
      // Hand off to the web dashboard; it owns the process until Ctrl-C.
      await require('./gui').start({ port: args.port });
      return;
    }
    if (INSTALL_AS_COMMAND && !args.targets.has('uninstall') && !args.targets.has('install')) {
      installAsCommand(true);
    }
    if (has('install')) installAsCommand();
    if (has('uninstall')) uninstallAsCommand();

    // First-run bootstrap: if no Router is configured and this run includes a
    // target that requires one, prompt for the base URL + API key to create
    // providers.csv. The `fetch` target then builds models-filtered.csv from the model
    // endpoint below. Targets that tolerate a missing Router (the *rest and
    // cleanup steps) don't trigger the prompt.
    const ROUTER_TARGETS = ['fetch', 'opencode', 'kilo', 't3models', 'dsh', 'pi', 'zcode', 'opencodex'];
    if (ROUTER_TARGETS.some((t) => has(t))) {
      const created = await ensureRouterProvider();
      if (created) console.log('Providers configured. Fetching the model catalog now...\n');
    }

    // Clean up per-harness preview CSVs that don't belong under the current
    // show_harness_model_list mode before any sync re-writes the ones that do.
    cleanupHarnessPreviews();

    const executionOrder = [
      'cleanmodels', 'fetch', 'opencode', 'opencoderest', 'kilo', 'kilorest',
      'kilopro', 't3models', 't3rest', 'dsh', 'dshrest', 'pi', 'pirest',
      'zcode', 'zcoderest', 'opencodex', 'opencodexrest', 'cleanupproviders',
      'cleanup', 'commands',
    ];

    for (const target of executionOrder) {
      if (!has(target)) continue;
      try {
        switch (target) {
          case 'fetch': {
            const n = await fetchModels(args.minInput, args.minOutput);
            console.log(`Wrote ${n} models to ${MODELS_CSV}`);
            break;
          }
          case 'opencode': {
            if (!fs.existsSync(OPENCODE_FILE)) {
              console.log(`Skipped opencode (not found: ${OPENCODE_FILE})`);
              break;
            }
            if (!getRouterRow(readProvidersCsv())) {
              console.log(`Skipped opencode router block (no router configured)`);
              break;
            }
            const n = await syncRouterProvider(OPENCODE_FILE, 'opencode');
            console.log(`Synced router provider block in ${OPENCODE_FILE} (${formatApiModels(n)})`);
            break;
          }
          case 'kilo': {
            if (!fs.existsSync(KILO_FILE)) {
              console.log(`Skipped kilo (not found: ${KILO_FILE})`);
              break;
            }
            if (!getRouterRow(readProvidersCsv())) {
              console.log(`Skipped kilo router block (no router configured)`);
              break;
            }
            const n = await syncRouterProvider(KILO_FILE, 'kilo');
            console.log(`Synced router provider block in ${KILO_FILE} (${formatApiModels(n)})`);
            break;
          }
          case 'kilopro': {
            if (!fs.existsSync(OPENCODE_FILE)) {
              console.log(`Skipped kilopro (opencode.jsonc not found: ${OPENCODE_FILE})`);
              break;
            }
            const kilo = copyProviderBlockToKilo();
            console.log(`Copied provider{} from ${OPENCODE_FILE} -> ${kilo}`);
            break;
          }
          case 't3models': {
            if (!getRouterRow(readProvidersCsv())) {
              console.log(`Skipped t3 router customModels (no router configured)`);
              break;
            }
            const n = await syncT3Models(args.minInput, args.minOutput);
            console.log(`Synced flat customModels in ${T3_SETTINGS_FILE} (${formatApiModels(n, 1, n)})`);
            break;
          }
          case 't3rest': {
            const n = await syncT3Providers();
            console.log(`Synced per-provider claudeAgent instances in ${T3_SETTINGS_FILE} (${formatApiModels(n, n, 0)})`);
            break;
          }
          case 'opencoderest': {
            if (!fs.existsSync(OPENCODE_FILE)) {
              console.log(`Skipped opencoderest (not found: ${OPENCODE_FILE})`);
              break;
            }
            const n = await syncOpencodeRestProviders();
            console.log(`Synced REST provider blocks in ${OPENCODE_FILE} (${formatApiModels(n)})`);
            break;
          }
          case 'kilorest': {
            if (!fs.existsSync(KILO_FILE)) {
              console.log(`Skipped kilorest (not found: ${KILO_FILE})`);
              break;
            }
            const n = await syncKiloRestProviders();
            console.log(`Synced REST provider blocks in ${KILO_FILE} (${formatApiModels(n)})`);
            break;
          }
          case 'dsh': {
            if (!isRouterActive('dsh')) {
              console.log(`Skipped dsh router block (disabled in config)`);
              break;
            }
            if (!getRouterRow(readProvidersCsv())) {
              console.log(`Skipped dsh router block (no router configured)`);
              break;
            }
            const res = await syncDSHRouter();
            console.log(`Synced DSH router providers in ${DSH_SETTINGS_FILE} (${formatApiModels(res)})`);
            break;
          }
          case 'dshrest': {
            if (!isSoloActive('dsh') && !isRestActive('dsh')) {
              console.log(`Skipped DSH REST/Solo blocks (disabled in config)`);
              break;
            }
            const rows = readProvidersCsv();
            const hasSolo = getSoloRows(rows).length > 0;
            const hasRest = getRestRows(rows).length > 0;
            if ((!isSoloActive('dsh') || !hasSolo) && (!isRestActive('dsh') || !hasRest)) {
              console.log(`Skipped DSH REST/Solo blocks (disabled in config or no matching providers)`);
              break;
            }
            const n = await syncDSHRestProviders();
            console.log(`Synced DSH REST providers in ${DSH_SETTINGS_FILE} (${formatApiModels(n, 0, 0)})`);
            break;
          }
          case 'pi': {
            if (!isRouterActive('pi')) {
              console.log(`Skipped pi router block (disabled in config)`);
              break;
            }
            if (!getRouterRow(readProvidersCsv())) {
              console.log(`Skipped pi router block (no router configured)`);
              break;
            }
            const n = await syncPiRouter();
            console.log(`Synced pi router provider in ${PI_FILE} (${formatApiModels(n)})`);
            break;
          }
          case 'pirest': {
            if (!isSoloActive('pi') && !isRestActive('pi')) {
              console.log(`Skipped pi REST/Solo blocks (disabled in config)`);
              break;
            }
            const rows = readProvidersCsv();
            const hasSolo = getSoloRows(rows).length > 0;
            const hasRest = getRestRows(rows).length > 0;
            if ((!isSoloActive('pi') || !hasSolo) && (!isRestActive('pi') || !hasRest)) {
              console.log(`Skipped pi REST/Solo blocks (disabled in config or no matching providers)`);
              break;
            }
            const n = await syncPiRestProviders();
            console.log(`Synced pi REST providers in ${PI_FILE} (${formatApiModels(n, 0, 0)})`);
            break;
          }
          case 'zcode': {
            if (!getRouterRow(readProvidersCsv())) {
              console.log(`Skipped zcode router block (no router configured)`);
              break;
            }
            const n = await syncZcodeRouter();
            console.log(`Synced zcode router provider in ${ZCODE_FILE} (${formatApiModels(n)})`);
            break;
          }
          case 'zcoderest': {
            const n = await syncZcodeRestProviders();
            console.log(`Synced zcode REST providers in ${ZCODE_FILE} (${formatApiModels(n, 0, 0)})`);
            break;
          }
          case 'opencodex': {
            if (!isRouterActive('opencodex')) {
              console.log(`Skipped opencodex router block (disabled in config)`);
              break;
            }
            if (!getRouterRow(readProvidersCsv())) {
              console.log(`Skipped opencodex router block (no router configured)`);
              break;
            }
            const n = await syncOpencodexRouter();
            console.log(`Synced opencodex router provider in ${OPENCODEX_FILE} (${formatApiModels(n)})`);
            break;
          }
          case 'opencodexrest': {
            if (!isSoloActive('opencodex') && !isRestActive('opencodex')) {
              console.log(`Skipped opencodex REST/Solo blocks (disabled in config)`);
              break;
            }
            const n = await syncOpencodexRestProviders();
            console.log(`Synced opencodex REST providers in ${OPENCODEX_FILE} (${formatApiModels(n, 0, 0)})`);
            break;
          }
          case 'cleanupproviders': {
            const n = cleanupProviders();
            console.log(`Reconciled script-managed providers (${n} removed)`);
            break;
          }
          case 'cleanup': {
            cleanupStep(args.cleanup);
            break;
          }
          case 'cleanmodels': {
            await cleanAllModels();
            break;
          }
          case 'commands': {
            const hasErr = await runCustomCommands();
            if (hasErr) failed = true;
            break;
          }
        }
      } catch (e) {
        failed = true;
        console.error(`[${target}] Error: ${e.message}`);
      }
    }
    if (setupOutcome) printSetupSummary(setupOutcome);
  } catch (e) {
    console.error('Error:', e.message);
    process.exit(1);
  }
  if (failed) process.exitCode = 1;
})();
