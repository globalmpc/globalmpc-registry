/**
 * 시크릿 해석 — spec 06 §6.4.
 *
 * 지금까지 모든 비밀은 환경변수에 값 그대로 들어갔다. 그 방식의 문제는 값이
 * 없다는 것이 아니라 **어디서 왔는지 알 수 없다**는 것이다.
 *
 * - 프로세스 목록·크래시 덤프·`docker inspect`에 값이 그대로 보인다.
 * - 회전(rotation)하려면 배포를 다시 해야 한다.
 * - 누가 언제 이 값을 넣었는지 기록이 없다.
 *
 * 그래서 환경변수에는 **참조(reference)**를 넣고 여기서 해석한다. 참조 형식은
 * `scheme:locator`이며, 값 그대로도 계속 받는다 — 로컬 개발까지 vault를 요구하면
 * 아무도 돌려보지 못한다.
 *
 * 지원 scheme:
 *
 * - `file:/path/to/secret` — 파일에서 읽는다. Docker secret·Kubernetes projected
 *   volume이 이 형태다. 값이 프로세스 환경에 남지 않는다.
 * - `env:OTHER_VAR` — 다른 환경변수를 가리킨다. 플랫폼이 주입한 이름을 그대로
 *   쓰면서 우리 이름과 분리한다.
 * - `plain:<value>` — 값 그대로임을 명시한다.
 * - scheme이 없으면 값 그대로로 본다(하위 호환).
 *
 * **해석된 값은 로그·오류 메시지에 절대 넣지 않는다.** 실패해도 참조 문자열의
 * scheme과 locator만 보고한다.
 */

import { readFileSync } from "node:fs";

export class SecretResolutionError extends Error {
  readonly code = "SECRET_UNRESOLVED";
  constructor(
    readonly variableName: string,
    reason: string,
  ) {
    // 값은 담지 않는다. 어떤 변수가 왜 안 풀렸는지만 남긴다.
    super(`${variableName}를 해석하지 못했다 — ${reason}`);
    this.name = "SecretResolutionError";
  }
}

export type SecretScheme = "file" | "env" | "plain" | "inline";

export interface SecretReference {
  readonly scheme: SecretScheme;
  /** scheme 뒤의 값. `inline`이면 원문 전체다. */
  readonly locator: string;
}

const SCHEME_PATTERN = /^(file|env|plain):(.+)$/s;

export function parseSecretReference(raw: string): SecretReference {
  const match = SCHEME_PATTERN.exec(raw);
  if (!match) return { scheme: "inline", locator: raw };
  return { scheme: match[1] as SecretScheme, locator: match[2]! };
}

/**
 * 참조를 실제 값으로 바꾼다.
 *
 * 로컬 개발과 CI는 `inline`을 그대로 쓰고, 배포 환경은 `file:`로 마운트된
 * 시크릿을 읽는다. 두 경로가 같은 함수를 지나므로 "배포에서만 다르게 동작"하는
 * 구간이 생기지 않는다.
 */
export function resolveSecret(
  variableName: string,
  raw: string | undefined,
  readFile: (path: string) => string = (path) => readFileSync(path, "utf8"),
  env: NodeJS.ProcessEnv = process.env,
): string {
  if (raw === undefined || raw.length === 0) {
    throw new SecretResolutionError(variableName, "값이 없다");
  }

  const reference = parseSecretReference(raw);

  switch (reference.scheme) {
    case "file": {
      let contents: string;
      try {
        contents = readFile(reference.locator);
      } catch (error) {
        throw new SecretResolutionError(
          variableName,
          `파일을 읽지 못했다: ${reference.locator} (${(error as NodeJS.ErrnoException).code ?? "unknown"})`,
        );
      }
      // 파일 끝 개행은 편집기가 붙인다. 그대로 두면 서명 키가 조용히 틀어진다.
      const trimmed = contents.trim();
      if (trimmed.length === 0) {
        throw new SecretResolutionError(variableName, `파일이 비어 있다: ${reference.locator}`);
      }
      return trimmed;
    }

    case "env": {
      const value = env[reference.locator];
      if (!value) {
        throw new SecretResolutionError(
          variableName,
          `가리킨 환경변수가 비어 있다: ${reference.locator}`,
        );
      }
      return value;
    }

    case "plain":
      return reference.locator;

    case "inline":
      return reference.locator;
  }
}

/**
 * 시작 시 시크릿 상태 요약.
 *
 * 값은 담지 않는다. 어떤 변수를 어떤 scheme으로 읽었는지만 남긴다 — 운영에서
 * "지금 어떤 키를 쓰고 있나"를 묻는 순간 그 답이 로그에 있어야 한다.
 */
export interface SecretAudit {
  readonly variableName: string;
  readonly scheme: SecretScheme;
  /** 값이 아니라 값의 지문. 회전 여부를 값 노출 없이 확인한다. */
  readonly fingerprint: string;
}

export function fingerprintSecret(value: string, hash: (input: string) => string): string {
  // 앞 12자만 남긴다. 전체를 남기면 rainbow table 대상이 된다.
  return hash(value).slice(0, 12);
}
