/**
 * Credit Cycle Web Dashboard v3
 * ==============================
 * Uses the z-score expansion pressure model from fetch_data.py.
 * When user adjusts weights:
 *   → Re-computes composite pressure per quarter using stored indicator_pressures
 *   → Maps to raw score via tanh
 *   → Applies zero-phase EWMA smoothing (forward + backward)
 *   → Re-renders slope marker and history chart
 */

let cycleData = null;
let currentWeights = {
  defaults:       0.22,
  profit_margins: 0.17,
  capex:          0.17,
  cash:           0.14,
  buybacks:       0.15,
  mna:            0.15,
};

const K_SCALE = 1.05;   // must match backend
const EWMA_A  = 0.45;   // must match backend

let selectedIndex = 0;
let historyChart  = null;

// ── Invesco phase definitions ─────────────────────────────────────────────
const PHASES = [
  { name: 'Early cycle', min: 0.0, max: 1.0,
    color: '#0284c7', lightColor: 'rgba(2, 132, 199, 0.13)',
    text: 'Plateauing defaults at elevated levels, recovering margins, capex bottoming and turning up, liquidity build-up' },
  { name: 'Mid-cycle', min: 1.0, max: 2.0,
    color: '#0d9488', lightColor: 'rgba(13, 148, 136, 0.13)',
    text: 'Defaults trending lower, profit margins expanding, capex stabilising, M&A and buybacks growing' },
  { name: 'Late cycle', min: 2.0, max: 3.0,
    color: '#16a34a', lightColor: 'rgba(22, 163, 74, 0.13)',
    text: 'Defaults at historical bottom, margins plateauing, capex accelerating, mega-deals & peak buybacks, cash declining' },
  { name: 'Recession', min: 3.0, max: 4.0,
    color: '#9333ea', lightColor: 'rgba(147, 51, 234, 0.13)',
    text: 'Defaults rising sharply, margins contracting, capex slashed, buybacks frozen, forced liquidity rebuild' },
];

// ── Math helpers ───────────────────────────────────────────────────────────
function tanhJS(x) {
  if (x > 20) return 1; if (x < -20) return -1;
  const e = Math.exp(2 * x);
  return (e - 1) / (e + 1);
}

function fbEWMA(arr, alpha) {
  const n = arr.length;
  const fwd = new Array(n);
  fwd[0] = arr[0];
  for (let i = 1; i < n; i++) fwd[i] = alpha * arr[i] + (1 - alpha) * fwd[i - 1];
  const bwd = new Array(n);
  bwd[n - 1] = fwd[n - 1];
  for (let i = n - 2; i >= 0; i--) bwd[i] = alpha * fwd[i] + (1 - alpha) * bwd[i + 1];
  return bwd;
}

function computeSmoothedScores(timeline, weights) {
  const totalW = Object.values(weights).reduce((a, b) => a + b, 0);
  const rawScores = timeline.map(rec => {
    const ip = rec.indicator_pressures || {};
    let p = 0;
    for (const k in weights) p += (weights[k] / totalW) * (ip[k] ?? 0);
    return Math.max(0, Math.min(4, 2.0 + 2.0 * tanhJS(K_SCALE * p)));
  });
  return fbEWMA(rawScores, EWMA_A).map(s => Math.max(0, Math.min(4, s)));
}

function getPhaseFromScore(s) {
  if (s < 1.0) return PHASES[0];
  if (s < 2.0) return PHASES[1];
  if (s < 3.0) return PHASES[2];
  return PHASES[3];
}

