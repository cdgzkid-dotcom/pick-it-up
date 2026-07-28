# FASE 0 — CONTEXTO COMPARTIDO (léelo antes de tu brief)

Proyecto: Pick It Up — `/Users/christian/code/pick-it-up`
HEAD al arrancar: `b833d98` (main). Fecha: 2026-07-28.
Stack: Next.js (App Router) + Supabase (Postgres) + Claude API + Telegram.

## REGLAS DURAS DE ESTA FASE (aplican a TODOS los workers)

1. **CERO WRITES.** No modifiques ningún archivo del repo. No corras `git`
   destructivo. No apliques migraciones. Contra Supabase: SOLO `SELECT`.
   Contra APIs externas: SOLO `GET`.
2. **EVIDENCIA CON `archivo:línea`.** Nada de "el código parece hacer X".
   Cita `lib/pickGen.ts:900`, no "en pickGen".
3. **DECLARA `NO VERIFICABLE`** cuando no puedas confirmar algo con evidencia
   directa, en vez de inferir o inventar. Es una respuesta válida y esperada.
   Es preferible un "NO VERIFICABLE + qué falta" que una conjetura elegante.
4. **Si verificas algo en vivo contra producción, registra el timestamp UTC.**
5. **Escribe tu entregable en el archivo que te indica tu brief**, dentro de
   `/Users/christian/code/pick-it-up/.fase0/`. Ese directorio es scratch, no
   forma parte del código de producción — escribir ahí SÍ está permitido.
6. **SENTINEL DE CIERRE (obligatorio):** tu ÚLTIMA acción es crear el archivo
   `/Users/christian/code/pick-it-up/.fase0/DONE-<tu-nombre-de-tarea>` con una
   sola línea: `OK <resumen>` o `FAIL <qué faltó>`.

## ⚠️ EL DOCUMENTO DE REDISEÑO (Fases 1-8) NO ESTÁ DISPONIBLE

El encargo original iba a incluir un documento completo de rediseño del núcleo
analítico con secciones Fase 1 a Fase 8. **Ese documento no llegó** (el prompt
traía un placeholder sin resolver). Está solicitado a Christian.

