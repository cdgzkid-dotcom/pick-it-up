# BRIEF W2 — Mapeo estático exhaustivo del pipeline analítico

Antes de nada, lee `/Users/christian/code/pick-it-up/.fase0/00-CONTEXTO-COMPARTIDO.md`.

## RESTRICCIONES DE TU CARRIL

**TODO ES LOCAL.** No necesitas red ni base de datos, y no las tienes: tu sandbox NO
resuelve DNS. No intentes tocar Supabase ni APIs externas — fallará y perderás tiempo.
Lectura estática del repo únicamente. **No modifiques ningún archivo** salvo tu
entregable en `.fase0/`.

Directorio: `/Users/christian/code/pick-it-up`, HEAD actual.
Presupuesto: ~30-45 min. Esta es una tarea de BARRIDO: prioriza exhaustividad sobre
elegancia. Prefiero una lista larga y completa a un ensayo corto.

## TAREAS

### 1. Diagrama textual del flujo completo

De la obtención de momios hasta el registro del bet y el cálculo de CLV.
Con `archivo:línea` en **CADA** paso. Incluye las bifurcaciones y los caminos de error.

### 2. Localiza TODOS los lugares donde se calcula o consume

- probabilidades
- edge
- tiers
- unidades
- Kelly
- auditorías
- notificaciones
- persistencia de picks
- resolución de bets
- CLV

### 3. Tabla de consumidores por símbolo

Por cada uno de estos símbolos, lista **TODOS** sus consumidores con `archivo:línea` y
qué hace cada uno con él (lee / escribe / compara / deriva):

```
real_probability      confidence_raw       edge_vs_market
SPORT_THRESHOLDS      tierFromProbability  TIER_RANGE
odds_at_bet           odds_at_close        original_odds
picked_side           observation_only     excluded_from_stats
```

### 4. Pregunta específica: ¿el pick se asume favorito?

¿Existe alguna ruta donde `picked_side`, `real_probability` o el tier estén
**semánticamente ligados al favorito**? Busca supuestos implícitos de que el pick
siempre es el favorito: comparaciones contra 0.5, ordenamientos que asumen el lado más
probable, derivaciones de "el otro lado" por complemento, umbrales que solo tienen
sentido para odds < 2.00.

Esto es el corazón del rediseño: hay que poder recomendar underdogs.

### 5. Clasifica CADA módulo en una de tres cubetas

- **AGNÓSTICO al mercado** (sobrevive intacto: Kelly, bankroll, resolución, Telegram…)
- **ACOPLADO A DEPORTE** (hay que parametrizar)
- **ACOPLADO A MONEYLINE de dos resultados** (hay que reescribir)

Esto determina qué sobrevive al rediseño y qué hay que reescribir. Sé explícito con los
casos dudosos y di por qué dudas.

### 6. Thresholds hardcodeados que deberían estar centralizados

**Antecedente real**: `TIER_RANGE` vivía hardcodeado en `lib/units.ts`, se desincronizó
de los umbrales reales de `SPORT_THRESHOLDS`, y **mintió al usuario en tres pantallas
durante semanas** (corregido en `24af709`).

Busca si hay más casos del mismo tipo: constantes numéricas duplicadas entre módulos,
literales mágicos en componentes de UI que replican lógica de `lib/`, strings de rango
construidos a mano, cualquier valor que exista en dos lugares y pueda divergir.
Para cada hallazgo: `archivo:línea` de ambas copias y si hoy ya divergieron.

### 7. Contradicciones

Si encuentras algo que contradiga los hechos listados en el contexto compartido,
**dilo explícitamente**. Vale más que confirmar lo que ya sabemos.

## ENTREGABLE

`/Users/christian/code/pick-it-up/.fase0/W2-pipeline-map.md`

Luego, como ÚLTIMA acción:
`/Users/christian/code/pick-it-up/.fase0/DONE-W2` con una línea `OK ...` o `FAIL ...`.
