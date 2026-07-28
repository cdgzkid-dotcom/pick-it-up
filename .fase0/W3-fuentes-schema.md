# W3 — Auditoría de fuentes y schema real

**Corte de evidencia en producción:** `2026-07-28T16:55:35Z` UTC. **HEAD auditado:** `b833d98`.

## Resumen ejecutivo

1. **BLOQUEANTE DE LA FASE 2:** el pipeline obtiene ambos lados del moneyline de ESPN/DraftKings y Pinnacle, pero el análisis persistido en `picks` conserva solamente el lado elegido por fuente. La única excepción parcial es `pinnacle_cache` (ambos lados durante 10 minutos) y `line_openings` (ambos lados de la casa primaria al primer avistamiento, sin nombre de casa). No existe un historial 1-a-N candidato/fuente con el par completo, timestamp, casa y evento de origen. Por tanto no se puede reconstruir ni eliminar el vig históricamente.
2. Producción tiene **60 columnas en `picks`**, de las cuales **13 no aparecen ni en `db/schema.sql` ni en migraciones**; además hay tres tablas usadas por el producto sin DDL en repo (`data_cache`, `elo_ratings`, `line_openings`).
3. El catálogo productivo refuta la hipótesis del trigger: **no hay trigger en `picks` ni `bets`**. El único trigger de `public` es `trg_leads_updated_at`. Ninguna función productiva escribe `picks.odds_decimal`; `place_bet_atomic` copia el argumento a `bets.odds_decimal` y `bets.odds_at_bet`. La reescritura observada viene del código de confirmación Draftea, que actualiza `picks.odds_decimal` antes de llamar al RPC (`app/api/bets/from-image/confirm/route.ts:194-224`, `:323-345`). Esto converge con la evidencia temporal conocida y elimina la sospecha de objeto DB oculto.
4. `picks` tiene cero `UNIQUE CONSTRAINT`, pero **sí tiene un índice único parcial no migrado**, `picks_pending_unique`, sobre `(sport, home_team, away_team, pick, bet_type) WHERE status='pending'`. `bets` también tiene `bets_pick_id_unique WHERE pick_id IS NOT NULL`, no migrado. El antecedente “cero unique constraints” es literalmente correcto, pero no significa “cero unicidad efectiva”.
5. La regla de NULL se viola hoy: en producción hay **511** `analyzed_no_edge` con `real_probability=implied_probability=edge=confidence=0`, y **16** `analyzed_no_odds_data` con `real_probability=edge=confidence=0`. Evidencia escritora: `app/api/cron/analyze/route.ts:285-312`, `:340-365`; `lib/pickGen.ts:1502-1549`.

## Parte A — fuentes de datos

### Respuesta clave: ¿se capturan AMBOS lados?

> **En memoria, sí para ESPN/DraftKings, otros books de ESPN, ESPN BPI y Pinnacle. En el registro histórico de cada análisis, NO. Solo se persiste el lado apostado. Esto es un BLOQUEANTE DE LA FASE 2.**

La prueba: ESPN exige home+away (`lib/espn.ts:207-216`, `:657-695`) y Pinnacle rechaza mercados asimétricos (`lib/pinnacle.ts:146-170`), pero al mapear el candidato se elige un `side` (`lib/pickGen.ts:923-993`), se reduce cada book a `{source, ml}` del lado elegido (`lib/pickGen.ts:1047-1051`) y `picks` guarda un solo `odds_decimal`, `implied_probability`, `pinnacle_implied` y consenso (`lib/pickGen.ts:1336-1387`). Sin el lado opuesto por fuente no puede calcularse retrospectivamente `q_home + q_away`, overround ni probabilidad no-vig.

### 1. Pinnacle Guest API

- **Obtención:** guest token + GET a `/sports/{id}/matchups` y `/matchups/{id}/markets/related/straight` (`lib/pinnacle.ts:25-39`, `:265-311`). MLB/NBA/NFL/NHL/WNBA están mapeados (`:28-36`).
- **Sanitización/matching:** liga exacta, nombres home/away exactos case-insensitive y, solo si hay varios candidatos, el start más cercano; el comentario promete ±60 min pero el código **no rechaza** por distancia (`lib/pinnacle.ts:102-143`). Solo `moneyline`, período 0, abierto, y ambos designations; americano→implícita (`:76-83`, `:146-170`).
- **Persistencia:** `pinnacle_cache` guarda `espn_event_id`, matchup id, equipos, **home/away implied**, `fetched_at`, TTL 600 (`lib/pinnacle.ts:173-230`; migración `supabase/migrations/20260512030000_pinnacle_integration.sql:23-36`). En `picks` solo queda la implícita del lado elegido, status y edge (`lib/pickGen.ts:1003-1019`, `:1156-1158`).
- **Consumo:** entra como una observación de media simple y como comparación separada (`lib/edge.ts:26-78`); no se elimina vig.
- **Campos auditados:** captura timestamp **sí en caché**; mercado **implícito por filtro, no persistido**; local/visitante **sí**; side **dos lados en caché, uno en pick**; decimal **derivado, no almacenado en caché**; casa **implícita por tabla, no columna**; vig/overround **no calculado/persistido**; estado fuente **`pinnacle_status` solo en pick**; minutos al inicio **no**; matching exacto **equipos+liga, hora solo desempata**.
- **Irrecuperable tras TTL/overwrite:** snapshot completo anterior, americano original, market id/type/period/status, start de Pinnacle, ambos decimales, overround, minutos, flags de matching.

