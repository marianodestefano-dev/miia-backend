'use strict';

/**
 * PRICE TRACKER v1.0 — Seguimiento de precios + contacto proactivo a tiendas
 *
 * Funcionalidades:
 * 1. Owner dice "MIIA, seguí este producto: [URL]" → scrape precio/stock
 * 2. Polling configurable: diario normal, cada 4h en semanas Cyber
 * 3. Baja de precio → notifica al owner en self-chat
 * 4. Stock bajo → notifica al owner
 * 5. Contacto proactivo: busca WhatsApp/email de la tienda → envía consulta
 * 6. Detecta respuesta de la tienda → informa al owner
 *
 * Firestore: users/{uid}/price_tracks/{trackId}
 *   { url, productName, baselinePrice, currentPrice, currency, stock,
 *     storeWhatsApp, storeEmail, lastCheck, priceHistory[], status, createdAt }
 */

const admin = require('firebase-admin');

// Dependencias inyectadas al init
let _generateAIContent = null;
let _safeSendMessage = null;
let _ownerPhone = null;
let _ownerUid = null;
let _getOwnerSock = null;

// Tracking de contactos de tiendas (para detectar respuestas)
const storeContacts = new Map(); // { phone: { trackId, productName, ownerUid } }

/**
 * Inicializar el price tracker
 */
function initPriceTracker(deps) {
  _generateAIContent = deps.generateAIContent;
  _safeSendMessage = deps.safeSendMessage;
  _ownerPhone = deps.ownerPhone;
  _ownerUid = deps.ownerUid;
  _getOwnerSock = deps.getOwnerSock;
  console.log('[PRICE-TRACKER] ✅ Inicializado');
}

/**
 * Agregar un producto para seguimiento
 * @param {string} url - URL del producto
 * @param {string} ownerUid - UID del owner
 * @param {Object} opts - { cyberMode: false, contactStore: true }
 * @returns {Promise<{success, trackId, productName, price, error?}>}
 */
async function trackProduct(url, ownerUid, opts = {}) {
  if (!_generateAIContent) return { success: false, error: 'Price tracker no inicializado' };

  console.log(`[PRICE-TRACKER] 🔍 Analizando producto: ${url}`);

  try {
    // Paso 1: Scrape con Gemini google_search
    const scrapePrompt = `Analiza esta URL de producto y extrae la siguiente información en formato JSON exacto:
{
  "productName": "nombre del producto",
  "price": 59990,
  "currency": "COP",
  "stock": "disponible" | "pocas unidades" | "agotado" | "desconocido",
  "stockCount": null,
  "storeWhatsApp": "número de WhatsApp de contacto de la tienda si está visible" | null,
  "storeEmail": "email de contacto de la tienda si está visible" | null,
  "storeName": "nombre de la tienda"
}

URL: ${url}

IMPORTANTE:
- El precio debe ser numérico SIN símbolos (ej: 59990, no "$59.990")
- La moneda en código ISO (COP, USD, MXN, CLP, EUR, ARS)
- Si no encontrás el WhatsApp o email, poné null
- Si ves stock limitado (ej: "últimas 3 unidades") ponelo en stockCount`;

    const scrapeResult = await _generateAIContent(scrapePrompt, { enableSearch: true });
    if (!scrapeResult) return { success: false, error: 'No se pudo analizar el producto' };

    // Parsear respuesta JSON
    let productData;
    try {
      const jsonMatch = scrapeResult.match(/\{[\s\S]*\}/);
      productData = JSON.parse(jsonMatch[0]);
    } catch (parseErr) {
      console.error(`[PRICE-TRACKER] ❌ Error parseando respuesta:`, parseErr.message);
      return { success: false, error: 'No se pudo extraer información del producto' };
    }

    // Paso 2: Guardar en Firestore
    const trackRef = admin.firestore()
      .collection('users').doc(ownerUid)
      .collection('price_tracks');

    const trackDoc = await trackRef.add({
      url,
      productName: productData.productName || 'Producto sin nombre',
      baselinePrice: productData.price || 0,
      currentPrice: productData.price || 0,
      currency: productData.currency || 'USD',
      stock: productData.stock || 'desconocido',
      stockCount: productData.stockCount || null,
      storeWhatsApp: productData.storeWhatsApp || null,
      storeEmail: productData.storeEmail || null,
      storeName: productData.storeName || null,
      priceHistory: [{
        price: productData.price || 0,
        stock: productData.stock,
        checkedAt: new Date().toISOString()
      }],
      status: 'active',
      cyberMode: opts.cyberMode || false,
      contactStore: opts.contactStore !== false,
      lastCheck: new Date().toISOString(),
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    });

    console.log(`[PRICE-TRACKER] ✅ Producto registrado: "${productData.productName}" @ ${productData.price} ${productData.currency} (ID: ${trackDoc.id})`);

    // Paso 3: Contactar tienda si tiene WhatsApp/email
    if (opts.contactStore !== false) {
      if (productData.storeWhatsApp) {
        await contactStoreWhatsApp(trackDoc.id, productData, ownerUid);
      }
      if (productData.storeEmail) {
        await contactStoreEmail(trackDoc.id, productData, ownerUid);
      }
    }

    return {
      success: true,
      trackId: trackDoc.id,
      productName: productData.productName,
      price: productData.price,
      currency: productData.currency,
      stock: productData.stock,
      storeWhatsApp: productData.storeWhatsApp,
      storeEmail: productData.storeEmail
    };
  } catch (e) {
    console.error(`[PRICE-TRACKER] ❌ Error en trackProduct:`, e.message);
    return { success: false, error: e.message };
  }
}

