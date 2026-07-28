# DISEÑO — Endpoints abiertos y kill switch

Para aprobación antes de implementar. Fecha: 2026-07-28. HEAD: `def08ff`.
**Nada de esto está aplicado.**

---

## 1. EL PATRÓN DE AUTH QUE YA EXISTE

Idéntico en las 3 rutas de cron (`analyze:1010-1018`, `calibrate:36-45`,
`heartbeat:10-14`):

```ts
function authOk(req: Request): boolean {
  const expected = process.env.CRON_SECRET;
  if (!expected) return false;                       // sin secreto → cerrado
  const header = req.headers.get('authorization') ?? '';
  return header === `Bearer ${expected}`;
}

async function handle(req: Request) {
  if (!authOk(req)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  …
}
```

Los llamadores lo mandan así (`.github/workflows/*.yml`):
`curl -X POST -H "Authorization: Bearer $CRON_SECRET" "$APP_URL/api/cron/..."`.

Es correcto: falla cerrado si falta la env var, y compara la cadena completa.
*(Nota menor: comparación no constant-time. Irrelevante aquí — no es un oráculo
de timing explotable sobre HTTP con esta latencia.)*

---

## 2. BARRIDO COMPLETO — 16 de 19 rutas sin auth

| ruta | métodos | auth | escribe |
|---|---|---|---|
| `cron/analyze` | POST,GET | ✅ | sí |
| `cron/calibrate` | POST,GET | ✅ | sí |
| `cron/heartbeat` | POST,GET | ✅ | sí |
| `check-results` | POST | ❌ | **bets + bankroll** |
| `generate-picks` | POST | ❌ | **picks** |
| `bets` | POST | ❌ | **bets + bankroll** |
| `bets/[id]` | PATCH | ❌ | **bets + bankroll** |
| `bets/from-image` | POST | ❌ | sesión + Claude Vision |
| `bets/from-image/confirm` | POST | ❌ | **bets + bankroll** |
| `bets/reset-pending` | POST | ❌ | **bets** |
| `bankroll` | PATCH | ❌ | **bankroll** |
| `bankroll/recalculate` | GET,POST | ❌ | **bankroll** |
| `settings` | PATCH | ❌ | **settings (incl. auto_enabled)** |
| `picks/[id]/skip` | POST | ❌ | picks |
| `telegram/webhook` | POST | ❌ | **todo el flujo de apuesta** |
| `live-status` | POST | ❌ | lectura |
| `pending-picks` | GET | ❌ | lectura |
| `health`, `health/full` | GET | ❌ | lectura |

No hay `middleware.ts`. `vercel.json` solo tiene `{"crons": []}`. **No hay
protección a nivel de plataforma.** La app entera es pública.

### El titular real

El inventario decía "dos rutas públicas". Son **catorce que escriben**. Cualquiera
con la URL del deploy puede insertar apuestas, mover el bankroll, cambiar settings
—incluido `auto_enabled`— y resolver bets.

### La peor: `telegram/webhook`

1. **No valida el `secret_token` de Telegram.** Telegram soporta `setWebhook`
   con `secret_token`, que llega en `X-Telegram-Bot-Api-Secret-Token`. No se usa.
2. **No valida el `chat_id` contra `TELEGRAM_CHAT_ID`.** Esa env var existe y solo
   se usa para *enviar* (`lib/telegram.ts:23`), nunca para autorizar entrada.
3. **`handleCallback` toma el `sessionId` de `cq.data`** (dato del atacante,
   `:343-344`) y confirma esa sesión sin verificar quién la creó.

Un POST anónimo puede disparar Claude Vision (coste), mandar mensajes por el bot,
y confirmar una sesión pendiente. Y como `bets/from-image/confirm` también está
abierta, ni siquiera hace falta pasar por el webhook.

---

## 3. ⚠️ POR QUÉ NO APLIQUÉ LO QUE PEDISTE

Agregar `CRON_SECRET` a `check-results` y `generate-picks` **rompe la UI**. El
riesgo no venía de cron-job.org: viene del navegador.

| ruta | llamador real | efecto del guard |
|---|---|---|
| `check-results` | `components/ResultsRefresher.tsx:32` (**automático**) | se rompe |
| `check-results` | `components/ForceCheckResultsButton.tsx:16` | se rompe |
| `generate-picks` | `components/AnalyzeNowButton.tsx:28` | se rompe |

Los tres son `fetch()` desde el navegador **sin cabecera**. `CRON_SECRET` no puede
exponerse al cliente sin dejar de ser un secreto.

**Sobre cron-job.org:** ninguna de las dos rutas está agendada. `cron_runs` tiene
500 corridas y **todas son `analyze`** (última `2026-07-28T17:10:06Z`, cada 10 min).
`calibrate` y `heartbeat` los dispara GitHub Actions, ya con la cabecera.
`runResultsCheck()` se ejecuta **dentro** de `analyze`; `/api/check-results` es una
ruta manual duplicada. Así que cron-job.org no se rompe — **la UI sí**.

---

## 4. PROPUESTA — tres opciones

### ✅ Opción 1 (recomendada): Vercel Deployment Protection + bypass

Protege **las 19 rutas y la UI** con un cambio de configuración, no de código.

1. Vercel → Settings → Deployment Protection → **Standard Protection** (SSO de la
   cuenta) o **Password Protection**.
