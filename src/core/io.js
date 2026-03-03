const fs = require('fs');

function formatPrefix(level) {
  if (level === 'info') return 'ℹ️';
  if (level === 'ok') return '✅';
  if (level === 'warn') return '⚠️';
  if (level === 'error') return '❌';
  return '·';
}

class Output {
  constructor(options = {}) {
    this.json = !!options.json;
    this.verbose = !!options.verbose;
    this.events = [];
  }

  emit(level, message, data) {
    const event = { level, message, ...(data ? { data } : {}) };
    this.events.push(event);
    if (!this.json) {
      const prefix = formatPrefix(level);
      process.stdout.write(`${prefix} ${message}\n`);
    }
  }

  info(message, data) { this.emit('info', message, data); }
  ok(message, data) { this.emit('ok', message, data); }
  warn(message, data) { this.emit('warn', message, data); }
  error(message, data) { this.emit('error', message, data); }

  printJson(payload) {
    process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
  }

  flushJson(summary) {
    if (!this.json) return;
    this.printJson({ ...summary, events: this.events });
  }
}

function ensureDir(path) {
  fs.mkdirSync(path, { recursive: true });
}

module.exports = { Output, ensureDir };
