
'use client';

import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Session } from '@supabase/supabase-js';
import {
  Copy,
  Gauge,
  Gamepad2,
  LogOut,
  Rocket,
  Swords,
  Trophy,
  User,
  UserRoundPlus,
  Users,
  Wifi,
} from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import {
  clearDisconnectDeadline,
  createMatchChannel,
  createMatchRoom,
  ensureAnonymousSession,
  fetchLatestSnapshot,
  fetchMatchById,
  fetchMyProfile,
  fetchMyPlayerStats,
  finishMatch,
  insertSnapshot,
  joinMatchRoom,
  markProfileRegistered,
  onAuthStateChange,
  registerOrUpgrade,
  setDisconnectDeadline,
  setMatchReady,
  signInWithPassword,
  signOutAndReturnAnonymous,
  submitSingleAiResult,
  type MatchRow,
  type ProfileRow,
} from '@/lib/game-backend';
import {
  applyPendingGarbage,
  BLOCK_COLORS,
  BLOCK_SHAPES,
  checkCollision,
  clearLines,
  COLS,
  createEmptyBoard,
  createInitialState,
  createPieceGenerator,
  lockBlock,
  moveHorizontal,
  rotateShape,
  rotateCurrent,
  ROWS,
  stepDown,
  type BlockType,
  type BoardCell,
  type PieceGenerator,
  type PlayerGameState,
  withActivePiece,
} from '@/lib/tetris-core';
import { getSupabaseClient } from '@/lib/supabase-client';

type Mode = 'menu' | 'single' | 'online';
type OnlinePhase = 'idle' | 'lobby' | 'playing' | 'ended';

interface MatchStartedEvent {
  matchId: string;
  seed: number;
  startAt: number;
  hostId: string;
  guestId: string | null;
}

interface PieceLockedEvent {
  matchId: string;
  playerId: string;
  seq: number;
  boardFixed: BoardCell[][];
  score: number;
  linesClearedTotal: number;
  sentGarbage: number;
  gameOver: boolean;
}

interface GarbageSentEvent {
  matchId: string;
  fromPlayerId: string;
  toPlayerId: string;
  seq: number;
  count: number;
}

interface ResyncRequestEvent {
  matchId: string;
  requesterId: string;
}

interface ResyncStateEvent {
  matchId: string;
  playerId: string;
  seq: number;
  boardFixed: BoardCell[][];
  score: number;
  pendingGarbage: number;
  gameOver: boolean;
}

interface HeartbeatEvent {
  matchId: string;
  playerId: string;
  ts: number;
}

interface GameOverEvent {
  matchId: string;
  loserId: string;
  winnerId: string;
  reason: 'normal' | 'disconnect_timeout' | 'forfeit';
}

interface RematchReadyEvent {
  matchId: string;
  playerId: string;
  ready: boolean;
}

interface RematchRoomEvent {
  oldMatchId: string;
  newMatchId: string;
  roomCode: string;
  hostId: string;
  guestId: string | null;
}

const toBoard = (value: unknown): BoardCell[][] => {
  if (!Array.isArray(value)) {
    return createEmptyBoard();
  }

  const rows = value.slice(0, ROWS).map((row) => {
    if (!Array.isArray(row)) {
      return Array(COLS).fill(null) as BoardCell[];
    }
    return row.slice(0, COLS).map((cell) => {
      if (typeof cell === 'string') {
        return cell;
      }
      return null;
    });
  });

  while (rows.length < ROWS) {
    rows.unshift(Array(COLS).fill(null));
  }

  return rows as BoardCell[][];
};

const randomSeed = (): number => Math.floor(Math.random() * 2_147_483_647);

const REALM_NAMES = [
  '炼气期',
  '筑基期',
  '结丹期',
  '元婴期',
  '化神期',
  '炼虚期',
  '合体期',
  '大乘期',
] as const;

interface RealmDifficulty {
  gravityMs: number;
  aiTickMs: number;
  aiLineChance: number;
  aiMultiLineBias: number;
  aiMistakeChance: number;
}

const REALM_DIFFICULTIES: RealmDifficulty[] = [
  { gravityMs: 900, aiTickMs: 900, aiLineChance: 0.35, aiMultiLineBias: 0.1, aiMistakeChance: 0.22 },
  { gravityMs: 820, aiTickMs: 820, aiLineChance: 0.42, aiMultiLineBias: 0.16, aiMistakeChance: 0.18 },
  { gravityMs: 720, aiTickMs: 730, aiLineChance: 0.52, aiMultiLineBias: 0.26, aiMistakeChance: 0.12 },
  { gravityMs: 620, aiTickMs: 660, aiLineChance: 0.6, aiMultiLineBias: 0.34, aiMistakeChance: 0.09 },
  { gravityMs: 540, aiTickMs: 600, aiLineChance: 0.68, aiMultiLineBias: 0.42, aiMistakeChance: 0.07 },
  { gravityMs: 470, aiTickMs: 550, aiLineChance: 0.74, aiMultiLineBias: 0.5, aiMistakeChance: 0.05 },
  { gravityMs: 410, aiTickMs: 500, aiLineChance: 0.8, aiMultiLineBias: 0.58, aiMistakeChance: 0.04 },
  { gravityMs: 360, aiTickMs: 450, aiLineChance: 0.86, aiMultiLineBias: 0.66, aiMistakeChance: 0.03 },
];

const clampRealmLevel = (value: number | null | undefined): number => {
  if (!value || Number.isNaN(value)) {
    return 1;
  }
  return Math.min(8, Math.max(1, Math.floor(value)));
};

const realmLabel = (level: number): string => REALM_NAMES[clampRealmLevel(level) - 1];

interface AiPlan {
  targetCol: number;
  targetShape: number[][];
}

interface AiCandidate {
  targetCol: number;
  targetShape: number[][];
  score: number;
}

const shapeKey = (shape: number[][]): string =>
  shape.map((row) => row.join('')).join('|');

const getUniqueRotations = (shape: number[][]): number[][][] => {
  const result: number[][][] = [];
  const seen = new Set<string>();
  let current = shape;

  for (let i = 0; i < 4; i++) {
    const key = shapeKey(current);
    if (!seen.has(key)) {
      result.push(current);
      seen.add(key);
    }
    current = rotateShape(current);
  }

  return result;
};

const countHoles = (board: BoardCell[][]): number => {
  let holes = 0;
  for (let c = 0; c < COLS; c++) {
    let seenBlock = false;
    for (let r = 0; r < ROWS; r++) {
      if (board[r][c] !== null) {
        seenBlock = true;
      } else if (seenBlock) {
        holes += 1;
      }
    }
  }
  return holes;
};

const getColumnHeights = (board: BoardCell[][]): number[] => {
  const heights: number[] = [];
  for (let c = 0; c < COLS; c++) {
    let height = 0;
    for (let r = 0; r < ROWS; r++) {
      if (board[r][c] !== null) {
        height = ROWS - r;
        break;
      }
    }
    heights.push(height);
  }
  return heights;
};

const getBumpiness = (heights: number[]): number => {
  let bumpiness = 0;
  for (let i = 0; i < heights.length - 1; i++) {
    bumpiness += Math.abs(heights[i] - heights[i + 1]);
  }
  return bumpiness;
};

const findDropRow = (
  board: BoardCell[][],
  shape: number[][],
  startRow: number,
  col: number,
): number | null => {
  if (checkCollision(board, shape, startRow, col)) {
    return null;
  }

  let row = startRow;
  while (!checkCollision(board, shape, row + 1, col)) {
    row += 1;
  }
  return row;
};

const evaluateAiBoard = (
  board: BoardCell[][],
  clearedLines: number,
  difficulty: RealmDifficulty,
): number => {
  const heights = getColumnHeights(board);
  const holes = countHoles(board);
  const aggregateHeight = heights.reduce((sum, h) => sum + h, 0);
  const maxHeight = Math.max(...heights);
  const bumpiness = getBumpiness(heights);

  const clearReward =
    clearedLines * (180 + difficulty.aiMultiLineBias * 240) +
    (clearedLines >= 2 ? 70 : 0);
  const penalties =
    holes * 18 +
    aggregateHeight * 0.55 +
    maxHeight * (2.4 - difficulty.aiLineChance) +
    bumpiness * 3.4;

  return clearReward - penalties + Math.random() * 1.2;
};

const buildAiPlan = (
  state: PlayerGameState,
  difficulty: RealmDifficulty,
): AiPlan | null => {
  const rotations = getUniqueRotations(state.currentShape);
  const candidates: AiCandidate[] = [];

  for (const shape of rotations) {
    for (let col = -4; col < COLS + 4; col++) {
      const dropRow = findDropRow(state.board, shape, state.currentPos.row, col);
      if (dropRow === null) {
        continue;
      }

      const locked = lockBlock(
        state.board,
        shape,
        dropRow,
        col,
        state.currentBlock,
      );
      const { nextBoard, clearedLines } = clearLines(locked);
      candidates.push({
        targetCol: col,
        targetShape: shape,
        score: evaluateAiBoard(nextBoard, clearedLines, difficulty),
      });
    }
  }

  if (candidates.length === 0) {
    return null;
  }

  candidates.sort((a, b) => b.score - a.score);

  let chosen: AiCandidate;
  if (Math.random() < difficulty.aiMistakeChance) {
    chosen = candidates[Math.floor(Math.random() * candidates.length)] ?? candidates[0];
  } else if (Math.random() < difficulty.aiLineChance) {
    chosen = candidates[0];
  } else {
    const topPool = candidates.slice(0, Math.min(4, candidates.length));
    chosen = topPool[Math.floor(Math.random() * topPool.length)] ?? candidates[0];
  }

  return {
    targetCol: chosen.targetCol,
    targetShape: chosen.targetShape,
  };
};

const sameShape = (left: number[][], right: number[][]): boolean => {
  if (left.length !== right.length) {
    return false;
  }
  for (let r = 0; r < left.length; r++) {
    if (left[r].length !== right[r].length) {
      return false;
    }
    for (let c = 0; c < left[r].length; c++) {
      if (left[r][c] !== right[r][c]) {
        return false;
      }
    }
  }
  return true;
};

