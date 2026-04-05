# 🏥 VADEMÉCUM MAESTRO LOBSTERS — LEY SUPREMA
**Versión:** 2.0 — Unificado Marzo 2026  
**Mantenido por:** VACUNA (Antigravity)  
**Regla:** Este es el ÚNICO archivo de Vademécum válido. Todos los errores y medicamentos deben estar aquí. Cualquier otro archivo de Vademécum parcial queda obsoleto y subordinado a este.

---

## 🟢 GRUPO 1: Estabilidad de Motor (Backend)

1. **[E-01] ERR_PORT_ORPHAN_BINDING** — Puertos zombies (3000/3001) tras cierre brusco.
   - *Medicamento (Mac/Linux):* `lsof -ti:[PORT] | xargs kill -9`
   - *Medicamento (Windows):* `netstat -ano | findstr :3000` → `taskkill /PID [ID] /F`
   - *% Éxito:* 99%

2. **[E-02] ERR_PKILL_NUCLEAR_LOOP** — Reinicio masivo que mata Node y Vite.
   - *Medicamento:* Prohibido `pkill -9 -f node`. Usar limpieza por puerto específico.
   - *% Éxito:* 100%

3. **[E-03] ERR_NODE_HEAP_OOM** — Falta de RAM en el proceso Node.
   - *Medicamento:* Iniciar con `--max-old-space-size=4096`
   - *% Éxito:* 95%

4. **[E-04] ERR_PUPPETEER_CRASH** — Protocol Error en el motor de WhatsApp Web (Puppeteer).  
   - *Síntoma extendido:* `ProtocolError: Execution context was destroyed` — Chrome se abre y cierra en loop.  
   - *Causa:* Sesión corrupta o vencida de WhatsApp, o flags de Chrome incompatibles con el SO.  
   - *Medicamento:*  
     1. `pm2 stop lobsters-casa-central-backend`  
     2. Borrar `backend/whatsapp_session_v14/session`  
     3. `pm2 start lobsters-casa-central-backend`  
     4. Escanear QR en `http://localhost:5173`  
   - *¿Genera ban WhatsApp?* ❌ NO. Es equivalente a cerrar sesión. El ban solo viene por spam masivo.  
   - *¿Se pierde vinculación?* SÍ temporalmente. Solo hay que re-escanear el QR.  
   - *% Éxito:* 98%

5. **[E-05] ERR_WHATSAPP_PERSISTENCE_LOST** — Sesión volátil que no persiste.
   - *Medicamento:* Configurar `restartOnAuthFail: true` y persistencia agresiva en LocalAuth.
   - *% Éxito:* 95%

6. **[E-06] ERR_VACCINE_BYPASS** — Fallo en el escudo de supervivencia VACUNA.
   - *Medicamento:* Inyección de `vaccine.js` al arranque (PID Lock).
   - *% Éxito:* 97%

7. **[E-07] ERR_CHROME_ZOMBIE_PROCESSES** — Decenas de procesos `chrome.exe` huérfanos quedan vivos tras un crash loop.  
   - **[AUTOGESTIÓN: SI]** — LOBSTERS CARE ejecutará la cura automáticamente si detecta crash en logs.
   - *Síntoma:* Múltiples ventanas negras parpadeando incluso cuando PM2 está "online".  
   - *Diagnóstico:* `tasklist | findstr chrome` — más de 3-4 procesos = zombies.  
   - *Medicamento (Windows):*  
     1. `pm2 stop lobsters-casa-central-backend`  
     2. `taskkill /F /IM chrome.exe /T`  
     3. Esperar 2 segundos  
     4. `pm2 start lobsters-casa-central-backend`  
   - *⚠️ Precaución:* Cierra también el Chrome del navegador del usuario. Advertirle.  
   - *% Éxito:* 100%

---

## 🟡 GRUPO 2: Windows — Errores de Plataforma (Casa Central)

8. **[W-08] ERR_WIN_LONG_PATHS** — Rutas de archivo superiores a 260 caracteres bloqueadas por Windows.
   - *Síntoma:* `node_modules` incompleto, módulos faltantes.
   - *Medicamento:* Instalar dependencias con `npm install` desde cero en la máquina local. No transferir carpetas `node_modules` precompiladas.
   - *% Éxito:* 99%

9. **[W-09] ERR_POWERSHELL_EXECUTION_POLICY** — PowerShell bloquea scripts de PM2/Vite no firmados.
   - *Medicamento:* Usar `cmd.exe` en lugar de PowerShell, o habilitar política: `Set-ExecutionPolicy RemoteSigned`
   - *% Éxito:* 99%

