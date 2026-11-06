'use strict';
// Standard console bridge: preserve original output and export its complete body.
const { logs, SeverityNumber } = require('@opentelemetry/api-logs');
const { context } = require('@opentelemetry/api');
const { format } = require('node:util');
const logger = logs.getLogger('console');
const levels = { debug: SeverityNumber.DEBUG, log: SeverityNumber.INFO, info: SeverityNumber.INFO,
  warn: SeverityNumber.WARN, error: SeverityNumber.ERROR, fatal: SeverityNumber.FATAL };
let emitting = false;
for (const method of ['debug', 'log', 'info', 'warn', 'error']) {
  const original = console[method];
  console[method] = function (...args) {
    original.apply(this, args);
    if (emitting) return;
    emitting = true;
    try {
      let record;
      try { record = args.length === 1 && typeof args[0] === 'string' ? JSON.parse(args[0]) : undefined; } catch {}
      const level = Object.hasOwn(levels, record?.level) ? record.level : method;
      logger.emit({
        body: format(...args),
        severityNumber: levels[level], severityText: level.toUpperCase(), context: context.active(),
      });
    } catch {
      // Export failure never changes the original application log or response.
    } finally { emitting = false; }
  };
}
