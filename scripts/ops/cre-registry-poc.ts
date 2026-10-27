import { runCreRegistryPoc } from "../../apps/api/test/helpers/cre-poc.js";

try {
  await runCreRegistryPoc();
} catch {
  // Connection and signing errors can include credentials or fixture sessions.
  process.stderr.write("CRE local proof failed. Check the named last stage and local prerequisites; credentials are omitted.\n");
  // setupFixture may fail before returning its DB handles (for example on checksum drift).
  // The helper has already run its finally block; terminate remaining fixture sockets too.
  process.exit(1);
}