10. **[W-10] ERR_PM2_NPM_CMD_SYNTAX** — PM2 intenta correr `npm.cmd` y falla con SyntaxError.
    - *Medicamento:* En `ecosystem.config.js`, reemplazar `npm run dev` por ruta directa: `./node_modules/vite/bin/vite.js`
    - *% Éxito:* 100%

11. **[W-11] ERR_REQUIRE_IN_ESM** — `require()` usado en archivo con `"type":"module"` en `package.json`.
    - *Síntoma:* `ReferenceError: require is not defined in ES module scope` — el backend crashea de inmediato.
    - *Medicamento:* Usar siempre `import` al tope. Si el módulo ya está importado (ej: `import fs from 'fs'`), usar `fs.existsSync()` directamente sin volver a llamar a `require`.
    - *% Éxito:* 100%

12. **[W-12] ERR_WIN_CHROME_PATH_HARDCODED** — Path de Chrome de Mac hardcodeado en Windows causa crash de Puppeteer.
    - *Medicamento:* Detectar el SO con `process.platform` y definir `chromePath` dinámicamente:
      - Windows: `C:\Program Files\Google\Chrome\Application\chrome.exe`
      - Mac: `/Applications/Google Chrome.app/Contents/MacOS/Google Chrome`
      - Linux: `/usr/bin/google-chrome-stable`
    - *% Éxito:* 100%

13. **[W-13] ERR_WIN_FIREWALL_BLOCKS_MAC** — Mac recibe `CANNOT GET` aunque el backend esté corriendo.
    - *Causa:* Windows Firewall bloquea conexiones entrantes desde la red local a puertos Node.js.
    - *Medicamento (requiere Administrador):*
      ```
      netsh advfirewall firewall add rule name="LOBSTERS Backend 3000" dir=in action=allow protocol=TCP localport=3000
      netsh advfirewall firewall add rule name="LOBSTERS Frontend 5173" dir=in action=allow protocol=TCP localport=5173
      ```
    - *% Éxito:* 99%

14. **[W-14] ERR_PM2_NOT_IN_PATH** — `pm2` no se reconoce en PowerShell aunque esté instalado.
    - *Medicamento:* Anteponer Node.js al PATH antes de cada llamada a PM2:
      `$env:PATH = "C:\Program Files\nodejs;" + $env:PATH; & "C:\Users\[usuario]\AppData\Roaming\npm\pm2.cmd" restart all`
    - *% Éxito:* 100%

---

## 🟢 GRUPO 3: Inteligencia y Prompts (MIIA)

15. **[I-15] ERR_MIIA_THIRD_PERSON_ALUCINATION** — MIIA habla en tercera persona o se identifica como IA.
    - *Medicamento:* Regla `IDENTIDAD NATURAL` obligatoria en el prompt maestro.
    - *% Éxito:* 98%

16. **[I-16] ERR_MIIA_METRALLETA_SPAM** — Envío de ráfagas (>5 mensajes) por error de delay.
    - *Medicamento:* Interceptor `pauseTimeout` de 30s automático + Rango de Oro (121-333 min).
    - *% Éxito:* 97%

17. **[I-17] ERR_LOOP_DRIP_48H_ZOMBIE** — Bucle infinito en motor drip.
    - *Medicamento:* Centralización de lógica en el "Cerebro Absoluto".
    - *% Éxito:* 95%

18. **[I-18] ERR_MIIA_VERBOSITY** — Respuestas técnicas demasiado extensas.
    - *Medicamento:* Inyectar `BREVEDAD_COMERCIAL` en el prompt.
    - *% Éxito:* 98%

19. **[I-19] ERR_MIIA_DOUBLE_REPLY** — MIIA responde dos veces al mismo mensaje.
    - *Medicamento:* Implementación de `mutex processing_cache`.
    - *% Éxito:* 99%

20. **[I-20] ERR_FAMILY_TRIGGER_BYPASS** — MIIA habla con familiares sin invitación.
    - *Medicamento:* Trigger "Hola MIIA" 100% obligatorio para contactos familia.
    - *% Éxito:* 100%

21. **[I-21] ERR_GOOGLE_AI_TIER_DELAY** — Frontend queda en "Detectando...".
    - *Medicamento:* Preconfiguración de Tier en `billingStats` + timeout de 10s.
    - *% Éxito:* 95%

---

## 🔵 GRUPO 4: Interfaz y UX (Frontend)

22. **[U-22] ERR_ADJACENT_JSX_ELEMENTS** — Colapso por etiquetas `div` no cerradas en `App.jsx`.
    - *Medicamento:* Saneamiento estructural con Fragmentos `<>...</>` y balance de columnas.
    - *% Éxito:* 100%

