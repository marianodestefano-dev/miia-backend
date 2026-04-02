# 🔴 ZONA CRÍTICA — WHATSAPP QR & VINCULACIÓN

> **LEER ANTES DE TOCAR CUALQUIER ARCHIVO LISTADO AQUÍ**

---

## ⛔ ARCHIVOS PROTEGIDOS

| Archivo | Zona crítica |
|---|---|
| `server.js` | Funciones: `initWhatsApp()`, `handleIncomingMessage()`, evento `message_create`, evento `qr`, evento `ready`, evento `authenticated`, evento `disconnected` |
| `firestore_session_store.js` | Todo el archivo — manejo de sesión WA en Firestore |

---

## 📋 PROTOCOLO OBLIGATORIO ANTES DE MODIFICAR

Si necesitás tocar alguno de estos archivos en la zona crítica, seguí este orden **sin saltarte ningún paso**:

### Paso 1 — Justificación
Explicar por escrito:
- ¿Por qué es necesario el cambio?
- ¿Hay alguna alternativa que NO toque esta zona?
- ¿Cuál es el riesgo si el cambio falla?

### Paso 2 — Backup
```bash
# Correr esto ANTES de cualquier cambio
cp server.js backups/server.js.$(date +%Y%m%d_%H%M%S).bak
cp firestore_session_store.js backups/firestore_session_store.js.$(date +%Y%m%d_%H%M%S).bak
```

### Paso 3 — Cambio mínimo
Solo tocar lo estrictamente necesario. Nada de refactors, limpieza ni "mejoras" de paso.

### Paso 4 — Deploy y testeo
- Deploy a Railway
- Esperar que aparezca en logs: `✅ WHATSAPP LISTO` y `📱 Número conectado`
- Verificar que la sesión se guarda: `Session saved successfully`
- Mariano testea enviando "hola miia" desde su chat propio

### Paso 5 — Informe
Entregar reporte completo con logs antes y después.

---

## 🗂️ AUDITORÍA — Fallos del 29-30 Mar 2026

### Fallo 1: auth timeout en Railway
- **Qué pasó:** Railway IP bloqueada por WhatsApp tras múltiples intentos de conexión
- **Por qué:** Loop de reintentos automáticos sin backoff
- **Fix:** Eliminados reintentos automáticos. Solo manual.
- **Estado:** ✅ Resuelto

### Fallo 2: "Navegador no compatible"
- **Qué pasó:** WhatsApp Web rechazaba Chromium de Railway
- **Por qué:** userAgent era el de Chromium genérico, no Chrome real
- **Fix:** Hardcodeado userAgent de Chrome 120 Windows
- **Estado:** ✅ Resuelto

### Fallo 3: Gemini 503/404
- **Qué pasó:** gemini-2.5-pro (503 overloaded), gemini-2.0-flash (404), gemini-1.5-flash (404)
- **Por qué:** Modelos incorrectos o con alta demanda
- **Fix:** Hardcodeado gemini-2.5-flash. NO usar variable de entorno GEMINI_URL para el modelo principal.
- **Estado:** ✅ Resuelto

### Fallo 4: Firebase DECODER error
- **Qué pasó:** `error:1E08010C:DECODER routines::unsupported` en todas las operaciones Firestore
- **Por qué:** FIREBASE_PRIVATE_KEY en Railway tenía formato incorrecto (incluía el nombre del campo JSON)
- **Fix:** Corregida la variable en Railway + mejorado el parsing en server.js
- **Estado:** ✅ Resuelto

### Fallo 5: ENOENT crash
- **Qué pasó:** `unlink ... RemoteAuth-tenant-...zip ENOENT` crasheaba el proceso
- **Por qué:** whatsapp-web.js intenta borrar el zip después de guardarlo, pero el filesystem de Railway es efímero
- **Fix:** Handler de `unhandledRejection` que captura y silencia ese error específico
- **Estado:** ✅ Resuelto

### Fallo 6: Zip 0.00MB (sesión corrupta)
- **Qué pasó:** Firestore guardaba la sesión pero al extraerla el zip era de 0 bytes
- **Por qué:** El crash ENOENT ocurría durante el proceso de extracción corrompiendo el archivo
- **Fix:** Validación en `extract()` que detecta base64 < 1000 chars y limpia la sesión corrupta
- **Estado:** ✅ Resuelto

