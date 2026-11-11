# Tenant-scoped scan queue access

The scan worker serves the tenant configured by `SCAN_SERVICE_TENANT_SLUG`. A connecting
role without BYPASSRLS currently sees no uploads because queue queries omit the tenant
session context. Set the existing transaction-local context for every queue operation;
do not change database roles, grants, policies, or the report API's authority.

| Identity / case | Authority and time basis | Input scope | Outcome / priority |
| --- | --- | --- | --- |
| Deployment tenant slug | Operator configuration resolved to the tenant UUID at startup | Existing id/slug lookup; no user request chooses the worker tenant | All queue transactions use this UUID |
| Lease candidate | Live upload state and attempt/lease budget | Configured tenant in RLS context and explicit tenant predicate | Only eligible quarantined rows may be leased |
| Failure or refunded attempt | Frozen tenant/upload/version/lease token from the claimed row | Same tenant context; exact lease, version and attempt comparison | A late worker cannot alter a replacement lease or another tenant |
| Backlog and pooled connection reuse | Live tenant queue state | Transaction-local tenant context | Counts exclude other tenants; context expires at transaction end |
| Scan result | Existing service-token report API | Token tenant, upload id, version and idempotency key | API remains the authority for clean/infected transitions |

External storage, scanner and report calls remain outside DB transactions. Existing
lease expiry, attempt refund, size limits, cancellation and reporting rules remain.
The worker's health signal continues to describe liveness; it grants no queue visibility.

Acceptance: scan queue operations work as a non-superuser, NOBYPASSRLS member of the
existing worker role; the existing tenant-isolation, retries and stale-lease cases pass
under that role; unscoped pooled reads remain empty. Independently review this security
boundary change before merge. The earlier shared-dev role's actual attributes were not
readable with the available AWS credentials, so local reproduction establishes the
failure mechanism, not a verified live database diagnosis.
