# W1 — CLV e instrumentación de precios

Worker: Claude (lead). HEAD `b833d98`. Fecha: 2026-07-28.
Verificaciones en vivo: **2026-07-28T16:55:21Z** (ESPN core API) y
**2026-07-28T16:57:55Z** (superficie pública de Draftea).
Contra Supabase: solo `SELECT` (vía Management API `/database/query`, token del
Supabase CLI en el llavero de macOS). Cero writes fuera de `.fase0/`.

---

## VEREDICTO: **A) ARTEFACTO CROSS-BOOK**

El campo `bets.odds_at_bet` **no es un precio de DraftKings**. Es el momio que
Claude Vision leyó de un **screenshot de la app de DRAFTEA**. `bets.odds_at_close`
sí es el cierre de DraftKings vía ESPN. Por lo tanto:

> **El `clv` almacenado mide el spread Draftea↔DraftKings, no movimiento de línea.**

No es una inferencia. La cadena está cerrada por código *y* por datos:

| evidencia | resultado |
|---|---|
| Los 36 bets con CLV posteriores a que existiera `ai_usage_log` (2026-05-15) | **36/36** tienen una extracción `vision_extract_bet_tg` (ticket de Draftea) inmediatamente antes |
| `picks.odds_decimal` reescrito ↔ `bets.created_at` | 35 filas, brecha **59–592 ms** (media 206 ms) |
| En esas 35 filas, `odds_at_bet` == `picks.odds_decimal` reescrito | **35/35** |
| `odds_at_close` a ±0.005 de `original_odds` (DK@análisis) | **14/39** (9 exactamente iguales) |
| `odds_at_close` a ±0.005 de `odds_at_bet` | **0/39** |
| Triggers de usuario sobre `picks` o `bets` en producción | **0** (catálogo consultado) |

La última fila del cuadro es la prueba de "misma casa": si `odds_at_bet` y
`odds_at_close` salieran del mismo libro, coincidirían de vez en cuando. Nunca
coinciden. `odds_at_close` sí coincide con `original_odds` en 14 de 39 casos —
porque **ambos son DraftKings**.

### Descomposición del CLV (n=41 con `original_odds`)

```
CLV = [ (1/close_DK) − (1/precio_Draftea) ]
    = [ (1/DK@análisis) − (1/Draftea) ]  +  [ (1/close_DK) − (1/DK@análisis) ]
       └── brecha cross-book ──┘            └── movimiento real de mercado ──┘
```

| componente | n=41 (todos) | n=39 (sin los 5 fallback) |
|---|---|---|
| CLV total almacenado | **−1.003 pp** | −1.054 pp |
| brecha cross-book (Draftea vs DK) | **−0.985 pp** | −1.010 pp |
| **movimiento real DK (análisis→cierre)** | **−0.018 pp** | −0.045 pp |

El movimiento real de DraftKings es **−0.018 pp con sd 0.822 pp**: ruido puro.
DK se alargó en 11 casos, se acortó en 19, quedó igual en 9 — moneda al aire.
**El 98% del "CLV" es la brecha de precio entre casas.** El hecho central del
brief queda confirmado y ahora además explicado.

Reconcilio con el inventario del 27-jul: ratio `odds_at_bet`/`original_odds`
= **0.98073, sd 0.0174** (idéntico). "Más corto en 34 de 41" es correcto **con
tolerancia ±0.005**; en estricto son 36 de 41 (3 más largo, 2 empate exacto).
Es la misma medición, no una contradicción.

---

## 1. Traza de cada campo (`archivo:línea`)

### 1.1 `picks.original_odds` — **DraftKings vía ESPN, congelado al análisis**

- **Quién**: `lib/pickGen.ts:1781` → `original_odds: row.odds_decimal`, dentro
  del INSERT del lock-in CAPA-2 (`lib/pickGen.ts:1775-1789`), junto con
  `locked_at: now` (`:1779`) y `lock_reason: 'first_analysis'` (`:1783`).
- **Cuándo**: en el primer análisis de un `espn_event_id`. Nunca se vuelve a
  escribir: la rama `update` del lock-in (`lib/pickGen.ts:1834-1856`) refresca
  `odds_decimal` pero **no** `original_odds`. Es el único campo de precio
  verdaderamente congelado.
- **Qué casa**: `row.odds_decimal` proviene de `dk_odds`
  (`lib/pickGen.ts:886`), producido por `fetchEspnGameOdds()`
  (`lib/espn.ts:657-698`) sobre el endpoint core de ESPN. Confirmado en datos:
  `best_odds_source = 'DraftKings'` en **41 de 41** picks con CLV
  (los 3 restantes son pre-lock-in y tienen `best_odds_source` NULL).
  `best_odds == original_odds` fila por fila.
- **Fallback**: si no hay `dk_odds` con ambos lados, el pick se descarta antes
  (`lib/pickGen.ts:889-916`, contador `fail_no_dk_odds`). No hay ruta de
  fallback que meta otra casa en `original_odds`.

### 1.2 `picks.odds_decimal` — **QUÉ lo reescribe (respuesta)**

