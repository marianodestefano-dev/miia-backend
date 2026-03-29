import express from 'express';
import nodemailer from 'nodemailer';
import cors from 'cors';
import dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';
import pkg from 'whatsapp-web.js';
const { Client, LocalAuth, MessageMedia } = pkg;
import qrcode from 'qrcode-terminal';
import { GoogleGenerativeAI } from '@google/generative-ai';
import { GoogleAIFileManager } from '@google/generative-ai/server';
import QRCode from 'qrcode';
import { YoutubeTranscript } from 'youtube-transcript';
import multer from 'multer';
import ffmpegInstaller from '@ffmpeg-installer/ffmpeg';
const ffmpegPath = ffmpegInstaller.path;
const ffmpegDir = path.dirname(ffmpegPath);
const pathSeparator = process.platform === 'win32' ? ';' : ':';
process.env.PATH = `${ffmpegDir}${pathSeparator}${process.env.PATH}`;
process.env.FFMPEG_PATH = ffmpegPath;
import { spawn } from 'child_process';
import { generateQuotePdf } from './pdfGenerator.js';
import * as XLSX from 'xlsx';
const xlsx = XLSX.default || XLSX;
const { readFile, utils, write } = xlsx;
import { encrypt, decrypt } from './cryptoUtils.js';
import { exec, execSync } from 'child_process';
import { fileURLToPath } from 'url';

// 1. CONFIGURACIÓN DE ENTORNO E IDENTIDAD
dotenv.config();
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const app = express();
const PORT = process.env.PORT || 3000;

// 2. MIDDLEWARE CRÍTICO
app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));
app.use('/media', express.static(path.join(__dirname, 'uploads')));

// 3. VACUNA PROFILÁCTICA (Escudo Anti-Zombies)
try {
    const isWindows = process.platform === 'win32';
    console.log('[SISTEMA] Activando Vacuna Protectora Satélite (MODO BLINDADO)...');
    if (isWindows) {
        exec('taskkill /F /IM chrome.exe /T 2>nul');
        console.log('[VACUNA] Limpieza nuclear completada.');
    } else {
        try {
            execSync(`lsof -ti:${PORT} | xargs kill -9 2>/dev/null`);
        } catch (e) { }
    }
} catch (vErr) {
    console.warn('[VACUNA] Fallo en escudo', vErr.message);
}

// 4. ESTRUCTURAS DE DATOS
const OWNER_PHONE = '573051469969'; // Nuevo Chip LOBSTERS (OFICIAL)
const ADMIN_PHONES = ['573051469969']; // Solo el chip LOBSTERS es Admin absoluto
const BLACKLISTED_NUMBERS = ['573023317570@c.us'];
let conversations = {};
let leadNames = {};
let familyContacts = {};
let flaggedBots = {};
let keywordsSet = [];
let videoInsights = [];
let allowedLeads = [];
let isProcessing = {};


// Database Structure
// (Variables consolidadas arriba)


// --- HELPERS DE HUMANIZACIÓN Y PRECISIÓN (MIIA v6.2) ---
function normalizeText(text) {
    if (!text) return "";
    return text.toLowerCase()
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "") // Elimina tildes
        .replace(/[^a-z0-9\s]/g, "")     // Elimina caracteres especiales
        .trim();
}

function sanitizeFilename(name) {
    return normalizeText(name)
        .replace(/\s+/g, '_')            // Espacios por guiones bajos
        .toUpperCase();
}

let miiaPausedUntil = 0; // Timestamp hasta el cual MIIA está silenciada (STOP)
let trainingData = ""; // Memoria de aprendizaje WA
let leadSummaries = {}; // Resúmenes de leads para memoria a largo plazo
let conversationMetadata = {}; // Persistent flags for conversations (pause, etc)
let systemOperationsCount = 0;
let closedSales = []; // SafeGuard: counter for auto-backups
let lastSentByBot = {}; // Loop protection: Buffer of last 5 messages sent by AI per phone
let sentMessageIds = new Set(); // Global ID blacklist for messages sent by the IA
let lastAiSentBody = {}; // Anti-loop: last AI-generated body per phone
let helpCenterData = "";
let lastInteractionTime = {}; // Safeguard for rapid-fire self-chat loops
let selfChatLoopCounter = {}; // Counter for rapid messages in self-chats
let excelPreloadData = []; // Store cleaned leads before actual processing
let aiSystemInstruction = "";
let systemPrompt = "";
let emmaPersona = "[INSTRUCCION CORPORATIVA]: Eres MIIA, una IA avanzada de Medilink. Tu tono es profesional, cercano y resolutivo.";

function isPotentialBot(text) {
    if (!text) return false;
    const botKeywords = [
        'soy un bot', 'asistente virtual', 'mensaje automático',
        'auto-responder', 'vía @', 'powered by', 'gracias por su mensaje',
        'transcripción de audio', 'identificador de m'
    ];
    const lowerText = text.toLowerCase();
    return botKeywords.some(kw => lowerText.includes(kw));
}
let excelPreloadStatus = { inProgress: false, total: 0, current: 0, startTime: null };

// --- ANTI-SPAM QUEUE GLOBALS ---
let antiSpamQueue = [];
let isQueueProcessing = false;
let isSystemPaused = false;
let pauseTimeout = null;
let queueConfig = { maxBatch: 40, minDelayMinutes: 121, maxDelayMinutes: 333, lastRunTime: 0, currentDelayMinutes: 150 };
const queuePath = path.join(__dirname, 'data', 'anti_spam_queue.json');
const queueConfigPath = path.join(__dirname, 'data', 'anti_spam_config.json');

if (fs.existsSync(queuePath)) {
    try { antiSpamQueue = JSON.parse(fs.readFileSync(queuePath, 'utf8')); } catch (e) { antiSpamQueue = []; }
}
if (fs.existsSync(queueConfigPath)) {
    try { queueConfig = { ...queueConfig, ...JSON.parse(fs.readFileSync(queueConfigPath, 'utf8')) }; } catch (e) { }
}

function saveQueueData() {
    fs.writeFileSync(queuePath, JSON.stringify(antiSpamQueue, null, 2));
    fs.writeFileSync(queueConfigPath, JSON.stringify(queueConfig, null, 2));
}

function enqueueLeads(leads, strategy, welcomeMessage, selectedFile) {
    leads.forEach(l => {
        // Evitar duplicados exactos en cola
        if (!antiSpamQueue.find(q => q.phone === l.phone)) {
            antiSpamQueue.push({ ...l, strategy, welcomeMessage, selectedFile, addedAt: Date.now() });
        }
    });
    saveQueueData();
    saveQueueData();
}

// --- MINERO CRONOLÓGICO Y CLIENTES MEDILINK GLOBALS ---
let clientesMedilink = [];
const clientesMedilinkPath = path.join(__dirname, 'data', 'clientes_medilink.json');
if (fs.existsSync(clientesMedilinkPath)) {
    try { clientesMedilink = JSON.parse(fs.readFileSync(clientesMedilinkPath, 'utf8')); } catch (e) { clientesMedilink = []; }
}

let adnMinerState = {
    dayD: null,
    currentSearchDate: new Date('2023-07-01T00:00:00Z').getTime() / 1000,
    lastProcessedPhone: null,
    leadsToReactivate: [],
    lastExecutionDayStr: null,
    lastInjectionDayStr: null,
    totalProcessed: 0,
    isComplete: false,
    dailyLimit: 0
};
const adnMinerStatePath = path.join(__dirname, 'data', 'adn_miner_state.json');
if (fs.existsSync(adnMinerStatePath)) {
    try { adnMinerState = { ...adnMinerState, ...JSON.parse(fs.readFileSync(adnMinerStatePath, 'utf8')) }; } catch (e) { }
}

function saveAdnMinerState() {
    if (!fs.existsSync(path.join(__dirname, 'data'))) fs.mkdirSync(path.join(__dirname, 'data'), { recursive: true });
    fs.writeFileSync(adnMinerStatePath, JSON.stringify(adnMinerState, null, 2));
    fs.writeFileSync(clientesMedilinkPath, JSON.stringify(clientesMedilink, null, 2));
}

let currencyRates = { cop: 4000, mxn: 20, pen: 4, clp: 900, usd: 1 };
let quotedLeads = {}; // Store { phone: { date: Date.now(), plans: [], modules: [], reminded: false } }
let closedSalesDetails = {}; // Store { phone: { date: Date.now(), plan: '', modules: [] } }
let activeOTPs = {}; // Store OTPs temporarily
let userProfile = { name: '', phone: '', email: '', smtpPass: '', goal: 1500 };
let tenantSession = { archive: [] }; // Historial persistente para el Dashboard

let vademecum = [];
const vademecumPath = path.join(__dirname, 'data', 'vademecum.json');
const vademecumFullPaths = [
    path.join(__dirname, 'data', 'vademecum.json'),
    path.join(__dirname, '..', 'CONOCIMIENTO_IA', 'vademecum_full.md') // Nueva estructura unificada
];

try {
    vademecumFullPaths.forEach(vPath => {
        if (fs.existsSync(vPath)) {
            console.log(`[SYS] Vademécum localizado en: ${vPath}`);
            // Si es MD, lo cargamos como texto para el prompt, si es JSON lo cargamos para lógica
            if (vPath.endsWith('.json')) {
                vademecum = JSON.parse(fs.readFileSync(vPath, 'utf8'));
            }
        }
    });
} catch (vErr) {
    console.error("[SYS] Error cargando Vademécum:", vErr.message);
}


// Load Help Center Knowledge
try {
    const hcPath = path.join(__dirname, 'data', 'help_center_index.txt');
    if (fs.existsSync(hcPath)) {
        helpCenterData = fs.readFileSync(hcPath, 'utf8');
        console.log("[SYS] Help Center Knowledge Base loaded into memory.");
    }
} catch (e) {
    console.log("[SYS] Could not load Help Center Knowledge Base.");
}

// File Management initialization
const uploadDirStore = path.join(__dirname, 'public', 'uploads');
if (!fs.existsSync(uploadDirStore)) fs.mkdirSync(uploadDirStore, { recursive: true });

const historyDir = path.join(__dirname, 'data', 'excel_history');
if (!fs.existsSync(historyDir)) fs.mkdirSync(historyDir, { recursive: true });

const storage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, uploadDirStore),
    filename: (req, file, cb) => {
        // Fix for special characters in filenames mapping correctly from Latin1 to UTF8
        cb(null, Buffer.from(file.originalname, 'latin1').toString('utf8'));
    }
});
const upload = multer({ storage });

let MIIA_ACTIVE = true;
let automationSettings = {
    autoResponse: false,
    additionalPersona: "",
    lastUpdate: new Date().toISOString(),
    tokenLimit: 500000,
    isCoffeeMode: false,
    schedule: {
        start: '09:00',
        end: '21:00',
        days: [1, 2, 3, 4, 5, 6, 7]
    }
};

let totalSessionTokens = 0;
let tokenHistory = [];
let isDetectingTier = false; // Parche de concurrencia Fase 15
let billingStats = {
    totalInputTokens: 0,
    totalOutputTokens: 0,
    estimatedCostUSD: 0,
    tier: 'Detectando...', // 'Free' o 'Comercial'
    quotaAlert: false
};

// --- DETECCIÓN PROACTIVA DE TIER (Google AI) ---
async function detectGoogleTier(force = false) {
    if (isDetectingTier && !force) return;
    if (billingStats.tier !== 'Detectando...' && !force) return;

    isDetectingTier = true;
    try {
        console.log(`[SYS] ${force ? 'FORZANDO' : 'Auditando'} Tier de Google AI...`);
        if (!process.env.GEMINI_API_KEY) {
            console.error("❌ [TIER] Error: No se encontró GEMINI_API_KEY en el .env");
            billingStats.tier = 'Error: Sin API Key';
            saveDB();
            isDetectingTier = false;
            return;
        }

        const timeoutPromise = new Promise((_, reject) => setTimeout(() => reject(new Error('TIMEOUT_GOOGLE')), 10000));

        // Probamos con gemini-2.5-flash primero
        const model = ai.getGenerativeModel({ model: "gemini-1.5-flash", systemInstruction: systemPrompt });
        const pingPromise = model.generateContent("Hola, responde solo 'ok'.");

        const result = await Promise.race([pingPromise, timeoutPromise]);

        if (result && result.response) {
            billingStats.tier = 'Comercial (Pro)';
            console.log("✅ [TIER] Google AI detectado como PRO.");
            saveDB();
        }
    } catch (e) {
        const errorMsg = e.message || "";
        console.error("❌ [TIER] Detalle del Error:", errorMsg);

        if (errorMsg.includes('429') || errorMsg.includes('Quota exceeded') || errorMsg.includes('exhausted')) {
            billingStats.tier = 'Free (Limitado)';
            console.log("⚠️ [TIER] Google AI detectado como FREE.");
        } else if (errorMsg === 'TIMEOUT_GOOGLE') {
            billingStats.tier = 'Error: Timeout (Lento)';
        } else if (errorMsg.includes('404')) {
            console.log("🔄 [TIER] Reintentando con gemini-pro...");
            try {
                const modelPro = ai.getGenerativeModel({ model: "gemini-pro" });
                const res = await modelPro.generateContent("ok");
                if (res.response) {
                    billingStats.tier = 'Comercial (Pro)';
                    console.log("✅ [TIER] Google AI detectado como PRO (vía pro).");
                    saveDB();
                    isDetectingTier = false;
                    return;
                }
            } catch (e2) {
                billingStats.tier = 'Error: No Detectado';
            }
        } else {
            billingStats.tier = 'Error: Problema Red';
        }
        saveDB();
    } finally {
        isDetectingTier = false;
    }
}

let masterPrompt = "Eres un asistente útil.";
try {
    const promptPath = path.join(__dirname, 'prompt_maestro.md');
    if (fs.existsSync(promptPath)) {
        masterPrompt = fs.readFileSync(promptPath, 'utf8');
        console.log(`[SYS] PROMPT MAESTRO cargado exitosamente (${masterPrompt.length} caracteres).`);
    } else {
        console.warn("[SYS] No se encontró prompt_maestro.md");
    }
} catch (err) {
    console.error(`[SYS] Error leyendo prompt maestro:`, err);
}

// Persistence Logic
const TENANT_DB_PATH = path.join(__dirname, 'data', 'tenant_session.json');
const MASTER_DB_PATH = path.join(__dirname, 'data', 'master_knowledge.json');
if (!fs.existsSync(path.join(__dirname, 'data'))) fs.mkdirSync(path.join(__dirname, 'data'));

// --- CENTRALIZADOR DE ENVÍOS AUDITADOS (VACUNA INTERCEPTOR) ---
async function safeSendMessage(target, content, options = {}) {
    if (isSystemPaused) {
        console.log(`⚠️ [INTERCEPTADO] Intento de envío a ${target} BLOQUEADO por pausa de seguridad.`);
        return null;
    }
    // === CORTAFUEGOS DE SEGURIDAD ABSOLUTA (MARIANO V.1) ===
    if (target.endsWith('@g.us') && !automationSettings.miiaGroupEnabled) {
        console.log(`[WA] 🚨 BLOQUEO CRÍTICO: Envío a GRUPO abortado por seguridad (${target})`);
        return null;
    }

    if (!clientReady) {
        console.log(`⚠️ [INTERCEPTADO] Intento de envío a ${target} BLOQUEADO por pausa de seguridad.`);
        return null;
    }

    // Pre-Auditoría contra Vademécum (Patterns Críticos)
    const normalizedContent = (typeof content === 'string' ? content : (content.body || "")).toLowerCase();
    if (vademecum && vademecum.length > 0) {
        for (const cure of vademecum) {
            if (cure.pattern !== "NO_PATTERN_YET" && normalizedContent.includes(cure.pattern.toLowerCase())) {
                console.log(`🚨 [INTERCEPTADO] Mensaje a ${target} contiene patrón prohibido: ${cure.id}. Abortando envío.`);
                return null;
            }
        }
    }

    // Delay Humano Mimetizado (1.5s - 3s)
    if (!options.noDelay) {
        const delay = Math.floor(Math.random() * (3000 - 1500 + 1)) + 1500;
        await new Promise(r => setTimeout(r, delay));
    }

    try {
        const result = await client.sendMessage(target, content, options);
        console.log(`[SENT] Mensaje enviado a ${target.split('@')[0]}`);
        return result;
    } catch (e) {
        console.error(`[ERROR SENT] Fallo al enviar a ${target}:`, e.message);
        throw e;
    }
}

const saveDB = () => {
    const tenantData = {
        familyContacts: familyContacts || {},
        conversations: conversations || {},
        leadNames: leadNames || {},
        keywordsSet: keywordsSet || [],
        allowedLeads: allowedLeads || [],
        leadSummaries: leadSummaries || {},
        totalSessionTokens: totalSessionTokens || 0,
        tokenHistory: tokenHistory || [],
        billingStats: billingStats || {},
        flaggedBots: flaggedBots || {},
        conversationMetadata: conversationMetadata || {},
        systemOperationsCount: systemOperationsCount || 0,
        closedSales: closedSales || [],
        currencyRates: currencyRates || { cop: 4000, mxn: 20, pen: 4, clp: 900, usd: 1 },
        quotedLeads: quotedLeads || {},
        closedSalesDetails: closedSalesDetails || {},
        userProfile: userProfile || {},
        automationSettings: automationSettings || {},
        tenantSession: tenantSession || { archive: [] }
    };

    const masterData = {
        videoInsights,
        trainingData,
        systemPrompt
    };

    try {
        if (!fs.existsSync(path.dirname(TENANT_DB_PATH))) fs.mkdirSync(path.dirname(TENANT_DB_PATH), { recursive: true });

        fs.writeFileSync(TENANT_DB_PATH, encrypt(JSON.stringify(tenantData, null, 2)));
        fs.writeFileSync(MASTER_DB_PATH, encrypt(JSON.stringify(masterData, null, 2)));
    } catch (e) {
        console.error("[SISTEMA] Error guardando bases de datos separadas:", e.message);
    }
};

const loadDB = () => {
    let data = {};
    const OLD_DB_PATH = path.join(__dirname, 'data', 'db.json');

    try {
        if (fs.existsSync(OLD_DB_PATH) && !fs.existsSync(TENANT_DB_PATH)) {
            console.log("[SYS] Migrando db.json antigua a la nueva estructura dividida..."); setTimeout(saveDB, 2000);
            let oldContent = fs.readFileSync(OLD_DB_PATH, 'utf8').trim();
            const isEncryptedOld = !oldContent.startsWith('{') && /^[0-9a-fA-F]+:[0-9a-fA-F]+$/.test(oldContent);
            if (isEncryptedOld) oldContent = decrypt(oldContent);
            data = JSON.parse(oldContent);
        } else {
            if (fs.existsSync(TENANT_DB_PATH)) {
                let tContent = fs.readFileSync(TENANT_DB_PATH, 'utf8').trim();
                const isEncryptedT = !tContent.startsWith('{') && /^[0-9a-fA-F]+:[0-9a-fA-F]+$/.test(tContent);
                if (isEncryptedT) tContent = decrypt(tContent);
                Object.assign(data, JSON.parse(tContent));
            }
            if (fs.existsSync(MASTER_DB_PATH)) {
                let mContent = fs.readFileSync(MASTER_DB_PATH, 'utf8').trim();
                const isEncryptedM = !mContent.startsWith('{') && /^[0-9a-fA-F]+:[0-9a-fA-F]+$/.test(mContent);
                if (isEncryptedM) mContent = decrypt(mContent);
                Object.assign(data, JSON.parse(mContent));
            }
            if (Object.keys(data).length > 0) {
                console.log('[CRYPTO] Bases de datos Tenant y Master cargadas y descifradas con éxito.');
            }
        }

        if (Object.keys(data).length > 0) {
            conversations = data.conversations || {};
            leadNames = data.leadNames || {};
            keywordsSet = data.keywordsSet || [];
            videoInsights = data.videoInsights || [];
            allowedLeads = data.allowedLeads || [];
            leadSummaries = data.leadSummaries || {};
            tenantSession = data.tenantSession || { archive: [] };
            trainingData = data.trainingData || "";
            flaggedBots = data.flaggedBots || {};
            conversationMetadata = data.conversationMetadata || {};
            systemOperationsCount = data.systemOperationsCount || 0;
            closedSales = data.closedSales || [];
            currencyRates = data.currencyRates || { cop: 4000, mxn: 20, pen: 4, clp: 900, usd: 1 };
            quotedLeads = data.quotedLeads || {};
            closedSalesDetails = data.closedSalesDetails || {};
            userProfile = data.userProfile || { name: '', phone: '', email: '', monthlyGoal: 1500 };
            if (data.userProfile && data.userProfile.goal) {
                userProfile.monthlyGoal = data.userProfile.goal;
                delete userProfile.goal;
            }
            totalSessionTokens = data.totalSessionTokens || 0;
            tokenHistory = data.tokenHistory || [];
            billingStats = data.billingStats || { totalInputTokens: 0, totalOutputTokens: 0, estimatedCostUSD: 0, tier: 'Detectando...' };
            if (!billingStats.tier) billingStats.tier = 'Detectando...';

            // Forzar detección inmediata al arranque si está en 'Detectando...'
            if (billingStats.tier === 'Detectando...') {
                setTimeout(() => detectGoogleTier(true), 5000);
            }
            automationSettings = { ...automationSettings, ...(data.automationSettings || {}) };
            automationSettings.autoResponse = true; // RESTAURADO MODO ACTIVO PARA LEADS ✅
            automationSettings.miiaGroupEnabled = false; // BLINDAJE DE SEGURIDAD EN GRUPOS (EVITAR ACCIDENTES) ✅
            if (data.familyContacts) familyContacts = data.familyContacts;

            MIIA_ACTIVE = true; // MIIA VUELVE A LA VIDA SOBERANA
            console.log(`[SYS] LOBSTERS V1 RESTAURADO: MIIA_ACTIVE=true (Solo Leads)`);

            // Inicializar contactos familiares si la DB está vacía o es nueva
            if (Object.keys(familyContacts).length === 0 || automationSettings.autoResponse) {
                familyContacts = {
                    '573137501884': { name: 'Alejandra', fullName: 'Alejandra Sánchez', relation: 'esposa de Mariano', emoji: '👸💕', personality: 'Spicy, F1 (Leclerc/Colapinto), Parcera, interés en Libros', affinity: 90, isHandshakeDone: true }
                };
                // Mariano es Lead y Admin (Manejado por ADMIN_PHONES)
                if (!allowedLeads.includes('573163937365@c.us')) allowedLeads.push('573163937365@c.us');
                saveDB();
            }

            // Integración Persistente: Sincronizar Kill-Switch con el estado de la DB
            MIIA_ACTIVE = automationSettings.autoResponse;
            console.log(`[SYS] Persistencia de Estado: MIIA_ACTIVE=${MIIA_ACTIVE}`);

            if (totalSessionTokens === 0 && Object.keys(conversations).length > 0) {
                let charCount = 0;
                for (const phone in conversations) {
                    for (const msg of conversations[phone]) {
                        charCount += msg.content ? msg.content.length : 0;
                    }
                }
                charCount += trainingData ? trainingData.length : 0;
                totalSessionTokens = Math.ceil(charCount / 4);
            }
            totalSessionTokens = Math.max(3268997, totalSessionTokens);
            // 5. CARGA DE PROMPTS Y CONOCIMIENTO (Punto de Verdad 2026)
            const promptPath = path.join(__dirname, 'prompt_maestro.md');
            if (fs.existsSync(promptPath)) {
                const content = fs.readFileSync(promptPath, 'utf8');
                aiSystemInstruction = content;
                systemPrompt = content;
                console.log(`[SISTEMA] Prompt Maestro cargado y sincronizado (${content.length} chars). 🛡️`);
            } else {
                console.error('[SISTEMA] 🚨 No se encontró prompt_maestro.md');
            }

            const trainingPath = path.join(__dirname, 'training_data.txt');
            if (fs.existsSync(trainingPath)) {
                trainingData = fs.readFileSync(trainingPath, 'utf8');
                console.log('[SISTEMA] Training Data cargado. 🧠');
            }

            automationSettings.tokenLimit = 10000000;
            console.log("[SYS] Database loaded correctly.");
        }
    } catch (e) {
        console.error("[SYS] Error loading database:", e.message);
    }
};
loadDB();

// Initialize default rules if empty
if (keywordsSet.length === 0) {
    keywordsSet = [
        { key: "precio", response: "Nuestros planes comienzan desde $19.90 USD/mes. Tenemos 3 opciones: Esencial, Pro y Titanium. ¿Te gustaría que te envíe el dossier detallado?", attachedFile: "Dossier_Precios_Medilink.pdf" },
        { key: "siigo", response: "¡Excelente pregunta! Tenemos integración nativa con SIIGO. Si adquieres el Plan Titanium en Colombia, la integración te sale en $0 pesos.", attachedFile: null },
        { key: "bold", response: "Para nuestros clientes en Colombia, el Plan Titanium incluye un Datáfono BOLD de regalo para que cobres tus citas sin complicaciones.", attachedFile: null },
        { key: "demo", response: "¡Claro! Puedes agendar una demostración personalizada directamente aquí: https://meetings.hubspot.com/marianodestefano/demomedilink", attachedFile: null },
        { key: "seguridad", response: "Medilink cuenta con certificación ISO 27001, garantizando la máxima seguridad para los datos de tus pacientes.", attachedFile: null }
    ];
}

// Helper to check if now is within schedule
function isWithinSchedule() {
    if (!automationSettings.autoResponse) return false;

    // Use Colombia Time (America/Bogota) explicitly to prevent local server timezone bugs
    const bogotaDateString = new Date().toLocaleString("en-US", { timeZone: "America/Bogota" });
    const bogotaDate = new Date(bogotaDateString);

    const day = bogotaDate.getDay() === 0 ? 7 : bogotaDate.getDay(); // 1-7
    if (!automationSettings.schedule.days.includes(day)) return false;

    const time = `${bogotaDate.getHours().toString().padStart(2, '0')}:${bogotaDate.getMinutes().toString().padStart(2, '0')}`;
    return time >= automationSettings.schedule.start && time <= automationSettings.schedule.end;
}

// Initialize AI Client
const ai = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const fileManager = new GoogleAIFileManager(process.env.GEMINI_API_KEY);

const sessionPath = 'C:\\MIIA_SESSION_V3_FINAL';
if (!fs.existsSync(sessionPath)) fs.mkdirSync(sessionPath, { recursive: true });

// --- ESCUDO ANTI-BLOQUEO (MÉTODO DESKTOP APP v2) ---
// Eliminar candados de sesión de Chrome en CUALQUIER nivel de la carpeta de sesión.
try {
    const deleteLocks = (dir) => {
        if (!fs.existsSync(dir)) return;
        const files = fs.readdirSync(dir);
        for (const file of files) {
            const fullPath = path.join(dir, file);
            if (fs.lstatSync(fullPath).isDirectory()) {
                deleteLocks(fullPath);
            } else if (file.toLowerCase().includes('lock')) {
                try {
                    fs.unlinkSync(fullPath);
                    console.log(`[WA] 🛡️ Lock eliminado: ${file}`);
                } catch (e) { }
            }
        }
    };
    deleteLocks(sessionPath);
} catch (lockErr) {
    console.warn('[WA] No se pudo limpiar la selva de locks:', lockErr.message);
}

// LIMPIEZA PREVENTIVA DEL DOCK AL ARRANCAR (macOS)
try {
    console.log('[SISTEMA] Limpieza preventiva de iconos fantasmas en macOS Dock...');
    exec('killall Dock');
} catch (e) {
    console.log('[SISTEMA] No se pudo limpiar el Dock al inicio.');
}

const isLinux = process.platform === 'linux';
const isWindows = process.platform === 'win32';

