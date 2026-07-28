# W5 — PLAN POR FASES, RIESGOS, TESTS Y MIGRACIONES

Worker: W5 · Fecha: 2026-07-28 · HEAD auditado: `b833d98` (main)
Método: lectura estática del repo. **Cero writes fuera de `.fase0/`.** No se
ejecutó nada contra Supabase ni contra APIs externas en esta entrega.

Nota de arranque: `00-CONTEXTO-COMPARTIDO.md:25-33` dice que el documento de
rediseño no llegó. **Sí está**: `01-DOCUMENTO-REDISENO.md` existe y fue mi
insumo principal. Nada quedó `BLOQUEADO` por ese motivo.

---

## 0. LO QUE CAMBIA EL PLAN — LEER ANTES QUE EL RESTO

Cinco hallazgos del código que reordenan el plan de fases. Los cinco están
verificados con `archivo:línea`. Los desarrollo en §8, aquí va el titular.

**H1 — Draftea no es una fuente de momios del sistema. No existe.**
El documento habla de `draftea_odds`, `draftea_implied_probability`,
`price_edge_pp` contra Draftea y "NO recibir el momio de Draftea" (Fase 1,
Fase 4, Fase 5). En el repo, Draftea aparece **solo** en la extracción por
visión de tickets ya apostados (`lib/vision-extract-bet.ts:51-73`) y en el
emparejamiento de esos tickets (`lib/bet-matching.ts:40-56`). **Todo el edge
se calcula contra DraftKings vía ESPN** (`lib/pickGen.ts:926-929`). Fase 4 tal
como está escrita no es implementable: pide medir el precio de una casa que el
pipeline no consulta.

**H2 — El vig no se elimina en ninguna parte, y el consenso mezcla peras con
manzanas.** `lib/edge.ts:1` es `1/oddsDecimal` crudo. `computeMarketConsensus`
(`lib/edge.ts:44-79`) promedia el implícito **con vig** de DK, el implícito
**con vig** de Pinnacle (`lib/pinnacle.ts:79-83`) y el `espn_bpi`, que es una
probabilidad de modelo y **ya viene sin vig**. Con overround medido de 1.048,
cada implícito de casa está inflado ~2.4pp; el BPI no. El promedio resultante
está sesgado hacia arriba en una cantidad que depende de **cuántas fuentes de
casa entraron ese día**. Esto convierte a la Fase 2 en el cimiento correcto —
confirma el brief — pero también significa que `edge_vs_market` histórico **no
es comparable entre picks**, porque el sesgo varía con `sources_count`.

**H3 — Sí hay un filtro estructural que bloquea un lado del mercado, y está en
una línea.** `lib/pickGen.ts:1067-1077`: si `tierFromProbability(pickedProb,…)`
devuelve `null` el pick se descarta. `lib/units.ts:43` devuelve `null` cuando
`realProbability < value` (0.55 MLB). El underdog canónico del documento —
p=0.45, momio 2.50, EV +12.5% — **pasa** el gate de edge
(`0.45 − 0.40 = +0.05 ≥ EDGE_THRESHOLD`) y **muere** en el tier. Los 79
underdogs medidos no refutan el filtro: "underdog" ahí es por momio, y el
filtro es por probabilidad de modelo. Detalle completo en §8.1.

**H4 — El misterio de `picks.odds_decimal` está resuelto: es código de la
aplicación, no un trigger.** `lib/pickGen.ts:1834-1859` reescribe
`odds_decimal` en cada re-análisis del cron (cada 10 min) mientras el pick está
`pending`. Y `place_bet_atomic` guarda `odds_at_bet := p_odds_decimal`
(`supabase/migrations/20260727120000_preseason_observation_only.sql:97,103`),
que la ruta recibe del cliente (`app/api/bets/route.ts:98`), que la UI toma del
pick vigente (`components/PickCard.tsx:94`). El ratio 1.0000 con sd 0.0002 no
es una coincidencia sospechosa: **es una identidad por construcción**. No hace
falta seguir buscando el objeto fantasma en producción.

**H5 — El kill switch es peor de lo inventariado: hay dos rutas de escritura
públicas y sin auth.** Además de `runResultsCheck` (§7.1), `/api/check-results`
(`app/api/check-results/route.ts:43`) y `/api/generate-picks`
(`app/api/generate-picks/route.ts:43`) exportan `POST` **sin `authOk` y sin
`CRON_SECRET`**. `generate-picks` llama `analyzeGames` directo: es una vía
completa de generación de picks que ignora `auto_enabled` y que cualquiera con
la URL puede disparar. Cortar `CRON_SECRET` **no apaga estas dos**.

---

## 1. PLAN DE ARCHIVOS POR FASE

Rutas verificadas contra el árbol real en `b833d98`. `[N]` = archivo nuevo.

### FASE 0 (nueva, propuesta) — Frenos y andamio de tests

No está en el documento. La propongo delante de todo porque las Fases 1-8
implican migraciones y mantenimiento sobre `picks`/`bets` con el cron vivo, y
hoy **no hay forma de pararlo** (§7.1, H5).

| Archivo | Qué se toca |
|---|---|
| `app/api/cron/analyze/route.ts` | Gate `auto_enabled` en `handle()` antes de `:1036` y `:1043`, no dentro de `runAnalyzeWindow` |
| `app/api/check-results/route.ts` | Añadir `authOk` + gate `auto_enabled` |
| `app/api/generate-picks/route.ts` | Añadir `authOk` + gate `auto_enabled` |
| `db/schema.sql`, migración `[N]` | `settings.kill_switch_reason text`, `settings.auto_enabled_changed_at` |
| `package.json`, `[N] vitest.config.ts` | Runner de tests (§3) |
| `[N] tests/**` | Primeros tests: `pickedSide`, `tierFromProbability` |

### FASE 1 — Modelo de datos observable

| Archivo | Qué se toca |
|---|---|
| `db/schema.sql` | Documentar columnas nuevas de `picks` |
| `supabase/migrations/[N]_analysis_observable_v1.sql` | ~30 columnas nuevas + backfill NULL |
| `lib/types.ts` | `Pick` (`:80-95`), `Bet` (`:95-124`) |
| `lib/pickGen.ts` | `MappedRow` (`:750-800`), `PickRow`, payloads de insert (`:1776-1789`) |
| `lib/healthChecks.ts` | `checkDbColumns` (`:100-118`) — añadir cada columna nueva |
| `app/api/cron/analyze/route.ts` | Marcadores `analyzed_no_edge` (`:287-310`, `:341-364`): `0` → `NULL` |

**Dependencia dura de W3.** W3 está auditando schema real vs. migraciones. Si
aparecen columnas en producción sin migración (ya pasó 3 veces:
`20260521000000/010000/020000_retroactive_schema_sync*.sql`), un
`add column if not exists` con **tipo distinto** al de producción no falla —
no hace nada — y el código nuevo escribe contra un tipo que no esperaba.
**Marcado como bloqueante: no redactar la migración de Fase 1 hasta tener el
inventario de W3.**

### FASE 2 — Normalización y eliminación del vig (CIMIENTO)

| Archivo | Qué se toca |
|---|---|
| `[N] lib/devig.ts` | Capa única: emparejar lados, quitar vig, detectar mercado incompleto, registrar método |
| `lib/edge.ts` | `impliedProbability` (`:1`) pasa a ser explícitamente *raw*; `computeMarketConsensus` (`:44-79`) consume no-vig |
| `lib/pinnacle.ts` | `extractMlFromMarkets` (`:146-171`) devuelve el par para de-viggear; `home_decimal`/`away_decimal` (`:196-197`) |
| `lib/espn.ts` | `eventToGame` (`:244-270`) — conservar ambos lados por proveedor |
| `lib/pickGen.ts` | `:928-929` y `:1009` dejan de usar `1/odds` crudo |
| `[N] tests/devig.test.ts` | Casos conocidos, overrounds extremos, mercado de un solo lado |

### FASE 3 — Consenso sharp

| Archivo | Qué se toca |
|---|---|
| `[N] lib/sharpConsensus.ts` | Media/mediana/ponderado configurable, dispersión, fuentes rechazadas |
| `[N] lib/config/consensusWeights.ts` | Pesos explícitos y versionados |
| `lib/edge.ts` | `computeMarketConsensus` se retira o queda como adaptador legacy |
| `lib/pickGen.ts` | `:996-1022` |
| `lib/pinnacle.ts`, `lib/espn.ts` | Marcar `fetched_at` por fuente |

### FASE 4 — Benchmark market-only (OBLIGATORIA)

| Archivo | Qué se toca |
|---|---|
| `[N] lib/variants/marketOnly.ts` | Probabilidad final = consenso sharp sin vig |
| `lib/pickGen.ts` | Bifurcar `analyzeGames` por `model_variant` |
| `app/api/cron/analyze/route.ts` | Ejecutar la variante en cada corrida |

⚠️ **Fase 4 está bloqueada por H1.** El documento define su salida como "edge
de precio contra Draftea". El repo no tiene Draftea. Decisión de Christian
requerida (§8.2) antes de codificar: (a) contra DK vía ESPN, que es lo que hoy
existe pero **no** es donde se apuesta; o (b) integrar Draftea como fuente, que
es un proyecto en sí y no está en ninguna fase.

### FASE 5 — Claude residual

| Archivo | Qué se toca |
|---|---|
| `lib/prompts.ts` | Reescritura mayor: `sanitizeGameForClaude` (`:50-72`), caps (`:315-323`), base rates (`:118-124`) |
| `lib/pickGen.ts` | Schemas zod (`:40-110`), adaptador legacy (`:140-186`), caps server-side, contador de alucinaciones |
| `lib/claude.ts` | Sin cambio estructural |
| `[N] lib/serverCaps.ts` | Los caps que hoy se piden en el prompt |

### FASE 6 — Clasificación por EV

| Archivo | Qué se toca |
|---|---|
| `lib/units.ts` | `SPORT_THRESHOLDS` (`:24-30`), `tierFromProbability` (`:32-52`), `tierRange` (`:127-133`), `TIER_UNITS` (`:4-9`) |
| `[N] lib/config/tiers.v2.ts` | Config centralizada y versionada |
| `lib/pickGen.ts` | `:1067-1077` (el filtro de H3), `:1171` (guard "culero"), `:1169` (conf≥55) |
| `lib/types.ts` | `Tier` — quitar/deshabilitar `lock` |
| `components/PickCard.tsx`, `lib/telegram.ts` | Etiquetas de tier |

### FASE 7 — Observación y experimentos

Detalle completo en §6.

| Archivo | Qué se toca |
|---|---|
| `supabase/migrations/[N]_model_variant.sql` | `picks.model_variant`, índice |
| `lib/espn.ts` | `OBSERVATION_SPORTS` (`:145`) — no toca la maquinaria |
| `[N] lib/observationMode.ts` | Interruptor global `observation_only = true` |
| `[N] app/api/experiments/compare/route.ts` | Vista comparativa de variantes |
| `[N] lib/metrics/brier.ts` | Brier / log loss — **no existen hoy** |

### FASE 8 — Criterios de activación sellados

| Archivo | Qué se toca |
|---|---|
| `supabase/migrations/[N]_activation_criteria.sql` | Tabla `activation_criteria` versionada + sellada |
| `[N] lib/activation.ts` | Evaluación de criterios |
| `app/api/cron/calibrate/route.ts` | Añadir Brier/log-loss/calibración (`:130-145` hoy solo mira CLV) |

### Paralelismo y dependencias

```
FASE 0 ──┬─────────────────────────────────────────────► (desbloquea todo)
         │
         ├─ FASE 1 ──► FASE 2 ──┬─► FASE 3 ──┬─► FASE 4 ──┐
         │  (bloq. W3)          │            │            ├─► FASE 7 ──► FASE 8
         │                      │            └─► FASE 5 ──┤
         │                      └─► FASE 6 ───────────────┘
         │
         └─ Deuda #7,#8,#9,#12 (tests + logs) ───────────► en paralelo, siempre
```

**Pueden ir en paralelo:**
- Fase 0 con cualquier trabajo de tests. No comparte archivos con nada.
- Deuda técnica #7, #8, #9, #12 con todas las fases: son tests y logs, tocan
  `tests/**` y añaden `console.log` estructurado.
- **Fase 3 y Fase 6** entre sí una vez cerrada la 2: la 3 vive en
  `lib/sharpConsensus.ts` y la 6 en `lib/units.ts` + `lib/config/tiers.v2.ts`.
  Chocan solo en `lib/pickGen.ts` — asignar a un mismo dueño ese archivo, o
  serializar el merge.
