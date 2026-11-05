/**
 * Chrome copy — OD-30.
 *
 * **The service runs in English only.** There is no locale toggle and no
 * runtime translation: the workspace renders one language, so a string in the
 * source is the string on screen.
 *
 * What stays here is the copy the chrome repeats — navigation labels and
 * session states. It is a single registry rather than local arrays in each
 * component because a destination renamed in one place and not the other reads
 * as two different destinations (@mpc/design patterns.md, "Chrome").
 *
 * **Boundary copy is not defined here.** `@mpc/ui`'s `REQUIRED_BOUNDARY_COPY`
 * is the origin; restating it per screen defeats the point of enforcing it.
 */

/**
 * Authenticated workspace navigation — spec 11 §11.2.
 *
 * `Data Room`, `Verification`, and `Readiness & Gates` are project sub-screens. Their global
 * entries open a project picker that answers "whose Data Room?" and lists only the projects the
 * session can open, so the nav matches the spec's ten items without links that lead nowhere.
 * `Authorities` sits beside `Integrations`: the authority catalog is its own screen (§11.10).
 *
 * **Menus outside the user's roles are hidden** (§11.2). `requires` is the API action the
 * screen calls, filtered against the action list the session provides (`actions` from `/auth/session`).
 * Hiding is not a security control — the server re-checks every request (02 §2.1).
 * `"subject"` is not a role: the screen is shown when a subject is bound to the wallet.
 *
 * Public screens do not belong here. `PUBLIC_NAV` is shown separately even after login.
 */
export interface NavEntry {
  readonly href: string;
  readonly label: string;
  readonly requires: string;
}

export const NAV: readonly NavEntry[] = [
  { href: "/w/work", label: "My Work", requires: "project.read" },
  { href: "/w/activity", label: "My Activity", requires: "subject" },
  { href: "/w/notifications", label: "Notifications", requires: "project.read" },
  { href: "/w/projects", label: "Projects", requires: "project.read" },
  { href: "/w/data-room", label: "Data Room", requires: "evidence.read" },
  { href: "/w/verification", label: "Verification", requires: "verification.read" },
  { href: "/w/readiness", label: "Readiness & Gates", requires: "readiness.read" },
  { href: "/w/registries", label: "Registries", requires: "registry.read" },
  { href: "/w/anchors", label: "Anchor", requires: "registry.read" },
  { href: "/w/integrations", label: "Integrations", requires: "authority.read" },
  { href: "/w/authorities", label: "Authorities", requires: "authority.read" },
  { href: "/w/governance", label: "Governance", requires: "governance.read" },
  { href: "/w/audit", label: "Audit", requires: "audit.read" },
  { href: "/w/admin", label: "Admin", requires: "admin.read" },
];

/**
 * The public surface — spec 11 §11.2.
 *
 * These seven are reachable with no account. They are listed here rather than
 * filtered out of `NAV` because they are not a subset of the workspace: the
 * public site answers "what has been published", the workspace answers "what am
 * I working on". Deriving one from the other made the public surface look like
 * a permissions leftover, and for a long time it held exactly one entry.
 */
export const PUBLIC_NAV = [
  { href: "/explorer", label: "Explorer" },
  { href: "/explorer/verifications", label: "Verification Records" },
  { href: "/asset-registry", label: "Asset Registry" },
  { href: "/verify", label: "Proof Verifier" },
  { href: "/governance", label: "Governance" },
  { href: "/disclosures", label: "Disclosures & Incidents" },
] as const;

