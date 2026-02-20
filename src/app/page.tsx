'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import { loadPlayerData, updatePlayerHighScore, updatePlayerTotalLines, type PlayerPosition, type TetrisPlayerData } from '@/lib/tetris-db';

// 方块类型定义
type BlockType = 'I' | 'O' | 'T' | 'S' | 'Z' | 'J' | 'L';

// 方块形状定义
const BLOCK_SHAPES: Record<BlockType, number[][]> = {
  I: [[1, 1, 1, 1]],
  O: [[1, 1], [1, 1]],
  T: [[0, 1, 0], [1, 1, 1]],
  S: [[0, 1, 1], [1, 1, 0]],
  Z: [[1, 1, 0], [0, 1, 1]],
  J: [[1, 0, 0], [1, 1, 1]],
  L: [[0, 0, 1], [1, 1, 1]]
};

// 方块颜色
const BLOCK_COLORS: Record<BlockType, string> = {
  I: '#00f0f0',
  O: '#f0f000',
  T: '#a000f0',
  S: '#00f000',
  Z: '#f00000',
  J: '#0000f0',
  L: '#f0a000'
};

// 游戏区域尺寸
const ROWS = 20;
const COLS = 10;

// 初始化空游戏区域
const createEmptyBoard = () => Array.from({ length: ROWS }, () => Array(COLS).fill(null as string | null));

// 生成随机方块
const getRandomBlock = (): BlockType => {
  const types: BlockType[] = ['I', 'O', 'T', 'S', 'Z', 'J', 'L'];
  return types[Math.floor(Math.random() * types.length)];
};

// 检查碰撞
const checkCollision = (board: (string | null)[][], shape: number[][], row: number, col: number): boolean => {
  for (let r = 0; r < shape.length; r++) {
    for (let c = 0; c < shape[r].length; c++) {
      if (shape[r][c]) {
        const newRow = row + r;
        const newCol = col + c;
        if (newRow < 0 || newRow >= ROWS || newCol < 0 || newCol >= COLS || board[newRow][newCol]) {
          return true;
        }
      }
    }
  }
  return false;
};

// 旋转方块
const rotateShape = (shape: number[][]): number[][] => {
  const rows = shape.length;
  const cols = shape[0].length;
  const rotated: number[][] = Array.from({ length: cols }, () => Array(rows).fill(0));
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      rotated[c][rows - 1 - r] = shape[r][c];
    }
  }
  return rotated;
};

// 游戏玩家状态
interface PlayerState {
  board: (string | null)[][];
  currentBlock: BlockType | null;
  currentShape: number[][];
  currentPos: { row: number; col: number };
  score: number;
  gameOver: boolean;
  nextBlock: BlockType;
}

// 创建初始玩家状态
const createInitialPlayer = (): PlayerState => {
  const block = getRandomBlock();
  const nextBlock = getRandomBlock();
  const shape = BLOCK_SHAPES[block];
  return {
    board: createEmptyBoard(),
    currentBlock: block,
    currentShape: shape,
    currentPos: { row: 0, col: Math.floor(COLS / 2) - Math.floor(shape[0].length / 2) },
    score: 0,
    gameOver: false,
    nextBlock
  };
};

// 固定方块到棋盘
const lockBlock = (board: (string | null)[][], shape: number[][], row: number, col: number, blockType: BlockType): (string | null)[][] => {
  const newBoard = board.map(r => [...r]);
  for (let r = 0; r < shape.length; r++) {
    for (let c = 0; c < shape[r].length; c++) {
      if (shape[r][c]) {
        const newRow = row + r;
        const newCol = col + c;
        if (newRow >= 0 && newRow < ROWS && newCol >= 0 && newCol < COLS) {
          newBoard[newRow][newCol] = BLOCK_COLORS[blockType];
        }
      }
    }
  }
  return newBoard;
};

// 消除完整的行
const clearLines = (board: (string | null)[][]): { newBoard: (string | null)[][], clearedLines: number } => {
  const newBoard = board.filter(row => !row.every(cell => cell !== null));
  const clearedLines = ROWS - newBoard.length;
  
  // 在顶部添加空行
  while (newBoard.length < ROWS) {
    newBoard.unshift(Array(COLS).fill(null));
  }
  
  return { newBoard, clearedLines };
};

