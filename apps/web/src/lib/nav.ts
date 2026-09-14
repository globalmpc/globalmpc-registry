import { NAV, type NavEntry } from "./copy";

/** 메뉴를 거르는 데 필요한 세션 사실. */
export interface NavSession {
  readonly actions?: readonly string[];
  readonly subjectId?: string | null;
}

/**
 * 이 세션에 보일 워크스페이스 메뉴 — spec 11 §11.2.
 *
 * 역할→action 표를 웹이 따로 들지 않는다. 서버가 세션에 준 action 목록만 본다 —
 * 두 표가 있으면 언젠가 갈라지고, 그때 메뉴가 서버와 다른 말을 한다.
 */
export function visibleNav(session: NavSession): readonly NavEntry[] {
  const actions = session.actions ?? [];
  return NAV.filter((entry) =>
    entry.requires === "subject" ? Boolean(session.subjectId) : actions.includes(entry.requires),
  );
}