export const COPY = {
  productName: "Registry Workspace",
  session: {
    disconnect: "Sign out",
    none: "Not signed in",
    required: "You are not signed in.",
    connect: "Sign in →",
    signIn: "Sign in →",
    settings: "Account",
    noRoles: "No roles",
    requestAccess: "Request access",
    publicMenu: "Public registry",
    /** Roles held but not in effect because identity assurance is below their minimum. */
    inactiveRoles: "inactive",
    inactiveReason: "Identity verification needed — ask an admin",
  },
  /**
   * A signed-in person with no role — plan §4 journey 1. Not an error: the account is ready and
   * waits for a grant. Two administrators take part in every grant, so the wait is said up front.
   */
  accessPending: {
    heading: "Access pending",
    lead: "Your account is set up, but no role has been granted to it yet. An administrator grants roles, and a second administrator approves each grant, so the workspace stays closed to you until then.",
    next: "What you can do now:",
    requestAccess: "Request access",
    requestAccessHint: "say which role you need and why",
    settings: "Account settings",
    settingsHint: "sign-in methods, second factors and signing wallets",
    signOut: "Sign out",
    publicRecords: "Published records stay open without a role:",
    explorer: "Explorer",
    inactiveHeading: "Your roles are not in effect",
    inactiveLead:
      "You hold these roles, but your identity assurance is below what they need. This happens after a signing wallet that an operator had verified is replaced: an administrator has not set your identity assurance again yet.",
    inactiveNext:
      "Ask an administrator to verify your identity again (Admin → Set assurance). Your roles take effect as soon as they do; nothing else has to be granted.",
    roleNeeds: (role: string, level: string) => `${role} — needs ${level}`,
  },
  /** Refusals as the signing flows (attestations, gate decisions) should say them. */
  signing: {
    SIGNATURE_SIGNER_MISMATCH:
      "This signature came from a wallet that is not your account's signing wallet. Switch your wallet to the signing wallet shown in Account settings, then sign again.",
  } as Record<string, string>,
  assurance: {
    heading: "Identity verification needed — ask an admin",
    lead: (required: string) =>
      `This action needs identity assurance ${required}, and yours is below it. Replacing a signing wallet that an operator had verified resets the assurance until an administrator confirms your identity and sets it again (Admin → Set assurance).`,
    roles: "Roles not in effect until then:",
  },
  empty: {
    noData: "There is no data here. This is not a permission problem.",
  },
} as const;

/**
 * Account sign-in, second factors, settings and account administration — WP6.
 *
 * Kept in this registry for the reason above: the same step named two ways on two screens
 * ("authenticator app" here, "TOTP" there) reads as two different things. Refusal codes from the
 * API map to one sentence each in `errors`; a code missing there falls back to the server's own
 * message, never to a blank.
 */
