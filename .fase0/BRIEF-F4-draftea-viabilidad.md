# BRIEF — Viabilidad de Draftea como fuente de momios (decisión de Fase 4)

Proyecto: `/Users/christian/code/pick-it-up`. Fecha: 2026-07-28.
Presupuesto: ~20-30 min.

## CONTEXTO

El sistema calcula el edge contra **DraftKings** (vía ESPN core API) pero Christian
apuesta en **Draftea**, que paga estructuralmente ~2% peor. Medición previa sobre 41
apuestas reales: ratio `precio_draftea / precio_DK = 0.98073`, sd 0.0174. Eso significa
que **todo el edge histórico está inflado ~1 pp por construcción** y que el "CLV"
almacenado es 98% spread entre casas, no movimiento de línea.

El repo **no toca Draftea como fuente de precios**: la única entrada de precios de
Draftea es Claude Vision leyendo screenshots de tickets **ya apostados**
(`lib/vision-extract-bet.ts:103`). Verificado: cero llamadas HTTP a cualquier host de
Draftea en `lib app components db supabase`.

Hay tres caminos y Christian decide. Tu trabajo es **reportar viabilidad del camino A
con evidencia de request real**, que es el único que no se puede decidir desde el
escritorio.

## TAREA PRINCIPAL — ¿Se pueden leer momios de Draftea programáticamente?

Investiga y responde **con evidencia de request real** (comando exacto + código de
respuesta + fragmento del cuerpo, o el error).

1. **¿Existe API pública o semi-pública de Draftea?**
   Punto de partida ya verificado el 27-jul (repítelo y amplíalo):
   - `www.draftea.com` → 301 → `www.draftea.mx` (200, HTML)
   - `api.draftea.com` → **404 con `content-type: application/json`** (el host existe y
     responde JSON, pero no expone raíz)

2. **Rutas candidatas a probar** (solo GET, sin autenticarte, sin credenciales):
   patrones habituales de casas de apuestas — `/v1`, `/api/v1`, `/sports`, `/events`,
   `/markets`, `/odds`, `/catalog`, `/sportsbook`, subdominios tipo
   `sportsbook.`, `sports.`, `odds.`, `graph`/`graphql`, `bff.`, `gateway.`.
   Documenta qué respondió cada una. Un 401/403 es información valiosa (existe y está
   protegida); un 404 JSON también (el router existe).

3. **¿Hay un `.well-known`, sitemap, o JS bundle público** que revele endpoints?
   `www.draftea.mx` es una web app: sus bundles JS suelen contener las URLs base de la
   API. Descarga el HTML, localiza los `<script src>`, y busca dentro cadenas tipo
   `api.`, `https://`, `/graphql`, `apiUrl`, `baseURL`. **Esto suele ser lo que resuelve
   la pregunta.**

4. **¿Requiere autenticación de sesión?** Si los endpoints de momios solo responden con
   token de usuario, dilo explícitamente: eso convierte el camino A en "scraping con
   sesión", que tiene otro perfil de riesgo y mantenimiento.

5. **Términos de servicio**: revisa si `draftea.mx` publica ToS que prohíban el acceso
   automatizado. Repórtalo como dato, no como veredicto.

## LÍMITES DUROS

- **Solo GET. Cero autenticación. Cero credenciales. Cero intentos de bypass.**
  No pruebes login, no uses cuentas, no fuerces nada protegido.
- **Volumen mínimo**: unas pocas decenas de requests en total, espaciados. No es un
  escaneo, es una inspección de superficie pública.
- Si algo pide credenciales o parece protegido, **anótalo y sigue** — no insistas.
- **Cero writes** en el repo salvo tu entregable.

## TAMBIÉN REPORTA (desde el escritorio, sin red)

6. **Camino B — spread como constante calibrada.** ¿Qué haría falta para medirlo bien?
   Ya existe un protocolo diseñado en `.fase0/W1-clv-instrumentacion.md` §3 (captura
   simultánea Draftea/DK en 6-8 juegos). Léelo y di: ¿cuántas observaciones hacen falta
   para una constante creíble, con qué frecuencia habría que re-medirla, y qué pasa si
   el spread varía por deporte o por rango de precio (la sd de 0.0174 sugiere que sí)?

7. **Camino C — subir `EDGE_THRESHOLD`.** Ya está calculado en
   `.fase0/W1-clv-instrumentacion.md` §5: el umbral requerido es **6.084%** (hoy 5.0%,
   en `lib/pickGen.ts:942`). Verifica esa aritmética de forma independiente y di si la
   compartes. Señala qué se pierde con este camino: ¿cuántos picks históricos habrían
   sobrevivido a 6.1% en vez de 5%? (Puedes estimarlo con la distribución de
   `edge_vs_market` que está en `.fase0/W4-analisis-historico.md` punto 9.)

## ENTREGABLE

`/Users/christian/code/pick-it-up/.fase0/F4-draftea-viabilidad.md`

Estructura: veredicto de A (VIABLE / NO VIABLE / VIABLE CON SESIÓN) con la evidencia
de request real arriba del todo, luego B y C.

Última acción: crear `/Users/christian/code/pick-it-up/.fase0/DONE-F4` con una línea
`OK ...` o `FAIL ...`.
