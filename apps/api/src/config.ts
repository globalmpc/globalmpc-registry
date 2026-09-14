import { createHash } from "node:crypto";
import { z } from "zod";
import { fingerprintSecret, parseSecretReference, resolveSecret } from "@mpc/config";
import type { SecretAudit } from "@mpc/config";

/**
 * 환경변수는 시작 시 한 번 검증한다.
 *
 * 런타임 중간에 누락을 발견하면 이미 요청을 받은 뒤다. 06 §6.4의 secret
 * management 요구는 "시작 시 존재를 확인한다"를 포함한다.
 *
 * 비밀은 값 대신 **참조**로 받을 수 있다(`file:`·`env:`·`plain:`). 배포 환경은
 * 마운트된 파일을 읽고, 로컬·CI는 값 그대로 쓴다. 두 경로가 같은 코드를 지나므로
 * "배포에서만 다르게 동작"하는 구간이 생기지 않는다.
 */

/** 참조로 받을 수 있는 변수. 나머지는 비밀이 아니다. */
const SECRET_VARIABLES = [
  "DATABASE_URL",
  "SESSION_SECRET",
  "OBJECT_SECRET_ACCESS_KEY",
] as const;
const schema = z.object({
  PORT: z.coerce.number().int().positive().default(3001),
  DATABASE_URL: z.string().min(1),
  SIWE_DOMAIN: z.string().min(1),
  SIWE_URI: z.string().url(),
  // BSC mainnet 56 / testnet 97만 허용한다. 다른 체인에 앵커하면 Explorer의
  // 검증 경로가 갈라진다.
  CHAIN_ID: z.coerce.number().refine((value) => value === 56 || value === 97, {
    message: "CHAIN_ID는 56(BSC mainnet) 또는 97(BSC testnet)이어야 한다",
  }),
  SESSION_SECRET: z.string().min(32, "SESSION_SECRET은 32자 이상이어야 한다"),
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),

  /**
   * 요청 상한 — 06 §6.9.
   *
   * 값을 코드에 박지 않는다. 정상 사용량은 배포마다 다르고, 상한이 낮아
   * 사용자가 막히는 것과 높아 무의미한 것 사이의 선택은 운영이 한다.
   *
   * **끄는 값을 두지 않는다.** 0을 허용하면 "잠깐 꺼 두자"가 영구가 된다.
   */
  RATE_LIMIT_MAX: z.coerce.number().int().positive().default(300),
  /** 로그인 경로의 상한. 인증 없이 행을 만들거나 서명을 검증하므로 훨씬 좁다. */
  AUTH_RATE_LIMIT_MAX: z.coerce.number().int().positive().default(10),

  /**
   * 요청 총시간 상한.
   *
   * Fastify는 이 값을 **끈 채로** 만들어진다(`requestTimeout: 0`). 즉 요청 하나가
   * 영원히 열려 있을 수 있었고, 그 표면은 인터넷에서 도달한다.
   *
   * 기본값을 300초로 두는 이유는 **스트리밍 업로드가 같은 서버에 있기 때문**이다
   * (`/uploads/stream`, 최대 2GiB). 여기를 30초로 조이면 느린 회선의 정상 업로드가
   * 끊긴다. 짧은 요청을 더 좁히고 싶으면 배포에서 이 값을 낮추고 업로드는
   * 별도 경로로 분리한다 — 그 분리는 서비스 분리 결정에 걸려 있다.
   *
   * **끄는 값을 두지 않는다.** 0을 허용하면 지금 상태로 되돌아간다.
   */
  REQUEST_TIMEOUT_MS: z.coerce.number().int().positive().default(300_000),

  /**
   * 소켓 유휴 상한.
   *
   * `requestTimeout`과 다른 것을 막는다. 이쪽은 **아무것도 보내지 않는 연결**을
   * 끊는다. 전송이 이어지는 동안에는 갱신되므로 큰 업로드를 자르지 않는다 —
   * 그래서 총시간 상한보다 훨씬 좁게 잡을 수 있다.
   *
   * Fastify 기본값도 0(무제한)이다. `headersTimeout` 60초는 헤더까지만 본다.
   */
  SOCKET_IDLE_TIMEOUT_MS: z.coerce.number().int().positive().default(60_000),

  /**
   * 요청자를 정할 때 신뢰하는 프록시 홉 수.
   *
   * 배포에서 API는 `web`의 `/api/*` 프록시를 지나서만 도달한다. 소켓 주소는 항상
   * web 컨테이너이므로, 그것으로 상한을 세면 **무인증 경로의 상한이 사이트 전체
   * 합산**이 된다 — 한 사람이 로그인 몫을 다 쓰면 그 분에는 아무도 로그인하지
   * 못한다.
   *
   * 그래서 `x-forwarded-for`를 **오른쪽에서** 이 홉 수만큼 건너뛴 값을 요청자로
   * 본다. 왼쪽 항목은 요청자가 마음대로 채울 수 있으므로 세지 않는다 — 홉 수를
   * 늘려 잡으면 그 순간 상한이 위조 가능해진다.
   *
   * 기본값 1의 근거: Traefik(Coolify)이 자기가 본 클라이언트 주소를 오른쪽 끝에
   * 붙이고, Next의 프록시는 받은 헤더를 **그대로 통과시킨다**(항목을 더하지
   * 않는다). 그래서 신뢰할 홉은 web 하나뿐이다.
   *
   * Next 쪽은 실측이다 — `next start`(Next 16.3.0)에 echo 서버를 물려 확인했다.
   * `x-forwarded-for: 9.9.9.9, 203.0.113.7`을 보내면 그대로 도착하고, 헤더가
   * 없을 때만 peer 주소로 채운다. **Next를 올릴 때 이 동작을 다시 확인한다** —
   * Next가 항목을 하나 더 붙이기 시작하면 오른쪽 끝이 web 컨테이너 주소가 되어
   * 이 값이 조용히 틀린 값이 된다.
   *
   * 프록시가 더 늘면(앞단 CDN 등) 그만큼 올린다. 0은 헤더를 아예 믿지 않고 소켓
   * 주소를 쓴다 — 프록시 없이 직접 노출할 때만 맞는 값이다.
   */
  TRUSTED_PROXY_HOPS: z.coerce.number().int().min(0).default(1),

  /**
   * `x-forwarded-*`를 믿어 줄 **피어 주소**. 쉼표로 나눈 IP·CIDR 목록.
   *
   * 홉 수만으로 믿던 것을 fastify 5.12.1이 없앴다(GHSA-97wr-x83h-mw3v 계열).
   * 이유가 정확하다 — 홉 수는 **바로 앞 상대가 누구인지 검사하지 않으므로**,
   * 프록시를 거치지 않고 직접 닿은 요청이 `x-forwarded-for`를 스스로 채워
   * 요청자 주소를 꾸밀 수 있다. 그러면 무인증 경로의 상한이 우회된다.
   *
   * 기본값은 사설 대역이다. 이 API는 배포에서 같은 네트워크의 `web`을 통해서만
   * 닿게 되어 있으므로, 공인 주소에서 직접 온 요청은 헤더를 믿지 않는다.
   * 앞단이 더 있으면(CDN 등) 그 대역을 여기에 적는다.
   */
  TRUSTED_PROXY_CIDRS: z
    .string()
    .default("127.0.0.0/8,10.0.0.0/8,172.16.0.0/12,192.168.0.0/16,::1/128,fc00::/7"),

  /**
   * 객체 저장 — OD-22.
   *
   * `memory`는 프로세스가 죽으면 사라진다. production에서 고르면 증빙 원문이
   * 재시작마다 사라지는데 그 사실이 아무 데도 드러나지 않는다.
   */
  OBJECT_STORE: z.enum(["memory", "s3"]).default("memory"),
  OBJECT_BUCKET: z.string().optional(),
  /**
   * 저장 리전. **기본값을 두지 않는다** — OD-17(원문 저장 관할)이 정해지기
   * 전까지 어느 리전도 "합리적 기본값"이 아니다. 기본값을 두면 그것이 결정이 된다.
   */
  OBJECT_REGION: z.string().optional(),
  OBJECT_ENDPOINT: z.string().url().optional(),
  /**
   * presigned URL용 공개 엔드포인트.
   *
   * 서버가 저장소를 부르는 주소와 브라우저가 접근할 수 있는 주소가 다를 때
   * 지정한다. 비면 `OBJECT_ENDPOINT`를 쓴다.
   */
  OBJECT_PUBLIC_ENDPOINT: z.string().url().optional(),
  OBJECT_FORCE_PATH_STYLE: z.enum(["true", "false"]).default("false"),
  /**
   * 서버 측 암호화 방식.
   *
   * `none`은 **로컬 MinIO 전용**이다. MinIO는 KMS 없이 SSE 요청을 거절하는데,
   * 그 차이 때문에 로컬에서 암호화 경로를 못 돌려 보면 배포에서 처음 만나게 된다.
   * production에서 `none`은 거절한다 — 원문이 평문으로 남는다.
   */
  OBJECT_SSE: z.enum(["none", "aes256", "kms"]).default("aes256"),
  /** KMS 키. `OBJECT_SSE=kms`일 때 필요하다. tenant별 분리는 OD-18에 종속된다. */
  OBJECT_KMS_KEY_ID: z.string().optional(),
  OBJECT_ACCESS_KEY_ID: z.string().optional(),
  OBJECT_SECRET_ACCESS_KEY: z.string().optional(),

  /**
   * 거버넌스 투표 무게 — 04 §4.5.
   *
   * 토큰 주소가 없으면 스냅숏을 만들지 않고 수동 무게로 떨어진다. 토큰이
   * 배포되기 전에는 읽을 잔고가 없고, 빈 값을 0으로 기록하면 투표권을
   * 조용히 뺏는다.
   */
  CHAIN_RPC_URL: z.string().url().optional(),
  GOVERNANCE_TOKEN_ADDRESS: z
    .string()
    .regex(/^0x[0-9a-fA-F]{40}$/)
    .optional(),
  /** 스냅숏 블록 깊이. head는 재구성될 수 있으므로 뒤로 물린다. */
  GOVERNANCE_CONFIRMATIONS: z.coerce.number().int().min(1).default(12),
});

