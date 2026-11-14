#!/usr/bin/env python3
"""
Update predictions for the football prediction site.

What it does (all free, standard library only):
  1. Downloads past results   -> football-data.co.uk  (CSV, no key needed)
  2. Downloads fixtures/results for this season -> football-data.org (free token)
  3. Replays every match through an Elo rating model
  4. Turns the ratings into Home / Draw / Away percentages
  5. Writes data/predictions.json (the website reads this file)
  6. Optionally pushes matches to Supabase so fan picks can be scored

Usage:
  FOOTBALL_DATA_TOKEN=xxxx python3 scripts/update_predictions.py
  python3 scripts/update_predictions.py --sample      # offline demo data

Optional env vars for Supabase sync:
  SUPABASE_URL, SUPABASE_SERVICE_KEY
"""
import argparse
import csv
import difflib
import io
import json
import math
import os
import random
import re
import sys
import time
import unicodedata
import urllib.error
import urllib.request
from collections import defaultdict
from datetime import datetime, timedelta, timezone

# --------------------------------------------------------------------------
# Settings
# --------------------------------------------------------------------------
COMPETITIONS = [
    # code, display name, football-data.co.uk league code, starting-rating offset
    {"code": "PL", "name": "Premier League", "csv": "E0", "offset": 40},
    {"code": "PD", "name": "La Liga", "csv": "SP1", "offset": 30},
    {"code": "CL", "name": "Champions League", "csv": None, "offset": None},
]
# Leagues used only so Champions League teams from other countries have ratings.
STRENGTH_ONLY_CSV = {"D1": 20, "I1": 20, "F1": 0}

BASE_RATING = 1500
UNKNOWN_TEAM_RATING = 1470   # teams first seen in the Champions League
K_FACTOR = 20
HOME_ADVANTAGE = 65          # Elo points
DRAW_THETA = 0.55            # controls how often draws are predicted (~26% for even teams)
SEASONS_BACK = 3
WINDOW_PAST_DAYS = 8
WINDOW_FUTURE_DAYS = 16
TABLE_STAGES = {"REGULAR_SEASON", "LEAGUE_STAGE", "GROUP_STAGE"}

# football-data.co.uk names -> words that match football-data.org names
ALIASES = {
    "Man United": "manchester united", "Man City": "manchester city",
    "Nott'm Forest": "nottingham forest", "Tottenham": "tottenham hotspur",
    "Wolves": "wolverhampton wanderers", "Newcastle": "newcastle united",
    "West Ham": "west ham united", "Brighton": "brighton hove albion",
    "Leeds": "leeds united", "Leicester": "leicester city", "Norwich": "norwich city",
    "Ath Madrid": "atletico madrid", "Ath Bilbao": "athletic club",
    "Betis": "real betis", "Sociedad": "real sociedad", "Vallecano": "rayo vallecano",
    "Celta": "celta vigo", "Espanol": "espanyol", "Alaves": "alaves",
    "Paris SG": "paris saint germain", "St Etienne": "saint etienne",
    "M'gladbach": "borussia monchengladbach", "Dortmund": "borussia dortmund",
    "Leverkusen": "bayer leverkusen", "Ein Frankfurt": "eintracht frankfurt",
    "Bayern Munich": "bayern munchen", "Inter": "internazionale milano",
    "Milan": "milan", "Sporting CP": "sporting cp",
}
STOP_WORDS = {"fc", "cf", "afc", "sc", "ssc", "ac", "as", "rc", "rcd", "ca", "cd", "ud",
              "sd", "us", "calcio", "club", "de", "the", "1", "04", "05", "1899", "1909", "1846"}


# --------------------------------------------------------------------------
# Small helpers
# --------------------------------------------------------------------------
def log(*a):
    print(*a, file=sys.stderr)


def norm(name):
    s = unicodedata.normalize("NFKD", name)
    s = "".join(c for c in s if not unicodedata.combining(c)).lower()
    s = re.sub(r"[^a-z0-9 ]+", " ", s.replace("'", ""))
    toks = [t for t in s.split() if t not in STOP_WORDS]
    return " ".join(toks) or s.strip()


