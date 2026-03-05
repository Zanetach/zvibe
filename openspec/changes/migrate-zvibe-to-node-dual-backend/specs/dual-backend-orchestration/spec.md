## ADDED Requirements

### 需求:双后端共存
系统必须同时支持 `ghostty-applescript` 与 `tmux` 两种后端能力，并禁止将其中任一后端硬编码为唯一实现。

#### 场景:后端可显式指定
- **当** 用户通过配置或参数指定 `ghostty` 或 `tmux`
- **那么** 系统必须仅使用指定后端执行布局与启动

### 需求:自动后端路由
系统必须支持 `backend=auto`，并必须按既定优先级选择后端。

#### 场景:auto 优先 Ghostty
- **当** `backend=auto` 且 Ghostty 路径可用
- **那么** 系统必须优先选择 Ghostty 后端

### 需求:失败降级策略
系统必须支持后端降级策略，在主后端失败且允许降级时切换到备用后端。

#### 场景:Ghostty 失败降级 tmux
- **当** `backend=auto` 且 Ghostty 执行失败且 `fallback=true`
- **那么** 系统必须自动尝试 tmux 后端并记录降级原因

## MODIFIED Requirements

## REMOVED Requirements
