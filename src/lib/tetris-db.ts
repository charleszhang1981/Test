import { getSupabaseClient } from '@/lib/supabase-client';

// 玩家位置类型
export type PlayerPosition = 'left' | 'right';

// 玩家数据接口
export interface TetrisPlayerData {
  id: string;
  position: PlayerPosition;
  player_name: string;
  high_score: number;
  total_lines_cleared: number;
  created_at: string;
  updated_at: string | null;
}

// 加载玩家数据
export async function loadPlayerData(position: PlayerPosition): Promise<TetrisPlayerData | null> {
  const client = getSupabaseClient();
  
  const { data, error } = await client
    .from('tetris_players')
    .select('*')
    .eq('position', position)
    .single();
  
  if (error) {
    console.error('加载玩家数据失败:', error.message);
    return null;
  }
  
  return data;
}

// 更新玩家最高分
export async function updatePlayerHighScore(position: PlayerPosition, score: number): Promise<boolean> {
  const client = getSupabaseClient();
  
  // 先获取当前最高分
  const { data: currentData, error: fetchError } = await client
    .from('tetris_players')
    .select('high_score')
    .eq('position', position)
    .single();
  
  if (fetchError) {
    console.error('获取当前最高分失败:', fetchError.message);
    return false;
  }
  
  // 只有新分数更高时才更新
  if (score > currentData.high_score) {
    const { error } = await client
      .from('tetris_players')
      .update({ 
        high_score: score,
        updated_at: new Date().toISOString()
      })
      .eq('position', position);
    
    if (error) {
      console.error('更新最高分失败:', error.message);
      return false;
    }
    
    return true;
  }
  
  return false;
}

// 更新玩家总消除行数
export async function updatePlayerTotalLines(position: PlayerPosition, linesCleared: number): Promise<boolean> {
  const client = getSupabaseClient();
  
  // 先获取当前总行数
  const { data: currentData, error: fetchError } = await client
    .from('tetris_players')
    .select('total_lines_cleared')
    .eq('position', position)
    .single();
  
  if (fetchError) {
    console.error('获取当前总行数失败:', fetchError.message);
    return false;
  }
  
  // 更新总行数
  const newTotal = currentData.total_lines_cleared + linesCleared;
  const { error } = await client
    .from('tetris_players')
    .update({ 
      total_lines_cleared: newTotal,
      updated_at: new Date().toISOString()
    })
    .eq('position', position);
  
  if (error) {
    console.error('更新总消除行数失败:', error.message);
    return false;
  }
  
  return true;
}

// 加载所有玩家数据
export async function loadAllPlayersData(): Promise<Record<PlayerPosition, TetrisPlayerData | null>> {
  const [leftPlayer, rightPlayer] = await Promise.all([
    loadPlayerData('left'),
    loadPlayerData('right')
  ]);
  
  return {
    left: leftPlayer,
    right: rightPlayer
  };
}
