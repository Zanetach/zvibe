## 为什么

当前 Zvibe 以 Bash 脚本为核心实现，随着功能扩展（Ghostty、tmux、多 Agent、setup/config/status 交互）在可维护性、稳定性与可观测性上已接近上限。现在需要以 Node/TypeScript 重构为中心，建立更可靠、可扩展且更易使用的运行架构，并保留现有用户心智模型。

## 变更内容

- 将 CLI 核心从 Bash 迁移到 Node/TypeScript，保留现有命令语义（`zvibe`、`zvibe setup`、`zvibe config`、`zvibe status`、`zvibe code`）。
- 引入双后端运行模型：`ghostty-applescript` 与 `tmux` 共存，并支持 `auto` 自动选择与可配置降级策略。
- 保留并强化默认行为：无参数 `zvibe` 必须使用 `defaultAgent` 启动；`zvibe code` 使用双 Agent 配对配置。
- 升级交互与稳定性：setup/config/status 提供可行动错误、结构化状态输出、可重复修复流程与更清晰的结果反馈。
- 输出与文案统一为中文，降低使用和排障成本。

## 功能 (Capabilities)

### 新增功能
- `node-cli-core`: 提供基于 Node/TypeScript 的 CLI 核心编排能力，承接参数解析、配置加载、运行调度与错误模型。
- `dual-backend-orchestration`: 提供 Ghostty 与 tmux 双后端共存、显式指定、自动路由与失败降级能力。
- `agent-launch-policy`: 定义并保证 defaultAgent、单 Agent 模式、双 Agent 模式的一致启动策略与优先级规则。
- `interactive-ops-experience`: 提供 setup/config/status 的中文交互体验、诊断输出与修复引导能力。

### 修改功能
- （无）

## 影响

- 受影响代码：CLI 入口与命令执行链路（参数解析、配置管理、后端调度、Agent 启动流程）。
- 受影响系统：Ghostty 自动化控制链路、tmux 会话管理链路、依赖检查与初始化流程。
- 受影响用户体验：命令行为保持兼容，输出语言和故障提示将更清晰，默认流程更稳定。
- 风险与迁移：需要确保旧配置兼容与行为对齐，避免对现有 `zvibe` 使用习惯造成破坏。
