# TAREA PENDIENTE: Voz de MIIA

**Fecha**: 2026-04-03
**Prioridad**: Fase futura
**Status**: Diseño conceptual

---

## Concepto

MIIA puede enviar mensajes de audio por WhatsApp usando Text-to-Speech con voz personalizada.

## Opciones técnicas

| Opción | Cómo funciona | Costo aprox |
|--------|--------------|-------------|
| **ElevenLabs Voice Clone** | Owner graba 30 segundos → se clona su voz | ~$5-22/mes |
| **OpenAI TTS** | Voces predefinidas (no clona), buena calidad | ~$15/1M caracteres |
| **Google Cloud TTS** | Voces predefinidas, más barato | ~$4/1M caracteres |

## Voces por tipo de contacto

| Contacto | Voz que usa MIIA |
|----------|-----------------|
| **Leads** | Voz clonada del owner → el lead cree que es el owner hablando |
| **Contacto Grupo** | Voz propia de MIIA (sintética elegida por el owner) |

## Funcionalidad

1. Owner graba su voz desde el dashboard (30 seg mínimo)
2. Se sube a ElevenLabs/OpenAI para clonación
3. MIIA genera audio con TTS cuando detecta que es mejor enviar audio que texto
4. Baileys soporta envío de audios nativamente

## Consideraciones legales

- El owner consiente clonar SU propia voz → OK
- El lead no sabe que es IA → mismo criterio que texto (ya lo hacemos)
- Revisar legislación por país cuando se implemente

## Pregunta abierta de Mariano

> "Y QUE VOZ USA? PUEDE EL USUARIO GRABAR SU VOZ Y QUE MIIA LA USE?"

Respuesta: Sí, técnicamente posible con ElevenLabs Voice Clone.

---

*Tarea registrada — Sesión 9, 2026-04-03*