class Namer:
    """Makes 'Man United' (CSV) and 'Manchester United FC' (API) the same team."""

    def __init__(self):
        self.known = {}      # key -> display name
        self.cache = {}

    def register(self, display):
        k = norm(display)
        self.known.setdefault(k, display)
        return k

    def key(self, raw):
        if raw in self.cache:
            return self.cache[raw]
        n = norm(ALIASES.get(raw, raw))
        if n in self.known:
            k = n
        else:
            nt = set(n.split())
            cands = [t for t in self.known
                     if nt and (nt <= set(t.split()) or set(t.split()) <= nt)]
            if len(cands) == 1:
                k = cands[0]
            else:
                m = difflib.get_close_matches(n, list(self.known), n=1, cutoff=0.8)
                k = m[0] if m else n
        self.cache[raw] = k
        return k


def http_get(url, headers=None, retries=2, timeout=40):
    req = urllib.request.Request(url, headers={"User-Agent": "football-predictor/1.0", **(headers or {})})
    last = None
    for attempt in range(retries + 1):
        try:
            with urllib.request.urlopen(req, timeout=timeout) as r:
                return r.read()
        except urllib.error.HTTPError as e:
            last = e
            if e.code == 429 and attempt < retries:
                log("  rate limited, waiting 60s...")
                time.sleep(60)
                continue
            if e.code in (403, 404):
                break
        except Exception as e:  # network hiccup
            last = e
            time.sleep(2)
    raise RuntimeError(f"GET {url} failed: {last}")


# --------------------------------------------------------------------------
# The model
# --------------------------------------------------------------------------
def _f(z):
    return 1.0 / (1.0 + math.exp(-z))


def outcome_probs(r_home, r_away):
    """Elo gap -> (P home win, P draw, P away win) using an ordered-logit curve."""
    d = (r_home - r_away + HOME_ADVANTAGE) * math.log(10) / 400.0
    ph = _f(d - DRAW_THETA)
    pa = _f(-d - DRAW_THETA)
    return ph, max(0.0, 1.0 - ph - pa), pa


def to_percent(p):
    """Round three probabilities to whole numbers that add up to 100."""
    raw = [x * 100 for x in p]
    base = [int(x) for x in raw]
    order = sorted(range(3), key=lambda i: raw[i] - base[i], reverse=True)
    for i in order[: 100 - sum(base)]:
        base[i] += 1
    return base


def goal_multiplier(gd):
    gd = abs(gd)
    return 1.0 if gd <= 1 else (1.5 if gd == 2 else (11 + gd) / 8.0)


def replay(events, stat_from):
    """Run every finished match through Elo, in date order.

    Returns (ratings, pre_match_probs_by_id, stats).
    """
    ratings = {}
    pre = {}
    hits = home_hits = n = 0
    for ev in sorted(events, key=lambda e: e["date"]):
        h, a = ev["home"], ev["away"]
        for t in (h, a):
            if t not in ratings:
                ratings[t] = (BASE_RATING + ev["offset"]) if ev.get("offset") is not None else UNKNOWN_TEAM_RATING
        ph, pd, pa = outcome_probs(ratings[h], ratings[a])
        if ev.get("id") is not None:
            pre[ev["id"]] = (ph, pd, pa)
        hg, ag = ev["hg"], ev["ag"]
        result = 0 if hg > ag else (2 if hg < ag else 1)   # 0=home 1=draw 2=away
        if ev["date"] >= stat_from and ev.get("domestic"):
            n += 1
            probs = (ph, pd, pa)
            hits += 1 if max(range(3), key=lambda i: probs[i]) == result else 0
            home_hits += 1 if result == 0 else 0
        exp_home = ph + 0.5 * pd
        score = 1.0 if result == 0 else (0.0 if result == 2 else 0.5)
        delta = K_FACTOR * goal_multiplier(hg - ag) * (score - exp_home)
        ratings[h] += delta
        ratings[a] -= delta
    stats = {"matches": n,
             "accuracy": round(hits / n, 3) if n else None,
             "always_home_accuracy": round(home_hits / n, 3) if n else None}
    return ratings, pre, stats


# --------------------------------------------------------------------------
# Parsing data sources
# --------------------------------------------------------------------------
def season_start_year(today):
    return today.year if today.month >= 7 else today.year - 1


def season_code(start_year):
    return f"{start_year % 100:02d}{(start_year + 1) % 100:02d}"


