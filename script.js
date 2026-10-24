'use strict';
/* Sky Hopper: endless runner.
   Sections: config, storage, input, world, update, render, UI, boot.
   World coordinates: x in logical px; y is an OFFSET from the ground line (0 = ground top, negative = up),
   so the layout survives resizing and rotation. */

/* ---------- Config ---------- */
const CFG = { H: 360, MIN_W: 420, GRAV: 1800, JUMP_V: -640, MOVE_V: 230,
  BASE_SPEED: 220, MAX_SPEED: 520, ACCEL: 0.12, HIST_MAX: 10 };
const KEY_BEST = 'skyhopper.best', KEY_HIST = 'skyhopper.history';
const $ = id => document.getElementById(id);

/* ---------- Storage (safe against missing / corrupt data) ---------- */
const Store = {
  read(k, def) { try { const v = localStorage.getItem(k); return v === null ? def : JSON.parse(v); } catch (e) { return def; } },
  write(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* storage unavailable */ } },
  best() { const b = this.read(KEY_BEST, 0); return Number.isFinite(b) && b > 0 ? Math.floor(b) : 0; },
  history() {
    const h = this.read(KEY_HIST, []);
    return Array.isArray(h) ? h.filter(r => r && Number.isFinite(r.score) && typeof r.date === 'string').slice(0, CFG.HIST_MAX) : [];
  },
  addRun(score) {
    const h = this.history();
    h.unshift({ score: score, date: new Date().toISOString() });
    this.write(KEY_HIST, h.slice(0, CFG.HIST_MAX));
    if (score > this.best()) this.write(KEY_BEST, score);
  }
};

/* ---------- Sound (tiny WebAudio beeps, no files) + mute ---------- */
let ac, muted = Store.read('skyhopper.muted', false) === true;
function snd(f, d, t, f2) {
  if (muted) return;
  try {
    ac = ac || new AudioContext(); const o = ac.createOscillator(), v = ac.createGain(), n = ac.currentTime;
    o.type = t || 'square'; o.frequency.setValueAtTime(f, n); if (f2) o.frequency.exponentialRampToValueAtTime(f2, n + d);
    v.gain.setValueAtTime(0.06, n); v.gain.exponentialRampToValueAtTime(0.001, n + d);
    o.connect(v); v.connect(ac.destination); o.start(n); o.stop(n + d);
  } catch (e) { /* audio unavailable */ }
}
function toggleMute() { muted = !muted; Store.write('skyhopper.muted', muted); $('muteBtn').textContent = muted ? '\uD83D\uDD07' : '\uD83D\uDD0A'; }
$('muteBtn').textContent = muted ? '\uD83D\uDD07' : '\uD83D\uDD0A';

/* ---------- Input: keyboard + pointer buttons (touch / mouse / pen) ---------- */
const kb = { left: 0, right: 0, jump: 0 }, tp = { left: 0, right: 0, jump: 0 };
const KEYS = { ArrowLeft: 'left', KeyA: 'left', ArrowRight: 'right', KeyD: 'right', ArrowUp: 'jump', KeyW: 'jump', Space: 'jump' };
const held = n => !!(kb[n] || tp[n]);
addEventListener('keydown', e => {
  const n = KEYS[e.code];
  if (n) { kb[n] = 1; e.preventDefault(); return; }
  if (e.repeat) return;
  if (e.code === 'KeyP' || e.code === 'Escape') togglePause();
  else if (e.code === 'Enter' && (G.state === 'menu' || G.state === 'over')) startGame();
});
addEventListener('keyup', e => { const n = KEYS[e.code]; if (n) kb[n] = 0; });
function releaseAll() { for (const n in kb) { kb[n] = 0; tp[n] = 0; } }
addEventListener('blur', releaseAll);
document.querySelectorAll('[data-k]').forEach(b => {
  const n = b.dataset.k;
  b.addEventListener('pointerdown', e => { e.preventDefault(); tp[n] = 1; try { b.setPointerCapture(e.pointerId); } catch (_) { /* ignore */ } });
  ['pointerup', 'pointercancel', 'lostpointercapture'].forEach(t => b.addEventListener(t, () => { tp[n] = 0; }));
  b.addEventListener('contextmenu', e => e.preventDefault());
});
// Block page scroll / pinch-zoom while playing (history list stays scrollable).
$('app').addEventListener('touchmove', e => { if (!e.target.closest('.hist')) e.preventDefault(); }, { passive: false });
document.addEventListener('gesturestart', e => e.preventDefault());

