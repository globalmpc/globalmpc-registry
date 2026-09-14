/**
 * 요청자 주소가 공인 주소인지 본다.
 *
 * `TRUSTED_PROXY_HOPS`가 맞는지는 코드가 알 수 없다 — 프록시 수는 배포 환경의
 * 사실이지 이 저장소의 사실이 아니다. 다만 **틀렸을 때의 증상 하나**는 런타임에서
 * 보인다: 홉 수가 실제보다 작으면 `request.ip`가 프록시·컨테이너의 사설 주소로
 * 떨어진다. 그 상태는 오류 없이 200을 돌려주므로 아무도 알아채지 못한 채,
 * 무인증 경로의 상한이 사이트 전체 합산이 된다.
 *
 * 반대 방향(홉 수를 실제보다 크게 잡아 요청자가 헤더로 주소를 꾸미는 것)은 여기서
 * 잡을 수 없다. 꾸민 주소도 공인 주소이기 때문이다. 그쪽은 배포 뒤 실제 프록시
 * 홉 수를 확인하는 운영 절차가 맡는다.
 */
import { parseCidr, matchesCidr, type CidrRange } from "./ip.js";

const IPV4_MAPPED_PREFIX = "::ffff:";

export function isUnroutableAddress(address: string | undefined): boolean {
  // 주소를 정하지 못한 것도 요청자별로 셀 수 없다는 뜻이므로 같이 알린다.
  if (!address) return true;

  const value = address.toLowerCase();
  // Docker는 IPv4를 `::ffff:10.0.5.2` 형태로 준다. 접두를 벗기지 않으면 사설
  // 대역을 전부 놓친다.
  const bare = value.startsWith(IPV4_MAPPED_PREFIX)
    ? value.slice(IPV4_MAPPED_PREFIX.length)
    : value;

  if (bare === "::1" || bare === "::") return true;
  // IPv6 unique local (fc00::/7). link-local(fe80::/10)도 같은 이유로 잡는다.
  if (/^f[cd][0-9a-f]{2}:/.test(bare)) return true;
  if (/^fe[89ab][0-9a-f]:/.test(bare)) return true;

  const octets = bare.split(".");
  if (octets.length !== 4) return false;

  const [first, second] = octets.map((octet) => Number(octet));
  if (first === undefined || second === undefined) return false;
  if (Number.isNaN(first) || Number.isNaN(second)) return false;

  if (first === 127) return true;
  if (first === 10) return true;
  // 172.16/12 — 172.15와 172.32는 공인이다. 넓게 잡으면 정상 배포에서 오경보가
  // 나고, 오경보가 나는 경고는 곧 무시된다.
  if (first === 172 && second >= 16 && second <= 31) return true;
  if (first === 192 && second === 168) return true;
  if (first === 169 && second === 254) return true;

  return false;
}

/**
 * 사설 주소가 요청자로 판정되면 **한 번만** 알린다.
 *
 * 매 요청마다 남기면 로그가 그것으로 덮여 실제 장애가 묻힌다. 한 번이면 사실은
 * 전달되고 소음은 생기지 않는다.
 */
export function createUnroutableClientWarning(
  emit: (address: string, message: string) => void,
): (address: string | undefined) => void {
  let told = false;

  return (address) => {
    if (told) return;
    if (!isUnroutableAddress(address)) return;
    told = true;
    emit(
      address ?? "",
      "요청자 주소가 공인 주소가 아니다 — TRUSTED_PROXY_HOPS가 실제 프록시 수보다 작을 수 있다. " +
        "이 상태에서는 무인증 경로의 요청 상한이 사이트 전체 합산이 된다",
    );
  };
}

/**
 * `x-forwarded-*`를 믿을지 정하는 함수 — fastify `trustProxy`.
 *
 * 홉 수만 주던 것을 fastify 5.12.1이 없앴다. **바로 앞 상대를 검사하지 않는
 * 신뢰이기 때문이다** — 프록시를 거치지 않고 직접 닿은 요청이 헤더를 스스로
 * 채우면 요청자 주소가 그 값이 되고, 무인증 경로의 상한이 우회된다.
 *
 * 두 조건을 **모두** 요구한다.
 *
 * 1. 홉이 `TRUSTED_PROXY_HOPS` 안이다 — 체인을 무한히 거슬러 올라가지 않는다.
 * 2. 그 홉의 주소가 `TRUSTED_PROXY_CIDRS` 안이다 — 우리 프록시인지 본다.
 *
 * 대역이 비어 있으면 아무도 믿지 않는다. 헤더를 못 믿는 상태는 상한이 사이트
 * 전체 합산이 되는 것이며, 그 사실은 `createUnroutableClientWarning`이 알린다.
 */
export function createProxyTrust(
  hops: number,
  cidrs: readonly string[],
): ((address: string, hop: number) => boolean) | false {
  if (hops <= 0) return false;

  const ranges = cidrs
    .map((entry) => parseCidr(entry))
    .filter((range): range is CidrRange => range !== null);
  if (ranges.length === 0) return false;

  return (address, hop) =>
    hop < hops && ranges.some((range) => matchesCidr(address, range));
}