// 添加垃圾行
const addGarbageLines = (board: (string | null)[][], count: number): (string | null)[][] => {
  const newBoard = board.map(r => [...r]);
  
  // 移除顶部的行
  const rowsToRemove = Math.min(count, newBoard.length);
  for (let i = 0; i < rowsToRemove; i++) {
    newBoard.shift();
  }
  
  // 亮色调色板
  const brightColors = [
    '#FF6B6B', '#4ECDC4', '#45B7D1', '#96CEB4', 
    '#FFEAA7', '#DDA0DD', '#98D8C8', '#F7DC6F',
    '#BB8FCE', '#85C1E9', '#F8B500', '#00CED1'
  ];
  
  // 在底部添加垃圾行（带空格）
  for (let i = 0; i < count; i++) {
    // 为每行选择一个随机亮色
    const rowColor = brightColors[Math.floor(Math.random() * brightColors.length)];
    const garbageRow: (string | null)[] = Array(COLS).fill(rowColor);
    
    // 随机挖掉2-3个空格
    const holes = Math.floor(Math.random() * 2) + 2;
    for (let j = 0; j < holes; j++) {
      const holeCol = Math.floor(Math.random() * COLS);
      garbageRow[holeCol] = null;
    }
    newBoard.push(garbageRow);
  }
  
  return newBoard;
};

