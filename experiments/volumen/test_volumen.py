#!/usr/bin/env python3
"""
FASE 1 - Perfil de volumen (POC / VAH / VAL) y estadisticas en XAUUSD (M1 de MT5)

Uso basico:
    python perfil_volumen_fase1.py --csv XAUUSD_M1.csv --out resultados

Opciones utiles:
    --va 0.70                     % de la Value Area (0.60 - 0.80)
    --bin 0.10                    tamano del nivel de precio en USD (oro: 0.10 = 10 puntos)
    --hold 2                      cierres M30 consecutivos dentro de la VA para validar la regla del 80%
    --sessions "Asia:0-8,Londres:8-15,NY:15-23"   horas del servidor [inicio-fin)
    --daily 0-23                  horas que forman el perfil diario
    --min-bars 30                 minimo de velas M1 para aceptar un perfil

Salidas (carpeta --out):
    hourly_profile.csv    actividad media por hora del servidor (volumen, rango, spread)
    profiles.csv          POC / VAH / VAL de cada sesion y de cada dia
    events.csv            una fila por (dia, sesion, referencia) con lo que paso
    stats_summary.csv     estadisticas globales
    stats_by_weekday.csv  estadisticas por dia de la semana
    stats_by_year.csv     estadisticas por ano

Referencias que se comparan (sin mirar al futuro):
    prev_day      : perfil DIARIO del dia anterior
    prev_session  : sesion anterior en la cadena Asia -> Londres -> NY -> (Asia del dia siguiente)
"""
import argparse
from pathlib import Path

import numpy as np
import pandas as pd

WEEKDAYS = ["Lun", "Mar", "Mie", "Jue", "Vie", "Sab", "Dom"]


# --------------------------------------------------------------------------- carga
def load_m1(path):
    with open(path, "r", encoding="utf-8-sig") as f:
        first = f.readline()
    if "\t" in first:
        sep = "\t"
    elif ";" in first:
        sep = ";"
    elif "," in first:
        sep = ","
    else:
        sep = r"\s+"
    df = pd.read_csv(path, sep=sep, encoding="utf-8-sig",
                     engine="python" if sep == r"\s+" else "c")
    df.columns = [c.strip().strip("<>").lower() for c in df.columns]

    required = {"date", "time", "open", "high", "low", "close"}
    missing = required - set(df.columns)
    if missing:
        raise SystemExit(f"Faltan columnas en el CSV: {sorted(missing)}. Cabeceras leidas: {list(df.columns)}")

    stamp = df["date"].astype(str).str.strip() + " " + df["time"].astype(str).str.strip()
    try:
        df["dt"] = pd.to_datetime(stamp, format="%Y.%m.%d %H:%M:%S")
    except ValueError:
        df["dt"] = pd.to_datetime(stamp, errors="coerce")
    df = df.dropna(subset=["dt"])

    if "tickvol" not in df.columns:
        df["tickvol"] = df["vol"] if "vol" in df.columns else 1.0
    if df["tickvol"].sum() == 0 and "vol" in df.columns:
        df["tickvol"] = df["vol"]
    if "spread" not in df.columns:
        df["spread"] = np.nan

    df = (df[["dt", "open", "high", "low", "close", "tickvol", "spread"]]
          .sort_values("dt").drop_duplicates("dt").reset_index(drop=True))
    df["date"] = df["dt"].dt.normalize()
    df["hour"] = df["dt"].dt.hour
    return df


# --------------------------------------------------------------------------- perfil
def build_profile(g, bin_size):
    """Reparte el tick volume de cada vela M1 de forma uniforme entre los niveles que recorre."""
    lo = g["low"].to_numpy()
    hi = g["high"].to_numpy()
    v = g["tickvol"].to_numpy(dtype=float)
    pmin = np.floor(lo.min() / bin_size) * bin_size
    li = np.floor((lo - pmin) / bin_size + 1e-9).astype(int)
    hi_i = np.floor((hi - pmin) / bin_size + 1e-9).astype(int)
    hi_i = np.maximum(hi_i, li)
    nb = int(hi_i.max()) + 1
    w = v / (hi_i - li + 1)
    diff = np.zeros(nb + 1)
    np.add.at(diff, li, w)
    np.add.at(diff, hi_i + 1, -w)
    vol = np.clip(np.cumsum(diff)[:nb], 0, None)
    return pmin, vol