### Fallo 7: Self-chat bloqueado
- **Qué pasó:** "hola miia" desde el chat propio no recibía respuesta
- **Por qué:** Guard `from === to → return` bloqueaba todos los mensajes del self-chat
- **Fix:** Condición modificada para permitir mensajes `fromMe` en self-chat
- **Estado:** ✅ Resuelto

### Fallo 8: QR no aparecía en dashboard sin /init previo
- **Qué pasó:** "Tenant no encontrado" al abrir el modal de QR
- **Por qué:** El endpoint `/api/tenant/:uid/qr` requería que el cliente ya estuviera inicializado
- **Fix:** Auto-init del owner cuando llega al endpoint QR sin cliente activo
- **Estado:** ✅ Resuelto

---

## ✅ ESTADO ACTUAL (30 Mar 2026, 15:22)

- WhatsApp conectado: **+573054169969**
- Sesión en Firestore: **SÍ** (3.89MB, 7 chunks)
- ENOENT crash: **NO ocurre**
- Gemini respondiendo: **SÍ** (gemini-2.5-flash)
- Self-chat (hola miia): **SÍ**
- Leads respondiendo: **SÍ**

---

## ⛔ PROTECCIÓN PDF COTIZACIÓN (ZONA CRÍTICA — NO TOCAR)

### Archivos involucrados
| Archivo | Zona protegida |
|---|---|
| `server.js` línea ~1170 | `const isSelfChat = isAlreadySavedParam` — detección self-chat |
| `server.js` línea ~515 | `typeof content === 'string' &&` guard en safeSendMessage |
| `server.js` línea ~544 | Branch `content.document` en safeSendMessage |
| `server.js` línea ~1854 | Caller de `enviarCotizacionWA(safeSendMessage, phone, cotizData, isSelfChat)` |
| `cotizacion_generator.js` línea ~741 | `enviarCotizacionWA(sendFn, phone, params, isSelfChat)` |

### Lección aprendida (Fallo 9 — PDF no llegaba al self-chat)
- **Qué pasó:** PDF se generaba OK (176KB, logs OK) pero nunca llegaba al WhatsApp de Mariano
- **Por qué (bug 1):** Heurística `!phoneBase.startsWith('1')` excluía device ID `136417472712832` (empieza con '1')
- **Por qué (bug 2):** `ownerSock.user.id` da el TELÉFONO (`573054169969`), pero `phone` tiene el DEVICE ID (`136417472712832`). Son diferentes — la comparación siempre daba `false`.
- **Fix:** Usar `isSelfChat` que ya existía en `processMiiaResponse` (viene de `fromMe=true`), NO recalcular. Delegar envío a `safeSendMessage` que maneja `@lid` correctamente.
- **Dato clave:** `ownerSock.user.id` = número de teléfono real. `phone` en self-chat = device ID. **NUNCA van a matchear.**
- **Estado:** ✅ Resuelto (commits ad1562b + d70649a, 2026-04-02)
- **Funcionó entre el 28-30 marzo** porque se usaba whatsapp-web.js (Chromium) que maneja self-chat nativamente.

### ⚠️ REGLAS ABSOLUTAS PARA PDF EN SELF-CHAT
1. **NUNCA** comparar `ownerSock.user.id` con `phone` para detectar self-chat — son IDs distintos
2. **SIEMPRE** usar `isSelfChat` que viene de `isAlreadySavedParam` (que viene de `fromMe=true`)
3. **NUNCA** usar heurísticas de longitud/prefijo de número para detectar device IDs
4. **SIEMPRE** enviar documentos a través de `safeSendMessage` (que convierte `@s.whatsapp.net → @lid`)
5. **NUNCA** llamar `sock.sendMessage()` directamente para documentos — usar `safeSendMessage`
6. El backup está en `cotizacion_generator.js.backup`

---

## ⚠️ PENDIENTE MONITOREAR

- Railway sigue reiniciándose espontáneamente (posible OOM por ráfagas de mensajes)
- El número 573163937365 genera ráfagas que pueden saturar memoria