export interface ObjectStoreConfig {
  readonly kind: "memory" | "s3";
  readonly bucket?: string;
  readonly region?: string;
  readonly endpoint?: string;
  readonly publicEndpoint?: string;
  readonly forcePathStyle: boolean;
  readonly sse: "none" | "aes256" | "kms";
  readonly kmsKeyId?: string;
  readonly credentials?: { accessKeyId: string; secretAccessKey: string };
}

export interface AppConfig {
  /** 어떤 비밀을 어떤 경로로 읽었는지. 값은 담지 않는다. */
  readonly secretAudit: readonly SecretAudit[];
  readonly objectStore: ObjectStoreConfig;
  readonly chainRpcUrl: string | null;
  readonly governanceTokenAddress: string | null;
  readonly governanceConfirmationDepth: number;
  readonly port: number;
  readonly databaseUrl: string;
  readonly siweDomain: string;
  readonly siweUri: string;
  readonly chainId: number;
  readonly sessionSecret: string;
  readonly nodeEnv: "development" | "test" | "production";
  readonly rateLimitMax: number;
  readonly authRateLimitMax: number;
  /** 요청자 판정에서 신뢰할 프록시 홉 수. 0이면 헤더를 믿지 않는다. */
  readonly trustedProxyHops: number;
  /** 그 홉이 이 대역 안에 있을 때만 헤더를 믿는다. 비면 아무도 믿지 않는다. */
  readonly trustedProxyCidrs: readonly string[];
  /** 요청 총시간 상한(ms). 0이 될 수 없다 — 스키마가 양수를 요구한다. */
  readonly requestTimeoutMs: number;
  /** 소켓 유휴 상한(ms). 전송 중에는 갱신되므로 큰 업로드를 자르지 않는다. */
  readonly socketIdleTimeoutMs: number;
}