// ── Invesco hump curve ─────────────────────────────────────────────────────
// x ∈ [0, 1] → normalised height ∈ [0, 1]
// Tuned to match original Invesco diagram:
//   x=0.0  (Early entry)   → low (≈0.18)
//   x=0.13 (Early peak)    → rising (≈0.55)
//   x=0.38 (Mid crest)     → max (≈1.00)
//   x=0.62 (Late cycle)    → descending (≈0.70)
//   x=0.80 (Late exit)     → steeper descent (≈0.35)
//   x=1.0  (Recession end) → trough (≈0.08)
function getCycleY(x) {
  // Piece-wise asymmetric sinusoid matching Invesco shape
  // Use a skewed sine: shifts peak toward x≈0.38 (Mid-cycle crest) and
  // makes the recession descent steeper than the early-cycle rise.
  const phase = x * 2 * Math.PI * 0.78 - 0.48;   // tuned offset + compression
  return Math.max(0.04, 0.5 + 0.46 * Math.sin(phase));
}

function getCycleSlope(x) {
  const dx = 0.004;
  return (getCycleY(Math.min(1, x + dx)) - getCycleY(Math.max(0, x - dx))) / (2 * dx);
}

// ── Initialisation ─────────────────────────────────────────────────────────
async function init() {
  try {
    const res = await fetch('credit_cycle_data.json');
    cycleData = await res.json();
    // Load intelligent weights from JSON
    const wp = cycleData.metadata?.weights_presets?.intelligent;
    if (wp) {
      // Only keep keys in currentWeights
      for (const k in currentWeights) {
        if (wp[k] !== undefined) currentWeights[k] = wp[k];
      }
    }
    selectedIndex = cycleData.timeline.length - 1;

    setupWeightControls();
    updateDashboard();
    setupTimelineSlider();
    initHistoryChart();
    renderIndicatorCards();

    // Click on the cycle curve canvas → jump to nearest historical quarter
    const canvas = document.getElementById('cycleCanvas');
    if (canvas) {
      canvas.style.cursor = 'crosshair';
      canvas.addEventListener('click', (e) => {
        const rect = canvas.getBoundingClientRect();
        const padL = 44, padR = 44;
        const plotW = rect.width - padL - padR;
        const xRatio = Math.max(0.01, Math.min(0.99, (e.clientX - rect.left - padL) / plotW));
        const targetS = xRatio * 4.0;
        const scores = computeSmoothedScores(cycleData.timeline, currentWeights);
        let best = 0, bestD = 999;
        scores.forEach((s, i) => { const d = Math.abs(s - targetS); if (d < bestD) { bestD = d; best = i; } });
        selectedIndex = best;
        updateDashboard();
      });
    }

    window.addEventListener('resize', () => updateDashboard());
  } catch (err) {
    console.error('Error loading data:', err);
    const el = document.getElementById('app-loading');
    if (el) el.innerHTML = `<div class="p-6 text-red-400 text-center">
      <p class="font-bold">Failed to load credit_cycle_data.json</p>
      <p class="text-sm mt-2">${err.message}</p></div>`;
  }
}

// ── Dashboard update ────────────────────────────────────────────────────────
let _cachedScores = null;
let _cachedWeightsSig = '';

function getCachedScores() {
  const sig = JSON.stringify(currentWeights);
  if (sig !== _cachedWeightsSig) {
    _cachedScores = computeSmoothedScores(cycleData.timeline, currentWeights);
    _cachedWeightsSig = sig;
  }
  return _cachedScores;
}