2. Generar **Protection Bypass for Automation** y añadir la cabecera
   `x-vercel-protection-bypass: <token>` a los 3 llamadores automáticos:
   - los 2 workflows de `.github/workflows/`
   - el job de cron-job.org que pega a `/api/cron/analyze`
3. Telegram: re-registrar el webhook con el token de bypass en la query string
   (`?x-vercel-protection-bypass=…`), porque Telegram no manda cabeceras propias.

**A favor:** cierra las 16 rutas de golpe, incluida la UI, sin tocar código.
**En contra:** depende del plan de Vercel; hay que coordinar 4 llamadores en el
mismo cambio o algo se cae.

### Opción 2: `middleware.ts` con cookie de sesión

Un middleware que exige cookie firmada para todo salvo `/api/cron/*` (que ya tiene
`CRON_SECRET`) y `/api/telegram/webhook` (que pasaría a validar `secret_token`).
Una pantalla mínima de contraseña emite la cookie.

**A favor:** independiente de Vercel, control fino, la UI sigue funcionando.
**En contra:** es código nuevo en el camino crítico y hay que escribirlo bien.

### Opción 3: mínimo viable inmediato

Sin resolver la UI, cerrar solo lo que no tiene llamador de navegador:
- `secret_token` + allowlist de `chat_id` en `telegram/webhook`
- `authOk` en `bets/reset-pending` y `bankroll/recalculate` (verificar llamadores)

**A favor:** hoy, sin coordinación.
**En contra:** deja abiertas `bets`, `bankroll`, `settings` y `bets/[id]`.

> **Mi recomendación: Opción 1**, y si el plan de Vercel no la ofrece, Opción 2.
> La Opción 3 sola deja el bankroll escribible por cualquiera.

---

## 5. KILL SWITCH — diseño

### El problema, verificado

`auto_enabled === false` solo hace `return` **dentro** de `runAnalyzeWindow()`
(`analyze/route.ts:146`). `handle()` (`:1017`) llama:

```
:1029  runAnalyzeWindow()      ← único gate
:1036  runResultsCheck()       ← NO consulta el flag  → resolve_bet_atomic, bankroll
:1043  cleanupOrphanedPicks()  ← NO consulta el flag  → update picks
```

cada una en su propio `try`. De 10 apariciones de `auto_enabled` en el repo, **una
sola** es un gate de comportamiento.

### Decisión de diseño: dos flags, no uno

**No sobrecargar `auto_enabled`.** Hoy significa "no generes picks
automáticamente", y es legítimo querer pausar la generación mientras se siguen
resolviendo apuestas ya colocadas. Fundirlos quita esa capacidad.

| flag | significado | corta |
|---|---|---|
| `auto_enabled` (existe) | no generar picks automáticamente | solo `runAnalyzeWindow` |
| **`system_paused`** (nuevo) | **kill switch: el sistema no escribe nada** | analyze + resultsCheck + cleanup + rutas públicas + RPCs |

Acompañan `system_paused_reason` (text) y `system_paused_at` (timestamptz), para
que quede registrado quién y por qué, en vez de un booleano mudo.

### Dónde se aplica — 3 capas, siguiendo el patrón de `observation_only`

El modo observación ya estableció el patrón correcto: el guard más fuerte vive
**dentro de la RPC**, donde ninguna ruta lo puede saltar
(`20260727120000_preseason_observation_only.sql:40-121`). El kill switch usa lo mismo.

**Capa 1 — handler completo** (`analyze/route.ts`): leer settings una vez al inicio
de `handle()` y envolver las tres llamadas. El `return` de `:146` se queda como
defensa en profundidad, no como único gate.

**Capa 2 — rutas de escritura**: mismo gate en `check-results`, `generate-picks`,
`bets`, `bets/[id]`, `bets/from-image/confirm`, `bets/reset-pending`, `bankroll`.
Un POST autenticado tampoco debe escribir con el switch en `false`.

**Capa 3 — RPC (la que no se puede saltar)**: guard al inicio de
`place_bet_atomic`, `resolve_bet_atomic` y `adjust_bankroll_atomic`:

```sql
if (select system_paused from settings limit 1) then
  raise exception 'system_paused: writes are disabled';
end if;
```

Con la capa 3, **da igual qué ruta se llame ni desde dónde**: si el switch está
puesto, no se escribe. Es lo que hace del switch un corte real y no una convención.

### Orden de aplicación (regla dura del proyecto)

1. **Migración PRIMERO**: columnas en `settings` + guards en las 3 RPC.
2. **Deploy DESPUÉS**: el código que lee `system_paused`.

Si sale al revés, PostgREST rechaza la columna desconocida y cae el pipeline.
Y ojo: `supabase db push` aplica **todas** las migraciones pendientes.

### Cómo se acciona

`UPDATE settings SET system_paused = true, system_paused_reason = '…',
system_paused_at = now();` — un solo statement desde cualquier cliente SQL, sin
depender de que la UI o Vercel estén sanos. Que es justo lo que hace falta cuando
algo se está saliendo de control.

### Criterio de aceptación

Con `system_paused = true`:
- `POST /api/cron/analyze` autenticado → `{ paused: true }`, cero escrituras.
- `resolve_bet_atomic` llamada directa → excepción `system_paused:`.
- Un bet en `pending` cuyo juego ya terminó sigue en `pending` tras una corrida.
- `auto_enabled = false` con `system_paused = false` → los bets **sí** se
  resuelven (comportamiento actual preservado).
