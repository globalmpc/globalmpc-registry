"use client";

import { useState } from "react";

/**
 * 지갑 주소 표시 — 항상 전체 주소, 복사 가능.
 *
 * 줄인 주소(`0x4868…`)는 눈으로 대조할 수 없다. 앞 몇 자리가 같은 다른 주소를 만드는
 * 것은 어렵지 않고, 운영자가 사람을 연결·비활성할 때 틀린 줄을 누르게 된다.
 * 전체를 보이고, 옮겨 적다 틀리지 않게 복사 버튼을 붙인다.
 */
export function Address({ value, label = "wallet address" }: {
  readonly value: string;
  readonly label?: string;
}) {
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");

  async function copy() {
    try {
      await navigator.clipboard.writeText(value);
      setState("copied");
    } catch {
      // 권한 거부·비보안 문맥. 주소는 화면에 전부 있으므로 직접 선택해 복사할 수 있다.
      setState("failed");
    }
    window.setTimeout(() => setState("idle"), 1600);
  }

  return (
    <span className="address">
      <span className="mono address-value" data-testid="wallet-address">
        {value}
      </span>
      <button
        type="button"
        className="address-copy"
        onClick={() => void copy()}
        aria-label={`Copy ${label}`}
      >
        {state === "copied" ? "Copied" : state === "failed" ? "Select to copy" : "Copy"}
      </button>
    </span>
  );
}
