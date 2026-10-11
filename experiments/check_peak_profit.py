import sys
import re

if hasattr(sys.stdout, 'reconfigure'):
    sys.stdout.reconfigure(encoding='utf-8')

log_path = r'C:\Users\Administrator\AppData\Roaming\MetaQuotes\Tester\E2324ECEF25C65C6B755A51F1CF36F86\Agent-127.0.0.1-3001\logs\20261011.log'

with open(log_path, 'r', encoding='utf-16le', errors='ignore') as f:
    lines = f.readlines()

run = [l for l in lines if '03:52:' in l or '03:53:' in l or '03:54:' in l or '03:55:' in l]
profits = []
for l in run:
    if 'TP Cesta Alcanzado' in l:
        m = re.search(r'Profit:\s*\$([\d\.-]+)', l)
        if m:
            profits.append(float(m.group(1)))

print(f"Total ciclos ganados en el mes: {len(profits):,}")
total_profit = sum(profits)
print(f"Beneficio acumulado: +${total_profit:,.2f} USD")
print(f"Balance pico alcanzado: ${100.0 + total_profit:,.2f} USD")
print(f"Multiplicador conseguido: {(100.0 + total_profit)/100.0:.1f}x")