- **Fase 4 y Fase 5** entre sí: variantes independientes
  (`lib/variants/marketOnly.ts` vs `lib/prompts.ts`), ambas cuelgan de la 3.

**Dependencia dura, con la razón:**
- **1 → 2.** La Fase 2 debe *persistir* `implied_probability_no_vig` y el
  método usado. Sin las columnas, PostgREST rechaza el insert con columna
  desconocida y muere el pipeline entero (regla dura del proyecto). No es
  preferencia de orden: es que el código no arranca.
- **2 → 3.** Un consenso construido sobre implícitos con vig hereda el sesgo
  de H2 y encima lo hace variable según `sources_count`. Optimizar pesos sobre
  esa base es ajustar pesos contra un sesgo.
- **2 → 4.** `market_only` *es* el consenso sin vig. Sin Fase 2 el benchmark
  no tiene nada que calcular.
- **2 → 5.** Fase 5 le pasa a Claude "el consenso sharp como prior". Si el
  prior lleva vig, cada ajuste residual se mide contra un ancla corrida.
- **2 → 6.** Los thresholds de EV se fijan tras "analizar la distribución
  histórica". Esa distribución debe recomputarse ya sin vig; hacerlo antes
  obliga a rehacerla.
- **3,4,5,6 → 7.** Las tres variantes del experimento necesitan existir para
  poder compararse.
- **7 → 8.** Los criterios de activación se sellan contra métricas que la
  Fase 7 produce.
- **W3 → 1.** Ver arriba: bloqueante explícito.
- **W1 → 8.** El documento dice que el criterio principal es CLV "siempre que
  la contradicción del CLV esté resuelta". H4 la resuelve por el lado del
  código; W1 debe confirmarlo con datos antes de sellar la Fase 8.

---

## 2. RIESGOS POR FASE — CÓMO SE ROMPE Y QUÉ SE OBSERVA

Prioridad a los fallos **silenciosos**. Marco cada uno con 🔇 (silencioso: no
lanza excepción, contamina datos) o 🔊 (ruidoso: rompe visiblemente).

### Fase 0

**R0.1 🔇 — El gate se pone en el sitio equivocado y el kill switch sigue sin
existir.** Si se añade el `if (auto_enabled === false)` dentro de
`runResultsCheck()` en vez de en `handle()`, quedan fuera `cleanupOrphanedPicks`
(`app/api/cron/analyze/route.ts:1043`, que hace `UPDATE picks SET status =
'skipped'` en `:1000-1003`) y las dos rutas públicas de H5. *Qué se observa:*
nada. El operador apaga el switch, ve el log `auto_disabled`, empieza a hacer
mantenimiento sobre `picks` y una corrida marca filas como `skipped` en medio.
*Verificación:* con el switch en `false`, un `POST /api/cron/analyze` debe
dejar `updated_at` de `picks` sin tocar y `bets` sin filas nuevas resueltas.

**R0.2 🔊 — Poner auth a `/api/check-results` y `/api/generate-picks` rompe un
consumidor no inventariado.** Nadie sabe hoy quién las llama (no hay workflow
de CI que las use: solo existen `calibrate.yml` y `heartbeat.yml`;
`cron-analyze.yml.disabled` está desactivado). *Qué se observa:* 401 en logs de
Vercel desde un origen desconocido. *Mitigación:* desplegar primero solo el
logging del `Authorization` recibido, mirar 48h, luego cerrar.

### Fase 1

**R1.1 🔇 — `0` sigue significando dos cosas durante la transición.** Hoy
`real_probability: 0` es placeholder (`app/api/cron/analyze/route.ts:300-302`
y `:354-356`). Si se añade la columna nueva y se deja la vieja escribiendo `0`,
cualquier query que agregue `real_probability` mezcla 188 placeholders con
predicciones reales. *Qué se observa:* medias de probabilidad que caen sin
causa deportiva; Brier score artificialmente pésimo cuando se calcule en Fase 8.
*Verificación:* `select count(*) from picks where status='analyzed_no_edge' and
real_probability = 0` debe ser 0 al cerrar la fase, y los históricos migrados
a NULL.

**R1.2 🔇 — Los marcadores `analyzed_no_edge` escriben `tier: 'value'`**
(`app/api/cron/analyze/route.ts:304` y `:358`) **con `odds_decimal: 1`**
(`:298`, `:352`). No son picks, pero cualquier estadística por tier los cuenta
como VALUE con momio 1.00. *Qué se observa:* el conteo de picks VALUE no cuadra
con los picks realmente emitidos; ROI por tier diluido hacia 0.
*Verificación:* `select tier, count(*) from picks where status='analyzed_no_edge'
group by 1` debe devolver solo NULL tras la fase.

**R1.3 🔇 — Nombre nuevo que colisiona con semántica vieja.** El documento pide
`observation_only` (Fase 1) y ya existe con un significado **más estrecho**:
"partido de exhibición según ESPN `season.type=1`"
(`supabase/migrations/20260727120000_preseason_observation_only.sql:21-22`). La
Fase 7 quiere "todo el sistema arranca en observación". Si se reusa la columna
sin separar los dos conceptos, al terminar la fase experimental se apaga el
modo global y **se desprotege la preseason**. *Qué se observa:* un pick de
pretemporada NFL se vuelve apostable sin que nadie haya tocado
`OBSERVATION_SPORTS`. *Mitigación:* columna separada `experiment_observation`
o un `observation_reason text` que distinga `preseason` de `experiment`.

**R1.4 🔇 — `healthChecks.checkDbColumns` no se actualiza.** `lib/healthChecks.ts:
100-118` enumera columnas a mano. Si la Fase 1 añade 30 y no se listan, el
check sigue verde mientras el insert real falla. *Qué se observa:* health
endpoint OK y `[pickGen] lock-in insert failed` en logs de Vercel, que nadie
mira. *Verificación:* toda columna nueva debe aparecer en ese `select`.

### Fase 2 — la fase de mayor riesgo silencioso

**R2.1 🔇 — El de-vig se aplica solo a la fuente que tiene ambos lados y las
demás quedan crudas.** `extractMlFromMarkets` de Pinnacle ya exige ambos lados
y devuelve `null` si falta uno (`lib/pinnacle.ts:146-171`), pero el BPI
(`lib/pickGen.ts:998-1002`) llega como una sola probabilidad de modelo y
DraftKings puede traer un lado (`lib/pickGen.ts:889-896` distingue
`home_ml_missing` / `away_ml_missing`). Si la capa nueva de-vigga lo que puede
y deja pasar lo demás, el consenso mezcla escalas. *Qué se observa:* el
`edge_vs_market` medio se mueve unos 2pp de un despliegue a otro sin que
cambien los momios, y la magnitud del salto correlaciona con `sources_count`.
*Verificación:* test que dé el mismo `no_vig` para el mismo par de momios
independientemente de cuántas otras fuentes haya, y una query que compruebe que
`sum(no_vig_home, no_vig_away) = 1.0 ± 1e-9` en el 100 % de las filas.

**R2.2 🔇 — El BPI se de-vigga "otra vez".** `espn_bpi` es una probabilidad de
modelo: ya suma 1. Si entra al normalizador proporcional junto a las casas, se
renormaliza contra sí mismo — inofensivo — pero si alguien lo mete en el mismo
pool que las casas *antes* de normalizar, arrastra el par entero. *Qué se
observa:* nada en los logs; probabilidades sistemáticamente corridas hacia el
BPI. *Mitigación:* el tipo de la fuente (`book` vs `model`) debe ser un campo
obligatorio en la capa nueva, no una convención.