### 2. DraftKings/otros books vía ESPN Core odds

- **Obtención:** scoreboard ESPN y fallback GET a Core `/events/{id}/competitions/{id}/odds` (`lib/espn.ts:186-202`, `:219-240`). No se fija DraftKings: se toma el primer proveedor no-live con ambos ML (`:204-216`); el log reconoce provider alterno (`lib/pickGen.ts:919-920`).
- **Sanitización:** americano finito/no cero→decimal redondeado a 3 cifras (`lib/espn.ts:108-113`); requiere ambos lados para la fuente primaria (`:657-695`); normaliza nombre de casa a slug (`:628-632`).
- **Persistencia/consumo:** ambos lados y todos los proveedores existen en memoria (`lib/espn.ts:634-695`). `line_openings` conserva ambos lados de la primaria por `espn_event_id`, pero no casa ni fetched timestamp distinto de `opened_at` (`lib/lineMovement.ts:48-98`). En `picks`, `odds_decimal`/`implied_probability` son solo lado elegido y `odds_comparison` se reduce al lado elegido por casa (`lib/pickGen.ts:923-1051`, `:1336-1387`).
- **Campos:** timestamp **solo `opened_at` de primera observación**, no cada fetch; market type **ML implícito, no columna**; local/visitante **sí**; side **ambos en memoria/opening, uno por casa en pick**; decimal **sí**; casa **sí en pick/comparison, no en opening**; vig **no**; estado evento **en memoria, no junto al quote**; minutos **calculados para filtro, no guardados** (`app/api/cron/analyze/route.ts:120-124`, `:169-176`); matching **ID ESPN exacto**.
- **Cierre:** obtiene ambos lados open/close y provider, con fallback de cierre a moneyline actual (`lib/espn.ts:748-834`), pero resolución persiste solo `bets.odds_at_close` y `clv`; pierde casa, endpoint, timestamp y si fue fallback.

### 3. The Odds API

**No es una fuente activa en HEAD.** La única referencia dice que fue retirada porque `ODDS_API_KEY` era inutilizable y sustituida por ESPN odds+BPI (`lib/pickGen.ts:440-446`). No hay URL, key ni fetch activos. Por tanto todos los campos y su comparabilidad histórica son **NO VERIFICABLES** desde HEAD; no debe contarse como fuente actual.

### 4. ESPN (scoreboard, injuries y BPI/predictor)

- **Scoreboard:** GET por cinco ligas (`lib/espn.ts:10-38`, `:186-192`), descarta post/completed, identifica competidores por `homeAway`, conserva `event.id`, fecha, equipos, status y venue en `Game` (`:219-315`). Persiste equipos, `espn_event_id`, `game_start_time`; el estado del evento solo vive en `notable_stats` enviado al modelo.
- **Injuries/resultados:** GET injuries y scoreboards fechados (`lib/espn.ts:384-422`, `:425-580`). Resultado persiste scores/estado de apuesta, no payload fuente.
- **BPI:** GET `/predictor`; lee ambos lados o deriva complemento (`lib/espn.ts:698-745`). No es momio/casa/mercado y mezclarlo como otra “fuente de mercado” en media simple es semánticamente distinto (`lib/edge.ts:26-42`). En `picks` no queda BPI individual: solo label en `market_sources` y media elegida.
- **Campos:** timestamp de captura **no**; market type/casa/vig/decimal **N/A para BPI**; home/away y ambos lados **sí en memoria**; estado/start/source event id **scoreboard sí**; minutos **no persistidos**; matching **event id**. No se puede reconstruir el valor BPI histórico ni distinguirlo del aporte de books a `market_consensus_implied`.

### 5. MLB Stats API

