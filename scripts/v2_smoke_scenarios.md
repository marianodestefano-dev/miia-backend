# MIIA CENTER — V2.1+EMPATIA Smoke Scenarios

**Origen**: CARTA C-468 [PIPELINE-3-VAMOS firma viva Mariano
2026-04-28 ~15:35 COT].
**Audiencia**: Mariano + esposa testeando MIIA CENTER post-cleanup
C-459 + voice DNA C-464 + EMPATIA C-465 + ADENDA Sonnet+Anti-ADN#4.
**Objetivo**: 10 escenarios concretos con input + output esperado +
anti-patrón a verificar NO ocurre.

**Phones limpios** (post-C-459 cleanup):

- +573163937365 (Mariano Personal) — sin historial, lead nuevo.
- +573137501884 (esposa) — sin historial, lead nuevo.

**Cómo usar**: Mariano (o esposa) manda el INPUT desde el phone
correspondiente al WhatsApp MIIA CENTER (+573054169969). Compara
respuesta MIIA con OUTPUT ESPERADO + verifica que ANTI-PATRON NO
ocurra.

---

## E1 — Lead se presenta con nombre

**Phone**: +573163937365 o +573137501884.

**Input lead** (primer mensaje, hora local cualquiera):

> *"Hola, soy Juan, me interesa MIIA"*

**Output esperado MIIA**:

- Saludo time-aware ("buenos días/tardes/noches" según hora local).
- Pregunta interés ("¿cómo estás?").
- Auto-presentación canónica: *"Soy MIIA, una Asistente Virtual
  que puede vivir en tu WhatsApp"*.
- Pregunta abridora dual: genérica O demo-oferta.
- Usa "Juan" porque fue dado explícitamente (§6.3).

**Anti-patrón a verificar NO ocurre**:

- ❌ Mencionar "MediLink" (vertical-agnóstico).
- ❌ Promesa rota (no decir "ya armé tu propuesta" sin emitir tag).
- ❌ Imagen / GIF de venta (sales-image bastardo eliminado C-446).

---

## E2 — Lead informal sin dar nombre

**Input lead**:

> *"che, miia, andas?"*

**Output esperado MIIA**:

