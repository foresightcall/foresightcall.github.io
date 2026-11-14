/* Hero football: a small physics toy drawn on a canvas.
   Tap or click near the ball to keep it up. Respects reduced-motion and
   stops drawing when the hero is off screen, so it costs nothing on phones. */
(function () {
  'use strict';
  var TAU = Math.PI * 2;

  function pentagon(ctx, cx, cy, rad, rot) {
    ctx.beginPath();
    for (var i = 0; i < 5; i++) {
      var a = rot + (i * TAU) / 5;
      var x = cx + Math.cos(a) * rad, y = cy + Math.sin(a) * rad;
      if (i) ctx.lineTo(x, y); else ctx.moveTo(x, y);
    }
    ctx.closePath();
  }

  function drawBall(ctx, x, y, r, angle) {
    ctx.save();
    ctx.translate(x, y);

    ctx.save();
    ctx.beginPath();
    ctx.arc(0, 0, r, 0, TAU);
    ctx.clip();

    var base = ctx.createRadialGradient(-r * 0.35, -r * 0.4, r * 0.1, 0, 0, r);
    base.addColorStop(0, '#ffffff');
    base.addColorStop(0.7, '#e8ecf4');
    base.addColorStop(1, '#b7c1d6');
    ctx.fillStyle = base;
    ctx.fillRect(-r, -r, r * 2, r * 2);

    ctx.save();
    ctx.rotate(angle);
    ctx.lineJoin = 'round';
    ctx.strokeStyle = 'rgba(90,105,138,.8)';
    ctx.lineWidth = Math.max(1, r * 0.04);
    var centre = r * 0.34, k, a;
    for (k = 0; k < 5; k++) {            // seams from the centre patch outwards
      a = -Math.PI / 2 + (k * TAU) / 5;
      ctx.beginPath();
      ctx.moveTo(Math.cos(a) * centre, Math.sin(a) * centre);
      ctx.lineTo(Math.cos(a) * r * 0.8, Math.sin(a) * r * 0.8);
      ctx.stroke();
    }
    ctx.fillStyle = '#0a1228';
    pentagon(ctx, 0, 0, centre, -Math.PI / 2);
    ctx.fill();
    for (k = 0; k < 5; k++) {            // patches around the rim
      a = -Math.PI / 2 + (k * TAU) / 5;
      pentagon(ctx, Math.cos(a) * r * 1.0, Math.sin(a) * r * 1.0, r * 0.36, a + Math.PI);
      ctx.fill();
    }
    ctx.restore();

    var shade = ctx.createRadialGradient(-r * 0.25, -r * 0.3, r * 0.3, 0, 0, r);
    shade.addColorStop(0, 'rgba(8,16,40,0)');
    shade.addColorStop(1, 'rgba(8,16,40,.42)');
    ctx.fillStyle = shade;
    ctx.fillRect(-r, -r, r * 2, r * 2);

    var spec = ctx.createRadialGradient(-r * 0.42, -r * 0.48, 0, -r * 0.42, -r * 0.48, r * 0.4);
    spec.addColorStop(0, 'rgba(255,255,255,.7)');
    spec.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = spec;
    ctx.fillRect(-r, -r, r * 2, r * 2);
    ctx.restore();

    ctx.beginPath();
    ctx.arc(0, 0, r - 0.5, 0, TAU);
    ctx.strokeStyle = 'rgba(5,10,25,.45)';
    ctx.lineWidth = 1;
    ctx.stroke();
    ctx.restore();
  }

  function initBall(canvas, hero, onCount) {
    var ctx = canvas.getContext('2d');
    var reduce = window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches;
    var G = 2400, FLOOR_GAP = 16;
    var w = 0, h = 0, r = 40, ground = 0, placed = false;
    var ball = { x: 0, y: 0, vx: 0, vy: 0, a: 0 };
    var count = 0, best = 0, restTimer = 0, running = false, last = 0, raf = 0;
    try { best = +localStorage.getItem('pc_best') || 0; } catch (e) {}

    function resize() {
      var rect = hero.getBoundingClientRect();
      var dpr = Math.min(2, window.devicePixelRatio || 1);
      w = rect.width; h = rect.height;
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      r = Math.max(30, Math.min(54, w * 0.046));
      ground = h - FLOOR_GAP;
      if (!placed) {
        ball.x = w > 760 ? w * 0.74 : w * 0.5;
        ball.y = reduce ? ground - r : -r * 2;
        placed = true;
      } else {
        ball.x = Math.min(Math.max(ball.x, r), w - r);
        ball.y = Math.min(ball.y, ground - r);
      }
      draw();
    }

    function draw() {
      ctx.clearRect(0, 0, w, h);
      var height = Math.max(0, Math.min(1, (ground - r - ball.y) / (h * 0.6)));
      ctx.fillStyle = 'rgba(0,0,0,' + (0.38 - 0.22 * height).toFixed(3) + ')';
      ctx.beginPath();
      ctx.ellipse(ball.x, ground + 1, r * (1 - 0.35 * height), r * 0.16 * (1 - 0.35 * height), 0, 0, TAU);
      ctx.fill();
      drawBall(ctx, ball.x, ball.y, r, ball.a);
    }

    function step(dt) {
      ball.vy += G * dt;
      ball.x += ball.vx * dt;
      ball.y += ball.vy * dt;
      var floorY = ground - r, onGround = false;
      if (ball.y >= floorY) {
        ball.y = floorY;
        if (Math.abs(ball.vy) > 190) { ball.vy = -ball.vy * 0.66; ball.vx *= 0.97; }
        else { ball.vy = 0; onGround = true; }
      }
      if (onGround) ball.vx *= Math.pow(0.3, dt);
      if (ball.x < r) { ball.x = r; ball.vx = Math.abs(ball.vx) * 0.8; }
      if (ball.x > w - r) { ball.x = w - r; ball.vx = -Math.abs(ball.vx) * 0.8; }
      ball.a += (ball.vx / r) * dt;

      if (onGround && Math.abs(ball.vx) < 10) {
        restTimer += dt;
        if (count && restTimer > 1.8) { count = 0; onCount(count, best); }
        if (restTimer > 3.4) {            // small hop now and then, so the ball looks alive
          ball.vy = -Math.sqrt(2 * G * Math.min(120, h * 0.2));
          ball.vx = (Math.random() - 0.5) * 140;
          restTimer = 0;
        }
      } else {
        restTimer = 0;
      }
    }

    function frame(t) {
      if (!running) return;
      var dt = Math.min(0.033, (t - last) / 1000 || 0.016);
      last = t;
      step(dt);
      draw();
      raf = requestAnimationFrame(frame);
    }

    function start() {
      if (running || reduce) return;
      running = true; last = performance.now();
      raf = requestAnimationFrame(frame);
    }
    function stop() { running = false; cancelAnimationFrame(raf); }

    function kick(px, py) {
      var dx = ball.x - px, dy = ball.y - py;
      if (Math.hypot(dx, dy) > r * 1.9) return;
      var apex = Math.min(h * 0.46, 250);
      ball.vy = -Math.sqrt(2 * G * apex);
      ball.vx = Math.max(-430, Math.min(430, (dx / r) * 280)) + (Math.random() - 0.5) * 70;
      count++;
      if (count > best) {
        best = count;
        try { localStorage.setItem('pc_best', String(best)); } catch (e) {}
      }
      restTimer = 0;
      onCount(count, best);
    }

    hero.addEventListener('pointerdown', function (e) {
      if (reduce || (e.target.closest && e.target.closest('a, button'))) return;
      var rect = canvas.getBoundingClientRect();
      kick(e.clientX - rect.left, e.clientY - rect.top);
    });

    if ('ResizeObserver' in window) new ResizeObserver(resize).observe(hero);
    else window.addEventListener('resize', resize);
    resize();

    if ('IntersectionObserver' in window) {
      new IntersectionObserver(function (entries) {
        entries[0].isIntersecting && !document.hidden ? start() : stop();
      }).observe(hero);
    } else start();
    document.addEventListener('visibilitychange', function () { document.hidden ? stop() : start(); });

    onCount(0, best);
  }

  window.initBall = initBall;
})();
