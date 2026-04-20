# Countries — Estructura de datos por país

## Propósito
Cada archivo `{CODE}.json` contiene TODA la información específica de un país para MIIA:
- Precios y moneda
- Módulos disponibles
- Reglas fiscales (IVA)
- Normativa de salud
- Dialecto y tono de comunicación
- ADN de ventas (cómo cerrar leads de ese país)

## Filosofía
**Un país = un archivo. Un archivo = toda la verdad de ese país.**

Cuando MIIA habla con un lead de México, solo necesita leer `MX.json`. No necesita filtrar mentalmente reglas de Colombia o Argentina. Esto elimina la contaminación cruzada entre países.

## Campos del JSON

### Identificación
| Campo | Tipo | Descripción |
|-------|------|-------------|
| `code` | string | Código ISO 2 letras (CO, CL, MX, ES, AR, DO, PE, EC, VE, UY, BO, PY, GT, CR, PA, US, INTL) |
| `name` | string | Nombre del país en español |
| `flag` | string | Emoji de bandera |
| `phonePrefix` | string[] | Prefijos telefónicos (ej: ["57"] para Colombia, ["1809","1829","1849"] para Rep. Dominicana) |
| `pais_tag` | string | Valor que la IA debe poner en el tag GENERAR_COTIZACION (ej: "COLOMBIA", "CHILE") |
| `timezone` | string | Timezone IANA (ej: "America/Bogota") |
| `normalizedPricing` | string? | Si presente, indica que este país usa la tabla de precios de otro (ej: "OP" = usa precios USD genéricos) |

### Moneda
| Campo | Tipo | Descripción |
|-------|------|-------------|
| `currency.code` | string | Código ISO moneda (COP, CLP, MXN, EUR, USD) |
| `currency.symbol` | string | Símbolo ($ o €) |
| `currency.display` | string | Prefijo para mostrar precios (ej: "COP $", "EUR €") |
| `currency.thousandSep` | string | Separador de miles ("." para COP/CLP, "," para USD/MXN/EUR) |
| `currency.decimals` | number | 0 para COP/CLP, 2 para USD/MXN/EUR |

### Precios
| Campo | Tipo | Descripción |
|-------|------|-------------|
| `pricing.plans.{plan}.base` | number | Precio base mensual (1 usuario) — excepto ES que es anual |
| `pricing.plans.{plan}.adic` | number | Precio por usuario adicional |
| `pricing.adicEscalonado` | boolean | true si los adicionales tienen tiers (solo Chile) |
| `pricing.adicTiers` | object? | Solo Chile: precios por rango de usuarios (tier1: 2-5, tier2: 6-10, tier3: 11+) |

### Bolsas de módulos
| Campo | Tipo | Descripción |
|-------|------|-------------|
| `bolsas.{modulo}.ranges` | number[] | Límites de envíos [S, M, L, XL] |
| `bolsas.{modulo}.prices` | number[] | Precios mensuales [S, M, L, XL] |

### Módulos disponibles
| Campo | Tipo | Descripción |
|-------|------|-------------|
| `modules.{modulo}.available` | boolean | Si el módulo está disponible en este país |
| `modules.{modulo}.name` | string | Nombre para mostrar |
| `modules.{modulo}.desc` | string | Descripción (puede variar por país, ej: CO incluye "FEV-RIPS" en factura) |
| `modules.receta.pricePerUser` | number? | Solo AR: $3 USD por usuario |
| `modules.receta.unlimited` | boolean? | Solo AR: true (sin bolsa de consumo) |

### Reglas
| Campo | Tipo | Descripción |
|-------|------|-------------|
| `rules.iva.rate` | number | Tasa de IVA (0 = sin IVA, 0.16 = 16% México) |
| `rules.iva.appliesTo` | string? | A qué se aplica ("plan_base" = solo plan+adic, null = no aplica) |
| `rules.anualOnly` | boolean | true = solo permite modalidad anual (España) |
| `rules.modalidades` | string[] | Modalidades permitidas |
| `rules.descuentos` | object | Descuentos por modalidad (ver formato abajo) |
| `rules.descuentos.{modalidad}.rate` | number | Tasa decimal (0.30 = 30%) |
| `rules.descuentos.{modalidad}.months` | number \| null | Meses que dura el descuento. `null` = permanente. `3` = solo primeros 3 meses (mensual) |
| `rules.siigo` | string? | Regla SIIGO (solo Colombia) |

**Formato `rules.descuentos` (v2.0 — desde C-298):**
```jsonc
{
  "mensual":   { "rate": 0.30, "months": 3 },     // mes 1-3 con 30% off, mes 4+ precio regular
  "semestral": { "rate": 0.15, "months": null },  // permanente
  "anual":     { "rate": 0.20, "months": null }   // permanente
}
```
España solo tiene `anual`. Todos los demás países tienen las 3 modalidades.
Backend calcula ambos valores (mes 1-3 con descuento / mes 4+ regular) cuando `modalidad=mensual`.

### Normativa
Array de objetos `{ title, countryOnly }`. Si `countryOnly=true`, solo se muestra en ese país.

### Dialecto
| Campo | Tipo | Descripción |
|-------|------|-------------|
| `dialect.style` | string | Estilo lingüístico (voseo, tuteo_formal, tuteo_mexicano, etc.) |
| `dialect.pronouns` | string | Pronombres a usar (vos, tú, usted) |
| `dialect.expressions` | string[] | Expresiones naturales para ese país |
| `dialect.avoid` | string[] | Expresiones que NO usar (de otros países) |
| `dialect.toneNote` | string | Guía de tono general |

### ADN de ventas
| Campo | Tipo | Descripción |
|-------|------|-------------|
| `salesDna.approach` | string | Cómo abordar al lead |
| `salesDna.objections` | object | Respuestas a objeciones comunes (caro, ya_tengo_sistema, lo_pienso) |
| `salesDna.closingTips` | string | Tips de cierre |
| `salesDna.culturalNotes` | string | Notas culturales del mercado |

## Países y sus particularidades

| País | Moneda | Factura | Receta | IVA | Solo Anual | Regla Especial |
|------|--------|---------|--------|-----|------------|----------------|
| CO | COP | ✅ | ❌ | 0% | ❌ | FEV-RIPS, SIIGO |
| CL | CLP | ✅ | ❌ | 0% | ❌ | Adic escalonados |
| MX | MXN | ✅ | ❌ | **16%** plan base | ❌ | CFDI |
| ES | EUR | ❌ | ❌ | 0% | **✅** | Precios anuales |
| AR | USD | ❌ | **✅ $3/usr** | 0% | ❌ | Recetas ilimitadas |
| DO | USD | ✅ | ❌ | 0% | ❌ | NCF/DGII |
| PE-INTL | USD | ❌ | ❌ | 0% | ❌ | — |

## Cómo usar

```javascript
const { getCountryConfig } = require('./countries');

// Por código de país
const config = getCountryConfig('MX');
// config.rules.iva.rate → 0.16
// config.modules.factura.available → true
// config.dialect.expressions → ["órale", "platícame", ...]

// Fallback automático
const unknown = getCountryConfig('XX');
// → retorna INTL.json
```

## Reglas de mantenimiento

1. **Si se cambia un precio en el código, DEBE cambiarse en el JSON del país**
2. **Si se agrega un país nuevo, crear su JSON y agregarlo al loader**
3. **NUNCA hardcodear reglas de país en el código** — leerlas del JSON
4. **Los JSONs son la FUENTE DE VERDAD** — el código los consume, no al revés
