# 首页登录态战绩面板设计

Date: 2026-02-23  
Status: approved in chat  
Scope: 首页右侧“账号与身份”卡片在登录态改为战绩展示

## 1. 目标

- 当用户是已登录（非匿名）状态时，隐藏登录/注册 Tabs。
- 替换为战绩面板，展示：
  - 修为等级
  - 单机名次
  - 联网名次
  - 联网胜率
- 保留“登出”按钮。
- 匿名状态下保持原登录/注册流程不变。

## 2. 数据方案

- 前端并行拉取：
  - `fetchMyPlayerStats()`
  - `fetchSingleLeaderboard(200)`
  - `fetchOnlineLeaderboard(200)`
- 计算规则：
  - 修为等级：`single_realm_level` + `realmLabel()`
  - 单机名次：在单机榜中按 `user_id` 查 index + 1
  - 联网名次：在联网榜中按 `user_id` 查 index + 1
  - 胜率：`online_wins / online_matches_played`（0 局显示 `0.0%`）

## 3. UI 方案

- 登录态卡片结构：
  1. 身份行（昵称、UID、已登录徽章）
  2. 4 宫格战绩卡（修为、单机名次、联网名次、联网胜率）
  3. 次级信息（单机胜场、联网战绩）
  4. 登出按钮
- 视觉约束：
  - 避免“浅底+浅字”组合
  - 主数值使用高对比度文字（白/亮色）
  - 背景使用深色半透明层，保证可读性

## 4. 边界与回归

- 只改 `src/app/page.tsx`。
- 不改数据库和后端 SQL/RPC。
- 保证 `single / online / local double` 模式入口与流程不受影响。
