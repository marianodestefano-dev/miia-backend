/**
 * messageProcessor.js - CommonJS
 * Lógica de procesamiento de mensajes de MIIA - Convertido de ESM a CommonJS
 */

const path = require('path');
const fs = require('fs');
const { exec } = require('child_process');

/**
 * Maneja mensajes entrantes del cliente WhatsApp + Procesa respuestas de MIIA
 * @param {Object} message - Mensaje de whatsapp-web.js
 * @param {Object} globalState - Estado global compartido
 */
async function handleIncomingMessage(message, globalState) {
    try {
        // --- FILTROS ANTI-RUIDO ---
        if (!message.body || !message.body.trim()) return;

        const isBroadcast = message.from.includes('status@broadcast');
        const isGroup = message.from.endsWith('@g.us');
        if (isBroadcast || isGroup) return;

        const fromMe = message.fromMe;
        const body = message.body.trim();
        const targetPhone = fromMe ? message.to : message.from;
        const basePhone = targetPhone.split('@')[0];

        console.log(`[MessageProcessor] Mensaje de ${basePhone}: ${body.substring(0,40)}`);

        // --- OPT-OUT CHECK ---
        const optOutKeywords = ['quitar', 'baja', 'no molestar', 'spam', 'unsubscribe'];
        if (!fromMe && optOutKeywords.some(kw => body.toLowerCase().includes(kw))) {
            await handleLeadOptOut(targetPhone, globalState);
            return;
        }

        // --- PROCESAR MENSAJE ---
        if (!globalState.isProcessing[targetPhone]) {
            globalState.isProcessing[targetPhone] = true;

            setTimeout(async () => {
                try {
                    await processAndSendAIResponse(targetPhone, body, false, globalState);
                } finally {
                    delete globalState.isProcessing[targetPhone];
                }
            }, 3500);
        }

    } catch (err) {
        console.error('[MessageProcessor] Error al procesar mensaje:', err.message);
    }
}

/**
 * Procesa y envía respuesta de IA
 */
async function processAndSendAIResponse(phone, userMessage, isAlreadySaved, globalState) {
    const basePhone = phone.split('@')[0];
    const isFamily = !!globalState.familyContacts[basePhone];
    const isGroup = phone.endsWith('@g.us');

    return await processMiiaResponse(null, phone, isFamily, isGroup, userMessage, isAlreadySaved, globalState);
}

/**
 * FUNCIÓN PRINCIPAL: Genera respuesta de MIIA vía IA
 */
