# FASE 0 — AUDITORÍA Y DISEÑO DEL REDISEÑO DEL NÚCLEO ANALÍTICO

**Documento de entrega para aprobación de Christian.**
HEAD auditado: `b833d98` (main) · Fecha: 2026-07-28
Verificaciones en vivo: `16:52`–`16:57 UTC` (Supabase, ESPN core, superficie Draftea)
Workers: W1 (claude), W2 (codex), W3 (amp), W4 (antigravity), W5 (claude)

**Cero código de producción tocado. Cero writes fuera de `.fase0/`. Solo SELECT y GET.**

---

## RESUMEN — LO QUE CAMBIA EL PLAN

Seis hallazgos reordenan el rediseño. Los seis están verificados con `archivo:línea`
o con consulta al catálogo real de producción.

| # | Hallazgo | Efecto sobre el plan |
|---|---|---|
| **1** | **El CLV mide spread entre casas, no movimiento de línea.** `odds_at_bet` es precio de **Draftea** leído por visión del ticket; `odds_at_close` es cierre de **DraftKings**. | La Fase 8 no puede sellarse con la métrica actual. Hay que reconstruir el CLV antes. |
| **2** | **No se persisten ambos lados del moneyline.** Se capturan en memoria, se guarda solo el lado apostado. | **BLOQUEANTE DE LA FASE 2.** Sin los dos lados no hay de-vig, y el histórico no es reconstruible. |
| **3** | **SÍ hay un filtro estructural que mata un lado del mercado**, y está en una línea: `lib/pickGen.ts:1067-1077` vía `lib/units.ts:43`. | Confirma la Fase 6, pero por una razón distinta —y peor— que la del encargo. |
| **4** | **La distribución histórica sobre la que fijar cortes por EV no existe.** 511 filas (57% de `picks`) son placeholders en cero. | La Fase 6 no puede calibrarse contra el histórico. Depende de la Fase 7. |
| **5** | **Draftea no es una fuente de momios del sistema.** No existe en el pipeline. | **La Fase 4 no es implementable como está escrita.** |
| **6** | **El kill switch es peor de lo inventariado:** dos rutas `POST` públicas **sin auth**. | Fase 0 de frenos antes de cualquier migración. |

---

## i) VEREDICTO SOBRE LAS DOS CONTRADICCIONES

### A) ¿El piso de 55% bloquea underdogs?

**VEREDICTO: SÍ hay bloqueo estructural — pero no el que decía el encargo.**

W4 (datos) y W5 (código) llegaron a conclusiones que suenan opuestas. No lo son:
**miden cosas distintas y ambas son correctas.** Verifiqué el código yo mismo.

- **W4, por datos:** 148 de 271 picks MLB con momio válido son underdog (54.6%);
  25 de 68 apuestas ejecutadas (36.8%). No hay bloqueo de underdogs *por precio*.
- **W5, por código:** `lib/pickGen.ts:1067-1077` descarta el pick cuando
  `tierFromProbability()` devuelve `null`, y `lib/units.ts:43` devuelve `null`
  cuando `realProbability < t.value` (0.55 en MLB/NHL/NBA/WNBA, 0.59 en NFL).

**Confirmado por lectura directa del código:**

```ts
// lib/units.ts:41-43
else if (realProbability >= t.value) tier = 'value';
else return null;                    // ← muere aquí

// lib/pickGen.ts:1067-1077
const adjustedTier = tierFromProbability(pickedProb, p.sport, pickedOdds);
if (adjustedTier === null) { … reasons.fail_confidence++; return []; }
```

La reconciliación: el filtro corta por **probabilidad de modelo**; "underdog" en la
medición del 27-jul es por **momio**. Un pick con momio 2.20 (implícito 45.5%) al que
Claude asigna 58% es simultáneamente underdog de mercado y favorito de modelo, y pasa
sin problema.

**Consecuencia real, y es peor que la del encargo:** el sistema no bloquea underdogs
—bloquea **los underdogs cuya probabilidad el modelo estima honestamente por debajo
del 55%**, que son precisamente los de EV positivo *por precio*. Se queda con la clase
más frágil (Claude discrepando del mercado) y descarta la más sólida (precio a favor).
El filtro garantiza que **los 79 underdogs medidos tienen todos `real_probability ≥
0.55`** — todos son casos de desacuerdo con el mercado.

El underdog canónico del documento (p=0.45, momio 2.50, EV +12.5%) pasa el gate de
edge (`+0.05 ≥ EDGE_THRESHOLD`) y **muere en el tier**.

**Filtros adicionales por precio que sobreviven a quitar el piso** (la Fase 6 debe
retirarlos también):
- `lib/pickGen.ts:1171` — descarta si `odds_decimal < 1.4 && edge < 0.05`
- `lib/units.ts:45-49` — degrada tier cuando `odds < 1.40`, hasta `null` para VALUE
- `lib/pickGen.ts:1028-1045` — dampening **asimétrico**: recorta la probabilidad solo
  hacia arriba; nada la recorta hacia abajo
- `lib/pickGen.ts:1169` — `confidence >= 55`, un segundo umbral sobre una magnitud que
  el propio documento advierte que no debe confundirse con probabilidad

**El rediseño sigue siendo correcto. La justificación del encargo no.** Hay que
sustituirla por esta.

### B) ¿El CLV mide movimiento de línea o spread entre casas?

**VEREDICTO: A) ARTEFACTO CROSS-BOOK. El 98% del "CLV" es spread entre casas.**

`bets.odds_at_bet` **no es un precio de DraftKings**: es el momio que Claude Vision leyó
de un **screenshot de la app de Draftea**. `bets.odds_at_close` sí es cierre real de
DraftKings vía ESPN.

**Descomposición (n=41 con `original_odds`):**

| componente | valor |
|---|---|
| CLV total almacenado | **−1.003 pp** |
| brecha cross-book (Draftea vs DK) | **−0.985 pp** |
| **movimiento real de DK (análisis→cierre)** | **−0.018 pp** (sd 0.822) |

El movimiento real de DraftKings es ruido puro: se alargó en 11 casos, se acortó en 19,
quedó igual en 9. Moneda al aire.

**Cadena de evidencia, cerrada por código y por datos:**