- **Obtención/sanitización:** schedule, pitchers, hitting, pitching y standings por GET (`lib/mlbStats.ts:55-88`, `:120-160`, `:184-218`, `:245-273`). Matching usa nombre/abreviatura con `includes` del último token, no ID compartido (`:287-317`), por lo que puede ser ambiguo.
- **Persistencia/consumo:** caché genérico `data_cache` con expiración (`lib/cache.ts:46-77`); contexto se inyecta a Claude (`lib/pickGen.ts:460-473`) y solo sobreviven la síntesis `analysis/key_stats/...`, no el snapshot fuente.
- **Campos de mercado:** tipo, side, odds, casa y vig **N/A**. Sí hay gamePk, fecha, home/away y equipos en memoria; captura exacta, estado, minutos y enlace ESPN↔MLB **no persistidos**. Histórico analítico no reconstruible.

### 6. NHL API (+ stats ESPN NHL)

- **Obtención:** standings, team summary, goalies y club schedule vía GET (`lib/nhlStats.ts:59-85`, `:117-139`, `:169-186`, `:210-243`), más métricas ESPN (`:269-320`).
- **Sanitización/matching:** abreviatura de equipo; resultados finales `OFF/FINAL`; contexto por home/away abbr (`:338-368`).
- **Persistencia/consumo:** `data_cache`, luego prompt (`lib/pickGen.ts:474-480`); no raw snapshot en análisis.
- **Campos de mercado:** N/A. Equipos/lado sí en memoria; timestamp de captura, source game id, estado contextual, minutos y matching audit trail no quedan. No comparable con quotes.

### 7. OpenWeather

- **Obtención:** GET forecast 5 días/3 h por coordenadas; domos se sintetizan sin API (`lib/weather.ts:108-125`). Elige slot temporal más cercano y rellena faltantes con 70°F/0 mph/50% (`:134-156`), sin flag de imputación.
- **Persistencia/consumo:** se adjunta al prompt (`lib/pickGen.ts:395-435`); no usa `cached()` y no persiste raw forecast/fetched_at/slot delta. Solo puede reaparecer como texto/key stat del modelo.
- **Campos de mercado:** N/A. Matching por string exacto de venue y hora; no persiste captura, source id, minutos ni calidad.

### 8. Draftea

- **No hay API Draftea:** una imagen de ticket se envía a Claude Vision. Extrae sport, equipos, selección, market type, línea, **momio solo del lado apostado**, event time, ticket status/id y placed_at (`lib/vision-extract-bet.ts:14-39`, `:51-99`). Clamp 1.01–200 convierte inválidos en **1.0**, otro placeholder no-NULL (`:168-180`).
- **Persistencia:** una apuesta guarda total/parlay, stake, estado y `draftea_ticket_id`; legs completos no tienen tabla y quedan comprimidos en `notes` (`app/api/bets/from-image/confirm/route.ts:295-321`, `:384-415`). Antes de apostar actualiza el quote de análisis en `picks.odds_decimal` (`:194-224`).
- **Matching:** matcher contra picks pendientes; `matched_pick_id` y comparación de momio (`app/api/telegram/webhook/route.ts:187-214`). El ticket no aporta precio del lado contrario, casa es implícita, no vig/overround. **También bloquea Fase 2 para precio de ejecución Draftea.**

## Parte B — schema real

### Método y alcance

Se consultaron exclusivamente con `SELECT` a las `2026-07-28T16:55:35Z`: `information_schema.columns`, `table_constraints`, `triggers`; `pg_indexes`, `pg_trigger`, `pg_proc`+`pg_get_functiondef`, y `pg_views`. El OpenAPI PostgREST confirmó la superficie expuesta a `2026-07-28T16:52:14Z`. El servidor reportó PostgreSQL 17.6. El inventario se limita a las 15 tablas de Pick It Up; la DB compartida contiene otras apps (`db/schema.sql:1-5`).

### Producción no representada por migraciones

- **Tablas completas:** `data_cache`, `elo_ratings`, `line_openings` (aunque el código las usa en `lib/cache.ts:46-77`, `lib/elo.ts:19-108`, `lib/lineMovement.ts:48-98`).
- **`picks` (13 columnas ausentes de ambas fuentes DDL):** `trap_warning`, `edge_vs_market`, `floor_applied`, `confidence_raw`, `market_consensus_implied`, `market_sources_count`, `market_sources`, `locked_at`, `original_real_probability`, `original_odds`, `reanalysis_count`, `lock_reason`, `audit_failures`. Además `home_team_abbr`/`away_team_abbr` están en `db/schema.sql` pero en ninguna migración. Las 13 no representadas explican CAPA-2/auditoría y son escritas en `lib/pickGen.ts:1334-1387`, `:1688-1787`, `:1832-1874`.
- **Índices no migrados:** `picks_pending_unique`; `bets_pick_id_unique`; `data_cache_{pkey,expires_idx}`; `elo_ratings_{pkey,sport_team_key}`, `elo_sport_team_idx`; `line_openings_{pkey,opened_at_idx}`.
- **DDL drift adicional:** `picks.updated_at` es `NOT NULL DEFAULT now()` en producción, pero nullable/sin default en `db/schema.sql:12`; `settings.auto_sports` default productivo es NBA/MLB/NHL/Liga MX/Premier League, frente a NBA/MLB/NHL/NFL/WNBA en `db/schema.sql:121`.

