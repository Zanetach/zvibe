const { spawnSync } = require('child_process');

function run(command, args = [], options = {}) {
  const result = spawnSync(command, args, {
    stdio: options.capture ? 'pipe' : 'inherit',
    cwd: options.cwd || process.cwd(),
    env: { ...process.env, ...(options.env || {}) },
    encoding: 'utf8'
  });

  return {
    ok: result.status === 0,
    code: result.status,
    stdout: result.stdout || '',
    stderr: result.stderr || ''
  };
}

function commandExists(cmd) {
  const result = spawnSync('sh', ['-lc', `command -v ${cmd}`], { stdio: 'pipe' });
  return result.status === 0;
}

module.exports = { run, commandExists };
