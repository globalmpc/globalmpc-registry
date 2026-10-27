import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { MAX_STREAM_BYTES } from "../src/routes/uploads.js";

it("accepts only upload sizes the deployed ClamAV and bounded worker can inspect", () => {
  const config = readFileSync(new URL("../../../docker/clamav/clamd.conf", import.meta.url), "utf8");
  for (const key of ["MaxFileSize", "MaxScanSize", "StreamMaxLength"]) {
    const configured = new RegExp(`^${key}\\s+(\\d+)M$`, "m").exec(config);
    expect(configured, key).not.toBeNull();
    expect(MAX_STREAM_BYTES).toBeLessThanOrEqual(Number(configured![1]) * 1024 * 1024);
  }
  expect(MAX_STREAM_BYTES).toBeLessThan(2 ** 31);
});
