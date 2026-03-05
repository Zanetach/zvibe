const fs = require('fs');
const os = require('os');
const path = require('path');
const { run, commandExists } = require('../core/process');
const { ZvibeError, ERRORS } = require('../core/errors');

function sessionName(targetDir, sessionTag = '') {
  const base = targetDir.split('/').filter(Boolean).pop().replace(/[^a-zA-Z0-9_-]/g, '-');
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
  const quotedCmd = command.replace(/'/g, `'\\''`);
  const quotedShell = shell.replace(/'/g, `'\\''`);
  return `cd '${quotedDir}' && ${quotedCmd}; exec ${quotedShell} -l`;
}

function escapeKdl(value) {
  return String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

function paneKdl(targetDir, command, paneName, size = null) {
  const shell = process.env.SHELL || '/bin/zsh';
  const cmd = shellWrap(targetDir, command);
  const sizeAttr = size ? ` size="${escapeKdl(size)}"` : '';
  return `pane name="${escapeKdl(paneName)}"${sizeAttr} command="${escapeKdl(shell)}" {\n        args "-lc" "${escapeKdl(cmd)}"\n      }`;
}

function buildLayout(targetDir, commands) {
  const project = sessionName(targetDir);
  const leftTop = paneKdl(targetDir, commands.leftTop, `${project}:files`);
  const leftBottom = paneKdl(targetDir, commands.leftBottom, `${project}:commit`);
  const rightBottomIsTerminal = commands.rightBottom === 'true';
  const rightTopSize = rightBottomIsTerminal ? '70%' : '50%';
  const rightBottomSize = rightBottomIsTerminal ? '30%' : '50%';
  const rightTop = paneKdl(targetDir, commands.rightTop, `${project}:agent`, rightTopSize);
  if (!commands.rightBottom) {
    return `layout {\n  pane split_direction="Vertical" {\n    pane size="45%" split_direction="Horizontal" {\n      ${leftTop}\n      ${leftBottom}\n    }\n    pane size="55%" {\n      ${rightTop}\n    }\n  }\n}\n`;
  }
  const rightBottom = paneKdl(targetDir, commands.rightBottom, `${project}:${rightBottomIsTerminal ? 'terminal' : 'agent'}`, rightBottomSize);
  return `layout {\n  pane split_direction="Vertical" {\n    pane size="45%" split_direction="Horizontal" {\n      ${leftTop}\n      ${leftBottom}\n    }\n    pane size="55%" split_direction="Horizontal" {\n      ${rightTop}\n      ${rightBottom}\n    }\n  }\n}\n`;
}

function writeLayout(targetDir, commands) {
  const file = path.join(os.tmpdir(), `zvibe-zellij-layout-${process.pid}-${Date.now()}.kdl`);
  fs.writeFileSync(file, buildLayout(targetDir, commands), 'utf8');
  return file;
}

function mustRun(command, args, hint, options = {}) {
  const result = run(command, args, options);
  if (!result.ok) {
    throw new ZvibeError(ERRORS.RUN_FAILED, `${command} 命令失败: ${args.join(' ')}`, hint || '请检查 zellij 状态后重试', result.stderr || result.stdout);
  }
  return result;
}

function applyPaneFrames() {
  run('zellij', ['options', '--pane-frames', 'true'], { capture: true });
}

function launch({ targetDir, commands, freshSession = false, sessionTag = '' }) {
  preflight();
  const name = `zvibe-${sessionName(targetDir, sessionTag)}`;
  const layoutFile = writeLayout(targetDir, commands);

  try {
    const inZellij = !!process.env.ZELLIJ;
    const existing = listSessions();
    if (existing.includes(name)) {
      if (freshSession && !inZellij) {
        mustRun('zellij', ['delete-session', '--force', name], '请检查 zellij 会话状态', { capture: true });
      } else {
        const attachResult = run('zellij', ['attach', name], { capture: false });
        if (attachResult.ok) return;
        if (!inZellij) {
          mustRun('zellij', ['delete-session', '--force', name], '请检查 zellij 会话状态', { capture: true });
        } else {
          // When already inside zellij, attaching another session is often unsupported.
          // Avoid spawning duplicate agent panes; keep the existing session as-is.
          return;
        }
      }
    }

    if (inZellij) {
      // IMPORTANT: when already inside zellij, never kill/delete sessions here.
      // Otherwise we may terminate the current interactive session unexpectedly.
      mustRun('zellij', ['action', 'new-tab', '--name', name, '--cwd', targetDir, '--layout', layoutFile], '请检查当前 zellij 会话状态', { capture: true });
      applyPaneFrames();
      return;
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
  return raw.startsWith('zvibe-') ? raw : `zvibe-${raw}`;
}

function isValidSessionName(name) {
  return /^[a-zA-Z0-9_-]+$/.test(name);
}

function listSessions() {
  preflight();
  const result = run('zellij', ['list-sessions', '--no-formatting', '--short'], { capture: true });
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
  return output
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && line.startsWith('zvibe-'));
}

function killSession(name) {
  preflight();
  const resolved = normalizeSessionInput(name);
  if (!resolved) {
    throw new ZvibeError(ERRORS.RUN_FAILED, '缺少会话名', '用法: zvibe session kill <name>');
  }
  if (!isValidSessionName(resolved)) {
    throw new ZvibeError(ERRORS.RUN_FAILED, `非法会话名: ${name}`, '会话名仅允许字母、数字、下划线和短横线');
  }

  const deleteResult = run('zellij', ['delete-session', '--force', resolved], { capture: true });
  if (!deleteResult.ok) {
    throw new ZvibeError(ERRORS.RUN_FAILED, `删除会话失败: ${resolved}`, '请先执行 zvibe session list 确认名称', deleteResult.stderr || deleteResult.stdout);
  }
  return resolved;
}

function attachSession(name) {
  preflight();
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
  if (!result.ok) {
    throw new ZvibeError(ERRORS.RUN_FAILED, `attach 失败: ${resolved}`, '请检查 zellij 状态后重试', result.stderr || result.stdout);
  }
  return resolved;
}

module.exports = {
  name: 'zellij',
  preflight,
  launch,
  healthcheck,
  sessionName,
  listSessions,
  killSession,
  attachSession,
  normalizeSessionInput
};