def parse_csv_events(text, league_code, offset, domestic):
    """football-data.co.uk CSV text -> list of finished-match events."""
    out = []
    reader = csv.DictReader(io.StringIO(text.lstrip("﻿")))
    for row in reader:
        try:
            ds = (row.get("Date") or "").strip()
            if not ds:
                continue
            fmt = "%d/%m/%Y" if len(ds.split("/")[-1]) == 4 else "%d/%m/%y"
            d = datetime.strptime(ds, fmt).replace(hour=12, tzinfo=timezone.utc)
            hg, ag = int(row["FTHG"]), int(row["FTAG"])
        except (ValueError, KeyError, TypeError):
            continue
        out.append({"date": d, "home_raw": row["HomeTeam"].strip(), "away_raw": row["AwayTeam"].strip(),
                    "hg": hg, "ag": ag, "offset": offset, "domestic": domestic, "league": league_code})
    return out


STATUS_MAP = {"FINISHED": "FINISHED", "AWARDED": "FINISHED", "IN_PLAY": "LIVE", "PAUSED": "LIVE",
              "SCHEDULED": "UPCOMING", "TIMED": "UPCOMING",
              "POSTPONED": "POSTPONED", "SUSPENDED": "POSTPONED", "CANCELLED": "POSTPONED"}


def parse_api_match(m):
    ft = (m.get("score") or {}).get("fullTime") or {}
    team = lambda t: {"name": t.get("shortName") or t.get("name") or "TBC",
                      "full": t.get("name") or "TBC", "tla": t.get("tla") or "",
                      "crest": t.get("crest") or ""}
    return {
        "id": m["id"],
        "date": datetime.fromisoformat(m["utcDate"].replace("Z", "+00:00")),
        "status": STATUS_MAP.get(m.get("status"), "UPCOMING"),
        "matchday": m.get("matchday"),
        "stage": m.get("stage"),
        "home": team(m.get("homeTeam") or {}),
        "away": team(m.get("awayTeam") or {}),
        "hg": ft.get("home"), "ag": ft.get("away"),
    }


# --------------------------------------------------------------------------
# Building the output
# --------------------------------------------------------------------------
def build_table(matches):
    rows = {}
    for m in sorted(matches, key=lambda x: x["date"]):
        if m["status"] != "FINISHED" or m["hg"] is None or m["stage"] not in TABLE_STAGES:
            continue
        for side, other, gf, ga in (("home", "away", m["hg"], m["ag"]), ("away", "home", m["ag"], m["hg"])):
            t = m[side]
            r = rows.setdefault(t["full"], {"team": t["name"], "tla": t["tla"], "crest": t.get("crest", ""), "p": 0, "w": 0, "d": 0,
                                            "l": 0, "gf": 0, "ga": 0, "pts": 0, "form": []})
            r["p"] += 1
            r["gf"] += gf
            r["ga"] += ga
            res = "W" if gf > ga else ("L" if gf < ga else "D")
            r["w" if res == "W" else ("l" if res == "L" else "d")] += 1
            r["pts"] += 3 if res == "W" else (1 if res == "D" else 0)
            r["form"].append(res)
    table = sorted(rows.values(), key=lambda r: (-r["pts"], -(r["gf"] - r["ga"]), -r["gf"], r["team"]))
    for i, r in enumerate(table, 1):
        r["pos"] = i
        r["gd"] = r["gf"] - r["ga"]
        r["form"] = r["form"][-5:]
    return table