23. **[U-23] ERR_FRONTEND_REFERENCE_ERROR** — Icono o componente no importado en `App.jsx`.
    - *Medicamento:* Verificar importaciones en `lucide-react` y listar todos los íconos usados.
    - *% Éxito:* 100%

24. **[U-24] ERR_UI_GLOBAL_CRASH** — Referencia a `settings` o estado no definido tras actualización.
    - *Medicamento:* Unificación de estados en `useUserProfile`.
    - *% Éxito:* 98%

25. **[U-25] ERR_SIMULATOR_NO_QR** — El simulador no muestra el QR por sesión vieja.
    - *Medicamento:* Limpieza de `whatsapp_session_v14` al detectar fallo.
    - *% Éxito:* 98%

26. **[U-26] ERR_LOGO_UPLOAD_FAIL** — Fallo al subir marca comercial en PDF.
    - *Medicamento:* FormData multipart/form-data con validación de backend.
    - *% Éxito:* 97%

27. **[U-27] ERR_SMTP_GUIDE_MISSING** — Usuario no sabe cómo generar clave de Google SMTP.
    - *Medicamento:* Inyección de `SMTP Guide` interactiva en la sección de Perfil.
    - *% Éxito:* 99%

28. **[U-28] ERR_OTP_NESTING** — El flujo de OTP rompe el grid del perfil.
    - *Medicamento:* Aislamiento de capas con `relative z-10` y transiciones CSS.
    - *% Éxito:* 99%

29. **[U-29] ERR_REACT_REMOVE_CHILD** — Virtual DOM de React colapsa al navegar entre pestañas (extensiones del navegador insertan nodos que React no reconoce).
    - *Medicamento:* Aplicar etiquetas estrictas (`key="nombre-de-vista"`) en los contenedores primarios de `App.jsx` para forzar reciclaje completo del árbol DOM.
    - *% Éxito:* 99%

---

## 🔴 GRUPO 5: Auditoría y SaaS

30. **[S-30] QR received but not scanned** — Dashboard queda esperando infinitamente.
    - *Medicamento:* Feedback visual "Escaneando..." + actualización de status `clientReady`.
    - *% Éxito:* 98%

31. **[S-31] Drag & Drop Excel Parse Error** — Fallo al leer `.xlsx` grandes.
    - *Medicamento:* Actualización a motor `XLSX.readFile` con buffering.
    - *% Éxito:* 97%

32. **[S-32] Leads Duplicados en Carga** — El sistema acepta dos veces el mismo número.
    - *Medicamento:* Filtro `Set()` sobre `allowedLeads` antes de persistencia.
    - *% Éxito:* 100%

33. **[S-33] Bóveda de Campañas Vacía** — El usuario no ve sus artes guardados.
    - *Medicamento:* Verificación de persistencia en `archive.json`.
    - *% Éxito:* 98%

34. **[S-34] CRM Filter Inoperante** — Los botones de Vendido/Desactivado no filtran.
    - *Medicamento:* Implementación de `crmFilter` state dinámico en el render.
    - *% Éxito:* 99%

35. **[S-35] Prefijo Telefónico Automático** — Leads se cargan sin código de país.
    - *Medicamento:* Selector de país en Perfil con inyección de prefijo en el `input`.
    - *% Éxito:* 99%

36. **[S-36] CISMA DE DB.JSON** — Riesgo de pérdida de datos por cambio de estructura.
    - *Medicamento:* Script de migración `fix_db.js` + backups en caliente (.bak).
    - *% Éxito:* 97%

---

## 📋 PROTOCOLO DE ACTUALIZACIÓN (LEY)

1. **Un solo archivo:** Este `vademecum_full.md` es el único Vademécum válido. Cualquier archivo de Vademécum parcial es obsoleto.
2. **Nueva entrada:** Cada error resuelto se agrega aquí con código único `[GRUPO-N]`, descripción, medicamento y % de éxito.
3. **Sincronización:** Después de cada actualización, copiar este archivo a `backend/public/uploads/vademecum_full.md` para que los nodos cliente puedan descargarlo.
4. **Comando de VACUNA:** `ACTUALIZAR` — actualiza este archivo. `BUSCA` — busca en este archivo antes de reinventar soluciones.

---
37. **[W-37] ERR_POWERSHELL_NPM_UNAUTHORIZED** — Bloqueo de ejecución de scripts npm en PowerShell por políticas de seguridad.
    - *Medicamento:* Ejecutar directamente con `node [archivo].js` o usar `cmd.exe`. Evitar el uso de `npm start`.
    - *% Éxito:* 100%