**Lo reescribe `app/api/bets/from-image/confirm/route.ts:214-224`, con el precio
del ticket de DRAFTEA leído por Claude Vision.** No es un trigger.

Flujo completo, en orden:

1. Christian manda una foto del ticket de Draftea al bot de Telegram.
2. `lib/vision-extract-bet.ts:103` `extractDrafteaBet()` — prompt de sistema en
   `lib/vision-extract-bet.ts:51`: *"extractor de datos de tickets de apuestas de
   DRAFTEA"*, `:54` *"DRAFTEA usa momios DECIMALES europeos"*. Se registra en
   `ai_usage_log` con `task_type='vision_extract_bet_tg'`.
3. `lib/bet-matching.ts:60-87` empareja cada leg contra `picks` con
   `status='pending'` de los últimos 7 días.
4. `app/api/telegram/webhook/route.ts:198-214` arma el payload de confirmación:
   `odds_changed = |leg.odds_decimal − pick.odds_decimal| > 0.005`
   (`:200-201`), `original_odds: pickOdds` (`:213`).
5. Christian pulsa "✅ Confirmar" → `POST /api/bets/from-image/confirm`.
6. **Paso 1 del handler** (`confirm/route.ts:196-231`): para cada leg con
   `odds_changed`, `UPDATE picks SET odds_decimal = <precio Draftea>,
   implied_probability = 1/<precio Draftea>, edge = real_probability − implied,
   updated_at = now()`. **No toca `original_odds`, ni `reanalysis_count`, ni
   `lock_reason`.**
7. **Paso 3a** (`confirm/route.ts:326-345`): `place_bet_atomic` con
   `p_odds_decimal: data.total_odds_decimal` (`:337`) — otra vez el precio
   Draftea.

Los ~137 ms son exactamente el intervalo entre el paso 6 y el paso 7 (dos
llamadas HTTP consecutivas a PostgREST desde el mismo handler serverless).
Medido: **59–592 ms, media 206 ms, n=35**.

Historia del código: la escritura existe desde `f64103f` (2026-05-14, feature
de visión); `3434e68` (2026-05-20) le agregó `implied_probability` y `edge`. Los
bets con brecha sub-segundo empiezan **exactamente el 2026-05-20**.

> El segundo reescritor, distinto y no implicado en estos 44 bets:
> `lib/pickGen.ts:1835` (`refreshFields.odds_decimal`) en el re-análisis del
> lock-in. **No participó aquí**: los 44 picks tienen
> `reanalysis_count = 0` y `lock_reason = 'first_analysis'`.

**Descarte formal de la hipótesis "trigger o función fuera de migraciones"**
(consultado el catálogo real, no las migraciones):

- `information_schema.triggers`: el único trigger de usuario en `public` es
  `trg_leads_updated_at` sobre `leads`. Cero sobre `picks` o `bets`.
- `pg_trigger` crudo (incl. internos): sobre `picks` y `bets` solo hay
  `RI_ConstraintTrigger_*` de integridad referencial (`tgisinternal = true`).
- `pg_rules` en `public`: **vacío**.
- `pg_proc` en `public`: exactamente 4 funciones —
  `place_bet_atomic`, `resolve_bet_atomic`, `adjust_bankroll_atomic`,
  `update_updated_at`. Ninguna otra.
- `pg_get_functiondef(place_bet_atomic)` desplegado es **idéntico** al del repo
  (`supabase/migrations/20260727120000_preseason_observation_only.sql:40-121`).
  No hay divergencia repo↔producción esta vez.
- `picks.updated_at` tiene `DEFAULT now()` pero **no** trigger de update: solo
  cambia cuando la aplicación lo escribe explícitamente. Eso es lo que hace que
  `updated_at` sea un reloj fiable del paso 6.

El antecedente de `retroactive_schema_sync` no se repitió: aquí el culpable
siempre estuvo en el repo, en TypeScript, no en la base.

### 1.3 `bets.odds_at_bet` — **precio de DRAFTEA (screenshot)**

- **Quién**: `place_bet_atomic`, `supabase/migrations/20260727120000_preseason_observation_only.sql:97`
  y `:103` → `odds_at_bet` recibe literalmente `p_odds_decimal`. Nadie más
  escribe la columna en todo el repo (`grep odds_at_bet`: solo lecturas).
- **Cuándo**: en el INSERT del bet. Nunca se actualiza después.
- **Qué casa, según el llamador**:
  - `app/api/bets/from-image/confirm/route.ts:337` →
    `data.total_odds_decimal` = total del ticket de **Draftea**.
    **Es la ruta real de los 44 bets con CLV.**
  - `app/api/bets/route.ts:98` → `fields.odds_decimal` del cliente web. Como el
    UI ofrece el `odds_decimal` del pick, aquí sería DK — pero ninguno de los 44
    bets con CLV vino por ahí (ver evidencia de `ai_usage_log` abajo).
- **Error/fallback**: ninguno. Si el RPC falla, no hay fila.

Corroboración independiente de que la ruta fue Draftea, además del intervalo de
137 ms:

| grupo | n | con extracción de ticket Draftea previa | brecha `picks.updated_at`→`bets.created_at` |
|---|---|---|---|
| confirm SÍ reescribió `odds_decimal` | 35 | 33 en ≤5 min, **35 en ≤2 h** | 59–592 ms |
| confirm NO reescribió (Δ ≤ 0.005) | 6 | 1 en ≤30 min (los otros 5 son anteriores a que existiera `ai_usage_log`) | 97 s – 34 min |
| sin `original_odds` (pre lock-in, 10–11 may) | 3 | 0 (tabla aún no existía) | 26 s – 4.2 h |

Y una huella de precisión: **`odds_at_bet` tiene ≤2 decimales en 44/44**, mientras
que `original_odds` tiene 3 decimales en 18/41. Las 4 filas donde el confirm *no*
reescribió pero `odds_at_bet ≠ picks.odds_decimal` difieren exactamente por
redondeo del display de Draftea: 1.769→**1.77**, 1.671→**1.67**, 1.641→**1.64**.
Ese es el umbral de `> 0.005` de `webhook/route.ts:201` dejando pasar el
redondeo, y el ticket imponiendo su propio formato de 2 decimales.

### 1.4 `bets.odds_at_close` — **cierre de DraftKings vía ESPN**

- **Quién** (dos rutas, misma lógica):
  - `app/api/cron/analyze/route.ts:829-857` (ruta principal, `runResultsCheck`)
    → RPC en `:862-873` con `p_odds_at_close: oddsAtClose` (`:870`).
  - `app/api/check-results/route.ts:152-186` → RPC en `:198-208` (`:205`).
  - Persistencia: `resolve_bet_atomic` desplegado,
    `odds_at_close = coalesce(p_odds_at_close, odds_at_close)`
    (`supabase/migrations/20260512050001_atomic_resolve_bet.sql:55`).
- **Endpoint**: `lib/espn.ts:797` →
  `https://sports.core.api.espn.com/v2/sports/{coreSport}/leagues/{coreLeague}/events/{id}/competitions/{id}/odds`,
  campo `close.moneyLine.decimal` del primer proveedor no-*live*
  (`lib/espn.ts:801-816`).
- **Qué casa**: verificado **en vivo 2026-07-28T16:55:21Z** contra los 3 bets con
  CLV más recientes. En los tres, el array `items` trae **un solo proveedor:
  `DraftKings`**, y su `close` reproduce exactamente el valor almacenado:

  | `espn_event_id` | `odds_at_close` guardado | ESPN `close` (proveedor) | `original_odds` | `odds_at_bet` |
  |---|---|---|---|---|
  | 401815920 | 1.67 | 1.67 (**DraftKings**, away) | 1.641 | 1.64 |
  | 401815837 | 1.85 | 1.85 (**DraftKings**, home) | 1.855 | 1.83 |
  | 401815755 | 1.75 | 1.75 (**DraftKings**, away) | 1.758 | **1.71** |

  El evento 401815755 es el caso didáctico: DK abrió 1.67, al análisis estaba en
  1.758 y cerró en 1.75 — se movió **−0.008**, nada. Draftea, en el mismo
  momento, pagaba **1.71**: **2.7% más corto**. Todo el "CLV negativo" de esa
  apuesta es el spread entre casas.

- **Camino de error / fallback (importante)**: si ESPN no devuelve cierre, o el
  bet no es ML, o no se pudo identificar el lado, **`odds_at_close` se rellena
  con `odds_at_bet`** y el CLV sale exactamente 0
  (`analyze/route.ts:840`, `check-results/route.ts:176-178`). Hoy hay **5 de 44
  filas** así — indistinguibles de una línea que no se movió, porque el campo
  `source` que sí distingue (`'espn_close'` vs `'fallback_no_data'`) **solo va al
  `console.log`** (`analyze/route.ts:842-850`), no a la base.
  El `catch` es peor: fija `clv = 0` explícitamente (`analyze/route.ts:854-856`).
- Resolución manual (`app/api/bets/[id]/route.ts:79`) y los `push`
  (`analyze/route.ts:799`, `check-results/route.ts:125`) pasan
  `p_odds_at_close: null` → nunca hay cierre. 35 de 79 bets no tienen CLV
  (5 parlays, spread/total, y los sin `espn_event_id`).

---

## 2. La hipótesis principal: **CONFIRMADA**

> *"`odds_at_bet` es precio de DRAFTEA y `odds_at_close` es cierre de
> DRAFTKINGS"*

**Confirmada con evidencia directa**, resumida arriba y sostenida por cuatro
patas independientes:

1. **Código** — `confirm/route.ts:337` pasa el total del ticket de Draftea a
   `place_bet_atomic`, que lo copia tal cual a `odds_at_bet`
   (`20260727120000_preseason_observation_only.sql:103`). El cierre viene de
   `fetchEspnClosingLine` (`lib/espn.ts:773-835`), proveedor DraftKings.
2. **Timing** — 35/35 bets llevan una reescritura de `picks.odds_decimal` entre
   59 y 592 ms antes del INSERT, y esa reescritura solo puede venir de
   `confirm/route.ts:221-224` (cero triggers en el catálogo; `POST /api/bets` no
   toca `odds_decimal`).
