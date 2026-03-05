## 1. 项目骨架与迁移准备

- [x] 1.1 初始化 Node/TypeScript CLI 工程结构（入口、命令模块、服务模块）
- [x] 1.2 建立配置 schema（defaultAgent、agentPair、backend、fallback、autoGitInit）与加载器
- [x] 1.3 建立统一错误码与结果模型（文本输出 + JSON 输出）
- [x] 1.4 建立 CLI 参数优先级解析规则（参数 > 配置 > 默认）

## 2. 命令层等价迁移

- [x] 2.1 迁移 `zvibe` 无参数启动路径并实现 defaultAgent 强约束
- [x] 2.2 迁移 `zvibe codex|claude|opencode|code` 运行路径
- [x] 2.3 迁移 `setup` 基础流程（preflight/install/verify/init-config）
- [x] 2.4 迁移 `config` 基础流程（读取/写入/校验）
- [x] 2.5 迁移 `status` 基础流程（环境层、配置层、运行层）

## 3. 后端编排能力（Ghostty + tmux）

- [x] 3.1 定义 Backend 接口（preflight、launch、healthcheck）
- [x] 3.2 实现 ghostty-applescript backend 并对齐现有布局行为
- [x] 3.3 实现 tmux backend（会话创建、布局、attach/reuse）
- [x] 3.4 实现 `backend=auto` 路由策略（优先 ghostty）
- [x] 3.5 实现 `fallback=true` 时 Ghostty 失败自动降级 tmux

## 4. Agent 启动策略与配置体验

- [x] 4.1 实现 defaultAgent 缺失/非法 fail-fast 与中文修复提示
- [x] 4.2 实现 `zvibe code` 使用 agentPair 双 Agent 启动策略
- [x] 4.3 实现 setup 中 defaultAgent 必选交互与持久化
- [x] 4.4 实现 config 对关键字段的合法性校验与错误映射
- [x] 4.5 实现配置解释输出（当前配置将触发的实际行为）

## 5. 交互与稳定性增强

- [x] 5.1 统一中文输出文案（成功、告警、失败、下一步建议）
- [x] 5.2 增加 `--json` 与 `--verbose` 支持并覆盖核心命令
- [x] 5.3 增加 setup 可重复修复能力（repair 模式，仅处理失败项）
- [x] 5.4 增加 status 诊断能力（分层结果 + 标准错误码）
- [x] 5.5 将关键底层错误映射为可行动提示（权限、命令缺失、后端不可用）

## 6. 验证与发布准备

- [x] 6.1 制定并执行命令行为回归清单（与 Bash 版本对照）
- [x] 6.2 验证 Ghostty 成功路径、失败路径与 tmux 降级路径
- [x] 6.3 验证无参数启动、单 Agent、双 Agent 三类核心场景
- [x] 6.4 完成 README 与迁移说明（中文）
- [x] 6.5 准备发布版本与回滚方案（保留旧入口应急回切）
