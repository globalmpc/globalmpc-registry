// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.28;

/// @title IRegistryAnchor
/// @notice Fixes integrity commitments of the publicly approved Registry projection on BNB Chain.
///
/// @dev spec 08 §8.4·§8.11 / OD-05·OD-41.
///
/// What this contract does not do:
/// - Store source content. Leaves are commitments; content, PII, contracts, and coordinates
///   stay off-chain.
/// - Judge factuality. Inclusion only means "those bytes were in this batch".
/// - Confer legal effect. Even if it conflicts with the official register, the chain does not
///   decide precedence.
interface IRegistryAnchor {
    /// @notice A batch was submitted.
    /// @param batchId Logical batch identifier generated off-chain. Never reused.
    /// @param root Merkle root. Built from leaves sorted ascending by leafHash plus sorted-pair hashing.
    /// @param manifestHash keccak256 of the batch manifest. The manifest is kept off-chain.
    /// @param schemaVersion canonical serialization/schema version.
    /// @param recordCount Number of records in the batch. Zero is not allowed.
    event RootSubmitted(
        bytes32 indexed batchId,
        bytes32 indexed root,
        bytes32 manifestHash,
        string schemaVersion,
        uint32 recordCount,
        address submitter
    );

    /// @notice Revokes a batch. Adds a new fact without deleting the existing root.
    event BatchRevoked(bytes32 indexed batchId, string reasonCode, address actor);

    /// @notice Supersedes a batch with a new batch. The existing root stays.
    event BatchSuperseded(bytes32 indexed batchId, bytes32 indexed newBatchId, address actor);

    error BatchAlreadyExists(bytes32 batchId);
    error BatchNotFound(bytes32 batchId);
    error BatchAlreadyRevoked(bytes32 batchId);
    error BatchAlreadySuperseded(bytes32 batchId);
    error EmptyBatch();
    error ZeroRoot();
    /// @dev batchId 0 is indistinguishable from "not superseded" (supersededBy == 0).
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
