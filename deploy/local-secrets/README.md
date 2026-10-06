# Local-only secrets

**Every value in this directory is public.** They are the anvil default account keys and
the MinIO default credentials, and none of them holds any real asset.

They are here not because the values are secret but **to make the injection path the same
as in deployment**. `docker-compose.yml` mounts these files as `file:` references, and the
application reads them with the same code in `packages/config`. If only local used
environment variable values, a "works locally but not in deployment" gap would appear.

Real deployments do not use this directory. Docker secrets, Kubernetes projected
volumes, or a secret manager place the files at the same path.
