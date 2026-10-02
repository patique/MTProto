import json
import urllib.request
from datetime import datetime

# 1. Descargar velas de 5m de Oro (PAXGUSDT) para hoy
url = 'https://api.binance.com/api/v3/klines?symbol=PAXGUSDT&interval=5m&limit=288'
req = urllib.request.Request(url, headers={'User-Agent': 'Mozilla/5.0'})
with urllib.request.urlopen(req) as resp:
    raw_candles = json.loads(resp.read().decode())

candles = []
for c in raw_candles:
    candles.append({
        'time': int(c[0]),
        'open': float(c[1]),
        'high': float(c[2]),
        'low': float(c[3]),
        'close': float(c[4])
    })

# 2. Cargar señales de hoy desde analytics_data.json
with open('analytics_data.json') as f:
    analytics = json.load(f)

signals = []
for ch_id, ch in analytics.items():
    if ch_id == 'MT5_AUTO':
        continue
    ch_name = ch.get('channelName', 'Canal')
    for s in ch.get('lastSignals', []):
        ts = s.get('timestamp', 0)
        # Filtrar señales de hoy 25 sept (timestamp > 1790294400000 = ~02:00 AM)
        if ts > 1790294400000 and s.get('entry') and s.get('sl'):
            signals.append({
                'channel': ch_name,
                'channelId': ch_id,
                'id': s.get('id'),
                'timeStr': s.get('timeStr'),
                'timestamp': ts,
                'action': s.get('action'),
                'entry': float(s.get('entry')),
                'sl': float(s.get('sl')),
                'tp': float(s.get('tp')) if s.get('tp') else None
            })

# Ordenar señales cronológicamente
signals.sort(key=lambda x: x['timestamp'])

print(f"========================================================================================")
print(f"📊 AUDITORÍA EXHAUSTIVA DE SEÑALES DE HOY (25 SEPTIEMBRE 2026) | IMPACTO DE BREAK-EVEN")
print(f"========================================================================================\n")
print(f"Total señales analizadas: {len(signals)}\n")

results = []

for s in signals:
    action = 'BUY' if 'BUY' in s['action'].upper() else 'SELL'
    entry = s['entry']
    sl = s['sl']
    tp = s['tp'] if s['tp'] else (entry + 8.0 if action == 'BUY' else entry - 8.0)
    sig_time = s['timestamp']

    # Filtrar velas posteriores a la señal
    post_candles = [c for c in candles if c['time'] >= sig_time]
    if not post_candles:
        post_candles = candles[-10:] # Fallback velas recientes

    # Escenario A: Con Auto-BE actual (Trigger a 3.0 pips / $3.00, BE en entry + 0.5)
    be_triggered = False
    outcome_with_be = None
    pips_with_be = 0

    # Escenario B: Sin Auto-BE (Stop Loss original y TP original)
    outcome_strict = None
    pips_strict = 0

    for c in post_candles:
        h = c['high']
        l = c['low']

        # Evaluar Escenario B (Estricto sin BE)
        if outcome_strict is None:
            if action == 'BUY':
                if h >= tp:
                    outcome_strict = 'TP'
                    pips_strict = (tp - entry) * 10
                elif l <= sl:
                    outcome_strict = 'SL'
                    pips_strict = -(entry - sl) * 10
            else: # SELL
                if l <= tp:
                    outcome_strict = 'TP'
                    pips_strict = (entry - tp) * 10
                elif h >= sl:
                    outcome_strict = 'SL'
                    pips_strict = -(sl - entry) * 10

        # Evaluar Escenario A (Con Auto-BE de 3.0 pips)
        if outcome_with_be is None:
            if action == 'BUY':
                if not be_triggered:
                    if h >= entry + 3.0:
                        be_triggered = True
                    elif l <= sl:
                        outcome_with_be = 'SL'
                        pips_with_be = -(entry - sl) * 10
                else:
                    # BE ya activado. SL está en entry + 0.5
                    be_price = entry + 0.5
                    if l <= be_price:
                        outcome_with_be = 'BE'
                        pips_with_be = 5.0 # +0.5 USD = 5 pips
                    elif h >= tp:
                        outcome_with_be = 'TP'
                        pips_with_be = (tp - entry) * 10
            else: # SELL
                if not be_triggered:
                    if l <= entry - 3.0:
                        be_triggered = True
                    elif h >= sl:
                        outcome_with_be = 'SL'
                        pips_with_be = -(sl - entry) * 10
                else:
                    # BE ya activado. SL está en entry - 0.5
                    be_price = entry - 0.5
                    if h >= be_price:
                        outcome_with_be = 'BE'
                        pips_with_be = 5.0 # +0.5 USD = 5 pips
                    elif l <= tp:
                        outcome_with_be = 'TP'
                        pips_with_be = (entry - tp) * 10

    if outcome_with_be is None:
        outcome_with_be = 'OPEN/BE' if be_triggered else 'OPEN'
        pips_with_be = 0
    if outcome_strict is None:
        outcome_strict = 'OPEN'
        pips_strict = 0

    results.append({
        'time': s['timeStr'],
        'channel': s['channel'],
        'action': action,
        'entry': entry,
        'sl': sl,
        'tp': tp,
        'be_triggered': be_triggered,
        'outcome_be': outcome_with_be,
        'pips_be': pips_with_be,
        'outcome_strict': outcome_strict,
        'pips_strict': pips_strict
    })

