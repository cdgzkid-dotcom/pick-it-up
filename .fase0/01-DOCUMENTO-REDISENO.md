# PICK IT UP — REDISEÑO DEL NÚCLEO ANALÍTICO: DE ORÁCULO A MODELO RESIDUAL

## OBJETIVO ESTRATÉGICO

Transformar el sistema de:

  "Claude calcula desde cero la probabilidad real de que un equipo gane"

a:

  mercado sharp → consenso sin vig → detección de precio →
  ajuste residual → EV conservador → observación → validación por CLV

Hipótesis nueva: el consenso sharp es el mejor prior disponible; Draftea
puede ofrecer temporalmente precios peores o líneas lentas; y datos
verificables de última hora pueden justificar ajustes PEQUEÑOS sobre ese
prior. Claude actúa como modelo residual, no como oráculo.

Consecuencia central: el tier deja de depender de la probabilidad
absoluta de ganar y pasa a depender del valor esperado y la calidad del
precio. Un underdog al 45% con momio 2.50 tiene EV +12.5% y debe poder
recomendarse.

JUSTIFICACIÓN CORREGIDA TRAS LA FASE 0 (2026-07-28). La versión
original de este documento decía que el piso de 55% impide recomendar
underdogs. Eso es FALSO medido por momio: 148 de 271 picks MLB con
momio válido son underdog (54.6%), y 25 de 68 apuestas ejecutadas.

La razón real es peor. El filtro de lib/pickGen.ts:1067-1077, vía
lib/units.ts:43, corta por PROBABILIDAD DE MODELO, no por precio. Por
tanto elimina exactamente los underdogs cuya probabilidad el modelo
estima honestamente por debajo del piso — que son los de EV positivo
POR PRECIO — y conserva solo aquellos a los que el modelo asigna ≥55%,
es decir los que dependen de que Claude discrepe del mercado.

El sesgo no es "no hay underdogs". Es "solo hay underdogs por opinión,
nunca por precio": el sistema se queda con la clase más frágil y
descarta la más sólida. El underdog canónico de arriba (p=0.45, momio
2.50) pasa el gate de edge y muere en el tier.

Filtros adicionales por precio que hay que retirar junto con el piso:
  lib/pickGen.ts:1171   descarta si odds<1.4 && edge<0.05
  lib/units.ts:45-49    degrada tier si odds<1.40, hasta null en VALUE
  lib/pickGen.ts:1028-1045  dampening asimétrico: recorta la
                        probabilidad solo hacia arriba
  lib/pickGen.ts:1169   confidence>=55, umbral sobre una magnitud que
                        este mismo documento advierte no confundir con
                        probabilidad

Fórmula base: expected_value = model_probability * odds_decimal - 1

Pero el diseño NO debe confiar ciegamente en model_probability. Debe
separar explícitamente: probabilidad sharp sin vig, consenso de mercado,
ajuste residual, probabilidad final, incertidumbre, edge contra Draftea,
EV central, EV conservador, calidad/frescura de datos, CLV esperado, CLV
realizado, y confianza analítica.

Ejemplo conceptual del ajuste residual:
  Probabilidad sharp sin vig:        47.8%
  Ajuste por pitcher confirmado:     +1.2 pp
  Ajuste por bullpen agotado:        +0.7 pp
  Ajuste por lineup:                 −0.4 pp
  Ajuste por clima:                  +0.3 pp
  Probabilidad final:                49.6%
  Intervalo conservador:             47.2%–52.0%

---

## FASE 1 — MODELO DE DATOS OBSERVABLE

Por candidato y por fuente:
  book_name, market_type, side, odds_decimal, implied_probability_raw,
  implied_probability_no_vig, fetched_at, game_start_time,
  minutes_to_start, source_event_id, source_status, is_stale,
  data_quality_flags

