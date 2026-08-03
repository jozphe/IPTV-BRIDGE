import { Request, Response } from 'express';
import { XtreamClient } from '../iptv/xtream';
import { parseM3UPlaylist } from '../iptv/m3u';
import axios from 'axios';

export async function handleTestConnection(req: Request, res: Response) {
  try {
    const { type, host, username, password, m3uUrl, tmdbApiKey } = req.body;

    let categories: any[] = [];
    let statusMessage = 'Connection successful!';
    let tmdbValid = false;

    // Test TMDB Key if provided
    if (tmdbApiKey) {
      try {
        const tmdbRes = await axios.get(`https://api.themoviedb.org/3/configuration?api_key=${tmdbApiKey}`, { timeout: 5000 });
        if (tmdbRes.data && tmdbRes.data.images) {
          tmdbValid = true;
        }
      } catch (e) {
        tmdbValid = false;
      }
    }

    if (type === 'xtream') {
      if (!host || !username || !password) {
        res.status(400).json({ success: false, error: 'Host, Username, and Password are required.' });
        return;
      }

      const client = new XtreamClient(host, username, password);
      const authData = await client.authenticate();
      categories = await client.getCategories();
      
      const userInfo = authData?.user_info;
      statusMessage = `Connected! User: ${userInfo?.username || username} (Status: ${userInfo?.status || 'Active'})`;

      res.json({
        success: true,
        message: statusMessage,
        categories,
        tmdbValid,
        userInfo: {
          username: userInfo?.username,
          status: userInfo?.status,
          expDate: userInfo?.exp_date ? new Date(parseInt(userInfo.exp_date, 10) * 1000).toLocaleDateString() : 'Unlimited',
          activeCons: `${userInfo?.active_cons || 0} / ${userInfo?.max_connections || '∞'}`
        }
      });
      return;
    } else if (type === 'm3u') {
      if (!m3uUrl) {
        res.status(400).json({ success: false, error: 'M3U Playlist URL is required.' });
        return;
      }

      const parsed = await parseM3UPlaylist(m3uUrl);
      res.json({
        success: true,
        message: `M3U Playlist parsed successfully! Found ${parsed.items.length} items across ${parsed.categories.length} categories.`,
        categories: parsed.categories,
        tmdbValid,
        totalItems: parsed.items.length
      });
      return;
    }

    res.status(400).json({ success: false, error: 'Invalid configuration type.' });
  } catch (err: any) {
    console.error('Test Connection Error:', err);
    res.status(500).json({
      success: false,
      error: err.message || 'Failed to connect to IPTV provider. Check URL or credentials.'
    });
  }
}
