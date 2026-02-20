import { createClient } from '@supabase/supabase-js';

// 从环境变量读取配置
const url = 'https://awahroucwafpkekzfjyh.supabase.co';
const anonKey = 'sb_publishable_oGN6V-Kmq3KfaKihn-rSJQ_RNs9fJl4';

console.log('🔍 正在测试 Supabase 连接...');
console.log('📍 URL:', url);
console.log('🔑 Key:', anonKey.substring(0, 20) + '...');

// 创建客户端
const client = createClient(url, anonKey, {
  db: { timeout: 10000 },
  auth: { autoRefreshToken: false, persistSession: false }
});

async function testConnection() {
  try {
    console.log('\n📊 尝试读取 tetris_players 表...');
    
    const { data, error } = await client
      .from('tetris_players')
      .select('*')
      .order('position');
    
    if (error) {
      console.error('❌ 读取失败:', error.message);
      console.error('错误详情:', error);
      return false;
    }
    
    console.log('✅ 连接成功！');
    console.log('\n📋 玩家数据:');
    console.log(JSON.stringify(data, null, 2));
    
    if (data && data.length > 0) {
      console.log('\n🎮 数据预览:');
      data.forEach(player => {
        console.log(`  ${player.position === 'left' ? '⬅️ 左玩家' : '➡️ 右玩家'}`);
        console.log(`    最高分: ${player.high_score}`);
        console.log(`    总消除行数: ${player.total_lines_cleared}`);
      });
    } else {
      console.log('\n⚠️  表中没有数据，请确保已执行 tetris-setup.sql 脚本');
    }
    
    return true;
  } catch (err) {
    console.error('❌ 发生错误:', err.message);
    return false;
  }
}

testConnection()
  .then(success => {
    console.log('\n' + '='.repeat(50));
    console.log(success ? '✅ 测试通过！' : '❌ 测试失败！');
    console.log('='.repeat(50));
  })
  .catch(err => {
    console.error('❌ 测试异常:', err);
  });
