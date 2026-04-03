# SISTEMA DE COTIZACIONES — Referencia rápida

## Flujo completo
1. Lead menciona usuarios → MIIA emite `[GENERAR_COTIZACION_PDF:{JSON}]`
2. server.js intercepta tag → llama `cotizacion_generator.js`
3. Generator calcula precios desde matrices `PRECIOS`
4. Genera HTML → Puppeteer → PDF
5. Envía PDF por WhatsApp via `safeSendMessage`

## Archivos
- `cotizacion_generator.js` — Matrices PRECIOS, cálculo, HTML, PDF
- `prompt_builder.js` — COTIZACION_PROTOCOL (reglas para MIIA)
- `server.js:1957-2020` — Intercepción del tag y envío

## Reglas por país
| País | Moneda | Factura | Receta AR | Modalidad | IVA |
|------|--------|---------|-----------|-----------|-----|
| Chile | CLP | Sí | No | Mensual/Semestral/Anual | 0% |
| Colombia | COP | Sí | No | Mensual/Semestral/Anual | 0% |
| México | MXN | Sí | No | Mensual/Semestral/Anual | **16%** |
| Rep. Dominicana | USD | **Sí** | No | Mensual/Semestral/Anual | 0% |
| Argentina | USD | **No** | **Sí ($3/usuario/mes)** | Mensual/Semestral/Anual | 0% |
| España | EUR | No | No | **Solo Anual** | 0% |
| Internacional | USD | No | No | Mensual/Semestral/Anual | 0% |

## Descuentos
- Mensual: 30% sobre subtotal básico (plan + adicionales)
- Semestral: 15%
- Anual: 20%
- Módulos (WA, Firma, Factura): a precio lista, SIN descuento

## Auto-cálculo de bolsas
- WA: `usuarios × 1.33 × citasMes` → selecciona tier S/M/L/XL
- Firma: `usuarios × 1` → tier
- Factura: `usuarios × 1` → tier
- **IMPORTANTE**: Los rangos de bolsas varían entre CLP y el resto

## Bugs corregidos (sesión 10)
- Receta AR: era $3 fijo, ahora $3 × usuarios × multiplicador
- PDF HTML: mostraba $3 hardcoded, ahora usa `recetaAR` calculado

## Bugs pendientes
- España: generator no fuerza `modalidad='anual'` server-side
- Prompt: no explica lógica de auto-cálculo de bolsas → MIIA puede decir precio incorrecto
- Prompt: tokens IA por plan (80/250/400) y ficha estética no mencionados