| evidencia | resultado |
|---|---|
| Bets con CLV posteriores a que existiera `ai_usage_log` con extracción `vision_extract_bet_tg` previa | **36/36** |
| Brecha `picks.updated_at` → `bets.created_at` | 59–592 ms (media 206), n=35 |
| En esas 35 filas, `odds_at_bet == picks.odds_decimal` reescrito | **35/35** |
| `odds_at_close` a ±0.005 de `odds_at_bet` | **0/39** |
| `odds_at_close` a ±0.005 de `original_odds` (DK@análisis) | **14/39** (9 exactos) |
| Triggers de usuario sobre `picks`/`bets` en producción | **0** |

La fila decisiva es la cuarta: si `odds_at_bet` y `odds_at_close` salieran del mismo
libro, coincidirían de vez en cuando. **Nunca coinciden.** `odds_at_close` sí coincide
con `original_odds` en 14 de 39 — porque ambos son DraftKings.

**Caso didáctico** (evento 401815755, verificado en vivo `16:55:21Z`): DK abrió 1.67,
al análisis estaba en 1.758, cerró en 1.75 — se movió −0.008, nada. Draftea, en el mismo
momento, pagaba **1.71: 2.7% más corto**. Todo el "CLV negativo" de esa apuesta es
spread entre casas.

**Lo que esto NO dice:** no dice que el sistema no tenga edge. Dice que el CLV medido no
sirve para saberlo. Y no contradice la hipótesis muerta #2 del encargo: `odds_at_close`
sí es cierre real de DK. **Lo que estaba mal no era el cierre — era la apertura.**

---

## MISTERIO RESUELTO: qué reescribe `picks.odds_decimal`

**Es código de la aplicación, no un trigger.** Convergen W1 y W3 desde ángulos
independientes (W1 por código + timing, W3 por catálogo productivo).

**Lo reescribe `app/api/bets/from-image/confirm/route.ts:214-224`**, con el precio del
ticket de Draftea leído por visión. Los ~137 ms son el intervalo entre ese `UPDATE` y la
llamada a `place_bet_atomic` (`:337`) — dos requests consecutivos a PostgREST desde el
mismo handler serverless. Medido: 59–592 ms, media 206 ms.

**Descarte formal de "trigger o función fuera de migraciones"** (catálogo real, no
migraciones):
- `information_schema.triggers`: único trigger de usuario en `public` es
  `trg_leads_updated_at` sobre `leads`. **Cero sobre `picks` o `bets`.**
- `pg_rules` en `public`: **vacío**.
- `pg_proc` en `public`: exactamente 4 funciones — `place_bet_atomic`,
  `resolve_bet_atomic`, `adjust_bankroll_atomic`, `update_updated_at`.
- `place_bet_atomic` desplegada es **idéntica** a la del repo.

**El patrón `retroactive_schema_sync` no se repitió aquí.** El culpable siempre estuvo
en TypeScript.

Existe un segundo reescritor, distinto y no implicado en estos 44 bets:
`lib/pickGen.ts:1834-1859` (refresh del lock-in en cada re-análisis). W5 lo señaló como
el causante; **W1 lo descarta con datos**: los 44 picks tienen `reanalysis_count = 0` y
`lock_reason = 'first_analysis'`. Ambos reescritores son reales; para estos 44 bets el
responsable es el de `confirm`.

> **El bug de fondo:** reescribir el precio de análisis con el precio de otra casa.
> Los campos de auditoría solo lo documentan. La corrección correcta es que `confirm`
> deje de tocar `odds_decimal` y escriba en un campo propio.

---

## a) DIAGRAMA DEL PIPELINE ACTUAL

*(Espina dorsal confirmada por W1, W2, W3 y W5. El inventario exhaustivo de
consumidores por símbolo está en §W2 más abajo.)*

```
ESPN scoreboard (5 ligas)                   lib/espn.ts:186-315
  └─ filtro seasontype ALLOWED_SEASON_TYPES  lib/espn.ts (OBSERVATION_SPORTS)
  └─ filtro ventana minutos al inicio        app/api/cron/analyze/route.ts:120-124,169-176
       │
       ├─ momios DK vía ESPN core            lib/espn.ts:657-698   ← AMBOS lados en memoria
       │    └─ primer proveedor no-live      lib/espn.ts:204-216
       ├─ Pinnacle guest API                 lib/pinnacle.ts:265-311 ← AMBOS lados
       │    └─ cache 10 min                  pinnacle_cache
       ├─ ESPN BPI (predictor)               lib/espn.ts:698-745   ← prob. de MODELO, sin vig
       ├─ MLB/NHL/NBA/NFL stats              lib/{mlb,nhl,nba,nfl}Stats.ts → data_cache
       └─ OpenWeather                        lib/weather.ts:108-156
       │
       ▼
  consenso de mercado                        lib/edge.ts:44-79
       ⚠ promedia implícitos CON vig (DK, Pinnacle) con BPI SIN vig
       ▼
  prompt → Claude                            lib/prompts.ts / lib/claude.ts
       ⚠ caps declarados en :320-323, NO aplicados server-side
       ▼
  real_probability, confidence               (respuesta del modelo)
       ▼
  edge = real_prob − 1/odds                  lib/edge.ts:3      ← contra DK, con vig
       ▼
  gate EDGE_THRESHOLD = 0.05                 lib/pickGen.ts:942 ← dentro de un flatMap
       ▼
  dampening asimétrico (solo hacia abajo)    lib/pickGen.ts:1028-1045
       ▼
  ⛔ tierFromProbability → null → DESCARTE    lib/pickGen.ts:1067-1077 + lib/units.ts:43
       ▼
  lock-in CAPA-2 (congela original_odds)     lib/pickGen.ts:1775-1789
       ├─ INSERT: original_odds = odds_decimal        :1781
       └─ UPDATE en re-análisis: refresca odds_decimal, NO original_odds   :1834-1856
       ▼
  auditoría de calidad                       lib/pickAudit.ts → picks.audit_failures (jsonb)
       ▼
  persistencia de picks                      lib/pickGen.ts:1336-1387
       ⚠ analyzed_no_edge → real_probability=0 (placeholder)
                                             app/api/cron/analyze/route.ts:285-312, 340-365
       ▼
  notificación Telegram                      lib/telegram.ts
       ▼
  ── Christian apuesta en Draftea, manda foto del ticket ──
       ▼
  visión extrae momio DRAFTEA (solo el lado apostado)  lib/vision-extract-bet.ts:103
       ▼
  matching contra picks pending 7 días       lib/bet-matching.ts:60-87
       ▼
  ⛔ UPDATE picks.odds_decimal = precio Draftea  confirm/route.ts:214-224
       ▼  (~206 ms después)
  place_bet_atomic(p_odds_decimal = Draftea) confirm/route.ts:337
       └─ odds_at_bet := p_odds_decimal      20260727120000_…:97,103
       ▼
  ── juego termina ──
       ▼
  runResultsCheck                            app/api/cron/analyze/route.ts:730-928
       ⚠ NO consulta auto_enabled
       ├─ cierre DK vía ESPN                 lib/espn.ts:773-835
       │   └─ fallback: odds_at_close := odds_at_bet, clv := 0   :840, 854-856
       └─ resolve_bet_atomic                 :863
           └─ clv = f(odds_at_bet[DRAFTEA], odds_at_close[DK])  ← ARTEFACTO CROSS-BOOK
```

