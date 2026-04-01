/**
 * MAIL SERVICE — Envío de notificaciones por email
 *
 * Soporta:
 * - SMTP tradicional (Gmail, Office 365, etc)
 * - SendGrid API (futuro)
 * - Firebase Cloud Email (futuro)
 */

'use strict';

const nodemailer = require('nodemailer');
const admin = require('firebase-admin');

let transporter = null;

/**
 * Inicializar transporter SMTP
 * Credenciales desde variables de entorno
 */
function initMailer() {
  const smtpHost = process.env.SMTP_HOST || '';
  const smtpPort = parseInt(process.env.SMTP_PORT || '587');
  const smtpUser = process.env.SMTP_USER || '';
  const smtpPass = process.env.SMTP_PASS || '';
  const smtpFrom = process.env.SMTP_FROM || 'noreply@miia.app';

  if (!smtpHost || !smtpUser || !smtpPass) {
    console.warn('[MAIL] ⚠️ SMTP no configurado. Variables vacías: SMTP_HOST, SMTP_USER, SMTP_PASS');
    return false;
  }

  try {
    transporter = nodemailer.createTransport({
      host: smtpHost,
      port: smtpPort,
      secure: smtpPort === 465,
      auth: {
        user: smtpUser,
        pass: smtpPass
      }
    });
    console.log('[MAIL] ✅ SMTP configurado correctamente');
    return true;
  } catch (e) {
    console.error('[MAIL] ❌ Error configurando SMTP:', e.message);
    return false;
  }
}

/**
 * Enviar notificación de desconexión WhatsApp
 * @param {string} uid - Firebase UID del usuario
 * @param {string} email - Email del usuario
 * @param {object} data - Información adicional (reason, recoveredAt, etc)
 */
async function sendSessionRecoveryEmail(uid, email, data = {}) {
  if (!transporter) {
    console.log('[MAIL] SMTP no disponible. Email NO enviado (pero registrado en Firestore)');
    return false;
  }

  const reason = data.reason || 'Sesión desincronizada por error criptográfico';
  const recoveredAt = data.recoveredAt || new Date().toISOString();
  const userName = data.userName || 'Usuario MIIA';

  const subject = '⚠️ Tu sesión de WhatsApp en MIIA fue reiniciada';
  const htmlBody = `
    <!DOCTYPE html>
    <html>
      <head>
        <meta charset="utf-8">
        <style>
          body { font-family: Inter, -apple-system, sans-serif; color: #333; line-height: 1.6; }
          .container { max-width: 600px; margin: 0 auto; padding: 20px; }
          .header { background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); color: white; padding: 20px; border-radius: 8px; text-align: center; }
          .content { padding: 20px; background: #f9fafb; border-radius: 8px; margin: 20px 0; }
          .alert { padding: 15px; background: #fff3cd; border-left: 4px solid #ffc107; border-radius: 4px; margin: 15px 0; }
          .code { font-family: monospace; padding: 10px; background: white; border: 1px solid #ddd; border-radius: 4px; }
          .footer { color: #666; font-size: 0.85rem; text-align: center; margin-top: 20px; }
          a { color: #667eea; text-decoration: none; }
        </style>
      </head>
      <body>
        <div class="container">
          <div class="header">
            <h1>🔔 Alerta de Sesión</h1>
          </div>

          <div class="content">
            <p>Hola <strong>${userName}</strong>,</p>

            <div class="alert">
              <strong>Tu sesión de WhatsApp en MIIA fue reiniciada automáticamente.</strong>
            </div>

            <h3>¿Qué pasó?</h3>
            <p>Detectamos una desincronización en tu sesión de WhatsApp (${reason}). Para tu seguridad, el sistema la limpió automáticamente.</p>

            <h3>¿Qué necesitas hacer?</h3>
            <ol>
              <li>Accede a tu <a href="https://miia-frontend.vercel.app/owner-dashboard.html">Dashboard de MIIA</a></li>
              <li>Haz clic en el botón <strong>"Conectar WhatsApp"</strong> en la sección <strong>Inicio</strong></li>
              <li>Escanea el código QR que aparecerá con tu teléfono</li>
              <li>¡Listo! Tu sesión estará reconectada</li>
            </ol>

            <h3>Detalles técnicos:</h3>
            <div class="code">
              <strong>UID:</strong> ${uid}<br>
              <strong>Razón:</strong> ${reason}<br>
              <strong>Reiniciada:</strong> ${new Date(recoveredAt).toLocaleString('es-CO')}
            </div>

            <p style="margin-top: 20px; color: #666;">Si no reconoces esta actividad, por favor contacta a soporte. Tu cuenta está segura.</p>
          </div>

          <div class="footer">
            <p>© 2026 MIIA - Asistente de Ventas IA | <a href="https://miia.app">miia.app</a></p>
          </div>
        </div>
      </body>
    </html>
  `;

  try {
    const info = await transporter.sendMail({
      from: process.env.SMTP_FROM || '"MIIA" <noreply@miia.app>',
      to: email,
      subject: subject,
      html: htmlBody
    });

    console.log(`[MAIL] ✅ Email enviado a ${email} (Message-ID: ${info.messageId})`);
    return true;
  } catch (error) {
    console.error(`[MAIL] ❌ Error enviando email a ${email}:`, error.message);
    return false;
  }
}

/**
 * Inicializar al cargar el módulo
 */
initMailer();

module.exports = {
  sendSessionRecoveryEmail,
  initMailer,
  isConfigured: () => !!transporter
};
