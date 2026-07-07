"use strict";

/* ============================================================
   CAMO CHAMELEON — 배경색을 몸에 칠해 술래 스캔을 통과하는 위장 게임.
   바닐라 JS + Canvas 2D. 백엔드 0. 위장 판정 = 픽셀 색차 알고리즘.
   ============================================================ */

/* ---------- Tunable constants (no magic numbers scattered in logic) ---------- */
const UINT32 = 0x100000000;        // 2^32 — seed/RNG normalization range
const ROUND_SECONDS = 25;          // 그리는 제한시간
const SAMPLE_STEP = 2;             // 위장점수 계산 시 픽셀 샘플 간격(성능)
const ALPHA_MIN = 8;               // 이 alpha 미만 = 몸 바깥(칠 안 된 영역)
const CAMO_SPAN = 95;              // 평균 색차가 이 값이면 위장률 0% (판정 곡선 기울기)
const SURVIVE_SCORE = 68;          // 이 위장률 이상이면 "숨었다"
const SWATCH_COUNT = 5;            // 자동 추출 팔레트 색 개수
const SCAN_MS = 950;               // 술래 스캔 애니메이션 길이

/* ---------- Sound (procedural WebAudio, no assets) ---------- */
const SFX = (() => {
  let ctx = null;
  let muted = localStorage.getItem("camo_muted") === "1";
  const ac = () => {
    if (!ctx) ctx = new (window.AudioContext || window.webkitAudioContext)();
    if (ctx.state === "suspended") ctx.resume();
    return ctx;
  };
  function blip(freq, dur, type, vol, slide) {
    if (muted || document.hidden) return;
    try {
      const c = ac();
      const o = c.createOscillator();
      const g = c.createGain();
      o.type = type;
      o.frequency.setValueAtTime(freq, c.currentTime);
      o.frequency.exponentialRampToValueAtTime(Math.max(30, freq * slide), c.currentTime + dur);
      g.gain.setValueAtTime(vol, c.currentTime);
      g.gain.exponentialRampToValueAtTime(0.001, c.currentTime + dur);
      o.connect(g).connect(c.destination);
      o.start();
      o.stop(c.currentTime + dur);
    } catch { /* audio unavailable: stay silent */ }
  }
  return {
    unlock() { if (!muted) try { ac(); } catch {} },
    dab() { blip(220 + Math.random() * 60, 0.05, "sine", 0.05, 1.2); },
    pick() { blip(660, 0.07, "triangle", 0.1, 1.4); },
    scan() { blip(120, 0.5, "sawtooth", 0.09, 1.8); },
    win() { [523, 659, 784, 1046].forEach((f, i) => setTimeout(() => blip(f, 0.15, "triangle", 0.14, 1), i * 90)); },
    lose() { [330, 247, 175].forEach((f, i) => setTimeout(() => blip(f, 0.18, "square", 0.13, 0.7), i * 110)); },
    toggle() { muted = !muted; localStorage.setItem("camo_muted", muted ? "1" : "0"); return muted; },
    get muted() { return muted; },
  };
})();
document.addEventListener("pointerdown", () => SFX.unlock(), { once: true });

/* ---------- Seeded RNG (mulberry32) — same seed, same scene ---------- */
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / UINT32;
  };
}

/* ---------- Config (validated from URL) ---------- */
function readSeed() {
  const raw = new URLSearchParams(location.search).get("seed");
  const n = parseInt(raw, 10);
  // 사용자 입력(seed)은 정수 파싱 + uint32 범위로만 사용 (문자열 그대로 쓰지 않음)
  return Number.isFinite(n) ? (n >>> 0) : ((Math.random() * UINT32) >>> 0);
}

/* ---------- DOM ---------- */
const el = (id) => document.getElementById(id);
const canvas = el("game");
const ctx = canvas.getContext("2d");
const W = canvas.width, H = canvas.height;

function makeLayer() {
  const c = document.createElement("canvas");
  c.width = W; c.height = H;
  return c;
}
const bg = makeLayer();
const bgc = bg.getContext("2d", { willReadFrequently: true });
const paint = makeLayer();
const pc = paint.getContext("2d", { willReadFrequently: true });

