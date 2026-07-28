# BRIEF W5 — Plan por fases, riesgos, tests y migraciones

Lee, en este orden:
1. `/Users/christian/code/pick-it-up/.fase0/00-CONTEXTO-COMPARTIDO.md` (reglas duras)
2. `/Users/christian/code/pick-it-up/.fase0/01-DOCUMENTO-REDISENO.md` (**tu insumo
   principal**: secciones Fase 1 a Fase 8, la lista de 12 puntos de deuda técnica, y
   las reglas no negociables)

Directorio: `/Users/christian/code/pick-it-up`, HEAD actual.
Presupuesto: ~40-55 min. **Lees el repo, NO lo modificas.** Tu único write es tu
entregable dentro de `.fase0/`.

Tu entrega alimenta directamente lo que Christian va a aprobar antes de que empiece la
Fase 1. Escribe para esa decisión: concreto, accionable, con rutas reales.

## TAREAS

### 1. PLAN DE ARCHIVOS POR FASE

Qué se toca en cada fase (1 a 8), con **rutas reales del repo** verificadas — no
inventadas. Marca explícitamente:
- Qué fases pueden ir **en paralelo**.
- Qué fases tienen **dependencia dura** y por qué.

Recuerda que la Fase 4 (benchmark market_only) es obligatoria y que la Fase 2
(eliminación del vig) es el cimiento del que dependen 3, 4, 5 y 6.

### 2. RIESGOS POR FASE, CON MODO DE FALLO CONCRETO

Cada riesgo debe decir **cómo se rompe exactamente y qué se observa cuando se rompe**.

✅ Ejemplo de lo que quiero:
> "Si la Fase 2 no captura ambos lados del moneyline, la eliminación del vig produce
> probabilidades silenciosamente sesgadas y todo lo aguas abajo hereda el sesgo sin
> señal de error."

❌ Ejemplo de lo que NO quiero:
> "riesgo de bugs"

Prioriza los fallos **silenciosos** — los que no lanzan excepción y contaminan datos.
Este proyecto ya tuvo varios (TIER_RANGE desincronizado, `real_probability=0` como
placeholder, `picks.odds_decimal` reescrito, caps del prompt ignorados).

### 3. PLAN DE TESTS

**El proyecto tiene CERO tests.** Los 10 runs verdes de CI son solo disparadores HTTP
(heartbeat diario, calibración semanal). Empiezas de cero: propón también el runner y
dónde viven los tests, coherente con el stack (Next.js + TypeScript + pnpm).

Prioriza, en este orden:
- **Eliminación de vig** con casos conocidos, incluidos **overrounds extremos** y
  **mercados de un solo lado**.
- **Emparejamiento de eventos y equipos.**
- **Nombres cortos**: `"Sox"` (White Sox / Red Sox) rompió `pickedSide` porque el
  threshold exigía >=4 caracteres. Localiza ese código y escribe el caso.
- **Temporadas y preseason** (`ALLOWED_SEASON_TYPES`, `OBSERVATION_SPORTS`).
- **Aritmética de EV con favoritos Y underdogs** — el pipeline debe ser simétrico.

Regla del documento: toda lógica financiera nueva lleva tests. Y antes de declarar algo
listo: `tsc --noEmit`, tests y `next build`. Los tres.

### 4. PLAN DE MIGRACIONES

Cada una reversible o con razón documentada de por qué no lo es.

⚠️ **Advertencia operativa verificada:** `supabase db push` aplica **TODAS** las
migraciones pendientes; no se puede aplicar una sola. Considéralo en el orden que
propongas — una migración a medio cocinar en el directorio se va a producción junto con
la siguiente que alguien empuje.

⚠️ **Regla dura del proyecto: migración PRIMERO, deploy DESPUÉS.** Si el código sale
antes que la columna, PostgREST rechaza la columna desconocida y **se cae el pipeline
entero**. Refleja esto en la secuencia de cada fase que toque schema.

Nota: W3 está auditando el schema real contra las migraciones y puede encontrar
columnas en producción sin migración correspondiente (ya pasó: 3 rondas de
`retroactive_schema_sync`). Deja marcado dónde tu plan depende de ese resultado.

### 5. CRITERIOS DE ACEPTACIÓN POR FASE

Cómo se sabe que quedó bien, con **verificación concreta** — el comando, la query o la
observación que lo demuestra. No "funciona correctamente".

### 6. REUSO DEL MECANISMO DE OBSERVACIÓN (Fase 7)

Ya existe en el repo: `picks.observation_only` + guard en `place_bet_atomic` + 4 capas
de bloqueo, construido para preseason NFL en el commit `b833d98`, acotado vía
`OBSERVATION_SPORTS = new Set(['NFL'])` en `lib/espn.ts`. Migración:
`supabase/migrations/20260727120000_preseason_observation_only.sql`.

**La Fase 7 debe REUSARLO, no construir uno paralelo.** Documenta, con `archivo:línea`:
- Qué existe hoy exactamente y dónde están las 4 capas.
- **Qué hay que extender** para soportar las tres variantes del experimento
  (`market_only`, `market_plus_claude`, `legacy_model`) y el arranque global en
  `observation_only = true`.
- Qué NO hay que tocar porque ya es agnóstico.

### 7. DEUDA TÉCNICA

Incorpora los **12 puntos** de la sección "DEUDA TÉCNICA A INCORPORAR AL PLAN POR
FASES" del documento de rediseño al plan por fases, cada uno con prioridad
**justificada** (no solo alta/media/baja: por qué).

El **kill switch (punto 1) es el más grave**: `auto_enabled === false` solo provoca el
early-return de `runAnalyzeWindow()` (`app/api/cron/analyze/route.ts:146`), mientras
`runResultsCheck()` se invoca aparte en el handler (`:1015`) y nunca consulta el flag.
**El sistema no tiene forma de pararse**, y cualquier mantenimiento sobre `bets` corre
con el cron vivo. Verifica esas líneas tú mismo y propón el fix con precisión.

### 8. CONTRADICCIONES ENTRE EL DOCUMENTO Y EL CÓDIGO REAL

**Señala toda contradicción que encuentres entre el documento de rediseño y el código
real.** Esto vale más que cumplir el encargo al pie de la letra — es la parte de tu
entrega con mayor valor.

Ejemplos del tipo de cosa que busco: que el documento asuma una capacidad que el código
no tiene, que proponga un campo que ya existe con otra semántica, que dé por hecho una
fuente de datos que el repo no consume, o que un supuesto numérico del documento no
cuadre con lo que dice el código.

Ya hay una contradicción conocida a verificar: el documento asume que el piso de
probabilidad impide estructuralmente recomendar underdogs (Fase 6), pero una medición
del 27-jul encontró 79 underdogs en 248 picks MLB. W4 está resolviéndola con datos; tú
resuélvela desde el código: **¿hay o no hay un filtro que bloquee un lado del mercado?**
Con `archivo:línea`.

## ENTREGABLE

`/Users/christian/code/pick-it-up/.fase0/W5-plan-riesgos.md`

Luego, como ÚLTIMA acción:
`/Users/christian/code/pick-it-up/.fase0/DONE-W5` con una línea `OK ...` o `FAIL ...`.
