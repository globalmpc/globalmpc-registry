# Project anchor batches

| Case | Authority | Input scope | Result |
| --- | --- | --- | --- |
| New batch | Administrator authorized on the selected tenant project | Its published, superseded and revoked versions with a content hash and no existing leaf | Freeze a single-project batch |
| Verification entry | Attestation's project in the same tenant | Published verification version | Include only in its own project's batch |
| Missing or inaccessible project | Tenant and project authorization | Request project UUID | Scoped callers cannot distinguish absent and inaccessible projects |
| Concurrent creation | Project transaction lock and existing unique entry-version index | Unbatched versions at selection | Each version appears in at most one batch |
| Legacy batch or retry | Existing tenant operations policy | Stored batch and leaves | Preserve root and retry without rebuilding |
