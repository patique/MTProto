import re
import sys

if hasattr(sys.stdout, 'reconfigure'):
    sys.stdout.reconfigure(encoding='utf-8')

log_path = r'C:\Users\Administrator\AppData\Roaming\MetaQuotes\Tester\E2324ECEF25C65C6B755A51F1CF36F86\Agent-127.0.0.1-3001\logs\20261011.log'

with open(log_path, 'r', encoding='utf-16le', errors='ignore') as f:
    lines = f.readlines()

# Buscar la última sesión de testing
last_session = []
for i in range(len(lines)-1, -1, -1):
    l = lines[i]
    last_session.append(l)
    if 'visual testing of' in l or 'test Experts' in l or 'ticks data begins' in l:
        break
last_session.reverse()

# Extraer todos los ciclos cerrados
cycles = []
for l in last_session:
    if 'TP Cesta' in l:
        # Ejemplo: Ciclo #12 cerrado | Órdenes: 3 | Lotes: 0.07 | Profit: $4.50
        m = re.search(r'Ciclo #(\d+).*?(\d+)\s*\|.*?Lotes:\s*([\d\.]+).*?Profit:\s*\$([\d\.-]+)', l)
        if m:
            cycles.append({
                'id': int(m.group(1)),
                'orders': int(m.group(2)),
                'lots': float(m.group(3)),
                'profit': float(m.group(4))
            })
        else:
            # Buscar numero de ordenes de forma simple
            m_ord = re.search(r'(\d+)\s*orden', l, re.IGNORECASE) or re.search(r':\s*(\d+)\s*\|', l)
            if m_ord:
                num_ord = int(m_ord.group(1))
                cycles.append({'orders': num_ord})

print(f"Total ciclos ganados en esta sesión: {len(cycles)}")

if len(cycles) > 0:
    order_counts = [c.get('orders', 1) for c in cycles]
    
    c1 = order_counts.count(1)
    c2 = order_counts.count(2)
    c3 = order_counts.count(3)
    c4 = order_counts.count(4)
    c5_plus = sum(1 for x in order_counts if x >= 5)

    print("\n--- DISTRIBUCIÓN POR NÚMERO DE RE-ENTRADAS ---")
    print(f"• 1 sola orden (Cierre directo a TP en segundos, DD < 1%): {c1} veces ({c1/len(cycles)*100:.1f}%)")
    print(f"• 2 órdenes (Micro-retroceso de 1$, DD flotante ~1-3%):    {c2} veces ({c2/len(cycles)*100:.1f}%)")
    print(f"• 3 órdenes (Retroceso de 2$, DD flotante ~5-8%):          {c3} veces ({c3/len(cycles)*100:.1f}%)")
    print(f"• 4 órdenes (Retroceso de 3$, DD flotante ~10-18%):        {c4} veces ({c4/len(cycles)*100:.1f}%)")
    print(f"• 5 o más órdenes (Retroceso > 4$, DD flotante > 20%):     {c5_plus} veces ({c5_plus/len(cycles)*100:.1f}%)")

    dd_10_20 = c4
    dd_gt_20 = c5_plus
    dd_gt_10 = c4 + c5_plus

    print("\n--- RESPUESTA A TU PREGUNTA ---")
    print(f"Veces con Drawdown entre 10% y 20%: {dd_10_20} veces ({dd_10_20/len(cycles)*100:.1f}%)")
    print(f"Veces con Drawdown mayor al 20%:    {dd_gt_20} veces ({dd_gt_20/len(cycles)*100:.1f}%)")
    print(f"Total veces que el flotante superó el 10%: {dd_gt_10} de {len(cycles)} ciclos ({dd_gt_10/len(cycles)*100:.1f}%)")
