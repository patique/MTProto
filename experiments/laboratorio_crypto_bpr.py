#!/usr/bin/env python3
"""
========================================================================================
🔬 LABORATORIO CUANTITATIVO INSTITUCIONAL BPR + BOS: CRIPTO 24/7 (BTCUSD / ETHUSD)
========================================================================================
Evalúa la eficacia de la estrategia institucional BPR en criptomonedas, comparando:
1. Operativa en FIN DE SEMANA (Sábado y Domingo) vs DÍAS HÁBILES (Lunes a Viernes).
2. Sensibilidad a los SPREADS reales de Brokers CFD (VT Markets / Exness) vs Exchanges.
3. Modelos de salida: R:R 1:2.0, 1:2.5, 1:3.0 y gestión dinámica con Break-Even (1.0R).
"""

import os
import sys
import json
import argparse
from datetime import datetime, timezone
import pandas as pd
import numpy as np

if hasattr(sys.stdout, 'reconfigure'):
    sys.stdout.reconfigure(encoding='utf-8')

def load_data(file_path):
    print(f"📂 Cargando histórico cripto desde: {file_path}")
    if file_path.endswith('.json'):
        with open(file_path, 'r', encoding='utf-8') as f:
            data = json.load(f)
        df = pd.DataFrame(data)
        if 'time' in df.columns:
            # Detectar ms vs s
            first_time = df['time'].iloc[0]
            if first_time > 1e11:
                df['dt'] = pd.to_datetime(df['time'], unit='ms', utc=True)
            else:
                df['dt'] = pd.to_datetime(df['time'], unit='s', utc=True)
    else:
        df = pd.read_csv(file_path)
        if 'dt' not in df.columns:
            for col in ['date', 'time', 'datetime', 'timestamp']:
                if col in df.columns:
                    df['dt'] = pd.to_datetime(df[col], utc=True)
                    break

    df = df.sort_values('dt').drop_duplicates('dt').reset_index(drop=True)
    df['open'] = df['open'].astype(float)
    df['high'] = df['high'].astype(float)
    df['low'] = df['low'].astype(float)
    df['close'] = df['close'].astype(float)
    df['volume'] = df.get('volume', 1.0).astype(float)

    # Identificar fin de semana (5 = Sábado, 6 = Domingo)
    df['day_of_week'] = df['dt'].dt.dayofweek
    df['is_weekend'] = df['day_of_week'].isin([5, 6])
    print(f"✅ Total velas cargadas: {len(df):,} | Rango: {df['dt'].min().strftime('%Y-%m-%d')} a {df['dt'].max().strftime('%Y-%m-%d')}")
    print(f"   • Velas en Fin de Semana: {df['is_weekend'].sum():,} ({df['is_weekend'].mean()*100:.1f}%)")
    print(f"   • Velas en Días Hábiles: {(~df['is_weekend']).sum():,} ({(1-df['is_weekend'].mean())*100:.1f}%)")
    return df