Por análisis:
  sharp_probability, sharp_consensus_probability, sharp_consensus_method,
  sharp_sources_count, sharp_dispersion, draftea_odds,
  draftea_implied_probability, price_edge_pp, market_only_probability,
  residual_adjustment_pp, adjusted_probability, probability_lower_bound,
  probability_upper_bound, expected_value_central,
  expected_value_conservative, expected_clv, actual_clv, model_variant,
  observation_only, rejection_reason, data_quality_score

Los nombres finales se definen DESPUÉS de revisar el schema existente.
Reporta colisiones y conceptos incompatibles.

REGLA DURA: nunca almacenar 0 como placeholder de probabilidad
desconocida. NULL cuando el valor no existe. Este bug ya destruyó
información histórica (188 analyzed_no_edge con real_probability=0).

## FASE 2 — NORMALIZACIÓN Y ELIMINACIÓN DEL VIG

PRERREQUISITO DURO, NO DETALLE DE IMPLEMENTACIÓN (Fase 0, 2026-07-28):
persistir AMBOS LADOS del moneyline por fuente y por snapshot.

Hoy no se persisten. Se capturan en memoria —ESPN exige home+away
(lib/espn.ts:207-216, :657-695) y Pinnacle rechaza mercados asimétricos
(lib/pinnacle.ts:146-170)— pero al mapear el candidato se elige un lado
(lib/pickGen.ts:923-993), cada book se reduce a {source, ml} del lado
elegido (:1047-1051) y picks guarda un solo odds_decimal. Las únicas
excepciones parciales son pinnacle_cache (ambos lados, TTL 600s) y
line_openings (ambos lados de la casa primaria al primer avistamiento,
sin nombre de casa).

Consecuencias, ambas bloqueantes:
  - Sin los dos lados no hay overround y por tanto no hay de-vig. Toda
    la Fase 2 es inejecutable.
  - El histórico NO es reconstruible. No se puede de-viggear hacia
    atrás y NUNCA debe fabricarse el lado faltante a partir del lado
    apostado.

Modo de fallo si se ignora: la normalización proporcional devuelve un
número plausible sobre un solo lado, las probabilidades salen
silenciosamente sesgadas, y todo aguas abajo hereda el sesgo sin señal
de error. El pipeline corre verde.

Además, el consenso actual mezcla magnitudes incompatibles y hay que
rehacerlo aquí: computeMarketConsensus (lib/edge.ts:44-79) promedia el
implícito CON vig de DK, el CON vig de Pinnacle y el espn_bpi, que es
probabilidad de modelo y ya viene SIN vig. Con overround 1.048 cada
implícito de casa está inflado ~2.4pp y el BPI no, así que el sesgo del
promedio varía según cuántas fuentes de casa entraron ese día. Corolario:
edge_vs_market histórico NO es comparable entre picks.

Capa única que: empareja ambos lados del moneyline, convierte a
probabilidades implícitas, elimina el vig, detecta mercados incompletos,
rechaza pares con timestamps o eventos incompatibles, y registra el
método usado.

Método inicial, normalización proporcional:
  q_home = 1/odds_home ; q_away = 1/odds_away
  p_home = q_home/(q_home+q_away) ; p_away = q_away/(q_home+q_away)

El diseño debe permitir comparar después power method o Shin sin
reescribir el pipeline. Tests unitarios con casos conocidos, incluyendo
overrounds extremos y mercados de un solo lado.

## FASE 3 — CONSENSO SHARP

Motor que soporte promedio simple sin vig, mediana, y promedio ponderado
configurable.

Persiste: fuentes usadas, fuentes rechazadas y por qué, dispersión entre
fuentes, timestamp más antiguo y más reciente, peso aplicado a cada una.

Los pesos NO se optimizan contra ROI al inicio. Explícitos, predefinidos,
versionados. Optimizar pesos contra el mismo histórico que los valida es
overfitting garantizado.

Sin las fuentes mínimas obligatorias, no se genera pick apostable. Se
genera observación con el motivo exacto.

## FASE 4 — BENCHMARK MARKET-ONLY