const hasMatchMeaningfulChange = (prev: MatchRow, next: MatchRow): boolean => {
  return (
    prev.status !== next.status ||
    prev.guest_user_id !== next.guest_user_id ||
    prev.host_ready !== next.host_ready ||
    prev.guest_ready !== next.guest_ready ||
    prev.winner_user_id !== next.winner_user_id ||
    prev.disconnect_user_id !== next.disconnect_user_id ||
    prev.disconnect_deadline !== next.disconnect_deadline ||
    prev.end_reason !== next.end_reason ||
    prev.updated_at !== next.updated_at
  );
};

const BoardGrid = ({
  board,
  gameOver,
  title,
}: {
  board: BoardCell[][];
  gameOver: boolean;
  title: string;
}) => {
  return (
    <div className="relative">
      <div className="mb-2 flex items-center justify-between">
        <h3 className="text-sm font-semibold uppercase tracking-[0.2em] text-slate-300">
          {title}
        </h3>
      </div>
      <div className="rounded-2xl border border-slate-700/70 bg-slate-950/60 p-2 shadow-[0_0_40px_rgba(14,165,233,0.12)]">
        {board.map((row, rowIndex) => (
          <div key={rowIndex} className="flex">
            {row.map((cell, colIndex) => (
              <div
                key={`${rowIndex}-${colIndex}`}
                className="h-4 w-4 border border-slate-800/80 sm:h-5 sm:w-5"
                style={{ backgroundColor: cell ?? 'transparent' }}
              />
            ))}
          </div>
        ))}
      </div>
      {gameOver && (
        <div className="absolute inset-0 flex items-center justify-center rounded-2xl bg-slate-950/80">
          <span className="text-lg font-bold text-rose-300">GAME OVER</span>
        </div>
      )}
    </div>
  );
};

const NextBlockCard = ({ blockType }: { blockType: BlockType }) => {
  const shape = BLOCK_SHAPES[blockType];
  const color = BLOCK_COLORS[blockType];

  return (
    <Card className="border-slate-700/60 bg-slate-900/60 py-3 shadow-none">
      <CardHeader className="px-4 py-0">
        <CardTitle className="text-xs uppercase tracking-[0.2em] text-slate-400">
          Next
        </CardTitle>
      </CardHeader>
      <CardContent className="px-4">
        <div className="mt-2 inline-flex flex-col rounded-lg border border-slate-700/70 bg-slate-950/60 p-2">
          {shape.map((row, rowIndex) => (
            <div key={rowIndex} className="flex">
              {row.map((cell, colIndex) => (
                <div
                  key={`${rowIndex}-${colIndex}`}
                  className="h-5 w-5 border border-slate-800"
                  style={{ backgroundColor: cell ? color : 'transparent' }}
                />
              ))}
            </div>
          ))}
        </div>
      </CardContent>
    </Card>
  );
};

function SingleMode({
  onBack,
  onProgressSettled,
  profile,
}: {
  onBack: () => void;
  onProgressSettled: () => Promise<void>;
  profile: ProfileRow | null;
}) {
  const isAnonymous = profile?.is_anonymous ?? true;
  const [playerState, setPlayerState] = useState<PlayerGameState | null>(null);
  const [aiState, setAiState] = useState<PlayerGameState | null>(null);
  const playerStateRef = useRef<PlayerGameState | null>(null);
  const aiStateRef = useRef<PlayerGameState | null>(null);
  const playerGeneratorRef = useRef<PieceGenerator | null>(null);
  const aiGeneratorRef = useRef<PieceGenerator | null>(null);
  const aiPlanRef = useRef<AiPlan | null>(null);
  const battleRealmRef = useRef(1);
  const battleDifficultyRef = useRef<RealmDifficulty>(REALM_DIFFICULTIES[0]);
  const settledRef = useRef(false);
  const [running, setRunning] = useState(false);
  const [progressLoading, setProgressLoading] = useState(true);
  const [realmLevel, setRealmLevel] = useState(1);
  const [aiWins, setAiWins] = useState(0);
  const [resultTitle, setResultTitle] = useState<string | null>(null);
  const [resultDetail, setResultDetail] = useState('');
  const [statusText, setStatusText] = useState('');
  const [settling, setSettling] = useState(false);
  const commitPlayerState = useCallback((next: PlayerGameState) => {
    playerStateRef.current = next;
    setPlayerState(next);
  }, []);

  const commitAiState = useCallback((next: PlayerGameState) => {
    aiStateRef.current = next;
    setAiState(next);
  }, []);

  const loadProgress = useCallback(async () => {
    setProgressLoading(true);
    if (isAnonymous) {
      setRealmLevel(1);
      setAiWins(0);
      setStatusText('匿名模式固定炼气期，想要升级请先注册账号。');
      setProgressLoading(false);
      return;
    }

    try {
      const stats = await fetchMyPlayerStats();
      const nextRealm = clampRealmLevel(stats?.single_realm_level);
      setRealmLevel(nextRealm);
      setAiWins(stats?.single_ai_wins ?? 0);
      setStatusText(`当前修为：${realmLabel(nextRealm)}（第 ${nextRealm}/8 重）`);
    } catch (error) {
      setRealmLevel(1);
      setAiWins(0);
      setStatusText(
        `进度读取失败，已回退到炼气期：${error instanceof Error ? error.message : 'unknown error'}`,
      );
    } finally {
      setProgressLoading(false);
    }
  }, [isAnonymous]);

  useEffect(() => {
    void loadProgress();
  }, [loadProgress]);

  const startGame = useCallback(() => {
    if (progressLoading) {
      return;
    }
    const currentRealm = clampRealmLevel(realmLevel);
    const playerGenerator = createPieceGenerator(randomSeed());
    const aiGenerator = createPieceGenerator(randomSeed());
    const initialPlayer = createInitialState(playerGenerator);
    const initialAi = createInitialState(aiGenerator);

    playerGeneratorRef.current = playerGenerator;
    aiGeneratorRef.current = aiGenerator;
    aiPlanRef.current = null;
    battleRealmRef.current = currentRealm;
    battleDifficultyRef.current = REALM_DIFFICULTIES[currentRealm - 1];
    settledRef.current = false;
    commitPlayerState(initialPlayer);
    commitAiState(initialAi);
    setResultTitle(null);
    setResultDetail('');
    setStatusText(`当前修为：${realmLabel(currentRealm)}（第 ${currentRealm}/8 重）`);
    setRunning(true);
  }, [commitAiState, commitPlayerState, progressLoading, realmLevel]);

  const stepPlayer = useCallback(() => {
    const current = playerStateRef.current;
    const generator = playerGeneratorRef.current;
    if (!current || !generator || current.gameOver) {
      return;
    }

    const baseState =
      current.pendingGarbage > 0 ? applyPendingGarbage(current, Date.now()) : current;
    const step = stepDown(baseState, generator);
    commitPlayerState(step.nextState);

    if (step.locked && step.sentGarbage > 0) {
      const aiCurrent = aiStateRef.current;
      if (aiCurrent && !aiCurrent.gameOver) {
        commitAiState({
          ...aiCurrent,
          pendingGarbage: aiCurrent.pendingGarbage + step.sentGarbage,
        });
      }
    }

    if (step.nextState.gameOver) {
      setRunning(false);
    }
  }, [commitAiState, commitPlayerState]);

  const stepAi = useCallback(() => {
    const current = aiStateRef.current;
    const generator = aiGeneratorRef.current;
    if (!current || !generator || current.gameOver) {
      return;
    }

    const difficulty = battleDifficultyRef.current;
    const baseState =
      current.pendingGarbage > 0 ? applyPendingGarbage(current, Date.now()) : current;
    if (baseState !== current) {
      aiPlanRef.current = null;
    }

    let working = baseState;
    let plan = aiPlanRef.current;
    if (!plan) {
      plan = buildAiPlan(working, difficulty);
      aiPlanRef.current = plan;
    }

    if (plan) {
      if (!sameShape(working.currentShape, plan.targetShape)) {
        const rotated = rotateCurrent(working);
        if (rotated !== working) {
          working = rotated;
        } else {
          const shiftDir: -1 | 1 = working.currentPos.col <= plan.targetCol ? 1 : -1;
          const shifted = moveHorizontal(working, shiftDir);
          if (shifted !== working) {
            working = shifted;
          } else {
            aiPlanRef.current = buildAiPlan(working, difficulty);
          }
        }
      } else if (working.currentPos.col < plan.targetCol) {
        const shifted = moveHorizontal(working, 1);
        if (shifted !== working) {
          working = shifted;
        } else {
          aiPlanRef.current = buildAiPlan(working, difficulty);
        }
      } else if (working.currentPos.col > plan.targetCol) {
        const shifted = moveHorizontal(working, -1);
        if (shifted !== working) {
          working = shifted;
        } else {
          aiPlanRef.current = buildAiPlan(working, difficulty);
        }
      }
    }

    const alignedToPlan =
      plan !== null &&
      sameShape(working.currentShape, plan.targetShape) &&
      working.currentPos.col === plan.targetCol;

    let step = stepDown(working, generator);
    if (alignedToPlan) {
      while (!step.locked && !step.nextState.gameOver) {
        step = stepDown(step.nextState, generator);
      }
    }

    commitAiState(step.nextState);

    if (step.locked) {
      aiPlanRef.current = null;
    }

    if (step.locked && step.sentGarbage > 0) {
      const latestPlayer = playerStateRef.current;
      if (latestPlayer && !latestPlayer.gameOver) {
        commitPlayerState({
          ...latestPlayer,
          pendingGarbage: latestPlayer.pendingGarbage + step.sentGarbage,
        });
      }
    }

    if (step.nextState.gameOver) {
      setRunning(false);
    }
  }, [commitAiState, commitPlayerState]);

  useEffect(() => {
    if (!running) {
      return;
    }

    const timer = window.setInterval(() => {
      stepPlayer();
    }, battleDifficultyRef.current.gravityMs);

    return () => window.clearInterval(timer);
  }, [running, stepPlayer]);

  useEffect(() => {
    if (!running) {
      return;
    }

    const timer = window.setInterval(() => {
      stepAi();
    }, battleDifficultyRef.current.aiTickMs);

    return () => window.clearInterval(timer);
  }, [running, stepAi]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const current = playerStateRef.current;
      if (!running || !current || current.gameOver) {
        return;
      }

      if (event.key === 'a' || event.key === 'A' || event.key === 'ArrowLeft') {
        event.preventDefault();
        commitPlayerState(moveHorizontal(current, -1));
        return;
      }

      if (event.key === 'd' || event.key === 'D' || event.key === 'ArrowRight') {
        event.preventDefault();
        commitPlayerState(moveHorizontal(current, 1));
        return;
      }

      if (event.key === 'w' || event.key === 'W' || event.key === 'ArrowUp') {
        event.preventDefault();
        commitPlayerState(rotateCurrent(current));
        return;
      }

      if (event.key === 's' || event.key === 'S' || event.key === 'ArrowDown') {
        event.preventDefault();
        stepPlayer();
      }
    };

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [commitPlayerState, running, stepPlayer]);

  useEffect(() => {
    const me = playerState;
    const ai = aiState;
    if (!me || !ai || running || settledRef.current) {
      return;
    }
    if (!me.gameOver && !ai.gameOver) {
      return;
    }

    settledRef.current = true;
    setRunning(false);

    const settle = async () => {
      const playerWin = ai.gameOver && !me.gameOver;
      const currentRealm = battleRealmRef.current;
      setSettling(true);
      try {
        if (isAnonymous) {
          setResultTitle(playerWin ? '本局胜利' : '本局战败');
          setResultDetail(
            playerWin
              ? `你击败了 ${realmLabel(currentRealm)} 的电脑。匿名模式固定炼气期，想要升级请先注册。`
              : '修为不变。匿名模式固定炼气期，想要升级请先注册。',
          );
          return;
        }

        const nextStats = await submitSingleAiResult(playerWin);
        const nextRealm = clampRealmLevel(nextStats.single_realm_level);
        setRealmLevel(nextRealm);
        setAiWins(nextStats.single_ai_wins);
        await onProgressSettled();

        if (playerWin) {
          setResultTitle('本局胜利');
          if (currentRealm >= 8) {
            setResultDetail('您已经天下无敌了');
          } else if (nextRealm > currentRealm) {
            setResultDetail(`突破成功！你已晋升至 ${realmLabel(nextRealm)}。`);
          } else {
            setResultDetail('胜利！修为保持不变。');
          }
        } else {
          setResultTitle('本局战败');
          setResultDetail('本局失败，修为不变。');
        }

        setStatusText(`当前修为：${realmLabel(nextRealm)}（第 ${nextRealm}/8 重）`);
      } catch (error) {
        setResultTitle(playerWin ? '本局胜利' : '本局战败');
        setResultDetail(
          `对局结果已记录，但进度保存失败：${error instanceof Error ? error.message : 'unknown error'}`,
        );
      } finally {
        setSettling(false);
      }
    };

    void settle();
  }, [aiState, isAnonymous, onProgressSettled, playerState, running]);

  const playerBoard = useMemo(() => {
    if (!playerState) {
      return createEmptyBoard();
    }
    return withActivePiece(playerState);
  }, [playerState]);

  const enemyBoard = useMemo(() => {
    if (!aiState) {
      return createEmptyBoard();
    }
    return withActivePiece(aiState);
  }, [aiState]);

  const battleRealm = running ? battleRealmRef.current : realmLevel;
  const battleDifficulty = running
    ? battleDifficultyRef.current
    : REALM_DIFFICULTIES[clampRealmLevel(realmLevel) - 1];

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-2xl font-black tracking-tight text-white">单机模式：修为对战电脑</h2>
          <p className="text-sm text-slate-400">
            控制键：A/D 左右，W 旋转，S 加速下落。先爆顶者输。
          </p>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" onClick={onBack} className="border-slate-600 bg-slate-900/70 text-slate-200">
            返回菜单
          </Button>
          <Button
            onClick={startGame}
            disabled={progressLoading || settling}
            className="bg-cyan-500 text-slate-950 hover:bg-cyan-400"
          >
            {running ? '重新开局' : '开始对战'}
          </Button>
        </div>
      </div>

      <div className="grid gap-3 sm:grid-cols-3">
        <Card className="border-slate-700/60 bg-slate-900/50 py-3 shadow-none">
          <CardHeader className="px-4 py-0">
            <CardTitle className="text-xs uppercase tracking-[0.2em] text-slate-400">当前修为</CardTitle>
          </CardHeader>
          <CardContent className="px-4">
            <p className="mt-2 text-2xl font-black text-cyan-300">{realmLabel(realmLevel)}</p>
            <p className="text-xs text-slate-500">第 {realmLevel}/8 重 · 累计胜场 {aiWins}</p>
          </CardContent>
        </Card>
        <Card className="border-slate-700/60 bg-slate-900/50 py-3 shadow-none">
          <CardHeader className="px-4 py-0">
            <CardTitle className="text-xs uppercase tracking-[0.2em] text-slate-400">对局难度</CardTitle>
          </CardHeader>
          <CardContent className="px-4">
            <p className="mt-2 text-2xl font-black text-orange-300">{realmLabel(battleRealm)}</p>
            <p className="text-xs text-slate-500">
              玩家下落 {battleDifficulty.gravityMs}ms · 电脑节奏 {battleDifficulty.aiTickMs}ms
            </p>
          </CardContent>
        </Card>
        <Card className="border-slate-700/60 bg-slate-900/50 py-3 shadow-none">
          <CardHeader className="px-4 py-0">
            <CardTitle className="text-xs uppercase tracking-[0.2em] text-slate-400">状态</CardTitle>
          </CardHeader>
          <CardContent className="px-4">
            <p className="mt-2 text-sm font-semibold text-slate-200">
              {progressLoading ? '正在读取修为...' : running ? '对战进行中' : '等待开局'}
            </p>
            <p className="text-xs text-slate-500">{statusText || '准备好后开始挑战'}</p>
          </CardContent>
        </Card>
      </div>

      {isAnonymous && (
        <Card className="border-amber-300/40 bg-amber-400/10 py-3 shadow-none">
          <CardContent className="px-4 text-sm text-amber-100">
            匿名模式可游玩，但修为固定为炼气期。想要升级并上榜，请先注册账号。
          </CardContent>
        </Card>
      )}

      <div className="flex justify-center">
        <div className="grid w-fit gap-4 lg:grid-cols-2">
          <BoardGrid board={playerBoard} gameOver={Boolean(playerState?.gameOver)} title="你" />
          <BoardGrid board={enemyBoard} gameOver={Boolean(aiState?.gameOver)} title={`电脑（${realmLabel(battleRealm)}）`} />
        </div>
      </div>

      <div className="grid gap-3 sm:grid-cols-[240px_1fr]">
        <NextBlockCard blockType={playerState?.nextBlock ?? 'I'} />
        <Card className="border-slate-700/60 bg-slate-900/50 py-3 shadow-none">
          <CardContent className="grid gap-3 px-4 sm:grid-cols-3">
            <div>
              <p className="text-xs uppercase tracking-[0.16em] text-slate-500">你的分数</p>
              <p className="mt-1 text-2xl font-black text-cyan-300">{playerState?.score ?? 0}</p>
            </div>
            <div>
              <p className="text-xs uppercase tracking-[0.16em] text-slate-500">电脑分数</p>
              <p className="mt-1 text-2xl font-black text-orange-300">{aiState?.score ?? 0}</p>
            </div>
            <div>
              <p className="text-xs uppercase tracking-[0.16em] text-slate-500">待处理垃圾</p>
              <p className="mt-1 text-2xl font-black text-fuchsia-300">{playerState?.pendingGarbage ?? 0}</p>
            </div>
          </CardContent>
        </Card>
      </div>

      {resultTitle && (
        <Card className="border-emerald-400/40 bg-emerald-500/10 py-3 shadow-none">
          <CardContent className="space-y-1 px-4">
            <p className="text-sm font-semibold text-emerald-200">{resultTitle}</p>
            <p className="text-xs text-emerald-100/90">
              {settling ? '正在结算进度...' : resultDetail}
            </p>
          </CardContent>
        </Card>
      )}
    </div>
  );
}

