import { createPublicKey, verify as cryptoVerify, type KeyObject } from "node:crypto";

/**
 * 출처 확정의 서버 측 근거 — 2026-09-10 실사 A1.
 *
 * 실사가 찾은 것: `source.upload` 권한을 가진 사람이 receipt를 만들 때
 * `signatureValid: true`를 **직접 보내면** 그 문서가 `confirmed_from_source`로
 * 저장됐다. bulk export의 `observedFields`도 요청자가 적어 보냈다. 즉
 * **업로더의 진술이 독립된 출처 검증 결과로 격상**됐다.
 *
 * 그 경로에서 확정의 뜻은 "우리가 확인했다"가 아니라 "올린 사람이 그렇다고
 * 했다"이다. 제품의 핵심이 출처 등급이므로 그 차이가 제품 전체의 의미를 정한다.
 *
 * 이 파일은 확정의 근거를 **서버가 만든다.** 두 가지다.
 *
 * 1. 서명 문서 — 업로드된 바이트, 분리 서명, 연동에 등록된 공개키로 검증한다.
 * 2. bulk export — 업로드된 파일에서 필드 목록을 **직접 뽑는다.**
 *
 * 어느 쪽도 요청 본문의 값을 믿지 않는다.
 */

/**
 * 검증기 버전.
 *
 * 확정 근거에 함께 남는다. 검증 규칙이 바뀌면 올린다 — 과거 receipt가 어느
 * 규칙으로 확정됐는지 재현할 수 없으면 그 확정은 근거를 잃는다.
 */
export const SIGNATURE_VERIFIER_VERSION = "sig-1";
export const BULK_EXTRACTOR_VERSION = "bulk-1";

/**
 * 필드를 뽑기 위해 메모리에 올릴 상한.
 *
 * 업로드 자체의 상한(2GiB)과 다르다. 여기서는 파일 전체를 문자열로 올리므로
 * 훨씬 작아야 한다. 넘으면 확정하지 않고 사람에게 넘긴다 — 조용히 앞부분만
 * 읽으면 뒤쪽 컬럼이 없는 것으로 판정된다.
 */
export const MAX_BULK_EXTRACT_BYTES = 32 * 1024 * 1024;

export type VerificationFailure = {
  readonly ok: false;
  readonly reason: string;
  readonly nextAction: string;
};

export type SignatureCheck =
  | {
      readonly ok: true;
      /** 서명이 이 키로 검증됐다. */
      readonly signatureValid: true;
      readonly keyType: string;
      readonly algorithm: string | null;
    }
  | (VerificationFailure & {
      /** false는 검증 실패, null은 검증을 시도하지 못한 것이다. */
      readonly signatureValid: false | null;
    });

/**
 * 공개키로 분리 서명을 검증한다.
 *
 * **알고리즘을 요청자가 고르지 않는다.** 키 종류가 알고리즘을 정한다 —
 * Ed25519는 해시를 따로 걸지 않고(그래서 `null`), RSA·EC는 SHA-256이다.
 * 요청자가 고를 수 있으면 약한 조합을 고르는 것으로 검증을 우회할 수 있다.
 */
export function verifyDetachedSignature(input: {
  readonly bytes: Uint8Array;
  readonly signature: Uint8Array;
  readonly publicKeyPem: string;
}): SignatureCheck {
  let key: KeyObject;
  try {
    key = createPublicKey(input.publicKeyPem);
  } catch {
    // 키를 읽지 못한 것은 서명이 틀린 것과 다르다. 전자는 우리 설정 문제다.
    return {
      ok: false,
      signatureValid: null,
      reason: "연동에 등록된 공개키를 읽지 못했다",
      nextAction: "연동의 signing_key_reference가 가리키는 PEM 공개키를 확인한다",
    };
  }

  const keyType = key.asymmetricKeyType ?? "unknown";
  // Ed25519·Ed448은 알고리즘 인자를 받지 않는다. 주면 검증이 던진다.
  const algorithm = keyType === "ed25519" || keyType === "ed448" ? null : "sha256";

  let valid: boolean;
  try {
    valid = cryptoVerify(algorithm, input.bytes, key, input.signature);
  } catch {
    // 서명 바이트가 형식에 맞지 않는 경우가 여기로 온다. 검증 실패로 본다 —
    // 우리가 확인할 수 없는 서명은 없는 서명과 같다.
    return {
      ok: false,
      signatureValid: false,
      reason: "서명을 검증하지 못했다",
      nextAction: "서명 파일이 이 문서에 대한 분리 서명인지 확인한다",
    };
  }

  if (!valid) {
    return {
      ok: false,
      signatureValid: false,
      reason: "서명이 문서와 맞지 않는다",
      nextAction: "문서가 변조됐는지, 다른 서명자의 서명인지 확인한다",
    };
  }

  return { ok: true, signatureValid: true, keyType, algorithm };
}

