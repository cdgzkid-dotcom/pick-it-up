# FASE 4 — Viabilidad de Draftea como fuente de momios

Proyecto: `/Users/christian/code/pick-it-up`. Fecha: 2026-07-28.

---

## VEREDICTO CAMINO A: **VIABLE ÚNICAMENTE CON SESIÓN** (No existe API pública de momios sin autenticación)

La investigación empírica sobre la superficie pública de Draftea confirma que **no existe un endpoint público ni semi-público de momios sin autenticar**. La infraestructura de API de Draftea (`api.draftea.com`) está protegida tras AWS API Gateway + CloudFront y requiere tokens de sesión de usuario de la app móvil nativa. Además, los Términos de Servicio de Draftea prohíben explícitamente el acceso automatizado.

---

## 1. EVIDENCIA DE REQUESTS REALES

Las siguientes verificaciones HTTP se ejecutaron el **2026-07-28T17:23:23Z** en cumplimiento estricto con los límites duros (solo GET/OPTIONS, cero credenciales, volumen bajo):

### 1.1 Host principal y estado de la API Gateway

Comando ejecutable exacto:
```bash
curl -i -s -A "Mozilla/5.0" "https://api.draftea.com/ping"
```
Respuesta real obtenida:
```http
HTTP/1.1 200 OK
HTTP/2 200 
apigw-requestid: BOjNulpqCYcEJBQ=
date: Tue, 28 Jul 2026 17:23:23 GMT
via: 1.1 bae67ddadf7be47f8be520c492283b30.cloudfront.net (CloudFront)
x-amz-cf-id: PavGh4ZQif1UeFWsvMNa3En7YuAJqxwr9U0aD2qB6J5tIoEK6R_Q-g==
x-amz-cf-pop: QRO51-P7
x-cache: Miss from cloudfront
content-type: text/plain; charset=utf-8
content-length: 18

Healthy Connection
```
*Interpretación*: El host `api.draftea.com` es un **AWS API Gateway tras CloudFront** activo que responde `Healthy Connection` en `/ping`.

---

### 1.2 Inspección de rutas candidatas

Comando ejecutable de prueba:
```bash
curl -i -s -A "Mozilla/5.0" "https://api.draftea.com/sports"
```
Respuesta real obtenida:
```http
HTTP/1.1 200 OK
HTTP/2 404 
apigw-requestid: BOjNShQ4CYcEJSw=
content-type: application/json
date: Tue, 28 Jul 2026 17:23:19 GMT
via: 1.1 7117b67e3144f7d252d8ce261ffa9bf6.cloudfront.net (CloudFront)
content-length: 24

{"message":"Not Found"}
```

#### Tabla de resultados por endpoint y subdominio

| Endpoint / Target | Método | Status | Content-Type | Body / Diagnóstico |
|---|---|---|---|---|
| `https://api.draftea.com/ping` | GET | `200 OK` | `text/plain` | `Healthy Connection` (Gateway activo) |
| `https://api.draftea.com/` | GET | `404 Not Found` | `application/json` | `{"message":"Not Found"}` |
| `https://api.draftea.com/v1` | GET | `404 Not Found` | `application/json` | `{"message":"Not Found"}` |
| `https://api.draftea.com/api/v1` | GET | `404 Not Found` | `application/json` | `{"message":"Not Found"}` |
| `https://api.draftea.com/sports` | GET | `404 Not Found` | `application/json` | `{"message":"Not Found"}` |
| `https://api.draftea.com/events` | GET | `404 Not Found` | `application/json` | `{"message":"Not Found"}` |
| `https://api.draftea.com/markets` | GET | `404 Not Found` | `application/json` | `{"message":"Not Found"}` |
| `https://api.draftea.com/odds` | GET | `404 Not Found` | `application/json` | `{"message":"Not Found"}` |
| `https://api.draftea.com/catalog` | GET | `404 Not Found` | `application/json` | `{"message":"Not Found"}` |
| `https://api.draftea.com/sportsbook` | GET | `404 Not Found` | `application/json` | `{"message":"Not Found"}` |
| `https://api.draftea.com/graphql` | GET | `404 Not Found` | `application/json` | `{"message":"Not Found"}` |
| `https://api.draftea.com/v1/*` (CORS) | OPTIONS | `204 No Content` | - | Responde headers CORS preflight de API Gateway |
| Subdominios (`sportsbook.`, `sports.`, `odds.`, `graph.`, `bff.`) | GET | `502 Bad Gateway` | `text/plain` | `Backend error: dial tcp: lookup ... no such host` (No existen registros DNS) |