---

## c) SCHEMA PROPUESTO, RECONCILIADO CON EL REAL (W3)

### Deriva real repo ↔ producción

- **3 tablas sin DDL en el repo:** `data_cache`, `elo_ratings`, `line_openings`
  (usadas por `lib/cache.ts:46-77`, `lib/elo.ts:19-108`, `lib/lineMovement.ts:48-98`).
- **13 columnas de `picks` ausentes de migraciones y de `db/schema.sql`:**
  `trap_warning`, `edge_vs_market`, `floor_applied`, `confidence_raw`,
  `market_consensus_implied`, `market_sources_count`, `market_sources`, `locked_at`,
  `original_real_probability`, `original_odds`, `reanalysis_count`, `lock_reason`,
  `audit_failures`. `picks` tiene **60 columnas** en producción.
- **Índices únicos parciales no migrados:**
  `picks_pending_unique (sport, home_team, away_team, pick, bet_type) WHERE status='pending'`
  y `bets_pick_id_unique (pick_id) WHERE pick_id IS NOT NULL`.
  → **Corrige el inventario:** "cero unique constraints en `picks`" es literalmente
  cierto pero describe mal la protección real. Hay unicidad efectiva, sin constraint.
- **`bets_draftea_ticket_id_idx` NO es único** (`20260515000000_vision_bet.sql:4-7`):
  el comentario "dedup" no está garantizado por la DB.
- **Drift de DDL:** `picks.updated_at` es `NOT NULL DEFAULT now()` en producción y
  nullable en `db/schema.sql:12`; `settings.auto_sports` difiere entre ambos.
  `idx_cron_runs_started_at` existe con definición distinta a la migrada.
- Las migraciones `20260727*` **sí están aplicadas**, pese al comentario
  "NOT APPLIED YET" en `20260727120000_preseason_observation_only.sql:14-16`.

### Colisiones semánticas peligrosas (las que hay que decidir)

| Propuesto | Choca con | Resolución de W3 |
|---|---|---|
| `sharp_consensus_probability` | `market_consensus_implied` | **Choque fuerte.** El actual es media simple de DK/BPI/Pinnacle **raw** y mezcla predictor con books. Nombre nuevo `sharp_consensus_probability_no_vig`. **Nada de migración automática.** |
| `data_quality_flags` | `audit_failures` | Choque: `audit_failures` es calidad **del pick**, no del dato fuente. Campo nuevo, en el quote. |
| `price_edge_pp` | `edge`, `edge_vs_market`, `edge_vs_pinnacle` | Tres cosas distintas ya. Nombre explícito: `adjusted_probability_minus_draftea_implied_pp`. |
| `adjusted_probability` | `real_probability` | Cercano, no igual. Renombrar a `adjusted_win_probability`; migrar solo con versionado y excluyendo placeholders. |
| `sharp_probability` | `pinnacle_implied` | Peligro: el Pinnacle actual es **raw con vig**. Definir `sharp_probability_no_vig` o eliminarlo. |
| `actual_clv` | `bets.clv` | Equivalente **solo si** se fija fórmula y unidad. Con el veredicto B, `bets.clv` actual mide otra cosa. No duplicar. |
| `observation_only` | `picks.observation_only` | **Ya existe y coincide.** Reusar. |

### Estructura propuesta (mínima)

1. **`analyses`** — una fila por evento+corrida+`model_variant`: consenso no-vig,
   método, count, dispersión, `residual_adjustment_pp`, `adjusted_win_probability`,
   bounds, EV central/conservador, `expected_clv`, `selection_side`,
   `rejection_reason`, `data_quality_score`, `observation_only`.
   `picks` referencia `analysis_id` y sigue siendo la decisión publicable.
2. **`analysis_source_quotes`** — 1-a-N, **dos filas enlazadas por snapshot y fuente**
   (home y away): `source_name`, `source_kind` (`sportsbook|predictor`), `market_type`,
   `side`, `odds_decimal`, `implied_probability_raw`, `implied_probability_no_vig`,
   `fetched_at`, `minutes_to_start`, `source_event_id`, `source_status`, `is_stale`,
   `data_quality_flags`, `snapshot_group_id`.
   Único sugerido: `(analysis_id, source_name, market_type, snapshot_group_id, side)`.
   **La ingestión debe exigir home+away antes de declarar el snapshot usable.**
3. **`bets`** — conserva ejecución y CLV, más metadatos de apertura/cierre
   (`opening_quote_id`, `closing_quote_id`, `closing_fetched_at`, `closing_source_name`,
   `closing_was_fallback`) en vez de duplicar probabilidades.

### Regla NULL

Hoy se viola en **527 filas**: 511 `analyzed_no_edge` con
`real_probability=implied_probability=edge=confidence=0` y 16 `analyzed_no_odds_data`.
Escritores: `app/api/cron/analyze/route.ts:285-312`, `:340-365`;
`lib/pickGen.ts:1502-1549`.

Además: el clamp de visión convierte momios inválidos en **1.0**
(`lib/vision-extract-bet.ts:171-180`) — otro placeholder no-NULL, y este además es un
*precio*. Debe ser rechazo o NULL, nunca un precio.

---

## h) ANÁLISIS HISTÓRICO (W4)

