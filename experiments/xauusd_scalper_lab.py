#!/usr/bin/env python3
"""
========================================================================================
🔬 LABORATORIO CUANTITATIVO: SCALPING ACUMULATIVO Y GRID DE MARGEN EN XAUUSD
========================================================================================
Analiza de forma exhaustiva el comportamiento del sistema de micro-take-profit (1$-2$),
entradas consecutivas, re-entradas por tiempo/margen y multiplicadores de lotaje.

Los resultados de cada combinación se vuelcan de forma persistente a SQLite:
`experiments/xauusd_scalper_lab.db`
========================================================================================
"""

import os
import sys
import time
import sqlite3
import argparse
from datetime import datetime
import numpy as np
import pandas as pd

if hasattr(sys.stdout, 'reconfigure'):
    sys.stdout.reconfigure(encoding='utf-8')

# Rutas del entorno
BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DB_PATH = os.path.join(BASE_DIR, "experiments", "xauusd_scalper_lab.db")
DEFAULT_CSV = os.path.join(BASE_DIR, "XAUUSD_M1_202001020600_202610011121.csv")

def init_db(db_path=DB_PATH):
    """Inicializa el esquema de SQLite para almacenar las simulaciones."""
    os.makedirs(os.path.dirname(db_path), exist_ok=True)
    conn = sqlite3.connect(db_path)
    cur = conn.cursor()
    
    cur.execute("""
    CREATE TABLE IF NOT EXISTS simulation_runs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        timestamp TEXT,
        strategy_mode TEXT,
        entry_rule TEXT,
        tp_usd REAL,
        step_usd REAL,
        reentry_delay_bars INTEGER,
        lot_multiplier REAL,
        base_lot REAL,
        max_orders INTEGER,
        leverage REAL,
        use_margin_scaling INTEGER,
        session_filter TEXT,
        initial_balance REAL,
        final_balance REAL,
        multiplier_x REAL,
        total_trades INTEGER,
        total_cycles INTEGER,
        winning_cycles INTEGER,
        losing_cycles INTEGER,
        win_rate_pct REAL,
        profit_factor REAL,
        max_dd_pct REAL,
        max_dd_usd REAL,
        status TEXT,
        stop_out_date TEXT,
        survival_days REAL,
        avg_cycle_duration_min REAL
    )
    """)

    cur.execute("""
    CREATE TABLE IF NOT EXISTS viable_configurations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        run_id INTEGER,
        multiplier_x REAL,
        win_rate_pct REAL,
        max_dd_pct REAL,
        strategy_mode TEXT,
        entry_rule TEXT,
        tp_usd REAL,
        step_usd REAL,
        lot_multiplier REAL,
        max_orders INTEGER,
        score REAL,
        FOREIGN KEY(run_id) REFERENCES simulation_runs(id)
    )
    """)
    conn.commit()
    conn.close()

def load_m1_data(csv_path, max_bars=300000):
    """
    Carga velas M1 reales de XAUUSD tabuladas.
    Optimizado para leer las últimas N barras para análisis rápido de regímenes recientes.
    """
    print(f"[{datetime.now().strftime('%H:%M:%S')}] 📂 Cargando datos M1 desde: {csv_path}")
    if not os.path.exists(csv_path):
        raise FileNotFoundError(f"Archivo no encontrado: {csv_path}")

    # Leemos con pandas optimizado
    df = pd.read_csv(
        csv_path,
        sep='\t',
        engine='c',
        dtype={
            '<OPEN>': np.float64,
            '<HIGH>': np.float64,
            '<LOW>': np.float64,
            '<CLOSE>': np.float64,
            '<TICKVOL>': np.int32,
            '<SPREAD>': np.float64
        }
    )
    
    df.rename(columns={
        '<DATE>': 'date',
        '<TIME>': 'time',
        '<OPEN>': 'open',
        '<HIGH>': 'high',
        '<LOW>': 'low',
        '<CLOSE>': 'close',
        '<SPREAD>': 'spread'
    }, inplace=True)

    if max_bars and len(df) > max_bars:
        df = df.iloc[-max_bars:].copy()

    df['dt_str'] = df['date'] + ' ' + df['time']
    df['hour'] = pd.to_datetime(df['time'], format='%H:%M:%S').dt.hour
    
    print(f"[{datetime.now().strftime('%H:%M:%S')}] ✅ {len(df):,} barras M1 cargadas ({df['dt_str'].iloc[0]} a {df['dt_str'].iloc[-1]})")
    return df

