# BRIEF W4 — Análisis histórico reproducible

Antes de nada, lee `/Users/christian/code/pick-it-up/.fase0/00-CONTEXTO-COMPARTIDO.md`.
Sus reglas duras (cero writes, NO VERIFICABLE, sentinel de cierre) aplican a este brief.

Directorio: `/Users/christian/code/pick-it-up`, HEAD actual.
Credenciales de Supabase: `.env.local` en la raíz. **SOLO SELECT. CERO WRITES.**
Presupuesto: ~35-50 min.

## REGLA CENTRAL DE ESTE BRIEF

Produce **SQL reproducible** que responda cada punto: incluye la consulta literal junto
al resultado, para que Christian pueda re-correrla.

Si algo **no se puede responder con los datos existentes**, escribe
`NO VERIFICABLE` y la razón concreta. **NO INFIERAS DESDE PLACEHOLDERS.**
(Recordatorio: las filas `analyzed_no_edge` tienen `real_probability = 0`,
`implied_probability = 0`, `edge = 0`, `edge_vs_market = NULL` — son placeholders,
NO predicciones de 0%. Tratarlos como datos reales envenenaría cualquier promedio.)

## PUNTOS A RESPONDER

### 1. Volumen de favoritos vs underdogs
Cuántos candidatos favoritos (`odds < 2.00`) y underdogs (`>= 2.00`) ha generado el
sistema, por deporte y por periodo.

### 2. ⚠️ CONTRADICCIÓN A RESOLVER — el piso de 55%

El encargo original asume que **el piso de 55% impide recomendar underdogs**.
Una medición del 27-jul lo **contradice**:
- 79 underdogs de 248 picks MLB (**31.9%**)
- 25 de 68 bets fueron underdog
- El cap de visitante en MLB es 58% contra piso VALUE 0.55 → **3pp de margen**

**Confirma o refuta con tus propios datos.** Si NO hay bloqueo estructural, **dilo
claramente** — el rediseño sigue siendo correcto, pero por otra razón, y esa razón hay
que nombrarla. No adornes el resultado para que encaje con el encargo.

### 3. Underdogs eliminados por el piso
Cuántos underdogs fueron eliminados **EXCLUSIVAMENTE** por el piso de probabilidad
(no por otro filtro), y cuál habría sido su EV.

### 4. CLV de underdogs vs favoritos

Dato previo, a confirmar o corregir:
- favoritos n=30, CLV −0.874 pp
- underdogs n=14, CLV −1.065 pp
- Welch t = 1.68 → **no significativo**

⚠️ **ADVERTENCIA**: el CLV almacenado está bajo investigación por otro worker (W1), que
está determinando si mide movimiento de línea o spread entre casas. **Usa los números,
pero marca explícitamente que su validez depende de ese veredicto.**

### 5. CLV por rango de momio.

### 6. Qué filtros eliminan más underdogs
Ranking por volumen.

### 7. Reconstruibilidad
¿Los estados `analyzed_no_edge` conservan información suficiente para reconstruir todo
lo anterior? Responde con evidencia, no con impresión.

### 8. Daño de los placeholders
Cuantifica el daño de guardar `real_probability = 0` como placeholder: cuántas filas,
qué periodo, **qué análisis quedan imposibles**. Dato de partida: los 188
`analyzed_no_edge` del último mes son placeholders con probabilidad 0.

### 9. Distribuciones sobre TODOS los candidatos
Distribución de `edge_vs_market` y de `real_probability` sobre **todos** los candidatos,
no solo los notificados. Da percentiles, no solo media.

Esto es **necesario para la Fase 6** (fijar thresholds por EV): sin conocer la
distribución no se pueden elegir cortes. Si los placeholders del punto 8 hacen que esta
distribución sea parcial o irreconstruible, **dilo con esas palabras** — es un hallazgo
de primer orden, no una limitación menor.

### 10. Los caps del prompt no se respetan — cuantifica el fenómeno completo

Dato verificado: `lib/prompts.ts:323` declara cap de 58% para visitante en MLB, y
**72 de 166 picks de visitante tienen `real_probability` > 58%**.

Cuantifica el fenómeno completo: **¿con qué frecuencia y con qué magnitud el LLM excede
los caps?** Por deporte, por lado, distribución del exceso (no solo el conteo).

## ENTREGABLE

`/Users/christian/code/pick-it-up/.fase0/W4-analisis-historico.md`

Con el SQL incluido para que sea reproducible.

Luego, como ÚLTIMA acción:
`/Users/christian/code/pick-it-up/.fase0/DONE-W4` con una línea `OK ...` o `FAIL ...`.

Cero writes fuera de `.fase0/`. Contra Supabase solo SELECT.