SQL reproducible completo en `.fase0/W4-analisis-historico.md`.

### El daño de los placeholders, cuantificado

**511 filas = 57.0% del universo de 896 `picks`.** 181 en el último mes. En el 100% de
ellas: `real_probability=0`, `implied_probability=0`, `edge=0`, `edge_vs_market` NULL,
`original_odds` NULL.

**Análisis que quedan imposibles:**
1. Sensibilidad del `EDGE_THRESHOLD` — los candidatos de 0–5% de edge no guardaron nada.
2. Cuántos underdogs con EV positivo murieron solo por el piso de 55%.
3. Curva de calibración completa del modelo.
4. Simulación de cortes por EV sobre el 100% de la oferta.

### Distribuciones

| subconjunto | n | P10 | P25 | P50 | P75 | P90 | media |
|---|---|---|---|---|---|---|---|
| `real_probability` (todos, con placeholders) | 896 | 0.00 | 0.00 | **0.00** | 0.55 | 0.61 | 21.7% |
| `real_probability` (solo válidos) | 369 | 0.334 | 0.480 | **0.560** | 0.608 | 0.630 | 52.8% |
| `edge_vs_market` (persistidos) | 197 | +3.09% | +4.66% | **+6.96%** | +8.00% | +9.08% | +6.65% |

> **HALLAZGO DE PRIMER ORDEN PARA LA FASE 6:** la distribución completa de candidatos
> **es irreconstruible**. Los cortes por EV **no se pueden derivar del histórico**.
> Tienen que salir del modo observación de la Fase 7. Esto es una **dependencia dura
> que el documento de rediseño no contempla**: la Fase 6 no puede preceder a la 7 para
> fijar valores definitivos.

Nótese además que la mediana de `real_probability` en los válidos es exactamente
**0.560** y el P25 es 0.480: la masa está pegada justo encima del piso de 0.55. Es la
firma del filtro, no una propiedad del deporte.

### CLV por segmento

| segmento | n | media CLV |
|---|---|---|
| Favoritos (<2.00) | 30 | −0.874 pp |
| Underdogs (≥2.00) | 14 | −1.065 pp |
| momio 1.50–1.99 | 30 | −0.874 pp |
| momio 2.00–2.49 | 13 | −1.046 pp |
| momio ≥2.50 | 1 | −1.314 pp |

**Welch t = 0.866, df 25.6, p ≈ 0.395 — no significativo.**
*Corrección al dato previo: el encargo decía t=1.68; el cálculo exacto sobre la muestra
completa da 0.866. Misma conclusión.*

⚠️ **Toda esta sección hereda el veredicto B**: el CLV almacenado mide spread entre
casas. La gradación por momio (más negativo cuanto más largo el precio) es consistente
con un haircut de casa proporcional, no con movimiento de mercado.

### Filtros que más underdogs eliminan

| ranking | estado | filas | underdogs |
|---|---|---|---|
| 1 | `analyzed_no_edge` | 511 | **NO VERIFICABLE** (placeholders) |
| 2 | `skipped` | 90 | **56** |
| 3 | `expired_no_bet` | 93 | 32 |
| 4 | `superseded_legacy` | 59 | 29 |
| 5 | `filtered_quality_audit` | 52 | 20 |

Desglose de `filtered_quality_audit` (vía `audit_failures` jsonb):
`lock_with_low_raw_confidence` 9 · `floor_not_applied` 7 · `edge_vs_market_excessive` 2.

### Los caps del prompt: cuantificación completa

**75 de 242 picks (31.0%) violan el cap declarado.**

| deporte / lado | cap | n | violaciones | tasa | exceso medio | exceso máx |
|---|---|---|---|---|---|---|
| MLB visitante | 58% | 146 | **65** | **44.5%** | +3.94 pp | +12.2 pp (70.2%) |
| MLB local | 66% | 69 | 3 | 4.3% | +2.00 pp | +4.0 pp |
| NBA visitante | 55% | 12 | **5** | **41.7%** | **+13.40 pp** | **+17.0 pp (72%)** |
| NHL visitante | 55% | 4 | 2 | 50.0% | +1.00 pp | +1.0 pp |
| NBA/NFL local | — | 6 | 0 | 0% | — | — |

El problema se concentra en el **lado visitante**. `lib/pickGen.ts` no valida ni trunca:
los caps son decorativos. **Esto valida la decisión de la Fase 5 de aplicarlos
server-side.**

⚠️ **Salvedad metodológica mía:** el SQL de W4 detecta el lado con
`pick ILIKE '%' || home_team || '%'`, el mismo patrón de matching por nombre que la
deuda técnica #8 reporta como frágil con nombres cortos ("Sox"). Las magnitudes son
demasiado grandes para invertirse por eso, pero los conteos exactos merecen recontarse
con el matcher corregido.

---

## b) PLAN DE ARCHIVOS POR FASE, Y DEPENDENCIAS (W5)

Detalle completo con rutas verificadas en `.fase0/W5-plan-riesgos.md` §1.

```
FASE 0 ──┬─────────────────────────────────────────────► (desbloquea todo)
         ├─ FASE 1 ──► FASE 2 ──┬─► FASE 3 ──┬─► FASE 4 ──┐
         │  (bloq. W3)          │            │            ├─► FASE 7 ──► FASE 8
         │                      │            └─► FASE 5 ──┤
         │                      └─► FASE 6 ───────────────┘
         └─ Deuda #7,#8,#9,#12 (tests + logs) ───────────► en paralelo, siempre
```

**W5 propone una FASE 0 nueva (frenos y andamio de tests) que no está en el documento.**
La respaldo: sin kill switch no se puede migrar con seguridad, y sin runner de tests no
hay red para la Fase 2.

**Dependencias duras, con su razón:**
- **1 → 2:** la Fase 2 debe *persistir* `implied_probability_no_vig`. Sin la columna,
  PostgREST rechaza el insert y **muere el pipeline entero**. No es preferencia de
  orden: el código no arranca.
- **2 → 3, 4, 5, 6:** un consenso sobre implícitos con vig hereda el sesgo y lo hace
  variable según `sources_count`.
- **3,4,5,6 → 7 → 8.**
- **W3 → 1** (schema real) y **W1 → 8** (el CLV es el criterio de activación).
- **NUEVA, del hallazgo de W4: 7 → 6 para valores definitivos.** Los cortes por EV no
  se pueden fijar antes de generar la distribución.

