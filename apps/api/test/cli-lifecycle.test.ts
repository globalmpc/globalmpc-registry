import { afterEach, beforeEach, expect, it, vi } from "vitest";
const s = vi.hoisted(() => ({
  // Callable for the bootstrap CLI's role check; `privileges` is what that query returns.
  privileges: { rolsuper: true, rolbypassrls: false },
  sql: Object.assign(vi.fn(async () => [s.privileges]), { end: vi.fn() }),
  bootstrap: vi.fn(),
  credential: vi.fn(),
  schema: vi.fn(),
  policy: vi.fn(),
  read: vi.fn(),
  listen: vi.fn(),
  close: vi.fn(),
  info: vi.fn(),
  error: vi.fn(),
  signals: new Map<string, () => void>(),
  relay: null as string | null,
  deps: vi.fn(),
}));
vi.mock("postgres", () => ({ default: () => s.sql }));
vi.mock("@mpc/config", () => ({
  resolveSecret: (_name: string, value: string) => value,
}));
vi.mock("node:fs", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:fs")>()),
  readFileSync: s.read,
}));
vi.mock("../src/bootstrap.js", () => ({
  bootstrapOperator: s.bootstrap,
  BootstrapError: class extends Error {},
}));
vi.mock("../src/bootstrap-registry.js", () => ({
  bootstrapCredential: s.credential,
  bootstrapAttestationSchema: s.schema,
  bootstrapPolicySet: s.policy,
  BootstrapRegistryError: class extends Error {},
}));
vi.mock("../src/config.js", () => ({
  loadConfig: () => ({
    port: 3001,
    secretAudit: [{ name: "key", scheme: "file" }],
    oidcTestRelayUrl: s.relay,
  }),
}));
vi.mock("../src/db.js", () => ({ createDb: () => s.sql }));
vi.mock("../src/server.js", () => ({
  buildServer: async (_config: unknown, _sql: unknown, deps: unknown) => (s.deps(deps), {
    listen: s.listen,
    close: s.close,
    log: { info: s.info, error: s.error },
  }),
}));
const originalExitCode = process.exitCode;
beforeEach(() => {
  vi.resetModules();
  s.privileges = { rolsuper: true, rolbypassrls: false };
  s.relay = null;
  for (const f of [
    s.deps,
    s.sql.end,
    s.bootstrap,
    s.credential,
    s.schema,
    s.policy,
    s.read,
    s.listen,
    s.close,
    s.info,
    s.error,
  ])
    f.mockReset();
  s.signals.clear();
  process.exitCode = 0;
  vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  vi.spyOn(process, "exit").mockImplementation((code) => {
    throw new Error(`exit:${code}`);
  });
  vi.stubEnv("DATABASE_URL", "postgres://local/test");
  vi.stubGlobal("process", process);
  vi.spyOn(process, "on").mockImplementation(((
    event: string,
    handler: () => void,
  ) => {
    s.signals.set(event, handler);
    return process;
  }) as typeof process.on);
  s.bootstrap.mockResolvedValue({
    created: true,
    roleGranted: true,
    tenantId: "t1",
    organizationId: "o1",
    subjectId: "s1",
  });
  for (const f of [s.credential, s.schema, s.policy])
    f.mockResolvedValue({ created: true, id: "r1", state: "draft" });
});
afterEach(() => {
  process.exitCode = originalExitCode;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});
