import { expect, it } from "vitest";
import { createUnauthorizedBackoff } from "../src/auth-backoff.js";

it("doubles from 5 seconds to a 5 minute cap and starts over after a reset", () => {
  const backoff = createUnauthorizedBackoff({ random: () => 1 });
  const steps = Array.from({ length: 9 }, () => backoff.next());
  expect(steps).toEqual([5000, 10000, 20000, 40000, 80000, 160000, 300000, 300000, 300000]);
  expect(backoff.failures).toBe(9);
  backoff.reset();
  expect(backoff.failures).toBe(0);
  expect(backoff.next()).toBe(5000);
});

it("jitters each pause to between half and all of its step", () => {
  expect(createUnauthorizedBackoff({ random: () => 0 }).next()).toBe(2500);
  const half = createUnauthorizedBackoff({ random: () => 0.5 });
  half.next();
  expect(half.next()).toBe(7500);
  const capped = createUnauthorizedBackoff({ random: () => 0 });
  for (let i = 0; i < 100; i++) capped.next();
  expect(capped.next()).toBe(150000);
});

it("uses Math.random and the documented defaults when not configured", () => {
  const first = createUnauthorizedBackoff().next();
  expect(first).toBeGreaterThanOrEqual(2500);
  expect(first).toBeLessThanOrEqual(5000);
});
