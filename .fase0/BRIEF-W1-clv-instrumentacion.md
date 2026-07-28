# BRIEF W1 — CLV e instrumentación de precios

Antes de nada, lee `/Users/christian/code/pick-it-up/.fase0/00-CONTEXTO-COMPARTIDO.md`.
Sus reglas duras (cero writes, evidencia con archivo:línea, NO VERIFICABLE, sentinel
de cierre) aplican a este brief.

Presupuesto: ~30-45 min. Trabajas sobre `/Users/christian/code/pick-it-up`, HEAD actual.

## OBJETIVO

Resolver de dónde salen `odds_at_bet` y `odds_at_close`, y proponer cómo medir CLV
correctamente. **Esta tarea es BLOQUEANTE**: sin ella no se puede diseñar la Fase 8
del rediseño.

## ESTA PREGUNTA YA SE RESPONDIÓ MAL TRES VECES. No repitas ninguno de estos errores:

1. Se dijo **"es artefacto de vig"** → FALSO. El overround es idéntico al abrir
   (1.0480) y al cerrar (1.0484).
2. Se dijo **"son casas distintas en el cierre"** → `odds_at_close` SÍ es cierre real
   de DraftKings en 11 de 12 casos comprobados.
3. Se comparó `odds_at_bet` contra `picks.odds_decimal` y dio 44/44 idéntico →
   **comparación CIRCULAR**, porque `picks.odds_decimal` se REESCRIBE
   post-generación (~137ms antes del insert del bet, por algo no identificado).

## LA MEDICIÓN QUE SÍ VALE

Contra `picks.original_odds` (precio congelado por el lock-in al momento del análisis):

| métrica | valor |
|---|---|
| ratio `odds_at_bet` / `original_odds` | 0.9807, sd 0.0174 |
| más corto en | 34 de 41 |
| brecha | −0.985 pp |
| CLV total almacenado | −0.934 pp |

**La brecha de captura sola ya cubre el CLV completo.** Ese es el hecho central.

## TAREAS

### 1. Traza con `archivo:línea` el origen de cada campo

Para cada uno: ¿qué casa de apuestas? ¿qué endpoint? ¿en qué momento exacto del flujo
se escribe? ¿qué pasa en el camino de error/fallback?

- `bets.odds_at_bet`
- `bets.odds_at_close`
- `picks.original_odds` — ¿quién lo escribe y cuándo?
- `picks.odds_decimal` — **¿QUÉ lo reescribe?**

Sobre el último: se detectó que algo lo modifica ~137ms antes del insert del bet y no
se encontró qué. Busca triggers, funciones RPC (`place_bet_atomic`,
`resolve_bet_atomic`, `adjust_bankroll_atomic` y cualquier otra), vistas, y código
desplegado fuera de migraciones. **Ya hay antecedente de objetos en producción que no
están en el repo**: las 3 rondas de `retroactive_schema_sync` en
`supabase/migrations/`. Consulta el catálogo real de Postgres con SELECT
(`pg_trigger`, `pg_proc`, `information_schema.triggers`, `pg_get_functiondef`) — no te
quedes solo en las migraciones del repo.

### 2. Prueba la hipótesis principal

**Hipótesis: `odds_at_bet` es precio de DRAFTEA y `odds_at_close` es cierre de
DRAFTKINGS.** Si es así, el "CLV" mide **spread entre casas contaminado por margen**,
no movimiento de línea.

Busca en el código la evidencia que la confirme o la mate. No la des por buena ni por
mala sin `archivo:línea`.

### 3. Si el código no basta, diseña la prueba empírica

Capturar precio de Draftea y de DraftKings en el MISMO instante para 5-8 juegos.
Especifica **exactamente**:
- ¿Existe API de Draftea? ¿el repo la toca? ¿o hay que capturar a mano desde la app?
- Protocolo paso a paso, reproducible por Christian sin ti.
- Qué resultado numérico confirmaría cada hipótesis y cuál la mataría.

### 4. Propón cómo medir CLV bien

- ¿Contra qué precio?
- ¿De qué casa?
- ¿De-vigged o bruto? Justifica.
- ¿Qué momento cuenta como "cierre"?
- **¿Qué campos hay que persistir que hoy no se persisten?** (hoy no se guarda ni la
  casa, ni el endpoint, ni el timestamp de captura del cierre; y 5 de 44 filas tienen
  `odds_at_close == odds_at_bet` por fallback, indistinguibles de línea inmóvil).

### 5. El costo estructural de Draftea

Si Draftea paga estructuralmente ~2% peor que DraftKings: **¿cuánto edge extra necesita
el sistema para compensarlo?** Da el número y la aritmética. Ese número debería estar
en el `EDGE_THRESHOLD` (`lib/pickGen.ts:900`, hoy 5%) y hoy no está.

## VEREDICTO EXPLÍCITO (obligatorio, al inicio de tu entregable)

Elige una y solo una, con la evidencia que la sostiene:

- **A) Artefacto cross-book** — el CLV mide spread entre casas, no movimiento.
- **B) Movimiento real de mercado** — el CLV es señal legítima.
- **C) Indeterminado** — y entonces di exactamente qué falta para determinarlo.

## ENTREGABLE

`/Users/christian/code/pick-it-up/.fase0/W1-clv-instrumentacion.md`

Luego, como ÚLTIMA acción:
`/Users/christian/code/pick-it-up/.fase0/DONE-W1` con una línea `OK ...` o `FAIL ...`.

Cero writes fuera de `.fase0/`. Contra Supabase solo SELECT.