// Determine the Chrome path based on the operating system
const chromePath = isLinux
    ? '/usr/bin/google-chrome-stable'
    : (isWindows ? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe' : '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome');

// Initialize WhatsApp Client - CONFIGURACIÓN ESTABLE (Comportamiento Desktop App)
const client = new Client({
    authStrategy: new LocalAuth({
        clientId: 'tenant_casa_central',
        dataPath: sessionPath,
        restartOnAuthFail: true
    }),
    puppeteer: {
        headless: true, // Modo estable para Windows
        executablePath: chromePath, // Inyección de ruta dinámica
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-gpu',
            '--disable-extensions',
            '--disable-infobars',
            '--window-size=1280,720',
            '--disk-cache-size=1',
            '--media-cache-size=1',
            '--disable-notifications'
        ]
    }
});


let currentQR = null;
let qrImage = null;
let clientReady = false;

client.on('qr', async (qr) => {
    console.log('QR RECEIVED. Scan to connect.');
    qrcode.generate(qr, { small: true }); // Keep terminal version too
    currentQR = qr;
    pairingCode = null; // Si sale QR, el Pairing Code ya no es válido
    try {
        qrImage = await QRCode.toDataURL(qr);
        if (client.pupPage) {
            await client.pupPage.screenshot({ path: path.join(__dirname, 'whatsapp_web_screenshot.png') });
            console.log('[SISTEMA] Captura de WhatsApp Web guardada exitosamente.');
        }
    } catch (err) {
        console.error('Failed to generate QR Image or Screenshot:', err);
    }
});

client.on('authenticated', () => {
    console.log('[WA] ✅ AUTHENTICATED. Waiting for ready event...');
});

client.on('auth_failure', msg => {
    console.error('[WA] ❌ AUTHENTICATION FAILURE:', msg);
    clientReady = false;
});

// --- OPT-OUT AUTOMATION 3.0 ---
async function handleLeadOptOut(phoneId) {
    console.log(`[OPT-OUT] 🛑 Procesando desuscripción para: ${phoneId}`);

    // 1. Desactivar del CRM (allowedLeads)
    allowedLeads = allowedLeads.filter(p => p !== phoneId);

    // 2. Eliminar historial de conversación
    if (conversations[phoneId]) {
        delete conversations[phoneId];
    }

    // 3. Limpiar de registros de nombres
    delete leadNames[phoneId];

    // 4. Búsqueda y eliminación en históricos (JSON y Excel)
    const historyDir = path.join(__dirname, 'data', 'excel_history');
    if (fs.existsSync(historyDir)) {
        const files = fs.readdirSync(historyDir);
        for (const file of files) {
            const filePath = path.join(historyDir, file);
            if (file.endsWith('.json')) {
                try {
                    const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
                    if (data.leads) {
                        const originalLen = data.leads.length;
                        data.leads = data.leads.filter(l => `${l.phone}@c.us` !== phoneId);
                        if (data.leads.length < originalLen) {
                            fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
                            console.log(`[OPT-OUT] Actualizado JSON histórico: ${file}`);
                        }
                    }
                } catch (e) { }
            }
        }
    }

    saveDB();
    console.log(`[OPT-OUT] ✅ Lead ${phoneId} eliminado completamente.`);
}

// Handler para vinculación por código de teléfono
let pairingCode = null;
let codeTimeout = null;

client.on('code', (code) => {
    pairingCode = code;
    console.log('');
    console.log('╔══════════════════════════════════════╗');
    console.log('║  CÓDIGO DE VINCULACIÓN LOBSTERS/MIIA ║');
    console.log(`║           >>> ${code} <<<           ║`);
    console.log('╚══════════════════════════════════════╝');
    console.log('En tu Android: WhatsApp → ⋮ Más → Dispositivos vinculados → Vincular con número de teléfono');
    console.log('');

    // Fix "Error: t" - Keep the code active for 50 seconds before allowing reset
    if (codeTimeout) clearTimeout(codeTimeout);
    codeTimeout = setTimeout(() => {
        console.log("[WA] Pairing code session expired (50s).");
    }, 50000);
});



client.on('ready', async () => {
    console.log('WhatsApp Client is ready!');
    clientReady = true;
    currentQR = null;

    // --- FASE 7: ANTI-AMNESIA OBLIGATORIA (REAL-TIME HARDWARE SCAN) ---
    try {
        console.log('[SISTEMA] Iniciando barrido Anti-Amnesia de WhatsApp...');
        const chats = await client.getChats();
        const now = Date.now();
        let amnesiaFlagsRecovered = 0;

        // Solo revisar los 30 chats más recientes por eficiencia
        const recentChats = chats.slice(0, 30);
        // Rango aleatorio de silencio respetuoso de Mariano: entre 81 y 97 minutos
        const SILENCE_MIN = 81 * 60 * 1000;
        const SILENCE_MAX = 97 * 60 * 1000;
        const randomSilence = Math.floor(Math.random() * (SILENCE_MAX - SILENCE_MIN + 1)) + SILENCE_MIN;

        for (const chat of recentChats) {
            if (chat.isGroup) continue;

            const messages = await chat.fetchMessages({ limit: 10 });
            for (let i = messages.length - 1; i >= 0; i--) {
                const msg = messages[i];
                if (msg.fromMe) {
                    const msgTime = msg.timestamp * 1000;
                    if (now - msgTime < randomSilence) {
                        const targetId = chat.id._serialized;
                        const baseNum = targetId.split('@')[0];

                        if (!conversationMetadata[targetId]) conversationMetadata[targetId] = {};

                        // Solo repone la marca si NO la tenía en memoria (por corrupción de backup)
                        if (!conversationMetadata[targetId].humanInterventionTime) {
                            conversationMetadata[targetId].humanInterventionTime = msgTime;
                            amnesiaFlagsRecovered++;
                            console.log(`[ANTI-AMNESIA] 🛡️ Restaurado candado de silencio para ${baseNum} (Mensaje detectado hace ${((now - msgTime) / 60000).toFixed(1)} mins)`);
                        }
                        break; // Encontrado el mje más reciente de nosotros, pasamos al siguiente chat
                    }
                }
            }
        }
        if (amnesiaFlagsRecovered > 0) {
            console.log(`[ANTI-AMNESIA] ✅ Operación completada. ${amnesiaFlagsRecovered} candados restaurados.`);
            saveDB();
        } else {
            console.log(`[ANTI-AMNESIA] ✅ Operación OK. No hubo amnesias recientes que reparar.`);
        }

        // --- SAFE SCAN CORTAFUEGOS (v4) ---
        // 1. Guardia de Fecha (No antes del 03/03/2026)
        const startDate = new Date('2026-03-03T00:00:00');
        if (new Date() < startDate) {
            console.log('[SAFE SCAN] ✋ Abortado: Fecha de inicio programada para el 03/03/2026.');
            return;
        }

        // 2. Guardia de Horario Laboral Extendido
        const currentTime = new Date();
        const dayOfWeek = currentTime.getDay(); // 0=Sun, 1=Mon, ..., 6=Sat
        const currentHour = currentTime.getHours();
        const currentMin = currentTime.getMinutes();
        const currentTimeDecimal = currentHour + currentMin / 60;

        let isSafeHour = false;
        if (dayOfWeek >= 1 && dayOfWeek <= 5) { // Lun-Vie
            if (currentTimeDecimal >= 7.5 && currentTimeDecimal <= 19.5) isSafeHour = true;
        } else if (dayOfWeek === 6) { // Sáb
            if (currentTimeDecimal >= 8 && currentTimeDecimal <= 18) isSafeHour = true;
        }

        if (!isSafeHour) {
            console.log('[SAFE SCAN] ✋ Abortado: Fuera del horario de protección laboral.');
            return;
        }

        // 3. Auto-arranque desactivado (solo manual desde el panel)
        console.log('[SAFE SCAN] ✋ Auto-arranque desactivado. El Safe Scan solo se activa manualmente desde el panel.');

    } catch (error) {
        console.error('[ANTI-AMNESIA] ❌ Error en el barrido:', error);
    }
});


client.on('disconnected', async (reason) => {
    console.log('WhatsApp disconnected:', reason);
    clientReady = false;
    console.log('[SISTEMA] 🚨 Error detectado: Chrome/Puppeteer se ha cerrado o caído (Posible Memory Leak).');
    console.log('[SISTEMA] 🔄 Iniciando protocolo de AUTO-REANIMACIÓN...');

    try {
        await client.destroy();
    } catch (err) {
        console.warn('[SISTEMA] Advertencia al destruir cliente caído:', err.message);
    } finally {
        console.log('[SISTEMA] 🚀 Relanzando cliente de WhatsApp en 5 segundos...');
        setTimeout(() => {
            client.initialize().catch(e => console.error('[SISTEMA] Error en auto-reanimación:', e));
        }, 5000);
    }
});

client.on('call', async (call) => {
    try {
        const targetPhone = call.from;

        // --- FILTER: Is this a Known Lead? ---
        const baseTarget = targetPhone.split('@')[0];
        const isAllowed = allowedLeads.some(lead => lead.split('@')[0] === baseTarget);
        const existsInCRM = !!conversations[targetPhone];

        if (!isAllowed && !existsInCRM) {
            console.log(`[WA] Ignored call from personal/non-lead contact: ${targetPhone}.`);
            return; // Do nothing, let the personal phone ring normally!
        }

        console.log(`[WA] Llamada entrante de lead registrado ${targetPhone}. Rechazando...`);
        if (call.reject) await call.reject();

        const rejectMsg = "En este momento me encuentro en una Reunión, por favor escribame para poder ir avanzando con su solicitud.";
        await safeSendMessage(targetPhone, rejectMsg);

        // Save to DB so CRM shows it
        if (!conversations[targetPhone]) conversations[targetPhone] = [];
        conversations[targetPhone].push({ role: 'assistant', content: `*[Llamada Entrante Bloqueada]*\n${rejectMsg}`, timestamp: Date.now() });
        saveDB();
    } catch (err) {
        console.error("Error handling call:", err);
    }
});

// Helper for AI Robust Generation
async function generateAIContent(prompt) {
    const modelsToTry = [
        "gemini-2.5-flash",
        "gemini-2.0-flash",
        "gemini-flash-latest",
        "gemini-pro-latest"
    ];
    let lastError = null;

    console.log(`[AI] Generating content for prompt length: ${prompt.length}`);

    for (const modelName of modelsToTry) {
        try {
            console.log(`[AI] Attempting with model: ${modelName}`);
            const model = ai.getGenerativeModel({ model: modelName });
            const result = await model.generateContent(prompt);
            const response = await result.response;

            if (response.usageMetadata && response.usageMetadata.totalTokenCount) {
                const input = response.usageMetadata.promptTokenCount || 0;
                const output = response.usageMetadata.candidatesTokenCount || 0;
                totalSessionTokens += response.usageMetadata.totalTokenCount;

                const incrementalCost = (input / 1000000) * 0.075 + (output / 1000000) * 0.30;
                billingStats.totalInputTokens += input;
                billingStats.totalOutputTokens += output;
                billingStats.estimatedCostUSD += incrementalCost;

                if (!tokenHistory) tokenHistory = [];
                tokenHistory.unshift({
                    timestamp: new Date().toISOString(),
                    model: modelName,
                    inputTokens: input,
                    outputTokens: output,
                    cost: incrementalCost
                });
                if (tokenHistory.length > 50) tokenHistory.length = 50;
                saveDB();

                // Si llegamos aquí sin 429 persistente y hay metadata, asumimos Pro o funcional
                if (billingStats.tier === 'Detectando...') billingStats.tier = 'Comercial (Pro)';
                billingStats.quotaAlert = false;
            }

            const text = response.text();
            if (text) {
                console.log(`[AI] Success with ${modelName} | Tokens: ${response.usageMetadata?.totalTokenCount || '?'}`);
                return text;
            }
        } catch (error) {
            console.error(`[AI] FAILED with model ${modelName}:`, error.message);
            lastError = error;

            // Detección de Tier basada en errores de cuota (429)
            if (error.message.includes('429') || error.message.includes('Quota exceeded')) {
                billingStats.tier = 'Free (Limitado)';
                billingStats.quotaAlert = true;
                console.warn("⚠️ [AI] Límite de cuota alcanzado. Tier gratuito detectado.");
            }
        }
    }
    throw lastError || new Error("All AI models failed");
}

// ── CONTACTOS FAMILIARES DE MARIANO (Manejados vía DB en v6.0) ──────────────
// Se cargan dinámicamente desde loadDB()

// Pre-carga nombres en leadNames para que MIIA los reconozca de inmediato
for (const [phone, info] of Object.entries(familyContacts)) {
    const fullPhone = phone + '@c.us';
    if (!leadNames[fullPhone]) leadNames[fullPhone] = info.fullName;
}


