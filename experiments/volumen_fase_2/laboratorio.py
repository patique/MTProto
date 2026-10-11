#!/usr/bin/env python3
"""
FASE 2 - Laboratorio de backtest (XAUUSD M1, MT5)

Una sola ejecucion prueba TODAS las combinaciones de:
    % de Value Area  x  tipo de entrada  x  SL (pips fijos y ATR)  x  RR (1..20 + objetivo=extremo opuesto)
    x  Break Even (sin BE / 0.5R / 1R)  x  par sesion-referencia
y las valida con WALK-FORWARD (optimiza con N anos, prueba en el siguiente, y rueda).
Incluye grupo de CONTROL (niveles desplazados al azar) y simulacion de reto de fondeo (DD diario/total).

Uso basico:
    python laboratorio_fase2.py --csv XAUUSD_M1.csv --out resultados_fase2

Logica de la senal (regla del 80% de Market Profile):
    La sesion abre FUERA de la Value Area de referencia. Si el precio vuelve a entrar en la VA,
    se opera hacia el extremo opuesto (abre arriba -> venta hacia VAL; abre abajo -> compra hacia VAH).
Entradas:
    confirm_mkt : a mercado tras --hold cierres M30 consecutivos dentro de la VA (regla del 80% clasica)
    reentry_mkt : a mercado tras el primer cierre M30 dentro de la VA
    limit_edge  : orden limit en el borde de la VA (retest desde dentro) tras la re-entrada
    rejection   : vela de rechazo (--rej-tf min) que sonda el borde y cierra de nuevo dentro; entrada a mercado

Reglas conservadoras de simulacion con velas M1:
    * Si SL y TP caben en la misma vela -> cuenta como PERDIDA.
    * Spread real de cada vela (columna SPREAD): compras a ask, ventas a bid.
    * BE se activa al cierre de la vela que alcanza el nivel y actua desde la vela siguiente.
    * Slippage fijo (--slip, en USD) en salidas por SL/BE.
    * Operaciones sin SL/TP se cierran al final de la sesion.
"""
import argparse
from pathlib import Path

import numpy as np
import pandas as pd

# =========================================================================== carga
def load_m1(path):
    with open(path, "r", encoding="utf-8-sig") as f:
        first = f.readline()
    sep = "\t" if "\t" in first else (";" if ";" in first else ("," if "," in first else r"\s+"))
    df = pd.read_csv(path, sep=sep, encoding="utf-8-sig", engine="python" if sep == r"\s+" else "c")
    df.columns = [c.strip().strip("<>").lower() for c in df.columns]
    need = {"date", "time", "open", "high", "low", "close"}
    if need - set(df.columns):
        raise SystemExit(f"Faltan columnas: {sorted(need - set(df.columns))}. Leidas: {list(df.columns)}")
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
        df["spread"] = 0.0
    df["spread"] = df["spread"].fillna(0.0)
    df = (df[["dt", "open", "high", "low", "close", "tickvol", "spread"]]
          .sort_values("dt").drop_duplicates("dt").reset_index(drop=True))
    return df


# =========================================================================== perfil
def build_profile(lo, hi, v, bin_size):
    pmin = np.floor(lo.min() / bin_size) * bin_size
    li = np.floor((lo - pmin) / bin_size + 1e-9).astype(int)
    hi_i = np.maximum(np.floor((hi - pmin) / bin_size + 1e-9).astype(int), li)
    nb = int(hi_i.max()) + 1
    w = v / (hi_i - li + 1)
    diff = np.zeros(nb + 1)
    np.add.at(diff, li, w)
    np.add.at(diff, hi_i + 1, -w)
    return pmin, np.clip(np.cumsum(diff)[:nb], 0, None)


