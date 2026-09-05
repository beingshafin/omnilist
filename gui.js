'use strict';
// Omnilist GUI — zero-dependency local web dashboard for editing config.jsonc,
// running the sync pipeline, and inspecting the model catalog.
// Started via `node omnilist.js gui [port]` (or `omnilist gui`); binds 127.0.0.1 only.

const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const {
  DEFAULTS,
  loadConfig,
  deepMerge,
  stripJsoncComments,
  parseModelSort,
  parseRule,
  parseModelFilterEntry,
  parseHarnessFilterEntry,
  parseOverrideEntry,
  resolvePath,
  applyModelFilters,
  parseTopNDirective,
  sortModels,
} = require('./omnilist.js');

const DEFAULT_PORT = 55555;
let currentServer = null;
let currentPort = DEFAULT_PORT;
const SCRIPT = path.join(__dirname, 'omnilist.js');

// Canonical harness ids shown in dropdowns (labels the UI maps itself).
const HARNESS_IDS = ['opencode', 'kilo', 't3', 'dsh', 'pi', 'zcode', 'ocx'];

// ---------------------------------------------------------------------------
// config file access
// ---------------------------------------------------------------------------

// Mirrors loadConfig()'s file selection: OMNILIST_CONFIG replaces the pair
// entirely; otherwise config.jsonc (legacy config.json fallback) + local overlay.
function configFilePaths() {
  if (process.env.OMNILIST_CONFIG) {
    return { primary: process.env.OMNILIST_CONFIG, local: null };
  }
  const primary = path.join(__dirname, 'config.jsonc');
  const legacy = path.join(__dirname, 'config.json');
  return {
    primary: !fs.existsSync(primary) && fs.existsSync(legacy) ? legacy : primary,
    local: path.join(__dirname, 'config.local.jsonc'),
  };
}

// Write target per priority rule: the local override file when it exists,
// otherwise the primary config file.
function resolveWriteTarget() {
  const { primary, local } = configFilePaths();
  if (local && fs.existsSync(local)) return local;
  return primary;
}

function parseJsoncFile(file) {
  if (!fs.existsSync(file)) return { ok: true, data: {} };
  try {
    const raw = fs.readFileSync(file, 'utf8');
    const json = stripJsoncComments(raw).replace(/,\s*([}\]])/g, '$1').trim();
    return { ok: true, data: JSON.parse(json) };
  } catch (e) {
    return { ok: false, error: e.message, data: null };
  }
}

// ---------------------------------------------------------------------------
// JSONC serialization
// ---------------------------------------------------------------------------

const SECTION_COMMENTS = {
  paths: 'paths — catalog + harness config file locations (~, absolute, or relative to the script dir)',
  cli: 'cli — global command registration',
  fetch: 'fetch — where the model list comes from ("" = {base_url}/models from the Router row)',
  capabilities: 'capabilities — which router model fields to probe for vision/reasoning/tool',
  model_sort: 'model sort — CSV column order for the filtered pipeline; "-" = descending, comma-separated',
  model_filters: 'model filters — C-like expressions, last matching rule wins',
  harness_filters: 'harness filters — second-stage filters at sync time; "rule->t3,dsh" targets specific harnesses',
  invalid_value_overrides: 'invalid_value_overrides — "(field:value)" or "(field:value)->t3,dsh"; rewrite only when current value is invalid',
  always_overrides: 'always_overrides — same syntax, unconditional rewrite',
  raw_catalog_harnesses: 'raw catalog — harnesses that read models-all.csv instead of models-filtered.csv',
  show_harness_model_list: 'previews — per-harness model list CSVs (models-<harness>.csv): raw | all | configured | none',
  custom_models: 'custom models — injected models; never filtered out',
  targets: 'targets — per-harness sync switches',
  follow_hardcoded_model_template: 'template — emit full hardcoded model template into OpenCode/Kilo blocks',
  cleanup_default: 'cleanup — default for the cleanup step (CLI --clean/--noclean)',
  t3: 't3 — drivers and driver strategy',
  opencode: 'adapters — opencode',
  kilo: 'adapters — kilo',
  pi: 'adapters — pi',
  zcode: 'adapters — zcode',
  opencodex: 'adapters — opencodex',
  dsh: 'dsh — adapters and model inputs',
  cleanup_providers: 'cleanup providers — prune stale c-* keys',
  custom_commands: 'custom commands — run after all sync targets; "sleep <s>" pauses, "bg:<cmd>" detaches',
};

// Keys are written in DEFAULTS order first (canonical), unknown keys after.
function keyOrder(obj) {
  const known = Object.keys(DEFAULTS).filter((k) => k in obj);
  const extra = Object.keys(obj).filter((k) => !(k in DEFAULTS));
  return known.concat(extra);
}

