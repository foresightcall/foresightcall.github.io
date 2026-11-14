/* Control center: its own page. Only the owner account can see the numbers; the database enforces it. */
(function () {
  'use strict';
  var CFG = window.SITE_CONFIG || {};
  var SUPABASE_JS = 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.45.4/dist/umd/supabase.min.js';
  var $ = function (s, r) { return (r || document).querySelector(s); };
  var esc = function (s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); };
  var app = $('#app'), client = null, data = null, tm;
  document.querySelectorAll('[data-site-name]').forEach(function (e) { e.textContent = CFG.siteName || 'Foresight Call'; });

  function toast(msg, err) {
    var t = $('#toast'); t.textContent = msg; t.hidden = false; t.className = 'toast' + (err ? ' err' : '');
    clearTimeout(tm); tm = setTimeout(function () { t.hidden = true; }, 3500);
  }
  function ago(iso) {
    var s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
    if (s < 60) return 'just now'; if (s < 3600) return Math.floor(s / 60) + ' min ago';
    if (s < 86400) return Math.floor(s / 3600) + ' h ago'; return Math.floor(s / 86400) + ' d ago';
  }
  function loadScript(src) {
    return new Promise(function (ok, bad) { var s = document.createElement('script'); s.src = src; s.onload = ok; s.onerror = function () { bad(new Error('Could not load the sign-in library.')); }; document.head.appendChild(s); });
  }

  /* ---------- screens ---------- */
  function message(title, body, extra) {
    app.innerHTML = '<div class="gate"><h1 class="gate-h">' + esc(title) + '</h1><p>' + body + '</p>' + (extra || '') + '</div>';
  }
  function signInScreen() {
    $('#outTop').hidden = true;
    app.innerHTML = '<div class="gate"><h1 class="gate-h">Control center</h1><p>Sign in with the owner account.</p>' +
      '<form id="f" class="dlg"><label for="e">Email</label><input id="e" type="email" required autocomplete="email">' +
      '<label for="p">Password</label><input id="p" type="password" required autocomplete="current-password">' +
      '<button class="btn" type="submit" style="border:0;cursor:pointer;width:100%">Sign in</button></form><p id="m" class="small" role="status"></p>' +
      '<p class="small"><a href="index.html">Back to the site</a></p></div>';
    $('#f').onsubmit = function (e) {
      e.preventDefault(); var b = e.target.querySelector('button'); b.disabled = true; $('#m').textContent = 'One moment...';
      client.auth.signInWithPassword({ email: $('#e').value.trim(), password: $('#p').value }).then(function (r) {
        if (r.error) { b.disabled = false; $('#m').textContent = /invalid login/i.test(r.error.message) ? 'That email and password do not match.' : r.error.message; return; }
        start();
      }).catch(function (er) { b.disabled = false; $('#m').textContent = er.message; });
    };
  }
  function notOwner(email) {
    $('#outTop').hidden = false;
    message('This is not the owner account', 'You are signed in as <b>' + esc(email) + '</b>. Only the owner can open this page.',
      '<p style="margin-top:14px"><a class="btn-line" href="index.html">Back to the site</a></p>');
  }

  function chartSVG(days) {
    var W = 560, H = 170, pl = 6, pb = 26, pt = 16, bw = (W - pl) / days.length;
    var max = Math.max(5, Math.max.apply(null, days.map(function (d) { return d.picks; })));
    var out = '<svg viewBox="0 0 ' + W + ' ' + H + '" role="img" aria-label="Picks per day for the last 14 days">';
    days.forEach(function (d, i) {
      var h = (H - pb - pt) * d.picks / max, x = pl + i * bw + 4, w = bw - 8, y = H - pb - h;
      out += '<rect class="b" x="' + x.toFixed(1) + '" y="' + y.toFixed(1) + '" width="' + w.toFixed(1) + '" height="' + Math.max(h, d.picks ? 2 : 0).toFixed(1) + '" rx="3"/>';
      if (d.picks) out += '<text x="' + (x + w / 2).toFixed(1) + '" y="' + (y - 4).toFixed(1) + '" text-anchor="middle" font-size="10">' + d.picks + '</text>';
      if (i % 3 === 1) out += '<text x="' + (x + w / 2).toFixed(1) + '" y="' + (H - 8) + '" text-anchor="middle" font-size="10">' +
        new Date(d.day + 'T00:00:00Z').toLocaleDateString([], { day: 'numeric', month: 'short', timeZone: 'UTC' }) + '</text>';
    });
    return out + '<line x1="0" x2="' + W + '" y1="' + (H - pb) + '" y2="' + (H - pb) + '" class="base"/></svg>';
  }
  function tile(big, label, sub) { return '<div class="tile"><p class="tv">' + big + '</p><p class="tl">' + label + '</p>' + (sub ? '<p class="ts">' + sub + '</p>' : '') + '</div>'; }

  function dashboard(s, players, comments, pred) {
    $('#outTop').hidden = false;
    var mdl = (pred && pred.model) || {}, stale = false, updated = 'unknown';
    if (pred && pred.generated_at) {
      var h = (Date.now() - new Date(pred.generated_at).getTime()) / 36e5; updated = pred.sample ? 'Demo data' : ago(pred.generated_at); stale = !pred.sample && h > 8;
    }
    var syncAge = s.last_sync ? ago(s.last_sync) : null;
    var html = '<div class="sec-head"><h1 class="gate-h" style="margin:0">Control center</h1><p class="meta"><button type="button" class="sec-btn" id="refresh">Refresh numbers</button></p></div>';

    html += '<h2 class="h3">Is everything running?</h2><div class="tiles">' +
      tile(esc(updated), 'Match data updated', stale ? '<b class="warnt">Older than expected. Check the Actions tab on GitHub.</b>' : 'It refreshes every 3 hours') +
      tile(s.matches, 'Matches in the database', syncAge ? 'Synced ' + syncAge : '<b class="warnt">Nothing synced yet. Run the update on GitHub.</b>') +
      tile(mdl.accuracy != null ? Math.round(mdl.accuracy * 100) + '%' : '–', 'Our chances called right', mdl.always_home_accuracy != null ? 'Always backing the home team: ' + Math.round(mdl.always_home_accuracy * 100) + '%' : '') + '</div>';

    html += '<h2 class="h3">Players</h2><div class="tiles">' +
      tile(s.players, 'People signed up', s.named_players + ' have a name') +
      tile(s.active_7d, 'Played this week', 'Made at least one pick') +
      tile(s.new_7d, 'New this week', '') +
      tile(s.picks_today, 'Picks today', s.picks_total + ' in total') +
      tile(s.correct_rate == null ? '–' : s.correct_rate + '%', 'Picks that were right', s.points_total + ' points handed out') + '</div>';

    html += '<h2 class="h3">Picks per day</h2><div class="chart">' + chartSVG(s.per_day) + '</div>';

    html += '<h2 class="h3">Most picked matches</h2>' + (s.top_matches.length ? '<div class="table-wrap"><table class="plain"><tbody>' + s.top_matches.map(function (m) {
      return '<tr><td>' + esc(m.home_name) + ' v ' + esc(m.away_name) + '</td><td>' + new Date(m.kickoff).toLocaleDateString([], { day: 'numeric', month: 'short' }) + '</td><td class="pts">' + m.picks + '</td></tr>';
    }).join('') + '</tbody></table></div>' : '<p class="small">No picks yet.</p>');

    html += '<h2 class="h3" style="margin-top:26px">Latest comments</h2>' + (comments.length ? '<div class="oc-list">' + comments.map(function (c) {
      return '<article class="c-item"><div class="c-main"><p class="c-top"><b>' + esc(c.name) + '</b> on ' + esc(c.home_name) + ' v ' + esc(c.away_name) + '<time>' + esc(ago(c.created_at)) + '</time>' +
        '<button type="button" class="c-del" data-act="delc" data-id="' + esc(String(c.id)) + '">Delete</button></p><p class="c-text">' + esc(c.body) + '</p></div></article>';
    }).join('') + '</div>' : '<p class="small">No comments yet.</p>');

    html += '<h2 class="h3" style="margin-top:26px">Players list</h2>' + (players.length ? '<div class="table-wrap"><table class="plain"><thead><tr><th>Name</th><th>Joined</th><th>Picks</th><th>Right</th><th>Points</th><th></th></tr></thead><tbody>' + players.map(function (p) {
      return '<tr><td>' + (p.name ? esc(p.name) : '<span class="small">no name</span>') + '</td><td>' + new Date(p.joined).toLocaleDateString([], { day: 'numeric', month: 'short' }) +
        '</td><td>' + p.n_picks + '</td><td>' + p.n_correct + '</td><td class="pts">' + p.points + '</td><td>' +
        (p.name ? '<button type="button" class="sec-btn" data-act="clear" data-id="' + esc(p.player_id) + '">Remove name</button>' : '') + '</td></tr>';
    }).join('') + '</tbody></table></div><p class="small" style="margin-top:8px">Removing a name takes the player off the leaderboard and hides their comments. Their picks stay.</p>' : '<p class="small">Nobody has signed up yet.</p>');

    html += '<div class="how" style="margin-top:34px"><p><strong>What these numbers mean</strong>' +
      '<b>Is everything running</b> shows if the 3-hour update on GitHub is alive and whether matches reached the database. ' +
      '<b>Played this week</b> counts people who made at least one pick in the last 7 days. ' +
      '<b>Picks that were right</b> counts only finished matches. Picks, comments and players update when you tap Refresh numbers.</p></div>';
    app.innerHTML = html;
  }

  /* ---------- data ---------- */
  function load() {
    return Promise.all([client.rpc('admin_stats'), client.rpc('admin_players'), client.rpc('admin_recent_comments'),
      fetch('data/predictions.json', { cache: 'no-store' }).then(function (r) { return r.ok ? r.json() : null; }).catch(function () { return null; })])
      .then(function (r) {
        var er = r[0].error || r[1].error || r[2].error;
        if (er) { message('Could not load the numbers', esc(er.message)); return; }
        dashboard(r[0].data, r[1].data || [], r[2].data || [], r[3]);
      });
  }
  function start() {
    client.auth.getSession().then(function (r) {
      var u = r.data.session && r.data.session.user;
      if (!u) return signInScreen();
      return client.rpc('is_admin').then(function (a) {
        if (a.error || a.data !== true) return notOwner(u.email);
        return load();
      });
    }).catch(function (e) { message('Something went wrong', esc(e.message)); });
  }

  app.addEventListener('click', function (e) {
    var t = e.target.closest('button'); if (!t) return;
    if (t.id === 'refresh') { load().then(function () { toast('Refreshed'); }); return; }
    var act = t.dataset.act; if (!act) return;
    if (t.dataset.armed !== '1') {
      t.dataset.armed = '1'; var was = t.textContent; t.textContent = 'Sure? Click again';
      setTimeout(function () { if (t.isConnected) { t.dataset.armed = ''; t.textContent = was; } }, 4000); return;
    }
    var q = act === 'delc' ? client.rpc('admin_delete_comment', { target: +t.dataset.id }) : client.rpc('admin_clear_name', { target: t.dataset.id });
    q.then(function (r) { if (r.error) { toast(r.error.message, true); return; } toast(act === 'delc' ? 'Comment deleted' : 'Name removed'); return load(); });
  });
  $('#outTop').addEventListener('click', function () { client.auth.signOut().then(function () { signInScreen(); }); });

  if (!CFG.supabaseUrl || !CFG.supabaseAnonKey) {
    message('Database not connected', 'Put your Supabase address and public key in <code>config.js</code> first. The control center needs real accounts.');
    return;
  }
  loadScript(SUPABASE_JS).then(function () {
    client = window.supabase.createClient(CFG.supabaseUrl, CFG.supabaseAnonKey); start();
  }).catch(function (e) { message('Could not start', esc(e.message)); });
})();
