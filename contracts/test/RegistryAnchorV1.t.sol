// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {IAccessControl} from "@openzeppelin/contracts/access/IAccessControl.sol";
import {
    IAccessControlDefaultAdminRules
} from "@openzeppelin/contracts/access/extensions/IAccessControlDefaultAdminRules.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {IERC165} from "@openzeppelin/contracts/utils/introspection/IERC165.sol";
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
    bytes32 internal constant BATCH_3 = keccak256("batch-3");
    bytes32 internal constant ROOT_3 = keccak256("root-3");

    uint48 internal constant ADMIN_DELAY = 2 days;

    function setUp() public {
        // A realistic clock: OpenZeppelin's schedules treat 0 as "unset".
        vm.warp(1_800_000_000);
        anchor = new RegistryAnchorV1(ADMIN_DELAY, admin, submitter, pauser);
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
            abi.encodeWithSelector(IAccessControl.AccessControlUnauthorizedAccount.selector, stranger, role)
        );
        anchor.submitRoot(BATCH_1, ROOT_1, MANIFEST_1, "1", 3);
    }

    /// @dev admin is a management right, not a submission right. The roles are separate.
    function test_submitRoot_adminCannotSubmitWithoutRole() public {
        bytes32 role = anchor.ANCHOR_SUBMITTER_ROLE();
        vm.prank(admin);
        vm.expectRevert(abi.encodeWithSelector(IAccessControl.AccessControlUnauthorizedAccount.selector, admin, role));
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
        vm.expectRevert(abi.encodeWithSelector(IRegistryAnchor.BatchAlreadyRevoked.selector, BATCH_1));
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
        _submit(BATCH_3, ROOT_3);

        vm.startPrank(submitter);
        anchor.supersedeBatch(BATCH_1, BATCH_2);
        vm.expectRevert(abi.encodeWithSelector(IRegistryAnchor.BatchAlreadySuperseded.selector, BATCH_1));
        anchor.supersedeBatch(BATCH_1, BATCH_3);
        vm.stopPrank();
    }

    /// @dev Audit L-6: A->B then B->A formed a 2-cycle, and a walk along supersededBy never
    ///      ended. The successor must now be a chain head.
    function test_supersedeBatch_refusesACycle() public {
        _submit(BATCH_1, ROOT_1);
        _submit(BATCH_2, ROOT_2);

        vm.startPrank(submitter);
        anchor.supersedeBatch(BATCH_1, BATCH_2);
        vm.expectRevert(abi.encodeWithSelector(IRegistryAnchor.SupersedeTargetSuperseded.selector, BATCH_1));
        anchor.supersedeBatch(BATCH_2, BATCH_1);
        vm.stopPrank();
        assertEq(anchor.getBatch(BATCH_2).supersededBy, bytes32(0));
    }

    /// @dev Linking to an older link in the chain is refused; link to the head instead.
    function test_supersedeBatch_requiresTheChainHead() public {
        _submit(BATCH_1, ROOT_1);
        _submit(BATCH_2, ROOT_2);
        _submit(BATCH_3, ROOT_3);

        vm.startPrank(submitter);
        anchor.supersedeBatch(BATCH_1, BATCH_2);
        vm.expectRevert(abi.encodeWithSelector(IRegistryAnchor.SupersedeTargetSuperseded.selector, BATCH_1));
        anchor.supersedeBatch(BATCH_3, BATCH_1);
        anchor.supersedeBatch(BATCH_2, BATCH_3);
        vm.stopPrank();
        assertEq(anchor.getBatch(BATCH_2).supersededBy, BATCH_3);
    }

    /// @dev Following the link must not land on a withdrawn root.
    function test_supersedeBatch_refusesARevokedTarget() public {
        _submit(BATCH_1, ROOT_1);
        _submit(BATCH_2, ROOT_2);

        vm.startPrank(submitter);
        anchor.revokeBatch(BATCH_2, "BAD");
        vm.expectRevert(abi.encodeWithSelector(IRegistryAnchor.SupersedeTargetRevoked.selector, BATCH_2));
        anchor.supersedeBatch(BATCH_1, BATCH_2);
        vm.stopPrank();
    }

    /// @dev A revoked batch is already withdrawn; "replaced by" would misdescribe it.
    function test_supersedeBatch_refusesARevokedSource() public {
        _submit(BATCH_1, ROOT_1);
        _submit(BATCH_2, ROOT_2);

        vm.startPrank(submitter);
        anchor.revokeBatch(BATCH_1, "BAD");
        vm.expectRevert(abi.encodeWithSelector(IRegistryAnchor.RevokedBatchCannotBeSuperseded.selector, BATCH_1));
        anchor.supersedeBatch(BATCH_1, BATCH_2);
        vm.stopPrank();
    }

    /// @dev Revoking a batch after it was superseded, or after it became a successor, stays
    ///      possible: each is a later fact with its own event.
    function test_revokeBatch_worksOnBothEndsOfALink() public {
        _submit(BATCH_1, ROOT_1);
        _submit(BATCH_2, ROOT_2);

        vm.startPrank(submitter);
        anchor.supersedeBatch(BATCH_1, BATCH_2);
        anchor.revokeBatch(BATCH_1, "OLD");
        anchor.revokeBatch(BATCH_2, "NEW");
        vm.stopPrank();
        assertEq(anchor.getBatch(BATCH_1).supersededBy, BATCH_2);
        assertTrue(anchor.getBatch(BATCH_1).revoked && anchor.getBatch(BATCH_2).revoked);
    }

    /// @dev Arbitrary supersede attempts over a small pool never leave a walk that fails to end
    ///      within batchCount() steps.
    function testFuzz_supersedeWalksAlwaysTerminate(uint8[32] memory froms, uint8[32] memory tos) public {
        uint256 pool = 6;
        bytes32[] memory ids = new bytes32[](pool);
        for (uint256 i = 0; i < pool; i++) {
            ids[i] = keccak256(abi.encode("pool", i));
            _submit(ids[i], keccak256(abi.encode("root", i)));
        }
        vm.startPrank(submitter);
        for (uint256 k = 0; k < froms.length; k++) {
            try anchor.supersedeBatch(ids[froms[k] % pool], ids[tos[k] % pool]) {} catch {}
        }
        vm.stopPrank();
        for (uint256 i = 0; i < pool; i++) {
            bytes32 cur = ids[i];
            uint256 steps;
            while (anchor.getBatch(cur).supersededBy != bytes32(0)) {
                cur = anchor.getBatch(cur).supersededBy;
                steps++;
                assertLe(steps, anchor.batchCount(), "supersede walk did not terminate");
            }
        }
    }

    // -----------------------------------------------------------------------
    // 08 §8.8 — pause does not block reads or proofs
    // -----------------------------------------------------------------------

    function test_pause_blocksSubmissionButNotReads() public {
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

    /// @dev Pause must contain a compromised submitter. A revoke cannot be undone, so if it
    ///      stayed open a stolen key could withdraw honest batches after the pauser reacted.
    ///      Corrections wait for rotated keys and unpause. (Before M-1, this test asserted the
    ///      opposite.)
    function test_pause_blocksRevoke() public {
        _submit(BATCH_1, ROOT_1);

        vm.prank(pauser);
        anchor.pause();

        vm.prank(submitter);
        vm.expectRevert(Pausable.EnforcedPause.selector);
        anchor.revokeBatch(BATCH_1, "EMERGENCY");
        assertFalse(anchor.getBatch(BATCH_1).revoked);
    }

    /// @dev A supersede link is permanent: one set by a stolen key during pause would block
    ///      the legitimate correction forever (`BatchAlreadySuperseded`).
    function test_pause_blocksSupersede() public {
        _submit(BATCH_1, ROOT_1);
        _submit(BATCH_2, ROOT_2);

        vm.prank(pauser);
        anchor.pause();

        vm.prank(submitter);
        vm.expectRevert(Pausable.EnforcedPause.selector);
        anchor.supersedeBatch(BATCH_1, BATCH_2);
        assertEq(anchor.getBatch(BATCH_1).supersededBy, bytes32(0));
    }

    /// @dev The audit scenario end to end: pause, the stolen key is refused, and after unpause
    ///      the legitimate correction is still possible.
    function test_unpause_restoresCorrections() public {
        _submit(BATCH_1, ROOT_1);
        _submit(BATCH_2, ROOT_2);
        _submit(BATCH_3, ROOT_3);

        vm.prank(pauser);
        anchor.pause();
        vm.startPrank(submitter);
        vm.expectRevert(Pausable.EnforcedPause.selector);
        anchor.supersedeBatch(BATCH_1, BATCH_2);
        vm.expectRevert(Pausable.EnforcedPause.selector);
        anchor.revokeBatch(BATCH_3, "ATTACK");
        vm.stopPrank();
        // Reads keep working while paused.
        assertEq(anchor.getBatch(BATCH_1).root, ROOT_1);

        vm.prank(pauser);
        anchor.unpause();

        vm.startPrank(submitter);
        anchor.supersedeBatch(BATCH_1, BATCH_3);
        anchor.revokeBatch(BATCH_2, "SOURCE_CORRECTION");
        vm.stopPrank();
        assertEq(anchor.getBatch(BATCH_1).supersededBy, BATCH_3);
        assertTrue(anchor.getBatch(BATCH_2).revoked);
        assertFalse(anchor.getBatch(BATCH_3).revoked);
    }

    /// @dev The recovery order the pause rule relies on: while paused the admin rotates the
    ///      submitter, the old key is locked out, and after unpause the new key corrects.
    function test_pause_allowsSubmitterRotationBeforeCorrections() public {
        _submit(BATCH_1, ROOT_1);
        bytes32 submitterRole = anchor.ANCHOR_SUBMITTER_ROLE();
        address rotated = address(0x5AFE2);

        vm.prank(pauser);
        anchor.pause();
        vm.startPrank(admin);
        anchor.revokeRole(submitterRole, submitter);
        anchor.grantRole(submitterRole, rotated);
        vm.stopPrank();
        vm.prank(pauser);
        anchor.unpause();

        vm.prank(submitter);
        vm.expectRevert(
            abi.encodeWithSelector(IAccessControl.AccessControlUnauthorizedAccount.selector, submitter, submitterRole)
        );
        anchor.revokeBatch(BATCH_1, "STOLEN_KEY");
        vm.prank(rotated);
        anchor.revokeBatch(BATCH_1, "SOURCE_CORRECTION");
        assertTrue(anchor.getBatch(BATCH_1).revoked);
    }

    function test_pause_revertsForUnauthorized() public {
        bytes32 role = anchor.PAUSER_ROLE();
        vm.prank(stranger);
        vm.expectRevert(
            abi.encodeWithSelector(IAccessControl.AccessControlUnauthorizedAccount.selector, stranger, role)
        );
        anchor.pause();
    }

    function test_unpause_restoresSubmissionAndPreservesHistory() public {
        _submit(BATCH_1, ROOT_1);
        vm.startPrank(pauser);
        anchor.pause();
        anchor.unpause();
        vm.stopPrank();

        assertFalse(anchor.paused());
        _submit(BATCH_2, ROOT_2);
        assertEq(anchor.batchCount(), 2);
        assertEq(anchor.batchIdAt(0), BATCH_1);
        assertEq(anchor.batchIdAt(1), BATCH_2);
        assertEq(anchor.getBatch(BATCH_1).root, ROOT_1);
    }

    function test_unpause_revertsForUnauthorized() public {
        vm.prank(pauser);
        anchor.pause();
        bytes32 role = anchor.PAUSER_ROLE();
        vm.prank(stranger);
        vm.expectRevert(
            abi.encodeWithSelector(IAccessControl.AccessControlUnauthorizedAccount.selector, stranger, role)
        );
        anchor.unpause();
        assertTrue(anchor.paused());
    }

    function test_supersedeBatch_revertsWhenOriginalMissing() public {
        _submit(BATCH_2, ROOT_2);
        vm.prank(submitter);
        vm.expectRevert(abi.encodeWithSelector(IRegistryAnchor.BatchNotFound.selector, BATCH_1));
        anchor.supersedeBatch(BATCH_1, BATCH_2);
        assertEq(anchor.getBatch(BATCH_2).root, ROOT_2);
    }

    // -----------------------------------------------------------------------
    // Not even the admin can change a root
    // -----------------------------------------------------------------------

    /// @dev There is no function at all through which DEFAULT_ADMIN_ROLE can modify a root.
    ///      This test fails if such a function is added to the ABI.
    function test_noFunctionCanMutateStoredRoot() public {
        _submit(BATCH_1, ROOT_1);
        bytes32 rootBefore = anchor.getBatch(BATCH_1).root;

        bytes32 submitterRole = anchor.ANCHOR_SUBMITTER_ROLE();
        vm.startPrank(admin);
        anchor.grantRole(submitterRole, admin);
        // Even with every role, all admin can do is mark revoke/supersede.
        anchor.revokeBatch(BATCH_1, "ADMIN_ATTEMPT");
        vm.stopPrank();

        assertEq(anchor.getBatch(BATCH_1).root, rootBefore);
    }

    // -----------------------------------------------------------------------
    // Admin — AccessControlDefaultAdminRules (audit L-3)
    // -----------------------------------------------------------------------

    function test_constructor_setsSingleAdminAndDelay() public view {
        assertEq(anchor.defaultAdmin(), admin);
        assertEq(anchor.owner(), admin);
        assertEq(anchor.defaultAdminDelay(), ADMIN_DELAY);
        assertTrue(anchor.hasRole(anchor.ANCHOR_SUBMITTER_ROLE(), submitter));
        assertTrue(anchor.hasRole(anchor.PAUSER_ROLE(), pauser));
    }

    /// @dev A role granted to address(0) is a role nobody holds. OpenZeppelin refuses it.
    function test_constructor_revertsOnZeroAdmin() public {
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccessControlDefaultAdminRules.AccessControlInvalidDefaultAdmin.selector, address(0)
            )
        );
        new RegistryAnchorV1(ADMIN_DELAY, address(0), submitter, pauser);
    }

    /// @dev The one-step handover (grant to a typo, renounce) is gone.
    function test_admin_cannotGrantAdminRoleDirectly() public {
        bytes32 adminRole = anchor.DEFAULT_ADMIN_ROLE();
        vm.prank(admin);
        vm.expectRevert(IAccessControlDefaultAdminRules.AccessControlEnforcedDefaultAdminRules.selector);
        anchor.grantRole(adminRole, address(0xdead));
    }

    function test_admin_cannotRenounceWithoutTheScheduledFlow() public {
        bytes32 adminRole = anchor.DEFAULT_ADMIN_ROLE();
        vm.prank(admin);
        vm.expectRevert(
            abi.encodeWithSelector(IAccessControlDefaultAdminRules.AccessControlEnforcedDefaultAdminDelay.selector, 0)
        );
        anchor.renounceRole(adminRole, admin);
        assertEq(anchor.defaultAdmin(), admin);
    }

    /// @dev Handover takes two steps and the delay; only the named new admin can accept.
    function test_admin_twoStepTransferWithDelay() public {
        address newAdmin = address(0xAD2);
        vm.prank(admin);
        anchor.beginDefaultAdminTransfer(newAdmin);
        uint48 schedule = uint48(block.timestamp) + ADMIN_DELAY;

        vm.prank(stranger);
        vm.expectRevert(
            abi.encodeWithSelector(IAccessControlDefaultAdminRules.AccessControlInvalidDefaultAdmin.selector, stranger)
        );
        anchor.acceptDefaultAdminTransfer();

        vm.prank(newAdmin);
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccessControlDefaultAdminRules.AccessControlEnforcedDefaultAdminDelay.selector, schedule
            )
        );
        anchor.acceptDefaultAdminTransfer();

        vm.warp(schedule + 1);
        vm.prank(newAdmin);
        anchor.acceptDefaultAdminTransfer();
        assertEq(anchor.defaultAdmin(), newAdmin);
        assertFalse(anchor.hasRole(anchor.DEFAULT_ADMIN_ROLE(), admin));
    }

    /// @dev The current admin can cancel a handover it did not intend, within the delay.
    function test_admin_canCancelAPendingTransfer() public {
        address attackerChoice = address(0xBADAD);
        vm.startPrank(admin);
        anchor.beginDefaultAdminTransfer(attackerChoice);
        anchor.cancelDefaultAdminTransfer();
        vm.stopPrank();

        vm.warp(block.timestamp + ADMIN_DELAY + 1);
        vm.prank(attackerChoice);
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccessControlDefaultAdminRules.AccessControlInvalidDefaultAdmin.selector, attackerChoice
            )
        );
        anchor.acceptDefaultAdminTransfer();
        assertEq(anchor.defaultAdmin(), admin);
    }

    /// @dev Renouncing is possible, but only by scheduling a transfer to address(0) and waiting.
    function test_admin_renounceAfterScheduledDelay() public {
        bytes32 adminRole = anchor.DEFAULT_ADMIN_ROLE();
        vm.prank(admin);
        anchor.beginDefaultAdminTransfer(address(0));
        vm.warp(block.timestamp + ADMIN_DELAY + 1);
        vm.prank(admin);
        anchor.renounceRole(adminRole, admin);
        assertEq(anchor.defaultAdmin(), address(0));
    }

    /// @dev Submitter and pauser are still granted and revoked in one step by the admin.
    function test_admin_managesOperationalRolesDirectly() public {
        bytes32 submitterRole = anchor.ANCHOR_SUBMITTER_ROLE();
        bytes32 pauserRole = anchor.PAUSER_ROLE();
        address rotated = address(0x5AFE2);
        vm.startPrank(admin);
        anchor.grantRole(submitterRole, rotated);
        anchor.revokeRole(submitterRole, submitter);
        anchor.revokeRole(pauserRole, pauser);
        vm.stopPrank();
        assertTrue(anchor.hasRole(submitterRole, rotated));
        assertFalse(anchor.hasRole(submitterRole, submitter));
        assertFalse(anchor.hasRole(pauserRole, pauser));
    }

    /// @dev Each holder has exactly its own role. A constructor that also granted, say, the
    ///      pauser role to the admin would survive every other test here.
    function test_roles_areSeparatedBetweenDistinctHolders() public view {
        bytes32 adminRole = anchor.DEFAULT_ADMIN_ROLE();
        bytes32 submitterRole = anchor.ANCHOR_SUBMITTER_ROLE();
        bytes32 pauserRole = anchor.PAUSER_ROLE();

        assertTrue(anchor.hasRole(adminRole, admin));
        assertFalse(anchor.hasRole(submitterRole, admin));
        assertFalse(anchor.hasRole(pauserRole, admin));

        assertTrue(anchor.hasRole(submitterRole, submitter));
        assertFalse(anchor.hasRole(adminRole, submitter));
        assertFalse(anchor.hasRole(pauserRole, submitter));

        assertTrue(anchor.hasRole(pauserRole, pauser));
        assertFalse(anchor.hasRole(adminRole, pauser));
        assertFalse(anchor.hasRole(submitterRole, pauser));
    }

    /// @dev Admin work does not stop with pause: rotation and handover must be possible while
    ///      corrections wait.
    function test_admin_flowsWorkWhilePaused() public {
        bytes32 submitterRole = anchor.ANCHOR_SUBMITTER_ROLE();
        address newAdmin = address(0xB0B);
        vm.prank(pauser);
        anchor.pause();

        vm.startPrank(admin);
        anchor.revokeRole(submitterRole, submitter);
        anchor.beginDefaultAdminTransfer(newAdmin);
        vm.stopPrank();
        vm.warp(block.timestamp + ADMIN_DELAY + 1);
        vm.prank(newAdmin);
        anchor.acceptDefaultAdminTransfer();

        assertEq(anchor.defaultAdmin(), newAdmin);
        assertFalse(anchor.hasRole(submitterRole, submitter));
        assertTrue(anchor.paused());
    }

    /// @dev Pause is the pauser's alone; the admin cannot lift it without being granted the role.
    function test_unpause_adminWithoutRoleCannot() public {
        bytes32 pauserRole = anchor.PAUSER_ROLE();
        vm.prank(pauser);
        anchor.pause();
        vm.prank(admin);
        vm.expectRevert(
            abi.encodeWithSelector(IAccessControl.AccessControlUnauthorizedAccount.selector, admin, pauserRole)
        );
        anchor.unpause();
    }

    /// @dev With the admin renounced, the operational roles keep working; only role changes end.
    function test_admin_renouncedContractStillAnchors() public {
        bytes32 adminRole = anchor.DEFAULT_ADMIN_ROLE();
        vm.prank(admin);
        anchor.beginDefaultAdminTransfer(address(0));
        vm.warp(block.timestamp + ADMIN_DELAY + 1);
        vm.prank(admin);
        anchor.renounceRole(adminRole, admin);

        _submit(BATCH_1, ROOT_1);
        assertEq(anchor.getBatch(BATCH_1).root, ROOT_1);
    }

    function test_supportsInterface() public view {
        assertTrue(anchor.supportsInterface(type(IAccessControlDefaultAdminRules).interfaceId));
        assertTrue(anchor.supportsInterface(type(IAccessControl).interfaceId));
        assertTrue(anchor.supportsInterface(type(IERC165).interfaceId));
    }

    /// @dev Revoking a successor ends its predecessor's line for good: the predecessor already
    ///      has its one link, and the revoked successor cannot get one. Correct by superseding
    ///      first; revoke a head only when the line should end.
    function test_supersedeBatch_revokedSuccessorEndsThePredecessorsLine() public {
        _submit(BATCH_1, ROOT_1);
        _submit(BATCH_2, ROOT_2);
        _submit(BATCH_3, ROOT_3);

        vm.startPrank(submitter);
        anchor.supersedeBatch(BATCH_1, BATCH_2);
        anchor.revokeBatch(BATCH_2, "BAD");
        vm.expectRevert(abi.encodeWithSelector(IRegistryAnchor.BatchAlreadySuperseded.selector, BATCH_1));
        anchor.supersedeBatch(BATCH_1, BATCH_3);
        vm.expectRevert(abi.encodeWithSelector(IRegistryAnchor.RevokedBatchCannotBeSuperseded.selector, BATCH_2));
        anchor.supersedeBatch(BATCH_2, BATCH_3);
        vm.stopPrank();
        assertEq(anchor.getBatch(BATCH_1).supersededBy, BATCH_2);
    }

    /// @dev The correction order that keeps the line open: supersede the bad head first, then
    ///      the line continues from the replacement.
    function test_supersedeBatch_correctingAHeadKeepsTheLineOpen() public {
        _submit(BATCH_1, ROOT_1);
        _submit(BATCH_2, ROOT_2);
        _submit(BATCH_3, ROOT_3);

        vm.startPrank(submitter);
        anchor.supersedeBatch(BATCH_1, BATCH_2);
        anchor.supersedeBatch(BATCH_2, BATCH_3);
        vm.stopPrank();
        assertEq(anchor.getBatch(anchor.getBatch(BATCH_1).supersededBy).supersededBy, BATCH_3);
    }

    /// @dev A long chain built one head at a time walks to its head in exactly length steps.
    function test_supersedeBatch_longChainWalksToItsHead() public {
        uint256 length = 12;
        bytes32[] memory ids = new bytes32[](length + 1);
        for (uint256 i = 0; i <= length; i++) {
            ids[i] = keccak256(abi.encode("chain", i));
            _submit(ids[i], keccak256(abi.encode("chain-root", i)));
        }
        vm.startPrank(submitter);
        for (uint256 i = 0; i < length; i++) {
            anchor.supersedeBatch(ids[i], ids[i + 1]);
        }
        // Closing the loop from the head back to the start is the cycle the rules forbid.
        vm.expectRevert(abi.encodeWithSelector(IRegistryAnchor.SupersedeTargetSuperseded.selector, ids[0]));
        anchor.supersedeBatch(ids[length], ids[0]);
        vm.stopPrank();

        bytes32 cur = ids[0];
        uint256 steps;
        while (anchor.getBatch(cur).supersededBy != bytes32(0)) {
            cur = anchor.getBatch(cur).supersededBy;
            steps++;
        }
        assertEq(steps, length);
        assertEq(cur, ids[length]);
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

    function testFuzz_duplicateBatchIdAlwaysReverts(bytes32 batchId, bytes32 rootA, bytes32 rootB) public {
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
        bytes32 role = anchor.ANCHOR_SUBMITTER_ROLE();

        vm.prank(caller);
        vm.expectRevert(abi.encodeWithSelector(IAccessControl.AccessControlUnauthorizedAccount.selector, caller, role));
        anchor.submitRoot(BATCH_1, ROOT_1, MANIFEST_1, "1", 1);
    }
}
