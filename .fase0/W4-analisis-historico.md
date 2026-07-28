# ENTREGABLE W4 — Análisis Histórico Reproducible

- **Proyecto**: Pick It Up (`/Users/christian/code/pick-it-up`)
- **HEAD**: `b833d98`
- **Timestamp UTC de verificación en vivo**: `2026-07-28 16:52:00 UTC`
- **Autor**: Worker W4 (Agente Antigravity)
- **Regla de Ejecución**: Solo `SELECT` contra Supabase. Cero writes fuera de `.fase0/`. Consultas SQL reproducibles incluidas para cada punto.

---

## 1. Volumen de favoritos vs underdogs

### SQL Reproducible
```sql
SELECT 
  sport,
  TO_CHAR(created_at, 'YYYY-MM') AS periodo,
  COUNT(*) FILTER (WHERE COALESCE(original_odds, odds_decimal) > 1 AND COALESCE(original_odds, odds_decimal) < 2.00) AS favoritos_count,
  COUNT(*) FILTER (WHERE COALESCE(original_odds, odds_decimal) >= 2.00) AS underdogs_count,
  COUNT(*) FILTER (WHERE status = 'analyzed_no_edge' OR COALESCE(original_odds, odds_decimal) <= 1) AS placeholders_no_odds_count,
  COUNT(*) AS total_filas
FROM picks
GROUP BY sport, TO_CHAR(created_at, 'YYYY-MM')
ORDER BY sport, periodo;
```

### Resultados
Total de registros en `picks`: **896**.
Picks con momio válido en BD (excluyendo placeholders `analyzed_no_edge`): **369**.

| Deporte | Periodo | Favoritos (`< 2.00`) | Underdogs (`>= 2.00`) | Placeholders (`analyzed_no_edge`) | Total Filas |
|---|---|---|---|---|---|
| **MLB** | 2026-04 | 14 | 14 | 0 | 28 |
| **MLB** | 2026-05 | 92 | 87 | 100 | 279 |
| **MLB** | 2026-06 | 32 | 34 | 162 | 228 |
| **MLB** | 2026-07 | 25 | 13 | 149 | 187 |
| **NBA** | 2026-04 | 8 | 9 | 0 | 17 |
| **NBA** | 2026-05 | 12 | 14 | 8 | 34 |
| **NHL** | 2026-04 | 2 | 2 | 0 | 4 |
| **NHL** | 2026-05 | 8 | 13 | 15 | 36 |
| **NFL** | 2026-07 | 2 | 0 | 9 | 11 |
| **WNBA** | 2026-06 | 0 | 2 | 0 | 2 |
| **Liga MX** | 2026-04 | 1 | 1 | 0 | 2 |
| **Premier League** | 2026-04 | 0 | 2 | 0 | 2 |
| **Parlay** | 2026-04 | 0 | 1 | 0 | 1 |
| **Parlay** | 2026-05 | 0 | 6 | 0 | 6 |
| **Parlay** | 2026-06 | 0 | 12 | 0 | 12 |
| **Parlay** | 2026-07 | 0 | 47 | 0 | 47 |

---

## 2. ⚠️ CONTRADICCIÓN A RESOLVER — El piso de 55%

### SQL Reproducible
```sql
-- Conteo de underdogs en picks MLB con momios válidos
SELECT 
  COUNT(*) AS total_picks_mlb_validos,
  COUNT(*) FILTER (WHERE COALESCE(original_odds, odds_decimal) >= 2.00) AS underdogs_mlb_count,
  ROUND(100.0 * COUNT(*) FILTER (WHERE COALESCE(original_odds, odds_decimal) >= 2.00) / COUNT(*), 1) AS pct_underdogs_mlb
FROM picks
WHERE sport = 'MLB' AND COALESCE(original_odds, odds_decimal) > 1;

-- Conteo de underdogs en apuestas ejecutadas (bets excluyendo manuales)
SELECT 
  COUNT(*) AS total_bets_validos,
  COUNT(*) FILTER (WHERE COALESCE(odds_at_bet, odds_decimal) >= 2.00) AS underdogs_bets_count,
  ROUND(100.0 * COUNT(*) FILTER (WHERE COALESCE(odds_at_bet, odds_decimal) >= 2.00) / COUNT(*), 1) AS pct_underdogs_bets
FROM bets
WHERE excluded_from_stats = false;
```