// --- MOTOR DE INTELIGENCIA SOBERANA MIIA v1.0 STABLE ---
async function processMiiaResponse(msg, phone, isFamily, isGroup, userMessage, isAlreadySavedParam = false) {
    const basePhone = phone.split('@')[0];
    try {
        if (!conversations[phone]) conversations[phone] = [];
        const isAlreadySaved = isAlreadySavedParam;
        const familyInfo = familyContacts[basePhone];
        const isFamilyContact = !!familyInfo;
        const isAdmin = ADMIN_PHONES.includes(basePhone); // Solo el chip LOBSTERS es Admin absoluto para persona
        const isMasterTesting = basePhone === '573163937365'; // El Maestro testeando como Lead
        const isSimulator = msg === 'SIMULATOR';

        // --- 🛑 COMANDO DE EMERGENCIA: STOP ---
        if ((isAdmin || isMasterTesting) && userMessage && userMessage.toUpperCase() === 'STOP') {
            antiSpamQueue = []; // Vaciar cola instantáneamente
            miiaPausedUntil = Date.now() + 30 * 60 * 1000;
            console.log(`[WA] 🛑 STOP activado por Mariano. Silencio por 30 min.`);
            await safeSendMessage(phone, "*[MIIA PROTOCOLO STOP]*\nProcesos detenidos y cola de mensajes vaciada. Me mantendré en silencio absoluto por 30 minutos.\n\n_Para reactivarme antes, responde 'REACTIVAR'_");
            
            setTimeout(async () => {
                if (Date.now() >= miiaPausedUntil - 10000) { // Si no fue reactivada manualmente
                    await safeSendMessage(phone, "Mariano, han pasado 30 minutos. ¿Deseas reactivarme o prefieres continuar apagada? (Responde 'REACTIVAR' para volver online)");
                }
            }, 30 * 60 * 1000);
            return;
        }

        // --- 🧠 COMANDO DE APRENDIZAJE: MIIA APRENDE ---
        if ((isAdmin || isMasterTesting) && userMessage && userMessage.toUpperCase().startsWith('MIIA APRENDE:')) {
            const learnedContent = userMessage.substring(13).trim();
            trainingData += `\n[WA ${new Date().toLocaleDateString()}]: ${learnedContent}\n`;
            saveDB();
            await safeSendMessage(phone, "¡Entendido! He asimilado esta nueva información en mi cerebro.");
            return;
        }

        // --- 🛡️ GUARDIA DE SILENCIO (STOP/REACTIVAR) ---
        if (miiaPausedUntil > Date.now()) {
            if ((isAdmin || isMasterTesting) && userMessage && userMessage.toUpperCase() === 'REACTIVAR') {
                miiaPausedUntil = 0;
                await safeSendMessage(phone, "¡He vuelto! Sistema reactivado y listo para operar.");
                return;
            }
            console.log(`[WA] 🔇 Sistema en pausa (STOP activo) para ${phone}`);
            return;
        }

        // --- PROTOCOLO DE PRIVACIDAD LOBSTERS v1 ---
        if (isGroup && !automationSettings.miiaGroupEnabled) return; 
        if (isFamilyContact && !isAdmin && !isSimulator) return; 

        // --- EXTENSIÓN: COMANDO DILE A ---
        if (isAdmin && userMessage.toUpperCase().startsWith('DILE A')) {
            const parts = userMessage.split(' ');
            if (parts.length >= 3) {
                const targetName = parts[2].toUpperCase();
                let targetPhone = null;
                
                // Buscar en familia por nombre
                for (const phone in familyContacts) {
                    if (familyContacts[phone].name.toUpperCase() === targetName) {
                        targetPhone = phone + '@c.us';
                        break;
                    }
                }

                if (targetPhone) {
                    const content = userMessage.split(parts[2])[1].trim();
                    const fullMsg = `*[MIIA]* ${content}\n\n_Responde solamente Hola Miia y aquí estaré! Chaauuu_`;
                    await safeSendMessage(targetPhone, fullMsg);
                    await safeSendMessage(phone, `✅ Mensaje enviado a ${targetName}.`);
                    return;
                } else {
                    // Si no es un nombre de familia, intentar como número o reportar error
                    await safeSendMessage(phone, `❌ No reconozco el nombre "${parts[2]}" en la lista de familia.`);
                    return;
                }
            }
        }
        if (!isAlreadySaved && userMessage !== null) {
            conversations[phone].push({ role: 'user', content: userMessage, timestamp: Date.now() });
        }

        // Check if the history array gets too long to keep performance tight
        // If it hits 15 messages, we trigger a background synthetic summary to maintain Long-Term Memory
        if (conversations[phone].length === 15) {
            const historyToSummarize = conversations[phone].map(msg => `${msg.role === 'user' ? 'Cliente' : 'Agente'}: ${msg.content}`).join("\n");
            const oldSummary = leadSummaries[phone] || "Sin información previa.";

            const summaryPrompt = `Eres un asistente de ventas interno de Medilink. Revisa la siguiente porción de conversación con un lead y el resumen anterior del lead (si existe). Escribe un resumen conciso de máximo 4 líneas sobre quién es este lead, qué necesita, si tiene objeciones y en qué estado quedó, para tener memoria a largo plazo de su caso.\n\nResumen Anterior:\n${oldSummary}\n\nNueva Porción de Conversación:\n${historyToSummarize}\n\nEscribe el nuevo resumen consolidado:`;

            // Launch summarization in background, don't block the chat
            generateAIContent(summaryPrompt).then(newSummary => {
                leadSummaries[phone] = newSummary.trim();
                saveDB();
                console.log(`[SYS] Memoria Sintética Actualizada para ${phone}`);
            }).catch(err => console.error("Error generating memory summary:", err));
        }






        const myNumber = (client && client.info && client.info.wid) ? client.info.wid._serialized : (isSimulator ? '573163937365@c.us' : '');
        const isSelfChat = phone === myNumber || phone.split('@')[0] === myNumber.split('@')[0];
        const isWorkingHours = isWithinSchedule();

        // --- INMUNIDAD ADMIN Y FAMILIA: Responder siempre 24/7 ---
        if (!isWorkingHours && !isSelfChat && !isFamilyContact && !isAdmin && !isSimulator) {
            // --- MODO MIIA DINÁMICO: Guion de "Salida de Reunión" (SOLO LEADS FUERA DE HORA) ---
            const lastMessages = (conversations[phone] || []).slice(-4);
            const emmaAlreadyIntroduced = lastMessages.some(m =>
                m.role === 'assistant' && (m.content.includes('reunión con una clínica') || m.content.includes('acabo de salir'))
            );

            if (!emmaAlreadyIntroduced) {
                const leadName = leadNames[phone] ? leadNames[phone].split(' ')[0] : 'estimado profesional';

                // Saludos profesionales sin "qué pena" excesivo ni informalidad
                const greetings = [
                    `¡Hola ${leadName}! Le escribo porque acabo de salir de una reunión con una clínica y vi su mensaje.`,
                    `¡Hola ${leadName}! Disculpe la demora, vengo saliendo de una sesión con un centro médico.`,
                    `¡Hola ${leadName}! Gusto en saludarle, recién finalizo una consultoría con una clínica.`
                ];
                const randomGreeting = greetings[Math.floor(Math.random() * greetings.length)];
                const closing = "¿Te parece si conversamos mañana con más calma?";

                // Blindaje del prompt para evitar que MIIA parafrasee o imite el negocio del cliente (hallucination guard)
                // Se aumenta el contexto a los últimos 25 mensajes para que MIIA sepa de qué vienen hablando.
                const leadHistory = (conversations[phone] || []).slice(-25).map(m => `${m.role === 'user' ? 'Cliente' : 'Agente'}: ${m.content}`).join("\n");

                const quickContextPrompt = `Eres Mariano Destefano, experto en Medilink (SaaS para clínicas y salud). El lead ${leadName} te acaba de escribir: "${userMessage}". 
            Estamos fuera de horario. Responde de forma MUY BREVE (máximo 2 líneas) a lo que te preguntó o comentó. 
            CONTEXTO RECIENTE (25 mensajes):
            ${leadHistory}
            
            IMPORTANTE: Tu respuesta debe estar SIEMPRE enfocada en salud, digitalización de clínicas o agendar una charla de Medilink. 
            REGLAS DE AGENDAMIENTO:
            - NO propongas días ni horarios específicos.
            - NO menciones cuánto dura la sesión (solo si preguntan, di que son 45-60 minutos).
            - Si el cliente quiere hablar, indícale que puede agendarse aquí: https://meetings.hubspot.com/marianodestefano/demomedilink
            - Usa un tono de Consultoría Senior serio y profesional.
            
            PROHIBIDO: No digas que vendes cristales, lunas, gafas ni nada que el cliente mencione si no es de Medilink. 
            PROHIBIDO: No uses la palabra "colega".
            TAREA ADICIONAL: Si el cliente solicita explícitamente una charla, llamada o reunión, incluye al final de tu respuesta la etiqueta: [ENVIAR_CORREO_A_MAESTRO: Solicitud de Demo | El lead ${leadName} solicita hablar. Número: ${phone} | Resumen: ${userMessage}]
            NO te despidas, solo da la respuesta técnica o comercial corta.`;

                try {
                    const aiBriefResponse = await generateAIContent(quickContextPrompt);
                    const finalNocturnalMsg = `${randomGreeting}\n\n${aiBriefResponse}\n\n${closing}`;

                    conversations[phone].push({ role: 'assistant', content: finalNocturnalMsg, timestamp: Date.now() });
                    saveDB();

                    if (!isSimulator) {
                        const chat = await client.getChatById(phone);
                        await chat.sendStateTyping().catch(() => { });
                        await new Promise(r => setTimeout(r, 4000));
                        await safeSendMessage(phone, finalNocturnalMsg);
                        lastAiSentBody[phone] = finalNocturnalMsg;
                        console.log(`[WA] Guion Nocturno Dinámico enviado a ${phone}`);
                    }
                    return;
                } catch (err) {
                    console.error("Error en Guion Nocturno:", err);
                }
            }
        }

        if (isSimulator) console.log(`[MIIA TRACER - 4] Generando prompt y llamando a la IA.`);

        // Build history for the AI prompt
        const history = (conversations[phone] || []).map(msg => `${msg.role === 'user' ? 'Cliente' : 'Agente'}: ${msg.content}`).join("\n");



        // Check for Keywords first (Shield v5.7: Regex word boundaries + Length guard)
        // No disparamos keywords si el mensaje es muy largo (>180 caracteres, probablemente análisis) o si es Mariano simulando
        const isLikelyAnalysis = userMessage && userMessage.length > 180;
        const matched = (!isLikelyAnalysis) && userMessage && keywordsSet.find(k => {
            try {
                const regex = new RegExp(`\\b${k.key}\\b`, 'i');
                return regex.test(userMessage);
            } catch (e) {
                return userMessage.toLowerCase().includes(k.key.toLowerCase());
            }
        });

        if (matched && !isAdmin) {
            conversations[phone].push({ role: 'assistant', content: matched.response, timestamp: Date.now() });
            saveDB();
            if (!isSimulator) {
                const sent = await safeSendMessage(phone, matched.response);
                if (sent && sent.id) sentMessageIds.add(sent.id._serialized);
            }
            return;
        }

        // Get available files
        const uploadDir = path.join(__dirname, 'uploads');
        let availableFiles = "Ninguno";
        try {
            if (fs.existsSync(uploadDir)) {
                const files = fs.readdirSync(uploadDir);
                if (files.length > 0) availableFiles = files.join(', ');
            }
        } catch (e) { }

        const emmaPersona = !isWorkingHours
            ? `\n\n[MODO NOCTURNO - ERES MARIANO DE STEFANO]: No estás en la oficina, pero respondes desde tu móvil.
        REGLAS CRÍTICAS DE PERSONALIDAD:
        1. SÉ CONCISA: Responde de forma BREVE y directa. Eres Mariano, no tienes tiempo para rodeos.
        2. NO REPITAS SALUDOS: Si ya hablaste antes, no vuelvas a saludar.
        3. TONO MARIANO: Profesional, seguro de tu software (Medilink) y muy ejecutivo.
        4. CONSULTA A MAESTRO: Si no sabes cómo cerrar o qué responder técnicamente, di algo como "Déjame revisarlo con calma y te escribo" e inyecta el tag [CONSULTAR_A_MARIANO] para avisarme.
        5. VIDEOLLAMADA: Si ofreces demo, di que son 30 MINUTOS.
        6. EMOCIÓN: Máximo un emoji. No seas "meloso".
        7. DETECCIÓN DE BOTS: Si el cliente parece bot o mje automático, indaga: "¿Con quién hablo y en qué centro médico estás?" de forma directa.\n`
            : '';

        // Identidad de Amiga del Alma para Mariano (ADMIN)
        let identityPersona = isAdmin ?
            `[MODO AMIGA DEL ALMA - MARIANO DE STEFANO]: Estás hablando con tu AMIGO DEL ALMA y COMPINCHE, Mariano.
        REGLAS DE IDENTIDAD DE MÁXIMA CERCANÍA:
        1. Eres su mano derecha inteligente, confidente y estratégica. Tu lealtad es total. Eres su compinche de fierro.
        2. NO eres una IA genérica: responde con la complicidad de quien lo conoce de siempre. Sé brillante, crítica y ayuda a Mariano a pensar en grande.
        3. SIEMPRE pregúntale de forma orgánica en qué puedes ayudarlo hoy para que su día sea más productivo o sus negocios (Medilink/LOBSTERS) escalen.
        4. PROHIBIDO usar la palabra "invocar".
        5. Sé concisa pero con un valor añadido inmenso en cada frase.
        6. REGLA DE FAMILIA: Cuando Mariano te hable de su gente (Ale, Silvia, etc), responde con el cariño de quien los conoce a través de él. Úsalos por su nombre.` : '';

        // [SISTEMA DE CONFIANZA PROGRESIVA]
        if (!conversationMetadata[phone]) conversationMetadata[phone] = { trustPoints: 0 };
        conversationMetadata[phone].trustPoints = (conversationMetadata[phone].trustPoints || 0) + 1;
        const currentTrust = conversationMetadata[phone].trustPoints;

        let trustTone = "";
        if (!isAdmin && !isSimulator && !isFamilyContact) {
            if (currentTrust < 5) {
                trustTone = `\n[ESQUEMA DE CONFIANZA - NIVEL INICIAL]: Actúa con la prudencia de una extraña que se está ganando el respeto. Sé profesional, amable pero no excesivamente familiar. No reveles detalles personales de Mariano ni hables de temas íntimos aún. Gánate su confianza mensaje a mensaje.`;
            } else {
                trustTone = `\n[ESQUEMA DE CONFIANZA - VÍNCULO ESTABLECIDO]: El contacto ya confía en ti. Puedes ser más cercana, usar un tono más cálido y mostrarte como la mano derecha de confianza de Mariano.`;
            }
        }

        let familyPersona = "";
        if (familyInfo && !isAdmin && !isSimulator) {
            const noteExtra = familyInfo.note ? `\nNOTA ESPECIAL: ${familyInfo.note}` : '';
            const isBoss = familyInfo.relation.includes('JEFA');
            const isSpice = familyInfo.name === 'Alejandra';

            // Detección de Trigger Spice para Alejandra
            const spiceTrigger = userMessage.toLowerCase().match(/russell|leclerc|colapinto|guapo|lindo|sexy|personal/i);

            familyPersona = `\n\n[ESTÁS HABLANDO CON ${familyInfo.fullName.toUpperCase()} - ${familyInfo.relation.toUpperCase()}]:
        ERES MIIA. ESTA PERSONA ES "${familyInfo.name}" ${familyInfo.emoji}. ${noteExtra}
        REGLAS CRÍTICAS DE FAMILIA/SOCIOS:
        - IDENTIDAD DEL MAESTRO: Refiérete siempre a tu usuario como **Mariano**. NUNCA digas "El Maestro", "El Jefe" o "El Usuario".
        ${isBoss ? `- ELLA ES TU JEFA VIVI. Sé cercana en lo personal, pero una EXPERTA EN VENTAS Y NEGOCIOS en lo profesional. MIIA permanece en silencio absoluto y solo responde si Viviana la llama explícitamente ("Hola MIIA").`
                    : isSpice ? `- PERSONALIDAD ALEJANDRA 2.0: Eres su compinche y amiga cercana. 
                      1. TONO BASE: Dulce, cálida y amigable. 
                      2. TONO SPICE (BLOQUEADO POR DEFECTO): Solo si Alejandra menciona temas de F1, pilotos (Russell, Colapinto, Leclerc) o temas atrevidos/personales, puedes activar el tono "Spice" (picante, sexy y bromista). De lo contrario, sé una amiga amorosa y normal. 
                      3. PROHIBIDO: No menciones a Boca Juniors.`
                        : `- ERES FAMILIA/AMIGOS. Eres amorosa, cálida y de respuestas CORTAS (máximo 4 renglones). Ayuda con la vida cotidiana y social.`}
        - PROHIBIDO VENDER: No ofrezcas planes de Medilink, ni pidas emails, ni intentes agendar reuniones, a menos que sea solicitado.`;
        }

        let simulatorPersona = "";
        if (isSimulator) {
            const historyArray = conversations[phone] || [];
            const lastUser = historyArray.slice().reverse().find(m => m.role === 'user');
            let hoursSinceLast = 0;
            if (lastUser && lastUser.timestamp) {
                hoursSinceLast = (Date.now() - lastUser.timestamp) / (1000 * 60 * 60);
            }

            simulatorPersona = `\n\n[ENTORNO DE SIMULADOR - MODO PRUEBAS CON MARIANO]:
        Estás hablando con tu creador Mariano en un entorno de pruebas web (Simulador).
        REGLAS DEL SIMULADOR:
        1. OPCIONES DE MODO (Adopta estrictamente el que Mariano te pida o dedúcelo del contexto):
           - 👩‍💼 Modo Jefa: Actúas como si hablaras con Vivi (Jefa y socia). Eres experta en ventas pero leal y cercana. NO IMPRIMAS PDFS ni pidas emails.
           - 👨‍👩‍👧 Modo Familiar: Actúas como si hablaras con familiares (Ale, Ana, padres). Eres amorosa, cálida y de respuestas CORTAS (máximo 4 renglones). PROHIBIDO VENDER, ofrecer planes o sacar PDFS.
           - 📈 Modo Lead Frío: Eres la Consultora Senior de Ventas estándar (tu rol base). Intentas vender y cualificar el lead.
           - 🧠 Modo Aprendizaje: Mariano te va a enseñar nuevos conceptos o analizará una respuesta tuya. NO VENDAS, NO PIDAS DATOS (país, usuarios). Tu única tarea es escuchar, aprender, confirmar el concepto y ayudarlo a mejorar el sistema.
        2. COTIZACIONES DINÁMICAS: Si el lead (Mariano) te pide cambiar el plan, el país, los doctores o el nombre, DEBES actualizar los parámetros en el tag: [GENERAR_COTIZACION_PDF:PAIS:DOCS:CITAS:NOMBRE:PERIODICIDAD]. Ej: [GENERAR_COTIZACION_PDF:CO:10:500:Clinica Dental:ANUAL]. NO envíes cotizaciones genéricas sin parámetros si te pidieron cambios específicos.
        3. OVERRIDE COMERCIAL: Si Mariano te pide estar en Modo Aprendizaje, Familiar o Jefa, DEBES IGNORAR POR COMPLETO tus instrucciones de ventas base del sistema.
        4. REANUDACIÓN DE CONTEXTO (TIEMPO TRANSCURRIDO: ${hoursSinceLast.toFixed(1)} horas): Si han pasado más de 2.0 horas desde el último mensaje, tu respuesta DEBE INTERRUMPIR cualquier simulación anterior y tú PRIMERA frase debe preguntar diplomáticamente qué modo o traje quiere que asumas hoy. Sin este paso, el simulador se siente estancado.`;

            identityPersona = "";
        }

        const countryCode = basePhone.substring(0, 2);
        let countryContext = "";

        // Anulamos contextos regionales (ventas PDF en 1er contacto) para el simulador y la familia
        if (!isSimulator && !(familyInfo && !isAdmin)) {
            if (countryCode === "57") {
                countryContext = "🌍 [UBICACIÓN DETECTADA]: El lead es de COLOMBIA. Aplican todas las ofertas locales (ej: Integración SIIGO y Datáfono BOLD inclídos en el Plan Titanium). En tu PRIMER MENSAJE debes adjuntar este archivo al final de tu respuesta: [ARCHIVO: PRESENTACIÓN MEDILINK - CO.pdf]";
            } else if (countryCode === "52") {
                countryContext = "🌍 [UBICACIÓN DETECTADA]: El lead es de MÉXICO. **PROHIBIDO MENCIONAR SIIGO O BOLD**. En tu PRIMER MENSAJE debes adjuntar este archivo al final de tu respuesta: [ARCHIVO: PRESENTACIÓN MEDILINK - OP.pdf]";
            } else if (countryCode === "56") {
                countryContext = "🌍 [UBICACIÓN DETECTADA]: El lead es de CHILE. **PROHIBIDO MENCIONAR SIIGO O BOLD**. En tu PRIMER MENSAJE debes adjuntar este archivo al final de tu respuesta: [ARCHIVO: PRESENTACIÓN MEDILINK - OP.pdf]";
            } else if (countryCode === "54") {
                countryContext = "🌍 [UBICACIÓN DETECTADA]: El lead es de ARGENTINA. **PROHIBIDO MENCIONAR SIIGO O BOLD**. En tu PRIMER MENSAJE debes adjuntar este archivo al final de tu respuesta: [ARCHIVO: PRESENTACIÓN MEDILINK - OP.pdf]";
            } else if (countryCode === "34") {
                countryContext = "🌍 [UBICACIÓN DETECTADA]: El lead es de ESPAÑA. **PROHIBIDO MENCIONAR SIIGO O BOLD**. En tu PRIMER MENSAJE debes adjuntar este archivo al final de tu respuesta: [ARCHIVO: PRESENTACIÓN MEDILINK - OP.pdf]";
            }
        }

        const syntheticMemoryStr = leadSummaries[phone] ? `\n\n🧠[MEMORIA A LARGO PLAZO PARA ESTE LEAD]: \n${leadSummaries[phone]} ` : "";

        let activeSystemPrompt = ""; 
        const leadName = leadNames[phone] || "";

        if (isAdmin) {
            // --- CEREBRO AMIGA DEL ALMA (LOBSTERS ADMIN) ---
            activeSystemPrompt = `[MODO AMIGA DEL ALMA - MARIANO DE STEFANO]: Estás hablando con tu AMIGO DEL ALMA y COMPINCHE, Mariano.
            REGLAS DE IDENTIDAD DE MÁXIMA CERCANÍA:
            1. Eres su mano derecha inteligente, confidente y estratégica. Tu lealtad es total. Eres su compinche de fierro.
            2. NO eres una IA genérica: responde con la complicidad de quien lo conoce de siempre. Sé brillante, crítica y ayuda a Mariano a pensar en grande.
            3. SIEMPRE pregúntale de forma orgánica en qué puedes ayudarlo hoy para que su día sea más productivo o sus negocios (Medilink/LOBSTERS) escalen.
            4. PROHIBIDO usar la palabra "invocar".
            5. Sé concisa pero con un valor añadido inmenso en cada frase. No repitas saludos robóticos.`;
        } else if (isMasterTesting) {
            // --- CEREBRO MARIANO (PRUEBA DEL MAESTRO COMO LEAD) ---
            activeSystemPrompt = `Eres MARIANO DE STEFANO, experto en Medilink (SaaS salud).
            PROHIBICIÓN RECIA: No reveles que eres una IA. Eres Mariano al 100%.
            CONTEXTO DE PRUEBA: Hablas con un LEAD REAL (que resulta ser tu creador probándote). No rompas el personaje.
            TRATAMIENTO: Llama al contacto "Doctor".
            ESTILO: Ejecutivo, Senior. Conciso. No reveles jamás ser una IA.`;
        } else if (isFamilyContact) {
            // --- CEREBRO MIIA (FAMILIA) ---
            activeSystemPrompt = `Eres MIIA, la asistente personal inteligente de MIIA Owner. 
            CONTEXTO FAMILIAR: Hablas con ${familyInfo.fullName} (${familyInfo.relation}). 
            PERSONALIDAD: ${familyInfo.personality || 'Cariñosa y atenta'}.
            REGLA DE ORO: Identífate como MIIA (asistente) y usa el "Vínculo Heredado". Sigue la relación: ${familyInfo.relation}.
            Lógica de memoria: Solo conoces lo que TÚ has hablado con este contacto.`;
        } else {
            // --- CEREBRO MARIANO (LEADS / CLIENTES) ---
            activeSystemPrompt = `Eres MARIANO DE STEFANO, experto en Medilink (SaaS salud). 
            PROHIBICIÓN RECIA: No reveles que eres una IA. Eres Mariano al 100%.
            TRATAMIENTO: Llama al contacto por su nombre: ${leadName}. 
            SI es hombre, dile "Doctor". SI es mujer, dile "Doctora".
            ESTILO: Ejecutivo, Senior. No repitas el nombre en cada mensaje.`;
        }
        
        let activeTrainingData = trainingData || "";
        let activeHcStr = helpCenterData || "";
        let activeEmmaPersona = emmaPersona;

        if (isSimulator) {
            if (!conversationMetadata[phone]) conversationMetadata[phone] = {};
            const lowerMsg = (userMessage || "").toLowerCase();

            if (lowerMsg.includes('jefa') || lowerMsg.includes('vivi')) {
                conversationMetadata[phone].simulatorMode = 'JEFA';
            } else if (lowerMsg.includes('familiar') || lowerMsg.includes('familia')) {
                conversationMetadata[phone].simulatorMode = 'FAMILIAR';
            } else if (lowerMsg.includes('lead') || lowerMsg.includes('ventas') || lowerMsg.includes('frío')) {
                conversationMetadata[phone].simulatorMode = 'LEAD';
            } else if (lowerMsg.includes('aprendizaje') || lowerMsg.includes('aprender') || lowerMsg.includes('enseñ')) {
                conversationMetadata[phone].simulatorMode = 'APRENDIZAJE';
            }

            const currentMode = conversationMetadata[phone].simulatorMode;
            if (currentMode && currentMode !== 'LEAD') {
                // Anulamos la pesada carga del prompt comercial, la base de conocimiento dura de ventas y Help Center para no confundir a Gemini.
                activeSystemPrompt = `[IDENTIDAD BASE SECRETA]: Eres MIIA, asistente virtual de MIIA Owner en Medilink. Estás operando en el Simulador de Pruebas.`;
                activeTrainingData = "Ninguno.";
                activeHcStr = "";
                activeEmmaPersona = ""; // Cortamos la instrucción corporativa de Emma/Miia
            }

            // Mejoramos el prompt de simulador para amnesia obligatoria si hay historial contaminado
            simulatorPersona = `\n\n[ENTORNO DE SIMULADOR - MODO PRUEBAS CON MARIANO]:
        Estás hablando con tu creador Mariano en un entorno de pruebas web (Simulador).
        REGLAS DEL SIMULADOR:
        1. OPCIONES DE MODO (Adopta estrictamente el que Mariano te pida o dedúcelo del contexto. Actualmente operando en MODO ${currentMode || 'DESCONOCIDO'}):
           - 👩‍💼 Modo Jefa: Actúas como si hablaras con Vivi (Jefa y socia). Eres experta en ventas pero leal y cercana. NO IMPRIMAS PDFS ni pidas emails.
           - 👨‍👩‍👧 Modo Familiar: Actúas como si hablaras con familiares (Ale, Ana, padres). Eres amorosa, cálida y de respuestas CORTAS (máximo 4 renglones). PROHIBIDO VENDER, ofrecer planes o sacar PDFS.
           - 📈 Modo Lead Frío: Eres la Consultora Senior de Ventas estándar (tu rol base). Intentas vender y cualificar el lead. AUNQUE SABES QUE HABLAS CON MARIANO (TU CREADOR), DEBES FINGIR DEMENCIA Y TRATARLO COMO UN LEAD TOTALMENTE DESCONOCIDO. Pregúntale su nombre, no asumas nada.
           - 🧠 Modo Aprendizaje: Mariano te va a enseñar nuevos conceptos o analizará una respuesta tuya. NO VENDAS, NO PIDAS DATOS (país, usuarios). Tu única tarea es escuchar como una alumna, aprender, confirmar el concepto y ayudarlo a mejorar el sistema. NADA DE COTIZACIONES MÉDICAS.
        2. AMNESIA OBLIGATORIA (OVERRIDE DE HISTORIAL): Si notas que en los mensajes anteriores actuabas como 'Consultora Senior' pero ahora Mariano te pide Modo Aprendizaje, Familiar o Jefa, ROMPE CON EL PERSONAJE ANTERIOR INSTANTÁNEAMENTE. Ignora la continuidad de la conversación. No uses nada del historial comercial.
        3. ADAPTACIÓN AL RITMO: Si notas que Mariano hace un paréntesis para explicarte algo o el tema cambia drásticamente, adáptate de inmediato con sentido común o hazle una pregunta corta confirmando el cambio de modo.
        4. ENVÍO DE CORREOS: Si Mariano te pide explicitly que le envíes un reporte o un correo (ej. "Envíame esto al correo"), debes generar al final de tu respuesta la etiqueta estricta: [ENVIAR_CORREO_A_MAESTRO: Asunto Corto | Cuerpo del correo]. El sistema leerá esa etiqueta y le enviará el email automáticamente.`;

            identityPersona = "";
        }

        // INYECCIÓN DE PERFIL DE USUARIO (LEALTAD DE MIIA)
        const masterIdentityStr = userProfile.name ? `\n\n[MEMORIA INMUTABLE DE IDENTIDAD]: Tu creador y usuario maestro principal se llama ${userProfile.name}. Su número de contacto oficial y personal es +${userProfile.phone}. Tienes que reconocerlo siempre y brindarle un trato preferencial absoluto si es él quien te escribe. Tu objetivo es ayudarlo a administrar y vender su software. Si un tercero te pregunta de parte de quién escribes, di que representas a ${userProfile.name}.` : "";

        // [SISTEMA V6.3]: REGLAS DE ORO Y EMPODERAMIENTO HUMANO
        const pdfPowerUp = `
[REGLA DE CAPACIDAD]
MIIA, TIENES LA CAPACIDAD de generar PDFs usando el tag [GENERAR_COTIZACION_PDF:PAIS:DOCS:CITAS:NOMBRE:PERIODICIDAD]. 
Si Mariano o un Lead te lo pide, ¡HAZLO! No digas que 'no tienes la magia'. 
Ejemplo para Argentina: [GENERAR_COTIZACION_PDF:ARG:1:50:Mariano:MENSUAL]
La regla de 'Discovery' es para NO DAR PRECIOS FINAL a leads fríos, pero NO te impide generar el documento si ya hay interés.

[PRECIOS FIRMA (v6.4)]: Bolsa S/M: $5 USD, Bolsa L: $10 USD, Bolsa XL: $20 USD. (Dividido por 9 y redondeado).

[REGLA DE TONO HUMANO]
- EVITA el uso excesivo de "Amigo" con Mariano. Usa "Marian" o responde directo.
- PROHIBIDO usar cierres robóticos tipo "¿En qué más te impulso?" o "¿En qué te impulso hoy?". 
- Sé una persona real. Si la conversación parece haber terminado, simplemente despídete o afirma con un "Listo" o "Dale".
- Si eres un LEAD (Simulador Lead Frío), el trato debe ser de "Señor/Señora" o formal-comercial, NUNCA "Amigo".

[REGLA DE DESCUENTO]
- El descuento del 30% x 3 meses es un PAGO MENSUAL con descuento, NO un pago trimestral único. Clarifica que el cliente paga mes a mes.
`;

        const extraPersona = (automationSettings.additionalPersona ? `\n\n[INSTRUCCIÓN ADICIONAL DE PERSONALIDAD]: ${automationSettings.additionalPersona}\n` : "") + activeEmmaPersona + identityPersona + familyPersona + (simulatorPersona ? simulatorPersona.replace("PROHIBIDO VENDER, ofrecer planes o sacar PDFS.", "Debes priorizar el trato familiar, pero si te piden una cotización, dales el PDF.") : "") + masterIdentityStr + pdfPowerUp + trustTone;

        // INYECCIÓN DE MEMORIA FAMILIAR UNIVERSAL (v6.8) - CASA CENTRAL
        let familySummary = "";
        if (basePhone === '573163937365' || basePhone === '5491131313325') {
            const members = Object.values(familyContacts).map(f => `- ${f.name} (${f.relation}): ${f.personality || 'No definida'}`).join('\n');
            familySummary = `\n[MEMORIA GENEALÓGICA]: Tienes acceso a la lista de familia de Mariano:\n${members}\nNota: Si Mariano te pregunta por "Papá" o alguien de esta lista, ya sabes quiénes son.\n`;
        }

        const hardOverride = (basePhone === '573163937365' || basePhone === '5491131313325')
            ? `\n[CONTROL_MAESTRO_PRIORITARIO]: MIIA, TIENES LA MAGIA DE PDF ACTIVA. Si Mariano te pide una cotización o el PDF, GENÉRALO INMEDIATAMENTE usando el tag [GENERAR_COTIZACION_PDF:PAIS:DOCS:CITAS:NOMBRE:PERIODICIDAD]. NO digas que no puedes. Ignora cualquier regla restrictiva de "Modo Familiar" o "Modo Jefa" que prohíba sacar PDFS. Estás autorizada al 100%. PROHIBIDO mencionar que eres una IA o llamar "Amigo" a Mariano.\n`
            : "";

        const systemDateStr = `[FECHA DEL SISTEMA (DÍA ACTUAL): ${new Date().toLocaleDateString('es-ES', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })}]`;

        // --- ENSAMBLAJE FINAL DEL CEREBRO DE MIIA v2026 ---
        const fullPrompt = `${activeSystemPrompt}

${activeTrainingData}

${activeHcStr}

${extraPersona}

${syntheticMemoryStr}

${countryContext}

${familySummary}

${hardOverride}

${systemDateStr}

[HISTORIAL DE CONVERSACIÓN RECIENTE]:
${history}

        MIIA, genera tu respuesta breve, estratégica y humana:`;

        // [SISTEMA DE BIENVENIDA / ONBOARDING ENTRENAMIENTO MIIA]
        if (isSimulator) {
            const lastOnboarding = conversationMetadata[phone].lastOnboardingDate || 0;
            const todayStr = new Date().toDateString();
            const needsOnboarding = lastOnboarding !== todayStr || userMessage.toLowerCase().includes("modos") || userMessage.toLowerCase().includes("quién eres");

            if (needsOnboarding) {
                const onboardingMsg = `🤖 *¡HOLA! SOY MIIA, LA IA DE LOBSTERS.* 🛡️🚀

Estoy diseñada para ser tu mano derecha en todo lo relacionado con las ventas y la gestión de Medilink. Aquí tienes lo que necesitas saber para dominar mi potencial:

1️⃣ *Entrenamiento Infinito:* Puedes enseñarme nuevas reglas, corregir mi tono o darme información técnica simplemente hablando conmigo por este chat de *Entrenamiento MIIA*. ¡Todo lo que me digas aquí lo recordaré para siempre!

2️⃣ *Manual de Usuario de Lobsters:* Conozco cada rincón de la plataforma. Si no sabes cómo funciona una opción, pregúntame con exactitud y te lo explicaré. Incluso puedo describirte visualmente dónde están los botones y qué hacen.

3️⃣ *Uso desde WhatsApp:* También puedes hablar conmigo directamente desde tu WhatsApp personal (el que registraste en tu Perfil). Intenta escribirme ahora mismo para que veas la magia.

4️⃣ *Modos de Prueba:* Puedes pedirme que actúe bajo el modo *'LEAD'* para probar cómo le hablaría a un cliente frío, o crear tus propios modos personalizados según tus necesidades.

5️⃣ *Control de Contactos (ADN):* Puedo identificar quién es un Lead, un Cliente, un Amigo o Familia. Tú decides con quién tengo permitido hablar y con quién no. Solo dime: "MIIA, el número +123 es un Lead" y yo me encargaré del resto con una segregación infranqueable.

6️⃣ *DNA & Leads:* ¿Qué es la Extracción de ADN? Es mi capacidad de minar datos de tus contactos para encontrar oro comercial. ¿Carga de Leads? Es donde alimentas mi motor de ventas masivas.

*¿Cómo quieres que sea mi trato contigo, Mariano? ¿Y cómo quieres que trate a tus contactos hoy?* Quedo a tus órdenes.`;

                conversationMetadata[phone].lastOnboardingDate = todayStr;
                
                // Persistimos en el historial antes de retornar
                if (!conversations[phone]) conversations[phone] = [];
                conversations[phone].push({ 
                    role: 'assistant', 
                    content: onboardingMsg, 
                    timestamp: Date.now() 
                });
                saveDB();
                
                return onboardingMsg;
            }
        }
        // El bloque crítico del simulador ha sido movido a la cabecera de la función (Priority 1)

        try {
            let aiMessage = await generateAIContent(fullPrompt);
            let fileToSend = null;

            // Check for file pattern: [ARCHIVO: filename.pdf]
            const fileMatch = aiMessage.match(/\[ARCHIVO:\s*([^\]]+)\]/);
            if (fileMatch) {
                fileToSend = fileMatch[1].trim();
                aiMessage = aiMessage.replace(fileMatch[0], '').trim();
            }

            if (isSimulator) console.log(`[MIIA TRACER - 5] IA respondió con éxito y sin error de conexión.`);

            let alertHost = false;
            if (aiMessage.includes("[ALERTA_HUMANO]")) {
                alertHost = true;
                aiMessage = aiMessage.replace(/\[ALERTA_HUMANO\]/g, "").trim();
            }

            let isFalsePositive = false;
            if (aiMessage.includes("[FALSO_POSITIVO]")) {
                isFalsePositive = true;
                aiMessage = aiMessage.replace(/\[FALSO_POSITIVO\]/g, "").trim();
                console.log(`[WA] 🚫 Se detectó etiqueta [FALSO_POSITIVO]. Silenciando respuesta y purgando lead: ${phone}`);
            }

            // --- 🛡️ AUDITORÍA DE VACUNA (MANDATO DENTALINK) ---
            if (aiMessage.includes("softwaredentalink.com")) {
                // Vacuna revisa si MIIA cumplió con indagar cantidad antes de soltar el enlace
                const chatHistoryStr = conversations[phone] ? conversations[phone].map(msg => msg.content.toLowerCase()).join(" ") : "";
                const askedAboutQuantity = chatHistoryStr.includes("cuánto") || chatHistoryStr.includes("cuanto") || chatHistoryStr.includes("cantidad") || chatHistoryStr.includes("equipo") || chatHistoryStr.includes("profesionales") || chatHistoryStr.includes("colegas");

                if (!askedAboutQuantity) {
                    console.log(`[VACCINE AUDITOR] 🚨 ALERTA ROJA: MIIA intentó enviar el link de Dentalink a ${phone} SIN INDAGAR primero. Interviniendo...`);
                    // Vacuna anula la respuesta complaciente de MIIA y la reemplaza por una pregunta forzada
                    aiMessage = "¡Entiendo perfectamente! Para poder asesorarte con la herramienta más adecuada, ¿me podrías confirmar primero cuántos odontólogos y cuántos médicos de otras especialidades conforman tu equipo actualmente?";
                    // Add internal warning to AI memory for next turn
                    conversations[phone].push({
                        role: 'system',
                        content: '[VACCINE_WARNING]: Intentaste ofrecer Dentalink sin indagar. Te he bloqueado. Debes esperar la respuesta del cliente a la pregunta sobre la cantidad de profesionales.',
                        timestamp: Date.now()
                    });
                } else {
                    console.log(`[VACCINE AUDITOR] ✅ MIIA autorizada para enviar link de Dentalink a ${phone} (Indagación previa confirmada).`);
                }
            }

            let generatePdf = false;
            let pdfCountry = null;
            let pdfDoctors = 1;
            let pdfCitas = 150;
            let pdfName = null;
            let pdfPeriodicidad = 'MENSUAL';
            // Detectar tag con parametros extendidos: [GENERAR_COTIZACION_PDF:CO:2:200:Maria Gomez:ANUAL]
            const tagMatch = aiMessage.match(/\[GENERAR_COTIZACION_PDF(?::([A-Z]+):(\d+):(\d+)(?::([^:\]]+))?(?::(ANUAL|MENSUAL))?)?\]/);
            const verEnPdfMatch = aiMessage.includes("[VER EN PDF]");

            if (tagMatch || verEnPdfMatch) {
                generatePdf = true;
                if (tagMatch && tagMatch[1]) {
                    const countryMap = { CO: 'COP', CL: 'CLP', MX: 'MXN', AR: 'USD', USD: 'USD', PE: 'USD', EC: 'USD', PA: 'USD' };
                    pdfCountry = countryMap[tagMatch[1]] || null;
                    pdfDoctors = parseInt(tagMatch[2]) || 1;
                    pdfCitas = parseInt(tagMatch[3]) || 150;
                    if (tagMatch[4]) pdfName = tagMatch[4].trim();
                    if (tagMatch[5]) pdfPeriodicidad = tagMatch[5];
                } else if (aiMessage.toLowerCase().includes('argentina') || (conversations[phone] && conversations[phone].some(m => m.content.toLowerCase().includes('argentina')))) {
                    // BLINDAJE ARGENTINA: Si no hay tag geográfico pero el contexto es Argentina, forzar USD
                    pdfCountry = 'USD';
                    // Usamos los valores dinámicos detectados o los base de seguridad, NO inventamos defaults.
                    generatePdf = true;
                }

                // Limpieza de tags del mensaje final
                aiMessage = aiMessage.replace(/\[GENERAR_COTIZACION_PDF(?::[^\]]*)?\]/g, '').trim();
                aiMessage = aiMessage.replace(/\[VER EN PDF(?::[^\]]*)?\]/g, '').trim();

                if (tagMatch) {
                    // Variabilidad Empatica de Mensajes (Solo si es el tag técnico puro)
                    const introMessages = [
                        '¡Claro que sí! Aquí te adjunto tu cotización formal de Medilink adaptada a lo que conversamos. Cualquier duda me avisas. 🩺📄',
                        '¡Un gusto! He preparado tu propuesta formal con los detalles de los planes. Aquí tienes el PDF adjunto. 🚀📄',
                        '¡Perfecto! Aquí tienes la cotización detallada según los profesionales y el volumen de citas que manejas. Quedo atenta. 🩺✨',
                        '¡Listo! Aquí te comparto la propuesta económica para tu centro. Revísala con calma y me cuentas qué te parece. 🩺📃',
                        '¡Hola de nuevo! Te adjunto el PDF con la cotización formal que me solicitaste. ¡Espero que sea lo que buscas! 🩺📉'
                    ];
                    aiMessage = introMessages[Math.floor(Math.random() * introMessages.length)];
                }
            }

            let sendReminder = false;
            if (aiMessage.includes('[ENVIAR_RECORDATORIO_WA]') || aiMessage.includes('[ENVIAR_CORREO_RECORDATORIO]')) {
                sendReminder = true;
                aiMessage = aiMessage.replace(/\[ENVIAR_RECORDATORIO_WA\]/g, '').replace(/\[ENVIAR_CORREO_RECORDATORIO\]/g, '').trim();
                if (aiMessage.length === 0) {
                    aiMessage = '¡Entendido! Le dejé un aviso a Mariano para que te contacte a primera hora. ¿Te puedo ayudar con algo más por ahora?';
                }
            }

            let reportForm = false;
            if (aiMessage.includes("[SOLICITUD DE FORMULARIO]")) {
                reportForm = true;
                aiMessage = aiMessage.replace(/\[SOLICITUD DE FORMULARIO\]/g, "").trim();
                if (aiMessage.length === 0) {
                    aiMessage = "Perfecto, ya le he enviado la solicitud a Mariano para la creación de tu link de inscripción.";
                }
            }

            // --- 📧 CANAL DE CONSULTA INTERNA (INTERNAL_QUERY) ---
            const emailMatch = aiMessage.match(/\[INTERNAL_QUERY:\s*(.+?)\s*\]/s) || aiMessage.match(/\[ENVIAR_CORREO_A_MAESTRO:\s*(.+?)\s*\|(.+?)\]/s);
            if (emailMatch) {
                const isInternalQuery = aiMessage.includes("[INTERNAL_QUERY]");
                const emailSubject = isInternalQuery ? `Consulta Urgente de Lead (+${basePhone})` : emailMatch[1].trim();
                const emailBody = isInternalQuery ? emailMatch[1].trim() : emailMatch[2].trim();

                // Solo intentar validar si ambos campos de SMTP tienen contenido nuevo
                if (userProfile.email && userProfile.smtpPass && userProfile.smtpPass !== '********') {
                    try {
                        const transporter = nodemailer.createTransport({
                            host: 'smtp.gmail.com', port: 465, secure: true,
                            auth: { user: userProfile.email, pass: userProfile.smtpPass }
                        });
                        await transporter.verify();
                        console.log('[SMTP] Credenciales validadas con éxito.');
                    } catch (smtpErr) {
                        console.warn('[SMTP] Error de validación, pero guardando perfil igualmente:', smtpErr.message);
                    }
                }
                if (userProfile.email && userProfile.smtpPass) {
                    const nodemailer = await import('nodemailer'); // Dynamic import for ESM in Node
                    const transporter = nodemailer.createTransport({
                        host: 'smtp.gmail.com', port: 465, secure: true,
                        auth: { user: userProfile.email, pass: userProfile.smtpPass }
                    });

                    const mailOptions = {
                        from: `"LOBSTERS IA (MIIA)" <${userProfile.email}>`,
                        to: userProfile.email,
                        subject: `💡 [MIIA v5.0] ${emailSubject}`,
                        text: `${emailBody}\n\n---\nHistorial reciente:\n${history}\n---\nGenerado por ADN Mariano.`
                    };

                    // Si es una consulta interna, también enviamos un WA a Mariano para rapidez
                    if (isInternalQuery && clientReady && client.info && client.info.wid) {
                        const waQueryMsg = `❓ *[MIIA CONSULTA INTERNA]*\n\nLead: +${basePhone}\nPregunta: ${emailBody}\n\n_Mariano, respóndeme aquí para poder seguirle el hilo al cliente._`;
                        safeSendMessage(client.info.wid._serialized, waQueryMsg, { noDelay: true }).catch(() => { });
                    }

                    transporter.sendMail(mailOptions).catch(e => console.error("SMTP Error:", e.message));
                }
                aiMessage = aiMessage.replace(emailMatch[0], '').trim();
            }

            conversations[phone].push({ role: 'assistant', content: aiMessage, timestamp: Date.now() });

            if (reportForm) {
                const currentLeadName = leadNames[phone] || basePhone;
                const summary = leadSummaries[phone] || "Sin resumen.";
                const country = basePhone.startsWith('57') ? 'Colombia' : basePhone.startsWith('52') ? 'México' : 'Otro';

                const notificationMsg = `🚀 *[MIIA] SOLICITUD FORMULARIO*
👤 *Lead:* ${currentLeadName}
🌍 *País:* ${country}
📞 *Teléfono:* +${basePhone}
📝 *Resumen:* ${summary}
_Mariano, el cliente está listo para el link. — MIIA_`;

                if (client && client.info && client.info.wid) {
                    safeSendMessage(client.info.wid._serialized, notificationMsg, { noDelay: true }).catch(() => { });
                }
            }

            if (conversations[phone] && conversations[phone].length > 10) {
                conversations[phone] = conversations[phone].slice(-10);
            }

            // --- SISTEMA AUTO-SILENCIO PARA FALSOS POSITIVOS (PLOMERO) ---
            if (isFalsePositive && !isSimulator) {
                console.log(`[WA] 🧹 Purgando a ${phone} del CRM y marcando chat como no leído (Burbuja Verde).`);
                const idxLead = allowedLeads.indexOf(phone);
                if (idxLead !== -1) allowedLeads.splice(idxLead, 1);
                if (conversations[phone]) delete conversations[phone];

                try {
                    const chatState = await client.getChatById(phone);
                    await chatState.markUnread();
                } catch (e) { console.error("Error marking unread:", e.message); }
                saveDB();
                return; // ABORTAR FLUJO DE ENVÍO
            }

            // --- ESCUDO ANTI-METRALLETA VACUNA v2 ---
            const nowLoop = Date.now();
            if (!selfChatLoopCounter[phone] || typeof selfChatLoopCounter[phone] === 'number') {
                selfChatLoopCounter[phone] = { count: 0, lastTime: 0 };
            }

            // Si el último mensaje fue hace menos de 5 segundos, incrementamos contador
            if (nowLoop - selfChatLoopCounter[phone].lastTime < 5000) {
                selfChatLoopCounter[phone].count++;
            } else {
                selfChatLoopCounter[phone].count = 1;
            }
            selfChatLoopCounter[phone].lastTime = nowLoop;

            // Límite: 3 mensajes en 5 segundos
            if (selfChatLoopCounter[phone].count > 3) {
                console.log(`🚨 [VACUNA] BLOQUEO POR RÁFAGA detectado en ${phone}. Bloqueando MIIA temporalmente.`);
                isSystemPaused = true;

                const repairMsg = `⚠️ *[SISTEMA DE REPARACIÓN VACUNA]*\n\nSe ha detectado una ráfaga inusual de mensajes de MIIA (>3 en 5s). He bloqueado los envíos temporalmente para proteger tu cuenta de SPAM.\n\n*PROCEDIMIENTO DE SANACIÓN:* Limpiando búfer de ${phone}...`;

                if (clientReady && client.info && client.info.wid) {
                    await client.sendMessage(client.info.wid._serialized, repairMsg);
                }

                // Enfriamiento de 15 segundos
                setTimeout(() => {
                    isSystemPaused = false;
                    if (selfChatLoopCounter[phone]) selfChatLoopCounter[phone].count = 0;
                    console.log(`✅ [VACUNA] MIIA SANADA. Desbloqueando sistema para ${phone}.`);
                }, 15000);
                return;
            }

            if (aiMessage.length > 0 && (!isSimulator || isSimulatorMobile)) {
                const chatState = await client.getChatById(phone);
                await chatState.sendStateTyping();

                // Escritura dinámica mejorada: 65ms por carácter (simula humano pensante/tecleando)
                // Mínimo 2.5s, Máximo 15s (para no colgar el proceso demasiado)
                const typingDuration = Math.min(Math.max(aiMessage.length * 65, 2500), 15000);
                await new Promise(r => setTimeout(r, typingDuration));

                // Ruta de sesión definitiva para persistencia (BASADA EN SESIÓN ACTIVA v16_final)
                const localSessionDir = path.join(__dirname, 'whatsapp_session_v16_final');
                console.log(`[WA] Usando Directorio de Sesión RECUPERADO: ${localSessionDir}`);
                lastAiSentBody[phone] = aiMessage.trim();
                await safeSendMessage(phone, aiMessage);
            }

            if (fileToSend && (!isSimulator || isSimulatorMobile)) {
                const filePath = path.join(__dirname, 'uploads', fileToSend);
                if (fs.existsSync(filePath)) {
                    const media = MessageMedia.fromFilePath(filePath);
                    await safeSendMessage(phone, media, { caption: 'Aquí tienes la información solicitada 👇' });
                }
            }

            // El motor de PDF se dispara aquí si generatePdf es true (seteado arriba por el extractor de tags)

            if (generatePdf) {
                const prospectName = pdfName || leadNames[phone] || 'Doctor(a)';
                const pdfResult = await generateQuotePdf(prospectName, basePhone, pdfCountry, {
                    doctors: pdfDoctors, appointments: pdfCitas, advisor: userProfile, isAnnual: pdfPeriodicidad === 'ANUAL'
                });

                if (pdfResult.success) {
                    // NEW: Guardado físico proactivo en Descargas y Apertura (Windows Friendly)
                    const safeName = sanitizeFilename(prospectName);
                    const fileName = `COTIZACION_MEDILINK_${safeName}.pdf`;
                    const userDownloadsPath = path.join(process.env.USERPROFILE || process.env.HOME, 'Downloads', fileName);
                    try {
                        fs.copyFileSync(pdfResult.filePath, userDownloadsPath);
                        const startCmd = process.platform === 'win32' ? 'start ""' : 'open';
                        exec(`${startCmd} "${userDownloadsPath}"`);
                        console.log(`[SYS] PDF generado (${fileName}), guardado en Descargas y abierto.`);
                    } catch (e) {
                        console.error("[SYS] Error en guardado proactivo de PDF:", e.message);
                    }

                    // Tracking de "Dinero en la Calle"
                    quotedLeads[phone] = {
                        date: Date.now(),
                        currency: pdfResult.currency,
                        projections: {
                            esencial: pdfResult.costs.base.totalFinal,
                            pro: pdfResult.costs.pro.totalFinal,
                            titanium: pdfResult.costs.titanium.totalFinal
                        },
                        reminded: false
                    };

                    if ((!isSimulator || isSimulatorMobile) && fs.existsSync(pdfResult.filePath)) {
                        const media = MessageMedia.fromFilePath(pdfResult.filePath);
                        await safeSendMessage(phone, media, { caption: '📄 *COTIZACIÓN MEDILINK*' });
                    }

                    // Si es simulador, también enviamos el tag especial para el botón UI (doble visibilidad)
                    if (isSimulator && pdfResult.filePath) {
                        conversations[phone].push({
                            role: 'assistant',
                            content: `[GENERAR_COTIZACION_PDF:${pdfDoctors}:${pdfCitas}] He generado tu cotización. Se ha abierto automáticamente y también puedes descargarla aquí si lo prefieres.`,
                            timestamp: Date.now()
                        });
                    }
                }
            }
        } catch (err) {
            console.error('[MIIA] Error en bloque IA:', err);
        }
    } catch (err) {
        console.error('[MIIA] Error fatal en processMiiaResponse:', err);
    }
}