**NO INVENTES SU CONTENIDO.** Si tu brief te pide reconciliar algo contra "la
Fase N del documento de contexto", marca esa parte como `BLOQUEADO — documento
de rediseño ausente` y haz todo lo demás. No deduzcas qué diría.

Lo que sí se sabe del rediseño, y es todo lo que se sabe:
- Propone ~30 campos nuevos de schema (lista no disponible).
- Su "sección 6" enumera 12 puntos de deuda técnica que corresponden al
  inventario reproducido abajo.
- Ejes conocidos del rediseño: eliminación del vig como cimiento del cálculo de
  probabilidad; dejar de tratar el pick como necesariamente el favorito;
  fijar thresholds por EV en vez de por piso de probabilidad; modo observación;
  medición correcta de CLV.

## HECHOS VERIFICADOS DEL PROYECTO (no los re-derives; sí puedes refutarlos)

Fuente: inventario de deuda técnica del 27-jul-2026, ya auditado.
Si tu trabajo CONTRADICE alguno de estos puntos, **dilo explícitamente** — vale
más que confirmarlos.

### Bloque CLV / precios (crítico para W1 y W4)

- Los 44 bets con CLV tienen `odds_at_bet` **idéntico** a `picks.odds_decimal`
  (ratio 1.0000, sd 0.0002, 44/44) y ~2% distinto de `picks.original_odds`
  (ratio 0.9807, sd 0.0174, más corto en 34 de 41).
- Por eso **`picks.odds_decimal` NO sirve como referencia histórica**: algo lo
  reescribe ~137ms antes del insert del bet, y nadie ha identificado qué.
  Comparar contra él es circular. La referencia correcta del precio de análisis
  es **`picks.original_odds`** (congelado por el lock-in de CAPA-2).
- Sospecha: trigger o función desplegada fuera de migraciones. Hay antecedente
  del mismo patrón: `supabase/migrations/2026052100*_retroactive_schema_sync*.sql`
  (3 rondas) existen porque había objetos en producción ausentes del repo.
- `bets` guarda `odds_at_close` y `clv` pero **no persiste la casa, el endpoint
  ni el timestamp de captura** del cierre. 5 de 44 filas tienen
  `odds_at_close == odds_at_bet` (fallback), indistinguibles de línea inmóvil.
- Brecha de captura (`odds_at_bet` vs `original_odds`): −0.985 pp.
  CLV total almacenado: −0.934 pp. **La brecha de captura sola ya cubre el CLV
  completo.**
- Hipótesis muerta #1: "es artefacto de vig" → FALSO, overround idéntico al
  abrir (1.0480) y al cerrar (1.0484).
- Hipótesis muerta #2: "son casas distintas en el cierre" → `odds_at_close` SÍ
  es cierre real de DraftKings en 11 de 12 casos comprobados.

### Bloque probabilidad / tiers / caps

- `lib/prompts.ts:323` declara para MLB cap de **58% para visitante**.
  En los datos: **72 de 166 picks de visitante tienen `real_probability` > 58%**.
  **Los caps del prompt NO se respetan.** El LLM los ignora. Hoy son lo peor de
  ambos mundos: dan falsa sensación de límite y no limitan.
- Umbrales por deporte viven en `SPORT_THRESHOLDS` (`lib/units.ts`).
  Umbral STRONG MLB = 0.60, piso VALUE MLB = 0.55.
- Antecedente de threshold hardcodeado desincronizado: `TIER_RANGE` vivía a mano
  en `lib/units.ts`, se desincronizó de los umbrales reales y mintió al usuario
  en tres pantallas durante semanas. Corregido en `24af709`.
- `EDGE_THRESHOLD` = 5% en `lib/pickGen.ts:900`.
- Base rates del prompt (`lib/prompts.ts:122`): 57% local / 66% favorito ML.
  Correctos para regular season, NO para preseason (45.6-50% / 59.2%).

### Bloque persistencia / análisis histórico

- Los marcadores `analyzed_no_edge` se persisten con `real_probability: 0`,
  `implied_probability: 0`, `edge: 0`, `edge_vs_market: NULL`.
  **No son predicciones de 0% — son placeholders.** Ver
  `app/api/cron/analyze/route.ts:319-322` y `:413-418`.
  Consecuencia: es imposible analizar dónde corta el `EDGE_THRESHOLD`, porque
  los candidatos de 0-5% de edge no se persisten en ninguna parte.
- `picks` tiene **cero unique constraints** (`db/schema.sql:9-54`: 5 índices,
  todos no-únicos). La protección contra duplicados es solo a nivel aplicación.
  `bets` sí está protegida: `place_bet_atomic` lanza `duplicate_bet:%`
  (errcode 23505) → HTTP 409.
- `factor_performance` guarda `wins` y `losses`; usar `wins` como número de
  apuestas indujo a reportar 21 apuestas cuando eran 68.
- 18 bets resueltos sin `espn_event_id` (13 ML simples de mayo + 5 combinadas).
- 11 parlays en `pending` con `game_start_time` NULL desde el 24-may.
- La clase de bug "bet mis-linkeado a otro juego de la misma serie" sigue viva:
  46 de 50 bets auditables son partidos de serie donde el matchup se repite
  en ±3 días, y la auditoría verifica coherencia interna, no que el bet apunte
  al partido correcto.

### Bloque operación / kill switch

- **El sistema no tiene forma de pararse.** `auto_enabled === false` solo
  provoca el early-return de `runAnalyzeWindow()`
  (`app/api/cron/analyze/route.ts:146`). `runResultsCheck()` se invoca aparte en
  el handler (`:1015`), en su propio try, y **no consulta `auto_enabled`**.
  Sigue llamando `resolve_bet_atomic` sobre cualquier bet `pending` con
  `espn_event_id`. El único corte hoy es cortar `CRON_SECRET` en Vercel o pausar
  el disparador en cron-job.org.
- Solo existen 3 rutas cron: `analyze`, `calibrate`, `heartbeat`.
- **Cero tests.** Los runs verdes de GitHub Actions son solo disparadores HTTP
  (heartbeat diario, calibración semanal). No hay una sola prueba unitaria ni de
  integración.
- Operativo verificado: `supabase db push` aplica **TODAS** las migraciones
  pendientes; no se puede aplicar una sola.
- Regla dura del proyecto: **migración PRIMERO, deploy DESPUÉS.** Si el código
  sale antes que la columna, PostgREST rechaza la columna desconocida y se cae
  el pipeline entero.

### Bloque modo observación (ya existe, hay que REUSARLO)

- El commit `b833d98` introdujo `picks.observation_only` y lo acotó a NFL vía
  `OBSERVATION_SPORTS = new Set(['NFL'])` en `lib/espn.ts`.
- La maquinaria completa —flag persistente, bloqueo de apuesta en 4 capas
  (incluido el guard en `place_bet_atomic`), exclusión de agregados, formato de
  Telegram— **ya es agnóstica de deporte**. Ampliarla es agregar la clave al set.
- Migración relevante: `supabase/migrations/20260727120000_preseason_observation_only.sql`
- Relacionado: `supabase/migrations/20260727130000_bets_excluded_from_stats.sql`
  (`bets.excluded_from_stats`).

### Falso positivo — NO volver a "arreglar"

- "la tabla `audit_failures` no existe" → **nunca fue una tabla**. Es una
  columna `jsonb` de `picks`, existe y funciona (verificado con datos reales el
  27-jul). El 404 de `/rest/v1/audit_failures` era una prueba contra una tabla
  que el código nunca pidió.

## MAPA RÁPIDO DEL REPO

```
app/api/cron/analyze/route.ts   ← handler principal: runAnalyzeWindow + runResultsCheck
app/api/cron/calibrate/route.ts
app/api/cron/heartbeat/route.ts
app/api/bets/route.ts           ← alta de bets
app/api/check-results/route.ts
app/api/generate-picks/route.ts
lib/pickGen.ts                  ← generación de picks, EDGE_THRESHOLD
lib/prompts.ts                  ← prompt del LLM, caps, base rates
lib/claude.ts                   ← llamada al modelo
lib/units.ts                    ← SPORT_THRESHOLDS, tiers, Kelly, TIER_RANGE
lib/edge.ts                     ← cálculo de edge
lib/pinnacle.ts  lib/espn.ts    ← fuentes de momios
lib/lineMovement.ts             ← movimiento de línea / cierre
lib/pickAudit.ts                ← auditorías del pick
lib/betEval.ts  lib/bet-matching.ts
lib/elo.ts  lib/montecarlo.ts  lib/learning.ts  lib/stats.ts
lib/mlbStats.ts lib/nflStats.ts lib/nbaStats.ts lib/nhlStats.ts lib/basketballStats.ts
lib/telegram.ts lib/weather.ts lib/teams.ts lib/supabase.ts lib/types.ts
db/schema.sql                   ← schema base
supabase/migrations/*.sql       ← 20 migraciones
```

Credenciales de solo lectura para Supabase: `.env.local` en la raíz del proyecto.