function stringifyValue(v, pad) {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  const inner = pad + '  ';
  if (Array.isArray(v)) {
    if (!v.length) return '[]';
    const items = v.map((x) => inner + stringifyValue(x, inner));
    return '[\n' + items.join(',\n') + '\n' + pad + ']';
  }
  const entries = Object.entries(v).map(([k, val]) => inner + JSON.stringify(k) + ': ' + stringifyValue(val, inner));
  if (!entries.length) return '{}';
  return '{\n' + entries.join(',\n') + '\n' + pad + '}';
}

function toJsoncBody(obj) {
  const lines = [];
  for (const k of keyOrder(obj)) {
    if (SECTION_COMMENTS[k]) lines.push('  // ' + SECTION_COMMENTS[k]);
    lines.push('  ' + JSON.stringify(k) + ': ' + stringifyValue(obj[k], '  ') + ',');
  }
  // trim trailing comma of the last entry
  if (lines.length) {
    lines[lines.length - 1] = lines[lines.length - 1].replace(/,$/, '');
  }
  return '{\n' + lines.join('\n') + '\n}\n';
}

const LOCAL_HEADER = `/*
  OMNILIST LOCAL OVERRIDES — private values layered over config.jsonc (deep-merged).
  Written by the omnilist GUI (\`omnilist gui\`); hand edits welcome.
  Only keys that differ from the built-in defaults are kept here —
  delete a key to fall back to config.jsonc / defaults.
*/

`;

const GENERATED_HEADER = `/*
  OMNILIST CONFIGURATION  (JSONC — comments allowed, unlike plain JSON)

  Every key is OPTIONAL; anything left out falls back to built-in defaults.
  Personal overrides belong in config.local.jsonc (gitignored) — this file is
  committed to git. Regenerated by the omnilist GUI; see README for the full
  reference (filter expressions, harness ids, override syntax).
*/

`;

