// @vitest-environment jsdom
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { PartiesPanel } from "../src/components/project/PartiesPanel";
import { mockHttp } from "./support/http";
import type { ProjectParty } from "../src/lib/projects-api";
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
const party: ProjectParty = {
  id: "party1",
  partyRole: "issuer",
  legalName: "Issuer",
  organizationId: null,
  submittedAt: "2026-10-20",
  jurisdiction: "MNG",
  status: "pending",
  evidence: null,
  asOf: null,
  version: 2,
  history: [],
};
it("submits a party as a separate act from evidence-backed confirmation", async () => {
  const changed = vi.fn();
  let fail = false;
  const calls = mockHttp({
    "POST /api/v1/projects/p1/parties": () => {
      if (fail) throw new Error("Party rejected");
      return {};
    },
    "POST /api/v1/projects/p1/parties/party1/confirmations": () => {
      if (fail) throw new Error("Evidence rejected");
      return {};
    },
  });
  render(
    <PartiesPanel
      token="token"
      projectId="p1"
      parties={[party]}
      canSubmit
      canConfirm
      onChanged={changed}
    />,
  );
  fireEvent.change(screen.getByLabelText("Party role"), {
    target: { value: "issuer" },
  });
  fireEvent.change(screen.getByLabelText("Legal name"), {
    target: { value: "New issuer" },
  });
  fireEvent.change(screen.getByLabelText("Jurisdiction (ISO3, optional)"), {
    target: { value: "mng" },
  });
  fireEvent.submit(screen.getByText("Submit party").closest("form")!);
  await waitFor(() => expect(changed).toHaveBeenCalledTimes(1));
  expect(calls[0]?.body).toMatchObject({
    partyRole: "issuer",
    legalName: "New issuer",
    jurisdiction: "MNG",
  });
  fireEvent.change(screen.getByLabelText("Party"), {
    target: { value: "party1" },
  });
  fireEvent.change(screen.getByLabelText("Status"), {
    target: { value: "confirmed" },
  });
  fireEvent.change(screen.getByLabelText("Evidence kind"), {
    target: { value: "attestation" },
  });
  fireEvent.change(screen.getByLabelText("Evidence id"), {
    target: { value: " a1 " },
  });
  fireEvent.change(screen.getByLabelText("As of"), {
    target: { value: "2026-10-20" },
  });
  fireEvent.change(screen.getByLabelText("Reason"), {
    target: { value: "Reviewed identity" },
  });
  fireEvent.submit(screen.getByText("Record party status").closest("form")!);
  await waitFor(() => expect(changed).toHaveBeenCalledTimes(2));
  expect(calls[1]?.headers.get("if-match")).toBe('"2"');
  expect(calls[1]?.body).toEqual({
    status: "confirmed",
    evidence: { kind: "attestation", id: "a1" },
    asOf: "2026-10-20",
    reason: "Reviewed identity",
  });
  fail = true;
  fireEvent.submit(screen.getByText("Record party status").closest("form")!);
  await screen.findByRole("alert");
  expect(changed).toHaveBeenCalledTimes(2);
  fireEvent.change(screen.getByLabelText("Legal name"), {
    target: { value: "Rejected issuer" },
  });
  fireEvent.submit(screen.getByText("Submit party").closest("form")!);
  await screen.findByText("Party rejected");
});