def simulate_bpr_crypto(df, rr_ratio=3.0, use_be=True, be_trigger_r=1.0, 
                        spread_usd=25.0, weekend_spread_mult=1.5,
                        min_gap_pts=80.0, lookback_swings=10):
    """
    Simulación fiel de la mecánica BPR + BOS + Sweeps institucional para BTCUSD.
    """
    n = len(df)
    trades = []
    active_bprs = [] # [{'top', 'bottom', 'ce50', 'is_buy', 'created_idx', 'active'}]
    
    # Calcular ATR simplificado (14 periodos)
    tr = np.maximum(df['high'] - df['low'], 
                    np.maximum(abs(df['high'] - df['close'].shift(1)), 
                               abs(df['low'] - df['close'].shift(1)))).fillna(0)
    atr = tr.rolling(14).mean().fillna(tr.mean()).values

    opens = df['open'].values
    highs = df['high'].values
    lows = df['low'].values
    closes = df['close'].values
    dts = df['dt'].values
    is_weekends = df['is_weekend'].values

    current_bos = 0 # 1 = Bullish BOS, -1 = Bearish BOS
    recent_high = highs[0]
    recent_low = lows[0]

    for i in range(lookback_swings + 2, n):
        # 1. Actualizar Swings de Liquidez (BSL / SSL)
        sub_highs = highs[i-lookback_swings:i]
        sub_lows = lows[i-lookback_swings:i]
        swing_h = np.max(sub_highs)
        swing_l = np.min(sub_lows)

        # Detectar BOS
        if closes[i] > swing_h and closes[i-1] <= swing_h:
            current_bos = 1
        elif closes[i] < swing_l and closes[i-1] >= swing_l:
            current_bos = -1

        # 2. Detección de FVG / BPR en velas i-2, i-1, i
        # Bullish FVG: Low de i > High de i-2
        is_bullish_fvg = (lows[i] > highs[i-2] + min_gap_pts)
        # Bearish FVG: High de i < Low de i-2
        is_bearish_fvg = (highs[i] < lows[i-2] - min_gap_pts)

        # BPR se forma cuando se solapan zonas de desequilibrio opuestas o tras sweep
        if is_bullish_fvg and current_bos == 1:
            top = lows[i]
            bottom = highs[i-2]
            ce50 = bottom + (top - bottom) * 0.5
            active_bprs.append({
                'top': top, 'bottom': bottom, 'ce50': ce50,
                'is_buy': True, 'created_idx': i, 'active': True,
                'sl': swing_l - (atr[i] * 0.2)
            })
        elif is_bearish_fvg and current_bos == -1:
            top = lows[i-2]
            bottom = highs[i]
            ce50 = bottom + (top - bottom) * 0.5
            active_bprs.append({
                'top': top, 'bottom': bottom, 'ce50': ce50,
                'is_buy': False, 'created_idx': i, 'active': True,
                'sl': swing_h + (atr[i] * 0.2)
            })

        # Limitar número de BPRs vivos (máx 150 barras)
        active_bprs = [b for b in active_bprs if (i - b['created_idx']) <= 150 and b['active']]

        # 3. Mitigación y Entrada en CE 50%
        for bpr in active_bprs:
            if not bpr['active']:
                continue

            cost_spread = (spread_usd * weekend_spread_mult) if is_weekends[i] else spread_usd
            
            # Condición de entrada CE 50%
            if bpr['is_buy']:
                # Si el precio penetra hacia el CE 50%
                if lows[i] <= bpr['ce50'] and closes[i] >= bpr['bottom']:
                    entry_p = bpr['ce50']
                    sl_p = bpr['sl']
                    risk = entry_p - sl_p
                    if risk > 50.0 and risk < 2500.0: # Filtro de riesgo razonable para BTC
                        tp_p = entry_p + (risk * rr_ratio)
                        trades.append({
                            'idx': i,
                            'dt': dts[i],
                            'is_weekend': is_weekends[i],
                            'type': 'BUY',
                            'entry': entry_p,
                            'sl': sl_p,
                            'tp': tp_p,
                            'risk': risk,
                            'spread_cost': cost_spread
                        })
                        bpr['active'] = False
                        break
            else:
                if highs[i] >= bpr['ce50'] and closes[i] <= bpr['top']:
                    entry_p = bpr['ce50']
                    sl_p = bpr['sl']
                    risk = sl_p - entry_p
                    if risk > 50.0 and risk < 2500.0:
                        tp_p = entry_p - (risk * rr_ratio)
                        trades.append({
                            'idx': i,
                            'dt': dts[i],
                            'is_weekend': is_weekends[i],
                            'type': 'SELL',
                            'entry': entry_p,
                            'sl': sl_p,
                            'tp': tp_p,
                            'risk': risk,
                            'spread_cost': cost_spread
                        })
                        bpr['active'] = False
                        break

    # 4. Resolver resultados de los trades vela a vela
    resolved_trades = []
    for t in trades:
        start_idx = t['idx'] + 1
        entry = t['entry']
        sl = t['sl']
        tp = t['tp']
        risk = t['risk']
        spread = t['spread_cost']
        is_buy = (t['type'] == 'BUY')
        
        be_active = False
        outcome = None
        pnl_pts = 0
        bars_held = 0

        for cur_idx in range(start_idx, min(start_idx + 250, n)):
            bars_held += 1
            cur_high = highs[cur_idx]
            cur_low = lows[cur_idx]

            if is_buy:
                # Comprobar BE trigger (1.0R)
                if use_be and not be_active and cur_high >= (entry + risk * be_trigger_r):
                    be_active = True
                    sl = entry + (spread * 0.5) # BE + pequeño buffer

                # TP alcanzado
                if cur_high >= tp:
                    outcome = 'TP'
                    pnl_pts = (tp - entry) - spread
                    break
                # SL alcanzado
                elif cur_low <= sl:
                    if be_active:
                        outcome = 'BE'
                        pnl_pts = 0.0 - (spread * 0.5)
                    else:
                        outcome = 'SL'
                        pnl_pts = -(risk) - spread
                    break
            else: # SELL
                if use_be and not be_active and cur_low <= (entry - risk * be_trigger_r):
                    be_active = True
                    sl = entry - (spread * 0.5)

                if cur_low <= tp:
                    outcome = 'TP'
                    pnl_pts = (entry - tp) - spread
                    break
                elif cur_high >= sl:
                    if be_active:
                        outcome = 'BE'
                        pnl_pts = 0.0 - (spread * 0.5)
                    else:
                        outcome = 'SL'
                        pnl_pts = -(risk) - spread
                    break

        if outcome is None:
            # Expiración por tiempo
            exit_p = closes[min(start_idx + 249, n - 1)]
            pnl_pts = (exit_p - entry - spread) if is_buy else (entry - exit_p - spread)
            outcome = 'TIMEOUT'

        resolved_trades.append({
            **t,
            'outcome': outcome,
            'pnl_pts': pnl_pts,
            'r_multiple': pnl_pts / risk,
            'bars_held': bars_held
        })

    return pd.DataFrame(resolved_trades)