/* ---------- Scene palette (biomes) ---------- */
const BIOMES = [
  { name: "정글", zones: ["#2f6d3b", "#3f8a49", "#6ab04c", "#274d22"] },
  { name: "사막", zones: ["#e2c290", "#d9a441", "#c68a3a", "#8a5a1f"] },
  { name: "벽돌", zones: ["#8a3a2f", "#a84b39", "#6d2f28", "#c25a44"] },
  { name: "바다", zones: ["#123a5e", "#1c5a86", "#2e86ab", "#0d2c47"] },
  { name: "단풍", zones: ["#7a3b1f", "#b5651d", "#d98d3a", "#5c3317"] },
  { name: "밤하늘", zones: ["#1b1f3a", "#2b2f55", "#3a3f70", "#12142a"] },
];

/* ---------- Color helpers ---------- */
const hex2 = (n) => n.toString(16).padStart(2, "0");
const rgbHex = (r, g, b) => "#" + hex2(r) + hex2(g) + hex2(b);

/* ---------- Game state ---------- */
const state = {
  seed: 0,
  rng: null,
  running: false,
  scanned: false,
  timeLeft: ROUND_SECONDS,
  timer: null,
  eyedropper: false,
  color: "#ffffff",
  brush: 18,
  painting: false,
  lastX: 0, lastY: 0,
  chameleon: null,
  biomeName: "",
};

/* ---------- Scene generation (seeded) ---------- */
function drawScene(rng) {
  const biome = BIOMES[Math.floor(rng() * BIOMES.length)];
  state.biomeName = biome.name;
  const zones = biome.zones;

  // 3개의 수평 밴드 — 경계는 지터를 줘서 자연스럽게
  const bands = 3;
  const bandH = H / bands;
  for (let i = 0; i < bands; i++) {
    const top = i * bandH;
    const grad = bgc.createLinearGradient(0, top, 0, top + bandH);
    const c1 = zones[i % zones.length];
    const c2 = zones[(i + 1) % zones.length];
    grad.addColorStop(0, c1);
    grad.addColorStop(1, c2);
    bgc.fillStyle = grad;
    bgc.fillRect(0, top - 1, W, bandH + 2);
  }

  // 부드러운 반점(잎/얼룩) — 텍스처용. 개수는 적게 유지해 색매칭이 여전히 공정하게.
  const patches = 34;
  for (let i = 0; i < patches; i++) {
    const x = rng() * W, y = rng() * H;
    const r = 10 + rng() * 34;
    const zc = zones[Math.floor(rng() * zones.length)];
    bgc.save();
    bgc.globalAlpha = 0.22 + rng() * 0.22;
    bgc.fillStyle = zc;
    bgc.beginPath();
    bgc.ellipse(x, y, r, r * (0.6 + rng() * 0.5), rng() * Math.PI, 0, Math.PI * 2);
    bgc.fill();
    bgc.restore();
  }
}

/* ---------- Chameleon silhouette (a Path2D placed in canvas coords) ---------- */
function buildChameleon(cx, cy, s) {
  const path = new Path2D();
  // body
  path.ellipse(cx, cy, s * 0.92, s * 0.6, 0, 0, Math.PI * 2);
  // head (front / right)
  path.ellipse(cx + s * 0.95, cy - s * 0.22, s * 0.42, s * 0.36, 0, 0, Math.PI * 2);
  // snout
  path.ellipse(cx + s * 1.28, cy - s * 0.16, s * 0.2, s * 0.16, 0, 0, Math.PI * 2);
  // legs (4 stubs)
  for (const [lx, ly] of [[-0.45, 0.55], [0.35, 0.6], [-0.2, 0.66], [0.6, 0.5]]) {
    path.ellipse(cx + s * lx, cy + s * ly, s * 0.14, s * 0.26, 0, 0, Math.PI * 2);
  }
  // curled tail (left) — tapering ellipses along an inward spiral
  let ang = Math.PI * 0.9, rad = s * 0.7, tx = cx - s * 0.9, ty = cy + s * 0.05;
  for (let i = 0; i < 8; i++) {
    path.ellipse(tx, ty, rad * 0.2, rad * 0.2, 0, 0, Math.PI * 2);
    ang += 0.8;
    rad *= 0.85;
    tx += Math.cos(ang) * rad * 0.7;
    ty += Math.sin(ang) * rad * 0.7;
  }
  // eye reference point (for the guidance dot while playing)
  const eye = { x: cx + s * 1.02, y: cy - s * 0.3, r: Math.max(3, s * 0.09) };
  return { path, eye, cx, cy, s };
}