function updateDashboard() {
  if (!cycleData) return;
  const scores = getCachedScores();
  const S = scores[selectedIndex];
  const rec = cycleData.timeline[selectedIndex];
  const phase = getPhaseFromScore(S);
  const normX = Math.max(0.02, Math.min(0.98, S / 4.0));
  const slope = getCycleSlope(normX);

  // Header badges
  document.getElementById('current-quarter-badge').innerText = rec.quarter_label;
  const phaseBadge = document.getElementById('current-phase-badge');
  phaseBadge.innerText = phase.name.toUpperCase();
  phaseBadge.style.backgroundColor = phase.color;
  document.getElementById('composite-score-badge').innerText = `${S.toFixed(2)} / 4.0`;

  // Slope text
  let slopeText, slopeClass;
  if (slope > 0.35)      { slopeText = 'Ascending — Expansion Strengthening'; slopeClass = 'text-sky-400'; }
  else if (slope > 0.05) { slopeText = 'Maturing — Approaching Peak';          slopeClass = 'text-teal-400'; }
  else if (slope > -0.30){ slopeText = 'Peak Plateau — Rollover Forming';       slopeClass = 'text-emerald-400'; }
  else                   { slopeText = 'Descending — Credit Contraction';       slopeClass = 'text-purple-400'; }
  document.getElementById('current-slope-text').innerHTML =
    `<span class="${slopeClass} font-bold">${slopeText}</span> <span class="text-slate-400">(dY/dx = ${slope.toFixed(2)})</span>`;
  document.getElementById('phase-description-text').innerText = phase.text;

  drawCycleSlope(normX, S, phase, scores);
  updateInvescoTable(rec, S);

  const slider = document.getElementById('history-slider');
  if (slider) {
    slider.value = selectedIndex;
    document.getElementById('slider-label').innerText =
      `${rec.quarter_label} (${selectedIndex + 1}/${cycleData.timeline.length})`;
  }
  updateHistoryChart(scores);
}