def value_area(vol, va_pct):
    n = len(vol)
    total = vol.sum()
    center = (n - 1) / 2
    cands = np.flatnonzero(vol >= vol.max() - 1e-9)
    poc = int(cands[np.argmin(np.abs(cands - center))])
    target = total * va_pct
    lo = hi = poc
    acc = vol[poc]
    while acc < target and (lo > 0 or hi < n - 1):
        up_bins = vol[hi + 1:hi + 3]
        dn_bins = vol[max(lo - 2, 0):lo]
        up = up_bins.sum() if len(up_bins) else -1.0
        dn = dn_bins.sum() if len(dn_bins) else -1.0
        if up >= dn:
            acc += up_bins.sum()
            hi += len(up_bins)
        else:
            acc += dn_bins.sum()
            lo -= len(dn_bins)
    return poc, lo, hi


def make_profile_row(name, date, g, bin_size, va_pct):
    pmin, vol = build_profile(g, bin_size)
    if vol.sum() <= 0:
        return None
    poc, lo, hi = value_area(vol, va_pct)
    price = lambda i: pmin + (i + 0.5) * bin_size
    return {
        "profile": name, "date": date, "n_bars": len(g),
        "open": g["open"].iloc[0], "high": g["high"].max(),
        "low": g["low"].min(), "close": g["close"].iloc[-1],
        "tickvol": float(g["tickvol"].sum()),
        "poc": round(price(poc), 4), "vah": round(price(hi), 4), "val": round(price(lo), 4),
        "va_width": round(price(hi) - price(lo), 4),
        "avg_spread_pts": float(g["spread"].mean()) if g["spread"].notna().any() else np.nan,
    }


