import { keccak256, type Hex } from "@mpc/canonical";

/**
 * 객체 저장 — 05 §5.2, 06 §6.7.
 *
 * 두 가지 규칙이 이 모듈의 전부다.
 *
 * 1. **키에 파일명이나 프로젝트 이름을 넣지 않는다.** 저장소 키는 로그·서명 URL·
 *    에러 메시지를 타고 흐른다. 문서 제목조차 public projection에 누출돼서는
 *    안 된다(§11.9).
 * 2. **업로드는 quarantine 경로로 먼저 들어간다.** 검사를 통과해야 evidence
 *    경로로 승격된다. 업로드 즉시 evidence가 되면 악성 파일이 검토 대상 자료가 된다.
 *
 * 인터페이스로 분리한 이유: 실제 S3는 통합 테스트에서만 필요하고, 도메인 규칙
 * (키 규칙·해시·quarantine 전이)은 저장소 없이 검증할 수 있어야 한다.
 */

export function quarantineKey(tenantId: string, uploadId: string): string {
  return `quarantine/${tenantId}/${uploadId}`;
}

export function evidenceKey(tenantId: string, artifactId: string): string {
  return `evidence/${tenantId}/${artifactId}`;
}

export function computeContentHash(bytes: Uint8Array): Hex {
  return keccak256(bytes);
}

export interface StoredObject {
  readonly key: string;
  readonly contentHash: Hex;
  readonly byteSize: number;
  readonly contentType: string;
}

export interface ObjectStore {
  put(key: string, body: Uint8Array, contentType: string): Promise<StoredObject>;
  /**
   * 스트리밍 업로드.
   *
   * 대용량 파일을 메모리에 통째로 올리지 않는다. content hash는 흘려보내면서
   * 계산하므로 **바이트를 두 번 읽지 않는다** — 저장 후 다시 읽어 해시하면
   * 그 사이에 바뀐 것을 잡지 못한다.
   */
  putStream(
    key: string,
    body: AsyncIterable<Uint8Array>,
    contentType: string,
  ): Promise<StoredObject>;
  get(key: string): Promise<Uint8Array | null>;
  /** 짧은 수명의 scoped URL. 영구 공개 URL을 만들지 않는다(06 §6.7). */
  presignGet(key: string, ttlSeconds: number): Promise<string>;
  /** quarantine → evidence 승격. 원본 키는 남긴다. */
  copy(fromKey: string, toKey: string): Promise<void>;
}

/** presigned URL의 상한. 그보다 긴 수명을 요청해도 잘라낸다. */
export const MAX_PRESIGN_TTL_SECONDS = 900;

/**
 * 메모리 구현.
 *
 * 개발과 테스트에 쓴다. 프로세스가 죽으면 사라지므로 운영에서 쓸 수 없다 —
 * `loadConfig`가 production에서 이것을 고르면 시작 자체를 막는다.
 */
export function createMemoryObjectStore(): ObjectStore & { size(): number } {
  const objects = new Map<string, { body: Uint8Array; contentType: string }>();

  return {
    async put(key, body, contentType) {
      objects.set(key, { body, contentType });
      return {
        key,
        contentHash: computeContentHash(body),
        byteSize: body.byteLength,
        contentType,
      };
    },

    async putStream(key, body, contentType) {
      const chunks: Uint8Array[] = [];
      let total = 0;
      for await (const chunk of body) {
        chunks.push(chunk);
        total += chunk.byteLength;
      }

      const merged = new Uint8Array(total);
      let offset = 0;
      for (const chunk of chunks) {
        merged.set(chunk, offset);
        offset += chunk.byteLength;
      }

      objects.set(key, { body: merged, contentType });
      return {
        key,
        contentHash: computeContentHash(merged),
        byteSize: merged.byteLength,
        contentType,
      };
    },

    async get(key) {
      return objects.get(key)?.body ?? null;
    },

    async presignGet(key, ttlSeconds) {
      const ttl = Math.min(ttlSeconds, MAX_PRESIGN_TTL_SECONDS);
      return `memory://${key}?ttl=${ttl}`;
    },

    async copy(fromKey, toKey) {
      const source = objects.get(fromKey);
      if (!source) throw new Error(`복사할 객체가 없다: ${fromKey}`);
      objects.set(toKey, source);
    },

    size() {
      return objects.size;
    },
  };
}

/**
 * 업로드 상태 전이 — 0007_object_uploads.sql의 enum과 같다.
 *
 * `received → quarantined → scanned_clean → promoted`가 정상 경로다.
 * 감염된 파일은 `scanned_infected`에서 멈추고 절대 promoted로 가지 않는다.
 */
export const UPLOAD_STATES = [
  "received",
  "quarantined",
  "scanned_clean",
  "scanned_infected",
  "promoted",
  "rejected",
] as const;

export type UploadState = (typeof UPLOAD_STATES)[number];

const UPLOAD_TRANSITIONS: Readonly<Record<UploadState, readonly UploadState[]>> = {
  received: ["quarantined", "rejected"],
  quarantined: ["scanned_clean", "scanned_infected", "rejected"],
  scanned_clean: ["promoted", "rejected"],
  // 감염 판정은 되돌릴 수 없다. 재검사가 필요하면 새로 업로드한다.
  scanned_infected: ["rejected"],
  promoted: [],
  rejected: [],
};

export function canTransitionUpload(from: UploadState, to: UploadState): boolean {
  return UPLOAD_TRANSITIONS[from].includes(to);
}

/** 감염 파일이 evidence로 승격되는 경로가 없는지 확인한다. */
export function infectedCanNeverBePromoted(): boolean {
  const visited = new Set<UploadState>();
  const queue: UploadState[] = ["scanned_infected"];

  while (queue.length > 0) {
    const current = queue.shift()!;
    if (current === "promoted") return false;
    if (visited.has(current)) continue;
    visited.add(current);
    queue.push(...UPLOAD_TRANSITIONS[current]);
  }

  return true;
}
