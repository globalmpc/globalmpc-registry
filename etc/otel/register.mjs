import { register } from 'node:module';
import { createRequire } from 'node:module';

// Register before tsx or application modules load: the standard CommonJS preload alone
// cannot instrument this repository's ESM imports. The SDK itself remains CommonJS.
try {
  // Intercept installed libraries and builtins. Wrapping workspace TypeScript before tsx
  // transforms it produces failed-to-wrap warnings and can change module exports.
  register('./node_modules/@opentelemetry/instrumentation/hook.mjs', import.meta.url, {
    data: { include: [/\/node_modules\//, /^node:/], exclude: [/\.tsx?($|\?)/] },
  });
  const require = createRequire(import.meta.url);
  require('./runtime.cjs');
  require('./otel-console-bridge.cjs');
} catch {
  // An observability initialization error must never prevent application startup.
  process.stderr.write('LGTM instrumentation unavailable; application startup continues\n');
}