/* ---------- State ---------- */
const cv = $('game'), ctx = cv.getContext('2d');
let W = 640, H = 360, scale = 1, dpr = 1, gy = 280, sky = '#2a2a6b';
const G = { state: 'menu', shake: 0, cd: 0, nextMile: 500, score: 0, dist: 0, bonus: 0, coins: 0, speed: 0, scroll: 0, dieT: 0, newBest: false,
  ground: [], plats: [], hz: [], coinList: [] };
const P = { x: 80, y: 0, w: 22, h: 30, vy: 0, ground: true, coyote: 0, anim: 0, sx: 1, sy: 1, alive: true, dustT: 0 };
let nextX = 0, jumpBuf = 0, prevJump = false, historyFrom = 'menu';
const clouds = Array.from({ length: 6 }, (_, i) => ({ x: i * 160, y: 30 + (i % 3) * 38, k: 0.05 + (i % 3) * 0.04, s: 0.8 + (i % 2) * 0.5 }));

/* ---------- Particles (fixed pool, no allocation during play) ---------- */
const parts = Array.from({ length: 90 }, () => ({ on: false, x: 0, y: 0, vx: 0, vy: 0, life: 0, max: 1, c: '#fff', r: 2 }));
let pi = 0;
function emit(x, y, n, col, spd, up) {
  for (let i = 0; i < n; i++) {
    const p = parts[pi = (pi + 1) % parts.length], a = Math.random() * 6.283, s = spd * (0.3 + Math.random());
    p.on = true; p.x = x; p.y = y; p.vx = Math.cos(a) * s; p.vy = Math.sin(a) * s - up;
    p.life = p.max = 0.3 + Math.random() * 0.4; p.c = col; p.r = 1.5 + Math.random() * 2;
  }
}
function updateParts(dt) {
  for (const p of parts) { if (!p.on) continue; p.life -= dt; if (p.life <= 0) { p.on = false; continue; } p.vy += 600 * dt; p.x += p.vx * dt; p.y += p.vy * dt; }
}

/* ---------- Floating score pops + banner ---------- */
const pops = Array.from({ length: 10 }, () => ({ on: false, x: 0, y: 0, t: 0, s: '', c: '#fff' }));
let po = 0;
function pop(x, y, s, c) { const p = pops[po = (po + 1) % pops.length]; p.on = true; p.x = x; p.y = y; p.t = 0.8; p.s = s; p.c = c; }
function updatePops(dt) { for (const p of pops) if (p.on) { p.t -= dt; p.y -= 45 * dt; if (p.t <= 0) p.on = false; } }
function banner(s) { const b = $('banner'); b.textContent = s; b.classList.remove('show'); void b.offsetWidth; b.classList.add('show'); }

