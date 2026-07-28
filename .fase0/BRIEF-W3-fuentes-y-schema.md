# BRIEF W3 — Auditoría de fuentes de datos y schema real

Antes de nada, lee `/Users/christian/code/pick-it-up/.fase0/00-CONTEXTO-COMPARTIDO.md`.
Sus reglas duras (cero writes, evidencia con archivo:línea, NO VERIFICABLE, sentinel
de cierre) aplican a este brief.

Directorio: `/Users/christian/code/pick-it-up`, HEAD actual.
Presupuesto: ~35-50 min.
Credenciales de Supabase: `.env.local` en la raíz. **SOLO SELECT.** Cero writes.

---

## PARTE A — FUENTES DE DATOS

Por cada fuente que el código toque —Pinnacle Guest API, DraftKings vía ESPN core,
The Odds API, ESPN, MLB Stats API, NHL API, OpenWeather, y **Draftea si el código la
toca**— documenta cómo se obtiene, sanitiza, persiste y consume, con `archivo:línea`.

**NO ASUMAS QUE LOS DATOS SON COMPARABLES ENTRE FUENTES.** Verifica explícitamente,
por fuente, si cada uno de estos existe y cómo se representa:

- timestamp de captura
- tipo de mercado
- identificación de local y visitante
- lado (side)
- momio decimal
- casa
- vig / overround
- estado del evento
- minutos al inicio
- correspondencia exacta del partido (matching)

Reporta **qué campos NO se persisten hoy** y que por tanto hacen imposible reconstruir
análisis históricos.

### Pregunta clave para el rediseño (respóndela destacada)

**¿El sistema captura AMBOS lados del moneyline de cada fuente?**

Sin los dos lados no se puede eliminar el vig, y eso es el cimiento de todo el
rediseño. **Si solo se guarda el lado apostado, es un BLOQUEANTE de la Fase 2** —
dilo con esas palabras y con la evidencia.

---

## PARTE B — SCHEMA REAL

Confirma el schema real de Supabase contra las migraciones del repo
(`db/schema.sql` + `supabase/migrations/*.sql`, 20 archivos).

**Ya hay antecedente de columnas que existen en producción sin migración
correspondiente**: las 3 rondas de `retroactive_schema_sync`
(`20260521000000`, `20260521010000`, `20260521020000`).

Reporta:

1. Columnas en producción que NO están en migraciones.
2. Migraciones que NO se reflejan en producción.
3. **Triggers, funciones y vistas existentes.** Relevante y prioritario: algo reescribe
   `picks.odds_decimal` ~137ms antes del insert del bet y no se sabe qué. Consulta el
   catálogo real (`information_schema.triggers`, `pg_trigger`, `pg_proc`,
   `pg_get_functiondef`, `pg_views`) — no te quedes en las migraciones.
   (W1 investiga lo mismo desde el lado del código; tu ángulo es el catálogo de la DB.
   Si ambos convergen, mejor; si divergen, dilo.)
4. Constraints e índices reales, y cuáles son únicos. Contrasta con el hecho conocido
   de que `picks` tiene cero unique constraints.

---

## PARTE C — COLISIONES CON EL SCHEMA PROPUESTO

El rediseño propone ~30 campos nuevos. **La lista completa está en la sección
`FASE 1 — MODELO DE DATOS OBSERVABLE` de
`/Users/christian/code/pick-it-up/.fase0/01-DOCUMENTO-REDISENO.md`.** Léela de ahí,
literal — no la reconstruyas de memoria.

Son dos grupos: campos **por candidato y por fuente** (book_name, market_type, side,
odds_decimal, implied_probability_raw, implied_probability_no_vig, fetched_at, …) y
campos **por análisis** (sharp_probability, sharp_consensus_probability, price_edge_pp,
expected_value_conservative, model_variant, rejection_reason, …).

Reconcílialos con el schema real que documentaste en la Parte B:

1. **Cuáles ya existen con otro nombre.** Ej.: ¿`draftea_implied_probability` es lo
   mismo que algún campo actual de `picks`? ¿`actual_clv` vs `bets.clv`?
2. **Cuáles chocan semánticamente con algo existente.** El caso peligroso: un nombre
   nuevo que parece equivalente a un campo actual pero significa otra cosa. Ojo
   particular con `confidence_raw` — el documento advierte que confundirlo con
   probabilidad de ganar ya costó semanas en este proyecto.
3. **Cuáles son genuinamente nuevos.**
4. **Propón nombres finales que no dupliquen conceptos**, y di en qué tabla va cada
   uno (o si hace falta una tabla nueva: el grupo "por candidato y por fuente" es
   claramente 1-a-N respecto del análisis, y hoy no hay dónde ponerlo).

Nota dos reglas duras del documento que afectan tu propuesta:
- **Nunca almacenar 0 como placeholder de probabilidad desconocida. NULL cuando el
  valor no existe.** Marca qué columnas actuales violan esto hoy.
- Cada migración reversible o con razón documentada.

Produce también el **inventario completo y anotado del schema real** (tabla → columna →
tipo → nullable → default → qué significa y quién la escribe). Es el insumo de la
reconciliación y entregable por sí solo.

---

## ENTREGABLE

`/Users/christian/code/pick-it-up/.fase0/W3-fuentes-schema.md`

Luego, como ÚLTIMA acción:
`/Users/christian/code/pick-it-up/.fase0/DONE-W3` con una línea `OK ...` o `FAIL ...`.

Cero writes fuera de `.fase0/`. Contra Supabase solo SELECT.
