import { keccak256, type Hex } from "@mpc/canonical";

/**
 * Object store — 05 §5.2, 06 §6.7.
 *
 * This module is two rules.
 *
 * 1. **Keys never contain file names or project names.** Store keys flow through logs, signed
 *    URLs, and error messages. Not even a document title may leak into the public projection
 *    (§11.9).
 * 2. **Uploads land in the quarantine path first.** Only after passing the scan are they promoted
 *    to the evidence path. If uploads became evidence immediately, malicious files would become
 *    review material.
 *
 * Why an interface: real S3 is needed only in integration tests, and the domain rules (key rules,
 * hashing, quarantine transitions) must be verifiable without a store.
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
   * Streaming upload.
   *
   * Large files are never loaded into memory whole. The content hash is computed while streaming,
   * so **bytes are never read twice** — re-reading after storage to hash would miss changes in
   * between.
   */
  putStream(
    key: string,
    body: AsyncIterable<Uint8Array>,
    contentType: string,
  ): Promise<StoredObject>;
  get(key: string): Promise<Uint8Array | null>;
  /** Short-lived scoped URL. Never creates a permanent public URL (06 §6.7). */
  presignGet(key: string, ttlSeconds: number): Promise<string>;
  /** quarantine → evidence promotion. The source key remains. */
  copy(fromKey: string, toKey: string): Promise<void>;
}

/** Cap on presigned URL lifetime. Longer requests are clamped. */
export const MAX_PRESIGN_TTL_SECONDS = 900;

/**
 * In-memory implementation.
 *
 * For development and tests. It vanishes when the process dies, so it cannot be used in
 * production — if `loadConfig` selects it in production, startup is blocked.
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
      if (!source) throw new Error(`no object to copy: ${fromKey}`);
      objects.set(toKey, source);
    },

    size() {
      return objects.size;
    },
  };
}

/**
 * Upload state transitions — matches the enum in 0007_object_uploads.sql.
 *
 * `received → quarantined → scanned_clean → promoted` is the normal path.
 * An infected file stops at `scanned_infected` and never reaches promoted.
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
  // An infected verdict is irreversible. Re-scanning requires a fresh upload.
  scanned_infected: ["rejected"],
  promoted: [],
  rejected: [],
};

export function canTransitionUpload(from: UploadState, to: UploadState): boolean {
  return UPLOAD_TRANSITIONS[from].includes(to);
}

/** Checks that no path promotes an infected file to evidence. */
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
