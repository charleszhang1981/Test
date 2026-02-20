-- ============================================
-- 俄罗斯方块游戏 - 数据库初始化脚本
-- ============================================
-- 说明：
-- 1. 先执行建表语句（CREATE TABLE）
-- 2. 再执行插入语句（INSERT）
-- ============================================

-- 1. 创建玩家表
CREATE TABLE IF NOT EXISTS tetris_players (
    id VARCHAR(36) PRIMARY KEY DEFAULT gen_random_uuid(),
    position VARCHAR(10) NOT NULL UNIQUE, -- 'left' 或 'right'
    player_name VARCHAR(100), -- 玩家名称
    high_score INTEGER NOT NULL DEFAULT 0, -- 最高分
    total_lines_cleared INTEGER NOT NULL DEFAULT 0, -- 总消除行数
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE
);


-- 2. 插入左侧玩家
INSERT INTO tetris_players (position, player_name, high_score, total_lines_cleared)
VALUES ('left', '左侧玩家', 0, 0)
ON CONFLICT (position) DO NOTHING;

-- 3. 插入右侧玩家
INSERT INTO tetris_players (position, player_name, high_score, total_lines_cleared)
VALUES ('right', '右侧玩家', 0, 0)
ON CONFLICT (position) DO NOTHING;

-- 4. 验证数据（可选）
SELECT * FROM tetris_players;

-- ============================================
-- 执行完成后，你应该看到两条记录：
-- | id | position | player_name | high_score | total_lines_cleared | created_at | updated_at |
-- |----|----------|-------------|------------|---------------------|------------|------------|
-- | xxx | left     | 左侧玩家    | 0          | 0                   | xxx        | NULL       |
-- | xxx | right    | 右侧玩家    | 0          | 0                   | xxx        | NULL       |
-- ============================================
