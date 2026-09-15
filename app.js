/**
 * Credit Cycle Web Dashboard - Core Engine
 * Renders Invesco Credit Cycle slope, 20-year historical trajectory,
 * dynamic weighting calculator, and real-time Invesco reference matrix.
 */

let cycleData = null;
let currentWeights = {
  defaults: 0.20,
  profit_margins: 0.15,
  capex: 0.15,
  cash: 0.15,
  buybacks: 0.125,
  mna: 0.125,
  dividends: 0.10
};

let selectedIndex = 0;
let historyChart = null;
let indicatorCharts = {};

// Invesco Phase Definitions
const PHASES = [
  { name: 'Early cycle', min: 0.0, max: 1.0, color: '#0284c7', lightColor: 'rgba(2, 132, 199, 0.15)', text: 'Plateauing defaults, recovering margins, bottoming capex, liquidity build-up' },
  { name: 'Mid-cycle', min: 1.0, max: 2.0, color: '#0d9488', lightColor: 'rgba(13, 148, 136, 0.15)', text: 'Declining defaults, expanding margins, steady capex, emerging M&A' },
  { name: 'Late cycle', min: 2.0, max: 3.0, color: '#16a34a', lightColor: 'rgba(22, 163, 74, 0.15)', text: 'Bottom defaults, plateauing margins, accelerating capex, heavy buybacks, declining cash' },
  { name: 'Recession', min: 3.0, max: 4.0, color: '#9333ea', lightColor: 'rgba(147, 51, 234, 0.15)', text: 'Rising defaults, contracting margins, slashed capex, frozen buybacks, liquidity scramble' }
];

async function init() {
  try {
    const res = await fetch('credit_cycle_data.json');
    cycleData = await res.json();
    selectedIndex = cycleData.timeline.length - 1; // Latest quarter
    
    setupWeightControls();
    updateDashboard();
    setupTimelineSlider();
    initHistoryChart();
    renderIndicatorCards();
    
    // Interactive canvas click to jump to corresponding historical cycle phase
    const canvas = document.getElementById('cycleCanvas');
    if (canvas) {
      canvas.style.cursor = 'pointer';
      canvas.addEventListener('click', (e) => {
        const rect = canvas.getBoundingClientRect();
        const clickX = e.clientX - rect.left;
        const paddingLeft = 40;
        const paddingRight = 40;
        const plotW = rect.width - paddingLeft - paddingRight;
        const ratio = Math.max(0.01, Math.min(0.99, (clickX - paddingLeft) / plotW));
        const targetScore = ratio * 4.0;

        // Find quarter in timeline closest to targetScore
        let bestIdx = 0;
        let minDiff = 999;
        cycleData.timeline.forEach((q, idx) => {
          const s = calculateCompositeScore(q, currentWeights);
          const diff = Math.abs(s - targetScore);
          if (diff < minDiff) {
            minDiff = diff;
            bestIdx = idx;
          }
        });
        selectedIndex = bestIdx;
        updateDashboard();
      });
    }

    window.addEventListener('resize', () => {
      updateDashboard();
    });
  } catch (err) {
    console.error("Error loading data:", err);
    document.getElementById('app-loading').innerHTML = `
      <div class="p-6 text-center text-red-400">
        <p class="font-bold text-lg">Error loading credit cycle data</p>
        <p class="text-sm mt-2">${err.message}</p>
      </div>`;
  }
}

function getIndicatorScore(record, key) {
  return record[key]?.phase_score ?? 1.5;
}

function calculateCompositeScore(record, weights) {
  let totalW = 0;
  let score = 0;
  for (const k in weights) {
    totalW += weights[k];
    score += (record[k]?.phase_score ?? 1.5) * weights[k];
  }
  return totalW > 0 ? score / totalW : 2.0;
}

function getPhaseFromScore(score) {
  if (score < 1.0) return PHASES[0];
  if (score < 2.0) return PHASES[1];
  if (score < 3.0) return PHASES[2];
  return PHASES[3];
}

// Invesco Cycle Curve Function: y(x) where x in [0, 1]
// Returns normalized height between 0 (trough) and 1 (peak)
function getCycleCurveY(x) {
  // x = 0 (Start of Early): 0.15
  // x = 0.40 (Mid-Cycle Peak): 0.95
  // x = 0.65 (Late Cycle Rollover): 0.70
  // x = 0.90 (Recession Trough): 0.05
  // Smooth composite curve simulating Invesco hump
  return 0.5 + 0.45 * Math.sin((x * 2 * Math.PI) - (Math.PI / 2.5));
}