### Migraciones/DDL repo que no se reflejan exactamente

- `cron_runs`: la migración declara `started_at/workflow/duration_ms/generated_picks NOT NULL` y defaults para workflow/duration/generated (`20260516000000_cron_runs_extended.sql:8-15`); producción conserva `started_at`, `duration_ms`, `generated_picks` nullable, sin default para workflow/duration/generated. Es efecto de `CREATE TABLE IF NOT EXISTS` sobre tabla preexistente, tal como admite `:3-6`.
- `idx_cron_runs_started_at` debería ser solo `(started_at DESC)` (`:17`), pero producción lo define `(workflow, started_at DESC)`, idéntico al segundo índice. El nombre existe, el significado no.
- `db/schema.sql` no es una migración aplicada y diverge en `picks.updated_at` y `settings.auto_sports` como arriba.
- Las migraciones 20260727 **sí están aplicadas**, pese al comentario “NOT APPLIED YET” en `20260727120000_preseason_observation_only.sql:14-16`: columna, índice, comentario y guard de `place_bet_atomic` existen; `bets.excluded_from_stats` también.
- No se encontró objeto declarado en una migración que esté totalmente ausente: tablas de learning, notifications, cache Pinnacle, RPCs, AI usage, cron, Telegram y columnas retroactivas existen.

### Triggers, funciones y vistas reales

- **Triggers:** solo `trg_leads_updated_at`, `BEFORE UPDATE` en `leads`, llama `update_updated_at()`. **Cero en `picks`; cero en `bets`.**
- **Funciones `public`:** cuatro: `adjust_bankroll_atomic`, `place_bet_atomic`, `resolve_bet_atomic` (las tres `SECURITY DEFINER`) y `update_updated_at` (invoker). Las tres RPC corresponden a `supabase/migrations/20260512050000_atomic_place_bet.sql:11-85`, `supabase/migrations/20260512050001_atomic_resolve_bet.sql:15-79` y `supabase/migrations/20260512050002_atomic_adjust_bankroll.sql:9-38`; `place_bet_atomic` productiva incluye el guard de `supabase/migrations/20260727120000_preseason_observation_only.sql:40-121`.
- **Vistas:** cero en `public`.
- **Conclusión sobre los ~137 ms:** catálogo descarta trigger/función. La única ruta encontrada que cambia `picks.odds_decimal` inmediatamente antes de `place_bet_atomic` es confirmación de ticket (`app/api/bets/from-image/confirm/route.ts:194-224`, luego `:323-345`). El RPC copia `p_odds_decimal` al bet y a `odds_at_bet` (`20260727120000_preseason_observation_only.sql:92-104`).

### Constraints e índices reales

- PK: todas salvo ninguna excepción entre las tablas inventariadas; `pinnacle_cache`, `line_openings` usan `espn_event_id`; `data_cache` usa `cache_key`.
- FK: `bets.pick_id→picks.id`; `pick_factors.pick_id→picks.id`; `pick_factors.bet_id→bets.id`. Solo el FK de bets especifica `ON DELETE SET NULL` en repo (`db/schema.sql:65`); los de learning no declaran acción (`20260511000930_add_learning_tables.sql:6-7`).
- UNIQUE constraints: `factor_performance(factor_name,factor_value,sport)`, `system_weights(sport,factor_name)`, `elo_ratings(sport,team)`. `picks`: **cero**. `bets`: cero aparte de PK.
- Índices únicos parciales (no constraints): `picks_pending_unique(sport,home_team,away_team,pick,bet_type) WHERE status='pending'`; `bets_pick_id_unique(pick_id) WHERE pick_id IS NOT NULL`.
- Índices secundarios: `picks` created/status/sport/game_start/event/observation; `bets` created/result/pick/event/Draftea/excluded; learning por FKs/sport; Pinnacle fetched; line opening opened; cache expires; cron tiene dos índices duplicados; Telegram created; AI created/task; notifications kind+sent; bankroll created.
- `bets_draftea_ticket_id_idx` **no es único** (`20260515000000_vision_bet.sql:4-7`), así que el comentario “dedup” no está garantizado por DB.

## Inventario completo anotado del schema real

Convenciones: `!` = NOT NULL, `?` = nullable; `=x` = default. Cada elemento es `columna tipo/null/default — significado [writer]`. PK/FK/uniques están en la sección anterior.

### `picks` (60 columnas)

