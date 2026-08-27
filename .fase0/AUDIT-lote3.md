app/api/cron/analyze/route.ts:1094-1120 + app/api/check-results/route.ts:288-314 ignoran `rpcData.skipped` y aplican ELO por bet/ruta; dos bets o carreras concurrentes cuentan el mismo juego varias veces — BLOQUEA
app/api/telegram/webhook/route.ts:396-445 borra la sesión antes del fetch; si el servidor debita y se pierde la respuesta, afirma “NO fue registrada” y un ticket sin `pick_id` puede reintentarse y debitarse otra vez — BLOQUEA
app/api/cron/analyze/route.ts:335-350 reclama `telegram_notified_at` antes de `sendPicksBatch`; el nuevo throw de línea 242 no libera el claim y deja picks marcados sin envío — BLOQUEA
lib/pickGen.ts:1630-1668 convierte fallos de markers `analyzed_no_odds_data` en throw y aborta todo `analyzeGames` en vez de saltar ese juego — BLOQUEA
app/api/cron/analyze/route.ts:586-646 hace throw por markers `analyzed_no_edge` después de generar/persistir picks, impidiendo que el lote llegue al envío — BLOQUEA
lib/learning.ts:115-118,170-239 propaga fallos auxiliares de learning; tras insertar un pick o resolver una bet aborta el resto del lote y su notificación — BLOQUEA
app/api/check-results/route.ts:363-433 + app/api/cron/analyze/route.ts:1146-1209 seleccionan unnotified sin claim; ejecuciones concurrentes pueden enviar dos veces antes de marcar — ARREGLAR-DESPUÉS
app/api/live-status/route.ts:15-67 + components/BetResolver.tsx:68-76 único caller encontrado adaptado al shape discriminado — OK
app/api/check-results/route.ts:42-65,145-181 y app/api/cron/analyze/route.ts:985-1013 corrigen 76ers/push ML sin hallar resolución aritmética incorrecta — OK
tsc: `npx tsc --noEmit --incremental false` pasó — OK
