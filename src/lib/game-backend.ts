import type {
  AuthChangeEvent,
  RealtimeChannel,
  Session,
  SupabaseClient,
  User,
} from '@supabase/supabase-js';
import { getSupabaseClient } from '@/lib/supabase-client';

export interface ProfileRow {
  user_id: string;
  display_name: string;
  avatar_url: string | null;
  is_anonymous: boolean;
  created_at: string;
  updated_at: string;
}

export interface PlayerStatsRow {
  user_id: string;
  single_high_score: number;
  single_total_lines: number;
  single_realm_level: number;
  single_ai_wins: number;
  online_points: number;
  online_wins: number;
  online_losses: number;
  online_matches_played: number;
  created_at: string;
  updated_at: string;
}

export type MatchStatus = 'waiting' | 'playing' | 'ended' | 'aborted';

export interface MatchRow {
  id: string;
  room_code: string;
  status: MatchStatus;
  host_user_id: string;
  guest_user_id: string | null;
  seed: number;
  host_ready: boolean;
  guest_ready: boolean;
  winner_user_id: string | null;
  disconnect_user_id: string | null;
  disconnect_deadline: string | null;
  end_reason: 'normal' | 'disconnect_timeout' | 'forfeit' | 'abort' | null;
  started_at: string | null;
  ended_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface MatchSnapshotRow {
  id: number;
  match_id: string;
  version: number;
  from_user_id: string;
  host_seq: number;
  guest_seq: number;
  host_board_fixed: unknown;
  guest_board_fixed: unknown;
  host_score: number;
  guest_score: number;
  host_pending_garbage: number;
  guest_pending_garbage: number;
  created_at: string;
}

export interface SingleLeaderboardRow {
  rank: number;
  user_id: string;
  display_name: string;
  single_realm_level: number;
  single_ai_wins: number;
  updated_at: string;
}

export interface OnlineLeaderboardRow {
  rank: number;
  user_id: string;
  display_name: string;
  online_points: number;
  online_wins: number;
  online_losses: number;
  online_matches_played: number;
  win_rate_percent: number;
  updated_at: string;
}

type AuthListener = (event: AuthChangeEvent, session: Session | null) => void;

const client = (): SupabaseClient => getSupabaseClient();

const unwrap = <T>(value: T | null, error: { message: string } | null): T => {
  if (error || value === null) {
    throw new Error(error?.message ?? 'Unexpected empty response');
  }
  return value;
};

export const getCurrentSession = async (): Promise<Session | null> => {
  const { data, error } = await client().auth.getSession();
  if (error) {
    throw new Error(error.message);
  }
  return data.session;
};

export const getCurrentUser = async (): Promise<User | null> => {
  const session = await getCurrentSession();
  return session?.user ?? null;
};

export const onAuthStateChange = (listener: AuthListener) =>
  client().auth.onAuthStateChange(listener);

export const ensureAnonymousSession = async (): Promise<Session> => {
  const existing = await getCurrentSession();
  if (existing) {
    return existing;
  }
  const { data, error } = await client().auth.signInAnonymously();
  if (error || !data.session) {
    throw new Error(error?.message ?? 'Anonymous sign-in failed');
  }
  return data.session;
};

export const signOutAndReturnAnonymous = async (): Promise<Session> => {
  const { error } = await client().auth.signOut();
  if (error) {
    throw new Error(error.message);
  }
  return ensureAnonymousSession();
};

export const signInWithPassword = async (
  email: string,
  password: string,
): Promise<Session> => {
  const { data, error } = await client().auth.signInWithPassword({
    email,
    password,
  });
  if (error || !data.session) {
    throw new Error(error?.message ?? 'Login failed');
  }
  return data.session;
};

export const registerOrUpgrade = async (
  email: string,
  password: string,
  displayName: string,
): Promise<Session | null> => {
  const current = await getCurrentSession();
  if (current?.user?.app_metadata?.provider === 'anonymous') {
    const { error } = await client().auth.updateUser({
      email,
      password,
      data: { display_name: displayName },
    });
    if (error) {
      throw new Error(error.message);
    }
    await client()
      .from('profiles')
      .update({
        display_name: displayName,
      })
      .eq('user_id', current.user.id);
    await markProfileRegistered();
    return await getCurrentSession();
  }

  const { data, error } = await client().auth.signUp({
    email,
    password,
    options: {
      data: { display_name: displayName },
    },
  });
  if (error) {
    throw new Error(error.message);
  }
  if (data.session) {
    await markProfileRegistered();
  }
  return data.session;
};

export const fetchMyProfile = async (): Promise<ProfileRow | null> => {
  const user = await getCurrentUser();
  if (!user) {
    return null;
  }
  const { data, error } = await client()
    .from('profiles')
    .select('*')
    .eq('user_id', user.id)
    .maybeSingle();

  if (error) {
    throw new Error(error.message);
  }
  return data as ProfileRow | null;
};

export const markProfileRegistered = async (): Promise<ProfileRow> => {
  const { data, error } = await client().rpc('mark_profile_registered');
  return unwrap(data as ProfileRow | null, error);
};

export const submitSingleScore = async (
  score: number,
  lines: number,
): Promise<PlayerStatsRow> => {
  const { data, error } = await client().rpc('submit_single_score', {
    p_score: score,
    p_lines: lines,
  });
  return unwrap(data as PlayerStatsRow | null, error);
};

export const submitSingleAiResult = async (
  isWin: boolean,
): Promise<PlayerStatsRow> => {
  const { data, error } = await client().rpc('submit_single_ai_result', {
    p_is_win: isWin,
  });
  return unwrap(data as PlayerStatsRow | null, error);
};

export const fetchMyPlayerStats = async (): Promise<PlayerStatsRow | null> => {
  const user = await getCurrentUser();
  if (!user) {
    return null;
  }

  const { data, error } = await client()
    .from('player_stats')
    .select('*')
    .eq('user_id', user.id)
    .maybeSingle();

  if (error) {
    throw new Error(error.message);
  }
  return data as PlayerStatsRow | null;
};

export const createMatchRoom = async (seed?: number): Promise<MatchRow> => {
  const { data, error } = await client().rpc('create_match_room', {
    p_seed: seed ?? null,
  });
  return unwrap(data as MatchRow | null, error);
};

export const joinMatchRoom = async (roomCode: string): Promise<MatchRow> => {
  const { data, error } = await client().rpc('join_match_room', {
    p_room_code: roomCode,
  });
  return unwrap(data as MatchRow | null, error);
};

export const setMatchReady = async (
  matchId: string,
  ready: boolean,
): Promise<MatchRow> => {
  const { data, error } = await client().rpc('set_match_ready', {
    p_match_id: matchId,
    p_is_ready: ready,
  });
  return unwrap(data as MatchRow | null, error);
};

export const setDisconnectDeadline = async (
  matchId: string,
  disconnectUserId: string,
  deadlineIso: string,
): Promise<MatchRow> => {
  const { data, error } = await client().rpc('set_disconnect_deadline', {
    p_match_id: matchId,
    p_disconnect_user_id: disconnectUserId,
    p_deadline: deadlineIso,
  });
  return unwrap(data as MatchRow | null, error);
};

export const clearDisconnectDeadline = async (
  matchId: string,
): Promise<MatchRow> => {
  const { data, error } = await client().rpc('clear_disconnect_deadline', {
    p_match_id: matchId,
  });
  return unwrap(data as MatchRow | null, error);
};

export const finishMatch = async (
  matchId: string,
  winnerUserId: string,
  reason: 'normal' | 'disconnect_timeout' | 'forfeit' | 'abort',
): Promise<MatchRow> => {
  const { data, error } = await client().rpc('finish_match', {
    p_match_id: matchId,
    p_winner_user_id: winnerUserId,
    p_end_reason: reason,
  });
  return unwrap(data as MatchRow | null, error);
};

export const fetchMatchById = async (matchId: string): Promise<MatchRow> => {
  const { data, error } = await client()
    .from('matches')
    .select('*')
    .eq('id', matchId)
    .single();

  return unwrap(data as MatchRow | null, error);
};

export const fetchLatestSnapshot = async (
  matchId: string,
): Promise<MatchSnapshotRow | null> => {
  const { data, error } = await client()
    .from('match_snapshots')
    .select('*')
    .eq('match_id', matchId)
    .order('version', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) {
    throw new Error(error.message);
  }
  return data as MatchSnapshotRow | null;
};

export const insertSnapshot = async (payload: {
  match_id: string;
  version: number;
  from_user_id: string;
  host_seq: number;
  guest_seq: number;
  host_board_fixed: unknown;
  guest_board_fixed: unknown;
  host_score: number;
  guest_score: number;
  host_pending_garbage: number;
  guest_pending_garbage: number;
}): Promise<MatchSnapshotRow> => {
  const { data, error } = await client()
    .from('match_snapshots')
    .insert(payload)
    .select('*')
    .single();
  return unwrap(data as MatchSnapshotRow | null, error);
};

export const fetchSingleLeaderboard = async (
  limit = 50,
): Promise<SingleLeaderboardRow[]> => {
  const { data, error } = await client()
    .from('single_mode_leaderboard')
    .select('*')
    .limit(limit);

  if (error) {
    throw new Error(error.message);
  }
  return (data ?? []) as SingleLeaderboardRow[];
};

export const fetchOnlineLeaderboard = async (
  limit = 50,
): Promise<OnlineLeaderboardRow[]> => {
  const { data, error } = await client()
    .from('online_mode_leaderboard')
    .select('*')
    .limit(limit);

  if (error) {
    throw new Error(error.message);
  }
  return (data ?? []) as OnlineLeaderboardRow[];
};

export const createMatchChannel = (matchId: string): RealtimeChannel =>
  client().channel(`match:${matchId}`, {
    config: {
      broadcast: { self: false },
      presence: { key: `user-${Date.now()}` },
    },
  });
