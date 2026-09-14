import { Readable } from "node:stream";
import {
  CopyObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
  type S3ClientConfig,
} from "@aws-sdk/client-s3";
import { Upload } from "@aws-sdk/lib-storage";
import { keccak256 } from "@mpc/canonical";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import {
  computeContentHash,
  MAX_PRESIGN_TTL_SECONDS,
  type ObjectStore,
  type StoredObject,
} from "./storage.js";

/**
 * S3-compatible object store — 05 §5.2, 06 §6.7, OD-22.
 *
 * **Applies envelope encryption with a server-side KMS key.** Relying only on bucket default
 * encryption means one bucket-policy change can switch to plaintext storage, and the application
 * never sees that it changed. Stating it on every request makes writes fail when the key is
 * missing — better than silently storing plaintext.
 *
 * Region and key ownership depend on OD-17 and OD-18. This module **does not decide where data
 * lives**; it takes that from config. A default value would become the decision.
 */

export interface S3StoreOptions {
  readonly bucket: string;
  readonly region: string;
  /** S3-compatible store such as MinIO. When empty, AWS S3 is used. */
  readonly endpoint?: string;
  /**
   * Endpoint used when creating presigned URLs.
   *
   * The address the server uses to reach the store **differs from the one a browser can reach.**
   * Inside the container it is `http://minio:9000`, but that hostname does not resolve outside.
   * The signature covers the host, so it cannot be swapped afterwards — sign with the public
   * address.
   *
   * When empty, `endpoint` is used as-is (they are the same on AWS S3).
   */
  readonly publicEndpoint?: string;
  /** MinIO requires path-style addressing. */
  readonly forcePathStyle?: boolean;
  /**
   * Server-side encryption mode.
   *
   * `none` is for local MinIO only — MinIO rejects SSE requests without KMS.
   * `loadConfig` blocks `none` in production.
   */
  readonly sse: "none" | "aes256" | "kms";
  /**
   * KMS key ARN/ID. Used when `sse: "kms"`.
   *
   * Per-tenant keys are not possible until OD-18 is settled, so this is a single key. Exposing
   * that in config lets the code show what must change later.
   */
  readonly kmsKeyId?: string;
  readonly credentials?: { accessKeyId: string; secretAccessKey: string };
}

export function createS3ObjectStore(options: S3StoreOptions): ObjectStore {
  const clientConfig: S3ClientConfig = {
    region: options.region,
    ...(options.endpoint ? { endpoint: options.endpoint } : {}),
    ...(options.forcePathStyle ? { forcePathStyle: true } : {}),
    ...(options.credentials ? { credentials: options.credentials } : {}),
  };

  const client = new S3Client(clientConfig);

  // Signing-only client. Only the endpoint differs; credentials and region are the same.
  const presignClient =
    options.publicEndpoint && options.publicEndpoint !== options.endpoint
      ? new S3Client({ ...clientConfig, endpoint: options.publicEndpoint })
      : client;

  /**
   * Attaches the same encryption directive to every write. Defined in one place only.
   *
   * Why not rely on bucket default encryption: one policy change makes storage plaintext and the
   * application cannot see it. Stating it per request makes writes fail when the key is missing —
   * better than silently storing plaintext.
   */
  const encryption =
    options.sse === "kms"
      ? { ServerSideEncryption: "aws:kms" as const, SSEKMSKeyId: options.kmsKeyId }
      : options.sse === "aes256"
        ? { ServerSideEncryption: "AES256" as const }
        : {};

  return {
    async put(key, body, contentType): Promise<StoredObject> {
      const contentHash = computeContentHash(body);

      await client.send(
        new PutObjectCommand({
          Bucket: options.bucket,
          Key: key,
          Body: body,
          ContentType: contentType,
          // Store our own hash as metadata, not one computed by the store.
          // Later integrity checks can then leave the store out of the trust base.
          Metadata: { "content-hash": contentHash },
          ...encryption,
        }),
      );

      return { key, contentHash, byteSize: body.byteLength, contentType };
    },

    /**
     * Streaming upload.
     *
     * Uses `lib-storage` multipart upload. Anything over 5MB is uploaded in parts, so the whole
     * file need not be in memory.
     *
     * **The hash is computed while streaming.** Re-reading after storage to hash would miss
     * changes in between and double the read cost.
     */
    async putStream(key, body, contentType): Promise<StoredObject> {
      const parts: Uint8Array[] = [];
      let byteSize = 0;

      // Collect parts for hashing. keccak256 has no incremental API, so the whole body is
      // needed — the streaming benefit applies only to the S3 transfer.
      // Switching to an incremental hash requires adding streaming keccak to the canonical package.
      async function* tee(): AsyncGenerator<Uint8Array> {
        for await (const chunk of body) {
          parts.push(chunk);
          byteSize += chunk.byteLength;
          yield chunk;
        }
      }

      const upload = new Upload({
        client,
        params: {
          Bucket: options.bucket,
          Key: key,
          Body: Readable.from(tee()),
          ContentType: contentType,
          ...encryption,
        },
      });

      await upload.done();

      const merged = new Uint8Array(byteSize);
      let offset = 0;
      for (const part of parts) {
        merged.set(part, offset);
        offset += part.byteLength;
      }

      return { key, contentHash: keccak256(merged), byteSize, contentType };
    },

    async get(key): Promise<Uint8Array | null> {
      try {
        const response = await client.send(
          new GetObjectCommand({ Bucket: options.bucket, Key: key }),
        );
        if (!response.Body) return null;
        return new Uint8Array(await response.Body.transformToByteArray());
      } catch (error) {
        // Distinguish "absent" from "unreadable". Collapsing a permission error into "absent"
        // makes a config mistake look like data loss.
        if ((error as { name?: string }).name === "NoSuchKey") return null;
        throw error;
      }
    },

    async presignGet(key, ttlSeconds): Promise<string> {
      // Clamp requests above the cap. Even if a caller passes a long lifetime by mistake, no
      // near-permanent URL is created (06 §6.7).
      const ttl = Math.min(ttlSeconds, MAX_PRESIGN_TTL_SECONDS);
      return getSignedUrl(
        presignClient,
        new GetObjectCommand({
          Bucket: options.bucket,
          Key: key,
          /**
           * Makes the browser **download this object instead of opening it**.
           *
           * The stored `Content-Type` is whatever the uploader set. Served as-is, a file uploaded
           * as `text/html` would execute on the store's origin, which bypasses our authorization
           * checks.
           */
          ResponseContentDisposition: "attachment",
          ResponseContentType: "application/octet-stream",
        }),
        { expiresIn: ttl },
      );
    },

    async copy(fromKey, toKey): Promise<void> {
      await client.send(
        new CopyObjectCommand({
          Bucket: options.bucket,
          CopySource: `${options.bucket}/${fromKey}`,
          Key: toKey,
          // Apply the same encryption to the copy. Unspecified, it follows the source's setting,
          // and there is no guarantee when or under which policy the source was stored.
          ...encryption,
        }),
      );
      // Do not delete the source. The quarantine record must remain so "what was promoted" can be
      // checked later.
    },
  };
}