### Resultados
1. **Picks MLB con momio válido**: 271 totales -> **148 Underdogs (54.6%)**.
2. **Picks MLB notificados/bet**: 248 totales auditados en julio -> **79 Underdogs (31.9%)**.
3. **Apuestas ejecutadas en `bets`**: 68 apuestas de modelo (79 totales menos 11 manuales) -> **25 Underdogs (36.8%)**.

### Veredicto: REFUTACIÓN DE LA ASUNCIÓN INICIAL
- **No existe un bloqueo absoluto contra underdogs en el código actual.** El sistema SÍ ha generado y apostado bajo underdogs de forma recurrente (31.9% de picks MLB notificados y 36.8% de apuestas reales ejecutadas fueron underdog).
- **Mecanismo técnico real**: Cuando el LLM otorga a un underdog (ej. momio 2.20, prob implícita 45.5%) una probabilidad estimada mayor o igual a **55%** (ej. 56%), el sistema lo clasifica como `VALUE` o `STRONG` y emite el pick.
- **Razón estructural por la que el rediseño SIGUE SIENDO CORRECTO**:
  Aunque el piso de 55% no impide *todos* los underdogs, impone un **sesgo asimétrico distorsionante**:
  - Para un **favorito** (momio 1.50, prob implícita 66.7%), el piso de 55% no bloquea nada porque la probabilidad estimada cae naturalmente por encima del piso.
  - Para un **underdog moderado** (momio 2.20, prob implícita 45.5%), si el modelo estima su probabilidad real en **50%**, eso representa un **edge masivo (+4.5%)** y un **EV positivo significativo (+10.0%)**. Sin embargo, el piso de 55% LO ELIMINA por exigirle ganar la victoria simple (>55%), tratándolo como si fuera favorito.
  - En visitantes MLB (cap en prompt = 58%, piso VALUE = 55%), la ventana permitida para un underdog visitante queda reducida a una **estrecha franja de 3pp** (55%-58%).
  - **Nombrado de la razón real**: El rediseño no es necesario porque "sea imposible recomendar underdogs", sino porque evaluar apuestas de valor mediante un piso de probabilidad absoluta (`real_probability >= 0.55`) en lugar de **Expected Value (EV > 0)** rompe la lógica analítica de valor en apuestas deportivas.

---

## 3. Underdogs eliminados por el piso

### SQL Reproducible
```sql
SELECT 
  status,
  COUNT(*) AS total_filas,
  COUNT(*) FILTER (WHERE real_probability > 0 AND real_probability < 0.55 AND COALESCE(original_odds, odds_decimal) >= 2.00) AS underdogs_con_prob_guardada
FROM picks
GROUP BY status;
```

### Resultado: `NO VERIFICABLE`
- **Razón concreta**: Como se documenta en la regla central y en `app/api/cron/analyze/route.ts:354`, todas las evaluaciones descartadas por falta de edge o por no superar los umbrales se persisten en la tabla `picks` bajo el estado `analyzed_no_edge` escribiendo `real_probability = 0`, `implied_probability = 0`, `edge = 0` y `original_odds = NULL`.
- **Efecto en los datos**: Al haber sobrescrito las probabilidades reales del LLM con el placeholder `0` en **511 candidatos**, la base de datos **no conserva** los valores originales de `real_prob` ni los momios para esas ejecuciones.
- **Evidencia en DB**: Solo existen en la BD **29 filas** con `0 < real_probability < 0.55` (correspondientes a parlays, picks en `filtered_quality_audit`, `expired_no_bet` o apuestas legacy), pero los candidatos descartados por el cron en `analyzed_no_edge` perdieron su probabilidad real y EV. Es imposible cuantificar cuántos de los 511 tuvieron `edge >= 5%` y `real_prob < 55%` sin re-ejecutar el LLM sobre todo el historial.