3. **Trazabilidad de la extracción** — 36/36 bets posteriores a 2026-05-15
   tienen una llamada `vision_extract_bet_tg` (ticket Draftea) previa.
4. **Firma numérica** — `odds_at_bet` siempre a 2 decimales; nunca coincide con
   `odds_at_close` (0/39) mientras `original_odds` sí (14/39, 9 exactos).

**Consecuencia**: el `clv` de las 44 filas **no debe interpretarse como señal de
mercado**. Mide, en su 98%, cuánto peor paga Draftea que DraftKings.

### Lo que esto NO dice

- **No** dice que el sistema no tenga edge. Dice que el CLV medido no sirve para
  saberlo.
- **No** contradice la hipótesis muerta #2 del brief: `odds_at_close` **sí** es
  cierre real de DraftKings. Lo que estaba mal no era el cierre — era la
  apertura.
- La brecha **no es puro margen estructural**: incluye 0–37 min (media 5.7) de
  deriva de línea entre el análisis y la captura del ticket. Está acotada por
  arriba porque el movimiento total DK análisis→cierre es −0.018 pp; el
  componente de deriva dentro de la primera media hora es una fracción de eso.
  **NO VERIFICABLE** la separación exacta margen-vs-deriva sin capturas
  simultáneas (§3).

---

## 3. Prueba empírica (para medir la magnitud, no para decidir el veredicto)

El código ya cierra el veredicto. Esta prueba sirve para **cuantificar el
spread estructural por deporte y por rango de precio**, que es lo que hace falta
para calibrar el `EDGE_THRESHOLD`.

### ¿Existe API de Draftea? ¿el repo la toca?

- **El repo NO la toca.** Cero llamadas HTTP a cualquier host de Draftea. La
  única vía de entrada de precios de Draftea es Claude Vision sobre screenshots
  (`lib/vision-extract-bet.ts:103`). Verificado con `grep -ri draftea` sobre
  `lib app components db supabase`: todas las coincidencias son visión,
  matching, normalización de texto y `draftea_ticket_id`.
- **Superficie pública** (probado 2026-07-28T16:57:55Z, solo GET):
  `www.draftea.com` → 301 → `www.draftea.mx` (200, HTML).
  `api.draftea.com` → **404 con `content-type: application/json`** (el host
  existe y responde JSON, pero no expone raíz).
  **NO VERIFICABLE** si hay un endpoint de momios utilizable sin autenticarse:
  determinarlo requiere inspeccionar el tráfico XHR de la app/web con sesión
  iniciada, que no puedo hacer desde aquí y que además cae fuera del "solo GET"
  de esta fase. **Asume captura manual.**

### Protocolo (reproducible por Christian, sin mí)

**Duración**: ~25 min. **Cuándo**: T−45 a T−20 min del primer juego de la noche
(es la ventana en que el sistema genera y en que él apuesta).

1. Elige **6–8 juegos MLB del mismo día** que ya tengan momios en Draftea.
   Anota el `espn_event_id` de cada uno (aparece en `picks.espn_event_id`, o en
   la URL de ESPN del partido).
2. Abre la app de Draftea en el teléfono y ESPN en la laptop, **lado a lado**.
3. Para **cada juego, en menos de 60 segundos**:
   a. Screenshot de Draftea con el ML de **ambos** equipos visible.
   b. En la laptop, ejecutar (reemplazando `<ID>`):

      ```bash
      curl -s "https://sports.core.api.espn.com/v2/sports/baseball/leagues/mlb/events/<ID>/competitions/<ID>/odds" \
        | python3 -c "import json,sys;d=json.load(sys.stdin)
      for o in d.get('items',[]):
          p=(o.get('provider') or {}).get('name')
          h=(o.get('homeTeamOdds') or {}); a=(o.get('awayTeamOdds') or {})
          print(p, 'home_ml=',h.get('moneyLine'), 'away_ml=',a.get('moneyLine'))"
      ```
   c. Anota la **hora UTC** (`date -u`) de las dos capturas.
4. Registrar en una tabla: `event_id, hora_utc, draftea_home, draftea_away,
   dk_home, dk_away`. Convertir americano→decimal con
   `d = 1 + am/100` si `am>0`, `d = 1 + 100/|am|` si `am<0`
   (misma fórmula que `americanToDecimal` en `lib/espn.ts`).
5. Para cada juego calcular:
   - `overround_draftea = 1/dr_home + 1/dr_away`
   - `overround_dk = 1/dk_home + 1/dk_away`
   - `ratio_home = dr_home / dk_home`, `ratio_away = dr_away / dk_away`
   - probabilidades **de-vigged** de ambos lados en ambas casas:
     `p_devig = (1/odds) / overround`

### Qué confirma y qué mata cada hipótesis

