import type { AppConfig } from "./config.js";
import { createMemoryObjectStore, createS3ObjectStore, type ObjectStore } from "@mpc/storage";

/**
 * Selects the store based on config.
 *
 * `loadConfig` has already validated the choice — the production + memory combination never
 * reaches here. This function only constructs.
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
