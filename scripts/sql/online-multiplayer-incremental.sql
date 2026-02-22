-- ============================================================
-- Online Multiplayer Tetris (Supabase) - INCREMENTAL MIGRATION
-- ============================================================
-- Intended use:
-- - Non-destructive rollout
-- - Keeps existing tables/data whenever possible
-- - Creates missing objects for multiplayer + leaderboards
-- ============================================================

begin;

create extension if not exists pgcrypto;

create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create table if not exists public.profiles (
  user_id uuid primary key references auth.users(id) on delete cascade,
  display_name text not null check (length(trim(display_name)) between 2 and 32),
  avatar_url text,
  is_anonymous boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.player_stats (
  user_id uuid primary key references auth.users(id) on delete cascade,
  single_high_score integer not null default 0 check (single_high_score >= 0),
  single_total_lines integer not null default 0 check (single_total_lines >= 0),
  single_realm_level smallint not null default 1 check (single_realm_level between 1 and 8),
  single_ai_wins integer not null default 0 check (single_ai_wins >= 0),
  online_points integer not null default 0 check (online_points >= 0),
  online_wins integer not null default 0 check (online_wins >= 0),
  online_losses integer not null default 0 check (online_losses >= 0),
  online_matches_played integer not null default 0 check (online_matches_played >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint stats_matches_consistent
    check (online_matches_played = online_wins + online_losses)
);

alter table public.player_stats
  add column if not exists single_realm_level smallint not null default 1 check (single_realm_level between 1 and 8);

alter table public.player_stats
  add column if not exists single_ai_wins integer not null default 0 check (single_ai_wins >= 0);

create table if not exists public.matches (
  id uuid primary key default gen_random_uuid(),
  room_code text not null unique check (room_code ~ '^[A-Z0-9]{6}$'),
  status text not null default 'waiting'
    check (status in ('waiting', 'playing', 'ended', 'aborted')),
  host_user_id uuid not null references auth.users(id) on delete restrict,
  guest_user_id uuid references auth.users(id) on delete set null,
  seed bigint not null,
  host_ready boolean not null default false,
  guest_ready boolean not null default false,
  winner_user_id uuid references auth.users(id) on delete set null,
  disconnect_user_id uuid references auth.users(id) on delete set null,
  disconnect_deadline timestamptz,
  host_last_seen_at timestamptz,
  guest_last_seen_at timestamptz,
  end_reason text
    check (end_reason in ('normal', 'disconnect_timeout', 'forfeit', 'abort')),
  started_at timestamptz,
  ended_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint matches_host_guest_distinct
    check (guest_user_id is null or host_user_id <> guest_user_id)
);

alter table public.matches
  add column if not exists host_last_seen_at timestamptz;

alter table public.matches
  add column if not exists guest_last_seen_at timestamptz;

create table if not exists public.match_snapshots (
  id bigserial primary key,
  match_id uuid not null references public.matches(id) on delete cascade,
  version integer not null check (version > 0),
  from_user_id uuid not null references auth.users(id) on delete cascade,
  host_seq integer not null default 0 check (host_seq >= 0),
  guest_seq integer not null default 0 check (guest_seq >= 0),
  host_board_fixed jsonb not null default '[]'::jsonb,
  guest_board_fixed jsonb not null default '[]'::jsonb,
  host_score integer not null default 0 check (host_score >= 0),
  guest_score integer not null default 0 check (guest_score >= 0),
  host_pending_garbage integer not null default 0 check (host_pending_garbage >= 0),
  guest_pending_garbage integer not null default 0 check (guest_pending_garbage >= 0),
  created_at timestamptz not null default now(),
  unique (match_id, version)
);

create index if not exists idx_profiles_registered on public.profiles (is_anonymous);
create index if not exists idx_profiles_display_name on public.profiles (display_name);

create index if not exists idx_stats_single_score on public.player_stats (single_high_score desc);
create index if not exists idx_stats_single_realm_wins on public.player_stats (single_realm_level desc, single_ai_wins desc);
create index if not exists idx_stats_online_rank on public.player_stats (online_points desc, online_wins desc);

create index if not exists idx_matches_status on public.matches (status);
create index if not exists idx_matches_host on public.matches (host_user_id);
create index if not exists idx_matches_guest on public.matches (guest_user_id);
create index if not exists idx_matches_room_code on public.matches (room_code);

create index if not exists idx_snapshots_match_created on public.match_snapshots (match_id, created_at desc);

drop trigger if exists trg_profiles_updated_at on public.profiles;
create trigger trg_profiles_updated_at
before update on public.profiles
for each row execute function public.set_updated_at();

drop trigger if exists trg_player_stats_updated_at on public.player_stats;
create trigger trg_player_stats_updated_at
before update on public.player_stats
for each row execute function public.set_updated_at();

drop trigger if exists trg_matches_updated_at on public.matches;
create trigger trg_matches_updated_at
before update on public.matches
for each row execute function public.set_updated_at();

create or replace function public.handle_new_auth_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  inferred_display_name text;
  inferred_is_anonymous boolean;
begin
  inferred_display_name := coalesce(
    nullif(trim(new.raw_user_meta_data ->> 'display_name'), ''),
    nullif(trim(new.raw_user_meta_data ->> 'name'), ''),
    nullif(split_part(new.email, '@', 1), ''),
    'Player-' || substr(new.id::text, 1, 8)
  );

  inferred_is_anonymous := coalesce(
    (new.raw_app_meta_data ->> 'provider') = 'anonymous',
    true
  );

  insert into public.profiles (user_id, display_name, is_anonymous)
  values (new.id, inferred_display_name, inferred_is_anonymous)
  on conflict (user_id) do update
    set display_name = excluded.display_name,
        is_anonymous = excluded.is_anonymous,
        updated_at = now();

  insert into public.player_stats (user_id)
  values (new.id)
  on conflict (user_id) do nothing;

  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
after insert on auth.users
for each row execute function public.handle_new_auth_user();

insert into public.profiles (user_id, display_name, is_anonymous)
select
  au.id as user_id,
  coalesce(
    nullif(trim(au.raw_user_meta_data ->> 'display_name'), ''),
    nullif(trim(au.raw_user_meta_data ->> 'name'), ''),
    nullif(split_part(au.email, '@', 1), ''),
    'Player-' || substr(au.id::text, 1, 8)
  ) as display_name,
  coalesce((au.raw_app_meta_data ->> 'provider') = 'anonymous', true) as is_anonymous
from auth.users au
on conflict (user_id) do nothing;

insert into public.player_stats (user_id)
select au.id
from auth.users au
on conflict (user_id) do nothing;

create or replace function public.generate_room_code()
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  alphabet constant text := 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  candidate text;
  i integer;
begin
  loop
    candidate := '';
    for i in 1..6 loop
      candidate := candidate || substr(alphabet, 1 + floor(random() * length(alphabet))::int, 1);
    end loop;
    if not exists (select 1 from public.matches where room_code = candidate) then
      return candidate;
    end if;
  end loop;
end;
$$;

create or replace function public.create_match_room(p_seed bigint default null)
returns public.matches
language plpgsql
security definer
set search_path = public
as $$
declare
  v_match public.matches;
begin
  if auth.uid() is null then
    raise exception 'AUTH_REQUIRED';
  end if;

  insert into public.matches (room_code, status, host_user_id, seed, host_last_seen_at)
  values (
    public.generate_room_code(),
    'waiting',
    auth.uid(),
    coalesce(p_seed, trunc(random() * 9000000000000000000)::bigint),
    now()
  )
  returning * into v_match;

  return v_match;
end;
$$;

create or replace function public.join_match_room(p_room_code text)
returns public.matches
language plpgsql
security definer
set search_path = public
as $$
declare
  v_match public.matches;
begin
  if auth.uid() is null then
    raise exception 'AUTH_REQUIRED';
  end if;

  update public.matches m
  set guest_user_id = auth.uid(),
      guest_last_seen_at = now(),
      updated_at = now()
  where m.room_code = upper(trim(p_room_code))
    and m.status = 'waiting'
    and m.guest_user_id is null
    and m.host_user_id <> auth.uid()
  returning * into v_match;

  if v_match.id is null then
    raise exception 'ROOM_UNAVAILABLE';
  end if;

  return v_match;
end;
$$;

create or replace function public.set_match_ready(
  p_match_id uuid,
  p_is_ready boolean
)
returns public.matches
language plpgsql
security definer
set search_path = public
as $$
declare
  v_match public.matches;
begin
  if auth.uid() is null then
    raise exception 'AUTH_REQUIRED';
  end if;

  update public.matches m
  set
    host_ready = case when auth.uid() = m.host_user_id then p_is_ready else m.host_ready end,
    guest_ready = case when auth.uid() = m.guest_user_id then p_is_ready else m.guest_ready end,
    status = case
      when m.status = 'waiting'
       and m.guest_user_id is not null
       and (case when auth.uid() = m.host_user_id then p_is_ready else m.host_ready end) = true
       and (case when auth.uid() = m.guest_user_id then p_is_ready else m.guest_ready end) = true
      then 'playing'
      else m.status
    end,
    started_at = case
      when m.status = 'waiting'
       and m.guest_user_id is not null
       and (case when auth.uid() = m.host_user_id then p_is_ready else m.host_ready end) = true
       and (case when auth.uid() = m.guest_user_id then p_is_ready else m.guest_ready end) = true
      then coalesce(m.started_at, now())
      else m.started_at
    end,
    host_last_seen_at = case
      when m.status = 'waiting'
       and m.guest_user_id is not null
       and (case when auth.uid() = m.host_user_id then p_is_ready else m.host_ready end) = true
       and (case when auth.uid() = m.guest_user_id then p_is_ready else m.guest_ready end) = true
      then now()
      else m.host_last_seen_at
    end,
    guest_last_seen_at = case
      when m.status = 'waiting'
       and m.guest_user_id is not null
       and (case when auth.uid() = m.host_user_id then p_is_ready else m.host_ready end) = true
       and (case when auth.uid() = m.guest_user_id then p_is_ready else m.guest_ready end) = true
      then now()
      else m.guest_last_seen_at
    end,
    disconnect_user_id = case
      when m.status = 'waiting'
       and m.guest_user_id is not null
       and (case when auth.uid() = m.host_user_id then p_is_ready else m.host_ready end) = true
       and (case when auth.uid() = m.guest_user_id then p_is_ready else m.guest_ready end) = true
      then null
      else m.disconnect_user_id
    end,
    disconnect_deadline = case
      when m.status = 'waiting'
       and m.guest_user_id is not null
       and (case when auth.uid() = m.host_user_id then p_is_ready else m.host_ready end) = true
       and (case when auth.uid() = m.guest_user_id then p_is_ready else m.guest_ready end) = true
      then null
      else m.disconnect_deadline
    end,
    updated_at = now()
  where m.id = p_match_id
    and (auth.uid() = m.host_user_id or auth.uid() = m.guest_user_id)
  returning * into v_match;

  if v_match.id is null then
    raise exception 'MATCH_NOT_FOUND_OR_FORBIDDEN';
  end if;

  return v_match;
end;
$$;

create or replace function public.set_disconnect_deadline(
  p_match_id uuid,
  p_disconnect_user_id uuid,
  p_deadline timestamptz
)
returns public.matches
language plpgsql
security definer
set search_path = public
as $$
declare
  v_match public.matches;
begin
  if auth.uid() is null then
    raise exception 'AUTH_REQUIRED';
  end if;

  update public.matches m
  set disconnect_user_id = p_disconnect_user_id,
      disconnect_deadline = p_deadline,
      updated_at = now()
  where m.id = p_match_id
    and (auth.uid() = m.host_user_id or auth.uid() = m.guest_user_id)
    and (p_disconnect_user_id = m.host_user_id or p_disconnect_user_id = m.guest_user_id)
    and m.status in ('waiting', 'playing')
  returning * into v_match;

  if v_match.id is null then
    raise exception 'MATCH_NOT_FOUND_OR_FORBIDDEN';
  end if;

  return v_match;
end;
$$;

create or replace function public.clear_disconnect_deadline(
  p_match_id uuid
)
returns public.matches
language plpgsql
security definer
set search_path = public
as $$
declare
  v_match public.matches;
begin
  if auth.uid() is null then
    raise exception 'AUTH_REQUIRED';
  end if;

  update public.matches m
  set disconnect_user_id = null,
      disconnect_deadline = null,
      updated_at = now()
  where m.id = p_match_id
    and (auth.uid() = m.host_user_id or auth.uid() = m.guest_user_id)
  returning * into v_match;

  if v_match.id is null then
    raise exception 'MATCH_NOT_FOUND_OR_FORBIDDEN';
  end if;

  return v_match;
end;
$$;

create or replace function public.heartbeat_match(
  p_match_id uuid
)
returns public.matches
language plpgsql
security definer
set search_path = public
as $$
declare
  v_match public.matches;
  v_now timestamptz := now();
  v_opponent_id uuid;
  v_opponent_seen_at timestamptz;
  v_missing_threshold interval := interval '20 seconds';
  v_grace interval := interval '45 seconds';
begin
  if auth.uid() is null then
    raise exception 'AUTH_REQUIRED';
  end if;

  select *
  into v_match
  from public.matches
  where id = p_match_id
  for update;

  if v_match.id is null then
    raise exception 'MATCH_NOT_FOUND';
  end if;

  if auth.uid() <> v_match.host_user_id and auth.uid() <> v_match.guest_user_id then
    raise exception 'NOT_MATCH_PARTICIPANT';
  end if;

  update public.matches m
  set host_last_seen_at = case when auth.uid() = m.host_user_id then v_now else m.host_last_seen_at end,
      guest_last_seen_at = case when auth.uid() = m.guest_user_id then v_now else m.guest_last_seen_at end,
      updated_at = now()
  where m.id = p_match_id
  returning * into v_match;

  if v_match.status <> 'playing' or v_match.guest_user_id is null then
    return v_match;
  end if;

  if auth.uid() = v_match.host_user_id then
    v_opponent_id := v_match.guest_user_id;
    v_opponent_seen_at := v_match.guest_last_seen_at;
  else
    v_opponent_id := v_match.host_user_id;
    v_opponent_seen_at := v_match.host_last_seen_at;
  end if;

  -- First-round guard: wait until both sides reported at least one heartbeat.
  if v_match.host_last_seen_at is null or v_match.guest_last_seen_at is null then
    if v_match.disconnect_user_id is not null then
      update public.matches
      set disconnect_user_id = null,
          disconnect_deadline = null,
          updated_at = now()
      where id = p_match_id
      returning * into v_match;
    end if;
    return v_match;
  end if;

  if v_opponent_seen_at is null or (v_now - v_opponent_seen_at) > v_missing_threshold then
    if v_match.disconnect_user_id is distinct from v_opponent_id then
      update public.matches
      set disconnect_user_id = v_opponent_id,
          disconnect_deadline = v_now + v_grace,
          updated_at = now()
      where id = p_match_id
      returning * into v_match;
    elsif v_match.disconnect_deadline is null then
      update public.matches
      set disconnect_deadline = v_now + v_grace,
          updated_at = now()
      where id = p_match_id
      returning * into v_match;
    end if;
  elsif v_match.disconnect_user_id is not null then
    update public.matches
    set disconnect_user_id = null,
        disconnect_deadline = null,
        updated_at = now()
    where id = p_match_id
    returning * into v_match;
  end if;

  return v_match;
end;
$$;

create or replace function public.check_match_timeout(
  p_match_id uuid
)
returns public.matches
language plpgsql
security definer
set search_path = public
as $$
declare
  v_match public.matches;
  v_now timestamptz := now();
  v_missing_threshold interval := interval '20 seconds';
  v_disconnected_seen_at timestamptz;
  v_winner_user_id uuid;
begin
  if auth.uid() is null then
    raise exception 'AUTH_REQUIRED';
  end if;

  select *
  into v_match
  from public.matches
  where id = p_match_id
  for update;

  if v_match.id is null then
    raise exception 'MATCH_NOT_FOUND';
  end if;

  if auth.uid() <> v_match.host_user_id and auth.uid() <> v_match.guest_user_id then
    raise exception 'NOT_MATCH_PARTICIPANT';
  end if;

  if v_match.status <> 'playing' or v_match.guest_user_id is null then
    return v_match;
  end if;

  if v_match.host_last_seen_at is null or v_match.guest_last_seen_at is null then
    return v_match;
  end if;

  if v_match.disconnect_user_id is null then
    return v_match;
  end if;

  v_disconnected_seen_at := case
    when v_match.disconnect_user_id = v_match.host_user_id then v_match.host_last_seen_at
    when v_match.disconnect_user_id = v_match.guest_user_id then v_match.guest_last_seen_at
    else null
  end;

  if v_disconnected_seen_at is not null and (v_now - v_disconnected_seen_at) <= v_missing_threshold then
    update public.matches
    set disconnect_user_id = null,
        disconnect_deadline = null,
        updated_at = now()
    where id = p_match_id
    returning * into v_match;
    return v_match;
  end if;

  if v_match.disconnect_deadline is not null and v_now >= v_match.disconnect_deadline then
    v_winner_user_id := case
      when v_match.disconnect_user_id = v_match.host_user_id then v_match.guest_user_id
      when v_match.disconnect_user_id = v_match.guest_user_id then v_match.host_user_id
      else null
    end;

    if v_winner_user_id is not null then
      return public.finish_match(p_match_id, v_winner_user_id, 'disconnect_timeout');
    end if;
  end if;

  return v_match;
end;
$$;

create or replace function public.finish_match(
  p_match_id uuid,
  p_winner_user_id uuid,
  p_end_reason text default 'normal'
)
returns public.matches
language plpgsql
security definer
set search_path = public
as $$
declare
  v_match public.matches;
  v_loser_id uuid;
  v_winner_registered boolean;
  v_loser_registered boolean;
begin
  if auth.uid() is null then
    raise exception 'AUTH_REQUIRED';
  end if;

  select *
  into v_match
  from public.matches
  where id = p_match_id
  for update;

  if v_match.id is null then
    raise exception 'MATCH_NOT_FOUND';
  end if;

  if auth.uid() <> v_match.host_user_id and auth.uid() <> v_match.guest_user_id then
    raise exception 'NOT_MATCH_PARTICIPANT';
  end if;

  if p_winner_user_id <> v_match.host_user_id and p_winner_user_id <> v_match.guest_user_id then
    raise exception 'INVALID_WINNER';
  end if;

  if p_end_reason not in ('normal', 'disconnect_timeout', 'forfeit', 'abort') then
    raise exception 'INVALID_END_REASON';
  end if;

  if v_match.status = 'ended' then
    return v_match;
  end if;

  v_loser_id := case
    when p_winner_user_id = v_match.host_user_id then v_match.guest_user_id
    else v_match.host_user_id
  end;

  if v_loser_id is null then
    raise exception 'MATCH_INCOMPLETE';
  end if;

  update public.matches
  set status = 'ended',
      winner_user_id = p_winner_user_id,
      ended_at = now(),
      end_reason = p_end_reason,
      disconnect_user_id = null,
      disconnect_deadline = null,
      updated_at = now()
  where id = p_match_id
  returning * into v_match;

  select exists (
    select 1 from public.profiles p
    where p.user_id = p_winner_user_id and p.is_anonymous = false
  ) into v_winner_registered;

  select exists (
    select 1 from public.profiles p
    where p.user_id = v_loser_id and p.is_anonymous = false
  ) into v_loser_registered;

  if v_winner_registered then
    insert into public.player_stats (user_id)
    values (p_winner_user_id)
    on conflict (user_id) do nothing;

    update public.player_stats
    set online_points = online_points + 3,
        online_wins = online_wins + 1,
        online_matches_played = online_matches_played + 1,
        updated_at = now()
    where user_id = p_winner_user_id;
  end if;

  if v_loser_registered then
    insert into public.player_stats (user_id)
    values (v_loser_id)
    on conflict (user_id) do nothing;

    update public.player_stats
    set online_losses = online_losses + 1,
        online_matches_played = online_matches_played + 1,
        updated_at = now()
    where user_id = v_loser_id;
  end if;

  return v_match;
end;
$$;

create or replace function public.submit_single_score(
  p_score integer,
  p_lines integer default 0
)
returns public.player_stats
language plpgsql
security definer
set search_path = public
as $$
declare
  v_stats public.player_stats;
  v_registered boolean;
begin
  if auth.uid() is null then
    raise exception 'AUTH_REQUIRED';
  end if;

  if p_score < 0 or p_lines < 0 then
    raise exception 'INVALID_SCORE';
  end if;

  select exists (
    select 1 from public.profiles p
    where p.user_id = auth.uid() and p.is_anonymous = false
  ) into v_registered;

  insert into public.player_stats (user_id)
  values (auth.uid())
  on conflict (user_id) do nothing;

  if v_registered then
    update public.player_stats
    set single_high_score = greatest(single_high_score, p_score),
        single_total_lines = single_total_lines + p_lines,
        updated_at = now()
    where user_id = auth.uid();
  end if;

  select *
  into v_stats
  from public.player_stats
  where user_id = auth.uid();

  return v_stats;
end;
$$;

create or replace function public.submit_single_ai_result(
  p_is_win boolean
)
returns public.player_stats
language plpgsql
security definer
set search_path = public
as $$
declare
  v_stats public.player_stats;
  v_registered boolean;
begin
  if auth.uid() is null then
    raise exception 'AUTH_REQUIRED';
  end if;

  select exists (
    select 1 from public.profiles p
    where p.user_id = auth.uid() and p.is_anonymous = false
  ) into v_registered;

  insert into public.player_stats (user_id)
  values (auth.uid())
  on conflict (user_id) do nothing;

  if v_registered and p_is_win then
    update public.player_stats
    set single_ai_wins = single_ai_wins + 1,
        single_realm_level = least(single_realm_level + 1, 8),
        updated_at = now()
    where user_id = auth.uid();
  end if;

  select *
  into v_stats
  from public.player_stats
  where user_id = auth.uid();

  return v_stats;
end;
$$;

create or replace function public.mark_profile_registered()
returns public.profiles
language plpgsql
security definer
set search_path = public
as $$
declare
  v_profile public.profiles;
begin
  if auth.uid() is null then
    raise exception 'AUTH_REQUIRED';
  end if;

  update public.profiles
  set is_anonymous = false,
      updated_at = now()
  where user_id = auth.uid()
  returning * into v_profile;

  if v_profile.user_id is null then
    raise exception 'PROFILE_NOT_FOUND';
  end if;

  return v_profile;
end;
$$;

drop view if exists public.single_mode_leaderboard;
create view public.single_mode_leaderboard as
select
  row_number() over (
    order by s.single_realm_level desc, s.single_ai_wins desc, s.updated_at asc, p.display_name asc
  ) as rank,
  p.user_id,
  p.display_name,
  s.single_realm_level,
  s.single_ai_wins,
  s.updated_at
from public.player_stats s
join public.profiles p on p.user_id = s.user_id
where p.is_anonymous = false
  and (s.single_realm_level > 1 or s.single_ai_wins > 0);

drop view if exists public.online_mode_leaderboard;
create view public.online_mode_leaderboard as
select
  row_number() over (
    order by
      s.online_points desc,
      s.online_wins desc,
      case
        when s.online_matches_played = 0 then 0
        else s.online_wins::numeric / s.online_matches_played
      end desc,
      s.updated_at asc,
      p.display_name asc
  ) as rank,
  p.user_id,
  p.display_name,
  s.online_points,
  s.online_wins,
  s.online_losses,
  s.online_matches_played,
  case
    when s.online_matches_played = 0 then 0
    else round((s.online_wins::numeric / s.online_matches_played) * 100, 2)
  end as win_rate_percent,
  s.updated_at
from public.player_stats s
join public.profiles p on p.user_id = s.user_id
where p.is_anonymous = false
  and s.online_matches_played > 0;

alter table public.profiles enable row level security;
alter table public.player_stats enable row level security;
alter table public.matches enable row level security;
alter table public.match_snapshots enable row level security;

drop policy if exists profiles_select_self_or_registered on public.profiles;
create policy profiles_select_self_or_registered
on public.profiles
for select
using (user_id = auth.uid() or is_anonymous = false);

drop policy if exists profiles_update_self on public.profiles;
create policy profiles_update_self
on public.profiles
for update
using (user_id = auth.uid())
with check (user_id = auth.uid());

drop policy if exists player_stats_select_self_or_registered on public.player_stats;
create policy player_stats_select_self_or_registered
on public.player_stats
for select
using (
  user_id = auth.uid()
  or exists (
    select 1 from public.profiles p
    where p.user_id = public.player_stats.user_id
      and p.is_anonymous = false
  )
);

drop policy if exists matches_select_participants on public.matches;
create policy matches_select_participants
on public.matches
for select
using (auth.uid() = host_user_id or auth.uid() = guest_user_id);

drop policy if exists match_snapshots_select_participants on public.match_snapshots;
create policy match_snapshots_select_participants
on public.match_snapshots
for select
using (
  exists (
    select 1
    from public.matches m
    where m.id = public.match_snapshots.match_id
      and (auth.uid() = m.host_user_id or auth.uid() = m.guest_user_id)
  )
);

drop policy if exists match_snapshots_insert_participants on public.match_snapshots;
create policy match_snapshots_insert_participants
on public.match_snapshots
for insert
with check (
  from_user_id = auth.uid()
  and exists (
    select 1
    from public.matches m
    where m.id = public.match_snapshots.match_id
      and (auth.uid() = m.host_user_id or auth.uid() = m.guest_user_id)
  )
);

grant select on public.single_mode_leaderboard to authenticated;
grant select on public.online_mode_leaderboard to authenticated;

grant execute on function public.generate_room_code() to authenticated;
grant execute on function public.create_match_room(bigint) to authenticated;
grant execute on function public.join_match_room(text) to authenticated;
grant execute on function public.set_match_ready(uuid, boolean) to authenticated;
grant execute on function public.set_disconnect_deadline(uuid, uuid, timestamptz) to authenticated;
grant execute on function public.clear_disconnect_deadline(uuid) to authenticated;
grant execute on function public.heartbeat_match(uuid) to authenticated;
grant execute on function public.check_match_timeout(uuid) to authenticated;
grant execute on function public.finish_match(uuid, uuid, text) to authenticated;
grant execute on function public.submit_single_score(integer, integer) to authenticated;
grant execute on function public.submit_single_ai_result(boolean) to authenticated;
grant execute on function public.mark_profile_registered() to authenticated;

commit;
