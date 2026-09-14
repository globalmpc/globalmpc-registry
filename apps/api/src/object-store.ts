import type { AppConfig } from "./config.js";
import { createMemoryObjectStore, createS3ObjectStore, type ObjectStore } from "@mpc/storage";

/**
 * 설정에 따라 저장소를 고른다.
 *
 * 선택 자체는 `loadConfig`가 이미 검증했다 — production + memory 조합은 여기까지
 * 오지 않는다. 이 함수는 만들기만 한다.
 */
export function createObjectStore(config: AppConfig): ObjectStore {
  if (config.objectStore.kind === "memory") {
    return createMemoryObjectStore();
  }

  return createS3ObjectStore({
    bucket: config.objectStore.bucket!,
    region: config.objectStore.region!,
    ...(config.objectStore.endpoint ? { endpoint: config.objectStore.endpoint } : {}),
    ...(config.objectStore.publicEndpoint
      ? { publicEndpoint: config.objectStore.publicEndpoint }
      : {}),
    ...(config.objectStore.forcePathStyle ? { forcePathStyle: true } : {}),
    sse: config.objectStore.sse,
    ...(config.objectStore.kmsKeyId ? { kmsKeyId: config.objectStore.kmsKeyId } : {}),
    ...(config.objectStore.credentials ? { credentials: config.objectStore.credentials } : {}),
  });
}
