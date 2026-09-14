"use client";

import { PublicRegistryBrowser } from "@/components/PublicRegistryBrowser";

/**
 * Verification Registry public list — spec 11 §11.2·§11.3.
 *
 * The purpose of publishing review results is not to show "reviewed" but **who looked at what,
 * under which authority and scope, and what they did not look at**
 * (OD-40). So the list shows reviewer organization, credential type, and decision type together
 * — a list of names alone leaves only the impression of "review complete".
 *
 * Reviewers default to a pseudonymous handle (AC-32). Natural-person names are not in the public
 * allowlist, so the server never returns them.
 */
export default function PublicVerificationsPage() {
  return (
    <>
      <div className="page-head">
        <div>
          <h1>Verification Records</h1>
          <p className="sub">
            Published reviews with the scope and the limits each reviewer stated. A record here
            reports what was examined. It is not an assurance of outcome, and it does not transfer
            the reviewer&rsquo;s standing to anything outside the stated scope.
          </p>
        </div>
      </div>

      <div className="notice" style={{ color: "var(--alert)" }}>
        <div className="title">Reading a verification record</div>
        Open a record to see the scope, the limitations, and the authority behind it. Those three
        travel with the record at every level of detail — a shorter view drops explanation, never
        limits.
      </div>

      <PublicRegistryBrowser
        registryType="verification"
        hrefFor={(item) =>
          `/explorer?registryType=verification&publicKey=${encodeURIComponent(item.publicKey)}`
        }
        // Server search (0034) looks only at the key and project fields. Saying it searches by reviewer
        // organization or decision makes an empty result read as "no such record".
        searchPlaceholder="Verification key"
        emptyMessage="No verification record has been published yet. This is not a permission problem."
        columns={[
          { field: "reviewerOrganization", label: "Reviewer" },
          { field: "reviewerCredentialType", label: "Credential" },
          { field: "decisionType", label: "Decision" },
          { field: "verificationScope", label: "Scope" },
        ]}
      />
    </>
  );
}