def value_area(vol, va_pct):
    n = len(vol)
    cands = np.flatnonzero(vol >= vol.max() - 1e-9)
    poc = int(cands[np.argmin(np.abs(cands - (n - 1) / 2))])
    target = vol.sum() * va_pct
    lo = hi = poc
    acc = vol[poc]
    while acc < target and (lo > 0 or hi < n - 1):
        up_b = vol[hi + 1:hi + 3]
        dn_b = vol[max(lo - 2, 0):lo]
        up = up_b.sum() if len(up_b) else -1.0
        dn = dn_b.sum() if len(dn_b) else -1.0
        if up >= dn:
            acc += up_b.sum()
            hi += len(up_b)
        else:
            acc += dn_b.sum()
            lo -= len(dn_b)
    return poc, lo, hi


# =========================================================================== simulacion de UNA operacion
def sim_trade(direction, entry, hi, lo, cl, spr, ds, rr_grid, tp_target, be_grid, slip, limit_fill):
    """
    Devuelve R para todas las combinaciones SL x (RR + objetivo VA) x (sinBE + BEs).
    direction: 1 compra (entry = ask), -1 venta (entry = bid). hi/lo/cl son BID; spr en precio.
    Salida: array (nSL, nRR+1, nBE+1).
    """
    n = len(hi)
    if direction == 1:
        fav = hi - entry
        adv = entry - lo
        pnl_last = cl[-1] - entry
    else:
        fav = entry - (lo + spr)
        adv = (hi + spr) - entry
        pnl_last = entry - (cl[-1] + spr[-1])
    if limit_fill:                      # en la vela de relleno no contamos el movimiento favorable
        fav = fav.copy()
        fav[0] = min(fav[0], 0.0)
    fmax = np.maximum.accumulate(fav)
    amax = np.maximum.accumulate(adv)

    nS = len(ds)
    tps = np.concatenate([ds[:, None] * rr_grid[None, :], np.full((nS, 1), tp_target)], axis=1)
    i_sl = np.searchsorted(amax, ds, side="left")
    i_tp = np.searchsorted(fmax, tps.ravel(), side="left").reshape(tps.shape)
    isl = i_sl[:, None]

    win0 = (i_tp < n) & (i_tp < isl)
    loss0 = (isl < n) & (isl <= i_tp)
    r_win = tps / ds[:, None]
    r_loss = -(1.0 + slip / ds)[:, None]
    r_to = (pnl_last / ds)[:, None]
    base = np.where(win0, r_win, np.where(loss0, r_loss, r_to))
    outs = [base]

    if len(be_grid):
        neg_idx = np.flatnonzero(adv >= 0)
        neg_ext = np.append(neg_idx, n)
        for x in be_grid:
            i_be = np.searchsorted(fmax, x * ds, side="left")
            t_ret = neg_ext[np.searchsorted(neg_idx, i_be, side="right")]
            applies = (i_be[:, None] < isl) & (i_be[:, None] < i_tp)
            tr = t_ret[:, None]
            win_a = (i_tp < n) & (i_tp < tr)
            scr_a = (tr < n) & (tr <= i_tp)
            r_scr = -(slip / ds)[:, None]
            alt = np.where(win_a, r_win, np.where(scr_a, r_scr, r_to))
            outs.append(np.where(applies, alt, base))
    return np.stack(outs, axis=2)


# =========================================================================== entradas
def find_entries(S, direction, L, vah, val, entries, hold, op, hi, lo, spr, i0):
    """Devuelve {tipo: (indice_local_vela, precio_entrada, es_limit)}."""
    n = S["n"]
    ends, cl30 = S["ends30"], S["cl30"]
    inside = (cl30 <= vah) & (cl30 >= val)
    ks = np.flatnonzero(inside)
    out = {}
    if len(ks) == 0:
        return out
    c_re = ends[ks[0]]

    def mkt(b):
        px = op[i0 + b]
        return (b, px + spr[i0 + b], False) if direction == 1 else (b, px, False)

    if "reentry_mkt" in entries and c_re + 1 < n:
        out["reentry_mkt"] = mkt(c_re + 1)
    if "confirm_mkt" in entries:
        if hold <= 1:
            kk = ks
        else:
            run = np.convolve(inside.astype(int), np.ones(hold, dtype=int), "valid") == hold
            kk = np.flatnonzero(run)
            kk = kk + hold - 1
        if len(kk):
            c = ends[kk[0]]
            if c + 1 < n:
                out["confirm_mkt"] = mkt(c + 1)
    if "limit_edge" in entries and c_re + 1 < n:
        h = hi[i0 + c_re + 1:i0 + n]
        l_ = lo[i0 + c_re + 1:i0 + n]
        s_ = spr[i0 + c_re + 1:i0 + n]
        hit = (h >= L) if direction == -1 else ((l_ + s_) <= L)
        if hit.any():
            j = c_re + 1 + int(np.argmax(hit))
            out["limit_edge"] = (j, L, True)
    if "rejection" in entries and S["rs"] is not None:
        rs, re_, ro, rh, rl, rc = S["rs"], S["re"], S["ro"], S["rh"], S["rl"], S["rc"]
        if direction == -1:
            cond = (rh >= L) & (rc < L) & (rc < ro) & (rs > c_re)
        else:
            cond = (rl <= L) & (rc > L) & (rc > ro) & (rs > c_re)
        if cond.any():
            j = int(np.argmax(cond))
            b = re_[j] + 1
            if b < n:
                out["rejection"] = mkt(b)
    return out


