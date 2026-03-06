const fs = require('fs');
const os = require('os');
const path = require('path');
const { run, commandExists } = require('../core/process');
const { ZvibeError, ERRORS } = require('../core/errors');

function sessionName(targetDir, sessionTag = '') {
  const rawBase = targetDir.split('/').filter(Boolean).pop();
  const normalizedBase = String(rawBase || 'workspace')
    .replace(/(?:[_-]?kits?)$/i, '')
    .replace(/[^a-zA-Z0-9_-]/g, '-');
  const base = normalizedBase || 'workspace';
  const tag = String(sessionTag || '').trim().replace(/[^a-zA-Z0-9_-]/g, '-');
  if (!tag) return base;
  return `${base}-${tag}`;
}

function preflight() {
  if (!commandExists('zellij')) {
    throw new ZvibeError(ERRORS.ZELLIJ_MISSING, '未检测到 zellij', '请安装 zellij 或改用 --backend ghostty');
  }
}

function shellWrap(targetDir, command) {
  const shell = process.env.SHELL || '/bin/zsh';
  const quotedDir = targetDir.replace(/'/g, `'\\''`);
  const paneCommand = String(command || '').trim() || ':';
  const quotedCmd = paneCommand.replace(/'/g, `'\\''`);
  const quotedShell = shell.replace(/'/g, `'\\''`);
  return `cd '${quotedDir}' || printf '[zvibe] warning: failed to enter %s\\n' '${quotedDir}'; ${quotedCmd}; _zvibe_code=$?; [ "$_zvibe_code" -eq 0 ] || printf '[zvibe] pane command exited: %s\\n' "$_zvibe_code"; exec ${quotedShell} -l`;
}

function escapeKdl(value) {
  return String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

function paneKdl(targetDir, command, paneName, size = null) {
  const shell = process.env.SHELL || '/bin/zsh';
  const cmd = shellWrap(targetDir, command);
  const sizeAttr = size ? ` size="${escapeKdl(size)}"` : '';
  return `pane name="${escapeKdl(paneName)}"${sizeAttr} borderless=true command="${escapeKdl(shell)}" {\n        args "-lc" "${escapeKdl(cmd)}"\n      }`;
}

function buildLayout(targetDir, commands) {
  const panePrefix = 'zvibe';
  const minimalTerminal = !!commands.minimalTerminal;
  const statusBar = paneKdl(targetDir, commands.statusBar || 'true', `${panePrefix}:state`, '3');
  const rightTopRole = commands.rightTopRole || 'agent';
  const rightTop = paneKdl(targetDir, commands.rightTop, `${panePrefix}:${rightTopRole}`);

  if (minimalTerminal) {
    return `layout {\n  pane split_direction="Horizontal" {\n    pane size="94%" {\n      ${rightTop}\n    }\n    ${statusBar}\n  }\n}\n`;
  }

  const leftTop = paneKdl(targetDir, commands.leftTop, `${panePrefix}:project`, '60%');
  const leftBottom = paneKdl(targetDir, commands.leftBottom, `${panePrefix}:commit`, '40%');
  const rightBottomIsTerminal = commands.rightBottom === 'true';
  const rightTopSize = rightBottomIsTerminal ? '70%' : '50%';
  const rightBottomSize = rightBottomIsTerminal ? '30%' : '50%';
  const rightTopSized = paneKdl(targetDir, commands.rightTop, `${panePrefix}:${rightTopRole}`, rightTopSize);

  if (!commands.rightBottom) {
    return `layout {\n  pane split_direction="Horizontal" {\n    pane size="94%" split_direction="Vertical" {\n      pane size="45%" split_direction="Horizontal" {\n        ${leftTop}\n        ${leftBottom}\n      }\n      pane size="55%" {\n        ${rightTopSized}\n      }\n    }\n    ${statusBar}\n  }\n}\n`;
  }
  const rightBottom = paneKdl(targetDir, commands.rightBottom, `${panePrefix}:${rightBottomIsTerminal ? 'terminal' : 'agent'}`, rightBottomSize);
  return `layout {\n  pane split_direction="Horizontal" {\n    pane size="94%" split_direction="Vertical" {\n      pane size="45%" split_direction="Horizontal" {\n        ${leftTop}\n        ${leftBottom}\n      }\n      pane size="55%" split_direction="Horizontal" {\n        ${rightTopSized}\n        ${rightBottom}\n      }\n    }\n    ${statusBar}\n  }\n}\n`;
}

function writeLayout(targetDir, commands) {
  const file = path.join(os.tmpdir(), `zvibe-zellij-layout-${process.pid}-${Date.now()}.kdl`);
  fs.writeFileSync(file, buildLayout(targetDir, commands), 'utf8');
  return file;
}

function mustRun(command, args, hint, options = {}) {
  const result = run(command, args, options);
  if (!result.ok) {
    if (String(result.error || '').toLowerCase().includes('enoent')) {
      throw new ZvibeError(ERRORS.ZELLIJ_MISSING, '未检测到 zellij', '请安装 zellij 或改用 --backend ghostty');
    }
    throw new ZvibeError(ERRORS.RUN_FAILED, `${command} 命令失败: ${args.join(' ')}`, hint || '请检查 zellij 状态后重试', result.stderr || result.stdout);
  }
  return result;
}

function applyPaneFrames() {
  const mouseMode = String(process.env.ZVIBE_ZELLIJ_MOUSE_MODE || 'false').trim().toLowerCase();
  const enableMouseMode = ['1', 'true', 'yes', 'on'].includes(mouseMode);
  run('zellij', ['options', '--pane-frames', 'false'], { capture: true });
  run('zellij', ['options', '--mouse-mode', enableMouseMode ? 'true' : 'false'], { capture: true });
}

function ensureInteractiveInputMode() {
  // When launched from an existing locked client (eg. external agent),
  // new tabs can inherit locked mode and appear "unclickable".
  run('zellij', ['action', 'switch-mode', 'pane'], { capture: true });
}

function launch({ targetDir, commands, freshSession = false, sessionTag = '' }) {
  preflight();
  const name = sessionName(targetDir, sessionTag);
  const layoutFile = writeLayout(targetDir, commands);

  try {
    const inZellij = !!process.env.ZELLIJ;

    if (inZellij) {
      // Inside zellij: always open a new tab with the latest layout.
      // This avoids attaching stale sessions that may not contain recent layout updates.
      mustRun('zellij', ['action', 'new-tab', '--name', name, '--cwd', targetDir, '--layout', layoutFile], '请检查当前 zellij 会话状态', { capture: true });
      // Some zellij setups keep focus on current tab after creating a new tab.
      // Move focus to make the new zvibe tab immediately visible.
      run('zellij', ['action', 'go-to-next-tab'], { capture: true });
      applyPaneFrames();
      ensureInteractiveInputMode();
      return;
    }

    const existing = listSessions();
    if (existing.includes(name)) {
      if (freshSession) {
        mustRun('zellij', ['delete-session', '--force', name], '请检查 zellij 会话状态', { capture: true });
      } else {
        const attachResult = run('zellij', ['attach', name], { capture: false });
        if (attachResult.ok) return;
        mustRun('zellij', ['delete-session', '--force', name], '请检查 zellij 会话状态', { capture: true });
      }
    }

    mustRun('zellij', ['-s', name, '-n', layoutFile], '请检查 zellij 配置后重试', { capture: false, cwd: targetDir });
  } finally {
    try {
      fs.unlinkSync(layoutFile);
    } catch {}
  }
}

function healthcheck() {
  try {
    preflight();
    return { ok: true, backend: 'zellij' };
  } catch (error) {
    return { ok: false, backend: 'zellij', error };
  }
}

function normalizeSessionInput(name) {
  const raw = String(name || '').trim();
  if (!raw) return '';
  return raw;
}

function isValidSessionName(name) {
  return /^[a-zA-Z0-9_-]+$/.test(name);
}

function filterZvibeSessions(output) {
  const legacyPattern = /^zvibe-/;
  const currentPattern = /-(codex|claude|opencode|code|terminal)-[a-z]{2}[0-9]{2}$/;
  return String(output || '')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && (legacyPattern.test(line) || currentPattern.test(line)));
}

function listSessions() {
  const result = run('zellij', ['list-sessions', '--no-formatting', '--short'], { capture: true });
  if (String(result.error || '').toLowerCase().includes('enoent')) {
    throw new ZvibeError(ERRORS.ZELLIJ_MISSING, '未检测到 zellij', '请安装 zellij 或改用 --backend ghostty');
  }
  if (!result.ok) {
    const combined = `${result.stdout || ''}\n${result.stderr || ''}`.toLowerCase();
    // zellij exits with code 1 when there are no active sessions.
    if (result.code === 1 && combined.includes('no active zellij sessions found')) {
      return [];
    }
    throw new ZvibeError(ERRORS.RUN_FAILED, 'zellij 会话列表读取失败', '请检查 zellij 状态后重试', result.stderr || result.stdout);
  }
  // Also check stderr for output (some versions of zellij output to stderr even on success)
  const output = result.stdout || result.stderr || '';
  return filterZvibeSessions(output);
}

function killSession(name) {
  const resolved = normalizeSessionInput(name);
  if (!resolved) {
    throw new ZvibeError(ERRORS.RUN_FAILED, '缺少会话名', '用法: zvibe session kill <name>');
  }
  if (!isValidSessionName(resolved)) {
    throw new ZvibeError(ERRORS.RUN_FAILED, `非法会话名: ${name}`, '会话名仅允许字母、数字、下划线和短横线');
  }

  const deleteResult = run('zellij', ['delete-session', '--force', resolved], { capture: true });
  if (String(deleteResult.error || '').toLowerCase().includes('enoent')) {
    throw new ZvibeError(ERRORS.ZELLIJ_MISSING, '未检测到 zellij', '请安装 zellij 或改用 --backend ghostty');
  }
  if (!deleteResult.ok) {
    throw new ZvibeError(ERRORS.RUN_FAILED, `删除会话失败: ${resolved}`, '请先执行 zvibe session list 确认名称', deleteResult.stderr || deleteResult.stdout);
  }
  return resolved;
}

function attachSession(name) {
  const resolved = normalizeSessionInput(name);
  if (!resolved) {
    throw new ZvibeError(ERRORS.RUN_FAILED, '缺少会话名', '用法: zvibe session attach <name>');
  }
  if (!isValidSessionName(resolved)) {
    throw new ZvibeError(ERRORS.RUN_FAILED, `非法会话名: ${name}`, '会话名仅允许字母、数字、下划线和短横线');
  }

  const existing = listSessions();
  if (!existing.includes(resolved)) {
    throw new ZvibeError(ERRORS.RUN_FAILED, `会话不存在: ${resolved}`, '请先执行 zvibe session list 确认名称');
  }

  const result = run('zellij', ['attach', resolved], { capture: false });
  if (String(result.error || '').toLowerCase().includes('enoent')) {
    throw new ZvibeError(ERRORS.ZELLIJ_MISSING, '未检测到 zellij', '请安装 zellij 或改用 --backend ghostty');
  }
  if (!result.ok) {
    throw new ZvibeError(ERRORS.RUN_FAILED, `attach 失败: ${resolved}`, '请检查 zellij 状态后重试', result.stderr || result.stdout);
  }
  return resolved;
}

module.exports = {
  name: 'zellij',
  preflight,
  launch,
  shellWrap,
  healthcheck,
  sessionName,
  listSessions,
  killSession,
  attachSession,
  normalizeSessionInput,
  filterZvibeSessions
};
