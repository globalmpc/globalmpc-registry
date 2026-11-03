/**
 * Account email wording — account authentication WP2.
 *
 * Every string a person reads in a sign-in, invitation or email-change mail lives here, keyed by
 * template and locale, so a translation is one more entry in `MESSAGES` and nothing else changes.
 * Only English exists today.
 *
 * Rules every template keeps:
 * - **A code is in the body, never the subject.** Subjects show in notification previews, lock
 *   screens and mail-server logs.
 * - **It says when it stops working** and **what to do if you did not ask for it** (nothing: a
 *   code or link is useless without the person who asked).
 * - Plain text only. Nothing from the parameters is interpreted as markup, and a parameter that
 *   does not have the expected shape refuses the whole message rather than being sent as is.
 */

export const EMAIL_TEMPLATES = [
  "sign_in_code",
  "invitation_link",
  "invitation_code",
  "email_change_code",
  "email_changed_notice",
  "mfa_reset_notice",
  "account_suspended_notice",
  "account_reinstated_notice",
] as const;
export type EmailTemplate = (typeof EMAIL_TEMPLATES)[number];

export type EmailLocale = "en";

export interface RenderedEmail {
  readonly subject: string;
  readonly text: string;
}

export class EmailParamsError extends Error {
  readonly reason = "invalid_params";
}

interface CodeParams {
  readonly code: string;
  readonly expiresMinutes: number;
}
interface LinkParams {
  readonly link: string;
  readonly expiresAt: string;
}
/**
 * Recovery notices (0123): the linked sign-ins the recovery revoked, as provider names only.
 * Rows queued before 0123 carry `{}` and render without the sentence.
 */
interface NoticeParams {
  readonly removedSignIns: readonly ("google" | "microsoft")[];
}

const PROVIDER_NAMES = { google: "Google", microsoft: "Microsoft" } as const;

/** "Google", "Google and Microsoft" — the names, never anything that identifies the account. */
function removedSignInsSentence(removed: NoticeParams["removedSignIns"]): string[] {
  if (removed.length === 0) return [];
  const names = removed.map((provider) => PROVIDER_NAMES[provider]).join(" and ");
  return [
    "",
    `The ${names} sign-in linked to the account was removed. To use it again, sign in with your email and link it again from your account settings.`,
  ];
}

const PRODUCT = "MPC Registry";

const MESSAGES: Record<EmailLocale, {
  readonly sign_in_code: (p: CodeParams) => RenderedEmail;
  readonly invitation_link: (p: LinkParams) => RenderedEmail;
  readonly invitation_code: (p: CodeParams) => RenderedEmail;
  readonly email_change_code: (p: CodeParams) => RenderedEmail;
  readonly email_changed_notice: (p: NoticeParams) => RenderedEmail;
  readonly mfa_reset_notice: (p: NoticeParams) => RenderedEmail;
  readonly account_suspended_notice: (p: NoticeParams) => RenderedEmail;
  readonly account_reinstated_notice: () => RenderedEmail;
}> = {
  en: {
    sign_in_code: ({ code, expiresMinutes }) => ({
      subject: `Your ${PRODUCT} sign-in code`,
      text: [
        `Your ${PRODUCT} sign-in code is:`,
        "",
        `    ${code}`,
        "",
        `It expires in ${expiresMinutes} minutes and works once.`,
        "",
        "If you did not try to sign in, you can ignore this email. Nobody can sign in without the code. Never share it, including with anyone who says they are from support.",
      ].join("\n"),
    }),
    invitation_link: ({ link, expiresAt }) => ({
      subject: `You have been invited to ${PRODUCT}`,
      text: [
        `You have been invited to create an account on ${PRODUCT}.`,
        "",
        "To accept, open this link and enter the code we then send to this address:",
        "",
        link,
        "",
        `The invitation expires at ${expiresAt} (UTC) and works once.`,
        "",
        "If you were not expecting this, you can ignore this email. No account is created unless you accept.",
      ].join("\n"),
    }),
    invitation_code: ({ code, expiresMinutes }) => ({
      subject: `Confirm your ${PRODUCT} invitation`,
      text: [
        `Your code to accept the ${PRODUCT} invitation is:`,
        "",
        `    ${code}`,
        "",
        `It expires in ${expiresMinutes} minutes and works once.`,
        "",
        "If you did not open an invitation link, you can ignore this email. Never share this code.",
      ].join("\n"),
    }),
    email_change_code: ({ code, expiresMinutes }) => ({
      subject: `Confirm your new ${PRODUCT} email address`,
      text: [
        `An administrator approved moving your ${PRODUCT} account to this address. Your confirmation code is:`,
        "",
        `    ${code}`,
        "",
        `It expires in ${expiresMinutes} minutes and works once. Confirming signs you out everywhere.`,
        "",
        "If you did not expect this, you can ignore this email, and tell your administrator. Never share this code.",
      ].join("\n"),
    }),
    email_changed_notice: ({ removedSignIns }) => ({
      subject: `Your ${PRODUCT} email address was changed`,
      text: [
        `The email address on your ${PRODUCT} account was changed. Codes are now sent to the new address, and every session was signed out.`,
        ...removedSignInsSentence(removedSignIns),
        "",
        "If you did not ask for this, contact your administrator now.",
      ].join("\n"),
    }),
    // Sent to the current address and to any address the account left in the last 90 days, so
    // whoever really owns the account hears of a reset even after the address was moved.
    mfa_reset_notice: ({ removedSignIns }) => ({
      subject: `Your ${PRODUCT} sign-in factors were reset`,
      text: [
        `An administrator reset the passkeys, authenticator apps and recovery codes on your ${PRODUCT} account, and every session was signed out.`,
        ...removedSignInsSentence(removedSignIns),
        "",
        "For the next 24 hours, whoever signs in to the account can set up a new passkey or authenticator app.",
        "",
        "If this wasn't you, contact your administrator now.",
      ].join("\n"),
    }),
    // Suspension (0127): two administrators took the account out of use. Nothing signed changes.
    account_suspended_notice: ({ removedSignIns }) => ({
      subject: `Your ${PRODUCT} account was suspended`,
      text: [
        `Two administrators suspended your ${PRODUCT} account. Every session was signed out, and the passkeys, authenticator apps and recovery codes on it were removed. Signing in is not possible until the account is reinstated.`,
        ...removedSignInsSentence(removedSignIns),
        "",
        "What you signed before stays as it was.",
        "",
        "If you think this is a mistake, contact your administrator.",
      ].join("\n"),
    }),
    account_reinstated_notice: () => ({
      subject: `Your ${PRODUCT} account was reinstated`,
      text: [
        `Two administrators reinstated your ${PRODUCT} account. You can sign in with your email again.`,
        "",
        "For the next 24 hours, whoever signs in to the account can set up a new passkey or authenticator app. Google or Microsoft sign-in has to be linked again from your account settings.",
        "",
        "If you did not expect this, contact your administrator now.",
      ].join("\n"),
    }),
  },
};

