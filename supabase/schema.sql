-- Database for fan picks. Paste this whole file into the Supabase SQL Editor and run it once.
-- It creates the tables and the rules that keep picks honest:
--   * a pick locks at kickoff (the database clock decides, not the visitor's phone)
--   * nobody can edit points, or see or change anyone else's picks
--   * points are awarded automatically when the update job marks a match FINISHED
--
-- Scoring and levels below must match config.js:
--   3 points for a correct pick, +2 if the model gave that outcome under 25%
--   picks per week: 3 (0 pts), 4 (10), 5 (25), 7 (50), 10 (100)

-- ---------------------------------------------------------------- tables
create table if not exists public.profiles (
  id           uuid primary key references auth.users(id) on delete cascade,
  display_name text check (display_name is null or char_length(display_name) between 3 and 20),
  created_at   timestamptz not null default now()
);
create unique index if not exists profiles_name_unique on public.profiles (lower(display_name));

create table if not exists public.matches (
  id          bigint primary key,
  competition text not null,
  matchday    int,
  kickoff     timestamptz not null,
  status      text not null default 'UPCOMING',   -- UPCOMING, LIVE, FINISHED, POSTPONED
  home_name   text not null,
  away_name   text not null,
  home_tla    text,
  away_tla    text,
  home_goals  int,
  away_goals  int,
  p_home      int not null,
  p_draw      int not null,
  p_away      int not null,
  updated_at  timestamptz not null default now()
);
create index if not exists matches_kickoff_idx on public.matches (kickoff);

create table if not exists public.picks (
  id         bigint generated always as identity primary key,
  user_id    uuid not null default auth.uid() references auth.users(id) on delete cascade,
  match_id   bigint not null references public.matches(id) on delete cascade,
  pick       char(1) not null check (pick in ('H', 'D', 'A')),
  points     int,                                  -- filled in by the database, never by the user
  created_at timestamptz not null default now(),
  unique (user_id, match_id)
);
create index if not exists picks_match_idx on public.picks (match_id);

-- ---------------------------------------------------------------- levels
create or replace function public.picks_allowed(pts int) returns int
language sql immutable as $$
  select case when pts >= 100 then 10 when pts >= 50 then 7 when pts >= 25 then 5
              when pts >= 10 then 4 else 3 end
$$;

-- ---------------------------------------------------------------- new users get a profile row
create or replace function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = public as $$
declare nm text := nullif(btrim(new.raw_user_meta_data ->> 'name'), '');
begin
  if nm is not null and char_length(nm) not between 3 and 20 then nm := null; end if;
  begin
    insert into public.profiles (id, display_name) values (new.id, nm) on conflict (id) do nothing;
  exception when unique_violation then          -- the name is taken: create the profile without it
    insert into public.profiles (id) values (new.id) on conflict (id) do nothing;
  end;
  return new;
end $$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created after insert on auth.users
  for each row execute function public.handle_new_user();

-- ---------------------------------------------------------------- pick rules
create or replace function public.picks_guard() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  m        public.matches%rowtype;
  pts      int;
  used     int;
begin
  -- These rules are for signed-in players. Server-side writes (the automatic scoring below,
  -- or the update job using the service key) have no signed-in user and skip them.
  if auth.uid() is null then
    return new;
  end if;

  select * into m from public.matches where id = new.match_id;
  if not found then
    raise exception 'Unknown match.';
  end if;
  if m.status <> 'UPCOMING' or now() >= m.kickoff then
    raise exception 'This match has started. Picks are closed.';
  end if;

  if tg_op = 'INSERT' then
    new.points := null;                            -- users cannot set points
    select coalesce(sum(points), 0) into pts from public.picks where user_id = new.user_id;
    select count(*) into used
      from public.picks p join public.matches mm on mm.id = p.match_id
     where p.user_id = new.user_id
       and date_trunc('week', mm.kickoff) = date_trunc('week', m.kickoff);
    if used >= public.picks_allowed(pts) then
      raise exception 'No picks left this week. Win points to get more.';
    end if;
  else
    if new.match_id <> old.match_id or new.user_id <> old.user_id then
      raise exception 'A pick cannot be moved to another match.';
    end if;
    new.points := old.points;                      -- users cannot change points
  end if;
  return new;
end $$;

drop trigger if exists picks_guard_trg on public.picks;
create trigger picks_guard_trg before insert or update on public.picks
  for each row execute function public.picks_guard();

-- ---------------------------------------------------------------- match rules + automatic scoring
create or replace function public.matches_before() returns trigger
language plpgsql as $$
begin
  new.updated_at := now();
  -- once a match has kicked off, the model's percentages are frozen so bonus points stay fair
  if tg_op = 'UPDATE' and old.kickoff <= now() then
    new.p_home := old.p_home; new.p_draw := old.p_draw; new.p_away := old.p_away;
  end if;
  return new;
end $$;

drop trigger if exists matches_before_trg on public.matches;
create trigger matches_before_trg before insert or update on public.matches
  for each row execute function public.matches_before();

create or replace function public.matches_score() returns trigger
language plpgsql security definer set search_path = public as $$
declare res char(1);
begin
  if new.status = 'FINISHED' and new.home_goals is not null and new.away_goals is not null then
    res := case when new.home_goals > new.away_goals then 'H'
                when new.home_goals < new.away_goals then 'A' else 'D' end;
    update public.picks p
       set points = case
             when p.pick <> res then 0
             else 3 + case when (case p.pick when 'H' then new.p_home
                                             when 'D' then new.p_draw
                                             else new.p_away end) < 25 then 2 else 0 end
           end
     where p.match_id = new.id and p.points is null;
  end if;
  return null;
end $$;

drop trigger if exists matches_score_trg on public.matches;
create trigger matches_score_trg after insert or update on public.matches
  for each row execute function public.matches_score();

-- ---------------------------------------------------------------- who can do what (row level security)
alter table public.profiles enable row level security;
alter table public.matches  enable row level security;
alter table public.picks    enable row level security;

create policy "profiles: read own"   on public.profiles for select using (id = auth.uid());
create policy "profiles: update own" on public.profiles for update using (id = auth.uid()) with check (id = auth.uid());

create policy "matches: anyone can read" on public.matches for select using (true);
-- no insert/update policy on matches: only the update job (service key) writes them

create policy "picks: read own"   on public.picks for select using (user_id = auth.uid());
create policy "picks: insert own" on public.picks for insert with check (user_id = auth.uid());
create policy "picks: update own" on public.picks for update using (user_id = auth.uid()) with check (user_id = auth.uid());
-- no delete policy: a pick cannot be withdrawn, only changed before kickoff

-- ---------------------------------------------------------------- public totals (no personal data)
-- Views run with the owner's rights, so they can count everyone's picks while exposing only totals.
create or replace view public.match_votes as
  select match_id,
         count(*) filter (where pick = 'H')::int as h,
         count(*) filter (where pick = 'D')::int as d,
         count(*) filter (where pick = 'A')::int as a
    from public.picks group by match_id;

create or replace view public.leaderboard as
  select pr.display_name,
         coalesce(sum(pk.points), 0)::int            as points,
         count(*) filter (where pk.points > 0)::int  as correct
    from public.profiles pr
    join public.picks pk on pk.user_id = pr.id
   where pr.display_name is not null
   group by pr.id, pr.display_name
   order by points desc, correct desc
   limit 50;

grant usage on schema public to anon, authenticated;
grant select on public.matches, public.match_votes, public.leaderboard to anon, authenticated;
grant select, update on public.profiles to authenticated;
grant select, insert, update on public.picks to authenticated;

-- ---------------------------------------------------------------- comments
-- Anyone can read comments. Only signed-in players with a name can write them.
create table if not exists public.comments (
  id         bigint generated always as identity primary key,
  match_id   bigint not null references public.matches(id) on delete cascade,
  user_id    uuid not null default auth.uid() references auth.users(id) on delete cascade,
  body       text not null check (char_length(btrim(body)) between 1 and 280),
  created_at timestamptz not null default now()
);
create index if not exists comments_match_idx on public.comments (match_id, created_at);
alter table public.comments enable row level security;
create policy "comments: read own"   on public.comments for select using (user_id = auth.uid());
create policy "comments: insert own" on public.comments for insert with check (user_id = auth.uid());
create policy "comments: delete own" on public.comments for delete using (user_id = auth.uid());

create or replace function public.comments_guard() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null then return new; end if;
  new.body := btrim(new.body);
  if not exists (select 1 from public.profiles where id = new.user_id and display_name is not null) then
    raise exception 'Choose a name before you comment.';
  end if;
  if exists (select 1 from public.comments where user_id = new.user_id and created_at > now() - interval '10 seconds') then
    raise exception 'Slow down a little. Try again in a few seconds.';
  end if;
  if (select count(*) from public.comments where user_id = new.user_id and created_at > now() - interval '1 day') >= 40 then
    raise exception 'That is the limit for today. Come back tomorrow.';
  end if;
  return new;
end $$;
drop trigger if exists comments_guard_trg on public.comments;
create trigger comments_guard_trg before insert on public.comments
  for each row execute function public.comments_guard();

-- What visitors see: name, text and time. No emails, no ids of people.
create or replace view public.comments_public as
  select c.id, c.match_id, pr.display_name as name, c.body, c.created_at, (c.user_id = auth.uid()) as mine
    from public.comments c join public.profiles pr on pr.id = c.user_id
   where pr.display_name is not null;
create or replace view public.comment_counts as
  select c.match_id, count(*)::int as n
    from public.comments c join public.profiles pr on pr.id = c.user_id
   where pr.display_name is not null group by c.match_id;
grant select on public.comments_public, public.comment_counts to anon, authenticated;
grant select, insert, delete on public.comments to authenticated;

-- ---------------------------------------------------------------- owner view
-- Only accounts listed in public.admins can read these numbers. To make yourself the owner, sign in
-- on the site once, then run this in the SQL Editor (put your own email in):
--   insert into public.admins (user_id) select id from auth.users where email = 'you@example.com';
create table if not exists public.admins (
  user_id uuid primary key references auth.users(id) on delete cascade
);
alter table public.admins enable row level security;     -- no policies: nobody can read it directly

create or replace function public.is_admin() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.admins where user_id = auth.uid())
$$;