def build_output(api_matches, csv_events, now, namer, sample=False):
    """api_matches: {comp_code: [parsed api matches]}; csv_events: parsed CSV events."""
    for comp in api_matches.values():
        for m in comp:
            for side in ("home", "away"):
                namer.register(m[side]["full"])

    events = []
    for e in csv_events:
        events.append({"date": e["date"], "home": namer.key(e["home_raw"]), "away": namer.key(e["away_raw"]),
                       "hg": e["hg"], "ag": e["ag"], "offset": e["offset"], "domestic": e["domestic"]})
    for code, comp in api_matches.items():
        cfg = next(c for c in COMPETITIONS if c["code"] == code)
        for m in comp:
            if m["status"] == "FINISHED" and m["hg"] is not None:
                events.append({"id": m["id"], "date": m["date"], "home": namer.key(m["home"]["full"]),
                               "away": namer.key(m["away"]["full"]), "hg": m["hg"], "ag": m["ag"],
                               "offset": cfg["offset"], "domestic": code != "CL"})

    ratings, pre, stats = replay(events, now - timedelta(days=365))
    log(f"model check over last year: {stats}")

    # Warn about current league clubs with no past results: usually a name that did not match
    # (add it to ALIASES). Newly promoted clubs can legitimately show up here too.
    history = {namer.key(e["home_raw"]) for e in csv_events if e["domestic"]} | \
              {namer.key(e["away_raw"]) for e in csv_events if e["domestic"]}
    if history:
        for code in ("PL", "PD"):
            missing = sorted({m[s]["full"] for m in api_matches.get(code, []) for s in ("home", "away")
                              if namer.key(m[s]["full"]) not in history})
            if missing:
                log(f"WARNING {code}: no match history found for: {', '.join(missing)} "
                    "(promoted club, or add a line to ALIASES)")

    start, end = now - timedelta(days=WINDOW_PAST_DAYS), now + timedelta(days=WINDOW_FUTURE_DAYS)
    comps_out = []
    for cfg in COMPETITIONS:
        ms = api_matches.get(cfg["code"], [])
        out_matches = []
        for m in sorted(ms, key=lambda x: x["date"]):
            if not (start <= m["date"] <= end):
                continue
            hk, ak = namer.key(m["home"]["full"]), namer.key(m["away"]["full"])
            if m["id"] in pre:
                probs = pre[m["id"]]
            else:
                probs = outcome_probs(ratings.get(hk, UNKNOWN_TEAM_RATING), ratings.get(ak, UNKNOWN_TEAM_RATING))
            ph, pd_, pa = to_percent(probs)
            out_matches.append({
                "id": m["id"], "kickoff": m["date"].isoformat().replace("+00:00", "Z"),
                "status": m["status"], "matchday": m["matchday"], "stage": m["stage"],
                "home": {"name": m["home"]["name"], "tla": m["home"]["tla"], "crest": m["home"].get("crest", ""),
                         "elo": round(ratings.get(hk, UNKNOWN_TEAM_RATING))},
                "away": {"name": m["away"]["name"], "tla": m["away"]["tla"], "crest": m["away"].get("crest", ""),
                         "elo": round(ratings.get(ak, UNKNOWN_TEAM_RATING))},
                "score": {"home": m["hg"], "away": m["ag"]} if m["status"] in ("FINISHED", "LIVE") else None,
                "prob": {"home": ph, "draw": pd_, "away": pa},
            })
        comps_out.append({"code": cfg["code"], "name": cfg["name"], "matches": out_matches,
                          "table": build_table(ms)})
    return {
        "generated_at": now.isoformat().replace("+00:00", "Z"),
        "sample": sample,
        "season": f"{season_start_year(now)}/{(season_start_year(now) + 1) % 100:02d}",
        "model": {"name": "Elo ratings + ordered logit", **stats},
        "competitions": comps_out,
    }


# --------------------------------------------------------------------------
# Live data fetching
# --------------------------------------------------------------------------
def fetch_api_matches(token):
    out = {}
    for i, cfg in enumerate(COMPETITIONS):
        if i:
            time.sleep(6.5)   # free tier: 10 requests per minute
        log(f"football-data.org: {cfg['code']} ...")
        raw = http_get(f"https://api.football-data.org/v4/competitions/{cfg['code']}/matches",
                       headers={"X-Auth-Token": token})
        out[cfg["code"]] = [parse_api_match(m) for m in json.loads(raw)["matches"]]
        log(f"  {len(out[cfg['code']])} matches")
    return out


def fetch_csv_events(now):
    cur = season_start_year(now)
    events = []
    jobs = []
    for cfg in COMPETITIONS:
        if cfg["csv"]:
            for s in range(cur - SEASONS_BACK, cur):       # finished seasons only: API covers this one
                jobs.append((cfg["csv"], s, cfg["offset"], True))
    for code, off in STRENGTH_ONLY_CSV.items():
        for s in range(cur - SEASONS_BACK, cur + 1):
            jobs.append((code, s, off, False))
    for code, s, off, dom in jobs:
        url = f"https://www.football-data.co.uk/mmz4281/{season_code(s)}/{code}.csv"
        try:
            text = http_get(url).decode("utf-8-sig", errors="replace")
            ev = parse_csv_events(text, code, off, dom)
            log(f"football-data.co.uk: {code} {season_code(s)} -> {len(ev)} matches")
            events += ev
        except RuntimeError as e:
            log(f"  skipped {code} {season_code(s)}: {e}")
    return events