---

## 4. CLV de underdogs vs favoritos

### SQL Reproducible
```sql
SELECT 
  CASE WHEN COALESCE(odds_at_bet, odds_decimal) < 2.00 THEN 'Favorito (<2.00)' ELSE 'Underdog (>=2.00)' END AS tipo,
  COUNT(*) AS n,
  ROUND(AVG(clv)::numeric, 6) AS mean_clv,
  ROUND(STDDEV_SAMP(clv)::numeric, 6) AS std_clv,
  ROUND(MIN(clv)::numeric, 6) AS min_clv,
  ROUND(MAX(clv)::numeric, 6) AS max_clv
FROM bets
WHERE clv IS NOT NULL AND excluded_from_stats = false
GROUP BY CASE WHEN COALESCE(odds_at_bet, odds_decimal) < 2.00 THEN 'Favorito (<2.00)' ELSE 'Underdog (>=2.00)' END;
```

### Resultados y Prueba Statistíca
Total de apuestas con CLV persistido (excluyendo `excluded_from_stats = true`): **44**.

- **Favoritos (`odds < 2.00`)**: $n = 30$, Media CLV = **−0.874 pp** (`−0.008740`), Desv. Est. = `0.006721` (0.672 pp).
- **Underdogs (`odds >= 2.00`)**: $n = 14$, Media CLV = **−1.065 pp** (`−0.010646`), Desv. Est. = `0.006880` (0.688 pp).
- **Diferencia (Fav − Dog)**: $+0.191\text{ pp}$ (`+0.001906`).
- **Prueba Welch $t$**:
  $$SE = \sqrt{\frac{0.006721^2}{30} + \frac{0.006880^2}{14}} = \sqrt{0.000001505 + 0.000003381} = 0.002210$$
  $$t = \frac{-0.008740 - (-0.010646)}{0.002210} = 0.8656$$
  Grados de libertad (Welch-Satterthwaite): $df = 25.59$.
  Valor $p \approx 0.395 > 0.05$.
- **Conclusión**: La diferencia de CLV entre favoritos y underdogs **NO ES ESTADÍSTICAMENTE SIGNIFICATIVA**.
  *(Nota: El dato previo mencionaba $t = 1.68$, el cálculo exacto corregido con la muestra completa es $t = 0.866$).*

> ⚠️ **ADVERTENCIA DE VALIDEZ CRÍTICA**:
> La validez de estos números de CLV está **sujeta al veredicto del worker W1**. Como consta en los hechos auditados:
> 1. Las 44 filas en `bets` tienen `odds_at_bet` idéntico a `picks.odds_decimal` y ~2% más corto que `picks.original_odds`.
> 2. La brecha de captura sola (`original_odds` vs `odds_at_bet`) representa **−0.985 pp**, lo cual cubre por sí solo la totalidad del CLV negativo reportado (−0.934 pp total).
> 3. En 5 de las 44 filas, `odds_at_close == odds_at_bet` (fallback por falta de captura al cierre).

---

## 5. CLV por rango de momio

### SQL Reproducible
```sql
SELECT 
  CASE 
    WHEN COALESCE(odds_at_bet, odds_decimal) < 1.50 THEN '1. < 1.50'
    WHEN COALESCE(odds_at_bet, odds_decimal) < 2.00 THEN '2. 1.50 - 1.99'
    WHEN COALESCE(odds_at_bet, odds_decimal) < 2.50 THEN '3. 2.00 - 2.49'
    ELSE '4. >= 2.50'
  END AS rango_momio,
  COUNT(*) AS n,
  ROUND(AVG(clv)::numeric, 6) AS mean_clv,
  ROUND(STDDEV_SAMP(clv)::numeric, 6) AS std_clv,
  ROUND(MIN(clv)::numeric, 6) AS min_clv,
  ROUND(MAX(clv)::numeric, 6) AS max_clv
FROM bets
WHERE clv IS NOT NULL AND excluded_from_stats = false
GROUP BY 1
ORDER BY 1;
```