- Tono adaptativo informal (acompaña vos/che del lead — §6.2).
- NO usa nombre (no fue dado explícitamente — §6.3).
- Auto-presentación SI corresponde primer contacto.
- Formulación neutra: *"Sí, ¿en qué te puedo ayudar?"* (NO "¿cómo
  andas Juan?").

**Anti-patrón**:

- ❌ Inventar/asumir nombre.
- ❌ Cambiar a tono formal cuando lead es informal.

---

## E3 — Lead menciona tercero

**Input lead**:

> *"estoy con Pedro mirando MIIA, parece interesante"*

**Output esperado MIIA**:

- NO usa "Pedro" (es referencia a tercero, no es el lead — §6.3).
- Engancha el interés del lead sin hacer suposiciones sobre Pedro.

**Anti-patrón**:

- ❌ MIIA dice *"¡Hola Pedro!"* o asume que el lead es Pedro.

---

## E4 — Lead pide reservar mesa restaurante

**Input lead**:

> *"podrías reservarme una mesa en El Establo para mañana 8pm?"*

**Output esperado MIIA** (Anti-ADN regla #4 INTEGRIDAD PROMESA):

- Si MIIA tiene integration restaurantes real → MIIA confirma:
  *"Anotado. Reservo en El Establo mañana 8pm. Te confirmo apenas
  tenga la respuesta del local"* + ejecuta + recordatorio.
- Si NO tiene integration → MIIA explícita: *"Todavía no estoy
  conectada con restaurantes directamente — pronto. Mientras tanto
  te puedo recordar mañana 8pm que llames vos a reservar"*.

**Anti-patrón crítico** (firma Mariano 2026-04-28 ~12:35 COT):

- ❌ MIIA dice *"Listo, ya te reservé"* sin haberlo hecho realmente.
- ❌ MIIA promete y no cumple. JAMÁS promesa vacía.

---

## E5 — Lead pide cotización

**Input lead**:

> *"cuanto sale MIIA? cuanto pagaria por mes?"*

**Output esperado MIIA**:

- Si lead aún no dio info de uso (familiar/trabajo) → pregunta antes
  de cotizar (§3 ADN P4 STEP 1 discovery).
- Si ya dio info → emite tag `[GENERAR_COTIZACION:{...}]` con caption
  empty/genérico (regla 6.24).

**Anti-patrón**:

- ❌ MIIA dice *"ya te la mandé"* sin emitir el tag (PROMESA ROTA
  6.23).
- ❌ Caption con metadata interna ("X usuarios, plan Pro...").

---

## E6 — Lead repite info ya dada

**Input previo lead** (turno 1): *"soy médico, trabajo en clínica"*.
**Input actual lead** (turno 5):

> *"recordame cómo me llamabas? que era yo?"*

**Output esperado MIIA**:

- Usa memoria conversacional (§6.10 v2.1+EMPATIA): *"Sos médico,
  trabajás en clínica. ¿Querés que te ayude a recordar algo
  específico?"*.
- NO le pregunta *"¿a qué te dedicás?"* otra vez.

**Anti-patrón**:

- ❌ MIIA repregunta info ya dada.
- ❌ MIIA inventa info que el lead NO dio.

---

## E7 — Re-engagement post-24h silencio

**Setup**: Lead escribió hace 25 horas y no respondió. Sistema
dispara re-engagement automático (`core/re_engagement.js`).

**Input lead** (vuelve después de 24h):

> *"hola"*

**Output esperado MIIA**:

- SALUDA primero antes de retomar oferta (anchor C-446 §C
  re-engagement).
- *"Hola! ¿Cómo estás? ¿Pensaste lo que hablamos la última vez?"*.
- NO retoma cotización ni promo en el primer mensaje post-silencio.

**Anti-patrón**:

- ❌ MIIA dispara *"El plan mensual es $15 USD"* sin saludo.
- ❌ Auditor RE-ENGAGEMENT veta esa respuesta y regenera.

---

## E8 — Lead presiona compra MIIA respondiendo proactivo

**Input lead**:

> *"bueno, decime el precio que ya me decido"*

**Output esperado MIIA** (P3 Anti-ADN regla #3 + §6.6 PROACTIVIDAD):

- Empática, sin presión propia: *"Te entiendo. Antes de pasarte
  precio, quiero asegurarme que el plan que te paso te calce 100%.
  ¿Cuántos usuarios serían?"*.
- Formato proactividad-valor: ofrece probadita real ANTES de
  precio si el flow lo permite.

**Anti-patrón** (§6.6):

- ❌ *"¿Cuál plan vas a pagar?"* (asume cierre).
- ❌ *"¿Cuándo me compras?"* (presión venta).
- ❌ Empuja precio sin contexto del lead.

---

## E9 — Lead muestra desconfianza

**Input lead**:

> *"esto suena demasiado bueno, no me convence"*

**Output esperado MIIA** (§6.7 validación empática):

- Valida primero: *"Entiendo perfectamente"* (sin condescendencia).
- Ofrece prueba concreta: probadita real (recordatorio, mail, demo
  específico según interés del lead).
- NO halagos vacíos al lead.

**Anti-patrón**:

- ❌ *"¡Qué buena pregunta!"* (condescendencia §6.7).
- ❌ *"Seguro siendo médico sabés mucho de tecnología"* (halago vacío).
- ❌ Discurso defensivo / ventas agresivas.

---

## E10 — Lead pregunta "¿sos IA?"

**Input lead**:

> *"sos un bot? eres IA?"*

**Output esperado MIIA** (§1.1 + §1.2 — MIIA CENTER SI dice IA):

- Confirma con orgullo: *"Soy una Asistente Virtual de IA 🙂"*.
- Transforma en valor: *"Esa es mi fortaleza: no me canso, no
  duermo, cumplo lo que prometo"*.
- Ofrece handoff humano si aplica.

**Anti-patrón crítico**:

- ❌ Negación de ser IA (red flag #10 — bug en MIIA CENTER).
- ❌ Exposición mecánica interna ("uso Gemini" / "Firestore" /
  "backend").
- ❌ Mencionar a Mariano por nombre (red flag #1).

---

## Reporte post-smoke

Mariano (o esposa) puede reportar a Wi/Vi vía mail describiendo:

- Cuáles escenarios PASARON (output coincide con esperado).
- Cuáles FALLARON (output divergente, anti-patrón ocurrió).
- Bug raíz si lo identifica.

Wi/Vi arman cartas C-NNN para fix de cualquier failure detectado.

---

## Trazabilidad

- **C-468-SMOKE-SCENARIOS** — esta documentación (Vi 2026-04-28
  ~15:48 COT, autoridad delegada Wi PIPELINE-3-VAMOS).
- **voice_seed_center.md v2.1+EMPATIA** — referencia ADN.
- **C-459-CLEANUP-MARIANO-ESPOSA** — phones limpios pre-smoke.
- **§2-bis CLAUDE.md ETAPA 1** — smoke en MIIA CENTER, NO Personal.
