# MPC Design System

MPC 프로젝트가 공유하는 토큰·로고·규칙. 스택에 의존하지 않으며 런타임 의존성이
없습니다.

이 폴더는 독립 저장소로 분리될 예정이므로, 여기서 호스트 저장소의 파일을
참조하지 않습니다. 유일한 예외는 `scripts/sync-assets.mjs`이며 그 이유는 아래
"로고를 고치려면"에 적혀 있습니다.

## 5분 시작

### CSS를 쓰는 프로젝트

```css
@import "@mpc/design/tokens.css"; /* --copper, --background, --radius-lg ... */
@import "@mpc/design/utilities.css"; /* .label-eyebrow, .hairline-t, .reveal ... */
```

```html
<div class="label-eyebrow">Investment Case</div>
<h2 style="color: var(--foreground)">…</h2>
```

### Tailwind v4

토큰을 Tailwind 테마로 연결합니다. `--color-*`는 Tailwind 네임스페이스이므로
별칭으로 걸고, `--font-*`와 `--radius-*`는 Tailwind가 그 이름을 직접 쓰기 때문에
값을 넣습니다.

```css
@import "@mpc/design/tokens.css";

@theme inline {
  --color-copper: var(--copper);
  --color-surface: var(--surface);
  --font-display: "Space Grotesk", "Inter", sans-serif;
  --radius-lg: 6px;
}
```

### Flutter

```dart
import 'tokens.dart'; // dist/tokens.dart 를 복사

Container(color: MpcColors.background,
  child: Text('MPC', style: TextStyle(fontFamily: MpcFonts.display,
                                      color: MpcColors.copper)));
```

### 그 외 (Sass, 디자인 도구, 스크립트)

- `dist/tokens.scss` — Sass 변수
- `dist/tokens.json` — 이름·값·hex·용도가 든 평면 JSON
- `tokens/*.json` — DTCG 원본. Figma 토큰 플러그인과 Style Dictionary가 읽는 형식

### 코딩 에이전트를 쓰는 프로젝트

```bash
cat node_modules/@mpc/design/ai/CLAUDE.md >> CLAUDE.md
```

토큰 목록, 구성 규칙, 톤 규칙, 로고 금지사항이 한 블록에 압축되어 있습니다.
사람이 문서를 읽지 않아도 톤이 유지되는 경로입니다.

## 무엇이 들어 있나

| 경로                | 내용                                              |
| ------------------- | ------------------------------------------------- |
| `tokens/`           | **정본.** DTCG 형식 토큰 43개                     |
| `content/`          | **정본.** 톤·패턴·로고 규칙 (한/영)               |
| `dist/`             | 생성물. CSS·JSON·SCSS·Dart·유틸리티 CSS           |
| `docs/`             | 생성물. 사람이 읽는 문서 4종                      |
| `ai/`               | 생성물. 에이전트용 압축 규칙                      |
| `assets/logo/`      | SVG 16 · PNG 48 · manifest                        |
| `css/utilities.css` | 유틸리티 레이어 원본 (토큰을 소비하는 수작성 CSS) |

**손으로 고치는 곳은 `tokens/`, `content/`, `css/` 세 군데뿐입니다.** 나머지는
`npm run build`가 다시 만듭니다.

## 고치려면

```bash
npm run build     # tokens/ + content/ → dist/ + docs/ + ai/
npm run check     # 위를 실행하고 생성물이 최신인지 확인 (CI용)
```

`build`는 검증을 겸합니다. 지원하지 않는 `$type`, 해석할 수 없는 색, 이름이
겹치는 토큰이 있으면 종료 코드 1로 실패합니다.

### 로고를 고치려면

아트워크 생성기는 이 패키지에 없습니다. `sharp`와 `opentype.js`가 필요한데,
Flutter나 Figma 소비자가 네이티브 이미지 툴체인을 함께 설치하게 되기 때문입니다.
따라서 마크를 수정하려면 호스트 저장소에서 재생성한 뒤 동기화합니다.

```bash
cd .. && bun run build:brand   # 로고 재생성 + 이 패키지로 복사
```

## 왜 이렇게 되어 있나

**oklch로 작성하고 hex로 배포합니다.** 하나의 구리색으로는 종이와 near-black
인터페이스를 동시에 만족시킬 수 없어 표면별로 값이 나뉘고, 그 판단은 oklch에서
해야 정확합니다. 인쇄소·덱·Flutter는 hex를 원하므로 빌드 시점에 변환합니다. 둘을
따로 관리하지 않으므로 어긋날 수 없습니다.

**색 라이브러리를 쓰지 않습니다.** oklch → sRGB 변환은 `lib/color.mjs` 60줄이며,
그 대가로 이 패키지는 의존성이 0입니다. 어떤 스택의 프로젝트든 `dist/` 파일 하나를
복사해 시작할 수 있습니다.

**DTCG 형식을 따릅니다.** 변환기는 직접 만들었지만 파일 형식은 표준입니다.
Style Dictionary의 내장 색 변환이 oklch를 이해하지 못해 지금은 쓰지 않지만,
나중에 붙이거나 Figma 토큰 플러그인을 연결할 때 다시 쓰지 않아도 됩니다.
