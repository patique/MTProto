import pandas as pd
import numpy as np

# Cargar enero 2026
df = pd.read_csv('XAUUSD_M1_202001020600_202610011121.csv', sep='\t')
df = df[df['<DATE>'].str.startswith('2026.01')].copy().reset_index(drop=True)

df['dt'] = df['<DATE>'] + ' ' + df['<TIME>']
opens = df['<OPEN>'].to_numpy()
highs = df['<HIGH>'].to_numpy()
lows = df['<LOW>'].to_numpy()
closes = df['<CLOSE>'].to_numpy()
spreads = df['<SPREAD>'].to_numpy() * 0.01

print(f"Dataset Enero 2026 cargado: {len(opens)} barras M1")

# Calcular EMA 50 y EMA 200 para filtro tendencial
ema50 = pd.Series(closes).ewm(span=50).mean().to_numpy()
ema200 = pd.Series(closes).ewm(span=200).mean().to_numpy()

def test_scalper(mode='TREND_FILTER_GRID', tp_usd=1.5, step_usd=1.5, max_orders=4, lot_mult=1.3, sl_basket_usd=30.0, use_trend_filter=True):
    balance = 100.0
    equity = 100.0
    initial_balance = 100.0
    peak_equity = 100.0
    max_dd_pct = 0.0
    total_trades = 0
    cycles = 0
    wins = 0
    losses = 0
    
    in_pos = False
    direction = 0
    orders_lots = []
    orders_prices = []
    bars_since_order = 0
    leverage = 500.0
    contract_size = 100.0
    
    for i in range(200, len(opens)):
        if in_pos:
            bars_since_order += 1
            curr_high = highs[i]
            curr_low = lows[i]
            curr_close = closes[i]
            curr_spread = spreads[i]
            total_lots = sum(orders_lots)
            
            weighted_entry = sum(p * l for p, l in zip(orders_prices, orders_lots)) / total_lots
            commissions = total_lots * 6.0
            
            # Evaluar TP
            tp_hit = False
            if direction == 1:
                target = weighted_entry + tp_usd + curr_spread
                if curr_high >= target:
                    tp_hit = True
                    exit_p = target
            else:
                target = weighted_entry - tp_usd - curr_spread
                if curr_low <= target:
                    tp_hit = True
                    exit_p = target
                    
            if tp_hit:
                # Ganancia
                pnl = 0.0
                for p, l in zip(orders_prices, orders_lots):
                    pnl += (exit_p - p) * contract_size * l if direction == 1 else (p - exit_p) * contract_size * l
                pnl -= commissions
                balance += pnl
                equity = balance
                cycles += 1
                wins += 1
                in_pos = False
                orders_lots = []
                orders_prices = []
                direction = 0
                continue
                
            # Evaluar flotante actual
            worst_p = curr_low if direction == 1 else curr_high
            worst_pnl = sum((worst_p - p)*contract_size*l if direction == 1 else (p - worst_p)*contract_size*l for p, l in zip(orders_prices, orders_lots)) - commissions
            worst_eq = balance + worst_pnl
            
            if worst_eq > peak_equity: peak_equity = worst_eq
            dd_pct = (peak_equity - worst_eq) / peak_equity * 100.0 if peak_equity > 0 else 100.0
            if dd_pct > max_dd_pct: max_dd_pct = dd_pct
            
            # Margin check
            used_margin = (curr_close * contract_size * total_lots) / leverage
            if worst_eq <= 0 or (used_margin > 0 and (worst_eq / used_margin * 100.0) <= 50.0):
                return {'status': 'STOP_OUT', 'final_balance': 0.0, 'cycles': cycles, 'wins': wins, 'losses': losses, 'max_dd_pct': 100.0, 'trades': total_trades}
                
            # SL de emergencia de cesta
            if sl_basket_usd > 0 and worst_pnl <= -sl_basket_usd:
                balance += worst_pnl
                equity = balance
                cycles += 1
                losses += 1
                in_pos = False
                orders_lots = []
                orders_prices = []
                direction = 0
                if balance <= 10.0:
                    return {'status': 'STOP_OUT', 'final_balance': balance, 'cycles': cycles, 'wins': wins, 'losses': losses, 'max_dd_pct': 100.0, 'trades': total_trades}
                continue
                
            # Re-entrada
            if len(orders_lots) < max_orders and bars_since_order >= 1:
                last_p = orders_prices[-1]
                diff = (curr_close - last_p) if direction == 1 else (last_p - curr_close)
                if diff <= -step_usd:
                    # Siguiente orden
                    scale = max(1.0, balance / initial_balance)
                    lot = round(0.01 * (lot_mult ** len(orders_lots)) * scale, 2)
                    req_margin = (curr_close * contract_size * lot) / leverage
                    if equity > req_margin * 1.5:
                        orders_lots.append(lot)
                        orders_prices.append(curr_close)
                        total_trades += 1
                        bars_since_order = 0
                        
        else:
            # Buscar entrada
            # Filtro tendencial EMA
            trend = 1 if closes[i-1] > ema200[i-1] else -1
            
            # Señal M1 momentum
            is_bull = closes[i-1] > opens[i-1]
            is_bear = closes[i-1] < opens[i-1]
            
            sig = 0
            if use_trend_filter:
                if trend == 1 and is_bull: sig = 1
                elif trend == -1 and is_bear: sig = -1
            else:
                if is_bull: sig = 1
                elif is_bear: sig = -1
                
            if sig != 0:
                direction = sig
                in_pos = True
                scale = max(1.0, balance / initial_balance)
                start_lot = round(0.01 * scale, 2)
                orders_lots = [start_lot]
                orders_prices = [opens[i]]
                total_trades += 1
                bars_since_order = 0
                
    return {
        'status': 'SURVIVED',
        'final_balance': round(balance, 2),
        'multiplier_x': round(balance / initial_balance, 2),
        'cycles': cycles,
        'wins': wins,
        'losses': losses,
        'win_rate': round(wins / cycles * 100.0, 1) if cycles > 0 else 0,
        'max_dd_pct': round(max_dd_pct, 1),
        'trades': total_trades
    }

print("\n--- PRUEBAS CON 100€ EN ENERO 2026 (INCLUYENDO DIA DE 107$) ---")
# 1. Sin filtro tendencial, sin SL (como antes)
print("1. Sin Filtro, Sin SL:", test_scalper(use_trend_filter=False, sl_basket_usd=0))

# 2. Con Filtro Tendencial EMA 200, Sin SL
print("2. Con Filtro Tendencial EMA 200, Sin SL:", test_scalper(use_trend_filter=True, sl_basket_usd=0, step_usd=1.5, max_orders=4, lot_mult=1.3))

# 3. Con Filtro Tendencial + SL de Emergencia Cesta (30€)
print("3. Con Filtro Tendencial + SL Emergencia (30€):", test_scalper(use_trend_filter=True, sl_basket_usd=30.0, step_usd=1.0, max_orders=4, lot_mult=1.5))

# 4. Ultra Rápido (TP 1.0$, Step 1.0$, Filtro Tendencial, Max 3 ordenes)
print("4. Ultra Rápido (TP 1.0$, Step 1.0$, Filtro Tendencial, Max 3 ordenes):", test_scalper(use_trend_filter=True, tp_usd=1.0, step_usd=1.0, max_orders=3, lot_mult=1.5, sl_basket_usd=25.0))