// Derivative / Slope at x
function getCycleCurveSlope(x) {
  const dx = 0.005;
  const y1 = getCycleCurveY(Math.max(0, x - dx));
  const y2 = getCycleCurveY(Math.min(1, x + dx));
  return (y2 - y1) / (2 * dx);
}

function updateDashboard() {
  if (!cycleData) return;
  const currentRec = cycleData.timeline[selectedIndex];
  const score = calculateCompositeScore(currentRec, currentWeights);
  const phase = getPhaseFromScore(score);

  // Normalized coordinate along the curve: 0.0 to 1.0
  // Score is 0.0 to 4.0
  const normalizedX = Math.max(0.02, Math.min(0.98, score / 4.0));
  const slope = getCycleCurveSlope(normalizedX);

  // Update Header Badges
  document.getElementById('current-quarter-badge').innerText = currentRec.quarter_label;
  document.getElementById('current-phase-badge').innerText = phase.name.toUpperCase();
  document.getElementById('current-phase-badge').style.backgroundColor = phase.color;
  document.getElementById('composite-score-badge').innerText = `${score.toFixed(2)} / 4.0`;

  let slopeText = "";
  let slopeColor = "";
  if (slope > 0.4) {
    slopeText = "Ascending (Strong Expansion)";
    slopeColor = "text-sky-400";
  } else if (slope > 0.05) {
    slopeText = "Maturing Peak (Approaching Crest)";
    slopeColor = "text-teal-400";
  } else if (slope > -0.35) {
    slopeText = "Peak Plateau / Rollover Initiated";
    slopeColor = "text-emerald-400";
  } else {
    slopeText = "Descending (Credit Contraction)";
    slopeColor = "text-purple-400";
  }
  document.getElementById('current-slope-text').innerHTML = `<span class="${slopeColor} font-bold">${slopeText}</span> (Slope: ${slope.toFixed(2)})`;
  document.getElementById('phase-description-text').innerText = phase.text;

  // Redraw Cycle Slope Canvas
  drawCycleSlope(normalizedX, score, phase, slopeText);

  // Update Reference Table Highlighting
  updateInvescoTable(currentRec);

  // Update Timeline Slider label
  const slider = document.getElementById('history-slider');
  if (slider) {
    slider.value = selectedIndex;
    document.getElementById('slider-label').innerText = `${currentRec.quarter_label} (${selectedIndex + 1}/${cycleData.timeline.length})`;
  }

  // Update Historical Chart line with new weights
  updateHistoryChart();
}

