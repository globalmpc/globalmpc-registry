// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.28;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {IRegistryAnchor} from "./interfaces/IRegistryAnchor.sol";

/// @title RegistryAnchorV1
/// @notice MPC dApp의 첫 BNB Chain 배포. 이것 하나만 배포한다(OD-05).
///
/// @dev 설계 제약 — spec 08 §8.4·§8.8, 13 §13.5:
///
/// 1. 동일 batchId 재사용 금지
/// 2. root 삭제·수정 금지 — setter가 없다
/// 3. 오류 정정은 revoke/supersede **event 추가**이며 덮어쓰기가 아니다
/// 4. pause 상태에서도 read와 proof 검증은 가능해야 한다
/// 5. DEFAULT_ADMIN_ROLE도 저장된 root를 바꿀 수 없다
///
/// 5번이 핵심이다. 관리자 권한이 탈취돼도 과거 root는 변하지 않는다. 공격자가
/// 할 수 있는 것은 새 batch를 추가하거나 기존 batch를 revoke로 표시하는 것뿐이며,
/// 그 행위 자체가 event로 남는다. 이 시스템이 체인을 쓰는 이유인 "MPC 자신도
/// 확정된 공개 이력을 단독으로 조용히 교체할 수 없다"가 이 제약에서 나온다.
contract RegistryAnchorV1 is IRegistryAnchor, AccessControl, Pausable {
    /// @notice batch 제출 권한. Safe multisig가 보유한다. EOA 단독 submitter를 두지 않는다.
    bytes32 public constant ANCHOR_SUBMITTER_ROLE = keccak256("ANCHOR_SUBMITTER_ROLE");

    /// @notice pause 실행 권한. 보안 사고 대응용이며 root를 바꿀 수는 없다.
    bytes32 public constant PAUSER_ROLE = keccak256("PAUSER_ROLE");

    mapping(bytes32 batchId => Batch batch) private _batches;

    bytes32[] private _batchIds;

    constructor(address admin, address submitter, address pauser) {
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(ANCHOR_SUBMITTER_ROLE, submitter);
        _grantRole(PAUSER_ROLE, pauser);
    }

    /// @inheritdoc IRegistryAnchor
    function submitRoot(
        bytes32 batchId,
        bytes32 root,
        bytes32 manifestHash,
        string calldata schemaVersion,
        uint32 recordCount
    ) external override onlyRole(ANCHOR_SUBMITTER_ROLE) whenNotPaused {
        // batchId 0을 거절한다. `supersededBy == 0`이 "대체되지 않음"을 뜻하므로,
        // batchId가 0이면 자기 자신을 대체한 것과 구분할 수 없다. invariant
        // fuzzing이 이 충돌을 찾아냈다.
        if (batchId == bytes32(0)) revert ZeroBatchId();
        if (_batches[batchId].submittedAt != 0) revert BatchAlreadyExists(batchId);
        if (root == bytes32(0)) revert ZeroRoot();
        // 빈 batch는 anchor하지 않는다. 오프체인 Merkle 빌더도 같은 조건으로 거절한다.
        if (recordCount == 0) revert EmptyBatch();

        _batches[batchId] = Batch({
            root: root,
            manifestHash: manifestHash,
            recordCount: recordCount,
            submittedAt: uint64(block.timestamp),
            revoked: false,
            supersededBy: bytes32(0)
        });
        _batchIds.push(batchId);

        emit RootSubmitted(batchId, root, manifestHash, schemaVersion, recordCount, msg.sender);
    }

    /// @inheritdoc IRegistryAnchor
    /// @dev root는 그대로 남는다. `revoked` 플래그와 event가 새 사실로 추가될 뿐이다.
    ///      과거에 제출된 root가 무엇이었는지는 영구히 조회 가능하다.
    function revokeBatch(bytes32 batchId, string calldata reasonCode)
        external
        override
        onlyRole(ANCHOR_SUBMITTER_ROLE)
    {
        Batch storage batch = _batches[batchId];
        if (batch.submittedAt == 0) revert BatchNotFound(batchId);
        if (batch.revoked) revert BatchAlreadyRevoked(batchId);

        batch.revoked = true;

        emit BatchRevoked(batchId, reasonCode, msg.sender);
    }

    /// @inheritdoc IRegistryAnchor
    function supersedeBatch(bytes32 batchId, bytes32 newBatchId)
        external
        override
        onlyRole(ANCHOR_SUBMITTER_ROLE)
    {
        if (batchId == newBatchId) revert SelfSupersede(batchId);

        Batch storage batch = _batches[batchId];
        if (batch.submittedAt == 0) revert BatchNotFound(batchId);
        if (batch.supersededBy != bytes32(0)) revert BatchAlreadySuperseded(batchId);
        // 대체 batch는 이미 제출돼 있어야 한다. 존재하지 않는 batch를 가리키면
        // Explorer가 따라갈 곳이 없다.
        if (_batches[newBatchId].submittedAt == 0) revert BatchNotFound(newBatchId);

        batch.supersededBy = newBatchId;

        emit BatchSuperseded(batchId, newBatchId, msg.sender);
    }

    /// @inheritdoc IRegistryAnchor
    /// @dev pause와 무관하게 항상 조회 가능하다(§8.8). 무결성 검증을 멈출 수 있으면
    ///      공개 검증권이 운영자에게 종속된다.
    function getBatch(bytes32 batchId) external view override returns (Batch memory) {
        return _batches[batchId];
    }

    /// @inheritdoc IRegistryAnchor
    function batchCount() external view override returns (uint256) {
        return _batchIds.length;
    }

    function batchIdAt(uint256 index) external view returns (bytes32) {
        return _batchIds[index];
    }

    function pause() external onlyRole(PAUSER_ROLE) {
        _pause();
    }

    function unpause() external onlyRole(PAUSER_ROLE) {
        _unpause();
    }
}
