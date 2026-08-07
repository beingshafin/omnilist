'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const https = require('https');
const http = require('http');
const readline = require('readline');
const { execFileSync } = require('child_process');

// ---------- config ----------
// VSCode models endpoint. Leave empty ('') to be prompted at runtime.
// Accepted at the prompt:
//   - full endpoint URL  e.g. http://localhost:20128/api/v1/vscode/<key>/models
//   - bare API key/token e.g. sk-0b4b7a306fe4eeb5-76a746-b056e0ba
const URL = '';
const VSCODE_MODELS_ENDPOINT = 'http://localhost:20128/api/v1/vscode';
// Base URL stored in providers.csv for the omniroute provider.
const OMNIROUTE_BASE_URL = 'http://localhost:20128/v1';
// The API key is stored in providers.csv (omniroute row) and reused for
// future fetches (until --new).

// If true, register this script as a "<CLI_COMMAND_NAME>" command:
//   - writes a <CLI_COMMAND_NAME>.cmd shim next to this script,
//   - adds the script folder to the persistent User PATH,
//   - drops an instant shim into %APPDATA%\npm (already on PATH) so the
//     current terminal can run it without a reset.
// Idempotent: re-running with true is a no-op if already installed.
// You can also trigger it manually via: node model-list.js install / uninstall
const INSTALL_AS_COMMAND = true;

// Name of the CLI command used to run this script from any terminal.
// "model-list" registers a model-list.cmd shim + adds this folder to PATH,
// so you can just type:  model-list <targets...>
const CLI_COMMAND_NAME = 'omnilist';

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
const MODEL_FILTERS = [

  "!kc/*",
  "!opencode-zen/*",
  "*free",

  "!agy/*",
  "!gemini/*",
  "!no-think",
  "!compatible",
];


const T3_FILTERS = [
  //"!*free",    // block anything ending with "free"
  //"*free",     // allow ONLY models ending with "free"
  //"kilo/*",    // allow anything under "kilo/" provider
];

// Custom models to inject into models.csv on every fetch.
// These are merged (no duplicates) and sorted alongside API results.
// Format: { id: "provider/model", in: <input_context>, out: <output_context> }
const CUSTOM_MODELS = [
  // { id: 'agentrouter/bunga', in: 200000, out: 128000 },
  // { id: 'my-provider/my-model', in: 200000, out: 128000 },
];

const MIN_INPUT_TOKENS_DEFAULT = 128000;
const MIN_OUTPUT_TOKENS_DEFAULT = 0;
const CLEANUP_DEFAULT = true;

const T3_OMNIRoute_PROVIDER = true;
const T3_REST_PROVIDER = true;

const OPENCODE_OMNIRoute_PROVIDER = true;
const OPENCODE_REST_PROVIDER = false;

const KILO_OMNIRoute_PROVIDER = true;
const KILO_REST_PROVIDER = false;

const KILO_COPY_OPENCODE_FULL_PROVIDER_BLOCK = false;

// If true, remove script-managed (custom_*) providers whose feature flag is false.
const REMOVE_IF_FALSE_PROVIDER = true;
// If true, remove script-managed (custom_*) providers that no longer exist in providers.csv.
const REMOVE_IF_PROVIDER_DOESNT_EXIST = true;

const home = os.homedir();
const MODELS_CSV = process.env.MODELS_TEST || path.join(__dirname, 'models.csv');
const PROVIDERS_CSV = path.join(__dirname, 'providers.csv');
const OPENCODE_FILE = process.env.JSONC_TEST || path.join(home, '.config', 'opencode', 'opencode.jsonc');
const KILO_FILE = process.env.KILO_TEST || path.join(home, '.config', 'kilo', 'kilo.jsonc');
// T3 userdata dir. Override with T3_DATA_DIR if T3 keeps its data elsewhere
// (e.g. a non-default profile/user folder on another machine).
const T3_DATA_DIR = process.env.T3_DATA_DIR || path.join(home, '.t3', 'userdata');
const T3_SETTINGS_FILE = path.join(T3_DATA_DIR, 'settings.json');
const T3_LOGS_DIR = path.join(T3_DATA_DIR, 'logs');

const T3_OMNIROUTE_DRIVERS = [
  { driver: 'claudeAgent', '1m': true },
  { driver: 'codex', '1m': false },
];

  // dont use codex or any other driver here only claude recommended
const T3_REST_PROVIDER_DRIVERS = [
  { driver: 'claudeAgent', '1m': true },
  // { driver: 'codex', '1m': false },
];

// Per-driver config strategy for T3 provider instances.
// claudeAgent connects via ANTHROPIC_* environment variables;
// codex connects via launchArgs (model_provider / model_providers.* overrides).
const T3_DRIVER_STRATEGY = {
  claudeAgent: { mode: 'env', apiKey: 'ANTHROPIC_API_KEY', baseUrl: 'ANTHROPIC_BASE_URL' },
  codex: { mode: 'launchArgs' },
};




// ---------- helpers ----------
// Parse a full vscode models endpoint URL or a bare key.
// URL form: <origin>/api/v1/vscode/<key>/models
// Returns { key, origin } (origin is '' for a bare key, key '' if not found).
function parseEndpointInput(input) {
  if (!input) return { key: '', origin: '' };
  input = input.trim();
  if (!input) return { key: '', origin: '' };
  if (/^https?:\/\//i.test(input)) {
    const origin = input.match(/^https?:\/\/[^/]+/i);
    const key = input.match(/\/vscode\/([^/]+)/i);
    return { key: key ? key[1] : '', origin: origin ? origin[0] : '' };
  }
  return { key: input, origin: '' };
}

// Build the vscode models fetch endpoint from an API key + stored base URL.
// base_url format: <origin>/v1  (e.g. http://localhost:20129/v1)
function buildFetchEndpoint(apiKey, baseUrl) {
  const origin = (baseUrl || '').trim().replace(/\/+$/, '').replace(/\/v1$/i, '');
  if (origin) return origin + '/api/v1/vscode/' + apiKey + '/models';
  return VSCODE_MODELS_ENDPOINT + '/' + apiKey + '/models';
}

