# Uber / Rappi / PedidosYa — Knowledge Base (Deep Links)

## Tipo de integración
- **NO son APIs**: Son deep links que abren la app del usuario
- **Auth**: NINGUNA
- **Riesgo**: Bajo (solo abrir apps, no ejecutar acciones)

## Deep Links

### Uber
```
uber://?action=setPickup&pickup=my_location
uber://?action=setPickup&pickup=my_location&dropoff[latitude]=X&dropoff[longitude]=Y
```
- Web fallback: `https://m.uber.com/ul/?action=setPickup&pickup=my_location`
- Si la app no está instalada, abre la web

### Rappi
```
rappi://home
rappi://store/{storeId}
```
- Web fallback: `https://www.rappi.com.co/` (varía por país)
- No tiene deep links tan avanzados como Uber

### PedidosYa
```
pedidosya://home
```
- Web fallback: `https://www.pedidosya.com.co/`

## Errores comunes

### 1. Deep link no funciona en WhatsApp
- WhatsApp puede bloquear custom schemes (`uber://`)
- **Fix**: Usar URL https (`https://m.uber.com/ul/...`) que WhatsApp SÍ abre

### 2. App no instalada
- Si el usuario no tiene Uber/Rappi → el deep link no hace nada
- **Fix**: Usar web fallback siempre

### 3. País incorrecto
- Rappi Colombia ≠ Rappi México ≠ Rappi Argentina
- **Fix**: Detectar país del owner y usar dominio correcto
  - CO: rappi.com.co
  - MX: rappi.com.mx
  - AR: rappi.com.ar

## Privacidad
- Deep links NO envían datos a Uber/Rappi
- Solo abren la app en el dispositivo del usuario
- BAJO riesgo de privacidad