Modelo base SIN Claude. Su probabilidad final es el consenso sharp sin
vig. Calcula: edge de precio contra Draftea, EV central, EV conservador,
diferencia contra cada sharp, precio justo, momio mínimo aceptable.

Identificado como model_variant = market_only.

Es OBLIGATORIO. Sin él no se puede demostrar que Claude aporta algo.

## FASE 5 — CLAUDE RESIDUAL

Rediseñar el prompt para que Claude:
 - Reciba el consenso sharp como prior
 - NO reciba el momio de Draftea
 - NO reciba el edge calculado
 - NO reciba qué lado conviene apostar
 - Reciba solo información deportiva verificable y temporalmente correcta
 - Devuelva ajustes residuales desglosados, cada uno citando el dato del
   payload que lo justifica
 - Devuelva cero cuando no haya evidencia para apartarse del mercado
 - Devuelva incertidumbre

Formato conceptual:
```json
{
  "market_prior_probability": 0.478,
  "adjustments": [
    {"factor": "confirmed_starting_pitcher", "adjustment_pp": 1.2,
     "evidence": "..."}
  ],
  "total_adjustment_pp": 1.8,
  "adjusted_probability": 0.496,
  "lower_bound_probability": 0.472,
  "upper_bound_probability": 0.520,
  "confidence_raw": 0.61,
  "data_quality": "high",
  "warnings": []
}
```

CRÍTICO — los caps se aplican SERVER-SIDE, no se piden en el prompt. Hay
evidencia medida de que el LLM ignora los caps del prompt (72 de 166
picks de visitante exceden el cap de 58%). Pedirle un límite y confiar en
que lo respete es un patrón que ya falló en este proyecto.

La probabilidad final se recalcula y valida en el servidor. No se confía
en la aritmética que devuelve Claude.

Cualquier ajuste que cite datos ausentes del payload se rechaza y se
registra como alucinación. Persiste el conteo — es la métrica que decide
si Claude aporta o contamina.

## FASE 6 — CLASIFICACIÓN POR EV

Eliminar la probabilidad absoluta como condición primaria de tier.

Tiers propuestos: NO_BET, WATCH, VALUE, STRONG.
LOCK se elimina o se deja deshabilitado.

El tier depende de combinación explícita de: EV conservador, edge contra
consenso sharp, número de fuentes, dispersión, frescura, calidad de
datos, incertidumbre, CLV esperado.

DEPENDENCIA INVERTIDA TRAS LA FASE 0 (2026-07-28): LA FASE 6 DEPENDE
DE LA FASE 7, NO AL REVÉS.

La instrucción original —"no fijar thresholds sin analizar primero la
distribución histórica"— es correcta pero inejecutable: esa distribución
YA NO EXISTE. Los 511 analyzed_no_edge (57% de las 896 filas de picks)
se guardaron con real_probability=0, implied_probability=0, edge=0,
edge_vs_market NULL y original_odds NULL. El 100% de ellos.

Lo que queda es una muestra truncada justo por encima del propio piso
que se quiere retirar: sobre los 369 picks válidos, la mediana de
real_probability es 0.560 y el P25 es 0.480. Esa masa pegada al 0.55 es
la firma del filtro, no una propiedad del deporte. Fijar cortes ahí es
calibrar contra el sesgo que se está intentando eliminar.

Por tanto: los cortes por EV se fijan con la distribución que GENERE el
modo observación de la Fase 7, guardando probabilidades crudas sin
placeholders. Hasta entonces, cualquier valor es provisional y debe
declararse como tal.

