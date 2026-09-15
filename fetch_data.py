"""
Credit Cycle Data Harvester & Quant Model
Pulls 20 years of macroeconomic and financial indicators from FRED,
calculates derived financial ratios, maps to Invesco Credit Cycle phases,
and generates credit_cycle_data.json.
"""

import subprocess
import csv
import io
import json
import os
import math
from datetime import datetime

SERIES_MAP = {
    'defaults': 'DRBLACBS',
    'hy_spread': 'BAMLH0A0HYM2',
    'profits': 'CP',
    'gdp': 'GDP',
    'capex': 'PNFI',
    'dividends': 'DIVIDEND',
    'buybacks': 'NCBCEBQ027S',
    'mna': 'IEAADIN',
    'cash_ratio': 'BOGZ1FL104001006Q'
}

def fetch_fred_series(series_id):
    url = f"https://fred.stlouisfed.org/graph/fredgraph.csv?id={series_id}"
    print(f"Fetching {series_id}...")
    res = subprocess.run(["curl.exe", "-s", url], capture_output=True, text=True)
    if res.returncode != 0 or not res.stdout:
        print(f"Failed to fetch {series_id}")
        return {}
    
    data = {}
    lines = res.stdout.strip().split("\n")
    reader = csv.reader(lines)
    header = next(reader, None)
    if not header or len(header) < 2:
        return {}
    
    for row in reader:
        if len(row) >= 2 and row[1] != '.' and row[1] != '':
            try:
                date_str = row[0].strip()
                val = float(row[1].strip())
                data[date_str] = val
            except ValueError:
                continue
    print(f"Loaded {len(data)} observations for {series_id}")
    return data

