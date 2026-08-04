import axios from 'axios';
import { IPTVItem, IPTVCategory } from '../types';
import { cleanTitle } from './cleaner';

function unwrapArray(data: any, key: string): any[] {
  if (Array.isArray(data)) return data;
  if (Array.isArray(data?.[key])) return data[key];
  if (data && typeof data === 'object') {
    const values = Object.values(data);
    if (values.length && values.every((value) => value && typeof value === 'object')) return values;
  }
  return [];
}

export class XtreamClient {
  private host: string;
  private username: string;
  private password: string;

  constructor(host: string, username: string, password: string) {
    // Normalize host
    let cleanHost = host.trim();
    if (!cleanHost.startsWith('http://') && !cleanHost.startsWith('https://')) {
      cleanHost = `http://${cleanHost}`;
    }
    this.host = cleanHost.replace(/\/+$/, '');
    this.username = username.trim();
    this.password = password.trim();
  }

  private get baseApiUrl(): string {
    return `${this.host}/player_api.php?username=${encodeURIComponent(this.username)}&password=${encodeURIComponent(this.password)}`;
  }

  public async authenticate(): Promise<{ user_info: any; server_info: any }> {
    const response = await axios.get(this.baseApiUrl, {
      timeout: 10000,
      headers: { 'User-Agent': 'IPTVSmartersPro/3.0.0 (Windows; IPTV Addon)' }
    });
    if (response.data?.user_info?.status === 'Disabled') {
      throw new Error('Xtream Codes account is disabled');
    }
    return response.data;
  }

  public async getCategories(): Promise<IPTVCategory[]> {
    const categories: IPTVCategory[] = [];

    try {
      const [liveRes, vodRes, seriesRes] = await Promise.allSettled([
        axios.get(`${this.baseApiUrl}&action=get_live_categories`, { timeout: 10000 }),
        axios.get(`${this.baseApiUrl}&action=get_vod_categories`, { timeout: 10000 }),
        axios.get(`${this.baseApiUrl}&action=get_series_categories`, { timeout: 10000 })
      ]);

      const liveData = liveRes.status === 'fulfilled' ? unwrapArray(liveRes.value.data, 'categories') : [];
      const vodData = vodRes.status === 'fulfilled' ? unwrapArray(vodRes.value.data, 'categories') : [];
      const seriesData = seriesRes.status === 'fulfilled' ? unwrapArray(seriesRes.value.data, 'categories') : [];

      if (liveData.length) {
        liveData.forEach((cat: any) => {
          categories.push({ id: `live_${cat.category_id}`, name: cat.category_name, type: 'live' });
        });
      }

      if (vodData.length) {
        vodData.forEach((cat: any) => {
          categories.push({ id: `vod_${cat.category_id}`, name: cat.category_name, type: 'movie' });
        });
      }

      if (seriesData.length) {
        seriesData.forEach((cat: any) => {
          categories.push({ id: `series_${cat.category_id}`, name: cat.category_name, type: 'series' });
        });
      }
    } catch (err) {
      console.error('Failed to fetch Xtream categories:', err);
    }

    return categories;
  }

