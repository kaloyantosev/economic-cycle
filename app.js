/**
 * Credit Cycle Web Dashboard v4 — Phase-Plane & Scrubber Sync Engine
 * ===================================================================
 * Features:
 *  - Full 1980–2026 coverage (187 quarters)
 *  - Recognizes all 4 cycle phases including RECESSIONS ([3.0, 4.0])
 *  - Real-time client-side re-weighting using indicator components (level + mom)
 *  - Scrubber moving dotted vertical line synced on the historical curve chart
 *  - Invesco matrix live highlighting
 */

let cycleData = null;
let currentWeights = {
  defaults:       0.22,
  profit_margins: 0.18,
  capex:          0.17,
  cash:           0.15,
  buybacks:       0.14,
  mna:            0.14,
};

const H_SCALE = 1.40;
const M_SCALE = 1.10;
const EWMA_A  = 0.50;

let selectedIndex = 0;
let historyChart  = null;
let showSP500     = false;

// ── Invesco phase definitions ─────────────────────────────────────────────
const PHASES = [
  { name: 'Early cycle', min: 0.0, max: 1.0,
    color: '#0284c7', lightColor: 'rgba(2, 132, 199, 0.14)',
    text: 'Plateauing defaults, recovering profit margins, capex bottoming, corporate liquidity rebuild.' },
  { name: 'Mid-cycle', min: 1.0, max: 2.0,
    color: '#0d9488', lightColor: 'rgba(13, 148, 136, 0.14)',
    text: 'Defaults trending lower, expanding corporate profit margins, steady capex, rising M&A and buybacks.' },
  { name: 'Late cycle', min: 2.0, max: 3.0,
    color: '#16a34a', lightColor: 'rgba(22, 163, 74, 0.14)',
    text: 'Defaults at cyclical bottom, margins plateauing, capex accelerating, peak buybacks and mega-deals, cash declining.' },
  { name: 'Recession', min: 3.0, max: 4.0,
    color: '#9333ea', lightColor: 'rgba(147, 51, 234, 0.14)',
    text: 'Defaults surging, severe profit margin contraction, capex slashed, share buybacks frozen, liquidity scramble.' },
];

function ppScore(H, M) {
  const theta = Math.atan2(M, H);
  let clock = (Math.PI - theta) % (2.0 * Math.PI);
  if (clock < 0) clock += 2.0 * Math.PI;
  return (clock / (2.0 * Math.PI)) * 4.0;
}

function circularFbEWMA(rawScores, alpha) {
  const n = rawScores.length;
  const cosArr = new Float64Array(n);
  const sinArr = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const a = (rawScores[i] / 4.0) * 2.0 * Math.PI;
    cosArr[i] = Math.cos(a);
    sinArr[i] = Math.sin(a);
  }

  function fwd(a) {
    const o = new Float64Array(n);
    o[0] = a[0];
    for (let i = 1; i < n; i++) o[i] = alpha * a[i] + (1 - alpha) * o[i - 1];
    return o;
  }
  function bwd(a) {
    const o = new Float64Array(n);
    o[n - 1] = a[n - 1];
    for (let i = n - 2; i >= 0; i--) o[i] = alpha * a[i] + (1 - alpha) * o[i + 1];
    return o;
  }

  const cosS = bwd(fwd(cosArr));
  const sinS = bwd(fwd(sinArr));
  const out = new Array(n);
  for (let i = 0; i < n; i++) {
    let ang = Math.atan2(sinS[i], cosS[i]) % (2.0 * Math.PI);
    if (ang < 0) ang += 2.0 * Math.PI;
    out[i] = Math.max(0.0, Math.min(4.0, (ang / (2.0 * Math.PI)) * 4.0));
  }
  return out;
}

function computeSmoothedScores(timeline, weights) {
  const totalW = Object.values(weights).reduce((a, b) => a + b, 0);
  const rawScores = timeline.map(rec => {
    const ic = rec.indicator_components || {};
    let PL = 0, PM = 0;
    for (const k in weights) {
      const c = ic[k];
      const w = weights[k] / totalW;
      if (c && c.available !== false) {
        PL += w * (c.level ?? 0);
        PM += w * (c.mom ?? 0);
      }
    }
    const H = Math.tanh(H_SCALE * PL);
    const M = Math.tanh(M_SCALE * PM);
    return ppScore(H, M);
  });
  return circularFbEWMA(rawScores, EWMA_A);
}