// Everything before the body-opening "{" line, when it is only comments and
// whitespace, is the user's documentation header and is preserved verbatim.
function preservedHeader(raw) {
  const m = /^[ \t]*\{/m.exec(raw);
  if (!m) return null;
  const head = raw.slice(0, m.index);
  try {
    if (stripJsoncComments(head).trim() !== '') return null;
  } catch (e) {
    return null;
  }
  return head;
}

// ---------------------------------------------------------------------------
// config diffing (what goes into config.local.jsonc)
// ---------------------------------------------------------------------------

// Recursive leaf-level diff for plain objects; arrays diff wholesale (they are
// semantic units — deepMerge replaces them anyway).
function diffConfig(eff, def) {
  const out = {};
  for (const k of Object.keys(eff)) {
    const ev = eff[k];
    const dv = def ? def[k] : undefined;
    if (dv === undefined) { out[k] = ev; continue; }
    const bothObj = ev && dv && typeof ev === 'object' && typeof dv === 'object'
      && !Array.isArray(ev) && !Array.isArray(dv);
    if (bothObj) {
      const sub = diffConfig(ev, dv);
      if (Object.keys(sub).length) out[k] = sub;
    } else if (JSON.stringify(ev) !== JSON.stringify(dv)) {
      out[k] = ev;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// run pipeline (child process + SSE stream)
// ---------------------------------------------------------------------------

const RUN_WORDS = new Set([
  'fetch', 'opencode', 'opencoderest', 'kilo', 'kilorest', 't3', 't3rest',
  'dsh', 'dshrest', 'pi', 'pirest', 'zcode', 'zcoderest', 'opencodex',
  'opencodexrest', 'ocx', 'ocxrest', 'cleanup', 'cleanupproviders', 'cleanmodels',
  'removemodels', 'commands', 'all', 'allpro',
  '--router', '--rest', '--solo',
]);

let run = null; // { child, lines: [{stream, text}], done, exitCode, startedAt, cmdline }
const sseClients = new Set();

function sseSend(res, event, data, id) {
  res.write(`id: ${id}\nevent: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

function broadcast(event, data, id) {
  for (const res of sseClients) {
    try { sseSend(res, event, data, id); } catch (e) { /* client gone */ }
  }
}

function startRun(body) {
  if (run && !run.done) return { error: 'a run is already active', status: 409 };
  const targets = Array.isArray(body.targets) ? body.targets.filter((t) => typeof t === 'string') : [];
  const bad = targets.filter((t) => !RUN_WORDS.has(t));
  if (bad.length) return { error: `unknown target(s): ${bad.join(', ')}`, status: 400 };

  const args = [SCRIPT];
  for (const t of targets) args.push(t);
  const mi = parseInt(body.minInput, 10);
  const mo = parseInt(body.minOutput, 10);
  if (!isNaN(mi) && mi > 0) args.push('-mi', String(mi));
  if (!isNaN(mo) && mo > 0) args.push('-mo', String(mo));
  if (body.cleanup === true) args.push('--clean');
  if (body.cleanup === false) args.push('--noclean');

  // Fresh process so a just-saved config is picked up (config is frozen at
  // require time inside omnilist.js).
  const child = spawn(process.execPath, args, { cwd: __dirname, windowsHide: true });
  run = { child, lines: [], done: false, exitCode: null, startedAt: Date.now(), cmdline: 'omnilist ' + targets.join(' ') };

  const emit = (stream) => {
    let buf = '';
    return (chunk) => {
      buf += chunk.toString('utf8');
      const parts = buf.split(/\r?\n/);
      buf = parts.pop();
      for (const line of parts) {
        run.lines.push({ stream, text: line });
        broadcast('log', run.lines[run.lines.length - 1], run.lines.length - 1);
      }
    };
  };
  child.stdout.on('data', emit('out'));
  child.stderr.on('data', emit('err'));
  child.on('error', (err) => {
    run.lines.push({ stream: 'err', text: 'Failed to start: ' + err.message });
    broadcast('log', run.lines[run.lines.length - 1], run.lines.length - 1);
    run.done = true;
    run.exitCode = 1;
    broadcast('done', { code: 1 }, run.lines.length);
  });
  child.on('close', (code) => {
    if (!run) return;
    run.done = true;
    run.exitCode = code == null ? 1 : code;
    broadcast('done', { code: run.exitCode }, run.lines.length);
  });
  return { ok: true, cmdline: run.cmdline };
}

function stopRun() {
  if (!run || run.done) return { error: 'no active run', status: 404 };
  run.child.kill();
  return { ok: true };
}

// ---------------------------------------------------------------------------
// CSV helpers
// ---------------------------------------------------------------------------

function parseCsv(text) {
  const rows = [];
  let row = [];
  let cur = '';
  let q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"') {
        if (text[i + 1] === '"') { cur += '"'; i++; } else q = false;
      } else cur += c;
    } else if (c === '"') {
      q = true;
    } else if (c === ',') {
      row.push(cur); cur = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(cur); cur = '';
      if (row.length > 1 || row[0].trim() !== '') rows.push(row);
      row = [];
    } else cur += c;
  }
  if (cur !== '' || row.length) { row.push(cur); rows.push(row); }
  return rows;
}

function readModelsCsv(which) {
  const cfg = loadConfig();
  const allBase = resolveish(cfg.paths.all_models_csv) || path.join(__dirname, 'models-all.csv');
  const filteredBase = resolveish(cfg.paths.models_csv) || path.join(__dirname, 'models-filtered.csv');
  let file = filteredBase;
  if (which === 'all') {
    file = allBase;
  } else if (which && which.startsWith('all-')) {
    const prov = which.slice(4);
    file = path.join(path.dirname(allBase), `models-all-${prov}.csv`);
  } else if (which && which.startsWith('filtered-')) {
    const prov = which.slice(9);
    file = path.join(path.dirname(filteredBase), `models-filtered-${prov}.csv`);
  } else if (which && which.startsWith('harness-')) {
    const h = which.slice(8);
    file = path.join(path.dirname(filteredBase), `models-${h}.csv`);
  }
  if (!fs.existsSync(file)) return { exists: false, path: file, rows: [] };
  const rows = parseCsv(fs.readFileSync(file, 'utf8'));
  const header = rows.shift() || [];
  const out = rows.map((r) => {
    const o = {};
    header.forEach((h, i) => (o[h] = r[i] === undefined ? '' : r[i]));
    return o;
  });
  return { exists: true, path: file, rows: out };
}

function resolveish(p) {
  if (!p) return '';
  if (p.startsWith('~') || path.isAbsolute(p)) {
    const home = (process.env.USERPROFILE || process.env.HOME || '').replace(/\\/g, '/');
    return p.replace(/^~/, home).replace(/\\/g, '/');
  }
  return path.join(__dirname, p);
}

function maskKey(k) {
  const s = String(k || '');
  if (!s) return '';
  if (s.length <= 8) return '***';
  return s.slice(0, 3) + '…' + s.slice(-4);
}

function readProviders() {
  const cfg = loadConfig();
  const file = resolveish(cfg.paths.providers_csv) || path.join(__dirname, 'providers.csv');
  if (!fs.existsSync(file)) return { exists: false, path: file, rows: [], raw: '' };
  const rawData = fs.readFileSync(file, 'utf8');
  const rows = parseCsv(rawData);
  if (!rows.length) return { exists: true, path: file, rows: [], raw: rawData };
  const headerRow = rows.shift() || [];
  const headerMap = {};
  headerRow.forEach((h, i) => { headerMap[h.trim().toLowerCase()] = i; });
  const hasTypeCol = 'type' in headerMap;

  const out = rows
    .filter((r) => r.length >= 2)
    .map((r, idx) => {
      let rawProvider = (hasTypeCol && headerMap['provider'] !== undefined ? r[headerMap['provider']] : r[0]) || '';
      const trimmedProv = rawProvider.trim();
      const disabled = trimmedProv.startsWith('#') || trimmedProv.startsWith('//');
      const provider = disabled ? trimmedProv.replace(/^(#|\/\/)\s*/, '') : rawProvider.trim();

      let type = hasTypeCol && headerMap['type'] !== undefined ? (r[headerMap['type']] || '').trim().toLowerCase() : '';
      let desc = hasTypeCol && headerMap['description'] !== undefined ? (r[headerMap['description']] || '').trim() : (r[3] || '').trim();
      if (!type) {
        if (desc === 'Router' || desc.toLowerCase() === 'router') type = 'router';
        else if (desc.toLowerCase() === 'solo') type = 'solo';
        else type = 'rest';
      }
      const isRouter = type === 'router';
      const isSolo = type === 'solo';
      return {
        index: idx,
        provider,
        base_url: (hasTypeCol && headerMap['base_url'] !== undefined ? r[headerMap['base_url']] : r[1]) || '',
        api_key: maskKey(hasTypeCol && headerMap['api_key'] !== undefined ? r[headerMap['api_key']] : r[2]),
        raw_key: (hasTypeCol && headerMap['api_key'] !== undefined ? r[headerMap['api_key']] : r[2]) || '',
        type,
        description: desc,
        isRouter,
        isSolo,
        disabled,
      };
    });
  return { exists: true, path: file, rows: out, raw: rawData };
}

function writeProvidersCsv(rows) {
  const cfg = loadConfig();
  const file = resolveish(cfg.paths.providers_csv) || path.join(__dirname, 'providers.csv');
  const header = 'provider,base_url,api_key,type,description\n';
  const csvEscape = (val) => {
    const s = String(val == null ? '' : val);
    if (/[",\n\r]/.test(s)) {
      return '"' + s.replace(/"/g, '""') + '"';
    }
    return s;
  };
  const body = rows.map((r) => {
    const line = [r.provider, r.base_url, r.api_key, r.type || 'rest', r.description || ''].map(csvEscape).join(',');
    return r.disabled ? `# ${line}` : line;
  }).join('\n') + '\n';
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, header + body, 'utf8');
}

// ---------------------------------------------------------------------------
// validation endpoint
// ---------------------------------------------------------------------------

function validateExpr(kind, expr) {
  try {
    if (kind === 'model' || kind === 'model_filter') {
      // top/bottom-N directives are valid model_filters entries too
      const m = expr.trim().match(/^\(?(top|bottom)(\d+)((?::-[^)\s]+)*)\)?$/i);
      if (m && m[3]) parseModelSort(m[3].split(':').map((s) => s.trim()).filter(Boolean).join(','));
      if (!m) parseRule(expr);
      return { ok: true };
    }
    if (kind === 'harness' || kind === 'harness_filter') {
      const { rule } = parseHarnessFilterEntry(expr);
      const m = rule.trim().match(/^\(?(top|bottom)(\d+)((?::-[^)\s]+)*)\)?$/i);
      if (m && m[3]) parseModelSort(m[3].split(':').map((s) => s.trim()).filter(Boolean).join(','));
      else if (!m) parseRule(rule);
      return { ok: true };
    }
    if (kind === 'override') {
      const parsed = parseOverrideEntry(expr);
      return parsed ? { ok: true } : { ok: false, error: 'expected "(field:value)" or "(field:value)->t3,dsh" — fields: id, input_context, output_context, vision, reasoning, tool' };
    }
    if (kind === 'sort') {
      parseModelSort(expr);
      return { ok: true };
    }
    return { ok: false, error: 'unknown kind' };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

// Live preview for the rule builder: run a candidate filter list against the
// raw catalog and report what survives, so the UI can show a match count and
// sample ids before anything is saved.
function previewFilters(filters, sortSpec) {
  const raw = readModelsCsv('all');
  if (!raw.exists) return { available: false, reason: 'models-all.csv not found — run fetch first' };
  const rows = raw.rows.map((r) => ({
    id: r.id,
    in: parseInt(r.input_context, 10) || 0,
    out: parseInt(r.output_context, 10) || 0,
    vision: parseInt(r.vision, 10),
    reasoning: parseInt(r.reasoning, 10),
    tool: parseInt(r.tool, 10),
  }));
  const list = Array.isArray(filters) ? filters.filter((f) => typeof f === 'string' && f.trim()) : [];
  // top/bottom-N directives are applied after the boolean rules, like fetch does
  const plain = [];
  let topN = null;
  for (const f of list) {
    const d = parseTopNDirective(f);
    if (d) topN = d;
    else plain.push(f);
  }
  let kept = applyModelFilters(rows, plain);
  let spec = null;
  try { spec = parseModelSort(sortSpec || 'id'); } catch (e) { spec = null; }
  kept = sortModels(kept, topN && topN.sort ? topN.sort : spec);
  if (topN) kept = topN.dir === 'top' ? kept.slice(0, topN.n) : kept.slice(-topN.n);
  return {
    available: true,
    total: rows.length,
    kept: kept.length,
    sample: kept.slice(0, 12).map((m) => m.id),
  };
}

// ---------------------------------------------------------------------------
// HTTP plumbing
// ---------------------------------------------------------------------------

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > 5 * 1024 * 1024) { reject(new Error('body too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch (e) { reject(new Error('invalid JSON body: ' + e.message)); }
    });
    req.on('error', reject);
  });
}

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(body);
}

