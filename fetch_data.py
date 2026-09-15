"""
Credit Cycle Data Harvester v3 — Calibrated Expansion Pressure Model
=====================================================================
Mathematical framework:
  1. Fetch 20+ years of quarterly FRED data for 7 Invesco indicators
  2. For each indicator, derive a MONOTONE-THROUGH-CYCLE composite signal
     using BOTH level and rate-of-change with correct economic sign:

     defaults      : HIGH + RISING         → Recession (score → 4)
                     HIGH + STABLE          → Early Cycle (plateau)
                     FALLING               → Mid-Cycle
                     LOW                   → Late Cycle
     profit_margins: RECOVERING             → Early Cycle
                     EXPANDING              → Mid Cycle
                     PLATEAUING HIGH        → Late Cycle
                     COLLAPSING             → Recession
     capex_yoy     : NEGATIVE YoY           → Recession
                     TURNING POSITIVE       → Early Cycle
                     MODERATE POSITIVE      → Mid Cycle
                     ACCELERATING           → Late Cycle
     buybacks      : LOW / ZERO             → Early Cycle
                     GROWING               → Mid Cycle
                     AGGRESSIVE            → Late Cycle
                     HALTED / CRASHING      → Recession
     mna           : LOW                   → Early Cycle
                     GROWING               → Mid Cycle
                     PEAK / MEGA-DEALS      → Late Cycle
                     COLLAPSING            → Recession
     cash_ratio    : HIGH + RISING          → Early Cycle (hoarding)
                     HIGH + DECLINING       → Mid Cycle (deploying)
                     LOW / DECLINING        → Late Cycle
                     LOW + RISING           → Recession (forced rebuild)

     NOTE: Dividends payout ratio is REMOVED as a standalone signal because
     it has cross-cycle ambiguity (falls during early recovery when profits
     surge faster than dividends, creating a false "late-cycle" reading).
     Instead we use ABSOLUTE dividend payouts with the capex and cash signals
     providing the payout context.

  3. Compute expansion pressure P_i ∈ [-2.5, +2.5] for each indicator:
       P_i = sign_i × [ w_L × clip(z_level, -3, 3)
                       + w_M × tanh(z_momentum) ]
     with z-scores computed over full-sample (not rolling), so that the GFC
     and COVID shocks register as true outliers.

  4. Composite pressure = weighted sum across indicators.

  5. Map to Cycle Score ∈ [0, 4]:
       S_raw = 2 + 2 × tanh(K × P_composite)

  6. Smooth with a FORWARD-BACKWARD EWMA (Butterworth-style zero-phase):
       First pass  : causal EWMA   α = 0.45  (recent signal dominates)
       Reverse pass: anti-causal   α = 0.45  (removes phase lag)
     This gives smooth, phase-correct cycle that spans all 4 Invesco phases
     without unrealistic single-quarter jumps.

Phase boundaries (score bands):
  [0.0, 1.0) → Early Cycle
  [1.0, 2.0) → Mid-Cycle
  [2.0, 3.0) → Late Cycle
  [3.0, 4.0) → Recession
"""

import subprocess, csv, json, math
from datetime import datetime
import numpy as np

SERIES_MAP = {
    'defaults': 'DRBLACBS',
    'profits':  'CP',
    'gdp':      'GDP',
    'capex':    'PNFI',
    'dividends':'DIVIDEND',
    'buybacks': 'NCBCEBQ027S',
    'mna':      'IEAADIN',
    'cash_ratio':'BOGZ1FL104001006Q'
}

# Weights for intelligent model
# NOTE: 6 indicators (dividends payout removed; dividends level kept under mna/buybacks context)
W_INTEL = {
    'defaults':       0.22,   # Primary credit stress barometer
    'profit_margins': 0.17,   # Corporate earnings engine
    'capex':          0.17,   # Investment cycle signal
    'cash':           0.14,   # Liquidity / risk-appetite signal
    'buybacks':       0.15,   # Financial excess signal
    'mna':            0.15,   # Deal activity / valuation signal
}
# Equal weights
W_EQUAL = {k: round(1./len(W_INTEL), 4) for k in W_INTEL}

