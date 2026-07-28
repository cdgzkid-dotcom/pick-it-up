# BRIEF S2 — Revertir gates a edge bruto + momio mínimo en Telegram

Trabajas en un worktree aislado del repo `pick-it-up`. HEAD base: `d502327`.
Decisión de Christian del 28-jul (Opción C + momio mínimo por pick). Implementa
exactamente esto, nada más.

## CONTEXTO

En `ef4632e` se cambiaron 4 gates de selección para consumir
`edge_after_spread = edge − BOOK_SPREAD_DISCOUNT.draftea`. Christian decidió
revertir eso: **el gate vuelve al edge bruto contra DK (5%), y la constante de
2.35pp pasa a ser solo contexto informativo en la notificación.** El checkpoint
del spread real lo hace Christian mirando el precio de Draftea en la app, con un
momio mínimo calculado en el mensaje.

## TAREA 1 — Revertir los 4 gates a edge bruto (`lib/pickGen.ts`)

Estado actual (post-`ef4632e`, líneas aproximadas):
- Gate principal (~L976-990): compara `bestEdgeAfterSpread < EDGE_THRESHOLD` →
  **vuelve a comparar el edge bruto** (`bestEdge < EDGE_THRESHOLD`).
- Guard de momio corto (~L1192): `p.edge_after_spread < 0.05` → vuelve a
  `p.edge < 0.05`.
- Gate de legs de parlay (~L1266): `p.edge_after_spread >= 0.03` → vuelve a
  `p.edge >= 0.03`.
- Gate de parlay total (~L1294-1297): vuelve a comparar `edge` contra 0.05.

**LO QUE NO SE REVIERTE:**
- `EDGE_THRESHOLD` sigue siendo constante de módulo exportada (la extracción del
  flatMap se queda).
- El cálculo y la persistencia de `edge_vs_dk` y `edge_after_spread` en el
  candidato, en el INSERT de picks y en el refresh del lock-in **se quedan tal
  cual**. Solo cambia qué consume el gate.
- `BOOK_SPREAD_DISCOUNT` en `lib/units.ts` se queda (lo consume la Tarea 2).
- El logging del gate puede seguir reportando ambos números.

No hay ningún gate en la clasificación de tier que revertir
(`tierFromProbability` nunca se tocó) — verifícalo y dilo en tu reporte.

## TAREA 2 — Momio mínimo por pick en la notificación de Telegram

### 2a. Helper puro en `lib/units.ts` (junto a BOOK_SPREAD_DISCOUNT)

```ts
/**
 * Minimum decimal odds at which a pick is still worth taking at the
 * execution book. 1.05 preserves the original +5% EV bar
 * (p × odds >= 1.05). That 5% is INHERITED from EDGE_THRESHOLD, not
 * calibrated — documented per Christian's decision 2026-07-28.
 * Rounds UP to 2 decimals (conservative: never understate the bar).
 */
export const minAcceptableOdds = (realProbability: number): number =>
  Math.ceil((1.05 / realProbability) * 100 - 1e-9) / 100;
```

⚠️ **El `- 1e-9` es obligatorio.** Sin él, la flotante mata el caso canónico:
`1.05/0.60 = 1.7500000000000002` → `Math.ceil` sin epsilon da **1.76**, y el
resultado correcto es **1.75**. Con epsilon: 0.60 → 1.75 ✓ y 0.57 →
1.8421… → **1.85** ✓ (el redondeo hacia arriba se conserva donde debe).

### 2b. Bloque en el mensaje de pick (`lib/telegram.ts`)

En el formato de pick individual (la función que arma el mensaje por pick,
~`lib/telegram.ts:352-409`), agrega:

```
💰 Edge vs DK: 5.2% · Neto estimado: ~2.9pp
✅ Apuesta SOLO si Draftea paga ≥ 1.75
```

- `Edge vs DK` = el edge bruto del pick (×100, 1 decimal).
- `Neto estimado` = `(edge − BOOK_SPREAD_DISCOUNT.draftea) × 100`, 1 decimal,
  con `~` delante (es estimación con la constante n=11, no medición del juego).
- Momio mínimo = `minAcceptableOdds(real_probability)`, 2 decimales.
- Si `real_probability` no está disponible en ese formato, omite el bloque
  entero (no inventes, no pongas 0) y repórtalo.

Aplícalo también al formato de parlay **solo si** la probabilidad combinada ya
está disponible ahí (sería `minAcceptableOdds(prob_combinada)` contra el momio
total). Si no está disponible de forma directa, déjalo solo en singles y
repórtalo — no refactorices para conseguirla.

No toques ningún otro mensaje (results, digest, calibración, observación).

## TAREA 3 — Verificación (obligatoria antes de reportar)

1. Los dos casos canónicos, ejecutados de verdad (script node con la fórmula
   exacta del helper, o como puedas ejecutarla):
   - `minAcceptableOdds(0.60)` → **1.75** (no 1.76)
   - `minAcceptableOdds(0.57)` → **1.85** (no 1.84)
2. `npx tsc --noEmit` limpio.
3. `npx next build` limpio.

## LÍMITES

- NO despliegues, NO `supabase db push` (no hay migración en este cambio), NO
  commitees. El lead integra.
- Archivos permitidos: `lib/pickGen.ts`, `lib/units.ts`, `lib/telegram.ts`.
- Cero cambios de esquema. Cero cambios en UI web.

## REPORTE FINAL

Lista de hunks por archivo con líneas exactas; el output literal de los dos
casos canónicos; el resultado de tsc y build; y confirmación explícita de que
tier classification no tenía nada que revertir.