/* ---------- Palette swatches from the scene ---------- */
function buildSwatches() {
  const box = el("swatches");
  box.textContent = "";
  const seen = new Set();
  const colors = [];
  // 세로 중앙선을 따라 균등 샘플 → 각 존의 대표색
  for (let i = 0; i < SWATCH_COUNT * 2 && colors.length < SWATCH_COUNT; i++) {
    const y = Math.floor((i + 0.5) / (SWATCH_COUNT * 2) * H);
    const d = bgc.getImageData(W >> 1, y, 1, 1).data;
    const hexv = rgbHex(d[0], d[1], d[2]);
    if (seen.has(hexv)) continue;
    seen.add(hexv);
    colors.push(hexv);
  }
  colors.forEach((hexv) => {
    const b = document.createElement("button");
    b.className = "swatch";
    b.style.background = hexv;
    b.title = hexv;
    b.addEventListener("click", () => setColor(hexv));
    box.appendChild(b);
  });
}

function setColor(hexv) {
  state.color = hexv;
  el("curColor").style.background = hexv;
  setEyedropper(false);
  for (const s of el("swatches").children) s.classList.toggle("on", s.style.background === hexColorToRgb(hexv));
}
// 브라우저는 style.background 를 rgb() 로 반환하므로 비교용 변환
function hexColorToRgb(hexv) {
  const n = parseInt(hexv.slice(1), 16);
  return `rgb(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255})`;
}

/* ---------- Pointer → canvas coords ---------- */
function toCanvas(e) {
  const r = canvas.getBoundingClientRect();
  return {
    x: (e.clientX - r.left) * (W / r.width),
    y: (e.clientY - r.top) * (H / r.height),
  };
}

/* ---------- Painting (clipped to the silhouette) ---------- */
function strokeTo(x, y) {
  pc.save();
  pc.clip(state.chameleon.path);
  pc.strokeStyle = state.color;
  pc.lineWidth = state.brush;
  pc.lineCap = "round";
  pc.lineJoin = "round";
  pc.beginPath();
  pc.moveTo(state.lastX, state.lastY);
  pc.lineTo(x, y);
  pc.stroke();
  pc.restore();
  state.lastX = x; state.lastY = y;
}

function pickColorAt(x, y) {
  const cx = Math.max(0, Math.min(W - 1, Math.floor(x)));
  const cy = Math.max(0, Math.min(H - 1, Math.floor(y)));
  const d = bgc.getImageData(cx, cy, 1, 1).data;
  setColor(rgbHex(d[0], d[1], d[2]));
  SFX.pick();
}

function setEyedropper(on) {
  state.eyedropper = on;
  el("eyedrop").classList.toggle("on", on);
  canvas.style.cursor = on ? "cell" : "crosshair";
}