function bootstrapEnv() {
  for (const [k, v] of Object.entries({
    BOOTSTRAP_TENANT_SLUG: "tenant",
    BOOTSTRAP_TENANT_NAME: "Tenant",
    BOOTSTRAP_ORG_NAME: "Sponsor",
    BOOTSTRAP_SUBJECT_NAME: "Operator",
    BOOTSTRAP_EMAIL: "operator@example.test",
  }))
    vi.stubEnv(k, v);
}
it("starts the API with the configured port and drains exactly once on repeated signals", async () => {
  await import("../src/main.js");
  expect(s.listen).toHaveBeenCalledWith({ port: 3001, host: "0.0.0.0" });
  expect(s.info).toHaveBeenCalledWith(
    expect.objectContaining({ secrets: [{ name: "key", scheme: "file" }] }),
    "secret sources resolved",
  );
  vi.mocked(process.exit).mockImplementation(() => undefined as never);
  s.signals.get("SIGTERM")!();
  s.signals.get("SIGINT")!();
  await vi.waitFor(() => expect(process.exit).toHaveBeenCalledWith(0));
  expect(s.close).toHaveBeenCalledOnce();
});
it("reaches the real providers unless the E2E relay is configured", async () => {
  await import("../src/main.js");
  expect(s.deps).toHaveBeenLastCalledWith({});

  vi.resetModules();
  s.relay = "http://127.0.0.1:4555";
  await import("../src/main.js");
  const deps = s.deps.mock.lastCall![0] as { oidcFetch?: unknown };
  expect(deps.oidcFetch).toBeTypeOf("function");
});
it("logs a shutdown failure and exits with a failure status", async () => {
  await import("../src/main.js");
  s.close.mockRejectedValue(new Error("Close failed"));
  vi.mocked(process.exit).mockImplementation(() => undefined as never);
  s.signals.get("SIGINT")!();
  await vi.waitFor(() => expect(process.exit).toHaveBeenCalledWith(1));
  expect(s.error).toHaveBeenCalledWith(
    expect.objectContaining({ err: expect.any(Error) }),
    "graceful shutdown failed",
  );
});
it("validates bootstrap variables before opening a connection — an email is required", async () => {
  vi.stubEnv("BOOTSTRAP_EMAIL", "");
  vi.stubEnv("BOOTSTRAP_WALLET", "");
  await expect(import("../src/bootstrap-cli.js")).rejects.toThrow("exit:1");
  expect(process.stderr.write).toHaveBeenCalledWith(expect.stringContaining("BOOTSTRAP_EMAIL"));
  expect(s.bootstrap).not.toHaveBeenCalled();
});
it("refuses a wallet: bootstrap binds none, the holder binds one by proof (WP7)", async () => {
  bootstrapEnv();
  vi.stubEnv("BOOTSTRAP_WALLET", "0xABCDEF");
  await expect(import("../src/bootstrap-cli.js")).rejects.toThrow("exit:1");
  expect(process.stderr.write).toHaveBeenCalledWith(expect.stringContaining("BOOTSTRAP_WALLET is no longer accepted"));
  expect(s.bootstrap).not.toHaveBeenCalled();
});
it("bootstraps an operator with explicit defaults and emits no personal data", async () => {
  bootstrapEnv();
  vi.stubEnv("BOOTSTRAP_WALLET", "");
  await import("../src/bootstrap-cli.js");
  expect(s.bootstrap).toHaveBeenCalledWith(
    s.sql,
    expect.objectContaining({
      tenantSlug: "tenant",
      email: "operator@example.test",
      jurisdiction: "MNG",
      role: "mpc_operator",
      assuranceLevel: "high_assurance",
    }),
  );
  const [input] = s.bootstrap.mock.lastCall!.slice(1) as [Record<string, unknown>];
  expect(input).not.toHaveProperty("walletAddress");
  expect(input).not.toHaveProperty("chainId");
  const written = String(vi.mocked(process.stdout.write).mock.lastCall![0]);
  expect(written).toContain('"subjectId":"s1"');
  expect(written).not.toContain("operator@example.test");
  expect(written).not.toContain("wallet");
  expect(s.sql.end).toHaveBeenCalledOnce();
});
it("delegates ownership validation to tenant-scoped bootstrap without requiring BYPASSRLS", async () => {
  bootstrapEnv();
  s.privileges = { rolsuper: false, rolbypassrls: false };
  await import("../src/bootstrap-cli.js");
  expect(s.bootstrap).toHaveBeenCalledOnce();
  expect(s.sql.end).toHaveBeenCalledOnce();
});
it("bootstraps with a role that has BYPASSRLS but is not a superuser", async () => {
  bootstrapEnv();
  s.privileges = { rolsuper: false, rolbypassrls: true };
  await import("../src/bootstrap-cli.js");
  expect(s.bootstrap).toHaveBeenCalledOnce();
});
it("reports bootstrap failure and closes its connection", async () => {
  bootstrapEnv();
  s.bootstrap.mockRejectedValue(new Error("Invalid tenant"));
  await import("../src/bootstrap-cli.js");
  expect(process.exitCode).toBe(1);
  expect(process.stderr.write).toHaveBeenCalledWith(
    expect.stringContaining("Invalid tenant"),
  );
  expect(s.sql.end).toHaveBeenCalledOnce();
});
function registryEnv(kind: string) {
  vi.spyOn(process, "argv", "get").mockReturnValue(["node", "cli", kind]);
  vi.stubEnv("BOOTSTRAP_TENANT_SLUG", "tenant");
}
it("requires a recognized registry kind", async () => {
  registryEnv("wrong");
  await expect(import("../src/bootstrap-registry-cli.js")).rejects.toThrow(
    "exit:1",
  );
  expect(process.stderr.write).toHaveBeenCalledWith(
    expect.stringContaining("Choose what to insert"),
  );
});
it("parses credential scopes and leaves optional issuer references unset", async () => {
  registryEnv("credential");
  for (const [k, v] of Object.entries({
    CREDENTIAL_WALLET: "0xabc",
    CREDENTIAL_ISSUER_REFERENCE: "Issuer",
    CREDENTIAL_TYPE: "review",
    CREDENTIAL_SCOPE: " rights, , technical ",
    CREDENTIAL_JURISDICTION: "MNG, KOR",
    CREDENTIAL_ISSUED_AT: "2026-10-20",
  }))
    vi.stubEnv(k, v);
  await import("../src/bootstrap-registry-cli.js");
  expect(s.credential).toHaveBeenCalledWith(
    s.sql,
    expect.objectContaining({
      credentialScope: ["rights", "technical"],
      jurisdiction: ["MNG", "KOR"],
      issuerAuthorityId: null,
      expiresAt: null,
    }),
  );
  expect(s.sql.end).toHaveBeenCalledOnce();
});
it("defaults schemas to draft and forwards a named approver when present", async () => {
  registryEnv("schema");
  for (const [k, v] of Object.entries({
    SCHEMA_KEY: "review",
    SCHEMA_VERSION: "1",
    SCHEMA_ATTESTATION_TYPE: "review",
    BOOTSTRAP_APPROVED_BY: " Approver ",
  }))
    vi.stubEnv(k, v);
  await import("../src/bootstrap-registry-cli.js");
  expect(s.schema).toHaveBeenCalledWith(
    s.sql,
    expect.objectContaining({
      approvedBy: "Approver",
      jurisdictionProfile: "MNG",
      requiredEvidence: [],
      mandatoryLimitations: [],
    }),
  );
});
it.each(["inline", "file"])(
  "reads a policy definition from %s",
  async (source) => {
    registryEnv("policy-set");
    vi.stubEnv("BOOTSTRAP_APPROVED_BY", "");
    if (source === "inline") vi.stubEnv("POLICY_SET_JSON", '{"version":1}');
    else {
      vi.stubEnv("POLICY_SET_FILE", "/policy.json");
      s.read.mockReturnValue('{"version":1}');
    }
    await import("../src/bootstrap-registry-cli.js");
    expect(s.policy).toHaveBeenCalledWith(s.sql, {
      tenantSlug: "tenant",
      definition: { version: 1 },
      approvedBy: null,
    });
    expect(s.sql.end).toHaveBeenCalledOnce();
  },
);
it.each(["missing", "malformed"])(
  "reports a %s policy source and closes the DB",
  async (kind) => {
    registryEnv("policy-set");
    vi.stubEnv("POLICY_SET_FILE", "");
    vi.stubEnv("POLICY_SET_JSON", kind === "missing" ? "" : "{invalid");
    await import("../src/bootstrap-registry-cli.js");
    expect(process.exitCode).toBe(1);
    expect(s.policy).not.toHaveBeenCalled();
    expect(s.sql.end).toHaveBeenCalledOnce();
  },
);