def session_struct(i0, i1, tmin, op, hi, lo, cl, rej_min):
    n = i1 - i0
    loc = tmin[i0:i1] - tmin[i0]
    b30 = loc // 30
    ends30 = np.flatnonzero(np.diff(b30, append=b30[-1] + 1))
    S = {"n": n, "ends30": ends30, "cl30": cl[i0:i1][ends30], "rs": None}
    if rej_min:
        br = loc // rej_min
        starts = np.flatnonzero(np.diff(br, prepend=-1))
        ends = np.flatnonzero(np.diff(br, append=br[-1] + 1))
        h_, l_ = hi[i0:i1], lo[i0:i1]
        S.update(rs=starts, re=ends, ro=op[i0:i1][starts],
                 rh=np.maximum.reduceat(h_, starts), rl=np.minimum.reduceat(l_, starts),
                 rc=cl[i0:i1][ends])
    return S


# =========================================================================== eventos
def build_events(A, sessions, daily, pairs, va_list, bin_size, min_bars):
    dtv = A["dtm"]
    dates = np.unique(dtv.astype("datetime64[D]"))
    names = [s[0] for s in sessions]
    last_s = names[-1]
    events = []
    last_daily = None
    last_by_name = {}

    def idx(d, a, b):
        t0 = d.astype("datetime64[m]") + np.timedelta64(a * 60, "m")
        t1 = d.astype("datetime64[m]") + np.timedelta64(b * 60, "m")
        return int(np.searchsorted(dtv, t0, "left")), int(np.searchsorted(dtv, t1, "left"))

    def levels(i0, i1):
        pmin, vol = build_profile(A["lo"][i0:i1], A["hi"][i0:i1], A["v"][i0:i1], bin_size)
        if vol.sum() <= 0:
            return None
        out = {}
        for va in va_list:
            poc, l_, h_ = value_area(vol, va)
            f = lambda i: pmin + (i + 0.5) * bin_size
            out[va] = (f(poc), f(h_), f(l_))
        return out

    for d in dates:
        today = {}
        for k, (name, a, b) in enumerate(sessions):
            i0, i1 = idx(d, a, b)
            if i1 - i0 < min_bars:
                continue
            lv = levels(i0, i1)
            if lv is None:
                continue
            prof = {"date": d, "levels": lv}
            today[name] = prof
            for tname, rtype in pairs:
                if tname != name:
                    continue
                ref = None
                if rtype == "prev_day":
                    ref = last_daily
                elif rtype == "prev_session":
                    ref = today.get(names[k - 1]) if k > 0 else last_by_name.get(last_s)
                if ref is not None and (d - ref["date"]).astype(int) <= 5:
                    events.append(dict(pair=f"{tname}|{rtype}", date=d, i0=i0, i1=i1, levels=ref["levels"]))
        i0, i1 = idx(d, daily[0], daily[1])
        if i1 - i0 >= min_bars:
            lv = levels(i0, i1)
            if lv is not None:
                prof = {"date": d, "levels": lv}
                for tname, rtype in pairs:
                    if tname == "Diario" and rtype == "prev_day" and last_daily is not None \
                            and (d - last_daily["date"]).astype(int) <= 5:
                        events.append(dict(pair="Diario|prev_day", date=d, i0=i0, i1=i1,
                                           levels=last_daily["levels"]))
                last_daily = prof
        last_by_name.update(today)
    return events


