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
 * S3 호환 객체 저장 — 05 §5.2, 06 §6.7, OD-22.
 *
 * **envelope encryption을 서버 측 KMS 키로 건다.** 버킷 기본 암호화에만 의존하면
 * 버킷 정책 변경 한 번으로 평문 저장으로 바뀔 수 있고, 그것이 바뀌었다는 사실이
 * 애플리케이션에는 보이지 않는다. 요청마다 명시하면 키가 없을 때 쓰기가 실패한다 —
 * 조용히 평문으로 저장되는 것보다 낫다.
 *
 * 리전과 키 소유권은 OD-17·OD-18에 종속된다. 이 모듈은 **어디에 둘지를 정하지
 * 않고** 설정으로 받는다. 기본값을 두면 그 기본값이 결정이 되어 버린다.
 */

export interface S3StoreOptions {
  readonly bucket: string;
  readonly region: string;
  /** MinIO 같은 S3 호환 저장소. 비면 AWS S3를 쓴다. */
  readonly endpoint?: string;
  /**
   * presigned URL을 만들 때 쓸 엔드포인트.
   *
   * 서버가 저장소를 부르는 주소와 **브라우저가 접근할 수 있는 주소는 다르다.**
   * 컨테이너 안에서는 `http://minio:9000`이지만 그 호스트명은 밖에서 풀리지
   * 않는다. 서명은 호스트를 포함하므로 나중에 바꿔 끼울 수 없다 — 서명할 때
   * 공개 주소를 써야 한다.
   *
   * 비면 `endpoint`를 그대로 쓴다(AWS S3는 둘이 같다).
   */
  readonly publicEndpoint?: string;
  /** MinIO는 path-style을 요구한다. */
  readonly forcePathStyle?: boolean;
  /**
   * 서버 측 암호화 방식.
   *
   * `none`은 로컬 MinIO 전용이다 — MinIO는 KMS 없이 SSE 요청을 거절한다.
   * production에서 `none`은 `loadConfig`가 막는다.
   */
  readonly sse: "none" | "aes256" | "kms";
  /**
   * KMS 키 ARN/ID. `sse: "kms"`일 때 쓴다.
   *
   * OD-18이 정해지기 전까지 tenant별 키를 나눌 수 없으므로 단일 키다. 그 사실을
   * 설정으로 드러내 두면 나중에 무엇을 바꿔야 하는지 코드가 말해 준다.
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

  // 서명 전용 클라이언트. 엔드포인트만 다르고 자격증명·리전은 같다.
  const presignClient =
    options.publicEndpoint && options.publicEndpoint !== options.endpoint
      ? new S3Client({ ...clientConfig, endpoint: options.publicEndpoint })
      : client;

  /**
   * 모든 쓰기에 같은 암호화 지시를 붙인다. 한 곳에서만 정의한다.
   *
   * 버킷 기본 암호화에만 의존하지 않는 이유: 정책 변경 한 번으로 평문 저장이
   * 되는데 애플리케이션에는 그것이 보이지 않는다. 요청마다 명시하면 키가 없을 때
   * 쓰기가 실패한다 — 조용히 평문으로 저장되는 것보다 낫다.
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
          // 저장소가 계산한 해시가 아니라 우리가 계산한 것을 메타데이터로 남긴다.
          // 나중에 무결성을 확인할 때 저장소를 신뢰 기반에서 뺄 수 있다.
          Metadata: { "content-hash": contentHash },
          ...encryption,
        }),
      );

      return { key, contentHash, byteSize: body.byteLength, contentType };
    },

    /**
     * 스트리밍 업로드.
     *
     * `lib-storage`의 multipart 업로드를 쓴다. 5MB 이상은 조각으로 나뉘어
     * 올라가므로 파일 전체가 메모리에 있지 않아도 된다.
     *
     * **해시는 흘려보내면서 계산한다.** 저장 후 다시 읽어 해시하면 그 사이의
     * 변경을 잡지 못하고, 읽기 비용도 두 배가 된다.
     */
    async putStream(key, body, contentType): Promise<StoredObject> {
      const parts: Uint8Array[] = [];
      let byteSize = 0;

      // 해시 계산을 위해 조각을 모은다. keccak256이 증분 API를 제공하지 않아
      // 전체가 필요하다 — 그래서 스트리밍의 이득은 S3 전송 쪽에만 있다.
      // 증분 해시로 바꾸려면 canonical 패키지에 streaming keccak을 추가해야 한다.
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
        // 없는 것과 못 읽는 것을 구분한다. 권한 오류를 "없음"으로 뭉개면
        // 설정 실수가 데이터 유실처럼 보인다.
        if ((error as { name?: string }).name === "NoSuchKey") return null;
        throw error;
      }
    },

    async presignGet(key, ttlSeconds): Promise<string> {
      // 상한을 넘는 요청은 잘라낸다. 호출부가 실수로 긴 수명을 주더라도 영구에
      // 가까운 URL이 만들어지지 않는다(06 §6.7).
      const ttl = Math.min(ttlSeconds, MAX_PRESIGN_TTL_SECONDS);
      return getSignedUrl(
        presignClient,
        new GetObjectCommand({
          Bucket: options.bucket,
          Key: key,
          /**
           * 브라우저가 이 객체를 **열지 않고 내려받게** 한다.
           *
           * 저장된 `Content-Type`은 업로더가 정한 값이다. 그대로 나가면
           * `text/html`로 올린 파일이 저장소 오리진에서 실행되고, 그 오리진은
           * 우리 권한 검사를 지나지 않는다.
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
          // 복사본에도 같은 암호화를 건다. 지정하지 않으면 원본의 설정을 따르는데,
          // 원본이 언제 어떤 정책으로 저장됐는지는 보장할 수 없다.
          ...encryption,
        }),
      );
      // 원본은 지우지 않는다. quarantine 기록이 남아야 "무엇이 승격됐는가"를
      // 나중에 확인할 수 있다.
    },
  };
}