/* ---------- World generation ---------- */
function resize() {
  dpr = Math.min(window.devicePixelRatio || 1, 2);
  const app = $('app'), cw = app.clientWidth, ch = app.clientHeight;
  scale = Math.min(ch / CFG.H, cw / CFG.MIN_W);
  W = cw / scale; H = ch / scale;
  cv.width = Math.round(cw * dpr); cv.height = Math.round(ch * dpr);
  cv.style.width = cw + 'px'; cv.style.height = ch + 'px';
  gy = Math.round(Math.min(H - 80, Math.max(H * 0.62, 250)));
  const g = ctx.createLinearGradient(0, 0, 0, H);
  g.addColorStop(0, '#2a2a6b'); g.addColorStop(0.6, '#ff8a5c'); g.addColorStop(1, '#ffd08a');
  sky = g;
  if (G.state === 'menu') resetWorld();
}
function resetWorld() {
  G.score = G.dist = G.bonus = G.coins = G.scroll = 0; G.speed = CFG.BASE_SPEED; G.newBest = false; G.nextMile = 500; G.shake = 0;
  G.ground.length = G.plats.length = G.hz.length = G.coinList.length = 0;
  G.ground.push({ x: -60, w: W + 420 }); nextX = W + 360;
  Object.assign(P, { x: Math.min(90, W * 0.25), y: 0, vy: 0, ground: true, coyote: 0, anim: 0, sx: 1, sy: 1, alive: true });
  jumpBuf = 0; prevJump = false;
  parts.forEach(p => { p.on = false; });
}
function coin(x, y) { G.coinList.push({ x: x, y: y, got: false }); }
function spawn() {
  const gap = 70 + G.speed * 0.2 + Math.random() * 30, sx = nextX + gap, len = 260 + Math.random() * 260;
  G.ground.push({ x: sx, w: len });
  for (let i = 0; i < 3; i++) coin(nextX + 10 + i * (gap / 3), -70 + Math.abs(i - 1) * 14); // arc over the pit
  let cx = sx + 110;
  while (cx < sx + len - 90) {
    const r = Math.random();
    if (r < 0.3) { const n = Math.random() < 0.35 ? 2 : 1; G.hz.push({ t: 's', x: cx, y: -18, w: n * 16, h: 18 }); cx += n * 16 + 150; }
    else if (r < 0.55) { G.hz.push({ t: 'e', x: cx, y: -20, w: 24, h: 20, vx: 55, dead: false }); cx += 160; }
    else if (r < 0.85) {
      const pw = 90 + Math.random() * 60, py = -(78 + Math.random() * 28);
      G.plats.push({ x: cx, y: py, w: pw, h: 12 });
      for (let i = 0; i < Math.floor(pw / 26); i++) coin(cx + 10 + i * 26, py - 16);
      cx += pw + 100;
    } else { for (let i = 0; i < 4; i++) coin(cx + i * 26, -40); cx += 140; }
  }
  nextX = sx + len;
}
function cull(a) { let j = 0; for (let i = 0; i < a.length; i++) { const e = a[i]; if (e.x + (e.w || 0) > -60 && !e.dead && !e.got) a[j++] = e; } a.length = j; }