create or replace function public.admin_stats() returns json
language plpgsql stable security definer set search_path = public as $$
declare r json;
begin
  if not public.is_admin() then raise exception 'Not allowed.'; end if;
  select json_build_object(
    'players',       (select count(*) from public.profiles),
    'named_players', (select count(*) from public.profiles where display_name is not null),
    'new_7d',        (select count(*) from public.profiles where created_at > now() - interval '7 days'),
    'active_7d',     (select count(distinct user_id) from public.picks where created_at > now() - interval '7 days'),
    'picks_total',   (select count(*) from public.picks),
    'picks_today',   (select count(*) from public.picks where created_at >= date_trunc('day', now())),
    'points_total',  (select coalesce(sum(points), 0) from public.picks),
    'correct_rate',  (select round(100.0 * count(*) filter (where points > 0) / nullif(count(points), 0), 1) from public.picks),
    'matches',       (select count(*) from public.matches),
    'last_sync',     (select max(updated_at) from public.matches),
    'per_day',       (select coalesce(json_agg(json_build_object('day', d::date, 'picks', coalesce(c.n, 0), 'players', coalesce(c.u, 0)) order by d), '[]'::json)
                        from generate_series(date_trunc('day', now()) - interval '13 days', date_trunc('day', now()), interval '1 day') d
                        left join (select date_trunc('day', created_at) as day, count(*) n, count(distinct user_id) u
                                     from public.picks group by 1) c on c.day = d),
    'top_matches',   (select coalesce(json_agg(t), '[]'::json)
                        from (select m.id, m.home_name, m.away_name, m.kickoff, count(p.id)::int as picks
                                from public.matches m join public.picks p on p.match_id = m.id
                               group by m.id order by picks desc, m.kickoff desc limit 5) t)
  ) into r;
  return r;
