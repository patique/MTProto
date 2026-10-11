import sys
import re
from collections import Counter

if hasattr(sys.stdout, 'reconfigure'):
    sys.stdout.reconfigure(encoding='utf-8')

log_path = r'C:\Users\Administrator\AppData\Roaming\MetaQuotes\Tester\E2324ECEF25C65C6B755A51F1CF36F86\Agent-127.0.0.1-3001\logs\20261011.log'

with open(log_path, 'r', encoding='utf-16le', errors='ignore') as f:
    lines = f.readlines()

# Tomar las líneas de la última ejecución (02:57 - 02:58)
run_lines = [l for l in lines if ('02:57:' in l or '02:58:' in l) and 'EA_XAUUSD_Burst_Scalper_1762' in l]

cycles = []
for l in run_lines:
    if 'TP Cesta Alcanzado' in l:
        m_ord = re.search(r'Órdenes:\s*(\d+)', l)
        m_id = re.search(r'Ciclo #(\d+)', l)
        m_prof = re.search(r'Profit:\s*\$([\d\.-]+)', l)
        m_lots = re.search(r'Lotes:\s*([\d\.]+)', l)
        if m_ord:
            cycles.append({
                'id': int(m_id.group(1)) if m_id else len(cycles)+1,
                'orders': int(m_ord.group(1)),
                'lots': float(m_lots.group(1)) if m_lots else 0.0,
                'profit': float(m_prof.group(1)) if m_prof else 0.0
            })

print(f"Total ciclos cerrados con éxito en la sesión: {len(cycles)}")

order_counts = [c['orders'] for c in cycles]
c = Counter(order_counts)

print("\n--- DISTRIBUCIÓN EXACTA POR NÚMERO DE ÓRDENES ---")
for k in sorted(c.keys()):
    print(f"  • {k} orden(es): {c[k]} veces ({c[k]/len(cycles)*100:.1f}%)")

# Análisis de flotante y Drawdown:
# En una cuenta que empezó en 100$:
# 1 orden: 0.01 lote -> Flotante < $1 (< 1% de la cuenta)
# 2 órdenes: 0.01 + 0.02 (1$ de caída) -> Flotante máximo en retroceso: ~$1.5 a $2.5 (~1.5% a 2.5%)
# 3 órdenes: 0.01 + 0.02 + 0.04 (2$ de caída) -> Flotante máximo en retroceso: ~$5.0 a $7.5 (~5% a 7.5%)
# 4 órdenes: 0.01 + 0.02 + 0.04 + 0.08 (3$ de caída) -> Flotante máximo en retroceso: ~$11.0 a $16.0 (Supera el 10% del balance inicial)
# 5 órdenes: + 0.16 (4$ de caída) -> Flotante máximo en retroceso: ~$26.0 a $38.0 (Supera el 20% del balance inicial)

n_1_2 = c.get(1, 0) + c.get(2, 0)
n_3   = c.get(3, 0)
n_4   = c.get(4, 0)
n_5   = c.get(5, 0)
n_gt5 = sum(c.get(k, 0) for k in c if k > 5)

print("\n=======================================================")
print("📊 INFORME DE DRAWDOWN FLOTANTE (DD)")
print("=======================================================")
print(f"Total de ciclos completados antes del fallo: {len(cycles)} ciclos ganados (+ el ciclo final #44)")
print(f"• Flotante insignificante (< 5% DD) [1 o 2 órdenes]: {n_1_2} veces ({n_1_2/len(cycles)*100:.1f}%)")
print(f"• Flotante moderado (5% a 10% DD)   [3 órdenes]:     {n_3} veces ({n_3/len(cycles)*100:.1f}%)")
print(f"• Flotante entre 10% y 20% DD       [4 órdenes]:     {n_4} veces ({n_4/len(cycles)*100:.1f}%)")
print(f"• Flotante superior al 20% DD       [5 órdenes]:     {n_5 + n_gt5} veces ({(n_5 + n_gt5)/len(cycles)*100:.1f}%)")
print(f"• Ciclo final que causó el Stop Out [Orden 5 rechazada por falta de margen en apertura NY]")
