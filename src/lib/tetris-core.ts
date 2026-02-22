export type BlockType = 'I' | 'O' | 'T' | 'S' | 'Z' | 'J' | 'L';

export type BoardCell = string | null;

export interface PlayerGameState {
  board: BoardCell[][];
  currentBlock: BlockType;
  currentShape: number[][];
  currentPos: { row: number; col: number };
  nextBlock: BlockType;
  score: number;
  totalCleared: number;
  gameOver: boolean;
  pendingGarbage: number;
}

export interface StepResult {
  nextState: PlayerGameState;
  locked: boolean;
  clearedLines: number;
  sentGarbage: number;
}

export interface PieceGenerator {
  next: () => BlockType;
}

export const ROWS = 20;
export const COLS = 10;

const BLOCK_TYPES: BlockType[] = ['I', 'O', 'T', 'S', 'Z', 'J', 'L'];

export const BLOCK_SHAPES: Record<BlockType, number[][]> = {
  I: [[1, 1, 1, 1]],
  O: [[1, 1], [1, 1]],
  T: [[0, 1, 0], [1, 1, 1]],
  S: [[0, 1, 1], [1, 1, 0]],
  Z: [[1, 1, 0], [0, 1, 1]],
  J: [[1, 0, 0], [1, 1, 1]],
  L: [[0, 0, 1], [1, 1, 1]],
};

export const BLOCK_COLORS: Record<BlockType, string> = {
  I: '#17d4ff',
  O: '#ffd447',
  T: '#bb7cff',
  S: '#5ce86b',
  Z: '#ff5d76',
  J: '#4e6dff',
  L: '#ff9d40',
};

const GARBAGE_COLORS = [
  '#4ECDC4',
  '#45B7D1',
  '#96CEB4',
  '#F7DC6F',
  '#BB8FCE',
  '#85C1E9',
];

const createMulberry32 = (seed: number) => {
  let state = seed >>> 0;
  return () => {
    state += 0x6d2b79f5;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};

const cloneBoard = (board: BoardCell[][]): BoardCell[][] =>
  board.map((row) => [...row]);

const shuffleBag = (bag: BlockType[], random: () => number): BlockType[] => {
  const next = [...bag];
  for (let i = next.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [next[i], next[j]] = [next[j], next[i]];
  }
  return next;
};

const normalizeSeed = (seed: number): number => {
  const safe = Number.isFinite(seed) ? Math.floor(seed) : Date.now();
  return safe >>> 0;
};

export const createPieceGenerator = (seed: number): PieceGenerator => {
  const random = createMulberry32(normalizeSeed(seed));
  let bag: BlockType[] = [];

  return {
    next: () => {
      if (bag.length === 0) {
        bag = shuffleBag(BLOCK_TYPES, random);
      }
      const next = bag.shift();
      if (!next) {
        return 'I';
      }
      return next;
    },
  };
};

export const createEmptyBoard = (): BoardCell[][] =>
  Array.from({ length: ROWS }, () => Array(COLS).fill(null));

export const rotateShape = (shape: number[][]): number[][] => {
  const rows = shape.length;
  const cols = shape[0]?.length ?? 0;
  const rotated: number[][] = Array.from({ length: cols }, () =>
    Array(rows).fill(0),
  );

  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      rotated[c][rows - 1 - r] = shape[r][c];
    }
  }

  return rotated;
};

export const checkCollision = (
  board: BoardCell[][],
  shape: number[][],
  row: number,
  col: number,
): boolean => {
  for (let r = 0; r < shape.length; r++) {
    for (let c = 0; c < shape[r].length; c++) {
      if (!shape[r][c]) {
        continue;
      }
      const nr = row + r;
      const nc = col + c;
      if (nr < 0 || nr >= ROWS || nc < 0 || nc >= COLS || board[nr][nc]) {
        return true;
      }
    }
  }
  return false;
};

export const lockBlock = (
  board: BoardCell[][],
  shape: number[][],
  row: number,
  col: number,
  blockType: BlockType,
): BoardCell[][] => {
  const nextBoard = cloneBoard(board);
  for (let r = 0; r < shape.length; r++) {
    for (let c = 0; c < shape[r].length; c++) {
      if (!shape[r][c]) {
        continue;
      }
      const nr = row + r;
      const nc = col + c;
      if (nr >= 0 && nr < ROWS && nc >= 0 && nc < COLS) {
        nextBoard[nr][nc] = BLOCK_COLORS[blockType];
      }
    }
  }
  return nextBoard;
};

export const clearLines = (board: BoardCell[][]) => {
  const remaining = board.filter((row) => !row.every((cell) => cell !== null));
  const clearedLines = ROWS - remaining.length;
  while (remaining.length < ROWS) {
    remaining.unshift(Array(COLS).fill(null));
  }
  return {
    nextBoard: remaining,
    clearedLines,
  };
};