function getPhaseFromScore(s) {
  if (s < 1.0) return PHASES[0];
  if (s < 2.0) return PHASES[1];
  if (s < 3.0) return PHASES[2];
  return PHASES[3];
}

// ── Invesco hump curve ─────────────────────────────────────────────────────
function getCycleY(x) {
  const phase = x * 2 * Math.PI * 0.78 - 0.48;
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
    const wp = cycleData.metadata?.weights_presets?.intelligent;
    if (wp) {
      for (const k in currentWeights) {
        if (wp[k] !== undefined) currentWeights[k] = wp[k];
      }
    }
    selectedIndex = cycleData.timeline.length - 1;

    setupWeightControls();
    setupTimelineSlider();
    initHistoryChart();
    renderIndicatorCards();
    updateDashboard();

    const canvas = document.getElementById('cycleCanvas');
    if (canvas) {
      canvas.style.cursor = 'crosshair';
      canvas.addEventListener('click', (e) => {
        const rect = canvas.getBoundingClientRect();
        const padL = 44, padR = 44;
        const plotW = rect.width - padL - padR;
        const xRatio = Math.max(0.01, Math.min(0.99, (e.clientX - rect.left - padL) / plotW));
        const targetS = xRatio * 4.0;
        const scores = getCachedScores();
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
      <p class="font-bold">Failed to load credit cycle data</p>
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

  document.getElementById('current-quarter-badge').innerText = rec.quarter_label;
  const phaseBadge = document.getElementById('current-phase-badge');
  phaseBadge.innerText = phase.name.toUpperCase();
  phaseBadge.style.backgroundColor = phase.color;
  document.getElementById('composite-score-badge').innerText = `${S.toFixed(2)} / 4.0`;

  let slopeText, slopeClass;
  if (slope > 0.35)       { slopeText = 'Ascending — Accelerating'; slopeClass = 'text-sky-400'; }
  else if (slope > 0.05)  { slopeText = 'Maturing — Peak Approaching'; slopeClass = 'text-teal-400'; }
  else if (slope > -0.30) { slopeText = 'Peak Plateau'; slopeClass = 'text-emerald-400'; }
  else                    { slopeText = 'Descending — Contraction'; slopeClass = 'text-purple-400'; }
  
  document.getElementById('current-slope-text').innerHTML =
    `<span class="${slopeClass} font-bold">${slopeText}</span> <span class="text-slate-500 font-mono text-xs">(dY/dx = ${slope.toFixed(2)})</span>`;
  document.getElementById('phase-description-text').innerText = phase.text;

  drawCycleSlope(normX, S, phase, scores);
  updateInvescoTable(rec, S);

  const slider = document.getElementById('history-slider');
  if (slider) {
    slider.value = selectedIndex;
    document.getElementById('slider-label').innerText = rec.quarter_label;
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

  // Phase zone shading
  PHASES.forEach((p, idx) => {
    const zX = padL + idx * plotW / 4;
    ctx.fillStyle = p.lightColor;
    ctx.fillRect(zX, padT, plotW / 4, plotH);
    if (idx > 0) {
      ctx.beginPath(); ctx.setLineDash([4, 5]);
      ctx.strokeStyle = 'rgba(255,255,255,0.1)'; ctx.lineWidth = 1;
      ctx.moveTo(zX, padT); ctx.lineTo(zX, padT + plotH); ctx.stroke();
      ctx.setLineDash([]);
    }
    ctx.fillStyle = p.color;
    ctx.font = 'bold 11px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(p.name.toUpperCase(), zX + plotW / 8, padT - 14);
  });

  // Build curve points
  const STEPS = 200;
  const pts = [];
  for (let i = 0; i <= STEPS; i++) {
    const xR  = i / STEPS;
    const px  = padL + xR * plotW;
    const pyN = getCycleY(xR);
    const py  = padT + (1 - pyN) * (plotH - 16) + 8;
    pts.push({ x: px, y: py, r: xR });
  }

  // Glow line
  ctx.beginPath();
  ctx.moveTo(pts[0].x, pts[0].y);
  pts.forEach(p => ctx.lineTo(p.x, p.y));
  ctx.strokeStyle = 'rgba(100, 200, 255, 0.12)';
  ctx.lineWidth = 12;
  ctx.lineJoin = 'round';
  ctx.stroke();

  // Gradient curve
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
  ctx.lineWidth = 4; ctx.lineJoin = 'round';
  ctx.stroke();

  // Reference lines
  const refLines = [
    { xR: 0.18, label: 'Early cycle', color: PHASES[0].color, tilt: -0.42 },
    { xR: 0.46, label: 'Mid-cycle',   color: PHASES[1].color, tilt:  0.0  },
    { xR: 0.68, label: 'Late cycle',  color: PHASES[2].color, tilt:  0.36 },
  ];
  refLines.forEach(ref => {
    const rx = padL + ref.xR * plotW;
    const ryN = getCycleY(ref.xR);
    const ry  = padT + (1 - ryN) * (plotH - 16) + 8;
    ctx.beginPath();
    ctx.strokeStyle = ref.color + 'aa';
    ctx.lineWidth = 1.5;
    ctx.moveTo(rx, ry); ctx.lineTo(rx, padT + plotH);
    ctx.stroke();
    ctx.beginPath(); ctx.arc(rx, ry, 4, 0, Math.PI * 2);
    ctx.fillStyle = ref.color; ctx.fill();

    ctx.save();
    ctx.translate(rx, ry);
    ctx.rotate(ref.tilt);
    ctx.fillStyle = ref.color;
    ctx.font = 'bold 11.5px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(ref.label, -8, -14);
    ctx.restore();
  });

  // Recession label
  ctx.save();
  ctx.fillStyle = PHASES[3].color;
  ctx.font = 'bold 11.5px system-ui, sans-serif';
  ctx.textAlign = 'center';
  const recX = padL + 0.88 * plotW;
  const recYN = getCycleY(0.88);
  const recY  = padT + (1 - recYN) * (plotH - 16) + 8;
  ctx.fillText('Recession', recX, recY - 16);
  ctx.restore();

  // Current position pin
  const pinX  = padL + normX * plotW;
  const pinYN = getCycleY(normX);
  const pinY  = padT + (1 - pinYN) * (plotH - 16) + 8;

  // Drop line
  ctx.beginPath(); ctx.setLineDash([4, 4]);
  ctx.strokeStyle = '#ffffffcc'; ctx.lineWidth = 2;
  ctx.moveTo(pinX, pinY); ctx.lineTo(pinX, padT + plotH);
  ctx.stroke(); ctx.setLineDash([]);

  // Flag tag "WE ARE HERE"
  const tagW = 106, tagH = 22;
  const tagX = Math.max(padL + 4, Math.min(padL + plotW - tagW - 4, pinX - tagW / 2));
  const tagY = pinY - 54;
  ctx.fillStyle = phase.color;
  _roundRect(ctx, tagX, tagY, tagW, tagH, 5); ctx.fill();
  ctx.fillStyle = '#ffffff';
  ctx.font = 'bold 9.5px system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText('▼  WE ARE HERE', tagX + tagW / 2, tagY + 14);

  // Outer glow ring
  ctx.beginPath(); ctx.arc(pinX, pinY, 12, 0, Math.PI * 2);
  ctx.fillStyle = phase.color + '44'; ctx.fill();

  // Inner white dot
  ctx.beginPath(); ctx.arc(pinX, pinY, 6, 0, Math.PI * 2);
  ctx.fillStyle = '#ffffff'; ctx.fill();
  ctx.strokeStyle = phase.color; ctx.lineWidth = 3;
  ctx.stroke();

  // Bottom status box
  const boxW = 180, boxH = 26;
  const boxX = Math.max(padL, Math.min(padL + plotW - boxW, pinX - boxW / 2));
  const boxY = padT + plotH + 8;
  ctx.fillStyle = 'rgba(10, 16, 28, 0.95)';
  ctx.strokeStyle = phase.color; ctx.lineWidth = 1.5;
  _roundRect(ctx, boxX, boxY, boxW, boxH, 6); ctx.fill(); ctx.stroke();
  ctx.fillStyle = '#f8fafc';
  ctx.font = 'bold 10.5px system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText(
    `${phase.name.toUpperCase()}  •  ${score.toFixed(2)} / 4.0`,
    boxX + boxW / 2, boxY + 17
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

  const activePhaseBand = score < 1 ? 0 : score < 2 ? 1 : score < 3 ? 2 : 3;

  cycleData.invesco_matrix.forEach(row => {
    const id  = row.id;
    const ind = rec[id] || {};
    const val   = ind.value;
    const unit  = ind.unit  || '';
    const chgKey = ind.chg_1y !== undefined ? 'chg_1y' : 'yoy';
    const chg  = ind[chgKey];

    const tr = document.createElement('tr');
    tr.className = 'border-b border-slate-800/80 hover:bg-slate-800/30 transition-colors';

    let chgHtml = '';
    if (chg !== undefined && chg !== null) {
      const isPos = chg >= 0;
      const suffix = id === 'defaults' || id === 'cash' ? 'pp' : '%';
      chgHtml = `<span class="text-[10px] ${isPos ? 'text-emerald-400' : 'text-rose-400'} font-semibold ml-1">${isPos ? '+' : ''}${chg}${suffix}</span>`;
    }

    let indHtml = `<td class="py-3 px-4">
      <div class="font-semibold text-slate-100 text-[13px]">${row.name}</div>
      <div class="text-[11px] text-slate-400 font-mono mt-0.5">
        ${val !== undefined ? `<span class="text-slate-200">${val}</span> ${unit}` : '<span class="text-slate-500 italic">Not tracked</span>'}
        ${chgHtml}
      </div>
    </td>`;

    const phaseCols = [row.early, row.mid, row.late, row.recession];
    phaseCols.forEach((cell, ci) => {
      const isActive = ci === activePhaseBand;
      if (isActive) {
        indHtml += `<td class="py-3 px-4 text-[12px] relative border-l border-slate-800"
          style="background:${PHASES[ci].color}22; border: 1.5px solid ${PHASES[ci].color}77; color:#fff; font-weight:700;">
          <div>${cell}</div>
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
    defaults:       { label: 'Defaults (Credit Stress)',   desc: 'DRBLACBS Delinquency Rate' },
    profit_margins: { label: 'Profit Margins',             desc: 'Corporate Profits / GDP' },
    capex:          { label: 'CAPEX',                      desc: 'Nonresidential Investment' },
    cash:           { label: 'Corporate Cash',             desc: 'Liquid Assets / ST Liabilities' },
    buybacks:       { label: 'Share Buybacks',             desc: 'Equity Retirements' },
    mna:            { label: 'M&A Activity',               desc: 'Direct Investment Acquisitions' },
  };

  for (const key in currentWeights) {
    const info = labels[key] || { label: key, desc: '' };
    const valPct = Math.round(currentWeights[key] * 100);
    const div = document.createElement('div');
    div.className = 'bg-slate-900/60 p-2.5 rounded-xl border border-slate-800/80';
    div.innerHTML = `
      <div class="flex justify-between items-center mb-1">
        <span class="text-[12px] font-semibold text-slate-200">${info.label}</span>
        <span id="wv-${key}" class="text-[11px] font-mono font-bold text-sky-400 bg-sky-950/70 px-2 py-0.5 rounded border border-sky-800/50">${valPct}%</span>
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
  if (slider) {
    slider.min = 0;
    slider.max = cycleData.timeline.length - 1;
    slider.value = selectedIndex;
    slider.addEventListener('input', e => {
      selectedIndex = parseInt(e.target.value);
      updateDashboard();
    });
  }

  const spBtn = document.getElementById('toggle-sp500-btn');
  const spTag = document.getElementById('sp500-status-tag');
  if (spBtn) {
    spBtn.addEventListener('click', () => {
      showSP500 = !showSP500;
      if (showSP500) {
        spBtn.classList.add('bg-amber-950/60', 'border-amber-600/60', 'text-amber-300');
        spBtn.classList.remove('bg-slate-800', 'border-slate-700', 'text-slate-300');
        if (spTag) {
          spTag.innerText = 'ON';
          spTag.className = 'text-[10px] font-mono text-amber-400 font-bold ml-0.5';
        }
      } else {
        spBtn.classList.remove('bg-amber-950/60', 'border-amber-600/60', 'text-amber-300');
        spBtn.classList.add('bg-slate-800', 'border-slate-700', 'text-slate-300');
        if (spTag) {
          spTag.innerText = 'OFF';
          spTag.className = 'text-[10px] font-mono text-slate-400 ml-0.5';
        }
      }
      updateHistoryChart();
    });
  }
}

// ── Custom Plugin for Scrubber & Phase Stage Vertical Lines ───────────────
const historyDecorationsPlugin = {
  id: 'historyDecorations',
  beforeDatasetsDraw(chart) {
    const { ctx, chartArea: { top, bottom }, scales: { x } } = chart;
    if (!cycleData?.timeline) return;

    const scores = getCachedScores();
    ctx.save();

    // Detect and draw vertical lines wherever cycle score crosses a stage boundary
    // Stages: 0: Early (<1), 1: Mid (<2), 2: Late (<3), 3: Recession (>=3)
    const stageColors = ['#0284c7', '#0d9488', '#16a34a', '#9333ea'];
    const stageLabels = ['EARLY', 'MID', 'LATE', 'RECESSION'];

    for (let i = 1; i < scores.length; i++) {
      const prevStage = Math.min(3, Math.floor(scores[i - 1]));
      const currStage = Math.min(3, Math.floor(scores[i]));

      if (prevStage !== currStage) {
        const xPos = x.getPixelForValue(i);
        if (xPos >= x.left && xPos <= x.right) {
          const color = stageColors[currStage];

          // Vertical stage line
          ctx.beginPath();
          ctx.setLineDash([3, 3]);
          ctx.lineWidth = 1.25;
          ctx.strokeStyle = color + '99';
          ctx.moveTo(xPos, top);
          ctx.lineTo(xPos, bottom);
          ctx.stroke();

          // Stage transition badge at the top
          ctx.setLineDash([]);
          ctx.font = 'bold 8.5px system-ui, sans-serif';
          ctx.fillStyle = color;
          ctx.textAlign = 'center';
          ctx.fillText(stageLabels[currStage], xPos, top + 10);
        }
      }
    }
    ctx.restore();
  },
  afterDatasetsDraw(chart) {
    const { ctx, chartArea: { top, bottom }, scales: { x } } = chart;
    if (selectedIndex === undefined || selectedIndex === null) return;
    const xPos = x.getPixelForValue(selectedIndex);
    if (xPos < x.left || xPos > x.right) return;

    ctx.save();
    // Scrubber vertical dotted line
    ctx.beginPath();
    ctx.setLineDash([4, 4]);
    ctx.lineWidth = 2;
    ctx.strokeStyle = '#38bdf8';
    ctx.moveTo(xPos, top);
    ctx.lineTo(xPos, bottom);
    ctx.stroke();

    // Top indicator dot
    ctx.setLineDash([]);
    ctx.fillStyle = '#38bdf8';
    ctx.beginPath();
    ctx.arc(xPos, top + 4, 4, 0, Math.PI * 2);
    ctx.fill();

    ctx.restore();
  }
};

// ── Historical Chart ───────────────────────────────────────────────────────
function initHistoryChart() {
  const ctx = document.getElementById('historyChart')?.getContext('2d');
  if (!ctx) return;
  const scores   = getCachedScores();
  const labels   = cycleData.timeline.map(r => r.quarter_label);
  const sp500Arr = cycleData.timeline.map(r => r.sp500 ?? null);

  historyChart = new Chart(ctx, {
    type: 'line',
    data: {
      labels,
      datasets: [
        {
          label: 'Credit Cycle Score',
          data: scores,
          borderColor: '#38bdf8',
          borderWidth: 2,
          pointRadius: 0,
          pointHoverRadius: 6,
          fill: true,
          backgroundColor: (ctx) => {
            const { chart: ch, chartArea: ca } = ctx;
            if (!ca) return null;
            const g = ch.ctx.createLinearGradient(0, ca.top, 0, ca.bottom);
            g.addColorStop(0, 'rgba(56, 189, 248, 0.25)');
            g.addColorStop(1, 'rgba(56, 189, 248, 0.00)');
            return g;
          },
          tension: 0.3,
          yAxisID: 'y',
        },
        {
          label: 'S&P 500 Price ($)',
          data: sp500Arr,
          borderColor: '#f59e0b',
          borderWidth: 2,
          pointRadius: 0,
          pointHoverRadius: 5,
          fill: false,
          tension: 0.2,
          hidden: !showSP500,
          yAxisID: 'y1',
        }
      ]
    },
    plugins: [historyDecorationsPlugin],
    options: {
      responsive: true, maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: {
          display: true,
          position: 'top',
          align: 'end',
          labels: {
            color: '#94a3b8',
            font: { size: 11 },
            boxWidth: 12,
            boxHeight: 12,
            usePointStyle: true,
            filter: (item) => showSP500 ? true : item.text !== 'S&P 500 Price ($)'
          }
        },
        tooltip: {
          backgroundColor: '#0f172a', titleColor: '#f8fafc',
          bodyColor: '#cbd5e1', borderColor: '#334155', borderWidth: 1, padding: 10,
          callbacks: {
            label: item => {
              if (item.datasetIndex === 0) {
                const s = item.parsed.y;
                const ph = getPhaseFromScore(s);
                return [`Cycle Score: ${s.toFixed(2)} / 4.0 (${ph.name})`];
              } else if (item.datasetIndex === 1) {
                const p = item.parsed.y;
                return [`S&P 500: $${p.toLocaleString('en-US', { minimumFractionDigits: 2 })}`];
              }
              return '';
            }
          }
        }
      },
      scales: {
        x: {
          grid: { color: 'rgba(255,255,255,0.04)' },
          ticks: { color: '#64748b', maxTicksLimit: 16, font: { size: 10 } }
        },
        y: {
          type: 'linear',
          display: true,
          position: 'left',
          min: 0, max: 4,
          grid: { color: 'rgba(255,255,255,0.06)' },
          ticks: {
            color: '#64748b', stepSize: 1,
            callback: v => ['Early', 'Mid', 'Late', 'Recession', ''][v] ?? ''
          }
        },
        y1: {
          type: 'linear',
          display: showSP500,
          position: 'right',
          grid: { drawOnChartArea: false },
          ticks: {
            color: '#f59e0b',
            callback: v => '$' + v.toLocaleString()
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
  historyChart.data.datasets[1].hidden = !showSP500;
  historyChart.options.scales.y1.display = showSP500;
  historyChart.update('none');
}

// ── Indicator Cards ────────────────────────────────────────────────────────
function renderIndicatorCards() {
  const container = document.getElementById('indicator-cards-container');
  if (!container) return;
  container.innerHTML = '';

  const cardDefs = [
    { key: 'defaults',       name: 'Defaults',           color: '#ef4444', desc: 'C&I Loan Delinquency (%)' },
    { key: 'profit_margins', name: 'Profit Margins',     color: '#10b981', desc: 'Corporate Profits / GDP (%)' },
    { key: 'capex',          name: 'CAPEX',              color: '#f59e0b', desc: 'Fixed Investment ($B)' },
    { key: 'cash',           name: 'Corporate Cash',     color: '#38bdf8', desc: 'Liquid Assets / ST Liab (%)' },
    { key: 'buybacks',       name: 'Share Buybacks',     color: '#a855f7', desc: 'Net Equity Retirements ($B)' },
    { key: 'mna',            name: 'M&A Volume',         color: '#ec4899', desc: 'Direct Investment ($B)' },
  ];

  cardDefs.forEach(c => {
    const cur = cycleData.current[c.key] || {};
    const div = document.createElement('div');
    div.className = 'glass-card p-4';

    const chgKey = cur.chg_1y !== undefined ? 'chg_1y' : 'yoy';
    const chg = cur[chgKey];
    const chgHtml = chg !== undefined ? `<span class="${chg >= 0 ? 'text-emerald-400' : 'text-rose-400'} text-xs font-semibold ml-auto">${chg > 0 ? '+' : ''}${chg}${chgKey === 'yoy' ? '% YoY' : ' 1y'}</span>` : '';

    div.innerHTML = `
      <div class="flex justify-between items-start mb-1">
        <div>
          <h4 class="font-bold text-slate-100 text-sm">${c.name}</h4>
          <p class="text-[10px] text-slate-500 font-mono">${c.desc}</p>
        </div>
        <span class="text-[10px] px-2 py-0.5 rounded font-semibold bg-slate-800 text-slate-300 border border-slate-700 ml-2 whitespace-nowrap">${cur.phase || ''}</span>
      </div>
      <div class="flex items-baseline gap-2 my-2">
        <span class="text-xl font-bold text-white font-mono">${cur.value ?? '-'}</span>
        <span class="text-xs text-slate-400">${cur.unit ?? ''}</span>
        ${chgHtml}
      </div>
      <div class="h-14 w-full mt-2"><canvas id="mini-${c.key}"></canvas></div>
    `;
    container.appendChild(div);

    setTimeout(() => {
      const mc = document.getElementById(`mini-${c.key}`)?.getContext('2d');
      if (!mc) return;
      new Chart(mc, {
        type: 'line',
        data: {
          labels: cycleData.timeline.map(r => r.quarter_label),
          datasets: [{ data: cycleData.timeline.map(r => (r[c.key] || {}).value ?? null),
            borderColor: c.color, borderWidth: 1.5, pointRadius: 0, fill: false, tension: 0.2 }]
        },
        options: {
          responsive: true, maintainAspectRatio: false,
          plugins: { legend: { display: false }, tooltip: { enabled: false } },
          scales: { x: { display: false }, y: { display: false } }
        }
      });
    }, 40);
  });
}

document.addEventListener('DOMContentLoaded', init);