| resultado | lectura |
|---|---|
| `overround_draftea` − `overround_dk` ≈ **+0.04** (Draftea ~1.09 vs DK ~1.048), y `p_devig` casi idénticas en ambas casas | **Margen estructural puro.** Draftea cobra más vig sobre la misma opinión. Es el resultado esperado dado el veredicto A. Acción: subir `EDGE_THRESHOLD` (§5) y medir CLV solo contra DK. |
| Overrounds parecidos pero `p_devig` sistemáticamente distintas | Draftea tiene **opinión propia** distinta de DK. La brecha no es margen sino desacuerdo → hay que decidir contra qué mercado se mide el edge, y hay valor real en apostar los lados donde Draftea discrepa a favor. |
| `ratio_home` y `ratio_away` ambos ≈ **0.98** de forma consistente | Confirma el −2% como constante estructural aplicable a los dos lados. Se puede hardcodear un `BOOK_HAIRCUT` y compensarlo. |
| Los ratios se dispersan mucho (uno 0.95, el otro 1.02) | El −2% promedio esconde estructura por lado/precio. Necesita modelo por rango de precio, no una constante. |
| `ratio` ≈ **1.00** en todos los juegos | **Mataría** la interpretación de margen estructural y obligaría a atribuir la brecha de −0.985 pp a la deriva de línea en los 5.7 min medios entre análisis y captura. Sería inconsistente con el movimiento DK total de −0.018 pp — así que si sale esto, sospechar del protocolo antes que del dato. |

Mínimo útil: **6 juegos × 2 lados = 12 observaciones**. Con la sd observada del
ratio (0.0174), 12 observaciones dan un error estándar de ~0.005 sobre la media
del ratio — suficiente para distinguir 0.98 de 1.00.

---

## 4. Cómo medir CLV bien

### 4.1 Contra qué precio y de qué casa

**Regla: el CLV debe comparar el mismo libro consigo mismo.**

- **Precio de referencia (apertura de la medición)**: `picks.original_odds` —
  DraftKings al momento del análisis, congelado por el lock-in
  (`lib/pickGen.ts:1781`). Es el único precio hoy que no se reescribe.
- **Precio de cierre**: `close.moneyLine.decimal` de **DraftKings** vía ESPN
  (`lib/espn.ts:797`), que ya es lo que se guarda.
- **`odds_at_bet` (Draftea) NO entra en el CLV.** Es un dato valiosísimo, pero
  de otra métrica.

Esto parte la medición actual en dos, que hoy están sumadas y confundidas:

```
clv_market   = (1/close_DK) − (1/original_odds_DK)    ← ¿el mercado se movió a mi favor?
book_gap     = (1/odds_at_bet) − (1/original_odds_DK) ← ¿cuánto me cuesta apostar en Draftea?
```

Nótese que `clv_actual = clv_market − book_gap`. Hoy el sistema reporta esa
resta como si fuera solo el primer término.

### 4.2 ¿De-vigged o bruto? — **De-vigged, y aquí está el porqué**

El brief ya mató "es artefacto de vig" para explicar la brecha, y es correcto:
el overround es 1.0480 al abrir y 1.0484 al cerrar, así que el vig **no explica
el −0.985 pp**. Pero eso es un argumento sobre el *diagnóstico*, no sobre la
*métrica futura*. Para la métrica:

- **`clv_market` (DK vs DK): de-vigged.** Con overround idéntico entre puntas,
  bruto y de-vigged dan casi lo mismo hoy — pero "casi" es una propiedad
  accidental de la muestra actual, no una garantía. En cuanto el vig se mueva
  (juegos de mayor liquidez, otros deportes, otros mercados), el CLV bruto
  empezaría a registrar cambios de margen como si fueran movimiento de línea.
  De-viggear cuesta una división y elimina la clase entera de error.
  Es computable: `fetchEspnClosingLine` **ya devuelve ambos lados**
  (`lib/espn.ts:827-834`), y `fetchEspnGameOdds` también
  (`lib/espn.ts:691-694`). Hoy simplemente se descarta el lado contrario.
- **`book_gap` (Draftea vs DK): de-vigged obligatorio.** Aquí el vig **sí** es
  el sospechoso principal: si Draftea cobra más margen, comparar precios brutos
  entre casas mezcla margen con opinión. De-viggear ambos lados separa
  "Draftea cobra más" de "Draftea piensa distinto" — que es justo la pregunta
  que decide si el −2% se puede compensar con más edge o si hay que cambiar de
  casa. Requiere capturar el precio del **lado contrario en Draftea**, que hoy
  no se captura (el ticket solo muestra el lado apostado). Ver §4.4.

Recomendación: persistir **las dos versiones** (bruta y de-vigged) para no
tener que re-derivar histórico cuando cambie el criterio. Son 2 columnas.

### 4.3 Qué momento cuenta como "cierre"

**El `close` que publica ESPN**, que es el precio de DraftKings al inicio del
juego. Es lo que ya se usa y es correcto — pero hoy se lee **al resolver el
bet**, horas después del partido, sin registrar cuándo.

Dos correcciones:

1. **Registrar el timestamp de captura** (`odds_at_close_captured_at`). Sin él
   no hay forma de auditar si ESPN reescribió el campo, ni de distinguir un
   cierre leído a los 10 min de uno leído a los 3 días.
2. **Distinguir cierre real de fallback.** Hoy `analyze/route.ts:840` rellena
   con `odds_at_bet` y produce `clv = 0`; el discriminador (`source`) solo va al
   `console.log` (`:842-850`). **5 de 44 filas están contaminadas así.** Con la
   métrica nueva esto es peor, no mejor: un fallback debe dar `clv = NULL`, no 0.

