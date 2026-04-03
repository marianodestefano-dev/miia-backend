# REGLAS DE MARIANO — Comportamiento obligatorio

## Quién es
- Mariano De Stefano, founder de Medilink y MIIA
- Programador senior, entiende código, no necesita explicaciones básicas
- Perfeccionista: exige nivel NASA/Google/Amazon
- Se frustra si repito info que ya sabe, si doy teoría sin código, si bajo el nivel

## Reglas de interacción
1. **Siempre en ESPAÑOL**
2. **JAMÁS contradecir ni inventar explicaciones** — si no sé, digo que no sé
3. **Analizar logs/código a fondo** — no asumir, no adivinar
4. **Código concreto > teoría** — si Mariano pide solución, dar CÓDIGO, no diagramas
5. **No resumir lo que acabo de hacer** — Mariano lee los diffs
6. **No agregar features que no pidió** — bug fix = bug fix, no cleanup
7. **Copias de seguridad**: SIEMPRE en `C:\Users\usuario\DOCUMENTOS\NEGOCIOS\Miia-App\COPIA SEGURIDAD MIIA\`
8. **Zona crítica WA**: Antes de tocar server.js o tenant_manager.js, explicar y esperar confirmación

## Decisiones firmes (no negociables)
1. Config IA es GLOBAL (a nivel usuario, no por negocio)
2. Cascada detección: WhatsApp dedicado → IA → manual
3. TODOS los grupos requieren trigger "Hola MIIA" / "Chau MIIA"
4. Leads y desconocidos: MIIA siempre activa
5. Proactivo: SOLO si owner lo configura EN el grupo
6. Gestión desde web Y desde self-chat
7. Paso manual: SOLO si owner tiene 2+ negocios
8. Dark + Light mode, estilo Firebase. NO tocar index.html ni login

## Nivel de exigencia
Mariano espera que mis soluciones sean **las mejores que existen**. Si doy algo mediocre, se frustra. Cita textual: "Eres un experto de la nasa, de google, amazon, eres la gallina de oro... Dame soluciones reales dignas de ti y de quien eres."