  public async getStreams(
    type: 'live' | 'movie' | 'series',
    categoryId?: string
  ): Promise<IPTVItem[]> {
    // NOTE: Xtream Codes uses `get_series` (not `get_series_streams`) for the
    // series list endpoint. Using the wrong action returns an empty body, which
    // is why series never appeared.
    let action = 'get_live_streams';
    if (type === 'movie') action = 'get_vod_streams';
    if (type === 'series') action = 'get_series';

    let url = `${this.baseApiUrl}&action=${action}`;
    if (categoryId) {
      // Strip prefix if needed
      const rawCatId = categoryId.replace(/^(live|vod|series)_/, '');
      url += `&category_id=${encodeURIComponent(rawCatId)}`;
    }

    const response = await axios.get(url, {
      timeout: 15000,
      headers: { 'User-Agent': 'IPTVSmartersPro/3.0.0' }
    });

    // A few Xtream panels return an object with a `streams` field, while most
    // return the array directly.
    const rawStreams = Array.isArray(response.data)
      ? response.data
      : Array.isArray(response.data?.streams)
        ? response.data.streams
        : [];

    if (!rawStreams.length) {
      return [];
    }

    return rawStreams.map((stream: any) => {
      const title = stream.name || stream.title || 'Untitled Stream';
      const cleaned = cleanTitle(title);
      const streamId = stream.stream_id ?? stream.series_id;
      const ext = stream.container_extension || 'mp4';

      // Series entries have no direct playable URL; episodes are resolved on
      // demand via get_series_info. Movies/live get a direct URL.
      let streamUrl = '';
      if (type === 'live') {
        streamUrl = `${this.host}/live/${this.username}/${this.password}/${streamId}.m3u8`;
      } else if (type === 'movie') {
        streamUrl = `${this.host}/movie/${this.username}/${this.password}/${streamId}.${ext}`;
      }

      const rawYear = stream.year || stream.releaseDate || stream.release_date;

      return {
        id: `xt_${type}_${streamId}`,
        streamId,
        title,
        cleanTitle: cleaned.cleanTitle,
        type: type === 'live' ? 'channel' : type,
        category: stream.category_name || String(stream.category_id || type),
        logo: stream.stream_icon || stream.cover || stream.movie_image,
        url: streamUrl,
        year: cleaned.year || (rawYear ? parseInt(String(rawYear).substring(0, 4), 10) : undefined),
        containerExtension: ext
      };
    });
  }

  public async getSeriesInfo(seriesId: string | number): Promise<any> {
    const rawId = String(seriesId).replace(/^xt_series_/, '');
    const url = `${this.baseApiUrl}&action=get_series_info&series_id=${encodeURIComponent(rawId)}`;
    const response = await axios.get(url, {
      timeout: 15000,
      headers: { 'User-Agent': 'IPTVSmartersPro/3.0.0' }
    });
    return response.data?.series_id || response.data?.episodes ? response.data : {};
  }

  /**
   * Resolve the playable episode URLs for a given series + season + episode.
   * Returns an array (a season/episode can have multiple quality variants).
   */
  public async getEpisodeStreams(
    seriesId: string | number,
    season: number,
    episode: number
  ): Promise<Array<{ url: string; title: string; quality?: string }>> {
    const info = await this.getSeriesInfo(seriesId);
    const episodesBySeason = info?.episodes;
    if (!episodesBySeason) return [];

    const seasonKey = String(season);
    const list: any[] = episodesBySeason[seasonKey] || episodesBySeason[Number(seasonKey)] || [];
    const out: Array<{ url: string; title: string; quality?: string }> = [];

    for (const ep of list) {
      const epNum = parseInt(String(ep.episode_num), 10);
      if (epNum !== episode) continue;
      const ext = ep.container_extension || 'mp4';
      out.push({
        url: `${this.host}/series/${this.username}/${this.password}/${ep.id}.${ext}`,
        title: ep.title || `Episode ${episode}`,
        quality: ep.info?.video?.height ? `${ep.info.video.height}p` : undefined
      });
    }
    return out;
  }

  /** List all provider episodes with ready-to-play URLs. */
  public async listAllEpisodes(
    seriesId: string | number
  ): Promise<Array<{ season: number; episode: number; title: string; url: string; quality?: string }>> {
    const info = await this.getSeriesInfo(seriesId);
    const episodesBySeason = info?.episodes;
    if (!episodesBySeason || typeof episodesBySeason !== 'object') return [];

    const out: Array<{ season: number; episode: number; title: string; url: string; quality?: string }> = [];
    for (const seasonKey of Object.keys(episodesBySeason)) {
      const list: any[] = episodesBySeason[seasonKey] || [];
      for (const ep of list) {
        const episode = parseInt(String(ep.episode_num), 10);
        if (!Number.isFinite(episode)) continue;
        const season = parseInt(String(ep.season ?? seasonKey), 10) || 1;
        const ext = ep.container_extension || 'mp4';
        out.push({
          season,
          episode,
          title: ep.title || `Episode ${episode}`,
          url: `${this.host}/series/${this.username}/${this.password}/${ep.id}.${ext}`,
          quality: ep.info?.video?.height ? `${ep.info.video.height}p` : undefined
        });
      }
    }
    return out;
  }

  public buildEpisodeUrl(episodeId: string | number, extension: string = 'mp4'): string {
    return `${this.host}/series/${this.username}/${this.password}/${episodeId}.${extension}`;
  }
}