function maskKey(key) {
  if (key.length <= 8) return key;
  const head = key.slice(0, 5);
  const tail = key.slice(-2);
  return head + '*'.repeat(key.length - head.length - tail.length) + tail;
}

// Censor API keys inside an endpoint URL before printing it (sk-0b***ba).
function maskEndpoint(url) {
  if (!url) return url;
  return url.replace(/\/([^/]+)\/models/i, (m, k) => '/' + maskKey(k) + '/models');
}

function promptInput(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

// Read providers.csv into an array of row objects (skips the header).
function readProvidersCsv() {
  if (!fs.existsSync(PROVIDERS_CSV)) return [];
  const csvLines = fs.readFileSync(PROVIDERS_CSV, 'utf8').trim().split('\n');
  if (csvLines.length < 2) return [];
  const headers = csvLines[0].split(',').map((h) => h.trim());
  return csvLines.slice(1).map((line) => {
    const vals = line.split(',');
    const row = {};
    headers.forEach((h, i) => { row[h] = (vals[i] || '').trim(); });
    return row;
  }).filter((r) => r.provider);
}

// Store the omniroute API key (and base URL when provided) in providers.csv
// (creates it if missing). Format: provider,base_url,api_key,description
function saveProviderKey(apiKey, baseUrl) {
  if (!fs.existsSync(PROVIDERS_CSV)) {
    fs.writeFileSync(PROVIDERS_CSV,
      'provider,base_url,api_key,description\n' +
      `omniroute,${baseUrl || OMNIROUTE_BASE_URL},${apiKey}, generated_from_omnilist_script\n`, 'utf8');
    console.log('Created ' + PROVIDERS_CSV + ' with omniroute api key');
    return;
  }
  const lines = fs.readFileSync(PROVIDERS_CSV, 'utf8').split('\n');
  const headers = (lines[0] || '').split(',').map((h) => h.trim());
  const keyIdx = headers.indexOf('api_key');
  const provIdx = headers.indexOf('provider');
  const baseIdx = headers.indexOf('base_url');
  let updated = false;
  if (keyIdx !== -1) {
    for (let i = 1; i < lines.length; i++) {
      const vals = lines[i].split(',');
      if (provIdx === -1 || (vals[provIdx] || '').trim() === 'omniroute') {
        vals[keyIdx] = apiKey;
        if (baseUrl && baseIdx !== -1) vals[baseIdx] = baseUrl;
        lines[i] = vals.join(',');
        updated = true;
        break;
      }
    }
  }
  if (!updated) {
    lines.push(`omniroute,${baseUrl || OMNIROUTE_BASE_URL},${apiKey}, generated_from_omnilist_script`);
  }
  fs.writeFileSync(PROVIDERS_CSV, lines.join('\n'), 'utf8');
  console.log(updated
    ? 'Updated api key in ' + PROVIDERS_CSV
    : 'Appended omniroute row to ' + PROVIDERS_CSV);
}

function getJSON(url) {
  const lib = url.startsWith('https') ? https : http;
  return new Promise((resolve, reject) => {
    lib.get(url, (res) => {
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
// Pattern syntax: "*" is a wildcard matching any text.
// Prefix = text before first "*", suffix = text after last "*".
//   "foo*bar"  -> startsWith("foo") AND endsWith("bar")
//   "prefix*"  -> startsWith("prefix")
//   "*suffix"  -> endsWith("suffix")
//   "plain"    -> includes("plain") /* no wildcards */
function matchPattern(pattern, text) {
  const p = pattern.toLowerCase();
  const t = text.toLowerCase();
  if (!p.includes('*')) return t.includes(p);
  const prefix = p.substring(0, p.indexOf('*'));
  const suffix = p.substring(p.lastIndexOf('*') + 1);
  return t.startsWith(prefix) && t.endsWith(suffix);
}

// applyFilters returns true if the model is KEPT, false if filtered out.
// Top-down: LAST matching rule wins (later rules override earlier ones).
function applyModelFilters(candidates, filters) {
  if (!filters || !filters.length) return candidates;
  // Parse each string rule once: leading "!" means block, otherwise allow.
  const rules = filters.map((rule) => {
    const block = rule.startsWith('!');
    return { pattern: block ? rule.slice(1) : rule, allow: !block };
  });
  return candidates.filter(({ id }) => {
    let keep = true;
    for (let i = 0; i < rules.length; i++) {
      const rule = rules[i];
      if (matchPattern(rule.pattern, id)) {
        keep = rule.allow;
      }
    }
    return keep;
  });
}

function buildModelEntry(id, ctxIn, ctxOut) {
  const limit = `          "limit": { "context": ${ctxIn}, "output": ${ctxOut} },`;
  return [
    `        "${id}": {`,
    `          "name": "${id} (custom)",`,
    `          "attachment" : true,`,
    `          "reasoning" : true,`,
    `          "tool_call" : true,`,
    `          "temperature": true,`,
    limit,
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
    `        }`,
  ].join('\n');
}

// Build codex launchArgs for a given provider (values from providers.csv).
// Format preserved exactly (double spaces between -c segments):
//   -c model_provider=<p>  -c model_providers.<p>.name=OmniRoute  -c model_providers.<p>.base_url=<url>  -c model_providers.<p>.api_key=<key>
function buildLaunchArgs(provider, baseUrl, apiKey) {
  return `-c model_provider=${provider}  -c model_providers.${provider}.name=OmniRoute  -c model_providers.${provider}.base_url=${baseUrl}  -c model_providers.${provider}.api_key=${apiKey}`;
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
    inst.config.launchArgs = buildLaunchArgs(providerName, baseUrl, apiKey);
  } else {
    inst.environment = [
      { name: strategy.apiKey, value: apiKey, sensitive: false },
      { name: strategy.baseUrl, value: baseUrl, sensitive: false },
    ];
  }
  return inst;
}

// ---------- fetchModels: fetch + build models.csv (DEFAULT target) ----------
// Each line written as:  model-id,context-input,context-output
// Filters:
//   --min-input-context N : skip models with input context < N (0 = no filter, default 200000)
//   --min-output-limit N   : skip models with output < N (0 = no filter)
async function fetchModels(minInput = 0, minOutput = 0, forceNew = false) {
  let apiKey = '';
  let baseUrl = '';
  if (URL) {
    const parsed = parseEndpointInput(URL);
    apiKey = parsed.key;
    baseUrl = parsed.origin ? parsed.origin + '/v1' : '';
  }
  if (!apiKey && !forceNew) {
    const rows = readProvidersCsv();
    const omni = rows.find((r) => r.provider === 'omniroute') || rows[0];
    if (omni && omni.api_key) {
      apiKey = omni.api_key;
      baseUrl = omni.base_url || '';
    }
  }
  if (!apiKey) {
    const answer = await promptInput('Give vscode model endpoint URL or API/token key: ');
    const parsed = parseEndpointInput(answer);
    apiKey = parsed.key;
    baseUrl = parsed.origin ? parsed.origin + '/v1' : '';
    if (!apiKey) throw new Error('No vscode model endpoint provided (URL or API key).');
    saveProviderKey(apiKey, baseUrl);
  } else if (!fs.existsSync(PROVIDERS_CSV)) {
    saveProviderKey(apiKey, baseUrl);
  }
  const url = buildFetchEndpoint(apiKey, baseUrl);
  console.log('Using endpoint: ' + maskEndpoint(url));
  const json = await getJSON(url);
  const results = [];
  for (const m of json.data) {
    let id = m.id;
    // Convert "name__provider_X" -> "X/name"
    if (id.includes('__provider_')) {
      const idx = id.indexOf('__provider_');
      const name = id.substring(0, idx);
      const prov = id.substring(idx + '__provider_'.length);
      id = prov + '/' + name;
    }

    // context limits (input falls back to context_length when max_input_tokens missing)
    const ctxIn = (m.max_input_tokens != null) ? m.max_input_tokens
      : (m.context_length != null ? m.context_length : 0);
    const ctxOut = (m.max_output_tokens != null) ? m.max_output_tokens : 0;

    // Apply filters
    if (minInput > 0 && ctxIn < minInput) continue;
    if (minOutput > 0 && ctxOut < minOutput) continue;

    results.push({ id, in: ctxIn, out: ctxOut });
  }

  const filtered = applyModelFilters(results, MODEL_FILTERS);

  // Merge custom models (skip if id already exists from API/filters)
  const existingIds = new Set(filtered.map((r) => r.id));
  for (const c of CUSTOM_MODELS) {
    if (!existingIds.has(c.id)) {
      filtered.push({ id: c.id, in: c.in, out: c.out });
    }
  }

  filtered.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const text = filtered.map((r) => `${r.id},${r.in},${r.out}`).join('\n');
  fs.mkdirSync(path.dirname(MODELS_CSV), { recursive: true });
  fs.writeFileSync(MODELS_CSV, text + (filtered.length ? '\n' : ''), 'utf8');
  return filtered.length;
}

// ---------- syncModelBlock: update omniroute models via markers (in a given file) ----------
function syncModelBlock(targetFile) {
  if (!fs.existsSync(MODELS_CSV)) {
    throw new Error('models.txt not found: ' + MODELS_CSV);
  }
  const ids = fs.readFileSync(MODELS_CSV, 'utf8')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
    .map((l) => {
      const parts = l.split(',');
      return { id: parts[0], in: parts[1] || '0', out: parts[2] || '0' };
    });

  const block = ids.map((m, i) => {
    const entry = buildModelEntry(m.id, m.in, m.out);
    return i === ids.length - 1 ? entry : entry + ',';
  });

  const lines = fs.readFileSync(targetFile, 'utf8').split('\n');

  const out = [];
  let inModels = false;
  let inBlock = false;
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    // Detect the omniroute "models" object opening
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
// Reads providers.csv and models.csv. Deletes all providerInstances keys starting with "custom_",
// then creates custom_<provider>_<n> for each key of each provider.
// customModels per instance = models matching <provider>/ prefix, with prefix stripped.
// Models with input context >= 1,000,000 also get a "[1m]" variant.
function syncT3Providers() {
  if (!fs.existsSync(PROVIDERS_CSV)) throw new Error('providers.csv not found: ' + PROVIDERS_CSV);
  if (!fs.existsSync(MODELS_CSV)) throw new Error('models.csv not found: ' + MODELS_CSV);

  const csvLines = fs.readFileSync(PROVIDERS_CSV, 'utf8').trim().split('\n');
  const headers = csvLines[0].split(',').map(h => h.trim());
  const rows = csvLines.slice(1).map(line => {
    const vals = line.split(',');
    const row = {};
    headers.forEach((h, i) => { row[h] = (vals[i] || '').trim(); });
    return row;
  }).filter(r => r.provider);

  const modelRows = fs.readFileSync(MODELS_CSV, 'utf8').split('\n')
    .map(l => l.trim()).filter(l => l.length > 0)
    .map(l => {
      const parts = l.split(',');
      return { id: parts[0], in: parseInt(parts[1] || '0', 10) };
    });

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
    if (key.startsWith('custom_') && !key.startsWith('custom_omniroute_')) {
      prevEnabled[key] = !!settings.providerInstances[key].enabled;
      delete settings.providerInstances[key];
    }
  }

  const activeRestDrivers = T3_REST_PROVIDER_DRIVERS.filter(e => e && typeof e === 'object' && e.driver);

  let count = 0;
  for (const [provider, keys] of Object.entries(byProvider)) {
    if (provider === 'omniroute') continue;
    const withPrefix = modelRows
      .filter((m) => m.id.startsWith(provider + '/'))
      .map((m) => ({ ...m, fullId: m.id }));
    const filtered = applyModelFilters(withPrefix, T3_FILTERS);
    const providerModelsAll = [];
    for (const m of filtered) {
      const name = m.id.slice(provider.length + 1);
      providerModelsAll.push(name);
      if (m.in >= 1000000) providerModelsAll.push(name + '[1m]');
    }
    const drivers = activeRestDrivers;
    if (drivers.length === 0) continue;
    keys.forEach((row, idx) => {
      drivers.forEach((driverEntry, driverIdx) => {
        const driverName = driverEntry.driver;
        const supports1m = !!driverEntry['1m'];
        const providerModels = supports1m ? providerModelsAll : providerModelsAll.filter(m => !m.endsWith('[1m]'));
        const key = `custom_${provider}_${idx + 1}_${driverName}`;
        settings.providerInstances[key] = buildT3DriverInstance(
          driverName,
          provider,
          `${provider}_${idx + 1}`,
          row.base_url,
          row.api_key,
          providerModels,
          prevEnabled.hasOwnProperty(key) ? prevEnabled[key] : false
        );
        count++;
      });
    });
  }

  fs.mkdirSync(path.dirname(T3_SETTINGS_FILE), { recursive: true });
  fs.writeFileSync(T3_SETTINGS_FILE, JSON.stringify(settings, null, 2) + '\n', 'utf8');
  return count;
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


// Reads models.csv and writes model IDs into:
//   settings.json -> providerInstances -> <omniroute driver blocks> -> config -> customModels
// Models with input context >= 1,000,000 also get a "[1m]" variant.
// Active omniroute drivers from T3_OMNIROUTE_DRIVERS become provider instances.
// Accepts the same filters as step1.
function ensureOmnirouteInstances(settings) {
  if (!settings.providerInstances) settings.providerInstances = {};

  if (settings.providerInstances.omniroute) {
    const mainEnabled = !!settings.providerInstances.omniroute.enabled;
    const mainModels = (settings.providerInstances.omniroute.config && settings.providerInstances.omniroute.config.customModels) || [];
    const prev = { enabled: mainEnabled, customModels: mainModels };
    delete settings.providerInstances.omniroute;
  }

  const activeOmniDrivers = T3_OMNIROUTE_DRIVERS.filter(e => e && typeof e === 'object' && e.driver);
  const activeDriverNames = new Set(activeOmniDrivers.map(e => e.driver));

  for (const key of Object.keys(settings.providerInstances)) {
    if (key.startsWith('custom_omniroute_')) {
      const driverName = key.slice('custom_omniroute_'.length);
      if (!activeDriverNames.has(driverName)) {
        delete settings.providerInstances[key];
      }
    }
  }

  const fallbackRow = (() => {
    if (!fs.existsSync(PROVIDERS_CSV)) return null;
    const csvLines = fs.readFileSync(PROVIDERS_CSV, 'utf8').trim().split('\n');
    const headers = csvLines[0].split(',').map((h) => h.trim());
    const rows = csvLines.slice(1).map((line) => {
      const vals = line.split(',');
      const entry = {};
      headers.forEach((h, i) => { entry[h] = (vals[i] || '').trim(); });
      return entry;
    }).filter((r) => r.provider);
    return rows.find((r) => r.provider === 'omniroute') || rows[0] || null;
  })();

  const apiKey = fallbackRow ? fallbackRow.api_key : 'sk-0b4b7a306fe4eeb5-76a746-b056e0ba';
  const baseUrl = fallbackRow ? fallbackRow.base_url : 'http://localhost:20128/v1';

  activeOmniDrivers.forEach((entry) => {
    const driverName = entry.driver;
    const key = `custom_omniroute_${driverName}`;
    settings.providerInstances[key] = buildT3DriverInstance(
      driverName,
      'omniroute',
      'Omniroute',
      baseUrl,
      apiKey,
      [],
      true
    );
  });
}

// Sort providerInstances so that:
//   1. "custom_omniroute_*" entries are always first
//   2. All non-custom_ entries come next (any manually-added ones like claudeAgent, opencode, etc.)
//   3. All remaining custom_* entries come last, in reverse creation order (newest first)
function sortProviderInstances(settings) {
  if (!settings.providerInstances) return;
  const keys = Object.keys(settings.providerInstances);
  const omniroute = keys.filter((k) => k.startsWith('custom_omniroute_'));
  const others = keys.filter((k) => !k.startsWith('custom_'));
  const customs = keys.filter((k) => k.startsWith('custom_') && !k.startsWith('custom_omniroute_')).reverse();
  const ordered = [...omniroute, ...others, ...customs];
  const reordered = {};
  for (const k of ordered) reordered[k] = settings.providerInstances[k];
  settings.providerInstances = reordered;
}

function syncOpencodeRestProviders() {
  if (!fs.existsSync(PROVIDERS_CSV)) throw new Error('providers.csv not found: ' + PROVIDERS_CSV);
  if (!fs.existsSync(MODELS_CSV)) throw new Error('models.csv not found: ' + MODELS_CSV);
  if (!fs.existsSync(OPENCODE_FILE)) throw new Error('opencode.jsonc not found: ' + OPENCODE_FILE);

  const csvLines = fs.readFileSync(PROVIDERS_CSV, 'utf8').trim().split('\n');
  const headers = csvLines[0].split(',').map(h => h.trim());
  const rows = csvLines.slice(1).map(line => {
    const vals = line.split(',');
    const row = {};
    headers.forEach((h, i) => { row[h] = (vals[i] || '').trim(); });
    return row;
  }).filter(r => r.provider);

  const modelLines = fs.readFileSync(MODELS_CSV, 'utf8').split('\n')
    .map(l => l.trim()).filter(l => l.length > 0)
    .map(l => {
      const parts = l.split(',');
      return { id: parts[0], in: parseInt(parts[1] || '0', 10) };
    });

  const byProvider = {};
  for (const row of rows) {
    if (!byProvider[row.provider]) byProvider[row.provider] = [];
    byProvider[row.provider].push(row);
  }

  const npmMap = {
    'agentrouter': '@ai-sdk/openai-compatible',
    'openai': '@ai-sdk/openai',
    'anthropic': '@ai-sdk/anthropic',
    'google': '@ai-sdk/google',
    'xai': '@ai-sdk/xai',
    'fmd': '@ai-sdk/openai-compatible',
  };

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
    if (providerName === 'omniroute') continue;
    const prefix = providerName + '/';
    providerRows.forEach((row, idx) => {
      const key = `custom_${providerName}_${idx + 1}`;
      const providerModels = modelLines
        .filter(m => m.id.startsWith(prefix))
        .map(m => {
          const modelId = m.id.slice(prefix.length);
          return {
            name: modelId,
            ...(m.in >= 1000000 ? { variants: { max: { thinking: { type: 'enabled', budgetTokens: 100000 } } } } : {})
          };
        });

      config.provider[key] = {
        name: key,
        npm: npmMap[providerName] || '@ai-sdk/openai-compatible',
        options: {
          baseURL: row.base_url.replace(/\/$/, ''),
          apiKey: row.api_key
        },
        models: providerModels.reduce((acc, m) => { acc[m.name] = m; return acc; }, {})
      };
    });
  }

  fs.writeFileSync(OPENCODE_FILE, JSON.stringify(config, null, 2) + '\n', 'utf8');
  return Object.keys(config.provider).filter(k => k.startsWith('custom_') && k !== 'custom_omniroute').length;
}

function syncKiloRestProviders() {
  if (!fs.existsSync(PROVIDERS_CSV)) throw new Error('providers.csv not found: ' + PROVIDERS_CSV);
  if (!fs.existsSync(MODELS_CSV)) throw new Error('models.csv not found: ' + MODELS_CSV);
  if (!fs.existsSync(KILO_FILE)) throw new Error('kilo.jsonc not found: ' + KILO_FILE);

  const csvLines = fs.readFileSync(PROVIDERS_CSV, 'utf8').trim().split('\n');
  const headers = csvLines[0].split(',').map(h => h.trim());
  const rows = csvLines.slice(1).map(line => {
    const vals = line.split(',');
    const row = {};
    headers.forEach((h, i) => { row[h] = (vals[i] || '').trim(); });
    return row;
  }).filter(r => r.provider);

  const modelLines = fs.readFileSync(MODELS_CSV, 'utf8').split('\n')
    .map(l => l.trim()).filter(l => l.length > 0)
    .map(l => {
      const parts = l.split(',');
      return { id: parts[0], in: parseInt(parts[1] || '0', 10) };
    });

  const byProvider = {};
  for (const row of rows) {
    if (!byProvider[row.provider]) byProvider[row.provider] = [];
    byProvider[row.provider].push(row);
  }

  const npmMap = {
    'agentrouter': '@ai-sdk/openai-compatible',
    'openai': '@ai-sdk/openai',
    'anthropic': '@ai-sdk/anthropic',
    'google': '@ai-sdk/google',
    'xai': '@ai-sdk/xai',
    'fmd': '@ai-sdk/openai-compatible',
  };

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
    if (providerName === 'omniroute') continue;
    const prefix = providerName + '/';
    providerRows.forEach((row, idx) => {
      const key = `custom_${providerName}_${idx + 1}`;
      const providerModels = modelLines
        .filter(m => m.id.startsWith(prefix))
        .map(m => {
          const modelId = m.id.slice(prefix.length);
          return {
            name: modelId,
            ...(m.in >= 1000000 ? { variants: { max: { thinking: { type: 'enabled', budgetTokens: 100000 } } } } : {})
          };
        });

      config.provider[key] = {
        name: key,
        npm: npmMap[providerName] || '@ai-sdk/openai-compatible',
        options: {
          baseURL: row.base_url.replace(/\/$/, ''),
          apiKey: row.api_key
        },
        models: providerModels.reduce((acc, m) => { acc[m.name] = m; return acc; }, {})
      };
    });
  }

  fs.writeFileSync(KILO_FILE, JSON.stringify(config, null, 2) + '\n', 'utf8');
  return Object.keys(config.provider).filter(k => k.startsWith('custom_') && k !== 'custom_omniroute').length;
}


// ---------- cleanupProviders: reconcile custom_* providers in all config files ----------
// For each config file, removes script-managed (custom_*) providers per:
//   REMOVE_IF_FALSE_PROVIDER:        remove providers whose feature flag is false
//   REMOVE_IF_PROVIDER_DOESNT_EXIST: remove providers that no longer exist in providers.csv
// Never touches non-custom_ entries, so user-added providers are preserved.
// Also renumbers per-provider indices to match providers.csv (1..N). Instances are
// matched to CSV rows by API key, so deleted keys are dropped and indices compacted.
function cleanupProviders() {
  if (!fs.existsSync(PROVIDERS_CSV)) throw new Error('providers.csv not found: ' + PROVIDERS_CSV);

  const csvLines = fs.readFileSync(PROVIDERS_CSV, 'utf8').trim().split('\n');
  const headers = csvLines[0].split(',').map(h => h.trim());
  const rows = csvLines.slice(1).map(line => {
    const vals = line.split(',');
    const row = {};
    headers.forEach((h, i) => { row[h] = (vals[i] || '').trim(); });
    return row;
  }).filter(r => r.provider);

  const byProvider = {};
  for (const row of rows) {
    if (!byProvider[row.provider]) byProvider[row.provider] = [];
    byProvider[row.provider].push(row);
  }

  let removed = 0;

  const specs = [
    {
      file: OPENCODE_FILE,
      container: 'provider',
      omniFlag: OPENCODE_OMNIRoute_PROVIDER,
      restFlag: OPENCODE_REST_PROVIDER,
      labelField: 'name',
      labelFor: (provider, idx) => `custom_${provider}_${idx}`,
      apiKeyOf: (inst) => inst && inst.options && inst.options.apiKey,
    },
    {
      file: KILO_FILE,
      container: 'provider',
      omniFlag: KILO_OMNIRoute_PROVIDER,
      restFlag: KILO_REST_PROVIDER,
      labelField: 'name',
      labelFor: (provider, idx) => `custom_${provider}_${idx}`,
      apiKeyOf: (inst) => inst && inst.options && inst.options.apiKey,
    },
    {
      file: T3_SETTINGS_FILE,
      container: 'providerInstances',
      omniFlag: T3_OMNIRoute_PROVIDER,
      restFlag: T3_REST_PROVIDER,
      labelField: 'displayName',
      labelFor: (provider, idx) => `${provider}_${idx}`,
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
      if (!key.startsWith('custom_')) continue;
      const parts = key.split('_');
      const provider = parts[1];
      if (!provider) continue;
      if (!grouped[provider]) grouped[provider] = [];
      grouped[provider].push({ key, inst: container[key] });
    }

    for (const provider of Object.keys(grouped)) {
      const isOmni = provider === 'omniroute';
      const flag = isOmni ? spec.omniFlag : spec.restFlag;
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
      if (!csvRows || isOmni) continue;

      const csvKeys = csvRows.map((r) => r.api_key);
      const placement = entries.map((e) => ({
        entry: e,
        rowIdx: csvKeys.indexOf(spec.apiKeyOf(e.inst)),
      }));
      const kept = placement.filter((p) => p.rowIdx !== -1).sort((a, b) => a.rowIdx - b.rowIdx);
      const built = [];
      for (const p of kept) {
        const suffix = p.entry.key.split('_').slice(3).join('_');
        const newKey = `custom_${provider}_${built.length + 1}` + (suffix ? '_' + suffix : '');
        const inst = p.entry.inst;
        if (spec.labelField && inst[spec.labelField]) {
          inst[spec.labelField] = spec.labelFor(provider, built.length + 1);
        }
        built.push({ newKey, inst });
      }
      if (built.length === entries.length && built.every((b) => container[b.newKey] === b.inst)) continue;
      for (const e of entries) delete container[e.key];
      for (const b of built) container[b.newKey] = b.inst;
      removed += (entries.length - kept.length);
    }

    fs.writeFileSync(spec.file, JSON.stringify(config, null, 2) + '\n', 'utf8');
  }

  return removed;
}


// ---------- syncOmnirouteProvider: write omniroute provider block (no markers, full replace) ----------
// Reads providers.csv + models.csv, builds complete omniroute provider block.
// Replaces entire omniroute block in target file. No marker dependency.
function syncOmnirouteProvider(targetFile) {
  if (!fs.existsSync(PROVIDERS_CSV)) throw new Error('providers.csv not found: ' + PROVIDERS_CSV);
  if (!fs.existsSync(MODELS_CSV)) throw new Error('models.csv not found: ' + MODELS_CSV);
  if (!fs.existsSync(targetFile)) throw new Error('Config file not found: ' + targetFile);

  const csvLines = fs.readFileSync(PROVIDERS_CSV, 'utf8').trim().split('\n');
  const headers = csvLines[0].split(',').map(h => h.trim());
  const rows = csvLines.slice(1).map(line => {
    const vals = line.split(',');
    const row = {};
    headers.forEach((h, i) => { row[h] = (vals[i] || '').trim(); });
    return row;
  }).filter(r => r.provider);

  const omnirouteRow = rows.find(r => r.provider === 'omniroute');
  if (!omnirouteRow) throw new Error('No omniroute provider found in providers.csv');

  const modelLines = fs.readFileSync(MODELS_CSV, 'utf8').split('\n')
    .map(l => l.trim()).filter(l => l.length > 0)
    .map(l => {
      const parts = l.split(',');
      return { id: parts[0], in: parseInt(parts[1] || '0', 10), out: parseInt(parts[2] || '0', 10) };
    })
    .filter(m => !m.id.endsWith('[1m]'));

  const models = {};
  for (const m of modelLines) {
    models[m.id] = {
      name: m.id + ' (custom)',
      attachment: true,
      reasoning: true,
      tool_call: true,
      temperature: true,
      limit: { context: m.in || 0, output: m.out || 0 }
    };
  }

  const omnirouteBlock = {
    name: 'OmniRoute',
    npm: '@ai-sdk/openai-compatible',
    options: {
      baseURL: omnirouteRow.base_url.replace(/\/$/, ''),
      apiKey: omnirouteRow.api_key
    },
    models: models
  };

  let config = {};
  const raw = fs.readFileSync(targetFile, 'utf8');
  const json = stripJsoncComments(raw).replace(/,\s*([}\]])/g, '$1').trim();
  try { config = JSON.parse(json); } catch (e) { throw new Error('Failed to parse ' + targetFile + ': ' + e.message); }
  config.provider = config.provider || {};
  config.provider['custom_omniroute'] = omnirouteBlock;

  fs.writeFileSync(targetFile, JSON.stringify(config, null, 2) + '\n', 'utf8');
  return Object.keys(models).length;
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


function syncT3Models(minInput = 0, minOutput = 0) {
  if (!fs.existsSync(MODELS_CSV)) {
    throw new Error('models.csv not found: ' + MODELS_CSV);
  }

  const models = fs.readFileSync(MODELS_CSV, 'utf8')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
    .map((l) => {
      const parts = l.split(',');
      return {
        id: parts[0],
        in: parseInt(parts[1] || '0', 10),
        out: parseInt(parts[2] || '0', 10)
      };
    })
    .filter((m) => {
      if (minInput > 0 && m.in < minInput) return false;
      if (minOutput > 0 && m.out < minOutput) return false;
      return true;
    });

  const filtered = applyModelFilters(models, T3_FILTERS);

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
  ensureOmnirouteInstances(settings);
  const omnirouteEntries = Object.entries(settings.providerInstances).filter(([k]) => k.startsWith('custom_omniroute_'));
  for (const [key, instance] of omnirouteEntries) {
    if (!instance.config) instance.config = {};
    const driverName = key.slice('custom_omniroute_'.length);
    const driverEntry = T3_OMNIROUTE_DRIVERS.find(e => e && typeof e === 'object' && e.driver === driverName);
    const supports1m = driverEntry ? !!driverEntry['1m'] : true;
    const modelsForDriver = supports1m
      ? customModels
      : customModels.filter(m => !m.endsWith('[1m]'));
    instance.config.customModels = modelsForDriver;
  }
  sortProviderInstances(settings);

  fs.mkdirSync(path.dirname(T3_SETTINGS_FILE), { recursive: true });
  fs.writeFileSync(T3_SETTINGS_FILE, JSON.stringify(settings, null, 2) + '\n', 'utf8');
  return customModels.length;
}

// ---------- run ----------
// Usage:
//   node model-list.js                 -> DEFAULT: fetch models -> models.csv only
//   node model-list.js opencode        -> sync model block into opencode.jsonc
//   node model-list.js kilo            -> sync model block into kilo.jsonc
//   node model-list.js kilopro         -> copy provider{} block opencode -> kilo
//   node model-list.js t3              -> sync flat model list into t3 claudeAgent
//   node model-list.js t3pro           -> t3 flat list + per-provider custom_* instances
//   node model-list.js all             -> fetch + opencode + kilo + t3
//   node model-list.js allpro          -> fetch + opencode + kilo + kilopro + t3pro
//   node model-list.js opencode kilo   -> combine targets (space-separated)
//
// Filters (default min-input-context is 200000; pass 0 to disable):
//   node model-list.js -mi 100000       -> override min input context
//   node model-list.js --min-output-limit 8192
//
// Help and info:
//   node model-list.js help             -> print this usage
//   node model-list.js -h / --help      -> same
//
// Legacy numeric steps still work as hidden aliases:
//   1=fetch  2=opencode+kilo  3=t3  4=t3providers  (1-4)

// ---------- install as command ----------
// INSTALL_AS_COMMAND = true auto-runs this; can also be triggered manually:
//   node model-list.js install | uninstall
// Runs PowerShell via -EncodedCommand so backslashes / quotes are NEVER
// mangled (a plain -Command string with JSON-escaped paths corrupts the
// User PATH with doubled backslashes).
function runPs(script) {
  const encoded = Buffer.from(script, 'utf16le').toString('base64');
  return execFileSync('powershell.exe', [
    '-NoProfile', '-NonInteractive', '-EncodedCommand', encoded,
  ], { encoding: 'utf8' });
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
  const scriptPath = path.join(__dirname, path.basename(__filename));
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
  const scriptDir = __dirname;
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
      changed.push(npmShim + '  (on current PATH: works instantly)');
    }
  }

  if (changed.length > 0) {
    console.log('Installed "' + CLI_COMMAND_NAME + '" command:');
    for (const r of changed) console.log('  - ' + r);
    console.log('Run it from any terminal:  ' + CLI_COMMAND_NAME + ' help');
  } else if (!quiet) {
    console.log('"' + CLI_COMMAND_NAME + '" command is already installed (nothing to do).');
  }
}

function uninstallAsCommand() {
  const scriptDir = __dirname;
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

// ---------- usage ----------
function printUsage() {
  console.log(`
model-list.js — fetch model catalog and sync into config files

Usage:
  node model-list.js [targets...] [options]

Targets (default if none given: fetch kilo t3 t3providers cleanup):
  fetch           Fetch models -> models.csv (next to this script; minInput default: 200000)
  opencode        Sync omniroute model block into opencode.jsonc
  opencoderest    Sync per-key custom_* REST provider blocks into opencode.jsonc
  kilo            Sync omniroute model block into kilo.jsonc
  kilorest        Sync per-key custom_* REST provider blocks into kilo.jsonc
  t3              Sync flat model list into T3 omniroute.customModels
  t3providers     Sync per-provider custom_* instances in T3 settings.json
  cleanupproviders  Reconcile script-managed custom_* providers (opt-in via flags)
  cleanup         Delete transient files (e.g. T3 logs dir)
  install         Register "model-list" as a command (shim + User PATH + npm shim)
  uninstall       Remove the registered command

Options:
  OPENCODE_OMNIRoute_PROVIDER=true    Sync omniroute model block into opencode.jsonc (default: false)
  OPENCODE_REST_PROVIDER=true         Sync per-key REST provider blocks into opencode.jsonc (default: false)
  T3_OMNIRoute_PROVIDER=true               Sync omniroute customModels into T3 settings.json (default: false)
  T3_REST_PROVIDER=true                    Sync per-provider instances in T3 settings.json (default: false)
  KILO_OMNIRoute_PROVIDER=true           Sync omniroute model block into kilo.jsonc (default: false)
  KILO_REST_PROVIDER=true                Sync per-key REST provider blocks into kilo.jsonc (default: false)
  KILO_COPY_OPENCODE_FULL_PROVIDER_BLOCK=true  Copy full provider{} block from opencode -> kilo (default: false)
  REMOVE_IF_FALSE_PROVIDER=true         Remove custom_* providers whose feature flag is false (default: false)
  REMOVE_IF_PROVIDER_DOESNT_EXIST=true  Remove custom_* providers missing from providers.csv (default: false)
  INSTALL_AS_COMMAND=true               Auto-register "model-list" as a command on every run (default: false)
  -mi, --min-input-context N   Skip models with input context < N (default: 200000, 0 = none)
  -mo, --min-output-limit N    Skip models with output < N (0 = none)
  --clean / --noclean          Enable/disable cleanup step (default: --clean)
  --new                        Re-prompt for the model endpoint URL/API key and overwrite the stored providers.csv key
  -h, --help                   Print usage

Legacy aliases:
  1 2 3 4 1-4

Examples:
  node model-list.js                  # default: fetch + opencode + kilo + t3 + cleanup
  node model-list.js t3               # only T3 flat list
  node model-list.js t3providers      # only T3 per-provider instances
  node model-list.js -mi 0 all        # fetch everything, no input filter
`);
}

// Atomic targets, in fixed execution order:
function buildOrder() {
  const order = ['fetch', 'cleanup'];
  if (OPENCODE_OMNIRoute_PROVIDER) order.splice(1, 0, 'opencode');
  if (OPENCODE_REST_PROVIDER) {
    const idx = order.indexOf('cleanup');
    order.splice(idx, 0, 'opencoderest');
  }
  if (KILO_OMNIRoute_PROVIDER) {
    const idx = order.indexOf('cleanup');
    order.splice(idx, 0, 'kilo');
  }
  if (KILO_REST_PROVIDER) {
    const idx = order.indexOf('cleanup');
    order.splice(idx, 0, 'kilorest');
  }
  if (KILO_COPY_OPENCODE_FULL_PROVIDER_BLOCK) {
    const idx = order.indexOf('cleanup');
    order.splice(idx, 0, 'kilopro');
  }
  if (T3_OMNIRoute_PROVIDER) {
    const idx = order.indexOf('cleanup');
    order.splice(idx, 0, 't3models');
  }
  if (T3_REST_PROVIDER) {
    const idx = order.indexOf('cleanup');
    order.splice(idx, 0, 't3providers');
  }
  const cleanupIdx = order.indexOf('cleanup');
  order.splice(cleanupIdx, 0, 'cleanupproviders');
  return order;
}

// CLI word -> atomic targets
const WORD_MAP = {
  fetch: ['fetch'],
  opencode: ['opencode'],
  opencoderest: ['opencoderest'],
  kilo: ['kilo'],
  kilorest: ['kilorest'],
  t3: ['t3models'],
  t3providers: ['t3models', 't3providers'],
  cleanup: ['cleanup'],
  cleanupproviders: ['cleanupproviders'],
  install: ['install'],
  uninstall: ['uninstall'],
  all: (() => {
    const t = ['fetch', 'cleanup'];
    if (OPENCODE_OMNIRoute_PROVIDER) t.push('opencode');
    if (OPENCODE_REST_PROVIDER) t.push('opencoderest');
    if (KILO_OMNIRoute_PROVIDER) t.push('kilo');
    if (KILO_REST_PROVIDER) t.push('kilorest');
    if (KILO_COPY_OPENCODE_FULL_PROVIDER_BLOCK) t.push('kilopro');
    if (T3_OMNIRoute_PROVIDER) t.push('t3models');
    if (T3_REST_PROVIDER) t.push('t3providers');
    t.push('cleanupproviders');
    return t;
  })(),
  allpro: (() => {
    const t = ['fetch', 'cleanup'];
    if (OPENCODE_OMNIRoute_PROVIDER) t.push('opencode');
    if (OPENCODE_REST_PROVIDER) t.push('opencoderest');
    if (KILO_OMNIRoute_PROVIDER) t.push('kilo');
    if (KILO_REST_PROVIDER) t.push('kilorest');
    if (KILO_COPY_OPENCODE_FULL_PROVIDER_BLOCK) t.push('kilopro');
    if (T3_OMNIRoute_PROVIDER) t.push('t3models');
    if (T3_REST_PROVIDER) t.push('t3providers');
    t.push('cleanupproviders');
    return t;
  })(),
};

// Legacy numeric step -> atomic targets
const NUM_MAP = {
  1: ['fetch'],
  2: ['opencode', 'kilo'],
  3: ['t3models'],
  4: ['t3models', 't3providers'],
};

function parseArgs() {
  const args = {
    targets: new Set(),
    minInput: MIN_INPUT_TOKENS_DEFAULT,
    minOutput: MIN_OUTPUT_TOKENS_DEFAULT,
    cleanup: CLEANUP_DEFAULT,
    newEndpoint: false,
  };
  const raw = process.argv.slice(2).filter((a) => a.length > 0);

  for (let i = 0; i < raw.length; i++) {
    const a = raw[i];

    // ----- filter flags -----
    let val = null;
    let isMinInput = false;
    let isMinOutput = false;

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
    }

    if (val !== null) {
      const n = parseInt(val, 10);
      if (!isNaN(n) && n >= 0) {
        if (isMinInput) args.minInput = n;
        if (isMinOutput) args.minOutput = n;
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

    // ----- force re-prompt for the model endpoint -----
    if (a === '--new') {
      args.newEndpoint = true;
      continue;
    }

    // ----- help -----
    if (a.toLowerCase() === 'help' || a === '-h' || a === '--help') {
      printUsage();
      process.exit(0);
    }

    // ----- legacy: -a / -all -> allpro -----
    if (a === '-a' || a === '-all') {
      WORD_MAP.allpro.forEach((t) => args.targets.add(t));
      continue;
    }

    // ----- named target words -----
    const word = a.toLowerCase();
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

    console.error(`Unknown argument: "${a}" (try: opencode, kilo, t3, t3providers, all, help)`);
    console.error('Run "node model-list.js help" for usage.');
    process.exit(1);
  }

  // Default: everything except kilopro
  if (args.targets.size === 0) {
    buildOrder().forEach((t) => args.targets.add(t));
  }

  return args;
}

(async () => {
  const args = parseArgs();
  const has = (t) => args.targets.has(t);
  let failed = false;
  try {
    if (INSTALL_AS_COMMAND && !args.targets.has('uninstall') && !args.targets.has('install')) {
      installAsCommand(true);
    }
    if (has('install')) installAsCommand();
    if (has('uninstall')) uninstallAsCommand();
    for (const target of buildOrder()) {
      if (!has(target)) continue;
      try {
        switch (target) {
          case 'fetch': {
            const n = await fetchModels(args.minInput, args.minOutput, args.newEndpoint);
            console.log(`Wrote ${n} models to ${MODELS_CSV}`);
            break;
          }
          case 'opencode': {
            if (!fs.existsSync(OPENCODE_FILE)) {
              console.log(`Skipped opencode (not found: ${OPENCODE_FILE})`);
              break;
            }
            const n = syncOmnirouteProvider(OPENCODE_FILE);
            console.log(`Synced omniroute provider block in ${OPENCODE_FILE} (${n} models)`);
            break;
          }
          case 'kilo': {
            if (!fs.existsSync(KILO_FILE)) {
              console.log(`Skipped kilo (not found: ${KILO_FILE})`);
              break;
            }
            const n = syncOmnirouteProvider(KILO_FILE);
            console.log(`Synced omniroute provider block in ${KILO_FILE} (${n} models)`);
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
            const n = syncT3Models(args.minInput, args.minOutput);
            console.log(`Synced flat customModels in ${T3_SETTINGS_FILE} (${n} entries)`);
            break;
          }
          case 't3providers': {
            const n = syncT3Providers();
            console.log(`Synced per-provider claudeAgent instances in ${T3_SETTINGS_FILE} (${n} instances)`);
            break;
          }
          case 'opencoderest': {
            if (!fs.existsSync(OPENCODE_FILE)) {
              console.log(`Skipped opencoderest (not found: ${OPENCODE_FILE})`);
              break;
            }
            const n = syncOpencodeRestProviders();
            console.log(`Synced REST provider blocks in ${OPENCODE_FILE} (${n} providers)`);
            break;
          }
          case 'kilorest': {
            if (!fs.existsSync(KILO_FILE)) {
              console.log(`Skipped kilorest (not found: ${KILO_FILE})`);
              break;
            }
            const n = syncKiloRestProviders();
            console.log(`Synced REST provider blocks in ${KILO_FILE} (${n} providers)`);
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
        }
      } catch (e) {
        failed = true;
        console.error(`[${target}] Error: ${e.message}`);
      }
    }
  } catch (e) {
    console.error('Error:', e.message);
    process.exit(1);
  }
  if (failed) process.exitCode = 1;
})();