**Pueden ir en paralelo:** Fase 3 y Fase 6 (chocan solo en `lib/pickGen.ts`);
Fase 4 y Fase 5; y la deuda #7/#8/#9/#12 con todo.

---

## d) RIESGOS POR FASE — MODO DE FALLO CONCRETO

Extracto de los silenciosos, que son los que importan. Completo en W5 §2.

| fase | modo de fallo | qué se observa |
|---|---|---|
| **2** | Si no se capturan ambos lados, el de-vig produce probabilidades **silenciosamente sesgadas** y todo aguas abajo hereda el sesgo sin señal de error. | Nada. El pipeline corre verde. |
| **2** | Overround extremo o mercado de un solo lado sin rechazo explícito → normalización proporcional devuelve un número plausible pero falso. | Nada, hasta que el CLV no cierra. |
| **3** | Consenso construido sobre implícitos con vig: el sesgo **varía con `sources_count`**, así que `edge_vs_market` no es comparable entre picks. | Métricas que se mueven al cambiar la cobertura de fuentes, no el modelo. |
| **5** | Claude cita datos ausentes del payload (alucinación) y el ajuste residual se aplica igual. | Nada, si no se persiste el conteo de rechazos. |
| **6** | Fijar cortes contra una distribución contaminada por 511 placeholders. | Cortes que parecen calibrados y están puestos sobre ruido. |
| **1** | Migrar `real_probability=0 → NULL` sin backup, con el cron vivo. | Pérdida irreversible, y el backup no es un punto consistente. |
| **transversal** | `supabase db push` aplica **todas** las migraciones pendientes. Una migración a medio cocinar se va a producción con la siguiente. | Deploy sorpresa. |

---

## e) PLAN DE TESTS

El proyecto tiene **cero tests**. W5 propone **Vitest** y 7 suites, en este orden:

1. **Eliminación de vig (P1)** — casos conocidos, overrounds extremos, mercados de un
   solo lado.
