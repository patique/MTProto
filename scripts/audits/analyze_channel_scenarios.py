import json

# 1. Cargar datos acumulados de analytics_data.json
with open('analytics_data.json') as f:
    analytics = json.load(f)

# Compilar estadísticas de cada canal
channels = {}
all_trades = []

for ch_id, ch in analytics.items():
    if ch_id == 'MT5_AUTO': continue
    name = ch.get('channelName', 'Canal')
    if name == 'Canal' and ch.get('totalSignals', 0) == 0: continue

    signals = ch.get('lastSignals', [])
    w = 0
    l = 0
    pips_won = 0.0
    pips_lost = 0.0
    channel_trades = []

    for s in signals:
        outcome = s.get('outcome', 'PENDING')
        p = float(s.get('pips', 0.0))
        entry = float(s.get('entry', 0.0))
        sl = float(s.get('sl', 0.0)) if s.get('sl') else None

        # Si el trade fue resuelto
        if outcome in ['WIN', 'TP_HIT', 'TP']:
            w += 1
            pips_won += abs(p)
            trade_record = {
                'channel': name,
                'channelId': ch_id,
                'time': s.get('timeStr'),
                'timestamp': s.get('timestamp', 0),
                'outcome': 'WIN',
                'pips': abs(p),
                'profitUSD': abs(p) * 0.1 # 0.01 lotes: 10 pips = $1.00 USD
            }
            channel_trades.append(trade_record)
            all_trades.append(trade_record)
        elif outcome in ['LOSS', 'SL_HIT', 'SL']:
            l += 1
            # Si el SL fue anormal (> 120 pips), registrarlo
            loss_pips = abs(p) if p != 0 else (abs(entry - sl) * 10 if (entry and sl) else 100.0)
            pips_lost += loss_pips
            trade_record = {
                'channel': name,
                'channelId': ch_id,
                'time': s.get('timeStr'),
                'timestamp': s.get('timestamp', 0),
                'outcome': 'LOSS',
                'pips': -loss_pips,
                'profitUSD': -loss_pips * 0.1
            }
            channel_trades.append(trade_record)
            all_trades.append(trade_record)

    resolved = w + l
    wr = (w / resolved * 100) if resolved > 0 else 0.0
    net_pips = pips_won - pips_lost
    net_usd = net_pips * 0.1 # en 0.01 lotes

    profit_factor = (pips_won / pips_lost) if pips_lost > 0 else (99.0 if pips_won > 0 else 0.0)

    channels[ch_id] = {
        'id': ch_id,
        'name': name,
        'signals': ch.get('totalSignals', resolved),
        'resolved': resolved,
        'wins': w,
        'losses': l,
        'winRate': wr,
        'pipsWon': pips_won,
        'pipsLost': pips_lost,
        'netPips': net_pips,
        'netUSD': net_usd,
        'profitFactor': profit_factor,
        'trades': channel_trades
    }

# Ordenar canales por Pips Netos descendente
sorted_channels = sorted(channels.values(), key=lambda x: (x['netPips'], x['winRate']), reverse=True)

print("=" * 110)
print(f"{'📊 RENDIMIENTO HISTÓRICO DE CANALES (SEMANAL / GLOBAL)':^110}")
print("=" * 110)
print(f"{'Canal':<28} | {'Señales':<7} | {'Win/Loss':<8} | {'Win Rate':<8} | {'Pips Ganados':<12} | {'Pips Perdidos':<13} | {'Pips Netos':<10} | {'P. Factor':<9}")
print("-" * 110)

for c in sorted_channels:
    wl_str = f"{c['wins']}W / {c['losses']}L"
    wr_str = f"{c['winRate']:.1f}%"
    pips_net_str = f"{c['netPips']:+.1f}p"
    pf_str = f"{c['profitFactor']:.2f}" if c['profitFactor'] < 90 else "MAX"
    print(f"{c['name'][:28]:<28} | {c['signals']:^7} | {wl_str:^8} | {wr_str:>8} | {c['pipsWon']:>11.1f}p | {c['pipsLost']:>12.1f}p | {pips_net_str:>10} | {pf_str:>9}")

print("\n" + "=" * 110)
print(f"{'🧪 SIMULACIÓN DE ESCENARIOS DE DESHABILITACIÓN':^110}")
print("=" * 110)