function drawCycleSlope(normalizedX, score, phase, slopeText) {
  const canvas = document.getElementById('cycleCanvas');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  const dpr = window.devicePixelRatio || 1;

  const rect = canvas.getBoundingClientRect();
  canvas.width = rect.width * dpr;
  canvas.height = rect.height * dpr;
  ctx.scale(dpr, dpr);

  const w = rect.width;
  const h = rect.height;

  ctx.clearRect(0, 0, w, h);

  const paddingLeft = 40;
  const paddingRight = 40;
  const paddingTop = 45;
  const paddingBottom = 65;

  const plotW = w - paddingLeft - paddingRight;
  const plotH = h - paddingTop - paddingBottom;

  // Background 4 Phase Zone Shading
  const zoneWidth = plotW / 4;
  PHASES.forEach((p, idx) => {
    const zX = paddingLeft + idx * zoneWidth;
    ctx.fillStyle = p.lightColor;
    ctx.fillRect(zX, paddingTop, zoneWidth, plotH);

    // Subtle dashed separator
    if (idx > 0) {
      ctx.beginPath();
      ctx.setLineDash([4, 4]);
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.15)';
      ctx.lineWidth = 1;
      ctx.moveTo(zX, paddingTop);
      ctx.lineTo(zX, paddingTop + plotH);
      ctx.stroke();
      ctx.setLineDash([]);
    }

    // Phase Header Labels
    ctx.fillStyle = p.color;
    ctx.font = 'bold 13px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(p.name.toUpperCase(), zX + zoneWidth / 2, paddingTop - 12);
  });

  // Draw the Invesco Credit Curve
  const points = [];
  const steps = 120;
  for (let i = 0; i <= steps; i++) {
    const xRatio = i / steps;
    const px = paddingLeft + xRatio * plotW;
    const pyNorm = getCycleCurveY(xRatio);
    // Invert pyNorm so 1 is near top, 0 near bottom
    const py = paddingTop + (1 - pyNorm) * (plotH - 20) + 10;
    points.push({ x: px, y: py, ratio: xRatio });
  }

  // Draw Glowing Curve
  ctx.beginPath();
  ctx.moveTo(points[0].x, points[0].y);
  for (let i = 1; i < points.length; i++) {
    ctx.lineTo(points[i].x, points[i].y);
  }

  // Gradient stroke for curve matching phases
  const grad = ctx.createLinearGradient(paddingLeft, 0, paddingLeft + plotW, 0);
  grad.addColorStop(0.12, PHASES[0].color);
  grad.addColorStop(0.38, PHASES[1].color);
  grad.addColorStop(0.65, PHASES[2].color);
  grad.addColorStop(0.90, PHASES[3].color);

  ctx.strokeStyle = grad;
  ctx.lineWidth = 4.5;
  ctx.shadowColor = 'rgba(56, 189, 248, 0.4)';
  ctx.shadowBlur = 10;
  ctx.stroke();
  ctx.shadowBlur = 0;

  // --- Draw Invesco Structural Reference Lines (from source image) ---
  const refLines = [
    { xRatio: 0.22, label: 'Early cycle', color: '#38bdf8', tilt: -0.38 },
    { xRatio: 0.46, label: 'Mid-cycle', color: '#2dd4bf', tilt: 0 },
    { xRatio: 0.70, label: 'Late cycle', color: '#4ade80', tilt: 0.38 }
  ];

  refLines.forEach(ref => {
    const rx = paddingLeft + ref.xRatio * plotW;
    const rCurveYNorm = getCycleCurveY(ref.xRatio);
    const ry = paddingTop + (1 - rCurveYNorm) * (plotH - 20) + 10;

    // Structural vertical pointer line
    ctx.beginPath();
    ctx.strokeStyle = ref.color;
    ctx.lineWidth = 1.8;
    ctx.moveTo(rx, ry);
    ctx.lineTo(rx, paddingTop + plotH);
    ctx.stroke();

    // Top dot on reference line
    ctx.beginPath();
    ctx.arc(rx, ry, 4, 0, Math.PI * 2);
    ctx.fillStyle = ref.color;
    ctx.fill();
  });

  // Structural Labels along the Curve (matching original diagram)
  ctx.save();
  // Early cycle label (tilted on ascending slope)
  ctx.translate(paddingLeft + 0.16 * plotW, paddingTop + 0.58 * plotH);
  ctx.rotate(-0.35);
  ctx.fillStyle = '#7dd3fc';
  ctx.font = 'bold 13px system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText('Early cycle', 0, -10);
  ctx.restore();

  // Mid-cycle label (centered above peak crest)
  ctx.save();
  ctx.fillStyle = '#5eead4';
  ctx.font = 'bold 14px system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText('Mid-cycle', paddingLeft + 0.46 * plotW, paddingTop + 16);
  ctx.restore();

  // Late cycle label (tilted on descending slope)
  ctx.save();
  ctx.translate(paddingLeft + 0.70 * plotW, paddingTop + 0.48 * plotH);
  ctx.rotate(0.35);
  ctx.fillStyle = '#86efac';
  ctx.font = 'bold 13px system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText('Late cycle', 0, -10);
  ctx.restore();

  // Recession label (trough)
  ctx.save();
  ctx.fillStyle = '#d8b4fe';
  ctx.font = 'bold 13px system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText('Recession', paddingLeft + 0.88 * plotW, paddingTop + 0.88 * plotH);
  ctx.restore();

  // Source image annotation top right
  ctx.fillStyle = '#94a3b8';
  ctx.font = 'italic 11px system-ui, sans-serif';
  ctx.textAlign = 'right';
  ctx.fillText('valuations are high, and megadeals become prevalent', paddingLeft + plotW - 10, paddingTop - 22);

  // --- DYNAMIC LIVE "WE ARE HERE" VERTICAL PIN & MARKER ---
  const currentPinX = paddingLeft + normalizedX * plotW;
  const currentCurveYNorm = getCycleCurveY(normalizedX);
  const currentPinY = paddingTop + (1 - currentCurveYNorm) * (plotH - 20) + 10;

  // 1. Prominent vertical dropline for Current Position
  ctx.beginPath();
  ctx.setLineDash([6, 3]);
  ctx.strokeStyle = '#ffffff';
  ctx.lineWidth = 2.5;
  ctx.shadowColor = phase.color;
  ctx.shadowBlur = 10;
  ctx.moveTo(currentPinX, currentPinY);
  ctx.lineTo(currentPinX, paddingTop + plotH);
  ctx.stroke();
  ctx.shadowBlur = 0;
  ctx.setLineDash([]);

  // 2. Vertical Pin Pole extending above curve
  ctx.beginPath();
  ctx.strokeStyle = '#f8fafc';
  ctx.lineWidth = 2.5;
  ctx.moveTo(currentPinX, currentPinY);
  ctx.lineTo(currentPinX, currentPinY - 36);
  ctx.stroke();

  // 3. Top Flag Callout: "YOU ARE HERE"
  const tagW = 106;
  const tagH = 22;
  const tagX = Math.max(paddingLeft, Math.min(paddingLeft + plotW - tagW, currentPinX - tagW / 2));
  const tagY = currentPinY - 48;

  ctx.fillStyle = phase.color;
  ctx.shadowColor = 'rgba(0, 0, 0, 0.7)';
  ctx.shadowBlur = 8;
  roundRect(ctx, tagX, tagY, tagW, tagH, 5, true, false);
  ctx.shadowBlur = 0;

  ctx.fillStyle = '#ffffff';
  ctx.font = '900 10px system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText('WE ARE HERE NOW', tagX + tagW / 2, tagY + 14);

  // 4. Glowing Pulsing Coordinate Pin on the Curve
  ctx.beginPath();
  ctx.arc(currentPinX, currentPinY, 12, 0, Math.PI * 2);
  ctx.fillStyle = phase.color;
  ctx.globalAlpha = 0.35;
  ctx.fill();
  ctx.globalAlpha = 1.0;

  ctx.beginPath();
  ctx.arc(currentPinX, currentPinY, 7, 0, Math.PI * 2);
  ctx.fillStyle = '#ffffff';
  ctx.fill();
  ctx.strokeStyle = phase.color;
  ctx.lineWidth = 3.5;
  ctx.shadowColor = phase.color;
  ctx.shadowBlur = 16;
  ctx.stroke();
  ctx.shadowBlur = 0;

  // 5. Baseline Indicator Box with exact coordinate
  const baseBoxW = 175;
  const baseBoxH = 28;
  const baseBoxX = Math.max(paddingLeft, Math.min(paddingLeft + plotW - baseBoxW, currentPinX - baseBoxW / 2));
  const baseBoxY = paddingTop + plotH + 8;

  ctx.fillStyle = 'rgba(15, 23, 42, 0.95)';
  ctx.strokeStyle = phase.color;
  ctx.lineWidth = 2;
  roundRect(ctx, baseBoxX, baseBoxY, baseBoxW, baseBoxH, 6, true, true);

  ctx.fillStyle = '#f8fafc';
  ctx.font = 'bold 11px system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText(`POSITION: ${(normalizedX * 100).toFixed(0)}% • ${phase.name.toUpperCase()}`, baseBoxX + baseBoxW / 2, baseBoxY + 18);
}