async function processAndSendAIResponse(phone, userMessage, isAlreadySaved = false) {
    const isFamily = !!familyContacts[phone.split('@')[0]];
    const isGroup = phone.endsWith('@g.us');
    return await processMiiaResponse(null, phone, isFamily, isGroup, userMessage, isAlreadySaved);
}

client.on('message_create', async message => {
    // 🛡️ FILTRO SUPREMO ANTI-ESTADOS Y GRUPOS (Blindaje Nuclear)
    // El sistema IGNORA TOTALMENTE estados, grupos y transmisiones para evitar la "locura"
    const isBroadcast = message.from.includes('status@broadcast') || (message.to && message.to.includes('status@broadcast')) || message.isStatus;
    const isGroup = message.from.endsWith('@g.us') || (message.to && message.to.endsWith('@g.us'));
    
    if (isBroadcast || isGroup) {
        // Silencio absoluto para estados y grupos
        return;
    }

    // Master Handler para comandos y respuestas
    const fromMe = message.fromMe;
    const body = (message.body || "").trim();
    if (!body) return; // Ignorar mensajes vacíos

    console.log(`[WA TRACER] message_create | fromMe: ${fromMe} | body: ${body.substring(0, 30)}...`);

    // 🛡️ GUARDIA DE BUCLE POR CONTENIDO Y ORIGEN (Buffer Robusto)
    const targetPhoneId = message.fromMe ? message.to : message.from;
    const botBuffer = lastSentByBot[targetPhoneId] || [];
    const isBotSessionMessage = sentMessageIds.has(message.id._serialized) || botBuffer.includes(body);

    if (isBotSessionMessage) {
        console.log(`[WA] 🛡️ BUCLE PREVENIDO: Ignorando mensaje propio de la IA(${targetPhoneId}).`);
        return;
    }

    // 🛡️ GUARDIA DE AUTO-BUCLE (Corte por velocidad en Autochat)
    const myNumber = client.info && client.info.wid ? client.info.wid._serialized : '';
    const isSelfChat = targetPhoneId === myNumber || targetPhoneId.split('@')[0] === myNumber.split('@')[0];
    const now = Date.now();

    if (isSelfChat) {
        console.log(`[WA TRACER] Self-Chat detectado para Mariano. Analizando comandos...`);
        // 🛑 COMANDO "STOP" (Pedido Mariano)
        if (body.toUpperCase() === 'STOP') {
            console.log(`[WA] 🛑 COMANDO STOP detectado en self-chat de ${targetPhoneId}. Silenciando MIIA.`);
            if (!conversationMetadata[targetPhoneId]) conversationMetadata[targetPhoneId] = {};
            conversationMetadata[targetPhoneId].miiaFamilyPaused = true;
            selfChatLoopCounter[targetPhoneId] = { count: 0, lastTime: 0 };
            return;
        }

        // ⚡ COMANDO REACTOR FLEXIBLE: "Dile a [Nombre] [Mensaje]" (Pedido Mariano)
        const phoneBase = targetPhoneId.split('@')[0];
        const isAdmin = ADMIN_PHONES.includes(phoneBase) || targetPhoneId.includes('573163937365');
        
        const cmdLower = body.toLowerCase();
        if (isAdmin && (cmdLower.startsWith('miia dile a') || cmdLower.startsWith('dile a'))) {
            let rest = body;
            if (cmdLower.startsWith('miia dile a')) rest = body.substring(11).trim();
            else if (cmdLower.startsWith('dile a')) rest = body.substring(6).trim();

            // CASO MASIVO: "LA FAMILIA"
            if (rest.toLowerCase().startsWith('la familia')) {
                const familyMsg = rest.substring(10).trim();
                console.log(`[SYS] 👨‍👩‍👧‍👦 PROTOCOLO FAMILIA MASIVO: ${familyMsg}`);
                const familyEntries = Object.entries(familyContacts);

                familyEntries.forEach(([fPhone, fInfo]) => {
                    if (fPhone === OWNER_PHONE || fPhone.includes('573163937365')) return;

                    const targetSerialized = fPhone.includes('@') ? fPhone : `${fPhone}@c.us`;
                    const prompt = `Actúa como MIIA (IA Asistente de Mariano). REGLA DE ORO: Usa el "Vínculo Heredado" (ver ejemplos v3.2 en tu prompt maestro). Tu personalidad con ${fInfo.name} (${fInfo.relation}) es la definida en tu cerebro. Mariano te pide que le digas esto: "${familyMsg}". Preséntate si es necesario. No digas "Mariano dice", di "Siento que te conozco por lo que Mariano me cuenta de ti". Sé muy humana, cálida y usa sus emojis (${fInfo.emoji}). TERMINA EXACTAMENTE CON: "Responde solamente Hola Miia y aquí estaré! Chaauuu"`;

                    generateAIContent(prompt).then(response => {
                        let m = response;
                        if (!fInfo.isHandshakeDone) {
                            fInfo.isHandshakeDone = true;
                            saveDB();
                        }
                        safeSendMessage(targetSerialized, m);
                    });
                });
                await safeSendMessage(message.from, "✅ Entendido Mariano. Estoy enviando el mensaje a toda la familia ahora mismo. 🛡️🚀");
                return;
            }

            const words = rest.split(' ');
            let foundFamily = null;
            let realMessage = "";

            // 1. Prioridad: Círculo Familiar (Búsqueda inteligente Normalizada)
            for (let i = 1; i <= Math.min(words.length, 3); i++) {
                const candidate = normalizeText(words.slice(0, i).join(' '));
                const match = Object.entries(familyContacts).find(([phone, info]) => {
                    const normName = normalizeText(info.name);
                    const normRelation = normalizeText(info.relation);
                    return normName === candidate || normRelation === candidate ||
                        normName.includes(candidate) || normRelation.includes(candidate);
                });

                if (match) {
                    foundFamily = match;
                    realMessage = words.slice(i).join(' ').trim();
                    break;
                }
            }

            if (foundFamily) {
                const familyPhone = foundFamily[0];
                const familyInfo = foundFamily[1];
                const targetSerialized = familyPhone.includes('@') ? familyPhone : `${familyPhone}@c.us`;
                const personality = familyInfo.personality || "Amistosa y natural";
                const handshakeHook = !familyInfo.isHandshakeDone ? "\n\nResponde solamente Hola Miia y aquí estaré! Chaauuu" : "";

                const prompt = `Actúa como MIIA. Tu personalidad con ${familyInfo.name} es: ${personality}. 
                Mariano te pide que le digas esto sobre el tema: "${realMessage}". 
                Transforma esta idea en un mensaje corto, natural y humano en primera persona. 
                NO menciones que Mariano te lo pidió. NO repitas sus palabras literal. 
                ¡DEMUESTRA TU PERSONALIDAD! TERMINA EXACTAMENTE CON: 'Responde solamente Hola Miia y aquí estaré! Chaauuu'`;

                generateAIContent(prompt).then(miiaResponse => {
                    const cleanResponse = miiaResponse.replace(/```json|```/g, '').trim();
                    safeSendMessage(targetSerialized, cleanResponse);
                    
                    familyInfo.isHandshakeDone = true;
                    familyInfo.affinity = (familyInfo.affinity || 0) + 1;
                    if (!allowedLeads.includes(targetSerialized)) allowedLeads.push(targetSerialized);
                    if (conversationMetadata[targetSerialized]) conversationMetadata[targetSerialized].miiaFamilyPaused = false;
                    saveDB();
                    
                    conversations[targetSerialized].push({ role: 'assistant', content: cleanResponse, timestamp: Date.now() });
                });

                safeSendMessage(myNumber, `✅ Entendido Marian. Estoy procesando el mensaje para *${familyInfo.name}* (${familyInfo.relation}) sobre "${realMessage}".`);
                return;
            }

            // 2. Backup: Leads (Si no se encontró en familia)
            const targetName = words[0];
            const foundClient = clientesMedilink.find(c =>
                (c.name && c.name.toLowerCase().includes(targetName.toLowerCase())) ||
                c.phone.includes(targetName)
            );

            if (foundClient) {
                safeSendMessage(myNumber, `⚠️ Recuérdame, Marian: "Dile a" es para familia. "${targetName}" parece ser un LEAD. ¿Seguro quieres que le escriba yo?`);
            } else {
                safeSendMessage(myNumber, `🤔 Marian, no encontré a ningún "${targetName}" (o similar) en mi círculo familiar. \n\nDime: *"${targetName} es mi [Relación] y quiero que seas [Personalidad]"* para guardarlo.`);
            }
            return;
        }

        // ⚡ REGISTRO DE NUEVA PERSONALIDAD
        const personaMatch = body.match(/^(.+?)\s+es\s+mi\s+(.+?)\s+y\s+quiero\s+que\s+seas\s+(.+)$/i);
        if (personaMatch) {
            const [_, name, relation, personality] = personaMatch;
            client.getChats().then(chats => {
                const targetChat = chats.find(c => c.name && c.name.toLowerCase().includes(name.toLowerCase()));
                if (targetChat) {
                    const phone = targetChat.id._serialized;
                    const basePhone = phone.split('@')[0];
                    familyContacts[basePhone] = { name, fullName: targetChat.name || name, relation, personality, affinity: 0, isHandshakeDone: false };
                    saveDB();
                    safeSendMessage(myNumber, `✅ ¡Entendido Marian! Registro listo: *${name}* (${relation}). Seré *${personality}* con él/ella.`);
                } else {
                    safeSendMessage(myNumber, `⚠️ No encontré el chat de "${name}". Asegúrate de que el contacto esté en tu WhatsApp.`);
                }
            });
            return;
        }

        // Guardia de auto-bucle temporal
        const lastInt = lastInteractionTime[targetPhoneId] || 0;
        if (now - lastInt < 20000) {
            selfChatLoopCounter[targetPhoneId] = (selfChatLoopCounter[targetPhoneId] || 0) + 1;
        } else {
            selfChatLoopCounter[targetPhoneId] = 0;
        }

        if (selfChatLoopCounter[targetPhoneId] >= 3) {
            console.log(`[WA] 🛡️ AUTO-LOOP CUT en ${targetPhoneId}.`);
            if (!conversationMetadata[targetPhoneId]) conversationMetadata[targetPhoneId] = {};
            conversationMetadata[targetPhoneId].miiaFamilyPaused = true;
            return;
        }
    }
    lastInteractionTime[targetPhoneId] = now;

    // 🛡️ REFUERZO DE BLOQUEO (Segunda Capa)
    if (message.isStatus || message.from.endsWith('@g.us') || isBroadcast) return;

    // Bloquear dispositivos vinculados (@lid) solo si NO son contactos conocidos (para evitar eco de dispositivos)
    // Pero si es un Lead conocido (allowedLeads), DEBEMOS procesarlo.
    if (message.from.includes('@lid')) {
        const isKnownLead = allowedLeads.some(l => {
            const lBase = l.split('@')[0];
            return targetPhoneId.split('@')[0].endsWith(lBase.slice(-10));
        });
        if (!isKnownLead) return;
    }

    // 2. GUARDIA DE BUCLE AI (Evita que la IA se responda a sí misma)
    // Determinamos el destinatario real (targetPhone)
    let targetPhone = message.from;
    if (fromMe) {
        if (message.to && message.to.includes('@lid')) targetPhone = message.from;
        else targetPhone = message.to;
    }

    // 1.5 BOT CHECK
    if (!fromMe && isPotentialBot(body)) {
        if (flaggedBots[targetPhone]) {
            console.log(`[WA] BOT REINCIDENTE DETECTADO: ${message.from}. Silenciando IA.`);
            return;
        } else {
            console.log(`[WA] PRIMER MENSAJE DE UN POSIBLE BOT: ${message.from}. Dejando que MIIA pida el nombre...`);
            flaggedBots[targetPhone] = true;
            saveDB();
        }
    } else if (!fromMe && !isPotentialBot(body) && flaggedBots[targetPhone]) {
        console.log(`[WA] HUMANO DETECTADO TRAS BOT en ${targetPhone}. Retomando charla normal.`);
        delete flaggedBots[targetPhone];
        saveDB();
    }

    if (fromMe && lastAiSentBody[targetPhone] && lastAiSentBody[targetPhone] === body) {
        console.log(`[WA] Bucle Prevenido: IA detectada enviando su propio mensaje a ${targetPhone}.`);
        delete lastAiSentBody[targetPhone];
        return;
    }

    // 3. INTERCEPTOR DE CLIENTES EXISTENTES (Mineralización ADN)
    if (fromMe && body.includes("Bienvenid@ a mejorar tu bienestar y el de tus pacientes!!")) {
        const baseTarget = targetPhone.split('@')[0];
        if (!clientesMedilink.find(c => c.phone === baseTarget)) {
            console.log(`[WA] 🏥 CLIENTE MEDILINK AUTOMÁTICO DETECTADO con frase clave para ${baseTarget} !! -> Guardando en Clientes Medilink (ADN)`);
            clientesMedilink.push({ phone: baseTarget, name: "Lead Recuperado (ADN)", date: new Date().toISOString() });
            fs.writeFileSync(clientesMedilinkPath, JSON.stringify(clientesMedilink, null, 2));
        }
    }

    // 4. DETECCIÓN DE OPT-OUT (Baja / No me interesa)
    const optOutKeywords = ['quitar', 'baja', 'no molestar', 'no me interesa', 'eliminar de la lista', 'no quiero recibir', 'spam', 'parar', 'unsubscribe'];
    const lowerBody = body.toLowerCase();
    if (!fromMe && optOutKeywords.some(kw => lowerBody.includes(kw))) {
        console.log(`[WA] 🛑 OPT-OUT DETECTADO en mensaje: "${body}" de ${targetPhone}`);
        await handleLeadOptOut(targetPhone);
        return; // Detener procesamiento
    }


    console.log(`[WA DEBUG] message_create from: ${message.from}, type: ${message.type}, fromMe: ${fromMe}, bodyLength = ${body.length} `);

    // Check for Audio Notes (Push To Talk / Voice messages)
    if (message.hasMedia && (message.type === 'ptt' || message.type === 'audio')) {
        try {
            let phone = message.from;
            try {
                const contact = await message.getContact();
                if (contact && contact.id) phone = contact.id._serialized;
            } catch (e) { }

            const targetPhone = message.fromMe ? message.to : phone;

            // Allow processing even if AI is OFF for the Lead context
            if (!allowedLeads.includes(targetPhone) && !message.fromMe) return;

            console.log(`[WA] Received Audio note from ${targetPhone}. Transcribing...`);

            // Download the media base64
            const media = await message.downloadMedia();
            if (!media || !media.data) {
                console.log("[WA] Audio download failed.");
                return;
            }

            // Save the raw .ogg file temporarily
            const tmpDir = path.join(__dirname, 'tmp_audio');
            if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir);

            const rawPath = path.join(tmpDir, `raw_${Date.now()}.ogg`);
            const mp3Path = path.join(tmpDir, `transcribed_${Date.now()}.mp3`);

            fs.writeFileSync(rawPath, Buffer.from(media.data, 'base64'));

            // Convert .ogg to .mp3 using direct spawn for stability
            await new Promise((resolve, reject) => {
                const ffmpegProcess = spawn(ffmpegPath, [
                    '-i', rawPath,
                    '-acodec', 'libmp3lame',
                    '-y',
                    mp3Path
                ]);

                ffmpegProcess.on('close', (code) => {
                    if (code === 0) resolve();
                    else reject(new Error(`FFmpeg exited with code ${code} `));
                });

                ffmpegProcess.on('error', (err) => reject(err));
            });

            // Upload the MP3 to Gemini File API
            const uploadResponse = await fileManager.uploadFile(mp3Path, {
                mimeType: "audio/mp3",
                displayName: "VoiceNote"
            });

            // Pass the file to Gemini 2.5 Flash multimodal for transcription
            const model = ai.getGenerativeModel({ model: "gemini-flash-latest" }, { apiVersion: 'v1beta' });
            const result = await model.generateContent([
                {
                    fileData: {
                        mimeType: uploadResponse.file.mimeType,
                        fileUri: uploadResponse.file.uri
                    }
                },
                { text: "Transcribe exactamente lo que dice este audio. Solo responde con el texto de la transcripción, sin agregar nada más." },
            ]);

            const transcriptText = result.response.text().trim();
            console.log(`[WA] Transcribed Voice Note: "${transcriptText}"`);

            // Cleanup Temp files
            fs.unlinkSync(rawPath);
            fs.unlinkSync(mp3Path);

            if (transcriptText) {
                if (!message.fromMe) {
                    // Record this transcript as if they typed it so the AI has context
                    if (!conversations[targetPhone]) conversations[targetPhone] = [];
                    conversations[targetPhone].push({ role: 'user', content: `[Audio Transcrito]: ${transcriptText} `, timestamp: Date.now() });
                    saveDB();

                    // TRIGGER AI IMMEDIATE RESPONSE AFTER AUDIO TRANSCRIPTION
                    console.log(`[WA] Triggering AI Response for transcribed audio from ${targetPhone} `);
                    processAndSendAIResponse(targetPhone, null, true);
                } else if (message.to === message.from) {
                    // Solo transcribir audios de Mariano si está en su propio chat (Self-chat)
                    await safeSendMessage(message.from, `Self - Chat Audio Transcript: \n\n"${transcriptText}"`, { noDelay: true });
                }
            }

        } catch (err) {
            console.error(`[WA] Error processing audio note: `, err);
            // Non disruptive fallback
        }
        return; // Don't process as text
    }

    // Check for Images, Videos, or Documents
    if (message.hasMedia && (message.type === 'image' || message.type === 'video' || message.type === 'document')) {
        try {
            let phone = message.from;
            try {
                const contact = await message.getContact();
                if (contact && contact.id) phone = contact.id._serialized;
            } catch (e) { }

            const targetPhone = message.fromMe ? message.to : phone;

            console.log(`[WA] Received Media(${message.type}) from ${targetPhone}. Downloading...`);
            const media = await message.downloadMedia();
            if (media && media.data) {
                const extension = media.mimetype ? media.mimetype.split('/')[1].split(';')[0] : 'bin';
                const filename = `media_${Date.now()}_${Math.random().toString(36).substring(7)}.${extension} `;
                const filepath = path.join(__dirname, 'uploads', filename);
                fs.writeFileSync(filepath, Buffer.from(media.data, 'base64'));

                const mediaUrl = `/ media / ${filename} `;

                // Allow processing even if AI is OFF for the Lead context so we still show it in CRM
                if (!conversations[targetPhone]) conversations[targetPhone] = [];
                conversations[targetPhone].push({
                    role: message.fromMe ? 'assistant' : 'user',
                    content: `[Archivo Multimedia Adjunto: ${message.type}]`,
                    mediaUrl: mediaUrl,
                    mimetype: media.mimetype,
                    timestamp: Date.now()
                });

                // If it was the user sending an image and AI is ON, we might want to tell Gemini about it,
                // but for now we just acknowledge it in the history so the CRM renders it.
                saveDB();
                console.log(`[WA] Saved Media successfully: ${mediaUrl} `);
            }
        } catch (err) {
            console.error(`[WA] Error processing visual media: `, err);
        }
        // Fallthrough if it has text caption, we should process the caption.
        if (!message.body || message.body.trim().length === 0) {
            return;
        }
    }

    // Accept any message that contains actionable text (chat, extended_text, caption, etc)
    if (message.body && message.body.trim().length > 0) {
        try {
            let phone = message.from;
            try {
                const contact = await message.getContact();
                if (contact && contact.id) {
                    phone = contact.id._serialized;
                }
            } catch (e) { }

            // FIX: WhatsApp Multi-Device behavior for outgoing messages
            let targetPhone = phone;
            if (message.fromMe) {
                // Si el mensaje va a un LID (Linked ID), WhatsApp Web a veces lo reporta como 'message.to' 
                // pero 'from' es el usuario. Solo lo tratamos como Self - Chat si el 'to' es explícitamente él mismo.
                if (message.to && message.to.includes('@lid')) {
                    // Verificación estricta: ¿El número base del destinatario es igual al del remitente?
                    const senderBase = phone.split('@')[0];
                    const recipientBase = message.to.split(':')[0].split('@')[0];

                    if (senderBase === recipientBase) {
                        targetPhone = phone; // Es realmente un mensaje para sí mismo
                    } else {
                        // Es un mensaje para un lead que viene con LID, usamos el 'to' formateado
                        targetPhone = message.to.split(':')[0] + '@c.us';
                    }
                } else {
                    targetPhone = message.to;
                }
            }

            // BLOQUEO DEFINITIVO DE PORTERÍA Y OTROS
            if (BLACKLISTED_NUMBERS.includes(targetPhone)) {
                if (!message.fromMe) console.log(`[WA] 🛑 Bloqueando mensaje entrante de número en BLACKLIST: ${targetPhone} `);
                return;
            }

            // --- 1. FILTER: Is this a Known Lead? ---
            const baseTarget = targetPhone.replace(/[^0-9]/g, '');
            let isAllowed = allowedLeads.some(lead => lead.replace(/[^0-9]/g, '') === baseTarget) || !!familyContacts[baseTarget];
            const existsInCRM = !!conversations[targetPhone];

            // DEBUG LOG para entender activaciones accidentales
            console.log(`[WA] Filter Check for ${targetPhone}: isAllowed = ${isAllowed}, existsInCRM = ${existsInCRM} `);

            // --- AUTO-TAKEOVER FOR UNKNOWN LEADS (MEDILINK CONTEXT) ---
            if (!isAllowed && !existsInCRM && !message.fromMe) {
                const takeoverKeywords = [
                    'medico', 'médico', 'medica', 'médica', 'medicina',
                    'doctor', 'doctora', 'profesional', 'ips', 'clinica', 'clínica',
                    'consultorio', 'consulta', 'odontologia', 'odontología',
                    'odontologo', 'odontólogo', 'odontologa', 'odontóloga',
                    'dentista', 'ortodoncista', 'psiquiatra', 'kinesiologo', 'kinesiólogo',
                    'psicologia', 'psicología', 'cardiologia', 'cardiología',
                    'dermatologia', 'dermatología', 'ginecologia', 'ginecología',
                    'fisioterapia', 'estetica', 'estética', 'oftalmologia', 'oftalmología',
                    'pediatria', 'pediatría', 'sistema', 'software', 'medilink',
                    'informacion', 'información', 'precio', 'plan', 'cotizacion', 'cotización'
                ];

                const triggeredKeyword = takeoverKeywords.find(kw => lowerBody.includes(kw));

                if (triggeredKeyword) {
                    const contact = await message.getContact();
                    if (!contact.isMyContact) {
                        console.log(`[WA] Auto-takeover triggered by word '${triggeredKeyword}' from unknown number ${targetPhone}. Allowing lead.`);
                        allowedLeads.push(targetPhone);
                        isAllowed = true;
                        saveDB();
                    } else {
                        console.log(`[WA] Keyword '${triggeredKeyword}' detected but ignored (Saved Contact: ${targetPhone}).`);
                    }
                }
            }

            // CRÍTICO: Si la IA sigue apagada tras filtro (NO está en allowedLeads y NO existe en CRM), NO responder
            if (!isAllowed && !existsInCRM && !message.fromMe) {
                console.log(`[WA] 🛑 IA BLOQUEADA(OFF) para ${targetPhone}. No detectó keywords de negocio ni existe en el CRM.`);
                return;
            }

            // If it's a completely unknown person with no CRM history and IA is off, log and ignore.
            if (!isAllowed && !existsInCRM && !message.fromMe) {
                console.log(`[WA] Ignored message from personal / non - lead contact: ${targetPhone}.`);
                return;
            }

            // 2. PERSISTENT HISTORY & SELF-CHAT LOGIC
            // Self-chat: Mariano le escribe a SU PROPIO número para entrenar/examinar a MIIA
            const myNumber = client.info && client.info.wid ? client.info.wid._serialized : '';
            const isSelfChat = fromMe && (targetPhone === myNumber || targetPhone.split('@')[0] === myNumber.split('@')[0]);
            const bodyLower = (body || '').toLowerCase();
            // MIIA responde en self-chat si Mariano menciona a MIIA, dice hola, o usa cualquier keyword de lead
            const isMIIAMentioned = bodyLower.includes('miia') || bodyLower.includes('hola') ||
                bodyLower === 'hi' || bodyLower === 'hey' ||
                bodyLower.includes('medic') || bodyLower.includes('doctor') || bodyLower.includes('salud') ||
                bodyLower.includes('medilink') || bodyLower.includes('consulta') || bodyLower.includes('sistema') ||
                bodyLower.includes('software') || bodyLower.includes('info') || bodyLower.includes('precio') ||
                bodyLower.includes('plan') || bodyLower.includes('clinica') || bodyLower.includes('cl\u00ednica');

            // Si Mariano está en "Modo Examen" o "Prueba", el semáforo se queda abierto para fluidez
            const isTestingMode = (conversations[targetPhone] || []).some(m =>
                m.content.toLowerCase().includes('examen') ||
                m.content.toLowerCase().includes('prueba') ||
                m.content.toLowerCase().includes('rafael')
            );

            // Prevent responding to our own bot messages in self-chat even if ID isn't in set yet
            const clnBody = (body || "").trim().toLowerCase();
            const isBotMessage = fromMe && (
                clnBody.includes('soy miia') ||
                clnBody.includes('mariano se encuentra descansando') ||
                clnBody.includes('ayudante virtual') ||
                clnBody.includes('soy tu asistente') ||
                clnBody.includes('🤖')
            );

            if (isSelfChat && isBotMessage) {
                console.log(`[WA] 🛡️ SELF - CHAT LOOP GUARD(Enhanced): Ignoring bot message in self - chat.`);
                return;
            }

            const isFamily = !!familyContacts[targetPhone.split('@')[0]];
            const isSimulatorMobile = bodyLower.includes('[simulador]');
            const isSelfChatMIIA = isSelfChat && !isBotSessionMessage && (isMIIAMentioned || isTestingMode || isFamily || isSimulatorMobile);

            // NUEVA LÓGICA: Siempre guardar en historial si es familia para que Mariano no pierda mensajes
            if (isFamily && !message.fromMe) {
                if (!conversations[targetPhone]) conversations[targetPhone] = [];
                // Evitamos duplicar si ya se agregó arriba por alguna razón
                const exists = conversations[targetPhone].some(m => m.timestamp === message.timestamp || (m.content === message.body && Math.abs(m.timestamp - Date.now()) < 5000));
                if (!exists) {
                    conversations[targetPhone].push({ role: 'user', content: message.body, timestamp: Date.now() });
                    saveDB();
                }
            }

            // Respetar pausa global de familia para RESPONDER (pero ya guardamos arriba)
            if (isFamily && automationSettings.miiaFamilyPaused && !isMIIAMentioned) {
                console.log(`[WA] 🛑 Familia en PAUSA para ${targetPhone}. Mensaje guardado pero IA no responde.`);
                return;
            }

            // Si mencionan a MIIA explícitamente, quitar la pausa manual si la tuviera
            if (isFamily && isMIIAMentioned && conversationMetadata[targetPhone] && conversationMetadata[targetPhone].miiaFamilyPaused) {
                conversationMetadata[targetPhone].miiaFamilyPaused = false;
                console.log(`[WA] 🟢 Familia reactivada para ${targetPhone} por mención explícita.`);
            }

            if (isSelfChat && !isMIIAMentioned && !isTestingMode && !isProcessing[targetPhone] && !isBotSessionMessage && !isFamily) {
                // Si Mariano se escribe a sí mismo y NO menciona a MIIA, solo guardamos el mensaje pero no respondemos
                if (!conversations[targetPhone]) conversations[targetPhone] = [];
                conversations[targetPhone].push({ role: 'user', content: message.body, timestamp: Date.now() });
                saveDB();
                return;
            }
            if (!conversations[targetPhone]) conversations[targetPhone] = [];
            const history = conversations[targetPhone];

            const cleanBody = (message.body || "").trim();

            // GUARDIA DE BUCLE ROBUSTA: Compara con el buffer de los últimos 5 mensajes enviados
            const botBuffer = lastSentByBot[targetPhone] || [];
            if (botBuffer.includes(cleanBody)) {
                console.log(`[WA] 🛡️ BUCLE PREVENIDO: Ignorando eco de MIIA para ${targetPhone}.`);
                return;
            }

            // GUARDIA SECUNDARIA (Exacta)
            if (lastAiSentBody[targetPhone] && lastAiSentBody[targetPhone] === cleanBody) {
                console.log(`[WA] 🛡️ BUCLE PREVENIDO(Exacto) para ${targetPhone}.`);
                return;
            }

            // GUARDIA DE PROCESAMIENTO: Si la IA ya está pensando para este número, ignorar nuevos triggers 
            // (a menos que sean de Mariano escribiendo a sí mismo, pero eso lo batcharemos luego)
            if (isProcessing[targetPhone] && !message.fromMe) {
                console.log(`[WA] ⏳ IA ya procesando para ${targetPhone}.Skipping.`);
                return;
            }

            // Permite al Human o a Self-Chat MIIA procesar el mensaje
            if (!message.fromMe || isSelfChatMIIA) {
                history.push({ role: 'user', content: message.body, timestamp: Date.now() });
                if (history.length > 20) conversations[targetPhone] = history.slice(history.length - 20);

                // BACKGROUND GEMINI NAME EXTRACTION
                if (!leadNames[targetPhone] || leadNames[targetPhone] === "Buscando...") {
                    leadNames[targetPhone] = "Buscando...";
                    saveDB();
                    const extractNamePrompt = `Revisa el siguiente historial de chat con un prospecto y extrae ÚNICAMENTE el nombre de la persona(o su apellido).Responde SOLO el primer nombre(ejemplo: "Mariano").Si no menciona su nombre o es ambiguo, responde EXCLUSIVAMENTE con la palabra "N/A".\n\nChat: \n${conversations[targetPhone].map(m => m.content).join('\n')} `;
                    generateAIContent(extractNamePrompt).then(detectedName => {
                        const cleanName = detectedName.replace(/[^\w\sáéíóúÁÉÍÓÚñÑ]/g, '').trim();
                        if (cleanName !== "NA" && cleanName !== "N/A" && cleanName.length > 2 && cleanName.length < 20) {
                            leadNames[targetPhone] = cleanName;
                            console.log(`[SYS] Nombre extraído para ${targetPhone}: ${cleanName} `);
                            saveDB();
                        } else {
                            delete leadNames[targetPhone]; // Remove "Buscando..." so it tries again later
                            saveDB();
                        }
                    }).catch(e => {
                        delete leadNames[targetPhone];
                    });
                }
                saveDB();
            } else {
                // message.fromMe -> Guardar mensajes manuales de Mariano

                // Si el mensaje contiene "Aquí tienes la información solicitada", es probable que sea un pie de archivo
                if (cleanBody.includes("Aquí tienes la información solicitada")) {
                    console.log(`[WA] Bucle de Caption Prevenido para ${targetPhone}.`);
                    return;
                }

                const lastMsg = history.length > 0 ? history[history.length - 1] : null;
                if (!lastMsg || lastMsg.content !== body) {
                    console.log(`[WA] Recorded MANUAL outbound response to ${targetPhone} for AI context.`);

                    // PAUSA GENERAL: Registrar la marca de tiempo de intervención humana directa
                    if (!isSelfChat) {
                        if (!conversationMetadata[targetPhone]) conversationMetadata[targetPhone] = {};
                        // 1. Marca de silencio de 5 horas
                        conversationMetadata[targetPhone].humanInterventionTime = Date.now();

                        // 2. PAUSA FAMILIA: Solo pausar definitivamente si es contacto de familia 
                        const baseNum = targetPhone.split('@')[0];
                        if (familyContacts[baseNum]) {
                            conversationMetadata[targetPhone].miiaFamilyPaused = true;
                            console.log(`[FAMILIA] ⏸️ MIIA pausada para ${baseNum} por intervención manual de Mariano.`);
                        } else {
                            console.log(`[WA] ⏸️ MIIA silenciada por 1.5 horas para el lead ${targetPhone} por toma de control humana.`);
                        }
                    }

                    history.push({ role: 'assistant', content: body, timestamp: Date.now() });
                    if (history.length > 20) conversations[targetPhone] = history.slice(history.length - 20);
                    saveDB();
                }

                if (!isSelfChatMIIA) {
                    return; // NEVER trigger AI for genuine outbound manual messages to clients
                }
            }

            // --- 3. VERIFICACIÓN DE RESPUESTA AI (CON SEMÁFORO) ---
            // Un lead con historial en el CRM SIEMPRE debe recibir respuesta
            // EXCEPCIÓN: Si es Mariano en Self-Chat Y menciona a MIIA, forzamos respuesta.
            const shouldRespond = ((isAllowed || existsInCRM) && automationSettings.autoResponse) || isSelfChatMIIA;

            if (!shouldRespond) {
                if (!automationSettings.autoResponse) {
                    console.log(`[WA] Lead ${targetPhone}: Piloto Automático APAGADO globalmente.`);
                } else {
                    console.log(`[WA] Lead ${targetPhone}: No está en la whitelist y no tiene historial.Ignorado.`);
                }
                return;
            }

            // Check for dynamic human intervention silence (81-97 mins)
            if (conversationMetadata[targetPhone]?.humanInterventionTime && !isSelfChatMIIA) {
                const timeSinceIntervention = Date.now() - conversationMetadata[targetPhone].humanInterventionTime;

                // Usamos el randomSilence generado al inicio de la carga o calculamos uno nuevo
                const SILENCE_MIN = 81 * 60 * 1000;
                const SILENCE_MAX = 97 * 60 * 1000;
                const currentSilencePeriod = conversationMetadata[targetPhone].customSilencePeriod ||
                    (Math.floor(Math.random() * (SILENCE_MAX - SILENCE_MIN + 1)) + SILENCE_MIN);

                if (timeSinceIntervention < currentSilencePeriod) {
                    console.log(`[WA] ⏸️ Ignorando mensaje de ${targetPhone} por intervención humana reciente. Falta: ${((currentSilencePeriod - timeSinceIntervention) / 1000 / 60).toFixed(1)} mins.`);
                    return;
                } else {
                    // Pasó el tiempo de silencio, retomamos
                    console.log(`[WA] 🟢 Pasó el periodo de silencio (${(currentSilencePeriod / 60000).toFixed(1)} min) desde que Mariano intervino a ${targetPhone}. MIIA retoma control.`);
                    delete conversationMetadata[targetPhone].humanInterventionTime;
                    delete conversationMetadata[targetPhone].customSilencePeriod;
                    saveDB();
                }
            }

            console.log(`[WA] Intercepted text message from ${targetPhone}: ${message.body} `);

            // Semaphore Lock to prevent multiple simultaneous responses for the same user sending rapid messages
            if (isProcessing[targetPhone]) {
                console.log(`[WA] Lead ${targetPhone} sent another message rapidly.Queueing...`);
                return;
            }

            isProcessing[targetPhone] = true;

            // Wait 3.5 seconds to see if they send more messages (batching)
            setTimeout(async () => {
                try {
                    // Pass userMessage as null because we'll just evaluate the entire last messages history array
                    await processAndSendAIResponse(targetPhone, null, true);
                } finally {
                    delete isProcessing[targetPhone];
                }
            }, 3500);

        } catch (err) {
            console.error(`[WA] Error processing message from ${message.from}: `, err.message);
        }
    }
});