# =========================================================================== simulacion global
class Grid:
    def __init__(self, a):
        self.va = a.va_list
        self.entries = a.entries
        self.sl_pips = np.array(a.sl_pips, dtype=float) * a.pip
        self.sl_atr = np.array(a.sl_atr, dtype=float)
        self.rr = np.array(a.rr, dtype=float)
        self.be = np.array(a.be, dtype=float)
        sl_lab = [f"{p:g}p" for p in a.sl_pips] + [f"ATR{k:g}" for k in a.sl_atr]
        rr_lab = [f"{r:g}" for r in a.rr] + ["VA"]
        be_lab = ["sinBE"] + [f"BE{x:g}R" for x in a.be]
        self.labels = (sl_lab, rr_lab, be_lab)
        self.K = len(sl_lab) * len(rr_lab) * len(be_lab)
        s, r, b = np.meshgrid(np.arange(len(sl_lab)), np.arange(len(rr_lab)), np.arange(len(be_lab)), indexing="ij")
        self.inner = pd.DataFrame({"sl": np.array(sl_lab)[s.ravel()], "rr": np.array(rr_lab)[r.ravel()],
                                   "be": np.array(be_lab)[b.ravel()]})


def simulate_all(events, A, G, a, rng=None):
    acc = {}
    for ev in events:
        i0, i1 = ev["i0"], ev["i1"]
        n = i1 - i0
        S = session_struct(i0, i1, A["tmin"], A["op"], A["hi"], A["lo"], A["cl"], a.rej_tf)
        o = A["op"][i0]
        for va in G.va:
            poc, vah, val = ev["levels"][va]
            if rng is not None:
                w = max(vah - val, a.bin)
                sh = rng.choice([-1.0, 1.0]) * rng.uniform(1.0, 2.0) * w
                poc, vah, val = poc + sh, vah + sh, val + sh
            if o > vah:
                direction, L, T = -1, vah, val
            elif o < val:
                direction, L, T = 1, val, vah
            else:
                continue
            ents = find_entries(S, direction, L, vah, val, G.entries, a.hold,
                                A["op"], A["hi"], A["lo"], A["spr"], i0)
            for et, (b, entry, is_lmt) in ents.items():
                g0 = i0 + b
                atr = A["atr"][g0]
                if not np.isfinite(atr) or atr <= 0:
                    continue
                tp_t = (entry - T) if direction == -1 else (T - entry)
                if tp_t < a.min_target:
                    continue
                ds = np.concatenate([G.sl_pips, G.sl_atr * atr])
                R = sim_trade(direction, entry, A["hi"][g0:i1], A["lo"][g0:i1], A["cl"][g0:i1],
                              A["spr"][g0:i1], ds, G.rr, tp_t, G.be, a.slip, is_lmt)
                key = (ev["pair"], va, et)
                rec = acc.setdefault(key, {"R": [], "ts": [], "yr": []})
                rec["R"].append(R.ravel().astype(np.float32))
                rec["ts"].append(int(A["tmin"][g0]))
                rec["yr"].append(int(str(ev["date"])[:4]))
    groups = []
    for key in sorted(acc):
        r = acc[key]
        groups.append({"key": key, "R": np.vstack(r["R"]), "ts": np.array(r["ts"]), "yr": np.array(r["yr"])})
    return groups


