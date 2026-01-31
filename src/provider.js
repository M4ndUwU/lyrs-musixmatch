import { z } from 'zod';
import makeCookieFetch from 'fetch-cookie';
import { hangulize } from './hangulize/index.js';

const cookieFetch = makeCookieFetch(fetch);
const cacheTable = {};
const TRANSLATION_CACHE_MAX = 500;
const translationCache = {}; // ja -> ko 캐시 (번역 API 호출 절감)
const translationCacheOrder = []; // LRU용

// 커버/歌ってみた 등 문구 제거 후 원곡 제목·아티스트 추출 (다양한 표기 대응)
const LEADING_COVER = /^【?(?:歌ってみた|踊ってみた|演奏してみた)】?\s*[・\-:]?\s*/i;
const TRAILING_COVER_PATTERNS = [
  /\s*／\s*[^／\n]+?\s*【歌ってみた】\s*$/i,
  /\s*\/\s*Cover\s*:\s*[^/\n]+$/i,
  /\s*[┃｜]\s*Cover\s+by\s+[^\n]+$/i,
  /\s*\/\s*Cover\s+by\s+[^/\n]+$/i,
  /\s+Cover\s+by\s+[^\n]+$/i,
  /\s*\/\s*covered\s+by\s+[^/\n]+$/i,
  /\s+covered\s+by\s+[^\n]+$/i,
  /\s*【[^】]*\/[^】]*】\s*$/,  // 【レイン・パターソン/にじさんじ】 등
  /\s*【歌ってみた】\s*$/i,
];
const PAREN_ARTIST = /^(.+?)[\（\(]([^）\)]+)[\）\)]\s*$/;  // Title（Artist） 또는 Title(Artist)
const SLASH_SEP = /\s*\/\s*/;   // Artist / Title
const DASH_SEP = /\s*-\s*/;     // Title - Artist (앞이 제목, 뒤가 아티스트인 경우)

function stripCoverMarkers(str) {
  if (!str || typeof str !== 'string') return '';
  let s = str.trim();
  s = s.replace(LEADING_COVER, '');
  for (const p of TRAILING_COVER_PATTERNS) {
    s = s.replace(p, '');
  }
  return s.replace(/\s+/g, ' ').trim();
}