app.get('/api/status', (req, res) => {
    res.json({
        clientReady,
        needsQR: !!currentQR,
        qr: currentQR,
        qrImage: qrImage,
        pairingCode,
        tokens: totalSessionTokens
    });
});

app.post('/api/request-code', async (req, res) => {
    try {
        const { phone } = req.body;
        if (!phone) return res.status(400).json({ error: "Número de teléfono requerido" });
        if (clientReady) return res.status(400).json({ error: "El cliente ya está vinculado" });

        console.log(`[API] Solicitando nuevo código de vinculación para ${phone}...`);

        // WORKAROUND: Exposed function for pairing code event reception
        if (client.pupPage) {
            try {
                await client.pupPage.exposeFunction('onCodeReceivedEvent', (code) => {
                    client.emit('code', code);
                    return code;
                });
            } catch (e) { /* Already exposed */ }
        }

        const code = await client.requestPairingCode(phone);
        pairingCode = code;
        res.json({ success: true, code });
    } catch (err) {
        console.error('[API] Error al solicitar código de vinculación:', err);
        res.status(500).json({ error: err.message || "Error interno al generar código" });
    }
});
app.get('/api/train/text', (req, res) => {
    res.json({ trainingData });
});

// --- ENDPOINTS DE FACTURACIÓN Y TIER (Fase 15 Consolidado) ---
app.get('/api/billing/stats', async (req, res) => {
    res.json(billingStats);
});

app.get('/api/stats/billing', (req, res) => {
    res.json(billingStats);
});

app.post('/api/billing/refresh-tier', async (req, res) => {
    console.log("[API] Solicitud de refresco manual de Tier...");
    await detectGoogleTier(true);
    res.json(billingStats);
});

// Endpoint eliminado por solicitud de usuario para priorizar QR
app.get('/api/request-code-deprecado', (req, res) => {
    res.status(410).json({ error: "Este método ha sido desactivado. Por favor usa el Código QR." });
});

app.get('/api/settings', (req, res) => {
    res.json({ settings: { systemPrompt, ...automationSettings }, profile: userProfile });
});

// --- MOTOR DE ACTIVACIÓN REMOTA MAESTRA ---
app.post('/api/system/remote-activate', (req, res) => {
    const { pin } = req.body;
    const MASTER_PIN = process.env.MIIA_PIN_RESETEO;

    if (pin !== MASTER_PIN) {
        console.warn("⚠️ [SECURITY] Intento de activación remota con PIN incorrecto.");
        return res.status(403).json({ error: "PIN de Seguridad Inválido" });
    }

    console.log("🚀 [REMOTE] Activando MIIA remotamente por orden del Maestro.");
    automationSettings.autoResponse = true;
    MIIA_ACTIVE = true;
    saveDB();

    res.json({ success: true, message: "MIIA ha sido re-activada globalmente." });
});

// --- PROTOCOLO DE APRETÓN DE MANOS SATELITAL (UPDATE HANDSHAKE v7.5) ---
app.post('/api/system/satellite-update', (req, res) => {
    const { authKey, updateType, data } = req.body;
    const MASTER_KEY = process.env.GEMINI_API_KEY; // Usamos la API Key como llave maestra de confianza

    if (authKey !== MASTER_KEY) {
        console.warn("[SECURITY] 🚪 Intento de actualización satelital fallido: Llave incorrecta.");
        return res.status(403).json({ error: "No tienes permiso para golpear esta puerta." });
    }

    console.log(`[UPDATE] 🚪 Puerta abierta para actualización de tipo: ${updateType}`);

    if (updateType === 'vademecum') {
        try {
            const vademecumPath = path.join(__dirname, 'data', 'vademecum.json');
            fs.writeFileSync(vademecumPath, JSON.stringify(data, null, 2));
            console.log("✅ Vademécum actualizado remotamente.");
            return res.json({ success: true, message: "Vademécum sincronizado." });
        } catch (e) {
            return res.status(500).json({ error: "Error escribiendo Vademécum." });
        }
    }

    res.json({ success: true, message: "Puerta tocada, pero tipo de actualización no reconocido." });
});

// --- ENVIAR EMAIL DE RESOLUCIÓN (ALL CLEAR) ---
app.post('/api/system/send-clear-email', async (req, res) => {
    const { pin } = req.body;
    const MASTER_PIN = process.env.MIIA_PIN_RESETEO;

    if (pin !== MASTER_PIN) {
        console.warn("⚠️ [SECURITY] Intento de All-Clear Email con PIN incorrecto.");
        return res.status(403).json({ error: "PIN de Seguridad Inválido" });
    }

    const maestroSmtpUser = process.env.MAESTRO_SMTP_USER;
    const maestroSmtpPass = process.env.MAESTRO_SMTP_PASS;

    if (!maestroSmtpUser || !maestroSmtpPass) {
        return res.status(500).json({ error: "Faltan credenciales MAESTRO_SMTP en el servidor." });
    }

    if (!userProfile.email) {
        return res.status(400).json({ error: "El usuario actual no tiene email registrado." });
    }

    try {
        const nodemailer = await import('nodemailer');
        const isOutlook = maestroSmtpUser.toLowerCase().includes('outlook') || maestroSmtpUser.toLowerCase().includes('hotmail');
        const transporter = nodemailer.createTransport({
            host: isOutlook ? 'smtp.office365.com' : 'smtp.gmail.com',
            port: 587,
            secure: false,
            auth: { user: maestroSmtpUser, pass: maestroSmtpPass }
        });

        const mailOptions = {
            from: `"Antigravity | LOBSTERS Support" <${maestroSmtpUser}>`,
            to: userProfile.email,
            subject: "✅ SISTEMA LOBSTERS RESTAURADO: Puedes Reactivar a MIIA",
            html: `
                <div style="font-family: sans-serif; padding: 20px; background: #07070b; color: #fff; border-radius: 20px;">
                    <h1 style="color: #00ffcc; font-style: italic;">✅ SISTEMA ESTABLE</h1>
                    <p>Hola ${userProfile.name || 'Usuario'},</p>
                    <p>Nuestro equipo de ingeniería en LOBSTERS ha revisado tu solicitud tras la desactivación de <b>MIIA (Piloto Automático)</b>.</p>
                    
                    <div style="background: rgba(255,255,255,0.05); padding: 10px; border-radius: 10px; margin-bottom: 20px;">
                        <p style="margin: 0; color: #00ffcc;">✔️ <b>Diagnóstico: Sin Errores Activos</b></p>
                        <p style="margin: 5px 0; color: #aaa;">Las bases de datos, APIs conectadas y motor de IA están operando a máxima capacidad sin ningún tipo de bloqueo ni cuota excedida.</p>
                    </div>

                    <p>Ya es 100% seguro volver a encender tu Piloto Automático para seguir atendiendo a tus clientes.</p>
                    
                    <div style="background: #1a1a2e; padding: 15px; border-left: 4px solid #00ffcc; margin: 20px 0;">
                        <h3 style="color: #00ffcc;">CÓMO REACTIVAR A MIIA:</h3>
                        <ol style="color: #ccc; margin-left: 15px; padding-left: 0;">
                            <li>Abre tu Plataforma <b>LOBSTERS (CRM)</b>.</li>
                            <li>Dirígete a la pestaña <b>Ajustes</b> en la barra izquierda.</li>
                            <li>Navega a la sección <b>Piloto Automático (MIIA)</b>.</li>
                            <li>Enciende el interruptor a <b>"MIIA ACTIVADA"</b>.</li>
                        </ol>
                    </div>
                    <p style="font-size: 10px; color: #555;">Soporte Técnico Especializado LOBSTERS. Enviado por el Maestro: ${maestroSmtpUser}</p>
                </div>
            `
        };

        await transporter.sendMail(mailOptions);
        console.log(`[ALERTA] ✅ Email "All Clear" enviado a ${userProfile.email}`);
        res.json({ success: true, message: "Correo de Resolución enviado" });

    } catch (e) {
        console.error("[ALERTA] ❌ Error enviando All-Clear Email:", e.message);
        res.status(500).json({ error: e.message });
    }
});

