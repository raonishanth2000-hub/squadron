/* Landing layer: the page a signed-out visitor sees. It hands over to app.js
   through window.Squadron when someone signs in. */
/* ============================================================
   LANDING LAYER — hero simulation, scroll choreography,
   the wipe into the workspace, and the app's moving indicators.
   ============================================================ */
(function () {
  'use strict';
  var g = window.gsap, ST = window.ScrollTrigger;
  var reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  var anim = !!g && !reduce;
  if (g && ST) g.registerPlugin(ST);
  var $ = function (s, r) { return (r || document).querySelector(s); };
  var $$ = function (s, r) { return Array.prototype.slice.call((r || document).querySelectorAll(s)); };

  var lp = $('#lp'), app = $('#app'), wipe = $('#wipe');


  /* ---------------------------------------------------------
     1. LIVE SCOREBOARD
     An ICPC board judges, re-sorts, and freezes for the last
     hour — which is exactly what the real thing does.
     --------------------------------------------------------- */
  var sbBody = $('#sb-body'), sbClock = $('#sb-clock'), sbState = $('#sb-state'),
      sbPulse = $('#sb-pulse'), sbToggle = $('#sb-toggle'), sb = $('#sb');
  var initialBoard = sbBody.innerHTML;
  var minute = 107, timer = null, paused = false, visible = true, frozen = false;

  function mmss(m) { return String(Math.floor(m / 60)).padStart(2, '0') + ':' + String(m % 60).padStart(2, '0'); }
  function rows() { return $$('.sb-row', sbBody); }

  /* FLIP: measure, reorder, then animate the delta away. */
  function reorder() {
    var els = rows();
    var before = els.map(function (e) { return e.getBoundingClientRect().top; });
    els.slice().sort(function (a, b) {
      var d = (+b.dataset.solved) - (+a.dataset.solved);
      return d !== 0 ? d : (+a.dataset.pen) - (+b.dataset.pen);
    }).forEach(function (e) { sbBody.appendChild(e); });
    rows().forEach(function (e, i) { $('.sb-rk', e).textContent = i + 1; });
    if (!anim) return;
    els.forEach(function (e, i) {
      var d = before[i] - e.getBoundingClientRect().top;
      if (Math.abs(d) < 1) return;
      g.fromTo(e, { y: d }, { y: 0, duration: 0.58, ease: 'power3.inOut', clearProps: 'transform' });
    });
  }

  function popBalloon(cell) {
    if (!anim) return;
    var r = cell.getBoundingClientRect(), b = document.createElement('div');
    b.className = 'balloon'; b.setAttribute('aria-hidden', 'true');
    b.innerHTML = '<svg class="icon"><use href="#i-balloon"/></svg>';
    b.style.left = (r.left + r.width / 2 - 9) + 'px';
    b.style.top = (r.top - 4) + 'px';
    b.style.position = 'fixed';
    document.body.appendChild(b);
    g.fromTo(b, { opacity: 0, scale: 0.4, y: 4 },
      { opacity: 1, scale: 1, y: -10, duration: 0.3, ease: 'back.out(2.6)',
        onComplete: function () {
          g.to(b, { opacity: 0, y: -46, x: (Math.random() * 16 - 8), duration: 0.75,
            ease: 'power2.in', onComplete: function () { b.remove(); } });
        } });
  }

  function judge() {
    minute += 3 + Math.floor(Math.random() * 7);
    sbClock.textContent = mmss(minute);

    /* the real board stops showing verdicts for the last hour */
    if (minute >= 240) {
      frozen = true;
      sbState.textContent = 'frozen';
      sbPulse.style.background = 'var(--warn)';
      $('.sb-live').style.color = 'var(--warn)';
      stop();
      setTimeout(function () { if (!paused) resetBoard(); }, 5200);
      return;
    }

    var all = rows();
    /* weight the home team a little — the story is you climbing */
    var row = Math.random() < 0.34 ? $('.sb-row.you', sbBody) : all[Math.floor(Math.random() * all.length)];
    if (!row) return;

    var pend = $('.sb-c.pend', row);
    var cell = pend;
    if (!cell) {
      var open = $$('.sb-c', row).filter(function (c) { return !c.classList.contains('ac') && !c.classList.contains('pend'); });
      if (!open.length) return;
      /* earlier letters get solved more often, as they do in a real set */
      cell = open[Math.floor(Math.pow(Math.random(), 1.7) * open.length)];
    }

    cell.classList.remove('wa', 'pend');
    cell.classList.add('ac');
    cell.textContent = minute;
    row.dataset.solved = (+row.dataset.solved) + 1;
    row.dataset.pen = (+row.dataset.pen) + minute;
    $('.sb-n', row).textContent = row.dataset.solved;
    $('.sb-p', row).textContent = row.dataset.pen;

    if (anim) g.fromTo(cell, { scale: 0.55, opacity: 0.3 }, { scale: 1, opacity: 1, duration: 0.42, ease: 'back.out(2.4)' });
    popBalloon(cell);

    /* leave a pending submission behind now and then */
    if (Math.random() < 0.32) {
      var free = $$('.sb-c', row).filter(function (c) { return !c.classList.contains('ac') && !c.classList.contains('pend'); });
      if (free.length) { free[0].classList.add('pend'); free[0].textContent = '?'; }
    }
    reorder();
  }

  function resetBoard() {
    sbBody.innerHTML = initialBoard;
    minute = 107; frozen = false;
    sbClock.textContent = mmss(minute);
    sbState.textContent = 'judging';
    sbPulse.style.background = 'var(--ok)';
    $('.sb-live').style.color = 'var(--ok)';
    start();
  }
  function start() { if (timer || paused || !visible || frozen || reduce) return; timer = setInterval(judge, 2400); }
  function stop() { clearInterval(timer); timer = null; }

  sbToggle.addEventListener('click', function () {
    paused = !paused;
    sbToggle.setAttribute('aria-pressed', String(paused));
    sbToggle.setAttribute('aria-label', paused ? 'Resume the live standings' : 'Pause the live standings');
    $('use', sbToggle).setAttribute('href', paused ? '#i-play' : '#i-pause');
    if (paused) { stop(); sbState.textContent = 'paused'; }
    else { sbState.textContent = frozen ? 'frozen' : 'judging'; start(); }
  });

  if (reduce) { sbState.textContent = 'paused'; sbPulse.style.background = 'var(--text-3)'; $('.sb-live').style.color = 'var(--text-3)'; }
  if (window.IntersectionObserver) {
    new IntersectionObserver(function (e) {
      visible = e[0].isIntersecting;
      if (visible) start(); else stop();
    }, { threshold: 0.15 }).observe(sb);
  } else start();

  /* the pulse itself */
  if (anim) g.to(sbPulse, { opacity: 0.25, duration: 0.85, repeat: -1, yoyo: true, ease: 'sine.inOut' });


  /* ---------------------------------------------------------
     2. HERO ENTRANCE + SCROLL CHOREOGRAPHY
     Every reveal uses gsap.from(), so the final state is what
     lives in the DOM — no CDN, no problem, page still reads.
     --------------------------------------------------------- */
  /* give each word a mask to rise out of */
  $$('.lp-h1 .w').forEach(function (w) {
    var m = document.createElement('span');
    m.className = 'wm';
    w.parentNode.insertBefore(m, w);
    m.appendChild(w);
  });

  if (anim) {
    var hero = g.timeline({ defaults: { ease: 'power3.out' } });
    hero.from('.lp-nav .lp-wrap > *', { opacity: 0, y: -10, duration: 0.5, stagger: 0.06 }, 0)
        .from('.lp-eyebrow', { opacity: 0, y: 12, duration: 0.5 }, 0.1)
        .from('.lp-h1 .w', { opacity: 0, yPercent: 108, duration: 0.72, stagger: 0.035, ease: 'expo.out' }, 0.16)
        .from('.lp-lede', { opacity: 0, y: 14, duration: 0.6 }, 0.42)
        .from('.lp-cta > *', { opacity: 0, y: 12, duration: 0.5, stagger: 0.07 }, 0.5)
        .from('.fact', { opacity: 0, y: 14, duration: 0.5, stagger: 0.07 }, 0.58)
        .from('#sb', { opacity: 0, y: 28, scale: 0.975, duration: 0.85, ease: 'power3.out', clearProps: 'transform' }, 0.26)
        .from('.sb-row', { opacity: 0, x: 18, duration: 0.5, stagger: 0.055 }, 0.5)
        .from('.hud > span', { opacity: 0, duration: 0.6, stagger: 0.09 }, 0.34);

    if (document.hidden) hero.progress(1);
    setTimeout(function () { if (hero.progress() < 1) hero.progress(1); }, 2600);

    /* the facts count up as they arrive */
    $$('.fact b[data-count]').forEach(function (el, i) {
      var target = +el.dataset.count, o = { v: 0 };
      g.to(o, { v: target, duration: 0.9, delay: 0.62 + i * 0.07, ease: 'power2.out',
        onUpdate: function () { el.textContent = Math.round(o.v); } });
    });
  }

  if (anim && ST) {
    var reveal = function (sel, opts) {
      $$(sel).forEach(function (el) {
        g.from(el, Object.assign({
          opacity: 0, y: 26, duration: 0.72, ease: 'power3.out',
          scrollTrigger: { trigger: el, scroller: lp, start: 'top 88%', once: true }
        }, opts || {}));
      });
    };
    reveal('.lp-head');
    reveal('.drift-i', { y: 22, stagger: 0.08, duration: 0.6 });
    reveal('.feat-txt', { x: -18, y: 0, duration: 0.68 });
    reveal('.shot', { y: 30, scale: 0.985, duration: 0.8, clearProps: 'transform' });
    reveal('.xpband', { y: 28, duration: 0.8 });
    reveal('.kind', { y: 24, stagger: 0.07, duration: 0.6 });
    reveal('.lp-close > h2, .lp-close > p, .lp-close > .lp-cta', { y: 22, stagger: 0.08, duration: 0.65 });
    reveal('.xp-rule', { x: -14, y: 0, stagger: 0.05, duration: 0.5 });

    /* the ring fills when the economy section arrives */
    var lpArc = $('#lp-arc');
    g.from(lpArc, { strokeDashoffset: 326.7, duration: 1.1, ease: 'power2.out',
      scrollTrigger: { trigger: '.xpband', scroller: lp, start: 'top 80%', once: true } });

    /* a slow parallax drift on the hero's dot grid, nothing more */
    ST.create({
      scroller: lp, trigger: '.lp-hero', start: 'top top', end: 'bottom top', scrub: 0.6,
      onUpdate: function (self) { $('.lp-hero').style.setProperty('--par', (self.progress * 34).toFixed(1) + 'px'); }
    });
  }

  /* nav gains its border only once you have left the hero */
  var nav = $('#lp-nav');
  lp.addEventListener('scroll', function () {
    nav.dataset.stuck = lp.scrollTop > 24 ? '1' : '0';
  }, { passive: true });



  /* ---------------------------------------------------------
     6. HUD CLOCK + LADDER
     --------------------------------------------------------- */
  var hudClock = $('#hud-clock');
  function tickClock() {
    var d = new Date();
    hudClock.textContent = [d.getHours(), d.getMinutes(), d.getSeconds()]
      .map(function (n) { return String(n).padStart(2, '0'); }).join(':');
  }
  tickClock();
  setInterval(function () { if (!lp.hidden) tickClock(); }, 1000);

  if (anim && ST) {
    var ladderTrigger = { trigger: '.ladder', scroller: lp, start: 'top 84%', once: true };
    g.from('.lseg', { scaleX: 0, duration: 0.78, stagger: 0.055, ease: 'power3.out',
      scrollTrigger: ladderTrigger });
    /* the marks carry a CSS translateX(-50%), so GSAP has to hold it
       through the tween and hand it back afterwards */
    g.from('.lmark', { opacity: 0, y: 16, scale: 0.7, xPercent: -50, duration: 0.5,
      stagger: 0.07, ease: 'back.out(2)', clearProps: 'transform',
      scrollTrigger: { trigger: '.ladder', scroller: lp, start: 'top 78%', once: true } });
    g.from('.ltick, .lkey', { opacity: 0, duration: 0.42, stagger: 0.03,
      scrollTrigger: { trigger: '.ladder', scroller: lp, start: 'top 78%', once: true } });
  }


  /* ---------------------------------------------------------
     7. UNIT-03 + THE INSTRUMENT CURSOR
     --------------------------------------------------------- */
  var fine = window.matchMedia('(pointer:fine)').matches;
  var bot = $('#bot'), botEyes = $$('.bot-eye'), botHead = $('.bot-head'),
      botRead = $('.bot-read'), botRings = $$('.bot-ring'), botBody = $('.bot-body');
  var curDot = $('#cur-dot'), curRing = $('#cur-ring');
  var spot = $('#spot');
  var mx = 0, my = 0, rx = 0, ry = 0, sx = 0, sy = 0, queued = false, mood = 'track';

  if (fine) {
    document.body.classList.add('has-cur');
    rx = sx = mx = window.innerWidth / 2; ry = sy = my = window.innerHeight / 2;
    spot.style.opacity = '1';
  }

  function setMood(next) {
    if (next === mood) return;
    mood = next;
    bot.dataset.mood = next;
    botRead.textContent = next === 'happy' ? 'LET\'S GO' : 'TRACKING';
    if (next !== 'happy' || !anim) return;
    /* robotic delight: a servo hop and two pings off the antenna */
    g.fromTo(botBody, { y: 0 }, { y: -10, duration: 0.2, ease: 'power2.out', yoyo: true, repeat: 3 });
    botRings.forEach(function (r, i) {
      g.fromTo(r, { opacity: 0.9, scale: 1 },
        { opacity: 0, scale: 3.6, duration: 0.9, delay: i * 0.24, ease: 'power2.out' });
    });
  }

  /* The trail factors below are tuned per 60fps frame. Applying them once per
     frame regardless of frame length makes the reticle's speed depend on the
     machine — at 15fps it visibly drags seconds behind the dot. Scaling by the
     real elapsed time keeps the same feel at any rate. */
  var lastT = 0;
  function ease(base, dt) { return reduce ? 1 : 1 - Math.pow(1 - base, dt / 16.7); }

  function frame(ts) {
    queued = false;
    var t = ts || (window.performance ? performance.now() : Date.now());
    var dt = lastT ? Math.min(t - lastT, 100) : 16.7;   /* clamp: tab wake-ups */
    lastT = t;

    /* cursor: dot is exact, reticle trails it */
    if (fine) {
      var kr = ease(0.18, dt), ks = ease(0.085, dt);
      curDot.style.transform = 'translate3d(' + mx + 'px,' + my + 'px,0) translate(-50%,-50%)';
      rx += (mx - rx) * kr;
      ry += (my - ry) * kr;
      curRing.style.transform = 'translate3d(' + rx.toFixed(1) + 'px,' + ry.toFixed(1) + 'px,0) translate(-50%,-50%)';
      /* the spotlight trails further behind so the ground eases rather than snaps */
      sx += (mx - sx) * ks;
      sy += (my - sy) * ks;
      spot.style.transform = 'translate3d(' + sx.toFixed(1) + 'px,' + sy.toFixed(1) + 'px,0) translate(-50%,-50%)';
      spot.style.opacity = (lp.hidden || document.body.classList.contains('curtain')) ? '0' : '1';
      var settled = Math.abs(mx - rx) + Math.abs(my - ry) + Math.abs(mx - sx) + Math.abs(my - sy);
      if (!reduce && settled > 0.5) { queued = true; requestAnimationFrame(frame); }
    }

    if (!bot || lp.hidden || reduce || !fine) return;

    /* read every rect first, then write — never interleave */
    var eyeCentres = botEyes.map(function (e) {
      var r = e.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    });
    var hr = botHead.getBoundingClientRect();
    var targets = $$('[data-enter]').map(function (t) { return t.getBoundingClientRect(); });

    eyeCentres.forEach(function (c, i) {
      var dx = mx - c.x, dy = my - c.y, d = Math.sqrt(dx * dx + dy * dy) || 1;
      var reach = Math.min(d / 130, 1) * 3.1;
      botEyes[i].setAttribute('transform',
        'translate(' + (dx / d * reach).toFixed(2) + ',' + (dy / d * reach).toFixed(2) + ')');
    });
    botHead.style.transform =
      'rotate(' + Math.max(-7, Math.min(7, (mx - (hr.left + hr.width / 2)) / 40)).toFixed(2) + 'deg)';

    /* a tight halo: hovering, or a hair away from, any enter button */
    if (targets.length) {
      var gap = Infinity;
      targets.forEach(function (tr) {
        var nx = Math.max(tr.left, Math.min(mx, tr.right));
        var ny = Math.max(tr.top, Math.min(my, tr.bottom));
        var d = Math.sqrt((mx - nx) * (mx - nx) + (my - ny) * (my - ny));
        if (d < gap) gap = d;
      });
      setMood(gap < 26 ? 'happy' : 'track');
    }
  }

  /* With the real pointer hidden the ring is the only affordance left, so it
     has to widen on everything that was previously a hand cursor. */
  var HOT = 'a,button,select,summary,label[for],[role="tab"],[role="button"],[tabindex]:not([tabindex="-1"]),' +
            '.squad,.kind,.card,.react,.chan,.sq-item,.sw,.fchip,.sym,.tk,.day';
  var TEXTY = 'input:not([type="checkbox"]):not([type="radio"]):not([type="range"]),textarea,[contenteditable="true"]';
  if (fine) {
    window.addEventListener('pointermove', function (e) {
      mx = e.clientX; my = e.clientY;
      /* any movement proves the pointer is inside; needed because returning
         from another window fires no mouseenter if it never left the frame */
      if (document.body.classList.contains('cur-away')) {
        document.body.classList.remove('cur-away');
        rx = sx = mx; ry = sy = my; lastT = 0;
      }
      if (!queued) { queued = true; requestAnimationFrame(frame); }
    }, { passive: true });
    document.addEventListener('pointerover', function (e) {
      var t = e.target;
      document.body.classList.toggle('cur-hot', !!(t.closest && t.closest(HOT)));
      document.body.classList.toggle('cur-text', !!(t.closest && t.closest(TEXTY)));
    }, { passive: true });
    lp.addEventListener('scroll', function () {
      if (!queued) { queued = true; requestAnimationFrame(frame); }
    }, { passive: true });

    /* Leaving the window strands the dot wherever it was; alt-tabbing back
       would otherwise snap it across the screen on the first move. Park it,
       and re-seat it silently where the pointer actually re-enters. */
    function park() { document.body.classList.add('cur-away'); lastT = 0; }
    document.documentElement.addEventListener('mouseleave', park);
    window.addEventListener('blur', park);
    document.documentElement.addEventListener('mouseenter', function (e) {
      document.body.classList.remove('cur-away');
      mx = rx = sx = e.clientX; my = ry = sy = e.clientY;
      lastT = 0;
      if (!queued) { queued = true; requestAnimationFrame(frame); }
    });

    frame();

    if (anim && window.IntersectionObserver) {
      bot.dataset.reveal = 'pending';
      var botIO = new IntersectionObserver(function (e) {
        if (!e[0].isIntersecting) return;
        bot.removeAttribute('data-reveal');
        botIO.disconnect();
      }, { root: lp, threshold: 0.12 });
      botIO.observe(bot);
      /* if the observer never reports, show it anyway */
      setTimeout(function () { bot.removeAttribute('data-reveal'); }, 4000);
    }
  }

  /* ---------------------------------------------------------
     HANDOVER — "Open the workspace" asks app.js to sign you in,
     then the curtain types you across.
     --------------------------------------------------------- */
  var lpEl = $('#lp'), wipe = $('#wipe');

  function showLanding() {
    lpEl.hidden = false;
    document.body.classList.remove('in-app');
    start();
    if (anim && ST) ST.refresh();
  }
  function hideLanding() {
    lpEl.hidden = true;
    document.body.classList.add('in-app');
    stop();
  }

  function curtain(name, done) {
    var first = String(name || 'there').trim().split(/\s+/)[0];
    var typeEl = $('#wipe-text'), inner = $('.wipe-inner'), barF = $('#wipe-bar-f');
    var sheen = $('.wipe-sheen'), hi = $('#wipe-hi'), tag = $('.wipe-tag'), bar = $('.wipe-bar');

    /* one span per letter so the name can land character by character */
    typeEl.innerHTML = '';
    var chars = [];
    first.toUpperCase().split('').forEach(function (c) {
      var sp = document.createElement('span');
      sp.className = 'wipe-ch';
      if (c === ' ') { sp.setAttribute('data-sp', '1'); sp.innerHTML = '&nbsp;'; }
      else sp.textContent = c;
      typeEl.appendChild(sp);
      chars.push(sp);
    });

    barF.style.width = '0%';
    wipe.hidden = false;
    document.body.classList.add('curtain');

    var fired = false;
    function finish() {
      if (fired) return; fired = true;
      clearTimeout(guard);
      wipe.hidden = true;
      document.body.classList.remove('curtain');
    }
    /* the workspace must appear even if a tween never reports back */
    var guard = setTimeout(finish, 5600);

    if (!anim) {
      hideLanding();
      done();
      setTimeout(finish, 900);
      return;
    }

    /* Apply the start state now, not as the timeline's first frame. A second
       sign-in in the same page load still holds the previous run's lifted
       position, which showed for one frame before the timeline took over. */
    g.set(wipe, { yPercent: 100 });
    g.set([tag, hi, bar], { opacity: 0, y: 14 });
    g.set(chars, { yPercent: 118, rotate: 4, opacity: 0 });
    g.set(sheen, { xPercent: -120 });

    var tl = g.timeline();
    /* the panel rises, then eases the last of the way rather than stopping dead */
    tl.to(wipe, { yPercent: 0, duration: 0.66, ease: 'expo.out' })
      .to(tag, { opacity: 1, y: 0, duration: 0.32, ease: 'power2.out' }, '-=0.22')
      .to(hi, { opacity: 1, y: 0, duration: 0.34, ease: 'power2.out' }, '-=0.20')
      .to(chars, {
        yPercent: 0, rotate: 0, opacity: 1,
        duration: 0.62, ease: 'back.out(1.9)',
        stagger: { each: Math.min(0.06, 0.42 / Math.max(chars.length, 1)), from: 'start' }
      }, '-=0.12')
      .to(bar, { opacity: 1, y: 0, duration: 0.28, ease: 'power2.out' }, '-=0.34')
      .to(barF, { width: '100%', duration: 0.95, ease: 'power1.inOut' }, '-=0.30')
      .to(sheen, { xPercent: 120, duration: 0.72, ease: 'power2.inOut' }, '-=0.78')
      /* hand the workspace over while the curtain is still up, so what is
         underneath is already painted when it lifts */
      .call(function () { hideLanding(); done(); })
      .addLabel('lift', '+=0.42')
      .to(chars, { yPercent: -90, opacity: 0, duration: 0.4, ease: 'power2.in',
        stagger: { each: 0.018, from: 'end' } }, 'lift')
      .to([tag, hi, bar], { opacity: 0, y: -16, duration: 0.3, ease: 'power2.in' }, 'lift')
      .to(wipe, { yPercent: -100, duration: 0.78, ease: 'expo.inOut' }, 'lift+=0.2')
      .call(finish, null, 'lift+=0.92');
  }

  /* app.js drives the session; the landing only asks and animates */
  window.Squadron = window.Squadron || {};
  window.Squadron.landing = {
    show: showLanding,
    hide: hideLanding,
    curtain: curtain
  };

  $$('[data-enter]').forEach(function (b) {
    b.addEventListener('click', function () {
      if (window.Squadron.openAuth) window.Squadron.openAuth();
    });
  });

  /* app.js may have decided before this file ran — obey whatever it set */
  if (lpEl.hidden) stop(); else showLanding();
})();
