import numpy as np, json

d = json.load(open('credit_cycle_data.json'))
W = {'defaults':0.20,'profit_margins':0.15,'capex':0.15,'cash':0.15,'buybacks':0.125,'mna':0.125,'dividends':0.10}
total_w = sum(W.values())

targets = ['Q2 2009','Q3 2009','Q4 2009','Q1 2010','Q2 2010','Q3 2010','Q4 2010']
for rec in d['timeline']:
    ql = rec['quarter_label']
    if ql in targets:
        ip = rec['indicator_pressures']
        p = sum(W[k]*ip[k] for k in W)/total_w
        raw_s = 2.0 + 2.0 * np.tanh(1.15 * p)
        print(ql, 'P=', round(p,3), 'rawScore=', round(raw_s,2))
        for k,v in ip.items():
            print(f'  {k:<20s} {v:+.2f}')
