"""
Credit Cycle Data Harvester v4 — Phase-Plane + Circular EWMA Model
====================================================================
Core innovation: split each indicator into two INDEPENDENT signals:
  H  (economic health level)    = sign_i × clip(z_level_i, -3, 3)
  M  (rate-of-change momentum)  = sign_i × tanh(z_mom_i)

Map composite (H, M) to a PHASE PLANE ANGLE via atan2:
  ─────────────────────────────────────────
  Quadrant / Condition         → Score range
  ─────────────────────────────────────────
  H>0, M>0  (good & improving) → Mid [1, 2)
  H>0, M<0  (good, decelerating)→ Late [2, 3)
  H<0, M<0  (bad & worsening)  → Recession [3, 4)
  H<0, M>0  (bad but improving) → Early [0, 1)
  ─────────────────────────────────────────

Formula: score = (π − atan2(M, H)) mod 2π / 2π × 4

Smooth with CIRCULAR zero-phase EWMA (cos/sin averaging) to handle the
discontinuous Recession→Early wrap-around without aliasing.

Data: 1980 Q1 → 2026 Q3.  Missing early series get z = 0 (neutral).
"""

import subprocess, csv, json, math
from datetime import datetime
import numpy as np

SERIES_MAP = {
    'defaults':  'DRBLACBS',         # C&I delinquency rate (starts ~1987 Q4)
    'profits':   'CP',               # Corporate profits after tax
    'gdp':       'GDP',
    'capex':     'PNFI',             # Private nonresidential fixed investment
    'dividends': 'DIVIDEND',
    'buybacks':  'NCBCEBQ027S',      # NFC equity liabilities (retirements)
    'mna':       'IEAADIN',          # US direct-investment equity acquisitions (~2000+)
    'cash':      'BOGZ1FL104001006Q' # NFC liquid assets / ST liabilities
}

# ── Sign convention: +1 = higher value → more expansionary ──────────────────
SIGN = {
    'defaults':       -1,   # High defaults → recession
    'profit_margins': +1,   # High margins → expansion
    'capex_yoy':      +1,
    'buybacks':       +1,
    'mna':            +1,
    'cash_ratio':     -1,   # High cash = hoarding → early/recession
}

# ── Intelligent weights ──────────────────────────────────────────────────────
W_INTEL = dict(defaults=0.22, profit_margins=0.18, capex=0.17,
               cash=0.15, buybacks=0.14, mna=0.14)
W_EQUAL = {k: round(1/len(W_INTEL), 4) for k in W_INTEL}

# ── Phase-plane scale factors ────────────────────────────────────────────────
H_SCALE = 1.40   # amplify level signal
M_SCALE = 1.10   # amplify momentum signal
EWMA_A  = 0.50   # forward-backward EWMA alpha

DATE_START = "1980-01-01"
DATE_END   = "2026-07-01"

# ── NBER US recession dates ───────────────────────────────────────────────────
NBER_RECESSIONS = [
    {"start": "1980-01-01", "end": "1980-07-01", "label": "1980"},
    {"start": "1981-07-01", "end": "1982-10-01", "label": "1981–82"},
    {"start": "1990-07-01", "end": "1991-01-01", "label": "1990–91"},
    {"start": "2001-01-01", "end": "2001-10-01", "label": "2001"},
    {"start": "2007-10-01", "end": "2009-04-01", "label": "GFC 2008–09"},
    {"start": "2020-01-01", "end": "2020-04-01", "label": "COVID 2020"},
]

# ─────────────────────────────────────────────────────────────────────────────
def fetch_fred(sid):
    url = f"https://fred.stlouisfed.org/graph/fredgraph.csv?id={sid}"
    print(f"  {sid} ...", end=" ")
    res = subprocess.run(["curl.exe", "-s", url], capture_output=True, text=True)
    data = {}
    if res.returncode != 0:
        print("FAILED"); return data
    for row in csv.reader(res.stdout.strip().split("\n")[1:]):
        if len(row) >= 2 and row[1] not in ('.', '', 'NA'):
            try:
                data[row[0].strip()] = float(row[1].strip())
            except ValueError:
                pass
    print(f"{len(data)} obs"); return data