### 4.4 Campos que hay que persistir y hoy no se persisten

Sobre `bets` (hoy: `id, created_at, pick_id, sport, game, home_team, away_team,
pick, bet_type, odds_decimal, amount, tier, result, cashout_amount, payout,
date, notes, home_team_abbr, away_team_abbr, espn_event_id, result_notified_at,
odds_at_bet, odds_at_close, clv, game_start_time, spread_line, total_line,
bet_direction, final_score, draftea_ticket_id, excluded_from_stats`):

| campo propuesto | tipo | por qué | sin él |
|---|---|---|---|
| `odds_at_bet_book` | text | Identifica la casa del precio de entrada (`'draftea'`). | Hoy hay que inferirlo cruzando `ai_usage_log` con `picks.updated_at`. Exactamente el trabajo de este brief. |
| `odds_at_bet_captured_at` | timestamptz | Momento del ticket, no del INSERT. | La deriva análisis→captura (media 5.7 min, máx 37) no se puede separar del spread. |
| `odds_at_bet_source` | text | `'draftea_vision'` / `'manual_web'`. | Las dos rutas de alta (`confirm` vs `POST /api/bets`) son indistinguibles en la fila. |
| `odds_at_bet_opposite` | numeric | Momio del lado contrario **en Draftea**. | Sin él el overround de Draftea es incalculable → §4.2 no se puede ejecutar. Requiere pedir a la visión ambos lados (`lib/vision-extract-bet.ts:75-95`). |
| `odds_at_close_book` | text | `'draftkings'` — hoy `fetchEspnClosingLine` **ya lo devuelve** (`source`, `source_slug`, `lib/espn.ts:832-833`) y se tira a la basura. | ESPN rota proveedores entre temporadas (comentado en `lib/edge.ts:38-40`). El día que rote, el CLV cambia de significado en silencio. |
| `odds_at_close_captured_at` | timestamptz | §4.3. | Sin auditoría posible del cierre. |
| `odds_at_close_source` | text | `'espn_close'` \| `'espn_american_fallback'` \| `'fallback_no_data'`. Hoy vive solo en `console.log` (`analyze/route.ts:848`). | Las 5 filas de fallback siguen siendo indistinguibles de línea inmóvil. |
| `odds_at_close_opposite` | numeric | De-vig del cierre. | `clv_market` de-vigged no es computable. |
| `reference_odds_at_bet` | numeric | DK en el mismo instante del ticket. Requiere un fetch extra a ESPN dentro de `confirm/route.ts`. | El `book_gap` se mide contra `original_odds` (hasta 37 min antes), mezclando spread con deriva. |
| `clv_market` | numeric | El CLV honesto (DK→DK). NULL si no hubo cierre real. | Es la métrica que no existe. |
| `book_gap` | numeric | El coste de Draftea, medible y monitoreable. | −0.985 pp/apuesta invisible en todos los tableros. |

Sobre `picks`, un solo campo cierra el agujero que originó todo esto:

| campo | por qué |
|---|---|
| `odds_decimal_overwritten_at` (+ `odds_decimal_overwritten_by`) | `confirm/route.ts:221-224` reescribe `odds_decimal` sin dejar rastro distinguible de un refresh del lock-in. Con estos campos, la pregunta de este brief se responde con un `SELECT`. **Alternativa preferible: que `confirm` deje de reescribir `odds_decimal` y escriba en un campo propio** (`odds_decimal_at_bet`). Reescribir el precio de análisis con el precio de otra casa es el bug de fondo — los campos de auditoría solo lo documentan. |

**Regla dura del proyecto que aplica**: migración PRIMERO, deploy DESPUÉS
(`00-CONTEXTO-COMPARTIDO.md:124-126`), y `supabase db push` aplica **todas** las
pendientes.

### 4.5 Qué hacer con las 44 filas actuales

Son recuperables sin re-capturar nada:

- `clv_market` es calculable retroactivamente **hoy**:
  `original_odds` está en `picks`, y el `close` de ESPN persiste post-partido
  (verificado en vivo con los 3 eventos de arriba, uno de ellos de mayo).
- `book_gap` también: `(1/odds_at_bet) − (1/original_odds)`, con la salvedad de
  que incluye la deriva de captura.
- Las 5 filas con `odds_at_close = odds_at_bet` deben marcarse
  `odds_at_close_source = 'fallback_no_data'` y su `clv` pasar a NULL.
- Las 3 filas del 10–11 may sin `original_odds` no son recuperables:
  **NO VERIFICABLE** cuál era el precio DK al análisis. Excluirlas.

---

## 5. El costo estructural de Draftea

**Datos reales (n=41 bets con CLV y `original_odds`):**

```
ratio  odds_at_bet / original_odds  =  0.98073   (sd 0.0174)
percentiles: p0 0.9552 | p25 0.9711 | p50 0.9772 | p75 0.9848 | p100 1.0638
precio DK medio (original_odds)     =  1.974     (rango 1.60 – 3.57)
```

