#!/usr/bin/env node
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execSync } = require('child_process');

const TICK_MS = 1000;
const RESCAN_EVERY = 8;
const WEATHER_RESCAN_EVERY = 15;
const PING_RESCAN_EVERY = 8;
const SPINNER = ['|', '/', '-', '\\'];
const CPU_BARS = '▁▂▃▄▅▆▇█';
const ANSI_RE = /\x1b\[[0-9;]*m/g;
const RESET = '\x1b[0m';
const ICON_VALUE_GAP = '  ';
const FIELD_GAP = '   ';
const ICONS = {
  cpu: '󰍛',
  gpu: '󰢮',
  mem: '󰘚',
  net: '󰖩',
  ping: '󰖟',
  model: '󱚟',
  tok: '󰏗',
  ctx: '󰆼',
  cost: '󰇭',
  weather: '󰖙',
  hype: '󰐕',
  quote: '󰃧'
};
const FUN_QUOTES = [
  '今天不卷，明天也强。',
  '先跑起来，再变优雅。',
  '这个 bug 很会藏，但我更会找。',
  '写代码像做菜，火候最重要。',
  '提交一小步，快乐一大步。',
  '不怕慢，就怕没 commit。',
  '别慌，先看日志。',
  '写完就测，心里不怯。',
  '修完这个，就去喝水。',
  '稳住，我们能赢。'
];

let spin = 0;
let tick = 0;
let cpuHistory = [];
let prevCpu = readCpuSnapshot();
let prevNet = readNetworkBytes();
let prevAt = Date.now();
let activityHistory = [];
let usageState = { model: null, input: null, output: null, total: null, context: null, cost: null };
let gpuState = { model: null, util: 0, raw: null, source: 'fallback' };
let prevTokenSnapshot = { input: null, output: null, total: null };
let extraState = { load1: null, diskUsed: null, battery: null, charging: null };
let weatherState = { text: 'Weather loading', symbol: '☁️' };
let pingState = { ms: null };
let pingCursor = 0;

function noAgentTelemetryMode() {
  const explicit = String(process.env.ZVIBE_NO_AGENT || '').trim();
  if (explicit === '1' || explicit.toLowerCase() === 'true') return true;
  const primary = String(process.env.ZVIBE_PRIMARY_AGENT || '').trim();
  const secondary = String(process.env.ZVIBE_SECONDARY_AGENT || '').trim();
  return !primary && !secondary;
}

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

function colorByPing(value, text) {
  if (!Number.isFinite(value)) return dim(text);
  if (value < 40) return color(text, 97, 191, 103);
  if (value < 90) return color(text, 230, 190, 64);
  if (value < 180) return color(text, 236, 138, 69);
  return color(text, 229, 78, 78);
}

function colorBySig(level, text) {
  if (level === 'CRIT') return color(text, 229, 78, 78);
  if (level === 'WARN') return color(text, 236, 138, 69);
  if (level === 'LIVE') return color(text, 91, 179, 255);
  if (level === 'IDLE') return dim(text);
  return dim(text);
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

function formatTps(value) {
  if (!Number.isFinite(value) || value < 0) return '--';
  if (value >= 100) return value.toFixed(0);
  if (value >= 10) return value.toFixed(1);
  return value.toFixed(2);
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

function layoutTwoColumns(left, right, max) {
  const sep = ' │ ';
  const sepLen = visibleLength(sep);
  const usable = Math.max(8, max - sepLen);
  const leftBudget = Math.max(8, Math.floor(usable * 0.58));
  const rightBudget = Math.max(8, usable - leftBudget);
  return `${shorten(left, leftBudget)}${sep}${shorten(right, rightBudget)}`;
}

function segmentRatios(width) {
  if (width >= 220) return [0.42, 0.36, 0.22];
  if (width >= 170) return [0.45, 0.33, 0.22];
  if (width >= 140) return [0.48, 0.30, 0.22];
  if (width >= 115) return [0.52, 0.26, 0.22];
  return [0.56, 0.20, 0.24];
}

function layoutThreeColumns(left, middle, right, max) {
  const sep = ' │ ';
  const sepLen = visibleLength(sep) * 2;
  const usable = Math.max(12, max - sepLen);
  const ratios = segmentRatios(max);

  let bLeft = Math.floor(usable * ratios[0]);
  let bMiddle = Math.floor(usable * ratios[1]);
  let bRight = usable - bLeft - bMiddle;

  const minLeft = max >= 120 ? 28 : 20;
  const minMiddle = max >= 120 ? 18 : 10;
  const minRight = max >= 120 ? 24 : 18;

  if (bRight < minRight) {
    const need = minRight - bRight;
    const fromMiddle = Math.min(need, Math.max(0, bMiddle - minMiddle));
    bMiddle -= fromMiddle;
    bRight += fromMiddle;
    const remain = need - fromMiddle;
    if (remain > 0) {
      const fromLeft = Math.min(remain, Math.max(0, bLeft - minLeft));
      bLeft -= fromLeft;
      bRight += fromLeft;
    }
  }

  if (bMiddle < minMiddle) {
    const need = minMiddle - bMiddle;
    const fromLeft = Math.min(need, Math.max(0, bLeft - minLeft));
    bLeft -= fromLeft;
    bMiddle += fromLeft;
  }

  const leftText = shorten(left, Math.max(6, bLeft));
  const middleText = shorten(middle, Math.max(4, bMiddle));
  const rightText = shorten(right, Math.max(6, bRight));
  return `${leftText}${sep}${middleText}${sep}${rightText}`;
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
    const m = out.match(/GPU(?:\s+HW)?\s+active\s+residency\s*:\s*([\d.]+)%/i)
      || out.match(/GPU\s+active\s*:\s*([\d.]+)%/i);
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
      const m = sp.match(/Chipset Model:\s*([^\n]+)/);
      if (m && m[1]) gpuState.model = m[1].trim();
    }
  } catch {}

  try {
    const raw = execSync('ioreg -l 2>/dev/null', {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      maxBuffer: 8 * 1024 * 1024
    });
    const matches = [...raw.matchAll(/"accumulatedGPUTime"\s*=\s*(\d+)/g)];
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

function compileLocationHelper(binPath) {
  const src = path.join(__dirname, 'location-helper.swift');
  if (!fs.existsSync(src)) return false;
  try {
    execSync(`xcrun swiftc "${src}" -o "${binPath}"`, { stdio: ['ignore', 'ignore', 'ignore'], timeout: 8000 });
    return fs.existsSync(binPath);
  } catch {
    return false;
  }
}

function readGpsCoordinates() {
  if (process.platform !== 'darwin') return null;
  const bin = path.join(os.tmpdir(), 'zvibe-location-helper');
  try {
    if (!fs.existsSync(bin)) {
      if (!compileLocationHelper(bin)) return null;
    }
    const out = execSync(`"${bin}"`, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 2500
    }).trim();
    const m = out.match(/^(-?\d+(?:\.\d+)?),\s*(-?\d+(?:\.\d+)?)$/);
    if (!m) return null;
    const lat = Number(m[1]);
    const lon = Number(m[2]);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
    return { lat, lon };
  } catch {
    return null;
  }
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

function readWeather() {
  const gps = readGpsCoordinates();
  const location = String(process.env.ZVIBE_WEATHER_LOCATION || '').trim();
  const encodedLocation = location ? encodeURIComponent(location) : '';
  // Priority: explicit location > GPS coordinates > IP-based location.
  const target = encodedLocation
    ? `https://wttr.in/${encodedLocation}?format=%l|%c|%C|%t`
    : (gps
      ? `https://wttr.in/${gps.lat},${gps.lon}?format=%l|%c|%C|%t`
      : 'https://wttr.in/?format=%l|%c|%C|%t');
  const safeUrl = target.replace(/(["\\$`])/g, '\\$1');
  try {
    const out = execSync(`curl -fsS --max-time 2 "${safeUrl}"`, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 2500
    }).trim();
    if (!out) return { text: 'Weather pending', symbol: '☁️' };
    const [locRaw, symbolRaw, condRaw, tempRaw] = out.split('|');
    const loc = String(locRaw || '').replace(/\s+/g, ' ').trim();
    const symbol = String(symbolRaw || '').replace(/\s+/g, '').trim();
    const cond = String(condRaw || '').replace(/\s+/g, ' ').trim();
    const temp = String(tempRaw || '').replace(/\s+/g, ' ').trim();
    const text = [loc, cond, temp].filter(Boolean).join(' ');
    return { text: text || 'Weather pending', symbol: symbol || '☁️' };
  } catch {
    return { text: 'Weather unavailable', symbol: '☁️' };
  }
}

function pingOne(host) {
  const safeHost = String(host || '').trim().replace(/(["\\$`])/g, '\\$1');
  if (!safeHost) return null;
  try {
    const out = execSync(`ping -c 1 -W 1000 "${safeHost}" 2>/dev/null`, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 1800
    });
    const m = out.match(/time[=<]([\d.]+)\s*ms/i);
    if (!m || !m[1]) return { host, ms: null };
    const ms = Number(m[1]);
    return { host, ms: Number.isFinite(ms) ? ms : null };
  } catch {
    return { host, ms: null };
  }
}

function readPing() {
  const hostsRaw = String(process.env.ZVIBE_PING_HOSTS || 'www.google.com,www.youtube.com,1.1.1.1')
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean)
    .slice(0, 6);
  if (!hostsRaw.length) return { ms: null };
  const host = hostsRaw[pingCursor % hostsRaw.length];
  pingCursor += 1;
  const item = pingOne(host);
  return { ms: item && Number.isFinite(item.ms) ? item.ms : null };
}

function formatUptimeCompact(seconds) {
  const s = Math.max(0, Math.floor(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (h > 0) return `${h}h${String(m).padStart(2, '0')}m`;
  return `${m}m`;
}

function formatEtaCompact(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return '--';
  const s = Math.floor(seconds);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  const mm = m % 60;
  return `${h}h${String(mm).padStart(2, '0')}m`;
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
  if (noAgentTelemetryMode()) return [];
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

  const preferred = preferredAgents();
  if (preferred.length === 0) {
    return { model: null, input: null, output: null, total: null, context: null, cost: null };
  }
  for (const agent of preferred) {
    const reader = readers[agent];
    if (!reader) continue;
    const usage = reader();
    if (!usage) continue;
    if (usage.model || usage.total != null || usage.input != null || usage.output != null) {
      return usage;
    }
  }

  // ultimate fallback for agent sessions
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
  if (tick % WEATHER_RESCAN_EVERY === 1) {
    weatherState = readWeather();
  }
  if (tick % PING_RESCAN_EVERY === 1) {
    pingState = readPing();
  }

  const now = Date.now();
  const elapsed = Math.max(0.2, (now - prevAt) / 1000);
  prevAt = now;
  const max = process.stdout.columns || 120;

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
  const deltaInPerSec = Number.isFinite(deltaIn) ? Math.max(0, deltaIn / elapsed) : NaN;
  const deltaOutPerSec = Number.isFinite(deltaOut) ? Math.max(0, deltaOut / elapsed) : NaN;
  const deltaTotalPerSec = Number.isFinite(deltaTotal) ? Math.max(0, deltaTotal / elapsed) : NaN;
  const tokenPulse = Math.max(0, Number.isFinite(deltaTotal) ? deltaTotal : 0);
  const activityScore = Math.max(0, Math.min(100, Math.round((cpu * 0.5) + (gpuPct * 0.2) + Math.min(100, tokenPulse / 20))));
  activityHistory.push(activityScore);
  if (activityHistory.length > 18) activityHistory = activityHistory.slice(-18);

  if (Number.isFinite(usageState.input)) prevTokenSnapshot.input = usageState.input;
  if (Number.isFinite(usageState.output)) prevTokenSnapshot.output = usageState.output;
  if (Number.isFinite(usageState.total)) prevTokenSnapshot.total = usageState.total;

  const tokInText = usageState.input == null ? dim('--') : colorByTokenDelta(deltaIn, formatCompactNumber(usageState.input));
  const tokOutText = usageState.output == null ? dim('--') : colorByTokenDelta(deltaOut, formatCompactNumber(usageState.output));
  const tokTotalText = usageState.total == null ? dim('--') : colorByTokenDelta(deltaTotal, formatCompactNumber(usageState.total));
  const ctxValue = usageState.context == null ? dim('--') : color(formatCompactNumber(usageState.context), 176, 132, 255);
  const costValue = usageState.cost == null ? dim('--') : colorByCost(usageState.cost, `$${usageState.cost.toFixed(4)}`);
  const tpsInText = Number.isFinite(deltaInPerSec) ? colorByTokenDelta(deltaIn, formatTps(deltaInPerSec)) : dim('--');
  const tpsOutText = Number.isFinite(deltaOutPerSec) ? colorByTokenDelta(deltaOut, formatTps(deltaOutPerSec)) : dim('--');
  const tpsTotalText = Number.isFinite(deltaTotalPerSec) ? colorByTokenDelta(deltaTotal, formatTps(deltaTotalPerSec)) : dim('--');
  const ctxRemaining = (Number.isFinite(usageState.context) && Number.isFinite(usageState.total))
    ? Math.max(0, usageState.context - usageState.total)
    : NaN;
  const etaText = (Number.isFinite(ctxRemaining) && Number.isFinite(deltaTotalPerSec) && deltaTotalPerSec > 0)
    ? color(formatEtaCompact(ctxRemaining / deltaTotalPerSec), 196, 160, 255)
    : dim('--');
  const sigLevel = (() => {
    if (!usageState.model) return '--';
    if (Number.isFinite(usageState.context) && Number.isFinite(usageState.total)) {
      const ctxPct = usageState.total / Math.max(1, usageState.context);
      if (ctxPct >= 0.9) return 'CRIT';
      if (ctxPct >= 0.75) return 'WARN';
    }
    if (Number.isFinite(deltaTotal) && deltaTotal > 0) return 'LIVE';
    return 'IDLE';
  })();
  const sigText = colorBySig(sigLevel, sigLevel);
  const loadValue = extraState.load1 == null ? dim('--') : colorByPercent(Math.min(100, (extraState.load1 / Math.max(1, os.cpus().length)) * 100), extraState.load1.toFixed(2));
  const diskValue = extraState.diskUsed == null ? dim('--') : colorByPercent(extraState.diskUsed, `${extraState.diskUsed}%`);
  const battPct = extraState.battery == null ? '--' : `${extraState.battery}%`;
  const battText = extraState.battery == null
    ? dim('--')
    : colorByPercent(100 - extraState.battery, `${battPct}${extraState.charging === true ? '⚡' : ''}`);

  const noAgent = noAgentTelemetryMode();
  const leftGpuField = `${ICONS.gpu}${ICON_VALUE_GAP}${gpuText}`;
  const leftNetField = noAgent
    ? `${ICONS.net}${ICON_VALUE_GAP}↓ ${netInText}`
    : `${ICONS.net}${ICON_VALUE_GAP}↓ ${netInText}${ICON_VALUE_GAP}↑ ${netOutText}`;
  const leftFields = [
    `${ICONS.cpu}${ICON_VALUE_GAP}${cpuText}${ICON_VALUE_GAP}${color(sparkline(cpuHistory), 120, 175, 255)}`,
    leftGpuField,
    `${ICONS.mem}${ICON_VALUE_GAP}${memText}`,
    leftNetField
  ];
  const left = leftFields.join(FIELD_GAP);

  const modelLabel = `${ICONS.model}${ICON_VALUE_GAP}${color(shorten(usageState.model || '--', 16), 120, 175, 255)}${ICON_VALUE_GAP}SIG ${sigText}`;
  const tokenLabel = `${ICONS.tok}${ICON_VALUE_GAP}I ${tokInText}${ICON_VALUE_GAP}O ${tokOutText}${ICON_VALUE_GAP}T ${tokTotalText}${ICON_VALUE_GAP}TPS ${tpsInText}/${tpsOutText}/${tpsTotalText}`;
  const tokenLabelCompact = `${ICONS.tok}${ICON_VALUE_GAP}T ${tokTotalText}${ICON_VALUE_GAP}TPS ${tpsTotalText}`;
  const ctxCostLabel = `${ICONS.ctx}${ICON_VALUE_GAP}${ctxValue}${ICON_VALUE_GAP}ETA ${etaText}${FIELD_GAP}${ICONS.cost}${ICON_VALUE_GAP}${costValue}`;
  const ctxEtaLabel = `${ICONS.ctx}${ICON_VALUE_GAP}${ctxValue}${ICON_VALUE_GAP}ETA ${etaText}`;
  const middleFull = [modelLabel, tokenLabel, ctxCostLabel].join(FIELD_GAP);
  const middleCompact = [modelLabel, tokenLabelCompact, ctxEtaLabel].join(FIELD_GAP);
  const middle = noAgent ? '' : (max < 145 ? middleCompact : middleFull);

  const quoteIdx = Math.floor(tick / 8) % FUN_QUOTES.length;
  const quoteText = FUN_QUOTES[quoteIdx];
  const quoteColor = color(shorten(quoteText, 16), 255, 203, 107);
  const weatherText = color(shorten(weatherState.text || 'Weather pending', 16), 110, 214, 250);
  const weatherCompactText = color(shorten(weatherState.text || 'Weather', 8), 110, 214, 250);
  const weatherIcon = weatherState.symbol || '☁️';
  const hypeText = colorByPercent(activityScore, `${activityScore}%`);
  const pingText = pingState.ms == null ? dim('--') : colorByPing(pingState.ms, `${Math.round(pingState.ms)}ms`);
  const rightFields = [
    `⏱${ICON_VALUE_GAP}${formatUptimeCompact(uptime)}`,
    `LA${ICON_VALUE_GAP}${loadValue}`,
    `💽${ICON_VALUE_GAP}${diskValue}`,
    `🔋${ICON_VALUE_GAP}${battText}`,
    `${ICONS.ping}${ICON_VALUE_GAP}${pingText}`,
    `${weatherIcon}${ICON_VALUE_GAP}${weatherText}`,
    `${ICONS.hype}${ICON_VALUE_GAP}${hypeText}${ICON_VALUE_GAP}${color(sparkline(activityHistory), 255, 165, 80)}`,
    `${ICONS.quote}${ICON_VALUE_GAP}${quoteColor}`,
    SPINNER[spin]
  ];
  const rightCompactFields = [
    `⏱${ICON_VALUE_GAP}${formatUptimeCompact(uptime)}`,
    `LA${ICON_VALUE_GAP}${loadValue}`,
    `${ICONS.ping}${ICON_VALUE_GAP}${pingText}`,
    `${weatherIcon}${ICON_VALUE_GAP}${weatherText}`,
    ...(noAgent ? [`${ICONS.quote}${ICON_VALUE_GAP}${quoteColor}`] : [`${ICONS.hype}${ICON_VALUE_GAP}${hypeText}`]),
    SPINNER[spin]
  ];
  const rightMinimalFields = [
    `${weatherIcon}${ICON_VALUE_GAP}${weatherCompactText}`,
    `${ICONS.quote}${ICON_VALUE_GAP}${quoteColor}`,
    `${ICONS.ping}${ICON_VALUE_GAP}${pingText}`,
    SPINNER[spin]
  ];
  const right = (max < 115 ? rightMinimalFields : (max < 145 ? rightCompactFields : rightFields)).join(FIELD_GAP);

  if (!process.stdout.isTTY) {
    if (noAgent) process.stdout.write(`${left} | ${right}\n`);
    else process.stdout.write(`${left} | ${middle} | ${right}\n`);
    return;
  }

  const line = noAgent
    ? layoutTwoColumns(left, right, max)
    : layoutThreeColumns(left, middle, right, max);
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
