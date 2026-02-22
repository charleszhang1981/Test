'use client';

import Link from 'next/link';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { ArrowLeft, Crown, Medal, Trophy } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import {
  ensureAnonymousSession,
  fetchMyProfile,
  fetchOnlineLeaderboard,
  fetchSingleLeaderboard,
  type OnlineLeaderboardRow,
  type ProfileRow,
  type SingleLeaderboardRow,
} from '@/lib/game-backend';

type BoardTab = 'single' | 'online';
type BoardRow = SingleLeaderboardRow | OnlineLeaderboardRow;
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

const realmName = (level: number): string => {
  const safe = Math.min(8, Math.max(1, Math.floor(level || 1)));
  return REALM_NAMES[safe - 1];
};

const podiumPalettes = [
  {
    card: 'border-amber-300/60 from-amber-300/25 via-amber-200/10 to-transparent',
    rank: 'border-amber-300/80 bg-amber-200/70 text-slate-900',
    score: 'text-slate-900',
  },
  {
    card: 'border-slate-300/55 from-slate-200/25 via-slate-100/10 to-transparent',
    rank: 'border-slate-300/80 bg-slate-100/75 text-slate-900',
    score: 'text-slate-900',
  },
  {
    card: 'border-orange-300/55 from-orange-300/25 via-orange-200/10 to-transparent',
    rank: 'border-orange-300/80 bg-orange-200/75 text-slate-900',
    score: 'text-slate-900',
  },
] as const;