- `id uuid! =gen_random_uuid()` identidad [DB]; `created_at timestamptz! =now()` alta [DB]; `updated_at timestamptz! =now()` última mutación [DB/app].
- `sport text!`, `game text!`, `league text?`, `home_team text!`, `away_team text!`, `home_team_abbr text?`, `away_team_abbr text?`, `espn_event_id text?`, `game_start_time timestamptz?` — identidad/matching ESPN [pipeline, `lib/pickGen.ts:1336-1344`, `:1379`].
- `pick text!`, `pick_detail text?`, `bet_type text!`, `tier text?`, `status text! ='pending'`, `is_parlay bool! =false`, `parlay_legs jsonb?` — decisión/estado [pipeline, `lib/pickGen.ts:1345-1347`, `:1362`, `:1376-1378`; cron cambia estado `app/api/cron/analyze/route.ts:996-999`].
- `odds_decimal numeric!`, `best_odds numeric?`, `best_odds_source text?`, `odds_comparison jsonb?` — precio elegido y comparación solo del lado elegido [pipeline `lib/pickGen.ts:1348-1351`; confirmación sobrescribe odds `app/api/bets/from-image/confirm/route.ts:194-224`].
- `confidence int?`, `confidence_raw int?`, `real_probability numeric?`, `implied_probability numeric?`, `edge numeric?` — score LLM, snapshot del mismo score (no probabilidad), probabilidad ajustada, `1/odds`, diferencia [pipeline `lib/pickGen.ts:1063-1067`, `:1125-1131`].
- `edge_vs_market numeric?`, `market_consensus_implied numeric?`, `market_sources_count int?`, `market_sources jsonb?`, `floor_applied text?` — diferencia/media simple/labels de las fuentes del lado elegido; floor hoy `'none'` [pipeline `lib/pickGen.ts:1011-1023`, `:1151-1155`].
- `pinnacle_implied numeric?`, `pinnacle_status text?`, `edge_vs_pinnacle numeric?` — lado elegido/status/diferencia Pinnacle [pipeline `lib/pickGen.ts:1003-1019`, `:1156-1158`].
- `recommended_amount numeric?`, `theoretical_amount numeric?`, `sizing_reason text?`, `units_actual numeric?`, `units_theoretical numeric?` — stake Kelly, techo y explicación/unidades [pipeline `lib/pickGen.ts:1079-1105`, `:1143-1148`].
- `analysis text?`, `risk_factors text?`, `injuries text?`, `key_stats jsonb?`, `trap_warning text?`, `line_movement_note text?`, `regression_flags text?` — salida/síntesis del modelo y auditoría [pipeline `lib/pickGen.ts:1132-1142`, `:1367-1375`].
- `early_payout_eligible bool! =false`, `early_payout_threshold text?` — metadatos legacy [pipeline fija false/null, `lib/pickGen.ts:1371-1372`].
- `locked_at timestamptz?`, `original_real_probability numeric?`, `original_odds numeric?`, `reanalysis_count int? =0`, `lock_reason text?` — snapshot congelado y auditoría CAPA-2/3 [lock-in `lib/pickGen.ts:1688-1699`, `:1773-1787`, `:1832-1874`].
- `audit_failures jsonb?` — array de fallos/warnings [audit `lib/pickGen.ts:1196-1223`, persistencia `:1381`]; `retry_count int? =0` — intentos sin odds [`lib/pickGen.ts:1581-1621`].
- `picks_generated_at timestamptz?`, `telegram_notified_at timestamptz?` — captura/aviso del pipeline [`lib/pickGen.ts:1778`; `app/api/cron/analyze/route.ts:697-704`]; `observation_only bool! =false` — exhibición no apostable [`lib/espn.ts:128-153`, `lib/pickGen.ts:1382`].

### `bets` (31)

- `id uuid! =gen_random_uuid()`, `created_at timestamptz! =now()` — identidad/alta [DB].
- `pick_id uuid?`, `sport text!`, `game text!`, `home_team text?`, `away_team text?`, `home_team_abbr text?`, `away_team_abbr text?`, `espn_event_id text?`, `game_start_time timestamptz?`, `pick text!`, `bet_type text!`, `tier text?` — vínculo y evento [RPC `supabase/migrations/20260727120000_preseason_observation_only.sql:92-104`; screenshot `app/api/bets/from-image/confirm/route.ts:295-345`].
- `odds_decimal numeric!`, `amount numeric!`, `odds_at_bet numeric?` — ejecución/stake/snapshot (RPC pone ambos odds iguales) [RPC ibid.].
- `result text! ='pending'`, `cashout_amount numeric?`, `payout numeric?`, `final_score text?`, `result_notified_at timestamptz?` — settlement [RPC `20260512050001_atomic_resolve_bet.sql:50-69`; cron resultados].
- `odds_at_close numeric?`, `clv numeric?` — cierre del lado y CLV, sin fuente/timestamp/fallback [RPC anterior `:50-58`; fetch `lib/espn.ts:748-834`].
- `bet_direction text?`, `spread_line numeric?`, `total_line numeric?` — dirección/líneas no-ML [rutas de bets]; `date text?`, `notes text?` — fecha display/metadatos libres [rutas/RPC].
- `draftea_ticket_id text?` — ticket [`app/api/bets/from-image/confirm/route.ts:367-372`, `:414`]; `excluded_from_stats bool! =false` — dinero real no-modelo [migración `20260727130000_bets_excluded_from_stats.sql:14-35`].