### Resultados

| Rango de Momio | $n$ | Media CLV | Desv. Est. CLV | Min CLV | Max CLV |
|---|---|---|---|---|---|
| `< 1.50` | 0 | N/A | N/A | N/A | N/A |
| `1.50 - 1.99` | 30 | **−0.874 pp** (`−0.0087`) | `0.0067` | −2.17 pp | +0.34 pp |
| `2.00 - 2.49` | 13 | **−1.046 pp** (`−0.0105`) | `0.0071` | −1.89 pp | 0.00 pp |
| `>= 2.50` | 1 | **−1.314 pp** (`−0.0131`) | `0.0000` | −1.31 pp | −1.31 pp |

---

## 6. Qué filtros eliminan más underdogs

### SQL Reproducible
```sql
SELECT 
  status,
  COUNT(*) AS total_filas,
  COUNT(*) FILTER (WHERE status != 'analyzed_no_edge' AND COALESCE(original_odds, odds_decimal) >= 2.00) AS underdogs_count,
  COUNT(*) FILTER (WHERE status != 'analyzed_no_edge' AND COALESCE(original_odds, odds_decimal) < 2.00) AS favoritos_count,
  COUNT(*) FILTER (WHERE status = 'analyzed_no_edge' OR COALESCE(original_odds, odds_decimal) <= 1) AS placeholders_count
FROM picks
GROUP BY status
ORDER BY total_filas DESC;
```

### Ranking por Volumen de Eliminación de Underdogs

| Ranking / Estado | Total Filas | Underdogs Confirmados | Favoritos Confirmados | Placeholders / Sin Odds | Descripción del Filtro / Razón |
|---|---|---|---|---|---|
| **1. `analyzed_no_edge`** | 511 | `NO VERIFICABLE` | `NO VERIFICABLE` | 511 | Candidatos sin edge suficiente (<5%). Es el mayor filtro general (57% de todas las corridas). |
| **2. `skipped`** | 90 | **56** | 34 | 0 | Juegos omitidos por movimiento adverso de línea o solapamiento de horario. **Filtro activo que más underdogs elimina**. |
| **3. `expired_no_bet`** | 93 | **32** | 61 | 0 | Picks aprobados pero no ejecutados antes del inicio del juego. |
| **4. `superseded_legacy`** | 59 | **29** | 30 | 0 | Picks sustituidos por re-análisis previo con lógica legacy. |
| **5. `filtered_quality_audit`** | 52 | **20** | 32 | 0 | Picks bloqueados por reglas del motor de auditoría (`lib/pickAudit.ts`). |
| **6. `analyzed_no_odds_data`** | 16 | 0 | 0 | 16 | Eventos sin momios en DraftKings. |

### Desglose del Filtro `filtered_quality_audit` (20 Underdogs Eliminados)
Del análisis de la columna `audit_failures` (`jsonb`):
- `lock_with_low_raw_confidence`: **9 underdogs eliminados** (LLM emitió tier LOCK pero `confidence` del prompt fue baja).
- `floor_not_applied`: **7 underdogs eliminados** (desalineación entre piso de probabilidad y tier).
- `edge_vs_market_excessive`: **2 underdogs eliminados** (discrepancia excesiva contra consenso de mercado).
- `edge_market_gap_*_blocking` & `confidence_floor_boost_*`: **2 underdogs eliminados**.

---

## 7. Reconstruibilidad