// ── Main Cycle Slope Canvas ────────────────────────────────────────────────
function drawCycleSlope(normX, score, phase, scores) {
  const canvas = document.getElementById('cycleCanvas');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  const dpr = window.devicePixelRatio || 1;
  const rect = canvas.getBoundingClientRect();
  canvas.width  = rect.width  * dpr;
  canvas.height = rect.height * dpr;
  ctx.scale(dpr, dpr);

  const W = rect.width, H = rect.height;
  const padL = 44, padR = 44, padT = 52, padB = 70;
  const plotW = W - padL - padR, plotH = H - padT - padB;

  ctx.clearRect(0, 0, W, H);

  // ── Phase zone shading (4 equal bands) ──
  PHASES.forEach((p, idx) => {
    const zX = padL + idx * plotW / 4;
    ctx.fillStyle = p.lightColor;
    ctx.fillRect(zX, padT, plotW / 4, plotH);
    // Phase divider
    if (idx > 0) {
      ctx.beginPath(); ctx.setLineDash([4, 5]);
      ctx.strokeStyle = 'rgba(255,255,255,0.12)'; ctx.lineWidth = 1;
      ctx.moveTo(zX, padT); ctx.lineTo(zX, padT + plotH); ctx.stroke();
      ctx.setLineDash([]);
    }
    // Phase zone header label
    ctx.fillStyle = p.color;
    ctx.font = 'bold 11.5px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(p.name.toUpperCase(), zX + plotW / 8, padT - 14);
  });

  // ── Build curve points ──
  const STEPS = 200;
  const pts = [];
  for (let i = 0; i <= STEPS; i++) {
    const xR  = i / STEPS;
    const px  = padL + xR * plotW;
    const pyN = getCycleY(xR);
    const py  = padT + (1 - pyN) * (plotH - 16) + 8;
    pts.push({ x: px, y: py, r: xR });
  }

  // ── Draw curve shadow (glow) ──
  ctx.beginPath();
  ctx.moveTo(pts[0].x, pts[0].y);
  pts.forEach(p => ctx.lineTo(p.x, p.y));
  ctx.strokeStyle = 'rgba(100, 200, 255, 0.12)';
  ctx.lineWidth = 12;
  ctx.lineJoin = 'round';
  ctx.stroke();

  // ── Draw main coloured curve ──
  const grad = ctx.createLinearGradient(padL, 0, padL + plotW, 0);
  grad.addColorStop(0.00, PHASES[0].color);
  grad.addColorStop(0.25, PHASES[1].color);
  grad.addColorStop(0.55, PHASES[2].color);
  grad.addColorStop(0.85, PHASES[3].color);
  grad.addColorStop(1.00, PHASES[3].color);

  ctx.beginPath();
  ctx.moveTo(pts[0].x, pts[0].y);
  pts.forEach(p => ctx.lineTo(p.x, p.y));
  ctx.strokeStyle = grad;
  ctx.lineWidth = 4.5; ctx.lineJoin = 'round';
  ctx.shadowColor = 'rgba(60, 180, 255, 0.35)'; ctx.shadowBlur = 10;
  ctx.stroke();
  ctx.shadowBlur = 0;

  // ── Invesco structural reference lines ──
  // Match exact positions in original Invesco diagram:
  //   Early cycle label  ≈ 18% along x-axis (ascending slope)
  //   Mid-cycle label    ≈ 46% (near crest)
  //   Late cycle label   ≈ 68% (descending slope)
  //   Recession label    ≈ 90% (deep trough region)
  const refLines = [
    { xR: 0.18, label: 'Early cycle', color: PHASES[0].color, tilt: -0.42 },
    { xR: 0.46, label: 'Mid-cycle',   color: PHASES[1].color, tilt:  0.0  },
    { xR: 0.68, label: 'Late cycle',  color: PHASES[2].color, tilt:  0.36 },
  ];
  refLines.forEach(ref => {
    const rx = padL + ref.xR * plotW;
    const ryN = getCycleY(ref.xR);
    const ry  = padT + (1 - ryN) * (plotH - 16) + 8;
    // Drop line from curve to base
    ctx.beginPath();
    ctx.strokeStyle = ref.color + 'cc';
    ctx.lineWidth = 1.5; ctx.setLineDash([]);
    ctx.moveTo(rx, ry); ctx.lineTo(rx, padT + plotH);
    ctx.stroke();
    // Curve dot
    ctx.beginPath(); ctx.arc(rx, ry, 4, 0, Math.PI * 2);
    ctx.fillStyle = ref.color; ctx.fill();
    // Tilted label on the curve
    ctx.save();
    ctx.translate(rx, ry);
    ctx.rotate(ref.tilt);
    ctx.fillStyle = ref.color;
    ctx.font = 'bold 12px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(ref.label, -8, -14);
    ctx.restore();
  });

  // "Recession" label at trough (no line, just text)
  ctx.save();
  ctx.fillStyle = PHASES[3].color;
  ctx.font = 'bold 12px system-ui, sans-serif';
  ctx.textAlign = 'center';
  const recX = padL + 0.9 * plotW;
  const recYN = getCycleY(0.9);
  const recY  = padT + (1 - recYN) * (plotH - 16) + 8;
  ctx.fillText('Recession', recX, recY - 16);
  ctx.restore();

  // Top-right annotation (matching Invesco source)
  ctx.fillStyle = '#64748b';
  ctx.font = 'italic 10px system-ui, sans-serif';
  ctx.textAlign = 'right';
  ctx.fillText('valuations are high, and megadeals become prevalent', padL + plotW - 8, padT - 30);

  // ── Current position pin ──
  const pinX  = padL + normX * plotW;
  const pinYN = getCycleY(normX);
  const pinY  = padT + (1 - pinYN) * (plotH - 16) + 8;

  // Drop line (white dashed)
  ctx.beginPath(); ctx.setLineDash([5, 4]);
  ctx.strokeStyle = '#ffffffbb'; ctx.lineWidth = 2.5;
  ctx.shadowColor = phase.color; ctx.shadowBlur = 8;
  ctx.moveTo(pinX, pinY); ctx.lineTo(pinX, padT + plotH);
  ctx.stroke(); ctx.setLineDash([]); ctx.shadowBlur = 0;

  // Vertical pole
  ctx.beginPath();
  ctx.strokeStyle = '#f8fafc'; ctx.lineWidth = 2.5;
  ctx.moveTo(pinX, pinY); ctx.lineTo(pinX, pinY - 38);
  ctx.stroke();

  // Flag tag "WE ARE HERE"
  const tagW = 114, tagH = 23;
  const tagX = Math.max(padL + 4, Math.min(padL + plotW - tagW - 4, pinX - tagW / 2));
  const tagY = pinY - 62;
  ctx.fillStyle = phase.color;
  ctx.shadowColor = 'rgba(0,0,0,0.8)'; ctx.shadowBlur = 8;
  _roundRect(ctx, tagX, tagY, tagW, tagH, 5); ctx.fill();
  ctx.shadowBlur = 0;
  ctx.fillStyle = '#ffffff';
  ctx.font = '800 10px system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText('▼  WE ARE HERE NOW', tagX + tagW / 2, tagY + 15);

  // Outer glow ring
  ctx.beginPath(); ctx.arc(pinX, pinY, 13, 0, Math.PI * 2);
  ctx.fillStyle = phase.color + '44'; ctx.fill();

  // Inner white dot
  ctx.beginPath(); ctx.arc(pinX, pinY, 7, 0, Math.PI * 2);
  ctx.fillStyle = '#ffffff'; ctx.fill();
  ctx.strokeStyle = phase.color; ctx.lineWidth = 3.5;
  ctx.shadowColor = phase.color; ctx.shadowBlur = 16;
  ctx.stroke(); ctx.shadowBlur = 0;

  // Bottom status box
  const boxW = 195, boxH = 28;
  const boxX = Math.max(padL, Math.min(padL + plotW - boxW, pinX - boxW / 2));
  const boxY = padT + plotH + 8;
  ctx.fillStyle = 'rgba(10, 16, 28, 0.95)';
  ctx.strokeStyle = phase.color; ctx.lineWidth = 2;
  _roundRect(ctx, boxX, boxY, boxW, boxH, 6); ctx.fill(); ctx.stroke();
  ctx.fillStyle = '#f8fafc';
  ctx.font = 'bold 11px system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText(
    `POSITION ${(normX * 100).toFixed(0)}% — ${phase.name.toUpperCase()}  (${score.toFixed(2)}/4)`,
    boxX + boxW / 2, boxY + 18
  );
}