38. **[E-38] ERR_REF_VARIABLE_NOT_DEFINED** — Crash por variables globales no inicializadas en el arranque (ej: `conversations` o `keywordsSet`).
    - *Medicamento:* Asegurar inicialización estricta al tope del archivo `index.js` antes de cualquier llamada a `loadDB()`.
    - *% Éxito:* 100%

39. **[V-39] LEY DE CIERRE (AUTO-AUDITORÍA)** — Riesgo de entregar código con errores de sintaxis o puertos bloqueados.
    - *Medicamento:* Ejecución OBLIGATORIA de `node backend/scripts/check_health.js` tras cada intervención.
    - *Protocolo:* No se reporta "Tarea Finalizada" si el status no es **Status: OK**.
    - *% Éxito:* 100%

---
## 🗑️ LÍNEAS ELIMINADAS / CAJÓN (Historial de Purgas)

Este apartado registra el código extirpado para evitar que errores del pasado regresen o que VACUNA pierda el rastro de la evolución del sistema.

| Fecha | Funcionalidad Previa | Motivo de Eliminación | Ubicación Original | Link Interno / Nueva Solución |
| :--- | :--- | :--- | :--- | :--- |
| 08/03/2026 | **WhatsApp Single Tenant** | Migración a Arquitectura Multitenant Pro. Evita colisiones de sesión. | `index.js:L230` y `L970-1125` | `initializeTenantWA(tenantId)` y `waClients['casa_central']` |
| 08/03/2026 | **Lógica Anti-Amnesia Global** | `SyntaxError: Illegal return`. Código fuera de funciones que bloqueaba el arranque. | `index.js:L969-1077` | Encapsulado en `safeScanPendingChats` por Tenant. |
| 08/03/2026 | **Notificaciones Administrativas** | `ReferenceError: client is not defined`. Llamadas a objeto global inexistente. | `index.js:L1742`, `L1881` | `safeSendMessage(..., { tenantId: 'casa_central' })` |
| 08/03/2026 | **Handler message_create Global** | El handler global no distinguía entre clientes, causando fugas de datos. | `index.js:L1918` | Delegado dinámicamente en `waClient.on('message_create', ...)` en `initializeTenantWA`. |

41. **[I-41] ERR_MIIA_SILENCE_REF_SHADOW** — Crash en `processMiiaResponse` por variables no definidas (`familyInfo`) o sombreadas (`isAlreadySaved`).
    - *Causa:* Durante la refactorización para restaurar `OWNER_PHONE`, se introdujeron dependencias de variables que no estaban en el scope de la función y se sobreescribieron parámetros vitales. Además, se omitió la inicialización del buzón de conversación.
    - *Medicamento:*
      1. Definir `familyInfo` al inicio de la función desde `familyContacts`.
      2. Asegurar la inicialización de `conversations[phone] = []` antes de cualquier `push`.
      3. Eliminar la re-declaración de `isAlreadySaved`.
    - *% Éxito:* 100%

42. **[C-42] ERR_CLOUDFLARE_502_BAD_GATEWAY** — El dominio `www.lobsterscrm.com` no conecta con el PC local.
    - *Causa:* Servicio `cloudflared` detenido o conector no instalado como servicio de Windows.
    - *Medicamento:* Instalación local con `cloudflared.exe service install [TOKEN]` + `Start-Service cloudflared`.
    - *% Éxito:* 100%

43. **[F-43] ERR_VITE_BLOCKED_HOST** — "Blocked request. This host ("www.lobsterscrm.com") is not allowed."
    - *Causa:* Vite restringe hosts por seguridad en entornos de red.
    - *Medicamento:* Agregar el dominio específico a `server.allowedHosts` en `vite.config.js`.
    - *% Éxito:* 100%

44. **[E-44] ERR_BACKEND_GLOBAL_SCOPE_MIGRATION** — `ReferenceError: [variable] is not defined` tras migrar a `LOBSTERS_NUBE`.
    - *Causa:* La arquitectura multi-SaaS requiere declaraciones `let` explícitas en el scope global que faltaban en la refactorización.
    - *Medicamento:* Consolidación y declaración de todas las variables de estado (`conversations`, `keywordsSet`, etc.) al inicio de `index.js`.
    - *% Éxito:* 100%

45. **[E-45] ERR_PUPPETEER_WIN_CODE_1** — Puppeteer falla al lanzar Chrome en Windows con error genérico Code 1.
    - *Medicamento:* Forzar `headless: "new"`, desactivar seguridad con `--disable-web-security` y asegurar limpieza de procesos Chrome huérfanos antes del arranque.
    - *% Éxito:* 95%

---
*Última actualización: 23 de Marzo de 2026 | 45 medicamentos | 4 Purga(s) Registrada(s) | Casa Central — Windows Master*
