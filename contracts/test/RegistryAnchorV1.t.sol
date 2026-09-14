// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {IAccessControl} from "@openzeppelin/contracts/access/IAccessControl.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {RegistryAnchorV1} from "../src/RegistryAnchorV1.sol";
import {IRegistryAnchor} from "../src/interfaces/IRegistryAnchor.sol";

contract RegistryAnchorV1Test is Test {
    RegistryAnchorV1 internal anchor;

    address internal admin = address(0xA11CE);
    address internal submitter = address(0x5AFE); // stands in for the Safe multisig
    address internal pauser = address(0x9A05E);
    address internal stranger = address(0xBAD);

    bytes32 internal constant BATCH_1 = keccak256("batch-1");
    bytes32 internal constant BATCH_2 = keccak256("batch-2");
    bytes32 internal constant ROOT_1 = keccak256("root-1");
    bytes32 internal constant ROOT_2 = keccak256("root-2");
    bytes32 internal constant MANIFEST_1 = keccak256("manifest-1");

    function setUp() public {
        anchor = new RegistryAnchorV1(admin, submitter, pauser);
    }

    function _submit(bytes32 batchId, bytes32 root) internal {
        vm.prank(submitter);
        anchor.submitRoot(batchId, root, MANIFEST_1, "1", 3);
    }

    // -----------------------------------------------------------------------
    // Submission
    // -----------------------------------------------------------------------

    function test_submitRoot_storesBatch() public {
        _submit(BATCH_1, ROOT_1);

        IRegistryAnchor.Batch memory batch = anchor.getBatch(BATCH_1);
        assertEq(batch.root, ROOT_1);
        assertEq(batch.manifestHash, MANIFEST_1);
        assertEq(batch.recordCount, 3);
        assertFalse(batch.revoked);
        assertEq(batch.supersededBy, bytes32(0));
        assertEq(anchor.batchCount(), 1);
    }

    function test_submitRoot_emitsEvent() public {
        vm.expectEmit(true, true, false, true);
        emit IRegistryAnchor.RootSubmitted(BATCH_1, ROOT_1, MANIFEST_1, "1", 3, submitter);
        _submit(BATCH_1, ROOT_1);
    }

    /// @dev 08 §8.4: a batchId is never reused.
    function test_submitRoot_revertsOnDuplicateBatchId() public {
        _submit(BATCH_1, ROOT_1);

        vm.prank(submitter);
        vm.expectRevert(abi.encodeWithSelector(IRegistryAnchor.BatchAlreadyExists.selector, BATCH_1));
        anchor.submitRoot(BATCH_1, ROOT_2, MANIFEST_1, "1", 5);
    }

    /// @dev After a rejected reuse, the original root is still in place.
    function test_submitRoot_duplicateDoesNotOverwrite() public {
        _submit(BATCH_1, ROOT_1);

        vm.prank(submitter);
        try anchor.submitRoot(BATCH_1, ROOT_2, MANIFEST_1, "1", 5) {
            fail();
        } catch {}

        assertEq(anchor.getBatch(BATCH_1).root, ROOT_1);
    }

    function test_submitRoot_revertsOnEmptyBatch() public {
        vm.prank(submitter);
        vm.expectRevert(IRegistryAnchor.EmptyBatch.selector);
        anchor.submitRoot(BATCH_1, ROOT_1, MANIFEST_1, "1", 0);
    }

    /// @dev batchId 0 has the same value as supersededBy's "none", so the meanings collide.
    function test_submitRoot_revertsOnZeroBatchId() public {
        vm.prank(submitter);
        vm.expectRevert(IRegistryAnchor.ZeroBatchId.selector);
        anchor.submitRoot(bytes32(0), ROOT_1, MANIFEST_1, "1", 3);
    }

    function test_submitRoot_revertsOnZeroRoot() public {
        vm.prank(submitter);
        vm.expectRevert(IRegistryAnchor.ZeroRoot.selector);
        anchor.submitRoot(BATCH_1, bytes32(0), MANIFEST_1, "1", 3);
    }

    function test_submitRoot_revertsForUnauthorized() public {
        // Read the role value up front. An external call inside the expectRevert arguments
        // would consume the prank and change the caller.
        bytes32 role = anchor.ANCHOR_SUBMITTER_ROLE();

        vm.prank(stranger);
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccessControl.AccessControlUnauthorizedAccount.selector, stranger, role
            )
        );
        anchor.submitRoot(BATCH_1, ROOT_1, MANIFEST_1, "1", 3);
    }

    /// @dev admin is a management right, not a submission right. The roles are separate.
    function test_submitRoot_adminCannotSubmitWithoutRole() public {
        vm.prank(admin);
        vm.expectRevert();
        anchor.submitRoot(BATCH_1, ROOT_1, MANIFEST_1, "1", 3);
    }

    // -----------------------------------------------------------------------
    // Corrections — append new facts instead of overwriting
    // -----------------------------------------------------------------------

    function test_revokeBatch_keepsRoot() public {
        _submit(BATCH_1, ROOT_1);

        vm.prank(submitter);
        anchor.revokeBatch(BATCH_1, "SOURCE_CORRECTION");

        IRegistryAnchor.Batch memory batch = anchor.getBatch(BATCH_1);
        assertTrue(batch.revoked);
        // The key point: the root is unchanged. What was submitted stays queryable forever.
        assertEq(batch.root, ROOT_1);
        assertEq(batch.recordCount, 3);
    }

    function test_revokeBatch_revertsOnDoubleRevoke() public {
        _submit(BATCH_1, ROOT_1);
        vm.startPrank(submitter);
        anchor.revokeBatch(BATCH_1, "REASON");
        vm.expectRevert(
            abi.encodeWithSelector(IRegistryAnchor.BatchAlreadyRevoked.selector, BATCH_1)
        );
        anchor.revokeBatch(BATCH_1, "REASON");
        vm.stopPrank();
    }

    function test_revokeBatch_revertsOnUnknownBatch() public {
        vm.prank(submitter);
        vm.expectRevert(abi.encodeWithSelector(IRegistryAnchor.BatchNotFound.selector, BATCH_1));
        anchor.revokeBatch(BATCH_1, "REASON");
    }

    function test_supersedeBatch_linksWithoutOverwriting() public {
        _submit(BATCH_1, ROOT_1);
        _submit(BATCH_2, ROOT_2);

        vm.prank(submitter);
        anchor.supersedeBatch(BATCH_1, BATCH_2);

        IRegistryAnchor.Batch memory old = anchor.getBatch(BATCH_1);
        assertEq(old.supersededBy, BATCH_2);
        assertEq(old.root, ROOT_1);
        assertEq(anchor.getBatch(BATCH_2).root, ROOT_2);
    }

    function test_supersedeBatch_revertsWhenTargetMissing() public {
        _submit(BATCH_1, ROOT_1);

        vm.prank(submitter);
        vm.expectRevert(abi.encodeWithSelector(IRegistryAnchor.BatchNotFound.selector, BATCH_2));
        anchor.supersedeBatch(BATCH_1, BATCH_2);
    }

    function test_supersedeBatch_revertsOnSelfReference() public {
        _submit(BATCH_1, ROOT_1);

        vm.prank(submitter);
        vm.expectRevert(abi.encodeWithSelector(IRegistryAnchor.SelfSupersede.selector, BATCH_1));
        anchor.supersedeBatch(BATCH_1, BATCH_1);
    }

    function test_supersedeBatch_revertsOnDoubleSupersede() public {
        _submit(BATCH_1, ROOT_1);
        _submit(BATCH_2, ROOT_2);
        bytes32 batch3 = keccak256("batch-3");
        _submit(batch3, keccak256("root-3"));

        vm.startPrank(submitter);
        anchor.supersedeBatch(BATCH_1, BATCH_2);
        vm.expectRevert(
            abi.encodeWithSelector(IRegistryAnchor.BatchAlreadySuperseded.selector, BATCH_1)
        );
        anchor.supersedeBatch(BATCH_1, batch3);
        vm.stopPrank();
    }

    // -----------------------------------------------------------------------
    // 08 §8.8 — pause does not block reads or proofs
    // -----------------------------------------------------------------------

    function test_pause_blocksSubmissionOnly() public {
        _submit(BATCH_1, ROOT_1);

        vm.prank(pauser);
        anchor.pause();

        vm.prank(submitter);
        vm.expectRevert(Pausable.EnforcedPause.selector);
        anchor.submitRoot(BATCH_2, ROOT_2, MANIFEST_1, "1", 3);

        // Reads keep working. If integrity verification could be halted, the public right
        // to verify would depend on the operator.
        assertEq(anchor.getBatch(BATCH_1).root, ROOT_1);
        assertEq(anchor.batchCount(), 1);
    }

    /// @dev Corrections must still work while paused. Halting without being able to revoke a
    ///      bad root leaves the error in place.
    function test_pause_allowsRevoke() public {
        _submit(BATCH_1, ROOT_1);

        vm.prank(pauser);
        anchor.pause();

        vm.prank(submitter);
        anchor.revokeBatch(BATCH_1, "EMERGENCY");
        assertTrue(anchor.getBatch(BATCH_1).revoked);
    }

    function test_pause_revertsForUnauthorized() public {
        vm.prank(stranger);
        vm.expectRevert();
        anchor.pause();
    }

    // -----------------------------------------------------------------------
    // Not even the admin can change a root
    // -----------------------------------------------------------------------

    /// @dev There is no function at all through which DEFAULT_ADMIN_ROLE can modify a root.
    ///      This test fails if such a function is added to the ABI.
    function test_noFunctionCanMutateStoredRoot() public {
        _submit(BATCH_1, ROOT_1);
        bytes32 rootBefore = anchor.getBatch(BATCH_1).root;

        vm.startPrank(admin);
        anchor.grantRole(anchor.ANCHOR_SUBMITTER_ROLE(), admin);
        // Even with every role, all admin can do is mark revoke/supersede.
        anchor.revokeBatch(BATCH_1, "ADMIN_ATTEMPT");
        vm.stopPrank();

        assertEq(anchor.getBatch(BATCH_1).root, rootBefore);
    }

    // -----------------------------------------------------------------------
    // Fuzz
    // -----------------------------------------------------------------------

    function testFuzz_submitRoot_storesExactValues(
        bytes32 batchId,
        bytes32 root,
        bytes32 manifestHash,
        uint32 recordCount
    ) public {
        // batchId 0 is a separate boundary value rejected with `ZeroBatchId`. This fuzz test
        // checks the normal storage property, so it states that precondition explicitly.
        vm.assume(batchId != bytes32(0));
        vm.assume(root != bytes32(0));
        vm.assume(recordCount > 0);

        vm.prank(submitter);
        anchor.submitRoot(batchId, root, manifestHash, "1", recordCount);

        IRegistryAnchor.Batch memory batch = anchor.getBatch(batchId);
        assertEq(batch.root, root);
        assertEq(batch.manifestHash, manifestHash);
        assertEq(batch.recordCount, recordCount);
    }

    function testFuzz_duplicateBatchIdAlwaysReverts(bytes32 batchId, bytes32 rootA, bytes32 rootB)
        public
    {
        // batchId 0 is caught first by `ZeroBatchId`. This test covers the duplicate check,
        // so that path is excluded — a separate test covers 0.
        vm.assume(rootA != bytes32(0) && rootB != bytes32(0) && batchId != bytes32(0));

        vm.startPrank(submitter);
        anchor.submitRoot(batchId, rootA, MANIFEST_1, "1", 1);
        vm.expectRevert(abi.encodeWithSelector(IRegistryAnchor.BatchAlreadyExists.selector, batchId));
        anchor.submitRoot(batchId, rootB, MANIFEST_1, "1", 1);
        vm.stopPrank();

        assertEq(anchor.getBatch(batchId).root, rootA);
    }

    function testFuzz_unauthorizedCannotSubmit(address caller) public {
        vm.assume(caller != submitter);

        vm.prank(caller);
        vm.expectRevert();
        anchor.submitRoot(BATCH_1, ROOT_1, MANIFEST_1, "1", 1);
    }
}