def simulate_engine(
    df,
    strategy_mode='GRID_AVERAGING',
    entry_rule='MOMENTUM_M1',
    tp_usd=1.5,
    step_usd=1.5,
    reentry_delay_bars=1,
    lot_multiplier=1.5,
    base_lot=0.01,
    max_orders=6,
    leverage=500.0,
    use_margin_scaling=1,
    session_filter='ALL_DAY',
    initial_balance=1000.0,
    commission_per_lot=6.0
):
    """
    Motor vectorial/matricial de ejecución rápida de simulación de scalping con gestión de margen.
    """
    opens = df['open'].to_numpy()
    highs = df['high'].to_numpy()
    lows = df['low'].to_numpy()
    closes = df['close'].to_numpy()
    spreads = df['spread'].to_numpy() * 0.01  # Convertir puntos a $ (24 -> 0.24$)
    hours = df['hour'].to_numpy()
    dates = df['dt_str'].to_numpy()
    n_bars = len(opens)

    # Estado de la cuenta
    balance = float(initial_balance)
    equity = float(initial_balance)
    peak_equity = float(initial_balance)
    max_dd_pct = 0.0
    max_dd_usd = 0.0

    # Estado de la cesta de órdenes
    in_position = False
    direction = 0  # +1: BUY, -1: SELL
    orders_lots = []
    orders_prices = []
    bars_since_last_order = 0
    cycle_start_idx = 0
    
    total_trades = 0
    total_cycles = 0
    winning_cycles = 0
    losing_cycles = 0
    gross_profit = 0.0
    gross_loss = 0.0
    cycle_durations = []

    status = 'SURVIVED'
    stop_out_date = None

    contract_size = 100.0  # 1 lote XAUUSD = 100 onzas troy

    for i in range(1, n_bars):
        # 1. Filtro de sesión
        hour = hours[i]
        in_session = True
        if session_filter == 'LONDON_NY':
            in_session = (7 <= hour <= 18)
        elif session_filter == 'ASIAN_QUIET':
            in_session = (0 <= hour <= 7)

        # 2. Si hay posiciones abiertas, evaluar TP de cesta o Drawdown / Stop Out
        if in_position:
            bars_since_last_order += 1
            curr_low = lows[i]
            curr_high = highs[i]
            curr_close = closes[i]
            curr_spread = spreads[i]

            total_lots = sum(orders_lots)
            
            # Calcular equity flotante en el peor y mejor caso de la vela
            # Para BUY: beneficio = (precio - precio_apertura) * 100 * lotes - comision
            # Para SELL: beneficio = (precio_apertura - precio) * 100 * lotes - comision
            
            weighted_entry = sum(p * l for p, l in zip(orders_prices, orders_lots)) / total_lots
            total_commissions = sum(l * commission_per_lot for l in orders_lots)

            # Evaluar Take Profit
            # El TP global en dólares por onza: queremos salir con `tp_usd` neto
            tp_hit = False
            exit_price = 0.0

            if direction == 1:  # BUY
                target_price = weighted_entry + tp_usd + curr_spread
                if curr_high >= target_price:
                    tp_hit = True
                    exit_price = target_price
            else:  # SELL
                target_price = weighted_entry - tp_usd - curr_spread
                if curr_low <= target_price:
                    tp_hit = True
                    exit_price = target_price

            if tp_hit:
                # Cerrar cesta con beneficio
                net_cycle_pnl = 0.0
                for p, l in zip(orders_prices, orders_lots):
                    if direction == 1:
                        pnl = (exit_price - p) * contract_size * l
                    else:
                        pnl = (p - exit_price) * contract_size * l
                    net_cycle_pnl += pnl

                net_cycle_pnl -= total_commissions
                balance += net_cycle_pnl
                equity = balance
                gross_profit += max(0.0, net_cycle_pnl)
                winning_cycles += 1
                total_cycles += 1
                cycle_durations.append(i - cycle_start_idx)

                # Reset de cesta
                in_position = False
                orders_lots = []
                orders_prices = []
                bars_since_last_order = 0
                direction = 0

            else:
                # Comprobar si se añade orden consecutiva
                # En GRID_AVERAGING: si el precio retrocedió `step_usd` en contra
                # En MOMENTUM_PYRAMID: si el precio avanzó `step_usd` a favor
                can_add_order = (len(orders_lots) < max_orders) and (bars_since_last_order >= reentry_delay_bars)

                if can_add_order:
                    last_price = orders_prices[-1]
                    price_diff = (curr_close - last_price) if direction == 1 else (last_price - curr_close)
                    
                    trigger_add = False
                    if strategy_mode == 'GRID_AVERAGING' and price_diff <= -step_usd:
                        trigger_add = True
                    elif strategy_mode == 'MOMENTUM_PYRAMID' and price_diff >= step_usd:
                        trigger_add = True

                    if trigger_add:
                        # Calcular nuevo lotaje
                        next_order_idx = len(orders_lots)
                        if use_margin_scaling:
                            # Aumenta en base a equity / balance actual
                            margin_factor = max(1.0, equity / initial_balance)
                            lot = base_lot * (lot_multiplier ** next_order_idx) * margin_factor
                        else:
                            lot = base_lot * (lot_multiplier ** next_order_idx)
                        
                        lot = round(min(lot, 20.0), 2)  # Cap por seguridad de simulación
                        
                        # Margen requerido
                        margin_required = (curr_close * contract_size * lot) / leverage
                        if equity > margin_required * 1.5:  # Hay margen suficiente
                            orders_lots.append(lot)
                            orders_prices.append(curr_close)
                            total_trades += 1
                            bars_since_last_order = 0

                # Evaluar peor flotante de la vela para Drawdown y Stop Out (Margin Call 50%)
                worst_price = curr_low if direction == 1 else curr_high
                worst_floating_pnl = 0.0
                for p, l in zip(orders_prices, orders_lots):
                    if direction == 1:
                        worst_floating_pnl += (worst_price - p) * contract_size * l
                    else:
                        worst_floating_pnl += (p - worst_price) * contract_size * l
                worst_floating_pnl -= total_commissions

                worst_equity = balance + worst_floating_pnl
                
                # Drawdown tracking
                if worst_equity > peak_equity:
                    peak_equity = worst_equity
                dd_usd = peak_equity - worst_equity
                dd_pct = (dd_usd / peak_equity * 100.0) if peak_equity > 0 else 100.0
                if dd_pct > max_dd_pct:
                    max_dd_pct = dd_pct
                if dd_usd > max_dd_usd:
                    max_dd_usd = dd_usd

                # Margen total requerido
                total_used_margin = (curr_close * contract_size * sum(orders_lots)) / leverage
                margin_level_pct = (worst_equity / total_used_margin * 100.0) if total_used_margin > 0 else 9999.0

                # Stop Out condicional (quiebra / margin call si margin level < 50% o equity <= 0)
                if worst_equity <= 0 or margin_level_pct <= 50.0:
                    status = 'STOP_OUT'
                    stop_out_date = dates[i]
                    losing_cycles += 1
                    total_cycles += 1
                    gross_loss += abs(worst_floating_pnl)
                    balance = max(0.0, worst_equity)
                    break

        # 3. Si no hay posición activa y estamos en sesión, buscar entrada
        if not in_position and in_session and i > 20:
            open_signal = 0
            
            if entry_rule == 'MOMENTUM_M1':
                # Si vela previa cerró alcista con cuerpo
                if closes[i-1] > opens[i-1]:
                    open_signal = 1
                elif closes[i-1] < opens[i-1]:
                    open_signal = -1

            elif entry_rule == 'EMA_CROSS_9_21':
                # Media rápida vs lenta en 20 barras
                ema_fast = np.mean(closes[i-9:i])
                ema_slow = np.mean(closes[i-21:i])
                if ema_fast > ema_slow:
                    open_signal = 1
                elif ema_fast < ema_slow:
                    open_signal = -1

            elif entry_rule == 'BREAKOUT_RANGE':
                # Rotura del rango de los últimos 15 min
                high_range = np.max(highs[i-15:i])
                low_range = np.min(lows[i-15:i])
                if closes[i-1] >= high_range:
                    open_signal = 1
                elif closes[i-1] <= low_range:
                    open_signal = -1

            if open_signal != 0:
                direction = open_signal
                in_position = True
                cycle_start_idx = i
                
                # Lotaje inicial ajustado a equity si use_margin_scaling está activo
                if use_margin_scaling:
                    curr_factor = max(1.0, balance / initial_balance)
                    first_lot = round(base_lot * curr_factor, 2)
                else:
                    first_lot = base_lot

                orders_lots = [first_lot]
                orders_prices = [opens[i]]
                total_trades += 1
                bars_since_last_order = 0

    final_balance = round(balance, 2)
    multiplier_x = round(final_balance / initial_balance, 2)
    win_rate = round((winning_cycles / total_cycles * 100.0), 2) if total_cycles > 0 else 0.0
    profit_factor = round((gross_profit / gross_loss), 2) if gross_loss > 0 else 99.0
    avg_duration = round(float(np.mean(cycle_durations)), 1) if cycle_durations else 0.0
    survival_days = round(n_bars / (60 * 24), 1)

    return {
        'strategy_mode': strategy_mode,
        'entry_rule': entry_rule,
        'tp_usd': tp_usd,
        'step_usd': step_usd,
        'reentry_delay_bars': reentry_delay_bars,
        'lot_multiplier': lot_multiplier,
        'base_lot': base_lot,
        'max_orders': max_orders,
        'leverage': leverage,
        'use_margin_scaling': use_margin_scaling,
        'session_filter': session_filter,
        'initial_balance': initial_balance,
        'final_balance': final_balance,
        'multiplier_x': multiplier_x,
        'total_trades': total_trades,
        'total_cycles': total_cycles,
        'winning_cycles': winning_cycles,
        'losing_cycles': losing_cycles,
        'win_rate_pct': win_rate,
        'profit_factor': profit_factor,
        'max_dd_pct': round(max_dd_pct, 2),
        'max_dd_usd': round(max_dd_usd, 2),
        'status': status,
        'stop_out_date': stop_out_date if stop_out_date else '',
        'survival_days': survival_days,
        'avg_cycle_duration_min': avg_duration
    }

