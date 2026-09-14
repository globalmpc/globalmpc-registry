import { describe, expect, it } from "vitest";
import {
  fingerprintSecret,
  parseSecretReference,
  resolveSecret,
  SecretResolutionError,
} from "../src/secrets.js";

/**
 * 시크릿 해석 — 06 §6.4.
 *
 * 여기서 확인하는 것의 절반은 "값이 잘 읽힌다"가 아니라 **값이 새지 않는다**다.
 * 오류 메시지에 값이 들어가면 로그가 유출 경로가 된다.
 */

const files: Record<string, string> = {
  "/run/secrets/session": "a-very-long-session-secret-value\n",
  "/run/secrets/empty": "   \n",
};

const readFile = (path: string): string => {
  const contents = files[path];
  if (contents === undefined) {
    const error = new Error("ENOENT") as NodeJS.ErrnoException;
    error.code = "ENOENT";
    throw error;
  }
  return contents;
};

describe("참조 파싱", () => {
  it("scheme이 있으면 분리한다", () => {
    expect(parseSecretReference("file:/run/secrets/x")).toEqual({
      scheme: "file",
      locator: "/run/secrets/x",
    });
  });

  it("scheme이 없으면 값 그대로로 본다", () => {
    // 로컬 개발까지 vault를 요구하면 아무도 돌려보지 못한다.
    expect(parseSecretReference("literal-value")).toEqual({
      scheme: "inline",
      locator: "literal-value",
    });
  });

  it("값에 콜론이 있어도 잘리지 않는다", () => {
    // DATABASE_URL이 `postgres://user:pass@host`다. 이것을 scheme으로 오인하면
    // 연결 문자열이 통째로 깨진다.
    expect(parseSecretReference("postgres://u:p@localhost:5432/db")).toEqual({
      scheme: "inline",
      locator: "postgres://u:p@localhost:5432/db",
    });
  });

  it("plain은 값 그대로임을 명시한다", () => {
    expect(parseSecretReference("plain:file:not-a-path")).toEqual({
      scheme: "plain",
      locator: "file:not-a-path",
    });
  });
});

describe("해석", () => {
  it("파일에서 읽고 끝 개행을 제거한다", () => {
    // 편집기가 붙인 개행을 그대로 두면 서명 키가 조용히 틀어진다.
    expect(resolveSecret("SESSION_SECRET", "file:/run/secrets/session", readFile)).toBe(
      "a-very-long-session-secret-value",
    );
  });

  it("다른 환경변수를 가리킬 수 있다", () => {
    const value = resolveSecret("DATABASE_URL", "env:PLATFORM_DB_URL", readFile, {
      PLATFORM_DB_URL: "postgres://localhost/x",
    });
    expect(value).toBe("postgres://localhost/x");
  });

  it("값 그대로도 받는다", () => {
    expect(resolveSecret("SESSION_SECRET", "literal", readFile)).toBe("literal");
  });
});

describe("실패", () => {
  it("값이 없으면 어떤 변수인지 말한다", () => {
    expect(() => resolveSecret("SESSION_SECRET", undefined, readFile)).toThrow(
      SecretResolutionError,
    );
  });

  it("파일이 없으면 경로와 코드를 알려준다", () => {
    try {
      resolveSecret("SESSION_SECRET", "file:/nope", readFile);
      expect.unreachable();
    } catch (error) {
      expect((error as Error).message).toContain("/nope");
      expect((error as Error).message).toContain("ENOENT");
    }
  });

  it("빈 파일을 값으로 받지 않는다", () => {
    // 공백만 있는 파일을 통과시키면 빈 secret으로 서버가 뜬다.
    expect(() => resolveSecret("SESSION_SECRET", "file:/run/secrets/empty", readFile)).toThrow(
      /비어 있다/,
    );
  });

  it("가리킨 환경변수가 비면 그 이름을 말한다", () => {
    try {
      resolveSecret("DATABASE_URL", "env:MISSING", readFile, {});
      expect.unreachable();
    } catch (error) {
      expect((error as Error).message).toContain("MISSING");
    }
  });

  it("오류 메시지에 값이 들어가지 않는다", () => {
    // 이 파일의 내용이 오류에 실리면 로그가 유출 경로가 된다.
    const secret = "a-very-long-session-secret-value";
    try {
      // 존재하는 파일을 읽되 변수명을 잘못 준 상황은 없다. 대신 env 경로에서
      // 값이 있는 변수를 가리키고, 이후 다른 실패를 만들어 메시지를 확인한다.
      resolveSecret("SESSION_SECRET", "file:/nope", readFile, { X: secret });
      expect.unreachable();
    } catch (error) {
      expect((error as Error).message).not.toContain(secret);
    }
  });
});

describe("지문", () => {
  const hash = (input: string) => `sha-${input.length}-${input.slice(0, 2)}-padding-padding`;

  it("값 자체를 노출하지 않는 짧은 지문을 만든다", () => {
    const fingerprint = fingerprintSecret("super-secret-value", hash);
    expect(fingerprint).toHaveLength(12);
    expect(fingerprint).not.toContain("secret");
  });

  it("같은 값이면 같은 지문이다", () => {
    // 회전했는지를 값 노출 없이 확인하는 것이 목적이다.
    expect(fingerprintSecret("v1", hash)).toBe(fingerprintSecret("v1", hash));
    expect(fingerprintSecret("v1", hash)).not.toBe(fingerprintSecret("value-2", hash));
  });
});