/**
 * Contactar tienda por WhatsApp
 */
async function contactStoreWhatsApp(trackId, productData, ownerUid) {
  if (!_safeSendMessage || !productData.storeWhatsApp) return;

  const storePhone = productData.storeWhatsApp.replace(/[^0-9]/g, '');
  const storeJid = `${storePhone}@s.whatsapp.net`;

  const msg = `¡Hola! 👋 Me interesa este producto: *${productData.productName}*. ¿Tienen disponibilidad y cuál es el precio actual? Gracias!`;

  try {
    await _safeSendMessage(storeJid, msg);
    // Registrar este número como contacto de tienda (para detectar respuesta)
    storeContacts.set(storeJid, { trackId, productName: productData.productName, ownerUid });
    console.log(`[PRICE-TRACKER] 📱 WhatsApp enviado a tienda ${productData.storeName || storePhone}: "${msg.substring(0, 50)}..."`);
  } catch (e) {
    console.error(`[PRICE-TRACKER] ❌ Error contactando tienda por WhatsApp:`, e.message);
  }
}

/**
 * Contactar tienda por email
 */
async function contactStoreEmail(trackId, productData, ownerUid) {
  try {
    const mailService = require('./mail_service');
    if (!mailService.isConfigured()) return;

    const subject = `Consulta sobre ${productData.productName}`;
    const body = `Hola!\n\nMe interesa el producto: ${productData.productName}\nURL: ${productData.url || ''}\n\n¿Podrían confirmarme disponibilidad y precio actual?\n\nGracias!`;

    const result = await mailService.sendGenericEmail(
      productData.storeEmail,
      subject,
      body,
      { fromName: 'Consulta de producto' }
    );

    if (result.success) {
      console.log(`[PRICE-TRACKER] 📧 Email enviado a tienda ${productData.storeEmail}`);
    }
  } catch (e) {
    console.error(`[PRICE-TRACKER] ❌ Error contactando tienda por email:`, e.message);
  }
}

/**
 * Verificar si un mensaje entrante es respuesta de una tienda trackeada
 * @param {string} fromPhone - JID del remitente
 * @param {string} body - Contenido del mensaje
 * @returns {Object|null} - { trackId, productName } si es de una tienda, null si no
 */
function identifyStoreReply(fromPhone, body) {
  if (!fromPhone || !body) return null;
  const storeInfo = storeContacts.get(fromPhone);
  if (!storeInfo) return null;
  return storeInfo;
}

/**
 * Procesar respuesta de una tienda — notificar al owner
 */
async function processStoreReply(fromPhone, body, storeInfo) {
  if (!_safeSendMessage || !_getOwnerSock) return;

  console.log(`[PRICE-TRACKER] 🛒 Respuesta de tienda detectada! Producto: "${storeInfo.productName}"`);

  // Notificar al owner
  const ownerJid = _getOwnerSock()?.user?.id;
  if (ownerJid) {
    const ownerSelf = ownerJid.includes(':') ? ownerJid.split(':')[0] + '@s.whatsapp.net' : ownerJid;
    await _safeSendMessage(ownerSelf,
      `🛒 *¡Respondieron por tu producto!*\n📦 *${storeInfo.productName}*\n💬 "${body.substring(0, 200)}"\n\nRevisá el chat para más detalles 👆`,
      { isSelfChat: true }
    );
  }

  // Actualizar Firestore
  try {
    const trackRef = admin.firestore()
      .collection('users').doc(storeInfo.ownerUid)
      .collection('price_tracks').doc(storeInfo.trackId);
    await trackRef.update({
      storeReplied: true,
      storeReplyAt: new Date().toISOString(),
      storeReplyPreview: body.substring(0, 300)
    });
  } catch (e) {
    console.error(`[PRICE-TRACKER] ❌ Error actualizando track con respuesta:`, e.message);
  }
}

/**
 * Polling de precios — ejecutar periódicamente
 * @param {string} ownerUid
 */
