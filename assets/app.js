/* Page logic: loads data/predictions.json, draws matches, tables and the leaderboard,
   and handles picks. Two storage modes:
     demo   (default)  picks live in this browser only
     online (Supabase) picks are saved per user, locked by the database at kickoff */
(function () {
  'use strict';

  var CFG = window.SITE_CONFIG;
  var SUPABASE_JS = 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.45.4/dist/umd/supabase.min.js';
  var $ = function (s, r) { return (r || document).querySelector(s); };
  var esc = function (s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  };

  var state = {
    data: null, comp: null, view: 'upcoming',
    mode: CFG.supabaseUrl && CFG.supabaseAnonKey ? 'online' : 'demo',
    picks: new Map(),      // matchId -> { pick: 'H'|'D'|'A', points: number|null, kickoff }
    votes: new Map(),      // matchId -> { H, D, A }
    leaders: [], user: null, name: '', justPicked: null, bannerClosed: false,
    isOwner: false, ownerFor: null,
    counts: new Map(), threads: new Map(), cmtId: null, cmtTab: 'talk', drafts: new Map(), authMode: 'in'
  };

  /* ---------- small helpers ---------- */
  function allMatches() {
    var out = [];
    state.data.competitions.forEach(function (c) { c.matches.forEach(function (m) { out.push(m); }); });
    return out;
  }
  function hue(name) { var h = 0; for (var i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) % 360; return h; }
  function tla(t) { return (t.tla || t.name.replace(/[^A-Za-z]/g, '').slice(0, 3)).toUpperCase(); }
  function badge(t) {
    var img = /^https:\/\//.test(t.crest || '') ? '<img src="' + esc(t.crest) + '" alt="" loading="lazy" referrerpolicy="no-referrer" onerror="this.remove()">' : '';
    return '<span class="badge' + (img ? ' has-crest' : '') + '" style="--h:' + hue(t.name) + '"><span class="bl">' + esc(tla(t)) + '</span>' + img + '</span>';
  }
  function kickDate(m) { return new Date(m.kickoff); }
  function result(m) {
    if (m.status !== 'FINISHED' || !m.score || m.score.home == null) return null;
    return m.score.home > m.score.away ? 'H' : (m.score.home < m.score.away ? 'A' : 'D');
  }
  function probOf(m, c) { return m.prob[c === 'H' ? 'home' : (c === 'D' ? 'draw' : 'away')]; }
  function scorePick(m, pick) {
    var res = result(m);
    if (!res) return null;
    if (res !== pick) return 0;
    return CFG.pointsCorrect + (probOf(m, pick) < CFG.bonusBelowPercent ? CFG.bonusPoints : 0);
  }
  function pct3(a, b, c) {                      // whole numbers that add to 100
    var t = a + b + c; if (!t) return null;
    var raw = [a, b, c].map(function (x) { return x * 100 / t; });
    var base = raw.map(Math.floor), left = 100 - base.reduce(function (x, y) { return x + y; }, 0);
    raw.map(function (x, i) { return [x - base[i], i]; }).sort(function (x, y) { return y[0] - x[0]; })
      .slice(0, left).forEach(function (p) { base[p[1]]++; });
    return base;
  }
  function weekStart(d) {                       // Monday 00:00 UTC, same as Postgres date_trunc('week')
    var t = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
    return t - ((new Date(t).getUTCDay() + 6) % 7) * 864e5;
  }
  function myPoints() {
    var s = 0;
    state.picks.forEach(function (p) { if (typeof p.points === 'number') s += p.points; });
    return s;
  }
  function levelFor(pts) {
    var i = 0;
    CFG.levels.forEach(function (l, k) { if (pts >= l.min) i = k; });
    return { i: i, cur: CFG.levels[i], next: CFG.levels[i + 1] || null };
  }
  function usedInWeek(wk) {
    var n = 0;
    state.picks.forEach(function (p) { if (p.kickoff && weekStart(new Date(p.kickoff)) === wk) n++; });
    return n;
  }
  function picksLeftFor(m) {
    return levelFor(myPoints()).cur.picks - usedInWeek(weekStart(kickDate(m)));
  }
  function isLocked(m) { return m.status !== 'UPCOMING' || Date.now() >= kickDate(m).getTime(); }
  function toast(msg, isErr) {
    var t = $('#toast');
    t.textContent = msg; t.className = 'toast' + (isErr ? ' err' : ''); t.hidden = false;
    clearTimeout(toast.t); toast.t = setTimeout(function () { t.hidden = true; }, 3600);
  }
  function ago(iso) {
    var m = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
    if (m < 2) return 'just now';
    if (m < 90) return m + ' minutes ago';
    if (m < 2880) return Math.round(m / 60) + ' hours ago';
    return Math.round(m / 1440) + ' days ago';
  }
  function loadScript(src) {
    return new Promise(function (ok, bad) {
      var s = document.createElement('script');
      s.src = src; s.onload = ok; s.onerror = function () { bad(new Error('Could not load ' + src)); };
      document.head.appendChild(s);
    });
  }

  /* ---------- storage: demo (this browser only) ---------- */
  var Local = {
    key: 'pc_picks_v1',
    init: function () {
      var raw = {};
      try { raw = JSON.parse(localStorage.getItem(this.key) || '{}'); } catch (e) {}
      state.picks = new Map(Object.keys(raw).map(function (k) { return [+k, raw[k]]; }));
      this.settle();
      return Promise.resolve();
    },
    persist: function () {
      var o = {}; state.picks.forEach(function (v, k) { o[k] = v; });
      try { localStorage.setItem(this.key, JSON.stringify(o)); } catch (e) {}
    },
    settle: function () {                       // award points once a match has finished
      allMatches().forEach(function (m) {
        var p = state.picks.get(m.id);
        if (p && p.points == null) { var s = scorePick(m, p.pick); if (s != null) p.points = s; }
      });
      this.persist();
    },
    savePick: function (m, c) {
      if (isLocked(m)) return Promise.reject(new Error('This match has started. Picks are closed.'));
      if (!state.picks.has(m.id) && picksLeftFor(m) <= 0) return Promise.reject(new Error('No picks left this week. Win points to get more.'));
      state.picks.set(m.id, { pick: c, points: null, kickoff: m.kickoff });
      this.persist();
      return Promise.resolve();
    },
    ckey: 'pc_comments_v1',
    _all: function () { try { return JSON.parse(localStorage.getItem(this.ckey) || '[]'); } catch (e) { return []; } },
    loadCounts: function () {
      var c = new Map(); this._all().forEach(function (x) { c.set(x.match_id, (c.get(x.match_id) || 0) + 1); });
      state.counts = c; return Promise.resolve();
    },
    loadComments: function (id) {
      return Promise.resolve(this._all().filter(function (x) { return x.match_id === id; }).map(function (x) {
        return { id: x.id, name: 'You', body: x.body, created_at: x.created_at, mine: true };
      }).reverse());
    },
    addComment: function (id, body) {
      var all = this._all(); all.push({ id: Date.now(), match_id: id, body: body, created_at: new Date().toISOString() });
      try { localStorage.setItem(this.ckey, JSON.stringify(all.slice(-200))); } catch (e) {}
      return Promise.resolve();
    },
    deleteComment: function (cid) {
      try { localStorage.setItem(this.ckey, JSON.stringify(this._all().filter(function (x) { return String(x.id) !== String(cid); }))); } catch (e) {}
      return Promise.resolve();
    },
    loadVotes: function () { return Promise.resolve(); },
    loadLeaders: function () { return Promise.resolve([]); },
    reset: function () { state.picks = new Map(); this.persist(); }
  };

  /* ---------- storage: online (Supabase) ---------- */
  var Online = {
    client: null,
    init: function () {
      var self = this;
      return loadScript(SUPABASE_JS).then(function () {
        self.client = window.supabase.createClient(CFG.supabaseUrl, CFG.supabaseAnonKey);
        return self.client.auth.getSession();
      }).then(function (r) {
        return self.apply(r.data.session).then(function () {
          self.client.auth.onAuthStateChange(function (_e, s) {
            self.apply(s).then(function () { refreshAll(); if (_e === 'PASSWORD_RECOVERY') openAccount('reset'); });
          });
        });
      });
    },
    apply: function (session) {
      var self = this;
      state.user = session && session.user ? { id: session.user.id, email: session.user.email } : null;
      if (!state.user) { state.name = ''; state.picks = new Map(); return Promise.resolve(); }
      return self.client.from('profiles').select('display_name').eq('id', state.user.id).maybeSingle()
        .then(function (r) {
          if (r.error) throw r.error;
          state.name = (r.data && r.data.display_name) || ''; return self.loadPicks();
        }).catch(function (e) {                       // stay signed in even if the picks cannot be read
          state.picks = new Map();
          toast('Signed in, but the database said: ' + (e.message || e), true);
        });
    },
    loadPicks: function () {
      return this.client.from('picks').select('match_id,pick,points,matches(kickoff)').then(function (r) {
        if (r.error) throw r.error;
        state.picks = new Map(r.data.map(function (x) {
          return [x.match_id, { pick: x.pick, points: x.points, kickoff: x.matches && x.matches.kickoff }];
        }));
      });
    },
    savePick: function (m, c) {
      var self = this, q;
      if (state.picks.has(m.id)) q = self.client.from('picks').update({ pick: c }).eq('match_id', m.id).eq('user_id', state.user.id);
      else q = self.client.from('picks').insert({ match_id: m.id, pick: c, user_id: state.user.id });
      return q.then(function (r) { if (r.error) throw new Error(r.error.message); return self.loadPicks(); });
    },
    loadVotes: function (ids) {
      return this.client.from('match_votes').select('*').in('match_id', ids).then(function (r) {
        if (r.error) return;
        state.votes = new Map(r.data.map(function (x) { return [x.match_id, { H: x.h, D: x.d, A: x.a }]; }));
      });
    },
    loadLeaders: function () {
      return this.client.from('leaderboard').select('*').then(function (r) { return r.error ? [] : r.data; });
    },
    home: function () { return location.href.split('#')[0]; },
    signUp: function (email, pw, name) {
      return this.client.auth.signUp({ email: email, password: pw, options: { data: { name: name }, emailRedirectTo: this.home() } })
        .then(function (r) { if (r.error) throw r.error; return !!r.data.session; });
    },
    signInPw: function (email, pw) {
      return this.client.auth.signInWithPassword({ email: email, password: pw }).then(function (r) { if (r.error) throw r.error; });
    },
    forgot: function (email) {
      return this.client.auth.resetPasswordForEmail(email, { redirectTo: this.home() }).then(function (r) { if (r.error) throw r.error; });
    },
    newPassword: function (pw) {
      return this.client.auth.updateUser({ password: pw }).then(function (r) { if (r.error) throw r.error; });
    },
    loadCounts: function (ids) {
      return this.client.from('comment_counts').select('*').in('match_id', ids).then(function (r) {
        if (r.error) return;
        state.counts = new Map(r.data.map(function (x) { return [x.match_id, x.n]; }));
      });
    },
    loadComments: function (id) {
      return this.client.from('comments_public').select('*').eq('match_id', id).order('created_at', { ascending: false }).limit(50)
        .then(function (r) { if (r.error) throw new Error(r.error.message); return r.data; });
    },
    addComment: function (id, body) {
      return this.client.from('comments').insert({ match_id: id, body: body, user_id: state.user.id })
        .then(function (r) { if (r.error) throw new Error(r.error.message); });
    },
    deleteComment: function (cid) {
      var c = this.client;
      var q = state.isOwner ? c.rpc('admin_delete_comment', { target: cid }) : c.from('comments').delete().eq('id', cid);
      return q.then(function (r) { if (r.error) throw new Error(r.error.message); });
    },
    signOut: function () { return this.client.auth.signOut(); },
    setName: function (n) {
      return this.client.from('profiles').update({ display_name: n }).eq('id', state.user.id).then(function (r) {
        if (r.error) throw new Error(/duplicate|unique/i.test(r.error.message) ? 'That name is taken. Try another.' : r.error.message);
        state.name = n;
      });
    }
  };
  var store = state.mode === 'online' ? Online : Local;

  /* ---------- rendering ---------- */
  function currentComp() {
    return state.data.competitions.filter(function (c) { return c.code === state.comp; })[0];
  }

  function renderStats() {
    var mdl = state.data.model || {};
    if (mdl.accuracy != null) {
      $('#hitRate').textContent = Math.round(mdl.accuracy * 100) + '%';
      $('#hitCap').textContent = 'of league games called right. Always backing the home team gets ' + Math.round(mdl.always_home_accuracy * 100) + '%.';
      $('#hitCap').title = 'Checked on ' + mdl.matches + ' league games from the last year' + (state.data.sample ? ' (demo data)' : '');
    } else { $('#hitRate').textContent = '–'; $('#hitCap').textContent = 'Shows up after the first update'; }
    $('#ptsBig').textContent = '+' + CFG.pointsCorrect;
    $('#ptsCap').textContent = 'points for a right pick. ' + (CFG.pointsCorrect + CFG.bonusPoints) + ' if you back a long shot.';
    tickClock();
  }

  function nextMatch() {
    var now = Date.now(), best = null;
    allMatches().forEach(function (m) {
      var t = kickDate(m).getTime();
      if (m.status === 'UPCOMING' && t > now && (!best || t < kickDate(best).getTime())) best = m;
    });
    return best;
  }
  function tickClock() {
    var m = nextMatch(), clock = $('#nextClock'), cap = $('#nextCap');
    if (!m) { clock.textContent = '–'; cap.textContent = 'No match coming up yet'; return; }
    var s = Math.max(0, Math.floor((kickDate(m).getTime() - Date.now()) / 1000));
    var d = Math.floor(s / 86400), h = Math.floor(s % 86400 / 3600), mi = Math.floor(s % 3600 / 60), sec = s % 60;
    var p = function (n) { return String(n).padStart(2, '0'); };
    clock.textContent = d ? d + 'd ' + h + 'h' : (h ? h + 'h ' + p(mi) + 'm' : p(mi) + ':' + p(sec));
    cap.textContent = 'until ' + m.home.name + ' v ' + m.away.name;
  }

  function renderBanner() {
    var b = $('#banner');
    var msgs = [];
    if (state.data.sample && state.mode === 'demo') msgs.push('These matches are made up so you can try the site. Your picks stay on this device.');
    else if (state.data.sample) msgs.push('These matches are made up so you can try the site.');
    else if (state.mode === 'demo') msgs.push('Your picks are saved on this device only.');
    b.hidden = state.bannerClosed || !msgs.length;
    $('#bannerText').textContent = msgs.join(' ');
  }

  function renderTabs() {
    var tabsHTML = state.data.competitions.map(function (c) {
      return '<button class="tab" role="tab" type="button" data-comp="' + c.code + '" aria-selected="' + (c.code === state.comp) + '">' + esc(c.name) + '</button>';
    }).join('');
    $('#tabs').innerHTML = tabsHTML; $('#tabs2').innerHTML = tabsHTML;
    document.querySelectorAll('#views button').forEach(function (b) { b.setAttribute('aria-pressed', String(b.dataset.view === state.view)); });
    $('#updated').textContent = 'Times are in your local time. ' + (state.data.sample ? 'Demo data.' : 'Updated ' + ago(state.data.generated_at) + '.');
  }

  function renderQuota() {
    var q = $('#quota'), pts = myPoints(), lv = levelFor(pts), pips = '';
    var left = Math.max(0, lv.cur.picks - usedInWeek(weekStart(new Date())));
    for (var i = 0; i < lv.cur.picks; i++) pips += '<span class="pip' + (i < left ? ' on' : '') + '"></span>';
    var next = lv.next ? (lv.next.min - pts) + ' more points for ' + lv.next.name + ' (' + lv.next.picks + ' picks a week).' : "You're at the top level.";
    q.innerHTML = '<span class="lvl">' + esc(lv.cur.name) + '<small>' + pts + ' points</small></span>' +
      '<span class="pips" role="img" aria-label="' + left + ' of ' + lv.cur.picks + ' picks left this week">' + pips + '</span>' +
      '<span class="quota-note"><b>' + left + ' of ' + lv.cur.picks + '</b> picks left this week. ' + next + '</span>';
  }

  function barHTML(a, b, c, animate) {
    var segs = [a, b, c].map(function (v, i) {
      return '<span class="s ' + ['h', 'd', 'a'][i] + '" data-g="' + v + '" style="--g:' + (animate ? 0 : v) + '"></span>';
    }).join('');
    return '<div class="bar3" aria-hidden="true">' + segs + '</div>';
  }

  function cardHTML(m, animate) {
    var d = kickDate(m), done = m.status === 'FINISHED', mine = state.picks.get(m.id);
    var locked = isLocked(m), res = result(m);
    var pr = [m.prob.home, m.prob.draw, m.prob.away], keys = ['H', 'D', 'A'];
    var names = [m.home.name, 'Draw', m.away.name];
    var mid = done || (m.status === 'LIVE' && m.score)
      ? '<span class="score">' + m.score.home + '–' + m.score.away + '</span>' : '<span class="vs">v</span>';
    var tag = m.status === 'LIVE' ? '<span class="tag">Live</span>' :
      (m.status === 'POSTPONED' ? '<span class="tag">Postponed</span>' : (done ? '<span>Full time</span>' :
        (m.stage && m.stage !== 'REGULAR_SEASON' ? '<span>' + esc(String(m.stage).replace(/_/g, ' ').toLowerCase()) + '</span>' : '<span>Matchday ' + (m.matchday || '') + '</span>')));

    var left = mine ? 1 : picksLeftFor(m);
    var open = !done && m.status !== 'POSTPONED' && !locked;
    var canTap = open && !(state.mode === 'demo' && !mine && left <= 0);

    var choices = keys.map(function (c, i) {
      var extra = '<span class="cb">' + (done ? (res === c ? 'Happened' : '&nbsp;')
        : (open && pr[i] < CFG.bonusBelowPercent ? '+' + CFG.bonusPoints + ' bonus' : '&nbsp;')) + '</span>';
      var inner = '<span class="cn">' + esc(names[i]) + '</span><span class="cp">' + pr[i] + '<small>%</small></span>' + extra;
      var cls = 'choice ' + ['h', 'd', 'a'][i] + (done && res === c ? ' won' : '') + (!done && pr[i] === Math.max.apply(null, pr) ? ' fav' : '');
      if (done) return '<div class="' + cls + '">' + inner + '</div>';
      return '<button type="button" class="' + cls + '"' + (canTap ? ' data-act="pick" data-id="' + m.id + '" data-c="' + c + '"' : ' disabled') +
        ' aria-pressed="' + (!!mine && mine.pick === c) + '" aria-label="' + esc(names[i]) + ', ' + pr[i] + ' percent chance. ' +
        (c === 'D' ? 'Pick a draw' : 'Pick ' + esc(names[i])) + '">' + inner + '</button>';
    }).join('');

    var v = state.votes.get(m.id), n = v ? v.H + v.D + v.A : 0, fans = '';
    if (n > 0) {
      var f = pct3(v.H, v.D, v.A);
      fans = '<p class="fans">Fans (' + n + (n === 1 ? ' vote' : ' votes') + '): <span class="fh">' + esc(tla(m.home)) + ' ' + f[0] +
        '%</span> <span class="fd">Draw ' + f[1] + '%</span> <span class="fa">' + esc(tla(m.away)) + ' ' + f[2] + '%</span></p>';
    }

    var note;
    if (done) {
      var who = res === 'H' ? m.home.name + ' won' : (res === 'A' ? m.away.name + ' won' : 'It ended in a draw');
      if (mine) {
        var pts = typeof mine.points === 'number' ? mine.points : scorePick(m, mine.pick);
        var label = mine.pick === 'H' ? m.home.name : (mine.pick === 'A' ? m.away.name : 'a draw');
        note = '<p class="note ' + (pts > 0 ? 'good' : 'bad') + '">You picked <b>' + esc(label) + '</b>. ' + (pts > 0 ? 'You earned ' + pts + ' points.' : 'No points this time.') + '</p>';
      } else note = '<p class="note">' + esc(who) + '.</p>';
    } else if (m.status === 'POSTPONED') {
      note = '<p class="note">This match is postponed. Picks reopen when it has a new date.</p>';
    } else if (locked) {
      note = '<p class="note">' + (mine ? 'The match has started. Your pick is locked in.' : 'This match has started. Picks are closed.') + '</p>';
    } else if (mine) {
      note = '<p class="note good ' + (state.justPicked === m.id ? 'kick' : '') + '">' +
        (state.justPicked === m.id ? '<span class="ball-pop">' + miniBall() + '</span> ' : '') + 'Your pick is in. You can change it until kickoff.</p>';
    } else if (state.mode === 'online' && !state.user) {
      note = '<p class="note">Sign in to make a pick.</p>';
    } else if (left <= 0) {
      note = '<p class="note">No picks left this week. Win points to get more.</p>';
    } else {
      note = '<p class="note">Tap who you think will win. ' + left + (left === 1 ? ' pick' : ' picks') + ' left this week.</p>';
    }

    return '<article class="match' + (mine && !done ? ' picked' : '') + (m.status === 'LIVE' ? ' live' : '') + '" data-id="' + m.id + '" style="--hh:' + hue(m.home.name) + ';--ha:' + hue(m.away.name) + '">' +
      '<div class="m-head"><time datetime="' + esc(m.kickoff) + '">' + d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) + '</time>' + tag + '</div>' +
      '<div class="teams" data-act="match-open" data-id="' + m.id + '"><div class="team">' + badge(m.home) + '<span class="tname">' + esc(m.home.name) + '</span></div>' + mid +
      '<div class="team">' + badge(m.away) + '<span class="tname">' + esc(m.away.name) + '</span></div></div>' +
      '<div class="choices">' + choices + '</div>' + barHTML(pr[0], pr[1], pr[2], animate) + fans + note +
      '<div class="m-foot">' + cmtHTML(m) + '<button type="button" class="det-btn" data-act="match-open" data-id="' + m.id + '">Match details <span aria-hidden="true">›</span></button></div></article>';
  }

  /* ---------- comments (each match has its own panel) ---------- */
  var CHAT = '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a8 8 0 0 1-11.6 7.1L4 20l1-4.6A8 8 0 1 1 21 12z"/></svg>';
  function cmtLabel(n) { return CHAT + '<span>' + (n ? n + (n === 1 ? ' comment' : ' comments') : 'Comments') + '</span>'; }
  function cmtHTML(m) {
    return '<button type="button" class="cmt-btn" data-act="cmt-open" data-id="' + m.id + '">' + cmtLabel(state.counts.get(m.id) || 0) + '</button>';
  }
  function refreshCmtButtons() {
    document.querySelectorAll('.cmt-btn').forEach(function (b) { b.innerHTML = cmtLabel(state.counts.get(+b.dataset.id) || 0); });
    if ($('#cdlg').open) sheetTabs();
  }
  function compOf(m) { return state.data.competitions.filter(function (c) { return c.matches.indexOf(m) >= 0; })[0]; }
  function ordinal(n) { var s = ['th', 'st', 'nd', 'rd'], v = n % 100; return s[(v - 20) % 10] || s[v] || s[0]; }
  function teamBlock(m, side) {
    var t = m[side], c = compOf(m), row = c ? c.table.filter(function (x) { return x.team === t.name; })[0] : null;
    var pos = row ? row.pos + ordinal(row.pos) + ' in the table, ' + row.pts + ' pts' : 'Not in the table yet';
    var form = row && row.form && row.form.length ? '<span class="form">' + row.form.map(function (f) { return '<span class="f ' + f + '" title="' + ({ W: 'Won', D: 'Drawn', L: 'Lost' }[f]) + '">' + f + '</span>'; }).join('') + '</span>' : '';
    return '<div class="ib-team">' + badge(t) + '<b>' + esc(t.name) + '</b><span class="small">' + esc(pos) + '</span>' + form + '</div>';
  }
  function untilText(m) {
    var ms = kickDate(m).getTime() - Date.now();
    if (m.status === 'FINISHED') return 'Full time';
    if (m.status === 'LIVE') return 'Live now';
    if (m.status === 'POSTPONED') return 'Postponed';
    if (ms <= 0) return 'Started';
    var mins = Math.round(ms / 60000);
    return mins < 90 ? 'Kicks off in ' + mins + ' min' : (mins < 2880 ? 'Kicks off in ' + Math.round(mins / 60) + ' hours' : 'Kicks off in ' + Math.round(mins / 1440) + ' days');
  }
  function infoHTML(m) {
    var pr = [m.prob.home, m.prob.draw, m.prob.away], big = Math.max.apply(null, pr), res = result(m);
    var mid = m.score && (m.status === 'FINISHED' || m.status === 'LIVE') ? '<span class="ib-score">' + m.score.home + '–' + m.score.away + '</span>' : '<span class="ib-vs">VS</span>';
    var names = [m.home.name, 'Draw', m.away.name], cls = ['h', 'd', 'a'];
    var blocks = pr.map(function (p, i) {
      return '<div class="ib-chance ' + cls[i] + (p === big && m.status !== 'FINISHED' ? ' fav' : '') + (res && 'HDA'.charAt(i) === res ? ' won' : '') + '"><span class="n">' + esc(names[i]) + '</span><span class="p">' + p + '<small>%</small></span></div>';
    }).join('');
    var v = state.votes.get(m.id), n = v ? v.H + v.D + v.A : 0, fans;
    if (n > 0) {
      var f = pct3(v.H, v.D, v.A);
      fans = '<h4 class="ib-h">What the fans think</h4>' + barHTML(f[0], f[1], f[2], false) +
        '<p class="small">' + n + (n === 1 ? ' vote' : ' votes') + ': ' + esc(m.home.name) + ' ' + f[0] + '%, draw ' + f[1] + '%, ' + esc(m.away.name) + ' ' + f[2] + '%.</p>';
    } else fans = '<h4 class="ib-h">What the fans think</h4><p class="small">No fan votes yet.</p>';
    var mine = state.picks.get(m.id), lab = mine ? (mine.pick === 'H' ? m.home.name : (mine.pick === 'A' ? m.away.name : 'A draw')) : null;
    return '<div class="ib"><p class="ib-when">' + esc(untilText(m)) + '</p>' +
      '<div class="ib-row">' + teamBlock(m, 'home') + mid + teamBlock(m, 'away') + '</div>' +
      '<h4 class="ib-h">Our chances</h4><div class="ib-chances">' + blocks + '</div>' + barHTML(pr[0], pr[1], pr[2], false) +
      '<p class="small">Worked out from team ratings built on past results, with a small boost for the home side. It is an estimate, not a promise.</p>' + fans +
      (lab ? '<p class="note good" style="margin-top:14px">Your pick: <b>' + esc(lab) + '</b></p>' : '') + '</div>';
  }
  function sheetTabs() {
    var n = state.counts.get(state.cmtId) || 0;
    $('#cTabs').innerHTML = '<button type="button" data-tab="info" aria-pressed="' + (state.cmtTab === 'info') + '">Overview</button>' +
      '<button type="button" data-tab="talk" aria-pressed="' + (state.cmtTab === 'talk') + '">Comments' + (n ? ' (' + n + ')' : '') + '</button>';
  }
  function renderSheet() {
    var m = allMatches().filter(function (x) { return x.id === state.cmtId; })[0]; if (!m) return;
    sheetTabs();
    if (state.cmtTab === 'info') { $('#cList').innerHTML = infoHTML(m); $('#cFoot').innerHTML = ''; $('#cFoot').hidden = true; return; }
    $('#cFoot').hidden = false;
    if (state.threads.has(state.cmtId)) renderThread(); else $('#cList').innerHTML = '<p class="small c-empty">Loading...</p>';
    renderComposer();
  }
  function initials(n) { return esc((n || '?').trim().charAt(0).toUpperCase()); }
  function renderThread() {
    var id = state.cmtId, list = state.threads.get(id), box = $('#cList');
    if (!box) return;
    if (!list) { box.innerHTML = '<p class="small c-empty">Loading...</p>'; return; }
    box.innerHTML = list.length ? list.map(function (c) {
      var canDel = c.mine || state.isOwner;
      return '<article class="c-item"><span class="av" style="--h:' + hue(c.name || '?') + '" aria-hidden="true">' + initials(c.name) + '</span>' +
        '<div class="c-main"><p class="c-top"><b>' + esc(c.name) + '</b><time>' + esc(ago(c.created_at)) + '</time>' +
        (canDel ? '<button type="button" class="c-del" data-act="cmt-del" data-cid="' + c.id + '">Delete</button>' : '') + '</p>' +
        '<p class="c-text">' + esc(c.body) + '</p></div></article>';
    }).join('') : '<div class="c-empty"><p><b>No comments yet</b></p><p class="small">Say who you think wins, and why.</p></div>';
    renderComposer();
  }
  function renderComposer() {
    var foot = $('#cFoot'), id = state.cmtId; if (!foot) return;
    var had = foot.querySelector('textarea'), keep = had && document.activeElement === had;
    if (state.mode === 'online' && !state.user) {
      foot.innerHTML = '<button type="button" class="btn sm wide" data-act="cmt-signin">Sign in to comment</button><p class="small">Anyone can read. You need a free account to write.</p>'; return;
    }
    if (state.mode === 'online' && !state.name) {
      foot.innerHTML = '<button type="button" class="btn sm wide" data-act="cmt-signin">Choose a name to comment</button>'; return;
    }
    foot.innerHTML = '<form class="c-form" data-id="' + id + '"><label class="sr" for="cText">Your comment</label>' +
      '<textarea id="cText" maxlength="280" rows="2" placeholder="Who wins, and why?" required>' + esc(state.drafts.get(id) || '') + '</textarea>' +
      '<div class="c-row"><span class="small" id="cCount">' + (state.drafts.get(id) || '').length + '/280</span><button class="btn sm" type="submit">Post</button></div></form>';
    if (keep) { var t = $('#cText'); t.focus(); t.setSelectionRange(t.value.length, t.value.length); }
  }
  function loadThread(id) {
    return store.loadComments(id).then(function (list) { state.threads.set(id, list); if (state.cmtId === id && state.cmtTab === 'talk') renderThread(); })
      .catch(function (e) { state.threads.set(id, []); if (state.cmtId === id && state.cmtTab === 'talk') renderThread(); toast(e.message, true); });
  }
  function openThread(id, tab) {
    var m = allMatches().filter(function (x) { return x.id === id; })[0]; if (!m) return;
    state.cmtId = id; state.cmtTab = tab || 'talk';
    $('#cTitle').textContent = m.home.name + ' v ' + m.away.name;
    $('#cSub').textContent = kickDate(m).toLocaleDateString([], { weekday: 'long', day: 'numeric', month: 'short' }) + ', ' + kickDate(m).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    $('#cList').scrollTop = 0;
    renderSheet();
    if (!$('#cdlg').open) $('#cdlg').showModal();
    loadThread(id);
  }
  function afterCmtChange(id) {
    return Promise.all([loadThread(id), store.loadCounts(allMatches().map(function (m) { return m.id; }))]).then(refreshCmtButtons);
  }
  function cmtSubmit(form) {
    var id = +form.dataset.id, body = form.querySelector('textarea').value.trim();
    if (!body) return;
    var btn = form.querySelector('button'); btn.disabled = true;
    store.addComment(id, body).then(function () { state.drafts.delete(id); return afterCmtChange(id); })
      .then(function () { renderComposer(); })
      .catch(function (e) { btn.disabled = false; toast(e.message, true); });
  }
  function cmtDelete(b) {
    if (b.dataset.armed !== '1') {
      b.dataset.armed = '1'; b.textContent = 'Sure?';
      setTimeout(function () { if (b.isConnected) { b.dataset.armed = ''; b.textContent = 'Delete'; } }, 3000); return;
    }
    store.deleteComment(b.dataset.cid).then(function () { return afterCmtChange(state.cmtId); })
      .catch(function (e) { toast(e.message, true); });
  }

  function miniBall() {
    return '<svg viewBox="0 0 32 32" width="16" height="16" aria-hidden="true" style="vertical-align:-3px"><circle cx="16" cy="16" r="14" fill="#f1f4fa"/><path d="M16 9.6l5 3.6-1.9 5.9h-6.2L11 13.2z" fill="#0a1228"/></svg>';
  }

  function renderMatches(animate) {
    var c = currentComp(), list = $('#matchList');
    var ms = c.matches.filter(function (m) { return state.view === 'results' ? m.status === 'FINISHED' : m.status !== 'FINISHED'; });
    ms.sort(function (a, b) { return state.view === 'results' ? kickDate(b) - kickDate(a) : kickDate(a) - kickDate(b); });
    if (!ms.length) {
      list.innerHTML = '<div class="empty">' + (state.view === 'results' ? 'No finished matches in the last week.' : 'No matches in the next two weeks. New ones show up here once they are scheduled.') + '</div>';
      return;
    }
    var html = '', day = '';
    ms.forEach(function (m) {
      var key = kickDate(m).toLocaleDateString([], { weekday: 'long', day: 'numeric', month: 'short' });
      if (key !== day) { if (day) html += '</div>'; html += '<h3 class="day">' + esc(key) + '</h3><div class="grid">'; day = key; }
      html += cardHTML(m, animate);
    });
    list.innerHTML = html + '</div>';
    if (animate) requestAnimationFrame(function () { requestAnimationFrame(function () {
      list.querySelectorAll('.s').forEach(function (s) { s.style.setProperty('--g', s.dataset.g); });
    }); });
  }

  function renderTable() {
    var c = currentComp(), w = $('#tableWrap');
    $('#tableMeta').textContent = c.name + ', ' + state.data.season + ' season';
    if (!c.table.length) { w.innerHTML = '<div class="empty" style="margin:0;border:0">The table shows up once matches have been played.</div>'; return; }
    w.innerHTML = '<table><thead><tr><th>#</th><th>Team</th><th>P</th><th class="opt">W</th><th class="opt">D</th><th class="opt">L</th><th class="opt3">GD</th><th>Pts</th><th class="opt">Form</th></tr></thead><tbody>' +
      c.table.map(function (r) {
        var t = { name: r.team, tla: r.tla, crest: r.crest };
        return '<tr' + (r.pos === 1 ? ' class="lead-row"' : '') + '><td>' + r.pos + '</td><td><span class="tcell">' + badge(t) + esc(r.team) + '</span></td><td>' + r.p +
          '</td><td class="opt">' + r.w + '</td><td class="opt">' + r.d + '</td><td class="opt">' + r.l + '</td><td class="opt3">' + (r.gd > 0 ? '+' : '') + r.gd + '</td><td class="pts">' + r.pts +
          '</td><td class="opt"><span class="form">' + r.form.map(function (f) { return '<span class="f ' + f + '" title="' + ({ W: 'Won', D: 'Drawn', L: 'Lost' }[f]) + '">' + f + '</span>'; }).join('') + '</span></td></tr>';
      }).join('') + '</tbody></table>';
  }

  function leaderRows(list, meName) {
    return '<ol class="leader">' + list.map(function (r, i) {
      var medal = i < 3 ? ' medal m' + (i + 1) : '';
      return '<li class="' + (r.display_name === meName ? 'me' : '') + '"><span class="rk' + medal + '">' + (i + 1) + '</span><span class="nm">' + esc(r.display_name) +
        '<small>' + esc(levelFor(r.points).cur.name) + ', ' + r.correct + ' correct</small></span><span class="pt">' + r.points + '</span></li>';
    }).join('') + '</ol>';
  }
  function demoLeader() { var lv = levelFor(myPoints()); return [{ display_name: 'You', points: myPoints(), correct: 0, _lv: lv }]; }
  function renderLeaders() {
    var box = $('#leaderList'), btn = $('#openLeaders');
    if (state.mode === 'demo') {
      var lv = levelFor(myPoints());
      box.innerHTML = '<ol class="leader"><li class="me"><span class="rk medal m1">1</span><span class="nm">You<small>' + esc(lv.cur.name) + ' on this device</small></span><span class="pt">' + myPoints() + '</span></li></ol>' +
        '<p class="small" style="margin-top:10px">Everyone\'s scores will show here once sign-in is switched on. For now this is just your score.</p>';
      btn.hidden = true; return;
    }
    if (!state.leaders.length) { box.innerHTML = '<div class="leader-empty">No scores yet. Make a pick and be first on the board.</div>'; btn.hidden = true; return; }
    box.innerHTML = leaderRows(state.leaders.slice(0, 5), state.name);
    btn.hidden = state.leaders.length <= 5; btn.textContent = 'See all ' + state.leaders.length + ' players';
  }
  function openLeaders() {
    var meIdx = state.leaders.map(function (r) { return r.display_name; }).indexOf(state.name);
    $('#lList').innerHTML = leaderRows(state.leaders, state.name);
    $('#lFoot').textContent = state.user && state.name ? (meIdx >= 0 ? 'You are number ' + (meIdx + 1) + ' with ' + state.leaders[meIdx].points + ' points.' : 'You are not on the board yet. Make a pick and win some points.') : 'Sign in and make picks to join the board.';
    $('#ldlg').showModal();
  }

  function renderLadder() {
    var cur = levelFor(myPoints()).i, max = CFG.levels[CFG.levels.length - 1].picks;
    $('#ladder').innerHTML = CFG.levels.map(function (l, i) {
      var hgt = 44 + (l.picks / max) * 96;
      return '<div class="step ' + (i < cur ? 'done' : (i === cur ? 'now' : '')) + '"><div class="col" style="height:' + hgt + 'px">' + l.picks + '</div><span class="nm">' + esc(l.name) +
        '</span><span class="th">' + (l.min ? l.min + ' pts' : 'start') + '</span></div>';
    }).join('');
  }

  function renderAcctBtn() {
    var b = $('#acctBtn'), pts = myPoints();
    if (state.mode === 'demo' || (state.mode === 'online' && !state.user)) b.textContent = 'Sign in';
    else b.innerHTML = esc(state.name || 'You') + ' <b>' + pts + '</b>';
  }

  function renderAll(animate) {
    renderBanner(); renderStats(); renderTabs(); renderQuota(); renderMatches(animate);
    renderTable(); renderLeaders(); renderLadder(); renderAcctBtn();
  }
  function refreshAll() {
    var ids = allMatches().map(function (m) { return m.id; });
    return Promise.all([store.loadVotes(ids), store.loadLeaders(), store.loadCounts(ids)]).then(function (r) {
      state.leaders = r[1] || []; return loadOwner();
    }).then(function () {
      renderAll(false);
      if ($('#cdlg').open && state.cmtId) loadThread(state.cmtId);
    }).catch(function () { renderAll(false); });
  }


  /* ---------- are you the owner? (the control center is its own page, owner.html) ---------- */
  function loadOwner() {
    if (state.mode !== 'online' || !state.user) { state.isOwner = false; state.ownerFor = null; return Promise.resolve(); }
    if (state.ownerFor === state.user.id) return Promise.resolve();
    return Online.client.rpc('is_admin').then(function (r) {
      state.ownerFor = state.user.id; state.isOwner = !r.error && r.data === true;
    }).catch(function () { state.isOwner = false; });
  }

  /* ---------- account dialog ---------- */
  function authForm(mode) {
    var pw = function (id, label, auto) { return '<label for="' + id + '">' + label + '</label><input id="' + id + '" type="password" required minlength="8" autocomplete="' + auto + '" placeholder="At least 8 characters">'; };
    var email = '<label for="emailIn">Email</label><input id="emailIn" type="email" required autocomplete="email" placeholder="you@example.com">';
    var tabs = '<div class="seg-ctl auth-tabs" role="group" aria-label="Sign in or create an account">' +
      '<button type="button" data-auth="in" aria-pressed="' + (mode === 'in') + '">Sign in</button>' +
      '<button type="button" data-auth="up" aria-pressed="' + (mode === 'up') + '">Create account</button></div>';
    if (mode === 'up') return '<h3 id="acctTitle">Create your account</h3>' + tabs +
      '<p>Free. Without an account you can read the chances and the comments. With one you can pick winners and comment.</p>' +
      '<form id="authForm" data-mode="up"><label for="nameUp">Name everyone will see</label><input id="nameUp" type="text" required minlength="3" maxlength="20" autocomplete="nickname" placeholder="3 to 20 letters">' +
      email + pw('pwIn', 'Password', 'new-password') + '<button class="btn" type="submit">Create account</button></form><p id="signMsg" class="small" role="status"></p>';
    if (mode === 'forgot') return '<h3 id="acctTitle">Reset your password</h3><p>Type your email and we will send you a link to choose a new password.</p>' +
      '<form id="authForm" data-mode="forgot">' + email + '<button class="btn" type="submit">Send the link</button></form><p id="signMsg" class="small" role="status"></p>' +
      '<p class="small"><button type="button" class="linkish" data-auth="in">Back to sign in</button></p>';
    if (mode === 'reset') return '<h3 id="acctTitle">Choose a new password</h3><form id="authForm" data-mode="reset">' +
      pw('pwIn', 'New password', 'new-password') + '<button class="btn" type="submit">Save password</button></form><p id="signMsg" class="small" role="status"></p>';
    return '<h3 id="acctTitle">Sign in</h3>' + tabs + '<form id="authForm" data-mode="in">' + email + pw('pwIn', 'Password', 'current-password') +
      '<button class="btn" type="submit">Sign in</button></form><p id="signMsg" class="small" role="status"></p>' +
      '<p class="small"><button type="button" class="linkish" data-auth="forgot">Forgot your password?</button></p>';
  }

  function openAccount(mode) {
    var body = $('#acctBody'), dlg = $('#acct'), pts = myPoints(), lv = levelFor(pts);
    var stats = '<div class="stat"><div>' + pts + '<span>points</span></div><div>' + esc(lv.cur.name) + '<span>level</span></div><div>' + lv.cur.picks + '<span>picks a week</span></div></div>';
    var h;
    if (mode !== 'in' && mode !== 'up' && mode !== 'forgot' && mode !== 'reset') mode = state.authMode;
    if (state.mode === 'demo') {
      if (mode === 'reset') mode = 'in';
      h = authForm(mode) + '<div class="demo-note"><p><b>Accounts are not switched on yet.</b> They start once the database is connected. Until then your picks and comments are saved on this phone only.</p>' +
        '<p class="small">' + pts + ' points so far. <button class="linkish" type="button" id="resetBtn">Clear my picks</button></p></div>';
    } else if (mode === 'reset' && state.user) {
      h = authForm('reset');
    } else if (!state.user) {
      state.authMode = mode; h = authForm(mode);
    } else {
      h = '<h3 id="acctTitle">Your account</h3>' + stats +
        '<form id="nameForm"><label for="nameIn">Name on the leaderboard and comments</label><input id="nameIn" type="text" minlength="3" maxlength="20" required value="' + esc(state.name) + '" placeholder="3 to 20 letters">' +
        '<div class="row-btns"><button class="btn" type="submit">Save</button><button class="sec-btn" type="button" id="outBtn">Sign out</button></div></form>' +
        (state.name ? '' : '<p class="small" style="margin-top:12px">Choose a name to show up on the leaderboard and to comment.</p>') +
        (state.isOwner ? '<p style="margin-top:14px"><a class="btn-line" href="owner.html">Open the control center</a></p>' : '');
    }
    body.className = 'dlg'; body.innerHTML = h;
    var f;
    if ((f = $('#resetBtn'))) f.onclick = function () { Local.reset(); renderAll(false); dlg.close(); toast('Picks cleared'); };
    if ((f = $('#outBtn'))) f.onclick = function () { Online.signOut().then(function () { dlg.close(); }); };
    body.querySelectorAll('[data-auth]').forEach(function (b) { b.onclick = function () { openAccount(b.dataset.auth); }; });
    if ((f = $('#authForm'))) f.onsubmit = function (e) {
      e.preventDefault();
      var m = e.target.dataset.mode, msg = $('#signMsg'), btn = e.target.querySelector('button[type=submit]'),
        em = $('#emailIn') ? $('#emailIn').value.trim() : '', pw = $('#pwIn') ? $('#pwIn').value : '';
      if (state.mode === 'demo') { $('#signMsg').textContent = 'Accounts are not switched on yet, so nothing was created. This is how the page will work.'; return; }
      var fail = function (er) {
        btn.disabled = false;
        var t = er.message || 'Something went wrong';
        if (/invalid login/i.test(t)) t = 'That email and password do not match.';
        else if (/already registered|already been registered/i.test(t)) t = 'That email already has an account. Try signing in.';
        else if (/rate limit|too many/i.test(t)) t = 'Too many tries. Wait a few minutes and try again.';
        msg.textContent = t;
      };
      btn.disabled = true; msg.textContent = 'One moment...';
      if (m === 'in') Online.signInPw(em, pw).then(function () { dlg.close(); toast('Signed in'); }).catch(fail);
      else if (m === 'up') Online.signUp(em, pw, $('#nameUp').value.trim()).then(function (signedIn) {
        if (signedIn) { dlg.close(); toast('Welcome!'); }
        else { btn.disabled = false; msg.textContent = 'Almost done. We sent you an email. Open it and tap the link to confirm, then sign in.'; }
      }).catch(fail);
      else if (m === 'forgot') Online.forgot(em).then(function () { btn.disabled = false; msg.textContent = 'If that email has an account, a link is on its way.'; }).catch(fail);
      else if (m === 'reset') Online.newPassword(pw).then(function () { dlg.close(); toast('Password changed'); }).catch(fail);
    };
    if ((f = $('#nameForm'))) f.onsubmit = function (e) {
      e.preventDefault();
      Online.setName($('#nameIn').value.trim()).then(function () { toast('Name saved'); dlg.close(); return refreshAll(); })
        .catch(function (er) { toast(er.message, true); });
    };
    if (!dlg.open) dlg.showModal();
  }

  /* ---------- events ---------- */
  function handlePick(id, c) {
    var m = allMatches().filter(function (x) { return x.id === id; })[0];
    if (!m) return;
    if (state.mode === 'online' && !state.user) { openAccount(); return; }
    if (state.mode === 'online' && !state.name) { toast('Choose a name first', true); openAccount(); return; }
    store.savePick(m, c).then(function () {
      state.justPicked = id; toast('Pick saved');
      return refreshAll();
    }).then(function () { state.justPicked = null; })
      .catch(function (er) { toast(er.message, true); });
  }

  var VIEWS = ['matches', 'tables', 'leaders', 'how'];
  function setView(v) {
    if (VIEWS.indexOf(v) < 0) v = 'matches';
    document.body.dataset.view = v;
    document.querySelectorAll('[data-v]').forEach(function (el) { el.hidden = el.dataset.v !== v; });
    document.querySelectorAll('[data-nav]').forEach(function (a) {
      if (a.dataset.nav === v) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
    });
    window.dispatchEvent(new Event('resize'));                        // lets the hero ball re-measure when it comes back
  }

  function bind() {
    ['#tabs', '#tabs2'].forEach(function (sel) {
      $(sel).addEventListener('click', function (e) {
        var b = e.target.closest('[data-comp]'); if (!b) return;
        state.comp = b.dataset.comp; renderTabs(); renderMatches(true); renderTable();
      });
    });
    document.addEventListener('click', function (e) {                 // the menu switches screens instead of scrolling
      var l = e.target.closest('a[href^="#"]'); if (!l || e.defaultPrevented) return;
      var id = l.getAttribute('href').slice(1);
      if (VIEWS.indexOf(id) < 0) return;
      e.preventDefault();
      try { if (location.hash !== '#' + id) history.pushState(null, '', '#' + id); }
      catch (err) { try { location.hash = id; } catch (er2) {} }          // Safari refuses pushState on loose files
      setView(id); window.scrollTo(0, 0);
    });
    window.addEventListener('hashchange', function () { setView(location.hash.slice(1)); });
    setView(location.hash.slice(1));
    $('#views').addEventListener('click', function (e) {
      var b = e.target.closest('[data-view]'); if (!b) return;
      state.view = b.dataset.view; renderTabs(); renderMatches(true);
    });
    $('#matchList').addEventListener('click', function (e) {
      var t = e.target.closest('[data-act]'); if (!t || t.disabled) return;
      var act = t.dataset.act;
      if (act === 'pick') handlePick(+t.dataset.id, t.dataset.c);
      else if (act === 'cmt-open') openThread(+t.dataset.id, 'talk');
      else if (act === 'match-open') openThread(+t.dataset.id, 'info');
    });
    $('#acctBtn').addEventListener('click', function () { openAccount(); });
    $('#openLeaders').addEventListener('click', openLeaders);
    $('#ldlg').addEventListener('click', function (e) { if (e.target === $('#ldlg')) $('#ldlg').close(); });
    var cd = $('#cdlg');
    cd.addEventListener('click', function (e) {
      if (e.target === cd) { cd.close(); return; }                       // tap the dark area to close
      var tb = e.target.closest('[data-tab]');
      if (tb) { state.cmtTab = tb.dataset.tab; renderSheet(); if (state.cmtTab === 'talk') loadThread(state.cmtId); return; }
      var t = e.target.closest('[data-act]'); if (!t) return;
      if (t.dataset.act === 'cmt-signin') { cd.close(); openAccount('up'); }
      else if (t.dataset.act === 'cmt-del') cmtDelete(t);
    });
    cd.addEventListener('submit', function (e) { var f = e.target.closest('.c-form'); if (f) { e.preventDefault(); cmtSubmit(f); } });
    cd.addEventListener('input', function (e) {
      if (e.target.id !== 'cText') return;
      state.drafts.set(state.cmtId, e.target.value); $('#cCount').textContent = e.target.value.length + '/280';
    });
    $('#bannerClose').addEventListener('click', function () { state.bannerClosed = true; renderBanner(); });
    setInterval(tickClock, 1000);
  }

  /* ---------- start ---------- */
  function fail(msg) {
    $('#matchList').innerHTML = '<div class="empty">' + msg + '</div>';
  }

  function boot() {
    document.querySelectorAll('[data-site-name]').forEach(function (n) { n.textContent = CFG.siteName; });
    document.title = CFG.siteName + ' | Football predictions';

    if (window.initBall) {
      window.initBall($('#ball'), $('#hero'), function (n, best) {
        $('#juggle').textContent = n ? 'Keep it up: ' + n + (n >= best ? ' (best)' : ' (best ' + best + ')') : (best ? 'Tap the ball. Best: ' + best : 'Tap the ball');
      });
    }
    bind();

    fetch('data/predictions.json', { cache: 'no-store' })
      .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
      .then(function (data) {
        state.data = data; state.comp = data.competitions[0].code;
        return store.init().catch(function (e) {
          console.warn('Falling back to demo mode:', e); state.mode = 'demo'; store = Local; return Local.init();
        });
      })
      .then(function () { renderAll(true); return refreshAll(); })
      .catch(function (e) {
        console.error(e);
        fail('Could not load the predictions. If you opened this file straight from your computer, start a small local server instead (see README). Otherwise run the update workflow once so <code>data/predictions.json</code> exists.');
      });
  }

  boot();
})();
