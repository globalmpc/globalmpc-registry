// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.28;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {IRegistryAnchor} from "./interfaces/IRegistryAnchor.sol";

/// @title RegistryAnchorV1
/// @notice The MPC dApp's first BNB Chain deployment. This is the only contract deployed (OD-05).
///
/// @dev Design constraints — spec 08 §8.4·§8.8, 13 §13.5:
///
/// 1. A batchId is never reused
/// 2. Roots are never deleted or modified — there is no setter
/// 3. Corrections **append a revoke/supersede event**; they never overwrite
/// 4. Reads and proof verification must keep working while paused
/// 5. Not even DEFAULT_ADMIN_ROLE can change a stored root
///
/// Constraint 5 is the core one. Even if admin rights are compromised, past roots do not change.
/// An attacker can only add new batches or mark existing batches as revoked, and each such act
/// is itself recorded as an event. The reason this system uses a chain at all — "not even MPC
/// can silently replace the finalized public history on its own" — follows from this constraint.
contract RegistryAnchorV1 is IRegistryAnchor, AccessControl, Pausable {
    /// @notice Batch submission right. Held by a Safe multisig. No sole EOA submitter.
    bytes32 public constant ANCHOR_SUBMITTER_ROLE = keccak256("ANCHOR_SUBMITTER_ROLE");

    /// @notice Pause right. For security incident response; it cannot change roots.
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
        // Reject batchId 0. `supersededBy == 0` means "not superseded", so a zero batchId
        // would be indistinguishable from a batch superseding itself. Invariant fuzzing
        // found this collision.
        if (batchId == bytes32(0)) revert ZeroBatchId();
        if (_batches[batchId].submittedAt != 0) revert BatchAlreadyExists(batchId);
        if (root == bytes32(0)) revert ZeroRoot();
        // Empty batches are not anchored. The off-chain Merkle builder rejects them the same way.
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
    /// @dev The root stays. Only the `revoked` flag and an event are added as new facts.
    ///      What root was submitted in the past remains queryable forever.
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
        // The replacement batch must already be submitted. Pointing at a nonexistent batch
        // leaves the Explorer nowhere to follow.
        if (_batches[newBatchId].submittedAt == 0) revert BatchNotFound(newBatchId);

        batch.supersededBy = newBatchId;

        emit BatchSuperseded(batchId, newBatchId, msg.sender);
    }

    /// @inheritdoc IRegistryAnchor
    /// @dev Always readable regardless of pause (§8.8). If integrity verification could be
    ///      halted, the public right to verify would depend on the operator.
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
