/**
 * R-04 금지어 lint를 **실제 화면 문구에** 건다 — spec 11 §11.13 / AC-31.
 *
 * `@mpc/ui`의 `lintProhibitedLanguage`는 지금까지 자기 자신의 상수만 검사했다.
 * 그 상태에서는 규칙이 존재하되 강제되지 않는다 — 화면에 "확정이득"을 적어도
 * CI가 통과한다. 이 스크립트가 그 구멍을 막는다.
 *
 * **주석은 검사 대상이 아니다.** 주석은 사용자에게 보이지 않고, 오히려 금지어를
 * 인용해 "쓰지 않는 이유"를 적는 자리다. 그래서 문자열·JSX 텍스트만 남기고
 * 주석을 제거한 뒤 검사한다.
 *
 * **부정문 예외.** "자동 승인된다는 뜻이 아니다"는 금지어를 포함하지만 금지어가
 * 막으려는 주장의 정반대다. 문자열 단위 allowlist로 명시하며, 각 항목은 사유를
 * 함께 적는다 — 목록이 조용히 늘어나면 규칙이 무의미해진다.
 */

import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { lintProhibitedLanguage } from "@mpc/ui";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DAPP = path.join(HERE, "..");

/** 사용자에게 도달하는 문구를 가진 곳. UI copy·API message·export 전부다. */
const ROOTS = [
  "apps/web/src",
  "apps/api/src",
  "apps/worker/src",
  "packages/ui/src",
  "packages/api-contract/src",
  "packages/domain/src",
];

/** 금지어 목록 자체를 검사하지 않는다 — 정의가 곧 위반으로 잡힌다. */
const SKIP = ["packages/ui/src/prohibited-language.ts"];

/**
 * 금지어를 부정하거나 그 오해를 막기 위해 인용하는 문구.
 *
 * 각 항목은 "이 문장이 금지어가 막으려는 주장을 하지 않는다"가 눈으로 확인돼야
 * 한다. 확인되지 않으면 예외가 아니라 고쳐야 할 문구다.
 */
const NEGATIONS: readonly { readonly text: string; readonly why: string }[] = [
  {
    text: "다음 단계가 자동 승인된다는 뜻이 아니다",
    why: "readiness ok가 승인이 아님을 밝히는 문구 — AC-03이 요구하는 부정문이다",
  },
  {
    text: "정부 승인이나 MPC의 보증",
    why: "'…이 아니다'가 뒤따르는 경계 문구다 — §11.12가 요구하는 부정 진술이다",
  },
];

/** 주석을 지운다. 문자열 안의 `//`를 주석으로 오인하지 않도록 상태를 추적한다. */
function stripComments(source: string): string {
  let out = "";
  let i = 0;
  let quote: string | null = null;

  while (i < source.length) {
    const c = source[i]!;
    const next = source[i + 1];

    if (quote) {
      if (c === "\\") {
        out += c + (next ?? "");
        i += 2;
        continue;
      }
      if (c === quote) quote = null;
      out += c;
      i += 1;
      continue;
    }

    if (c === '"' || c === "'" || c === "`") {
      quote = c;
      out += c;
      i += 1;
      continue;
    }

    if (c === "/" && next === "/") {
      while (i < source.length && source[i] !== "\n") i += 1;
      continue;
    }

    if (c === "/" && next === "*") {
      i += 2;
      while (i < source.length && !(source[i] === "*" && source[i + 1] === "/")) i += 1;
      i += 2;
      continue;
    }

    out += c;
    i += 1;
  }

  return out;
}

function sources(dir: string): string[] {
  const entries = readdirSync(path.join(DAPP, dir), { withFileTypes: true });
  return entries.flatMap((entry) => {
    const rel = path.join(dir, entry.name);
    if (entry.isDirectory()) return sources(rel);
    if (!/\.(ts|tsx)$/.test(entry.name)) return [];
    if (SKIP.includes(rel)) return [];
    return [rel];
  });
}

let violations = 0;

for (const root of ROOTS) {
  for (const file of sources(root)) {
    const text = stripComments(readFileSync(path.join(DAPP, file), "utf8"));
    for (const finding of lintProhibitedLanguage(text)) {
      if (NEGATIONS.some((entry) => finding.context.includes(entry.text))) continue;
      violations += 1;
      console.error(
        `${file}: 금지어 "${finding.phrase}" — ${finding.reason}\n` +
          `  문맥: …${finding.context.replace(/\s+/g, " ").trim()}…\n` +
          `  대신: ${finding.replacement}`,
      );
    }
  }
}

if (violations > 0) {
  console.error(`\nR-04 금지어 ${violations}건. 문구를 고치기 전에는 배포하지 않는다.`);
  process.exit(1);
}

console.log("R-04 금지어 없음.");