# Imprimir tabla comparativa
print(f"{'Hora':<8} | {'Canal':<24} | {'Tipo':<4} | {'Entrada':<7} | {'Con Auto-BE':<14} | {'Sin Auto-BE':<14} | {'¿BE Mató el TP?':<16}")
print("-" * 100)

be_killed_tp_count = 0
be_saved_from_sl_count = 0
total_pips_be = 0
total_pips_strict = 0

for r in results:
    killed_tp = (r['outcome_be'] == 'BE' and r['outcome_strict'] == 'TP')
    saved_sl = (r['outcome_be'] == 'BE' and r['outcome_strict'] == 'SL')
    if killed_tp:
        be_killed_tp_count += 1
    if saved_sl:
        be_saved_from_sl_count += 1

    status_note = "❌ CORTÓ TP" if killed_tp else ("🛡️ SALVÓ DE SL" if saved_sl else "—")
    res_be_str = f"{r['outcome_be']} ({r['pips_be']:+.0f}p)"
    res_str_str = f"{r['outcome_strict']} ({r['pips_strict']:+.0f}p)"

    total_pips_be += r['pips_be']
    total_pips_strict += r['pips_strict']

    print(f"{r['time']:<8} | {r['channel'][:24]:<24} | {r['action']:<4} | {r['entry']:<7.1f} | {res_be_str:<14} | {res_str_str:<14} | {status_note}")

be_total = sum(1 for r in results if r['outcome_be'] == 'BE')

print("\n" + "=" * 100)
print("📈 RESUMEN ESTADÍSTICO COMPARATIVO:")
print("=" * 100)
print(f"• Total operaciones analizadas hoy: {len(results)}")
print(f"• Operaciones cerradas en Break-Even (BE): {be_total} ({((be_total/len(results))*100):.1f}%)")
print(f"• 💔 Casos donde el BE CORTÓ prematuramente un TP real: {be_killed_tp_count} de {be_total} ({((be_killed_tp_count/max(1, be_total))*100):.1f}% de los BEs)")
print(f"• 🛡️ Casos donde el BE SALVÓ la cuenta de un SL posterior: {be_saved_from_sl_count} de {be_total} ({((be_saved_from_sl_count/max(1, be_total))*100):.1f}% de los BEs)")
print("-" * 100)
print(f"💰 Pips Netos CON Auto-BE (3 pips): {total_pips_be:+.1f} pips")
print(f"💰 Pips Netos SIN Auto-BE (Strict TP/SL): {total_pips_strict:+.1f} pips")
diff_pips = total_pips_strict - total_pips_be
print(f"🚀 Diferencia de rendimiento: {diff_pips:+.1f} pips a favor de {'SIN BE (o BE tardío en TP1)' if diff_pips > 0 else 'CON BE'}")
print("=" * 100)
