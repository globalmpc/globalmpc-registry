/**
 * Compose 파일의 볼륨 경로에 변수 치환이 없는가 — 2026-09-11.
 *
 * Coolify는 볼륨 source에 `${`가 있으면 보안상 거절하고 **배포 전체를 멈춘다**:
 *
 *   Deployment failed: Invalid Docker volume definition: Invalid volume source:
 *   contains forbidden character '${' (variable substitution with potential
 *   command injection).
 *
 * 로컬 `docker compose`는 그 치환을 정상으로 받아들이므로 로컬 검사·CI·E2E가 모두
 * 초록인 채로 배포만 실패한다. 실제로 그랬다(2026-09-10 A4 수정 → 2026-09-11 배포
 * 실패). 사람이 기억해서 막을 수 없는 제약이라 게이트로 둔다.
 *
 * YAML 파서를 쓰지 않는다 — 들여쓰기로 서비스의 `volumes:` 블록만 본다. 이
 * 저장소의 compose 파일은 짧은 문법(`- 원본:대상`)과 긴 문법(`source:`)만 쓴다.
 */

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DAPP = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
/**
 * 기본 대상은 이 저장소가 갖는 compose 파일 전부다.
 *
 * 배포 환경별 compose는 저장소에 따라 없을 수 있다. 기본 목록에 있는데 파일이
 * 없으면 **건너뛰었다고 출력하고** 지나간다 — 조용히 빼면 검사가 도는 줄 알고
 * 아무것도 보지 않는 상태가 생긴다. 인자로 직접 지정한 파일이 없으면 오류다.
 * 그것은 구성 차이가 아니라 오타다.
 */
const DEFAULT_FILES = ["docker-compose.yml"];
const requested = process.argv.slice(2);
const FILES = (requested.length > 0 ? requested : DEFAULT_FILES).filter((file) => {
  if (existsSync(path.isAbsolute(file) ? file : path.join(DAPP, file))) return true;
  if (requested.length > 0) {
    console.error(`검사 대상이 없다: ${file}`);
    process.exit(1);
  }
  console.log(`없어서 건너뛴다: ${file}`);
  return false;
});

if (FILES.length === 0) {
  console.error("검사할 compose 파일이 하나도 없다.");
  process.exit(1);
}

interface Violation {
  readonly file: string;
  readonly line: number;
  readonly text: string;
}

/**
 * Coolify가 볼륨 source에서 거절하는 문자열 — `validateShellSafePath`
 * (coollabsio/coolify `bootstrap/helpers/shared.php`). `${`만이 아니다. 목록을
 * 그대로 옮겨 두어야 다음 거절이 또 배포 단계에서 드러나지 않는다.
 * 줄바꿈·CR은 한 줄 안에 올 수 없으므로 뺐다.
 */
const FORBIDDEN: readonly string[] = ["`", "$(", "${", "|", "&", ";", "\t", ">", "<"];

const indentOf = (line: string): number => line.length - line.trimStart().length;

export function findVolumeSubstitutions(file: string, text: string): Violation[] {
  const violations: Violation[] = [];
  let volumesIndent: number | null = null;

  text.split("\n").forEach((raw, index) => {
    const line = raw.replace(/\s+#.*$/, "");
    if (line.trim() === "" || line.trim().startsWith("#")) return;

    const indent = indentOf(line);

    // 서비스 아래의 `volumes:`만 본다. 최상위 `volumes:`(named volume 선언)는 경로가 없다.
    if (/^\s+volumes:\s*$/.test(line)) {
      volumesIndent = indent;
      return;
    }
    if (volumesIndent !== null && indent <= volumesIndent) volumesIndent = null;
    if (volumesIndent === null) return;

    const trimmed = line.trim();
    // 짧은 문법(`- 원본:대상:모드`)은 항목 전체를 본다. `${A:-b}`처럼 치환 안에
    // `:`가 있어 원본만 잘라 내기 어렵고, 대상·모드에도 이 문자들이 올 이유가 없다.
    const item = trimmed.startsWith("-") ? trimmed.replace(/^-\s*/, "") : "";
    const longSource = /^source:\s*(.+)$/.exec(trimmed)?.[1] ?? "";
    const candidate = item || longSource;
    const found = FORBIDDEN.find((token) => candidate.includes(token));
    if (found) {
      violations.push({ file, line: index + 1, text: `${JSON.stringify(found)} · ${raw.trim()}` });
    }
  });

  return violations;
}

const all = FILES.flatMap((file) =>
  findVolumeSubstitutions(file, readFileSync(path.isAbsolute(file) ? file : path.join(DAPP, file), "utf8")),
);

if (all.length > 0) {
  console.error("볼륨 경로에 Coolify 금지 문자가 있다. 배포가 거절된다:\n");
  for (const violation of all) console.error(`  ${violation.file}:${violation.line}  ${violation.text}`);
  console.error(
    "\n볼륨에는 고정 경로만 둔다. 파일 선택이 필요하면 시작 스크립트에서 환경변수로 고른다" +
      " (예: 컨테이너 entrypoint에서 파일을 고른다).",
  );
  process.exit(1);
}

console.log(`볼륨 경로 Coolify 금지 문자 없음 — ${FILES.join(" · ")}`);