export class ConfigError extends Error {
  readonly code = "CONFIG_INVALID";
}

/**
 * 빈 문자열을 "주지 않은 것"으로 읽는다.
 *
 * 배포 플랫폼은 선언된 변수를 값이 없어도 빈 문자열로 주입한다. Coolify는 compose
 * 파일을 파싱해 만든 변수 목록을 **모든 컨테이너에** 넣으므로, anchor worker용으로
 * 비워 둔 `CHAIN_RPC_URL`이 API에도 `""`로 들어온다. `.url().optional()`은
 * undefined는 통과시키지만 빈 문자열은 거절하므로 API가 시작 직후 죽는다.
 *
 * 값을 주지 않은 것과 빈 값을 준 것을 구분할 이유가 이 설정에는 없다. 필수 항목은
 * 빈 문자열이 지워진 뒤 "Required"로 걸리므로 오히려 사유가 정확해진다.
 */
function dropEmpty(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const kept: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(env)) {
    if (typeof value === "string" && value.trim() === "") continue;
    kept[name] = value;
  }
  return kept;
}

export function loadConfig(rawEnv: NodeJS.ProcessEnv): AppConfig {
  const env = dropEmpty(rawEnv);
  // 참조를 먼저 값으로 바꾼 뒤 스키마를 돌린다. 순서가 반대면 `file:/run/...`이
  // URL 검증에 걸려 무엇이 문제인지 알 수 없는 오류가 난다.
  const resolved: NodeJS.ProcessEnv = { ...env };
  const secretAudit: SecretAudit[] = [];

  for (const name of SECRET_VARIABLES) {
    const raw = env[name];
    if (raw === undefined) continue;
    const value = resolveSecret(name, raw, undefined, env);
    resolved[name] = value;
    secretAudit.push({
      variableName: name,
      scheme: parseSecretReference(raw).scheme,
      fingerprint: fingerprintSecret(value, (input) =>
        createHash("sha256").update(input).digest("hex"),
      ),
    });
  }

  const parsed = schema.safeParse(resolved);

  if (!parsed.success) {
    // 값이 아니라 키와 사유만 보고한다. 값을 찍으면 로그에 secret이 남는다.
    const issues = parsed.error.issues
      .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
      .join("; ");
    throw new ConfigError(`환경변수가 유효하지 않다 — ${issues}`);
  }

  const value = parsed.data;

  // production에서 메모리 저장소를 고르면 증빙 원문이 재시작마다 사라진다.
  // 조용히 동작하는 것이 최악이므로 시작 자체를 막는다.
  if (value.NODE_ENV === "production" && value.OBJECT_STORE === "memory") {
    throw new ConfigError("production에서 OBJECT_STORE=memory를 쓸 수 없다");
  }

  if (value.OBJECT_STORE === "s3") {
    // 리전을 요구하는 것이 OD-17을 코드로 강제하는 지점이다. 기본값이 있으면
    // 아무도 결정하지 않은 채 어딘가에 저장된다.
    if (!value.OBJECT_BUCKET || !value.OBJECT_REGION) {
      throw new ConfigError(
        "OBJECT_STORE=s3에는 OBJECT_BUCKET과 OBJECT_REGION이 필요하다 (리전은 OD-17 결정 사항)",
      );
    }

    if (value.OBJECT_SSE === "kms" && !value.OBJECT_KMS_KEY_ID) {
      throw new ConfigError("OBJECT_SSE=kms에는 OBJECT_KMS_KEY_ID가 필요하다");
    }
  }

  // 암호화를 끈 채로 운영하면 증빙 원문이 평문으로 남는다. 로컬 MinIO 전용이다.
  if (value.NODE_ENV === "production" && value.OBJECT_SSE === "none") {
    throw new ConfigError("production에서 OBJECT_SSE=none을 쓸 수 없다");
  }

  const objectStore: ObjectStoreConfig = {
    kind: value.OBJECT_STORE,
    ...(value.OBJECT_BUCKET ? { bucket: value.OBJECT_BUCKET } : {}),
    ...(value.OBJECT_REGION ? { region: value.OBJECT_REGION } : {}),
    ...(value.OBJECT_ENDPOINT ? { endpoint: value.OBJECT_ENDPOINT } : {}),
    ...(value.OBJECT_PUBLIC_ENDPOINT ? { publicEndpoint: value.OBJECT_PUBLIC_ENDPOINT } : {}),
    forcePathStyle: value.OBJECT_FORCE_PATH_STYLE === "true",
    sse: value.OBJECT_SSE,
    ...(value.OBJECT_KMS_KEY_ID ? { kmsKeyId: value.OBJECT_KMS_KEY_ID } : {}),
    ...(value.OBJECT_ACCESS_KEY_ID && value.OBJECT_SECRET_ACCESS_KEY
      ? {
          credentials: {
            accessKeyId: value.OBJECT_ACCESS_KEY_ID,
            secretAccessKey: value.OBJECT_SECRET_ACCESS_KEY,
          },
        }
      : {}),
  };

  return {
    port: value.PORT,
    databaseUrl: value.DATABASE_URL,
    siweDomain: value.SIWE_DOMAIN,
    siweUri: value.SIWE_URI,
    chainId: value.CHAIN_ID,
    sessionSecret: value.SESSION_SECRET,
    nodeEnv: value.NODE_ENV,
    rateLimitMax: value.RATE_LIMIT_MAX,
    authRateLimitMax: value.AUTH_RATE_LIMIT_MAX,
    trustedProxyHops: value.TRUSTED_PROXY_HOPS,
    trustedProxyCidrs: value.TRUSTED_PROXY_CIDRS.split(",")
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0),
    requestTimeoutMs: value.REQUEST_TIMEOUT_MS,
    socketIdleTimeoutMs: value.SOCKET_IDLE_TIMEOUT_MS,
    secretAudit,
    objectStore,
    chainRpcUrl: value.CHAIN_RPC_URL ?? null,
    governanceTokenAddress: value.GOVERNANCE_TOKEN_ADDRESS?.toLowerCase() ?? null,
    governanceConfirmationDepth: value.GOVERNANCE_CONFIRMATIONS,
  };
}