# --------------------------------------------------------------------------
# Supabase sync (optional)
# --------------------------------------------------------------------------
def sync_supabase(output):
    url, key = os.environ.get("SUPABASE_URL"), os.environ.get("SUPABASE_SERVICE_KEY")
    if not (url and key):
        log("Supabase not configured - skipping sync.")
        return
    rows = []
    for comp in output["competitions"]:
        for m in comp["matches"]:
            rows.append({
                "id": m["id"], "competition": comp["code"], "matchday": m["matchday"],
                "kickoff": m["kickoff"], "status": m["status"],
                "home_name": m["home"]["name"], "away_name": m["away"]["name"],
                "home_tla": m["home"]["tla"], "away_tla": m["away"]["tla"],
                "home_goals": (m["score"] or {}).get("home"), "away_goals": (m["score"] or {}).get("away"),
                "p_home": m["prob"]["home"], "p_draw": m["prob"]["draw"], "p_away": m["prob"]["away"],
            })
    req = urllib.request.Request(
        url.rstrip("/") + "/rest/v1/matches?on_conflict=id", data=json.dumps(rows).encode(), method="POST",
        headers={"apikey": key, "Authorization": f"Bearer {key}", "Content-Type": "application/json",
                 "Prefer": "resolution=merge-duplicates,return=minimal"})
    with urllib.request.urlopen(req, timeout=60) as r:
        log(f"Supabase: synced {len(rows)} matches (HTTP {r.status}).")


# --------------------------------------------------------------------------
# Offline demo data (clearly flagged "sample": true in the output)
# --------------------------------------------------------------------------
SAMPLE_TEAMS = {
    "PL": ["Arsenal", "Manchester City", "Liverpool", "Chelsea", "Tottenham Hotspur", "Manchester United",
           "Newcastle United", "Aston Villa", "Brighton Hove Albion", "West Ham United", "Crystal Palace",
           "Fulham", "Brentford", "Everton", "Wolverhampton Wanderers", "Bournemouth", "Nottingham Forest",
           "Leeds United", "Sunderland", "Burnley"],
    "PD": ["Real Madrid", "Barcelona", "Atletico Madrid", "Athletic Club", "Real Sociedad", "Villarreal",
           "Real Betis", "Sevilla", "Valencia", "Girona", "Celta Vigo", "Osasuna", "Getafe",
           "Rayo Vallecano", "Mallorca", "Espanyol", "Alaves", "Elche", "Levante", "Oviedo"],
    "CL_EXTRA": ["Bayern Munchen", "Internazionale Milano", "Paris Saint Germain", "Juventus", "Benfica",
                 "Borussia Dortmund", "Napoli", "Sporting CP", "Ajax"],
}


def _poisson(rng, lam):
    l, k, p = math.exp(-lam), 0, 1.0
    while True:
        p *= rng.random()
        if p <= l:
            return k
        k += 1


