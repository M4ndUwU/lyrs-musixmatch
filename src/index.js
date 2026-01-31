import { MusixMatchLyricProvider } from "./provider"

export default ({ useConfig, useSetting, registerLyricProvider, logger }) => {
  logger.info("[Lyrs] [MusixMatch] Initializing MusixMatch lyric provider...")

  const getShowKoreanPronunciation = useSetting({
    type: 'boolean',
    key: 'show-korean-pronunciation',
    name: '한글 발음 표시 (일본어 가사)',
    description: '일본어 가사에 한글 발음을 함께 표시합니다. 이미 표시 중인 가사에는 적용되지 않으며, 가사를 새로 불러오거나 곡을 다시 선택하면 반영됩니다.',
    default: true,
  })

  const getExtractOriginalTrack = useSetting({
    type: 'boolean',
    key: 'extract-original-track',
    name: '歌ってみた/covered by 필터 및 원곡 검색',
    description: '제목에 「歌ってみた」「covered by」 등이 있으면 제거 후 원곡 제목·가수로 가사를 검색합니다. 끄면 입력된 제목·가수 그대로 검색합니다.',
    default: true,
  })

  const getUseTranslationWhenNoKorean = useSetting({
    type: 'boolean',
    key: 'use-translation-when-no-korean',
    name: '일본어→한국어 번역 (한국어 가사 없을 때)',
    description: '일본어 노래인데 한국어 가사가 없을 때 MyMemory API로 일본어 가사를 한국어로 번역해 함께 표시합니다. MusixMatch에 한국어 번역이 없을 때만 적용되며, API 호출 때문에 가사 표시가 느려질 수 있습니다.',
    default: true,
  })

  registerLyricProvider(new MusixMatchLyricProvider(useConfig(), logger, getShowKoreanPronunciation, getExtractOriginalTrack, getUseTranslationWhenNoKorean))
}