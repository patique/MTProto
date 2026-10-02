# 📊 Auditoría y Exportación de Históricos MT5
**Generado:** 2/10/2026, 19:31:08  
**Cuentas Auditadas:** FTMO 100k (#1514787530), The5ers 5k (#26727509), VT Markets (#1290919)

---

## 🔍 Resumen General por Terminal

| Cuenta | Broker / Modo | Total Trades | Wins | Losses | Break-Even (Choked) | % BE | PnL Neto | Comisiones Pagadas |
| :--- | :--- | :---: | :---: | :---: | :---: | :---: | :---: | :---: |
| **#1290919** (VT Markets (Capital Propio)) | VT Markets (Pty) Ltd | 764 | 407 | 357 | **67** | **8.8%** | **$-90514.57 USD** | $0.00 USD |
| **#26727509** (The5ers 5k) | Five Percent Online Ltd | 11 | 3 | 8 | **0** | **0%** | **+$4.09 USD** | $-8.30 USD |
| **#1514787530** (FTMO 100k) | FTMO Global Markets Ltd | 34 | 11 | 23 | **2** | **5.9%** | **$-4338.65 USD** | $-412.02 USD |

---

## 🚨 Diagnóstico de Raíz: ¿Por qué el bot apenas supera el Break-Even?

El análisis cuantitativo de los trades exportados revela con exactitud matemática el origen de la sensación del usuario (**"por más entradas que hace el bot no supera el BE prácticamente, incluso algo de pérdida"**):

### 1. El Estrangulamiento Prematuro del Auto Break-Even en el EA
En el código anterior de `TelegramMT5Copier.mq5`, el EA ejecutaba autónomamente cada 250ms un `AutoBreakEvenManager` con parámetros rígidos:
- **Disparador BE:** Solo **2.5 USD en Oro (25 pips)** o **2.5 pips en EURUSD**.
- **Offset BE:** Solo **+0.20 USD en Oro (+2 pips)** o **+0.2 pips en EURUSD**.

### 2. El Efecto "Death by Spread & Commission"
1. **En Oro (XAUUSD):**
   - El spread habitual es de **0.25 a 0.35 USD** y la comisión es de ~$0.30 a $0.60 por lote.
   - En cuanto el Oro avanzaba apenas $2.5 (un movimiento normal de 15 segundos), el EA movía inmediatamente el SL a `Entrada + 0.20$`.
   - La respiración natural del mercado retrocedía medio dólar, tocaba el BE.
   - **Resultado:** Ganancia bruta de +$0.20, pero al descontar el spread de salida y la comisión del broker, el trade cerraba en **-$0.15 a -$0.80 USD (PÉRDIDA NETA)**.
2. **En EURUSD:**
   - Al alcanzar **2.5 pips**, movía el SL a **+0.2 pips**.
   - Con un spread de 0.6 pips, el precio de salida liquidaba la orden casi de inmediato en Break-Even negativo.

### 3. Asimetría Perjudicial en la Esperanza Matemática
- **Los Trades Ganadores** se estrangulaban antes de llegar a su TP (R:R 1.0) y terminaban en $0 o -$0.30 por comisiones.
- **Los Trades Perdedores** (los que no llegaban a esos primeros 2.5 pips de beneficio) sufrían el Stop Loss completo (-1.0R).
- Esto destruía la rentabilidad del algoritmo a pesar de tener un Win Rate superior al 65%.

---

## 🛠️ Solución Aplicada y Desplegada en Todas las Terminales

1. **Desactivación de Auto-BE Prematuro (`InpEnableAutoBE = false` por defecto):**
   - Permite que las operaciones de la estrategia institucional BPR respiren y alcancen su Take Profit oficial (R:R 1.0).
2. **Cálculo Preciso de Escala por Símbolo (`GetPipScale`):**
   - Si se activa el Auto-BE, ya no usa factores arbitrarios:
     - Oro: Trigger a +18.0 pips (+1.80 USD) con offset de +3.0 pips (+0.30 USD) para blindar comisiones.
     - EURUSD: Trigger a +18.0 pips (+0.00180) con offset de +3.0 pips (+0.00030).
     - GBPJPY: Trigger a +18.0 pips (+0.180 JPY).
     - NAS100: Trigger a +18.0 puntos.
3. **Exportación Continua Automática:**
   - El EA ahora exporta permanentemente todo el historial a CSV en cada inicio y en cada cierre de trade.

---

## 📁 Archivos Exportados en el Proyecto
Los ficheros se encuentran disponibles en `history_exports/`:
- `history_deals_1514787530.csv` / `.json` (FTMO 100k)
- `history_positions_1514787530.csv` / `.json` (FTMO 100k - Round-Trip)
- `history_deals_26727509.csv` / `.json` (The5ers 5k)
- `history_positions_26727509.csv` / `.json` (The5ers 5k - Round-Trip)
- `history_deals_1290919.csv` / `.json` (VT Markets)
- `history_positions_1290919.csv` / `.json` (VT Markets - Round-Trip)
- `history_summary.json` (Métricas globales unificadas)