function roundRect(ctx, x, y, width, height, radius, fill, stroke) {
  ctx.beginPath();
  ctx.moveTo(x + radius, y);
  ctx.lineTo(x + width - radius, y);
  ctx.quadraticCurveTo(x + width, y, x + width, y + radius);
  ctx.lineTo(x + width, y + height - radius);
  ctx.quadraticCurveTo(x + width, y + height, x + width - radius, y + height);
  ctx.lineTo(x + radius, y + height);
  ctx.quadraticCurveTo(x, y + height, x, y + height - radius);
  ctx.lineTo(x, y + radius);
  ctx.quadraticCurveTo(x, y, x + radius, y);
  ctx.closePath();
  if (fill) ctx.fill();
  if (stroke) ctx.stroke();
}

function updateInvescoTable(rec) {
  if (!cycleData?.invesco_matrix) return;
  const tbody = document.getElementById('invesco-table-body');
  if (!tbody) return;

  tbody.innerHTML = '';

  const phaseMap = {
    'Early cycle': 0,
    'Mid-cycle': 1,
    'Late cycle': 2,
    'Recession': 3
  };

  cycleData.invesco_matrix.forEach(row => {
    const indicatorKey = row.id;
    const indData = rec[indicatorKey];
    const activeState = indData?.phase || '';
    const val = indData?.value;
    const unit = indData?.unit || '';
    const chg = indData?.chg_1y !== undefined ? indData.chg_1y : (indData?.yoy !== undefined ? indData.yoy : null);

    const tr = document.createElement('tr');
    tr.className = "border-b border-slate-800 hover:bg-slate-800/40 transition-colors";

    // Indicator Column
    let indicatorHtml = `
      <td class="py-3 px-4 font-semibold text-slate-200">
        <div class="flex items-center gap-2">
          <span>${row.name}</span>
          ${row.name === 'CAPEX' ? '<span class="text-xs px-1.5 py-0.5 rounded bg-red-950 text-red-300 font-bold border border-red-700">CAPEX</span>' : ''}
        </div>
        <div class="text-xs text-slate-400 font-mono mt-0.5">
          ${val !== undefined ? `${val} ${unit}` : ''}
          ${chg !== null ? `<span class="${chg >= 0 ? 'text-emerald-400' : 'text-rose-400'} ml-1.5 font-sans font-medium">(${chg > 0 ? '+' : ''}${chg}${unit === '%' || unit.includes('%') ? 'pp' : '%'} 1y)</span>` : ''}
        </div>
      </td>`;

    // 4 Phase Columns
    const cols = [
      { text: row.early, phaseName: 'Early cycle', isMatch: activeState.toLowerCase().includes(row.early.toLowerCase()) || row.early.toLowerCase().includes(activeState.toLowerCase()) },
      { text: row.mid, phaseName: 'Mid-cycle', isMatch: activeState.toLowerCase().includes(row.mid.toLowerCase()) || row.mid.toLowerCase().includes(activeState.toLowerCase()) },
      { text: row.late, phaseName: 'Late cycle', isMatch: activeState.toLowerCase().includes(row.late.toLowerCase()) || row.late.toLowerCase().includes(activeState.toLowerCase()) },
      { text: row.recession, phaseName: 'Recession', isMatch: activeState.toLowerCase().includes(row.recession.toLowerCase()) || row.recession.toLowerCase().includes(activeState.toLowerCase()) }
    ];

    cols.forEach(col => {
      const activeClass = col.isMatch ? 'table-cell-active text-emerald-300' : 'text-slate-300';
      indicatorHtml += `
        <td class="py-3 px-4 text-sm ${activeClass} transition-all duration-200">
          <div>${col.text}</div>
          ${col.isMatch ? `<div class="text-[11px] text-emerald-200/90 font-mono mt-0.5 font-semibold">Value: ${val} ${unit}</div>` : ''}
        </td>`;
    });

    tr.innerHTML = indicatorHtml;
    tbody.appendChild(tr);
  });
}

