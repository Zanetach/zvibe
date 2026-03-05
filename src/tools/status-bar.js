#!/usr/bin/env node
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execSync } = require('child_process');

const TICK_MS = 1000;
const RESCAN_EVERY = 8;
const SPINNER = ['|', '/', '-', '\\'];
const CPU_BARS = '▁▂▃▄▅▆▇█';
const ANSI_RE = /\x1b\[[0-9;]*m/g;
const RESET = '\x1b[0m';
const ICONS = {
  cpu: '󰍛',
  gpu: '󰢮',
  mem: '󰘚',
  net: '󰖩',
  model: '󱚟',
  tok: '󰏗',
  ctx: '󰆼',
  cost: '󰇭'
};

let spin = 0;
let tick = 0;
let cpuHistory = [];
let prevCpu = readCpuSnapshot();
let prevNet = readNetworkBytes();
let prevAt = Date.now();
let usageState = { model: null, input: null, output: null, total: null, context: null, cost: null };
let gpuState = { model: null, util: 0, raw: null, source: 'fallback' };
let prevTokenSnapshot = { input: null, output: null, total: null };
let extraState = { load1: null, diskUsed: null, battery: null, charging: null };

function supportsColor() {
  return process.stdout.isTTY && !process.env.NO_COLOR;
}

function color(text, r, g, b) {
  if (!supportsColor()) return text;
  return `\x1b[38;2;${r};${g};${b}m${text}${RESET}`;
}

function dim(text) {
  return color(text, 130, 137, 150);
}

function colorByPercent(value, text) {
  if (!Number.isFinite(value)) return dim(text);
  if (value < 40) return color(text, 97, 191, 103);
  if (value < 70) return color(text, 230, 190, 64);
  if (value < 90) return color(text, 236, 138, 69);
  return color(text, 229, 78, 78);
}

function colorByRate(value, text) {
  if (!Number.isFinite(value)) return dim(text);
  if (value < 128 * 1024) return color(text, 97, 191, 103);
  if (value < 2 * 1024 * 1024) return color(text, 230, 190, 64);
  if (value < 10 * 1024 * 1024) return color(text, 236, 138, 69);
  return color(text, 229, 78, 78);
}

function colorByTokenDelta(delta, text) {
  if (!Number.isFinite(delta)) return dim(text);
  if (delta > 0) return color(text, 91, 179, 255);
  return dim(text);
}

function colorByCost(value, text) {
  if (!Number.isFinite(value)) return dim(text);
  if (value < 0.2) return color(text, 97, 191, 103);
  if (value < 1) return color(text, 230, 190, 64);
  return color(text, 229, 78, 78);
}

function readCpuSnapshot() {
  const cpus = os.cpus();
  let idle = 0;
  let total = 0;
  cpus.forEach((cpu) => {
    Object.values(cpu.times).forEach((n) => { total += n; });
    idle += cpu.times.idle;
  });
  return { idle, total };
}

function readCpuPercent() {
  const next = readCpuSnapshot();
  const idleDelta = next.idle - prevCpu.idle;
  const totalDelta = next.total - prevCpu.total;
  prevCpu = next;
  if (totalDelta <= 0) return 0;
  return Math.max(0, Math.min(100, (1 - (idleDelta / totalDelta)) * 100));
}

function readNetworkBytes() {
  try {
    const output = execSync('netstat -ibn', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    const lines = output.split('\n').filter(Boolean);
    if (lines.length < 2) return { inBytes: 0, outBytes: 0 };
    const header = lines[0].trim().split(/\s+/);
    const iBytesIdx = header.indexOf('Ibytes');
    const oBytesIdx = header.indexOf('Obytes');
    if (iBytesIdx < 0 || oBytesIdx < 0) return { inBytes: 0, outBytes: 0 };

    let inBytesTotal = 0;
    let outBytesTotal = 0;
    for (let i = 1; i < lines.length; i += 1) {
      const cols = lines[i].trim().split(/\s+/);
      if (cols.length <= Math.max(iBytesIdx, oBytesIdx)) continue;
      if (cols[0] === 'lo0') continue;
      const iBytes = Number(cols[iBytesIdx]);
      const oBytes = Number(cols[oBytesIdx]);
      if (Number.isFinite(iBytes)) inBytesTotal += iBytes;
      if (Number.isFinite(oBytes)) outBytesTotal += oBytes;
    }
    return { inBytes: inBytesTotal, outBytes: outBytesTotal };
  } catch {
    return { inBytes: 0, outBytes: 0 };
  }
}

function formatRate(bytesPerSecond) {
  const units = ['B/s', 'KB/s', 'MB/s', 'GB/s'];
  let value = bytesPerSecond;
  let idx = 0;
  while (value >= 1024 && idx < units.length - 1) {
    value /= 1024;
    idx += 1;
  }
  return `${value >= 100 ? value.toFixed(0) : value.toFixed(1)}${units[idx]}`;
}

function formatCompactNumber(value) {
  if (!Number.isFinite(value)) return '--';
  const abs = Math.abs(value);
  if (abs >= 1e9) return `${(value / 1e9).toFixed(1)}b`;
  if (abs >= 1e6) return `${(value / 1e6).toFixed(1)}m`;
  if (abs >= 1e3) return `${(value / 1e3).toFixed(1)}k`;
  return String(Math.round(value));
}

function formatPercent(v) {
  return `${Math.round(v)}%`;
}

function sparkline(values) {
  if (!values.length) return '';
  return values.map((value) => {
    const idx = Math.max(0, Math.min(CPU_BARS.length - 1, Math.floor((value / 100) * (CPU_BARS.length - 1))));
    return CPU_BARS[idx];
  }).join('');
}

function shorten(text, max) {
  const plain = String(text || '').replace(ANSI_RE, '');
  if (!max || plain.length <= max) return text;
  if (max <= 1) return plain.slice(0, max);

  let out = '';
  let visible = 0;
  let i = 0;
  while (i < text.length && visible < max - 1) {
    if (text[i] === '\x1b') {
      const m = text.slice(i).match(/^\x1b\[[0-9;]*m/);
      if (m) {
        out += m[0];
        i += m[0].length;
        continue;
      }
    }
    out += text[i];
    visible += 1;
    i += 1;
  }
  return `${out}…${supportsColor() ? RESET : ''}`;
}

function visibleLength(text) {
  return String(text || '').replace(ANSI_RE, '').length;
}

function findLatestFiles(pattern, limit = 8) {
  const [base, ...rest] = pattern.split('/');
  const root = base === '~' ? os.homedir() : base;
  const fullPattern = path.join(root, ...rest);
  try {
    const out = execSync(`ls -1t ${fullPattern} 2>/dev/null | head -n ${limit}`, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    return out.split('\n').map((x) => x.trim()).filter(Boolean);
  } catch {
    return [];
  }
}

function readTail(filePath, maxBytes = 220 * 1024) {
  try {
    const stat = fs.statSync(filePath);
    const start = Math.max(0, stat.size - maxBytes);
    const size = stat.size - start;
    const fd = fs.openSync(filePath, 'r');
    const buf = Buffer.alloc(size);
    fs.readSync(fd, buf, 0, size, start);
    fs.closeSync(fd);
    return buf.toString('utf8');
  } catch {
    return '';
  }
}

function safeJSON(line) {
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}

function extractCodexModelFromFile(file) {
  const parseModel = (text) => {
    const m = String(text || '').match(/"model"\s*:\s*"([^"]+)"/);
    return m && m[1] ? m[1] : null;
  };
  try {
    const escaped = file.replace(/(["\\$`])/g, '\\$1');
    const codexOut = execSync(`rg -m 1 -o '\"model\":\"[^\"]*codex[^\"]*\"' \"${escaped}\"`, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore']
    }).trim();
    const codexModel = parseModel(codexOut);
    if (codexModel) return codexModel;
  } catch {}

  try {
    const escaped = file.replace(/(["\\$`])/g, '\\$1');
    const out = execSync(`rg -m 1 -o '\"model\":\"[^\"]+\"' \"${escaped}\"`, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore']
    }).trim();
    return parseModel(out);
  } catch {
    return null;
  }
}

function readCodexUsage() {
  const files = findLatestFiles('~/.codex/sessions/*/*/*/*.jsonl', 6);
  for (const file of files) {
    const tail = readTail(file);
    if (!tail) continue;

    let model = null;
    let usage = null;
    const lines = tail.split('\n');
    for (let i = lines.length - 1; i >= 0; i -= 1) {
      const obj = safeJSON(lines[i]);
      if (!obj) continue;

      if (!model && obj.type === 'turn_context' && obj.payload && obj.payload.model) {
        model = String(obj.payload.model);
      }

      if (!usage && obj.type === 'event_msg' && obj.payload && obj.payload.type === 'token_count') {
        const total = obj.payload.info && obj.payload.info.total_token_usage;
        const ctx = obj.payload.info && obj.payload.info.model_context_window;
        if (total) {
          usage = {
            input: Number(total.input_tokens),
            output: Number(total.output_tokens),
            total: Number(total.total_tokens),
            context: Number(ctx),
            cost: null
          };
        }
      }

      if (model && usage) break;
    }

    if (!model) model = extractCodexModelFromFile(file);

    if (model || usage) {
      return {
        model,
        input: usage && Number.isFinite(usage.input) ? usage.input : null,
        output: usage && Number.isFinite(usage.output) ? usage.output : null,
        total: usage && Number.isFinite(usage.total) ? usage.total : null,
        context: usage && Number.isFinite(usage.context) ? usage.context : null,
        cost: usage && Number.isFinite(usage.cost) ? usage.cost : null
      };
    }
  }
  return null;
}

function parseClaudeMetadata(raw) {
  if (!raw) return null;
  try {
    const normalized = raw.replace(/\\"/g, '"');
    return JSON.parse(normalized);
  } catch {
    return null;
  }
}

function readClaudeUsage() {
  const files = findLatestFiles('~/.claude/telemetry/*.json', 20);
  for (const file of files) {
    const tail = readTail(file, 320 * 1024);
    if (!tail) continue;
    const lines = tail.split('\n');

    for (let i = lines.length - 1; i >= 0; i -= 1) {
      const obj = safeJSON(lines[i]);
      if (!obj || !obj.event_data) continue;
      const event = obj.event_data;
      if (event.event_name !== 'tengu_exit') continue;

      const model = event.model ? String(event.model) : null;
      const metadata = parseClaudeMetadata(event.additional_metadata);
      const input = metadata && Number(metadata.last_session_total_input_tokens);
      const output = metadata && Number(metadata.last_session_total_output_tokens);
      const context = metadata && Number(metadata.last_session_context_window);
      const cost = metadata && Number(metadata.last_session_cost);
      const total = Number.isFinite(input) && Number.isFinite(output) ? input + output : null;

      return {
        model,
        input: Number.isFinite(input) ? input : null,
        output: Number.isFinite(output) ? output : null,
        total,
        context: Number.isFinite(context) ? context : null,
        cost: Number.isFinite(cost) ? cost : null
      };
    }
  }

  // Fallback: at least show latest model from telemetry
  for (const file of files) {
    const tail = readTail(file, 120 * 1024);
    const match = tail.match(/"model"\s*:\s*"([^"]+)"/g);
    if (!match || !match.length) continue;
    const last = match[match.length - 1].match(/"model"\s*:\s*"([^"]+)"/);
    if (last && last[1]) {
      return { model: last[1], input: null, output: null, total: null, context: null, cost: null };
    }
  }
  return null;
}

function readOpencodeUsage() {
  const files = findLatestFiles('~/.config/opencode/*.json*', 6);
  for (const file of files) {
    const tail = readTail(file, 150 * 1024);
    if (!tail) continue;
    const modelMatch = [...tail.matchAll(/"model"\s*:\s*"([^"]+)"/g)];
    if (!modelMatch.length) continue;
    const model = modelMatch[modelMatch.length - 1][1];
    return { model, input: null, output: null, total: null, context: null, cost: null };
  }
  return null;
}

function readGpuInfo() {
  // First try powermetrics with non-interactive sudo (works after setup grants NOPASSWD).
  try {
    const out = execSync('sudo -n /usr/bin/powermetrics --samplers gpu_power -n 1 -i 1000 2>/dev/null', {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 2500
    });
    const m = out.match(/GPU(?:\\s+HW)?\\s+active\\s+residency\\s*:\\s*([\\d.]+)%/i)
      || out.match(/GPU\\s+active\\s*:\\s*([\\d.]+)%/i);
    if (m && m[1]) {
      const util = Number(m[1]);
      if (Number.isFinite(util)) {
        gpuState.util = Math.max(0, Math.min(100, Math.round(util)));
        gpuState.source = 'powermetrics';
      }
    }
  } catch {}

  // Best-effort fallback on macOS without privileged metrics:
  // derive activity from ioreg AppUsage accumulatedGPUTime deltas.
  try {
    if (!gpuState.model) {
      const sp = execSync('system_profiler SPDisplaysDataType 2>/dev/null', {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore']
      });
      const m = sp.match(/Chipset Model:\\s*([^\\n]+)/);
      if (m && m[1]) gpuState.model = m[1].trim();
    }
  } catch {}

  try {
    const raw = execSync('ioreg -l 2>/dev/null', {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      maxBuffer: 8 * 1024 * 1024
    });
    const matches = [...raw.matchAll(/"accumulatedGPUTime"\\s*=\\s*(\\d+)/g)];
    if (!matches.length) {
      if (gpuState.util == null) gpuState.util = 0;
      return gpuState;
    }
    let total = 0;
    matches.forEach((x) => { total += Number(x[1]) || 0; });

    if (gpuState.raw != null) {
      const delta = Math.max(0, total - gpuState.raw);
      // Empirical normalization for Apple Silicon; keeps range mostly in 0-100 for interactive loads.
      if (gpuState.source !== 'powermetrics') {
        const util = Math.max(0, Math.min(100, Math.round((delta / 5e9) * 100)));
        gpuState.util = util;
        gpuState.source = 'fallback';
      }
    }
    gpuState.raw = total;
  } catch {}

  return gpuState;
}

function readSystemExtras() {
  const extras = { load1: null, diskUsed: null, battery: null, charging: null };
  try {
    const load = os.loadavg()[0];
    if (Number.isFinite(load)) extras.load1 = load;
  } catch {}

  try {
    const out = execSync('df -k .', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    const line = out.split('\n').filter(Boolean)[1] || '';
    const parts = line.trim().split(/\s+/);
    const useStr = parts[4] || '';
    const use = Number(useStr.replace('%', ''));
    if (Number.isFinite(use)) extras.diskUsed = use;
  } catch {}

  try {
    const batt = execSync('pmset -g batt 2>/dev/null', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    const m = batt.match(/(\d+)%/);
    if (m && m[1]) {
      const pct = Number(m[1]);
      if (Number.isFinite(pct)) extras.battery = pct;
    }
    if (/AC Power|charging/i.test(batt)) extras.charging = true;
    if (/discharging|Battery Power/i.test(batt)) extras.charging = false;
  } catch {}

  return extras;
}

function formatUptimeCompact(seconds) {
  const s = Math.max(0, Math.floor(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (h > 0) return `${h}h${String(m).padStart(2, '0')}m`;
  return `${m}m`;
}

function safeUptimeSeconds() {
  try {
    const up = os.uptime();
    if (Number.isFinite(up) && up >= 0) return up;
  } catch {}
  try {
    const up = process.uptime();
    if (Number.isFinite(up) && up >= 0) return up;
  } catch {}
  return 0;
}

function preferredAgents() {
  const fromEnv = [process.env.ZVIBE_PRIMARY_AGENT, process.env.ZVIBE_SECONDARY_AGENT]
    .map((x) => String(x || '').trim())
    .filter(Boolean);
  const uniq = [];
  fromEnv.forEach((x) => { if (!uniq.includes(x)) uniq.push(x); });
  return uniq.length ? uniq : ['codex', 'claude', 'opencode'];
}

function resolveUsage() {
  const readers = {
    codex: readCodexUsage,
    claude: readClaudeUsage,
    opencode: readOpencodeUsage
  };

  for (const agent of preferredAgents()) {
    const reader = readers[agent];
    if (!reader) continue;
    const usage = reader();
    if (!usage) continue;
    if (usage.model || usage.total != null || usage.input != null || usage.output != null) {
      return usage;
    }
  }

  // ultimate fallback
  return readCodexUsage() || readClaudeUsage() || readOpencodeUsage() || {
    model: null, input: null, output: null, total: null, context: null, cost: null
  };
}

function render() {
  tick += 1;
  spin = (spin + 1) % SPINNER.length;

  if (tick % RESCAN_EVERY === 1) {
    usageState = resolveUsage();
    gpuState = readGpuInfo();
    extraState = readSystemExtras();
  }

  const now = Date.now();
  const elapsed = Math.max(0.2, (now - prevAt) / 1000);
  prevAt = now;

  const cpu = readCpuPercent();
  cpuHistory.push(cpu);
  if (cpuHistory.length > 12) cpuHistory = cpuHistory.slice(-12);

  const memUsed = ((os.totalmem() - os.freemem()) / os.totalmem()) * 100;
  const netNow = readNetworkBytes();
  const netInRate = Math.max(0, (netNow.inBytes - prevNet.inBytes) / elapsed);
  const netOutRate = Math.max(0, (netNow.outBytes - prevNet.outBytes) / elapsed);
  prevNet = netNow;
  const uptime = safeUptimeSeconds();

  const gpuPct = gpuState.util == null ? 0 : gpuState.util;
  const cpuText = colorByPercent(cpu, formatPercent(cpu));
  const gpuText = colorByPercent(gpuPct, `${gpuPct}%`);
  const memText = colorByPercent(memUsed, formatPercent(memUsed));
  const netInText = colorByRate(netInRate, formatRate(netInRate));
  const netOutText = colorByRate(netOutRate, formatRate(netOutRate));

  const deltaIn = Number.isFinite(usageState.input) && Number.isFinite(prevTokenSnapshot.input)
    ? usageState.input - prevTokenSnapshot.input
    : NaN;
  const deltaOut = Number.isFinite(usageState.output) && Number.isFinite(prevTokenSnapshot.output)
    ? usageState.output - prevTokenSnapshot.output
    : NaN;
  const deltaTotal = Number.isFinite(usageState.total) && Number.isFinite(prevTokenSnapshot.total)
    ? usageState.total - prevTokenSnapshot.total
    : NaN;

  if (Number.isFinite(usageState.input)) prevTokenSnapshot.input = usageState.input;
  if (Number.isFinite(usageState.output)) prevTokenSnapshot.output = usageState.output;
  if (Number.isFinite(usageState.total)) prevTokenSnapshot.total = usageState.total;

  const tokInText = usageState.input == null ? dim('--') : colorByTokenDelta(deltaIn, formatCompactNumber(usageState.input));
  const tokOutText = usageState.output == null ? dim('--') : colorByTokenDelta(deltaOut, formatCompactNumber(usageState.output));
  const tokTotalText = usageState.total == null ? dim('--') : colorByTokenDelta(deltaTotal, formatCompactNumber(usageState.total));
  const ctxValue = usageState.context == null ? dim('--') : color(formatCompactNumber(usageState.context), 176, 132, 255);
  const costValue = usageState.cost == null ? dim('--') : colorByCost(usageState.cost, `$${usageState.cost.toFixed(4)}`);
  const loadValue = extraState.load1 == null ? dim('--') : colorByPercent(Math.min(100, (extraState.load1 / Math.max(1, os.cpus().length)) * 100), extraState.load1.toFixed(2));
  const diskValue = extraState.diskUsed == null ? dim('--') : colorByPercent(extraState.diskUsed, `${extraState.diskUsed}%`);
  const battPct = extraState.battery == null ? '--' : `${extraState.battery}%`;
  const battText = extraState.battery == null
    ? dim('--')
    : colorByPercent(100 - extraState.battery, `${battPct}${extraState.charging === true ? '⚡' : ''}`);

  const gpuModel = gpuState.model ? ` ${dim(shorten(gpuState.model, 10))}` : '';
  const gpuLabel = `${ICONS.gpu} ${gpuText}${gpuModel}`;
  const left = `${ICONS.cpu}${cpuText} ${color(sparkline(cpuHistory), 120, 175, 255)}  ${gpuLabel}  ${ICONS.mem}${memText}  ${ICONS.net}↓${netInText} ↑${netOutText}`;
  const modelLabel = `${ICONS.model}${color(shorten(usageState.model || '--', 14), 120, 175, 255)}`;
  const tokenLabel = `${ICONS.tok}I${tokInText} O${tokOutText} T${tokTotalText}`;
  const ctxCostLabel = `${ICONS.ctx}${ctxValue} ${ICONS.cost}${costValue}`;
  const middle = `${modelLabel}  ${tokenLabel}  ${ctxCostLabel}`;
  const right = `⏱${formatUptimeCompact(uptime)} LA${loadValue} 💽${diskValue} 🔋${battText} GPU:${dim(gpuState.source === 'powermetrics' ? 'pm' : 'io')} ${SPINNER[spin]}`;

  if (!process.stdout.isTTY) {
    process.stdout.write(`${left} | ${middle} | ${right}\n`);
    return;
  }

  const max = process.stdout.columns || 120;
  const sep = '  |  ';
  let leftPart = left;
  let middlePart = middle;
  const leftLen = visibleLength(leftPart);
  const middleLen = visibleLength(middlePart);
  const rightLen = visibleLength(right);

  let line = '';
  const fullLen = leftLen + visibleLength(sep) + middleLen + 1 + rightLen;
  if (fullLen <= max) {
    const base = `${leftPart}${sep}${middlePart}`;
    const pad = Math.max(1, max - visibleLength(base) - rightLen);
    line = `${base}${' '.repeat(pad)}${right}`;
  } else {
    const middleBudget = max - leftLen - rightLen - visibleLength(sep) - 1;
    if (middleBudget >= 12) {
      middlePart = shorten(middlePart, middleBudget);
      const base = `${leftPart}${sep}${middlePart}`;
      const pad = Math.max(1, max - visibleLength(base) - rightLen);
      line = `${base}${' '.repeat(pad)}${right}`;
    } else {
      const leftBudget = max - rightLen - visibleLength(sep) - 1;
      leftPart = shorten(leftPart, Math.max(12, leftBudget));
      const base = `${leftPart}${sep}`;
      const pad = Math.max(1, max - visibleLength(base) - rightLen);
      line = `${base}${' '.repeat(pad)}${right}`;
    }
  }

  process.stdout.write(`\x1b[2K\r${shorten(line, max)}`);
}

process.on('SIGINT', () => {
  process.stdout.write('\n');
  process.exit(0);
});

process.on('SIGTERM', () => {
  process.stdout.write('\n');
  process.exit(0);
});

usageState = resolveUsage();
render();
setInterval(render, TICK_MS);