def fetch_sp500_quarterly():
    """Fetch monthly S&P 500 price history back to 1980 from datasets/s-and-p-500."""
    url = "https://raw.githubusercontent.com/datasets/s-and-p-500/main/data/data.csv"
    print("  S&P 500 history ...", end=" ")
    res = subprocess.run(["curl.exe", "-s", url], capture_output=True, text=True)
    data = {}
    if res.returncode != 0:
        print("FAILED"); return data
    for row in csv.reader(res.stdout.strip().split("\n")[1:]):
        if len(row) >= 2 and row[1] not in ('.', '', 'NA'):
            try:
                data[row[0].strip()] = round(float(row[1].strip()), 2)
            except ValueError:
                pass
    print(f"{len(data)} obs")
    return data

def full_zscore(arr):
    """Z-score over full sample."""
    a = np.asarray(arr, float)
    mu, sd = a.mean(), a.std(ddof=0)
    return (a - mu) / max(sd, 1e-12)

def lag_diff_zscore(arr, lag=4):
    """Z-score of lag-differenced series (momentum signal)."""
    a = np.asarray(arr, float)
    mom = np.array([a[i] - a[max(0, i - lag)] for i in range(len(a))])
    return full_zscore(mom)

def circular_fbewma(raw_scores, alpha):
    """
    Zero-phase circular EWMA smoother.
    Converts scores → angles → cos/sin → EWMA forward → EWMA backward → angles → scores.
    Handles the 0↔4 wrap-around boundary correctly.
    """
    angles  = raw_scores / 4.0 * 2.0 * np.pi
    cos_arr = np.cos(angles)
    sin_arr = np.sin(angles)

    def fwd(a):
        o = np.empty_like(a); o[0] = a[0]
        for i in range(1, len(a)):
            o[i] = alpha * a[i] + (1 - alpha) * o[i-1]
        return o

    def bwd(a):
        o = np.empty_like(a); o[-1] = a[-1]
        for i in range(len(a)-2, -1, -1):
            o[i] = alpha * a[i] + (1 - alpha) * o[i+1]
        return o

    cos_s = bwd(fwd(cos_arr))
    sin_s = bwd(fwd(sin_arr))
    ang_s = np.arctan2(sin_s, cos_s) % (2.0 * np.pi)
    return np.clip(ang_s / (2.0 * np.pi) * 4.0, 0.0, 4.0)

def pp_score(H, M):
    """Phase-plane score ∈ [0, 4] from health (H) and momentum (M) in [-1, 1]."""
    theta = math.atan2(M, H)
    clock = (math.pi - theta) % (2.0 * math.pi)
    return clock / (2.0 * math.pi) * 4.0

def score_to_phase(s):
    if s < 1.0: return "Early cycle",  "#0284c7"
    if s < 2.0: return "Mid-cycle",    "#0d9488"
    if s < 3.0: return "Late cycle",   "#16a34a"
    return             "Recession",    "#9333ea"

