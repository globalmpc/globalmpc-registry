# CRE CLI runtime compatibility

The real CRE CLI 1.39.0 compiled the workflow but failed configuration validation
before requesting any report: Javy has no global URL constructor. The SDK's browser
node:url shim captures that missing global; Node-based tests had concealed it.

| Input / authority | Scope | Expected result |
| --- | --- | --- |
| Operator report endpoint | Unchanged strict raw URL grammar plus WHATWG parsing | Preserve rejection of credentials, malformed hosts, redirects and non-loopback HTTP |
| Missing runtime URL global | CRE/Javy only | Use a bundled pure URL implementation, no Node dependency or authorization bypass |
| Local synthetic demo | Isolated cre_poc_cli database, loopback API and scoped token | No actual project publication or chain transaction; no DON deployment claim |

Use core-js-pure's URL implementation explicitly. Keep global behavior unchanged.
Verify existing endpoint rejection corpus, missing-global regression, typechecks
and real CLI simulation. Independent security review remains required before merge.

Verification: 112 SDK/protocol tests passed and all three CRE typecheck projects
passed. Real CLI1.39.0 now compiles and initializes the workflow, invokes the
loopback authenticated API and persists one report in the isolated database.
It subsequently fails at report delivery, so full simulation and on-chain
receiver execution remain unverified. No broadcast flag was used. The first
fixed-code CLI attempt hit a CLI config-path length limit; using a short relative
path resolved it. No real project or existing database was modified.

Engine-log follow-up: the CLI FakeEVMChain reports `EVM Chain WriteReport
Dry-Run Successful`. The workflow still returns failure because it requires
a confirmed receiver execution and transaction hash. Dry-run evidence must not
be reported as an actual delivered report; those production checks are retained.

## PR142 review correction

Replaced the post-import global stub with a fresh-process startup regression.
Vite bundles the real protocol and dependencies without executing them; the child
then removes URL/URLSearchParams and Node-only HTTP globals before evaluating that
bundle. The pure parser must not install globals. HTTPS and explicit loopback HTTP
are accepted; malformed IPv4/IPv6, userinfo and non-loopback HTTP remain rejected.
A deliberately faulty module that captures globalThis.URL at startup fails this
regression; the restored implementation passes all112 tests and three typechecks.

Initial test setup exposed that tsx itself requires URL and Node lazily initializes
HTTP globals using URLSearchParams. Bundling before evaluation and removing those
Node-only globals isolates the intended CRE startup boundary. Production code and
validation rules are unchanged by this review correction. CI/re-review for the
new revision remain pending; prior CI passed at0e24f751.