async function processMiiaResponse(msg, phone, isFamily, isGroup, userMessage, isAlreadySaved, globalState) {
    const {
        generateAIContent, safeSendMessage, saveDB,
        conversations, leadNames, familyContacts, keywordsSet,
        allowedLeads, leadSummaries, conversationMetadata,
        miiaPausedUntil, trainingData, ADMIN_PHONES,
        automationSettings, userProfile, lastAiSentBody, sentMessageIds,
        isWithinSchedule, quotedLeads, generateQuotePdf, MessageMedia,
        client, clientReady, vademecum, helpCenterData
    } = globalState;

    const basePhone = phone.split('@')[0];

    try {
        if (!conversations[phone]) conversations[phone] = [];

        const isAdmin = ADMIN_PHONES.includes(basePhone);
        const isMasterTesting = basePhone === '573163937365';
        const isSimulator = msg === 'SIMULATOR';
        const familyInfo = familyContacts[basePhone];

        // --- COMANDOS ADMIN ---
        if ((isAdmin || isMasterTesting) && userMessage) {
            if (userMessage.toUpperCase() === 'STOP') {
                miiaPausedUntil = Date.now() + 30 * 60 * 1000;
                await safeSendMessage(phone, "*[MIIA PROTOCOLO STOP]*\nSilencio por 30 minutos.");
                return;
            }

            if (userMessage.toUpperCase().startsWith('MIIA APRENDE:')) {
                const learnedContent = userMessage.substring(13).trim();
                trainingData += `\n[${new Date().toLocaleDateString()}]: ${learnedContent}\n`;
                saveDB();
                await safeSendMessage(phone, "¡Asimilado!");
                return;
            }

            if (userMessage.toUpperCase() === 'REACTIVAR' && miiaPausedUntil > Date.now()) {
                miiaPausedUntil = 0;
                await safeSendMessage(phone, "¡He vuelto!");
                return;
            }
        }

        if (miiaPausedUntil > Date.now()) return;
        if (isGroup && !automationSettings.miiaGroupEnabled) return;
        if (familyInfo && !isAdmin && !isSimulator) return;

        // --- GUARDAR MENSAJE ---
        if (!isAlreadySaved && userMessage) {
            conversations[phone].push({ role: 'user', content: userMessage, timestamp: Date.now() });
        }

        // --- SÍNTESIS DE MEMORIA A CADA 15 MENSAJES ---
        if (conversations[phone].length === 15) {
            const historyText = conversations[phone].map(m => `${m.role === 'user' ? 'Cliente' : 'Agente'}: ${m.content}`).join('\n');
            const summaryPrompt =`Resume en máximo 4 líneas quién es este cliente, qué necesita y en qué estado quedó.\n\n${historyText}`;

            generateAIContent(summaryPrompt).then(summary => {
                leadSummaries[phone] = summary.trim();
                saveDB();
            }).catch(() => {});
        }

        // --- DETECTAR PALABRAS CLAVE (OFERTAS RÁPIDAS) ---
        if (userMessage && keywordsSet.length > 0) {
            const matched = keywordsSet.find(k => {
                try {
                    return new RegExp(`\\b${k.key}\\b`, 'i').test(userMessage);
                } catch {
                    return userMessage.toLowerCase().includes(k.key.toLowerCase());
                }
            });

            if (matched && !isAdmin) {
                conversations[phone].push({ role: 'assistant', content: matched.response, timestamp: Date.now() });
                saveDB();
                if (!isSimulator) {
                    await safeSendMessage(phone, matched.response);
                }
                return;
            }
        }

        // --- CONSTRUIR PROMPT DE IA ---
        const history = (conversations[phone] || []).map(m =>
            `${m.role === 'user' ? 'Cliente' : 'Agente'}: ${m.content}`
        ).join('\n');

        const leadName = leadNames[phone] || 'Usuario';
        const countryCode = basePhone.substring(0, 2);
        let systemPrompt = 'Eres MARIANO DE STEFANO, experto en Medilink (SaaS hospitalario).';

        if (isAdmin) {
            systemPrompt = '[MODO AMIGA DEL ALMA]: Eres su mano derecha inteligente. Total lealtad y complicidad.';
        } else if (isFamily && familyInfo) {
            systemPrompt = `Eres MIIA, asistente de Mariano. Hablas con ${familyInfo.fullName} (${familyInfo.relation}).`;
        }

        const syntheticMemory = leadSummaries[phone] ? `\nMEMORIA DEL LEAD: ${leadSummaries[phone]}` : '';
        const countryHint = countryCode === '57' ? '\n🌍 El cliente es de COLOMBIA (incluir SIIGO y BOLD en Titanium)' : '';
        const trainingHint = trainingData ? `\nCONOCIMIENTO ESPECIAL: ${trainingData.substring(0, 300)}...` : '';

        const fullPrompt = `${systemPrompt}${syntheticMemory}${countryHint}${trainingHint}

[HISTORIAL DE CONVERSACIÓN]:
${history}

Genera una respuesta breve, natural y profesional como Mariano/MIIA:`;

        // --- LLAMAR A IA ---
        let aiMessage = await generateAIContent(fullPrompt);
        if (!aiMessage) {
            throw new Error('Gemini no devolvió respuesta');
        }

        // --- DETECTAR TAGS ESPECIALES ---
        let generatePdf = false;
        let pdfParams = { country: null, doctors: 1, appointments: 150, name: null, periodic: 'MENSUAL' };

        const pdfTagMatch = aiMessage.match(/\[GENERAR_COTIZACION_PDF(?::([A-Z]+):(\d+):(\d+)(?::([^:\]]+))?(?::(ANUAL|MENSUAL))?)?\]/);
        if (pdfTagMatch) {
            generatePdf = true;
            if (pdfTagMatch[1]) {
                const countryMap = { CO: 'COP', MX: 'MXN', CL: 'CLP', AR: 'USD' };
                pdfParams.country = countryMap[pdfTagMatch[1]] || 'USD';
                pdfParams.doctors = parseInt(pdfTagMatch[2]) || 1;
                pdfParams.appointments = parseInt(pdfTagMatch[3]) || 150;
                if (pdfTagMatch[4]) pdfParams.name = pdfTagMatch[4];
                if (pdfTagMatch[5]) pdfParams.periodic = pdfTagMatch[5];
            }
            aiMessage = aiMessage.replace(pdfTagMatch[0], '').trim();

            // Mensaje amigable para PDF
            const pdfIntros = [
                '¡Aquí tienes tu cotización! 📄',
                '¡Perfecto! Tu propuesta formal está lista. 🩺📄',
                '¡Listo! Aquí está tu cotización personalizada. 📃'
            ];
            aiMessage = pdfIntros[Math.floor(Math.random() * pdfIntros.length)];
        }

        // --- GUARDAR RESPUESTA ---
        conversations[phone].push({ role: 'assistant', content: aiMessage, timestamp: Date.now() });
        saveDB();

        // --- LIMPIAR HISTORIAL A 10 ÚLTIMOS MENSAJES ---
        if (conversations[phone].length > 10) {
            conversations[phone] = conversations[phone].slice(-10);
        }

        // --- ENVIAR RESPUESTA ---
        if (aiMessage.length > 0 && (!isSimulator)) {
            try {
                const chatState = await client.getChatById(phone);
                await chatState.sendStateTyping();

                // Simular escritura: 65ms por carácter
                const typingDuration = Math.min(Math.max(aiMessage.length * 65, 2500), 15000);
                await new Promise(r => setTimeout(r, typingDuration));

                lastAiSentBody[phone] = aiMessage.trim();
                await safeSendMessage(phone, aiMessage);
            } catch (sendErr) {
                console.error('[MessageProcessor] Error enviando mensaje:', sendErr.message);
            }
        }

        // --- GENERAR PDF SI SE SOLICITÓ ---
        if (generatePdf && generateQuotePdf) {
            try {
                const prospectName = pdfParams.name || leadNames[phone] || 'Cliente';
                const pdfResult = await generateQuotePdf(prospectName, basePhone, pdfParams.country, {
                    doctors: pdfParams.doctors,
                    appointments: pdfParams.appointments,
                    advisor: userProfile,
                    isAnnual: pdfParams.periodic === 'ANUAL'
                });

                if (pdfResult && pdfResult.success && pdfResult.filePath) {
                    // Enviar PDF por WhatsApp
                    if (MessageMedia && fs.existsSync(pdfResult.filePath)) {
                        const media = MessageMedia.fromFilePath(pdfResult.filePath);
                        await safeSendMessage(phone, media, { caption: '📄 COTIZACIÓN MEDILINK' });
                    }

                    // Guardar tracking
                    quotedLeads[phone] = {
                        date: Date.now(),
                        currency: pdfResult.currency,
                        reminded: false
                    };
                    saveDB();
                }
            } catch (pdfErr) {
                console.error('[MessageProcessor] Error generando PDF:', pdfErr.message);
            }
        }

    } catch (err) {
        console.error('[MessageProcessor] Error en processMiiaResponse:', err.message);
    }
}

/**
 * Maneja desuscripción de leads (opt-out)
 */
async function handleLeadOptOut(phoneId, globalState) {
    const { conversations, leadNames, allowedLeads, saveDB } = globalState;

    console.log(`[OPT-OUT] Procesando opt-out para: ${phoneId}`);

    // Eliminar de leads permitidos
    const idx = allowedLeads.indexOf(phoneId);
    if (idx !== -1) allowedLeads.splice(idx, 1);

    // Eliminar historial
    if (conversations[phoneId]) delete conversations[phoneId];
    if (leadNames[phoneId]) delete leadNames[phoneId];

    saveDB();
    console.log(`[OPT-OUT] Lead ${phoneId} eliminado completamente.`);
}

// Exportar funciones
module.exports = {
    handleIncomingMessage,
    processAndSendAIResponse,
    processMiiaResponse,
    handleLeadOptOut
};