function extractOriginalTrack(title, artist) {
  if (!title && !artist) return { title: '', artist: '' };
  let t = stripCoverMarkers(title || '');
  let a = stripCoverMarkers(artist || '');
  if (!t && !a) return { title: title || '', artist: artist || '' };

  const combined = [t, a].filter(Boolean).join(' / ');
  const stripped = stripCoverMarkers(combined);
  if (!stripped) return { title: t || title, artist: a || artist };

  let outTitle = '';
  let outArtist = '';

  const parts = stripped.split(SLASH_SEP).map(s => s.trim()).filter(Boolean);
  if (parts.length >= 2) {
    const left = parts[0];
    const right = parts.slice(1).join(' / ');
    const matchLeft = left.match(PAREN_ARTIST);
    if (matchLeft) {
      outTitle = matchLeft[1].trim();
      outArtist = matchLeft[2].trim();
    } else if (/[\（\(]/.test(right) && left.length <= 20 && !/[\（\(]/.test(left)) {
      outTitle = right;
      outArtist = left;
    } else {
      outTitle = left;
      outArtist = right;
    }
  } else {
    const single = parts[0] || stripped;
    const match = single.match(PAREN_ARTIST);
    if (match) {
      outTitle = match[1].trim();
      outArtist = match[2].trim();
    } else {
      const dashParts = single.split(DASH_SEP).map(s => s.trim()).filter(Boolean);
      if (dashParts.length >= 2) {
        outTitle = dashParts[0];
        outArtist = dashParts[1];
      } else {
        outTitle = single;
        outArtist = a || '';
      }
    }
  }

  if (!outTitle) outTitle = t || title || '';
  if (!outArtist) outArtist = a || artist || '';
  return { title: outTitle.replace(/\s+/g, ' ').trim(), artist: outArtist.replace(/\s+/g, ' ').trim() };
}

const LyricResponseSchema = z.object({
  id: z.number(),
  name: z.string(),
  trackName: z.string(),
  artistName: z.string(),
  albumName: z.string(),
  duration: z.number(), // in seconds not ms
  instrumental: z.boolean().optional(),
  plainLyrics: z.string(),
  syncedLyrics: z.string().nullable(), // [mm:ss.xx] lyrics\n ...
});

const MYMEMORY_URL = 'https://api.mymemory.translated.net/get';

export class MusixMatchLyricProvider {
  constructor(_config, logger, getShowKoreanPronunciation, getExtractOriginalTrack, getUseTranslationWhenNoKorean) {
    const [config, setConfig] = _config;
    this.name = 'MusixMatch';
    this.usertoken = "";
    this._updatingUserTokenPromise = null;
    this.targetLanguage = "ko";
    this._config = _config;
    this.getShowKoreanPronunciation = typeof getShowKoreanPronunciation === 'function' ? getShowKoreanPronunciation : () => true;
    this.getExtractOriginalTrack = typeof getExtractOriginalTrack === 'function' ? getExtractOriginalTrack : () => true;
    this.getUseTranslationWhenNoKorean = typeof getUseTranslationWhenNoKorean === 'function' ? getUseTranslationWhenNoKorean : () => true;
    this.getConfig = () => ({
      showKoreanPronunciation: this.getShowKoreanPronunciation(),
      extractOriginalTrack: this.getExtractOriginalTrack(),
      useTranslationWhenNoKorean: this.getUseTranslationWhenNoKorean(),
      ...config(),
    });
    this.setConfig = setConfig;
    this.logger = logger;
  }

  /** 일본어 → 한국어 번역 (한국어 가사 없을 때). MyMemory API 사용, LRU 캐시 적용. */
  async translateJaToKo(text) {
    if (!text || typeof text !== 'string') return null;
    const key = text.trim();
    if (!key) return null;
    if (translationCache[key]) {
      const idx = translationCacheOrder.indexOf(key);
      if (idx >= 0) {
        translationCacheOrder.splice(idx, 1);
        translationCacheOrder.push(key);
      }
      return translationCache[key];
    }
    try {
      const url = `${MYMEMORY_URL}?q=${encodeURIComponent(key)}&langpair=ja|ko`;
      const res = await fetch(url);
      const json = await res.json();
      const translated = json?.responseData?.translatedText;
      if (translated) {
        if (translationCacheOrder.length >= TRANSLATION_CACHE_MAX) {
          const oldest = translationCacheOrder.shift();
          delete translationCache[oldest];
        }
        translationCache[key] = translated;
        translationCacheOrder.push(key);
        return translated;
      }
    } catch (e) {
      this.logger?.warn?.('[Lyrs] [MusixMatch] Translation API failed', e?.message);
    }
    return null;
  }

  async getUserToken() {
    const config = this.getConfig();
    this.targetLanguage = config.language || "ko";
    this.usertoken = config.musixMatchToken
    if (this.usertoken) return this.usertoken;
    if (!this._updatingUserTokenPromise) {
      this.logger.info('[Lyrs] [MusixMatch] Fetching user token...');
      this._updatingUserTokenPromise = this._updateUserToken();
    }
    return await this._updatingUserTokenPromise;
  }

  async _updateUserToken() {
    const res = await cookieFetch("https://apic.musixmatch.com/ws/1.1/token.get?app_id=mac-ios-v2.0")
    const json = await res.json()
    if (!json || !json.message || json.message.header.status_code !== 200) {
      throw new Error('Failed to fetch user token from MusixMatch');
    }
    this.usertoken = json.message.body.user_token;
    this.setConfig({ musixMatchToken: this.usertoken });
    return this.usertoken;
  }

  async getLyricById(id) {
    if (cacheTable[id]) {
      this.logger.info("[Lyrs] [MusixMatch] Returning cached lyric for ID (applying current settings)", id);
      return await this.buildResultFromRaw(cacheTable[id]);
    }
    const query = new URLSearchParams();
    query.set('commontrack_id', this.encode(id));
    query.set('usertoken', this.encode(await this.getUserToken()));
    query.set('app_id', this.encode("mac-ios-v2.0"));
    this.logger.info("[LYRS] [MusixMatch] Fetching lyric by ID", id, query.toString());

    const response = await cookieFetch(`https://apic.musixmatch.com/ws/1.1/macro.subtitles.get?${query.toString()}`);
    const json = await response.json();
    const success = json.message?.body?.macro_calls?.['track.lyrics.get']?.message?.header?.status_code === 200;
    if (!success) {
      this.logger.warn('[Lyrs] [MusixMatch] Failed to fetch lyrics', json);
      return null;
    }
    const parsed = await this.musixmatchMacroToLyricScheme(json);
    if (!parsed.success) return null;

    const lyric = parsed.data[0];
    if (!lyric.syncedLyrics) return null;

    const isJaSub = json.message?.body?.macro_calls?.['track.subtitles.get']?.message?.body?.subtitle_list?.[0]?.subtitle?.subtitle_language === "ja";

    let translations = [];
    const translationResponse = await cookieFetch(`https://apic.musixmatch.com/ws/1.1/crowd.track.translations.get?app_id=mac-ios-v2.0&usertoken=${this.encode(await this.getUserToken())}&commontrack_id=${this.encode(lyric.id.toString())}&selected_language=${(this.getConfig().language || this.targetLanguage)}`);
    const translationJson = await translationResponse.json();
    if (translationJson.message?.header?.status_code === 200) {
      translations = translationJson.message?.body?.translations_list || [];
    } else {
      this.logger.warn('[Lyrs] [MusixMatch] Failed to fetch translation', translationJson);
    }

    const raw = { lyric, syncedLyrics: lyric.syncedLyrics, translations, isJaSub };
    cacheTable[id] = raw;
    return await this.buildResultFromRaw(raw);
  }

  async getLyric(params) {
    if (params.page && params.page > 1) return null;
    const cfg = this.getConfig();
    const useExtract = cfg.extractOriginalTrack !== false;
    const extracted = useExtract ? extractOriginalTrack(params.title || "", params.artist || "") : { title: params.title || "", artist: params.artist || "" };
    const searchTitle = extracted.title || params.title || "";
    const searchArtist = extracted.artist || params.artist || "";
    if (useExtract && (searchTitle !== (params.title || "") || searchArtist !== (params.artist || ""))) {
      this.logger.info("[Lyrs] [MusixMatch] Extracted original track for search", { original: params, extracted: { title: searchTitle, artist: searchArtist } });
    }
    const cacheKey = [params.page, searchTitle, searchArtist].filter(Boolean).join('|');
    if (cacheTable[cacheKey]) {
      this.logger.info("[Lyrs] [MusixMatch] Returning cached lyric for params (applying current settings)", params);
      return await this.buildResultFromRaw(cacheTable[cacheKey]);
    }

    const query = new URLSearchParams();
    query.set('usertoken', this.encode(await this.getUserToken()));
    query.set('app_id', this.encode("mac-ios-v2.0"));
    const isrc = await this.getIsrc(searchTitle, searchArtist);
    if (!isrc) {
      this.logger.warn('[Lyrs] [MusixMatch] No isrc ID found for search', params);
      return null;
    }
    query.set('track_isrc', this.encode(isrc || ""));
    this.logger.info("[Lyrs] [MusixMatch] Fetching lyrics with query", query.toString());

    const response = await cookieFetch(`https://apic.musixmatch.com/ws/1.1/macro.subtitles.get?${query.toString()}`);
    const json = await response.json();
    const success = json.message?.body?.macro_calls?.['track.lyrics.get']?.message?.header?.status_code === 200;
    if (!success) {
      this.logger.warn('[Lyrs] [MusixMatch] Failed to fetch lyrics', json);
      return null;
    }
    const parsed = await this.musixmatchMacroToLyricScheme(json);
    if (!parsed.success) {
      this.logger.warn('[Lyrs] [MusixMatch] Failed to parse search response', parsed.error);
      return null;
    }

    const lyric = parsed.data[0];
    this.logger.info("[LYRS] [MusixMatch] Fetched lyric", lyric);
    if (!lyric.syncedLyrics) return null;
    this.logger.info("[LYRS] [MusixMatch] Synced lyrics found", lyric.syncedLyrics);

    const isJaSub = json.message?.body?.macro_calls?.['track.subtitles.get']?.message?.body?.subtitle_list?.[0]?.subtitle?.subtitle_language === "ja";

    let translations = [];
    const translationResponse = await cookieFetch(`https://apic.musixmatch.com/ws/1.1/crowd.track.translations.get?app_id=mac-ios-v2.0&usertoken=${this.encode(await this.getUserToken())}&commontrack_id=${this.encode(lyric.id.toString())}&selected_language=${(this.getConfig().language || this.targetLanguage)}`);
    const translationJson = await translationResponse.json();
    if (translationJson.message?.header?.status_code === 200) {
      translations = translationJson.message?.body?.translations_list || [];
    }

    const raw = { lyric, syncedLyrics: lyric.syncedLyrics, translations, isJaSub };
    cacheTable[cacheKey] = raw;
    return await this.buildResultFromRaw(raw);
  }

  async searchLyrics(params) {
    const lyric = await this.getLyric(params);
    if (!lyric) {
      this.logger.warn('[Lyrs] [MusixMatch] No lyrics found for search', params);
      return [];
    }
    return [lyric]
  }

  encode(str) {
    return encodeURIComponent(str).replace(/%20/g, '+');
  }

  async musixmatchMacroToLyricScheme(json) {
    this.logger.info(json.message?.body?.macro_calls?.['track.subtitles.get']?.message?.body?.subtitle_list)
    return await LyricResponseSchema.array().spa([{
      id: json.message?.body?.macro_calls?.['matcher.track.get']?.message?.body?.track?.commontrack_id,
      name: json.message?.body?.macro_calls?.['matcher.track.get']?.message?.body?.track?.track_name,
      trackName: json.message?.body?.macro_calls?.['matcher.track.get']?.message?.body?.track?.track_name,
      artistName: json.message?.body?.macro_calls?.['matcher.track.get']?.message?.body?.track?.artist_name,
      albumName: json.message?.body?.macro_calls?.['matcher.track.get']?.message?.body?.track?.album_name,
      duration: json.message?.body?.macro_calls?.['matcher.track.get']?.message?.body?.track?.track_length,
      instrumental: !!json.message?.body?.macro_calls?.['matcher.track.get']?.message?.body?.track?.instrumental,
      plainLyrics: json.message?.body?.macro_calls?.['track.subtitles.get']?.message?.body?.subtitle_list[0]?.subtitle?.subtitle_body || '',
      syncedLyrics: json.message?.body?.macro_calls?.['track.subtitles.get']?.message?.body?.subtitle_list[0]?.subtitle?.subtitle_body || '',
    }]);
  }

  async getIsrc(title, artist) {
    // https://www.shazam.com/services/amapi/v1/catalog/KR/search?types=songs&term=yorushika&limit=3
    const query = new URLSearchParams();
    query.set('term', artist + ' ' + title);
    query.set('types', 'songs');
    query.set('limit', '1');
    const response = await fetch(`https://www.shazam.com/services/amapi/v1/catalog/KR/search?${query.toString()}`);
    const json = await response.json();
    if (!json || json.results?.songs?.data?.length === 0) {
      this.logger.warn('[Lyrs] [MusixMatch] No results found for Isrc search', json);
      return null;
    }
    this.logger.info("[Lyrs] [MusixMatch] Found Isrc ID", json.results.songs.data[0].attributes.isrc);
    return json.results.songs.data[0].attributes.isrc;
  }

  /** raw 캐시에서 현재 설정(한글 발음 on/off 등)을 적용해 결과 객체를 만듦. 캐시에서 반환할 때마다 호출해 이미 로드된 가사도 설정 변경이 반영되도록 함. */
  async buildResultFromRaw(raw) {
    const { lyric, syncedLyrics, translations, isJaSub } = raw;
    let convertedLyrics = this.syncedLyricsToLyric(syncedLyrics);
    const cfg = this.getConfig();
    const targetKo = (cfg.language || this.targetLanguage) === "ko";

    if (targetKo && cfg.showKoreanPronunciation && isJaSub) {
      try {
        for (const [timestamp, lines] of Object.entries(convertedLyrics)) {
          if (lines[0]) convertedLyrics[Number(timestamp)].push(await hangulize(lines[0]));
        }
      } catch (e) {
        this.logger.warn("[Lyrs] [MusixMatch] Failed to convert Japanese to Korean pronunciation", e?.message);
      }
    }

    (translations || []).forEach(tr => {
      const source = tr.translation?.subtitle_matched_line;
      const target = tr.translation?.description;
      if (source != null && target != null) {
        Object.entries(convertedLyrics).forEach(([timestamp, lines]) => {
          if (lines.includes(source)) convertedLyrics[Number(timestamp)].push(target);
        });
      }
    });

    if (targetKo && cfg.useTranslationWhenNoKorean && isJaSub) {
      try {
        this.logger.info("[Lyrs] [MusixMatch] Applying translation when no Korean lyrics...");
        for (const [timestamp, lines] of Object.entries(convertedLyrics)) {
          const original = lines[0];
          if (!original) continue;
          const onlyOriginalOrWithPronunciation = lines.length <= 2;
          if (onlyOriginalOrWithPronunciation) {
            const translated = await this.translateJaToKo(original);
            if (translated && !lines.includes(translated)) convertedLyrics[Number(timestamp)].push(translated);
          }
        }
      } catch (e) {
        this.logger.warn("[Lyrs] [MusixMatch] Failed to apply translation when no Korean", e?.message);
      }
    }

    return {
      ...this.responseToMetadata(lyric),
      lyric: convertedLyrics,
      lyricRaw: syncedLyrics,
    };
  }

  responseToMetadata(lyric) {
    return {
      id: lyric.id.toString(),
      title: lyric.trackName,
      album: lyric.albumName,
      artist: lyric.artistName,
      playtime: lyric.duration * 1000,
    };
  }

  syncedLyricsToLyric(lyrics) {
    return lyrics.split('\n').reduce(
      (prev, line) => {
        const [time, ...text] = line.split('] ');
        const [minute, second] = time.slice(1).split(':').map(Number);
        const timestamp = minute * 60 * 1000 + second * 1000;

        return {
          ...prev,
          [timestamp]: [text.join('] ')],
        };
      },
      {},
    );
  }
}