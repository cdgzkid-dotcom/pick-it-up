# BRIEF S1 — Etapa 1+3 del spread Draftea (implementación acotada)

Proyecto: Next.js + Supabase. Trabajas en un worktree aislado del repo
`pick-it-up`. HEAD base: `471b743`.

Contexto obligatorio (léelo primero):
- `.fase0/FASE-0-INTEGRADO.md` — sección "El EDGE_THRESHOLD está mal ubicado"
- `.fase0/W1-clv-instrumentacion.md` — §5 (costo estructural de Draftea)

## DECISIÓN DE CHRISTIAN QUE IMPLEMENTAS (no la cuestiones, no la amplíes)

El sistema calcula edge contra DraftKings pero se apuesta en Draftea, que paga
peor. Se descuenta una constante calibrada del edge antes de que el pick pase el
gate de clasificación.

**Constante: 2.35pp (0.0235), mediana de captura simultánea Draftea/DK.
Procedencia: CALIBRADA CON n=11, rango 0.65–7.34pp, 2 de 11 con matching dudoso
por hora exacta. Fecha de medición: 2026-07-28. Recalibrar en n=30.**
Esa procedencia va LITERAL en el doc comment de la constante.

## TAREAS

### 1. Constante en configuración centralizada

En `lib/units.ts`, junto a `SPORT_THRESHOLDS` (la config de la que ya se derivan
las leyendas):

```ts
export const BOOK_SPREAD_DISCOUNT: Record<string, number> = {
  // Mediana del spread de precio Draftea vs DraftKings, en puntos de
  // probabilidad implícita. CALIBRADA CON n=11 (captura simultánea
  // 2026-07-28; rango 0.65–7.34pp; 2/11 con matching dudoso por hora
  // exacta). RECALIBRAR cuando bets.book_spread_pp acumule n>=30 —
  // trigger documentado en el scratchpad de deuda técnica.
  draftea: 0.0235,
};
```

NO la hardcodees en `lib/pickGen.ts` ni en ningún otro sitio. Un solo lugar.

### 2. Descuento en el pipeline (`lib/pickGen.ts`)

Hoy: `EDGE_THRESHOLD = 0.05` declarado DENTRO de un flatMap en
`lib/pickGen.ts:942` (no en :900). Primero sácalo a constante exportada de
módulo (`export const EDGE_THRESHOLD = 0.05;` arriba del archivo) — está
señalado como deuda que no es importable ni testeable.

Luego:
- `edge_vs_dk` = el edge bruto contra DK (lo que hoy se llama `edge` en el
  candidato).
- `edge_after_spread = edge_vs_dk - BOOK_SPREAD_DISCOUNT.draftea`.
- **El gate de selección consume `edge_after_spread`**: el sitio principal
  (`:942`/`:964`), el guard de `odds<1.4 && edge<0.05` (`:1171`), y el gate de
  legs de parlay (`:1245`) y de parlay total (`:1272`).
- NO toques `lib/learning.ts` (etiquetas `edge_over_5` etc. siguen con el bruto
  — comparabilidad histórica).
- NO toques `lib/pickAudit.ts` (sus checks son contra consenso de mercado, otra
  métrica).
- La UI y Telegram siguen mostrando lo que ya muestran. Sin cambios de display.

### 3. Persistencia en `picks` — ambos campos, sin sobrescribir nada

Migración nueva `supabase/migrations/20260728130000_draftea_spread_discount.sql`:

```sql
alter table picks add column if not exists edge_vs_dk numeric;
alter table picks add column if not exists edge_after_spread numeric;
alter table bets  add column if not exists book_spread_pp numeric;
comment on column picks.edge_vs_dk is 'Edge bruto vs DraftKings al análisis. No se reescribe.';
comment on column picks.edge_after_spread is 'edge_vs_dk - BOOK_SPREAD_DISCOUNT (2.35pp, n=11, 2026-07-28).';
comment on column bets.book_spread_pp is 'Spread observado del ticket: (1/odds_at_bet - 1/original_odds)*100. Muestra para recalibrar.';
-- Reversible: drop column en cada caso.
```

En el INSERT de picks (`lib/pickGen.ts:1336-1387`) persiste ambos. En el UPDATE
del re-análisis del lock-in (`:1834-1859`) refresca ambos igual que se refresca
`edge`. **El campo `edge` existente NO cambia de semántica ni se toca su
escritura** — el bug conocido de que `confirm` lo reescribe se arregla aparte,
no aquí.

### 4. Etapa 3 — acumular la muestra del spread

En `app/api/bets/from-image/confirm/route.ts`, donde ya se tiene el leg matched
y su pick (~`:194-230` y el INSERT vía `place_bet_atomic` en `:326-345`): tras
colocar el bet con éxito, si el pick tiene `original_odds` y el ticket trae
momio, escribe en el bet recién creado:

```
book_spread_pp = (1/odds_ticket - 1/original_odds) * 100
```

(UPDATE por id del bet devuelto; si `original_odds` es NULL, deja NULL — nunca
0). Positivo = Draftea paga peor. Es la muestra que dispara la recalibración en
n>=30.

## LÍMITES

- NO despliegues, NO corras `supabase db push`, NO commitees. El lead integra.
- NO toques nada fuera de: `lib/units.ts`, `lib/pickGen.ts`,
  `app/api/bets/from-image/confirm/route.ts`, la migración nueva.
- El lead está editando en paralelo `app/api/cron/analyze/route.ts`, las rutas
  de bets/bankroll (gates de kill switch) y una migración
  `20260728120000_kill_switch.sql`. Por eso tu confirm/route.ts puede chocar al
  integrar: mantén tu edición ahí MÍNIMA y localizada.

## PASS/FAIL

PASS = `npx tsc --noEmit` limpio y `npx next build` limpio en tu worktree, y un
resumen final con: archivos tocados, líneas exactas de cada gate cambiado, y el
diff de la migración. FAIL = cualquiera de los dos comandos falla.

Tu reporte final NO lo ve Christian — lo integra el lead. Sé concreto: lista de
hunks, no prosa.