async function checkPrices(ownerUid) {
  if (!_generateAIContent) return;

  try {
    const tracksSnap = await admin.firestore()
      .collection('users').doc(ownerUid)
      .collection('price_tracks')
      .where('status', '==', 'active')
      .limit(20)
      .get();

    if (tracksSnap.empty) return;

    let checked = 0;
    let alerts = 0;

    for (const doc of tracksSnap.docs) {
      const track = doc.data();

      // Respetar intervalo: diario normal, 4h en cyberMode
      const intervalMs = track.cyberMode ? 4 * 3600000 : 24 * 3600000;
      const lastCheck = track.lastCheck ? new Date(track.lastCheck).getTime() : 0;
      if (Date.now() - lastCheck < intervalMs) continue;

      // Scrape precio actual
      const checkPrompt = `Busca el precio actual de este producto: "${track.productName}"
URL: ${track.url}
Responde SOLO en formato JSON: {"price": 59990, "stock": "disponible", "stockCount": null}
Si no encontrás info, responde: {"price": null, "stock": "desconocido"}`;

      try {
        const result = await _generateAIContent(checkPrompt, { enableSearch: true });
        if (!result) continue;

        const jsonMatch = result.match(/\{[\s\S]*?\}/);
        if (!jsonMatch) continue;
        const data = JSON.parse(jsonMatch[0]);
        if (!data.price) continue;

        const oldPrice = track.currentPrice;
        const newPrice = data.price;
        const priceDiff = oldPrice > 0 ? ((newPrice - oldPrice) / oldPrice * 100).toFixed(1) : 0;

        // Actualizar Firestore
        const historyEntry = { price: newPrice, stock: data.stock, checkedAt: new Date().toISOString() };
        await doc.ref.update({
          currentPrice: newPrice,
          stock: data.stock || track.stock,
          stockCount: data.stockCount || track.stockCount,
          lastCheck: new Date().toISOString(),
          priceHistory: admin.firestore.FieldValue.arrayUnion(historyEntry)
        });
        checked++;

        // Alertas
        if (newPrice < oldPrice && Math.abs(priceDiff) >= 3) {
          alerts++;
          const ownerJid = _getOwnerSock()?.user?.id;
          if (ownerJid) {
            const ownerSelf = ownerJid.includes(':') ? ownerJid.split(':')[0] + '@s.whatsapp.net' : ownerJid;
            const emoji = Math.abs(priceDiff) >= 15 ? '🔥🔥🔥' : Math.abs(priceDiff) >= 8 ? '🔥' : '📉';
            await _safeSendMessage(ownerSelf,
              `${emoji} *Baja de precio!*\n📦 ${track.productName}\n💰 ${track.currency} ${oldPrice.toLocaleString()} → *${newPrice.toLocaleString()}* (${priceDiff}%)\n${data.stock !== 'disponible' ? `⚠️ Stock: ${data.stock}${data.stockCount ? ` (${data.stockCount} unidades)` : ''}` : ''}`,
              { isSelfChat: true }
            );
          }
        } else if (newPrice > oldPrice && Math.abs(priceDiff) >= 10) {
          // Subida significativa — avisar también
          const ownerJid = _getOwnerSock()?.user?.id;
          if (ownerJid) {
            const ownerSelf = ownerJid.includes(':') ? ownerJid.split(':')[0] + '@s.whatsapp.net' : ownerJid;
            await _safeSendMessage(ownerSelf,
              `📈 *Subida de precio*\n📦 ${track.productName}\n💰 ${track.currency} ${oldPrice.toLocaleString()} → *${newPrice.toLocaleString()}* (+${priceDiff}%)`,
              { isSelfChat: true }
            );
          }
        }

        // Stock bajo
        if (data.stockCount && data.stockCount <= 5 && track.stockCount > 5) {
          const ownerJid = _getOwnerSock()?.user?.id;
          if (ownerJid) {
            const ownerSelf = ownerJid.includes(':') ? ownerJid.split(':')[0] + '@s.whatsapp.net' : ownerJid;
            await _safeSendMessage(ownerSelf,
              `⚠️ *Stock bajo!*\n📦 ${track.productName}\n📊 Quedan *${data.stockCount}* unidades`,
              { isSelfChat: true }
            );
          }
        }

        // Rate limit: esperar 3s entre checks para no saturar Gemini
        await new Promise(r => setTimeout(r, 3000));
      } catch (checkErr) {
        console.error(`[PRICE-TRACKER] ❌ Error checking ${track.productName}:`, checkErr.message);
      }
    }

    if (checked > 0) console.log(`[PRICE-TRACKER] ✅ ${checked} productos verificados, ${alerts} alertas enviadas`);
  } catch (e) {
    console.error(`[PRICE-TRACKER] ❌ Error en checkPrices:`, e.message);
  }
}

/**
 * Desactivar seguimiento de un producto
 */
async function stopTracking(trackId, ownerUid) {
  try {
    await admin.firestore()
      .collection('users').doc(ownerUid)
      .collection('price_tracks').doc(trackId)
      .update({ status: 'stopped', stoppedAt: new Date().toISOString() });
    console.log(`[PRICE-TRACKER] ⏹️ Seguimiento detenido: ${trackId}`);
    return { success: true };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

module.exports = {
  initPriceTracker,
  trackProduct,
  checkPrices,
  stopTracking,
  identifyStoreReply,
  processStoreReply
};
