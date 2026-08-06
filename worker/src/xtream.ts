// Xtream Codes API client using the global fetch() only — no axios / node http.

const UA = 'IPTVSmartersPro/3.0.0 (Cloudflare Worker; IPTV Bridge)';

export interface XtreamCategory {
  category_id: string;
  category_name: string;
}

export interface RawStream {
  stream_id?: number | string;
  series_id?: number | string;
  name?: string;
  title?: string;
  stream_icon?: string;
  cover?: string;
  movie_image?: string;
  category_id?: string | number;
  category_name?: string;
  container_extension?: string;
  year?: string | number;
  releaseDate?: string;
  release_date?: string;
  plot?: string;
  backdrop_path?: string[] | string;
}

function normalizeHost(host: string): string {
  let h = (host || '').trim();
  if (!h.startsWith('http://') && !h.startsWith('https://')) h = `http://${h}`;
  return h.replace(/\/+$/, '');
}

async function getJson(url: string, timeoutMs = 15000): Promise<any> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { headers: { 'User-Agent': UA }, signal: ctrl.signal });
    if (!res.ok) throw new Error(`Upstream ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

function unwrap(data: any, key: string): any[] {
  if (Array.isArray(data)) return data;
  if (Array.isArray(data?.[key])) return data[key];
  if (data && typeof data === 'object') {
    const values = Object.values(data);
    if (values.length && values.every((v) => v && typeof v === 'object')) return values as any[];
  }
  return [];
}

export class XtreamClient {
  readonly host: string;
  private readonly username: string;
  private readonly password: string;

  constructor(host: string, username: string, password: string) {
    this.host = normalizeHost(host);
    this.username = (username || '').trim();
    this.password = (password || '').trim();
  }

  static fromCredentials(host: string, username: string, password: string): XtreamClient {
    return new XtreamClient(host, username, password);
  }

  private get base(): string {
    return `${this.host}/player_api.php?username=${encodeURIComponent(this.username)}&password=${encodeURIComponent(this.password)}`;
  }

  async authenticate(): Promise<any> {
    const data = await getJson(this.base, 10000);
    if (data?.user_info?.status === 'Disabled') throw new Error('Xtream account disabled');
    return data;
  }

  async getCategories(kind: 'live' | 'movie' | 'series'): Promise<XtreamCategory[]> {
    const action =
      kind === 'live' ? 'get_live_categories' : kind === 'movie' ? 'get_vod_categories' : 'get_series_categories';
    const data = await getJson(`${this.base}&action=${action}`, 12000);
    return unwrap(data, 'categories').map((c: any) => ({
      category_id: String(c.category_id),
      category_name: c.category_name || 'Uncategorized'
    }));
  }

  async getStreams(kind: 'live' | 'movie' | 'series'): Promise<RawStream[]> {
    const action = kind === 'live' ? 'get_live_streams' : kind === 'movie' ? 'get_vod_streams' : 'get_series';
    const data = await getJson(`${this.base}&action=${action}`, 20000);
    if (Array.isArray(data)) return data;
    if (Array.isArray(data?.streams)) return data.streams;
    return [];
  }

  async getSeriesInfo(seriesId: string | number): Promise<any> {
    const rawId = String(seriesId).replace(/^xt_series_/, '');
    const data = await getJson(`${this.base}&action=get_series_info&series_id=${encodeURIComponent(rawId)}`, 15000);
    return data?.series_id || data?.episodes || data?.info ? data : {};
  }

  /** Resolve playable episode URLs for series + season + episode. */
  async getEpisodeStreams(
    seriesId: string | number,
    season: number,
    episode: number
  ): Promise<Array<{ url: string; title: string; quality?: string }>> {
    const info = await this.getSeriesInfo(seriesId);
    const bySeason = info?.episodes;
    if (!bySeason) return [];
    const list: any[] = bySeason[String(season)] || bySeason[season] || [];
    const out: Array<{ url: string; title: string; quality?: string }> = [];
    for (const ep of list) {
      if (parseInt(String(ep.episode_num), 10) !== episode) continue;
      const ext = ep.container_extension || 'mp4';
      out.push({
        url: this.episodeUrl(ep.id, ext),
        title: ep.title || `Episode ${episode}`,
        quality: ep.info?.video?.height ? `${ep.info.video.height}p` : undefined
      });
    }
    return out;
  }

  /** All provider episodes for a series with ready-to-play URLs. */
  async listAllEpisodes(
    seriesId: string | number
  ): Promise<Array<{ season: number; episode: number; title: string; url: string; quality?: string; released?: string; overview?: string; thumbnail?: string }>> {
    const info = await this.getSeriesInfo(seriesId);
    const bySeason = info?.episodes;
    if (!bySeason || typeof bySeason !== 'object') return [];
    const out: Array<{ season: number; episode: number; title: string; url: string; quality?: string; released?: string; overview?: string; thumbnail?: string }> = [];
    for (const seasonKey of Object.keys(bySeason)) {
      for (const ep of bySeason[seasonKey] || []) {
        const episode = parseInt(String(ep.episode_num), 10);
        if (!Number.isFinite(episode)) continue;
        const season = parseInt(String(ep.season ?? seasonKey), 10) || 1;
        const ext = ep.container_extension || 'mp4';
        out.push({
          season,
          episode,
          title: ep.title || `Episode ${episode}`,
          url: this.episodeUrl(ep.id, ext),
          quality: ep.info?.video?.height ? `${ep.info.video.height}p` : undefined,
          released: ep.info?.releasedate ? `${ep.info.releasedate}T00:00:00.000Z` : undefined,
          overview: ep.info?.plot || undefined,
          thumbnail: ep.info?.movie_image || undefined
        });
      }
    }
    return out;
  }

  movieUrl(streamId: string | number, ext = 'mp4'): string {
    return `${this.host}/movie/${this.username}/${this.password}/${streamId}.${ext}`;
  }

  liveUrl(streamId: string | number): string {
    return `${this.host}/live/${this.username}/${this.password}/${streamId}.m3u8`;
  }

  episodeUrl(episodeId: string | number, ext = 'mp4'): string {
    return `${this.host}/series/${this.username}/${this.password}/${episodeId}.${ext}`;
  }
}