# Función para simular un escenario
def simulate_scenario(scenario_name, allowed_channel_ids, max_sl_cap=None):
    filtered_trades = [t for t in all_trades if t['channelId'] in allowed_channel_ids]
    filtered_trades.sort(key=lambda x: x['timestamp'])

    total_w = sum(1 for t in filtered_trades if t['outcome'] == 'WIN')
    total_l = sum(1 for t in filtered_trades if t['outcome'] == 'LOSS')
    total_res = total_w + total_l
    wr = (total_w / total_res * 100) if total_res > 0 else 0.0

    net_pips = 0.0
    net_usd = 0.0
    gross_win = 0.0
    gross_loss = 0.0
    peak_balance = 0.0
    current_balance = 0.0
    max_drawdown_usd = 0.0

    for t in filtered_trades:
        pips = t['pips']
        usd = t['profitUSD']
        # Aplicar tope de SL si está definido
        if max_sl_cap and t['outcome'] == 'LOSS' and abs(pips) > max_sl_cap:
            pips = -max_sl_cap
            usd = -max_sl_cap * 0.1

        net_pips += pips
        net_usd += usd
        current_balance += usd

        if current_balance > peak_balance:
            peak_balance = current_balance
        dd = peak_balance - current_balance
        if dd > max_drawdown_usd:
            max_drawdown_usd = dd

        if pips > 0: gross_win += pips
        else: gross_loss += abs(pips)

    pf = (gross_win / gross_loss) if gross_loss > 0 else (99.0 if gross_win > 0 else 0.0)

    return {
        'name': scenario_name,
        'channels_count': len(allowed_channel_ids),
        'trades_count': total_res,
        'winRate': wr,
        'netPips': net_pips,
        'netUSD': net_usd,
        'profitFactor': pf,
        'maxDrawdown': max_drawdown_usd
    }

# 1. Escenario 0: Todos los canales activos
all_ids = set(channels.keys())
s0 = simulate_scenario("Escenario 0: Todos los Canales (Baseline actual)", all_ids)

# 2. Escenario 1: Deshabilitar los canales con Pips Netos Negativos (< 0 pips)
# Canales negativos: Attaullah (-130p), Aliens (-141p), Smart Pips (-120p), Candle Logic (-111p), G.S Market (-110p), Ai Premium (-18p)
positive_ids = set(c['id'] for c in sorted_channels if c['netPips'] > 0)
s1 = simulate_scenario("Escenario 1: Eliminar Canales Tóxicos (Solo Pips Netos > 0)", positive_ids)

# 3. Escenario 2: Solo Canales de Alta Efectividad (Win Rate >= 75%)
high_wr_ids = set(c['id'] for c in sorted_channels if c['winRate'] >= 75.0 and c['netPips'] > 0)
s2 = simulate_scenario("Escenario 2: Elite Only (Win Rate >= 75% + Pips Positivos)", high_wr_ids)

# 4. Escenario 3: La Combinación Óptima (VIP Squad + Límite Max SL 100 pips)
# Top performers: GOLD PRO, MARCO, Craig Percoco, META TRADER 5, Williams, Risk Management, XAUUSD Forex, The Traders Club
optimal_ids = set(c['id'] for c in sorted_channels if c['id'] in [
    '-1002429125771', # GOLD PRO SIGNAL (100% WR, +587p)
    '-1002157727490', # MARCO TRADING HUB (100% WR, +150p)
    '-1001823957090', # Craig Percoco Daily Trades (100% WR, +125p)
    '-1002493671900', # XAUUSD FOREX TRADING (100% WR, +100p)
    '-1003745883830', # Williams tradershub (100% WR, +70p)
    '-1002206734647', # Risk Management-revealed (100% WR, +61p)
    '-1001891914408', # THE TRADERS CLUB – FWA (75% WR, +5p)
    '-1002176496064'  # META TRADER 5 OFFICIALL (85% WR, +331p)
])
s3 = simulate_scenario("Escenario 3 (ÓPTIMO): VIP Squad (8 Canales) + Max SL 100 pips", optimal_ids, max_sl_cap=100.0)

scenarios = [s0, s1, s2, s3]

print(f"{'Escenario':<58} | {'Canales':<7} | {'Trades':<6} | {'Win Rate':<8} | {'Pips Netos':<10} | {'Beneficio $':<11} | {'Drawdown':<8} | {'P.Factor':<8}")
print("-" * 135)

for s in scenarios:
    pf_disp = f"{s['profitFactor']:.2f}" if s['profitFactor'] < 90 else "MAX"
    print(f"{s['name'][:58]:<58} | {s['channels_count']:^7} | {s['trades_count']:^6} | {s['winRate']:>7.1f}% | {s['netPips']:>9.1f}p | {s['netUSD']:>+10.2f}$ | ${s['maxDrawdown']:>6.2f} | {pf_disp:>8}")

print("=" * 135)

# Canales a Deshabilitar
toxic_channels = [c for c in sorted_channels if c['id'] not in optimal_ids]
print("\n🚨 CANALES A DESHABILITAR (Generadores de Pérdidas y Drawdown):")
for t in toxic_channels:
    print(f"   ❌ {t['name']:<28} -> Win Rate: {t['winRate']:.1f}% | Pips Netos: {t['netPips']:+.1f} pips | Pérdidas: {t['pipsLost']:.1f}p")

print("\n🏆 CANALES RECOMENDADOS PARA MANTENER ACTIVOS (Combinación Ganadora):")
for o in [c for c in sorted_channels if c['id'] in optimal_ids]:
    print(f"   ✅ {o['name']:<28} -> Win Rate: {o['winRate']:.1f}% | Pips Netos: {o['netPips']:+.1f} pips | Profit Factor: {o['profitFactor']:.2f}")

