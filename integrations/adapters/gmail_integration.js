/**
 * Gmail Integration — Resumen de emails urgentes/importantes.
 * API: Gmail API (googleapis) — requiere OAuth2 del usuario.
 * Proactivo: resumen matutino de emails sin leer importantes.
 * Firestore prefs: miia_interests/gmail → { enabled, accessToken, refreshToken, tokenExpiry, morningDigest: true, digestTime: "08:00", importantSenders: [] }
 */
const BaseIntegration = require('../base_integration');

const GMAIL_API = 'https://gmail.googleapis.com/gmail/v1/users/me';
const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';

class GmailIntegration extends BaseIntegration {
  constructor() {
    super({
      type: 'gmail',
      displayName: 'Gmail',
      emoji: '📧',
      checkIntervalMs: 3600000 // 1 hora
    });
    this._lastDigestDate = null;
  }

  async _refreshToken(prefs, ctx) {
    const clientId = process.env.GOOGLE_CLIENT_ID;
    const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
    if (!clientId || !clientSecret || !prefs.refreshToken) return null;

    try {
      const resp = await fetch(GOOGLE_TOKEN_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: `client_id=${clientId}&client_secret=${clientSecret}&refresh_token=${prefs.refreshToken}&grant_type=refresh_token`,
        signal: AbortSignal.timeout(15000) // T16-FIX HIGH-2
      });

      if (!resp.ok) {
        const errBody = await resp.text().catch(() => '');
        console.warn(`[GMAIL] ⚠️ Token refresh falló: ${resp.status} ${resp.statusText} — ${errBody.substring(0, 200)}`);
        return null;
      }
      const data = await resp.json();

      const newPrefs = {
        accessToken: data.access_token,
        tokenExpiry: Date.now() + (data.expires_in * 1000)
      };

      if (ctx.admin && ctx.ownerUid) {
        await this.savePrefs(ctx.admin, ctx.ownerUid, newPrefs);
      }

      return data.access_token;
    } catch (e) {
      this._error('Error refrescando token', e);
      return null;
    }
  }

  async _getToken(prefs, ctx) {
    if (prefs.accessToken && prefs.tokenExpiry && Date.now() < prefs.tokenExpiry) {
      return prefs.accessToken;
    }
    return await this._refreshToken(prefs, ctx);
  }

  async check(prefs, ctx) {
    if (!prefs.enabled || !prefs.morningDigest) return [];

    const tz = prefs.timezone || 'America/Bogota';
    const localNow = new Date(new Date().toLocaleString('en-US', { timeZone: tz }));
    const h = localNow.getHours();
    const todayStr = localNow.toISOString().split('T')[0];

    if (this._lastDigestDate === todayStr) return [];
    const digestHour = parseInt(prefs.digestTime?.split(':')[0]) || 8;
    if (h < digestHour || h > digestHour + 1) return [];

    const token = await this._getToken(prefs, ctx);
    if (!token) {
      this._log('Sin token de Gmail — usuario debe autenticar');
      return [];
    }

    try {
      // Buscar emails sin leer de las últimas 24h
      const after = Math.floor((Date.now() - 86400000) / 1000);
      const query = `is:unread after:${after}${prefs.importantSenders?.length ? ` from:(${prefs.importantSenders.join(' OR ')})` : ' is:important'}`;

      const listResp = await fetch(`${GMAIL_API}/messages?q=${encodeURIComponent(query)}&maxResults=10`, {
        headers: { 'Authorization': `Bearer ${token}` },
        signal: AbortSignal.timeout(15000) // T16-FIX HIGH-2
      });

      if (!listResp.ok) {
        this._error('Error listando emails', { message: `${listResp.status}` });
        return [];
      }

      const listData = await listResp.json();
      const messageIds = listData.messages || [];

      if (messageIds.length === 0) {
        this._lastDigestDate = todayStr;
        return [];
      }

      // Obtener headers de cada email (subject, from)
      const emailSummaries = [];
      for (const msg of messageIds.slice(0, 5)) {
        try {
          const msgResp = await fetch(`${GMAIL_API}/messages/${msg.id}?format=metadata&metadataHeaders=Subject&metadataHeaders=From`, {
            headers: { 'Authorization': `Bearer ${token}` },
            signal: AbortSignal.timeout(15000) // T16-FIX HIGH-2
          });
          if (!msgResp.ok) continue;
          const msgData = await msgResp.json();

          const headers = msgData.payload?.headers || [];
          const subject = headers.find(h => h.name === 'Subject')?.value || '(sin asunto)';
          const from = headers.find(h => h.name === 'From')?.value || 'desconocido';
          const fromName = from.split('<')[0].trim() || from;

          emailSummaries.push(`• *${fromName}*: ${subject}`);
        } catch (emailErr) { console.warn(`[GMAIL] ⚠️ Error parseando email: ${emailErr.message}`); }
      }

      this._lastDigestDate = todayStr;

      if (emailSummaries.length === 0) return [];

      const total = messageIds.length;
      const shown = emailSummaries.length;
      const moreText = total > shown ? `\n_...y ${total - shown} más._` : '';

      return [{
        message: `📧 *Resumen de emails (${total} sin leer)*\n${emailSummaries.join('\n')}${moreText}`,
        priority: 'medium'
      }];
    } catch (e) {
      this._error('Error en digest', e);
      return [];
    }
  }
}

module.exports = GmailIntegration;