export const addGarbageLines = (
  board: BoardCell[][],
  count: number,
  randomSeed?: number,
): BoardCell[][] => {
  if (count <= 0) {
    return board;
  }
  const nextBoard = cloneBoard(board);
  const random = createMulberry32(
    normalizeSeed((randomSeed ?? Date.now()) + count * 17),
  );

  for (let i = 0; i < count; i++) {
    nextBoard.shift();
    const rowColor =
      GARBAGE_COLORS[Math.floor(random() * GARBAGE_COLORS.length)] ??
      '#6b7280';
    const garbageRow: BoardCell[] = Array(COLS).fill(rowColor);
    const holes = Math.floor(random() * 2) + 2;
    for (let j = 0; j < holes; j++) {
      const holeCol = Math.floor(random() * COLS);
      garbageRow[holeCol] = null;
    }
    nextBoard.push(garbageRow);
  }

  return nextBoard;
};

const centerColFor = (shape: number[][]): number =>
  Math.floor(COLS / 2) - Math.floor((shape[0]?.length ?? 1) / 2);

export const createInitialState = (
  generator: PieceGenerator,
): PlayerGameState => {
  const block = generator.next();
  const nextBlock = generator.next();
  const shape = BLOCK_SHAPES[block];
  return {
    board: createEmptyBoard(),
    currentBlock: block,
    currentShape: shape,
    currentPos: { row: 0, col: centerColFor(shape) },
    nextBlock,
    score: 0,
    totalCleared: 0,
    gameOver: false,
    pendingGarbage: 0,
  };
};

const spawnNextPiece = (
  state: PlayerGameState,
  generator: PieceGenerator,
): PlayerGameState => {
  const currentBlock = state.nextBlock;
  const currentShape = BLOCK_SHAPES[currentBlock];
  const spawnCol = centerColFor(currentShape);
  const spawnCollision = checkCollision(state.board, currentShape, 0, spawnCol);
  return {
    ...state,
    currentBlock,
    currentShape,
    currentPos: { row: 0, col: spawnCol },
    nextBlock: generator.next(),
    gameOver: spawnCollision,
  };
};

export const moveHorizontal = (
  state: PlayerGameState,
  deltaCol: -1 | 1,
): PlayerGameState => {
  if (state.gameOver) {
    return state;
  }
  const nextCol = state.currentPos.col + deltaCol;
  if (
    checkCollision(state.board, state.currentShape, state.currentPos.row, nextCol)
  ) {
    return state;
  }
  return {
    ...state,
    currentPos: { ...state.currentPos, col: nextCol },
  };
};

export const rotateCurrent = (state: PlayerGameState): PlayerGameState => {
  if (state.gameOver) {
    return state;
  }
  const rotated = rotateShape(state.currentShape);
  if (
    checkCollision(
      state.board,
      rotated,
      state.currentPos.row,
      state.currentPos.col,
    )
  ) {
    return state;
  }
  return {
    ...state,
    currentShape: rotated,
  };
};

export const applyPendingGarbage = (
  state: PlayerGameState,
  randomSeed?: number,
): PlayerGameState => {
  if (state.pendingGarbage <= 0) {
    return state;
  }
  return {
    ...state,
    board: addGarbageLines(state.board, state.pendingGarbage, randomSeed),
    pendingGarbage: 0,
  };
};

export const stepDown = (
  state: PlayerGameState,
  generator: PieceGenerator,
): StepResult => {
  if (state.gameOver) {
    return {
      nextState: state,
      locked: false,
      clearedLines: 0,
      sentGarbage: 0,
    };
  }

  const nextRow = state.currentPos.row + 1;
  if (!checkCollision(state.board, state.currentShape, nextRow, state.currentPos.col)) {
    return {
      nextState: {
        ...state,
        currentPos: { ...state.currentPos, row: nextRow },
      },
      locked: false,
      clearedLines: 0,
      sentGarbage: 0,
    };
  }

  let nextBoard = lockBlock(
    state.board,
    state.currentShape,
    state.currentPos.row,
    state.currentPos.col,
    state.currentBlock,
  );
  const { nextBoard: boardAfterClear, clearedLines } = clearLines(nextBoard);
  nextBoard = boardAfterClear;

  const updated: PlayerGameState = {
    ...state,
    board: nextBoard,
    score: state.score + clearedLines * 100,
    totalCleared: state.totalCleared + clearedLines,
  };

  const afterSpawn = spawnNextPiece(updated, generator);
  const sentGarbage = clearedLines >= 2 ? clearedLines : 0;

  return {
    nextState: afterSpawn,
    locked: true,
    clearedLines,
    sentGarbage,
  };
};

export const withActivePiece = (state: PlayerGameState): BoardCell[][] => {
  const board = cloneBoard(state.board);
  if (state.gameOver) {
    return board;
  }
  for (let r = 0; r < state.currentShape.length; r++) {
    for (let c = 0; c < state.currentShape[r].length; c++) {
      if (!state.currentShape[r][c]) {
        continue;
      }
      const nr = state.currentPos.row + r;
      const nc = state.currentPos.col + c;
      if (nr >= 0 && nr < ROWS && nc >= 0 && nc < COLS) {
        board[nr][nc] = BLOCK_COLORS[state.currentBlock];
      }
    }
  }
  return board;
};
