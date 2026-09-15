import json
d = json.load(open('credit_cycle_data.json'))
print('=== ALL 91 QUARTERS ===')
for rec in d['timeline']:
    s = rec['composite_score_weighted']
    p = rec['composite_phase']
    filled = int(s * 10)
    bar = '|' + '#'*filled + '.'*(40-filled) + '|'
    ql = rec['quarter_label']
    print(f'{ql:8s}  {s:.2f}  {bar} {p}')
