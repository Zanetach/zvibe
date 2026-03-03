const { commandExists } = require('./process');
const { ZvibeError, ERRORS } = require('./errors');
const { AGENTS } = require('./constants');

function validateAgent(agent) {
  if (!AGENTS.includes(agent)) {
    throw new ZvibeError(ERRORS.AGENT_INVALID, `未知 agent: ${agent}`, `可选值: ${AGENTS.join('|')}`);
  }
}

function claudeCommand() {
  if (commandExists('claude')) return 'claude';
  if (commandExists('claude-code')) return 'claude-code';
  return 'claude';
}

function agentCommand(agent) {
  validateAgent(agent);
  if (agent === 'codex') {
    if (commandExists('codex')) return 'codex';
    return 'npx --yes @openai/codex';
  }
  if (agent === 'claude') return claudeCommand();
  if (agent === 'opencode') return 'opencode';
  return agent;
}

module.exports = { validateAgent, agentCommand, claudeCommand };