/* ---------- Render ---------- */
function render() {
  ctx.clearRect(0, 0, W, H);
  ctx.drawImage(bg, 0, 0);
  ctx.drawImage(paint, 0, 0);
  if (!state.scanned) {
    // 그리는 동안엔 실루엣 윤곽 + 눈 점을 보여줘 어디를 칠할지 알려준다
    ctx.save();
    ctx.lineWidth = 2;
    ctx.setLineDash([6, 4]);
    ctx.strokeStyle = "rgba(255,255,255,0.55)";
    ctx.stroke(state.chameleon.path);
    ctx.restore();
    const eye = state.chameleon.eye;
    ctx.fillStyle = "#0b0b0b";
    ctx.beginPath();
    ctx.arc(eye.x, eye.y, eye.r, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = "#fff";
    ctx.beginPath();
    ctx.arc(eye.x + eye.r * 0.3, eye.y - eye.r * 0.3, eye.r * 0.35, 0, Math.PI * 2);
    ctx.fill();
  }
}

/* ---------- Camouflage scoring (the "seeker") ---------- */
function computeCamo() {
  const bd = bgc.getImageData(0, 0, W, H).data;
  const pd = pc.getImageData(0, 0, W, H).data;
  let sum = 0, n = 0, worst = -1, wx = W / 2, wy = H / 2;
  for (let y = 0; y < H; y += SAMPLE_STEP) {
    for (let x = 0; x < W; x += SAMPLE_STEP) {
      const i = (y * W + x) * 4;
      if (pd[i + 3] < ALPHA_MIN) continue; // 몸 바깥
      const dr = pd[i] - bd[i];
      const dg = pd[i + 1] - bd[i + 1];
      const db = pd[i + 2] - bd[i + 2];
      const dist = Math.sqrt(dr * dr + dg * dg + db * db);
      sum += dist; n += 1;
      if (dist > worst) { worst = dist; wx = x; wy = y; }
    }
  }
  if (n === 0) return { score: 0, wx, wy };
  const avg = sum / n;
  const score = Math.max(0, Math.min(100, Math.round(100 * (1 - avg / CAMO_SPAN))));
  return { score, wx, wy };
}

function gradeFor(score) {
  if (score >= 92) return "완벽한 위장 — 술래가 눈앞을 지나쳤다";
  if (score >= 80) return "훌륭 — 거의 배경";
  if (score >= SURVIVE_SCORE) return "통과 — 아슬아슬하게 숨었다";
  if (score >= 45) return "들킴 — 색이 조금 튀었다";
  return "즉시 발각 — 하얀 몸이 그대로 보인다";
}

/* ---------- Scan sequence ---------- */
function runScan() {
  if (!state.running) return;
  state.running = false;
  clearInterval(state.timer);
  SFX.scan();

  const result = computeCamo();
  state.scanned = true;

  // 술래 스캔 라인 스윕 애니메이션 → 결과
  const start = performance.now();
  (function sweep(now) {
    const t = Math.min(1, (now - start) / SCAN_MS);
    render();
    const y = t * H;
    ctx.save();
    ctx.fillStyle = "rgba(88,166,255,0.12)";
    ctx.fillRect(0, 0, W, y);
    ctx.strokeStyle = "rgba(88,166,255,0.9)";
    ctx.lineWidth = 3;
    ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke();
    ctx.restore();
    if (t < 1) { requestAnimationFrame(sweep); return; }
    finishScan(result);
  })(start);
}

function finishScan(result) {
  render();
  const survived = result.score >= SURVIVE_SCORE;
  if (!survived) {
    // 술래가 가장 튀는 부위를 지목
    ctx.save();
    ctx.strokeStyle = "#f85149";
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.arc(result.wx, result.wy, 26, 0, Math.PI * 2);
    ctx.stroke();
    ctx.fillStyle = "#f85149";
    ctx.font = "700 20px system-ui";
    ctx.textAlign = "center";
    ctx.fillText("👁️", result.wx, result.wy - 30);
    ctx.restore();
  }
  if (survived) SFX.win(); else SFX.lose();

  const verdict = el("resVerdict");
  verdict.textContent = survived ? "숨었다! 🫥" : "들켰다! 👁️";
  verdict.className = "verdict " + (survived ? "win" : "lose");
  el("resScore").textContent = result.score + "%";
  el("resGrade").textContent = gradeFor(result.score) + `  ·  ${state.biomeName} · seed ${state.seed}`;
  const ring = document.querySelector("#result .ring");
  ring.style.setProperty("--pct", result.score);
  ring.style.setProperty("--ringColor", survived ? "#3fb950" : "#f85149");
  el("result").classList.remove("hidden");
}

/* ---------- Timer ---------- */
function tickTimer() {
  state.timeLeft -= 1;
  el("timerFill").style.width = Math.max(0, state.timeLeft / ROUND_SECONDS * 100) + "%";
  el("timerFill").style.background = state.timeLeft <= 5 ? "#f85149" : "#3fb950";
  if (state.timeLeft <= 0) runScan();
}

/* ---------- Round lifecycle ---------- */
function startRound(seed) {
  state.seed = seed >>> 0;
  state.rng = mulberry32(state.seed);
  state.scanned = false;
  state.running = true;
  state.timeLeft = ROUND_SECONDS;

  bgc.clearRect(0, 0, W, H);
  drawScene(state.rng);

  const s = Math.min(W, H) * 0.2;
  state.chameleon = buildChameleon(W * 0.44, H * 0.5, s);
  pc.clearRect(0, 0, W, H);
  pc.fillStyle = "#ffffff"; // 카멜레온은 순백 몸에서 시작
  pc.fill(state.chameleon.path);

  buildSwatches();
  setColor("#ffffff");
  setEyedropper(false);

  el("timerFill").style.width = "100%";
  el("timerFill").style.background = "#3fb950";
  clearInterval(state.timer);
  state.timer = setInterval(tickTimer, 1000);

  el("result").classList.add("hidden");
  el("intro").classList.add("hidden");
  render();
  syncUrl();
}

function syncUrl() {
  history.replaceState(null, "", location.pathname + "?seed=" + state.seed);
}

/* ---------- Share ---------- */
async function share() {
  syncUrl();
  const text = `CAMO CHAMELEON — ${state.biomeName} seed ${state.seed} 도전! ${location.href}`;
  try {
    await navigator.clipboard.writeText(text);
    toast("링크 복사됨! 친구에게 붙여넣어 같은 장면 대결 🔗");
  } catch {
    toast("복사 실패 — 주소창의 링크를 직접 공유하세요");
  }
}

let toastTimer = null;
function toast(msg) {
  const t = el("toast");
  t.textContent = msg;
  t.classList.remove("hidden");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.add("hidden"), 2200);
}