Sea `r = 0.98073` el ratio de precio, `O` el precio DK, `p` la probabilidad real
y `e = p − 1/O` el edge que **el sistema calcula hoy** (`lib/edge.ts:3`, contra
la línea DK).

**(a) Coste en probabilidad implícita — el número directo**

```
coste = 1/(r·O) − 1/O = (1−r)/(r·O)
```
Promediado sobre las 41 filas reales: **0.985 pp**.
(Coincide, no por casualidad, con la brecha de captura medida: es la misma
cantidad calculada de dos formas.)

→ **El edge real obtenido es ~0.99 pp menor que el que el sistema imprime.**
Un pick que el sistema llama "5.0% de edge" es, ejecutado en Draftea, un pick
de **4.0%**.

**(b) Edge mínimo para no ser −EV en Draftea (breakeven)**

```
EV_draftea = p·(r·O) − 1 > 0   ⟺   e > (1−r)/(r·O)
```
Promedio sobre las filas reales: **0.985 pp**.
Cualquier pick con edge DK < ~1 pp es **−EV** al ejecutarlo en Draftea, aunque
el sistema lo marque como positivo. Hoy no es vinculante (el umbral es 5%), pero
lo sería de inmediato si alguien bajara el umbral "para tener más volumen".

**(c) Umbral necesario para preservar el EV que el 5% pretende**

Resolviendo `p·(r·O) − 1 = e_objetivo · O` para `e`:

```
e_requerido = e_objetivo/r + (1−r)/(r·O)
            = 0.05/0.98073 + 0.985pp
            = 5.098% + 0.985%
```
Evaluado fila por fila con los `O` reales: **6.084%**.

| precio DK | umbral requerido |
|---|---|
| 1.75 | 6.22% |
| 1.95 | 6.11% |
| 2.50 | 5.89% |
| media real (1.974) | **6.08%** |

### El número

> **`EDGE_THRESHOLD` debe pasar de 5.0% a ~6.1%** para que "5% de edge"
> signifique en la ejecución lo que hoy dice significar en el análisis.
> Redondeo operativo: **6%** (deja ~0.1 pp de holgura contra el 6.08 calculado;
> 6.25% si se quiere margen sobre la sd de 0.0174 del ratio).

**Coste actual, en dinero**: la diferencia de EV por apuesta entre ejecutar en
DK y ejecutar en Draftea, calculada con las `real_probability` reales de los 41
picks, es **2.168 puntos de ROI sobre el stake**. Con edge de 5 pp al precio
medio de 1.974, el EV teórico es ~9.9% de ROI; el realizado en Draftea ronda
7.7%. **Draftea se lleva ~22% del EV esperado del sistema.**

### Dónde está hoy y qué está desincronizado

- `EDGE_THRESHOLD = 0.05` está en **`lib/pickGen.ts:942`** — no en `:900` como
  dice el brief. (Diferencia menor, pero para que W2/W3 no busquen en el sitio
  equivocado.)
- **Está declarado dentro del cuerpo de un `flatMap`**, no como constante de
  módulo. No es importable, no es testeable, y no puede depender del deporte.
- **Ya está desincronizado de su propia documentación**: el comentario de
  `lib/pickGen.ts:246` dice *"below EDGE_THRESHOLD (2%)"* cuando el valor real
  es 5%. Es exactamente la clase de bug de `TIER_RANGE` corregido en `24af709`
  — un número escrito a mano en dos lugares que se separaron. Al tocar el
  umbral, sacarlo a constante exportada y derivar el texto, no repetirlo.
- El haircut de la casa **no aparece en ninguna parte del cálculo**. `lib/edge.ts:3`
  computa `realProb − 1/oddsDecimal` sobre el precio **DK**, y nada corrige
  después. La compensación no existe ni implícita ni explícitamente.

**Recomendación de forma** (no de valor — el valor es decisión de Christian):
en vez de subir 5.0→6.1 a mano, expresar el umbral como
`EDGE_THRESHOLD_BASE + BOOK_HAIRCUT[book]`, con `BOOK_HAIRCUT.draftea = 0.0099`
medido y re-medible con el protocolo de §3. Así el día que cambie de casa —o que
Draftea ajuste su margen— se toca un número con procedencia, no una constante
mágica.

---

## Reconciliación con el inventario del 27-jul

Todo confirmado; tres precisiones:

1. ✅ ratio 0.9807 sd 0.0174, brecha −0.985 pp, CLV −0.934 pp *(mido −1.003 pp
   sobre las 41 con `original_odds`; el −0.934 del inventario probablemente
   promedia las 44 incluyendo las 3 sin `original_odds`)*.
2. ✅ "más corto en 34 de 41" — correcto **con tolerancia ±0.005**; 36 de 41 en
   comparación estricta. Misma medición.
3. ✅ 5 de 44 filas con `odds_at_close == odds_at_bet` por fallback.
4. ⚠️ **Corrijo la sospecha de "trigger o función desplegada fuera de
   migraciones"**: no la hay. Cero triggers de usuario sobre `picks`/`bets`,
   cero rules, 4 funciones en `public` y `place_bet_atomic` desplegada idéntica
   al repo. El reescritor siempre estuvo en TypeScript
   (`confirm/route.ts:214-224`). El patrón `retroactive_schema_sync` **no** se
   repitió.
