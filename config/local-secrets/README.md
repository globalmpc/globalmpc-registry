# Optional local secret-file fixtures

Every value in this directory is a public local test value, including Anvil default account
keys and MinIO defaults. They are not real deployment credentials.

Compose injects values directly as environment variables and no longer mounts these files.
They remain optional fixtures for exercising the application's `file:` reference support.
File references are one supported configuration format; direct values also work.

Use independently provisioned values for each deployed environment. Do not reuse these
fixtures or the Compose demo defaults for a shared deployment.