/* ---------- Update ---------- */
function overlap(a, b, m) { return a.x + m < b.x + b.w && a.x + a.w - m > b.x && a.y - a.h + m < b.y + b.h && a.y - m > b.y; }
function die() {
  if (!P.alive) return;
  P.alive = false; G.state = 'dying'; G.dieT = 0.7; G.shake = 0.5; snd(300, 0.45, 'sawtooth', 60);
  emit(P.x + P.w / 2, gy + Math.max(-20, Math.min(P.y, 40)) - 15, 28, '#ff5e5b', 220, 120);
  emit(P.x + P.w / 2, gy + Math.max(-20, Math.min(P.y, 40)) - 15, 16, '#2bb673', 180, 100);
  G.newBest = G.score > Store.best();
  Store.addRun(G.score);
}
function update(dt) {
  G.speed = Math.min(CFG.MAX_SPEED, CFG.BASE_SPEED + G.dist * CFG.ACCEL);
  const dx = G.speed * dt;
  G.scroll += dx; G.dist += dx / 10; G.score = Math.floor(G.dist) + G.bonus;
  nextX -= dx;
  for (const s of G.ground) s.x -= dx;
  for (const s of G.plats) s.x -= dx;
  for (const s of G.coinList) s.x -= dx;
  for (const s of G.hz) s.x -= dx + (s.vx ? s.vx * dt : 0);
  while (nextX < W + 300) spawn();
  if (G.score >= G.nextMile) { banner(G.nextMile + ' points!'); snd(660, 0.25, 'triangle', 990); G.nextMile += 500; }

  // Horizontal steering (the world already runs forward)
  const dir = (held('right') ? 1 : 0) - (held('left') ? 1 : 0);
  P.x = Math.max(16, Math.min(W * 0.7, P.x + dir * CFG.MOVE_V * dt));

  // Jump: buffered press + coyote time; no mid-air jumps
  const j = held('jump'); if (j && !prevJump) jumpBuf = 0.12; prevJump = j; jumpBuf -= dt;
  if (P.ground) P.coyote = 0.1; else P.coyote -= dt;
  if (jumpBuf > 0 && P.coyote > 0) {
    snd(380, 0.16, 'square', 760); P.vy = CFG.JUMP_V; P.ground = false; P.coyote = 0; jumpBuf = 0; P.sx = 0.8; P.sy = 1.25;
    emit(P.x + P.w / 2, gy + P.y, 6, '#f5efe0', 70, 20);
  }
  if (!j && P.vy < -250) P.vy = -250; // release early = short hop

  // Gravity + one-way landing on ground segments and platforms
  const prev = P.y, was = P.ground;
  P.vy = Math.min(P.vy + CFG.GRAV * dt, 900); P.y += P.vy * dt; P.ground = false;
  if (P.vy >= 0) {
    const land = (s, top) => {
      if (P.x + P.w > s.x + 3 && P.x < s.x + s.w - 3 && prev <= top + 6 && P.y >= top) { P.y = top; P.vy = 0; P.ground = true; return true; }
      return false;
    };
    for (const s of G.ground) if (land(s, 0)) break;
    if (!P.ground) for (const s of G.plats) if (land(s, s.y)) break;
  }
  if (P.ground && !was) { P.sx = 1.25; P.sy = 0.78; emit(P.x + P.w / 2, gy + P.y, 7, '#f5efe0', 80, 30); }
  const k = Math.min(1, dt * 12); P.sx += (1 - P.sx) * k; P.sy += (1 - P.sy) * k;
  if (P.ground) P.anim += dt * G.speed / 28;
  P.dustT -= dt;
  if (P.dustT <= 0) { P.dustT = P.ground ? 0.06 : 0.04; if (P.ground) emit(P.x + 4, gy, 1, '#e9dcc0', 35, 12); else emit(P.x + P.w / 2, gy + P.y - 15, 1, '#3ddc97', 15, 0); }

  // Hazards
  for (const h of G.hz) {
    if (h.dead || !overlap(P, h, 3)) continue;
    if (h.t === 'e' && P.vy > 0 && prev <= h.y + 8) {
      h.dead = true; P.vy = -420; P.ground = false; G.bonus += 50; snd(220, 0.14, 'square', 520); pop(h.x + 12, gy + h.y - 8, '+50', '#ffd34d');
      emit(h.x + 12, gy + h.y + 10, 10, '#5a1f4a', 140, 60);
    } else { die(); return; }
  }
  for (const c of G.coinList) {
    if (c.got) continue;
    if (Math.abs(c.x - (P.x + P.w / 2)) < 18 && Math.abs(c.y - (P.y - P.h / 2)) < 22) { c.got = true; G.coins++; G.bonus += 10; snd(1000, 0.08, 'triangle', 1500); pop(c.x, gy + c.y - 12, '+10', '#f5b700'); emit(c.x, gy + c.y, 6, '#f5b700', 90, 40); }
  }
  if (P.y > 140) { die(); return; }
  cull(G.ground); cull(G.plats); cull(G.hz); cull(G.coinList);
}

/* ---------- Sky: palette cycles sunset > day > dusk > night as you run ---------- */
const PAL = [['#2a2a6b', '#ff8a5c', '#ffd08a'], ['#3b8fe8', '#86cdfa', '#e3f6ff'], ['#3a1c71', '#d76d77', '#ffaf7b'], ['#07071f', '#17174f', '#3a2a6b']];
const hx = (h, i) => parseInt(h.slice(1 + i * 2, 3 + i * 2), 16);
const mixc = (a, b, t) => 'rgb(' + [0, 1, 2].map(i => Math.round(hx(a, i) + (hx(b, i) - hx(a, i)) * t)).join(',') + ')';
function skyFill() {
  const k = G.dist / 400, i = Math.floor(k) % 4, m = Math.max(0, Math.min(1, (k % 1 - 0.7) * 3.3)), a = PAL[i], b = PAL[(i + 1) % 4];
  const g = ctx.createLinearGradient(0, 0, 0, H);
  g.addColorStop(0, mixc(a[0], b[0], m)); g.addColorStop(0.6, mixc(a[1], b[1], m)); g.addColorStop(1, mixc(a[2], b[2], m));
  ctx.fillStyle = g; ctx.fillRect(-20, -20, W + 40, H + 40);
  const n = i === 3 ? 1 - m : (i === 2 ? m : 0);
  if (n > 0) { ctx.fillStyle = '#fff'; for (let s = 0; s < 28; s++) { ctx.globalAlpha = n * (0.4 + 0.5 * Math.abs(Math.sin(G.t0 * 2 + s))); ctx.fillRect((s * 97) % W, (s * 53) % (gy - 60), 2, 2); } ctx.globalAlpha = 1; }
}