end $$;

create or replace function public.admin_players()
returns table (player_id uuid, name text, joined timestamptz, n_picks int, points int, n_correct int)
language plpgsql stable security definer set search_path = public as $$
begin
  if not public.is_admin() then raise exception 'Not allowed.'; end if;
  return query
    select pr.id, pr.display_name, pr.created_at, count(pk.id)::int,
           coalesce(sum(pk.points), 0)::int, (count(*) filter (where pk.points > 0))::int
      from public.profiles pr left join public.picks pk on pk.user_id = pr.id
     group by pr.id order by 5 desc, 4 desc, pr.created_at desc limit 100;
end $$;

-- Removes a player's name, which also takes them off the leaderboard. Their picks are kept.
create or replace function public.admin_clear_name(target uuid) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not public.is_admin() then raise exception 'Not allowed.'; end if;
  update public.profiles set display_name = null where id = target;
end $$;

-- The owner can delete any comment and see the latest ones.
create or replace function public.admin_delete_comment(target bigint) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not public.is_admin() then raise exception 'Not allowed.'; end if;
  delete from public.comments where id = target;
end $$;

create or replace function public.admin_recent_comments()
returns table (id bigint, name text, body text, created_at timestamptz, home_name text, away_name text)
language plpgsql stable security definer set search_path = public as $$
begin
  if not public.is_admin() then raise exception 'Not allowed.'; end if;
  return query
    select c.id, pr.display_name, c.body, c.created_at, m.home_name, m.away_name
      from public.comments c join public.profiles pr on pr.id = c.user_id join public.matches m on m.id = c.match_id
     order by c.created_at desc limit 30;
end $$;

revoke all on function public.is_admin(), public.admin_stats(), public.admin_players(), public.admin_clear_name(uuid), public.admin_delete_comment(bigint), public.admin_recent_comments() from public, anon;
grant execute on function public.is_admin(), public.admin_stats(), public.admin_players(), public.admin_clear_name(uuid), public.admin_delete_comment(bigint), public.admin_recent_comments() to authenticated;