export default function TetrisGame() {
  const [gameMode, setGameMode] = useState<'single' | 'double' | null>(null);
  const [players, setPlayers] = useState<PlayerState[]>([createInitialPlayer(), createInitialPlayer()]);
  const [gameStarted, setGameStarted] = useState(false);
  const [gameSpeed, setGameSpeed] = useState(1000);
  const [startTime, setStartTime] = useState<number>(0);
  const [winner, setWinner] = useState<string | null>(null);
  const [isClient, setIsClient] = useState(false);
  const [musicEnabled, setMusicEnabled] = useState(true);
  const [autoDropEnabled, setAutoDropEnabled] = useState(false);
  
  // 玩家数据（从 Supabase 加载）
  const [playerData, setPlayerData] = useState<Record<PlayerPosition, TetrisPlayerData | null>>({
    left: null,
    right: null
  });
  
  const gameLoopRef = useRef<NodeJS.Timeout | null>(null);
  const speedUpdateRef = useRef<NodeJS.Timeout | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const musicTimeoutRef = useRef<NodeJS.Timeout | null>(null);

  // 确保只在客户端渲染
  useEffect(() => {
    setIsClient(true);
  }, []);

  // 加载玩家数据（游戏开始时）
  useEffect(() => {
    if (gameMode && gameStarted) {
      const loadPlayers = async () => {
        const positions: PlayerPosition[] = gameMode === 'single' ? ['left'] : ['left', 'right'];
        const loadedData: Record<PlayerPosition, TetrisPlayerData | null> = { left: null, right: null };
        
        for (const pos of positions) {
          const data = await loadPlayerData(pos);
          loadedData[pos] = data;
        }
        
        setPlayerData(loadedData);
      };
      
      loadPlayers();
    }
  }, [gameMode, gameStarted]);

  // 音乐系统
  const playNote = useCallback((frequency: number, duration: number, startTime: number, type: OscillatorType = 'sine') => {
    if (!audioContextRef.current || !musicEnabled) return;
    
    const oscillator = audioContextRef.current.createOscillator();
    const gainNode = audioContextRef.current.createGain();
    
    oscillator.type = type;
    oscillator.frequency.setValueAtTime(frequency, startTime);
    
    // 增加音量，让音乐更活泼
    const volume = type === 'triangle' ? 0.12 : 0.08;
    gainNode.gain.setValueAtTime(0, startTime);
    gainNode.gain.linearRampToValueAtTime(volume, startTime + 0.03);
    gainNode.gain.linearRampToValueAtTime(volume * 0.9, startTime + duration * 0.6);
    gainNode.gain.linearRampToValueAtTime(0, startTime + duration);
    
    oscillator.connect(gainNode);
    gainNode.connect(audioContextRef.current.destination);
    
    oscillator.start(startTime);
    oscillator.stop(startTime + duration);
  }, [musicEnabled]);

  const playMelody = useCallback(() => {
    if (!audioContextRef.current || !musicEnabled) return;
    
    const now = audioContextRef.current.currentTime;
    
    // 更欢快的旋律 - 跳跃性更强
    const melodies = [
      [523.25, 659.25, 783.99, 1046.50], // C5 E5 G5 C6 - 高八度
      [587.33, 698.46, 880.00, 1046.50], // D5 F5 A5 C6
      [659.25, 783.99, 987.77, 1174.66], // E5 G5 B5 D6
      [523.25, 587.33, 659.25, 783.99, 880.00, 1046.50], // C5 D5 E5 F5 G5 A5 C6 - 上行音阶
      [1046.50, 987.77, 880.00, 783.99, 659.25, 523.25], // C6 B5 A5 G5 E5 C5 - 下行
      [523.25, 659.25, 783.99, 659.25, 523.25, 659.25], // C5 E5 G5 E5 C5 E5 - 摇摆
      [783.99, 880.00, 1046.50, 880.00, 783.99, 659.25], // G5 A5 C6 A5 G5 E5
      [523.25, 392.00, 523.25, 659.25, 523.25, 783.99], // C5 G4 C5 E5 C5 G5
      [659.25, 523.25, 659.25, 783.99, 659.25, 987.77], // E5 C5 E5 G5 E5 B5
      [523.25, 698.46, 880.00, 1046.50, 880.00, 698.46, 523.25], // C5 F5 A5 C6 A5 F5 C5
    ];
    
    // 随机选择一个旋律
    const melody = melodies[Math.floor(Math.random() * melodies.length)];
    
    // 更快的节奏类型
    const rhythmOptions = [
      [0.15, 0.15, 0.15, 0.15], // 快速四连音
      [0.2, 0.2, 0.2, 0.2, 0.15, 0.15], // 六连音
      [0.1, 0.1, 0.1, 0.2, 0.2], // 快速
      [0.15, 0.15, 0.3, 0.2], // 不规则节奏
    ];
    
    const rhythm = rhythmOptions[Math.floor(Math.random() * rhythmOptions.length)];
    
    let currentTime = now;
    melody.forEach((freq, index) => {
      if (index < rhythm.length) {
        // 主旋律 - 使用 triangle 音色，更明亮
        playNote(freq, rhythm[index], currentTime, 'triangle');
        
        // 添加简单的和弦（低八度）增加丰富度
        if (Math.random() > 0.5) {
          playNote(freq / 2, rhythm[index], currentTime, 'sine');
        }
        currentTime += rhythm[index];
      }
    });
    
    // 安排下一个旋律 - 更短的间隔让音乐更连贯
    const totalDuration = rhythm.reduce((a, b) => a + b, 0);
    musicTimeoutRef.current = setTimeout(playMelody, totalDuration * 1000 + 200);
  }, [musicEnabled, playNote]);

  const startMusic = useCallback(() => {
    if (!audioContextRef.current) {
      audioContextRef.current = new (window.AudioContext || (window as any).webkitAudioContext)();
    }
    if (audioContextRef.current.state === 'suspended') {
      audioContextRef.current.resume();
    }
    playMelody();
  }, [playMelody]);

  const stopMusic = useCallback(() => {
    if (musicTimeoutRef.current) {
      clearTimeout(musicTimeoutRef.current);
      musicTimeoutRef.current = null;
    }
    if (audioContextRef.current) {
      audioContextRef.current.close();
      audioContextRef.current = null;
    }
  }, []);

  // 音乐开关控制
  useEffect(() => {
    if (musicEnabled && gameStarted) {
      startMusic();
    } else {
      stopMusic();
    }
  }, [musicEnabled, gameStarted, startMusic, stopMusic]);

  // 移动方块
  const moveBlock = useCallback((playerIndex: number, direction: 'left' | 'right' | 'down') => {
    setPlayers(prevPlayers => {
      if (!gameStarted || prevPlayers[playerIndex].gameOver) return prevPlayers;
      
      const player = { ...prevPlayers[playerIndex] };
      let newRow = player.currentPos.row;
      let newCol = player.currentPos.col;
      
      switch (direction) {
        case 'left':
          newCol--;
          break;
        case 'right':
          newCol++;
          break;
        case 'down':
          newRow++;
          break;
      }
      
      if (!checkCollision(player.board, player.currentShape, newRow, newCol)) {
        player.currentPos = { row: newRow, col: newCol };
      } else if (direction === 'down') {
        // 到底了，固定方块
        player.board = lockBlock(player.board, player.currentShape, player.currentPos.row, player.currentPos.col, player.currentBlock!);
        
        // 消除行
        const { newBoard, clearedLines } = clearLines(player.board);
        player.board = newBoard;
        player.score += clearedLines * 100;
        
        // 如果消掉2行及以上，发送垃圾行给对方（仅双人模式）
        if (clearedLines >= 2 && gameMode === 'double' && prevPlayers[1]) {
          const opponentIndex = playerIndex === 0 ? 1 : 0;
          const opponent = { ...prevPlayers[opponentIndex] };
          opponent.board = addGarbageLines(opponent.board, clearedLines);
          
          const newPlayers = [...prevPlayers];
          newPlayers[opponentIndex] = opponent;
          newPlayers[playerIndex] = player;
          
          // 生成新方块
          const nextBlock = player.nextBlock;
          player.currentBlock = nextBlock;
          player.currentShape = BLOCK_SHAPES[nextBlock];
          player.nextBlock = getRandomBlock();
          
          // 检查新方块是否可以放置
          if (checkCollision(player.board, player.currentShape, 0, Math.floor(COLS / 2) - Math.floor(player.currentShape[0].length / 2))) {
            player.gameOver = true;
          } else {
            player.currentPos = { row: 0, col: Math.floor(COLS / 2) - Math.floor(player.currentShape[0].length / 2) };
          }
          
          newPlayers[playerIndex] = player;
          return newPlayers;
        }
        
        // 生成新方块
        const nextBlock = player.nextBlock;
        player.currentBlock = nextBlock;
        player.currentShape = BLOCK_SHAPES[nextBlock];
        player.nextBlock = getRandomBlock();
        
        // 检查新方块是否可以放置
        if (checkCollision(player.board, player.currentShape, 0, Math.floor(COLS / 2) - Math.floor(player.currentShape[0].length / 2))) {
          player.gameOver = true;
        } else {
          player.currentPos = { row: 0, col: Math.floor(COLS / 2) - Math.floor(player.currentShape[0].length / 2) };
        }
      }
      
      const newPlayers = [...prevPlayers];
      newPlayers[playerIndex] = player;
      return newPlayers;
    });
  }, [gameStarted]);

  // 旋转方块
  const rotateBlock = useCallback((playerIndex: number) => {
    setPlayers(prevPlayers => {
      if (!gameStarted || prevPlayers[playerIndex].gameOver) return prevPlayers;
      
      const player = { ...prevPlayers[playerIndex] };
      const rotated = rotateShape(player.currentShape);
      
      if (!checkCollision(player.board, rotated, player.currentPos.row, player.currentPos.col)) {
        player.currentShape = rotated;
      }
      
      const newPlayers = [...prevPlayers];
      newPlayers[playerIndex] = player;
      return newPlayers;
    });
  }, [gameStarted]);

  // 键盘事件处理
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (!gameStarted) return;
      
      // 左玩家控制：W-旋转，A-左，S-下，D-右
      if (e.key === 'a' || e.key === 'A') {
        moveBlock(0, 'left');
      } else if (e.key === 'd' || e.key === 'D') {
        moveBlock(0, 'right');
      } else if (e.key === 's' || e.key === 'S') {
        moveBlock(0, 'down');
      } else if (e.key === 'w' || e.key === 'W') {
        rotateBlock(0);
      }
      
      // 右玩家控制：小键盘方向键（仅在双人模式下有效）
      if (gameMode === 'double') {
        if (e.key === 'ArrowLeft') {
          e.preventDefault();
          moveBlock(1, 'left');
        } else if (e.key === 'ArrowRight') {
          e.preventDefault();
          moveBlock(1, 'right');
        } else if (e.key === 'ArrowDown') {
          e.preventDefault();
          moveBlock(1, 'down');
        } else if (e.key === 'ArrowUp') {
          e.preventDefault();
          rotateBlock(1);
        }
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [gameStarted, moveBlock, rotateBlock, gameMode]);

  // 游戏主循环
  useEffect(() => {
    if (!gameStarted) {
      if (gameLoopRef.current) {
        clearInterval(gameLoopRef.current);
        gameLoopRef.current = null;
      }
      if (speedUpdateRef.current) {
        clearInterval(speedUpdateRef.current);
        speedUpdateRef.current = null;
      }
      return;
    }

    // 单人模式且自动下落关闭时，不启动游戏循环
    if (gameMode === 'single' && !autoDropEnabled) {
      if (gameLoopRef.current) {
        clearInterval(gameLoopRef.current);
        gameLoopRef.current = null;
      }
      if (speedUpdateRef.current) {
        clearInterval(speedUpdateRef.current);
        speedUpdateRef.current = null;
      }
      return;
    }

    // 主游戏循环 - 自动下落
    gameLoopRef.current = setInterval(() => {
      setPlayers(prevPlayers => {
        // 先处理每个玩家的下落和行消除
        let garbageLinesToSend: Array<{ playerIndex: number; count: number }> = [];
        
        const tempPlayers = prevPlayers.map((player, index) => {
          if (player.gameOver) return player;
          
          const newPlayer = { ...player };
          const newRow = newPlayer.currentPos.row + 1;
          
          if (!checkCollision(newPlayer.board, newPlayer.currentShape, newRow, newPlayer.currentPos.col)) {
            newPlayer.currentPos.row = newRow;
            return newPlayer;
          }
          
          // 固定方块
          newPlayer.board = lockBlock(newPlayer.board, newPlayer.currentShape, newPlayer.currentPos.row, newPlayer.currentPos.col, newPlayer.currentBlock!);
          
          // 消除行
          const { newBoard, clearedLines } = clearLines(newPlayer.board);
          newPlayer.board = newBoard;
          newPlayer.score += clearedLines * 100;
          
          // 如果消掉2行及以上，记录需要发送的垃圾行（仅双人模式）
          if (clearedLines >= 2 && gameMode === 'double') {
            garbageLinesToSend.push({ playerIndex: index, count: clearedLines });
          }
          
          // 生成新方块
          const nextBlock = newPlayer.nextBlock;
          newPlayer.currentBlock = nextBlock;
          newPlayer.currentShape = BLOCK_SHAPES[nextBlock];
          newPlayer.nextBlock = getRandomBlock();
          
          // 检查新方块是否可以放置
          if (checkCollision(newPlayer.board, newPlayer.currentShape, 0, Math.floor(COLS / 2) - Math.floor(newPlayer.currentShape[0].length / 2))) {
            newPlayer.gameOver = true;
          } else {
            newPlayer.currentPos = { row: 0, col: Math.floor(COLS / 2) - Math.floor(newPlayer.currentShape[0].length / 2) };
          }
          
          return newPlayer;
        });
        
        // 处理垃圾行发送（仅双人模式）
        garbageLinesToSend.forEach(({ playerIndex, count }) => {
          const opponentIndex = playerIndex === 0 ? 1 : 0;
          if (tempPlayers[opponentIndex]) {
            tempPlayers[opponentIndex] = {
              ...tempPlayers[opponentIndex],
              board: addGarbageLines(tempPlayers[opponentIndex].board, count)
            };
          }
        });
        
        return tempPlayers;
      });
    }, gameSpeed);

    // 速度更新循环 - 仅在双人模式下每60秒提速10%
    if (gameMode === 'double') {
      speedUpdateRef.current = setInterval(() => {
        setGameSpeed(prev => Math.max(100, Math.floor(prev * 0.9)));
      }, 60000);
    }

    return () => {
      if (gameLoopRef.current) clearInterval(gameLoopRef.current);
      if (speedUpdateRef.current) clearInterval(speedUpdateRef.current);
    };
  }, [gameStarted, gameSpeed, gameMode, autoDropEnabled]);

  // 检查游戏结束
  useEffect(() => {
    if (gameMode === 'single') {
      // 单人模式：第一个玩家游戏结束
      if (players[0] && players[0].gameOver) {
        setGameStarted(false);
        setWinner(`游戏结束！得分: ${players[0].score}`);
        
        // 更新玩家数据
        const updateData = async () => {
          // 更新最高分
          await updatePlayerHighScore('left', players[0].score);
          
          // 计算本次消除的行数（分数 / 100）
          const linesCleared = Math.floor(players[0].score / 100);
          if (linesCleared > 0) {
            await updatePlayerTotalLines('left', linesCleared);
          }
        };
        updateData();
        
        // 停止音乐
        if (musicTimeoutRef.current) {
          clearTimeout(musicTimeoutRef.current);
          musicTimeoutRef.current = null;
        }
        if (audioContextRef.current) {
          audioContextRef.current.close();
          audioContextRef.current = null;
        }
      }
    } else {
      // 双人模式
      if (players[0]?.gameOver || players[1]?.gameOver) {
        setGameStarted(false);
        
        // 更新玩家数据
        const updateData = async () => {
          // 更新左玩家数据
          if (players[0]) {
            await updatePlayerHighScore('left', players[0].score);
            const linesClearedLeft = Math.floor(players[0].score / 100);
            if (linesClearedLeft > 0) {
              await updatePlayerTotalLines('left', linesClearedLeft);
            }
          }
          
          // 更新右玩家数据
          if (players[1]) {
            await updatePlayerHighScore('right', players[1].score);
            const linesClearedRight = Math.floor(players[1].score / 100);
            if (linesClearedRight > 0) {
              await updatePlayerTotalLines('right', linesClearedRight);
            }
          }
        };
        updateData();
        
        // 停止音乐
        if (musicTimeoutRef.current) {
          clearTimeout(musicTimeoutRef.current);
          musicTimeoutRef.current = null;
        }
        if (audioContextRef.current) {
          audioContextRef.current.close();
          audioContextRef.current = null;
        }
        if (players[0]?.gameOver && !players[1]?.gameOver) {
          setWinner('右玩家获胜！');
        } else if (!players[0]?.gameOver && players[1]?.gameOver) {
          setWinner('左玩家获胜！');
        } else if (players[0]?.gameOver && players[1]?.gameOver) {
          setWinner(players[0].score > players[1].score ? '左玩家获胜！' : '右玩家获胜！');
        }
      }
    }
  }, [players, gameMode]);

  // 开始游戏
  const startGame = () => {
    if (gameMode === 'single') {
      setPlayers([createInitialPlayer()]);
    } else {
      setPlayers([createInitialPlayer(), createInitialPlayer()]);
    }
    setGameStarted(true);
    setGameSpeed(1000);
    setStartTime(Date.now());
    setWinner(null);
    if (musicEnabled) {
      startMusic();
    }
  };

  // 渲染游戏区域
  const renderBoard = (player: PlayerState, playerIndex: number) => {
    const board = player.board.map(row => [...row]);
    
    // 将当前方块渲染到棋盘上（用于显示）
    if (player.currentBlock && !player.gameOver) {
      for (let r = 0; r < player.currentShape.length; r++) {
        for (let c = 0; c < player.currentShape[r].length; c++) {
          if (player.currentShape[r][c]) {
            const boardRow = player.currentPos.row + r;
            const boardCol = player.currentPos.col + c;
            if (boardRow >= 0 && boardRow < ROWS && boardCol >= 0 && boardCol < COLS) {
              board[boardRow][boardCol] = BLOCK_COLORS[player.currentBlock];
            }
          }
        }
      }
    }
    
    return (
      <div className="relative bg-gray-900 border-4 border-gray-700 rounded-lg p-2">
        {board.map((row, rowIndex) => (
          <div key={rowIndex} className="flex">
            {row.map((cell, colIndex) => (
              <div
                key={colIndex}
                className="w-6 h-6 border border-gray-800"
                style={{
                  backgroundColor: cell ? (typeof cell === 'string' ? cell : '#808080') : 'transparent',
                }}
              />
            ))}
          </div>
        ))}
        {player.gameOver && (
          <div className="absolute inset-0 bg-black bg-opacity-70 flex items-center justify-center">
            <div className="text-white text-2xl font-bold">游戏结束</div>
          </div>
        )}
      </div>
    );
  };

  // 渲染下一个方块
  const renderNextBlock = (blockType: BlockType) => {
    const shape = BLOCK_SHAPES[blockType];
    const color = BLOCK_COLORS[blockType];
    
    return (
      <div className="bg-gray-900 border-2 border-gray-700 rounded-lg p-4">
        <div className="text-white text-sm mb-2">下一个</div>
        <div className="flex flex-col items-center justify-center">
          {shape.map((row, rowIndex) => (
            <div key={rowIndex} className="flex">
              {row.map((cell, colIndex) => (
                <div
                  key={colIndex}
                  className="w-6 h-6 border border-gray-800"
                  style={{
                    backgroundColor: cell ? color : 'transparent',
                  }}
                />
              ))}
            </div>
          ))}
        </div>
      </div>
    );
  };

  return (
    <div className="min-h-screen bg-gradient-to-br from-gray-900 via-purple-900 to-gray-900 p-4 flex flex-col items-center justify-center">
      {!isClient ? (
        <div className="text-white text-xl">加载中...</div>
      ) : (
        <>
      <div className="text-center mb-6">
        <h1 className="text-4xl font-bold text-white mb-2">俄罗斯方块</h1>
        
        {/* 模式选择 */}
        {!gameMode && !gameStarted && !winner && (
          <div className="space-y-4 mt-6">
            <div className="flex items-center justify-center gap-4 mb-4">
              <button
                onClick={() => setMusicEnabled(!musicEnabled)}
                className={`px-4 py-2 rounded-lg font-bold transition-colors ${
                  musicEnabled 
                    ? 'bg-purple-500 hover:bg-purple-600 text-white' 
                    : 'bg-gray-600 hover:bg-gray-700 text-white'
                }`}
              >
                {musicEnabled ? '🎵 音乐开' : '🔇 音乐关'}
              </button>
            </div>
            <h2 className="text-white text-2xl font-bold mb-4">选择游戏模式</h2>
            <div className="flex gap-6 justify-center">
              <button
                onClick={() => setGameMode('single')}
                className="bg-blue-500 hover:bg-blue-600 text-white font-bold py-4 px-8 rounded-lg text-xl transition-colors shadow-lg"
              >
                👤 单人模式
              </button>
              <button
                onClick={() => setGameMode('double')}
                className="bg-orange-500 hover:bg-orange-600 text-white font-bold py-4 px-8 rounded-lg text-xl transition-colors shadow-lg"
              >
                👥 双人模式
              </button>
            </div>
          </div>
        )}
        
        {/* 音乐开关（在选择模式后显示） */}
        {gameMode && !gameStarted && !winner && (
          <div className="flex items-center justify-center gap-4 mb-4">
            <button
              onClick={() => setMusicEnabled(!musicEnabled)}
              className={`px-4 py-2 rounded-lg font-bold transition-colors ${
                musicEnabled 
                  ? 'bg-purple-500 hover:bg-purple-600 text-white' 
                  : 'bg-gray-600 hover:bg-gray-700 text-white'
              }`}
            >
              {musicEnabled ? '🎵 音乐开' : '🔇 音乐关'}
            </button>
            <button
              onClick={() => setGameMode(null)}
              className="bg-gray-500 hover:bg-gray-600 text-white font-bold py-2 px-4 rounded-lg transition-colors"
            >
              返回
            </button>
          </div>
        )}
        
        {gameMode && !gameStarted && !winner && (
          <button
            onClick={startGame}
            className="bg-green-500 hover:bg-green-600 text-white font-bold py-3 px-8 rounded-lg text-xl transition-colors"
          >
            开始游戏
          </button>
        )}
        {winner && (
          <div className="text-white text-2xl mb-4">
            <span className="font-bold">{winner}</span>
            <button
              onClick={startGame}
              className="ml-4 bg-green-500 hover:bg-green-600 text-white font-bold py-2 px-6 rounded-lg text-lg transition-colors"
            >
              再来一局
            </button>
            <button
              onClick={() => setGameMode(null)}
              className="ml-4 bg-gray-500 hover:bg-gray-600 text-white font-bold py-2 px-6 rounded-lg text-lg transition-colors"
            >
              返回主菜单
            </button>
          </div>
        )}
      </div>

      {/* 游戏说明 - 只在选择模式后显示 */}
      {gameMode && !gameStarted && !winner && (
        <div className="bg-gray-800 bg-opacity-80 rounded-lg p-6 mb-6 max-w-4xl">
          <h2 className="text-white text-xl font-bold mb-4">游戏说明</h2>
          <div className="grid grid-cols-2 gap-8 text-gray-300">
            <div>
              <h3 className="font-bold mb-2">左玩家控制</h3>
              <ul className="space-y-1">
                <li><span className="inline-block bg-gray-700 px-2 py-1 rounded mr-2">W</span> 旋转</li>
                <li><span className="inline-block bg-gray-700 px-2 py-1 rounded mr-2">A</span> 向左</li>
                <li><span className="inline-block bg-gray-700 px-2 py-1 rounded mr-2">S</span> 向下</li>
                <li><span className="inline-block bg-gray-700 px-2 py-1 rounded mr-2">D</span> 向右</li>
              </ul>
            </div>
            {gameMode === 'double' && (
              <div>
                <h3 className="font-bold mb-2">右玩家控制（小键盘）</h3>
                <ul className="space-y-1">
                  <li><span className="inline-block bg-gray-700 px-2 py-1 rounded mr-2">↑</span> 旋转</li>
                  <li><span className="inline-block bg-gray-700 px-2 py-1 rounded mr-2">←</span> 向左</li>
                  <li><span className="inline-block bg-gray-700 px-2 py-1 rounded mr-2">↓</span> 向下</li>
                  <li><span className="inline-block bg-gray-700 px-2 py-1 rounded mr-2">→</span> 向右</li>
                </ul>
              </div>
            )}
          </div>
          <div className="mt-4 text-yellow-400">
            <p>⚡ {gameMode === 'double' ? '一次性消除2行及以上，将相应数量的垃圾行发送到对方底部！' : '消除行获得分数！'}</p>
            <p>⚡ {gameMode === 'double' ? '初始速度：1秒/格，每60秒速度提升10%' : '速度固定：1秒/格'}</p>
          </div>
        </div>
      )}

      {/* 游戏区域 */}
      {gameMode === 'double' ? (
        <div className="flex gap-8 items-start">
          {/* 左玩家 */}
          <div className="flex flex-col items-center">
            <h2 className="text-white text-2xl font-bold mb-4">左玩家</h2>
            <div className="flex gap-4">
              {players[0] && renderBoard(players[0], 0)}
              <div className="flex flex-col gap-4">
                {players[0] && renderNextBlock(players[0].nextBlock)}
                <div className="bg-gray-900 border-2 border-gray-700 rounded-lg p-4">
                  <div className="text-white text-sm mb-2">分数</div>
                  <div className="text-white text-2xl font-bold">{players[0]?.score || 0}</div>
                </div>
                <div className="bg-gray-900 border-2 border-gray-700 rounded-lg p-4">
                  <div className="text-white text-sm mb-2">最高分</div>
                  <div className="text-yellow-400 text-2xl font-bold">{playerData.left?.high_score || 0}</div>
                </div>
                <div className="bg-gray-900 border-2 border-gray-700 rounded-lg p-4">
                  <div className="text-white text-sm mb-2">总消除行数</div>
                  <div className="text-green-400 text-2xl font-bold">{playerData.left?.total_lines_cleared || 0}</div>
                </div>
              </div>
            </div>
          </div>

          {/* 右玩家 */}
          <div className="flex flex-col items-center">
            <h2 className="text-white text-2xl font-bold mb-4">右玩家</h2>
            <div className="flex gap-4">
              {players[1] && renderBoard(players[1], 1)}
              <div className="flex flex-col gap-4">
                {players[1] && renderNextBlock(players[1].nextBlock)}
                <div className="bg-gray-900 border-2 border-gray-700 rounded-lg p-4">
                  <div className="text-white text-sm mb-2">分数</div>
                  <div className="text-white text-2xl font-bold">{players[1]?.score || 0}</div>
                </div>
                <div className="bg-gray-900 border-2 border-gray-700 rounded-lg p-4">
                  <div className="text-white text-sm mb-2">最高分</div>
                  <div className="text-yellow-400 text-2xl font-bold">{playerData.right?.high_score || 0}</div>
                </div>
                <div className="bg-gray-900 border-2 border-gray-700 rounded-lg p-4">
                  <div className="text-white text-sm mb-2">总消除行数</div>
                  <div className="text-green-400 text-2xl font-bold">{playerData.right?.total_lines_cleared || 0}</div>
                </div>
              </div>
            </div>
          </div>
        </div>
      ) : (
        /* 单人模式 */
        <div className="flex items-center justify-center">
          <div className="flex flex-col items-center">
            <div className="flex items-center gap-4 mb-4">
              <h2 className="text-white text-2xl font-bold">单人游戏</h2>
              <button
                onClick={() => setAutoDropEnabled(!autoDropEnabled)}
                className={`px-3 py-1 rounded text-sm font-bold transition-colors ${
                  autoDropEnabled 
                    ? 'bg-yellow-500 hover:bg-yellow-600 text-white' 
                    : 'bg-gray-600 hover:bg-gray-700 text-gray-300'
                }`}
              >
                {autoDropEnabled ? '⏬ 自动下开' : '⏸️ 自动下关'}
              </button>
            </div>
            <div className="flex gap-4">
              {players[0] && renderBoard(players[0], 0)}
              <div className="flex flex-col gap-4">
                {players[0] && renderNextBlock(players[0].nextBlock)}
                <div className="bg-gray-900 border-2 border-gray-700 rounded-lg p-4">
                  <div className="text-white text-sm mb-2">分数</div>
                  <div className="text-white text-2xl font-bold">{players[0]?.score || 0}</div>
                </div>
                <div className="bg-gray-900 border-2 border-gray-700 rounded-lg p-4">
                  <div className="text-white text-sm mb-2">最高分</div>
                  <div className="text-yellow-400 text-2xl font-bold">{playerData.left?.high_score || 0}</div>
                </div>
                <div className="bg-gray-900 border-2 border-gray-700 rounded-lg p-4">
                  <div className="text-white text-sm mb-2">总消除行数</div>
                  <div className="text-green-400 text-2xl font-bold">{playerData.left?.total_lines_cleared || 0}</div>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* 速度显示 */}
      {gameStarted && (
        <div className="mt-6 text-gray-300">
          {gameMode === 'double' ? `当前速度：${(1000 / gameSpeed).toFixed(2)} 格/秒` : '速度固定：1.00 格/秒'}
        </div>
      )}
        </>
      )}
    </div>
  );
}