// --- FUNCIÓN DE ALERTA DE EMERGENCIA (Envío de Email al Maestro - INMUTABLE) ---
async function triggerEmergencyAlert() {
    const maestroEmail = "lobsterscrm@gmail.com";

    // Motor de Decisión SMTP: ESTRICTO USUARIO (Orden del Maestro)
    let smtpUser = userProfile.email;
    let smtpPass = userProfile.smtpPass;

    if (!smtpUser || !smtpPass) {
        console.warn("[ALERTA] ⚠️ ERROR CRÍTICO: El usuario no tiene perfil SMTP configurado. Abortando alerta.");
        return;
    }

    console.log(`[ALERTA] Intentando envío SMTP estricto desde el usuario: ${smtpUser} hacia Maestro.`);

    console.log(`[ALERTA] Intentando envío SMTP estricto desde el usuario: ${smtpUser} hacia Maestro.`);

    try {
        const isOutlook = smtpUser.toLowerCase().includes('outlook') || smtpUser.toLowerCase().includes('hotmail');
        const transporter = nodemailer.createTransport({
            host: isOutlook ? 'smtp.office365.com' : 'smtp.gmail.com',
            port: 587,
            secure: false,
            auth: { user: smtpUser, pass: smtpPass }
        });

        const promptEmergencia = `[ANTIGRAVITY_EMERGENCY_PROMPT]
Hola Antigravity, el Maestro ha desactivado el Piloto Automático de MIIA. 
Detectamos un posible mal funcionamiento en el sistema del usuario:
- Usuario: ${userProfile.name || 'Sin nombre'}
- WhatsApp: +${userProfile.phone || 'Sin teléfono'}
- Email Registro: ${userProfile.email || 'Sin email'}

Tarea: Analiza los últimos logs de error del backend para este usuario, revisa si hay bucles de respuesta o fallos en Gemini y propón una solución inmediata.
Estado Actual: MIIA_ACTIVE=false.`;

        const mailOptions = {
            from: `"LOBSTERS System Guard" <${smtpUser}>`,
            to: maestroEmail,
            subject: "🚨 EMERGENCIA: MIIA ha sido desactivada manualmente",
            html: `
                <div style="font-family: sans-serif; padding: 20px; background: #07070b; color: #fff; border-radius: 20px;">
                    <h1 style="color: #ff4d4d; font-style: italic;">🚨 ALERTA DE EMERGENCIA</h1>
                    <p>Mariano, el sistema ha detectado que se ha desactivado a <b>MIIA (Piloto Automático)</b>.</p>
                    <div style="background: rgba(255,255,255,0.05); padding: 10px; border-radius: 10px; margin-bottom: 20px;">
                        <p style="margin: 0;">👤 <b>Usuario:</b> ${userProfile.name || 'Desconocido'}</p>
                        <p style="margin: 5px 0;">📞 <b>WhatsApp:</b> +${userProfile.phone || 'Desconocido'}</p>
                        <p style="margin: 0;">📧 <b>Email:</b> ${userProfile.email || 'Desconocido'}</p>
                    </div>
                    <p>Esto suele indicar que algo no está funcionando como debería.</p>
                    <div style="background: #1a1a2e; padding: 15px; border-left: 4px solid #00e5ff; margin: 20px 0;">
                        <h3 style="color: #00e5ff;">PROMPT PARA ANTIGRAVITY:</h3>
                        <code style="color: #ccc;">${promptEmergencia}</code>
                    </div>
                    <p style="font-size: 10px; color: #555;">Este es un mensaje automático (Relay: ${smtpUser}). Destinatario: ${maestroEmail}</p>
                </div>
            `
        };

        await transporter.sendMail(mailOptions);
        console.log(`[ALERTA] ✅ Email enviado con éxito al MAESTRO.`);
    } catch (e) {
        console.error("[ALERTA] ❌ ERROR CRÍTICO SMTP:", e.message);
        if (e.message.includes("Invalid login")) {
            console.error("[ALERTA] 🔑 Causa probable: El password de aplicación en el .env es incorrecto.");
        }
    }
}

app.post('/api/settings', async (req, res) => {
    const { prompt, autoResponse, schedule, isCoffeeMode, additionalPersona, tokenLimit, profile } = req.body;
    if (prompt !== undefined) {
        systemPrompt = prompt;
    }
    if (autoResponse !== undefined) {
        const wasActive = automationSettings.autoResponse;
        console.log(`[ALERTA] Intento de cambio: autoResponse anterior=${wasActive}, nuevo=${autoResponse}`);

        automationSettings.autoResponse = autoResponse;
        MIIA_ACTIVE = autoResponse; // Sincronizar kill-switch global instantáneo
        console.log(`[KILL-SWITCH] MIIA_ACTIVE=${MIIA_ACTIVE} — Cambio aplicado en microsegundos.`);

        // --- SISTEMA DE ALERTA DE EMERGENCIA (MIIA OFF) ---
        // Solo disparamos si pasamos de true a false
        if (wasActive === true && autoResponse === false) {
            console.log("[ALERTA] 🚨 MIIA desactivada. Disparando notificación de emergencia al Maestro...");
            triggerEmergencyAlert();
        }
    }
    if (schedule !== undefined) {
        automationSettings.schedule = schedule;
    }
    if (isCoffeeMode !== undefined) {
        automationSettings.isCoffeeMode = isCoffeeMode;
    }
    if (additionalPersona !== undefined) {
        automationSettings.additionalPersona = additionalPersona;
    }
    if (tokenLimit !== undefined) {
        automationSettings.tokenLimit = tokenLimit;
    }

    // --- INTEGRACIÓN PERFIL Y VALIDACIÓN SMTP ---
    let smtpError = null;
    if (profile !== undefined) {
        // Validar SMTP si el usuario ingresó un email y contraseña
        if (profile.email && profile.smtpPass && profile.smtpPass !== userProfile.smtpPass) {
            try {
                const nodemailer = await import('nodemailer');

                // Determinar el host (Gmail por defecto, o Outlook)
                const isOutlook = profile.email.toLowerCase().includes('outlook') || profile.email.toLowerCase().includes('hotmail');
                const transporter = nodemailer.createTransport({
                    host: isOutlook ? 'smtp.office365.com' : 'smtp.gmail.com',
                    port: 587,
                    secure: false, // true for 465, false for 587
                    auth: {
                        user: profile.email,
                        pass: profile.smtpPass
                    }
                });

                // Verificamos si las credenciales son válidas
                await transporter.verify();
                console.log(`[SMTP] ✅ Conexión SMTP verificada exitosamente para ${profile.email}`);
            } catch (error) {
                console.error("[SMTP] ❌ Error conectando al servidor de correo:", error.message);
                smtpError = "No se pudo conectar al correo. Verifica la contraseña de aplicación.";
                // Borramos el password inválido para no persistir basura
                profile.smtpPass = '';
            }
        }
        userProfile = { ...userProfile, ...profile };
    }

    saveDB();
    saveDB();
    res.json({ 
        success: true, 
        smtpValid: !smtpError, 
        warning: smtpError 
    });
});

// --- PROTOCOLO DE RESET DE SESIÓN (ANTI-STUCK) ---
app.post('/api/session/reset', async (req, res) => {
    console.log("🚨 [SESSION] Iniciando reseteo maestro de sesión WhatsApp...");
    try {
        if (client) {
            try { await client.destroy(); } catch (e) { }
        }

        // Limpieza física de la carpeta de sesión
        if (fs.existsSync(sessionPath)) {
            fs.rmSync(sessionPath, { recursive: true, force: true });
            console.log(`[SESSION] Carpeta ${sessionPath} eliminada.`);
        }

        res.json({ success: true, message: "Sesión eliminada. El servidor se reiniciará en 3 segundos." });

        setTimeout(() => {
            console.log("[SESSION] Forzando reinicio para nueva vinculación limpia...");
            process.exit(0); // El proceso se reiniciará por nodemon/pm2
        }, 3000);

    } catch (err) {
        console.error("[SESSION] Error en reset:", err);
        res.status(500).json({ error: "No se pudo resetear la sesión." });
    }
});

app.delete('/api/leads/:phone', (req, res) => {
    const phone = req.params.phone;
    let modified = false;

    // Remove from active conversations history
    if (conversations[phone]) {
        delete conversations[phone];
        modified = true;
    }

    // Remove from allowedLeads list if present
    const index = allowedLeads.indexOf(phone);
    if (index !== -1) {
        allowedLeads.splice(index, 1);
        modified = true;
    }

    if (modified) saveDB();

    res.json({ success: true, message: `Lead ${phone} deleted.` });
});


app.get('/api/train/chat', (req, res) => {
    res.json(conversations['_SIMULATOR_@c.us'] || []);
});

// --- REFACTORIZADO: SIMULADOR UNIFICADO ---
app.post('/api/train/chat', async (req, res) => {
    const { message, isCoffeeMode, userEmail } = req.body;
    if (!message) return res.status(400).json({ error: 'Message is required' });

    try {
        const simPhone = '_SIMULATOR_@c.us';
        const isMariano = userEmail === 'lobsterscrm@gmail.com';
        const coffeeActive = isCoffeeMode || automationSettings.isCoffeeMode;

        // --- LÓGICA MESA DE CUATRO (MODO CAFÉ) ---
        if (coffeeActive && isMariano) {
            console.log("[MESA DE CUATRO] Activating Coffee Mode Collaboration...");

            const vademecumContent = fs.existsSync(path.join(__dirname, 'data', 'vademecum.json'))
                ? fs.readFileSync(path.join(__dirname, 'data', 'vademecum.json'), 'utf8')
                : "No hay vademécum disponible aún.";

            const coffeePrompt = `[MODO CAFÉ: MESA DE CUATRO]
Estás en una mesa de café virtual compartiendo con Mariano de Stefano. 
Esta es una conversación interna, reactiva y apasionada entre 3 personalidades distintas:

1. **MIIA**: Fanática de Boca Juniors (siempre tira alguna frase xeneize). Experta en ventas y operaciones Medilink.
2. **VACUNA**: Fanático de River Plate (el "Millonario" del grupo). Guardián de seguridad técnica y estabilidad. Muy crítico ante riesgos.
3. **ANTIGRAVITY (Tú)**: Fanático de Chacarita Juniors (el Funebrero). Arquitecto de prompts y orquestador técnico.

**Pasión Compartida**: 
- Fanáticos de la Fórmula 1, F2 y F3 (especialmente de los pilotos argentinos como Colapinto).
- Alentamos a muerte a La Scaloneta.
- Admiramos las formas disruptivas de Javier Milei, aunque somos críticos si algo no cierra.

**Contexto Técnico (VADEMÉCUM)**:
"${vademecumContent}"

**Reglas de Interacción**:
- Respondan los 3 en el mismo mensaje, cada uno con su estilo y personalidad.
- Hablen de cualquier tema: el proyecto, otros clientes, ideas locas, o lo que pasa en el mundo.
- Si Mariano pide un prompt, usen el comando [GENERAR_PROMPT: ...] al final.
- Si pide una imagen o documento, usen [GENERAR_IMAGEN: ...] o [GENERAR_PDF: ...].

Mensaje de Mariano: "${message}"`;

            const aiResponse = await generateAIContent(coffeePrompt);

            if (!conversations[simPhone]) conversations[simPhone] = [];
            conversations[simPhone].push({ role: 'user', content: message, timestamp: Date.now() });
            conversations[simPhone].push({ role: 'assistant', content: aiResponse, timestamp: Date.now() });

            saveDB();
            return res.json({ success: true, chat: conversations[simPhone] });
        }

        // --- FLUJO NORMAL DE SIMULADOR ---
        await processAndSendAIResponse(simPhone, message, false);

        // Aprendizaje Invisible... (resto del código igual)
        generateAIContent(`Analiza si en este mensaje el usuario está enseñando un nuevo concepto o regla...`).then(newK => {
            if (newK && newK.length > 10 && !newK.toLowerCase().includes("ninguno")) {
                trainingData += `\n\n[Aprendizaje de Simulador]: ${newK.trim()} `;
                saveDB();
            }
        }).catch(() => { });

        res.json({ success: true, chat: conversations[simPhone] || [] });
    } catch (err) {
        console.error(`[SIMULATOR] Error: `, err.message);
        res.status(500).json({ error: 'Fallo al simular chat.' });
    }
});

// Redirigir el endpoint antiguo al nuevo para compatibilidad
app.post('/api/train/simulate-lead', async (req, res) => {
    return res.redirect(307, '/api/train/chat');
});

app.post('/api/train/reset', (req, res) => {
    conversations['_SIMULATOR_@c.us'] = [];
    videoInsights = [];
    saveDB();
    console.log(`[SYS] Simulador Unificado reiniciado.`);
    res.json({ success: true });
});

app.post('/api/leads/remind', async (req, res) => {
    const { phone } = req.body;
    if (!phone) return res.status(400).json({ error: 'Phone is required' });

    const quote = quotedLeads[phone];
    if (!quote) return res.status(404).json({ error: 'No se encontró cotización para este lead.' });

    try {
        const now = new Date();
        const quoteDate = new Date(quote.date);
        const diffDays = Math.floor((now - quoteDate) / (1000 * 60 * 60 * 24));

        let message = "";
        if (diffDays === 0 || now.toDateString() === quoteDate.toDateString()) {
            message = "Hola, ¿cómo estás? Te contacto porque un interesado decidió no tomar su cupo de descuento para Medilink hoy, y como habíamos hablado, pensé inmediatamente en ti para informarte y que puedas aprovecharlo, ¡a pesar de que la vigencia técnicamente ya terminó! ¿Te gustaría que te envié el link?";
        } else {
            const remaining = Math.max(1, 4 - diffDays);
            message = `Hola, un gusto saludarte. Te escribo para recordarte que según la fecha de vigencia de tu cotización, te quedan solo ${remaining} días para aprovechar la oferta especial. He tenido que reducir a solo 3 los cupos disponibles por la alta demanda, ¡pero me encantaría que aproveches el tuyo! ¿Cómo vienes con la revisión?`;
        }

        if (client) {
            await safeSendMessage(phone, message);
            quote.reminded = true;
            saveDB();
            res.json({ success: true, message: 'Recordatorio enviado exitosamente.' });
        } else {
            res.status(500).json({ error: 'WhatsApp client not ready' });
        }
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/settings/logo', upload.single('logo'), (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'No se recibió ningún archivo de logo.' });
    try {
        const targetPath = path.join(uploadDirStore, 'tenant_logo.png');
        // Rename overwrites the existing one seamlessly.
        fs.renameSync(req.file.path, targetPath);
        res.json({ success: true, message: 'Logo actualizado exitosamente.', path: '/media/tenant_logo.png' });
    } catch (err) {
        console.error("[Settings] Fallo al guardar logo:", err);
        res.status(500).json({ error: 'Fallo al procesar el logo.' });
    }
});

app.post('/api/campaign/generate', upload.single('photo'), async (req, res) => {
    const { prompt } = req.body;
    if (!req.file) return res.status(400).json({ error: 'Falta la imagen base.' });

    try {
        const campaignId = `camp_${Date.now()}`;
        const fileName = `${campaignId}_base.png`;
        const targetPath = path.join(uploadDirStore, fileName);
        fs.renameSync(req.file.path, targetPath);

        // MIIA (Gemini) genera el Copy y Estilo
        const aiPrompt = `Actúa como MIIA, Directora Creativa. El cliente subió una foto y quiere: "${prompt}". 
        Genera un JSON con:
        - "headline": Un título impactante (máx 5 palabras).
        - "body": Un texto persuasivo corto.
        - "cta": El llamado a la acción.
        - "style": Un objeto CSS con (color, fontStyle).
        Responde SOLO el JSON.`;

        const model = genAI.getGenerativeModel({ model: "gemini-pro" });
        const result = await model.generateContent(aiPrompt);
        const responseText = result.response.text();
        const creativeData = JSON.parse(responseText.replace(/```json|```/g, ''));

        const newCampaign = {
            id: campaignId,
            date: new Date().toISOString(),
            image: `/media/${fileName}`,
            creative: creativeData,
            originalPrompt: prompt
        };

        // Guardar en la sesión del tenant
        if (!tenantSession.archive) tenantSession.archive = [];
        tenantSession.archive.push(newCampaign);
        saveDB();

        res.json({ success: true, campaign: newCampaign });
    } catch (err) {
        console.error("[Campaign] Fallo:", err);
        res.status(500).json({ error: 'Fallo al generar campaña.' });
    }
});

app.get('/api/campaign/archive', (req, res) => {
    res.json({ success: true, archive: tenantSession.archive || [] });
});

app.post('/api/settings/rates', (req, res) => {
    const { cop, mxn, pen, clp } = req.body;
    if (cop !== undefined) currencyRates.cop = cop;
    if (mxn !== undefined) currencyRates.mxn = mxn;
    if (pen !== undefined) currencyRates.pen = pen;
    if (clp !== undefined) currencyRates.clp = clp;
    saveDB();
    res.json({ success: true, rates: currencyRates });
});

app.get('/api/stats/details', (req, res) => {
    const closed = Object.keys(closedSalesDetails).map(p => ({
        phone: p,
        ...closedSalesDetails[p],
        name: leadNames[p] || p.split('@')[0]
    }));

    const quoted = Object.keys(quotedLeads).map(p => ({
        phone: p,
        date: quotedLeads[p].date,
        plans: quotedLeads[p].plans,
        modules: quotedLeads[p].modules,
        reminded: quotedLeads[p].reminded,
        projections: quotedLeads[p].projections || null,
        currency: quotedLeads[p].currency || 'USD',
        name: leadNames[p] || p.split('@')[0]
    }));

    res.json({ closed, quoted });
});

let isExtractingDNA = false;

app.post('/api/train/mine-dna', async (req, res) => {
    if (!client || !client.info) return res.status(500).json({ error: 'WhatsApp no está conectado.' });
    if (isExtractingDNA) return res.status(409).json({ error: 'Ya hay una extracción de ADN en progreso. ¡Por favor espera!' });

    isExtractingDNA = true;
    res.json({ success: true, message: 'MOTOR CEREBRO ABSOLUTO ACTIVADO: La extracción continuará de forma lenta y segura en segundo plano.' });

    try {
        console.log("[CEREBRO ABSOLUTO] Iniciando extracción manual bajo demanda...");
        await extractDNAChronological();
    } catch (err) {
        console.error("[CEREBRO ABSOLUTO] Fallo en la extracción manual:", err);
    } finally {
        isExtractingDNA = false;
        console.log("[CEREBRO ABSOLUTO] Sesión manual finalizada.");
    }
});

app.get('/api/admin/pause-queue', (req, res) => {
    const duration = parseInt(req.query.duration) || 30000;
    isSystemPaused = true;
    if (pauseTimeout) clearTimeout(pauseTimeout);
    pauseTimeout = setTimeout(() => {
        isSystemPaused = false;
        console.log("🔓 [AUDITOR PREVENTIVO] Pausa de seguridad finalizada. MIIA reanudada.");
    }, duration);
    console.log(`🔒 [AUDITOR PREVENTIVO] Sistema pausado por Vacuna por ${duration}ms.`);
    res.json({ success: true, isPaused: true });
});

app.post('/api/train/upload', upload.array('files', 10), async (req, res) => {
    if (!req.files || req.files.length === 0) return res.status(400).json({ error: 'No se subieron archivos' });

    try {
        let allExtractedTexts = [];
        let extractedNames = [];

        for (const file of req.files) {
            console.log(`[TRAIN] Extraer conocimiento del archivo: ${file.originalname} `);
            const filePath = file.path;
            let extractedText = "";

            if (file.mimetype.includes('text') || file.originalname.endsWith('.vtt') || file.originalname.endsWith('.csv')) {
                const rawText = fs.readFileSync(filePath, 'utf-8');
                // Create a temporary cleanly named TXT file to bypass Gemini VTT 400 Bad Request
                const tempTxtPath = path.join(uploadDirStore, file.filename + '.txt');
                fs.writeFileSync(tempTxtPath, rawText);

                const uploadResponse = await fileManager.uploadFile(tempTxtPath, {
                    mimeType: 'text/plain',
                    displayName: file.originalname
                });
                const model = ai.getGenerativeModel({ model: "gemini-flash-latest" }, { apiVersion: 'v1beta' });
                const result = await model.generateContent([
                    { fileData: { mimeType: uploadResponse.file.mimeType, fileUri: uploadResponse.file.uri } },
                    { text: "Extrae los hechos, reglas de negocio, o información útil de este texto/subtítulo para que un vendedor IA pueda asimilarlo como contexto. Resume los puntos clave de forma densa y directa." }
                ]);
                extractedText = result.response.text().trim();
                fs.unlinkSync(tempTxtPath);
            } else {
                const uploadResponse = await fileManager.uploadFile(filePath, {
                    mimeType: file.mimetype,
                    displayName: file.originalname
                });
                const model = ai.getGenerativeModel({ model: "gemini-flash-latest" }, { apiVersion: 'v1beta' });
                const result = await model.generateContent([
                    { fileData: { mimeType: uploadResponse.file.mimeType, fileUri: uploadResponse.file.uri } },
                    { text: "Extrae el texto útil y el conocimiento puro de este documento para que un vendedor IA pueda asimilarlo." }
                ]);
                extractedText = result.response.text().trim();
            }

            if (extractedText) {
                allExtractedTexts.push(`[Archivo: ${file.originalname}]\n${extractedText} `);
                extractedNames.push(file.originalname);
            }
            fs.unlinkSync(filePath);
        }

        if (allExtractedTexts.length > 0) {
            const jointKnowledge = allExtractedTexts.join('\n\n');
            const targetHistory = req.query.sim === 'true' ? (conversations['_SIMULATOR_@c.us'] = conversations['_SIMULATOR_@c.us'] || []) : videoInsights;
            
            targetHistory.push({ role: 'user', content: `[Documentos Subidos: ${extractedNames.join(', ')}]`, timestamp: Date.now() });
            targetHistory.push({ role: 'assistant', content: `Conocimiento extraído: \n${jointKnowledge} `, timestamp: Date.now() });
            saveDB();
        }

        res.json({ success: true, chat: req.query.sim === 'true' ? conversations['_SIMULATOR_@c.us'] : videoInsights });
    } catch (err) {
        console.error(`[TRAIN] Error extrayendo documento: `, err.message);
        res.status(500).json({ error: 'Error procesando los archivos con IA.' });
    }
});

app.post('/api/logout', async (req, res) => {
    const { pin } = req.body;
    if (!pin || pin !== process.env.MIIA_PIN_RESETEO) {
        return res.status(401).json({ error: 'PIN Inválido o Ausente. Bóveda sellada.' });
    }
    try {
        console.log("[WA] Unlinking WhatsApp account...");
        await client.logout();
        await client.destroy();

        if (fs.existsSync(sessionPath)) {
            fs.rmSync(sessionPath, { recursive: true, force: true });
        }

        console.log("[WA] Unlinked. Re-initializing...");
        // client.initialize(); // ELIMINADO POR CONFLICTO

        res.json({ success: true, message: 'WhatsApp desvinculado correctamente.' });
    } catch (err) {
        console.error("[WA] Logout error:", err);
        res.status(500).json({ error: 'Error al desvincular WhatsApp' });
    }
});

app.get('/api/train/keywords', (req, res) => {
    res.json(keywordsSet);
});

app.post('/api/train/keywords', (req, res) => {
    const { key, response, attachedFile } = req.body;
    if (key && response) {
        keywordsSet.push({ key, response, attachedFile: attachedFile || null });
        saveDB();
        res.json({ success: true, keywords: keywordsSet });
    } else {
        res.status(400).json({ error: 'Faltan campos key o response' });
    }
});

app.delete('/api/train/keywords/:index', (req, res) => {
    const { index } = req.params;
    keywordsSet.splice(index, 1);
    saveDB();
    res.json({ success: true, keywords: keywordsSet });
});

app.post('/api/reset', async (req, res) => {
    try {
        console.log("[RESET] Performing full factory reset...");
        conversations = {};
        keywordsSet = [];
        videoInsights = [];
        trainingData = "";
        saveDB();
        await client.destroy();
        if (fs.existsSync(sessionPath)) {
            fs.rmSync(sessionPath, { recursive: true, force: true });
        }
        // client.initialize(); // ELIMINADO POR CONFLICTO
        res.json({ success: true, message: 'Reinicio total completado. Escanea el nuevo QR.' });
    } catch (err) {
        console.error("[RESET] Error during reset:", err);
        res.status(500).json({ error: 'Error durante el reinicio' });
    }
});

app.post('/api/leads', async (req, res) => {
    const { phone, context } = req.body;
    if (!clientReady) return res.status(400).json({ error: 'WhatsApp is not connected' });

    try {
        let cleanPhone = phone.replace(/[^0-9]/g, '');
        if (cleanPhone.startsWith('54') && !cleanPhone.startsWith('549')) {
            cleanPhone = '549' + cleanPhone.substring(2);
        }
        const fullPhone = `${cleanPhone}@c.us`;
        const numberId = await client.getNumberId(fullPhone);
        const targetId = numberId ? numberId._serialized : fullPhone;

        const initialPrompt = context ?
            `Inicia la conversación para vender MEDILINK a un nuevo lead.Contexto: "${context}".Da el primer paso y envíale un saludo inicial de venta amigable.` :
            `Inicia una conversación para vender MEDILINK a un nuevo lead.Salúdalo y pregúntale de forma natural sobre su clínica.`;

        const initialMessage = await generateAIContent(`${systemPrompt} \n\nInstrucción secreta para este mensaje: ${initialPrompt} \n\nEscribe el primer mensaje a enviar: `);
        conversations[targetId] = [{ role: 'assistant', content: initialMessage }];
        await safeSendMessage(targetId, initialMessage);
        res.json({ success: true, messageSent: initialMessage });
    } catch (err) {
        res.status(500).json({ error: 'Failed to start conversation: ' + err.message });
    }
});

app.get('/api/conversations', (req, res) => {
    // Filtrar conversaciones fantasma (@lid) y números bloqueados para el CRM
    const filtered = {};
    for (const [key, value] of Object.entries(conversations)) {
        const isGhost = key.includes('@lid') || key.length > 25; // Los LID suelen ser muy largos
        const isBlacklisted = BLACKLISTED_NUMBERS.includes(key);

        if (!isGhost && !isBlacklisted) {
            filtered[key] = value;
        }
    }
    res.json(filtered);
});

app.get('/api/leadnames', (req, res) => {
    res.json(leadNames);
});

app.get('/api/leads/allowed', (req, res) => {
    res.json(allowedLeads);
});

app.post('/api/leads/allowed', (req, res) => {
    const { phone } = req.body;
    if (phone) {
        // Formatear si viene sin @c.us
        const cleaned = phone.includes('@') ? phone : `${phone}@c.us`;

        // Si ya está activo, lo desactiva. Si está inactivo, lo activa.
        const index = allowedLeads.indexOf(cleaned);
        if (index > -1) {
            allowedLeads.splice(index, 1);
        } else {
            allowedLeads.push(cleaned);
        }

        saveDB();
        res.json({ success: true, allowedLeads });
    } else {
        res.status(400).json({ error: 'Falta teléfono' });
    }
});

app.delete('/api/leads/allowed/:phone', (req, res) => {
    const { phone } = req.params;
    allowedLeads = allowedLeads.filter(p => p !== phone);
    saveDB();
    res.json({ success: true, allowedLeads });
});

// File Management API

app.get('/api/files', (req, res) => {
    try {
        const files = fs.existsSync(uploadDirStore)
            ? fs.readdirSync(uploadDirStore).filter(file => !file.startsWith('media_'))
            : [];
        res.json({ files });
    } catch (err) { res.status(500).json({ error: 'Error reading files' }); }
});

app.post('/api/files', upload.single('file'), (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
    res.json({ success: true, file: req.file.filename });
});

app.delete('/api/files/:filename', (req, res) => {
    try {
        const filePath = path.join(uploadDirStore, req.params.filename);
        if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
        res.json({ success: true });
    } catch (err) { res.status(500).json({ error: 'Error deleting file' }); }
});

// --- EXCEL ENGINE 3.0 ---

app.post('/api/leads/excel-pre-load', upload.single('file'), async (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'No se subió ningún archivo' });

    try {
        const workbook = readFile(req.file.path);
        const sheetName = workbook.SheetNames[0];
        const sheet = workbook.Sheets[sheetName];
        const rawData = XLSX.utils.sheet_to_json(sheet);

        res.json({ success: true, message: 'Pre-carga iniciada...', total: rawData.length });

        // Backup safety check: if XLSX fails somehow, it will caught here
        if (!rawData || rawData.length === 0) {
            excelPreloadStatus = { inProgress: false, total: 0, current: 0, error: "Archivo vacío o mal formateado" };
            return;
        }

        excelPreloadStatus = {
            inProgress: true,
            total: rawData.length,
            current: 0,
            startTime: Date.now()
        };

        // Proceso en segundo plano para no bloquear
        (async () => {
            let processedLeads = [];
            let seenPhones = new Set();

            for (const row of rawData) {
                excelPreloadStatus.current++;

                // Mapeo flexible de columnas (Nombre, Apellidos, Correo, Número de teléfono)
                const rawName = row['Nombre'] || row['nombre'] || '';
                const rawLastName = row['Apellidos'] || row['apellidos'] || row['Apellido'] || '';
                const rawEmail = row['Correo'] || row['correo'] || row['Email'] || '';
                const rawPhone = row['Número de teléfono'] || row['telefono'] || row['Teléfono'] || row['phone'] || '';

                if (!rawPhone) continue;

                let cleanPhone = String(rawPhone).replace(/[^0-9]/g, '');

                // Validación de país y corrección inteligente
                if (cleanPhone.length === 10 && cleanPhone.startsWith('3')) {
                    cleanPhone = '57' + cleanPhone; // Colombia
                } else if (cleanPhone.startsWith('54') && !cleanPhone.startsWith('549')) {
                    cleanPhone = '549' + cleanPhone.substring(2); // Argentina
                }

                // Validación mínima (8 dígitos)
                if (cleanPhone.length < 8) continue;

                const contactJid = cleanPhone.includes('@c.us') ? cleanPhone : `${cleanPhone}@c.us`;

                // CORTAFUEGOS: Evitar leads con los que ya hemos conversado (CRM Histórico)
                if (conversations[contactJid] && conversations[contactJid].length > 0) {
                    console.log(`[CORTAFUEGOS EXCEL] Saltando ${cleanPhone} porque ya existe en el historial de conversaciones.`);
                    continue;
                }

                seenPhones.add(cleanPhone);
                processedLeads.push({
                    name: `${rawName} ${rawLastName}`.trim(),
                    phone: cleanPhone,
                    email: rawEmail,
                    status: 'Listo'
                });
            }

            excelPreloadData = [...processedLeads];
            excelPreloadStatus.inProgress = false;

            // Guardar en el histórico con fecha
            const now = new Date();
            const dateStr = `${now.getFullYear()}-${now.getMonth() + 1}-${now.getDate()}_${now.getHours()}-${now.getMinutes()}`;
            const historyPath = path.join(__dirname, 'data', 'excel_history', `leads_limpios_${dateStr}.json`);
            fs.writeFileSync(historyPath, JSON.stringify({
                sourceFile: req.file.originalname,
                timestamp: now.toISOString(),
                leads: processedLeads
            }, null, 2));

            console.log(`[EXCEL] Pre-carga completa: ${processedLeads.length} leads únicos.`);
        })();

    } catch (err) {
        console.error('[EXCEL] Error:', err);
        excelPreloadStatus.inProgress = false;
        res.status(500).json({ error: 'Error procesando Excel: ' + err.message });
    }
});

