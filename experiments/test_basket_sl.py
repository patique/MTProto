import pandas as pd
import numpy as np

df = pd.read_csv('XAUUSD_M1_202001020600_202610011121.csv', sep='\t')
df = df[df['<DATE>'].str.startswith('2026.01')].copy().reset_index(drop=True)

opens = df['<OPEN>'].to_numpy()
highs = df['<HIGH>'].to_numpy()
lows = df['<LOW>'].to_numpy()
closes = df['<CLOSE>'].to_numpy()
spreads = df['<SPREAD>'].to_numpy() * 0.01

def sim(basket_sl_usd=0, max_orders=8, lot_mult=2.0, step=1.0, tp=2.0, withdraw_mult=0):
    balance = 100.0
    initial = 100.0
    orders_lots = []
    orders_prices = []
    direction = 0
    in_pos = False
    closed_cycles = 0
    wins = 0
    losses = 0
    total_withdrawn = 0.0
    
    for i in range(15, len(opens)):
        if in_pos:
            curr_h = highs[i]
            curr_l = lows[i]
            curr_c = closes[i]
            total_l = sum(orders_lots)
            w_entry = sum(p*l for p,l in zip(orders_prices, orders_lots)) / total_l
            comms = total_l * 6.0
            
            # TP
            hit_tp = False
            if direction == 1 and curr_h >= (w_entry + tp + spreads[i]):
                hit_tp = True
                exit_p = w_entry + tp + spreads[i]
            elif direction == -1 and curr_l <= (w_entry - tp - spreads[i]):
                hit_tp = True
                exit_p = w_entry - tp - spreads[i]
            
            if hit_tp:
                pnl = sum((exit_p - p)*100*l if direction == 1 else (p - exit_p)*100*l for p,l in zip(orders_prices, orders_lots)) - comms
                balance += pnl
                in_pos = False
                orders_lots = []
                orders_prices = []
                direction = 0
                closed_cycles += 1
                wins += 1
                
                # Regla de retiro: si balance supera 2x (200$), retirar 100$
                if withdraw_mult > 0 and balance >= 200.0:
                    balance -= 100.0
                    total_withdrawn += 100.0
                continue
                
            # Flotante
            worst_p = curr_l if direction == 1 else curr_h
            worst_pnl = sum((worst_p - p)*100*l if direction == 1 else (p - worst_p)*100*l for p,l in zip(orders_prices, orders_lots)) - comms
            
            # SL de cesta en $
            if basket_sl_usd > 0 and worst_pnl <= -basket_sl_usd:
                balance += worst_pnl
                in_pos = False
                orders_lots = []
                orders_prices = []
                direction = 0
                closed_cycles += 1
                losses += 1
                if balance <= 10:
                    return {'status': 'STOP_OUT', 'balance': balance, 'wins': wins, 'losses': losses, 'withdrawn': total_withdrawn}
                continue
                
            # Stop out margin
            used_m = (curr_c * 100 * total_l) / 500.0
            if (balance + worst_pnl) <= 0 or (used_m > 0 and ((balance + worst_pnl)/used_m*100) <= 50):
                return {'status': 'STOP_OUT', 'balance': 0.0, 'wins': wins, 'losses': losses, 'withdrawn': total_withdrawn}
                
            # Re-entry
            if len(orders_lots) < max_orders:
                diff = (curr_c - orders_prices[-1]) if direction == 1 else (orders_prices[-1] - curr_c)
                if diff <= -step:
                    next_lot = round(0.01 * (lot_mult ** len(orders_lots)), 2)
                    orders_lots.append(next_lot)
                    orders_prices.append(curr_c)
        else:
            # Breakout 15m
            h_range = np.max(highs[i-15:i])
            l_range = np.min(lows[i-15:i])
            if closes[i-1] >= h_range:
                direction = 1
                in_pos = True
                orders_lots = [0.01]
                orders_prices = [opens[i]]
            elif closes[i-1] <= l_range:
                direction = -1
                in_pos = True
                orders_lots = [0.01]
                orders_prices = [opens[i]]
                
    return {'status': 'SURVIVED', 'balance': round(balance, 2), 'wins': wins, 'losses': losses, 'cycles': closed_cycles, 'withdrawn': total_withdrawn}

print("1. Original Sin SL:", sim(basket_sl_usd=0, max_orders=8))
print("2. Con Retiro al doblar (Retirar 100 cada vez que llega a 200):", sim(basket_sl_usd=0, max_orders=8, withdraw_mult=1))
print("3. Con Basket SL 35 USD:", sim(basket_sl_usd=35, max_orders=8))
print("4. Con Basket SL 50 USD:", sim(basket_sl_usd=50, max_orders=8))
print("5. Con Max Orders 4, Step 2.0, Basket SL 40 USD:", sim(basket_sl_usd=40, max_orders=4, lot_mult=1.5, step=2.0))
