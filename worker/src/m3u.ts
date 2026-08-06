// M3U / M3U8 playlist parser (fetch-based), ported from the Node addon.

import { cleanTitle } from './cleaner';
import { Genre, ProviderItem } from './types';

export interface ParsedM3U {
  categories: Genre[];
  items: ProviderItem[];
}

export async function parseM3UPlaylist(m3uUrl: string): Promise<ParsedM3U> {
  const res = await fetch(m3uUrl, { headers: { 'User-Agent': 'IPTVSmartersPro/3.0.0 (Cloudflare Worker; IPTV Bridge)' } });
  if (!res.ok) throw new Error(`Playlist fetch failed (${res.status})`);
  const content = await res.text();
  const lines = content.split(/\r?\n/);

  const items: ProviderItem[] = [];
  const categoriesMap = new Map<string, Genre>();
  let currentExtInf: string | null = null;

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (line.startsWith('#EXTINF:')) {
      currentExtInf = line;
    } else if (line && !line.startsWith('#') && currentExtInf) {
      const url = line;

      const groupTitleMatch = currentExtInf.match(/group-title="([^"]*)"/i);
      const categoryName = groupTitleMatch ? groupTitleMatch[1].trim() : 'General';
      const logoMatch = currentExtInf.match(/tvg-logo="([^"]*)"/i);
      const logo = logoMatch ? logoMatch[1].trim() : undefined;
      const tvgIdMatch = currentExtInf.match(/tvg-id="([^"]*)"/i);
      const tvgId = tvgIdMatch ? tvgIdMatch[1].trim() : undefined;

      const titleParts = currentExtInf.split(',');
      const rawTitle = titleParts.length > 1 ? titleParts.slice(1).join(',').trim() : 'Unknown';
      const cleaned = cleanTitle(rawTitle);

      let itemType: ProviderItem['type'] = 'channel';
      const catLower = categoryName.toLowerCase();
      if (cleaned.season !== undefined || catLower.includes('series') || catLower.includes('shows') || catLower.includes('season')) {
        itemType = 'series';
      } else if (catLower.includes('movie') || catLower.includes('vod') || catLower.includes('cinema') || url.endsWith('.mkv') || url.endsWith('.mp4')) {
        itemType = 'movie';
      }

      const categoryId = categoryName.toLowerCase().replace(/[^a-z0-9]+/g, '-');
      if (!categoriesMap.has(categoryId)) {
        categoriesMap.set(categoryId, { id: categoryId, name: categoryName });
      }

      items.push({
        id: tvgId || `m3u_${items.length + 1}`,
        title: rawTitle,
        cleanTitle: cleaned.cleanTitle,
        type: itemType,
        category: categoryName,
        logo,
        url,
        year: cleaned.year,
        season: cleaned.season,
        episode: cleaned.episode
      });

      currentExtInf = null;
    }
  }

  return { categories: Array.from(categoriesMap.values()), items };
}