function handleApi(req, res, url) {
  const route = url.pathname;

  if (req.method === 'GET' && route === '/api/config') {
    const { primary, local } = configFilePaths();
    const base = parseJsoncFile(primary);
    const localParsed = local ? parseJsoncFile(local) : { ok: true, data: {} };
    return sendJson(res, 200, {
      defaults: DEFAULTS,
      base: base.data,
      baseError: base.ok ? null : base.error,
      baseFile: primary,
      local: localParsed.data,
      localError: localParsed.ok ? null : localParsed.error,
      localFile: local,
      localExists: !!(local && fs.existsSync(local)),
      effective: loadConfig(),
      writeTarget: resolveWriteTarget(),
    });
  }

  if (req.method === 'POST' && route === '/api/config') {
    return readBody(req).then((body) => {
      const cfg = body.config;
      if (!cfg || typeof cfg !== 'object' || Array.isArray(cfg)) {
        return sendJson(res, 400, { error: 'expected { config: {...} }' });
      }
      const target = resolveWriteTarget();
      let header;
      // one-generation backup so a bad save is always recoverable
      if (fs.existsSync(target)) fs.copyFileSync(target, target + '.bak');
      if (target.endsWith('config.local.jsonc')) {
        const { primary } = configFilePaths();
        const base = parseJsoncFile(primary);
        const baseMerged = deepMerge(JSON.parse(JSON.stringify(DEFAULTS)), base.ok && base.data ? base.data : {});
        const diff = diffConfig(cfg, baseMerged);
        header = LOCAL_HEADER;
        fs.writeFileSync(target, header + toJsoncBody(diff), 'utf8');
        return sendJson(res, 200, { written: target, mode: 'diff', keys: Object.keys(diff) });
      }
      // writing the primary file: keep the user's doc header when the file
      // already exists and its preamble is pure comments
      const prev = fs.existsSync(target) ? fs.readFileSync(target, 'utf8') : '';
      const keep = preservedHeader(prev);
      header = keep !== null && keep !== undefined ? keep : GENERATED_HEADER;
      fs.writeFileSync(target, header + toJsoncBody(cfg), 'utf8');
      return sendJson(res, 200, { written: target, mode: 'full', headerPreserved: keep != null });
    }).catch((e) => sendJson(res, 400, { error: e.message }));
  }

  if (req.method === 'GET' && route === '/api/models/files') {
    const cfg = loadConfig();
    const allBase = resolveish(cfg.paths.all_models_csv) || path.join(__dirname, 'models-all.csv');
    const filteredBase = resolveish(cfg.paths.models_csv) || path.join(__dirname, 'models-filtered.csv');
    const dir = path.dirname(filteredBase);

    const router = {
      filtered: fs.existsSync(filteredBase),
      all: fs.existsSync(allBase),
    };

    const providersData = readProviders();
    const soloProviders = (providersData.rows || []).filter((r) => r.type === 'solo');
    const solo = soloProviders.map((p) => {
      const allFile = path.join(path.dirname(allBase), `models-all-${p.provider}.csv`);
      const filteredFile = path.join(dir, `models-filtered-${p.provider}.csv`);
      return {
        provider: p.provider,
        filtered: fs.existsSync(filteredFile),
        all: fs.existsSync(allFile),
      };
    });

    const harnesses = ['opencode', 'kilo', 't3', 'dsh', 'pi', 'zcode', 'ocx'].filter((h) => {
      return fs.existsSync(path.join(dir, `models-${h}.csv`));
    });

    return sendJson(res, 200, { router, solo, harnesses });
  }

  if (req.method === 'GET' && route === '/api/models') {
    const which = url.searchParams.get('file') || 'filtered';
    return sendJson(res, 200, readModelsCsv(which));
  }

  if (req.method === 'GET' && route === '/api/providers') {
    return sendJson(res, 200, readProviders());
  }

  if (req.method === 'GET' && route === '/api/providers/raw') {
    const cfg = loadConfig();
    const file = resolveish(cfg.paths.providers_csv) || path.join(__dirname, 'providers.csv');
    const content = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
    return sendJson(res, 200, { path: file, content });
  }

  if (req.method === 'POST' && route === '/api/providers/raw') {
    return readBody(req).then((body) => {
      const content = String(body.content || '');
      const cfg = loadConfig();
      const file = resolveish(cfg.paths.providers_csv) || path.join(__dirname, 'providers.csv');
      const parsed = parseCsv(content);
      if (!parsed.length) throw new Error('CSV cannot be empty');
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, content.endsWith('\n') ? content : content + '\n', 'utf8');
      return sendJson(res, 200, { ok: true, message: 'providers.csv saved successfully' });
    }).catch((e) => sendJson(res, 400, { error: e.message }));
  }

  if (req.method === 'POST' && route === '/api/providers') {
    return readBody(req).then((body) => {
      const current = readProviders();
      const rows = current.rows.map(r => ({
        provider: r.provider,
        base_url: r.base_url,
        api_key: r.raw_key,
        type: r.type,
        description: r.description,
        disabled: Boolean(r.disabled),
      }));

      const provider = (body.provider || '').trim();
      const base_url = (body.base_url || '').trim();
      const api_key = (body.api_key || '').trim();
      const type = (body.type || 'rest').toLowerCase();
      const description = (body.description || '').trim();
      const disabled = Boolean(body.disabled);

      if (!provider) throw new Error('Provider name is required');
      if (!base_url) throw new Error('Base URL is required');

      if (type === 'router' && !disabled) {
        const existingRouter = rows.find(r => r.type === 'router' && !r.disabled);
        if (existingRouter) throw new Error(`An active Router provider already exists (${existingRouter.provider}). OmniList only supports one active Router.`);
      }

      rows.push({ provider, base_url, api_key, type, description, disabled });
      writeProvidersCsv(rows);
      return sendJson(res, 200, { ok: true, message: 'Provider added' });
    }).catch((e) => sendJson(res, 400, { error: e.message }));
  }

  if (req.method === 'PUT' && route === '/api/providers') {
    return readBody(req).then((body) => {
      const current = readProviders();
      const rows = current.rows.map(r => ({
        provider: r.provider,
        base_url: r.base_url,
        api_key: r.raw_key,
        type: r.type,
        description: r.description,
        disabled: Boolean(r.disabled),
      }));

      const index = parseInt(body.index, 10);
      if (isNaN(index) || index < 0 || index >= rows.length) throw new Error('Invalid provider index');

      const provider = (body.provider || '').trim();
      const base_url = (body.base_url || '').trim();
      let api_key = (body.api_key !== undefined) ? String(body.api_key).trim() : '';
      if (!api_key || api_key.includes('…') || api_key === '***') {
        api_key = rows[index].api_key;
      }
      const type = (body.type || 'rest').toLowerCase();
      const description = (body.description || '').trim();
      const disabled = body.disabled !== undefined ? Boolean(body.disabled) : Boolean(rows[index].disabled);

      if (!provider) throw new Error('Provider name is required');
      if (!base_url) throw new Error('Base URL is required');

      if (type === 'router' && !disabled) {
        const otherRouter = rows.find((r, i) => i !== index && r.type === 'router' && !r.disabled);
        if (otherRouter) throw new Error(`Another active Router already exists (${otherRouter.provider}). Only one active Router allowed.`);
      }

      rows[index] = { provider, base_url, api_key, type, description, disabled };
      writeProvidersCsv(rows);
      return sendJson(res, 200, { ok: true, message: 'Provider updated' });
    }).catch((e) => sendJson(res, 400, { error: e.message }));
  }

  if (req.method === 'POST' && route === '/api/providers/toggle') {
    return readBody(req).then((body) => {
      const current = readProviders();
      const rows = current.rows.map(r => ({
        provider: r.provider,
        base_url: r.base_url,
        api_key: r.raw_key,
        type: r.type,
        description: r.description,
        disabled: Boolean(r.disabled),
      }));

      const index = parseInt(body.index, 10);
      if (isNaN(index) || index < 0 || index >= rows.length) throw new Error('Invalid provider index');

      const target = rows[index];
      const willBeDisabled = !target.disabled;

      if (!willBeDisabled && target.type === 'router') {
        const otherRouter = rows.find((r, i) => i !== index && r.type === 'router' && !r.disabled);
        if (otherRouter) throw new Error(`Another active Router already exists (${otherRouter.provider}). Only one active Router allowed.`);
      }

      target.disabled = willBeDisabled;
      writeProvidersCsv(rows);
      return sendJson(res, 200, { ok: true, message: `Provider ${willBeDisabled ? 'disabled' : 'enabled'}`, disabled: willBeDisabled });
    }).catch((e) => sendJson(res, 400, { error: e.message }));
  }

  if (req.method === 'DELETE' && route === '/api/providers') {
    return readBody(req).then((body) => {
      const current = readProviders();
      const rows = current.rows.map(r => ({
        provider: r.provider,
        base_url: r.base_url,
        api_key: r.raw_key,
        type: r.type,
        description: r.description,
        disabled: Boolean(r.disabled),
      }));

      const index = parseInt(body.index, 10);
      if (isNaN(index) || index < 0 || index >= rows.length) throw new Error('Invalid provider index');

      rows.splice(index, 1);
      writeProvidersCsv(rows);
      return sendJson(res, 200, { ok: true, message: 'Provider deleted' });
    }).catch((e) => sendJson(res, 400, { error: e.message }));
  }

  if (req.method === 'POST' && route === '/api/validate') {
    return readBody(req).then((body) => {
      sendJson(res, 200, validateExpr(body.kind, String(body.expr || '')));
    }).catch((e) => sendJson(res, 400, { error: e.message }));
  }

  // Directory listing for the path pickers: folders first, then files, no dotfiles.
  if (req.method === 'GET' && route === '/api/browse') {
    let dir = url.searchParams.get('dir') || '~';
    dir = resolveish(dir) || dir;
    try {
      const entries = fs.readdirSync(dir, { withFileTypes: true })
        .filter((e) => !e.name.startsWith('.'))
        .sort((a, b) => (b.isDirectory() - a.isDirectory()) || a.name.localeCompare(b.name));
      return sendJson(res, 200, {
        dir,
        parent: path.dirname(dir) !== dir ? path.dirname(dir) : null,
        dirs: entries.filter((e) => e.isDirectory()).map((e) => e.name),
        files: entries.filter((e) => e.isFile()).map((e) => e.name),
      });
    } catch (e) {
      return sendJson(res, 200, { dir, parent: null, dirs: [], files: [], error: e.message });
    }
  }

  // Live match count + sample ids for a candidate filter list (rule builder).
  if (req.method === 'POST' && route === '/api/preview-filters') {
    return readBody(req).then((body) => {
      try {
        sendJson(res, 200, previewFilters(body.filters, body.sort));
      } catch (e) {
        sendJson(res, 200, { available: false, reason: e.message });
      }
    }).catch((e) => sendJson(res, 400, { error: e.message }));
  }

  // Known values backing the UI's dropdowns.
  if (req.method === 'GET' && route === '/api/meta') {
    // Provider prefixes and name keywords discovered from the raw catalog, so
    // filter dropdowns offer real choices instead of free text.
    const raw = readModelsCsv('all');
    const prefixCount = new Map();
    const familyCount = new Map();
    const FAMILIES = ['glm', 'deepseek', 'kimi', 'minimax', 'qwen', 'stepfun', 'gpt', 'claude', 'gemini', 'llama', 'mistral', 'grok', 'command', 'phi', 'yi'];
    for (const r of raw.rows) {
      const id = String(r.id || '');
      const slash = id.indexOf('/');
      if (slash > 0) {
        const p = id.slice(0, slash);
        prefixCount.set(p, (prefixCount.get(p) || 0) + 1);
      }
      const lower = id.toLowerCase();
      for (const f of FAMILIES) if (lower.includes(f)) familyCount.set(f, (familyCount.get(f) || 0) + 1);
    }
    const byCount = (m) => Array.from(m.entries())
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .map(([value, count]) => ({ value, count }));
    return sendJson(res, 200, {
      harnessIds: HARNESS_IDS,
      sortFields: ['id', 'input_context', 'output_context', 'vision', 'reasoning', 'tool'],
      overrideFields: ['id', 'input_context', 'output_context', 'vision', 'reasoning', 'tool'],
      providers: byCount(prefixCount),
      families: byCount(familyCount),
      configuredProviders: readProviders().rows,
      catalogSize: raw.rows.length,
      scriptDir: __dirname.replace(/\\/g, '/'),
      home: (process.env.USERPROFILE || process.env.HOME || '').replace(/\\/g, '/'),
    });
  }

  if (req.method === 'GET' && route === '/api/run/status') {
    if (!run) return sendJson(res, 200, { active: false, hasRun: false });
    return sendJson(res, 200, {
      active: !run.done,
      hasRun: true,
      done: run.done,
      exitCode: run.exitCode,
      lineCount: run.lines.length,
      cmdline: run.cmdline,
    });
  }

  if (req.method === 'POST' && route === '/api/run') {
    return readBody(req).then((body) => {
      const r = startRun(body || {});
      sendJson(res, r.error ? r.status : 200, r.error ? { error: r.error } : r);
    }).catch((e) => sendJson(res, 400, { error: e.message }));
  }

  if (req.method === 'POST' && route === '/api/run/stop') {
    const r = stopRun();
    return sendJson(res, r.error ? r.status : 200, r.error ? { error: r.error } : r);
  }

  if (req.method === 'GET' && route === '/api/ping') {
    return sendJson(res, 200, { ok: true, app: 'omnilist', port: currentPort, pid: process.pid });
  }

  // GUI-initiated shutdown: reply first, then let the server close so the
  // terminal that ran `omnilist gui` exits cleanly.
  if (req.method === 'POST' && route === '/api/shutdown') {
    sendJson(res, 200, { ok: true });
    stopRun();
    setTimeout(() => process.exit(0), 150);
    return;
  }

  if (req.method === 'POST' && route === '/api/restart') {
    const port = currentPort;
    sendJson(res, 200, { ok: true, port });
    stopRun();
    setTimeout(() => {
      const { spawn } = require('child_process');
      const child = spawn(process.execPath, [__filename, String(port)], {
        cwd: __dirname,
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
      });
      try { child.unref(); } catch (e) {}
      process.exit(0);
    }, 150);
    return;
  }

  if (req.method === 'GET' && route === '/api/run/stream') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write('retry: 1500\n\n');
    sseClients.add(res);
    if (run) {
      run.lines.forEach((line, i) => sseSend(res, 'log', line, i));
      if (run.done) sseSend(res, 'done', { code: run.exitCode }, run.lines.length);
    }
    const ping = setInterval(() => {
      try { res.write(': ping\n\n'); } catch (e) { /* ignore */ }
    }, 25000);
    req.on('close', () => { clearInterval(ping); sseClients.delete(res); });
    return;
  }

  sendJson(res, 404, { error: 'not found' });
}