function setupWeightControls() {
  const container = document.getElementById('weight-sliders');
  if (!container) return;
  container.innerHTML = '';

  const labels = {
    defaults: { label: 'Defaults & Credit Stress', desc: 'FRED: DRBLACBS' },
    profit_margins: { label: 'Corporate Profit Margins', desc: 'FRED: CP / GDP' },
    capex: { label: 'CAPEX (Capital Expenditure)', desc: 'FRED: PNFI' },
    cash: { label: 'Corporate Cash / Liquidity', desc: 'FRED: Liquid Assets / ST Liab' },
    buybacks: { label: 'Share Buybacks & Equity Retirements', desc: 'FRED: NCBCEBQ027S' },
    mna: { label: 'M&A & Deal Frenzy', desc: 'FRED: IEAADIN' },
    dividends: { label: 'Dividends & Payout Ratios', desc: 'FRED: DIVIDEND / CP' }
  };

  for (const key in currentWeights) {
    const info = labels[key];
    const valPct = Math.round(currentWeights[key] * 100);

    const div = document.createElement('div');
    div.className = "bg-slate-900/60 p-3 rounded-xl border border-slate-800/80";
    div.innerHTML = `
      <div class="flex justify-between items-center mb-1">
        <div>
          <span class="text-xs font-semibold text-slate-200">${info.label}</span>
          <span class="text-[10px] text-slate-500 block">${info.desc}</span>
        </div>
        <span id="weight-val-${key}" class="text-xs font-mono font-bold text-sky-400 bg-sky-950/60 px-2 py-0.5 rounded border border-sky-800/50">${valPct}%</span>
      </div>
      <input type="range" id="slider-weight-${key}" min="0" max="40" step="1" value="${valPct}" class="w-full">
    `;
    container.appendChild(div);

    const input = div.querySelector(`#slider-weight-${key}`);
    input.addEventListener('input', (e) => {
      const newPct = parseFloat(e.target.value);
      currentWeights[key] = newPct / 100.0;
      document.getElementById(`weight-val-${key}`).innerText = `${newPct}%`;
      normalizeWeights(key);
      updateDashboard();
    });
  }

  // Preset Buttons
  document.getElementById('btn-preset-intel')?.addEventListener('click', () => {
    currentWeights = { ...cycleData.metadata.weights_presets.intelligent };
    syncSliderInputs();
    updateDashboard();
  });

  document.getElementById('btn-preset-equal')?.addEventListener('click', () => {
    const eq = 1.0 / 7.0;
    for (const k in currentWeights) currentWeights[k] = eq;
    syncSliderInputs();
    updateDashboard();
  });
}

