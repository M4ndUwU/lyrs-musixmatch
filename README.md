# lyrs-musixmatch

**lyrs-musixmatch**는 커스텀이 편리한 가사 표시기 [Lyrs](https://github.com/organization/lyrs)를 위한 MusixMatch 지원 플러그인입니다.  
자동으로 곡 정보를 인식하고, 다양한 언어의 가사와 번역, 일본어 가사 한글 발음까지 지원합니다!

![lyrs-musixmatch 데모](https://github.com/user-attachments/assets/eaca64f2-83f2-4929-9f87-4e972c28f692)

---

## 주요 기능

- 🎵 **Shazam(Apple Music API) 기반 곡 인식**  
  재생 중인 곡의 ISRC를 자동으로 검색합니다.

- 🌐 **MusixMatch에서 가사 자동 불러오기**  
  인식된 곡의 가사를 MusixMatch에서 가져와 표시합니다.

- 💬 **다국어 번역 지원**  
  Lyrs에 설정된 언어와 일치하는 번역 가사가 있으면 2열로 표시합니다.

- 🈂️ **일본어 → 한글 발음 변환**  
  한국어로 설정된 경우, 원문 가사가 일본어라면 [Hangulize](https://github.com/hangulize/hangulize)를 통해 한글 발음을 추가로 제공합니다. (플러그인 설정에서 on/off 가능)

- 🎌 **歌ってみた / covered by 필터 및 원곡 검색**  
  제목이 「歌ってみた」로 시작하면 커버 표기와 슬래시를 제거한 **원곡 제목**으로 가사를 검색합니다.  
  `제목 / covered by 아티스트`, `제목 / 아티스트` 형태에서 원곡 제목만 추출하며, 끝의 `/`가 포함되지 않도록 정리하고, 커버 곡인 경우 원곡 아티스트는 비워 둡니다. (플러그인 설정에서 on/off 가능)

- 📖 **일본어→한국어 번역 (한국어 가사 없을 때)**  
  일본어 노래인데 MusixMatch에 한국어 가사가 없을 때 [MyMemory](https://mymemory.translated.net/) API로 일본어 가사를 한국어로 번역해 함께 표시합니다. API 호출로 인해 가사 표시가 다소 느려질 수 있습니다. (플러그인 설정에서 on/off 가능)

---

## 설치 방법

1. **필수 조건**
   - [Lyrs](https://github.com/organization/lyrs)가 먼저 설치되어 있어야 합니다.

2. **lyrs-musixmatch 설치**
   - [여기](https://github.com/Baw-Appie/lyrs-musixmatch/releases/latest)에서 플러그인을 다운로드 받고,
   Lyrs 설정에서 [파일에서 불러오기]를 눌러 설치하세요.

3. **Lyrs 설정 변경**
   - Lyrs의 [가사 제공자] 설정을 MusixMatch로 변경하세요.

---

## 사용법

1. Lyrs를 실행하면, 자동으로 재생 중인 곡을 인식합니다.
2. 가사가 자동으로 표시됩니다.
3. 설정한 언어와 일치하는 번역 가사가 있으면 2열로 보여줍니다.
4. 일본어 가사의 경우, 한국어 설정 시 한글 발음도 함께 표시됩니다.
5. Lyrs **플러그인 설정**에서 한글 발음 표시, 歌ってみた 필터, 일본어→한국어 번역을 각각 켜거나 끌 수 있습니다.

---

## 향후 개선 아이디어

- **번역 API**: MyMemory 무료 한도(일일 약 1000단어) 초과 시 Papago/Google 등 대체 API 옵션, 또는 API 키 설정 지원
- **원곡 추출 고도화**: 규칙 기반으로 해결되지 않는 제목은 소형 LLM으로 원곡 제목·가수 추출 시도 (선택 옵션)
- **가사 검색 실패 시**: 원곡 추출로 검색 실패하면 원본 제목·가수로 재시도
- **캐시**: 가사 캐시(cacheTable)에 최대 개수 또는 TTL 적용해 메모리 사용 완화

## 기여하기

이 프로젝트는 오픈소스입니다!  
버그 제보, 기능 제안, PR 모두 환영합니다.

1. 이슈 등록 또는 PR 생성
2. 친절한 설명을 곁들여주시면 더욱 좋아요!

---

## 참고 자료

- [Lyrs 공식 저장소](https://github.com/organization/lyrs)
- [MusixMatch](https://www.musixmatch.com/)
- [Hangulize](https://github.com/hangulize/hangulize)
