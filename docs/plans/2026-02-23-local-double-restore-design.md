# Local Double 模式恢复设计

Date: 2026-02-23  
Status: approved in chat  
Scope: 在不影响现有 `single` 与 `online` 的前提下，恢复本地同键盘双人对战

## 1. 目标与约束

- 保留现有 `single` 模式与 `online` 模式行为不变。
- 新增 `local double` 模式（同一台电脑、同一键盘）。
- `local double` 匿名即可玩，不计分、不入榜，不触发任何数据库写入。
- 首页四卡顺序调整为：
  1. single（不变）
  2. online（不变）
  3. local double（新增）
  4. leaderboard（内容不变，仅位置调整）
- 进入方式与现有两种模式一致：页面迁移到 `/?mode=...&popup=1`，不是新窗口。

## 2. 路由与模式

- `Mode` 扩展为：`menu | single | online | local-double`。
- URL 参数解析支持 `mode=local-double`。
- `navigateToMode` 支持传入 `local-double`。
- 弹层顶栏模式文案增加“本地双人模式”。

## 3. Local Double 玩法

- 两个棋盘同时运行，均使用现有 `tetris-core` 状态机。
- 键位：
  - 左玩家：`W/A/S/D`
  - 右玩家：`↑/←/↓/→`
- 垃圾行规则：
  - 消 1 行：发送 0
  - 消 2/3/4 行：发送 2/3/4
- 速度规则：
  - 初始重力间隔 `1000ms`
  - 每 `60s` 提速 `10%`
- 结算规则：
  - 任一方先 `game over`，另一方胜
  - 若双方同时结束，按分数高者胜；同分平局

## 4. 数据边界

- `LocalDoubleMode` 全部状态在前端内存完成。
- 不调用 `game-backend` 写接口，不使用 `tetris-db`。
- 不改 SQL、表结构、RLS、排行榜逻辑。

## 5. 回归范围

- `single` 模式进入、游玩、结算路径保持可用。
- `online` 模式房间入口与流程不受影响。
- `local double` 可进入、可控制、垃圾行互发、可结算、可再来一局、可返回主页。