def _round_robin(teams):
    t = list(teams)
    n = len(t)
    rounds = []
    for r in range(n - 1):
        rounds.append([(t[i], t[n - 1 - i]) for i in range(n // 2)])
        t = [t[0]] + [t[-1]] + t[1:-1]
    second = [[(b, a) for a, b in rd] for rd in rounds]
    return rounds + second


def make_sample(now, seed=7):
    rng = random.Random(seed)
    strength = {}
    for grp in SAMPLE_TEAMS.values():
        for i, t in enumerate(grp):
            strength[t] = 1750 - i * 14 + rng.uniform(-25, 25)
    strength.update({"Bayern Munchen": 1850, "Internazionale Milano": 1790, "Paris Saint Germain": 1810})

    def score(a, b):
        lh = 1.4 * 10 ** ((strength[a] - strength[b] + HOME_ADVANTAGE) / 800)
        la = 1.1 * 10 ** ((strength[b] - strength[a] - HOME_ADVANTAGE) / 800)
        return _poisson(rng, lh), _poisson(rng, la)

    sat = (now + timedelta(days=(5 - now.weekday()) % 7)).replace(hour=0, minute=0, second=0, microsecond=0)
    slots = [(12, 30), (15, 0), (15, 0), (17, 30), (20, 0)]
    csv_events, api = [], {}
    cur = season_start_year(now)
    next_id = 1000

    for cfg in COMPETITIONS[:2]:
        teams = SAMPLE_TEAMS[cfg["code"]]
        sched = _round_robin(teams)
        # two finished past seasons -> "csv" history
        for yrs in (2, 1):
            for md, rd in enumerate(sched):
                d = datetime(cur - yrs, 8, 15, 12, tzinfo=timezone.utc) + timedelta(days=7 * md)
                for a, b in rd:
                    hg, ag = score(a, b)
                    csv_events.append({"date": d, "home_raw": a, "away_raw": b, "hg": hg, "ag": ag,
                                       "offset": cfg["offset"], "domestic": True})
        # current season: matchday 12 is the coming Saturday
        matches = []
        for md, rd in enumerate(sched[:20], 1):
            base = sat - timedelta(days=7 * (12 - md))
            for i, (a, b) in enumerate(rd):
                hh, mm = slots[i % len(slots)]
                d = (base + timedelta(days=0 if i < 6 else (1 if i < 9 else 2), hours=hh, minutes=mm))
                done = d < now
                hg, ag = score(a, b) if done else (None, None)
                short = lambda n: n.split()[0][:3].upper() if len(n.split()) == 1 else (n.split()[0][0] + n.split()[1][:2]).upper()
                matches.append({"id": next_id, "date": d, "status": "FINISHED" if done else "UPCOMING",
                                "matchday": md, "stage": "REGULAR_SEASON",
                                "home": {"name": a, "full": a, "tla": short(a)},
                                "away": {"name": b, "full": b, "tla": short(b)}, "hg": hg, "ag": ag})
                next_id += 1
        api[cfg["code"]] = matches

    # Champions League: 16 teams, matchdays on Tue/Wed every 3 weeks
    cl = SAMPLE_TEAMS["PL"][:4] + SAMPLE_TEAMS["PD"][:3] + SAMPLE_TEAMS["CL_EXTRA"]
    tue = (now + timedelta(days=(1 - now.weekday()) % 7 + 7)).replace(hour=0, minute=0, second=0, microsecond=0)
    matches = []
    for md in range(1, 7):
        base = tue - timedelta(days=21 * (5 - md))
        pool = cl[:]
        rng.shuffle(pool)
        for i in range(0, len(pool) - 1, 2):
            a, b = pool[i], pool[i + 1]
            d = base + timedelta(days=i % 2, hours=17 + 2 * (i % 2), minutes=45 if i % 4 else 0)
            done = d < now
            hg, ag = score(a, b) if done else (None, None)
            short = lambda n: n.split()[0][:3].upper()
            matches.append({"id": next_id, "date": d, "status": "FINISHED" if done else "UPCOMING",
                            "matchday": md, "stage": "LEAGUE_STAGE",
                            "home": {"name": a, "full": a, "tla": short(a)},
                            "away": {"name": b, "full": b, "tla": short(b)}, "hg": hg, "ag": ag})
            next_id += 1
    api["CL"] = matches
    return api, csv_events


# --------------------------------------------------------------------------
def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--sample", action="store_true", help="make offline demo data (no internet, no token)")
    ap.add_argument("--out", default=os.path.join(os.path.dirname(__file__), "..", "data", "predictions.json"))
    ap.add_argument("--no-supabase", action="store_true")
    args = ap.parse_args()

    now = datetime.now(timezone.utc).replace(microsecond=0)
    namer = Namer()
    if args.sample:
        api, csv_events = make_sample(now)
    else:
        token = os.environ.get("FOOTBALL_DATA_TOKEN")
        if not token:
            sys.exit("Set FOOTBALL_DATA_TOKEN (free at https://www.football-data.org/client/register) "
                     "or run with --sample.")
        api = fetch_api_matches(token)
        for comp in api.values():                   # register API names first so CSV names can match them
            for m in comp:
                namer.register(m["home"]["full"])
                namer.register(m["away"]["full"])
        csv_events = fetch_csv_events(now)

    output = build_output(api, csv_events, now, namer, sample=args.sample)

    os.makedirs(os.path.dirname(os.path.abspath(args.out)), exist_ok=True)
    total = sum(len(c["matches"]) for c in output["competitions"])
    try:                                    # leave the file alone if only the timestamp changed
        with open(args.out, encoding="utf-8") as f:
            old = json.load(f)
        same = {**old, "generated_at": None} == {**output, "generated_at": None}
    except (OSError, ValueError):
        same = False
    if same:
        log(f"No changes since the last run ({total} matches). File left as it was.")
    else:
        with open(args.out, "w", encoding="utf-8") as f:
            json.dump(output, f, ensure_ascii=False, indent=1)
        log(f"Wrote {args.out} ({total} matches in the window).")

    if not args.sample and not args.no_supabase:
        try:
            sync_supabase(output)
        except Exception as e:
            log(f"Supabase sync failed (website data was still written): {e}")


if __name__ == "__main__":
    main()