function _roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y); ctx.quadraticCurveTo(x + w, y, x + w, y + r);
  ctx.lineTo(x + w, y + h - r); ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  ctx.lineTo(x + r, y + h); ctx.quadraticCurveTo(x, y + h, x, y + h - r);
  ctx.lineTo(x, y + r); ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.closePath();
}

// ── Invesco Reference Table ─────────────────────────────────────────────────
function updateInvescoTable(rec, score) {
  const tbody = document.getElementById('invesco-table-body');
  if (!tbody || !cycleData?.invesco_matrix) return;
  tbody.innerHTML = '';

  cycleData.invesco_matrix.forEach(row => {
    const id  = row.id;
    const ind = rec[id] || {};
    const activeState = ind.phase || '';
    const val   = ind.value;
    const unit  = ind.unit  || '';
    const chgKey = ind.chg_1y !== undefined ? 'chg_1y' : 'yoy';
    const chg  = ind[chgKey];

    const tr = document.createElement('tr');
    tr.className = 'border-b border-slate-800/80 hover:bg-slate-800/30 transition-colors';

    const matchPhase = (cell) => {
      const cellL = cell.toLowerCase().replace(/[^a-z0-9]/g,'');
      const stateL = activeState.toLowerCase().replace(/[^a-z0-9]/g,'');
      return stateL.includes(cellL.substring(0, 8)) || cellL.includes(stateL.substring(0, 8));
    };

    const phaseColMatch = [row.early, row.mid, row.late, row.recession].map(c => matchPhase(c));
    // Fallback: use score bands if text match fails
    const activePhaseBand = score < 1 ? 0 : score < 2 ? 1 : score < 3 ? 2 : 3;
    const activeIdx = phaseColMatch.some(m => m) ? phaseColMatch.indexOf(true) : activePhaseBand;

    let chgHtml = '';
    if (chg !== undefined && chg !== null) {
      const isPos = chg >= 0;
      const suffix = id === 'defaults' || id === 'cash' ? 'pp' : '%';
      chgHtml = `<span class="text-[10px] ${isPos ? 'text-emerald-400' : 'text-rose-400'} font-semibold ml-1">${isPos ? '+' : ''}${chg}${suffix} 1y</span>`;
    }

    let indHtml = `<td class="py-3 px-4">
      <div class="font-semibold text-slate-100 text-[13px]">${row.name}</div>
      <div class="text-[11px] text-slate-400 font-mono mt-0.5">
        ${val !== undefined ? `<span class="text-slate-200">${val}</span> ${unit}` : ''}
        ${chgHtml}
      </div>
    </td>`;

    const phaseColor = PHASES[activePhaseBand].color;
    const phaseCols  = [row.early, row.mid, row.late, row.recession];
    phaseCols.forEach((cell, ci) => {
      const isActive = ci === activeIdx;
      if (isActive) {
        indHtml += `<td class="py-3 px-4 text-[12px] relative border-l border-slate-800"
          style="background:${PHASES[ci].color}22; border: 1.5px solid ${PHASES[ci].color}77; color:#fff; font-weight:700; box-shadow: inset 0 0 12px ${PHASES[ci].color}44;">
          <div>${cell}</div>
          <div class="text-[9px] font-mono mt-0.5 opacity-80">${val !== undefined ? `${val} ${unit}` : ''}</div>
          <span style="position:absolute;top:3px;right:5px;font-size:8px;background:${PHASES[ci].color};color:#000;font-weight:900;padding:1px 4px;border-radius:3px;">ACTIVE</span>
        </td>`;
      } else {
        indHtml += `<td class="py-3 px-4 text-[12px] text-slate-400 border-l border-slate-800/60">
          <div>${cell}</div>
        </td>`;
      }
    });

    tr.innerHTML = indHtml;
    tbody.appendChild(tr);
  });
}