### Tablas operativas/learning

- **`bankroll_log` (6):** `id uuid! =gen_random_uuid()`, `created_at timestamptz! =now()`, `type text!`, `amount numeric!`, `balance_after numeric!`, `note text?` — ledger escrito solo por RPCs atómicos (`supabase/migrations/20260512050000_atomic_place_bet.sql:70-73`; `supabase/migrations/20260512050001_atomic_resolve_bet.sql:60-69`; `supabase/migrations/20260512050002_atomic_adjust_bankroll.sql:32-34`).
- **`settings` (6):** `id int! =1`, `bankroll_current numeric! =300`, `unit_percentage numeric! =5`, `auto_sports text[]!` (default productivo arriba), `auto_enabled bool! =true`, `bankroll_initial numeric! =300` — singleton/config; API settings escribe (`app/api/settings/route.ts:32`), RPCs bankroll (`supabase/migrations/20260512050000_atomic_place_bet.sql:45-73`).
- **`pick_factors` (8):** `id uuid! =gen_random_uuid()`, `pick_id uuid?`, `bet_id uuid?`, `sport text?`, `factors jsonb!`, `result text?`, `profit numeric?`, `created_at timestamptz? =now()` — factores por pick y resultado; writer `lib/learning.ts:104-118`, `:121-168`.
- **`factor_performance` (11):** `id uuid!`, `factor_name text!`, `factor_value text?`, `sport text?`, `total_picks int?=0`, `wins int?=0`, `losses int?=0`, `total_profit numeric?=0`, `avg_edge numeric?=0`, `win_rate numeric?=0`, `last_updated timestamptz?=now()` — agregado por factor; writer `lib/learning.ts:173-212`. `avg_edge` no se escribe en ese flujo.
- **`system_weights` (7):** `id uuid!`, `sport text!`, `factor_name text!`, `weight numeric! =1`, `sample_size int?=0`, `last_calibrated timestamptz?=now()` — calibración semanal; writer `app/api/cron/calibrate/route.ts:67-82`.
- **`elo_ratings` (7):** `id uuid!`, `sport text!`, `team text!`, `abbreviation text?`, `elo numeric! =1500`, `games_played int! =0`, `last_updated timestamptz?=now()` — ELO; init/update `lib/elo.ts:19-40`, `:58-108`.

### Tablas de captura/cache/operación

- **`pinnacle_cache` (9):** `espn_event_id text!`, `pinnacle_matchup_id bigint?`, `sport text?`, `home_team text?`, `away_team text?`, `home_implied numeric?`, `away_implied numeric?`, `fetched_at timestamptz?=now()`, `ttl_seconds int?=600` — snapshot Pinnacle mutable; writer `lib/pinnacle.ts:206-230`.
- **`line_openings` (13):** `espn_event_id text!`, `sport text!`, `game_label text?`, `home_team text?`, `away_team text?`, `home_ml_open numeric?`, `away_ml_open numeric?`, `spread_line_open numeric?`, `spread_home_odds_open numeric?`, `total_line_open numeric?`, `over_odds_open numeric?`, `under_odds_open numeric?`, `opened_at timestamptz! =now()` — primera línea ESPN primaria; writer `lib/lineMovement.ts:48-98`.
- **`data_cache` (4):** `cache_key text!`, `data jsonb!`, `expires_at timestamptz!`, `created_at timestamptz?=now()` — caché compartido de stats; writer/serialización `lib/cache.ts:21-77`.
- **`system_notifications` (4):** `id uuid!`, `kind text!`, `sent_at timestamptz?=now()`, `payload jsonb?` — anti-spam/estado de avisos; cron usa en `app/api/cron/analyze/route.ts:423-440`.
- **`cron_runs` (10):** `id uuid!`, `workflow text!`, `started_at timestamptz?=now()`, `duration_ms int?`, `generated_picks int?`, `errors jsonb?`, `games_fetched int!=0`, `games_in_window int!=0`, `games_analyzed int!=0`, `anthropic_status text!='skipped'` — heartbeat por corrida; writer `app/api/cron/analyze/route.ts:1048-1075`.
- **`telegram_sessions` (4):** `id uuid!`, `chat_id bigint!`, `payload jsonb!`, `created_at timestamptz! =now()` — confirmación efímera; writer/delete `app/api/telegram/webhook/route.ts:316-373`.
- **`ai_usage_log` (10):** `id uuid!`, `created_at timestamptz!`, `task_type text!`, `model text!`, `tokens_in int?`, `tokens_out int?`, `cost_usd numeric?`, `success bool!=true`, `confidence_level text?`, `metadata jsonb?` — coste/calidad Vision; writer `app/api/bets/from-image/route.ts:70-93`.