export const AUTH_COPY = {
  signIn: {
    heading: "Sign in",
    lead: "Sign in with the email address your invitation was sent to. There is no password.",
    emailLabel: "Email address",
    sendCode: "Send code",
    sending: "Sending…",
    codeHeading: "Enter your code",
    codeSent: (minutes: number) =>
      `If this address has access, a sign-in code is on its way. It expires in ${minutes} minutes.`,
    codeLabel: (digits: number) => `${digits}-digit code`,
    verify: "Continue",
    verifying: "Checking…",
    expiresIn: (time: string) => `Code expires in ${time}`,
    expired: "This code has expired. Ask for a new one.",
    resend: "Send a new code",
    resendIn: (seconds: number) => `Send a new code in ${seconds} s`,
    otherAddress: "Use another address",
    or: "or",
    withProvider: (name: string) => `Continue with ${name}`,
    alreadySignedIn: "You are signed in.",
    goToWorkspace: "Go to projects →",
    noInvitation:
      "Accounts are created by invitation. If you have not received one, ask your organisation's administrator.",
  },
  providers: { google: "Google", microsoft: "Microsoft" } as Record<string, string>,
  oidc: {
    completing: "Completing sign-in…",
    failedHeading: "Sign-in did not complete",
    linked: (name: string) => `${name} is now linked to your account.`,
    back: "Back to sign-in",
    backToSettings: "Back to account settings",
  },
  mfa: {
    heading: "Second step",
    challengeLead: "Prove it is you with one of the second factors on your account.",
    passkey: "Use your passkey",
    passkeyWorking: "Waiting for your passkey…",
    totpLabel: "6-digit code from your authenticator app",
    totpSubmit: "Verify code",
    useRecovery: "Use a recovery code instead",
    recoveryLabel: "Recovery code",
    recoverySubmit: "Use recovery code",
    recoveryWarning:
      "A recovery code signs out every other session and lets this one only add a new passkey or authenticator app. After that you sign in again.",
    enrolHeading: "Set up your second factor",
    enrolLead:
      "Every account needs a second factor. A passkey is phishing-resistant and is required for reviewer, approver and operator roles.",
    enrolPasskey: "Create a passkey",
    passkeyName: "Passkey name (optional)",
    enrolTotp: "Use an authenticator app instead",
    totpScan: "Scan this code with your authenticator app, then enter the 6-digit code it shows.",
    totpManual: "Can't scan? Enter this key by hand:",
    totpConfirm: "Confirm",
    windowClosedHeading: "You cannot add a second factor from here",
    windowClosed:
      "This account has no second factor, and the time to set one up after an invitation or reset has passed. Ask an administrator for an MFA reset; they will need a second administrator to approve it.",
    reenrolHeading: "Add a new second factor",
    reenrolLead:
      "You used a recovery code. Add a new passkey or authenticator app now; every session then ends and you sign in again with it.",
    recoveryDone:
      "Your new second factor is set up. Every session has ended, this one included. Sign in again with it.",
    signInAgain: "Sign in again",
    signOut: "Sign out",
  },
  recoveryCodes: {
    heading: "Save your recovery codes",
    lead: "Each code works once and replaces your second factor if you lose it. They are shown only now.",
    copy: "Copy",
    copied: "Copied",
    download: "Download",
    saved: "I have saved these codes somewhere safe",
    continue: "Continue",
    fileName: "mpc-recovery-codes.txt",
  },
  stepUp: {
    heading: "Confirm it is you",
    passkeyLead: "This action needs your passkey.",
    factorLead: "This action needs a second factor.",
    cancel: "Cancel",
    button: (roles: string) => `Verify with a passkey to act as ${roles}`,
    narrowed: "Some of your roles need a stronger sign-in for this session:",
    errorAction: "Verify and try again",
    noPasskey:
      "Your account has no passkey yet. Add one in Account settings, then try again — an authenticator app code cannot be used for this action.",
  },
  settings: {
    heading: "Account settings",
    lead: "How you sign in, your second factors and the wallets you sign with.",
    navLabel: "Account",
    identities: "Google and Microsoft sign-in",
    identitiesLead:
      "A linked account signs you in by its provider's identifier, never by the email address it reports.",
    noIdentities: "None linked.",
    link: (name: string) => `Link ${name}`,
    unlink: "Unlink",
    linkedVia: (via: string) => (via === "invitation" ? "linked when you accepted the invitation" : "linked from settings"),
    authenticators: "Second factors",
    passkeys: "Passkeys",
    noPasskeys: "No passkey yet.",
    rename: "Rename",
    save: "Save",
    remove: "Remove",
    addPasskey: "Add a passkey",
    totp: "Authenticator app",
    totpOn: "Set up",
    totpOff: "Not set up",
    addTotp: "Set up an authenticator app",
    addFactor: "Add a passkey or authenticator app",
    recovery: "Recovery codes",
    recoveryRemaining: (n: number) => `${n} unused`,
    recoveryHidden: "Shown once you have proved a second factor in this session.",
    regenerate: "Generate new codes",
    regenerateWarning: "New codes replace every unused one.",
    wallets: "Signing wallet",
    walletsLead:
      "Your account has one signing wallet: the key you sign attestations and decisions with, and your governance wallet. It never signs you in. Bind one by signing a message with it.",
    noWallets: "No signing wallet. Bind one to sign attestations and decisions.",
    currentWallet: "Signs for your account and is your governance wallet.",
    walletHistory: "Earlier wallets",
    bind: "Connect and bind a wallet",
    replace: "Replace",
    replaceWarning: (current: string, next: string) =>
      `This will replace ${current} with ${next}. The current wallet stops signing for your account at once; what it signed stays recorded as its. Your sessions stay signed in.`,
    confirmReplace: "Sign and replace",
    replaceReason: "Why are you replacing it?",
    replaceReasons: {
      rotation: "Planned rotation",
      key_lost: "Key lost",
      key_compromised: "Key compromised",
    } as Record<string, string>,
    replaceCompromised:
      "A compromised key can never be bound again — to your account or anyone's.",
    replaceOperatorVerified:
      "Your current wallet was verified by an operator. Replacing it lowers your identity assurance until an admin verifies you again.",
    replaceDone: "Your new signing wallet is bound. Sign with it from now on; the replaced wallet can no longer sign for this account.",
    replaceDoneOperator: (assurance: string) =>
      `The replaced wallet had been verified by an operator, so your identity assurance is now ${assurance}.`,
    replaceDoneInactive: "These roles are not in effect until an administrator verifies your identity again:",
    replaceDoneNext:
      "Next: ask an administrator to confirm your identity and set your assurance again (Admin → Set assurance). Your roles take effect again as soon as they do — no new role grant is needed.",
    binding: "Waiting for the wallet…",
    disable: "Disable",
    disableWarning:
      "Disabling your wallet signs out every session of your account, this one included, and leaves the account with no signing wallet. To change wallets, use Replace instead.",
    sessionEnded: "Your session has ended. Sign in again.",
    sessions: "Sessions",
    sessionsLead:
      "Where this account is signed in. End a session you do not recognise; removing a factor or a wallet ends every other session too.",
    signedInAt: (at: string) => `signed in ${at} UTC`,
    thisBrowser: "this browser",
    endSession: "End session",
    disabled: "disabled",
    boundVia: (via: string) => (via === "proof" ? "bound by you" : "bound by an operator"),
    used: (at: string) => `last used ${at}`,
    never: "never used",
    synced: "synced",
  },
  invitation: {
    heading: "Accept your invitation",
    lead: "Confirm the address the invitation was sent to, then set up a second factor.",
    missing:
      "This page needs the link from your invitation email. Open the link from the email again; if it has expired, ask the person who invited you for a new one.",
    sendCode: "Email me a code",
    nameLabel: "Your name, as colleagues will see it",
    accept: "Accept invitation",
    codeRequired: "This provider cannot confirm the invited address. Use the emailed code instead.",
  },
  emailChange: {
    heading: "Confirm your new email address",
    lead: "An administrator approved moving your account to a new address. Enter that address and the code sent to it.",
    done: "Your address has changed. Every session has ended; sign in with the new address.",
    confirm: "Confirm address",
  },
  signing: {
    walletNotBound: (address: string) =>
      `The connected wallet ${address.slice(0, 6)}…${address.slice(-4)} is not bound to your account on this chain. Bind it in Account settings, or connect a bound wallet.`,
  },
  admin: {
    invitations: "Invitations",
    invitationsLead:
      "An invitation names one address and one organisation, and no role. Roles are granted separately, by two people.",
    invite: "Send invitation",
    organization: "Organisation",
    revoke: "Revoke",
    noInvitations: "No invitations.",
    emailChanges: "Email address changes",
    emailChangesLead:
      "Two administrators other than the person. Approval mails a code to the new address; completing it signs the person out everywhere and removes their linked Google / Microsoft sign-in.",
    proposeEmailChange: "Propose email change",
    proposeMfaReset: "Propose factor reset",
    person: "Person",
    newEmail: "New address",
    reason: "Reason",
    approve: "Approve",
    reject: "Reject",
    decisionReason: "Decision reason",
    noEmailChanges: "No email changes.",
    mfaResets: "Second-factor resets",
    mfaResetsLead:
      "For someone who lost every passkey, authenticator app and recovery code. Two administrators; approval removes their factors and linked sign-ins and opens 24 hours to set up a new one.",
    noMfaResets: "No resets.",
    suspensions: "Suspension",
    suspensionsLead:
      "Takes a person's account out of use. Two administrators other than the person; approval signs them out everywhere, removes their passkeys, authenticator apps, recovery codes and linked sign-ins, and stops every sign-in. What they signed stays. Reinstating takes two administrators too and opens 24 hours to set up a new factor.",
    suspend: "Propose suspension",
    reinstate: "Propose reinstatement",
    noSuspensions: "No suspensions.",
    suspensionAction: { suspend: "suspend", reinstate: "reinstate" } as Record<string, string>,
    suspended: "suspended",
    windowUntil: (at: string) => `may enrol until ${at}`,
    /** A request a suspension closed (0132): said as such, never as its expiry or an open window. */
    closedReason: {
      inviter_suspended: "Closed — inviter suspended",
      subject_suspended: "Closed — person suspended",
      proposer_suspended: "Closed — proposer suspended",
      approver_suspended: "Closed — approver suspended",
    } as Record<string, string>,
    signInMethods: "Signs in with",
    methodLabels: {
      email: "email",
      google: "Google",
      microsoft: "Microsoft",
    } as Record<string, string>,
    noMethod: "no way to sign in",
    lockedTitle: (n: number) => `${n} account${n === 1 ? "" : "s"} cannot sign in`,
    lockedBody: (names: string) =>
      `${names} has no email address and no linked Google or Microsoft sign-in. Roles remain recorded, but there is no way in until an invitation or a bootstrap re-run gives them an address.`,
    you: "you",
  },
  errors: {
    EMAIL_CODE_INVALID: "That code is not right. Check it and try again.",
    EMAIL_CODE_EXPIRED: "This code has expired. Ask for a new one.",
    EMAIL_CODE_ATTEMPTS_EXHAUSTED: "Too many wrong codes. Ask for a new one.",
    RATE_LIMITED: "Too many attempts. Wait a few minutes and try again.",
    INVITATION_INVALID:
      "This invitation cannot be used. It may have expired, been used or been revoked. Ask for a new one.",
    INVITATION_EMAIL_UNAVAILABLE:
      "This address cannot be invited. It may already have an account or a pending invitation.",
    INVITATION_NOT_PENDING: "This invitation is no longer pending.",
    ACCOUNT_RECOVERY_SEPARATION_REQUIRED:
      "You took part in another recovery for this person in the last 30 days. Another administrator has to handle this one.",
    EMAIL_CHANGE_NO_ADDRESS:
      "This person has no email address to change. Invite them instead; their roles are then granted again.",
    EMAIL_CHANGE_SELF: "You cannot change your own address this way.",
    EMAIL_CHANGE_SELF_TARGET: "You cannot change your own address this way.",
    EMAIL_CHANGE_SELF_APPROVAL: "Someone other than the proposer has to decide this change.",
    EMAIL_CHANGE_EMAIL_UNAVAILABLE: "This address cannot be used.",
    EMAIL_CHANGE_ALREADY_OPEN: "There is already an open change for this person.",
    EMAIL_CHANGE_ALREADY_DECIDED: "This change has already been decided.",
    MFA_RESET_SELF_TARGET: "You cannot reset your own second factors.",
    SUSPENSION_SELF_TARGET: "Nobody proposes or decides their own suspension or reinstatement.",
    SUSPENSION_SELF_APPROVAL: "Another administrator has to decide what you proposed.",
    SUSPENSION_STATE_CONFLICT: "Only an active person can be suspended, and only a suspended one reinstated.",
    SUSPENSION_ALREADY_PENDING: "A request for this person is already waiting for a decision.",
    SUSPENSION_ALREADY_DECIDED: "This request is already decided.",
    SUBJECT_SUSPENDED: "This person is suspended. Reinstate them first; that opens 24 hours to set up new factors.",
    ACTOR_SUSPENDED: "This account is suspended and cannot act.",
    MFA_RESET_SELF_APPROVAL: "Someone other than the proposer has to decide this reset.",
    MFA_RESET_ALREADY_PENDING: "There is already a pending reset for this person.",
    MFA_RESET_ALREADY_DECIDED: "This reset has already been decided.",
    MFA_TOTP_INVALID: "That code is not right. Wait for the next one and try again.",
    MFA_TOTP_LOCKED: "Too many wrong codes. Try again in 15 minutes or use your passkey.",
    MFA_TOTP_UNREADABLE:
      "Your authenticator app can no longer be checked. Use your passkey or a recovery code, then set it up again.",
    MFA_RECOVERY_CODE_INVALID: "That recovery code is not valid or was already used.",
    MFA_PASSKEY_INVALID: "The passkey could not be verified. Try again.",
    MFA_USER_VERIFICATION_REQUIRED: "Your passkey must check it is you (PIN or biometrics). Try again.",
    MFA_CHALLENGE_INVALID: "This step took too long. Start it again.",
    MFA_ENROLMENT_WINDOW_CLOSED:
      "The time to set up a first second factor has passed. Ask an administrator for an MFA reset.",
    MFA_LAST_FACTOR: "This is your only second factor. Add another one before removing it.",
    MFA_CREDENTIAL_EXISTS: "This passkey is already registered.",
    MFA_TOTP_ALREADY_ENROLLED: "An authenticator app is already set up.",
    MFA_ALREADY_SATISFIED: "This session has already proved a second factor.",
    OIDC_ACCOUNT_NOT_FOUND:
      "No account is linked to this sign-in. Sign in with your email address, then link it from Account settings.",
    OIDC_IDENTITY_UNAVAILABLE: "This sign-in cannot be linked to your account.",
    OIDC_PROVIDER_ALREADY_LINKED: "You already have a sign-in of this provider linked. Unlink it first.",
    OIDC_EMAIL_CODE_REQUIRED: "This provider cannot confirm the invited address. Use the emailed code instead.",
    OIDC_EMAIL_NOT_VERIFIED: "The provider has not verified this address. Use the emailed code instead.",
    OIDC_EMAIL_MISMATCH: "This sign-in is for a different address than the invitation. Use the emailed code instead.",
    OIDC_ACCESS_DENIED: "Sign-in was cancelled.",
    OIDC_PROVIDER_ERROR: "The provider could not complete the sign-in. Start again.",
    OIDC_PROVIDER_UNAVAILABLE: "The sign-in provider could not be reached. Try again.",
    OIDC_PROVIDER_DISABLED: "This sign-in provider is not available.",
    OIDC_STATE_INVALID: "This sign-in link is no longer valid. Start again.",
    OIDC_TOKEN_INVALID: "The sign-in could not be verified. Start again.",
    OIDC_TENANT_NOT_ALLOWED: "Accounts of your organisation's directory cannot sign in here.",
    OIDC_BINDING_MISSING: "This sign-in was not started in this browser. Start again.",
    OIDC_LAST_SIGN_IN_METHOD: "This is your only way to sign in. It cannot be unlinked.",
    WALLET_UNAVAILABLE: "This wallet cannot be bound.",
    WALLET_CHALLENGE_INVALID:
      "The binding message expired, was already used, or your wallet changed since it was issued. Start again.",
    WALLET_ALREADY_ACTIVE: "This wallet already is your signing wallet.",
    SIGNATURE_SIGNER_MISMATCH: "The signature came from a different wallet than the one being bound.",
    CROSS_SITE_REQUEST_REFUSED: "This request did not come from this site and was refused.",
  } as Record<string, string>,
} as const;

/** Project navigation shares one registry across overview and every subpage. */
export const PROJECT_SECTIONS = [
  ["", "Overview", []],
  ["data-room", "Documents & evidence", ["documents", "impacts", "claims"]],
  ["verification", "Review evidence", ["readiness", "gates"]],
  ["publication", "Prepare publication", ["cre"]],
] as const;
export const PROJECT_TOOLS = [
  ["documents", "Document status", "data-room"],
  ["impacts", "Documents to recheck", "data-room"],
  ["readiness", "Readiness", "verification"],
  ["gates/registry_publication", "Gate decision", "verification"],
  ["cre", "CRE", "publication"],
] as const;