Los thresholds van en configuración centralizada y versionada, NO
hardcodeados en múltiples archivos. Este proyecto ya tuvo el mismo rango
de tier hardcodeado en dos lugares que se desincronizaron y mintieron al
usuario durante semanas — y en la Fase 0 apareció una SEGUNDA copia viva
(app/(tabs)/home/page.tsx:161-165, que afirmaba "VALUE 55%+ todos los
deportes" cuando NFL exige 59%). Corregida en b0e2b0c derivándola de
SPORT_THRESHOLDS. Van dos.

Favoritos y underdogs recorren EXACTAMENTE el mismo pipeline. Ningún
filtro tipo probability >= 0.55 que impida estructuralmente un lado del
mercado.

## FASE 7 — MODO OBSERVACIÓN Y EXPERIMENTOS

Todo el sistema nuevo arranca con observation_only = true.

NO debe permitir: registrar apuestas desde UI, confirmar desde imagen,
ejecutar RPC de apuesta, ni enviar mensajes que parezcan recomendaciones
apostables.

SÍ debe: analizar todos los juegos, guardar candidatos aceptados y
rechazados con motivo, resolverlos, capturar precios posteriores,
calcular CLV, comparar variantes.

REUSO OBLIGATORIO: ya existe un mecanismo de observación en el repo
(picks.observation_only + guard en place_bet_atomic + 4 capas de bloqueo)
implementado para preseason NFL. Reúsalo, no construyas otro paralelo.

Tres variantes: market_only, market_plus_claude, legacy_model (control
temporal, sin apuestas).

Vista o endpoint que compare: número de candidatos, CLV medio, mediana de
CLV, % con CLV positivo, Brier score, log loss, calibración, ROI
hipotético, y desgloses por deporte, favorito/underdog, rango de momio, y
ventana pregame.

NO declarar ganador por ROI con muestra pequeña. Criterio principal: CLV
— SIEMPRE QUE la contradicción del CLV esté resuelta (ver W1).

## FASE 8 — CRITERIOS DE ACTIVACIÓN SELLADOS

EL CRITERIO DE CLV QUEDA EN PAUSA (Fase 0, 2026-07-28).

No se sella ningún criterio basado en CLV hasta que exista
instrumentación correcta. Razón: el CLV histórico (−1.003pp sobre n=41)
es 98% spread entre casas y NO dice nada sobre el modelo.

  CLV total almacenado          −1.003 pp
  brecha cross-book Draftea/DK  −0.985 pp
  movimiento real de DK         −0.018 pp   (sd 0.822 — ruido)

odds_at_bet es el precio de DRAFTEA leído por visión del ticket
(confirm/route.ts:337 → place_bet_atomic); odds_at_close es el cierre de
DRAFTKINGS vía ESPN. La prueba: odds_at_close nunca coincide con
odds_at_bet (0/39) y sí con original_odds en 14/39, porque ambos son DK.

Requisitos mínimos para reactivar el criterio: CLV medido contra LA
MISMA CASA, el MISMO LADO y un MOMENTO de cierre definido y registrado.
En concreto:
  - clv_market = (1/close_DK) − (1/original_odds_DK), de-vigged
  - book_gap   = (1/odds_at_bet) − (1/original_odds_DK), medido aparte
    y monitoreado, nunca sumado dentro del CLV
  - persistir casa, endpoint y timestamp de captura del cierre
  - fallback debe dar clv NULL, jamás 0 (hoy 5 de 44 filas están
    contaminadas así, indistinguibles de línea inmóvil)

Mientras tanto, la comparación de variantes de la Fase 7 no puede
declararse por CLV. Si hace falta un criterio provisional, usar Brier
score y log loss, que no dependen del precio de ejecución.

Antes de ver ningún resultado, persistir criterios explícitos para
considerar activar apuestas reales. Propón valores conservadores para
aprobación de Christian:
 - mínimo de observaciones cerradas
 - CLV medio > 0
 - IC del CLV que no sea claramente negativo
 - % de CLV positivo
 - cero errores de integridad
 - cobertura mínima de fuentes
 - Brier score no peor que market_only
 - market_plus_claude debe superar a market_only

Los valores finales requieren aprobación ANTES de codificarse. No
optimizar thresholds después de ver resultados sin crear una nueva
versión del experimento.

Contexto de potencia estadística, medido previamente: detectar un edge de
3pp sobre breakeven vía win rate requiere ~1,708 apuestas. CLV requiere
~25-155. Por eso CLV es el criterio — y por eso resolver su
instrumentación es bloqueante.

Advertencia sobre calibración: isotonic regression con muestras <2,000
EMPEORA activamente el modelo (Niculescu-Mizil & Caruana). Si propones
calibración, usa Platt o temperature scaling. No isotónica.

---

## DEUDA TÉCNICA A INCORPORAR AL PLAN POR FASES

 1. Kill switch del handler completo. auto_enabled solo corta la
    generación de picks; runResultsCheck se invoca aparte y nunca
    consulta ese flag. El sistema no tiene forma de pararse.
 2. Ninguna escritura destructiva sin backup previo.
 3. Constraints reales contra picks duplicados. Hoy: cero unique
    constraints en picks, solo dedup read-then-write en código. bets sí
    está protegida.
 4. Persistir la fuente de odds_at_close.
 5. Diagnóstico de odds_at_bet.
 6. Sustituir probabilidades placeholder por NULL.
 7. Tests de emparejamiento de eventos y equipos.
 8. Tests para nombres cortos: "Sox" (White Sox / Red Sox) rompió
    pickedSide porque el threshold exigía >=4 caracteres.
 9. Tests de temporadas y preseason.
10. Manejo explícito de fallos de Telegram (hay retry con backoff; faltan
    los call sites que descartan la promesa con void).
11. Protección contra eventos de la misma serie enlazados al partido
    equivocado. 46 de 50 bets auditables son mis-linkeables en principio:
    en series el mismo matchup se repite en ±3 días, y la auditoría
    contra ESPN verifica coherencia interna, no que el bet apunte al
    partido correcto. Un caso confirmado (09-jun).
12. Logs estructurados con IDs de fuente y timestamps.

---

## REGLAS NO NEGOCIABLES

 - NO usar Claude como fuente sharp (viola CAPA 1: sería validarse a sí
   mismo)
 - NO pasar momios sin sanitizar al prompt de Claude (leaka market bias)
 - NO filtrar partidos antes de analizarlos por límites artificiales
 - NO usar datos posteriores al momento de análisis
 - NO usar CSVs semanales ni dumps no-live en producción
 - NO confundir confidence_raw con probabilidad de ganar. Son
   semánticamente distintos. Confundirlos costó semanas de este proyecto.
 - NO concluir rentabilidad con muestras pequeñas
 - NO optimizar thresholds contra el mismo histórico sin lockbox
 - NO implementar cambio masivo sin fases
 - NO refactors no relacionados
 - Commits granulares por causa raíz
 - Cada migración reversible o con razón documentada
 - Toda lógica financiera nueva con tests
 - Antes de declarar listo: tsc --noEmit, tests, next build. Los tres.
 - NO desplegar automáticamente
 - NO activar apuestas reales
 - NO modificar bankroll histórico
 - NO alterar resultados o bets existentes salvo migración
   explícitamente aprobada

---

## FUENTES Y ESTADO ACTUAL (para referencia de los workers)

Fuentes: Pinnacle Guest API, DraftKings vía ESPN core API, The Odds API
(500 req/mes), ESPN (scores/lesiones/calendario/BPI), MLB Stats API (sin
key), NHL API (sin key), OpenWeather, y Draftea como casa de ejecución.

Regla dura vigente: tres fuentes sharp por deporte, excepto NHL que opera
con dos por limitación de ESPN.

Estado medido al 28-jul-2026:
 - Bankroll: $1,097.59 MXN
 - 79 bets; 68 del sistema, 11 backfill manual excluido vía
   bets.excluded_from_stats
 - Rendimiento del sistema: 35W-33L, 51.5% win rate, ROI −5.0%
 - Con n=68 y MDE ~11pp, ese −5% NO es distinguible de cero
 - CLV almacenado: −0.934pp sobre n=44, bajo investigación (W1)
 - Deportes activos: MLB, NBA, NHL, NFL. WNBA desactivada.
 - El repo tiene CERO tests. Los 10 runs verdes de CI son solo
   disparadores HTTP.