// ── Weight Sliders ─────────────────────────────────────────────────────────
function setupWeightControls() {
  const container = document.getElementById('weight-sliders');
  if (!container) return;
  container.innerHTML = '';

  const labels = {
    defaults:       { label: 'Defaults & Credit Stress',        desc: 'FRED: DRBLACBS — C&I Loan Delinquency Rate' },
    profit_margins: { label: 'Corporate Profit Margins',         desc: 'FRED: CP / GDP — After-Tax Corporate Profits' },
    capex:          { label: 'CAPEX (Capital Investment)',       desc: 'FRED: PNFI — Private Nonresidential Fixed Investment' },
    cash:           { label: 'Corporate Cash / Liquidity',       desc: 'FRED: BOGZ1FL104001006Q — Liquid Assets / ST Liabilities' },
    buybacks:       { label: 'Share Buybacks & Repurchases',     desc: 'FRED: NCBCEBQ027S — NFC Equity Retirement Transactions' },
    mna:            { label: 'M&A Activity (Deal Volume)',       desc: 'FRED: IEAADIN — US Direct Investment Equity Acquisitions' },
  };

  for (const key in currentWeights) {
    const info = labels[key] || { label: key, desc: '' };
    const valPct = Math.round(currentWeights[key] * 100);
    const div = document.createElement('div');
    div.className = 'bg-slate-900/60 p-3 rounded-xl border border-slate-800/80';
    div.innerHTML = `
      <div class="flex justify-between items-start mb-1.5">
        <div>
          <span class="text-[12px] font-semibold text-slate-200">${info.label}</span>
          <span class="text-[10px] text-slate-500 block mt-0.5">${info.desc}</span>
        </div>
        <span id="wv-${key}" class="text-[11px] font-mono font-bold text-sky-400 bg-sky-950/70 px-2 py-0.5 rounded border border-sky-800/50 whitespace-nowrap">${valPct}%</span>
      </div>
      <input type="range" id="ws-${key}" min="0" max="40" step="1" value="${valPct}" class="w-full">
    `;
    container.appendChild(div);
    div.querySelector(`#ws-${key}`).addEventListener('input', e => {
      currentWeights[key] = parseFloat(e.target.value) / 100;
      document.getElementById(`wv-${key}`).innerText = `${e.target.value}%`;
      _cachedWeightsSig = '';
      updateDashboard();
    });
  }

  document.getElementById('btn-preset-intel')?.addEventListener('click', () => {
    const wp = cycleData?.metadata?.weights_presets?.intelligent || {};
    for (const k in currentWeights) if (wp[k] !== undefined) currentWeights[k] = wp[k];
    syncSliders(); _cachedWeightsSig = ''; updateDashboard();
  });
  document.getElementById('btn-preset-equal')?.addEventListener('click', () => {
    const eq = 1 / Object.keys(currentWeights).length;
    for (const k in currentWeights) currentWeights[k] = eq;
    syncSliders(); _cachedWeightsSig = ''; updateDashboard();
  });
}