/* ---------- Render ---------- */
function rr(x, y, w, h, r) { ctx.beginPath(); if (ctx.roundRect) ctx.roundRect(x, y, w, h, r); else ctx.rect(x, y, w, h); }
function hills(f, col, base, amp) {
  ctx.fillStyle = col; ctx.beginPath(); ctx.moveTo(0, H);
  for (let i = 0; i <= W + 16; i += 16) { const w = i + G.scroll * f; ctx.lineTo(i, base - Math.sin(w / 90) * amp * 0.5 - Math.sin(w / 37) * amp * 0.2); }
  ctx.lineTo(W + 16, H); ctx.fill();
}
function drawPlayer() {
  const bob = P.ground ? Math.abs(Math.sin(P.anim)) * 2 : 0, l = P.ground ? Math.sin(P.anim) * 5 : 3;
  ctx.save(); ctx.translate(P.x + P.w / 2, gy + P.y); ctx.scale(P.sx, P.sy);
  ctx.translate(0, -15); ctx.rotate(P.ground ? 0 : Math.max(-0.25, Math.min(0.25, P.vy / 2400))); ctx.translate(0, 15);
  ctx.fillStyle = '#1b1b3a'; ctx.fillRect(-8 + l, -6, 6, 6); ctx.fillRect(2 - l, -6, 6, 6);
  ctx.fillStyle = '#ff5e5b'; rr(-24, -22 - bob + Math.sin(G.t0 * 18) * 3, 14, 5, 2); ctx.fill(); rr(-20, -17 - bob + Math.sin(G.t0 * 18 + 1) * 3, 10, 4, 2); ctx.fill();
  ctx.fillStyle = '#2bb673'; rr(-11, -30 - bob, 22, 24, 7); ctx.fill();
  ctx.fillStyle = '#ff5e5b'; rr(-13, -33 - bob, 26, 9, 4); ctx.fill();
  ctx.fillStyle = '#fff';
  if (G.t0 % 3 < 0.12) ctx.fillRect(2, -19 - bob, 7, 2); else { ctx.fillRect(2, -22 - bob, 7, 7); ctx.fillStyle = '#111'; ctx.fillRect(5, -20 - bob, 3, 4); }
  ctx.restore();
}
function render() {
  ctx.setTransform(dpr * scale, 0, 0, dpr * scale, 0, 0);
  if (G.shake > 0) ctx.translate((Math.random() - 0.5) * G.shake * 24, (Math.random() - 0.5) * G.shake * 24);
  skyFill();
  ctx.fillStyle = '#fff3c4'; ctx.beginPath(); ctx.arc(W * 0.78, gy - 130, 44, 0, 7); ctx.fill();
  ctx.fillStyle = 'rgba(255,250,240,.8)';
  for (const c of clouds) { const x = ((c.x - G.scroll * c.k) % (W + 200) + (W + 200)) % (W + 200) - 100; rr(x, c.y, 70 * c.s, 20 * c.s, 10 * c.s); ctx.fill(); rr(x + 14 * c.s, c.y - 10 * c.s, 36 * c.s, 20 * c.s, 10 * c.s); ctx.fill(); }
  hills(0.15, '#5b3a8c', gy - 40, 80); hills(0.4, '#3a2a6b', gy - 5, 50);
  for (const s of G.ground) {
    ctx.fillStyle = '#8a4f2b'; ctx.fillRect(s.x, gy, s.w, H - gy + 2);
    ctx.fillStyle = 'rgba(0,0,0,.2)'; for (let i = Math.max(32, Math.ceil(-s.x / 32) * 32); i < s.w && s.x + i < W; i += 32) ctx.fillRect(s.x + i, gy + 8, 2, H - gy);
    ctx.fillStyle = '#3ddc97'; ctx.fillRect(s.x, gy, s.w, 8);
  }
  for (const s of G.plats) { ctx.fillStyle = '#c8572e'; rr(s.x, gy + s.y, s.w, s.h, 5); ctx.fill(); ctx.fillStyle = '#3ddc97'; ctx.fillRect(s.x + 2, gy + s.y, s.w - 4, 4); }
  for (const h of G.hz) {
    if (h.dead) continue;
    if (h.t === 's') {
      ctx.fillStyle = '#f5efe0'; ctx.strokeStyle = '#1b1b3a'; ctx.lineWidth = 2;
      for (let i = 0; i < h.w / 16; i++) { ctx.beginPath(); ctx.moveTo(h.x + i * 16, gy); ctx.lineTo(h.x + i * 16 + 8, gy - 18); ctx.lineTo(h.x + i * 16 + 16, gy); ctx.closePath(); ctx.fill(); ctx.stroke(); }
    } else {
      const b = Math.abs(Math.sin(G.t0 + h.x / 20)) * 2;
      ctx.fillStyle = '#5a1f4a'; rr(h.x, gy + h.y - b, h.w, h.h, 8); ctx.fill();
      ctx.fillStyle = '#fff'; ctx.fillRect(h.x + 4, gy + h.y + 4 - b, 6, 6); ctx.fillRect(h.x + 14, gy + h.y + 4 - b, 6, 6);
      ctx.fillStyle = '#111'; ctx.fillRect(h.x + 4, gy + h.y + 6 - b, 3, 3); ctx.fillRect(h.x + 14, gy + h.y + 6 - b, 3, 3);
    }
  }
  for (let i = 0; i < G.coinList.length; i++) {
    const c = G.coinList[i], w = Math.max(2, 8 * Math.abs(Math.cos(G.t0 * 5 + i)));
    ctx.fillStyle = '#f5b700'; ctx.strokeStyle = '#8a5a00'; ctx.lineWidth = 2; ctx.beginPath(); ctx.ellipse(c.x, gy + c.y, w, 9, 0, 0, 7); ctx.fill(); ctx.stroke();
  }
  if (G.speed > 330 && G.state === 'play') { ctx.fillStyle = 'rgba(255,255,255,.22)'; for (let i = 0; i < 8; i++) ctx.fillRect(W - ((G.scroll * 1.6 + i * 131) % (W + 80)), 40 + ((i * 67) % (gy - 60)), 30 + (G.speed - 330) / 6, 2); }
  if (P.alive) drawPlayer();
  for (const p of parts) { if (!p.on) continue; ctx.globalAlpha = Math.max(0, p.life / p.max); ctx.fillStyle = p.c; ctx.fillRect(p.x - p.r, p.y - p.r, p.r * 2, p.r * 2); }
  ctx.globalAlpha = 1;
  ctx.font = '900 16px system-ui,sans-serif'; ctx.textAlign = 'center';
  for (const p of pops) { if (!p.on) continue; ctx.globalAlpha = Math.min(1, p.t * 2); ctx.fillStyle = '#1b1b3a'; ctx.fillText(p.s, p.x + 1, p.y + 1); ctx.fillStyle = p.c; ctx.fillText(p.s, p.x, p.y); }
  ctx.globalAlpha = 1;
}