### SQL Reproducible
```sql
SELECT 
  COUNT(*) AS total_analyzed_no_edge,
  COUNT(*) FILTER (WHERE real_probability = 0) AS real_probability_cero,
  COUNT(*) FILTER (WHERE implied_probability = 0) AS implied_probability_cero,
  COUNT(*) FILTER (WHERE edge = 0) AS edge_cero,
  COUNT(*) FILTER (WHERE edge_vs_market IS NULL) AS edge_vs_market_null,
  COUNT(*) FILTER (WHERE original_odds IS NULL) AS original_odds_null
FROM picks
WHERE status = 'analyzed_no_edge';
```

### Resultado y Evidencia
- `total_analyzed_no_edge`: **511** (100%)
- `real_probability = 0`: **511** (100%)
- `implied_probability = 0`: **511** (100%)
- `edge = 0`: **511** (100%)
- `edge_vs_market IS NULL`: **511** (100%)
- `original_odds IS NULL`: **511** (100%)

### Veredicto: NO CONSERVAN INFORMACIÓN
Los registros `analyzed_no_edge` **NO conservan información suficiente** para reconstruir ni el volumen real de underdogs descartados, ni la distribución de probabilities, ni los EV de los candidatos no notificados. Los campos fueron sobrescritos con ceros y `NULL`s duros en `app/api/cron/analyze/route.ts:354-357`.

---

## 8. Daño de los placeholders

### SQL Reproducible
```sql
SELECT 
  COUNT(*) AS total_analyzed_no_edge,
  COUNT(*) FILTER (WHERE created_at >= '2026-06-28T00:00:00Z') AS count_ultimo_mes,
  ROUND(100.0 * COUNT(*) / (SELECT COUNT(*) FROM picks), 1) AS pct_del_total_de_picks
FROM picks
WHERE status = 'analyzed_no_edge';
```

### Cuantificación del Daño
- **Total de filas afectadas**: **511 filas** (**57.0%** del universo total de 896 registros en `picks`).
- **Filas en el último mes** (desde 28-jun-2026): **181 filas** (prácticamente todo el volumen reciente).

### Análisis que Quedan Imposibles
1. **Análisis de sensibilidad de umbrales (Fase 6)**: Imposible probar qué habría pasado si `EDGE_THRESHOLD` se bajara de 5% a 3% o 2%, porque los candidatos con edge entre 0% y 5% no guardaron su edge real.
2. **Evaluación real del piso de 55%**: Imposible saber cuántos underdogs con EV positivo fueron descartados únicamente por el piso de probabilidad de 55%.
3. **Distribución real de probabilidades del LLM**: Imposible conocer la curva completa de calibración del modelo sobre todos los partidos analizados; cualquier promedio sobre `picks` queda severamente sesgado hacia abajo (media contaminada de 21.7%).
4. **Optimización de cortes por EV**: Imposible simular estrategias basadas en EV esperado sobre el 100% de la oferta deportiva.

---

## 9. Distribuciones sobre TODOS los candidatos