function syncSliders() {
  for (const k in currentWeights) {
    const pct = Math.round(currentWeights[k] * 100);
    const s = document.getElementById(`ws-${k}`); if (s) s.value = pct;
    const v = document.getElementById(`wv-${k}`); if (v) v.innerText = `${pct}%`;
  }
}

// ── Timeline Slider ────────────────────────────────────────────────────────
function setupTimelineSlider() {
  const slider = document.getElementById('history-slider');
  if (!slider) return;
  slider.max = cycleData.timeline.length - 1;
  slider.value = selectedIndex;
  slider.addEventListener('input', e => {
    selectedIndex = parseInt(e.target.value);
    updateDashboard();
  });
}

// ── Historical Chart ───────────────────────────────────────────────────────
function initHistoryChart() {
  const ctx = document.getElementById('historyChart')?.getContext('2d');
  if (!ctx) return;
  const scores  = getCachedScores();
  const labels  = cycleData.timeline.map(r => r.quarter_label);

  historyChart = new Chart(ctx, {
    type: 'line',
    data: {
      labels,
      datasets: [{
        label: 'Credit Cycle Score',
        data: scores,
        borderColor: '#38bdf8',
        borderWidth: 2.5,
        pointRadius: 0,
        pointHoverRadius: 7,
        pointHoverBackgroundColor: '#ffffff',
        pointHoverBorderColor: '#38bdf8',
        fill: true,
        backgroundColor: (ctx) => {
          const { chart: ch, chartArea: ca } = ctx;
          if (!ca) return null;
          const g = ch.ctx.createLinearGradient(0, ca.top, 0, ca.bottom);
          g.addColorStop(0,   'rgba(56, 189, 248, 0.28)');
          g.addColorStop(1,   'rgba(56, 189, 248, 0.00)');
          return g;
        },
        tension: 0.4,
      }]
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: { display: false },
        tooltip: {
          backgroundColor: '#0f172a', titleColor: '#f8fafc',
          bodyColor: '#cbd5e1', borderColor: '#334155', borderWidth: 1, padding: 12,
          callbacks: {
            label: item => {
              const s = item.parsed.y;
              const ph = getPhaseFromScore(s);
              return [`Score: ${s.toFixed(2)} / 4.0`, `Phase: ${ph.name}`];
            }
          }
        },
        annotation: {
          annotations: {
            early: { type: 'box', yMin: 0, yMax: 1, backgroundColor: 'rgba(2,132,199,0.05)', borderWidth: 0 },
            mid:   { type: 'box', yMin: 1, yMax: 2, backgroundColor: 'rgba(13,148,136,0.05)', borderWidth: 0 },
            late:  { type: 'box', yMin: 2, yMax: 3, backgroundColor: 'rgba(22,163,74,0.05)',  borderWidth: 0 },
            rec:   { type: 'box', yMin: 3, yMax: 4, backgroundColor: 'rgba(147,51,234,0.05)', borderWidth: 0 },
          }
        }
      },
      scales: {
        x: {
          grid: { color: 'rgba(255,255,255,0.05)' },
          ticks: { color: '#64748b', maxTicksLimit: 14, font: { size: 10 } }
        },
        y: {
          min: 0, max: 4,
          grid: { color: 'rgba(255,255,255,0.06)' },
          ticks: {
            color: '#64748b', stepSize: 1,
            callback: v => ['Early Cycle', 'Mid-Cycle', 'Late Cycle', 'Recession', ''][v] ?? ''
          }
        }
      },
      onClick: (e, elements) => {
        if (elements.length > 0) { selectedIndex = elements[0].index; updateDashboard(); }
      }
    }
  });
}