def run_laboratory_matrix(df, db_path=DB_PATH):
    """
    Ejecuta el barrido combinatorio de hiperparámetros y vuelca cada simulación a SQLite.
    """
    init_db(db_path)
    
    # Espacio combinatorio del experimento
    strategy_modes = ['GRID_AVERAGING', 'MOMENTUM_PYRAMID']
    entry_rules = ['MOMENTUM_M1', 'EMA_CROSS_9_21', 'BREAKOUT_RANGE']
    tp_targets = [1.0, 1.5, 2.0]            # Micro TP de 1 a 2$ en oro
    steps = [1.0, 1.5, 2.0]                 # Distancia entre re-entradas
    reentry_delays = [1, 3]                 # Minutos entre re-entradas consecutivas
    lot_multipliers = [1.2, 1.5, 2.0]       # Escalado suave vs martingala
    max_orders_list = [4, 6, 8]             # Número de trades en ráfaga
    session_filters = ['ALL_DAY', 'LONDON_NY']
    margin_scaling_options = [1, 0]

    # Generar combinaciones
    total_combinations = (
        len(strategy_modes) * len(entry_rules) * len(tp_targets) *
        len(steps) * len(reentry_delays) * len(lot_multipliers) *
        len(max_orders_list) * len(session_filters) * len(margin_scaling_options)
    )

    print(f"[{datetime.now().strftime('%H:%M:%S')}] 🧪 Iniciando barrido combinatorio: {total_combinations} configuraciones a evaluar...")

    conn = sqlite3.connect(db_path)
    cur = conn.cursor()

    count = 0
    viable_count = 0
    start_time = time.time()

    for s_mode in strategy_modes:
        for e_rule in entry_rules:
            for tp in tp_targets:
                for step in steps:
                    for delay in reentry_delays:
                        for mult in lot_multipliers:
                            for max_ord in max_orders_list:
                                for sess in session_filters:
                                    for m_scale in margin_scaling_options:
                                        count += 1
                                        
                                        res = simulate_engine(
                                            df,
                                            strategy_mode=s_mode,
                                            entry_rule=e_rule,
                                            tp_usd=tp,
                                            step_usd=step,
                                            reentry_delay_bars=delay,
                                            lot_multiplier=mult,
                                            base_lot=0.01,
                                            max_orders=max_ord,
                                            leverage=500.0,
                                            use_margin_scaling=m_scale,
                                            session_filter=sess,
                                            initial_balance=1000.0
                                        )

                                        # Inserción en SQLite
                                        now_str = datetime.now().strftime('%Y-%m-%d %H:%M:%S')
                                        cur.execute("""
                                        INSERT INTO simulation_runs (
                                            timestamp, strategy_mode, entry_rule, tp_usd, step_usd,
                                            reentry_delay_bars, lot_multiplier, base_lot, max_orders,
                                            leverage, use_margin_scaling, session_filter, initial_balance,
                                            final_balance, multiplier_x, total_trades, total_cycles,
                                            winning_cycles, losing_cycles, win_rate_pct, profit_factor,
                                            max_dd_pct, max_dd_usd, status, stop_out_date,
                                            survival_days, avg_cycle_duration_min
                                        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                                        """, (
                                            now_str, res['strategy_mode'], res['entry_rule'], res['tp_usd'],
                                            res['step_usd'], res['reentry_delay_bars'], res['lot_multiplier'],
                                            res['base_lot'], res['max_orders'], res['leverage'],
                                            res['use_margin_scaling'], res['session_filter'],
                                            res['initial_balance'], res['final_balance'], res['multiplier_x'],
                                            res['total_trades'], res['total_cycles'], res['winning_cycles'],
                                            res['losing_cycles'], res['win_rate_pct'], res['profit_factor'],
                                            res['max_dd_pct'], res['max_dd_usd'], res['status'],
                                            res['stop_out_date'], res['survival_days'], res['avg_cycle_duration_min']
                                        ))
                                        run_id = cur.lastrowid

                                        # Si la configuración es viable (multiplicó cuenta > 1.5x y no quebró con DD < 40%)
                                        if res['status'] == 'SURVIVED' and res['multiplier_x'] >= 1.5 and res['max_dd_pct'] <= 40.0:
                                            viable_count += 1
                                            score = (res['multiplier_x'] * 2.0) - (res['max_dd_pct'] * 0.05)
                                            cur.execute("""
                                            INSERT INTO viable_configurations (
                                                run_id, multiplier_x, win_rate_pct, max_dd_pct,
                                                strategy_mode, entry_rule, tp_usd, step_usd,
                                                lot_multiplier, max_orders, score
                                            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                                            """, (
                                                run_id, res['multiplier_x'], res['win_rate_pct'], res['max_dd_pct'],
                                                res['strategy_mode'], res['entry_rule'], res['tp_usd'], res['step_usd'],
                                                res['lot_multiplier'], res['max_orders'], score
                                            ))

                                        # Commit periódico cada 20 simulaciones
                                        if count % 20 == 0:
                                            conn.commit()
                                            elapsed = time.time() - start_time
                                            speed = count / elapsed if elapsed > 0 else 0
                                            print(f"[{datetime.now().strftime('%H:%M:%S')}] ⏳ Progreso: {count}/{total_combinations} ({count/total_combinations*100:.1f}%) | Viables: {viable_count} | Vel: {speed:.1f} sims/seg")

    conn.commit()
    conn.close()
    total_elapsed = time.time() - start_time
    print(f"[{datetime.now().strftime('%H:%M:%S')}] 🎉 Barrido finalizado en {total_elapsed:.1f}s. Total simulaciones volcadas: {count}. Configuraciones viables: {viable_count}")

def main():
    parser = argparse.ArgumentParser(description="Laboratorio Cuantitativo XAUUSD Scalping")
    parser.add_argument("--csv", default=DEFAULT_CSV, help="Ruta del CSV de M1")
    parser.add_argument("--bars", type=int, default=150000, help="Cantidad de barras recientes a testear")
    parser.add_argument("--db", default=DB_PATH, help="Ruta de la base de datos SQLite")
    args = parser.parse_args()

    df = load_m1_data(args.csv, max_bars=args.bars)
    run_laboratory_matrix(df, db_path=args.db)

if __name__ == "__main__":
    main()