/* ---------- UI ---------- */
const screens = ['menu', 'pause', 'over', 'history'];
function showScreen(name) {
  screens.forEach(id => { $(id).hidden = id !== name; });
  const playing = name === null || name === 'pause' || name === 'over';
  $('hud').hidden = !playing; $('controls').hidden = !(name === null || name === 'pause');
}
function bump(el) { el.classList.remove('bump'); void el.offsetWidth; el.classList.add('bump'); }
let hs = { s: -1, b: -1, c: -1 };
function hudSync() {
  if (hs.s !== G.score) { hs.s = G.score; $('score').textContent = G.score; }
  const b = Math.max(Store.best(), G.score);
  if (hs.b !== b) { hs.b = b; $('best').textContent = b; }
  if (hs.c !== G.coins) { hs.c = G.coins; $('coins').textContent = G.coins; if (G.coins) bump($('coins').parentElement); }
}
let cdShown = -1;
function startGame() {
  try { ac = ac || new AudioContext(); ac.resume(); } catch (e) { /* ignore */ }
  resetWorld(); G.state = 'count'; G.cd = 3; cdShown = -1; showScreen(null); hs = { s: -1, b: -1, c: -1 };
}
function pauseGame() { if (G.state === 'play') { G.state = 'pause'; releaseAll(); showScreen('pause'); } }
function resumeGame() { if (G.state === 'pause') { G.state = 'play'; showScreen(null); } }
function togglePause() { G.state === 'play' ? pauseGame() : resumeGame(); }
function toMenu() { G.state = 'menu'; resetWorld(); showScreen('menu'); }
function showOver() {
  G.state = 'over'; releaseAll();
  $('oScore').textContent = G.score; $('oBest').textContent = Store.best(); $('newBest').hidden = !G.newBest;
  showScreen('over');
}
function showHistory() {
  historyFrom = G.state === 'over' ? 'over' : 'menu';
  const ul = $('histList'); ul.textContent = '';
  const h = Store.history();
  if (!h.length) { const li = document.createElement('li'); li.className = 'empty'; li.textContent = 'No runs yet. Hit Play!'; ul.appendChild(li); }
  h.forEach(r => {
    const li = document.createElement('li'), d = document.createElement('span'), s = document.createElement('b');
    let t = r.date; try { t = new Date(r.date).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }); } catch (e) { /* keep raw */ }
    d.textContent = t; s.textContent = r.score; li.append(d, s); ul.appendChild(li);
  });
  showScreen('history');
}
const ACTIONS = { mute: toggleMute, play: startGame, restart: startGame, pause: pauseGame, resume: resumeGame, menu: toMenu, history: showHistory,
  back: () => { showScreen(historyFrom === 'over' ? 'over' : 'menu'); } };