function updateHistoryChart(scores) {
  if (!historyChart) return;
  historyChart.data.datasets[0].data = scores || getCachedScores();
  historyChart.update('none');
}

// ── Indicator Cards ────────────────────────────────────────────────────────
function renderIndicatorCards() {
  const container = document.getElementById('indicator-cards-container');
  if (!container) return;
  container.innerHTML = '';

  const cardDefs = [
    { key: 'defaults',       name: 'Defaults & Delinquencies',  color: '#ef4444', desc: 'C&I Loan Delinquency Rate (%)' },
    { key: 'profit_margins', name: 'Corporate Profit Margins',   color: '#10b981', desc: 'After-Tax Profits / GDP (%)' },
    { key: 'capex',          name: 'CAPEX (Investment Cycle)',   color: '#f59e0b', desc: 'Private Nonresidential Investment ($B)' },
    { key: 'cash',           name: 'Corporate Cash / Liquidity', color: '#38bdf8', desc: 'Liquid Assets / ST Liabilities (%)' },
    { key: 'buybacks',       name: 'Share Buybacks',             color: '#a855f7', desc: 'Net Equity Retirements ($B)' },
    { key: 'mna',            name: 'M&A Deal Activity',         color: '#ec4899', desc: 'US Direct Investment Acquisitions ($B)' },
    { key: 'dividends',      name: 'Dividend Payouts',           color: '#6366f1', desc: 'Net Corporate Dividends ($B)' },
  ];

  cardDefs.forEach(c => {
    const cur = cycleData.current[c.key] || {};
    const div = document.createElement('div');
    div.className = 'glass-card p-5';

    const chgKey = cur.chg_1y !== undefined ? 'chg_1y' : 'yoy';
    const chg = cur[chgKey];
    const chgHtml = chg !== undefined ? `<span class="${chg >= 0 ? 'text-emerald-400' : 'text-rose-400'} text-xs font-semibold ml-auto">${chg > 0 ? '+' : ''}${chg}${chgKey === 'yoy' ? '% YoY' : ' 1y'}</span>` : '';

    div.innerHTML = `
      <div class="flex justify-between items-start mb-2">
        <div>
          <h4 class="font-bold text-slate-100 text-sm">${c.name}</h4>
          <p class="text-[10px] text-slate-400 font-mono">${c.desc}</p>
        </div>
        <span class="text-[10px] px-2 py-0.5 rounded-full font-bold bg-slate-800 text-slate-300 border border-slate-700 ml-2 whitespace-nowrap">${cur.phase || ''}</span>
      </div>
      <div class="flex items-baseline gap-2 my-2">
        <span class="text-xl font-black text-white font-mono">${cur.value ?? '-'}</span>
        <span class="text-xs text-slate-400">${cur.unit ?? ''}</span>
        ${chgHtml}
      </div>
      <div class="h-16 w-full mt-3"><canvas id="mini-${c.key}"></canvas></div>
    `;
    container.appendChild(div);

    setTimeout(() => {
      const mc = document.getElementById(`mini-${c.key}`)?.getContext('2d');
      if (!mc) return;
      new Chart(mc, {
        type: 'line',
        data: {
          labels: cycleData.timeline.map(r => r.quarter_label),
          datasets: [{ data: cycleData.timeline.map(r => (r[c.key] || {}).value ?? 0),
            borderColor: c.color, borderWidth: 2, pointRadius: 0, fill: false, tension: 0.3 }]
        },
        options: {
          responsive: true, maintainAspectRatio: false,
          plugins: { legend: { display: false }, tooltip: { enabled: false } },
          scales: { x: { display: false }, y: { display: false } }
        }
      });
    }, 50);
  });
}

document.addEventListener('DOMContentLoaded', init);
