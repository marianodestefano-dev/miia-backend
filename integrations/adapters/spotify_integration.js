/**
 * Spotify Integration — Lanzamientos de artistas favoritos + recomendaciones.
 * API: Spotify Web API (requiere OAuth2 del usuario)
 * Proactivo: chequea nuevos releases de artistas seguidos.
 * Firestore prefs: miia_interests/spotify → { enabled, accessToken, refreshToken, tokenExpiry, favoriteArtists: [{id, name}] }
 */
const BaseIntegration = require('../base_integration');

const SPOTIFY_API = 'https://api.spotify.com/v1';
const SPOTIFY_TOKEN_URL = 'https://accounts.spotify.com/api/token';

class SpotifyIntegration extends BaseIntegration {
  constructor() {
    super({
      type: 'spotify',
      displayName: 'Spotify',
      emoji: '🎵',
      checkIntervalMs: 7200000 // 2 horas
    });
  }

  async _refreshToken(prefs, ctx) {
    const clientId = process.env.SPOTIFY_CLIENT_ID;
    const clientSecret = process.env.SPOTIFY_CLIENT_SECRET;
    if (!clientId || !clientSecret || !prefs.refreshToken) return null;

    try {
      const resp = await fetch(SPOTIFY_TOKEN_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'Authorization': 'Basic ' + Buffer.from(`${clientId}:${clientSecret}`).toString('base64')
        },
        body: `grant_type=refresh_token&refresh_token=${prefs.refreshToken}`,
        signal: AbortSignal.timeout(15000) // T16-FIX HIGH-2
      });

      if (!resp.ok) return null;
      const data = await resp.json();

      // Guardar nuevo token
      const newPrefs = {
        accessToken: data.access_token,
        tokenExpiry: Date.now() + (data.expires_in * 1000)
      };
      if (data.refresh_token) newPrefs.refreshToken = data.refresh_token;

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
    if (!prefs.enabled || !prefs.favoriteArtists?.length) return [];

    const token = await this._getToken(prefs, ctx);
    if (!token) {
      this._log('Sin token de Spotify — usuario debe autenticar');
      return [];
    }

    const messages = [];
    const lastChecked = prefs.lastChecked ? new Date(prefs.lastChecked) : new Date(Date.now() - 86400000);

    for (const artist of prefs.favoriteArtists.slice(0, 10)) {
      try {
        // Obtener últimos álbumes/singles
        const resp = await fetch(`${SPOTIFY_API}/artists/${artist.id}/albums?include_groups=album,single&limit=5&market=AR`, {
          headers: { 'Authorization': `Bearer ${token}` },
          signal: AbortSignal.timeout(15000) // T16-FIX HIGH-2
        });
        if (!resp.ok) continue;
        const data = await resp.json();

        for (const album of (data.items || [])) {
          const releaseDate = new Date(album.release_date);
          if (releaseDate > lastChecked) {
            const type = album.album_type === 'single' ? 'single' : 'álbum';
            const spotifyUrl = album.external_urls?.spotify || '';
            messages.push({
              message: `🎵 *${artist.name}* lanzó un ${type} nuevo:\n*${album.name}*${spotifyUrl ? `\n${spotifyUrl}` : ''}`,
              priority: 'medium'
            });
          }
        }
      } catch (e) {
        this._error(`Error chequeando ${artist.name}`, e);
      }
    }

    if (ctx.admin && ctx.ownerUid) {
      await this.savePrefs(ctx.admin, ctx.ownerUid, { lastChecked: new Date().toISOString() });
    }

    return messages;
  }
}

module.exports = SpotifyIntegration;