function normalizeWeights(excludeKey) {
  let sum = 0;
  for (const k in currentWeights) sum += currentWeights[k];
  if (sum <= 0) {
    currentWeights[excludeKey] = 1.0;
    sum = 1.0;
  }
}

function syncSliderInputs() {
  for (const key in currentWeights) {
    const valPct = Math.round(currentWeights[key] * 100);
    const slider = document.getElementById(`slider-weight-${key}`);
    const label = document.getElementById(`weight-val-${key}`);
    if (slider) slider.value = valPct;
    if (label) label.innerText = `${valPct}%`;
  }
}

function setupTimelineSlider() {
  const slider = document.getElementById('history-slider');
  if (!slider) return;
  slider.max = cycleData.timeline.length - 1;
  slider.value = selectedIndex;

  slider.addEventListener('input', (e) => {
    selectedIndex = parseInt(e.target.value);
    updateDashboard();
  });
}

function initHistoryChart() {
  const ctx = document.getElementById('historyChart')?.getContext('2d');
  if (!ctx) return;

  const labels = cycleData.timeline.map(r => r.quarter_label);
  const dataScores = cycleData.timeline.map(r => calculateCompositeScore(r, currentWeights));

  historyChart = new Chart(ctx, {
    type: 'line',
    data: {
      labels: labels,
      datasets: [
        {
          label: 'Credit Cycle Composite Score',
          data: dataScores,
          borderColor: '#38bdf8',
          borderWidth: 3,
          pointRadius: 0,
          pointHoverRadius: 6,
          pointHoverBackgroundColor: '#ffffff',
          pointHoverBorderColor: '#38bdf8',
          fill: true,
          backgroundColor: (context) => {
            const chart = context.chart;
            const { ctx, chartArea } = chart;
            if (!chartArea) return null;
            const gradient = ctx.createLinearGradient(0, chartArea.top, 0, chartArea.bottom);
            gradient.addColorStop(0, 'rgba(56, 189, 248, 0.25)');
            gradient.addColorStop(1, 'rgba(56, 189, 248, 0.0)');
            return gradient;
          },
          tension: 0.35
        }
      ]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: {
        mode: 'index',
        intersect: false
      },
      plugins: {
        legend: { display: false },
        tooltip: {
          backgroundColor: '#0f172a',
          titleColor: '#f8fafc',
          bodyColor: '#cbd5e1',
          borderColor: '#334155',
          borderWidth: 1,
          padding: 12,
          callbacks: {
            label: (item) => {
              const score = item.parsed.y;
              const phase = getPhaseFromScore(score);
              return [`Cycle Score: ${score.toFixed(2)} / 4.0`, `Phase: ${phase.name}`];
            }
          }
        }
      },
      scales: {
        x: {
          grid: { color: 'rgba(255, 255, 255, 0.05)' },
          ticks: {
            color: '#64748b',
            maxTicksLimit: 12,
            font: { size: 11 }
          }
        },
        y: {
          min: 0,
          max: 4,
          grid: { color: 'rgba(255, 255, 255, 0.06)' },
          ticks: {
            color: '#64748b',
            stepSize: 1,
            callback: (val) => {
              if (val === 0.5) return 'Early (0-1)';
              if (val === 1.5) return 'Mid (1-2)';
              if (val === 2.5) return 'Late (2-3)';
              if (val === 3.5) return 'Recession (3-4)';
              return val;
            }
          }
        }
      },
      onClick: (e, elements) => {
        if (elements.length > 0) {
          selectedIndex = elements[0].index;
          updateDashboard();
        }
      }
    }
  });
}

