import type { Sensitivity } from "./disclosure.js";

/**
 * 저장 경로 판정 — OD-17·OD-18 (2026-08-14 초안 결정).
 *
 * 초안 단계는 **한 가지 저장 경로만** 갖는다. provider가 관리하는 키로 암호화된
 * 단일 버킷이고, tenant별 키 분리도 rotation runbook도 없다. 그것으로 충분한
 * 자료만 이 경로를 지나갈 수 있다.
 *
 * 실제 계약서·개인정보가 올라와야 할 때는 **별도의 secured route**를 만든다.
 * 그때 tenant 키 분리·rotation·crypto-shredding을 함께 정한다(OD-18 재판정).
 *
 * **게이트를 지금 만드는 이유:** 간단한 경로만 만들고 게이트를 나중에 붙이면 그
 * 사이에 올라온 민감 자료가 간단한 경로를 그대로 지나간다. 저장은 되돌릴 수
 * 있지만 "그 관할에서 그 키로 처리됐다"는 사실은 되돌릴 수 없다.
 */

/** 초안 경로가 받을 수 있는 등급. */
const DRAFT_TIER_ALLOWED = ["public", "restricted"] as const;

export type StorageTier = "draft" | "secured";

/** 이 등급이 어느 경로로 가야 하는가. */
export function storageTierFor(sensitivity: Sensitivity): StorageTier {
  return (DRAFT_TIER_ALLOWED as readonly string[]).includes(sensitivity) ? "draft" : "secured";
}

export type StorageAdmission =
  | { readonly admitted: true; readonly tier: "draft" }
  | {
      readonly admitted: false;
      readonly requiredTier: "secured";
      readonly reason: string;
      readonly nextAction: string;
    };

/**
 * 이 자료를 지금 받을 수 있는가.
 *
 * secured route가 없는 동안 민감 등급은 거절한다. **"나중에 옮기면 된다"가
 * 성립하지 않는다** — 파일을 옮겨도 그 사이 기간의 처리 사실은 남는다.
 */
export function admitToStorage(sensitivity: Sensitivity): StorageAdmission {
  if (storageTierFor(sensitivity) === "draft") {
    return { admitted: true, tier: "draft" };
  }

  return {
    admitted: false,
    requiredTier: "secured",
    reason:
      `${sensitivity} 등급은 초안 저장 경로가 받지 않는다. ` +
      "지금 저장소는 provider 관리 키를 쓰며 tenant별 키 분리와 파기 절차가 없다",
    nextAction:
      "secured route가 열린 뒤 올린다. 그 경로는 OD-18 재판정(키 소유권·rotation·" +
      "crypto-shredding)과 함께 만들어진다",
  };
}