**R2.3 🔇 — Emparejar lados de eventos distintos.** El documento pide
explícitamente "rechaza pares con timestamps o eventos incompatibles". Hoy no
hay tal chequeo: `dkOdds` viene atado al `Game` y Pinnacle se resuelve por
`pinnacle_matchup_id` cacheado (`lib/pinnacle.ts:181-197`) con TTL. En series
MLB el mismo matchup se repite en ±3 días (deuda #11). Un `matchup_id` obsoleto
en caché empareja el momio del partido de ayer con el evento de hoy. *Qué se
observa:* `sharp_dispersion` alta en juegos concretos y `edge` grande en la
misma serie durante varios días seguidos. *Verificación:* la capa nueva debe
rechazar cuando `|fetched_at(A) − fetched_at(B)| > N min` o cuando el
`source_event_id` no resuelve al mismo `game_start_time`.

**R2.4 🔇 — Overround < 1 (arbitraje o dato corrupto) pasa sin señal.** La
normalización proporcional acepta cualquier suma positiva. Con un momio mal
parseado (americano leído como decimal, por ejemplo), `q_home + q_away` puede
dar 0.6 y la normalización produce probabilidades preciosas y falsas. *Qué se
observa:* un pick con edge enorme y sin explicación. *Verificación:* rango
aceptado explícito (p. ej. `1.00 ≤ overround ≤ 1.20`), fuera de él → rechazo
con motivo persistido, no clamp silencioso.

**R2.5 🔊 — Mercado de un solo lado.** Debe rechazarse, no imputarse.
*Verificación:* test dedicado (§3.1, caso 5).

### Fase 3

**R3.1 🔇 — Ponderar sin declarar peso 0.** Si una fuente falla ese día y se
promedia sobre las presentes sin registrarlo, el "consenso ponderado" del lunes
y el del martes no son el mismo estimador. *Qué se observa:* dispersión que
baja mágicamente en días con caídas de API. *Verificación:* `sharp_sources_count`
y la lista de rechazadas deben persistirse siempre, incluso cuando el pick no
se emite.

**R3.2 🔇 — "Tres fuentes sharp por deporte" no se cumple hoy y nadie lo nota.**
El documento fija esa regla dura. En el código hay tres candidatas
(DK, BPI, Pinnacle) pero `computeMarketConsensus` devuelve resultado con **una
sola** (`lib/edge.ts:66`: solo rechaza si `values.length === 0`), y el gate de
dampening exige apenas `sources_count >= 2` (`lib/pickGen.ts:1029`). *Qué se
observa:* picks emitidos con una única fuente durante caídas de ESPN, con la
misma etiqueta de tier que picks con tres. *Verificación:* contar hoy
`select market_sources_count, count(*) from picks group by 1` — si hay filas con
1, la regla dura ya se está violando en producción.

### Fase 4

**R4.1 🔊/🔇 — El benchmark mide contra la casa equivocada (H1).** Si
`market_only` calcula el precio justo contra DK vía ESPN y el usuario apuesta en
Draftea, el benchmark responde "¿bate DK a DK?" en vez de "¿hay valor en
Draftea?". *Qué se observa:* `market_only` con CLV cercano a 0 por construcción
y ROI hipotético indistinguible de cero — y se interpretará como "el mercado es
eficiente" cuando en realidad es "nos medimos contra nuestro propio espejo".
Es exactamente la circularidad que ya mordió a este proyecto con
`picks.odds_decimal`. *Mitigación:* decisión explícita de Christian antes de
codificar (§8.2).

**R4.2 🔇 — `market_only` hereda el `EDGE_THRESHOLD` de 5 %.** Si la variante
reusa `lib/pickGen.ts:942`, no genera candidatos donde no hay edge y el
benchmark queda medido solo sobre el subconjunto donde el modelo legacy ya
opinaba. *Qué se observa:* `market_only` con muchos menos candidatos que
`market_plus_claude`, comparación no pareada. *Verificación:* las tres variantes
deben producir **una fila por juego analizado**, con `rejection_reason` cuando
no hay apuesta.

### Fase 5

**R5.1 🔇 — Los caps se mueven "server-side" pero se aplican por clamp mudo.**
El documento acierta en sacar los caps del prompt (72 de 166 picks lo violan
hoy; `lib/prompts.ts:320`). Pero si el server hace `min(p, cap)` y sigue,
pierde exactamente la señal que hace falta para saber si Claude aporta. *Qué se
observa:* la distribución de probabilidades se acumula en el valor del cap —
una barra vertical en el histograma. *Verificación:* persistir
`cap_applied boolean` + valor pre-cap; el conteo de clamps es una métrica de
calidad del modelo, no un detalle de implementación.

**R5.2 🔇 — El dampening actual ya es un cap encubierto y va a chocar con el
nuevo.** `lib/pickGen.ts:1028-1045` recorta la desviación a 8pp sobre el
consenso, **solo hacia arriba** (`(pickedProb − avg) > MAX_DEVIATION_PP`). Nada
recorta hacia abajo. Es el mismo diseño asimétrico que la Fase 6 quiere
eliminar. Si la Fase 5 añade caps sin retirar este, hay dos limitadores en
serie. *Qué se observa:* `real_probability` que no coincide con la
`adjusted_probability` que devolvió Claude, sin log que lo explique más allá de
`[PROB_DAMPENED]`.

**R5.3 🔇 — El adaptador legacy invierte probabilidades con equipos de nombre
corto.** `lib/pickGen.ts:164-166`: `homeLast.length >= 3 && pickLower.includes
(homeLast)`. Para "Chicago White Sox" vs "Boston Red Sox" ambos dan `sox`; el
adaptador concluye `isHome = true` siempre y en `:166` asigna
`home = p.real_probability` — **la probabilidad del lado contrario**. *Qué se
observa:* nada. Un pick de Red Sox con la probabilidad de los White Sox.
Mitigado hoy solo porque `LEGACY_SCHEMA_SUNSET` (`lib/prompts.ts:7`) es
2026-05-25 y ya pasó → la ruta lanza (`lib/pickGen.ts:150-155`). **Riesgo
reactivable:** cualquier cambio de prompt en Fase 5 que haga fallar el schema
nuevo cae en `:141` y lanza en `:151`. Ruidoso hoy, pero verificar que la Fase 5
no reviva el adaptador.

**R5.4 🔇 — "Alucinación" definida como string-matching.** El documento pide
rechazar ajustes que citen datos ausentes del payload. Si se implementa
buscando la subcadena de `evidence` en el JSON, un modelo que parafrasee marca
falsos positivos y uno que copie literalmente un campo irrelevante pasa. *Qué
se observa:* la métrica que "decide si Claude aporta o contamina" mide
formato, no veracidad. *Mitigación:* validar contra la **lista de claves**
presentes en `real_data`, no contra el texto.

### Fase 6

**R6.1 🔇 — Se quita el piso de probabilidad y se olvida el guard "culero".**
`lib/pickGen.ts:1171`: `p.odds_decimal < 1.4 && p.edge < 0.05` descarta, y
`lib/units.ts:45-49` degrada tier cuando `odds < 1.40`. Ambos son filtros por
precio, no por EV, y ambos sobreviven a quitar `tierFromProbability`. *Qué se
observa:* la asimetría persiste después de la fase que la iba a eliminar, y
nadie lo nota porque el filtro que se documentó (el piso) sí se quitó.

**R6.2 🔇 — `TIER_RANGE` v2.** `tierRange` (`lib/units.ts:127-133`) ya deriva
las etiquetas de `SPORT_THRESHOLDS` — eso se arregló en `24af709`. Si los tiers
pasan a depender de EV y las etiquetas siguen expresándose en % de
probabilidad, vuelve exactamente el bug de `24af709` con otro disfraz. *Qué se
observa:* el usuario ve "VALUE 55-59 %" en un pick con `real_probability` 0.45.
*Verificación:* test que compare la etiqueta emitida contra el criterio real
para cada tier y cada deporte (§3.6).

**R6.3 🔇 — El Kelly se queda anclado a probabilidad y explota con underdogs.**
`kellyAmount` (`lib/units.ts:63-81`) tiene piso `Math.max(0.01, …)`: **cualquier
Kelly positivo, por ínfimo que sea, apuesta al menos 1 % del bankroll**. Con la
Fase 6 abriendo la puerta a underdogs de EV pequeño, ese piso convierte
edges marginales en stakes reales. *Qué se observa:* más apuestas, tamaño
uniforme de 1 %, varianza que sube sin que suba el edge medio.

### Fase 7

**R7.1 🔇 — Se construye un segundo mecanismo de observación en paralelo.** Es
el riesgo que el brief nombra. Concretamente: si la Fase 7 añade un
`experiment_mode` que bloquea en la UI pero **no** pasa por
`place_bet_atomic`, la capa que no se puede saltar deja de cubrir el caso
nuevo. *Qué se observa:* un bet registrado desde un script o desde
`/api/bets/from-image/confirm` durante el experimento. *Verificación:* §6.4.

**R7.2 🔇 — Comparar variantes sobre conjuntos distintos.** Ver R4.2. Si
`legacy_model` solo emite cuando pasa sus filtros y `market_only` emite
siempre, cualquier media comparada está sesgada por selección. *Qué se
observa:* `market_only` "gana" en CLV medio simplemente por incluir los juegos
fáciles que legacy descarta.

**R7.3 🔇 — El CLV del experimento hereda H4.** Si `odds_at_bet` sigue siendo
una copia de `picks.odds_decimal` (`…observation_only.sql:97,103`), el CLV de
las tres variantes se mide contra un precio que el propio pipeline reescribió
(`lib/pickGen.ts:1834-1859`). *Qué se observa:* CLV medio pegado a la brecha de
captura (−0.985 pp) en las tres variantes por igual, y la conclusión "ninguna
variante genera CLV" será un artefacto de instrumentación.

**R7.4 🔇 — `fetchEspnClosingLine` falla y el fallback produce CLV exactamente
0.** `app/api/cron/analyze/route.ts:840` y `app/api/check-results/route.ts:176-177`:
si no hay cierre, `oddsAtClose = oddsAtBet` → `clv = 0`, indistinguible de una
línea que no se movió. Peor: la URL en `lib/espn.ts:797` usa
`competitions/${eventId}` (el *event* id como *competition* id), mientras
`fetchCoreOdds` (`lib/espn.ts:199`) usa correctamente `comp.id`. Coinciden en
la mayoría de ligas de ESPN, no por contrato. Si divergen, el fetch devuelve
`null` **para todos los bets de esa liga** y el CLV de la liga entera es 0
silencioso. *Verificación:* el `source` ya se calcula
(`app/api/cron/analyze/route.ts:832,837`) pero **solo se loguea** (`:849`) —
persistirlo es la deuda #4, y es prerrequisito de la Fase 7, no un extra.

### Fase 8

**R8.1 🔇 — Sellar criterios contra métricas que no existen.** No hay Brier ni
log loss en el repo: `app/api/cron/calibrate/route.ts:137-138` solo agrega
`clv`. Sellar "Brier no peor que market_only" antes de implementarlo deja el
criterio sin evaluador y se cumplirá por vacío. *Verificación:* la tabla de
criterios debe referirse a métricas con implementación y test propios.

**R8.2 🔇 — Calibración isotónica por inercia.** El documento avisa (n<2000
empeora el modelo). El riesgo es que alguien la implemente porque es la
opción por defecto de `sklearn` y equivalentes. *Qué se observa:* calibración
que mejora en el histórico de entrenamiento y empeora fuera. *Mitigación:*
prohibirlo en el propio archivo de configuración, con el comentario y la cita.

**R8.3 🔇 — Reoptimizar tras ver resultados.** Riesgo de proceso, no de código.
*Mitigación estructural:* `activation_criteria` con `sealed_at` y
`experiment_version`; cambiar un valor obliga a insertar una fila nueva, nunca
a hacer `UPDATE`. Constraint de base de datos, no disciplina.

### Transversal a todas las fases

**RX.1 🔇 — `supabase db push` arrastra migraciones a medio cocinar.**
Verificado en el contexto compartido. Detalle y mitigación en §4.

**RX.2 🔇 — Comentarios que mienten y se toman por especificación.** Ya hay dos
en el repo, ambos verificados:
- `app/api/cron/analyze/route.ts:331` y `lib/pickGen.ts:246` dicen que el umbral
  de edge es **2 %**. El código dice **5 %** (`lib/pickGen.ts:942`).
- `lib/healthChecks.ts:190-196` afirma que la pretemporada NFL "está excluida
  del pipeline por `ALLOWED_SEASON_TYPES`". `b833d98` la volvió a admitir
  (`lib/espn.ts:171-173`: `NFL: [1, 2, 3]`). Consecuencia real y viva: la NFL
  se considera off-season hasta el 9 de septiembre
  (`lib/healthChecks.ts:199`), así que **durante toda la ventana de
  observación de pretemporada los checks de predictor NFL quedan excluidos del
  conteo de errores**. El health check está ciego exactamente cuando el
  mecanismo que se quiere observar está corriendo.

**RX.3 🔇 — La independencia de los parlays.** `lib/pickGen.ts:1269`:
`realProb = Π legs`. Asume independencia entre partidos del mismo día. No es
una fase del documento, pero cualquier métrica de calibración de la Fase 8 que
incluya parlays medirá ese supuesto y no el modelo.

---

## 3. PLAN DE TESTS

**Punto de partida: cero tests.** `package.json:5-10` tiene `dev`, `build`,
`start`, `lint`. Nada más. Los workflows verdes (`.github/workflows/
calibrate.yml`, `heartbeat.yml`) son `curl` con `Authorization: Bearer`, no
pruebas.

### 3.0 Runner y ubicación

**Propuesta: Vitest.** Razones concretas para este repo, no genéricas:
- `tsconfig.json:9` usa `"moduleResolution": "bundler"` y `:20-22` el alias
  `@/*`. Vitest lo resuelve leyendo el `tsconfig` vía `vite-tsconfig-paths`;
  con `node --test` habría que duplicar el mapeo a mano.
- El código bajo prueba es TypeScript con `import type` y `satisfies`; Vitest
  lo transpila sin pipeline adicional.
- No se necesita entorno de navegador para la lógica financiera: `environment:
  'node'` basta. Los componentes (`components/*.tsx`) quedan fuera de alcance
  en esta primera tanda.

```
tests/
  unit/
    devig.test.ts            ← Fase 2, máxima prioridad
    edge.test.ts
    units.tiers.test.ts
    units.kelly.test.ts
    betEval.pickedSide.test.ts
    espn.seasonTypes.test.ts
    prompts.sanitize.test.ts
  integration/
    pickGen.mapping.test.ts  ← con fixtures, sin red
  fixtures/
    espn-odds-mlb.json
    pinnacle-markets.json
    claude-response.json
```

```json
"scripts": {
  "test": "vitest run",
  "test:watch": "vitest",
  "typecheck": "tsc --noEmit",
  "verify": "pnpm typecheck && pnpm test && pnpm build"
}
```

`pnpm verify` codifica la regla del documento —`tsc --noEmit`, tests y
`next build`, los tres— en un solo comando, para que "declarar listo" no
dependa de que alguien recuerde los tres pasos.

Devdeps: `vitest`, `vite-tsconfig-paths`. Nada más; no hace falta jsdom.

### 3.1 Eliminación de vig (PRIORIDAD 1)

Contra `lib/devig.ts` (Fase 2). Casos:

1. **Simétrico exacto.** `home = away = 1.9091` → overround 1.0476 → ambos
   0.5000. Cualquier desviación revela un error de redondeo en la
   normalización.
2. **Asimétrico conocido.** `home = 1.5556` (−180), `away = 2.5000` (+150) →
   `q = 0.6429 / 0.4000`, suma 1.0429 → `p_home = 0.6164`, `p_away = 0.3836`.
   Suma exacta 1.
3. **Overround del proyecto.** Par que dé 1.0480 (el medido al abrir) y 1.0484
   (al cerrar). Comprueba que el de-vig **no** cambia el resultado entre abrir
   y cerrar — es la hipótesis muerta #1 del contexto, y conviene tenerla
   clavada como test para que nadie la reviva.
4. **Overround extremo alto.** `1.30` (props/ligas menores). Debe rechazarse o
   marcarse `data_quality_flags`, nunca normalizarse en silencio.
5. **Mercado de un solo lado.** `home = 1.80`, `away = null` → debe devolver
   `null` con motivo `one_sided_market`. **No** imputar `1 − p_home`.
6. **Overround < 1** (`home = 2.10`, `away = 2.10`, suma 0.952). Es arbitraje o
   dato corrupto. Rechazo con motivo, no clamp (R2.4).
7. **Momio inválido:** `1.0`, `0`, negativo, `NaN`, `Infinity` → `null`.
8. **Invariante de propiedad:** para todo par válido,
   `|p_home + p_away − 1| < 1e-9`.
9. **Independencia de método:** el mismo par debe dar el mismo resultado
   llamando por `proportional` explícito y por defecto (garantiza que el
   pluggable de power/Shin no cambia el comportamiento base).
10. **Estabilidad frente a `sources_count`:** de-viggear el par de DK debe dar
    lo mismo con 1 o con 5 fuentes más en el pool. Es el test que atrapa H2.

### 3.2 Emparejamiento de eventos y equipos (deuda #7, #11)

Contra `lib/pickGen.ts:841-863` (`gameByMatchup`) y `lib/bet-matching.ts:40-56`.

1. **Match exacto** case-insensitive: `"Boston Red Sox"` vs `"boston red sox"`.
2. **Deporte discordante** (`lib/pickGen.ts:854-863`): mismo matchup, sport
   distinto → descarte con `[SCHEMA_MISMATCH]`.
3. **Serie de 3 juegos, mismo matchup, fechas ±3 días** (deuda #11): tres
   `espn_event_id` distintos con idénticos `home_team`/`away_team`. El match
   por nombres debe ser **insuficiente**: el test afirma que se requiere
   `espn_event_id` o `game_start_time` para desempatar. **Este test debe fallar
   hoy** — es el que documenta el bug vivo.
4. **Doubleheader:** dos eventos el mismo día, mismo matchup, horas distintas.
5. `legsMatch` con `"Yankees vs Red Sox"`, `"Yankees @ Red Sox"`,
   `"Yankees contra Red Sox"` (los tres separadores de
   `lib/bet-matching.ts:42`).

### 3.3 Nombres cortos — el caso "Sox" (deuda #8)

**Localización del código:** `lib/betEval.ts:16-24`. El threshold que el brief
menciona ya no es `>= 4`: hoy es **`>= 3`** en `:23` y `:24`. El cambio arregló
el caso "no encuentra" y **abrió uno peor**: ambigüedad silenciosa.

```ts
const lastWord = (s) => s.toLowerCase().split(/\s+/).pop();
const hw = lastWord(homeName);  // "Chicago White Sox" → "sox"
const aw = lastWord(awayName);  // "Boston Red Sox"    → "sox"
if (hw && hw.length >= 3 && p.includes(hw)) return 'home';  // ← siempre gana
if (aw && aw.length >= 3 && p.includes(aw)) return 'away';  // ← inalcanzable
```

Casos:

1. **`pickedSide('Boston Red Sox ML', null, null, 'Chicago White Sox',
   'Boston Red Sox')` → debe ser `'away'`. Hoy devuelve `'home'`.**
   Fallo silencioso completo: sin excepción, sin log (el `console.warn` de
   `:25` solo salta cuando **no** hay match). Un bet ganado se resuelve como
   perdido y el bankroll se ajusta al revés
   (`app/api/cron/analyze/route.ts:762-764`).
2. El mismo caso **con abreviaturas presentes** (`'chw'`, `'bos'`) → `'away'`
   correcto. Documenta que el bug solo aparece cuando faltan los abbr — y hay
   18 bets resueltos sin `espn_event_id` donde eso es plausible.
3. `"New York Yankees"` vs `"New York Mets"` → `lastWord` distingue bien;
   test de no-regresión.
4. Abreviatura que es subcadena del nombre rival: `homeAbbr = 'no'` (Pelicans)
   contra un pick que contenga "no" en cualquier palabra. `checkAbbr`
   (`lib/betEval.ts:13`) usa `includes` sin límites de palabra.
5. **Mismo caso contra el adaptador legacy** `lib/pickGen.ts:164-166`: verificar
   que la ruta lanza (post-sunset) en vez de invertir la probabilidad (R5.3).
6. `pickedSide` con `pick` vacío o `'—'` (el texto de los marcadores
   `analyzed_no_edge`, `app/api/cron/analyze/route.ts:296`) → `null`, no
   `'home'`.

### 3.4 Temporadas y preseason (deuda #9)

Contra `lib/espn.ts:145-184`.

1. `isObservationOnlySeasonType('NFL', 1)` → `true`.
2. `isObservationOnlySeasonType('NFL', 2)` → `false`.
3. `isObservationOnlySeasonType('MLB', 1)` → `false` (no está en
   `OBSERVATION_SPORTS`, `:145`).
4. `isProcessableSeasonType('NBA', {season:{type:1}})` → `true` — no hay entrada
   en `ALLOWED_SEASON_TYPES` (`:171-173`), y ese es justo el comportamiento que
   mantiene vivos NBA/NHL cuando su scoreboard solo trae pretemporada 2027
   (`lib/espn.ts:166-170`). Es el test que impide que alguien "generalice" el
   filtro y vacíe dos ligas.
5. `season.type` ausente → `true` (`:182`), con el comentario como
   justificación.
6. `eventToGame` con `season.type = 1` en NFL → `observation_only: true`
   (`lib/espn.ts:281-296`).
7. **Regresión de `isLeagueOffSeason`** (`lib/healthChecks.ts:199`): con fecha
   15-ago-2026, NFL debe considerarse **activa** si se están generando picks de
   observación. Hoy devuelve off-season → el test falla y documenta RX.2.

### 3.5 Aritmética de EV — favoritos Y underdogs (simetría)

Contra `lib/edge.ts` y el pipeline de `lib/pickGen.ts:926-1077`.

1. **Favorito:** `p = 0.65`, `odds = 1.60` → `implied = 0.625`,
   `edge = +0.025`, `EV = 0.65 × 1.60 − 1 = +0.04`.
2. **Underdog del documento:** `p = 0.45`, `odds = 2.50` → `implied = 0.40`,
   `edge = +0.05`, `EV = +0.125`. **Test de simetría:** con el pipeline actual
   este pick se descarta en `lib/pickGen.ts:1067-1077`; el test debe afirmar
   que **sobrevive**. Falla hoy, pasa al cerrar la Fase 6. Es el test que
   define la fase.
3. **Simetría estricta:** para todo `(p, odds)`, `edgeOf(p, odds)` y
   `edgeOf(1 − p, odds')` del lado contrario deben producir el mismo veredicto
   de "hay valor" cuando el EV es el mismo. Ninguna rama del código debe
   consultar si `p > 0.5`.
4. **EV vs edge no son lo mismo:** `p = 0.52`, `odds = 1.95` → `edge = +0.0072`,
   `EV = +0.014`. El test fija que el tier lo decide EV, no edge, tras la
   Fase 6.
5. **Kelly con underdog:** `kellyAmount(1000, 0.45, 2.50)` → `b = 1.5`,
   `kelly = (0.675 − 0.55)/1.5 = 0.0833`, half = 0.0417 → 4.2 % del bankroll.
   Verifica que no lo recorta el piso de `Math.max(0.01, …)`
   (`lib/units.ts:78`) ni el techo del 10 %.
6. **Kelly con edge minúsculo:** `kellyAmount(1000, 0.5005, 2.00)` → kelly
   ≈ 0.001, half ≈ 0.0005, pero el piso lo eleva a **0.01** → $10. Test que
   documenta R6.3.
7. **`adjustedEdgeScore`** (`lib/edge.ts:6-9`) multiplica por `√odds`: favorece
   underdogs en el orden. Test de que el orden resultante es el esperado, ya
   que ese score decide qué picks se muestran primero (`lib/pickGen.ts:1187`).

### 3.6 Tiers y etiquetas (no-regresión de `24af709`)

1. Para cada deporte de `SPORT_THRESHOLDS` (`lib/units.ts:24-30`), la etiqueta
   de `tierRange` debe coincidir con el umbral que realmente emite el tier en
   `tierFromProbability`. Test parametrizado sobre las 5 ligas × 3 tiers.
2. `tierFromProbability(0.66, 'MLB', 1.35)` → `'strong'`, no `'lock'`
   (degradación por `odds < 1.40`, `lib/units.ts:45-49`).
3. `tierFromProbability(0.56, 'MLB', 1.35)` → `null`.
4. `computeParlayTier(['lock','value'])` → `'value'` (regla: el tier de un
   parlay es el de su pata más débil, nunca el edge combinado).
5. **Al cerrar Fase 6:** el mismo test parametrizado, pero con la config
   versionada de `lib/config/tiers.v2.ts` como única fuente. Si alguien
   reintroduce un umbral en `lib/units.ts`, el test debe detectar dos fuentes.

### 3.7 Sanitización del prompt (regla no negociable)

Contra `lib/prompts.ts:50-72`.

1. `sanitizeGameForClaude` sobre un `Game` completo → el JSON resultante **no
   contiene** ninguna de: `odds`, `multi_odds`, `odds_comparison`, `dk_odds`,
   `espn_bpi`, `best_ml`, `line_movement`. Aserción sobre el string
   serializado, no sobre las claves de primer nivel — el riesgo es un campo
   anidado.
2. `market_signal` sí está presente y es uno de los 6 valores enumerados
   (`lib/prompts.ts:11-18`).
3. **Test de fuga por campo nuevo:** cualquier clave de `real_data` cuyo nombre
   contenga `odds`, `implied`, `prob` o `line` y que no esté en una allowlist
   explícita → el test falla. Es el guard contra que la Fase 5 añada un campo
   y lo filtre sin querer.

### Orden de implementación

Fase 0 escribe 3.3 y 3.6 (son bugs vivos y no dependen de nada). Fase 2 escribe
3.1 completo antes de tocar `lib/pickGen.ts`. 3.2 y 3.4 en paralelo con
cualquier fase. 3.5 se escribe en Fase 4 (favoritos, verde) y se completa en
Fase 6 (underdogs, rojo→verde). 3.7 antes de tocar `lib/prompts.ts`.

---

## 4. PLAN DE MIGRACIONES

### 4.0 La restricción operativa manda sobre el orden

`supabase db push` aplica **todas** las migraciones pendientes del directorio.
No se puede aplicar una sola. Consecuencia que debe gobernar el proceso: **una
migración a medio escribir en `supabase/migrations/` no es un borrador, es
código en la rampa de despegue.** El siguiente que empuje cualquier cosa la
manda a producción.

**Regla de trabajo propuesta:** las migraciones se redactan en
`.fase0/migrations-draft/` (o en la rama, sin merge) y solo se mueven a
`supabase/migrations/` en el momento de aplicarlas. El directorio real se
mantiene **siempre vacío de pendientes**. Es la única mitigación que no depende
de que nadie se equivoque.

**Regla dura del proyecto, reflejada en cada secuencia de abajo:** migración
PRIMERO, deploy DESPUÉS. Si el código sale antes que la columna, PostgREST
rechaza la columna desconocida y cae el pipeline entero. La migración
`20260727120000` ya lo documenta en su cabecera (`:14-16`) — ese formato es el
precedente a seguir.

### 4.1 Dependencia de W3 (bloqueante, explícita)

W3 está comparando el schema real contra las migraciones. Hay antecedente de
objetos en producción ausentes del repo: tres rondas de
`retroactive_schema_sync` (`20260521000000`, `20260521010000`, `20260521020000`).

**Dónde depende mi plan del resultado de W3:**
- **M1 (Fase 1)** no se redacta hasta tener el inventario. Motivo concreto:
  `add column if not exists` con un tipo distinto al que ya está en producción
  **no falla y no hace nada**; el código nuevo escribiría contra un tipo que no
  espera. Es un fallo silencioso de la clase que este proyecto ya sufrió.
- **M4 (Fase 7)** depende de si `place_bet_atomic` en producción es
  byte-idéntica a `20260727120000_preseason_observation_only.sql:40-121`. Si
  alguien la redefinió fuera de migraciones, el `create or replace` de M4
  **borra ese cambio sin avisar**.
- **M0** no depende de W3: toca solo `settings`, tabla con tres columnas
  (`db/schema.sql:117-124`) y superficie mínima.

### 4.2 Secuencia propuesta

Cada migración se aplica **sola** (directorio vacío antes y después), se
verifica, y solo entonces se despliega el código.

---

**M0 — Kill switch (Fase 0). Reversible.**

```sql
alter table settings add column if not exists kill_switch_reason text;
alter table settings add column if not exists auto_enabled_changed_at timestamptz;
```

Reversión: `alter table settings drop column …`. Sin datos que perder — son
columnas nuevas y nullable.
**Secuencia:** migración → verificar `\d settings` → deploy del gate en
`handle()`.

---

**M1 — Modelo observable (Fase 1). Reversible con pérdida documentada.**

~30 columnas nuevas en `picks`, todas **nullable y sin default**. Que sean
nullable no es un detalle de estilo: es la regla dura del documento — NULL
significa "no existe", nunca `0`.

Reversión: `drop column` de las 30. **Pérdida:** los datos escritos entre
aplicar y revertir se van. Aceptable porque durante la Fase 1 el sistema está
en observación y no hay dinero atado a esas columnas. **Documentar esa razón
en la cabecera de la migración**, no en el commit.

**Secuencia obligatoria:**
1. Migración de columnas.
2. Verificar con `select … limit 1` cada columna nueva (es lo que hace
   `lib/healthChecks.ts:100-118`).
3. Actualizar `checkDbColumns` con las 30 columnas — **antes** del deploy del
   código que las escribe, para que un despliegue incompleto salga en rojo.
4. Deploy del código.

---

**M2 — Placeholders `0` → `NULL` (Fase 1, deuda #6). IRREVERSIBLE.**

```sql
update picks
   set real_probability = null,
       implied_probability = null,
       edge = null,
       tier = null
 where status = 'analyzed_no_edge'
   and real_probability = 0;
```

**No es reversible y la razón es que no hay información que restaurar:** el `0`
nunca fue un dato, era ausencia de dato. Revertir significaría reintroducir la
mentira. La reversión "honesta" no existe.

**Requisito previo — deuda #2, ninguna escritura destructiva sin backup:**
antes de este `update`, `create table picks_backup_20260xxx as select * from
picks where status='analyzed_no_edge'`. La tabla de respaldo se retiene hasta
que la Fase 8 cierre y se elimina en una migración explícita. Sin ese respaldo,
esta migración no se aplica.

**Riesgo de ejecución:** el `where` debe llevar `and real_probability = 0`. Sin
esa condición, borra las probabilidades de picks reales que compartan
`status`. Ejecutar primero el `select count(*)` equivalente y comparar contra
los 188 esperados.

---

**M3 — Unique constraint en `picks` (deuda #3). Reversible; puede FALLAR al
aplicar.**

```sql
create unique index concurrently if not exists picks_event_bettype_uniq
  on picks (espn_event_id, bet_type)
  where is_parlay = false
    and status in ('pending','bet')
    and espn_event_id is not null;
```

Índice **parcial** a propósito: la dedup real que el código implementa es
"un pick vivo por evento y tipo" (`lib/pickGen.ts:1717-1725` filtra por
`espn_event_id` + `bet_type` + `is_parlay=false` + `status in ('pending','bet')`).
Un unique total rompería los históricos resueltos y los marcadores.

**Modo de fallo al aplicar:** si ya hay duplicados en producción, el
`create unique index` **falla** y, con `supabase db push`, arrastra el fallo de
todas las pendientes. *Mitigación obligatoria:* correr antes el `select
espn_event_id, bet_type, count(*) … having count(*) > 1` y limpiar. Con
`concurrently` no bloquea escrituras, pero **no puede ir dentro de una
transacción** — verificar cómo lo envuelve `supabase db push` antes de usarlo;
si lo envuelve, quitar `concurrently` y aceptar el lock breve (la tabla es
pequeña).

Reversión: `drop index picks_event_bettype_uniq`. Limpia.

---

**M4 — `model_variant` y observación de experimento (Fase 7). Reversible con
cuidado.**

```sql
alter table picks add column if not exists model_variant text;
alter table picks add column if not exists experiment_observation boolean not null default true;
```

`experiment_observation` **separada de `observation_only`** por R1.3: si se
reusa la columna de preseason, apagar el experimento desprotege la
pretemporada. `default true` implementa "todo el sistema nuevo arranca en
observación" a nivel de schema, no de código — el default es el que aguanta si
alguien olvida setearlo.

Requiere además `create or replace function place_bet_atomic(...)` añadiendo el
guard de `experiment_observation`. **Depende de W3** (§4.1). El cuerpo debe
partir del texto de `20260727120000_preseason_observation_only.sql:40-121` y
añadir **solo** el guard nuevo, siguiendo el precedente que ese archivo
documenta en `:37-38`.

Reversión: `drop column` + `create or replace` con el cuerpo anterior.
**El script de reversión de la función se escribe y se guarda junto con la
migración**, no se reconstruye después.

---

**M5 — Fuente y timestamp del cierre (deuda #4, Fase 7). Reversible.**

```sql
alter table bets add column if not exists odds_at_close_source text;
alter table bets add column if not exists odds_at_close_book text;
alter table bets add column if not exists odds_at_close_fetched_at timestamptz;
```

Los valores ya se calculan y se tiran: `app/api/cron/analyze/route.ts:832,837`
(`'espn_close'` / `'fallback_no_data'`) solo llegan al `console.log` de `:849`.
Requiere extender `resolve_bet_atomic` (`20260512050001_atomic_resolve_bet.sql`)
con tres parámetros. **Añadir parámetros con default a una función PL/pgSQL
crea una sobrecarga**, no reemplaza: si la firma vieja sobrevive, las llamadas
existentes (`app/api/cron/analyze/route.ts:863`,
`app/api/check-results/route.ts:198`, `app/api/bets/[id]/route.ts:79`) siguen
resolviendo a la vieja y las columnas quedan NULL para siempre, en silencio.
**La migración debe `drop function` de la firma anterior explícitamente.**

Reversión: restaurar la firma vieja; las columnas nuevas quedan huérfanas pero
inertes.

---

**M6 — Criterios de activación sellados (Fase 8). Reversible.**

Tabla nueva `activation_criteria` con `experiment_version`, `sealed_at`,
`criterion_key`, `threshold_value`, y `constraint` que impida `UPDATE` de una
fila sellada (trigger `before update` que lanza si `sealed_at is not null`).
Cambiar un criterio obliga a una fila nueva con versión nueva (R8.3). Reversión:
`drop table`.

### 4.3 Orden global y qué NO se junta nunca

```
M0 ──► M1 ──► M2 ──► M3 ──► M4 ──► M5 ──► M6
(F0)    (F1)   (F1)   (F1)   (F7)   (F7)   (F8)
```

- **M2 nunca en el mismo push que M1.** M2 es un `update` masivo; M1 es DDL. Si
  M1 falla a medias y M2 corre, el `update` toca una tabla en estado
  intermedio.
- **M3 nunca en el mismo push que nada.** Es la única que puede fallar por
  datos preexistentes y arrastraría a las demás.
- **M4 y M5 nunca juntas.** Ambas hacen `create or replace function`. Si una
  falla, el estado de las funciones queda mixto y ninguna de las dos es
  obviamente responsable.

---

## 5. CRITERIOS DE ACEPTACIÓN POR FASE

Cada uno con el comando, la query o la observación que lo demuestra.

### Fase 0

- **Kill switch real.** Con `update settings set auto_enabled = false where id=1`:
  `POST /api/cron/analyze` devuelve 200 con `analyze.message = 'auto_disabled'`
  **y** `results` y `orphansCleaned` no ejecutados. Verificación:
  `select max(updated_at) from picks` y `select count(*) from bets where
  result <> 'pending'` idénticos antes y después de tres corridas del cron.
- **Rutas cerradas.** `curl -X POST $APP_URL/api/check-results` sin
  `Authorization` → **401**. Igual para `/api/generate-picks`. Hoy ambas
  responden 200.
- **Runner vivo.** `pnpm verify` sale 0 en local y en CI, con al menos los
  tests de §3.3 y §3.6 presentes.
- **El test de "Sox" falla antes del fix y pasa después.** Es la prueba de que
  el test mide algo.

### Fase 1

- `select count(*) from picks where status='analyzed_no_edge' and
  real_probability = 0` → **0**.
- `select count(*) from picks where status='analyzed_no_edge' and tier is not
  null` → **0**.
- `GET /api/health/full` en verde **con** las 30 columnas nuevas listadas en
  `checkDbColumns`. Probar además el caso negativo: quitar una columna del
  `select` de una copia y confirmar que el check se pone rojo.
- Una corrida de cron produce al menos una fila con
  `implied_probability_no_vig is not null` y `fetched_at is not null`.
- `pnpm verify` verde.

### Fase 2

- `pnpm test tests/unit/devig.test.ts` — los 10 casos de §3.1 en verde,
  incluidos el de un solo lado y el de overround < 1.
- **Invariante en producción:** `select count(*) from picks where
  abs(no_vig_home + no_vig_away - 1) > 1e-9` → **0**.
- **Sesgo eliminado, medido:** sobre los picks de una semana,
  `avg(implied_probability_raw − implied_probability_no_vig)` debe estar en
  torno a la mitad del overround medio (≈ +2.4pp con 1.048), y la **desviación
  estándar de esa diferencia agrupada por `sources_count`** debe caer respecto
  a la del histórico. Es la verificación directa de H2.
- Un mercado de un solo lado en producción produce una fila con
  `rejection_reason = 'one_sided_market'`, no un pick.

### Fase 3

- `select sharp_sources_count, count(*) from picks where picks_generated_at >
  now() - interval '7 days' group by 1` — **cero filas con `sharp_sources_count
  < 3`** en MLB/NBA/NFL, y `< 2` en NHL (la excepción documentada).
- Todo pick rechazado por fuentes insuficientes tiene `rejection_reason`
  poblado y **existe como fila**. Verificación: el número de juegos analizados
  del log (`[AUDIT][cron] in-window games`) debe igualar el número de filas
  nuevas de `picks` para esa corrida.
- Los pesos usados están en `lib/config/consensusWeights.ts` con un
  `version` que aparece persistido en cada fila
  (`sharp_consensus_method`). `grep -rn "0\.\d" lib/sharpConsensus.ts` no
  devuelve pesos hardcodeados.

### Fase 4

- **Una fila `market_only` por juego analizado.** `select model_variant,
  count(*) from picks where picks_generated_at::date = current_date group by 1`
  → los conteos de `market_only` y `market_plus_claude` coinciden.
- `market_only` no invoca a Claude: la corrida con solo esa variante deja
  `cron_runs.anthropic_status = 'skipped'`.
- La comparación es pareada: cada `espn_event_id` con `market_only` tiene su
  contraparte de las otras variantes, o un `rejection_reason` explícito.
- **Precondición de aceptación:** la decisión de §8.2 sobre contra qué casa se
  mide está tomada y escrita en la cabecera de `lib/variants/marketOnly.ts`.

### Fase 5

- **Los caps se aplican y se cuentan.** `select count(*) from picks where
  cap_applied = true and picks_generated_at > now() - interval '7 days'` →
  número finito y con histograma **sin** acumulación anómala en el valor exacto
  del cap (R5.1). Y `select count(*) from picks where model_variant =
  'market_plus_claude' and adjusted_probability > cap_value` → **0**, que es lo
  que hoy falla (72 de 166).
- **El prompt no ve momios:** `pnpm test tests/unit/prompts.sanitize.test.ts`
  verde, incluido el test de fuga por campo nuevo (§3.7 caso 3).
- Todo ajuste residual persistido cita una clave que existe en `real_data`.
  Verificación: `select count(*) from picks where hallucinated_adjustments > 0`
  es una métrica reportada, no cero por no medirse.
- El dampening viejo (`lib/pickGen.ts:1028-1045`) **está eliminado**, no
  coexistiendo: `grep -n "MAX_DEVIATION_PP" lib/` sin resultados.

### Fase 6

- **El underdog canónico sobrevive.** Test de §3.5 caso 2 en verde: `p=0.45`,
  `odds=2.50` produce un pick con tier ≥ VALUE.
- **Ninguna rama consulta la probabilidad absoluta para decidir tier:**
  `grep -n "real_probability >= \|prob >= 0\.\|>= t.value" lib/` no devuelve
  nada en la ruta de tier.
- **Fuente única de umbrales:** `grep -rn "0\.55\|0\.60\|0\.65\|0\.68" lib/
  --include=*.ts` solo devuelve `lib/config/tiers.v2.ts`.
- Test parametrizado de etiquetas (§3.6 caso 1) verde para 5 ligas × 3 tiers.
- **Distribución antes y después:** proporción de picks con `odds_decimal > 2.0`
  medida sobre una semana, comparada contra la línea base actual. Debe subir.
  Si no sube, algún otro filtro sobrevivió (R6.1) — revisar `lib/pickGen.ts:1171`
  y `lib/units.ts:45-49`.

### Fase 7

- **El sistema arranca cerrado:** `select count(*) from picks where
  experiment_observation = false` → **0** al terminar la fase.
- **La capa no evitable funciona:** llamada directa a `place_bet_atomic` con un
  `pick_id` de experimento → excepción. Verificación en psql, no vía la ruta —
  la gracia es probar el camino que salta las rutas.
- Las tres variantes producen filas el mismo día para los mismos
  `espn_event_id`.
- `GET /api/experiments/compare` devuelve, por variante: n candidatos, CLV
  medio y mediana, % CLV positivo, Brier, log loss, ROI hipotético, y los
  desgloses por deporte, favorito/underdog, rango de momio y ventana pregame.
- **CLV instrumentado de verdad:** `select count(*) from bets where
  odds_at_close_source is null and result <> 'pending'` → 0, y
  `select odds_at_close_source, count(*) from bets group by 1` distingue
  `espn_close` de `fallback_no_data`. Hoy las 5 filas con
  `odds_at_close = odds_at_bet` son indistinguibles de una línea inmóvil.

### Fase 8

- Existe `activation_criteria` con al menos una fila `sealed_at is not null`, y
  un `update` sobre ella **lanza**. Verificación directa en psql.
- Brier y log loss tienen implementación **y test con valores conocidos**
  (Brier de una predicción de 0.7 que acierta = 0.09).
- `grep -rn "isotonic" lib/` → sin resultados, y el archivo de configuración
  contiene la prohibición explícita con la cita (Niculescu-Mizil & Caruana).
- El informe de activación se genera sin que nadie ajuste un umbral después de
  verlo. Verificación: `sealed_at` de todas las filas es anterior a la primera
  fila de resultados del experimento.

---

## 6. REUSO DEL MECANISMO DE OBSERVACIÓN (FASE 7)

### 6.1 Qué existe hoy, exactamente

**Origen y alcance.** Commit `b833d98`, "feat(nfl): preseason observation mode".
El propio mensaje declara el bloqueo en cuatro capas y la exclusión de
agregados en seis puntos.

**Flag persistente.**
- `supabase/migrations/20260727120000_preseason_observation_only.sql:18-19` —
  `picks.observation_only boolean not null default false`. NOT NULL con default
  a propósito (`:10-12`): nunca "desconocido".
- Índice parcial: `:27-29`.
- Reflejado en `db/schema.sql:48-51` y el índice en `:55-56`.

**Origen del valor.**
- `lib/espn.ts:129` — `OBSERVATION_SEASON_TYPE = 1`.
- `lib/espn.ts:145` — `OBSERVATION_SPORTS = new Set(['NFL'])`.
- `lib/espn.ts:147-153` — `isObservationOnlySeasonType`.
- `lib/espn.ts:281` — se calcula en `eventToGame`; `:296` se escribe en el
  `Game`; `:282-290` loguea `[PRESEASON_OBSERVATION]`.
- `lib/pickGen.ts:914` y `:1159` — se propaga al `MappedRow`.
- `lib/pickGen.ts:1382`, `:1447`, `:1548` — al `PickRow` que se inserta.
- `app/api/cron/analyze/route.ts:309` y `:363` — también en los marcadores
  `analyzed_no_edge`, vía el mapa de `:262-266`.

### 6.2 Las cuatro capas de bloqueo, con línea

| # | Capa | Ubicación | Comportamiento |
|---|---|---|---|
| 1 | UI | `components/PickCard.tsx:27` (`observationOnly`), comentario en `:24-26` | Render read-only: sin botón APOSTAR, sin input de stake |
| 2 | Ruta de alta | `app/api/bets/route.ts:62-78` | 422 + `code: 'observation_only_pick'` + `console.error` con contexto |
| 3 | Ruta de confirmación por imagen | `app/api/bets/from-image/confirm/route.ts:151-190` | Rechaza el **ticket completo** antes de cualquier write (`:151`) |
| 4 | **RPC — la que no se puede saltar** | `…observation_only.sql:69-73`, dentro de `place_bet_atomic` | `raise exception 'observation_only_pick:%'`, errcode `22023`, **antes** de tocar bankroll o `bets` |

El manejo del error de la capa 4 en la ruta está en `app/api/bets/route.ts:117-131`
— y su comentario (`:118-119`) dice explícitamente que llegar ahí significa que
algo saltó el guard de la ruta.

**Exclusión de agregados** (los 6 puntos del commit):
- `lib/pickGen.ts:1804-1810` — se salta `recordPickFactors`, que corta la
  cadena `pick_factors → factor_performance → system_weights → prompt`.
- `lib/pickGen.ts:1248` — excluido de candidatos a parlay.
- `app/api/cron/heartbeat/route.ts:29`, `:52`, `:72` — tres bloques.
- `app/api/pending-picks/route.ts:27` — `.eq('observation_only', false)`.

**Presentación:**
- `lib/telegram.ts:331-332` separa observación de apostables; `:334-341` cambia
  el encabezado entero cuando la jornada es toda de pretemporada, para que no
  haya una línea de "N picks listos" que se lea como accionable.

**Payload al modelo:**
- `lib/pickGen.ts:514-531` — inyecta `data_availability` con
  `standings_available`, nota y guía. Diseñado para no rellenar con ceros
  (referencia explícita a `bdb6fc1`).

**Salud:**
- `lib/healthChecks.ts:118` — `observation_only` está en `checkDbColumns`
  precisamente para que un deploy sin migración salga rojo en vez de morir con
  un error críptico de cron.

**Emparejamiento:**
- `lib/bet-matching.ts:64-67` — selecciona la columna **sin filtrar**, a
  propósito: así el rechazo del ticket puede nombrar el pick.

### 6.3 Qué hay que EXTENDER

**(A) `model_variant` — no existe. Hay que crearlo entero.**
`grep` de `model_variant` en el repo: cero resultados. Requiere:
- Columna (M4) + índice.
- Un discriminador en `analyzeGames` (`lib/pickGen.ts`) que produzca las tres
  filas por juego. Hoy `analyzeGames` tiene una única ruta y devuelve un único
  conjunto (`lib/pickGen.ts:841-1187`).
- Propagación por los tres constructores de fila: `:1382` (singles), `:1447`,
  `:1548`.
- El dedup de lock-in (`lib/pickGen.ts:1717-1723`) filtra por `espn_event_id` +
  `bet_type` + `is_parlay` **sin** `model_variant`. **Sin añadirlo, la segunda
  variante del mismo juego se interpreta como re-análisis de la primera y la
  sobrescribe** (`:1832-1859`). Es el punto de integración más peligroso de
  toda la Fase 7: falla en silencio y produce exactamente una variante donde
  debería haber tres. Mismo cambio hace falta en el unique index M3.

**(B) Arranque global en `observation_only = true`.**
Hoy el flag se deriva del deporte y el `season.type` (`lib/espn.ts:147-153`).
No hay interruptor global. Se necesita `experiment_observation` (columna
separada, R1.3) con `default true`, más un guard adicional en
`place_bet_atomic` que rechace por cualquiera de los dos motivos.
**Lo que NO hay que hacer:** ampliar `OBSERVATION_SPORTS` a todos los deportes
para simular el modo global. Colisionaría con `ALLOWED_SEASON_TYPES`
(`lib/espn.ts:171-173`), que solo tiene entrada para NFL, y el comentario de
`:166-170` explica por qué generalizarlo vacía NBA y NHL.

**(C) Las tres variantes en la presentación.**
`lib/telegram.ts:331-332` particiona en dos grupos. Con tres variantes en
observación, el mensaje necesita otra dimensión, o el usuario ve el mismo
partido tres veces sin saber por qué.

**(D) Vista comparativa.**
No existe nada parecido. `app/api/cron/calibrate/route.ts:137-138` solo agrega
`clv`. Brier, log loss y calibración hay que escribirlos.

**(E) `rejection_reason` para candidatos rechazados.**
La Fase 7 exige "guardar candidatos aceptados y rechazados con motivo". Hoy los
motivos existen **solo como logs**: `[NO_DK_ODDS]` (`lib/pickGen.ts:897`),
`[NO_POSITIVE_EDGE]` (`:944`), `[EDGE_BELOW_THRESHOLD]` (`:965`),
`[TIER_NULL_FILTERED]` (`:1069`), `[AUDIT] DISCARD` (`:1173`), y el resumen de
`reasons` en `:1189`. Todo eso se pierde al rotar los logs de Vercel. Hay que
persistirlo.

### 6.4 Qué NO hay que tocar

Lo siguiente ya es agnóstico de deporte y de variante. Tocarlo es riesgo puro
sin beneficio:

- **`place_bet_atomic` más allá del guard.** El cuerpo es byte-idéntico a
  `20260512050000_atomic_place_bet.sql` salvo el guard, y esa propiedad está
  documentada en `…observation_only.sql:37-38`. Mantenerla: añadir **solo** la
  condición nueva.
- **La estructura de cuatro capas.** Está bien puesta: falla ruidosa en cada
  una y una capa final que no se puede saltar. La Fase 7 añade un motivo de
  rechazo, no una arquitectura.
- **`lib/telegram.ts:331-332`** como mecanismo de partición — se extiende, no se
  reescribe.
- **`lib/bet-matching.ts:64-67`** — el "no filtrar aquí a propósito" es
  correcto y su comentario lo explica.
- **`lib/pickGen.ts:514-531`** (`data_availability`) — es agnóstico y la lógica
  de "no rellenar con ceros" es la correcta; se reusa tal cual para cualquier
  deporte que entre en observación.
- **`lib/healthChecks.ts:118`** — el patrón es correcto; solo se le añaden las
  columnas nuevas.
- **`OBSERVATION_SPORTS` como set** (`lib/espn.ts:145`) — la decisión de dejarlo
  en NFL está razonada en `:137-143` y `:166-170`. La Fase 7 no la necesita
  para nada: usa el interruptor global, no este set.

---

## 7. DEUDA TÉCNICA — LOS 12 PUNTOS, CON PRIORIDAD JUSTIFICADA

Prioridad no como etiqueta sino como razón: **qué pasa si no se hace antes de
la fase asignada.**

### 7.1 Punto 1 — Kill switch. **P0. Fase 0. Es el más grave y es peor de lo inventariado.**

**Verificado línea por línea:**
- `app/api/cron/analyze/route.ts:146` — `if (settings.auto_enabled === false)`
  hace `return` **dentro de `runAnalyzeWindow()`**, que empieza en `:128`.
- `handle()` empieza en `:1017`. Llama `runAnalyzeWindow()` en `:1029`,
  `runResultsCheck()` en `:1036` y `cleanupOrphanedPicks()` en `:1043`, **cada
  una en su propio `try`**.
- `runResultsCheck()` (`:730-928`) **no lee `settings`**. Su única fuente es
  `select * from bets where result='pending' and espn_event_id is not null`
  (`:733-737`). Llama `resolve_bet_atomic` en `:792` (push) y `:863`
  (win/loss): escribe `bets`, mueve bankroll e inserta en `bankroll_log`.
- `cleanupOrphanedPicks()` (`:968-991`) hace
  `update picks set status='skipped'` (`:1000-1003`) sin consultar el flag.
- `grep -rn auto_enabled` en todo el repo: 10 apariciones, **una sola** es un
  gate de comportamiento (`:146`). Las demás son schema (`db/schema.sql:122`),
  tipos (`lib/types.ts:142`) y UI (`app/(tabs)/home/page.tsx:33`,
  `app/api/settings/route.ts:10,26`, `components/AutoSportsSettings.tsx:41`).

**Y además (H5):** `/api/check-results` (`app/api/check-results/route.ts:43`)
y `/api/generate-picks` (`app/api/generate-picks/route.ts:43`) exportan `POST`
**sin `authOk` y sin `CRON_SECRET`** — comparar con
`app/api/cron/calibrate/route.ts:36-45` y `app/api/cron/heartbeat/route.ts:10-14,
314`, que sí lo tienen. `/api/check-results` resuelve bets y mueve bankroll
(`:198-207`). `/api/generate-picks` llama `analyzeGames` directo.

**Por qué P0 y no P1:** la Fase 1 y la Fase 2 implican migraciones sobre
`picks` y un `update` masivo (M2). Todas esas operaciones corren hoy con el
cron vivo escribiendo la misma tabla, y cortar `CRON_SECRET` **no apaga las dos
rutas públicas**. El punto 2 de la deuda ("ninguna escritura destructiva sin
backup") es inaplicable mientras el sistema no se pueda detener: un backup
tomado mientras el cron escribe no es un punto consistente.

**Fix propuesto, con precisión:**

1. Extraer la lectura de `settings` a una función `readSettings()` al inicio de
   `handle()` (`app/api/cron/analyze/route.ts:1017`).
2. Envolver las tres llamadas — `:1029`, `:1036`, `:1043` — en un único
   `if (settings.auto_enabled !== false) { … }`, y devolver
   `{ message: 'auto_disabled' }` en el nivel del handler.
3. Dejar `runAnalyzeWindow` tal cual: el `return` de `:146` pasa a ser
   defensa en profundidad, no el único gate.
4. Añadir `authOk` a `app/api/check-results/route.ts:43` y
   `app/api/generate-picks/route.ts:43`, copiando el patrón de
   `app/api/cron/heartbeat/route.ts:10-14`.
5. Añadir el mismo gate de `auto_enabled` a esas dos rutas: un `POST`
   autenticado tampoco debe escribir con el switch en `false`.
6. `settings.kill_switch_reason` (M0) para que quede registrado **quién y por
   qué** apagó, en vez de un booleano mudo.

**Criterio de aceptación:** ver §5, Fase 0.

### 7.2 Punto 2 — Ninguna escritura destructiva sin backup. **P0. Fase 0-1.**

**Justificación:** M2 es un `update` de 188 filas que no es reversible (§4.2).
Sin backup previo no hay vuelta atrás de ningún tipo. Es prerrequisito
**bloqueante** de M2, no una buena práctica. Y depende del punto 1: el backup
debe tomarse con el sistema detenido.

### 7.3 Punto 6 — Placeholders → NULL. **P0. Fase 1.**

**Justificación:** es una regla dura explícita del documento ("nunca almacenar
0 como placeholder"). Pero la razón de prioridad es otra: la Fase 8 se decide
por Brier score, y 188 filas con `real_probability = 0` que en realidad
significan "no hubo predicción" envenenan cualquier métrica de calibración que
se calcule sobre el histórico. Si se hace después de la Fase 8, la métrica que
decide activar dinero real se calculó sobre datos contaminados.
`app/api/cron/analyze/route.ts:300-302`, `:354-356`.

### 7.4 Punto 5 — Diagnóstico de `odds_at_bet`. **P0 → RESUELTO EN ESTA ENTREGA. Fase 0.**

**Ya no es un diagnóstico pendiente, es un fix pendiente.** H4: `odds_at_bet`
es una copia literal de `p_odds_decimal`
(`…observation_only.sql:97,103`) ← `app/api/bets/route.ts:98` ←
`components/PickCard.tsx:94` ← `picks.odds_decimal`, que
`lib/pickGen.ts:1834-1859` reescribe en cada re-análisis. **No hay ningún
trigger ni objeto fuera de migraciones que buscar.**

**Por qué P0:** el criterio de decisión de toda la Fase 8 es el CLV, y el CLV
se calcula con `odds_at_bet` (`app/api/cron/analyze/route.ts:829,841`). Medir
CLV contra un precio que el propio pipeline reescribió es exactamente la
circularidad que el contexto compartido ya identificó. Cada día que pase sin el
fix añade filas con CLV no interpretable.

**Fix:** `place_bet_atomic` debe guardar en `odds_at_bet` el precio congelado —
`picks.original_odds`, escrito en `lib/pickGen.ts:1781` en el primer análisis y
nunca tocado después (la lista de campos refrescados de `:1834-1855` **no** lo
incluye) — o capturar el momio en vivo en el momento del insert. Lo que no
puede seguir siendo es un parámetro que el cliente elige.

**Sigue pendiente de W1** confirmar con datos que la brecha de −0.985 pp
coincide con las re-escrituras registradas en `reanalysis_count`. Mi entrega da
el mecanismo; W1 da la magnitud.

### 7.5 Punto 4 — Persistir la fuente de `odds_at_close`. **P1. Fase 7 (prerrequisito).**

**Justificación:** el valor **ya se calcula** y se tira.
`app/api/cron/analyze/route.ts:832` inicializa `source = 'fallback_no_data'`,
`:837` lo pone en `'espn_close'`, `:849` lo loguea — y el
`resolve_bet_atomic` de `:863-871` no tiene parámetro donde ponerlo. Lo mismo en
`app/api/check-results/route.ts:154,167,177`. Coste casi nulo, valor alto: hoy
5 de 44 filas con `odds_at_close == odds_at_bet` son indistinguibles entre
"línea inmóvil" y "fetch falló" (`:840`). Sin esto, el criterio de activación
de la Fase 8 se calcula sobre un CLV con 11 % de filas de calidad desconocida.
Migración M5.

### 7.6 Punto 8 — Tests de nombres cortos. **P1. Fase 0.**

**Justificación:** `lib/betEval.ts:23-24` tiene un fallo **silencioso vivo hoy**
(§3.3): con "Chicago White Sox" vs "Boston Red Sox" y sin abreviaturas,
`pickedSide` devuelve siempre `'home'`. La consecuencia no es un pick raro: es
un bet resuelto al revés y un ajuste de bankroll invertido
(`app/api/cron/analyze/route.ts:762-764`). Más alto que los otros tests porque
el bug ya está en producción y el `console.warn` de `:25` **no** salta en este
caso — solo cuando no hay match ninguno.

### 7.7 Punto 11 — Eventos de la misma serie mal enlazados. **P1. Fase 2.**

**Justificación:** 46 de 50 bets auditables son mis-enlazables en principio y
hay un caso confirmado (09-jun). Va en Fase 2 y no después porque la capa de
de-vig debe "rechazar pares con timestamps o eventos incompatibles" — el mismo
mecanismo de validación sirve para las dos cosas, y hacerlo dos veces por
separado es garantizar que divergen. El vector concreto en el código es el
caché de Pinnacle por `pinnacle_matchup_id` (`lib/pinnacle.ts:181-197`) con TTL.

### 7.8 Punto 3 — Constraints contra picks duplicados. **P1. Fase 1.**

**Justificación:** `db/schema.sql:54-60` tiene 5 índices, ninguno único; la
protección es read-then-write en `lib/pickGen.ts:1717-1725`. Sube a P1 por la
Fase 7: al introducir tres variantes, ese dedup en código pasa de "suficiente"
a "activamente destructivo" (§6.3.A) — sin `model_variant` en la clave, la
segunda variante sobrescribe a la primera. Aplicar M3 **antes** de la Fase 7
obliga a resolver el diseño de la clave cuando todavía es barato.

### 7.9 Punto 7 — Tests de emparejamiento. **P1. Continuo, arranca en Fase 0.**

**Justificación:** el emparejamiento es la entrada de todo (`lib/pickGen.ts:843`).
Un fallo aquí no produce un pick malo: produce **ningún** pick, con un
`[SCHEMA_MISMATCH]` en logs que nadie lee, o el pick del partido equivocado
(punto 11). Los tests son baratos y no dependen de ninguna fase.

### 7.10 Punto 9 — Tests de temporadas y preseason. **P1. Fase 0.**

**Justificación:** sube a P1 por RX.2. `lib/healthChecks.ts:190-196` ya afirma
algo que `b833d98` invalidó, y la consecuencia (`:199`) es que **la NFL se
considera off-season durante toda la ventana de observación de pretemporada**,
que es justo cuando se quiere vigilar. El mecanismo que la Fase 7 va a reusar
está siendo observado por un health check ciego. El test de §3.4 caso 7 lo
expone.

### 7.11 Punto 12 — Logs estructurados con IDs de fuente y timestamps. **P2, pero se adelanta a Fase 1.**

**Justificación:** los logs existen y son buenos —`[AUDIT]`, `[CLV_COMPUTED]`,
`[PROB_DAMPENED]`, `[TIER_NULL_FILTERED]`— pero son `console.log` en Vercel: se
rotan. Toda la información de por qué **no** se emitió un pick vive ahí y solo
ahí (§6.3.E). La Fase 7 exige persistir candidatos rechazados con motivo, así
que el trabajo hay que hacerlo igual; hacerlo en Fase 1, cuando ya se está
tocando el modelo de datos, cuesta una columna más y no un refactor aparte.

### 7.12 Punto 10 — Manejo explícito de fallos de Telegram. **P2. Continuo.**

**Justificación:** el retry con backoff **ya existe** (`lib/telegram.ts:36-75`:
reintentos, respeto de `retry_after` en 429, 4xx tratados como permanentes).
Lo que falta son los call sites que descartan la promesa: `lib/claude.ts:75`
y `:91`, `app/api/health/full/route.ts:138`. P2 y no más alto porque el modo de
fallo es "el usuario no se entera de algo", no corrupción de datos — pero es
real: `lib/claude.ts:75` es precisamente la alerta de que Claude falló, y es la
que se pierde en silencio.

### Resumen de prioridades

| # | Deuda | Prioridad | Fase |
|---|---|---|---|
| 1 | Kill switch | **P0** | 0 |
| 2 | Backup antes de escritura destructiva | **P0** | 0-1 |
| 6 | Placeholders → NULL | **P0** | 1 |
| 5 | `odds_at_bet` (diagnosticado → fix) | **P0** | 0 |
| 4 | Fuente de `odds_at_close` | P1 | 7 (prereq) |
| 8 | Tests nombres cortos | P1 | 0 |
| 11 | Serie mal enlazada | P1 | 2 |
| 3 | Unique constraints en `picks` | P1 | 1 |
| 7 | Tests de emparejamiento | P1 | continuo |
| 9 | Tests de temporadas/preseason | P1 | 0 |
| 12 | Logs estructurados persistidos | P2→P1 | 1 |
| 10 | Fallos de Telegram en call sites | P2 | continuo |

---

## 8. CONTRADICCIONES ENTRE EL DOCUMENTO Y EL CÓDIGO REAL

### 8.1 La contradicción conocida: ¿hay o no hay un filtro que bloquee un lado del mercado?

**SÍ LO HAY. `lib/pickGen.ts:1067-1077`.**

```ts
const adjustedTier = tierFromProbability(pickedProb, p.sport, pickedOdds);
if (adjustedTier === null) {
  console.log('[TIER_NULL_FILTERED]', { … });
  reasons.fail_confidence++;
  return [];          // ← el pick desaparece
}
```

`tierFromProbability` (`lib/units.ts:32-52`) devuelve `null` en `:43` cuando
`realProbability < t.value` — 0.55 en MLB, NHL, NBA y WNBA; 0.59 en NFL
(`lib/units.ts:24-30`). Y en `:45-49` degrada un escalón cuando
`oddsDecimal < 1.40`, hasta `null` para VALUE.

**El documento tiene razón en el diagnóstico y se equivoca en la magnitud.**
El underdog canónico de la Fase 6 —p=0.45, momio 2.50, EV +12.5 %— recorre así
el pipeline:

| Paso | Ubicación | Resultado |
|---|---|---|
| Edge por lado | `lib/pickGen.ts:928-929` | `0.45 − 1/2.50 = +0.05` |
| Gate de edge positivo | `:943-961` | pasa |
| `EDGE_THRESHOLD` 5 % | `:942`, `:964` | pasa, justo |
| **Tier** | **`:1067-1077`** | **`0.45 < 0.55` → `null` → DESCARTADO** |

**Y los 79 underdogs en 248 picks MLB no lo refutan.** Los dos hechos son
compatibles porque miden cosas distintas:

- El filtro corta por **probabilidad de modelo** (`pickedProb`).
- "Underdog" en la medición del 27-jul es por **momio** (`odds_decimal > 2.0`,
  implícito de mercado < 50 %).

Un pick con `odds = 2.20` (implícito 45.5 %) al que Claude asigna
`real_probability = 0.58` es, simultáneamente, un underdog de mercado y un
favorito de modelo. Pasa el filtro sin problema. De hecho, **el filtro
garantiza que todos los 79 underdogs tienen `real_probability ≥ 0.55`** — es
decir, todos son casos donde el modelo discrepa fuertemente del mercado.

**Consecuencia real, que es peor que la que el documento describe:** el sistema
no bloquea underdogs; bloquea **los underdogs cuya probabilidad el modelo
estima honestamente por debajo del 55 %**, que son exactamente los de valor
esperado positivo por precio y no por discrepancia de opinión. Se queda con la
clase de underdog más frágil (Claude contra el mercado) y descarta la más
sólida (precio a favor). El sesgo no es "no hay underdogs", es "solo hay
underdogs por opinión".

**Filtros adicionales por precio que sobreviven a quitar el piso** (y que la
Fase 6 debe retirar también, R6.1):
- `lib/pickGen.ts:1171` — descarta si `odds_decimal < 1.4 && edge < 0.05`.
- `lib/units.ts:45-49` — degrada tier por `odds < 1.40`.
- `lib/pickGen.ts:1028-1045` — dampening asimétrico: recorta la probabilidad
  **solo hacia arriba**. Nada la recorta hacia abajo.
- `lib/pickGen.ts:1169` — `confidence >= 55`, un segundo umbral sobre una
  magnitud que el documento advierte que no debe confundirse con probabilidad.

**Verificación con datos que W4 puede correr para cerrarlo del todo:**
`select count(*) from picks where real_probability < 0.55 and sport='MLB'` →
si es 0, el filtro está operando exactamente como describo.

### 8.2 El documento asume una fuente de datos que el repo no consume: Draftea

El documento nombra a Draftea 5 veces como si fuera una fuente del pipeline:
`draftea_odds` y `draftea_implied_probability` (Fase 1), "detección de precio"
y `price_edge_pp` (objetivo), "edge de precio contra Draftea" (Fase 4), "NO
reciba el momio de Draftea" (Fase 5), "Draftea como casa de ejecución"
(fuentes).

**En el repo, Draftea no es una fuente de momios.** `grep -rni draftea` sobre
`lib app components db supabase` devuelve **solo**:
- `lib/vision-extract-bet.ts` — extracción por Claude Vision de tickets **ya
  apostados** (`:51-73`).
- `lib/bet-matching.ts` — emparejar esos tickets con picks (`:40-56`).
- `lib/normalize-bet.ts:38` — normalización de texto de esos tickets.
- `app/api/bets/from-image/**` — la ruta que los consume.

Todo el edge se calcula contra **DraftKings vía ESPN**:
`lib/pickGen.ts:884-896` exige `dkOdds`, `:926-929` calcula el edge con él,
`:1009` deriva `marketBookImplied` de él.

**Impacto:** Fase 4 no es implementable tal como está escrita. Y hay un riesgo
conceptual mayor (R4.1): si `market_only` mide el precio justo contra DK y
DK es también la fuente del "precio de mercado", el benchmark compara el
mercado consigo mismo. Es la misma circularidad que ya invalidó
`picks.odds_decimal` como referencia. **Requiere decisión explícita de
Christian antes de la Fase 4.**

Nota adicional: el documento lista "The Odds API (500 req/mes)" entre las
fuentes. `lib/pickGen.ts:443-446` documenta el post-mortem de 2026-05:
`ODDS_API_KEY` "was effectively unusable in prod" y se retiró.
`grep -rn "ODDS_API"` no devuelve ninguna llamada viva. **La lista de fuentes
del documento describe una arquitectura anterior a mayo.**

### 8.3 Fase 5 invierte una decisión de arquitectura vigente, y choca con una regla no negociable del propio documento

Fase 5 pide que Claude "reciba el consenso sharp como prior".

El código actual tiene la decisión contraria, deliberada y documentada:
- `lib/prompts.ts:315-317`: **"TÚ NO VES MOMIOS. Eso es intencional."**
- `lib/prompts.ts:36-48`: `sanitizeGameForClaude` elimina `odds`, `multi_odds`,
  `odds_comparison`, `dk_odds`, `espn_bpi`, `best_ml`, `player_props`,
  `line_movement`.
- `lib/prompts.ts:2-4`: se llama "CAPA 1" y tiene fecha de retiro del esquema
  legacy asociada.

Y las reglas no negociables del propio documento dicen: **"NO pasar momios sin
sanitizar al prompt de Claude (leaka market bias)"**.

**El consenso sharp sin vig es un momio.** De-viggeado, promediado y
transformado, pero deriva directamente del precio. Fase 5 y la regla no
negociable son **literalmente incompatibles** salvo que la regla se reformule
como "no pasar momios **de Draftea** ni el edge calculado". Esa reformulación
es razonable —el prior sharp como ancla es el corazón del rediseño residual—
pero **debe escribirse**, porque tal como está, quien implemente la Fase 5
tiene una instrucción y su negación en el mismo documento.

**Fuga parcial ya existente, relevante para el diseño:** `lib/prompts.ts:71`
inyecta `market_signal`, computado en `:20-34` a partir de `dk_odds` **y**
`espn_bpi`. Es cualitativo (6 valores enumerados), pero es información de
mercado. La "CAPA 1" ya no es hermética; es semi-permeable por diseño. Vale la
pena decirlo porque la Fase 5 va a abrirla del todo y conviene que sea una
decisión, no un descubrimiento.

### 8.4 El documento propone campos que ya existen con otra semántica

| Campo del documento | Ya existe como | Colisión |
|---|---|---|
| `observation_only` (Fase 1/7, "todo el sistema arranca en observación") | `picks.observation_only` — "partido de exhibición, ESPN `season.type=1`" (`…observation_only.sql:21-22`) | Reusarlo mezcla dos conceptos. Al apagar el experimento se desprotege la pretemporada (R1.3) |
| `expected_value_central` / `expected_value_conservative` | `picks.edge` (`db/schema.sql:32`) = `real_probability − 1/odds`. **No es EV**, es diferencia de probabilidades | Nombres distintos, magnitudes distintas. `edge` debe conservarse con su significado o migrarse explícitamente |
| `sharp_consensus_probability` | `picks.market_consensus_implied` — promedio simple **con vig** de DK + BPI + Pinnacle (`lib/edge.ts:67`) | Mismo concepto nominal, cálculo incompatible (H2). No reusar la columna |
| `sharp_sources_count` | `picks.market_sources_count` (`lib/pickGen.ts:1153`) | Semánticamente cercano, pero cuenta el BPI como "fuente de mercado" y el BPI es un modelo |
| `model_variant` | **No existe.** `grep` → cero resultados | Sin colisión; hay que construirlo entero (§6.3.A) |
| `actual_clv` | `bets.clv` (`db/schema.sql:87`) | Existe, pero calculado sobre un `odds_at_bet` circular (H4). Reusar el nombre sin arreglar el cálculo hereda el problema |
| `confidence_raw` | `picks.confidence_raw` ya existe (`lib/pickGen.ts:1130`) y hoy es **idéntico** a `confidence` (`:1063-1064`: `const confRaw = p.confidence; const conf = p.confidence;`) | El documento advierte "NO confundir confidence_raw con probabilidad". En el código los dos campos son el mismo número duplicado — la distinción que la advertencia protege **no existe todavía** |

### 8.5 Supuestos numéricos del documento que no cuadran con el código

**(a) Base rates.** El contexto compartido dice "base rates del prompt
(`lib/prompts.ts:122`): 57 % local / 66 % favorito ML". Verificado: `:122` es
la línea **de NFL**. El prompt tiene cinco filas distintas (`:118-124`), y la
de MLB es `~54 % local | ~58 % favorito ML`. Atribuir 57/66 al sistema en
general y no a NFL lleva a conclusiones erróneas sobre MLB, que es donde está
el 100 % del histórico útil.

**(b) El cap de MLB.** Verificado: `lib/prompts.ts:320` — `MLB: max 58 %
visitante, max 66 % local`. La Fase 5 acierta al moverlos server-side. Nota de
implementación: los caps del prompt son **asimétricos por localía**, mientras
`SPORT_THRESHOLDS` (`lib/units.ts:24-30`) es **simétrico**. Al mover los caps
al servidor hay que decidir cuál de las dos estructuras gana; el documento no
lo dice.

**(c) `EDGE_THRESHOLD`.** El contexto lo sitúa en `lib/pickGen.ts:900`. Está en
**`:942`** (`const EDGE_THRESHOLD = 0.05`), aplicado en `:964`. Valor
confirmado: 5 %. Pero **dos comentarios del propio repo dicen 2 %**:
`lib/pickGen.ts:246` y `app/api/cron/analyze/route.ts:331`. Cualquiera que
planifique leyendo comentarios planifica sobre un umbral que no existe.

**(d) Umbral de parlays.** `lib/pickGen.ts:1245` filtra patas con
`edge >= 0.03`, mientras el umbral de singles es 0.05 (`:942`). Es decir: un
pick con 4 % de edge no se emite como single pero **sí puede ser pata de un
parlay**. No es una contradicción con el documento —el documento no habla de
parlays— pero sí una inconsistencia interna que la Fase 6 debe resolver al
centralizar thresholds, porque hoy hay dos umbrales de edge en el mismo archivo.

**(e) Potencia estadística.** El documento cita ~1.708 apuestas para detectar
3pp vía win rate y 25-155 para CLV. No verificable desde el código; es un
cálculo externo. **Lo declaro `NO VERIFICABLE`** — no lo refuto, no lo confirmo.
Lo que sí verifico es que la conclusión operativa (el CLV es el criterio) queda
sujeta a que H4 se arregle primero, porque el CLV medido hoy no es el CLV.

### 8.6 El documento asume una capacidad de medición que el código no tiene

Fase 7 pide "Brier score, log loss, calibración". Fase 8 pide "Brier score no
peor que market_only".

`grep -rn "brier\|log_loss\|logLoss\|calibration_curve" lib app` → **cero
resultados**. `app/api/cron/calibrate/route.ts` no calcula ninguna de las tres:
`:137-138` filtra bets con `clv` no nulo y promedia. Lo que la ruta llama
"calibración" es el ajuste de pesos de factores
(`pick_factors → factor_performance → system_weights`), un concepto distinto
del que usan las Fases 7 y 8.

**Impacto:** el criterio de activación de la Fase 8 se apoya en tres métricas
que hay que construir desde cero, con sus tests. No es un detalle: es trabajo
no contabilizado en ninguna fase del documento.

### 8.7 "NO filtrar partidos antes de analizarlos por límites artificiales" — ya se hace, en dos sitios

Regla no negociable del documento. En el código:

- `app/api/cron/analyze/route.ts:255` — `scored.slice(0, MAX_FRESH_GAMES)`,
  y **`MAX_FRESH_GAMES = 3`** (`:245`). Tres partidos nuevos por corrida,
  ordenados por playoffs y proximidad al arranque. Los cortados **no se
  analizan y no dejan rastro** salvo un `console.log` en `:256`. Con una
  jornada MLB de 15 partidos, el sistema ve 3 y descarta 12 sin registro
  persistente de cuáles.
- `app/api/generate-picks/route.ts:19-23` — `competitiveness()` ordena por
  cercanía a 50/50 y `selectTopGames` corta a 20 (`:12`). Un límite artificial
  explícito y, además, **sesgado**: prioriza partidos parejos, que es
  exactamente el subconjunto donde el mercado es más eficiente.

No digo que los caps deban quitarse — hay un presupuesto real de 60 s de Vercel
(`maxDuration = 60`) y de tokens. Digo que la regla del documento está escrita
como absoluta y el código ya la incumple por razones legítimas. **La regla
necesita una excepción escrita, con el requisito de que todo partido cortado
deje una fila con `rejection_reason = 'budget_cap'`.** Si no, la Fase 7 va a
comparar variantes sobre conjuntos de partidos que nadie sabe cómo se
seleccionaron.

### 8.8 Contradicciones internas del repo (no del documento) que afectan al plan

Las incluyo porque cualquiera que planifique leyendo el código las va a tomar
por especificación:

1. **`lib/healthChecks.ts:190-196`** afirma que la pretemporada NFL está
   excluida del pipeline por `ALLOWED_SEASON_TYPES`. `b833d98` la readmitió
   (`lib/espn.ts:171-173`: `NFL: [1,2,3]`). Consecuencia viva: `:199` deja la
   NFL como off-season hasta el 9-sep, así que los checks de predictor NFL
   quedan fuera del conteo de errores **durante toda la ventana de
   observación**. El health check está ciego justo cuando el mecanismo que se
   quiere observar está corriendo.
2. **Umbral de edge**: 2 % en dos comentarios, 5 % en el código (§8.5.c).
3. **`lib/espn.ts:797`** construye la URL de cierre con
   `competitions/${eventId}` mientras `lib/espn.ts:199` usa correctamente
   `comp.id`. Coinciden en la mayoría de ligas de ESPN por convención, no por
   contrato. Si divergen en alguna, el CLV de esa liga entera vale 0 en
   silencio (R7.4).
4. **`confidence` y `confidence_raw` son el mismo valor** duplicado
   (`lib/pickGen.ts:1063-1064`), pese a que existen como dos columnas y el
   documento dedica una regla no negociable a no confundirlos.
5. **`floor_applied` está muerto**: `lib/pickGen.ts:1065` lo fija a `'none'`
   como constante y nunca cambia, pero se persiste (`:1155`), se lee en el
   heartbeat (`app/api/cron/heartbeat/route.ts:23`), se convierte en porcentaje
   (`:110`), se muestra al usuario (`:124`) y alimenta una alerta
   (`:146-148`: `floorAppliedPct < 60` → "Claude may be over-confident") que por
   construcción siempre se dispara. Una alerta que no puede informar, y un
   número visible que siempre dirá 0 %.

---

## APÉNDICE — QUÉ NO VERIFIQUÉ

Honestidad sobre los límites de esta entrega:

- **Nada contra producción.** Todas las afirmaciones son de lectura estática en
  `b833d98`. No consulté Supabase ni ninguna API. Los conteos que cito (188
  placeholders, 79 underdogs, 44 bets con CLV, 72 de 166) vienen del contexto
  compartido, no de una medición mía.
- **`NO VERIFICABLE`: qué hay realmente desplegado en producción.** Si
  `place_bet_atomic` en el servidor difiere de
  `…observation_only.sql:40-121`, varias conclusiones de §6 y §7.4 cambian. Es
  el trabajo de W3 y mi plan lo marca como bloqueante en §4.1.
- **`NO VERIFICABLE`: quién llama hoy a `/api/check-results` y
  `/api/generate-picks`.** Sé que no tienen auth y que ningún workflow del repo
  las invoca. No sé si algo externo lo hace. Por eso R0.2 propone loguear antes
  de cerrar.
- **`NO VERIFICABLE`: la cifra de ~1.708 apuestas** de la Fase 8 (§8.5.e).
- **No revisé** `components/**` salvo `PickCard.tsx`, ni `lib/mlbStats.ts`,
  `lib/nflStats.ts`, `lib/nhlStats.ts`, `lib/basketballStats.ts`,
  `lib/montecarlo.ts`, `lib/weather.ts`, `lib/elo.ts` ni el webhook de
  Telegram. Ninguno está en la ruta crítica de las Fases 1-6, pero si alguna
  fase los toca, este plan no los cubre.