document.addEventListener('click', e => { const a = e.target.closest('[data-act]'); if (a && ACTIONS[a.dataset.act]) ACTIONS[a.dataset.act](); });
document.addEventListener('visibilitychange', () => { if (document.hidden) pauseGame(); });

/* ---------- Game loop ---------- */
G.t0 = 0;
let last = 0;
function frame(ts) {
  requestAnimationFrame(frame);
  const dt = Math.min(0.033, (ts - last) / 1000 || 0); last = ts;
  G.t0 += dt; if (G.shake > 0) G.shake = Math.max(0, G.shake - dt); updatePops(dt);
  if (G.state === 'count') {
    G.scroll += 120 * dt; P.anim += dt * 8; G.cd -= dt;
    const n = G.cd > 0 ? Math.ceil(G.cd) : 0;
    if (n !== cdShown) { cdShown = n; const c = $('count'); c.hidden = false; c.textContent = n || 'GO!'; c.classList.remove('tick'); void c.offsetWidth; c.classList.add('tick'); snd(n ? 440 : 880, 0.15, 'square'); }
    if (G.cd <= -0.45) { $('count').hidden = true; G.state = 'play'; }
  } else if (G.state === 'play') update(dt);
  else if (G.state === 'dying') { updateParts(dt); G.dieT -= dt; if (G.dieT <= 0) showOver(); }
  else if (G.state === 'menu') { G.scroll += 70 * dt; P.anim += dt * 8; }
  if (G.state === 'play') updateParts(dt);
  render(); hudSync();
}

/* ---------- Boot ---------- */
addEventListener('resize', resize);
addEventListener('orientationchange', () => setTimeout(resize, 150));
resize(); resetWorld(); showScreen('menu');
requestAnimationFrame(frame);