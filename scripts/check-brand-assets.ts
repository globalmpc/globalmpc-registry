/**
 * 브랜드 자산 동기 검사.
 *
 * 웹은 로고를 정적 파일로 서빙한다(`public/`, `src/app/icon.svg`). 번들러 설정
 * 없이 동작하는 대신 **사본이 생긴다** — 사본은 원본이 바뀌어도 조용히 옛
 * 아트워크를 계속 내보낸다.
 *
 * 그래서 사본과 `@mpc/design/assets/logo`의 원본이 바이트 단위로 같은지 검사한다.
 * 로고를 다시 그리면 이 검사가 실패하고, 실패가 사본을 갱신하라는 신호다.
 *
 * 아트워크를 여기서 고치지 않는다. 원본은 design-system이며 생성기는 호스트
 * 저장소에 있다(`design-system/README.md` "To change the logo").
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DAPP = path.join(HERE, "..");
/** design-system은 저장소 루트 아래에 있다. */
const ORIGIN = path.join(DAPP, "design-system/assets/logo/svg");

interface Copy {
  readonly origin: string;
  readonly copy: string;
  readonly why: string;
}

const COPIES: readonly Copy[] = [
  {
    origin: "mpc-mark-on-dark.svg",
    copy: "apps/web/public/brand/mpc-mark-on-dark.svg",
    why: "TopBar 브랜드 마크",
  },
  {
    origin: "mpc-mark-on-dark.svg",
    copy: "apps/web/src/app/icon.svg",
    why: "favicon (Next app router 규약)",
  },
];

const drifted = COPIES.filter((entry) => {
  const origin = readFileSync(path.join(ORIGIN, entry.origin));
  const copy = readFileSync(path.join(DAPP, entry.copy));
  return !origin.equals(copy);
});

if (drifted.length > 0) {
  for (const entry of drifted) {
    console.error(
      `브랜드 자산이 원본과 다르다: ${entry.copy} (${entry.why})\n` +
        `  원본: design-system/assets/logo/svg/${entry.origin}\n` +
        `  고치는 법: cp design-system/assets/logo/svg/${entry.origin} ${entry.copy}`,
    );
  }
  process.exit(1);
}

console.log(`브랜드 자산 ${COPIES.length}개가 원본과 같다.`);
