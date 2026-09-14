// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.28;

/// @dev The contracts of spec 08 §8.1 other than `RegistryAnchorV1`.
///
/// **The interfaces in this file are not to be implemented or deployed.** Per OD-05 the first
/// deployment is RegistryAnchor alone; the rest ship as separate releases after each passes its
/// own legal, parameter, and audit gates. This file only fixes boundaries and invariants so the
/// scope of responsibility does not drift when they are implemented later.
///
/// OD-07: unapproved regulated features are not hidden behind feature flags. Declaring an
/// interface is not the same as hiding an implementation.

/// @notice Fixed-supply MPC token.
/// @dev invariant (13 §13.5):
///  - totalSupply == 10_000_000_000 * 10^decimals
///  - No mint authority, or it is permanently renounced right after deployment
///  - Unrelated to AT rights, dividends, or legal issuance (R-01·R-02). No NAV-tracking logic.
interface IMPCToken {
    function totalSupply() external view returns (uint256);
    function mintingPermanentlyDisabled() external view returns (bool);
}

/// @notice Five-bucket vesting.
/// @dev invariant:
///  - Sum of bucket allocations == total supply
///  - Sum of TGE releases == 1_350_000_000 (13.5%)
///  - Cumulative vesting is monotonically non-decreasing and never exceeds the bucket total
///  - Releasable remainder == 0 after the last period
///  - Changing a beneficiary does not change the bucket total
interface IMPCVesting {
    enum Bucket { Community, TeamAdvisors, Investors, MarketingListing, Liquidity }

    function bucketTotal(Bucket bucket) external view returns (uint256);
    function cumulativeEntitlement(Bucket bucket, uint64 timestamp) external view returns (uint256);
    function claimed(Bucket bucket) external view returns (uint256);
}

/// @notice versioned protocol parameter reference.
/// @dev Cannot change an individual project's rights. Only points to versions of the fee,
///      listing, and reviewer criteria.
interface IProtocolParameterRegistry {
    function currentVersion(bytes32 parameterKey) external view returns (bytes32);
}

/// @notice Protocol Governance.
/// @dev invariant (13 §13.5, AC-05):
///  - The proposal type allowlist is fixed in contract code and tests
///  - The target allowlist contains no project asset disposition target
///  - Cannot hold a readiness override or legal issuance approval target
interface IProtocolGovernor {
    function isAllowedProposalType(bytes32 proposalType) external view returns (bool);
    function isAllowedTarget(address target) external view returns (bool);
}

/// @notice Project Governance.
/// @dev invariant:
///  - Records only per-project-ID voter snapshots and results
///  - Does not move SPV equity or legally held funds
///  - Cannot change protocol parameters or the treasury
///  - A passed vote is `execution_pending`, not completed off-chain execution (AC-06)
interface IProjectGovernor {
    function projectOf(uint256 proposalId) external view returns (bytes32);
    function executionState(uint256 proposalId) external view returns (uint8);
}

/// @notice Conditional MPC bond.
/// @dev Does not approve legal issuance. Release/slash conditions are settled by OD-28.
interface IGateBond {
    function lockedAmount(bytes32 projectId) external view returns (uint256);
}

/// @notice verification/oracle stake.
/// @dev Slashing is limited to objective evidence such as double-signing, forged source
///      references, or signed unavailable data. Disagreement, business failure, and price
///      declines are not grounds for slashing.
interface IVerificationStaking {
    function stakeOf(address participant) external view returns (uint256);
}

/// @notice marketing/event/early access list.
/// @dev **Warning**: membership in this list must not be used as authorization in a transfer
///      hook (13 §13.5, AC-07). Regulated eligibility is managed by ComplianceAdapter.
///      The two keep separate interfaces, events, and storage namespaces (08 §8.6).
interface IAccessRegistry {
    function isMember(address account) external view returns (bool);
}

/// @notice investor/transfer status reference from the ERSP for each function and jurisdiction.
/// @dev Managed under contractual authority by the project-specific Issuer and the relevant
///      ERSP, not by MPC. Even `ersp_confirmed` does not raise legalEffect above none (AC-33).
interface IComplianceAdapter {
    function transferEligibility(address account, bytes32 jurisdiction)
        external
        view
        returns (uint8);
}

/// @notice Per-project asset contract reference.
/// @dev Does not replace the legal register. The default is reference; whether it counts as
///      book-entry securities is a separate decision under OD-36.
interface IAssetRegistryAdapter {
    function contractReference(bytes32 projectId) external view returns (address);
}