# ─────────────────────────────────────────────────────────────────────────────
def run_pipeline():
    print("=== Credit Cycle Pipeline v4 (Phase-Plane) ===\n")
    print("Fetching FRED:")
    raw = {k: fetch_fred(v) for k, v in SERIES_MAP.items()}
    sp500_raw = fetch_sp500_quarterly()
    print()

    # ── Quarterly date grid ──────────────────────────────────────────────────
    dates = [f"{y}-{m:02d}-01"
             for y in range(1980, 2027)
             for m in [1, 4, 7, 10]
             if DATE_START <= f"{y}-{m:02d}-01" <= DATE_END]
    N = len(dates)
    print(f"Grid: {dates[0]} -> {dates[-1]}  ({N} quarters)\n")

    # ── Carry-forward fill for each raw series ───────────────────────────────
    def build(key, fallback):
        arr = np.zeros(N); prev = fallback
        for i, d in enumerate(dates):
            v = raw[key].get(d, None)
            if v is not None: prev = v
            arr[i] = prev
        return arr

    def_arr  = build('defaults',  1.3)   # DRBLACBS: valid ~1987 Q4 onward
    cp_arr   = build('profits',   2000.)
    gdp_arr  = build('gdp',       10000.)
    cpx_arr  = build('capex',     1000.)
    div_arr  = build('dividends', 400.)
    bb_arr   = np.abs(build('buybacks', 50000.)) / 1000.    # $B
    mna_arr  = build('mna',       40000.) / 1000.            # $B
    csh_arr  = build('cash',      90.)

    sp500_arr = np.zeros(N)
    prev_sp = 110.9
    for i, d in enumerate(dates):
        v = sp500_raw.get(d, None)
        if v is not None: prev_sp = v
        sp500_arr[i] = prev_sp

    # Find when each series actually starts (has real data from FRED)
    def first_date(key):
        dates_in_fred = sorted(raw[key].keys())
        return dates_in_fred[0] if dates_in_fred else "2099-01-01"

    def_start  = first_date('defaults')   # ~1987-10-01
    mna_start  = first_date('mna')        # ~2000-01-01

    # ── Derived series ───────────────────────────────────────────────────────
    margin_arr = cp_arr / np.maximum(gdp_arr, 1.0) * 100.0
    capex_yoy  = np.zeros(N)
    for i in range(N):
        p = max(0, i - 4)
        capex_yoy[i] = (cpx_arr[i] - cpx_arr[p]) / max(cpx_arr[p], 1.) * 100.

    # ── Full-sample z-scores (computed over available portion only) ──────────
    # For indicators with limited history, compute z over their live window,
    # set z = 0 before they are available.

    def safe_zscore(arr, avail_from_date):
        """z-score the array, but only using data from avail_from_date onward;
           before that date return 0.0."""
        avail_mask = np.array([d >= avail_from_date for d in dates], dtype=float)
        out = np.zeros(N)
        idx = np.where(avail_mask)[0]
        if len(idx) < 4:
            return out
        sub = arr[idx]
        mu, sd = sub.mean(), sub.std(ddof=0)
        if sd < 1e-12:
            return out
        for i in idx:
            out[i] = (arr[i] - mu) / sd
        return out

    zl_def  = safe_zscore(def_arr,    def_start)
    zl_mar  = full_zscore(margin_arr)
    zl_cpy  = full_zscore(capex_yoy)
    zl_bb   = safe_zscore(bb_arr,     dates[0])   # buybacks: available all the way back
    zl_mna  = safe_zscore(mna_arr,    mna_start)
    zl_csh  = full_zscore(csh_arr)

    zm_def  = safe_zscore(lag_diff_zscore(def_arr),    def_start)
    zm_mar  = full_zscore(lag_diff_zscore(margin_arr))
    zm_cpy  = full_zscore(lag_diff_zscore(capex_yoy, lag=2))
    zm_bb   = safe_zscore(lag_diff_zscore(bb_arr),     dates[0])
    zm_mna  = safe_zscore(lag_diff_zscore(mna_arr),    mna_start)
    zm_csh  = full_zscore(lag_diff_zscore(csh_arr))

    # ── Per-indicator level and momentum pressures ───────────────────────────
    S = SIGN
    def lp(z, sign): return sign * np.clip(z, -3.0, 3.0)   # level pressure
    def mp(z, sign): return sign * np.tanh(z)               # momentum pressure

    lp_def = lp(zl_def,  S['defaults'])
    lp_mar = lp(zl_mar,  S['profit_margins'])
    lp_cpy = lp(zl_cpy,  S['capex_yoy'])
    lp_bb  = lp(zl_bb,   S['buybacks'])
    lp_mna = lp(zl_mna,  S['mna'])
    lp_csh = lp(zl_csh,  S['cash_ratio'])

    mp_def = mp(zm_def,  S['defaults'])
    mp_mar = mp(zm_mar,  S['profit_margins'])
    mp_cpy = mp(zm_cpy,  S['capex_yoy'])
    mp_bb  = mp(zm_bb,   S['buybacks'])
    mp_mna = mp(zm_mna,  S['mna'])
    mp_csh = mp(zm_csh,  S['cash_ratio'])

    # key order must match W_INTEL
    lp_map = dict(defaults=lp_def, profit_margins=lp_mar, capex=lp_cpy,
                  cash=lp_csh, buybacks=lp_bb, mna=lp_mna)
    mp_map = dict(defaults=mp_def, profit_margins=mp_mar, capex=mp_cpy,
                  cash=mp_csh, buybacks=mp_bb, mna=mp_mna)

    def composite(weight_dict):
        tw = sum(weight_dict.values())
        PL = sum((weight_dict[k] / tw) * lp_map[k] for k in weight_dict)
        PM = sum((weight_dict[k] / tw) * mp_map[k] for k in weight_dict)
        return PL, PM

    PL_intel, PM_intel = composite(W_INTEL)
    PL_equal, PM_equal = composite(W_EQUAL)

    def scores_from_PL_PM(PL, PM):
        raw = np.array([
            pp_score(math.tanh(H_SCALE * float(PL[i])),
                     math.tanh(M_SCALE * float(PM[i])))
            for i in range(N)
        ])
        return circular_fbewma(raw, EWMA_A)

    S_intel = scores_from_PL_PM(PL_intel, PM_intel)
    S_equal = scores_from_PL_PM(PL_equal, PM_equal)

    # ── Diagnostics ──────────────────────────────────────────────────────────
    labels = [f"Q{(int(d[5:7])-1)//3+1} {d[:4]}" for d in dates]
    print("=== Phase Trajectory (every 4 quarters) ===")
    for i in range(0, N, 4):
        s = S_intel[i]
        bar = '#' * int(s * 8) + '.' * max(0, 32 - int(s * 8))
        ph = score_to_phase(s)[0]
        print(f"  {labels[i]:8s}  {s:.2f}  |{bar}| {ph}")
    print()

    cur_s = S_intel[-1]
    print(f"CURRENT  {labels[-1]}  Score={cur_s:.3f}  {score_to_phase(cur_s)[0]}")
    scores_arr = list(S_intel)
    print(f"Score range: {min(scores_arr):.2f} -> {max(scores_arr):.2f}")
    ph_counts = {}
    for s in scores_arr:
        ph = score_to_phase(s)[0]
        ph_counts[ph] = ph_counts.get(ph, 0) + 1
    print("Phase distribution:", ph_counts)

    # ── Assemble records ──────────────────────────────────────────────────────
    records = []
    for i, d in enumerate(dates):
        S  = float(S_intel[i])
        Sq = float(S_equal[i])
        phase_name, phase_color = score_to_phase(S)

        def c4(a): return float(a[i] - a[max(0, i-4)])
        def p4(a): return float((a[i]-a[max(0,i-4)]) / max(a[max(0,i-4)], 1.) * 100.)

        st_def = "Rise" if S>=3 else "Bottom" if S>=2 else "Trend lower" if S>=1 else "Plateau"
        st_mar = "Decline" if S>=3 else "Plateau" if S>=2 else "Expand" if S>=1 else "Recover"
        st_cpx = "Declines" if S>=3 else "Accelerates" if S>=2 else "Stabilizes" if S>=1 else "Bottoms"
        st_div = "Payouts decline" if S>=3 else "Payouts rise, ratios fall" if S>=2 else "Payouts rise" if S>=1 else "Payouts and ratios rise"
        st_bb  = "Halted" if S>=3 else "Near/above FCF" if S>=2 else "Rising < FCF" if S>=1 else "Reinstated"
        st_mna = "Cheap valuations" if S>=3 else "Mega-deals" if S>=2 else "Growing" if S>=1 else "Starting"
        st_csh = "Rebuilding" if S>=3 else "Declining" if S>=2 else "Redeploying" if S>=1 else "Building"

        has_def = d >= def_start
        has_mna = d >= mna_start

        rec = {
            'date':         d,
            'quarter_label': f"Q{(int(d[5:7])-1)//3+1} {d[:4]}",
            'composite_score_weighted': round(S,  3),
            'composite_score_equal':    round(Sq, 3),
            'composite_phase':  phase_name,
            'phase_color':      phase_color,
            'cycle_x_pct':      round(S / 4. * 100., 1),
            'sp500':            round(float(sp500_arr[i]), 2),

            # Per-indicator level + momentum for frontend re-weighting
            'indicator_components': {
                'defaults':       {'level': round(float(lp_def[i]),3), 'mom': round(float(mp_def[i]),3), 'available': has_def},
                'profit_margins': {'level': round(float(lp_mar[i]),3), 'mom': round(float(mp_mar[i]),3), 'available': True},
                'capex':          {'level': round(float(lp_cpy[i]),3), 'mom': round(float(mp_cpy[i]),3), 'available': True},
                'cash':           {'level': round(float(lp_csh[i]),3), 'mom': round(float(mp_csh[i]),3), 'available': True},
                'buybacks':       {'level': round(float(lp_bb[i]), 3), 'mom': round(float(mp_bb[i]), 3), 'available': True},
                'mna':            {'level': round(float(lp_mna[i]),3), 'mom': round(float(mp_mna[i]),3), 'available': has_mna},
            },
            # Legacy key kept for display / indicator cards
            'indicator_pressures': {
                'defaults':       round(float(lp_def[i]+mp_def[i])*0.5, 3),
                'profit_margins': round(float(lp_mar[i]+mp_mar[i])*0.5, 3),
                'capex':          round(float(lp_cpy[i]+mp_cpy[i])*0.5, 3),
                'cash':           round(float(lp_csh[i]+mp_csh[i])*0.5, 3),
                'buybacks':       round(float(lp_bb[i]+mp_bb[i])*0.5, 3),
                'mna':            round(float(lp_mna[i]+mp_mna[i])*0.5, 3),
                'dividends':      round(float(lp_mar[i])*0.2, 3),
            },

            'defaults': {
                'value': round(float(def_arr[i]),2), 'unit':'%',
                'chg_1y': round(c4(def_arr),2), 'phase': st_def,
                'phase_score': round(float(lp_def[i]),3),
                'available': has_def,
            },
            'profit_margins': {
                'value': round(float(margin_arr[i]),2), 'unit':'% of GDP',
                'chg_1y': round(c4(margin_arr),2), 'phase': st_mar,
                'phase_score': round(float(lp_mar[i]),3),
            },
            'capex': {
                'value': round(float(cpx_arr[i]),1), 'unit':'$B',
                'yoy': round(float(capex_yoy[i]),1), 'phase': st_cpx,
                'phase_score': round(float(lp_cpy[i]),3),
            },
            'dividends': {
                'value': round(float(div_arr[i]),1), 'unit':'$B',
                'payout_ratio': round(float(div_arr[i]/max(cp_arr[i],1.)*100.),1),
                'chg_1y': round(c4(div_arr),1), 'phase': st_div,
                'phase_score': round(float(lp_mar[i])*0.3,3),
            },
            'buybacks': {
                'value': round(float(bb_arr[i]),1), 'unit':'$B',
                'yoy': round(p4(bb_arr),1), 'phase': st_bb,
                'phase_score': round(float(lp_bb[i]),3),
            },
            'mna': {
                'value': round(float(mna_arr[i]),1), 'unit':'$B',
                'yoy': round(p4(mna_arr),1) if has_mna else 0, 'phase': st_mna,
                'phase_score': round(float(lp_mna[i]),3),
                'available': has_mna,
            },
            'cash': {
                'value': round(float(csh_arr[i]),2), 'unit':'%',
                'chg_1y': round(c4(csh_arr),2), 'phase': st_csh,
                'phase_score': round(float(lp_csh[i]),3),
            },
        }
        records.append(rec)

    MATRIX = [
        {'id':'defaults','name':'Defaults','description':'C&I Loan Delinquency Rate (FRED: DRBLACBS • from 1987)',
         'early':'Plateau','mid':'Trend lower','late':'Bottom','recession':'Rise'},
        {'id':'profit_margins','name':'Profit Margins','description':'Corporate Profits / GDP (FRED: CP / GDP)',
         'early':'Recover','mid':'Expand','late':'Plateau','recession':'Decline'},
        {'id':'capex','name':'CAPEX','description':'Private Nonresidential Fixed Investment YoY (FRED: PNFI)',
         'early':'Bottoms','mid':'Stabilizes','late':'Accelerates','recession':'Declines'},
        {'id':'dividends','name':'Dividends','description':'Net Corporate Dividends (FRED: DIVIDEND)',
         'early':'Payouts and ratios rise','mid':'Payouts rise',
         'late':'Payouts rise, ratios fall','recession':'Payouts decline'},
        {'id':'buybacks','name':'Buybacks','description':'NFC Equity Retirements (FRED: NCBCEBQ027S)',
         'early':'Reinstated','mid':'Rising < FCF','late':'Near/above FCF','recession':'Halted'},
        {'id':'mna','name':'M&A','description':'US Direct Investment Acquisitions (FRED: IEAADIN • from 2000)',
         'early':'Starting','mid':'Growing','late':'Mega-deals','recession':'Cheap valuations'},
        {'id':'cash','name':'Cash','description':'NFC Liquid Assets / ST Liabilities (FRED: BOGZ1FL104001006Q)',
         'early':'Building','mid':'Redeploying','late':'Declining','recession':'Rebuilding'},
    ]

    dataset = {
        'metadata': {
            'generated_at':   datetime.now().isoformat(),
            'model_version':  '4.0 — Phase-Plane + Circular EWMA',
            'source':         'Federal Reserve FRED • Invesco Framework',
            'quarters_count': N,
            'start_date':     dates[0],
            'end_date':       dates[-1],
            'h_scale':        H_SCALE,
            'm_scale':        M_SCALE,
            'ewma_alpha':     EWMA_A,
            'weights_presets': {'intelligent': W_INTEL, 'equal': W_EQUAL},
            'nber_recessions': NBER_RECESSIONS,
            'data_notes': {
                'defaults': f'Available from {def_start}; z=0 before that date',
                'mna':      f'Available from {mna_start}; z=0 before that date',
            }
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