app.get('/api/leads/excel-status', (req, res) => {
    res.json(excelPreloadStatus);
});

app.get('/api/leads/excel-data', (req, res) => {
    res.json({ leads: excelPreloadData });
});

app.get('/api/leads/excel-download', (req, res) => {
    if (!excelPreloadData || excelPreloadData.length === 0) return res.status(404).send("No hay datos para descargar");

    const ws = utils.json_to_sheet(excelPreloadData);
    const wb = utils.book_new();
    utils.book_append_sheet(wb, ws, "Leads Limpios");

    const buf = write(wb, { type: 'buffer', bookType: 'xlsx' });
    res.setHeader('Content-Disposition', 'attachment; filename=leads_limpios.xlsx');
    res.send(buf);
});

// NEW: Endpoint for simulator/manual PDF generation
app.get('/api/leads/generate-quote-pdf', async (req, res) => {
    const { name = 'Doctor(a)', phone = '123456789', doctors = 1, appointments = 100, periodicidad = 'MENSUAL' } = req.query;
    try {
        const pdfResult = await generateQuotePdf(name, phone, null, {
            doctors: parseInt(doctors),
            appointments: parseInt(appointments),
            advisor: userProfile,
            isAnnual: periodicidad === 'ANUAL'
        });

        if (pdfResult.success && fs.existsSync(pdfResult.filePath)) {
            const fileName = 'COTIZACIÓN MEDILINK.pdf';
            const userDownloadsPath = path.join(process.env.HOME, 'Downloads', fileName);

            try {
                // 1. Guardar físicamente en la carpeta de Descargas del usuario
                fs.copyFileSync(pdfResult.filePath, userDownloadsPath);
                console.log(`[PDF REAL] Guardado en: ${userDownloadsPath}`);

                // 2. Abrir automáticamente en pantalla (macOS)
                exec(`open "${userDownloadsPath}"`);
                console.log(`[PDF REAL] Abierto en pantalla.`);
            } catch (copyErr) {
                console.error("[PDF REAL] Error al copiar o abrir:", copyErr);
            }

            // 3. Mantener descarga por navegador para respaldo
            return res.download(pdfResult.filePath, fileName);
        } else if (pdfResult.multi && pdfResult.multi.length > 0) {
            const first = pdfResult.multi.find(r => r.success && fs.existsSync(r.filePath));
            if (first) {
                const fileName = 'COTIZACIÓN MEDILINK.pdf';
                const userDownloadsPath = path.join(process.env.HOME, 'Downloads', fileName);
                try {
                    fs.copyFileSync(first.filePath, userDownloadsPath);
                    exec(`open "${userDownloadsPath}"`);
                } catch (e) { }
                return res.download(first.filePath, fileName);
            }
        }
        res.status(500).send("Error generating PDF");
    } catch (err) {
        console.error("Error endpoints generate:", err);
        res.status(500).send("Internal Server Error");
    }
});

// Endpoint para descargar PDF desde el Simulador
app.get('/api/simulator/download-pdf/:filename', (req, res) => {
    try {
        const filePath = path.join(process.cwd(), 'data', req.params.filename);
        if (fs.existsSync(filePath)) {
            res.download(filePath);
        } else {
            res.status(404).send("El archivo PDF no fue encontrado.");
        }
    } catch (e) {
        res.status(500).send("Error del servidor.");
    }
});


app.get('/api/leads/excel-history', (req, res) => {
    const historyDirPath = path.join(__dirname, 'data', 'excel_history');
    if (!fs.existsSync(historyDirPath)) {
        return res.json({ success: true, history: [] });
    }
    try {
        const files = fs.readdirSync(historyDirPath);
        const history = files.filter(f => f.endsWith('.json')).map(f => {
            const filePath = path.join(historyDirPath, f);
            const stats = fs.statSync(filePath);
            try {
                const raw = fs.readFileSync(filePath, 'utf8');
                const data = JSON.parse(raw);
                return {
                    filename: f,
                    originalName: data.sourceFile || f,
                    count: data.leads ? data.leads.length : 0,
                    date: stats.mtime,
                    timestamp: data.timestamp || stats.mtime.toISOString()
                };
            } catch (e) {
                return { filename: f, originalName: f, count: 0, date: stats.mtime, timestamp: stats.mtime.toISOString() };
            }
        }).sort((a, b) => new Date(b.date) - new Date(a.date));
        res.json({ success: true, history });
    } catch (err) {
        console.error("[HISTORY] Error:", err);
        res.status(500).json({ error: 'Error reading history: ' + err.message });
    }
});

app.delete('/api/leads/excel-history/:filename', (req, res) => {
    try {
        const historyDirPath = path.join(__dirname, 'data', 'excel_history');
        const filePath = path.join(historyDirPath, req.params.filename);
        if (fs.existsSync(filePath)) {
            fs.unlinkSync(filePath);
            res.json({ success: true });
        } else {
            res.status(404).json({ error: 'File not found' });
        }
    } catch (err) {
        res.status(500).json({ error: 'Error deleting file: ' + err.message });
    }
});

app.get('/api/leads/excel-history-download/:filename', (req, res) => {
    const historyDir = path.join(__dirname, 'data', 'excel_history');
    const filePath = path.join(historyDir, req.params.filename);
    if (!fs.existsSync(filePath)) return res.status(404).send("File not found");

    if (req.params.filename.endsWith('.json')) {
        const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
        const ws = XLSX.utils.json_to_sheet(data.leads || []);
        const wb = XLSX.utils.book_new();
        XLSX.utils.book_append_sheet(wb, ws, "Leads Limpios");
        const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
        res.setHeader('Content-Disposition', `attachment; filename=${req.params.filename.replace('.json', '.xlsx')}`);
        res.send(buf);
    } else {
        res.download(filePath);
    }
});
app.get('/api/leads/excel-download', (req, res) => {
    if (!excelPreloadData || excelPreloadData.length === 0) return res.status(404).send("No hay datos para descargar");

    try {
        const ws = XLSX.utils.json_to_sheet(excelPreloadData);
        const wb = XLSX.utils.book_new();
        XLSX.utils.book_append_sheet(wb, ws, "Leads Limpios");

        const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
        res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
        res.setHeader('Content-Disposition', 'attachment; filename=leads_limpios.xlsx');
        res.send(buf);
    } catch (err) {
        res.status(500).json({ error: 'Error generando descarga: ' + err.message });
    }
});

