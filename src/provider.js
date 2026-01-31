import { z } from 'zod';
import makeCookieFetch from 'fetch-cookie';
import { hangulize } from './hangulize/index.js';

const cookieFetch = makeCookieFetch(fetch);
const cacheTable = {};
const TRANSLATION_CACHE_MAX = 500;

const translationCache = {}; // ja -> ko 캐시 (번역 API 호출 절감)
const translationCacheOrder = []; // LRU용

const COVER_KEYWORDS = [
  '歌ってみた', '踊ってみた', '演奏してみた',
  'covered by', 'Cover by', 'Cover:', 'cover:',
  'Covered by', 'カバー', 'cover',
];

function hasCoverKeyword(title, artist) {
  const raw = [title || '', artist || ''].join(' ');
  return COVER_KEYWORDS.some((kw) => raw.includes(kw));
}

/** 【歌ってみた】로 시작하는 제목만 처리. 5가지 패턴에 맞춰 제목/원곡 아티스트 추출 */
function extractOriginalTrackRuleBased(title, artist) {
  const raw = String(title || '').trim();
  if (!raw.startsWith('【歌ってみた】')) {
    return { title: raw, artist: '' };
  }
  let s = raw.replace(/^【歌ってみた】/, '').trim();
  // 끝의 【...】 블록 제거 (예: 【レイン・パターソン/にじさんじ】, 【covered by 花宮莉歌】)
  s = s.replace(/\s*【[^】]*】\s*$/g, '').trim();
  // 끝의 " covered by X" 제거 (예: covered by 明透, covered by 幸祜&HACHI, covered by ヰ世界情緒)
  s = s.replace(/\s+covered\s+by\s+.+$/i, '').trim();
  // 끝의 공백+슬래시 제거 (예: "君の知らない物語 /" → "君の知らない物語")
  s = s.replace(/\s*[\/／\uFF0F\u2044\u2215]\s*$/g, '').trim();
  s = s.replace(/\u3000/g, ' ').replace(/\s+/g, ' ').trim();

  let outTitle = s;
  let outArtist = '';
  const inputArtist = typeof artist === 'string' ? artist.trim() : '';

  if (s.includes(' / ')) {
    const parts = s.split(' / ').map((p) => p.trim());
    const left = parts[0] || '';
    const right = parts[1] || '';
    if (right) {
      // right가 "covered by" 포함이거나, 트랙 아티스트가 있으면 right는 커버 아티스트로 간주
      if (/covered\s*by/i.test(right) || inputArtist) {
        outTitle = left;
        outArtist = ''; // 커버 아티스트로 판단, 비움
      } else {
        outTitle = left;
        outArtist = right;
      }
    } else {
      outTitle = left;
      outArtist = '';
    }
  } else if (s.includes(' - ')) {
    const parts = s.split(' - ').map((p) => p.trim());
    const left = parts[0] || '';
    const right = parts.slice(1).join(' - ').trim() || '';
    if (left && right) {
      outTitle = left;
      outArtist = right;
    } else {
      outTitle = left || s;
      outArtist = '';
    }
  }

  return { title: outTitle.trim(), artist: (outArtist || '').trim() };
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
    this.getUseTranslationWhenNoKorean = typeof getUseTranslationWhenNoKorean === 'function' ? getUseTranslationWhenNoKorean : () => false;
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
    const title = params.title ?? params.titile ?? params.trackTitle ?? "";
    const artist = params.artist ?? params.aritist ?? params.channelName ?? "";
    const cfg = this.getConfig();
    const useExtract = cfg.extractOriginalTrack === true;
    const shouldExtract = useExtract && (title || '').startsWith('【歌ってみた】');
    const extracted = shouldExtract
      ? extractOriginalTrackRuleBased(title, artist)
      : { title, artist };
    const searchTitle = extracted.title || title;
    // 추출 시 아티스트를 비웠으면 빈 문자열 유지 (원래 artist로 대체하지 않음)
    const searchArtist = shouldExtract ? extracted.artist : artist;
    if (shouldExtract && (searchTitle !== title || searchArtist !== artist)) {
      this.logger.info("[Lyrs] [MusixMatch] Rule-based extracted original track for search", { original: { title, artist }, extracted: { title: searchTitle, artist: searchArtist } });
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
    const term = [artist, title].filter((s) => s != null && String(s).trim()).join(' ').trim() || (title || '').trim();
    const query = new URLSearchParams();
    query.set('term', term);
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