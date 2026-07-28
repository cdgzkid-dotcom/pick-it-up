# DISEÑO — Etapa 2: checkpoint humano de precio Draftea

> ⚠️ **SUPERSEDIDO EN PARTE — decisión de Christian del 28-jul (Opción C + momio
> mínimo).** Lo vigente:
> - La fórmula del mínimo es **`1.05 / real_probability`** (preserva EV ≥ +5%,
>   `p × odds ≥ 1.05`), redondeada a 2 decimales HACIA ARRIBA — **no** la
>   `1/(p − 0.05)` propuesta abajo (que preservaba edge aditivo; barra distinta).
>   El 1.05 es heredado del EDGE_THRESHOLD de 5%, no calibrado.
> - El bloque en Telegram se implementa YA (no "con el rediseño"), sin persistir
>   `min_acceptable_odds` — display solamente.
> - Los gates de generación vuelven al edge BRUTO contra DK (la constante 2.35pp
>   no gatea nada; es contexto "neto estimado" en la notificación).
>
> El resto del documento se conserva como razonamiento de diseño (la idea del
> checkpoint humano, la métrica de disciplina, la interacción con la Fase 6).

Fecha original: 2026-07-28.

## LA IDEA EN UNA LÍNEA

El flujo real ya incluye que Christian vea el precio de Draftea en la app antes de
apostar. Si la notificación del pick le dice **el momio mínimo aceptable**, el spread
de ESE juego lo evalúa él con el dato en pantalla — sin API de Draftea, sin scraping,
sin violar los ToS. La limitación se convierte en un checkpoint humano barato, que
además es la Auditoría 1 (pre-bet checklist) que lleva meses en deuda.

## QUÉ CAMBIA EN LA NOTIFICACIÓN

Hoy el mensaje de Telegram muestra el pick, tier, momio DK y unidades. Se agrega un
bloque:

```
💰 Edge vs DK: 7.2% @ 1.95
✅ Apostable en Draftea si paga ≥ 1.90
❌ Si Draftea paga menos de 1.90 → NO BET
```

## LA ARITMÉTICA

En el momento del análisis se conocen `real_probability` (p) y el umbral de edge del
pick. El momio mínimo en Draftea que preserva el edge objetivo es:

```
min_odds_draftea = 1 / (p − EDGE_THRESHOLD)
```

Ejemplo: p = 0.58, umbral 5% → min_odds = 1/0.53 = **1.887** → se notifica "≥ 1.89"
(redondeo hacia arriba a 2 decimales, el formato de display de Draftea).

**Punto clave — la interacción con la Etapa 1:** cuando Christian verifica el precio
real, la constante de 2.35pp deja de aplicar a ese juego. La constante existe porque en
generación no sabemos qué pagará Draftea; el checkpoint reemplaza la estimación con el
dato. Por eso el mínimo se calcula con `EDGE_THRESHOLD` **sin** descuento:

- **Generación** (sin dato de Draftea): gate conservador con
  `edge_after_spread ≥ EDGE_THRESHOLD` — ya en producción.
- **Ejecución** (con dato en pantalla): checkpoint exacto con
  `1/(p − EDGE_THRESHOLD)` — el precio real sustituye a la constante.

Un pick puede pasar el gate y aun así fallar el checkpoint ese día (spread peor que
2.35pp), o al revés no: el gate ya filtró antes. El checkpoint solo puede rechazar,
nunca rescatar — mantiene la asimetría conservadora.

## QUÉ SE PERSISTE

| campo | tabla | por qué |
|---|---|---|
| `min_acceptable_odds` | `picks` | Congela el checkpoint del análisis. Auditable: ¿la apuesta respetó su propio mínimo? |
| (ya existe desde Etapa 3) `book_spread_pp` | `bets` | El ticket revela qué pagó Draftea de verdad; cruza contra el mínimo. |

Con ambos, una query responde: **¿cuántas apuestas se colocaron por debajo de su
mínimo declarado?** Esa es la métrica de disciplina del checkpoint — y es la parte de
la Auditoría 1 que ningún checklist manual puede falsear después.

## POR QUÉ TIER NO SE RECALCULA EN EL CHECKPOINT

Alternativa considerada y descartada: que el mensaje diga "si paga ≥ Y1 es STRONG, si
paga entre Y2 y Y1 es VALUE…". Descartada porque hoy el tier depende de probabilidad,
no de precio (eso cambia justo en la Fase 6 del rediseño), y porque un checkpoint con
una sola línea roja se ejecuta; uno con tabla de casos se ignora. Cuando la Fase 6
mueva los tiers a EV, este diseño se revisa: ahí sí el mínimo por tier es natural
(`min_odds(tier) = 1/(p − umbral_EV_tier)`).

## IMPLEMENTACIÓN (cuando se apruebe, ~half day)

1. Migración: `picks.min_acceptable_odds numeric` (reversible: drop column).
2. `lib/pickGen.ts`: calcular y persistir en el INSERT del pick (y refresh de lock-in).
3. `lib/telegram.ts`: el bloque de 3 líneas en el formato del pick.
4. Sin cambios de UI web en esta etapa (el flujo de apuesta real pasa por Telegram).

Dependencias: ninguna del rediseño — puede ir antes o en paralelo a la Fase 1.
Regla de siempre: migración primero, deploy después.

## LO QUE ESTE DISEÑO NO HACE

- No captura el lado contrario de Draftea (eso sigue NO VERIFICABLE sin captura
  manual; el de-vig de Draftea queda para cuando haya muestra del protocolo W1 §3).
- No automatiza la decisión: el checkpoint es deliberadamente humano.
- No toca el gate de generación ni la constante de la Etapa 1.