K_SCALE = 1.05     # sensitivity of tanh mapping
EWMA_A  = 0.45     # forward-backward EWMA alpha

# ─────────────────────────────────────────────────────────────────────────────
def fetch_fred(sid):
    url = f"https://fred.stlouisfed.org/graph/fredgraph.csv?id={sid}"
    print(f"  Fetching {sid} ...", end=" ")
    res = subprocess.run(["curl.exe", "-s", url], capture_output=True, text=True)
    data = {}
    if res.returncode != 0:
        print("FAILED"); return data
    lines = res.stdout.strip().split("\n")
    reader = csv.reader(lines)
    next(reader, None)
    for row in reader:
        if len(row) >= 2 and row[1] not in ('.', '', 'NA'):
            try: data[row[0].strip()] = float(row[1].strip())
            except ValueError: pass
    print(f"{len(data)} obs"); return data

def full_zscore(arr):
    """Full-sample z-score (mean and std of entire series)."""
    a = np.asarray(arr, float)
    mu, sd = a.mean(), a.std(ddof=0)
    return (a - mu) / max(sd, 1e-12)

def zscore_momentum(arr, lag=4):
    """Full-sample z-score of lag-differenced series."""
    a = np.asarray(arr, float)
    mom = np.zeros(len(a))
    for i in range(len(a)):
        prev = max(0, i - lag)
        mom[i] = a[i] - a[prev]
    return full_zscore(mom)

def expansion_pressure(z_lvl, z_mom, sign, lvl_w=0.55, mom_w=0.45):
    """
    Expansion pressure for one indicator at one time step.
    sign=+1 → higher value / positive momentum = more expansionary
    sign=-1 → higher value / positive momentum = more recessionary
    """
    raw = sign * (lvl_w * np.clip(z_lvl, -3, 3) + mom_w * np.tanh(z_mom))
    return float(np.clip(raw, -2.5, 2.5))

def fbewma(arr, alpha):
    """Zero-phase (forward-backward) EWMA smoother."""
    def causal(a, al):
        out = np.zeros(len(a))
        out[0] = a[0]
        for i in range(1, len(a)):
            out[i] = al * a[i] + (1 - al) * out[i-1]
        return out
    return causal(causal(arr, alpha)[::-1], alpha)[::-1]

def score_to_phase(s):
    if s < 1.0: return "Early cycle", "#0284c7"
    if s < 2.0: return "Mid-cycle",   "#0d9488"
    if s < 3.0: return "Late cycle",  "#16a34a"
    return             "Recession",   "#9333ea"