function codeParams(params: unknown): CodeParams {
  const p = params as Partial<CodeParams> | null;
  if (
    typeof p?.code !== "string" ||
    !/^[0-9]{8}$/.test(p.code) ||
    typeof p.expiresMinutes !== "number" ||
    !Number.isInteger(p.expiresMinutes) ||
    p.expiresMinutes <= 0
  ) {
    throw new EmailParamsError("code parameters do not have the expected shape");
  }
  return { code: p.code, expiresMinutes: p.expiresMinutes };
}

function linkParams(params: unknown): LinkParams {
  const p = params as Partial<LinkParams> | null;
  let url: URL;
  try {
    url = new URL(String(p?.link));
  } catch {
    throw new EmailParamsError("link parameter is not a URL");
  }
  if (
    (url.protocol !== "https:" && url.protocol !== "http:") ||
    typeof p?.link !== "string" ||
    /\s/.test(p.link) ||
    typeof p.expiresAt !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}Z$/.test(p.expiresAt)
  ) {
    throw new EmailParamsError("link parameters do not have the expected shape");
  }
  return { link: p.link, expiresAt: p.expiresAt.replace("T", " ").replace("Z", "") };
}

function noticeParams(params: unknown): NoticeParams {
  const p = params as { removedSignIns?: unknown } | null;
  if (p === null || typeof p !== "object") throw new EmailParamsError("notice parameters do not have the expected shape");
  if (p.removedSignIns === undefined) return { removedSignIns: [] };
  if (
    !Array.isArray(p.removedSignIns) ||
    p.removedSignIns.length > 2 ||
    p.removedSignIns.some((entry) => entry !== "google" && entry !== "microsoft") ||
    new Set(p.removedSignIns).size !== p.removedSignIns.length
  ) {
    throw new EmailParamsError("notice parameters do not have the expected shape");
  }
  return { removedSignIns: p.removedSignIns as NoticeParams["removedSignIns"] };
}

/** The subject and body for one outbox row. Throws `EmailParamsError` for unusable parameters. */
export function renderEmail(
  template: EmailTemplate,
  params: unknown,
  locale: EmailLocale = "en",
): RenderedEmail {
  const messages = MESSAGES[locale];
  switch (template) {
    case "sign_in_code":
      return messages.sign_in_code(codeParams(params));
    case "invitation_link":
      return messages.invitation_link(linkParams(params));
    case "invitation_code":
      return messages.invitation_code(codeParams(params));
    case "email_change_code":
      return messages.email_change_code(codeParams(params));
    case "email_changed_notice":
      return messages.email_changed_notice(noticeParams(params));
    case "mfa_reset_notice":
      return messages.mfa_reset_notice(noticeParams(params));
    case "account_suspended_notice":
      return messages.account_suspended_notice(noticeParams(params));
    case "account_reinstated_notice":
      noticeParams(params);
      return messages.account_reinstated_notice();
    default:
      throw new EmailParamsError("unknown template");
  }
}

/**
 * An address as the worker log may show it: first character and domain (`a***@example.com`).
 * Enough to tell a bounce at one provider from a general outage; not enough to name the person.
 */
export function maskEmail(address: string): string {
  const at = address.lastIndexOf("@");
  if (at <= 0) return "***";
  return `${address[0]}***${address.slice(at)}`;
}