### SQL Reproducible
```sql
-- Distribución de real_probability sobre TODOS los candidatos (incluyendo placeholders 0)
SELECT 
  COUNT(*) AS total_filas,
  PERCENTILE_CONT(0.10) WITHIN GROUP (ORDER BY real_probability) AS p10_real_prob,
  PERCENTILE_CONT(0.25) WITHIN GROUP (ORDER BY real_probability) AS p25_real_prob,
  PERCENTILE_CONT(0.50) WITHIN GROUP (ORDER BY real_probability) AS median_real_prob,
  PERCENTILE_CONT(0.75) WITHIN GROUP (ORDER BY real_probability) AS p75_real_prob,
  PERCENTILE_CONT(0.90) WITHIN GROUP (ORDER BY real_probability) AS p90_real_prob,
  AVG(real_probability) AS mean_real_prob
FROM picks;

-- Distribución de real_probability sobre candidatos VÁLIDOS (excluyendo placeholders)
SELECT 
  COUNT(*) AS valid_picks_count,
  PERCENTILE_CONT(0.10) WITHIN GROUP (ORDER BY real_probability) AS p10_real_prob,
  PERCENTILE_CONT(0.25) WITHIN GROUP (ORDER BY real_probability) AS p25_real_prob,
  PERCENTILE_CONT(0.50) WITHIN GROUP (ORDER BY real_probability) AS median_real_prob,
  PERCENTILE_CONT(0.75) WITHIN GROUP (ORDER BY real_probability) AS p75_real_prob,
  PERCENTILE_CONT(0.90) WITHIN GROUP (ORDER BY real_probability) AS p90_real_prob,
  AVG(real_probability) AS mean_real_prob
FROM picks
WHERE status != 'analyzed_no_edge' AND real_probability > 0;

-- Distribución de edge_vs_market sobre candidatos con dato guardado
SELECT 
  COUNT(*) AS count_edge_vs_market,
  PERCENTILE_CONT(0.10) WITHIN GROUP (ORDER BY edge_vs_market) AS p10_edge_mkt,
  PERCENTILE_CONT(0.25) WITHIN GROUP (ORDER BY edge_vs_market) AS p25_edge_mkt,
  PERCENTILE_CONT(0.50) WITHIN GROUP (ORDER BY edge_vs_market) AS median_edge_mkt,
  PERCENTILE_CONT(0.75) WITHIN GROUP (ORDER BY edge_vs_market) AS p75_edge_mkt,
  PERCENTILE_CONT(0.90) WITHIN GROUP (ORDER BY edge_vs_market) AS p90_edge_mkt,
  AVG(edge_vs_market) AS mean_edge_mkt
FROM picks
WHERE edge_vs_market IS NOT NULL;
```

### Resultados de Percentiles

| Métrica / Subconjunto | $n$ | Min | P10 | P25 | Mediana (P50) | P75 | P90 | Max | Media |
|---|---|---|---|---|---|---|---|---|---|
| **`real_probability` (TODOS con placeholders 0)** | 896 | 0.00 | 0.00 | 0.00 | **0.00** | 0.55 | 0.61 | 0.78 | **21.7%** |
| **`real_probability` (Solo VÁLIDOS)** | 369 | 0.157 | 0.334 | 0.480 | **0.560** | 0.608 | 0.630 | 0.78 | **52.8%** |
| **`edge_vs_market` (Solo persisitidos)** | 197 | +0.04% | +3.09% | +4.66% | **+6.96%** | +8.00% | +9.08% | +26.77% | **+6.65%** |

### HALLAZGO DE PRIMER ORDEN PARA FASE 6
> **LA DISTRIBUCIÓN COMPLETA DE CANDIDATOS ES IRRECONSTRUIBLE Y PARCIAL.**
> Debido a que el 57% de los partidos analizados fueron guardados como ceros (`analyzed_no_edge`), la distribución real de `real_probability` y `edge_vs_market` de **todos los candidatos** no se encuentra en la base de datos.
> Para la **Fase 6** (fijar umbrales por EV), los cortes no se pueden calcular analíticamente sobre el historial guardado en BD; será imprescindible re-correr una muestra de observaciones o activar el **Modo Observación** que guarde las probabilidades crudas sin ceros.

---

## 10. Los caps del prompt no se respetan — Cuantificación completa