## Parte C — reconciliación y nombres finales

### Colisiones/equivalencias y peligros semánticos

| Propuesto literal | Existente | Veredicto / nombre final |
|---|---|---|
| `book_name` | `best_odds_source`, nombres dentro de `odds_comparison`; Pinnacle implícito | No reutilizar: esos campos describen solo el lado elegido. En nueva hija: `source_name` (o `book_name` si solo sportsbooks). |
| `market_type` | `picks.bet_type` | Casi equivalente para el pick, no para cada quote. Nueva hija `market_type`; FK análisis conserva `bet_type` como selección final. |
| `side` | implícito en `pick`; `bets.bet_direction` solo totals | **Nuevo.** `selection_side` en análisis y `side` en quote; no reutilizar `bet_direction`. |
| `odds_decimal` | `picks.odds_decimal`, `original_odds`, bets odds*, line openings | Mismo tipo, distinto momento. Nueva hija `odds_decimal`; congelar por snapshot. `picks.odds_decimal` es mutable y no fuente histórica. |
| `implied_probability_raw` | `picks.implied_probability`, `pinnacle_implied` | `picks.implied_probability` equivale solo para selección y contiene vig. Nueva hija `implied_probability_raw`; no duplicar en análisis. |
| `implied_probability_no_vig` | ninguno | Nuevo. |
| `fetched_at` | `pinnacle_cache.fetched_at`, `line_openings.opened_at`, `created_at` genéricos | Semántica equivalente solo en Pinnacle. Nuevo obligatorio por quote. |
| `game_start_time` | `picks/bets.game_start_time` | Equivalente; mantener en evento/análisis y opcionalmente snapshot para auditabilidad. |
| `minutes_to_start` | cálculo efímero | Nuevo derivado; guardar para reproducibilidad aunque derive de timestamps. |
| `source_event_id` | `espn_event_id`, `pinnacle_matchup_id` | Nuevo genérico; no renombrar IDs existentes sin preservar namespace. |
| `source_status` | `pinnacle_status`; ESPN event state no persistido | Nuevo por quote; `pinnacle_status` puede migrarse. |
| `is_stale` | TTL Pinnacle implícito | Nuevo derivado/materializado. |
| `data_quality_flags` | `audit_failures` | **Choque:** audit_failures es calidad del pick, no del dato fuente. Nuevo en quote. |
| `sharp_probability` | `pinnacle_implied`; `real_probability` | Peligro: Pinnacle actual es raw con vig; real_probability es modelo ajustado. Definir `sharp_probability_no_vig` o eliminar si coincide con una fuente. |
| `sharp_consensus_probability` | `market_consensus_implied` | Choque fuerte: actual es media simple de DK/BPI/Pinnacle **raw** y mezcla predictor con books. Nuevo nombre `sharp_consensus_probability_no_vig`; no migración automática. |
| `sharp_consensus_method` | ninguno | Nuevo (`proportional_no_vig_mean_v1`, etc.). |
| `sharp_sources_count` | `market_sources_count` | Estructuralmente similar, semántica distinta por vig/composición. Nuevo; no copiar sin recomputar. |
| `sharp_dispersion` | ninguno | Nuevo. |
| `draftea_odds` | `bets.odds_at_bet`/`odds_decimal`; pick mutable | Para apuesta ejecutada equivale a `bets.odds_at_bet`; para candidato pre-bet es nuevo. Nombre final `execution_odds_decimal` en bet y `draftea_odds_decimal` en análisis. |
| `draftea_implied_probability` | `picks.implied_probability` si provider Draftea, pero normalmente ESPN book | **No equivalente.** Nuevo `draftea_implied_probability_raw`; solo cuando existe quote Draftea real. |
| `price_edge_pp` | `edge`, `edge_vs_market`, `edge_vs_pinnacle` | Choque: `edge` usa modelo vs quote elegido; `edge_vs_market` usa consenso raw. Nombre final explícito `adjusted_probability_minus_draftea_implied_pp`. |
| `market_only_probability` | ninguno confiable; `market_consensus_implied` no-vig no | Nuevo `market_consensus_probability_no_vig`. |
| `residual_adjustment_pp` | diferencia no guardada | Nuevo. |
| `adjusted_probability` | `real_probability` post dampening | Conceptualmente cercano. Renombrar futuro a `adjusted_win_probability`; migrar `real_probability` solo con versionado y exclusión de placeholders. |
| `probability_lower_bound`, `probability_upper_bound` | ninguno | Nuevos. |
| `expected_value_central`, `expected_value_conservative` | `edge` no es EV monetario | Nuevos; sufijo `_per_unit` para unidad inequívoca. |
| `expected_clv` | ninguno | Nuevo, definir unidad (`expected_clv_probability_pp`). |
| `actual_clv` | `bets.clv` | Equivalente si misma fórmula/unidad. Nombre final `bets.clv` o renombrar una vez a `clv_probability_pp`; no duplicar `actual_clv`. |
| `model_variant` | ninguno | Nuevo. |
| `observation_only` | `picks.observation_only` | Ya existe y coincide (`supabase/migrations/20260727120000_preseason_observation_only.sql:9-22`). Reusar. |
| `rejection_reason` | `status`, `audit_failures`, logs no persistidos | Nuevo estructurado; no reemplazar audit warnings. |
| `data_quality_score` | ninguno | Nuevo por análisis; distinto de flags por quote. |