# --------------------------------------------------------------------------- eventos
def evaluate(g, ref, hold):
    """Que hizo el precio de la sesion `g` respecto a los niveles (POC/VAH/VAL) de la referencia."""
    vah, val, poc = ref["vah"], ref["val"], ref["poc"]
    o = g["open"].iloc[0]
    hi = g["high"].to_numpy()
    lo = g["low"].to_numpy()
    cl = g["close"].to_numpy()

    loc = "arriba" if o > vah else ("abajo" if o < val else "dentro")
    touch_poc = lo.min() <= poc <= hi.max()
    touch_vah = lo.min() <= vah <= hi.max()
    touch_val = lo.min() <= val <= hi.max()

    confirmed = np.nan
    reach_opp = np.nan
    if loc != "dentro":
        confirmed = 0.0
        t = (g["dt"] - g["dt"].iloc[0]).dt.total_seconds().to_numpy()
        block = (t // 1800).astype(int)
        ends = np.flatnonzero(np.diff(block, append=block[-1] + 1))
        inside = ((cl[ends] <= vah) & (cl[ends] >= val)).astype(int)
        if len(inside) >= hold:
            run = np.convolve(inside, np.ones(hold, dtype=int), "valid") == hold
            ks = np.flatnonzero(run)
            if len(ks):
                confirmed = 1.0
                c = ends[ks[0] + hold - 1]
                if loc == "arriba":
                    reach_opp = float(c + 1 < len(lo) and lo[c + 1:].min() <= val)
                else:
                    reach_opp = float(c + 1 < len(hi) and hi[c + 1:].max() >= vah)

    return {
        "open_loc": loc,
        "touch_poc": float(touch_poc),
        "touch_vah": float(touch_vah),
        "touch_val": float(touch_val),
        "full_rotation": float(touch_vah and touch_val),
        "confirmed80": confirmed,
        "reach_opp": reach_opp,
    }


def summarize(ev, by):
    out = ev.groupby(by).agg(
        n=("touch_poc", "size"),
        pct_touch_poc=("touch_poc", "mean"),
        pct_touch_vah=("touch_vah", "mean"),
        pct_touch_val=("touch_val", "mean"),
        pct_full_rotation=("full_rotation", "mean"),
        pct_confirmed_80=("confirmed80", "mean"),
        n_confirmed=("reach_opp", "count"),
        pct_reach_opposite_if_confirmed=("reach_opp", "mean"),
    ).reset_index()
    for c in out.columns:
        if c.startswith("pct_"):
            out[c] = (out[c] * 100).round(1)
    base = [c for c in by if c not in ("open_loc", "weekday", "year")]
    out["pct_of_days"] = (out["n"] / out.groupby(base)["n"].transform("sum") * 100).round(1)
    return out


# --------------------------------------------------------------------------- main
def parse_sessions(s):
    out = []
    for part in s.split(","):
        name, rng = part.split(":")
        a, b = rng.split("-")
        out.append((name.strip(), int(a), int(b)))
    return out


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--csv", required=True)
    ap.add_argument("--out", default="resultados_fase1")
    ap.add_argument("--va", type=float, default=0.70)
    ap.add_argument("--bin", type=float, default=0.10)
    ap.add_argument("--hold", type=int, default=2)
    ap.add_argument("--sessions", default="Asia:0-8,Londres:8-15,NY:15-23")
    ap.add_argument("--daily", default="0-23")
    ap.add_argument("--min-bars", type=int, default=30)
    args = ap.parse_args()

    out_dir = Path(args.out)
    out_dir.mkdir(parents=True, exist_ok=True)

    print("Cargando datos...")
    df = load_m1(args.csv)
    print(f"  {len(df):,} velas M1  |  {df['dt'].min()}  ->  {df['dt'].max()}")

    # --- actividad por hora (responde a la pregunta inicial sobre el volumen por hora)
    h = df.groupby(["date", "hour"]).agg(tickvol=("tickvol", "sum"), hi=("high", "max"),
                                          lo=("low", "min"), spread=("spread", "mean"))
    h["range"] = h["hi"] - h["lo"]
    hp = h.groupby("hour").agg(avg_tickvol=("tickvol", "mean"), avg_range=("range", "mean"),
                               avg_spread_pts=("spread", "mean"), days=("tickvol", "size"))
    hp["pct_of_day_volume"] = hp["avg_tickvol"] / hp["avg_tickvol"].sum() * 100
    hp.round(2).to_csv(out_dir / "hourly_profile.csv")

    sessions = parse_sessions(args.sessions)
    d0, d1 = (int(x) for x in args.daily.split("-"))
    first_s, last_s = sessions[0][0], sessions[-1][0]

    profiles, events = [], []
    last_daily = None
    last_by_name = {}

    print("Construyendo perfiles y evaluando eventos...")
    for date, day in df.groupby("date", sort=True):
        today = {}
        for idx, (name, a, b) in enumerate(sessions):
            g = day[(day["hour"] >= a) & (day["hour"] < b)]
            if len(g) < args.min_bars:
                continue
            row = make_profile_row(name, date, g, args.bin, args.va)
            if row is None:
                continue
            profiles.append(row)
            today[name] = row

            refs = []
            if last_daily is not None and (date - last_daily["date"]).days <= 5:
                refs.append(("prev_day", last_daily))
            prev_name = sessions[idx - 1][0] if idx > 0 else last_s
            prev = today.get(prev_name) if idx > 0 else last_by_name.get(last_s)
            if prev is not None and (date - prev["date"]).days <= 5:
                refs.append(("prev_session", prev))
            for ref_type, ref in refs:
                ev = evaluate(g, ref, args.hold)
                ev.update(date=date, target=name, ref_type=ref_type, ref_profile=ref["profile"])
                events.append(ev)

        g = day[(day["hour"] >= d0) & (day["hour"] < d1)]
        if len(g) >= args.min_bars:
            row = make_profile_row("Diario", date, g, args.bin, args.va)
            if row is not None:
                profiles.append(row)
                if last_daily is not None and (date - last_daily["date"]).days <= 5:
                    ev = evaluate(g, last_daily, args.hold)
                    ev.update(date=date, target="Diario", ref_type="prev_day", ref_profile="Diario")
                    events.append(ev)
                last_daily = row
        last_by_name.update(today)

    prof = pd.DataFrame(profiles)
    ev = pd.DataFrame(events)
    ev["year"] = ev["date"].dt.year
    ev["weekday"] = ev["date"].dt.weekday.map(lambda i: WEEKDAYS[i])

    prof.to_csv(out_dir / "profiles.csv", index=False)
    ev.to_csv(out_dir / "events.csv", index=False)
    base = ["target", "ref_type", "open_loc"]
    summarize(ev, base).to_csv(out_dir / "stats_summary.csv", index=False)
    summarize(ev, base + ["weekday"]).to_csv(out_dir / "stats_by_weekday.csv", index=False)
    summarize(ev, base + ["year"]).to_csv(out_dir / "stats_by_year.csv", index=False)

    print(f"\nPerfiles: {len(prof):,}   Eventos: {len(ev):,}")
    print("\nResumen (VA {:.0%}, bin {}):".format(args.va, args.bin))
    pd.set_option("display.width", 200)
    pd.set_option("display.max_columns", 20)
    print(summarize(ev, base).to_string(index=False))
    print(f"\nArchivos guardados en: {out_dir.resolve()}")
    print("Aviso: grupos con n < 30 no son fiables estadisticamente.")


if __name__ == "__main__":
    main()
