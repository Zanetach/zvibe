#!/usr/bin/env node
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execSync, fork } = require('child_process');

const TICK_MS = 1000;
const RESCAN_EVERY = 3;
const GPU_RESCAN_EVERY = 6;
const EXTRAS_RESCAN_EVERY = 6;
const NETWORK_RESCAN_EVERY = 2;
const PING_RESCAN_EVERY = 3;
const BOOTSTRAP_FAST_TICKS = 6;
const CPU_BARS = '▁▂▃▄▅▆▇█';
const ANSI_RE = /\x1b\[[0-9;]*m/g;
const RESET = '\x1b[0m';
const ICON_VALUE_GAP = '  ';
const FIELD_GAP = '   ';
const EDGE_PADDING = '  ';
const FRAME_LEFT = '';
const FRAME_RIGHT = '';
const NERD_ICONS = {
  cpu: '󰍛',
  gpu: '󰢮',
  mem: '󰘚',
  net: '󰖩',
  ping: '󰖟',
  model: '󱚟',
  tok: '󰏗',
  ctx: '󰆼',
  cost: '󰇭',
  uptime: '⏱',
  load: 'LA',
  disk: '󰋊',
  battery: '🔋',
  date: '🗓',
  weather: '󰖙',
  quote: '󰃧'
};
const UNICODE_ICONS = {
  cpu: 'CPU',
  gpu: 'GPU',
  mem: 'MEM',
  net: 'NET',
  ping: 'PING',
  model: 'MODEL',
  tok: 'TOK',
  ctx: 'CTX',
  cost: '$',
  uptime: 'UP',
  load: 'LA',
  disk: 'DISK',
  battery: 'BAT',
  date: 'DATE',
  weather: 'WTH',
  quote: 'Q'
};

function resolveIcons() {
  const forced = String(process.env.ZVIBE_ICON_SET || '').trim().toLowerCase();
  if (forced === 'nerd') return NERD_ICONS;
  if (forced === 'unicode' || forced === 'ascii') return UNICODE_ICONS;
  const terminalProgram = String(process.env.TERM_PROGRAM || '').trim();
  if (terminalProgram === 'Apple_Terminal') return UNICODE_ICONS;
  return NERD_ICONS;
}
const ICONS = resolveIcons();

let tick = 0;
let cpuHistory = [];
let gpuHistory = [];
let memHistory = [];
let prevCpu = readCpuSnapshot();
let prevNet = readNetworkBytes();
let prevNetAt = Date.now();
let prevAt = Date.now();
let usageState = { model: null, input: null, output: null, total: null, context: null, cost: null };
let gpuState = { model: null, util: 0, raw: null, source: 'fallback' };
let prevTokenSnapshot = { input: null, output: null, total: null };
let extraState = { load1: null, diskUsed: null, diskTotalBytes: null, diskFreeBytes: null, battery: null, charging: null };
let pingState = { ms: null };
let netRates = { inRate: 0, outRate: 0 };
let pingCursor = 0;
let samplerChild = null;
let pageIndex = 0;
let pageCount = 1;
let scrollOffset = 0;
let scrollable = false;
let inputBound = false;

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

function formatBytesCompact(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return '--';
  const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
  let value = bytes;
  let idx = 0;
  while (value >= 1024 && idx < units.length - 1) {
    value /= 1024;
    idx += 1;
  }
  const text = value >= 100 ? value.toFixed(0) : value.toFixed(1);
  return `${text}${units[idx]}`;
}

function formatDiskBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return '--';
  const units = ['B', 'K', 'M', 'G', 'TB', 'PB'];
  let value = bytes;
  let idx = 0;
  while (value >= 1024 && idx < units.length - 1) {
    value /= 1024;
    idx += 1;
  }
  const text = value >= 100 ? value.toFixed(0) : value.toFixed(1);
  return `${text}${units[idx]}`;
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

function padVisible(text, width) {
  const value = String(text || '');
  const len = visibleLength(value);
  if (len >= width) return value;
  return value + ' '.repeat(width - len);
}

function fillLineToWidth(text, width) {
  const value = String(text || '');
  const len = visibleLength(value);
  if (len >= width) return value;
  return `${value}${' '.repeat(width - len)}`;
}

function layoutPinnedEdges(left, right, max, minGap = 2) {
  const gap = ' '.repeat(Math.max(1, minGap));
  const gapLen = visibleLength(gap);
  const leftLen = visibleLength(left);
  const rightLen = visibleLength(right);
  if (leftLen + gapLen + rightLen <= max) {
    return `${left}${' '.repeat(max - leftLen - rightLen)}${right}`;
  }
  const minRight = Math.max(8, Math.min(26, Math.floor(max * 0.28)));
  const rightBudget = Math.min(rightLen, Math.max(minRight, Math.floor(max * 0.34)));
  const rightText = shorten(right, rightBudget);
  const leftBudget = Math.max(6, max - gapLen - visibleLength(rightText));
  const leftText = shorten(left, leftBudget);
  const pad = Math.max(1, max - visibleLength(leftText) - visibleLength(rightText));
  return `${leftText}${' '.repeat(pad)}${rightText}`;
}

function miniBar(percent, width, rgb) {
  if (!Number.isFinite(percent)) return dim('-'.repeat(width));
  const p = Math.max(0, Math.min(100, percent));
  const filled = Math.round((p / 100) * width);
  const fillText = color('━'.repeat(Math.max(0, filled)), rgb[0], rgb[1], rgb[2]);
  const emptyText = dim('─'.repeat(Math.max(0, width - filled)));
  return `${fillText}${emptyText}`;
}

function packFieldsByWidth(fields, maxWidth, gap = FIELD_GAP) {
  if (!Array.isArray(fields) || fields.length === 0 || maxWidth <= 0) return '';
  const out = [];
  let used = 0;
  const gapLen = visibleLength(gap);
  for (const field of fields) {
    const fieldLen = visibleLength(field);
    const next = out.length === 0 ? fieldLen : (gapLen + fieldLen);
    if (used + next > maxWidth) break;
    out.push(field);
    used += next;
  }
  return out.join(gap);
}

function paginateFields(fields, maxWidth, gap = FIELD_GAP) {
  if (!Array.isArray(fields) || fields.length === 0 || maxWidth <= 0) return [''];
  const pages = [];
  const gapLen = visibleLength(gap);
  let cursor = 0;

  while (cursor < fields.length) {
    const out = [];
    let used = 0;

    while (cursor < fields.length) {
      const field = String(fields[cursor] || '');
      const fieldLen = visibleLength(field);
      const next = out.length === 0 ? fieldLen : (gapLen + fieldLen);
      if (used + next > maxWidth) {
        if (out.length === 0) {
          out.push(shorten(field, Math.max(6, maxWidth)));
          cursor += 1;
        }
        break;
      }
      out.push(field);
      used += next;
      cursor += 1;
    }

    pages.push(out.join(gap));
  }

  return pages.length ? pages : [''];
}

function clampPageIndex(next, total) {
  if (!Number.isFinite(total) || total <= 1) return 0;
  const maxIdx = total - 1;
  if (!Number.isFinite(next)) return 0;
  return Math.max(0, Math.min(maxIdx, next));
}

function sliceVisible(text, offset, width) {
  const plain = String(text || '').replace(ANSI_RE, '');
  const start = Math.max(0, Math.floor(offset || 0));
  const max = Math.max(0, Math.floor(width || 0));
  if (max <= 0 || start >= plain.length) return '';
  return plain.slice(start, Math.min(plain.length, start + max));
}

function layoutTwoColumns(left, right, max) {
  const sep = ' │ ';
  const sepLen = visibleLength(sep);
  const usable = Math.max(8, max - sepLen);
  const leftBudget = Math.max(8, Math.floor(usable * 0.48));
  const rightBudget = Math.max(8, usable - leftBudget);
  return `${shorten(left, leftBudget)}${sep}${shorten(right, rightBudget)}`;
}

function segmentRatios(width) {
  if (width >= 220) return [0.40, 0.34, 0.26];
  if (width >= 170) return [0.43, 0.31, 0.26];
  if (width >= 140) return [0.46, 0.28, 0.26];
  if (width >= 115) return [0.50, 0.24, 0.26];
  return [0.54, 0.20, 0.26];
}

function layoutThreeColumns(left, middle, right, max) {
  const baseSep = ' │ ';
  const sepLen = visibleLength(baseSep) * 2;
  const usable = Math.max(12, max - sepLen);
  const ratios = segmentRatios(max);

  let bLeft = Math.floor(usable * ratios[0]);
  let bMiddle = Math.floor(usable * ratios[1]);
  let bRight = usable - bLeft - bMiddle;

  const minLeft = max >= 120 ? 28 : 20;
  const minMiddle = max >= 120 ? 18 : 10;
  const minRight = max >= 120 ? 30 : 20;

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

  // Reflow spare space: if a column's real content is shorter than its budget,
  // donate the unused width to columns that still need more room (priority: right).
  const leftLen = visibleLength(left);
  const middleLen = visibleLength(middle);
  const rightLen = visibleLength(right);

  let spare = 0;
  if (leftLen < bLeft) {
    spare += bLeft - leftLen;
    bLeft = leftLen;
  }
  if (middleLen < bMiddle) {
    spare += bMiddle - middleLen;
    bMiddle = middleLen;
  }
  if (rightLen < bRight) {
    spare += bRight - rightLen;
    bRight = rightLen;
  }

  const needs = {
    right: Math.max(0, rightLen - bRight),
    middle: Math.max(0, middleLen - bMiddle),
    left: Math.max(0, leftLen - bLeft)
  };

  const grant = (key) => {
    if (spare <= 0 || needs[key] <= 0) return;
    const n = Math.min(spare, needs[key]);
    if (key === 'right') bRight += n;
    if (key === 'middle') bMiddle += n;
    if (key === 'left') bLeft += n;
    needs[key] -= n;
    spare -= n;
  };

  grant('right');
  grant('middle');
  grant('left');
  if (spare > 0) bRight += spare;

  const leftText = shorten(left, Math.max(6, bLeft));
  const middleText = shorten(middle, Math.max(4, bMiddle));
  const rightText = shorten(right, Math.max(6, bRight));
  return `${leftText}${baseSep}${middleText}${baseSep}${rightText}`;
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
      timeout: 1200
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
  const extras = { load1: null, diskUsed: null, diskTotalBytes: null, diskFreeBytes: null, battery: null, charging: null };
  try {
    const load = os.loadavg()[0];
    if (Number.isFinite(load)) extras.load1 = load;
  } catch {}

  try {
    const out = execSync('df -k .', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    const line = out.split('\n').filter(Boolean)[1] || '';
    const parts = line.trim().split(/\s+/);
    const totalKb = Number(parts[1] || '');
    const freeKb = Number(parts[3] || '');
    const useStr = parts[4] || '';
    const use = Number(useStr.replace('%', ''));
    if (Number.isFinite(use)) extras.diskUsed = use;
    if (Number.isFinite(totalKb)) extras.diskTotalBytes = totalKb * 1024;
    if (Number.isFinite(freeKb)) extras.diskFreeBytes = freeKb * 1024;
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

function pingOne(host) {
  const safeHost = String(host || '').trim().replace(/(["\\$`])/g, '\\$1');
  if (!safeHost) return null;
  try {
    const out = execSync(`ping -c 1 -W 1000 "${safeHost}" 2>/dev/null`, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 900
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

function formatDateLite(date = new Date()) {
  const mm = String(date.getMonth() + 1).padStart(2, '0');
  const dd = String(date.getDate()).padStart(2, '0');
  const hh = String(date.getHours()).padStart(2, '0');
  const mi = String(date.getMinutes()).padStart(2, '0');
  const ss = String(date.getSeconds()).padStart(2, '0');
  const week = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][date.getDay()];
  return `${mm}-${dd} ${week} ${hh}:${mi}:${ss}`;
}

function formatDateCompact(date = new Date()) {
  const hh = String(date.getHours()).padStart(2, '0');
  const mi = String(date.getMinutes()).padStart(2, '0');
  const week = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][date.getDay()];
  return `${week} ${hh}:${mi}`;
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
  const fastBoot = tick <= BOOTSTRAP_FAST_TICKS;

  const now = Date.now();
  const elapsed = Math.max(0.2, (now - prevAt) / 1000);
  prevAt = now;
  const max = process.stdout.columns || 120;
  const fieldGap = max >= 230 ? '      ' : (max >= 180 ? '    ' : FIELD_GAP);

  const cpu = readCpuPercent();
  cpuHistory.push(cpu);
  if (cpuHistory.length > 12) cpuHistory = cpuHistory.slice(-12);

  const memUsed = ((os.totalmem() - os.freemem()) / os.totalmem()) * 100;
  let netInRate = netRates.inRate;
  let netOutRate = netRates.outRate;
  if (!samplerChild && (fastBoot || tick % NETWORK_RESCAN_EVERY === 0)) {
    const netNow = readNetworkBytes();
    const netElapsed = Math.max(0.2, (now - prevNetAt) / 1000);
    netInRate = Math.max(0, (netNow.inBytes - prevNet.inBytes) / netElapsed);
    netOutRate = Math.max(0, (netNow.outBytes - prevNet.outBytes) / netElapsed);
    prevNet = netNow;
    prevNetAt = now;
    netRates = { inRate: netInRate, outRate: netOutRate };
  }
  const uptime = safeUptimeSeconds();

  const gpuPct = gpuState.util == null ? 0 : gpuState.util;
  gpuHistory.push(gpuPct);
  if (gpuHistory.length > 12) gpuHistory = gpuHistory.slice(-12);
  memHistory.push(memUsed);
  if (memHistory.length > 12) memHistory = memHistory.slice(-12);
  const cpuText = colorByPercent(cpu, formatPercent(cpu));
  const gpuText = colorByPercent(gpuPct, `${gpuPct}%`);
  const memText = colorByPercent(memUsed, formatPercent(memUsed));
  const netInText = colorByRate(netInRate, formatRate(netInRate));
  const netOutText = colorByRate(netOutRate, formatRate(netOutRate));
  const pingText = pingState.ms == null ? dim('--') : `${Math.round(pingState.ms)}ms`;

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
  const loadValue = extraState.load1 == null ? dim('--') : colorByPercent(Math.min(100, (extraState.load1 / Math.max(1, os.cpus().length)) * 100), extraState.load1.toFixed(2));
  const diskUsedPct = (Number.isFinite(extraState.diskTotalBytes) && Number.isFinite(extraState.diskFreeBytes) && extraState.diskTotalBytes > 0)
    ? Math.max(0, Math.min(100, ((extraState.diskTotalBytes - extraState.diskFreeBytes) / extraState.diskTotalBytes) * 100))
    : NaN;
  const diskUsedBytes = (Number.isFinite(extraState.diskTotalBytes) && Number.isFinite(extraState.diskFreeBytes))
    ? Math.max(0, extraState.diskTotalBytes - extraState.diskFreeBytes)
    : NaN;
  const diskValue = Number.isFinite(extraState.diskTotalBytes)
    ? colorByPercent(
      diskUsedPct,
      `${formatDiskBytes(diskUsedBytes)}/${formatDiskBytes(extraState.diskTotalBytes)}`
    )
    : dim('--');
  const battPct = extraState.battery == null ? '--' : `${extraState.battery}%`;
  const battText = extraState.battery == null
    ? dim('--')
    : colorByPercent(100 - extraState.battery, `${battPct}${extraState.charging === true ? '⚡' : ''}`);

  const noAgent = noAgentTelemetryMode();
  const leftNetField = noAgent
    ? `${ICONS.net}${ICON_VALUE_GAP}↓ ${netInText}${ICON_VALUE_GAP}${ICONS.ping}${ICON_VALUE_GAP}${pingText}`
    : `${ICONS.ping}${ICON_VALUE_GAP}${pingText}${ICON_VALUE_GAP}${ICONS.net}${ICON_VALUE_GAP}↓ ${netInText}${ICON_VALUE_GAP}↑ ${netOutText}`;
  const cpuBar = miniBar(cpu, 8, [120, 175, 255]);
  const gpuBar = miniBar(gpuPct, 8, [196, 160, 255]);
  const memBar = miniBar(memUsed, 8, [97, 191, 103]);
  const leftFields = [
    `${ICONS.cpu}${ICON_VALUE_GAP}${cpuText}${ICON_VALUE_GAP}${cpuBar}`,
    `${ICONS.gpu}${ICON_VALUE_GAP}${gpuText}${ICON_VALUE_GAP}${gpuBar}`,
    `${ICONS.mem}${ICON_VALUE_GAP}${memText}${ICON_VALUE_GAP}${memBar}`,
    leftNetField
  ];
  const left = leftFields.join(fieldGap);

  const modelLabel = `${ICONS.model}${ICON_VALUE_GAP}${color(shorten(usageState.model || '--', 16), 120, 175, 255)}`;
  const tokenLabel = `${ICONS.tok}${ICON_VALUE_GAP}I ${tokInText}${ICON_VALUE_GAP}O ${tokOutText}${ICON_VALUE_GAP}T ${tokTotalText}`;
  const tokenLabelCompact = `${ICONS.tok}${ICON_VALUE_GAP}T ${tokTotalText}`;
  const ctxCostLabel = `${ICONS.ctx}${ICON_VALUE_GAP}${ctxValue}`;
  const ctxEtaLabel = `${ICONS.ctx}${ICON_VALUE_GAP}${ctxValue}`;
  const middleFull = [modelLabel, ctxCostLabel, tokenLabel].join(fieldGap);
  const middleCompact = [modelLabel, ctxEtaLabel, tokenLabelCompact].join(fieldGap);
  const middle = noAgent ? '' : (max < 145 ? middleCompact : middleFull);

  const dateRaw = max < 145 ? formatDateCompact(new Date()) : formatDateLite(new Date());
  const dateText = color(dateRaw, 174, 203, 255);
  const dateField = `${ICONS.date}${ICON_VALUE_GAP}${dateText}`;
  const rightFields = [
    `${ICONS.disk}${ICON_VALUE_GAP}${diskValue}`,
    dateField,
    `${ICONS.battery}${ICON_VALUE_GAP}${battText}`,
    `${ICONS.uptime}${ICON_VALUE_GAP}${formatUptimeCompact(uptime)}`,
    `${ICONS.load}${ICON_VALUE_GAP}${loadValue}`
  ];
  const rightCompactFields = [
    dateField
  ];
  const rightMinimalFields = [
    dateField
  ];
  const right = (max < 115 ? rightMinimalFields : (max < 145 ? rightCompactFields : rightFields)).join(fieldGap);

  if (!process.stdout.isTTY) {
    if (noAgent) process.stdout.write(`${left} | ${right}\n`);
    else process.stdout.write(`${left} | ${middle} | ${right}\n`);
    return;
  }

  let line;
  let pages = [''];
  if (noAgent) {
    const criticalFields = [
      `${ICONS.cpu}${ICON_VALUE_GAP}${cpuText}`,
      `${ICONS.gpu}${ICON_VALUE_GAP}${gpuText}`,
      `${ICONS.mem}${ICON_VALUE_GAP}${memText}`,
      `${ICONS.disk}${ICON_VALUE_GAP}${diskValue}`,
      `${ICONS.net}${ICON_VALUE_GAP}↓ ${netInText}`,
      `${ICONS.ping}${ICON_VALUE_GAP}${pingText}`
    ];
    const criticalCompactFields = [
      `${ICONS.cpu}${ICON_VALUE_GAP}${Math.round(cpu)}%`,
      `${ICONS.gpu}${ICON_VALUE_GAP}${gpuPct}%`,
      `${ICONS.mem}${ICON_VALUE_GAP}${Math.round(memUsed)}%`,
      `${ICONS.disk}${ICON_VALUE_GAP}${Number.isFinite(extraState.diskTotalBytes) ? `${formatDiskBytes(diskUsedBytes)}/${formatDiskBytes(extraState.diskTotalBytes)}` : '--'}`,
      `${ICONS.net}${ICON_VALUE_GAP}${formatRate(netInRate)}`,
      `${ICONS.ping}${ICON_VALUE_GAP}${pingText}`
    ];
    const secondaryFields = [
      `${ICONS.battery}${ICON_VALUE_GAP}${battText}`,
      `${ICONS.uptime}${ICON_VALUE_GAP}${formatUptimeCompact(uptime)}`,
      `${ICONS.load}${ICON_VALUE_GAP}${loadValue}`,
      `${ICONS.date}${ICON_VALUE_GAP}${dateText}`
    ];
    const budget = Math.max(10, max - visibleLength(EDGE_PADDING));
    const criticalFullLine = criticalFields.join(fieldGap);
    const compactGap = '  ';
    const criticalCompactLine = criticalCompactFields.join(compactGap);
    if (visibleLength(criticalFullLine) <= budget) {
      pages = paginateFields(criticalFields.concat(secondaryFields), budget, fieldGap);
    } else if (visibleLength(criticalCompactLine) <= budget) {
      pages = paginateFields(criticalCompactFields.concat(secondaryFields), budget, compactGap);
    } else {
      pages = paginateFields(criticalCompactFields, budget, ' ');
    }
    if (!pages.length) pages = [dateField];
  } else {
    const budget = Math.max(20, max - visibleLength(EDGE_PADDING));
    const shortModel = `${ICONS.model}${ICON_VALUE_GAP}${color(shorten(usageState.model || '--', max >= 170 ? 18 : 12), 120, 175, 255)}`;
    const shortTokens = max >= 170
      ? `${ICONS.tok}${ICON_VALUE_GAP}I ${tokInText}${ICON_VALUE_GAP}O ${tokOutText}${ICON_VALUE_GAP}T ${tokTotalText}`
      : `${ICONS.tok}${ICON_VALUE_GAP}T ${tokTotalText}`;
    const shortCtx = `${ICONS.ctx}${ICON_VALUE_GAP}${ctxValue}`;
    const shortNet = `${ICONS.net}${ICON_VALUE_GAP}↓ ${netInText}${ICON_VALUE_GAP}↑ ${netOutText}`;
    const shortDate = `${ICONS.date}${ICON_VALUE_GAP}${color(formatDateLite(new Date()), 174, 203, 255)}`;

    const leftCompact = [
      `${ICONS.cpu}${ICON_VALUE_GAP}${cpuText}${ICON_VALUE_GAP}${cpuBar}`,
      `${ICONS.gpu}${ICON_VALUE_GAP}${gpuText}${ICON_VALUE_GAP}${gpuBar}`,
      `${ICONS.mem}${ICON_VALUE_GAP}${memText}${ICON_VALUE_GAP}${memBar}`,
      `${ICONS.ping}${ICON_VALUE_GAP}${pingText}`,
      shortNet
    ];
    const middleCompact = [shortModel, shortTokens, shortCtx];
    const rightCompact = [
      `${ICONS.disk}${ICON_VALUE_GAP}${diskValue}`,
      `${ICONS.battery}${ICON_VALUE_GAP}${battText}`,
      `${ICONS.uptime}${ICON_VALUE_GAP}${formatUptimeCompact(uptime)}`,
      `${ICONS.load}${ICON_VALUE_GAP}${loadValue}`,
      shortDate
    ];
    const orderedFields = leftCompact.concat(middleCompact).concat(rightCompact);
    pages = paginateFields(orderedFields, budget, fieldGap);
  }

  if (!pages.length) pages = [''];
  pageCount = pages.length;
  pageIndex = clampPageIndex(pageIndex, pageCount);
  line = pages[pageIndex] || '';

  const frameWidth = visibleLength(FRAME_LEFT) + visibleLength(FRAME_RIGHT);
  const contentWidth = Math.max(10, max - visibleLength(EDGE_PADDING) - frameWidth);
  const pageTag = pageCount > 1 ? dim(` [${pageIndex + 1}/${pageCount}]`) : '';
  const tagWidth = visibleLength(pageTag);
  const textBudget = Math.max(6, contentWidth - tagWidth);
  scrollable = visibleLength(line) > textBudget;
  if (!scrollable) scrollOffset = 0;
  const baseLine = scrollable ? sliceVisible(line, scrollOffset, textBudget) : shorten(line, textBudget);
  const fitted = `${baseLine}${pageTag}`;
  const filled = fillLineToWidth(fitted, contentWidth);
  process.stdout.write(`\x1b[2K\r${EDGE_PADDING}${FRAME_LEFT}${filled}${FRAME_RIGHT}`);

  // Poll after painting so state appears immediately on startup.
  // When sampler process is enabled, render loop only consumes cached telemetry.
  if (!samplerChild) {
    if (fastBoot || tick % RESCAN_EVERY === 1) {
      usageState = resolveUsage();
    }
    if (fastBoot || tick % GPU_RESCAN_EVERY === 0) {
      gpuState = readGpuInfo();
    }
    if (fastBoot || tick % EXTRAS_RESCAN_EVERY === 0) {
      extraState = readSystemExtras();
    }
    if (fastBoot || tick % PING_RESCAN_EVERY === 0) {
      pingState = readPing();
    }
  }
}

function setupInputControls() {
  if (inputBound || !process.stdin.isTTY || process.env.ZVIBE_STATUSBAR_SAMPLER === '1') return;
  inputBound = true;
  try {
    if (typeof process.stdin.setRawMode === 'function') process.stdin.setRawMode(true);
  } catch {}
  process.stdin.resume();
  process.stdin.on('data', (chunk) => {
    const input = String(chunk || '');
    if (!input) return;

    const pageNext = () => { pageIndex = clampPageIndex(pageIndex + 1, pageCount); };
    const pagePrev = () => { pageIndex = clampPageIndex(pageIndex - 1, pageCount); };
    const scrollNext = () => { if (scrollable) scrollOffset += 4; };
    const scrollPrev = () => { if (scrollable) scrollOffset = Math.max(0, scrollOffset - 4); };

    if (/\x1b\[<64;[0-9]+;[0-9]+[mM]/.test(input) || input === '\x1b[A' || input === '\x1b[C') {
      if (pageCount > 1) pageNext();
      else scrollNext();
      render();
      return;
    }
    if (/\x1b\[<65;[0-9]+;[0-9]+[mM]/.test(input) || input === '\x1b[B' || input === '\x1b[D') {
      if (pageCount > 1) pagePrev();
      else scrollPrev();
      render();
      return;
    }
    if (input === ']' || input.toLowerCase() === 'n') {
      if (pageCount > 1) pageNext();
      else scrollNext();
      render();
      return;
    }
    if (input === '[' || input.toLowerCase() === 'p') {
      if (pageCount > 1) pagePrev();
      else scrollPrev();
      render();
    }
  });
}

function sendSamplerMetrics(payload) {
  if (!process.send) return;
  try {
    process.send({ type: 'metrics', ...payload });
  } catch {}
}

function runSamplerProcess() {
  let localTick = 0;
  let localPrevNet = readNetworkBytes();
  let localPrevNetAt = Date.now();
  let localRates = { inRate: 0, outRate: 0 };
  let localUsage = { model: null, input: null, output: null, total: null, context: null, cost: null };
  let localGpu = { model: null, util: 0, raw: null, source: 'fallback' };
  let localExtras = { load1: null, diskUsed: null, diskTotalBytes: null, diskFreeBytes: null, battery: null, charging: null };
  let localPing = { ms: null };

  const sample = () => {
    localTick += 1;
    const fastBoot = localTick <= BOOTSTRAP_FAST_TICKS;
    const now = Date.now();

    if (fastBoot || localTick % NETWORK_RESCAN_EVERY === 0) {
      const netNow = readNetworkBytes();
      const netElapsed = Math.max(0.2, (now - localPrevNetAt) / 1000);
      localRates = {
        inRate: Math.max(0, (netNow.inBytes - localPrevNet.inBytes) / netElapsed),
        outRate: Math.max(0, (netNow.outBytes - localPrevNet.outBytes) / netElapsed)
      };
      localPrevNet = netNow;
      localPrevNetAt = now;
    }
    if (fastBoot || localTick % RESCAN_EVERY === 1) localUsage = resolveUsage();
    if (fastBoot || localTick % GPU_RESCAN_EVERY === 0) localGpu = readGpuInfo();
    if (fastBoot || localTick % EXTRAS_RESCAN_EVERY === 0) localExtras = readSystemExtras();
    if (fastBoot || localTick % PING_RESCAN_EVERY === 0) localPing = readPing();

    sendSamplerMetrics({
      usageState: localUsage,
      gpuState: localGpu,
      extraState: localExtras,
      pingState: localPing,
      netRates: localRates
    });
  };

  sample();
  setInterval(sample, TICK_MS);
}

function startSamplerProcess() {
  if (process.env.ZVIBE_DISABLE_STATUSBAR_SAMPLER === '1') return null;
  try {
    const child = fork(__filename, [], {
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
      env: {
        ...process.env,
        ZVIBE_STATUSBAR_SAMPLER: '1',
        ZVIBE_DISABLE_STATUSBAR_SAMPLER: '1'
      }
    });
    child.on('message', (message) => {
      if (!message || message.type !== 'metrics') return;
      if (message.usageState) usageState = message.usageState;
      if (message.gpuState) gpuState = message.gpuState;
      if (message.extraState) extraState = message.extraState;
      if (message.pingState) pingState = message.pingState;
      if (message.netRates) netRates = message.netRates;
    });
    child.on('exit', () => {
      samplerChild = null;
    });
    return child;
  } catch {
    return null;
  }
}

process.on('SIGINT', () => {
  try { if (inputBound && typeof process.stdin.setRawMode === 'function') process.stdin.setRawMode(false); } catch {}
  if (samplerChild) {
    try { samplerChild.kill('SIGTERM'); } catch {}
  }
  process.stdout.write('\n');
  process.exit(0);
});

process.on('SIGTERM', () => {
  try { if (inputBound && typeof process.stdin.setRawMode === 'function') process.stdin.setRawMode(false); } catch {}
  if (samplerChild) {
    try { samplerChild.kill('SIGTERM'); } catch {}
  }
  process.stdout.write('\n');
  process.exit(0);
});

if (require.main === module) {
  if (process.env.ZVIBE_STATUSBAR_SAMPLER === '1') {
    runSamplerProcess();
    return;
  }
  samplerChild = startSamplerProcess();
  setupInputControls();
  render();
  setInterval(render, TICK_MS);
}

module.exports = {
  visibleLength,
  shorten,
  fillLineToWidth,
  packFieldsByWidth,
  paginateFields,
  clampPageIndex,
  layoutPinnedEdges,
  segmentRatios,
  layoutThreeColumns
};
