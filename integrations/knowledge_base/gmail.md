# Gmail — Knowledge Base

## API
- **Servicio**: Gmail API v1
- **Base URL**: `https://gmail.googleapis.com/gmail/v1/users/me`
- **Auth**: OAuth 2.0 (mismos tokens que Calendar, scope adicional `gmail.readonly`)
- **Docs**: https://developers.google.com/gmail/api/reference/rest
- **Módulo MIIA**: `integrations/adapters/gmail_integration.js`

## REGLA DE ORO
Operar por `messageId` (string único de Gmail). NUNCA buscar emails por subject text para operaciones de modificación.

## IDs que se guardan en Firestore

| Campo | Qué es | Dónde |
|---|---|---|
| `gmailMessageId` | ID del mensaje en Gmail | Referencia interna si se necesita |
| `accessToken/refreshToken` | OAuth tokens | `users/{uid}/miia_interests/gmail` |

## Errores comunes

### 1. Token expirado
- **Síntoma**: 401 Unauthorized
- **Causa**: Access token dura 1 hora
- **Fix**: Refresh automático con `refreshToken`. Si falla → pedir reconexión.

### 2. Scope insuficiente
- **Síntoma**: 403 Forbidden al leer mensajes
- **Causa**: El usuario solo autorizó `calendar` pero no `gmail.readonly`
- **Fix**: Pedir scope adicional. NO se pueden leer emails sin `gmail.readonly`.

### 3. Contenido sensible en logs
- **Riesgo**: Loguear subject/body/from expone privacidad
- **Regla**: Loguear solo messageId y metadata, NUNCA contenido del email

### 4. Resultados vacíos con query compleja
- **Causa**: Gmail query syntax es específica (no es Google Search)
- **Queries válidas**: `is:unread`, `from:email@...`, `newer_than:1d`, `subject:"texto"`
- **NO funciona**: lenguaje natural, wildcards complejos

## Rate Limits
- **Queries/día**: 1,000,000,000 (prácticamente ilimitado)
- **Queries/segundo/usuario**: 250
- **En práctica**: MIIA hace ~10-20 queries/día

## Operaciones MIIA usa

| Operación | Endpoint | Riesgo |
|---|---|---|
| Listar mensajes | `GET /messages?q=...` | Bajo — solo lectura |
| Leer metadata | `GET /messages/{id}?format=metadata` | Bajo — solo headers |
| Leer completo | `GET /messages/{id}?format=full` | Medio — contiene body |

## Privacidad
- MIIA solo lee metadata (Subject, From, Date) por defecto
- NO lee body completo salvo que el owner lo pida explícitamente
- NUNCA reenviar contenido de emails a terceros
- NUNCA loguear contenido de emails en producción