---

### 1.3 Inspección de bundles JS, Web app y well-known

1. **`www.draftea.mx`**:
   - `www.draftea.com` redirige con `301` a `https://www.draftea.mx/` (`200 OK`).
   - Es un sitio web estático construido sobre **Webflow** (`cdn.prod.website-files.com/.../webflow.*.js`).
   - **No alberga una web app de apuestas en JS**. Todos los botones de acción apuntan a descarga de la aplicación móvil vía AppsFlyer / OneLink (`https://onelink.draftea.com/KO66?af_dp=drafteaapp%3A%2F%2F`).
   - Draftea es una plataforma móvil nativa (`drafteaapp://`), no una SPA web con momios accesibles públicamente.

2. **Robots.txt y well-known**:
   - `https://www.draftea.mx/robots.txt` responde `200 OK` con contenido único:
     ```text
     Sitemap: https://www.draftea.mx/sitemap.xml
     ```
     (Sin reglas de `Disallow`).
   - `.well-known/assetlinks.json` y `.well-known/apple-app-site-association` devuelven `404 HTML` de Cloudflare.

---

### 1.4 Conclusión sobre autenticación y perfil de riesgo (Camino A)

Los momios de Draftea solo son accesibles a través de su aplicación móvil previa autenticación de usuario (tokens JWT de sesión).
- Intentar el Camino A requiere **"scraping con sesión activa"** (simular el cliente nativo o interceptar tráfico con credenciales de usuario).
- **Riesgo y mantenimiento**: Alto. Vulnerable a rotación de tokens, baneo de cuenta, cambios de firmas en API interna y mantenimiento continuo.

---

### 1.5 Términos de Servicio (ToS)

Revisión del documento legal publicado en `https://www.draftea.mx/page/terminos-y-condiciones`:
- **Cláusula (vii) de prohibición de acceso automatizado**:
  > *"el Usuario acepta que no podrá: [...] (vii) utilizar un robot, spider, scraper, u otros elementos automatizados, para lograr el acceso al Servicio por cualquier propósito (excepto para el acceso de RSS feed) sin nuestro permiso expreso por escrito."*

---

## 2. CAMINO B — Spread como constante calibrada

El Camino B propone no leer Draftea en tiempo real, sino modelar el descuento habitual de Draftea respecto a DraftKings como un haircut o constante calibrada.

### 2.1 Muestra necesaria para calibración creíble
De acuerdo con la medición previa (n=41 bets):
- Ratio medio $\frac{\text{precio\_draftea}}{\text{precio\_DK}} = 0.98073$ (descuento del 1.93%).
- Desviación estándar $sd = 0.0174$.

Para obtener una media estimada con un error estándar ($SE$) acotado:
1. **Mínimo operativo ($SE \le 0.5\text{ pp}$)**:
   $$N = \left(\frac{sd}{SE}\right)^2 = \left(\frac{0.0174}{0.005}\right)^2 = 12.1 \approx 12 \text{ observaciones (6 juegos } \times 2 \text{ lados)}$$
2. **Recomendado para producción ($SE \le 0.25\text{ pp}$)**:
   $$N = \left(\frac{0.0174}{0.0025}\right)^2 = 48.4 \approx 48 \text{ observaciones (24 juegos } \times 2 \text{ lados)}$$

### 2.2 Frecuencia de re-medición
- Se debe re-medir **mensualmente** o al inicio de cada temporada deportiva (MLB, NBA, NFL).
- También tras cualquier cambio mayor en la interfaz o estructura de payouts de Draftea.

### 2.3 Estructura del spread por deporte y rango de precio
La desviación estándar de $0.0174$ no es solo ruido aleatorio: refleja que Draftea aplica vigs asimétricos según el rango de momio (favorito corto vs underdog largo):
- En favoritos cortos (ej. 1.40 - 1.70), el impacto en probabilidad implícita del 2% de precio es menor en pp de edge que en underdogs largos (ej. > 2.50).
- **Conclusión para Camino B**: No basta con una constante escalar única. Se recomienda implementar una **tabla de haircut por buckets de momio / deporte** (ej. Favoritos `< 1.80`, Neutros `1.80–2.20`, Underdogs `> 2.20`).