### Propuesta mínima de tablas

1. **`analyses`** (una fila por evento+corrida/model variant): identidad, evento/teams/start/fetched window, `model_variant`, `market_consensus_probability_no_vig`, método/count/dispersion, `residual_adjustment_pp`, `adjusted_win_probability`, bounds, EV central/conservative, expected CLV, `selection_side`, `rejection_reason`, `data_quality_score`, `observation_only`. `picks` debería referenciar `analysis_id` y seguir siendo la decisión publicable/operativa.
2. **`analysis_source_quotes`** (1-a-N respecto de analysis, idealmente **dos filas enlazadas por snapshot por fuente**, una home y otra away): `analysis_id`, `source_name`, `source_kind` (`sportsbook|predictor`), `market_type`, `side`, `odds_decimal`, `implied_probability_raw`, `implied_probability_no_vig`, `fetched_at`, `game_start_time`, `minutes_to_start`, `source_event_id`, `source_status`, `is_stale`, `data_quality_flags`, `snapshot_group_id`. Constraint único sugerido `(analysis_id, source_name, market_type, snapshot_group_id, side)` y check odds/probabilities; constraint diferido/proceso de ingestión debe exigir home+away para moneyline antes de declarar snapshot usable.
3. **`bets`** conserva ejecución y `clv`, pero añadir metadatos de apertura/cierre (`opening_quote_id`, `closing_quote_id`, `closing_fetched_at`, `closing_source_name`, `closing_was_fallback`) en lugar de duplicar probabilidades.

No guardar `sharp_probability` si es solo el quote Pinnacle; derivarlo de las quotes no-vig. No guardar a la vez `draftea_implied_probability` y odds si no se necesita rendimiento: es derivable, aunque guardarlo como snapshot calculado/versionado facilita auditoría.

### Regla NULL y migraciones

- Cambiar marcadores para que `real_probability`, `implied_probability`, `edge`, `confidence` sean NULL cuando no se calcularon; `odds_decimal` hoy es NOT NULL y fuerza `1`, por lo que el modelo nuevo debe separar análisis/rechazo de pick o hacer nullable el quote seleccionado. Los 511+16 ceros no deben reinterpretarse ni backfillearse como probabilidades reales.
- El clamp Draftea inválido a `1.0` (`lib/vision-extract-bet.ts:171-180`) debe convertirse en rechazo/NULL antes de persistir, nunca en precio.
- Cada cambio debe entrar en una migración idempotente **y reversible** (`DROP TABLE/COLUMN/INDEX` en down operativo documentado) o declarar explícitamente por qué el backfill/normalización de datos es irreversible. Orden: crear tablas/columnas e índices → desplegar dual-write → validar pares y NULL → backfill solo de hechos demostrables → cambiar readers → retirar legado en migración posterior. Nunca fabricar el lado faltante ni no-vig desde el lado apostado.

## NO VERIFICABLE / límites

- No puede determinarse la semántica histórica exacta de columnas no migradas antes de su código actual, ni el DDL que las creó: no existe migración.
- No se verificaron respuestas vivas de APIs externas; esta auditoría prueba contratos y transformaciones de HEAD, no disponibilidad ni payload actual.
- La razón original por la que `idx_cron_runs_started_at` quedó con definición equivocada y quién creó las tablas/columnas fuera de migración es **NO VERIFICABLE** sin historial de DDL/audit logs.
- La identidad matemática de `bets.clv` con el `actual_clv` propuesto depende de fijar fórmula/unidad en el rediseño. Con el documento actual solo puede marcarse equivalente condicional.