2. **Emparejamiento de eventos y equipos** (deuda #7, #11).
3. **Nombres cortos — el caso "Sox"** (deuda #8). *Nota: W4 acaba de usar ese mismo
   patrón frágil en su SQL, lo que confirma que el problema es transversal.*
4. **Temporadas y preseason** (deuda #9) — `ALLOWED_SEASON_TYPES`, `OBSERVATION_SPORTS`.
5. **Aritmética de EV con favoritos Y underdogs** — simetría del pipeline.
6. **Tiers y etiquetas** — no-regresión de `24af709`.
7. **Sanitización del prompt** — regla no negociable: no leakear momios a Claude.

Puerta de salida del proyecto: `tsc --noEmit`, tests y `next build`. Los tres.

---

## f) PLAN DE MIGRACIONES

7 migraciones, todas reversibles o con razón documentada. Detalle en W5 §4.

**Restricciones que mandan sobre el orden:**
1. `supabase db push` aplica **TODAS** las pendientes → nunca dejar una a medias en el
   directorio.
2. **Migración PRIMERO, deploy DESPUÉS** → si el código sale antes que la columna,
   PostgREST rechaza y cae el pipeline.
3. **M2** (placeholders → NULL, 188+ filas) **no es reversible** → exige backup previo,
   que a su vez exige el kill switch de la Fase 0. Es una cadena, no una lista.

Secuencia de ingestión que W3 recomienda para el modelo nuevo:
crear tablas/columnas/índices → desplegar dual-write → validar pares y NULL →
backfill solo de hechos demostrables → cambiar readers → retirar legado en migración
posterior. **Nunca fabricar el lado faltante ni el no-vig desde el lado apostado.**

---

## g) CRITERIOS DE ACEPTACIÓN

Uno por fase, con verificación concreta (comando/query/observación). Completos en
W5 §5. El de la Fase 0 es el que desbloquea todo lo demás y debería aprobarse primero.

---

## REUSO DEL MECANISMO DE OBSERVACIÓN (FASE 7)

**Ya existe y hay que extenderlo, no reconstruirlo.** W5 ubicó las 4 capas de bloqueo
con línea (§6.2). Lo que hay que extender (§6.3): las tres variantes
(`market_only`, `market_plus_claude`, `legacy_model`) y el arranque global en
`observation_only = true`. Lo que **no** hay que tocar (§6.4): la maquinaria ya es
agnóstica de deporte — ampliar es agregar la clave al set en `lib/espn.ts`.

---

## LO MÁS GRAVE QUE APARECIÓ Y NO ESTABA EN EL ENCARGO

### Dos rutas `POST` públicas sin autenticación

**Verificado por mí directamente:**

```
grep -n "CRON_SECRET|authOk|Authorization|auto_enabled"
  app/api/check-results/route.ts app/api/generate-picks/route.ts
→ NINGUNA COINCIDENCIA EN AMBAS
```

Mientras `app/api/cron/analyze/route.ts:1010-1018` sí tiene `authOk()` con `CRON_SECRET`.

- `app/api/check-results/route.ts:43` — `export async function POST()`. Resuelve bets y
  **mueve bankroll** (`:198-207`).
- `app/api/generate-picks/route.ts:43` — `export async function POST(req)`. Llama
  `analyzeGames` directo: **vía completa de generación de picks** que ignora
  `auto_enabled`.

**Consecuencia operativa:** el inventario decía que el corte efectivo era cortar
`CRON_SECRET` en Vercel. **No lo es.** Cortar `CRON_SECRET` no apaga estas dos rutas.
Cualquiera con la URL del deploy puede disparar resolución de bets y generación de picks.

Y el kill switch conocido, confirmado línea por línea: `auto_enabled === false` solo
hace `return` **dentro** de `runAnalyzeWindow()` (`:146`); `handle()` (`:1017`) llama
`runResultsCheck()` (`:1036`) y `cleanupOrphanedPicks()` (`:1043`) en sus propios `try`,
y **ninguna consulta el flag**. De 10 apariciones de `auto_enabled` en el repo, **una
sola** es un gate de comportamiento.

### El `EDGE_THRESHOLD` está mal ubicado, ya desincronizado, y es insuficiente

- Está en **`lib/pickGen.ts:942`**, no en `:900` como decía el encargo.
- **Declarado dentro del cuerpo de un `flatMap`**: no es importable, no es testeable, y
  no puede depender del deporte.
- **Ya está desincronizado de su documentación:** el comentario de `lib/pickGen.ts:246`
  dice *"below EDGE_THRESHOLD (2%)"* cuando el valor real es 5%. Es exactamente el bug
  de `TIER_RANGE` que se corrigió en `24af709`, otra vez.

**Y el número está mal.** Con el ratio Draftea/DK medido (0.98073, sd 0.0174):

```
coste en probabilidad implícita = (1−r)/(r·O) = 0.985 pp
umbral requerido = 0.05/r + (1−r)/(r·O) = 6.084%
```

> **`EDGE_THRESHOLD` debería pasar de 5.0% a ~6.1%** para que "5% de edge" signifique
> en la ejecución lo que hoy dice significar en el análisis. Redondeo operativo: **6%**.

Un pick que el sistema llama "5.0% de edge" es, ejecutado en Draftea, un pick de **4.0%**.
Cualquier pick con edge DK < ~1 pp es **−EV** en Draftea aunque el sistema lo marque
positivo. **Draftea se lleva ~22% del EV esperado del sistema** (2.168 puntos de ROI
sobre el stake).

Recomendación de forma (el valor lo decide Christian): expresarlo como
`EDGE_THRESHOLD_BASE + BOOK_HAIRCUT[book]` con `BOOK_HAIRCUT.draftea = 0.0099`, medido y
re-medible. Así se toca un número con procedencia, no una constante mágica.

---

## j) CONTRADICCIONES ENTRE EL DOCUMENTO DE REDISEÑO Y EL CÓDIGO REAL

W5 documentó 8. Las que cambian el plan:

1. **La Fase 4 no es implementable como está escrita.** El documento habla de
   `draftea_odds`, `price_edge_pp` contra Draftea y "edge de precio contra Draftea".
   **Draftea no es una fuente de momios del sistema**: aparece solo en la extracción por
   visión de tickets **ya apostados** (`lib/vision-extract-bet.ts:51-73`) y su matching
   (`lib/bet-matching.ts:40-56`). Todo el edge se calcula contra **DraftKings vía ESPN**
   (`lib/pickGen.ts:926-929`). W1 lo confirma desde fuera: el repo no hace ni una
   llamada HTTP a ningún host de Draftea; `api.draftea.com` responde 404 JSON y **NO
   VERIFICABLE** si hay endpoint público sin inspeccionar tráfico autenticado.
   → **Decisión necesaria de Christian:** o se construye un capturador de precios de
   Draftea (¿scraping? ¿captura manual?), o la Fase 4 mide contra otra cosa y el
   "price edge" cambia de definición.

2. **El vig no se elimina en ninguna parte, y el consenso mezcla peras con manzanas.**
   `lib/edge.ts:1` es `1/oddsDecimal` crudo. `computeMarketConsensus`
   (`lib/edge.ts:44-79`) promedia el implícito **con vig** de DK, el **con vig** de
   Pinnacle y el `espn_bpi`, que es probabilidad de modelo y **ya viene sin vig**. Con
   overround 1.048, cada implícito de casa está inflado ~2.4 pp y el BPI no.
   → **El sesgo del promedio depende de cuántas fuentes de casa entraron ese día**, así
   que `edge_vs_market` **no es comparable entre picks**. Esto confirma que la Fase 2 es
   el cimiento correcto, y además invalida comparaciones históricas de esa columna.

3. **El bloqueante de la Fase 2 es real y el documento no lo anticipa:** no se persisten
   ambos lados. Solo `pinnacle_cache` (10 min de TTL) y `line_openings` (primer
   avistamiento, sin nombre de casa) guardan pares. **No hay historial 1-a-N
   candidato/fuente con par completo, timestamp, casa y evento.**

4. **La Fase 6 no puede calibrarse contra el histórico** (hallazgo de W4). El documento
   dice "NO fijar thresholds definitivos sin analizar primero la distribución
   histórica"; esa distribución **no existe**. Hay que invertir la dependencia: la
   Fase 7 genera los datos que la Fase 6 necesita.

5. **"NO filtrar partidos antes de analizarlos por límites artificiales"** — ya se hace,
   en dos sitios (W5 §8.7).

6. **La Fase 5 choca con una regla no negociable del propio documento** (W5 §8.3).

7. El documento propone campos que ya existen con otra semántica (W5 §8.4, y la tabla
   de colisiones de W3 arriba).

8. **Supuestos numéricos que no cuadran** (W5 §8.5), incluido el `EDGE_THRESHOLD:900`
   vs `:942`.

---

## NO VERIFICABLE — lo que quedó abierto

- **Separación exacta margen-vs-deriva dentro del −0.985 pp.** Acotada por arriba
  (el movimiento DK total es −0.018 pp) pero no desglosada. La resuelve el protocolo
  empírico de W1 §3 (~25 min de Christian, 6–8 juegos, captura simultánea).
- **Overround de Draftea.** No se captura el lado contrario del ticket. Sin él no hay
  de-vig de Draftea ni comparación de opiniones entre casas.
- **Existencia de una API de momios de Draftea utilizable.**
- **Cuántos underdogs con EV positivo murieron solo por el piso** — irrecuperable, los
  511 placeholders se lo llevaron.
- **Semántica histórica y autoría de las 13 columnas no migradas** — no hay migración ni
  audit log de DDL.

---

## §W2 — MAPEO ESTÁTICO: LO QUE SOLO ÉL ENCONTRÓ

W2 (Codex) completó el análisis pero **su sandbox `-s read-only` le impidió escribir el
entregable** (error de configuración mío al lanzarlo). Se recuperó por stdout sin
re-correr el análisis. Su inventario de consumidores por símbolo —probabilidades, edge,
tiers, unidades/Kelly, auditorías, notificaciones, persistencia, resolución, CLV— quedó
capturado con `archivo:línea`.

### Veredicto de W2 sobre el acoplamiento al favorito

> "`picked_side` **no** está ligado al favorito en el selector actual; **tier y
> elegibilidad sí** lo están. El sistema solo puede recomendar un underdog si su
> probabilidad posterior al dampening supera el piso deportivo —55%, o 59% NFL—,
> excluyendo el caso normal de un underdog con p<50% pero p>implied y EV positivo."

**Coincide exactamente con W5 y con mi verificación independiente.** Tres fuentes
convergentes, dos de ellas sin verse entre sí.

Acoplamientos al favorito que W2 añade y nadie más listó:

1. **`lib/units.ts:12-22`** — la justificación está escrita en la constante: VALUE se
   fija sobre el *home base rate* y LOCK donde gana el favorito promedio. **No por EV.**
   El comentario documenta el sesgo que la Fase 6 quiere eliminar.
2. **`lib/pickAudit.ts:110-117`** — LOCK **siempre falla** con odds > 2.5, aunque el EV
   fuese válido.
3. **`lib/learning.ts:50-55, :69-86` — taxonomía incorrecta.** `oddsRange` llama
   `slight_fav` al rango 2.00–2.49 y `underdog` solo a ≥2.5. En decimal binario, **una
   cuota >2.00 ya es underdog por precio**. Y `home_favorite` significa en realidad "el
   pick tiene odds<2", **no** que el local sea favorito.
   → Todo el `factor_performance` acumulado está etiquetado con esta taxonomía.
   Sumado al ítem 15 de la deuda (contar `wins` como apuestas), **las conclusiones de
   aprendizaje por factor no son confiables.**
4. **`app/api/generate-picks/route.ts:19-40`** — la preselección prioriza cercanía de la
   cuota local al 50%: puede omitir mismatches con underdog valioso **antes** de
   analizarlos. Choca con la regla no negociable "NO filtrar partidos antes de
   analizarlos por límites artificiales".
5. **`lib/lineMovement.ts:122-139`** — RLM define underdog por `implied<0.5` y deriva el
   otro lado como trampa favorita. Solo válido en mercados binarios.
6. **Complementos `1−p`** en `lib/pickGen.ts:161-175`, `lib/espn.ts:739-745`,
   `lib/elo.ts:76` — inválidos para mercados 3-way o de outcomes múltiples.

### Clasificación de módulos (qué sobrevive al rediseño)

- **AGNÓSTICO** (sobrevive): `lib/claude.ts`, `lib/cache.ts`, `lib/supabase.ts`,
  `lib/types.ts`, `lib/teams.ts`, `lib/normalize-bet.ts`, `lib/weather.ts`, los
  `*Stats.ts` por deporte, `lib/montecarlo.ts`, `lib/stats.ts`, `lib/telegram.ts`,
  `lib/healthChecks.ts`, `app/api/bankroll/**`, `app/api/settings`, `app/api/health/**`,
  `app/api/bets/[id]`, la ingesta por visión y matching, las RPC atómicas, y los
  componentes de presentación.
  *Caso dudoso señalado por W2:* `lib/elo.ts` es reutilizable salvo el complemento
  binario de `:76`.
- **ACOPLADO A DEPORTE** (parametrizar): `lib/units.ts` (`SPORT_THRESHOLDS`,
  multiplier), `app/api/generate-picks/route.ts`, `app/(tabs)/home/page.tsx`,
  `components/AutoSportsSettings.tsx`, `components/UpcomingGames.tsx`.
- **ACOPLADO A MONEYLINE de dos resultados** (reescribir): `lib/pickGen.ts`
  (`:734-743`, `:865-990`, `:1235-1297`), `lib/edge.ts:11-23`, `lib/lineMovement.ts`,
  `lib/pickAudit.ts:73-130`, `lib/betEval.ts:5-105`, `app/api/check-results/route.ts` y
  la resolución del cron, `components/EdgeBar.tsx`, `app/api/pending-picks`,
  `app/(tabs)/picks/page.tsx`, y **`db/schema.sql:20-44, :72-92`** — `pick` es texto y
  no existen `picked_side`, `market` ni `outcome`, lo que fuerza inferencia por string.

### 🔴 Thresholds duplicados que YA DIVERGIERON (no son riesgo futuro)

| qué | copias | estado |
|---|---|---|
| **Leyenda de tiers** | `lib/units.ts:24-49` ↔ **`app/(tabs)/home/page.tsx:161-165`** | **DIVERGIÓ. Verificado por mí.** |
| **Edge principal** | código 5% `lib/pickGen.ts:941-964` ↔ comentarios `lib/pickGen.ts:734-742`, `app/api/cron/analyze/route.ts:329-332`, `lib/telegram.ts:511-517` | **DIVERGIÓ:** comportamiento 5%, explicación 2%. |
| **Kelly** | `lib/units.ts:69-80` ↔ `components/PickCard.tsx:270-276`, `:54-61` | **DIVERGIÓ:** la UI ignora `conservative`, el multiplier y la escala final. Puede mostrar una fracción distinta de la usada. |
| **Bins de momio** | `lib/learning.ts:50-55` ↔ `:74` | **DIVERGENCIA INTERNA:** `home_favorite` usa <2, `odds_range` llama `slight_fav` a 2–2.5. |
| Fórmula y fallback de CLV | `app/api/cron/analyze/route.ts:829-855` ↔ `app/api/check-results/route.ts:139-180` | Duplicada, con redondeo y logging distintos. |
| Kelly learning | `lib/units.ts:107-112` (n=30, cortes .58/.53/.48) ↔ `app/api/cron/calibrate/route.ts:29-33` (muestra 20, outputs 1.5/1/.5/0) | Cortes coinciden; muestra y outputs divergen. |
| Unidades por tier | `lib/units.ts:4-9` ↔ `lib/stats.ts:156-161` ↔ 2 textos de UI | Coinciden hoy; **cuatro** fuentes. |
| Confidence | `lib/prompts.ts:338-383` ↔ `lib/learning.ts:57-62` ↔ `lib/pickAudit.ts:66-108` (45/65) ↔ `lib/pickGen.ts:1164-1177` (55) | Contrato repartido en cuatro sitios. |
| Suma de probabilidades | prompt ±.02 ↔ servidor ±.03 (`lib/pickGen.ts:865-880`) | Divergencia intencional, sin constante contractual. |
| Bankroll inicial | `db/schema.sql:119-127` ↔ `app/api/bankroll/recalculate/route.ts:8` ↔ `app/(tabs)/stats/page.tsx:70` | Coinciden hoy; tres fuentes. |
| Edge 5% / 3% / 2% | ~11 sitios con el mismo número y **semánticas distintas** | Coincidencia accidental; requieren nombres propios. |

#### 🔴 EL BUG VIVO: la leyenda de tiers volvió a mentir, y miente sobre NFL

`app/(tabs)/home/page.tsx:161-165` es una **segunda copia hardcodeada** de los umbrales:

```
LOCK   · 2 units   · MLB/NHL 65%+ | NBA/NFL 68%+
STRONG · 1.5 units · MLB/NHL 60-64% | NBA/NFL 62-67%
VALUE  · 1 unit    · 55%+ todos los deportes        ← FALSO
```

Contra `SPORT_THRESHOLDS` real (`lib/units.ts:24-30`):

- **VALUE NFL es 0.59, no 0.55.** La leyenda dice "55%+ todos los deportes". **Miente.**
- **STRONG NFL empieza en 0.63, no en 0.62.** El rango "62-67%" está mal.
- **WNBA no aparece** en la leyenda.

**La ironía está escrita en el propio código.** El docstring de `lib/units.ts:19-22` dice:

> *"Exported because tierRange() derives the user-facing labels from the same numbers —
> the legend used to be a hardcoded second source of truth and drifted (it showed
> 'LOCK 85-100%' while the system emitted LOCK from 65%)."*

El commit `24af709` arregló **una** leyenda (`TIER_RANGE`) y **dejó viva esta otra**.
El mismo bug, en el mismo proyecto, en otro archivo — y esta vez la mentira es sobre
**NFL**, justo antes de que arranque la preseason el 13-ago. Es el único deporte con
umbrales distintos y es exactamente el que la leyenda describe mal.

**Es un bug de producción, hoy, sin relación con el rediseño.** Debe arreglarse en la
Fase 0 derivando la leyenda de `tierRange()`, no en una fase posterior.

---

## CRUCE OBLIGATORIO W2 ↔ W3

Los dos mapearon el mismo sistema desde ángulos distintos: W2 estático sobre el código,
W3 sobre el catálogo real de producción y las fuentes.

### Dónde convergen (y por eso son creíbles)

| punto | W2 (código) | W3 (producción) |
|---|---|---|
| Reescritor de `picks.odds_decimal` | `confirm/route.ts:194-230` en su mapa de persistencia | catálogo: cero triggers, 4 funciones, ninguna escribe la columna |
| Ambos lados existen en memoria | ESPN y Pinnacle exigen home+away | idem, y confirma que **no se persisten** |
| Placeholders | `analyze/route.ts:285-312`, `:340-365` | 511 + 16 filas medidas en producción |
| Acoplamiento binario | 8 sitios que derivan el otro lado como `1−p` | `db/schema.sql`: no hay `picked_side`/`market`/`outcome` |

### Lo que aparece en uno y NO en el otro — el valor del cruce

**Solo W2 (invisible desde la DB):**
- Las **10 duplicaciones de thresholds**, 4 de ellas ya divergidas. Ningún catálogo de
  Postgres las muestra: viven en TypeScript y en JSX.
- **El bug vivo de la leyenda de tiers.** W3 no podía verlo: es texto de UI.
- La **taxonomía rota de `lib/learning.ts`** (`slight_fav` para 2.00–2.49,
  `home_favorite` significando odds<2). Los datos de `factor_performance` en la DB se
  ven perfectamente sanos — el error está en cómo se etiquetan al escribir.
- La preselección de `generate-picks` que filtra por cercanía al 50%.

**Solo W3 (invisible desde el código):**
- Las **13 columnas de `picks` sin DDL en el repo** y las **3 tablas sin migración**.
  El código las usa con naturalidad; nada en TypeScript delata que no existan en
  ninguna migración.
- **`picks_pending_unique` y `bets_pick_id_unique`**: índices únicos parciales reales,
  no migrados. W2 leyó `db/schema.sql:9-54` y habría concluido —correctamente según el
  repo— que no hay unicidad. **La producción dice otra cosa.**
- El drift de `picks.updated_at` (NOT NULL DEFAULT en producción, nullable en el repo) —
  relevante porque es el reloj que permitió a W1 fechar la reescritura.
- Que `bets_draftea_ticket_id_idx` **no es único** pese al comentario "dedup".
- Que las migraciones `20260727*` **sí están aplicadas** pese al comentario
  "NOT APPLIED YET" en el propio archivo.

> **Conclusión del cruce:** ninguno de los dos mapas, por separado, describe el sistema.
> El código miente sobre el estado de la base (13 columnas y 2 índices que no declara);
> la base no puede mostrar dónde el código se contradice a sí mismo (10 duplicaciones,
> 4 divergidas). **La leyenda de tiers rota solo aparece en el cruce**: es una copia
> hardcodeada de un valor que W3 confirma correcto en `SPORT_THRESHOLDS` y que W2
> encuentra repetido y desactualizado en JSX.

---

## INCIDENCIAS DE EJECUCIÓN (para el registro)

1. **La sección CONTEXTO del encargo llegó vacía** (placeholder sin resolver). Lancé W1,
   W2 y W4 con briefs autosuficientes; W3 salió ya con el documento incorporado y W5
   ~4 min después. Ningún worker recibió contenido inventado. **Corrección a
   `00-CONTEXTO-COMPARTIDO.md:25-33`**, que quedó desactualizado y W5 señaló con razón:
   el documento sí estaba disponible para los dos últimos workers.
2. **W2 no pudo escribir su entregable**: lo lancé con `codex -s read-only -a never`
   siguiendo la regla de "solo lectura estática", pero eso también bloquea escribir en
   `.fase0/`. Error mío de configuración, no del worker. Recuperado por stdout sin
   re-correr el análisis; el reporte quedó en esta integración y **no existe
   `W2-pipeline-map.md` como archivo**.
   → Para la Fase 1: los workers de lectura necesitan `-s workspace-write` con el brief
   restringiendo qué pueden tocar, o un directorio de salida fuera del sandbox.
3. **Contabilidad**: lanzamiento 10:47–10:52, recolección 10:52–11:06.
   W4 cerró a los 5 min; W3 a los 14; W1 a los 15; W5 a los 18. Tiempo muerto
   DONE→recogido: <1 min en los cuatro. W2 requirió ~10 min extra de recuperación.
