import axios from 'axios';
import { IPTVItem, IPTVCategory } from '../types';
import { cleanTitle } from './cleaner';

export interface ParsedM3U {
  categories: IPTVCategory[];
  items: IPTVItem[];
}

export async function parseM3UPlaylist(m3uUrl: string, selectedCategories?: string[]): Promise<ParsedM3U> {
  const response = await axios.get(m3uUrl, {
    headers: {
      'User-Agent': 'IPTVSmartersPro/3.0.0 (Windows; IPTV Addon)'
    },
    timeout: 15000,
    responseType: 'text'
  });

  const content = response.data;
  const lines = content.split(/\r?\n/);

  const items: IPTVItem[] = [];
  const categoriesMap = new Map<string, IPTVCategory>();

  let currentExtInf: string | null = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();

    if (line.startsWith('#EXTINF:')) {
      currentExtInf = line;
    } else if (line && !line.startsWith('#') && currentExtInf) {
      const url = line;
      
      // Extract tvg attributes
      const groupTitleMatch = currentExtInf.match(/group-title="([^"]*)"/i);
      const categoryName = groupTitleMatch ? groupTitleMatch[1].trim() : 'General';

      const logoMatch = currentExtInf.match(/tvg-logo="([^"]*)"/i);
      const logo = logoMatch ? logoMatch[1].trim() : undefined;

      const tvgIdMatch = currentExtInf.match(/tvg-id="([^"]*)"/i);
      const tvgId = tvgIdMatch ? tvgIdMatch[1].trim() : undefined;

      // Extract raw title from end of EXTINF line
      const titleParts = currentExtInf.split(',');
      const rawTitle = titleParts.length > 1 ? titleParts.slice(1).join(',').trim() : 'Unknown';

      const cleaned = cleanTitle(rawTitle);

      // Determine item type based on group title or URL / S01E02 patterns
      let itemType: 'channel' | 'movie' | 'series' = 'channel';
      const catLower = categoryName.toLowerCase();

      if (cleaned.season !== undefined || catLower.includes('series') || catLower.includes('shows') || catLower.includes('season')) {
        itemType = 'series';
      } else if (catLower.includes('movie') || catLower.includes('vod') || catLower.includes('cinema') || url.endsWith('.mkv') || url.endsWith('.mp4')) {
        itemType = 'movie';
      }

      // Add category if not existing
      const categoryId = categoryName.toLowerCase().replace(/[^a-z0-9]+/g, '-');
      if (!categoriesMap.has(categoryId)) {
        categoriesMap.set(categoryId, {
          id: categoryId,
          name: categoryName,
          type: itemType === 'series' ? 'series' : itemType === 'movie' ? 'movie' : 'live'
        });
      }

      // Check category filter if provided
      if (!selectedCategories || selectedCategories.length === 0 || selectedCategories.includes(categoryId) || selectedCategories.includes(categoryName)) {
        const item: IPTVItem = {
          id: tvgId || `m3u_${items.length + 1}`,
          title: rawTitle,
          cleanTitle: cleaned.cleanTitle,
          type: itemType,
          category: categoryName,
          categoryId,
          logo,
          url,
          year: cleaned.year,
          season: cleaned.season,
          episode: cleaned.episode
        };

        items.push(item);
      }

      currentExtInf = null;
    }
  }

  return {
    categories: Array.from(categoriesMap.values()),
    items
  };
}
