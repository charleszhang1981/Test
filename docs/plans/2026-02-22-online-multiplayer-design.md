# Online Multiplayer Tetris Design (Supabase-Only, MVP)

Date: 2026-02-22
Status: approved in chat
Scope: architecture + data model + SQL deliverables (no app code changes yet)

## 1) Confirmed Product Decisions

- Infra: Supabase only (Auth + Realtime + Postgres), no extra backend service.
- Scale target: MVP, concurrent players under 100.
- Matchmaking: friend room by room code only.
- Identity: Supabase Anonymous Auth supported; account upgrade (email/password) supported later.
- Authority model: client authoritative.
- Sync rule: do not sync per-frame falling animation; sync only lock/fixed-board outcomes.
- Garbage rule: clear 1 line sends 0 garbage; clear 2/3/4 lines sends 2/3/4 garbage.
- Disconnect rule: 30s reconnect window, timeout = loss.
- Draws: disabled. Every match ends with winner and loser.
- Score system: winner +3 points, loser +0.
- Anonymous users: can play online but do not gain points and do not appear on leaderboards.
- Leaderboards:
  - Single mode: ranked by historical highest score.
  - Online mode: ranked by points, tie-break by wins, then win rate.

## 2) Architecture

### Realtime path (low latency)

- Use one Realtime channel per match: `match:{match_id}`.
- Use broadcast events for gameplay events.
- Main event types:
  - `match_started`
  - `piece_locked`
  - `garbage_sent`
  - `resync_request`
  - `resync_state`

### Persistence path (low DB cost)

- Do not persist high-frequency gameplay events.
- Persist only:
  - room lifecycle (`matches`)
  - sparse snapshots (`match_snapshots`) at `10s OR 8 locks`
  - final result and points settlement (`matches` + `player_stats`)

### Why this is the selected approach

- Keeps gameplay latency low by avoiding DB round-trips for each lock event.
- Keeps DB write volume low versus event-per-row model.
- Still provides reconnect recovery anchor via sparse snapshots.

## 3) Realtime Event Contract (MVP)

All events include `matchId`, `sentAt`, `senderId`.

### `match_started`

- Fields: `seed`, `startAt`, `hostId`, `guestId`.
- Purpose: both clients start with deterministic piece sequence.

### `piece_locked`

- Fields: `playerId`, `seq`, `boardFixed`, `score`, `linesClearedTotal`, `sentGarbage`.
- Purpose: sync fixed-board result after lock only.
- Idempotency: receiver de-duplicates by `(playerId, seq)`.

### `garbage_sent`

- Fields: `fromPlayerId`, `toPlayerId`, `seq`, `count`.
- Rule: `count = clearedLines` if `clearedLines >= 2`, else event omitted.

### `resync_request` / `resync_state`

- Use when reconnecting.
- Reconnect flow:
  - load latest snapshot from DB,
  - request peer state,
  - apply latest `(seq)` and continue.

## 4) Database Design

### Tables

- `profiles`
  - one row per `auth.users.id`
  - `is_anonymous` flag
  - display data for leaderboard
- `player_stats`
  - single high score
  - online points/wins/losses/matches
- `matches`
  - room code, participants, lifecycle status, winner
  - disconnect tracking fields
- `match_snapshots`
  - sparse match recovery snapshots
  - fixed-board + score + pending garbage + seq

### Views

- `single_mode_leaderboard`
  - registered users only (`is_anonymous = false`)
  - order by `single_high_score desc`
- `online_mode_leaderboard`
  - registered users only
  - order by `online_points desc`, `online_wins desc`, `win_rate desc`

### Security / RLS

- `matches` and `match_snapshots`: selectable only by participants.
- `match_snapshots` insert: only by participants.
- `profiles`/`player_stats` self access + registered rows readable for leaderboard.
- settlement and room join/create rely on SQL functions (security definer).

## 5) Gameplay Lifecycle (Server-Backed Milestones)

1. User enters app -> Anonymous Auth sign-in if not logged in.
2. Host creates room -> `create_match_room(seed)`.
3. Guest joins room -> `join_match_room(room_code)` (atomic seat claim).
4. Ready handshake -> `set_match_ready(match_id, is_ready)`; both ready flips status to `playing`.
5. Match starts -> `match_started` event with shared seed.
6. Gameplay -> realtime `piece_locked` + `garbage_sent`.
7. Every `10s OR 8 locks` -> sparse snapshot write.
8. Disconnect -> `set_disconnect_deadline(...)`; reconnect success -> `clear_disconnect_deadline(...)`.
9. Timeout disconnect or game over -> `finish_match(match_id, winner_id, end_reason)`.

## 6) Leaderboard UX Direction

- One page with two tabs: `Single Mode` and `Online Mode`.
- Hero section with Top 3 podium and rank badges.
- Strong visual emphasis for top players (medal colors, elevated cards, subtle motion).
- Current user row highlighted.
- Mobile and desktop both supported.

## 7) Limitations and Known Tradeoffs

- Client-authoritative model is fast but not cheat-resistant.
- For MVP this is accepted; stronger anti-cheat requires server-authoritative simulation later.

## 8) SQL Deliverables

- `scripts/sql/online-multiplayer-full-reset.sql`
  - drop + recreate schema
  - RLS, indexes, functions, views, bootstrap trigger
- `scripts/sql/online-multiplayer-incremental.sql`
  - additive migration variant for non-destructive rollout

## 9) Implementation Checklist (next phase)

- Integrate auth flows in frontend (anonymous + register/login).
- Add room create/join UI and match lifecycle API calls.
- Replace local double mode with online room mode.
- Add snapshot scheduler (`10s OR 8 locks`) and reconnect flow.
- Add settlement invocation and leaderboard pages.
- Add tests for room join race, reconnect, and settlement points logic.