def analyze_performance(df_trades, label=""):
    if df_trades.empty:
        print(f"⚠️ Sin trades para: {label}")
        return {}

    total = len(df_trades)
    wins = len(df_trades[df_trades['outcome'] == 'TP'])
    losses = len(df_trades[df_trades['outcome'] == 'SL'])
    bes = len(df_trades[df_trades['outcome'] == 'BE'])
    timeouts = len(df_trades[df_trades['outcome'] == 'TIMEOUT'])
    
    gross_profit = df_trades[df_trades['pnl_pts'] > 0]['pnl_pts'].sum()
    gross_loss = abs(df_trades[df_trades['pnl_pts'] < 0]['pnl_pts'].sum())
    net_pts = df_trades['pnl_pts'].sum()
    pf = (gross_profit / gross_loss) if gross_loss > 0 else np.nan
    wr = (wins / total) * 100

    # Drawdown acumulado en puntos
    cum = df_trades['pnl_pts'].cumsum()
    peak = cum.cummax()
    dd = peak - cum
    max_dd = dd.max()

    avg_r = df_trades['r_multiple'].mean()

    print(f"\n==================================================================================")
    print(f"📊 RESUMEN: {label}")
    print(f"==================================================================================")
    print(f"  • Total Trades   : {total} (TP: {wins} | SL: {losses} | BE: {bes} | TO: {timeouts})")
    print(f"  • Win Rate       : {wr:.1f}%")
    print(f"  • Profit Factor  : {pf:.2f}")
    print(f"  • PnL Neto       : {'+' if net_pts>=0 else ''}{net_pts:,.1f} USD (Puntos BTC)")
    print(f"  • Esperanza (R)  : {'+' if avg_r>=0 else ''}{avg_r:.2f}R por operación")
    print(f"  • Max Drawdown   : -{max_dd:,.1f} USD")
    print(f"==================================================================================")
    return {
        'total': total, 'wins': wins, 'losses': losses, 'bes': bes,
        'wr': wr, 'pf': pf, 'net_pts': net_pts, 'max_dd': max_dd, 'avg_r': avg_r
    }

def main():
    parser = argparse.ArgumentParser(description="Laboratorio Cuantitativo BPR Cripto 24/7")
    parser.add_argument('--data', type=str, default='scripts/audits/cache_btcusdt_15m_1y.json', help='Ruta al archivo JSON/CSV de velas')
    args = parser.parse_args()

    full_path = os.path.abspath(args.data)
    if not os.path.exists(full_path):
        print(f"❌ Error: Archivo no encontrado en {full_path}")
        return

    df = load_data(full_path)

    # Batería de pruebas:
    # 1. R:R 1:2.0 vs 1:2.5 vs 1:3.0 con Spread Real de Fin de Semana
    print("\n" + "#"*80)
    print("🧪 BATERÍA 1: OPTIMIZACIÓN DE RATIO R:R Y BREAK-EVEN (SPREAD CFD FIN DE SEMANA)")
    print("#"*80)
    
    for rr in [2.0, 2.5, 3.0]:
        df_res = simulate_bpr_crypto(df, rr_ratio=rr, use_be=True, be_trigger_r=1.0, spread_usd=25.0, weekend_spread_mult=1.6)
        analyze_performance(df_res, f"BTCUSD M15 | R:R 1:{rr} con Auto-BE 1.0R (Spread Normal $25 / Finde $40)")

    # 2. Desglose Específico: FIN DE SEMANA vs DÍAS HÁBILES (con R:R 1:3.0)
    print("\n" + "#"*80)
    print("🏖️ BATERÍA 2: RENDIMIENTO FIN DE SEMANA vs DÍAS DE SEMANA (R:R 1:3.0)")
    print("#"*80)
    df_opt = simulate_bpr_crypto(df, rr_ratio=3.0, use_be=True, be_trigger_r=1.0, spread_usd=25.0, weekend_spread_mult=1.6)
    
    df_weekend = df_opt[df_opt['is_weekend'] == True]
    df_weekdays = df_opt[df_opt['is_weekend'] == False]
    
    analyze_performance(df_weekend, "BTCUSD M15 | SOLO FINES DE SEMANA (Sábados y Domingos)")
    analyze_performance(df_weekdays, "BTCUSD M15 | SOLO DÍAS HÁBILES (Lunes a Viernes)")

    # 3. Impacto de la Fricción del Broker (VT Markets / Exness)
    print("\n" + "#"*80)
    print("📈 BATERÍA 3: SENSIBILIDAD AL SPREAD DEL BROKER EN FINES DE SEMANA")
    print("#"*80)
    for spread in [15.0, 30.0, 50.0, 80.0]:
        df_spread = simulate_bpr_crypto(df, rr_ratio=3.0, use_be=True, spread_usd=spread, weekend_spread_mult=1.5)
        df_sp_wk = df_spread[df_spread['is_weekend'] == True]
        analyze_performance(df_sp_wk, f"SOLO FINES DE SEMANA con Spread CFD = ${spread:.0f} USD (x1.5 finde = ${spread*1.5:.0f})")

if __name__ == '__main__':
    main()