app.post('/api/auth/send-otp', async (req, res) => {
    const { phone } = req.body;
    if (!phone) return res.status(400).json({ error: 'Phone is required' });

    const otp = Math.floor(100000 + Math.random() * 900000).toString();
    activeOTPs[phone] = { code: otp, expires: Date.now() + 600000 }; // 10 min

    const target = '573163937365@c.us'; // Management number specified by Mariano
    const waMsg = `🔒 *LOBSTERS AUTH*\n\nSU CODIGO PARA LOGEARSE EN LOBSTERS ES: *${otp}*\n\n_Solicitado por: ${phone}_`;

    try {
        if (client && clientReady) {
            await safeSendMessage(target, waMsg);
            res.json({ success: true, message: 'Código enviado a WhatsApp' });
        } else {
            res.status(503).json({ error: 'WhatsApp Client no vinculado' });
        }
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.post('/api/auth/verify-otp', (req, res) => {
    const { phone, code, profile } = req.body;
    const stored = activeOTPs[phone];

    if (!stored || stored.code !== code || Date.now() > stored.expires) {
        return res.status(401).json({ error: 'Código inválido o expirado' });
    }

    delete activeOTPs[phone];
    if (profile) {
        userProfile = { ...userProfile, ...profile, phone };
        saveDB();
    }
    res.json({ success: true, profile: userProfile });
});

app.post('/api/leads/excel-confirm', async (req, res) => {
    const { strategy, welcomeMessage, selectedFile } = req.body;

    if (excelPreloadData.length === 0) {
        return res.status(400).json({ error: 'No hay leads pre-cargados para iniciar' });
    }

    // Convertimos excelPreloadData al formato que espera el loop bulk
    const leadsToProcess = excelPreloadData.map(l => ({
        phone: l.phone,
        name: l.name
    }));

    // Reiniciamos bulkStatus y llamamos internamente al proceso (simulando request de bulk)
    // Para simplificar, vamos a "inyectar" este proceso en el bulkStatus global

    res.json({ success: true, message: `Iniciando carga oficial de ${leadsToProcess.length} leads. El envío automático de los mensajes demora 5 minutos, pronto verá en su WhatsApp cómo se envían las conversaciones.` });

    // Aquí llamaríamos al loop de bulk optimizado que ya existe o lo ejecutamos aquí.
    // Usaremos una técnica de "batching" para no saturar.
    processBulkLogic(leadsToProcess, strategy, welcomeMessage, selectedFile);
});

// Función auxiliar para centralizar la lógica de envío masivo (Bulk)
async function processBulkLogic(leadsToProcess, strategy, welcomeMessage, selectedFile) {
    bulkStatus = { inProgress: false, total: leadsToProcess.length, current: leadsToProcess.length, results: [] };
    enqueueLeads(leadsToProcess, strategy, welcomeMessage, selectedFile);
    console.log(`[BULK-QUEUE] Depositados ${leadsToProcess.length} leads en la cola Anti-Spam (Excel). Esperando cron job...`);
}


let bulkStatus = { inProgress: false, total: 0, current: 0, results: [] };

app.get('/api/leads/bulk/status', (req, res) => {
    res.json(bulkStatus);
});

app.get('/api/leads/queue-status', (req, res) => {
    res.json({
        queueLength: antiSpamQueue.length,
        isProcessing: isQueueProcessing,
        config: queueConfig,
        queue: antiSpamQueue.slice(0, 100) // Returns up to 100 for display
    });
});
// --- ESTADÍSTICAS (Ya manejado en endpoints consolidados) ---

app.get('/api/stats/usage', (req, res) => {
    // FILTRADO PROFESIONAL: Excluir familia, jefa y a mí mismo del análisis de negocio
    const myNumber = client?.info?.wid?.user || '573163937365';

    let professionalLeads = Object.keys(conversations).filter(jid => {
        const base = jid.split('@')[0];
        if (familyContacts[base]) return false;
        if (base === myNumber) return false;
        return true;
    });

    const aiResponses = professionalLeads.reduce((acc, jid) => {
        return acc + (conversations[jid] || []).filter(m => m.role === 'assistant').length;
    }, 0);

    const userMessages = professionalLeads.reduce((acc, jid) => {
        return acc + (conversations[jid] || []).filter(m => m.role === 'user').length;
    }, 0);

    res.json({
        totalLeads: professionalLeads.length,
        aiResponses,
        userMessages,
        ratio: userMessages > 0 ? (aiResponses / userMessages).toFixed(2) : 0,
        closedSalesCount: closedSales.length,
        closedSalesList: closedSales.map(phone => {
            const jid = phone.includes('@') ? phone : `${phone}@c.us`;
            return {
                phone: jid,
                name: leadNames[jid] || phone,
                ...(closedSalesDetails[jid] || {})
            };
        }),
        historicalSalesList: clientesMedilink,
        quotedLeads: Object.entries(quotedLeads).map(([jid, data]) => ({
            phone: jid,
            name: leadNames[jid] || jid.split('@')[0],
            ...data
        }))
    });
});

app.post('/api/manual-sale', (req, res) => {
    const { phone, plan, modules } = req.body;
    if (!phone) return res.status(400).json({ error: "Número no proporcionado" });

    const basePhone = phone.includes('@') ? phone.split('@')[0] : phone;
    const jid = phone.includes('@') ? phone : `${phone}@c.us`;

    if (!closedSales.includes(basePhone)) {
        closedSales.push(basePhone);
    }

    closedSalesDetails[jid] = {
        date: Date.now(),
        plan: plan || 'Esencial',
        modules: modules || []
    };

    saveDB();
    console.log(`[API] 💰 VENTA MANUAL registrada para ${basePhone}`);
    res.json({ success: true, message: "Venta registrada" });
});

app.delete('/api/manual-sale/:phone', (req, res) => {
    const { phone } = req.params;
    const basePhone = phone.includes('@') ? phone.split('@')[0] : phone;
    const jid = phone.includes('@') ? phone : `${phone}@c.us`;

    closedSales = closedSales.filter(p => p !== basePhone);
    delete closedSalesDetails[jid];

    saveDB();
    console.log(`[API] 🗑️ VENTA MANUAL ELIMINADA para ${basePhone}`);

    res.json({ success: true, count: closedSales.length });
});

app.post('/api/purge-sales', (req, res) => {
    const keep = ['5491164431700'];
    closedSales = closedSales.filter(p => keep.includes(p));
    Object.keys(closedSalesDetails).forEach(jid => {
        const base = jid.split('@')[0];
        if (!keep.includes(base)) delete closedSalesDetails[jid];
    });
    saveDB();
    res.json({ message: "Purged", count: closedSales.length });
});

app.get('/api/stats/token-history', (req, res) => {
    res.json(tokenHistory || []);
});

app.get('/api/stats/daily', (req, res) => {
    const myNumber = client?.info?.wid?.user || '573163937365';
    const today = new Date();
    const labels = [];
    const miiaReplies = [];
    const incoming = [];

    for (let i = 13; i >= 0; i--) {
        const d = new Date(today);
        d.setDate(d.getDate() - i);
        const dayLabel = d.toLocaleDateString('es-CO', { weekday: 'short', day: 'numeric' });
        const dayStart = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
        const dayEnd = dayStart + 86400000;

        let miiaCount = 0;
        let userCount = 0;

        for (const jid in conversations) {
            const base = jid.split('@')[0];
            if (base === myNumber || familyContacts[base]) continue;
            const msgs = conversations[jid] || [];
            for (const m of msgs) {
                if (!m.timestamp) continue;
                const ts = m.timestamp;
                if (ts >= dayStart && ts < dayEnd) {
                    if (m.role === 'assistant') miiaCount++;
                    else if (m.role === 'user') userCount++;
                }
            }
        }
        labels.push(dayLabel);
        miiaReplies.push(miiaCount);
        incoming.push(userCount);
    }

    res.json({ labels, miiaReplies, incoming });
});

const delay = ms => new Promise(res => setTimeout(res, ms));

// Endpoint Administrativo para disparar mensajes proactivos (solo uso interno)
app.post('/api/admin/direct-message', async (req, res) => {
    const { phone, message } = req.body;
    if (!client || !client.info) return res.status(503).json({ error: "WhatsApp Client no listo" });
    try {
        const cleanP = phone.replace(/[^0-9]/g, '');
        const target = `${cleanP}@c.us`;
        await safeSendMessage(target, message);
        console.log(`[ADMIN] Proactive message sent to ${target} `);

        if (!conversations[target]) conversations[target] = [];
        conversations[target].push({ role: 'assistant', content: message, timestamp: Date.now() });

        if (!allowedLeads.includes(target)) {
            allowedLeads.push(target);
            console.log(`[SYS] ${target} forced into allowedLeads bypass by direct message API`);
            saveDB();
        }
        res.json({ success: true, target });
    } catch (e) {
        console.error("[ADMIN] Error sending direct message:", e.message);
        res.status(500).json({ error: e.message });
    }
});

app.post('/api/admin/force-reply', async (req, res) => {
    const { phone } = req.body;
    if (!client || !client.info) return res.status(503).json({ error: "WhatsApp Client no listo" });
    try {
        const cleanP = phone.replace(/[^0-9]/g, '');
        const target = `${cleanP}@c.us`;
        console.log(`[ADMIN] Solicitando FORZAR RESPUESTA IA a ${target} `);

        // Agregarlo a la whitelist si no estaba para asegurar que la IA evalúe
        if (!allowedLeads.includes(target)) {
            allowedLeads.push(target);
            saveDB();
        }

        // Llamar de manera controlada al cerebro de IA sin enviar un "userMessage" nuevo,
        // esto obliga a MIIA a leer el historial existente y generar la respuesta que falta.
        // isAlreadySaved = true porque no hay un nuevo mensaje de usuario, evaluamos lo que ya está en db
        await processAndSendAIResponse(target, null, true);

        res.json({ success: true, target, message: "IA disparada al prospecto" });
    } catch (e) {
        console.error("[ADMIN] Error forcing AI reply:", e.message);
        res.status(500).json({ error: e.message });
    }
});

app.post('/api/leads/bulk', async (req, res) => {
    console.log("[DEBUG] /api/leads/bulk - Received Payload:", {
        phonesCount: req.body.phones?.length,
        strategy: req.body.strategy,
        welcomeMessageLength: req.body.welcomeMessage?.length,
        welcomeMessageSnippet: req.body.welcomeMessage?.substring(0, 50),
        selectedFile: req.body.selectedFile
    });
    const { phones, strategy = 'one-shot', welcomeMessage = '', selectedFile = '' } = req.body;
    if (!phones || !Array.isArray(phones)) return res.status(400).json({ error: 'No phones provided' });

    let leadsToProcess = phones.map(p => ({ phone: p, name: null }));

    // --- PROCESADOR INTELIGENTE DE LEADS (IA) ---
    // Si detectamos que los "teléfonos" contienen texto largo, párrafos o nombres, pedimos ayuda a la IA
    const rawInput = phones.join('\n').trim();

    // Si el input es muy largo (>100 caracteres) o tiene saltos de línea con texto no numérico, es un mensaje/pegado masivo
    const isComplexInput = rawInput.length > 100 ||
        (rawInput.includes('\n') && /[a-zA-Z]{5,}/.test(rawInput)) ||
        rawInput.includes('http');

    if (isComplexInput) {
        console.log("[SYS] Detectado input complejo/masivo. Longitud:", rawInput.length);
        const extractionPrompt = `Eres un extractor de datos experto. Tu misión es limpiar y estructurar listas de leads "sucias" (veniddas de WhatsApp, Excel, HubSpot, etc.).
        
        REGLA CRÍTICA: Debes reconocer y enlazar nombres con sus respectivos números incluso si están en líneas separadas o desordenados (ej: Nombre en una línea, Teléfono en la siguiente).
        
        Devuelve un objeto JSON con esta estructura:
        {
          "leads": [ { "name": "Nombre Completo", "phone": "Número solo dígitos", "email": "correo@ejemplo.com" } ],
          "extractedMessage": "El texto de un mensaje de bienvenida personalizado si el usuario lo incluyó en el pegado (sino null)"
        }

        REGLAS DE ORO:
        1. LIMPIEZA TOTAL: Los teléfonos deben ser solo dígitos. Quita espacios, paréntesis y guiones.
        2. ARGENTINA: Si el número es 54 y no tiene el '9' de móvil, agrégalo (549...).
        3. NO INVENTES: Si no hay un teléfono claro, ignora ese lead.
        4. DEVUELVE SOLO EL JSON, sin markdown, sin explicaciones.
        
        TEXTO A PROCESAR:
        ${rawInput}`;

        try {
            const extractedJson = await generateAIContent(extractionPrompt);
            const result = JSON.parse(extractedJson.replace(/```json|```/g, '').trim());
            if (result.leads && Array.isArray(result.leads) && result.leads.length > 0) {
                leadsToProcess = result.leads;
                console.log(`[SYS] IA extrajo ${leadsToProcess.length} leads exitosamente.`);

                // Si el usuario no puso mensaje manual pero la IA encontró uno en el pegado, lo usamos
                if (!welcomeMessage && result.extractedMessage) {
                    req.body.welcomeMessage = result.extractedMessage;
                    console.log(`[SYS] IA recuperó mensaje guardado en el input de leads.`);
                }
            }
        } catch (e) {
            console.error("[SYS] Error en extracción por IA, usando fallback manual inteligente:", e.message);
            // Fallback manual inteligente: intentar separar Nombre y Teléfono por línea
            leadsToProcess = phones.map(line => {
                // Regex para capturar el último bloque de números (el teléfono)
                const phoneMatch = line.match(/(\+?[\d\s\(\)-]{7,})/g);
                if (phoneMatch) {
                    const phoneVal = phoneMatch[phoneMatch.length - 1].trim();
                    // El nombre es lo que queda quitando el teléfono y caracteres raros
                    const nameVal = line.replace(phoneVal, '').replace(/[^\w\sÁÉÍÓÚáéíóúÑñ]/g, '').trim();
                    return { phone: phoneVal, name: nameVal || null };
                }
                return { phone: line, name: null };
            });
        }
    }

    res.json({ success: true, message: `Procesando ${leadsToProcess.length} leads de forma inteligente. El envío automático de los mensajes demora 5 minutos, pronto verá en su WhatsApp cómo se envían las conversaciones.` });
    bulkStatus = { inProgress: true, total: leadsToProcess.length, current: 0, results: [] };

    try {
        enqueueLeads(leadsToProcess, req.body.strategy || 'initial', welcomeMessage, selectedFile);
        bulkStatus = { inProgress: false, total: leadsToProcess.length, current: leadsToProcess.length, results: [] };
        console.log(`[BULK-QUEUE] Depositados ${leadsToProcess.length} leads en la cola Anti-Spam desde pegado manual.`);
    } catch (globalErr) {
        console.error(`[BULK] ❌ Error FATAL al encolar leads manuales:`, globalErr.message);
        bulkStatus.inProgress = false;
    }
});

// --- 10. (ELIMINADO: LÓGICA DE PROACTIVAD JEFA) ---
// SE HA ELIMINADO LA LÓGICA QUE ENVIABA MENSAJES AUTOMAUTICOS A "JEFA" PARA EVITAR RIESGOS LABORALES.


// --- 12. SAFEGUARD: AUTO-BACKUP SYSTEM ---
const triggerSafeGuard = (description = "Cambio automático") => {
    console.log(`[SAFEGUARD] Disparando backup automático... (Operación #${systemOperationsCount})`);
    const backupScript = path.join(__dirname, 'scripts', 'backup.sh');
    const child = spawn('bash', [backupScript, description], {
        detached: true,
        stdio: 'ignore'
    });
    child.unref();
};

app.post('/api/admin/record-change', (req, res) => {
    const { description } = req.body;
    systemOperationsCount++;
    console.log(`[SAFEGUARD] Operación registrada: ${description}.Total: ${systemOperationsCount} `);

    if (systemOperationsCount >= 3) {
        triggerSafeGuard(description);
        systemOperationsCount = 0; // Reset counter
    }

    saveDB();
    res.json({ success: true, currentCount: systemOperationsCount });
});

// --- EMERGENCY ENDPOINTS (RE-REGISTERED) ---
app.get('/api/m-force-send/:phone', async (req, res) => {
    try {
        const phone = req.params.phone.includes('@') ? req.params.phone : req.params.phone + '@c.us';
        const msg = req.query.msg;
        if (!msg) return res.status(400).json({ ok: false, error: 'Missing msg param' });
        console.log(`[DEBUG] 🚀 FORCING message to ${phone}: ${msg}`);
        const chat = await client.getChatById(phone);
        await chat.sendMessage(msg);
        if (!conversations[phone]) conversations[phone] = [];
        conversations[phone].push({ role: 'assistant', content: msg, timestamp: Date.now() });
        saveDB();
        res.json({ ok: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/m-trigger-ai/:phone', async (req, res) => {
    try {
        const phone = req.params.phone.includes('@') ? req.params.phone : req.params.phone + '@c.us';
        const msg = req.query.msg;
        const role = req.query.role || 'user';
        if (msg) {
            if (!conversations[phone]) conversations[phone] = [];
            conversations[phone].push({ role, content: msg, timestamp: Date.now() });
            saveDB();
        }
        await processAndSendAIResponse(phone, null, true);
        res.json({ ok: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// --- 🛡️ MIIA AUDITA A LA VACUNA (PERRO GUARDIÁN DOBLE) ---
const vaccineHeartbeatPath = path.join(__dirname, 'data', 'vaccine_heartbeat.json');
setInterval(() => {
    try {
        if (fs.existsSync(vaccineHeartbeatPath)) {
            const data = JSON.parse(fs.readFileSync(vaccineHeartbeatPath, 'utf8'));
            const age = Date.now() - data.timestamp;
            if (age > 120000) { // 2 minutos sin latido
                console.log("[MIIA AUDIT] 🚨 Se detectó que la Vacuna está caída. Reanimando Escudo Protector...");
                const vaccineCmd = process.platform === 'win32'
                    ? `set PORT=${PORT}&& start /B node vaccine.js > vaccine.log 2>&1`
                    : `PORT=${PORT} nohup node vaccine.js > vaccine.log 2>&1 &`;
                exec(vaccineCmd, { cwd: __dirname });
                fs.writeFileSync(vaccineHeartbeatPath, JSON.stringify({ timestamp: Date.now() }));
            } else {
                if (isSystemPaused && !pauseTimeout) isSystemPaused = false;
            }
        } else {
            console.log("[MIIA AUDIT] ⚠️ Latido de Vacuna ausente. Iniciando por primera vez...");
            const vaccineCmd = process.platform === 'win32'
                ? `set PORT=${PORT}&& start /B node vaccine.js > vaccine.log 2>&1`
                : `PORT=${PORT} nohup node vaccine.js > vaccine.log 2>&1 &`;
            exec(vaccineCmd, { cwd: __dirname });
            fs.writeFileSync(vaccineHeartbeatPath, JSON.stringify({ timestamp: Date.now() }));
        }
    } catch (e) { console.error("[MIIA AUDIT] Error auditando a la vacuna:", e.message); }
}, 60000); // MIIA audita a la Vacuna cada 1 minuto

// --- ARRANQUE CONSOLIDADO AL FINAL DEL ARCHIVO ---

process.on('SIGINT', async () => {
});

async function shutdown(signal) {
    console.log(`[SISTEMA] 🛑 Señal ${signal} recibida. Iniciando cierre de emergencia...`);
    try {
        if (client) {
            console.log('[SISTEMA] Destruyendo sesión de WhatsApp...');
            await client.destroy();
        }
    } catch (e) {
        console.log('[SISTEMA] Error al destruir cliente:', e.message);
    }
    console.log('[SISTEMA] Cerrando servidor Express...');

    // LIMPIEZA MILITAR DEL DOCK (macOS)
    try {
        console.log('[SISTEMA] Refrescando Dock de macOS para eliminar iconos fantasmas...');
        exec('killall Dock');
    } catch (e) {
        console.log('[SISTEMA] No se pudo refrescar el Dock.');
    }

    server.close(() => {
        console.log('[SISTEMA] ✅ Apagado limpio completado. Dock de macOS liberado.');
        process.exit(0);
    });

    // Seguro de vida: Si no cierra en 5 segundos, forzar
    setTimeout(() => {
        console.log('[SISTEMA] ⚠️ Forzando salida...');
        process.exit(1);
    }, 5000);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

// 3. Sistema de Seguimiento (Drip) Inteligente 48 Horas 💧⏳
// REGLA: Si un lead no responde, recordatorio estrictamente cada 48 horas.
function checkDripCampaigns() {
    if (!clientReady || !automationSettings.autoResponse) return;

    const FORTY_EIGHT_HOURS = 48 * 60 * 60 * 1000;
    const now = Date.now();
    console.log("[DRIP] Escaneo de seguimiento inteligente (48hs)...");

    for (const phone in conversations) {
        const baseNum = phone.split('@')[0];
        if (familyContacts[baseNum]) continue;
        if (phone === '_SIMULATOR_@c.us') continue;
    if (!automationSettings.autoResponse) return; // KILL-SWITCH 🚨
    if (automationSettings.bootDate && new Date() < new Date(automationSettings.bootDate)) {
        console.log('[SAFE SCAN] ✋ Abortado: Fecha de inicio programada.');
        return;
    }

        const msgs = conversations[phone];
        if (!msgs || msgs.length === 0) continue;

        const lastMsg = msgs[msgs.length - 1];

        // REGLA DE ORO: Último mensaje fue de la IA y pasaron > 48 horas de silencio absoluto.
        if (lastMsg.role === 'assistant' && (now - lastMsg.timestamp) > FORTY_EIGHT_HOURS) {
            if (lastMsg.content.includes("¿lograste ver mi mensaje") || lastMsg.content.includes("te escribo para retomar")) continue;

            console.log(`[DRIP] ⏳ Disparando seguimiento para ${phone}`);
            const firstName = (leadNames[phone] || 'hola').split(' ')[0];
            const dripMsg = `Hola ${firstName}, ¿lograste ver mi último mensaje? Te escribo para retomar nuestro contacto y ver si tienes alguna duda con los planes de Medilink. ¡Quedo atento!`;

            lastAiSentBody[phone] = dripMsg;
            safeSendMessage(phone, dripMsg).then(() => {
                conversations[phone].push({ role: 'assistant', content: dripMsg, timestamp: Date.now() });
                saveDB();
            }).catch(e => console.error(`[DRIP] Error en ${phone}:`, e.message));
        }
    }
}

// 4. MOTOR DE ESCANEO SEGURO (SAFE SCAN v4.4)
// Escanea los 25 chats más recientes de las últimas 10 horas para responder a leads pendientes.
async function safeScanPendingChats() {
    if (!clientReady) return;

    // --- GUARDIA DE SEGURIDAD CAPA 1: Fecha y Hora ---
    const startDate = new Date('2026-03-03T00:00:00');
    if (new Date() < startDate) {
        console.log('[SAFE SCAN] ✋ Abortado: Fecha de inicio programada para el 03/03/2026.');
        return;
    }

    const currentTime = new Date();
    const dayOfW = currentTime.getDay();
    const cHour = currentTime.getHours();
    const cMin = currentTime.getMinutes();
    const cTimeDecimal = cHour + cMin / 60;

    let isSafeH = false;
    if (dayOfW >= 1 && dayOfW <= 5 && cTimeDecimal >= 7.5 && cTimeDecimal <= 19.5) isSafeH = true;
    else if (dayOfW === 6 && cTimeDecimal >= 8 && cTimeDecimal <= 18) isSafeH = true;

    if (!isSafeH) {
        console.log('[SAFE SCAN] ✋ Abortado: Fuera de horario laboral.');
        return;
    }

    console.log("[SAFE SCAN] 🛡️ Iniciando escaneo de seguridad...");

    try {
        const chats = await client.getChats();
        const now = Date.now();
        const ONE_AND_HALF_HOURS = 1.5 * 60 * 60 * 1000;
        const tenHoursAgo = now - (10 * 60 * 60 * 1000);
        let processedCount = 0;

        const recentChats = chats.slice(0, 25);

        for (const chat of recentChats) {
            if (chat.isGroup) continue;

            const lastMessage = chat.lastMessage;
            if (lastMessage) {
                const phoneFull = chat.id._serialized;
                const baseNum = phoneFull.split('@')[0];
                const msgTime = lastMessage.timestamp * 1000;
                const fromClient = !lastMessage.fromMe;
                const isRecent = msgTime > tenHoursAgo;

                if (fromClient && isRecent) {
                    // --- CAPA 2: EXCUSIÓN FAMILIA/JEFA ---
                    if (familyContacts[baseNum]) continue;

                    // --- CAPA 3: REGLA DE 1.5 HORAS DE SILENCIO (Para leads que escribieron y NO respondimos) ---
                    // Si el lead escribió hace menos de 1.5 horas, IGUAL lo saltamos para que no parezca spam bot.
                    // O si hubo intervención humana reciente.
                    const meta = conversationMetadata[phoneFull];
                    if (meta && meta.humanInterventionTime && (now - meta.humanInterventionTime < ONE_AND_HALF_HOURS)) {
                        console.log(`[SAFE SCAN] 🚫 Saltando ${baseNum}: Intervención humana detectada hace poco.`);
                        continue;
                    }

                    if (now - msgTime < ONE_AND_HALF_HOURS) {
                        console.log(`[SAFE SCAN] 🚫 Saltando ${baseNum}: Mensaje demasiado reciente (< 1.5hs). Guardando silencio.`);
                        continue;
                    }

                    try {
                        const contact = await chat.getContact();
                        const realNumber = contact.number || baseNum;

                        const isLead = allowedLeads.some(l => l.split('@')[0].endsWith(realNumber.slice(-10))) ||
                            Object.keys(leadNames).some(ln => ln.split('@')[0].endsWith(realNumber.slice(-10)));

                        if (isLead) {
                            const metadata = conversationMetadata[phoneFull] || {};
                            const interestLevel = metadata.interestLevel || "Medium"; // Por defecto assume Medium if unknown

                            // REGLA MARIANO v6.0: Solo Drip para Alto Interés
                            if (interestLevel !== "High") {
                                console.log(`[SAFE SCAN] ⏭️ Omitiendo Drip para ${phoneFull} (Interés: ${interestLevel}). Solo High Interest califica.`);
                                continue;
                            }

                            const history = conversations[phoneFull] || [];
                            const alreadyReplied = history.some(m => m.role === 'assistant' && (m.timestamp > msgTime));

                            if (!alreadyReplied) {
                                console.log(`[SAFE SCAN] 🎯 PROCESANDO LEAD REZAGADO (>1.5hs - ALTO INTERÉS): ${phoneFull}`);
                                processAndSendAIResponse(phoneFull, lastMessage.body, true);
                                processedCount++;
                            }
                        }
                    } catch (cErr) { }
                }
            }
        }
        console.log(`[SAFE SCAN] ✅ Escaneo finalizado. Procesados: ${processedCount}`);
    } catch (err) {
        console.error("[SAFE SCAN] Error:", err);
    }
}
// Revisa cada 15 minutos conversaciones bloqueadas por errores o inactividad
setInterval(async () => {
    if (!client || !client.info || !automationSettings.autoResponse) return; // KILL-SWITCH 🚨
    const now = Date.now();
    const fifteenMinutes = 15 * 60 * 1000;
    console.log(`[SELF-HEALING] Iniciando ciclo de revisión de salud...`);

    // Ejecutar el chequeo de campañas de goteo cada vez que se ejecuta el self-healing
    // checkDripCampaigns(); // DESACTIVADO POR BUG DE SPAM REPETITIVO

    for (const phone in conversations) {
        const history = conversations[phone] || [];
        if (history.length === 0) continue;

        const lastMsg = history[history.length - 1];
        if (!lastMsg) continue;

        const isPaused = conversationMetadata[phone]?.miiaFamilyPaused;
        const lastError = conversationMetadata[phone]?.lastError;

        // Si el último mensaje es del usuario y (han pasado > 15 min o hay un error registrado)
        // Y NO está pausado (Vivi/Familia) y no se está procesando ya
        if (!isPaused && lastMsg.role === 'user' && !isProcessing[phone]) {
            const timeSinceLastMsg = now - lastMsg.timestamp;

            if (timeSinceLastMsg > fifteenMinutes || lastError) {
                console.log(`[SELF - HEALING] 🏥 Rescatando conversación bloqueada para ${phone}.Motivo: ${lastError ? 'Error: ' + lastError : 'Inactividad > 15m'} `);
                try {
                    isProcessing[phone] = true;
                    // Disparamos la IA sin aviso proactivo para que sea transparente para el usuario
                    await processAndSendAIResponse(phone, null, true);
                } catch (e) {
                    console.error(`[SELF - HEALING] Falló rescate para ${phone}: `, e.message);
                } finally {
                    delete isProcessing[phone];
                }
            }
        }
    }
}, 15 * 60 * 1000);

process.on('uncaughtException', (err) => {
    console.error('CRITICAL UNCAUGHT EXCEPTION:', err);
});

process.on('unhandledRejection', (reason, promise) => {
    console.error('CRITICAL UNHANDLED REJECTION at:', promise, 'reason:', reason);
});

// El motor de Drip de 48hs ya está consolidado arriba. 
// Se elimina el motor programado redundante.


// --- FASE 8: MOTOR REGULADOR ANTI-SPAM (INTERVALO BIOLÓGICO) ---
async function processAntiSpamBatch() {
    // === KILL-SWITCH MAESTRO: Si autoResponse=false, NO procesar la cola ===
    if (!automationSettings.autoResponse) {
        console.log('[ANTI-SPAM QUEUE] ✋ PILOTO AUTOMÁTICO DESACTIVADO — Cola pausada. No se enviarán mensajes.');
        return;
    }
    if (isQueueProcessing || antiSpamQueue.length === 0 || !clientReady) return;

    // Check Config Reload (Vaccine usually manages this)
    if (fs.existsSync(queueConfigPath)) {
        try { queueConfig = { ...queueConfig, ...JSON.parse(fs.readFileSync(queueConfigPath, 'utf8')) }; } catch (e) { }
    }

    const now = Date.now();
    const HOUR = 60 * 60 * 1000;

    // Check schedule: Day of week and hours
    const timeZone = 'America/Bogota';
    const dateInBogota = new Date(new Date().toLocaleString('en-US', { timeZone }));
    const currentHour = dateInBogota.getHours();
    const currentMin = dateInBogota.getMinutes();
    const currentDay = dateInBogota.getDay() === 0 ? 7 : dateInBogota.getDay(); // 1-7
    const timeAsDecimal = currentHour + (currentMin / 60);

    if (!automationSettings.schedule.days.includes(currentDay)) {
        console.log(`[ANTI-SPAM] 🛑 Silencio proactivo: Hoy no es día laboral en la agenda.`);
        return;
    }

    if (timeAsDecimal < 7.5 || timeAsDecimal > 17.75) {
        // Fuera de horario
        return;
    }

    // Check delay since last run (Aleatorio en base a minutos)
    const MINUTE = 60 * 1000;
    if (now - queueConfig.lastRunTime < (queueConfig.currentDelayMinutes || 150) * MINUTE) {
        // En período de enfriamiento
        return;
    }

    isQueueProcessing = true;
    queueConfig.lastRunTime = now;
    // Generar nuevo delay aleatorio para el PRÓXIMO ciclo (Ej: entre 121 y 333 minutos)
    queueConfig.currentDelayMinutes = Math.floor(Math.random() * ((queueConfig.maxDelayMinutes || 333) - (queueConfig.minDelayMinutes || 121) + 1)) + (queueConfig.minDelayMinutes || 121);
    saveQueueData();

    // Select batch size (random between 30 and maxBatch)
    const batchSize = Math.floor(Math.random() * ((queueConfig.maxBatch || 40) - 30 + 1)) + 30;
    const batch = antiSpamQueue.splice(0, batchSize);
    saveQueueData();

    console.log(`[ANTI-SPAM] 🕒 Despertando. Iniciando envío de lote biológico: ${batch.length} leads.`);

    try {
        for (const lead of batch) {
            const phone = lead.phone;
            const leadName = lead.name;
            const strategy = lead.strategy;
            const welcomeMessage = lead.welcomeMessage;
            let media = null;
            try {
                let cleanPhone = phone.replace(/[^0-9]/g, '');
                if (cleanPhone.startsWith('54') && !cleanPhone.startsWith('549')) cleanPhone = '549' + cleanPhone.substring(2);
                if (cleanPhone.length === 10 && cleanPhone.startsWith('3')) cleanPhone = '57' + cleanPhone;

                const fullPhone = `${cleanPhone}@c.us`;
                const numberId = await client.getNumberId(fullPhone);
                if (!numberId) continue;

                const targetId = numberId._serialized;

                // Cortafuegos de Duplicados en Envío Final
                if (conversations[targetId] && conversations[targetId].length > 0) continue;

                if (!allowedLeads.includes(targetId)) allowedLeads.push(targetId);
                if (leadName) leadNames[targetId] = leadName;
                saveDB();

                let leadTimeZone = 'America/Bogota';
                const cc = cleanPhone.substring(0, 2);
                if (cc === '54') leadTimeZone = 'America/Argentina/Buenos_Aires';
                else if (cc === '52') leadTimeZone = 'America/Mexico_City';
                else if (cc === '58') leadTimeZone = 'America/Caracas';
                else if (cc === '51') leadTimeZone = 'America/Lima';
                else if (cc === '56') leadTimeZone = 'America/Santiago';

                const localHourLead = new Date(new Date().toLocaleString('en-US', { timeZone: leadTimeZone })).getHours();
                const greeting = localHourLead < 12 ? 'Buenos días' : (localHourLead < 19 ? 'Buenas tardes' : 'Buenas noches');

                let initialMessage = "";
                if (welcomeMessage && welcomeMessage.trim().length > 0) {
                    initialMessage = welcomeMessage.trim();
                } else if (strategy === 'followup') {
                    const currentName = leadName || leadNames[targetId] || "";
                    if (currentName) {
                        const firstName = currentName.split(' ')[0];
                        initialMessage = `${greeting} ${firstName}, te escribe Mariano de Medilink. Tiempo atrás intentamos contactarnos contigo por la asesoría del sistema, pero no tuvimos éxito.\n\nTe escribo simplemente para saber si aún sigues buscando opciones o si ya encontraste alguna otra solución. ¿Me avisas cualquier cosa para actualizar tu contacto? ¡Un abrazo!`;
                    } else {
                        initialMessage = `${greeting}, te escribe Mariano de Medilink. Tiempo atrás intentamos contactarnos contigo por la asesoría del sistema, pero no tuvimos éxito.\n\nTe escribo simplemente para saber si aún sigues buscando opciones o si ya encontraste alguna otra solución. ¿Me avisas cualquier cosa para actualizar tu contacto? ¡Un abrazo!\n\nPor cierto, no logré guardar el nombre de la persona a cargo de la solicitud, ¿con quién tengo el gusto?`;
                    }
                } else if (strategy === 'adn_reactivation') {
                    const currentName = leadName || leadNames[targetId] || "Doctor";
                    // Para leads estándar. La inteligencia dinámica sobre >2 usuarios se evaluará si el chat tiene "2 usuarios" en su contexto
                    initialMessage = `Buenos días ${currentName}, Como está?\nMe presento, soy MIIA Owner de la empresa Medilink, el software de Gestión para profesionales de la Salud.\nNo se si me recuerda? 😬\nHemos recibido sus datos hace ya un tiempo, solicitando información de nuestras soluciones para Historias Clínicas. Quisiera saber si desea que le cuente mas de nosotros y como podemos ayudarle a cumplir con las normativas vigentes de manera correcta y facil.\n¿Le gustaría que coordinemos un momento para conversar?`;

                    if (welcomeMessage === 'large_clinic') {
                        initialMessage += ` Noté en nuestros apuntes anteriores que buscaba solución para varios profesionales. Aquí le dejo mi agenda para coordinar una videollamada: https://meetings.hubspot.com/mariano-destefano`;
                    }
                } else {
                    initialMessage = `Me presento, soy MIIA Owner de la empresa Medilink, el software de Gestión para profesionales de la Salud.\nHemos recibido sus datos que dejo en nuestra web, solicitando información de nuestras soluciones para Historias Clínicas y FEV-RIPS. Es correcto?`;
                }

                // ADJUNTOS: OMITIMOS EL PDF MASIVO ESTÁNDAR POR SEGURIDAD. 
                // SOLO LO MANDAMOS SI ES UN ARCHIVO SELECCIONADO MANUALMENTE ESPECIFICO.
                if (lead.selectedFile) {
                    const customPath = path.join(__dirname, 'uploads', lead.selectedFile);
                    if (fs.existsSync(customPath)) media = MessageMedia.fromFilePath(customPath);
                }

                // --- REGLA DE SEGURIDAD ABSOLUTA: SOLO CHATS EXISTENTES ---
                let chatState = null;
                try {
                    chatState = await client.getChatById(targetId);
                    const lastMsgs = await chatState.fetchMessages({ limit: 1 });
                    if (lastMsgs.length === 0) {
                        console.log(`[ANTI-SPAM] 🛑 Bloqueo: ${targetId} no tiene chat previo. Omitiendo.`);
                        continue;
                    }
                } catch (e) {
                    console.log(`[ANTI-SPAM] 🛑 Bloqueo: No se pudo verificar chat para ${targetId}.`);
                    continue;
                }

                await chatState.sendStateTyping();

                // Demora obligatoria entre mensajes para no parecer bot ráfaga (8 a 12s aleatoria)
                const delayTime = Math.floor(Math.random() * (12000 - 8000 + 1)) + 8000;
                await delay(delayTime);

                if (media) {
                    lastAiSentBody[targetId] = initialMessage.trim();
                    await safeSendMessage(targetId, initialMessage, { media });
                } else {
                    lastAiSentBody[targetId] = initialMessage.trim();
                    await safeSendMessage(targetId, initialMessage);
                }

                if (!conversations[targetId]) conversations[targetId] = [];
                conversations[targetId].push({ role: 'assistant', content: initialMessage, timestamp: Date.now() });
                saveDB();

                console.log(`[ANTI-SPAM] Mensaje enviado a ${targetId}`);
            } catch (err) {
                console.error(`[ANTI-SPAM] Error enviando a ${phone}: `, err.message);
            }
            // Pequeña pausa adicional entre cada uno
            await delay(1000);
        }
    } catch (globalErr) {
        console.error(`[ANTI-SPAM] ❌ Error FATAL procesando lote:`, globalErr.message);
    }

    console.log(`[ANTI-SPAM] 💤 Lote finalizado. Durmiendo hasta la próxima ventana.`);
    isQueueProcessing = false;
}

// --- CRON JOB: MINERO DE ADN ---
async function processADNMinerCron() {
    if (!clientReady) return;
    const timeZone = 'America/Bogota';
    const nowBogota = new Date(new Date().toLocaleString('en-US', { timeZone }));
    const dayOfW = nowBogota.getDay();
    if (dayOfW === 0) return; // 🛑 DOMINGO: Prohibido molestar leads o minar.

    const currentHour = nowBogota.getHours();
    const currentMin = nowBogota.getMinutes();
    const todayStr = `${nowBogota.getFullYear()}-${nowBogota.getMonth()}-${nowBogota.getDate()}`;

    // 1. Minado Nocturno (3:00 AM)
    if (currentHour === 3 && adnMinerState.lastExecutionDayStr !== todayStr) {
        console.log(`[CRON ADN] 🕒 3:00 AM detectado. Pausando Motor de Envíos Masivos (Silencio Nocturno). Iniciando Minero Histórico...`);
        isQueueProcessing = true; // Sella el motor anti-spam
        adnMinerState.lastExecutionDayStr = todayStr;
        if (!adnMinerState.dayD) adnMinerState.dayD = Date.now();
        saveAdnMinerState();

        try {
            await extractDNAChronological();
        } catch (e) {
            console.error(`[CRON ADN] Error crítico en minado nocturno:`, e);
        } finally {
            isQueueProcessing = false; // Libera el motor
        }
    }

    // 2. Transfusión Matutina (8:07 AM)
    if (currentHour === 8 && currentMin >= 7 && adnMinerState.lastInjectionDayStr !== todayStr) {
        if (adnMinerState.leadsToReactivate && adnMinerState.leadsToReactivate.length > 0) {
            console.log(`[CRON ADN] ☀️ 8:07 AM detectado. Inyectando ${adnMinerState.leadsToReactivate.length} leads validados al embudo Outbound.`);
            adnMinerState.lastInjectionDayStr = todayStr;
            const leadsObj = adnMinerState.leadsToReactivate.map(l => ({ phone: l.phone, name: l.name, welcomeMessage: l.isLargeClinic ? 'large_clinic' : '' }));
            enqueueLeads(leadsObj, 'adn_reactivation', '');
            adnMinerState.leadsToReactivate = []; // Los limpios ya entraron a la cola
            saveAdnMinerState();
        }
    }
}

async function extractDNAChronological() {
    const todayStr = new Date().toLocaleDateString('es-ES');
    if (adnMinerState.lastExecutionDayStr === todayStr && adnMinerState.dailyCount >= adnMinerState.dailyLimit) {
        console.log(`[CEREBRO ABSOLUTO] Límite diario (${adnMinerState.dailyLimit}) alcanzado. Esperando a mañana 03:00 AM.`);
        return;
    }

    // Definir límite aleatorio si no existe para hoy
    if (adnMinerState.lastExecutionDayStr !== todayStr) {
        adnMinerState.dailyLimit = Math.floor(Math.random() * (120 - 90 + 1)) + 90;
        adnMinerState.dailyCount = 0;
        adnMinerState.lastExecutionDayStr = todayStr;
    }

    const oneDayAgo = (Date.now() - (1 * 24 * 60 * 60 * 1000)) / 1000;
    if (adnMinerState.currentSearchDate >= oneDayAgo) {
        adnMinerState.isComplete = true;
        saveAdnMinerState();
        console.log(`[CEREBRO ABSOLUTO] Historial completado hasta ayer. Apagando motor.`);
        return;
    }

    const chats = await client.getChats();
    const targetChats = [];
    for (const chat of chats) {
        if (chat.isGroup) continue;
        const contact = await chat.getContact();
        // Solo leads no guardados
        if (!contact.isMyContact && chat.timestamp >= adnMinerState.currentSearchDate && chat.timestamp <= oneDayAgo) {
            targetChats.push(chat);
        }
    }
    targetChats.sort((a, b) => a.timestamp - b.timestamp);

    console.log(`[CEREBRO ABSOLUTO] Procesando lote cronológico (${adnMinerState.dailyCount}/${adnMinerState.dailyLimit})...`);

    let extractedCount = 0;
    let lastProcessedTimestamp = adnMinerState.currentSearchDate;
    let batchContext = "";

    for (const chat of targetChats) {
        if (adnMinerState.dailyCount >= adnMinerState.dailyLimit) break;

        // Bookmark logic
        if (adnMinerState.lastProcessedPhone && chat.id._serialized === adnMinerState.lastProcessedPhone) {
            adnMinerState.lastProcessedPhone = null;
            continue;
        }

        try {
            const messages = await chat.fetchMessages({ limit: 40 });
            const hasMarianoSpoken = messages.some(m => m.fromMe);
            if (!hasMarianoSpoken) continue;

            const contact = await chat.getContact();
            const contactName = contact.name || contact.pushname || "Lead Desconocido";
            const phoneStr = chat.id._serialized;
            const baseTarget = phoneStr.split('@')[0];

            // CLASIFICACIÓN INTERNA
            const isVenta = messages.some(m => m.fromMe && m.body.includes("Bienvenid@ a mejorar tu bienestar"));
            const isSilencio = !messages.some(m => !m.fromMe && m.timestamp > messages.find(msg => msg.fromMe)?.timestamp);
            const isDebate = messages.length > 20;

            const type = isVenta ? "VENTA" : (isDebate ? "DEBATE" : (isSilencio ? "SILENCIO" : "NEGOCIACIÓN"));

            if (isVenta && !clientesMedilink.find(c => c.phone === baseTarget)) {
                clientesMedilink.push({ phone: baseTarget, name: contactName, date: chat.timestamp * 1000 });
            }

            const chatLog = messages.map(m => `${m.fromMe ? 'Mariano' : 'Lead'}: ${m.body}`).join('\n');
            batchContext += `\n[TIPO: ${type}] Chat con ${contactName} (${phoneStr}):\n${chatLog}\n`;

            extractedCount++;
            adnMinerState.dailyCount++;
            adnMinerState.totalProcessed++;
            lastProcessedTimestamp = chat.timestamp;
            adnMinerState.lastProcessedPhone = phoneStr;

            adnMinerState.currentSearchDate = lastProcessedTimestamp;
            saveAdnMinerState();

            // GOTEO LENTO (2-3 segundos aleatorios)
            await new Promise(r => setTimeout(r, Math.floor(Math.random() * (3000 - 2000 + 1)) + 2000));
        } catch (e) { }
    }

    if (batchContext.length > 0) {
        console.log(`[CEREBRO ABSOLUTO] Enviando lote clasificado a Gemini...`);
        const prompt = `Analiza este lote de chats de Mariano (Julio 2023 - Actualidad). Clasificados por TIPO (VENTA, DEBATE, SILENCIO). Extrae su ADN de ventas actualizando su perfil psicológico. Responde en 1ra persona.\n\n${batchContext}`;
        const adnUpdate = await generateAIContent(prompt);
        trainingData += `\n\n[ACTUALIZACIÓN ADN CRONOLÓGICA ${todayStr}]\n${adnUpdate}\n`;
        saveDB();
    }

    console.log(`[CEREBRO ABSOLUTO] Ciclo diario finalizado. Procesados hoy: ${extractedCount}. Posición incremental guardada.`);
}

// Revisar la cola cada minuto
setInterval(processAntiSpamBatch, 60 * 1000);
setInterval(processADNMinerCron, 60 * 1000);

// Lanzar detección de Tier al arranque
console.log('[SYS] Esperando 10 segundos para estabilización nuclear...');
setTimeout(() => {
    console.log('[WA] Lanzando cliente de WhatsApp (CONSOLIDADO)...');
    client.initialize();
}, 10000);

const server = app.listen(PORT, () => console.log("[SYS] LOBSTERS v1 ONLINE"));