function updateHistoryChart() {
  if (!historyChart) return;
  const newScores = cycleData.timeline.map(r => calculateCompositeScore(r, currentWeights));
  historyChart.data.datasets[0].data = newScores;
  historyChart.update();
}

function renderIndicatorCards() {
  const container = document.getElementById('indicator-cards-container');
  if (!container) return;
  container.innerHTML = '';

  const cards = [
    { key: 'defaults', name: 'Defaults & Delinquencies', series: 'DRBLACBS', desc: 'Commercial Bank C&I Loan Delinquency Rate (%)', color: '#ef4444' },
    { key: 'profit_margins', name: 'Corporate Profit Margins', series: 'CP / GDP', desc: 'Corporate Profits After Tax / GDP (%)', color: '#10b981' },
    { key: 'capex', name: 'CAPEX (Investment)', series: 'PNFI', desc: 'Private Nonresidential Fixed Investment ($B)', color: '#f59e0b' },
    { key: 'cash', name: 'Corporate Cash / Liquidity', series: 'BOGZ1FL104001006Q', desc: 'Liquid Assets as % of Short-Term Liabilities', color: '#38bdf8' },
    { key: 'buybacks', name: 'Share Buybacks', series: 'NCBCEBQ027S', desc: 'Net Corporate Equity Liabilities / Retirements ($B)', color: '#a855f7' },
    { key: 'mna', name: 'Mergers & Acquisitions', series: 'IEAADIN', desc: 'Direct Investment Equity Acquisitions ($B)', color: '#ec4899' },
    { key: 'dividends', name: 'Dividend Payouts', series: 'DIVIDEND', desc: 'Net Corporate Dividends ($B)', color: '#6366f1' }
  ];

  cards.forEach(c => {
    const cur = cycleData.current[c.key];
    const div = document.createElement('div');
    div.className = "glass-card p-5";
    div.innerHTML = `
      <div class="flex justify-between items-start mb-2">
        <div>
          <h4 class="font-bold text-slate-100 text-base">${c.name}</h4>
          <p class="text-xs text-slate-400 font-mono">${c.desc}</p>
        </div>
        <span class="text-xs px-2 py-0.5 rounded-full font-bold bg-slate-800 text-slate-300 border border-slate-700">${cur?.phase || ''}</span>
      </div>
      <div class="flex items-baseline gap-2 my-2">
        <span class="text-2xl font-black text-white font-mono">${cur?.value ?? '-'}</span>
        <span class="text-xs text-slate-400 font-mono">${cur?.unit ?? ''}</span>
        ${cur?.chg_1y !== undefined ? `<span class="text-xs font-semibold ${cur.chg_1y >= 0 ? 'text-emerald-400' : 'text-rose-400'} ml-auto">${cur.chg_1y > 0 ? '+' : ''}${cur.chg_1y} 1y</span>` : ''}
        ${cur?.yoy !== undefined ? `<span class="text-xs font-semibold ${cur.yoy >= 0 ? 'text-emerald-400' : 'text-rose-400'} ml-auto">${cur.yoy > 0 ? '+' : ''}${cur.yoy}% YoY</span>` : ''}
      </div>
      <div class="h-20 w-full mt-3">
        <canvas id="mini-chart-${c.key}"></canvas>
      </div>
    `;
    container.appendChild(div);

    // Mini Sparkline Chart
    setTimeout(() => {
      const miniCtx = document.getElementById(`mini-chart-${c.key}`)?.getContext('2d');
      if (miniCtx) {
        new Chart(miniCtx, {
          type: 'line',
          data: {
            labels: cycleData.timeline.map(r => r.quarter_label),
            datasets: [{
              data: cycleData.timeline.map(r => r[c.key]?.value ?? 0),
              borderColor: c.color,
              borderWidth: 2,
              pointRadius: 0,
              fill: false,
              tension: 0.3
            }]
          },
          options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: { legend: { display: false }, tooltip: { enabled: true } },
            scales: {
              x: { display: false },
              y: { display: false }
            }
          }
        });
      }
    }, 50);
  });
}

document.addEventListener('DOMContentLoaded', init);
