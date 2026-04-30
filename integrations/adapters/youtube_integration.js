/**
 * YouTube Integration — Avisa al owner cuando sus canales favoritos publican videos nuevos.
 * API: YouTube Data API v3 (gratis, 10,000 quota/día)
 * Firestore prefs: miia_interests/youtube → { channels: [{id, name}], lastChecked, apiKey }
 */
const BaseIntegration = require('../base_integration');

class YouTubeIntegration extends BaseIntegration {
  constructor() {
    super({
      type: 'youtube',
      displayName: 'YouTube',
      emoji: '📺',
      checkIntervalMs: 3600000 // 1 hora
    });
  }

  async check(prefs, ctx) {
    if (!prefs.channels || prefs.channels.length === 0) return [];
    const apiKey = prefs.apiKey || process.env.YOUTUBE_API_KEY;
    if (!apiKey) {
      this._log('Sin API key configurada');
      return [];
    }

    const messages = [];
    const lastChecked = prefs.lastChecked ? new Date(prefs.lastChecked) : new Date(Date.now() - 86400000);
    const publishedAfter = lastChecked.toISOString();

    for (const channel of prefs.channels.slice(0, 10)) { // Max 10 canales
      try {
        const url = `https://www.googleapis.com/youtube/v3/search?part=snippet&channelId=${channel.id}&order=date&publishedAfter=${publishedAfter}&maxResults=3&type=video&key=${apiKey}`;
        const resp = await fetch(url, { signal: AbortSignal.timeout(15000) }); // T16-FIX HIGH-2
        if (!resp.ok) {
          this._error(`API error para ${channel.name}`, { message: `${resp.status}` });
          continue;
        }
        const data = await resp.json();
        const videos = data.items || [];

        for (const video of videos) {
          const title = video.snippet.title;
          const videoId = video.id.videoId;
          const channelName = channel.name || video.snippet.channelTitle;
          messages.push({
            message: `📺 *${channelName}* subió un video nuevo:\n*${title}*\nhttps://youtu.be/${videoId}`,
            priority: 'medium'
          });
        }
      } catch (e) {
        this._error(`Error chequeando ${channel.name}`, e);
      }
    }

    // Actualizar lastChecked
    if (ctx.admin && ctx.ownerUid) {
      await this.savePrefs(ctx.admin, ctx.ownerUid, { lastChecked: new Date().toISOString() });
    }

    return messages;
  }
}

module.exports = YouTubeIntegration;
