# TABLERO FASE 0 — pick-it-up

Lanzamiento: 2026-07-28. Tope: 60 min. Sentinel watcher: activo (task bki00tkav).

| Worker | pid Solo | Runtime | Tarea | Estado | Entregable |
|---|---|---|---|---|---|
| W1 | 276 | claude | CLV e instrumentación de precios (BLOQUEANTE) | corriendo | `W1-clv-instrumentacion.md` |
| W2 | 277 | codex `-s read-only -a never` | Mapeo estático del pipeline | corriendo | `W2-pipeline-map.md` |
| W3 | 278 | amp | Fuentes + schema real + colisiones | corriendo | `W3-fuentes-schema.md` |
| W4 | 279 | agy `--sandbox --dangerously-skip-permissions` | Análisis histórico SQL | corriendo | `W4-analisis-historico.md` |
| W5 | 280 | claude | Plan por fases, riesgos, tests, migraciones | corriendo | `W5-plan-riesgos.md` |

Todos escriben solo dentro de `.fase0/`. Cero writes en el repo, solo SELECT en Supabase.

## Incidencia de arranque

El encargo original traía la sección CONTEXTO sin resolver (placeholder literal). W1,
W2, W4 se lanzaron igual porque sus briefs eran autosuficientes; W3 se lanzó ya con el
documento incorporado, y W5 se lanzó ~4 min después, al llegar el documento. Ningún
worker recibió contenido inventado.

## Archivos de contexto

- `00-CONTEXTO-COMPARTIDO.md` — reglas duras + hechos verificados del proyecto
- `01-DOCUMENTO-REDISENO.md` — el documento de rediseño (Fases 1-8)
- `BRIEF-W{1..5}-*.md` — briefs individuales