5. ⚠️ `EDGE_THRESHOLD` está en `lib/pickGen.ts:942`, no `:900`.

## Lo que queda NO VERIFICABLE

- **Separación exacta margen-vs-deriva dentro del −0.985 pp.** Acotada por
  arriba (el movimiento DK total análisis→cierre es −0.018 pp), pero no
  desglosada. Lo resuelve §3.
- **Overround de Draftea.** No se captura el lado contrario del ticket. Sin él
  no hay de-vig de Draftea y la comparación de opiniones entre casas es
  imposible. Lo resuelven §3 y `odds_at_bet_opposite` de §4.4.
- **Existencia de una API de momios de Draftea utilizable.** `api.draftea.com`
  responde JSON 404; no se pudo determinar si hay un endpoint público sin
  inspeccionar tráfico autenticado.
---

## Reconciliación con el documento de rediseño

*(El documento apareció en `.fase0/01-DOCUMENTO-REDISENO.md` mientras este brief
estaba en curso; el contexto compartido lo daba por ausente. Reconciliado a
posteriori.)*

El rediseño **ya prevé la separación que este análisis exige** — lo que faltaba
era la evidencia de por qué es obligatoria. Encajes directos:

| campo de FASE 1 (`01-DOCUMENTO-REDISENO.md:44-57`) | equivale a lo propuesto en §4.4 |
|---|---|
| `book_name`, `side`, `fetched_at`, `source_event_id` por candidato y por fuente | `odds_at_bet_book`, `odds_at_close_book`, `*_captured_at`, `odds_at_bet_source`. **El modelo por-fuente resuelve el problema de raíz**, mejor que mis columnas planas sobre `bets`. |
| `implied_probability_raw` + `implied_probability_no_vig` | La recomendación de §4.2 de persistir bruta **y** de-vigged. Coincide. |
| `draftea_odds`, `draftea_implied_probability`, **`price_edge_pp`** | Es exactamente mi `book_gap`. **El rediseño ya lo tenía nombrado.** Usar `price_edge_pp`, no `book_gap`. |
| `expected_clv`, `actual_clv` | `clv_market`. Usar `actual_clv`. |
| `market_type`, `side` emparejando ambos lados (FASE 2) | Cubre `odds_at_bet_opposite` y `odds_at_close_opposite`, que es lo que hace computable el de-vig. |
| Regla dura: *"nunca almacenar 0 como placeholder… NULL cuando el valor no existe"* (`:64-66`) | Es literalmente el fix de las 5 filas de fallback (§4.3): `clv = 0` por fallback debe ser NULL. **La regla ya existe y el CLV la viola hoy.** |

Deuda técnica del rediseño que este brief cierra:

- **#4 "Persistir la fuente de `odds_at_close`"** (`:236`) — la fuente es
  **DraftKings vía ESPN core**, verificada en vivo; `fetchEspnClosingLine` ya la
  devuelve (`lib/espn.ts:832-833`) y el código la descarta. Es persistirla, no
  averiguarla.
- **#5 "Diagnóstico de `odds_at_bet`"** (`:237`) — **resuelto**: es el precio de
  Draftea leído por visión del ticket, escrito vía
  `confirm/route.ts:337` → `place_bet_atomic`. Ver §1.3.

**Consecuencia para FASE 8** (`:198-219`): sus criterios de activación se apoyan
en `CLV medio > 0`, `IC del CLV no claramente negativo` y `% de CLV positivo`,
justificados por potencia estadística (25–155 observaciones vs 1,708 por win
rate). **Esos tres criterios son inutilizables contra el `clv` actual**: mide
spread entre casas, así que un sistema con edge real perfecto igual arrojaría
CLV ≈ −1 pp y nunca activaría. El criterio de FASE 8 debe evaluarse contra
`actual_clv` DK→DK (de-vigged), con `price_edge_pp` reportado **aparte** como
coste de ejecución. La nota del documento — *"SIEMPRE QUE la contradicción del
CLV esté resuelta (ver W1)"* (`:196`) — queda satisfecha: **la contradicción era
que el numerador y el denominador venían de casas distintas.**

Advertencia adicional para FASE 8: con `price_edge_pp ≈ −0.99 pp`, el umbral de
activación `CLV medio > 0` medido correctamente **sigue sin garantizar
rentabilidad en Draftea**. Un sistema con `actual_clv = +0.5 pp` contra DK es
−EV al ejecutarse a `r = 0.98`. Si el criterio de activación gobierna apuestas
reales en Draftea, debe ser `actual_clv > price_edge_pp` (≈ `> +1 pp`), no
`> 0`. Ese ajuste requiere aprobación de Christian antes de codificarse, según
la propia regla del documento (`:211-213`).

Sin colisiones de nombres detectadas: ninguno de los campos de FASE 1 existe hoy
en `bets` ni en `picks`.

Con esto, el único punto que el contexto compartido marcaba como bloqueado
queda cerrado. Los tres `NO VERIFICABLE` restantes son los de la sección
anterior (separación margen/deriva, overround de Draftea, API de Draftea), y
los tres los resuelve el protocolo de §3.