/* ---------- Input wiring ---------- */
canvas.addEventListener("pointerdown", (e) => {
  if (!state.running) return;
  const { x, y } = toCanvas(e);
  if (state.eyedropper) { pickColorAt(x, y); return; }
  state.painting = true;
  state.lastX = x; state.lastY = y;
  strokeTo(x + 0.01, y); // 점 하나도 찍히게
  render();
  canvas.setPointerCapture(e.pointerId);
});
canvas.addEventListener("pointermove", (e) => {
  if (!state.painting) return;
  const { x, y } = toCanvas(e);
  strokeTo(x, y);
  SFX.dab();
  render();
});
function endPaint() { state.painting = false; }
canvas.addEventListener("pointerup", endPaint);
canvas.addEventListener("pointercancel", endPaint);

el("eyedrop").addEventListener("click", () => setEyedropper(!state.eyedropper));
el("brush").addEventListener("input", () => {
  state.brush = parseInt(el("brush").value, 10) || 18;
  el("brushVal").textContent = state.brush;
});
el("btnHide").addEventListener("click", runScan);
el("btnStart").addEventListener("click", () => startRound(state.seed));
el("btnReplay").addEventListener("click", () => startRound(state.seed));
el("btnNext").addEventListener("click", () => startRound((Math.random() * UINT32) >>> 0));
el("btnShare").addEventListener("click", share);

const muteBtn = el("btnMute");
muteBtn.textContent = SFX.muted ? "🔇" : "🔊";
muteBtn.addEventListener("click", () => { muteBtn.textContent = SFX.toggle() ? "🔇" : "🔊"; });

/* ---------- Boot ---------- */
state.seed = readSeed();
// 인트로 뒤에 장면을 미리 깔아 살아있게 보이도록(러닝은 시작 버튼에서)
state.rng = mulberry32(state.seed);
drawScene(state.rng);
state.chameleon = buildChameleon(W * 0.44, H * 0.5, Math.min(W, H) * 0.2);
pc.fillStyle = "#ffffff";
pc.fill(state.chameleon.path);
render();
