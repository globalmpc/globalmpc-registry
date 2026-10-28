// Type-checked by runtime-types.test.ts as if it were workflow source. Every line below
// uses an API that the CRE WASM runtime does not provide and must fail typecheck.
import { readFileSync } from "node:fs";

export const probes = [
  () => fetch("https://registry.example"),
  () => setTimeout(() => undefined, 1),
  () => process.env["REGISTRY_BEARER_TOKEN"],
  () => readFileSync("/etc/hostname"),
];