function OnlineMode({
  session,
  profile,
  onProfileRefresh,
  onBack,
  initialMatchId,
}: {
  session: Session;
  profile: ProfileRow | null;
  onProfileRefresh: () => Promise<void>;
  onBack: () => void;
  initialMatchId?: string | null;
}) {
  const userId = session.user.id;
  const [phase, setPhase] = useState<OnlinePhase>('idle');
  const [roomInput, setRoomInput] = useState('');
  const [match, setMatch] = useState<MatchRow | null>(null);
  const matchRef = useRef<MatchRow | null>(null);

  const [localState, setLocalState] = useState<PlayerGameState | null>(null);
  const [remoteBoard, setRemoteBoard] = useState<BoardCell[][]>(createEmptyBoard());
  const [remoteScore, setRemoteScore] = useState(0);
  const [remoteGameOver, setRemoteGameOver] = useState(false);

  const localStateRef = useRef<PlayerGameState | null>(null);
  const remoteStateRef = useRef<{
    board: BoardCell[][];
    score: number;
    pendingGarbage: number;
    gameOver: boolean;
  }>({
    board: createEmptyBoard(),
    score: 0,
    pendingGarbage: 0,
    gameOver: false,
  });

  const channelRef = useRef<ReturnType<typeof createMatchChannel> | null>(null);
  const generatorRef = useRef<PieceGenerator | null>(null);
  const startedRef = useRef(false);
  const endingRef = useRef(false);

  const mySeqRef = useRef(0);
  const opponentSeqRef = useRef(0);
  const snapshotVersionRef = useRef(0);
  const locksSinceSnapshotRef = useRef(0);
  const lastSnapshotAtRef = useRef(0);

  const opponentHeartbeatRef = useRef(Date.now());
  const [statusText, setStatusText] = useState('创建房间或输入房间码加入');
  const [winnerText, setWinnerText] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [rematchLocalReady, setRematchLocalReady] = useState(false);
  const [rematchRemoteReady, setRematchRemoteReady] = useState(false);
  const rematchLaunchingRef = useRef(false);
  const rankedEnabled = !profile?.is_anonymous;
  const opponentIdRef = useRef<string | null>(null);

  const isHost = match?.host_user_id === userId;
  const opponentId = useMemo(() => {
    if (!match) {
      return null;
    }
    return isHost ? match.guest_user_id : match.host_user_id;
  }, [isHost, match]);

  const myReady = useMemo(() => {
    if (!match) {
      return false;
    }
    return isHost ? match.host_ready : match.guest_ready;
  }, [isHost, match]);

  const opponentReady = useMemo(() => {
    if (!match) {
      return false;
    }
    return isHost ? match.guest_ready : match.host_ready;
  }, [isHost, match]);

  const commitLocalState = useCallback((next: PlayerGameState) => {
    localStateRef.current = next;
    setLocalState(next);
  }, []);

  const commitRemoteState = useCallback(
    (
      patch: Partial<{
        board: BoardCell[][];
        score: number;
        pendingGarbage: number;
        gameOver: boolean;
      }>,
    ) => {
      remoteStateRef.current = {
        ...remoteStateRef.current,
        ...patch,
      };

      if (patch.board) {
        setRemoteBoard(patch.board);
      }
      if (typeof patch.score === 'number') {
        setRemoteScore(patch.score);
      }
      if (typeof patch.gameOver === 'boolean') {
        setRemoteGameOver(patch.gameOver);
      }
    },
    [],
  );

  useEffect(() => {
    matchRef.current = match;
  }, [match]);

  useEffect(() => {
    opponentIdRef.current = opponentId;
  }, [opponentId]);

  const broadcast = useCallback(
    async (event: string, payload: Record<string, unknown>) => {
      const channel = channelRef.current;
      if (!channel) {
        return;
      }

      await channel.send({
        type: 'broadcast',
        event,
        payload,
      });
    },
    [],
  );

  const resetBattleRuntime = useCallback(() => {
    startedRef.current = false;
    endingRef.current = false;
    rematchLaunchingRef.current = false;
    mySeqRef.current = 0;
    opponentSeqRef.current = 0;
    snapshotVersionRef.current = 0;
    locksSinceSnapshotRef.current = 0;
    lastSnapshotAtRef.current = 0;
    opponentHeartbeatRef.current = Date.now();
    generatorRef.current = null;
    localStateRef.current = null;
    setLocalState(null);
    commitRemoteState({
      board: createEmptyBoard(),
      score: 0,
      pendingGarbage: 0,
      gameOver: false,
    });
    setWinnerText(null);
    setRematchLocalReady(false);
    setRematchRemoteReady(false);
  }, [commitRemoteState]);

  const copyRoomCode = useCallback(async () => {
    const code = matchRef.current?.room_code;
    if (!code) {
      return;
    }

    try {
      if (typeof navigator !== 'undefined' && navigator.clipboard) {
        await navigator.clipboard.writeText(code);
        setStatusText(`房间码 ${code} 已复制`);
        return;
      }
      throw new Error('clipboard API unavailable');
    } catch {
      setStatusText(`复制失败，请手动复制：${code}`);
    }
  }, []);

  const persistSnapshotMaybe = useCallback(
    async (force = false) => {
      if (!isHost || !matchRef.current || !localStateRef.current) {
        return;
      }

      const now = Date.now();
      if (
        !force &&
        locksSinceSnapshotRef.current < 8 &&
        now - lastSnapshotAtRef.current < 10_000
      ) {
        return;
      }

      const currentMatch = matchRef.current;
      const local = localStateRef.current;
      const remote = remoteStateRef.current;
      if (!currentMatch || !local) {
        return;
      }

      const nextVersion = snapshotVersionRef.current + 1;

      const hostBoard = isHost ? local.board : remote.board;
      const guestBoard = isHost ? remote.board : local.board;
      const hostScore = isHost ? local.score : remote.score;
      const guestScore = isHost ? remote.score : local.score;
      const hostSeq = isHost ? mySeqRef.current : opponentSeqRef.current;
      const guestSeq = isHost ? opponentSeqRef.current : mySeqRef.current;
      const hostPending = isHost ? local.pendingGarbage : remote.pendingGarbage;
      const guestPending = isHost ? remote.pendingGarbage : local.pendingGarbage;

      await insertSnapshot({
        match_id: currentMatch.id,
        version: nextVersion,
        from_user_id: userId,
        host_seq: hostSeq,
        guest_seq: guestSeq,
        host_board_fixed: hostBoard,
        guest_board_fixed: guestBoard,
        host_score: hostScore,
        guest_score: guestScore,
        host_pending_garbage: hostPending,
        guest_pending_garbage: guestPending,
      });

      snapshotVersionRef.current = nextVersion;
      locksSinceSnapshotRef.current = 0;
      lastSnapshotAtRef.current = now;
    },
    [isHost, userId],
  );

  const startPlaying = useCallback(
    async (sourceMatch: MatchRow, seed: number) => {
      if (startedRef.current) {
        return;
      }
      startedRef.current = true;
      setPhase('playing');
      setStatusText('对战已开始，祝你好运');
      setWinnerText(null);

      const generator = createPieceGenerator(seed);
      generatorRef.current = generator;

      let nextState = createInitialState(generator);
      let remoteBoardInit = createEmptyBoard();
      let remoteScoreInit = 0;
      let remotePendingInit = 0;

      try {
        const snapshot = await fetchLatestSnapshot(sourceMatch.id);
        if (snapshot) {
          snapshotVersionRef.current = snapshot.version;

          const myBoardFromSnapshot = isHost
            ? toBoard(snapshot.host_board_fixed)
            : toBoard(snapshot.guest_board_fixed);
          const remoteBoardFromSnapshot = isHost
            ? toBoard(snapshot.guest_board_fixed)
            : toBoard(snapshot.host_board_fixed);

          const myScoreFromSnapshot = isHost
            ? snapshot.host_score
            : snapshot.guest_score;
          const remoteScoreFromSnapshot = isHost
            ? snapshot.guest_score
            : snapshot.host_score;

          const myPendingFromSnapshot = isHost
            ? snapshot.host_pending_garbage
            : snapshot.guest_pending_garbage;
          const remotePendingFromSnapshot = isHost
            ? snapshot.guest_pending_garbage
            : snapshot.host_pending_garbage;

          const mySeq = isHost ? snapshot.host_seq : snapshot.guest_seq;
          const opponentSeq = isHost ? snapshot.guest_seq : snapshot.host_seq;

          mySeqRef.current = mySeq;
          opponentSeqRef.current = opponentSeq;
          nextState = {
            ...nextState,
            board: myBoardFromSnapshot,
            score: myScoreFromSnapshot,
            pendingGarbage: myPendingFromSnapshot,
          };

          if (
            checkCollision(
              nextState.board,
              nextState.currentShape,
              nextState.currentPos.row,
              nextState.currentPos.col,
            )
          ) {
            nextState.gameOver = true;
          }

          remoteBoardInit = remoteBoardFromSnapshot;
          remoteScoreInit = remoteScoreFromSnapshot;
          remotePendingInit = remotePendingFromSnapshot;
        }
      } catch (error) {
        setStatusText(
          `快照恢复失败，已按新局继续：${error instanceof Error ? error.message : 'unknown error'}`,
        );
      }

      commitLocalState(nextState);
      commitRemoteState({
        board: remoteBoardInit,
        score: remoteScoreInit,
        pendingGarbage: remotePendingInit,
        gameOver: false,
      });
    },
    [commitLocalState, commitRemoteState, isHost],
  );

  useEffect(() => {
    if (!initialMatchId) {
      return;
    }
    if (matchRef.current?.id === initialMatchId) {
      return;
    }

    let cancelled = false;

    const hydrateFromMatchId = async () => {
      setBusy(true);
      try {
        const existing = await fetchMatchById(initialMatchId);
        if (cancelled) {
          return;
        }
        resetBattleRuntime();
        setMatch(existing);
        setRoomInput(existing.room_code);
        setPhase(existing.status === 'playing' ? 'playing' : 'lobby');
        setStatusText(`已载入房间 ${existing.room_code}`);
        if (existing.status === 'playing') {
          await startPlaying(existing, existing.seed);
        }
      } catch (error) {
        if (!cancelled) {
          setStatusText(
            `载入房间失败：${error instanceof Error ? error.message : 'unknown error'}`,
          );
        }
      } finally {
        if (!cancelled) {
          setBusy(false);
        }
      }
    };

    void hydrateFromMatchId();
    return () => {
      cancelled = true;
    };
  }, [initialMatchId, resetBattleRuntime, startPlaying]);

  const settleMatchIfNeeded = useCallback(
    async (
      loserId: string,
      reason: 'normal' | 'disconnect_timeout' | 'forfeit',
    ) => {
      const currentMatch = matchRef.current;
      const currentOpponentId = opponentIdRef.current;
      if (!currentMatch || !currentOpponentId || endingRef.current) {
        return;
      }

      const winnerId = loserId === userId ? currentOpponentId : userId;
      endingRef.current = true;
      try {
        const ended = await finishMatch(currentMatch.id, winnerId, reason);
        setMatch(ended);
        if (winnerId === userId) {
          setWinnerText(rankedEnabled ? '你赢了！+3 分' : '你赢了！（匿名模式不计分）');
        } else {
          setWinnerText(rankedEnabled ? '你输了，本局 +0 分' : '你输了（匿名模式不计分）');
        }
        setPhase('ended');
        setStatusText(
          reason === 'disconnect_timeout'
            ? '对局因断线超时结算'
            : '对局已结算',
        );
      } catch (error) {
        endingRef.current = false;
        setStatusText(
          `结算失败：${error instanceof Error ? error.message : 'unknown error'}`,
        );
      }
    },
    [rankedEnabled, userId],
  );

  const stepLocal = useCallback(async () => {
    const current = localStateRef.current;
    const generator = generatorRef.current;
    const currentMatch = matchRef.current;
    if (!current || !generator || !currentMatch || phase !== 'playing') {
      return;
    }
    if (current.gameOver) {
      return;
    }

    const step = stepDown(current, generator);
    let nextState = step.nextState;

    if (step.locked && nextState.pendingGarbage > 0) {
      nextState = applyPendingGarbage(nextState, Date.now());
    }

    commitLocalState(nextState);

    if (!step.locked) {
      return;
    }

    mySeqRef.current += 1;
    const seq = mySeqRef.current;
    const currentOpponentId = opponentIdRef.current;

    const piecePayload: PieceLockedEvent = {
      matchId: currentMatch.id,
      playerId: userId,
      seq,
      boardFixed: nextState.board,
      score: nextState.score,
      linesClearedTotal: nextState.totalCleared,
      sentGarbage: step.sentGarbage,
      gameOver: nextState.gameOver,
    };

    await broadcast('piece_locked', piecePayload as unknown as Record<string, unknown>);

    if (step.sentGarbage > 0 && currentOpponentId) {
      const garbagePayload: GarbageSentEvent = {
        matchId: currentMatch.id,
        fromPlayerId: userId,
        toPlayerId: currentOpponentId,
        seq,
        count: step.sentGarbage,
      };
      await broadcast('garbage_sent', garbagePayload as unknown as Record<string, unknown>);
    }

    locksSinceSnapshotRef.current += 1;
    void persistSnapshotMaybe(false);

    if (nextState.gameOver) {
      if (currentOpponentId) {
        await broadcast(
          'game_over',
          {
            matchId: currentMatch.id,
            loserId: userId,
            winnerId: currentOpponentId,
            reason: 'normal',
          } satisfies GameOverEvent as unknown as Record<string, unknown>,
        );
      }
      await settleMatchIfNeeded(userId, 'normal');
    }
  }, [broadcast, commitLocalState, persistSnapshotMaybe, phase, settleMatchIfNeeded, userId]);

  const createRoom = useCallback(async () => {
    setBusy(true);
    try {
      const created = await createMatchRoom(randomSeed());
      resetBattleRuntime();
      setMatch(created);
      setRoomInput(created.room_code);
      setPhase(created.status === 'playing' ? 'playing' : 'lobby');
      setStatusText(`房间 ${created.room_code} 已创建，分享给好友`);
    } catch (error) {
      setStatusText(`创建失败：${error instanceof Error ? error.message : 'unknown error'}`);
    } finally {
      setBusy(false);
    }
  }, [resetBattleRuntime]);

  const joinRoom = useCallback(async () => {
    if (!roomInput.trim()) {
      return;
    }
    setBusy(true);
    try {
      const joined = await joinMatchRoom(roomInput.trim().toUpperCase());
      resetBattleRuntime();
      setMatch(joined);
      setRoomInput(joined.room_code);
      setPhase(joined.status === 'playing' ? 'playing' : 'lobby');
      setStatusText(`已加入房间 ${joined.room_code}`);
    } catch (error) {
      setStatusText(`加入失败：${error instanceof Error ? error.message : 'unknown error'}`);
    } finally {
      setBusy(false);
    }
  }, [resetBattleRuntime, roomInput]);

  const toggleReady = useCallback(async () => {
    if (!match) {
      return;
    }

    setBusy(true);
    try {
      const updated = await setMatchReady(match.id, !myReady);
      setMatch(updated);

      const nextReady = updated.host_user_id === userId ? updated.host_ready : updated.guest_ready;
      setStatusText(nextReady ? '已就绪，等待对手' : '已取消就绪');

      await broadcast('ready_changed', {
        matchId: updated.id,
        userId,
        ready: nextReady,
      });

      if (updated.status === 'playing') {
        if (isHost) {
          await broadcast(
            'match_started',
            {
              matchId: updated.id,
              seed: updated.seed,
              startAt: Date.now() + 1200,
              hostId: updated.host_user_id,
              guestId: updated.guest_user_id,
            } satisfies MatchStartedEvent as unknown as Record<string, unknown>,
          );
        }
        await startPlaying(updated, updated.seed);
      }
    } catch (error) {
      setStatusText(`设置就绪失败：${error instanceof Error ? error.message : 'unknown error'}`);
    } finally {
      setBusy(false);
    }
  }, [broadcast, isHost, match, myReady, startPlaying, userId]);

  const requestRematchReady = useCallback(async () => {
    const currentMatch = matchRef.current;
    const currentOpponentId = opponentIdRef.current;
    if (!currentMatch || phase !== 'ended') {
      return;
    }
    if (!currentOpponentId) {
      setStatusText('当前房间没有对手，无法发起再来一局');
      return;
    }
    if (rematchLocalReady) {
      return;
    }

    setRematchLocalReady(true);
    setStatusText('已点击再来一局，等待双方就绪');

    try {
      await broadcast(
        'rematch_ready',
        {
          matchId: currentMatch.id,
          playerId: userId,
          ready: true,
        } satisfies RematchReadyEvent as unknown as Record<string, unknown>,
      );
    } catch (error) {
      setRematchLocalReady(false);
      setStatusText(
        `发送再来一局请求失败：${error instanceof Error ? error.message : 'unknown error'}`,
      );
    }
  }, [broadcast, phase, rematchLocalReady, userId]);

  const launchRematchRoom = useCallback(async () => {
    const currentMatch = matchRef.current;
    const currentOpponentId = opponentIdRef.current;
    if (!currentMatch || !currentOpponentId) {
      return;
    }
    if (!isHost || phase !== 'ended' || !rematchLocalReady || !rematchRemoteReady) {
      return;
    }
    if (rematchLaunchingRef.current) {
      return;
    }

    rematchLaunchingRef.current = true;
    setBusy(true);
    try {
      const created = await createMatchRoom(randomSeed());
      const hostReady = await setMatchReady(created.id, true);

      await broadcast(
        'rematch_room',
        {
          oldMatchId: currentMatch.id,
          newMatchId: hostReady.id,
          roomCode: hostReady.room_code,
          hostId: userId,
          guestId: currentOpponentId,
        } satisfies RematchRoomEvent as unknown as Record<string, unknown>,
      );

      resetBattleRuntime();
      setMatch(hostReady);
      setRoomInput(hostReady.room_code);
      setPhase(hostReady.status === 'playing' ? 'playing' : 'lobby');
      setStatusText(`再来一局房间 ${hostReady.room_code} 已创建，等待对手就绪`);

      if (hostReady.status === 'playing') {
        await startPlaying(hostReady, hostReady.seed);
      }
    } catch (error) {
      rematchLaunchingRef.current = false;
      setStatusText(`再来一局失败：${error instanceof Error ? error.message : 'unknown error'}`);
    } finally {
      setBusy(false);
    }
  }, [broadcast, isHost, phase, rematchLocalReady, rematchRemoteReady, resetBattleRuntime, startPlaying, userId]);

  useEffect(() => {
    if (!isHost || phase !== 'ended' || !rematchLocalReady || !rematchRemoteReady) {
      return;
    }
    void launchRematchRoom();
  }, [isHost, launchRematchRoom, phase, rematchLocalReady, rematchRemoteReady]);

  const leaveRoom = useCallback(async () => {
    const currentMatch = matchRef.current;
    const currentOpponentId = opponentIdRef.current;
    if (
      currentMatch &&
      phase === 'playing' &&
      currentOpponentId &&
      currentMatch.status !== 'ended'
    ) {
      await settleMatchIfNeeded(userId, 'forfeit');
    }

    setMatch(null);
    setPhase('idle');
    setStatusText('已离开房间');
    resetBattleRuntime();
  }, [phase, resetBattleRuntime, settleMatchIfNeeded, userId]);

  useEffect(() => {
    const matchId = match?.id;
    if (!matchId) {
      return;
    }

    const channel = createMatchChannel(matchId);
    channelRef.current = channel;

    channel.on('broadcast', { event: 'match_started' }, ({ payload }) => {
      const event = payload as MatchStartedEvent;
      if (event.matchId !== matchId) {
        return;
      }
      const currentMatch = matchRef.current;
      if (currentMatch && currentMatch.id === matchId) {
        void startPlaying(currentMatch, event.seed);
      }
    });

    channel.on('broadcast', { event: 'piece_locked' }, ({ payload }) => {
      const event = payload as PieceLockedEvent;
      const currentOpponentId = opponentIdRef.current;
      if (
        !currentOpponentId ||
        event.matchId !== matchId ||
        event.playerId !== currentOpponentId
      ) {
        return;
      }
      if (event.seq <= opponentSeqRef.current) {
        return;
      }
      opponentSeqRef.current = event.seq;
      commitRemoteState({
        board: toBoard(event.boardFixed),
        score: event.score,
        gameOver: event.gameOver,
      });
    });

    channel.on('broadcast', { event: 'garbage_sent' }, ({ payload }) => {
      const event = payload as GarbageSentEvent;
      if (event.matchId !== matchId || event.toPlayerId !== userId) {
        return;
      }
      const current = localStateRef.current;
      if (!current) {
        return;
      }
      const next = {
        ...current,
        pendingGarbage: current.pendingGarbage + event.count,
      };
      commitLocalState(next);
      setStatusText(`收到 ${event.count} 行垃圾攻击`);
    });

    channel.on('broadcast', { event: 'resync_request' }, ({ payload }) => {
      const event = payload as ResyncRequestEvent;
      if (event.matchId !== matchId || event.requesterId === userId) {
        return;
      }
      const current = localStateRef.current;
      if (!current) {
        return;
      }

      const response: ResyncStateEvent = {
        matchId,
        playerId: userId,
        seq: mySeqRef.current,
        boardFixed: current.board,
        score: current.score,
        pendingGarbage: current.pendingGarbage,
        gameOver: current.gameOver,
      };
      void broadcast('resync_state', response as unknown as Record<string, unknown>);
    });

    channel.on('broadcast', { event: 'resync_state' }, ({ payload }) => {
      const event = payload as ResyncStateEvent;
      const currentOpponentId = opponentIdRef.current;
      if (
        !currentOpponentId ||
        event.matchId !== matchId ||
        event.playerId !== currentOpponentId
      ) {
        return;
      }
      if (event.seq < opponentSeqRef.current) {
        return;
      }
      opponentSeqRef.current = event.seq;
      commitRemoteState({
        board: toBoard(event.boardFixed),
        score: event.score,
        pendingGarbage: event.pendingGarbage,
        gameOver: event.gameOver,
      });
      setStatusText('已与对手完成状态同步');
    });

    channel.on('broadcast', { event: 'heartbeat' }, ({ payload }) => {
      const event = payload as HeartbeatEvent;
      const currentOpponentId = opponentIdRef.current;
      if (
        !currentOpponentId ||
        event.matchId !== matchId ||
        event.playerId !== currentOpponentId
      ) {
        return;
      }
      opponentHeartbeatRef.current = Date.now();
    });

    channel.on('broadcast', { event: 'game_over' }, ({ payload }) => {
      const event = payload as GameOverEvent;
      if (event.matchId !== matchId) {
        return;
      }
      if (event.winnerId === userId) {
        setWinnerText(rankedEnabled ? '你赢了！+3 分' : '你赢了！（匿名模式不计分）');
      } else if (event.loserId === userId) {
        setWinnerText(rankedEnabled ? '你输了，本局 +0 分' : '你输了（匿名模式不计分）');
      }
    });

    channel.on('broadcast', { event: 'rematch_ready' }, ({ payload }) => {
      const event = payload as RematchReadyEvent;
      if (event.matchId !== matchId || event.playerId === userId) {
        return;
      }
      setRematchRemoteReady(event.ready);
      if (event.ready) {
        setStatusText('对手已点击再来一局，等待双方就绪');
      }
    });

    channel.on('broadcast', { event: 'rematch_room' }, ({ payload }) => {
      const event = payload as RematchRoomEvent;
      if (event.oldMatchId !== matchId || event.guestId !== userId) {
        return;
      }

      void (async () => {
        setBusy(true);
        try {
          const joined = await joinMatchRoom(event.roomCode);
          const guestReady = await setMatchReady(joined.id, true);

          resetBattleRuntime();
          setMatch(guestReady);
          setRoomInput(guestReady.room_code);
          setPhase(guestReady.status === 'playing' ? 'playing' : 'lobby');
          setStatusText(
            guestReady.status === 'playing'
              ? '双方就绪，对局开始'
              : `已加入再来一局房间 ${guestReady.room_code}，等待开始`,
          );

          if (guestReady.status === 'playing') {
            await startPlaying(guestReady, guestReady.seed);
          }
        } catch (error) {
          setStatusText(
            `加入再来一局失败：${error instanceof Error ? error.message : 'unknown error'}`,
          );
        } finally {
          setBusy(false);
        }
      })();
    });

    channel.subscribe((status) => {
      if (status === 'SUBSCRIBED') {
        setStatusText((prev) => `${prev} · Realtime 已连接`);
        if (matchRef.current?.status === 'playing') {
          void broadcast('resync_request', {
            matchId,
            requesterId: userId,
          });
        }
      }
    });

    return () => {
      void channel.unsubscribe();
      getSupabaseClient().removeChannel(channel);
      if (channelRef.current === channel) {
        channelRef.current = null;
      }
    };
  }, [broadcast, commitLocalState, commitRemoteState, match?.id, rankedEnabled, resetBattleRuntime, startPlaying, userId]);

  useEffect(() => {
    const matchId = match?.id;
    if (!matchId) {
      return;
    }

    let cancelled = false;

    const poll = async () => {
      try {
        const latest = await fetchMatchById(matchId);
        if (cancelled) {
          return;
        }
        const current = matchRef.current;
        if (!current || hasMatchMeaningfulChange(current, latest)) {
          setMatch(latest);
        }

        if (latest.status === 'playing' && !startedRef.current) {
          await startPlaying(latest, latest.seed);
        }

        if (latest.status === 'ended') {
          setPhase('ended');
          if (!current || current.status !== 'ended') {
            rematchLaunchingRef.current = false;
            setRematchLocalReady(false);
            setRematchRemoteReady(false);
            if (latest.winner_user_id === userId) {
              setWinnerText(rankedEnabled ? '你赢了！+3 分' : '你赢了！（匿名模式不计分）');
            } else {
              setWinnerText(rankedEnabled ? '你输了，本局 +0 分' : '你输了（匿名模式不计分）');
            }
            setStatusText('本局已结束');
            await onProfileRefresh();
          }
        }
      } catch (error) {
        if (!cancelled) {
          setStatusText(
            `房间状态轮询失败：${error instanceof Error ? error.message : 'unknown error'}`,
          );
        }
      }
    };

    void poll();
    const timer = window.setInterval(() => {
      void poll();
    }, 2_000);

    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [match?.id, onProfileRefresh, rankedEnabled, startPlaying, userId]);

  useEffect(() => {
    if (phase !== 'playing') {
      return;
    }
    const timer = window.setInterval(() => {
      void stepLocal();
    }, 700);
    return () => window.clearInterval(timer);
  }, [phase, stepLocal]);

  useEffect(() => {
    if (phase !== 'playing' || !match) {
      return;
    }

    let running = true;
    let pendingDisconnectUpdate = false;

    const heartbeatTimer = window.setInterval(() => {
      void broadcast('heartbeat', {
        matchId: match.id,
        playerId: userId,
        ts: Date.now(),
      } satisfies HeartbeatEvent as unknown as Record<string, unknown>);
    }, 5_000);

    const watchdogTimer = window.setInterval(() => {
      void (async () => {
        if (!running || pendingDisconnectUpdate) {
          return;
        }

        const currentMatch = matchRef.current;
        const currentOpponentId = opponentIdRef.current;
        if (!currentMatch || currentMatch.status !== 'playing') {
          return;
        }
        if (!currentOpponentId) {
          return;
        }

        const now = Date.now();
        const missingFor = now - opponentHeartbeatRef.current;
        const deadline = currentMatch.disconnect_deadline
          ? new Date(currentMatch.disconnect_deadline).getTime()
          : null;

        try {
          if (
            missingFor > 12_000 &&
            currentMatch.disconnect_user_id !== currentOpponentId
          ) {
            pendingDisconnectUpdate = true;
            const updated = await setDisconnectDeadline(
              currentMatch.id,
              currentOpponentId,
              new Date(now + 30_000).toISOString(),
            );
            setMatch(updated);
            setStatusText('对手疑似断线，已进入 30 秒重连窗口');
          }

          if (
            currentMatch.disconnect_user_id === currentOpponentId &&
            deadline &&
            now > deadline &&
            !endingRef.current
          ) {
            await settleMatchIfNeeded(currentOpponentId, 'disconnect_timeout');
          }

          if (
            missingFor <= 12_000 &&
            currentMatch.disconnect_user_id === currentOpponentId &&
            !endingRef.current
          ) {
            pendingDisconnectUpdate = true;
            const updated = await clearDisconnectDeadline(currentMatch.id);
            setMatch(updated);
            setStatusText('对手已重连，比赛继续');
          }
        } catch (error) {
          setStatusText(
            `断线检测失败：${error instanceof Error ? error.message : 'unknown error'}`,
          );
        } finally {
          pendingDisconnectUpdate = false;
        }
      })();
    }, 3_000);

    return () => {
      running = false;
      window.clearInterval(heartbeatTimer);
      window.clearInterval(watchdogTimer);
    };
  }, [broadcast, match?.id, phase, settleMatchIfNeeded, userId]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (phase !== 'playing') {
        return;
      }

      const current = localStateRef.current;
      if (!current || current.gameOver) {
        return;
      }

      if (event.key === 'a' || event.key === 'A' || event.key === 'ArrowLeft') {
        event.preventDefault();
        commitLocalState(moveHorizontal(current, -1));
        return;
      }
      if (event.key === 'd' || event.key === 'D' || event.key === 'ArrowRight') {
        event.preventDefault();
        commitLocalState(moveHorizontal(current, 1));
        return;
      }
      if (event.key === 'w' || event.key === 'W' || event.key === 'ArrowUp') {
        event.preventDefault();
        commitLocalState(rotateCurrent(current));
        return;
      }
      if (event.key === 's' || event.key === 'S' || event.key === 'ArrowDown') {
        event.preventDefault();
        void stepLocal();
      }
    };

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [commitLocalState, phase, stepLocal]);

  const localBoard = useMemo(() => {
    if (!localState) {
      return createEmptyBoard();
    }
    return withActivePiece(localState);
  }, [localState]);

  const onlineSummary = (
    <div className="grid gap-3 sm:grid-cols-3">
      <Card className="border-slate-700/60 bg-slate-900/50 py-3 shadow-none">
        <CardHeader className="px-4 py-0">
          <CardTitle className="text-xs uppercase tracking-[0.2em] text-slate-400">我的分数</CardTitle>
        </CardHeader>
        <CardContent className="px-4">
          <p className="mt-2 text-2xl font-black text-cyan-300">{localState?.score ?? 0}</p>
        </CardContent>
      </Card>
      <Card className="border-slate-700/60 bg-slate-900/50 py-3 shadow-none">
        <CardHeader className="px-4 py-0">
          <CardTitle className="text-xs uppercase tracking-[0.2em] text-slate-400">对手分数</CardTitle>
        </CardHeader>
        <CardContent className="px-4">
          <p className="mt-2 text-2xl font-black text-orange-300">{remoteScore}</p>
        </CardContent>
      </Card>
      <Card className="border-slate-700/60 bg-slate-900/50 py-3 shadow-none">
        <CardHeader className="px-4 py-0">
          <CardTitle className="text-xs uppercase tracking-[0.2em] text-slate-400">待处理垃圾</CardTitle>
        </CardHeader>
        <CardContent className="px-4">
          <p className="mt-2 text-2xl font-black text-fuchsia-300">{localState?.pendingGarbage ?? 0}</p>
        </CardContent>
      </Card>
    </div>
  );

  const displayMyReady = phase === 'ended' ? rematchLocalReady : myReady;
  const displayOpponentReady = phase === 'ended' ? rematchRemoteReady : opponentReady;
  const readyButtonLabel =
    phase === 'ended'
      ? rematchLocalReady
        ? '等待就绪'
        : '再来一局'
      : myReady
        ? '取消就绪'
        : '准备就绪';

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-2xl font-black tracking-tight text-white">联网对战</h2>
          <p className="text-sm text-slate-400">
            规则：消 2/3/4 行会发送 2/3/4 行垃圾，断线 30 秒超时判负
          </p>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" onClick={onBack} className="border-slate-600 bg-slate-900/70 text-slate-200">
            返回菜单
          </Button>
          {match && (
            <Button
              variant="outline"
              onClick={() => void leaveRoom()}
              className="border-rose-400/50 bg-rose-950/30 text-rose-200 hover:bg-rose-900/40"
            >
              离开房间
            </Button>
          )}
        </div>
      </div>

      <Card className="border-slate-700/70 bg-slate-900/55 py-4 shadow-[0_0_70px_rgba(16,185,129,0.08)]">
        <CardHeader className="px-4 pb-0">
          <CardTitle className="text-sm font-semibold text-slate-100">房间与连接状态</CardTitle>
          <CardDescription className="text-xs text-slate-400">{statusText}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3 px-4">
          {!match && (
            <div className="grid gap-3 sm:grid-cols-[1fr_auto_auto]">
              <Input
                value={roomInput}
                onChange={(event) => setRoomInput(event.target.value.toUpperCase())}
                placeholder="输入房间码（6位）"
                maxLength={6}
                className="border-slate-700 bg-slate-950/70 text-slate-100"
              />
              <Button disabled={busy} onClick={() => void joinRoom()} className="bg-indigo-500 text-white hover:bg-indigo-400">
                加入房间
              </Button>
              <Button disabled={busy} onClick={() => void createRoom()} className="bg-emerald-500 text-slate-950 hover:bg-emerald-400">
                创建房间
              </Button>
            </div>
          )}

          {match && (
            <div className="space-y-3">
              <div className="flex flex-wrap items-center gap-2">
                <Badge className="bg-cyan-400/20 text-cyan-100">房间码 {match.room_code}</Badge>
                <Button
                  variant="outline"
                  onClick={() => void copyRoomCode()}
                  className="h-7 border-cyan-400/50 bg-cyan-500/10 px-2 text-cyan-100 hover:bg-cyan-500/20"
                >
                  <Copy className="mr-1 h-3.5 w-3.5" /> 复制
                </Button>
                <Badge className="bg-violet-400/20 text-violet-100">状态 {match.status}</Badge>
                <Badge className="bg-slate-200/10 text-slate-200">{isHost ? '你是房主' : '你是客人'}</Badge>
                <Badge className="bg-slate-200/10 text-slate-200">{profile?.is_anonymous ? '匿名账号（不计分）' : '注册账号（计分）'}</Badge>
              </div>

              {phase !== 'playing' && (
                <div className="flex flex-wrap items-center gap-2">
                  <Button
                    disabled={busy || (phase === 'ended' && rematchLocalReady)}
                    onClick={() => {
                      if (phase === 'ended') {
                        void requestRematchReady();
                        return;
                      }
                      void toggleReady();
                    }}
                    className="bg-amber-500 text-slate-950 hover:bg-amber-400"
                  >
                    {readyButtonLabel}
                  </Button>
                  <Badge
                    className={
                      displayMyReady
                        ? 'bg-emerald-500/20 text-emerald-100'
                        : 'bg-slate-500/20 text-slate-300'
                    }
                  >
                    我：{displayMyReady ? '已就绪' : '未就绪'}
                  </Badge>
                  <Badge
                    className={
                      displayOpponentReady
                        ? 'bg-emerald-500/20 text-emerald-100'
                        : 'bg-slate-500/20 text-slate-300'
                    }
                  >
                    对手：{displayOpponentReady ? '已就绪' : '未就绪'}
                  </Badge>
                </div>
              )}
            </div>
          )}
        </CardContent>
      </Card>

      {(phase === 'playing' || phase === 'ended') && (
        <>
          {onlineSummary}
          <div className="flex justify-center">
            <div className="grid w-fit gap-4 lg:grid-cols-2">
              <BoardGrid board={localBoard} gameOver={Boolean(localState?.gameOver)} title="You" />
              <BoardGrid board={remoteBoard} gameOver={remoteGameOver} title="Opponent" />
            </div>
          </div>
        </>
      )}

      {phase === 'playing' && localState && (
        <div className="grid gap-3 sm:grid-cols-[240px_1fr]">
          <NextBlockCard blockType={localState.nextBlock} />
          <Card className="border-slate-700/60 bg-slate-900/50 py-3 shadow-none">
            <CardContent className="space-y-1 px-4">
              <p className="text-sm text-slate-300">实时同步：方块落地状态 + 垃圾行事件</p>
              <p className="text-xs text-slate-500">快照策略：每 10 秒或每 8 次落地（仅房主写库）</p>
            </CardContent>
          </Card>
        </div>
      )}

      {winnerText && (
        <Card className="border-emerald-400/40 bg-emerald-500/10 py-3 shadow-none">
          <CardContent className="px-4">
            <p className="text-sm font-semibold text-emerald-200">{winnerText}</p>
          </CardContent>
        </Card>
      )}
    </div>
  );
}

function HomePageContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const requestedMode = searchParams.get('mode');
  const popupMode = searchParams.get('popup') === '1';
  const initialMatchId = searchParams.get('matchId');

  const [mode, setMode] = useState<Mode>(
    popupMode && (requestedMode === 'single' || requestedMode === 'online')
      ? requestedMode
      : 'menu',
  );

  const [session, setSession] = useState<Session | null>(null);
  const [profile, setProfile] = useState<ProfileRow | null>(null);
  const [loading, setLoading] = useState(true);
  const [authMessage, setAuthMessage] = useState('');

  const [loginEmail, setLoginEmail] = useState('');
  const [loginPassword, setLoginPassword] = useState('');
  const [registerName, setRegisterName] = useState('');
  const [registerEmail, setRegisterEmail] = useState('');
  const [registerPassword, setRegisterPassword] = useState('');
  const [authBusy, setAuthBusy] = useState(false);
  const [authTab, setAuthTab] = useState<'login' | 'register'>('login');

  const navigateToMode = useCallback(
    (nextMode: 'single' | 'online', matchId?: string) => {
      const params = new URLSearchParams();
      params.set('mode', nextMode);
      params.set('popup', '1');
      if (matchId) {
        params.set('matchId', matchId);
      }
      router.push(`/?${params.toString()}`);
    },
    [router],
  );

  const refreshProfile = useCallback(async () => {
    try {
      const nextProfile = await fetchMyProfile();
      setProfile(nextProfile);
    } catch (error) {
      setAuthMessage(`读取用户资料失败：${error instanceof Error ? error.message : 'unknown error'}`);
    }
  }, []);

  useEffect(() => {
    if (
      popupMode &&
      (requestedMode === 'single' || requestedMode === 'online')
    ) {
      setMode(requestedMode);
      return;
    }
    setMode('menu');
  }, [popupMode, requestedMode]);

  useEffect(() => {
    let active = true;

    const bootstrap = async () => {
      try {
        const currentSession = await ensureAnonymousSession();
        if (!active) {
          return;
        }
        setSession(currentSession);
        const currentProfile = await fetchMyProfile();
        if (!active) {
          return;
        }
        setProfile(currentProfile);
      } catch (error) {
        if (active) {
          const message =
            error instanceof Error ? error.message : 'unknown error';
          if (message.includes('Anonymous sign-ins are disabled')) {
            setAuthMessage(
              '当前 Supabase 项目未开启匿名登录。请在 Auth > Providers > Anonymous 启用后刷新页面。',
            );
          } else {
            setAuthMessage(`初始化失败：${message}`);
          }
        }
      } finally {
        if (active) {
          setLoading(false);
        }
      }
    };

    void bootstrap();

    const {
      data: { subscription },
    } = onAuthStateChange((_event, nextSession) => {
      setSession(nextSession);
      if (nextSession) {
        void refreshProfile();
      } else {
        setProfile(null);
      }
    });

    return () => {
      active = false;
      subscription.unsubscribe();
    };
  }, [refreshProfile]);

  const login = useCallback(async () => {
    if (!loginEmail.trim() || !loginPassword) {
      setAuthMessage('请填写邮箱和密码');
      return;
    }

    setAuthBusy(true);
    try {
      const nextSession = await signInWithPassword(loginEmail.trim(), loginPassword);
      setSession(nextSession);
      await refreshProfile();
      setAuthMessage('登录成功');
      setLoginPassword('');
    } catch (error) {
      setAuthMessage(`登录失败：${error instanceof Error ? error.message : 'unknown error'}`);
    } finally {
      setAuthBusy(false);
    }
  }, [loginEmail, loginPassword, refreshProfile]);

  const register = useCallback(async () => {
    if (!registerEmail.trim() || !registerPassword || !registerName.trim()) {
      setAuthMessage('注册请填写昵称、邮箱和密码');
      return;
    }

    setAuthBusy(true);
    try {
      await ensureAnonymousSession();
      const nextSession = await registerOrUpgrade(
        registerEmail.trim(),
        registerPassword,
        registerName.trim(),
      );

      let finalSession = nextSession;
      if (!finalSession) {
        try {
          finalSession = await signInWithPassword(
            registerEmail.trim(),
            registerPassword,
          );
        } catch {
          finalSession = null;
        }
      }

      if (finalSession) {
        setSession(finalSession);
        await markProfileRegistered();
        await refreshProfile();
        setAuthTab('login');
        setAuthMessage('注册成功，已自动登录并开启积分功能');
      } else {
        setAuthMessage('注册成功，但当前 Supabase 仍要求邮箱验证，请关闭邮箱验证后重试');
      }
      setRegisterPassword('');
    } catch (error) {
      setAuthMessage(`注册失败：${error instanceof Error ? error.message : 'unknown error'}`);
    } finally {
      setAuthBusy(false);
    }
  }, [refreshProfile, registerEmail, registerName, registerPassword]);

  const backToAnonymous = useCallback(async () => {
    setAuthBusy(true);
    try {
      const nextSession = await signOutAndReturnAnonymous();
      setSession(nextSession);
      await refreshProfile();
      router.push('/');
      setAuthMessage('已登出，已切换到匿名模式');
    } catch (error) {
      setAuthMessage(`切换失败：${error instanceof Error ? error.message : 'unknown error'}`);
    } finally {
      setAuthBusy(false);
    }
  }, [refreshProfile, router]);

  useEffect(() => {
    if (profile?.is_anonymous === false) {
      setAuthTab('login');
    }
  }, [profile?.is_anonymous]);

  if (loading) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-slate-950 text-slate-200">
        <span>正在初始化会话...</span>
      </div>
    );
  }

  const isAnonymous = profile?.is_anonymous ?? true;
  const authLocked = !isAnonymous;

  return (
    <div className="min-h-screen bg-[radial-gradient(circle_at_20%_10%,rgba(56,189,248,0.25),transparent_38%),radial-gradient(circle_at_80%_0%,rgba(16,185,129,0.24),transparent_34%),linear-gradient(145deg,#020617,#111827_55%,#1e293b)] px-4 py-6 text-slate-100 sm:px-6 lg:px-10">
      <div className="mx-auto max-w-6xl space-y-5">
        {!popupMode && (
          <Card className="overflow-hidden border-slate-700/80 bg-slate-900/70 py-0 shadow-[0_0_120px_rgba(14,165,233,0.12)]">
            <CardHeader className="relative gap-4 border-b border-slate-700/70 px-5 py-5 sm:px-6">
              <div className="absolute -right-20 -top-14 h-48 w-48 rounded-full bg-cyan-500/15 blur-3xl" />
              <div className="flex flex-wrap items-start justify-between gap-4">
                <div>
                  <CardTitle className="text-3xl font-black tracking-tight text-white sm:text-4xl">
                    RussiaBricks Arena
                  </CardTitle>
                  <CardDescription className="mt-1 text-sm text-slate-300">
                    单机冲榜 + 联网房间对战（Supabase Realtime）
                  </CardDescription>
                </div>
                <div className="flex flex-wrap gap-2">
                  <Badge className="bg-amber-400/20 text-amber-100">
                    试玩版，提建议请联系微信：13818258128
                  </Badge>
                </div>
              </div>
            </CardHeader>

            <CardContent className="space-y-5 px-5 py-5 sm:px-6">
              <div className="grid gap-3 lg:grid-cols-[1fr_340px]">
                <div className="grid gap-3 sm:grid-cols-2">
                  <button
                    type="button"
                    onClick={() => navigateToMode('single')}
                    className="rounded-2xl border border-cyan-400/30 bg-cyan-500/10 p-4 text-left transition hover:-translate-y-0.5 hover:bg-cyan-500/20"
                  >
                    <div className="mb-2 flex items-center gap-2 text-cyan-200">
                      <Gamepad2 className="h-4 w-4" />
                      <span className="text-xs uppercase tracking-[0.2em]">Single</span>
                    </div>
                    <p className="text-lg font-bold text-white">单机模式</p>
                    <p className="mt-1 text-xs text-slate-300">挑战电脑突破修为，按境界与胜场上榜</p>
                  </button>

                  <button
                    type="button"
                    onClick={() => navigateToMode('online')}
                    className="rounded-2xl border border-emerald-400/30 bg-emerald-500/10 p-4 text-left transition hover:-translate-y-0.5 hover:bg-emerald-500/20"
                  >
                    <div className="mb-2 flex items-center gap-2 text-emerald-200">
                      <Swords className="h-4 w-4" />
                      <span className="text-xs uppercase tracking-[0.2em]">Online</span>
                    </div>
                    <p className="text-lg font-bold text-white">联网双人房</p>
                    <p className="mt-1 text-xs text-slate-300">进入房间大厅，双方就绪后自动进入对局</p>
                  </button>

                  <Link
                    href="/leaderboard"
                    className="rounded-2xl border border-amber-300/40 bg-amber-300/10 p-4 text-left transition hover:-translate-y-0.5 hover:bg-amber-300/20"
                  >
                    <div className="mb-2 flex items-center gap-2 text-amber-100">
                      <Trophy className="h-4 w-4" />
                      <span className="text-xs uppercase tracking-[0.2em]">Leaderboard</span>
                    </div>
                    <p className="text-lg font-bold text-white">排行榜大厅</p>
                    <p className="mt-1 text-xs text-slate-300">单机榜 + 联网积分榜</p>
                  </Link>

                  <div className="rounded-2xl border border-fuchsia-400/30 bg-fuchsia-500/10 p-4 text-left">
                    <div className="mb-2 flex items-center gap-2 text-fuchsia-100">
                      <Gauge className="h-4 w-4" />
                      <span className="text-xs uppercase tracking-[0.2em]">Coming Soon</span>
                    </div>
                    <p className="text-lg font-bold text-white">新功能开发中...</p>
                    <p className="mt-1 text-xs text-slate-300">敬请期待更多玩法与活动</p>
                  </div>
                </div>

                <Card className="border-slate-700/70 bg-slate-950/55 py-4 shadow-none">
                  <CardHeader className="px-4 py-0">
                    <CardTitle className="text-sm text-slate-100">账号与身份</CardTitle>
                    <CardDescription className="text-xs text-slate-400">
                      匿名可玩联机；注册后才累计积分并进排行榜
                    </CardDescription>
                  </CardHeader>
                  <CardContent className="space-y-3 px-4">
                    <div className="flex items-center justify-between rounded-lg border border-slate-700/70 bg-slate-900/70 px-3 py-2">
                      <div className="text-xs text-slate-300">
                        <p className="font-semibold text-slate-100">{profile?.display_name ?? 'Player'}</p>
                        <p className="text-slate-400">UID {session?.user.id.slice(0, 8)}...</p>
                      </div>
                      <Badge className={isAnonymous ? 'bg-slate-500/20 text-slate-200' : 'bg-emerald-500/20 text-emerald-100'}>
                        {isAnonymous ? '匿名' : '已登录'}
                      </Badge>
                    </div>

                    <Tabs
                      value={authTab}
                      onValueChange={(value) => {
                        if (!authLocked) {
                          setAuthTab(value as 'login' | 'register');
                        }
                      }}
                      className={`space-y-3 ${authLocked ? 'opacity-50' : ''}`}
                    >
                      <TabsList className="w-full bg-slate-900/90 p-1">
                        <TabsTrigger
                          value="login"
                          disabled={authLocked}
                          className="flex-1 border border-transparent text-slate-200 hover:text-white disabled:cursor-not-allowed disabled:opacity-60 data-[state=active]:border-indigo-300/40 data-[state=active]:bg-indigo-500 data-[state=active]:text-white"
                        >
                          登录
                        </TabsTrigger>
                        <TabsTrigger
                          value="register"
                          disabled={authLocked}
                          className="flex-1 border border-transparent text-slate-200 hover:text-white disabled:cursor-not-allowed disabled:opacity-60 data-[state=active]:border-emerald-300/40 data-[state=active]:bg-emerald-500 data-[state=active]:text-slate-950"
                        >
                          注册
                        </TabsTrigger>
                      </TabsList>

                      <TabsContent value="login" className="space-y-2">
                        <Input
                          value={loginEmail}
                          onChange={(event) => setLoginEmail(event.target.value)}
                          placeholder="登录邮箱"
                          disabled={authBusy || authLocked}
                          className="border-slate-700 bg-slate-950/70 text-slate-100"
                        />
                        <Input
                          value={loginPassword}
                          onChange={(event) => setLoginPassword(event.target.value)}
                          placeholder="登录密码"
                          type="password"
                          disabled={authBusy || authLocked}
                          className="border-slate-700 bg-slate-950/70 text-slate-100"
                        />
                        <Button
                          disabled={authBusy || authLocked}
                          onClick={() => void login()}
                          className="w-full bg-indigo-500 text-white hover:bg-indigo-400"
                        >
                          <User className="mr-1 h-4 w-4" /> 登录
                        </Button>
                      </TabsContent>

                      <TabsContent value="register" className="space-y-2">
                        <Input
                          value={registerName}
                          onChange={(event) => setRegisterName(event.target.value)}
                          placeholder="注册昵称"
                          disabled={authBusy || authLocked}
                          className="border-slate-700 bg-slate-950/70 text-slate-100"
                        />
                        <Input
                          value={registerEmail}
                          onChange={(event) => setRegisterEmail(event.target.value)}
                          placeholder="注册邮箱"
                          disabled={authBusy || authLocked}
                          className="border-slate-700 bg-slate-950/70 text-slate-100"
                        />
                        <Input
                          value={registerPassword}
                          onChange={(event) => setRegisterPassword(event.target.value)}
                          placeholder="注册密码"
                          type="password"
                          disabled={authBusy || authLocked}
                          className="border-slate-700 bg-slate-950/70 text-slate-100"
                        />
                        <Button
                          disabled={authBusy || authLocked}
                          onClick={() => void register()}
                          className="w-full bg-emerald-500 text-slate-950 hover:bg-emerald-400"
                        >
                          <UserRoundPlus className="mr-1 h-4 w-4" /> 注册并登录
                        </Button>
                      </TabsContent>
                    </Tabs>

                    <Button
                      variant="outline"
                      disabled={authBusy}
                      onClick={() => void backToAnonymous()}
                      className="w-full border-slate-600 bg-slate-900/70 text-slate-200"
                    >
                      <LogOut className="mr-1 h-4 w-4" /> 登出
                    </Button>

                    {authMessage && (
                      <p className="rounded-md border border-slate-700/70 bg-slate-900/70 px-2 py-1 text-xs text-slate-300">
                        {authMessage}
                      </p>
                    )}
                  </CardContent>
                </Card>
              </div>
            </CardContent>
          </Card>
        )}

        {popupMode && (
          <Card className="border-slate-700/70 bg-slate-900/60 py-3">
            <CardContent className="flex items-center justify-between gap-3 px-4 sm:px-6">
              <p className="text-sm text-slate-300">{mode === 'online' ? '联网模式' : '单机模式'}</p>
              <Link href="/" className="text-sm text-cyan-200 underline underline-offset-4">
                返回主页
              </Link>
            </CardContent>
          </Card>
        )}

        {mode === 'single' && (
          <Card className="border-slate-700/80 bg-slate-900/65 py-4 shadow-[0_0_80px_rgba(6,182,212,0.08)]">
            <CardContent className="px-4 sm:px-6">
              <SingleMode
                onBack={() => router.push('/')}
                onProgressSettled={refreshProfile}
                profile={profile}
              />
            </CardContent>
          </Card>
        )}

        {mode === 'online' && session && (
          <Card className="border-slate-700/80 bg-slate-900/65 py-4 shadow-[0_0_80px_rgba(52,211,153,0.08)]">
            <CardContent className="px-4 sm:px-6">
              <OnlineMode
                session={session}
                profile={profile}
                onProfileRefresh={refreshProfile}
                onBack={() => router.push('/')}
                initialMatchId={initialMatchId}
              />
            </CardContent>
          </Card>
        )}

        {mode === 'menu' && (
          <Card className="border-slate-700/70 bg-slate-900/50 py-3">
            <CardContent className="flex flex-wrap items-center justify-between gap-3 px-4 text-xs text-slate-300 sm:px-6">
              <div className="flex items-center gap-2">
                <Wifi className="h-4 w-4 text-cyan-300" />
                <span>联机规则：双方就绪后开始，断线 30 秒未重连判负</span>
              </div>
              <div className="flex items-center gap-2">
                <Users className="h-4 w-4 text-emerald-300" />
                <span>垃圾行：一次消除 2/3/4 行，会给对手发送 2/3/4 行；单消不发送</span>
              </div>
              <div className="flex items-center gap-2">
                <Rocket className="h-4 w-4 text-violet-300" />
                <span>积分规则：注册账号联机胜一局 +3，负一局 +0；匿名模式不计分</span>
              </div>
              <div className="flex items-center gap-2">
                <Gamepad2 className="h-4 w-4 text-cyan-200" />
                <span>操作键：A/D 左右移动，W 旋转，S 加速下落</span>
              </div>
            </CardContent>
          </Card>
        )}
      </div>
    </div>
  );
}

export default function HomePage() {
  return (
    <Suspense fallback={null}>
      <HomePageContent />
    </Suspense>
  );
}
