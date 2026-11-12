'use strict';
const { readFileSync } = require('node:fs');
const { NodeSDK } = require('@opentelemetry/sdk-node');
const { getNodeAutoInstrumentations } = require('@opentelemetry/auto-instrumentations-node');

// Ignore the entire origin: endpoint paths, query strings and redirects on the same
// service may carry credentials. A failed reference must not open the export boundary.
const protectedOrigins = new Set();
let unresolvedEndpoint = false;
for (const name of ['CHAIN_RPC_URL', 'CRE_CHAIN_RPC_URL', 'SAFE_SERVICE_URL']) {
  const raw = process.env[name];
  if (!raw) continue;
  try {
    const match = /^(env|file|plain):(.+)$/s.exec(raw);
    const value = !match ? raw : match[1] === 'env' ? process.env[match[2]]
      : match[1] === 'file' ? readFileSync(match[2], 'utf8').trim() : match[2];
    protectedOrigins.add(new URL(value).origin);
  } catch { unresolvedEndpoint = true; }
}
function ignoreOrigin(value) {
  if (unresolvedEndpoint) return true;
  try { return protectedOrigins.has(new URL(value).origin); }
  catch { return true; }
}
const sdk = new NodeSDK({
  instrumentations: getNodeAutoInstrumentations({
    '@opentelemetry/instrumentation-http': {
      ignoreOutgoingRequestHook: (request) => ignoreOrigin(
        `${request.protocol || 'http:'}//${request.hostname || request.host}${request.port ? ':' + request.port : ''}`),
    },
    '@opentelemetry/instrumentation-undici': {
      ignoreRequestHook: (request) => ignoreOrigin(request.origin),
    },
  }),
});
sdk.start();

// The SDK's auto-register SIGTERM handler shuts providers down before application
// handlers finish. Own only the final flush; application signal handlers still drain.
let shutdown;
function stop() {
  return shutdown ||= new Promise((resolve) => {
    const timer = setTimeout(resolve, 2000);
    Promise.resolve().then(() => sdk.shutdown()).catch(() => {}).finally(() => {
      clearTimeout(timer);
      resolve();
    });
  });
}
// Explicit exits are synchronous startup refusal boundaries: never replace process.exit.
// Applications that deliberately exit after draining can await this optional hook first.
globalThis[Symbol.for('mpc.telemetry.shutdown')] = stop;
process.once('beforeExit', stop);
for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => {
    // With no application listener, retain normal signal termination semantics.
    if (process.listenerCount(signal) === 1) {
      void stop().finally(() => process.exit(signal === 'SIGTERM' ? 143 : 130));
    }
  });
}
