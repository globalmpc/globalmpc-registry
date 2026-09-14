// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.28;

/// @dev spec 08 §8.1의 컨트랙트 중 `RegistryAnchorV1`을 제외한 것들.
///
/// **이 파일의 인터페이스는 구현·배포 대상이 아니다.** OD-05에 따라 첫 배포는
/// RegistryAnchor 하나뿐이고, 나머지는 각자의 법률·파라미터·감사 gate를 통과한 뒤
/// 별도 release로 배포한다. 여기서는 경계와 invariant만 고정해, 나중에 구현할 때
/// 책임 범위가 흔들리지 않게 한다.
///
/// OD-07: feature flag 뒤에 미승인 규제 기능을 숨겨 두지 않는다. 인터페이스만
/// 두는 것과 구현을 숨겨 두는 것은 다르다.

/// @notice 고정 공급 MPC 토큰.
/// @dev invariant (13 §13.5):
///  - totalSupply == 10_000_000_000 * 10^decimals
///  - mint authority가 없거나 배포 직후 영구 폐기
///  - AT 권리·배당·법적 발행과 무관하다(R-01·R-02). NAV 추종 로직을 넣지 않는다.
interface IMPCToken {
    function totalSupply() external view returns (uint256);
    function mintingPermanentlyDisabled() external view returns (bool);
}

/// @notice 5개 bucket vesting.
/// @dev invariant:
///  - bucket allocation 합계 == total supply
///  - TGE release 합계 == 1_350_000_000 (13.5%)
///  - cumulative vesting은 단조 증가하며 bucket total을 넘지 않는다
///  - 마지막 period 이후 releasable remainder == 0
///  - beneficiary 변경은 bucket total을 바꾸지 않는다
interface IMPCVesting {
    enum Bucket { Community, TeamAdvisors, Investors, MarketingListing, Liquidity }

    function bucketTotal(Bucket bucket) external view returns (uint256);
    function cumulativeEntitlement(Bucket bucket, uint64 timestamp) external view returns (uint256);
    function claimed(Bucket bucket) external view returns (uint256);
}

/// @notice versioned protocol parameter reference.
/// @dev 개별 project의 권리를 바꿀 수 없다. fee·listing·reviewer 기준의 version만 가리킨다.
interface IProtocolParameterRegistry {
    function currentVersion(bytes32 parameterKey) external view returns (bytes32);
}

/// @notice Protocol Governance.
/// @dev invariant (13 §13.5, AC-05):
///  - proposal type allowlist가 contract code와 test에 고정된다
///  - target allowlist에 project asset disposition target이 없다
///  - readiness override·legal issuance 승인 target을 가질 수 없다
interface IProtocolGovernor {
    function isAllowedProposalType(bytes32 proposalType) external view returns (bool);
    function isAllowedTarget(address target) external view returns (bool);
}

/// @notice Project Governance.
/// @dev invariant:
///  - project ID별 voter snapshot과 결과만 기록한다
///  - SPV 지분이나 법정 자금을 이동하지 않는다
///  - protocol parameter·treasury를 변경할 수 없다
///  - 투표 성공은 `execution_pending`이며 오프체인 집행 완료가 아니다(AC-06)
interface IProjectGovernor {
    function projectOf(uint256 proposalId) external view returns (bytes32);
    function executionState(uint256 proposalId) external view returns (uint8);
}

/// @notice 조건부 MPC bond.
/// @dev legal issuance를 승인하지 않는다. release/slash 조건은 OD-28에서 확정한다.
interface IGateBond {
    function lockedAmount(bytes32 projectId) external view returns (uint256);
}

/// @notice verification/oracle stake.
/// @dev slash는 double-sign·forged source reference·signed unavailable data 같은
///      객관적 증거에 한정한다. 의견 차이·사업 실패·가격 하락은 slash 사유가 아니다.
interface IVerificationStaking {
    function stakeOf(address participant) external view returns (uint256);
}

/// @notice marketing/event/early access 목록.
/// @dev **경고**: 이 목록의 membership을 transfer hook의 authorization으로 쓰면 안 된다
///      (13 §13.5, AC-07). regulated eligibility는 ComplianceAdapter가 관리한다.
///      두 interface·event·storage namespace를 분리한다(08 §8.6).
interface IAccessRegistry {
    function isMember(address account) external view returns (bool);
}

/// @notice 기능·관할별 ERSP의 investor/transfer status reference.
/// @dev MPC가 아니라 project-specific Issuer와 해당 ERSP가 계약상 권한으로 관리한다.
///      `ersp_confirmed`도 legalEffect를 none보다 높이지 않는다(AC-33).
interface IComplianceAdapter {
    function transferEligibility(address account, bytes32 jurisdiction)
        external
        view
        returns (uint8);
}

/// @notice project별 asset contract reference.
/// @dev 법적 등록부를 대체하지 않는다. 기본값은 reference이며 장부증권 인정 여부는
///      OD-36의 별도 결정이다.
interface IAssetRegistryAdapter {
    function contractReference(bytes32 projectId) external view returns (address);
}
