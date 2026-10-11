import sqlite3

conn = sqlite3.connect('experiments/xauusd_scalper_lab.db')
cur = conn.cursor()

print("--- TOP 5 MÁXIMO MULTIPLICADOR (CON MAX DD < 40%) ---")
cur.execute('''
    SELECT id, strategy_mode, entry_rule, tp_usd, step_usd, reentry_delay_bars, lot_multiplier, max_orders, 
           session_filter, use_margin_scaling, initial_balance, final_balance, multiplier_x, max_dd_pct, total_cycles
    FROM simulation_runs
    WHERE status = 'SURVIVED' AND max_dd_pct <= 40.0
    ORDER BY multiplier_x DESC
    LIMIT 5
''')
for r in cur.fetchall():
    print(r)

print("\n--- TOP 5 CONSERVADORAS (MAX DD < 25%) ---")
cur.execute('''
    SELECT id, strategy_mode, entry_rule, tp_usd, step_usd, reentry_delay_bars, lot_multiplier, max_orders, 
           session_filter, use_margin_scaling, initial_balance, final_balance, multiplier_x, max_dd_pct, total_cycles
    FROM simulation_runs
    WHERE status = 'SURVIVED' AND max_dd_pct <= 25.0 AND multiplier_x >= 1.5
    ORDER BY multiplier_x DESC
    LIMIT 5
''')
for r in cur.fetchall():
    print(r)

print("\n--- CONFIGURACIÓN EXTREMA MÁXIMO BENEFICIO HISTÓRICO (INCLUYENDO CUALQUIER DD) ---")
cur.execute('''
    SELECT id, strategy_mode, entry_rule, tp_usd, step_usd, reentry_delay_bars, lot_multiplier, max_orders, 
           session_filter, use_margin_scaling, initial_balance, final_balance, multiplier_x, max_dd_pct, total_cycles, status
    FROM simulation_runs
    ORDER BY multiplier_x DESC
    LIMIT 5
''')
for r in cur.fetchall():
    print(r)

conn.close()