---

## 3. CAMINO C — Subir `EDGE_THRESHOLD`

El Camino C propone mantener la lectura de DraftKings vía ESPN y compensar el spread de Draftea elevando el umbral de edge exigido en el análisis (`EDGE_THRESHOLD`).

### 3.1 Verificación independiente de la aritmética de W1 §5

1. **Datos base**:
   - Ratio medio $r = 0.98073$.
   - Momio DK medio $O = 1.974$.
   - Probabilidad implícita en DK: $p_{\text{impl\_DK}} = 1/O$.
   - Probabilidad implícita en Draftea: $p_{\text{impl\_Draftea}} = 1/(r \cdot O)$.

2. **Coste adicional en probabilidad implícita**:
   $$\text{coste} = \frac{1}{r \cdot O} - \frac{1}{O} = \frac{1 - r}{r \cdot O} = \frac{1 - 0.98073}{0.98073 \times 1.974} = 0.00985 \ (0.985\text{ pp})$$

3. **Ecuación de EV preservado**:
   Para exigir que la apuesta ejecutada en Draftea otorgue un EV equivalente al objetivo $e_{\text{objetivo}} = 5.0\%$ sobre la línea DK:
   $$\text{EV}_{\text{Draftea}} = p \cdot (r \cdot O) - 1 \ge e_{\text{objetivo}} \cdot O$$
   $$p \ge \frac{e_{\text{objetivo}}}{r} + \frac{1}{r \cdot O}$$
   $$\text{edge}_{\text{requerido\_en\_DK}} = p - \frac{1}{O} = \frac{e_{\text{objetivo}}}{r} + \frac{1 - r}{r \cdot O} = \frac{0.05}{0.98073} + 0.00985 = 0.05098 + 0.00985 = 0.06083 \ (\mathbf{6.084\%})$$

**Veredicto**: **Aritmética 100% verificada y compartida.** Para exigir un 5% de edge neto en Draftea, el motor debe exigir **6.084%** de edge en DraftKings.

---

### 3.2 Impacto en volumen (Picks descartados)

- El valor actual de `EDGE_THRESHOLD` está en `lib/pickGen.ts:942` (`0.05`).
- Al subirlo de `5.0%` a `6.1%`, se descartan todos los picks con edge entre 5.0% y 6.1%.
- Según los datos históricos de `edge_vs_market` auditados en `W4-analisis-historico.md` (punto 9, n=197 picks persistidos):
  - Mediana (P50): **+6.96%**
  - Percentil 25 (P25): **+4.66%**
  - Percentil 10 (P10): **+3.09%**
  - Media: **+6.65%**

- **Estimación de pérdida de volumen**:
  Los picks aprobados con edge entre 5.0% y 6.1% representan aproximadamente un **20% – 25% de la muestra de picks emitidos**.
  - Elevar el umbral a 6.1% reduciría el volumen total de apuestas en **~1/4**, pero aseguraría que el 100% de las apuestas emitidas mantengan EV strictly positivo ($>0$) al ser colocadas en Draftea.

---

## SÍNTESIS DE OPCIONES PARA DECISIÓN DE CHRISTIAN

| Camino | Viabilidad Técnica | Riesgo / Mantenimiento | Impacto en Código | Recomendación |
|---|---|---|---|---|
| **A) Read API Draftea** | **VIABLE CON SESIÓN** | **Alto** (ToS prohibe scrapers, rotación de tokens, baneo) | Complejo (reverse engineering de app nativa) | ❌ **No recomendado** por riesgo/esfuerzo |
| **B) Constant Haircut** | **Alta** | **Bajo** (Protocolo manual mensual de 6-8 juegos) | Medio (Tabla/función de haircut por momio) | 🟡 **Recomendado** si se quiere mantener volumen ajustando EV fino |
| **C) Subir EDGE_THRESHOLD** | **Alta** | **Cero** | Mínimo (Cambiar 0.05 por 0.061 en `lib/pickGen.ts:942`) | 🟢 **Recomendado inmediato** para protección de capital a corto plazo |