# =========================================================================== metricas
def year_stats(groups, years, K):
    Y, Gn = len(years), len(groups)
    n = np.zeros((Y, Gn * K))
    s1 = np.zeros_like(n); s2 = np.zeros_like(n); gp = np.zeros_like(n); gl = np.zeros_like(n); w = np.zeros_like(n)
    for gi, g in enumerate(groups):
        sl = slice(gi * K, (gi + 1) * K)
        for yi, y in enumerate(years):
            m = g["yr"] == y
            if not m.any():
                continue
            R = g["R"][m].astype(np.float64)
            n[yi, sl] = m.sum()
            s1[yi, sl] = R.sum(0)
            s2[yi, sl] = (R ** 2).sum(0)
            gp[yi, sl] = np.where(R > 0, R, 0).sum(0)
            gl[yi, sl] = np.where(R < 0, -R, 0).sum(0)
            w[yi, sl] = (R > 0).sum(0)
    return dict(n=n, s1=s1, s2=s2, gp=gp, gl=gl, w=w)


def agg(st, ys):
    n = st["n"][ys].sum(0)
    s1 = st["s1"][ys].sum(0)
    s2 = st["s2"][ys].sum(0)
    with np.errstate(divide="ignore", invalid="ignore"):
        mean = np.where(n > 0, s1 / n, np.nan)
        var = np.where(n > 0, s2 / n - mean ** 2, np.nan)
        se = np.sqrt(np.maximum(var, 0) / np.maximum(n, 1))
        pf = np.where(st["gl"][ys].sum(0) > 0, st["gp"][ys].sum(0) / st["gl"][ys].sum(0), np.nan)
        wr = np.where(n > 0, st["w"][ys].sum(0) / n, np.nan)
    return dict(n=n, mean=mean, score=mean - se, pf=pf, wr=wr)


def series_stats(R, ts):
    if len(R) == 0:
        return dict(n=0, exp_R=np.nan, win_pct=np.nan, pf=np.nan, total_R=0.0, maxDD_R=0.0,
                    worst_day_R=0.0, max_loss_streak=0)
    o = np.argsort(ts, kind="stable")
    R, ts = R[o], ts[o]
    eq = np.cumsum(R)
    dd = float(np.max(np.maximum.accumulate(np.r_[0, eq]) - np.r_[0, eq]))
    days = ts // 1440
    wd = float(min(R[days == d].sum() for d in np.unique(days)))
    streak = best = 0
    for r in R:
        streak = streak + 1 if r < 0 else 0
        best = max(best, streak)
    gl = -R[R < 0].sum()
    return dict(n=len(R), exp_R=float(R.mean()), win_pct=float((R > 0).mean() * 100),
                pf=float(R[R > 0].sum() / gl) if gl > 0 else np.nan, total_R=float(R.sum()),
                maxDD_R=dd, worst_day_R=wd, max_loss_streak=best)


def walk_forward(groups, G, years, a):
    K = G.K
    st = year_stats(groups, years, K)
    folds, oos = [], []
    for i in range(len(years) - a.train_years):
        tr = list(range(i, i + a.train_years))
        te = i + a.train_years
        A_ = agg(st, tr)
        sc = np.where(A_["n"] >= a.min_trades, A_["score"], -np.inf)
        if not np.isfinite(sc).any():
            continue
        best = int(np.nanargmax(sc))
        gi, k = divmod(best, K)
        g = groups[gi]
        m = g["yr"] == years[te]
        R = g["R"][m, k].astype(np.float64)
        T = agg(st, [te])
        folds.append(dict(train=f"{years[tr[0]]}-{years[tr[-1]]}", test=years[te],
                          pair=g["key"][0], va=g["key"][1], entry=g["key"][2],
                          sl=G.inner.sl[k], rr=G.inner.rr[k], be=G.inner.be[k],
                          train_n=int(A_["n"][best]), train_exp_R=A_["mean"][best], train_pf=A_["pf"][best],
                          test_n=int(len(R)), test_exp_R=float(R.mean()) if len(R) else np.nan,
                          test_total_R=float(R.sum())))
        for r, t in zip(R, g["ts"][m]):
            oos.append((years[te], int(t), float(r)))
    oos = pd.DataFrame(oos, columns=["year", "ts", "R"])
    return pd.DataFrame(folds), oos, st