def run_pipeline():
    raw_series = {}
    for key, sid in SERIES_MAP.items():
        raw_series[key] = fetch_fred_series(sid)
    
    # Build quarter list from 2004-01-01 through 2026-04-01
    quarter_dates = []
    for year in range(2004, 2027):
        for month in [1, 4, 7, 10]:
            d = f"{year}-{month:02d}-01"
            if d <= "2026-07-01":
                quarter_dates.append(d)

    quarterly_records = []
    
    for i, q_date in enumerate(quarter_dates):
        # 1. Defaults: DRBLACBS (Delinquency Rate on C&I Loans)
        def_val = raw_series['defaults'].get(q_date)
        if def_val is None and i > 0:
            def_val = quarterly_records[-1]['defaults']['value']
        elif def_val is None:
            def_val = 1.30

        # 2. Profit Margins: CP / GDP * 100
        cp = raw_series['profits'].get(q_date)
        gdp = raw_series['gdp'].get(q_date)
        if cp is None and i > 0:
            cp = quarterly_records[-1]['_raw_cp']
        if gdp is None and i > 0:
            gdp = quarterly_records[-1]['_raw_gdp']
        if cp is None: cp = 3000.0
        if gdp is None: gdp = 25000.0
        profit_margin = round((cp / gdp) * 100, 2)

        # 3. CAPEX: PNFI ($ Billions)
        capex_val = raw_series['capex'].get(q_date)
        if capex_val is None and i > 0:
            capex_val = quarterly_records[-1]['_raw_capex']
        if capex_val is None: capex_val = 3500.0
        
        # 4. Dividends: Net Corporate Dividends & Payout Ratio (DIVIDEND / CP * 100)
        div_val = raw_series['dividends'].get(q_date)
        if div_val is None and i > 0:
            div_val = quarterly_records[-1]['_raw_div']
        if div_val is None: div_val = 1800.0
        div_payout_ratio = round((div_val / cp) * 100, 1) if cp else 50.0

        # 5. Buybacks: Nonfinancial Corporate Equities Liability Transactions (NCBCEBQ027S)
        buyback_val = raw_series['buybacks'].get(q_date)
        if buyback_val is None and i > 0:
            buyback_val = quarterly_records[-1]['_raw_buyback']
        if buyback_val is None: buyback_val = 200000.0
        buyback_billions = round(abs(buyback_val) / 1000.0, 1)

        # 6. M&A: US Direct Investment Equity Asset Acquisitions (IEAADIN)
        mna_val = raw_series['mna'].get(q_date)
        if mna_val is None and i > 0:
            mna_val = quarterly_records[-1]['_raw_mna']
        if mna_val is None: mna_val = 90000.0
        mna_billions = round(mna_val / 1000.0, 1)

        # 7. Cash Position: Liquid Assets as % of Short-Term Liabilities (BOGZ1FL104001006Q)
        cash_ratio = raw_series['cash_ratio'].get(q_date)
        if cash_ratio is None and i > 0:
            cash_ratio = quarterly_records[-1]['_raw_cash_ratio']
        if cash_ratio is None: cash_ratio = 95.0
        cash_ratio = round(cash_ratio, 2)

        record = {
            'date': q_date,
            'quarter_label': f"Q{(int(q_date[5:7])-1)//3 + 1} {q_date[:4]}",
            '_raw_cp': cp,
            '_raw_gdp': gdp,
            '_raw_capex': capex_val,
            '_raw_div': div_val,
            '_raw_buyback': buyback_val,
            '_raw_mna': mna_val,
            '_raw_cash_ratio': cash_ratio,
            'defaults': {'value': round(def_val, 2), 'unit': '%'},
            'profit_margins': {'value': profit_margin, 'unit': '% of GDP'},
            'capex': {'value': round(capex_val, 1), 'unit': '$B'},
            'dividends': {'value': round(div_val, 1), 'payout_ratio': div_payout_ratio, 'unit': '$B'},
            'buybacks': {'value': buyback_billions, 'unit': '$B'},
            'mna': {'value': mna_billions, 'unit': '$B'},
            'cash': {'value': cash_ratio, 'unit': '% of ST Liab'}
        }
        quarterly_records.append(record)

    # Compute YoY growth rates
    for i in range(len(quarterly_records)):
        rec = quarterly_records[i]
        prev_4 = quarterly_records[i-4] if i >= 4 else quarterly_records[0]

        capex_yoy = ((rec['capex']['value'] - prev_4['capex']['value']) / max(prev_4['capex']['value'], 1.0)) * 100
        rec['capex']['yoy'] = round(capex_yoy, 1)
        rec['defaults']['chg_1y'] = round(rec['defaults']['value'] - prev_4['defaults']['value'], 2)
        rec['profit_margins']['chg_1y'] = round(rec['profit_margins']['value'] - prev_4['profit_margins']['value'], 2)
        bb_yoy = ((rec['buybacks']['value'] - prev_4['buybacks']['value']) / max(prev_4['buybacks']['value'], 1.0)) * 100
        rec['buybacks']['yoy'] = round(bb_yoy, 1)
        mna_yoy = ((rec['mna']['value'] - prev_4['mna']['value']) / max(prev_4['mna']['value'], 1.0)) * 100
        rec['mna']['yoy'] = round(mna_yoy, 1)
        rec['cash']['chg_1y'] = round(rec['cash']['value'] - prev_4['cash']['value'], 2)

    # Rolling percentile & phase scoring
    for i in range(len(quarterly_records)):
        history_window = quarterly_records[max(0, i-40):i+1]
        
        def get_percentile(key, val):
            vals = [h[key]['value'] for h in history_window]
            vals.sort()
            rank = sum(1 for v in vals if v <= val)
            return rank / len(vals)

        rec = quarterly_records[i]
        p_def = get_percentile('defaults', rec['defaults']['value'])
        p_mar = get_percentile('profit_margins', rec['profit_margins']['value'])
        p_cpx = get_percentile('capex', rec['capex']['value'])
        p_cpx_yoy = rec['capex']['yoy']
        p_div_ratio = rec['dividends']['payout_ratio']
        p_bb = get_percentile('buybacks', rec['buybacks']['value'])
        p_mna = get_percentile('mna', rec['mna']['value'])
        p_csh = get_percentile('cash', rec['cash']['value'])
        
        # 1. Defaults
        if rec['defaults']['chg_1y'] > 0.6 or (rec['defaults']['value'] > 3.0 and rec['defaults']['chg_1y'] > 0):
            def_phase = 3.5
            def_state = "Rise"
        elif rec['defaults']['value'] <= 1.5 or p_def < 0.25:
            def_phase = 2.5
            def_state = "Bottom"
        elif rec['defaults']['chg_1y'] < -0.15:
            def_phase = 1.5
            def_state = "Trend lower"
        else:
            def_phase = 0.5
            def_state = "Plateau"
        rec['defaults']['phase'] = def_state
        rec['defaults']['phase_score'] = def_phase

        # 2. Profit Margins
        if rec['profit_margins']['chg_1y'] < -0.6:
            mar_phase = 3.5
            mar_state = "Decline & bottom"
        elif p_mar > 0.65 and abs(rec['profit_margins']['chg_1y']) <= 0.4:
            mar_phase = 2.5
            mar_state = "Plateau"
        elif rec['profit_margins']['chg_1y'] > 0.2 and p_mar > 0.4:
            mar_phase = 1.5
            mar_state = "Expand"
        else:
            mar_phase = 0.5
            mar_state = "Recover"
        rec['profit_margins']['phase'] = mar_state
        rec['profit_margins']['phase_score'] = mar_phase

        # 3. CAPEX
        if p_cpx_yoy < -1.0:
            cpx_phase = 3.5
            cpx_state = "Declines"
        elif p_cpx_yoy > 7.0 or (p_cpx > 0.75 and p_cpx_yoy > 5.0):
            cpx_phase = 2.5
            cpx_state = "Accelerates"
        elif p_cpx_yoy >= 2.5:
            cpx_phase = 1.5
            cpx_state = "Stabilizes"
        else:
            cpx_phase = 0.5
            cpx_state = "Bottoms then rises"
        rec['capex']['phase'] = cpx_state
        rec['capex']['phase_score'] = cpx_phase

        # 4. Dividends
        if rec['profit_margins']['chg_1y'] < -0.5 and p_div_ratio > 65:
            div_phase = 3.5
            div_state = "Payouts decline, ratios rise"
        elif p_div_ratio < 48:
            div_phase = 2.5
            div_state = "Payouts rise, ratios decline"
        elif 48 <= p_div_ratio <= 60:
            div_phase = 1.5
            div_state = "Payouts rise, ratios stabilize"
        else:
            div_phase = 0.5
            div_state = "Payouts and ratios rise"
        rec['dividends']['phase'] = div_state
        rec['dividends']['phase_score'] = div_phase

        # 5. Buybacks
        if rec['buybacks']['yoy'] < -10.0:
            bb_phase = 3.5
            bb_state = "Falling or halted"
        elif p_bb > 0.7 or rec['buybacks']['yoy'] > 15.0:
            bb_phase = 2.5
            bb_state = "Rising, nearing/exceeding FCF"
        elif rec['buybacks']['yoy'] > 0:
            bb_phase = 1.5
            bb_state = "Rising < FCF"
        else:
            bb_phase = 0.5
            bb_state = "Reinstated"
        rec['buybacks']['phase'] = bb_state
        rec['buybacks']['phase_score'] = bb_phase

        # 6. M&A
        if rec['mna']['yoy'] < -15.0:
            mna_phase = 3.5
            mna_state = "End of cycle, cheap valuations"
        elif p_mna > 0.75 or rec['mna']['yoy'] > 20.0:
            mna_phase = 2.5
            mna_state = "Peaks, mega-deals, high valuations"
        elif rec['mna']['yoy'] > 0:
            mna_phase = 1.5
            mna_state = "Growing, major deals emerge"
        else:
            mna_phase = 0.5
            mna_state = "Start of cycle"
        rec['mna']['phase'] = mna_state
        rec['mna']['phase_score'] = mna_phase

        # 7. Cash Position
        if rec['cash']['chg_1y'] < -4.0 or p_csh < 0.3:
            cash_phase = 2.5
            cash_state = "Decline"
        elif rec['defaults']['phase'] == "Rise":
            cash_phase = 3.5
            cash_state = "Rebuilding"
        elif rec['cash']['chg_1y'] > 3.0 and p_csh > 0.6:
            cash_phase = 0.5
            cash_state = "Build-up"
        else:
            cash_phase = 1.5
            cash_state = "Build-up and redeployment"
        rec['cash']['phase'] = cash_state
        rec['cash']['phase_score'] = cash_phase

        # Composite weighted score
        w_intel = {
            'defaults': 0.20,
            'profit_margins': 0.15,
            'capex': 0.15,
            'cash': 0.15,
            'buybacks': 0.125,
            'mna': 0.125,
            'dividends': 0.10
        }
        w_equal = {k: 1.0/7.0 for k in w_intel}

        score_intel = sum(rec[k]['phase_score'] * w_intel[k] for k in w_intel)
        score_equal = sum(rec[k]['phase_score'] * w_equal[k] for k in w_equal)

        rec['composite_score_weighted'] = round(score_intel, 3)
        rec['composite_score_equal'] = round(score_equal, 3)

        rec['cycle_x_pct'] = round((score_intel / 4.0) * 100, 1)

        # Height on hump curve
        if score_intel <= 2.2:
            curve_y = math.sin((score_intel / 2.2) * (math.pi / 2))
        elif score_intel <= 3.0:
            curve_y = math.cos(((score_intel - 2.2) / 0.8) * (math.pi / 3))
        else:
            curve_y = 0.5 - ((score_intel - 3.0) * 0.7)
        rec['cycle_y'] = round(curve_y, 3)

        if score_intel < 1.0:
            composite_phase = "Early cycle"
            phase_color = "#0284c7"
        elif score_intel < 2.0:
            composite_phase = "Mid-cycle"
            phase_color = "#0d9488"
        elif score_intel < 3.0:
            composite_phase = "Late cycle"
            phase_color = "#16a34a"
        else:
            composite_phase = "Recession"
            phase_color = "#9333ea"
        
        rec['composite_phase'] = composite_phase
        rec['phase_color'] = phase_color

        del rec['_raw_cp']
        del rec['_raw_gdp']
        del rec['_raw_capex']
        del rec['_raw_div']
        del rec['_raw_buyback']
        del rec['_raw_mna']
        del rec['_raw_cash_ratio']

    output_path = r"C:\Users\kaloy\.gemini\antigravity\scratch\credit_cycle_app\credit_cycle_data.json"
    dataset = {
        'metadata': {
            'generated_at': datetime.now().isoformat(),
            'source': 'Federal Reserve Economic Data (FRED), Invesco Credit Framework',
            'quarters_count': len(quarterly_records),
            'start_date': quarterly_records[0]['date'],
            'end_date': quarterly_records[-1]['date'],
            'weights_presets': {
                'intelligent': w_intel,
                'equal': {k: round(1.0/7.0, 4) for k in w_intel}
            }
        },
        'invesco_matrix': [
            {
                'id': 'defaults',
                'name': 'Defaults',
                'description': 'Delinquency Rate on Commercial & Industrial Loans, All Commercial Banks (FRED: DRBLACBS)',
                'early': 'Plateau',
                'mid': 'Trend lower',
                'late': 'Bottom',
                'recession': 'Rise'
            },
            {
                'id': 'profit_margins',
                'name': 'Profit Margins',
                'description': 'Corporate Profits After Tax with IVA & CCAdj as % of GDP (FRED: CP / GDP)',
                'early': 'Recover',
                'mid': 'Expand',
                'late': 'Plateau',
                'recession': 'Decline & bottom'
            },
            {
                'id': 'capex',
                'name': 'CAPEX',
                'description': 'Private Nonresidential Fixed Investment (FRED: PNFI), tracks capital expenditure cycles',
                'early': 'Bottoms then rises',
                'mid': 'Stabilizes',
                'late': 'Accelerates',
                'recession': 'Declines'
            },
            {
                'id': 'dividends',
                'name': 'Dividends',
                'description': 'Net Corporate Dividends & Dividend Payout Ratio (FRED: DIVIDEND / CP)',
                'early': 'Payouts and ratios rise',
                'mid': 'Payouts rise, ratios stabilize',
                'late': 'Payouts rise, ratios decline',
                'recession': 'Payouts decline, ratios rise'
            },
            {
                'id': 'buybacks',
                'name': 'Buybacks',
                'description': 'Nonfinancial Corporate Equities Liability Transactions (FRED: NCBCEBQ027S)',
                'early': 'Reinstated',
                'mid': 'Rising but less than free cash flows',
                'late': 'Rising, nearing or exceeding free cash flows',
                'recession': 'Falling or halted'
            },
            {
                'id': 'mna',
                'name': 'M&A',
                'description': 'US Direct Investment Equity Acquisitions / Corporate M&A (FRED: IEAADIN)',
                'early': 'Start of cycle',
                'mid': 'Growing, major deals emerge',
                'late': 'Peaks, mega-deals, high valuations',
                'recession': 'End of cycle, cheap valuations'
            },
            {
                'id': 'cash',
                'name': 'Cash position',
                'description': 'Corporate Liquid Assets as % of Short-Term Liabilities (FRED: BOGZ1FL104001006Q)',
                'early': 'Build-up',
                'mid': 'Build-up and redeployment',
                'late': 'Decline',
                'recession': 'Rebuilding'
            }
        ],
        'timeline': quarterly_records,
        'current': quarterly_records[-1]
    }

    with open(output_path, 'w', encoding='utf-8') as f:
        json.dump(dataset, f, indent=2)

    print(f"Successfully generated {output_path} with {len(quarterly_records)} quarters!")
    print(f"Latest period: {dataset['current']['quarter_label']}")
    print(f"Current Phase: {dataset['current']['composite_phase']} (Score: {dataset['current']['composite_score_weighted']})")
    print(f"Indicators status:")
    for k in ['defaults', 'profit_margins', 'capex', 'dividends', 'buybacks', 'mna', 'cash']:
        print(f"  - {k.capitalize()}: {dataset['current'][k]['value']} ({dataset['current'][k]['phase']})")

if __name__ == '__main__':
    run_pipeline()
