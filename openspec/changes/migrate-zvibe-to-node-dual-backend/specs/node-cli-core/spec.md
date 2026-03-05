## ADDED Requirements

### 需求:Node CLI 核心入口
系统必须提供基于 Node/TypeScript 的统一 CLI 入口，并必须兼容现有命令语义（`zvibe`、`zvibe setup`、`zvibe config`、`zvibe status`、`zvibe code`）。

#### 场景:命令语义保持兼容
- **当** 用户执行 `zvibe setup`、`zvibe config`、`zvibe status` 或 `zvibe code`
- **那么** 系统必须按对应命令语义执行，不得要求用户学习新的主命令集合

### 需求:配置模式校验
系统必须在加载配置时执行结构化校验，并在配置缺失或非法时返回明确错误。

#### 场景:配置非法时阻断启动
- **当** 配置文件中的关键字段类型不合法或值不在允许集合内
- **那么** 系统必须阻断运行并输出可行动修复提示

### 需求:可观测输出模式
系统必须支持人类可读输出与机器可读输出两种模式，以满足交互与自动化场景。

#### 场景:JSON 输出
- **当** 用户执行命令并传入 `--json`
- **那么** 系统必须返回结构化 JSON 结果，且包含状态和错误字段

## MODIFIED Requirements

## REMOVED Requirements