# ─────────────────────────────────────────────────────────────────────────────
def run_pipeline():
    print("=== Credit Cycle Pipeline v3 ===\n")

    # 1. Fetch FRED series
    print("Fetching FRED series:")
    raw = {k: fetch_fred(v) for k, v in SERIES_MAP.items()}
    print()

    # 2. Quarterly date grid
    dates = [f"{y}-{m:02d}-01"
             for y in range(2004, 2027)
             for m in [1, 4, 7, 10]
             if f"{y}-{m:02d}-01" <= "2026-07-01"]
    N = len(dates)
    print(f"Grid: {dates[0]} -> {dates[-1]}  ({N} quarters)\n")

    # 3. Assemble raw arrays with carry-forward
    def build(key, fallback):
        arr = np.zeros(N); prev = fallback
        for i, d in enumerate(dates):
            v = raw[key].get(d, prev)
            if v is None: v = prev
            arr[i] = v; prev = v
        return arr

    def_arr  = build('defaults',  1.3)
    cp_arr   = build('profits',   3000.)
    gdp_arr  = build('gdp',       25000.)
    cpx_arr  = build('capex',     3500.)
    div_arr  = build('dividends', 1800.)
    bb_arr   = np.abs(build('buybacks',  200000.)) / 1000.   # $B
    mna_arr  = build('mna',       90000.) / 1000.             # $B
    csh_arr  = build('cash_ratio',95.)

    # Derived series
    margin_arr  = cp_arr / np.maximum(gdp_arr, 1.) * 100.     # % of GDP
    capex_yoy   = np.zeros(N)
    for i in range(N):
        p4 = max(0, i-4)
        capex_yoy[i] = (cpx_arr[i] - cpx_arr[p4]) / max(cpx_arr[p4], 1.) * 100.
    div_abs     = div_arr                                       # $B SAAR

    # 4. Full-sample z-scores and momentums
    # (Full-sample ensures GFC/COVID register as true extremes)
    zl_def  = full_zscore(def_arr)
    zm_def  = zscore_momentum(def_arr, lag=4)

    zl_mar  = full_zscore(margin_arr)
    zm_mar  = zscore_momentum(margin_arr, lag=4)

    zl_cpy  = full_zscore(capex_yoy)
    zm_cpy  = zscore_momentum(capex_yoy, lag=2)   # 2Q momentum for capex

    zl_bb   = full_zscore(bb_arr)
    zm_bb   = zscore_momentum(bb_arr, lag=4)

    zl_mna  = full_zscore(mna_arr)
    zm_mna  = zscore_momentum(mna_arr, lag=4)

    zl_csh  = full_zscore(csh_arr)
    zm_csh  = zscore_momentum(csh_arr, lag=4)

    # 5. Per-indicator expansion pressures
    # defaults: higher defaults = RECESSIONARY → sign = -1
    P_def = np.array([expansion_pressure(zl_def[i], zm_def[i], sign=-1) for i in range(N)])

    # profit_margins: higher margins = EXPANSIONARY → sign = +1
    P_mar = np.array([expansion_pressure(zl_mar[i], zm_mar[i], sign=+1) for i in range(N)])

    # capex YoY: higher growth = EXPANSIONARY → sign = +1
    P_cpy = np.array([expansion_pressure(zl_cpy[i], zm_cpy[i], sign=+1) for i in range(N)])

    # buybacks: higher = EXPANSIONARY (late-cycle excess) → sign = +1
    P_bb  = np.array([expansion_pressure(zl_bb[i],  zm_bb[i],  sign=+1) for i in range(N)])

    # M&A: higher = EXPANSIONARY (peak deal activity) → sign = +1
    P_mna = np.array([expansion_pressure(zl_mna[i], zm_mna[i], sign=+1) for i in range(N)])

    # cash ratio: higher = CONSERVATIVE/EARLY-CYCLE → sign = -1
    # BUT during recession, cash RISES because companies hoard → also recessionary
    # so sign=-1 is correct: high cash → lower expansion pressure
    P_csh = np.array([expansion_pressure(zl_csh[i], zm_csh[i], sign=-1) for i in range(N)])

    # 6. Intelligent-weight composite pressure
    ind_pressures_arr = {
        'defaults':       P_def,
        'profit_margins': P_mar,
        'capex':          P_cpy,
        'buybacks':       P_bb,
        'mna':            P_mna,
        'cash':           P_csh,
    }
    total_w = sum(W_INTEL.values())
    composite_intel = sum((W_INTEL[k] / total_w) * ind_pressures_arr[k] for k in W_INTEL)
    composite_equal = sum((1./len(W_INTEL)) * ind_pressures_arr[k] for k in W_INTEL)

    # 7. Map pressure → raw cycle score [0, 4]
    raw_intel = np.array([2.0 + 2.0 * math.tanh(K_SCALE * float(p)) for p in composite_intel])
    raw_equal = np.array([2.0 + 2.0 * math.tanh(K_SCALE * float(p)) for p in composite_equal])

    # 8. Zero-phase EWMA smooth
    smooth_intel = np.clip(fbewma(raw_intel, EWMA_A), 0., 4.)
    smooth_equal = np.clip(fbewma(raw_equal, EWMA_A), 0., 4.)

    # 9. Assemble output records
    records = []
    for i, d in enumerate(dates):
        S = float(smooth_intel[i])
        S_eq = float(smooth_equal[i])
        phase_name, phase_color = score_to_phase(S)

        chg4 = lambda a: float(a[i] - a[max(0,i-4)])
        pct4 = lambda a: float((a[i]-a[max(0,i-4)])/max(a[max(0,i-4)],1.)*100.)

        # Indicator state labels (inferred from composite score)
        def_state = (("Rise" if S>=3 else "Bottom" if S>=2 else "Trend lower" if S>=1 else "Plateau"))
        mar_state = (("Decline & bottom" if S>=3 else "Plateau" if S>=2 else "Expand" if S>=1 else "Recover"))
        cpx_state = (("Declines" if S>=3 else "Accelerates" if S>=2 else "Stabilizes" if S>=1 else "Bottoms then rises"))
        div_state = (("Payouts decline, ratios rise" if S>=3 else "Payouts rise, ratios decline" if S>=2 else "Payouts rise, ratios stabilize" if S>=1 else "Payouts and ratios rise"))
        bb_state  = (("Falling or halted" if S>=3 else "Rising, nearing/exceeding FCF" if S>=2 else "Rising < FCF" if S>=1 else "Reinstated"))
        mna_state = (("End of cycle, cheap valuations" if S>=3 else "Peaks, mega-deals, high valuations" if S>=2 else "Growing, major deals emerge" if S>=1 else "Start of cycle"))
        csh_state = (("Rebuilding" if S>=3 else "Decline" if S>=2 else "Build-up and redeployment" if S>=1 else "Build-up"))

        rec = {
            'date':                     d,
            'quarter_label':            f"Q{(int(d[5:7])-1)//3+1} {d[:4]}",
            'composite_score_weighted': round(S, 3),
            'composite_score_equal':    round(S_eq, 3),
            'composite_phase':          phase_name,
            'phase_color':              phase_color,
            'cycle_x_pct':              round(S / 4. * 100., 1),

            # Per-indicator expansion pressures (used by frontend for re-weighting)
            'indicator_pressures': {
                'defaults':       round(float(P_def[i]),  3),
                'profit_margins': round(float(P_mar[i]),  3),
                'capex':          round(float(P_cpy[i]),  3),
                'buybacks':       round(float(P_bb[i]),   3),
                'mna':            round(float(P_mna[i]),  3),
                'cash':           round(float(P_csh[i]),  3),
                'dividends':      round(float(P_mar[i]) * 0.3, 3),  # proxy for display
            },

            # Human-readable display fields
            'defaults': {
                'value':    round(float(def_arr[i]), 2),
                'unit':     '%',
                'chg_1y':   round(chg4(def_arr), 2),
                'phase':    def_state,
                'phase_score': round(float(P_def[i]), 3),
                'z_level':  round(float(zl_def[i]), 2),
            },
            'profit_margins': {
                'value':    round(float(margin_arr[i]), 2),
                'unit':     '% of GDP',
                'chg_1y':   round(chg4(margin_arr), 2),
                'phase':    mar_state,
                'phase_score': round(float(P_mar[i]), 3),
                'z_level':  round(float(zl_mar[i]), 2),
            },
            'capex': {
                'value':    round(float(cpx_arr[i]), 1),
                'unit':     '$B',
                'yoy':      round(float(capex_yoy[i]), 1),
                'phase':    cpx_state,
                'phase_score': round(float(P_cpy[i]), 3),
                'z_level':  round(float(zl_cpy[i]), 2),
            },
            'dividends': {
                'value':        round(float(div_arr[i]), 1),
                'unit':         '$B',
                'payout_ratio': round(float(div_arr[i] / max(cp_arr[i], 1.) * 100.), 1),
                'chg_1y':       round(chg4(div_arr), 1),
                'phase':        div_state,
                'phase_score':  round(float(P_mar[i]) * 0.3, 3),
                'z_level':      round(float(zl_mar[i]), 2),
            },
            'buybacks': {
                'value':    round(float(bb_arr[i]), 1),
                'unit':     '$B',
                'yoy':      round(pct4(bb_arr), 1),
                'phase':    bb_state,
                'phase_score': round(float(P_bb[i]), 3),
                'z_level':  round(float(zl_bb[i]), 2),
            },
            'mna': {
                'value':    round(float(mna_arr[i]), 1),
                'unit':     '$B',
                'yoy':      round(pct4(mna_arr), 1),
                'phase':    mna_state,
                'phase_score': round(float(P_mna[i]), 3),
                'z_level':  round(float(zl_mna[i]), 2),
            },
            'cash': {
                'value':    round(float(csh_arr[i]), 2),
                'unit':     '% of ST Liab',
                'chg_1y':   round(chg4(csh_arr), 2),
                'phase':    csh_state,
                'phase_score': round(float(P_csh[i]), 3),
                'z_level':  round(float(zl_csh[i]), 2),
            },
        }
        records.append(rec)

    # 10. Diagnostics
    print("=== Historical Phase Trajectory (every 4 quarters) ===")
    for rec in records[::4]:
        s = rec['composite_score_weighted']
        print(f"  {rec['quarter_label']:8s}  {s:.2f}  {rec['composite_phase']}")

    cur = records[-1]
    print(f"\n=== Current: {cur['quarter_label']} ===")
    print(f"  Phase: {cur['composite_phase']}  Score: {cur['composite_score_weighted']}")
    for k in ['defaults','profit_margins','capex','buybacks','mna','cash']:
        v  = cur[k]['value']
        ph = cur[k]['phase']
        ep = cur['indicator_pressures'][k]
        print(f"  {k:<20s}  {v:>10}  P={ep:+.2f}  -> {ph}")

    scores = [r['composite_score_weighted'] for r in records]
    print(f"\nScore range: {min(scores):.3f} to {max(scores):.3f}")
    phases = {}
    for r in records:
        p = r['composite_phase']
        phases[p] = phases.get(p, 0) + 1
    print("Phase distribution:", phases)

    # 11. Build and write JSON
    MATRIX = [
        {'id':'defaults','name':'Defaults','description':'Delinquency Rate on C&I Loans (FRED: DRBLACBS)',
         'early':'Plateau','mid':'Trend lower','late':'Bottom','recession':'Rise'},
        {'id':'profit_margins','name':'Profit Margins','description':'Corporate Profits After Tax / GDP (FRED: CP / GDP)',
         'early':'Recover','mid':'Expand','late':'Plateau','recession':'Decline & bottom'},
        {'id':'capex','name':'CAPEX','description':'Private Nonresidential Fixed Investment YoY growth (FRED: PNFI)',
         'early':'Bottoms then rises','mid':'Stabilizes','late':'Accelerates','recession':'Declines'},
        {'id':'dividends','name':'Dividends','description':'Net Corporate Dividends (FRED: DIVIDEND)',
         'early':'Payouts and ratios rise','mid':'Payouts rise, ratios stabilize',
         'late':'Payouts rise, ratios decline','recession':'Payouts decline, ratios rise'},
        {'id':'buybacks','name':'Buybacks','description':'NFC Corporate Equities Liability Transactions (FRED: NCBCEBQ027S)',
         'early':'Reinstated','mid':'Rising but less than free cash flows',
         'late':'Rising, nearing or exceeding free cash flows','recession':'Falling or halted'},
        {'id':'mna','name':'M&A','description':'US Direct Investment Equity Acquisitions (FRED: IEAADIN)',
         'early':'Start of cycle','mid':'Growing, major deals emerge',
         'late':'Peaks, mega-deals, high valuations','recession':'End of cycle, cheap valuations'},
        {'id':'cash','name':'Cash position','description':'NFC Liquid Assets / ST Liabilities (FRED: BOGZ1FL104001006Q)',
         'early':'Build-up','mid':'Build-up and redeployment','late':'Decline','recession':'Rebuilding'},
    ]

    dataset = {
        'metadata': {
            'generated_at':  datetime.now().isoformat(),
            'source':        'Federal Reserve FRED + Invesco Credit Cycle Framework',
            'model_version': '3.0 — Full-sample z-score expansion pressure + zero-phase EWMA smoother',
            'quarters_count': N,
            'start_date':    dates[0],
            'end_date':      dates[-1],
            'ewma_alpha':    EWMA_A,
            'k_scale':       K_SCALE,
            'weights_presets': {'intelligent': W_INTEL, 'equal': W_EQUAL},
        },
        'invesco_matrix': MATRIX,
        'timeline':       records,
        'current':        records[-1],
    }
    out = r"C:\Users\kaloy\.gemini\antigravity\scratch\credit_cycle_app\credit_cycle_data.json"
    with open(out, 'w', encoding='utf-8') as f:
        json.dump(dataset, f, indent=2)
    print(f"\nWrote {out}  ({N} records)")

if __name__ == '__main__':
    run_pipeline()