// ---------------------------------------------------------------------------
// server
// ---------------------------------------------------------------------------

function createServer() {
  return http.createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    if (url.pathname.startsWith('/api/')) return handleApi(req, res, url);
    if (url.pathname === '/favicon.ico') {
      res.writeHead(200, { 'Content-Type': 'image/svg+xml', 'Cache-Control': 'public, max-age=86400' });
      return res.end('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="8" fill="%23f54e00"/><path d="M8 10h16M8 16h16M8 22h10" stroke="%23ffffff" stroke-width="2.5" stroke-linecap="round"/><circle cx="23" cy="22" r="2.5" fill="%23ffffff"/></svg>');
    }
    if (req.method !== 'GET') {
      return sendJson(res, 405, { error: 'method not allowed' });
    }
    const htmlFile = path.join(__dirname, 'dashboard.html');
    try {
      const html = fs.readFileSync(htmlFile);
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(html);
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'text/plain' });
      res.end('dashboard.html not found next to gui.js: ' + e.message);
    }
  });
}

function start(opts) {
  const wanted = (opts && opts.port) || DEFAULT_PORT;
  const server = createServer();
  let attempts = 0;

  const tryListen = (p) => {
    server.once('error', (err) => {
      if (err.code === 'EADDRINUSE' && attempts < 20) {
        attempts++;
        tryListen(p + 1);
      } else {
        console.error('Failed to start the GUI server: ' + err.message);
        process.exit(1);
      }
    });
    server.listen(p, '127.0.0.1', () => {
      currentServer = server;
      currentPort = p;
      try { fs.writeFileSync(path.join(__dirname, '.gui.port'), String(p), 'utf8'); } catch (e) {}
      try { fs.writeFileSync(path.join(__dirname, '.gui.pid'), String(process.pid), 'utf8'); } catch (e) {}
      console.log('');
      console.log('  Omnilist GUI running at:  http://127.0.0.1:' + p);
      if (p !== wanted) console.log('  (port ' + wanted + ' was busy, using the next free one)');
      console.log('  (ctrl-c to stop)');
      console.log('');
    });
  };
  tryListen(wanted);

  const shutdown = () => {
    try {
      const pf = path.join(__dirname, '.gui.port');
      if (fs.existsSync(pf)) fs.unlinkSync(pf);
    } catch (e) {}
    try {
      const pidf = path.join(__dirname, '.gui.pid');
      if (fs.existsSync(pidf)) fs.unlinkSync(pidf);
    } catch (e) {}
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 1500).unref();
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  return new Promise((resolve) => server.on('listening', () => resolve({ port: server.address().port })));
}

if (process.stdout && typeof process.stdout.on === 'function') {
  process.stdout.on('error', (err) => { if (err && err.code === 'EPIPE') return; });
}
if (process.stderr && typeof process.stderr.on === 'function') {
  process.stderr.on('error', (err) => { if (err && err.code === 'EPIPE') return; });
}


if (require.main === module) {
  const portArg = parseInt(process.argv[2], 10);
  start({ port: isNaN(portArg) || portArg <= 0 ? DEFAULT_PORT : portArg });
}

module.exports = { start, readProviders, writeProvidersCsv, readModelsCsv, DEFAULT_PORT };