function Podium({
  rows,
  meId,
  mode,
}: {
  rows: BoardRow[];
  meId: string | null;
  mode: BoardTab;
}) {
  const top3 = rows.slice(0, 3);

  if (top3.length === 0) {
    return (
      <Card className="border-slate-700/70 bg-slate-900/60 py-4">
        <CardContent className="px-4 text-sm text-slate-300">
          暂无上榜数据，先去打一局吧。
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="grid gap-3 md:grid-cols-3">
      {top3.map((row, index) => {
        const palette = podiumPalettes[index] ?? podiumPalettes[2];
        const isMe = row.user_id === meId;
        const score =
          mode === 'single'
            ? realmName((row as SingleLeaderboardRow).single_realm_level)
            : `${(row as OnlineLeaderboardRow).online_points} 分`;
        const subline =
          mode === 'single'
            ? `胜场 ${(row as SingleLeaderboardRow).single_ai_wins}`
            : `胜场 ${(row as OnlineLeaderboardRow).online_wins} · 胜率 ${(row as OnlineLeaderboardRow).win_rate_percent}%`;

        return (
          <Card
            key={`${mode}-${row.user_id}`}
            className={`border bg-gradient-to-br py-4 shadow-[0_0_40px_rgba(15,23,42,0.35)] ${palette.card} ${
              isMe ? 'ring-2 ring-emerald-300/70' : ''
            }`}
          >
            <CardHeader className="space-y-2 px-4 py-0">
              <div className="flex items-center justify-between">
                <span
                  className={`inline-flex min-w-12 items-center justify-center rounded-full border px-2 py-1 text-xs font-black tracking-wide ${palette.rank}`}
                >
                  #{row.rank}
                </span>
                {index === 0 && <Crown className="h-4 w-4 text-amber-700" />}
              </div>
              <CardTitle className="truncate text-lg font-black tracking-tight text-slate-900">
                {row.display_name}
              </CardTitle>
              <CardDescription className="text-xs text-slate-700">
                {isMe ? '这是你' : 'Top 玩家'}
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-1 px-4">
              <p className={`text-2xl font-black ${palette.score}`}>{score}</p>
              <p className="text-xs text-slate-700">{subline}</p>
            </CardContent>
          </Card>
        );
      })}
    </div>
  );
}

function BoardTable({
  rows,
  mode,
  meId,
}: {
  rows: BoardRow[];
  mode: BoardTab;
  meId: string | null;
}) {
  return (
    <div className="overflow-hidden rounded-2xl border border-slate-700/70 bg-slate-900/60">
      <table className="w-full text-left text-sm">
        <thead className="bg-slate-950/70 text-xs uppercase tracking-[0.18em] text-slate-400">
          <tr>
            <th className="px-4 py-3">Rank</th>
            <th className="px-4 py-3">Player</th>
            {mode === 'single' ? (
              <>
                <th className="px-4 py-3">修为境界</th>
                <th className="px-4 py-3">电脑胜场</th>
              </>
            ) : (
              <>
                <th className="px-4 py-3">积分</th>
                <th className="px-4 py-3">战绩</th>
              </>
            )}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => {
            const isMe = row.user_id === meId;
            return (
              <tr
                key={`${mode}-${row.user_id}`}
                className={isMe ? 'bg-emerald-500/12' : 'odd:bg-slate-900/20'}
              >
                <td className="px-4 py-3 font-semibold text-slate-200">#{row.rank}</td>
                <td className="px-4 py-3">
                  <div className="flex items-center gap-2">
                    <span className="font-medium text-white">{row.display_name}</span>
                    {isMe && (
                      <Badge className="bg-emerald-500/20 text-emerald-100">我</Badge>
                    )}
                  </div>
                </td>
                {mode === 'single' ? (
                  <>
                    <td className="px-4 py-3 font-semibold text-cyan-300">
                      {realmName((row as SingleLeaderboardRow).single_realm_level)}
                    </td>
                    <td className="px-4 py-3 text-slate-300">
                      {(row as SingleLeaderboardRow).single_ai_wins}
                    </td>
                  </>
                ) : (
                  <>
                    <td className="px-4 py-3 font-semibold text-amber-300">
                      {(row as OnlineLeaderboardRow).online_points}
                    </td>
                    <td className="px-4 py-3 text-slate-300">
                      {(row as OnlineLeaderboardRow).online_wins}W-
                      {(row as OnlineLeaderboardRow).online_losses}L (
                      {(row as OnlineLeaderboardRow).win_rate_percent}%)
                    </td>
                  </>
                )}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

export default function LeaderboardPage() {
  const [profile, setProfile] = useState<ProfileRow | null>(null);
  const [singleRows, setSingleRows] = useState<SingleLeaderboardRow[]>([]);
  const [onlineRows, setOnlineRows] = useState<OnlineLeaderboardRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [tab, setTab] = useState<BoardTab>('single');

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      await ensureAnonymousSession();
      const [nextProfile, nextSingle, nextOnline] = await Promise.all([
        fetchMyProfile(),
        fetchSingleLeaderboard(100),
        fetchOnlineLeaderboard(100),
      ]);
      setProfile(nextProfile);
      setSingleRows(nextSingle);
      setOnlineRows(nextOnline);
    } catch (loadError) {
      setError(
        loadError instanceof Error ? loadError.message : 'failed to load leaderboards',
      );
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const meId = profile?.user_id ?? null;
  const currentRows = useMemo(
    () => (tab === 'single' ? singleRows : onlineRows),
    [onlineRows, singleRows, tab],
  );

  return (
    <div className="min-h-screen bg-[radial-gradient(circle_at_10%_0%,rgba(250,204,21,0.2),transparent_38%),radial-gradient(circle_at_100%_10%,rgba(56,189,248,0.18),transparent_35%),linear-gradient(155deg,#020617,#0f172a_52%,#1f2937)] px-4 py-6 text-slate-100 sm:px-6 lg:px-10">
      <div className="mx-auto max-w-6xl space-y-5">
        <Card className="border-slate-700/80 bg-slate-900/70 py-4 shadow-[0_0_120px_rgba(251,191,36,0.12)]">
          <CardHeader className="space-y-3 px-4 sm:px-6">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <CardTitle className="text-3xl font-black tracking-tight text-white sm:text-4xl">
                  Hall of Bricks
                </CardTitle>
                <CardDescription className="mt-1 text-sm text-slate-300">
                  排名前列会更亮、更高、更显眼
                </CardDescription>
              </div>
              <div className="flex items-center gap-2">
                <Link href="/">
                  <Button
                    variant="outline"
                    className="border-slate-600 bg-slate-900/70 text-slate-200"
                  >
                    <ArrowLeft className="mr-1 h-4 w-4" />
                    返回游戏
                  </Button>
                </Link>
                <Button
                  onClick={() => void load()}
                  className="bg-amber-400 text-slate-950 hover:bg-amber-300"
                >
                  刷新
                </Button>
              </div>
            </div>
            <div className="flex flex-wrap gap-2">
              <Badge className="bg-amber-500/20 text-amber-100">
                <Trophy className="mr-1 h-3 w-3" />
                Top3 奖台
              </Badge>
              <Badge className="bg-cyan-500/20 text-cyan-100">
                <Medal className="mr-1 h-3 w-3" />
                当前用户高亮
              </Badge>
              <Badge className="bg-slate-200/10 text-slate-200">
                匿名用户不进入排行榜
              </Badge>
            </div>
          </CardHeader>

          <CardContent className="space-y-4 px-4 sm:px-6">
            {loading ? (
              <Card className="border-slate-700/70 bg-slate-900/60 py-4">
                <CardContent className="px-4 text-sm text-slate-300">
                  正在加载榜单...
                </CardContent>
              </Card>
            ) : error ? (
              <Card className="border-rose-400/50 bg-rose-500/10 py-4">
                <CardContent className="px-4 text-sm text-rose-200">
                  加载失败：{error}
                </CardContent>
              </Card>
            ) : (
              <Tabs
                value={tab}
                onValueChange={(next) => setTab(next as BoardTab)}
                className="space-y-4"
              >
                <TabsList className="grid h-auto w-full max-w-md grid-cols-2 rounded-xl border border-slate-700/80 bg-slate-950/80 p-1">
                  <TabsTrigger
                    value="single"
                    className="rounded-lg text-slate-300 data-[state=active]:bg-cyan-400 data-[state=active]:text-slate-950"
                  >
                    单机模式榜
                  </TabsTrigger>
                  <TabsTrigger
                    value="online"
                    className="rounded-lg text-slate-300 data-[state=active]:bg-amber-400 data-[state=active]:text-slate-950"
                  >
                    联网积分榜
                  </TabsTrigger>
                </TabsList>

                <TabsContent value="single" className="space-y-4">
                  <Podium rows={singleRows} meId={meId} mode="single" />
                  <BoardTable rows={singleRows} mode="single" meId={meId} />
                </TabsContent>

                <TabsContent value="online" className="space-y-4">
                  <Podium rows={onlineRows} meId={meId} mode="online" />
                  <BoardTable rows={onlineRows} mode="online" meId={meId} />
                </TabsContent>
              </Tabs>
            )}

            {!loading && !error && currentRows.length === 0 && (
              <Card className="border-slate-700/70 bg-slate-900/60 py-4">
                <CardContent className="px-4 text-sm text-slate-300">
                  还没有榜单数据，去打几局把名字挂上来。
                </CardContent>
              </Card>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
