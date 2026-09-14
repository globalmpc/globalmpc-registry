// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.28;

/// @title IRegistryAnchor
/// @notice 공개 승인된 Registry projection의 무결성 commitment를 BNB Chain에 고정한다.
///
/// @dev spec 08 §8.4·§8.11 / OD-05·OD-41.
///
/// 이 컨트랙트가 하지 않는 것:
/// - 원문 저장. leaf는 commitment이고 원문·PII·계약·좌표는 오프체인에 남는다.
/// - 사실성 판정. inclusion은 "그 바이트가 이 batch에 있었다"만 뜻한다.
/// - 법률 효력 부여. 공식 등록부와 충돌해도 chain이 우선순위를 정하지 않는다.
interface IRegistryAnchor {
    /// @notice batch가 제출됐다.
    /// @param batchId 오프체인에서 생성한 논리 batch 식별자. 재사용 불가.
    /// @param root Merkle root. leafHash 오름차순 정렬 + 정렬쌍 해시로 만든다.
    /// @param manifestHash batch manifest의 keccak256. manifest는 오프체인에 보존한다.
    /// @param schemaVersion canonical serialization/schema 버전.
    /// @param recordCount batch에 포함된 record 수. 0은 허용하지 않는다.
    event RootSubmitted(
        bytes32 indexed batchId,
        bytes32 indexed root,
        bytes32 manifestHash,
        string schemaVersion,
        uint32 recordCount,
        address submitter
    );

    /// @notice batch를 철회한다. 기존 root를 지우지 않고 새 사실을 추가한다.
    event BatchRevoked(bytes32 indexed batchId, string reasonCode, address actor);

    /// @notice batch를 새 batch로 대체한다. 기존 root는 그대로 남는다.
    event BatchSuperseded(bytes32 indexed batchId, bytes32 indexed newBatchId, address actor);

    error BatchAlreadyExists(bytes32 batchId);
    error BatchNotFound(bytes32 batchId);
    error BatchAlreadyRevoked(bytes32 batchId);
    error BatchAlreadySuperseded(bytes32 batchId);
    error EmptyBatch();
    error ZeroRoot();
    /// @dev batchId 0은 "대체되지 않음"(supersededBy == 0)과 구분되지 않는다.
    error ZeroBatchId();
    error SelfSupersede(bytes32 batchId);

    struct Batch {
        bytes32 root;
        bytes32 manifestHash;
        uint32 recordCount;
        uint64 submittedAt;
        bool revoked;
        bytes32 supersededBy;
    }

    function submitRoot(
        bytes32 batchId,
        bytes32 root,
        bytes32 manifestHash,
        string calldata schemaVersion,
        uint32 recordCount
    ) external;

    function revokeBatch(bytes32 batchId, string calldata reasonCode) external;

    function supersedeBatch(bytes32 batchId, bytes32 newBatchId) external;

    function getBatch(bytes32 batchId) external view returns (Batch memory);

    function batchCount() external view returns (uint256);
}