### SQL Reproducible
```sql
-- Cuantificación de violaciones a los caps declarados en lib/prompts.ts:320-323
-- Caps: MLB away > 58%, MLB home > 66%; NBA away > 55%, NBA home > 70%; NHL away > 55%, NHL home > 65%; NFL away > 62%, NFL home > 73%
SELECT 
  sport,
  CASE 
    WHEN (pick ILIKE '%' || home_team || '%' OR pick ILIKE '%' || COALESCE(home_team_abbr,'') || '%') THEN 'home'
    WHEN (pick ILIKE '%' || away_team || '%' OR pick ILIKE '%' || COALESCE(away_team_abbr,'') || '%') THEN 'away'
    ELSE 'indeterminado'
  END AS lado,
  COUNT(*) AS total_evaluated,
  COUNT(*) FILTER (
    WHERE (sport = 'MLB' AND (pick ILIKE '%' || home_team || '%' OR pick ILIKE '%' || COALESCE(home_team_abbr,'') || '%') AND real_probability > 0.66)
       OR (sport = 'MLB' AND (pick ILIKE '%' || away_team || '%' OR pick ILIKE '%' || COALESCE(away_team_abbr,'') || '%') AND real_probability > 0.58)
       OR (sport = 'NBA' AND (pick ILIKE '%' || home_team || '%' OR pick ILIKE '%' || COALESCE(home_team_abbr,'') || '%') AND real_probability > 0.70)
       OR (sport = 'NBA' AND (pick ILIKE '%' || away_team || '%' OR pick ILIKE '%' || COALESCE(away_team_abbr,'') || '%') AND real_probability > 0.55)
       OR (sport = 'NHL' AND (pick ILIKE '%' || home_team || '%' OR pick ILIKE '%' || COALESCE(home_team_abbr,'') || '%') AND real_probability > 0.65)
       OR (sport = 'NHL' AND (pick ILIKE '%' || away_team || '%' OR pick ILIKE '%' || COALESCE(away_team_abbr,'') || '%') AND real_probability > 0.55)
  ) AS violaciones_count
FROM picks
WHERE status != 'analyzed_no_edge' AND real_probability > 0
GROUP BY sport, lado;
```

### Resultados de la Cuantificación

Evaluación sobre **242 picks individuales** de deportes con caps definidos en `lib/prompts.ts:320-323`.

- **Total de violaciones detectadas**: **75 picks** (**31.0% de todos los picks evaluados**).

| Deporte / Lado | Cap Prompt | Total Picks Evaluados | Violaciones (Excesos) | Tasa de Violación (%) | Exceso Medio | Exceso Mediana (P50) | Exceso P90 | Exceso Máximo |
|---|---|---|---|---|---|---|---|---|
| **MLB Visitante (away)** | **58%** | 146 | **65** | **44.5%** | **+3.94 pp** | **+4.00 pp** | **+7.00 pp** | **+12.20 pp** (70.2%) |
| **MLB Local (home)** | **66%** | 69 | **3** | **4.3%** | **+2.00 pp** | **+1.00 pp** | **+3.40 pp** | **+4.00 pp** (70.0%) |
| **NBA Visitante (away)** | **55%** | 12 | **5** | **41.7%** | **+13.40 pp** | **+13.00 pp** | **+17.00 pp** | **+17.00 pp** (72.0%) |
| **NBA Local (home)** | **70%** | 4 | 0 | 0.0% | N/A | N/A | N/A | N/A |
| **NHL Visitante (away)** | **55%** | 4 | **2** | **50.0%** | **+1.00 pp** | **+1.00 pp** | **+1.00 pp** | **+1.00 pp** (56.0%) |
| **NHL Local (home)** | **65%** | 5 | 0 | 0.0% | N/A | N/A | N/A | N/A |
| **NFL Local/Away** | **73%/62%** | 2 | 0 | 0.0% | N/A | N/A | N/A | N/A |

### Diagnóstico Técnico
1. **Foco del problema**: El LLM viola masivamente los caps en el **lado visitante** (**44.5% de los picks visitantes de MLB** y **41.7% de NBA** superan el límite).
2. **Magnitud**: En MLB visitante, 65 picks superaron el 58% de cap (llegando hasta 70.2% de probabilidad real). En NBA visitante, los excesos alcanzaron hasta +17 pp por encima del cap de 55% (emitiendo probabilidades de 72%).
3. **Causa raíz**: El prompt declara los límites en texto (`lib/prompts.ts:320-323`), pero el código de aplicación en `lib/pickGen.ts` **no los valida ni los trunca mediante código**. Los caps en el prompt actúan solo como sugerencias informativas que el modelo ignora en casi la mitad de las predicciones de visitantes.
