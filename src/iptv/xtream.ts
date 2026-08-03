import axios from 'axios';
import { IPTVItem, IPTVCategory } from '../types';
import { cleanTitle } from './cleaner';

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

      if (liveRes.status === 'fulfilled' && Array.isArray(liveRes.value.data)) {
        liveRes.value.data.forEach((cat: any) => {
          categories.push({ id: `live_${cat.category_id}`, name: cat.category_name, type: 'live' });
        });
      }

      if (vodRes.status === 'fulfilled' && Array.isArray(vodRes.value.data)) {
        vodRes.value.data.forEach((cat: any) => {
          categories.push({ id: `vod_${cat.category_id}`, name: cat.category_name, type: 'movie' });
        });
      }

      if (seriesRes.status === 'fulfilled' && Array.isArray(seriesRes.value.data)) {
        seriesRes.value.data.forEach((cat: any) => {
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
    let action = 'get_live_streams';
    if (type === 'movie') action = 'get_vod_streams';
    if (type === 'series') action = 'get_series_streams';

    let url = `${this.baseApiUrl}&action=${action}`;
    if (categoryId) {
      // Strip prefix if needed
      const rawCatId = categoryId.replace(/^(live|vod|series)_/, '');
      url += `&category_id=${encodeURIComponent(rawCatId)}`;
    }

    const response = await axios.get(url, {
      timeout: 12000,
      headers: { 'User-Agent': 'IPTVSmartersPro/3.0.0' }
    });

    if (!Array.isArray(response.data)) {
      return [];
    }

    return response.data.map((stream: any) => {
      const title = stream.name || 'Untitled Stream';
      const cleaned = cleanTitle(title);
      const streamId = stream.stream_id || stream.series_id;
      const ext = stream.container_extension || 'mp4';

      let streamUrl = '';
      if (type === 'live') {
        streamUrl = `${this.host}/live/${this.username}/${this.password}/${streamId}.m3u8`;
      } else if (type === 'movie') {
        streamUrl = `${this.host}/movie/${this.username}/${this.password}/${streamId}.${ext}`;
      } else {
        streamUrl = `${this.host}/series/${this.username}/${this.password}/${streamId}.${ext}`;
      }

      return {
        id: `xt_${type}_${streamId}`,
        streamId,
        title,
        cleanTitle: cleaned.cleanTitle,
        type: type === 'live' ? 'channel' : type,
        category: stream.category_name || type,
        logo: stream.stream_icon || stream.cover,
        url: streamUrl,
        year: cleaned.year || (stream.year ? parseInt(stream.year, 10) : undefined),
        containerExtension: ext
      };
    });
  }

  public async getSeriesEpisodes(seriesId: string | number): Promise<any> {
    const rawId = String(seriesId).replace(/^xt_series_/, '');
    const url = `${this.baseApiUrl}&action=get_series_info&series_id=${encodeURIComponent(rawId)}`;
    const response = await axios.get(url, { timeout: 10000 });
    return response.data;
  }

  public buildEpisodeUrl(episodeId: string | number, extension: string = 'mp4'): string {
    return `${this.host}/series/${this.username}/${this.password}/${episodeId}.${extension}`;
  }
}
