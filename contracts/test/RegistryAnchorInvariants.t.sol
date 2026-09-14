// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {RegistryAnchorV1} from "../src/RegistryAnchorV1.sol";
import {IRegistryAnchor} from "../src/interfaces/IRegistryAnchor.sol";

/// @notice Handler targeted by invariant fuzzing.
/// @dev Hammers the contract in arbitrary order with arbitrary arguments and checks that no
///      submitted root ever changes. Mechanically verifies 13 §13.5's "Registry roots cannot be
///      overwritten/deleted" and "revoked/superseded is expressed only as new events".
contract AnchorHandler is Test {
    RegistryAnchorV1 public anchor;

    bytes32[] public knownBatchIds;
    mapping(bytes32 => bytes32) public expectedRoot;
    mapping(bytes32 => uint32) public expectedRecordCount;

    address internal immutable submitter;

    constructor(RegistryAnchorV1 anchor_, address submitter_) {
        anchor = anchor_;
        submitter = submitter_;
    }

    function submit(bytes32 batchId, bytes32 root, uint32 recordCount) external {
        if (batchId == bytes32(0)) return;
        if (root == bytes32(0)) return;
        if (recordCount == 0) return;
        if (expectedRoot[batchId] != bytes32(0)) return;

        vm.prank(submitter);
        try anchor.submitRoot(batchId, root, keccak256(abi.encode(batchId)), "1", recordCount) {
            knownBatchIds.push(batchId);
            expectedRoot[batchId] = root;
            expectedRecordCount[batchId] = recordCount;
        } catch {}
    }

    function revokeExisting(uint256 seed, string calldata reason) external {
        if (knownBatchIds.length == 0) return;
        bytes32 batchId = knownBatchIds[seed % knownBatchIds.length];

        vm.prank(submitter);
        try anchor.revokeBatch(batchId, reason) {} catch {}
    }

    function supersedeExisting(uint256 fromSeed, uint256 toSeed) external {
        if (knownBatchIds.length < 2) return;
        bytes32 from = knownBatchIds[fromSeed % knownBatchIds.length];
        bytes32 to = knownBatchIds[toSeed % knownBatchIds.length];

        vm.prank(submitter);
        try anchor.supersedeBatch(from, to) {} catch {}
    }

    function attemptResubmit(uint256 seed, bytes32 differentRoot) external {
        if (knownBatchIds.length == 0) return;
        if (differentRoot == bytes32(0)) return;
        bytes32 batchId = knownBatchIds[seed % knownBatchIds.length];

        vm.prank(submitter);
        try anchor.submitRoot(batchId, differentRoot, bytes32(0), "1", 1) {
            // Must not succeed. The invariants catch it if it does.
        } catch {}
    }

    function knownBatchCount() external view returns (uint256) {
        return knownBatchIds.length;
    }
}

contract RegistryAnchorInvariants is Test {
    RegistryAnchorV1 internal anchor;
    AnchorHandler internal handler;

    address internal constant SUBMITTER = address(0x5AFE);

    function setUp() public {
        anchor = new RegistryAnchorV1(address(this), SUBMITTER, address(this));
        handler = new AnchorHandler(anchor, SUBMITTER);
        targetContract(address(handler));
    }

    /// @dev A submitted root never changes under any call sequence.
    function invariant_rootNeverChanges() public view {
        uint256 count = handler.knownBatchCount();
        for (uint256 i = 0; i < count; i++) {
            bytes32 batchId = handler.knownBatchIds(i);
            IRegistryAnchor.Batch memory batch = anchor.getBatch(batchId);
            assertEq(batch.root, handler.expectedRoot(batchId), "root mutated");
        }
    }

    /// @dev Neither does recordCount.
    function invariant_recordCountNeverChanges() public view {
        uint256 count = handler.knownBatchCount();
        for (uint256 i = 0; i < count; i++) {
            bytes32 batchId = handler.knownBatchIds(i);
            assertEq(
                anchor.getBatch(batchId).recordCount,
                handler.expectedRecordCount(batchId),
                "recordCount mutated"
            );
        }
    }

    /// @dev Batches never disappear. Anything submitted stays queryable forever.
    function invariant_batchesNeverDisappear() public view {
        assertGe(anchor.batchCount(), handler.knownBatchCount(), "batch disappeared");
    }

    /// @dev revoke and supersede are only status flags; they never erase the root.
    function invariant_revokedBatchesRetainRoot() public view {
        uint256 count = handler.knownBatchCount();
        for (uint256 i = 0; i < count; i++) {
            bytes32 batchId = handler.knownBatchIds(i);
            IRegistryAnchor.Batch memory batch = anchor.getBatch(batchId);
            if (batch.revoked || batch.supersededBy != bytes32(0)) {
                assertTrue(batch.root != bytes32(0), "revoke/supersede erased root");
            }
        }
    }

    /// @dev A stored batch always has recordCount >= 1. Empty batches are never anchored.
    function invariant_noEmptyBatchStored() public view {
        uint256 count = handler.knownBatchCount();
        for (uint256 i = 0; i < count; i++) {
            assertGt(anchor.getBatch(handler.knownBatchIds(i)).recordCount, 0);
        }
    }

    /// @dev A batch cannot supersede itself.
    function invariant_noSelfSupersede() public view {
        uint256 count = handler.knownBatchCount();
        for (uint256 i = 0; i < count; i++) {
            bytes32 batchId = handler.knownBatchIds(i);
            assertTrue(anchor.getBatch(batchId).supersededBy != batchId);
        }
    }
}
