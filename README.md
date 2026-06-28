# Design System Linter (Figma Plugin)

Figma 파일을 스캔해서 **디자인 시스템에서 벗어난 항목**을 찾아주는 플러그인입니다.
판단 기준(source of truth)은 파일에 등록된 **Figma 변수(Variables)와 스타일(Styles)** 입니다.

## 감지 항목

| 종류 | 위반으로 판단하는 경우 |
| --- | --- |
| **색상 (Color)** | Fill·Stroke의 solid 색상이 변수(`boundVariables`)나 paint 스타일(`fillStyleId`/`strokeStyleId`)에 연결되지 않은 raw 값일 때 |
| **타이포그래피** | 텍스트가 text style에 연결되지 않았거나, 부분 적용(mixed)일 때 |
| **Detached / Override** | 컴포넌트 인스턴스가 메인 컴포넌트의 시각 속성(fills/strokes/text 등)을 override 해서 시스템 값에서 벗어났을 때 |

> ℹ️ Figma API로는 "한때 컴포넌트였다가 detach된" 사실을 사후에 알 수 없습니다.
> 그래서 Detached 검사는 *시스템 값에서 벗어난(override된) 인스턴스* 를 실용적 대리 지표로 감지합니다.

## 개발 환경

```bash
npm install
npm run dev     # esbuild watch 모드
npm run build   # dist/ 에 code.js + ui.html 생성
npm run typecheck
```

## Figma에 불러오기

1. `npm run build` 로 `dist/` 생성
2. Figma 데스크톱 앱 → **Plugins → Development → Import plugin from manifest…**
3. 이 레포의 `manifest.json` 선택
4. 캔버스에서 **Plugins → Development → Design System Linter** 실행

## 사용법

- **검사 범위**: `현재 페이지` 전체 또는 `선택 영역`만
- **검사 항목**: 색상 / 타이포그래피 / Detached 중 선택
- **검사 실행** 후 위반 목록이 종류별로 표시됩니다. 항목을 클릭하면 캔버스에서 해당 노드로 이동·선택됩니다.

## 구조

```
manifest.json      플러그인 매니페스트
build.mjs          esbuild 빌드 (code 번들 + UI를 단일 HTML로 인라인)
src/
  shared.ts        메인 스레드 ↔ UI 공유 타입/메시지
  code.ts          Figma 씬 그래프 순회 + 위반 감지 (메인 스레드)
  ui/
    ui.tsx         React UI (iframe)
    ui.css         스타일 (Figma 테마 변수 사용)
    ui.html        UI 템플릿
```

## 라이선스

MIT