# =========================================================================== reto de fondeo (Monte Carlo)
def prop_sim(oos, risk, dd_daily, dd_total, target, rng, n_paths=3000, max_days=260):
    o = oos.sort_values("ts")
    days = (o["ts"] // 1440).to_numpy()
    R = o["R"].to_numpy()
    dsum, dmin = [], []
    for d in np.unique(days):
        cs = np.cumsum(R[days == d])
        dsum.append(cs[-1])
        dmin.append(min(0.0, cs.min()))
    dsum, dmin = np.array(dsum), np.array(dmin)
    nd = len(dsum)
    idx = rng.integers(0, nd, size=(n_paths, max_days))
    eq = np.zeros(n_paths)
    alive = np.ones(n_paths, bool)
    status = np.zeros(n_paths, int)          # 1 pasa, -1 quemada
    t_pass = np.full(n_paths, np.nan)
    for t in range(max_days):
        ds_, dm_ = dsum[idx[:, t]] * risk, dmin[idx[:, t]] * risk
        breach = alive & ((dm_ <= -dd_daily) | (eq + dm_ <= -dd_total))
        status[breach] = -1
        alive &= ~breach
        eq = np.where(alive, eq + ds_, eq)
        done = alive & (eq >= target)
        status[done] = 1
        t_pass[done] = t + 1
        alive &= ~done
    return dict(risk_pct=risk, pct_pass=100 * (status == 1).mean(), pct_burn=100 * (status == -1).mean(),
                pct_open=100 * (status == 0).mean(), median_days_to_pass=float(np.nanmedian(t_pass))
                if np.isfinite(t_pass).any() else np.nan)


# =========================================================================== main
def flist(s):
    return [float(x) for x in s.split(",") if x.strip()]


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--csv", required=True)
    ap.add_argument("--out", default="resultados_fase2")
    ap.add_argument("--sessions", default="Asia:0-8,Londres:8-15,NY:15-23")
    ap.add_argument("--daily", default="0-23")
    ap.add_argument("--pairs", default="Londres:prev_session,NY:prev_session,Diario:prev_day")
    ap.add_argument("--va", default="0.60,0.68,0.70,0.75,0.80")
    ap.add_argument("--entries", default="confirm_mkt,reentry_mkt,limit_edge,rejection")
    ap.add_argument("--sl-pips", default="15,20,30,40,50,75,100,150")
    ap.add_argument("--sl-atr", default="0.5,1,1.5,2,3")
    ap.add_argument("--rr", default="1,1.5,2,3,4,5,7,10,15,20")
    ap.add_argument("--be", default="0.5,1")
    ap.add_argument("--bin", type=float, default=0.10)
    ap.add_argument("--hold", type=int, default=2)
    ap.add_argument("--rej-tf", type=int, default=5)
    ap.add_argument("--min-bars", type=int, default=30)
    ap.add_argument("--min-target", type=float, default=2.0, help="distancia minima (USD) al extremo opuesto")
    ap.add_argument("--pip", type=float, default=0.10, help="USD por pip en oro")
    ap.add_argument("--point", type=float, default=0.01, help="USD por punto (columna SPREAD)")
    ap.add_argument("--slip", type=float, default=0.05, help="slippage USD en salidas por SL/BE")
    ap.add_argument("--train-years", type=int, default=3)
    ap.add_argument("--split-year", type=int, default=2023, help="ultimo ano del periodo A en los marginales")
    ap.add_argument("--min-trades", type=int, default=100, help="minimo de operaciones para elegir en entrenamiento")
    ap.add_argument("--risk", default="0.25,0.5,1.0")
    ap.add_argument("--dd-daily", type=float, default=5.0)
    ap.add_argument("--dd-total", type=float, default=10.0)
    ap.add_argument("--target", type=float, default=10.0)
    ap.add_argument("--control", type=int, default=2, help="n de ejecuciones de control (0 = omitir)")
    ap.add_argument("--seed", type=int, default=42)
    a = ap.parse_args()

    a.va_list = flist(a.va)
    a.entries = [x.strip() for x in a.entries.split(",")]
    a.sl_pips, a.sl_atr, a.rr, a.be = flist(a.sl_pips), flist(a.sl_atr), flist(a.rr), flist(a.be)
    sessions = []
    for part in a.sessions.split(","):
        nm, rng_ = part.split(":")
        s0, s1 = rng_.split("-")
        sessions.append((nm.strip(), int(s0), int(s1)))
    daily = tuple(int(x) for x in a.daily.split("-"))
    pairs = [tuple(p.split(":")) for p in a.pairs.split(",")]
    out = Path(a.out)
    out.mkdir(parents=True, exist_ok=True)
    rng = np.random.default_rng(a.seed)

    print("Cargando datos...")
    df = load_m1(a.csv)
    print(f"  {len(df):,} velas M1 | {df['dt'].min()} -> {df['dt'].max()}")
    dtm = df["dt"].values.astype("datetime64[m]")
    tr_ = pd.concat([df["high"] - df["low"], (df["high"] - df["close"].shift()).abs(),
                     (df["low"] - df["close"].shift()).abs()], axis=1).max(axis=1)
    m15 = pd.DataFrame({"h": df["high"], "l": df["low"], "c": df["close"]}).set_index(df["dt"]).resample("15min").agg(
        {"h": "max", "l": "min", "c": "last"}).dropna()
    pc = m15["c"].shift()
    tr15 = pd.concat([m15["h"] - m15["l"], (m15["h"] - pc).abs(), (m15["l"] - pc).abs()], axis=1).max(axis=1)
    atr15 = tr15.rolling(14).mean().shift(1)
    atr1 = atr15.reindex(df["dt"], method="ffill").to_numpy()
    A = dict(dtm=dtm, tmin=dtm.astype("int64"), op=df["open"].to_numpy(), hi=df["high"].to_numpy(),
             lo=df["low"].to_numpy(), cl=df["close"].to_numpy(), v=df["tickvol"].to_numpy(dtype=float),
             spr=df["spread"].to_numpy() * a.point, atr=atr1)

    print("Construyendo perfiles y eventos...")
    events = build_events(A, sessions, daily, pairs, a.va_list, a.bin, a.min_bars)
    print(f"  {len(events):,} eventos (sesion x referencia)")

    G = Grid(a)
    n_groups_est = len(pairs) * len(a.va_list) * len(a.entries)
    print(f"Simulando operaciones... ({n_groups_est} grupos x {G.K} combinaciones = {n_groups_est * G.K:,})")
    groups = simulate_all(events, A, G, a)
    years = sorted({int(y) for g in groups for y in np.unique(g["yr"])})
    print(f"  {len(groups)} grupos con operaciones | anos: {years[0]}-{years[-1]}")

    # ---- tabla de combinaciones
    st = year_stats(groups, years, G.K)
    yA = [i for i, y in enumerate(years) if y <= a.split_year]
    yB = [i for i, y in enumerate(years) if y > a.split_year]
    AA, BB, ALL = agg(st, yA), agg(st, yB), agg(st, list(range(len(years))))
    meta = pd.concat([pd.concat([pd.DataFrame({"pair": g["key"][0], "va": g["key"][1], "entry": g["key"][2]},
                                              index=range(G.K)), G.inner], axis=1) for g in groups],
                     ignore_index=True)
    meta["n"] = ALL["n"]; meta["exp_R"] = ALL["mean"]; meta["win_pct"] = ALL["wr"] * 100; meta["pf"] = ALL["pf"]
    meta["nA"] = AA["n"]; meta["expA"] = AA["mean"]; meta["nB"] = BB["n"]; meta["expB"] = BB["mean"]
    for yi, y in enumerate(years):
        with np.errstate(divide="ignore", invalid="ignore"):
            meta[f"exp_{y}"] = np.where(st["n"][yi] > 0, st["s1"][yi] / st["n"][yi], np.nan)
    meta["years_pos"] = (meta[[f"exp_{y}" for y in years]] > 0).sum(axis=1)
    meta["stab"] = np.fmin(meta["expA"], meta["expB"])
    meta.round(4).to_csv(out / "combos.csv", index=False)

    ok = (meta["nA"] >= 40) & (meta["nB"] >= 40)
    top = meta[ok].sort_values("stab", ascending=False).head(100)
    top.round(4).to_csv(out / "top_estables_INSAMPLE.csv", index=False)

    rows = []
    for dim in ["pair", "va", "entry", "sl", "rr", "be"]:
        for val_, d in meta[ok].groupby(dim):
            rows.append(dict(parametro=dim, valor=val_, combos=len(d),
                             exp_mediana_A=d["expA"].median(), exp_mediana_B=d["expB"].median(),
                             pct_combos_pos_A=(d["expA"] > 0).mean() * 100, pct_combos_pos_B=(d["expB"] > 0).mean() * 100))
    marg = pd.DataFrame(rows).round(4)
    marg.to_csv(out / "marginales.csv", index=False)

    # ---- walk-forward
    folds, oos, _ = walk_forward(groups, G, years, a)
    folds.round(4).to_csv(out / "wf_folds.csv", index=False)
    oos.to_csv(out / "wf_oos_trades.csv", index=False)
    pd.set_option("display.width", 220); pd.set_option("display.max_columns", 30)
    print("\n================ WALK-FORWARD (optimiza con {} anos, prueba en el siguiente) ================".format(a.train_years))
    if len(folds):
        print(folds.round(3).to_string(index=False))
        ss = series_stats(oos["R"].to_numpy(), oos["ts"].to_numpy())
        print("\nRESULTADO FUERA DE MUESTRA (todos los tramos de prueba juntos):")
        for k_, v_ in ss.items():
            print(f"  {k_:>16}: {v_:.3f}" if isinstance(v_, float) else f"  {k_:>16}: {v_}")
        pd.DataFrame([ss]).round(4).to_csv(out / "wf_resumen.csv", index=False)
        sims = [dict(prop_sim(oos, r, a.dd_daily, a.dd_total, a.target, rng)) for r in flist(a.risk)]
        sim = pd.DataFrame(sims).round(1)
        sim.to_csv(out / "reto_fondeo_sim.csv", index=False)
        print(f"\nSIMULACION DE RETO (DD diario {a.dd_daily}%, DD total {a.dd_total}%, objetivo {a.target}%; "
              "dias remuestreados del fuera-de-muestra):")
        print(sim.to_string(index=False))
    else:
        print("Sin tramos validos (pocos anos o --min-trades demasiado alto).")
        ss = None

    # ---- control
    if a.control > 0 and len(folds):
        print("\n================ CONTROL (niveles desplazados al azar, mismo proceso de optimizacion) ================")
        res = []
        for c in range(a.control):
            g2 = simulate_all(events, A, G, a, rng=np.random.default_rng(a.seed + 1 + c))
            f2, o2, st2 = walk_forward(g2, G, years, a) if g2 else (pd.DataFrame(), pd.DataFrame(), None)
            if len(o2):
                s2 = series_stats(o2["R"].to_numpy(), o2["ts"].to_numpy())
                med = np.nanmedian(agg(st2, list(range(len(years))))["mean"])
                res.append(dict(corrida=c + 1, oos_n=s2["n"], oos_exp_R=s2["exp_R"], oos_pf=s2["pf"],
                                oos_total_R=s2["total_R"], mediana_exp_todas_combos=med))
        real_med = np.nanmedian(ALL["mean"])
        res.insert(0, dict(corrida="REAL", oos_n=ss["n"], oos_exp_R=ss["exp_R"], oos_pf=ss["pf"],
                           oos_total_R=ss["total_R"], mediana_exp_todas_combos=real_med))
        cdf = pd.DataFrame(res).round(4)
        cdf.to_csv(out / "control.csv", index=False)
        print(cdf.to_string(index=False))
        print("Si REAL no supera claramente al control, los niveles de volumen no aportan ventaja medible.")

    print("\n================ MARGINALES (mediana de expectativa en R; A = <= {}, B = posterior) ================".format(a.split_year))
    print(marg.to_string(index=False))
    print(f"\nArchivos en: {out.resolve()}")
    print("OJO: top_estables_INSAMPLE.csv y combos.csv son DENTRO de muestra; la evidencia real es wf_* y control.csv.")


if __name__ == "__main__":
    main()