export type FieldExtraction =
  | { readonly ok: true; readonly fields: readonly string[] }
  | VerificationFailure;

/** UTF-8 BOM은 첫 컬럼 이름에 눈에 보이지 않게 붙는다. */
function stripBom(value: string): string {
  return value.charCodeAt(0) === 0xfeff ? value.slice(1) : value;
}

/**
 * CSV 머리글 한 줄을 컬럼 이름으로 나눈다.
 *
 * 인용부호 안의 쉼표를 지킨다. 머리글만 읽으므로 전체 CSV 파서를 두지 않는다 —
 * 본문 파싱은 이 판정에 필요하지 않고, 없는 코드는 틀리지 않는다.
 */
function parseCsvHeader(line: string): string[] {
  const fields: string[] = [];
  let current = "";
  let quoted = false;

  for (let index = 0; index < line.length; index += 1) {
    const char = line[index]!;

    if (quoted) {
      if (char === '"') {
        if (line[index + 1] === '"') {
          current += '"';
          index += 1;
        } else {
          quoted = false;
        }
      } else {
        current += char;
      }
      continue;
    }

    if (char === '"') {
      quoted = true;
    } else if (char === ",") {
      fields.push(current.trim());
      current = "";
    } else {
      current += char;
    }
  }

  fields.push(current.trim());
  return fields;
}

/**
 * 파일에서 관측된 필드를 뽑는다.
 *
 * **요청자가 보낸 목록을 쓰지 않는다.** 그 목록은 파일과 무관할 수 있고, 그러면
 * schema drift 대조가 대조하는 시늉만 한다.
 */
export function extractObservedFields(
  bytes: Uint8Array,
  contentType: string,
): FieldExtraction {
  if (bytes.byteLength === 0) {
    return {
      ok: false,
      reason: "빈 파일에서는 스키마를 읽을 수 없다",
      nextAction: "출처가 내려준 파일을 다시 올린다",
    };
  }
  if (bytes.byteLength > MAX_BULK_EXTRACT_BYTES) {
    return {
      ok: false,
      reason: `스키마를 읽기 위한 상한(${MAX_BULK_EXTRACT_BYTES} bytes)을 넘는 파일이다`,
      nextAction: "머리글을 포함한 부분 파일로 나누어 올리거나 수동 확인 경로를 쓴다",
    };
  }

  const text = stripBom(Buffer.from(bytes).toString("utf8"));
  const media = contentType.split(";")[0]!.trim().toLowerCase();

  if (media === "text/csv" || media === "text/plain" || media === "application/vnd.ms-excel") {
    const header = text.split(/\r?\n/).find((line) => line.trim().length > 0);
    if (!header) {
      return {
        ok: false,
        reason: "머리글 줄이 없다",
        nextAction: "컬럼 이름이 첫 줄에 있는 파일을 올린다",
      };
    }
    const fields = parseCsvHeader(header).filter((field) => field.length > 0);
    if (fields.length === 0) {
      return {
        ok: false,
        reason: "머리글에서 컬럼 이름을 읽지 못했다",
        nextAction: "컬럼 이름이 첫 줄에 있는 파일을 올린다",
      };
    }
    return { ok: true, fields };
  }

  if (media === "application/json") {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      return {
        ok: false,
        reason: "JSON으로 읽히지 않는다",
        nextAction: "출처가 내려준 파일이 맞는지 확인한다",
      };
    }

    // 레코드 배열이면 첫 레코드의 키가 컬럼이다. 전체를 훑어 합집합을 만들지
    // 않는다 — 합집합은 뒤 레코드에만 있는 필드를 "있다"로 만들고, 그러면
    // 사라진 컬럼(더 위험한 쪽)이 가려진다.
    const record = Array.isArray(parsed) ? parsed[0] : parsed;
    if (record === null || typeof record !== "object" || Array.isArray(record)) {
      return {
        ok: false,
        reason: "레코드 객체를 찾지 못했다",
        nextAction: "레코드 배열 또는 객체 형태의 파일을 올린다",
      };
    }
    return { ok: true, fields: Object.keys(record as Record<string, unknown>) };
  }

  return {
    ok: false,
    reason: `이 형식에서는 스키마를 읽을 수 없다: ${media}`,
    nextAction: "CSV 또는 JSON으로 받은 원본을 올리거나 수동 확인 경로를 쓴다",
  };
}
