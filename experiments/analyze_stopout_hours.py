import sqlite3
import sys
import pandas as pd

if hasattr(sys.stdout, 'reconfigure'):
    sys.stdout.reconfigure(encoding='utf-8')

conn = sqlite3.connect('experiments/xauusd_scalper_lab.db')
query = """
SELECT id, stop_out_date, status, session_filter, max_orders, step_usd 
FROM simulation_runs 
WHERE status='STOP_OUT' AND stop_out_date IS NOT NULL AND stop_out_date != ''
"""
df = pd.read_sql_query(query, conn)
conn.close()

print(f"Total Stop Outs analizados en SQLite: {len(df):,} simulaciones")

df['dt'] = pd.to_datetime(df['stop_out_date'], errors='coerce')
df['hour'] = df['dt'].dt.hour
df['date_only'] = df['dt'].dt.date
df['day_name'] = df['dt'].dt.day_name()

print("\n--- DISTRIBUCIÓN HORARIA DEL STOP OUT (HORA SERVIDOR) ---")
hour_counts = df['hour'].value_counts().sort_index()
for h, cnt in hour_counts.items():
    pct = cnt / len(df) * 100
    bar = '█' * int(pct / 2)
    # Marcar sesiones
    session_label = ""
    if 0 <= h <= 2: session_label = "[Rollover / Pre-Asia]"
    elif 3 <= h <= 6: session_label = "[Asia Core]"
    elif 7 <= h <= 9: session_label = "[Apertura Londres]"
    elif 10 <= h <= 13: session_label = "[Mediodía Londres]"
    elif 14 <= h <= 17: session_label = "[Solapamiento NY / Apertura US]"
    elif 18 <= h <= 21: session_label = "[Tarde NY]"
    elif 22 <= h <= 23: session_label = "[Cierre Diario]"
    
    print(f"  {h:02d}:00  {session_label:32s} : {cnt:4d} quemas ({pct:5.1f}%) {bar}")

print("\n--- DISTRIBUCIÓN POR DÍAS DE LA SEMANA ---")
day_counts = df['day_name'].value_counts()
for d, cnt in day_counts.items():
    print(f"  • {d:10s}: {cnt:4d} quemas ({cnt/len(df)*100:.1f}%)")

print("\n--- FECHAS CONCENTRADAS DE QUEMA MASIVA ---")
date_counts = df['date_only'].value_counts().head(7)
for dt, cnt in date_counts.items():
    print(f"  • {dt}: {cnt:4d} simulaciones quemadas")
