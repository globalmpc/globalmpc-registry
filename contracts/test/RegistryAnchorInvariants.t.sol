// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {StdInvariant} from "forge-std/StdInvariant.sol";
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
    /// @dev The real admin (the test contract). Never used as an actor below.
    address internal immutable admin;

    /// @dev Longest supersede chain seen in this run, in links.
    uint256 public maxChainLength;
    /// @dev Links in the longest chain that ends at this batch.
    mapping(bytes32 => uint256) internal linksBehind;

    /// @dev Calls that succeeded although the rules say they must not. The invariants require 0.
    ///      Checked here, at call time, because a later revoke legitimately changes the state the
    ///      rule was judged on.
    uint256 public ruleViolations;

    constructor(RegistryAnchorV1 anchor_, address submitter_, address admin_) {
        anchor = anchor_;
        submitter = submitter_;
        admin = admin_;
    }

    /// @dev The handler holds PAUSER_ROLE, so pause can interleave with every write. Only one
    ///      call in eight pauses: paused half the time, a run mostly records refusals and never
    ///      builds the chains the supersede rules are about.
    function pause(uint256 seed) external {
        if (seed % 8 == 0 && !anchor.paused()) anchor.pause();
    }

    function unpause() external {
        if (anchor.paused()) anchor.unpause();
    }

    /// @dev Fresh, valid ids every time, so a run accumulates batches to link. `submitRaw`
    ///      keeps the arbitrary-argument path (zero ids, zero roots, reuse).
    function submit(uint256 seed, uint32 recordCount) external {
        bytes32 batchId = keccak256(abi.encode("batch", knownBatchIds.length, seed));
        bytes32 root = keccak256(abi.encode("root", batchId));
        this.submitRaw(batchId, root, uint32(bound(recordCount, 1, type(uint32).max)));
    }

    function submitRaw(bytes32 batchId, bytes32 root, uint32 recordCount) external {
        if (batchId == bytes32(0)) return;
        if (root == bytes32(0)) return;
        if (recordCount == 0) return;
        if (expectedRoot[batchId] != bytes32(0)) return;

        bool wasPaused = anchor.paused();
        vm.prank(submitter);
        try anchor.submitRoot(batchId, root, keccak256(abi.encode(batchId)), "1", recordCount) {
            if (wasPaused) ruleViolations++;
            knownBatchIds.push(batchId);
            expectedRoot[batchId] = root;
            expectedRecordCount[batchId] = recordCount;
        } catch {}
    }

    function revokeExisting(uint256 seed, string calldata reason) external {
        if (knownBatchIds.length == 0) return;
        bytes32 batchId = knownBatchIds[seed % knownBatchIds.length];

        bool wasPaused = anchor.paused();
        vm.prank(submitter);
        try anchor.revokeBatch(batchId, reason) {
            if (wasPaused) ruleViolations++;
        } catch {}
    }

    function supersedeExisting(uint256 fromSeed, uint256 toSeed) external {
        if (knownBatchIds.length < 2) return;
        bytes32 from = knownBatchIds[fromSeed % knownBatchIds.length];
        bytes32 to = knownBatchIds[toSeed % knownBatchIds.length];

        bool wasPaused = anchor.paused();
        IRegistryAnchor.Batch memory source = anchor.getBatch(from);
        IRegistryAnchor.Batch memory target = anchor.getBatch(to);
        vm.prank(submitter);
        try anchor.supersedeBatch(from, to) {
            if (wasPaused || from == to || source.revoked || source.supersededBy != bytes32(0)) ruleViolations++;
            if (target.submittedAt == 0 || target.revoked || target.supersededBy != bytes32(0)) ruleViolations++;
            _recordLink(from, to);
        } catch {}
    }

    /// @dev O(1): the successor is a head, so the longest chain ending at it is either the one
    ///      it had or the source's plus this link.
    function _recordLink(bytes32 from, bytes32 to) private {
        uint256 length = linksBehind[from] + 1;
        if (length > linksBehind[to]) linksBehind[to] = length;
        if (length > maxChainLength) maxChainLength = length;
    }

    // --- Admin takeover attempts ------------------------------------------------------------
    // Every actor here lacks DEFAULT_ADMIN_ROLE. If any of these paths worked, the attacker
    // would schedule itself, wait out the delay (`warp`) and accept — and `invariant_admin*`
    // would see the new admin.

    function _actor(uint256 seed) private view returns (address actor) {
        address[3] memory actors = [submitter, address(this), address(uint160(0xBAD0) + uint160(seed % 4))];
        actor = actors[seed % 3];
        assert(actor != admin);
    }

    function attackBeginAdminTransfer(uint256 actorSeed) external {
        address actor = _actor(actorSeed);
        vm.prank(actor);
        try anchor.beginDefaultAdminTransfer(actor) {
            ruleViolations++;
        } catch {}
    }

    function attackAcceptAdminTransfer(uint256 actorSeed) external {
        vm.prank(_actor(actorSeed));
        try anchor.acceptDefaultAdminTransfer() {
            ruleViolations++;
        } catch {}
    }

    function attackGrantAdminRole(uint256 actorSeed) external {
        address actor = _actor(actorSeed);
        bytes32 adminRole = anchor.DEFAULT_ADMIN_ROLE();
        vm.prank(actor);
        try anchor.grantRole(adminRole, actor) {
            ruleViolations++;
        } catch {}
    }

    function attackChangeAdminDelay(uint256 actorSeed) external {
        vm.prank(_actor(actorSeed));
        try anchor.changeDefaultAdminDelay(0) {
            ruleViolations++;
        } catch {}
    }

    /// @dev Lets the admin delay elapse inside a run, so a scheduled takeover could complete.
    function warp(uint32 seconds_) external {
        vm.warp(block.timestamp + bound(seconds_, 1, 3 days));
    }

    /// @dev Biased toward success: link the head of one chain to the head of another, the only
    ///      kind of link the contract accepts from a source with no link yet. Each success joins
    ///      two chains, so runs build long ones; random pairs alone rarely got past two links.
    function supersedeToHead(uint256 fromSeed, uint256 toSeed) external {
        if (knownBatchIds.length < 2) return;
        bytes32 from = _head(knownBatchIds[fromSeed % knownBatchIds.length]);
        bytes32 to = _head(knownBatchIds[toSeed % knownBatchIds.length]);
        this.supersedeExisting(_indexOf(from), _indexOf(to));
    }

    function _head(bytes32 batchId) private view returns (bytes32) {
        for (uint256 i = 0; i < knownBatchIds.length; i++) {
            bytes32 next = anchor.getBatch(batchId).supersededBy;
            if (next == bytes32(0)) break;
            batchId = next;
        }
        return batchId;
    }

    function _indexOf(bytes32 batchId) private view returns (uint256) {
        for (uint256 i = 0; i < knownBatchIds.length; i++) {
            if (knownBatchIds[i] == batchId) return i;
        }
        return 0;
    }

    function attemptResubmit(uint256 seed, bytes32 differentRoot) external {
        if (knownBatchIds.length == 0) return;
        if (differentRoot == bytes32(0)) return;
        bytes32 batchId = knownBatchIds[seed % knownBatchIds.length];

        vm.prank(submitter);
        try anchor.submitRoot(batchId, differentRoot, bytes32(0), "1", 1) {
        // Must not succeed. The invariants catch it if it does.
        }
            catch {}
    }

    function knownBatchCount() external view returns (uint256) {
        return knownBatchIds.length;
    }

    /// @dev The whole list in one call. The invariants run after every handler call, and one
    ///      external call per index made them most of the suite's time.
    function allBatchIds() external view returns (bytes32[] memory) {
        return knownBatchIds;
    }
}

contract RegistryAnchorInvariants is Test {
    RegistryAnchorV1 internal anchor;
    AnchorHandler internal handler;

    address internal constant SUBMITTER = address(0x5AFE);

    function setUp() public {
        vm.warp(1_800_000_000);
        anchor = new RegistryAnchorV1(1 days, address(this), SUBMITTER, address(this));
        handler = new AnchorHandler(anchor, SUBMITTER, address(this));
        anchor.grantRole(anchor.PAUSER_ROLE(), address(handler));
        targetContract(address(handler));

        // Weighted by repetition: submits and head-links build the chains; everything else
        // appears once.
        bytes4[] memory selectors = new bytes4[](18);
        selectors[0] = AnchorHandler.submit.selector;
        selectors[1] = AnchorHandler.submit.selector;
        selectors[2] = AnchorHandler.submit.selector;
        selectors[3] = AnchorHandler.submit.selector;
        selectors[4] = AnchorHandler.supersedeToHead.selector;
        selectors[5] = AnchorHandler.supersedeToHead.selector;
        selectors[6] = AnchorHandler.supersedeToHead.selector;
        selectors[7] = AnchorHandler.submitRaw.selector;
        selectors[8] = AnchorHandler.supersedeExisting.selector;
        selectors[9] = AnchorHandler.revokeExisting.selector;
        selectors[10] = AnchorHandler.attemptResubmit.selector;
        selectors[11] = AnchorHandler.pause.selector;
        selectors[12] = AnchorHandler.unpause.selector;
        selectors[13] = AnchorHandler.attackBeginAdminTransfer.selector;
        selectors[14] = AnchorHandler.attackAcceptAdminTransfer.selector;
        selectors[15] = AnchorHandler.attackGrantAdminRole.selector;
        selectors[16] = AnchorHandler.attackChangeAdminDelay.selector;
        selectors[17] = AnchorHandler.warp.selector;
        targetSelector(StdInvariant.FuzzSelector({addr: address(handler), selectors: selectors}));
    }

    /// @dev No write succeeded while paused, and every supersede that succeeded met the
    ///      source and target rules at the time it was made.
    function invariant_noRuleViolations() public view {
        assertEq(handler.ruleViolations(), 0, "a write broke the pause or supersede rules");
    }

    /// @dev Following supersededBy from any batch ends within batchCount() steps: no cycle.
    ///      The longest walk must also equal the handler's ghost, which is built only from the
    ///      supersede calls that succeeded: a link the contract stored differently, or one made
    ///      without a successful call, shows up as a mismatch.
    function invariant_supersedeWalksTerminate() public view {
        bytes32[] memory ids = handler.allBatchIds();
        uint256 count = ids.length;
        uint256 limit = anchor.batchCount();
        uint256 longest;
        for (uint256 i = 0; i < count; i++) {
            bytes32 cur = ids[i];
            uint256 steps;
            while (anchor.getBatch(cur).supersededBy != bytes32(0)) {
                cur = anchor.getBatch(cur).supersededBy;
                steps++;
                assertLe(steps, limit, "supersede walk did not terminate");
            }
            if (steps > longest) longest = steps;
        }
        assertEq(longest, handler.maxChainLength(), "on-chain chains differ from the successful supersedes");
    }

    /// @dev The single admin never changes: no handler path can start or accept a handover.
    ///      The handler's non-admin actors try to begin, accept and grant; `warp` lets a
    ///      scheduled takeover mature. No pending handover may ever appear either.
    function invariant_adminUnchanged() public view {
        assertEq(anchor.defaultAdmin(), address(this));
        (address pending,) = anchor.pendingDefaultAdmin();
        assertEq(pending, address(0), "a non-admin scheduled an admin handover");
        assertEq(anchor.defaultAdminDelay(), 1 days, "admin delay changed");
    }

    /// @dev A submitted root never changes under any call sequence.
    function invariant_rootNeverChanges() public view {
        bytes32[] memory ids = handler.allBatchIds();
        uint256 count = ids.length;
        for (uint256 i = 0; i < count; i++) {
            bytes32 batchId = ids[i];
            IRegistryAnchor.Batch memory batch = anchor.getBatch(batchId);
            assertEq(batch.root, handler.expectedRoot(batchId), "root mutated");
        }
    }

    /// @dev Neither does recordCount.
    function invariant_recordCountNeverChanges() public view {
        bytes32[] memory ids = handler.allBatchIds();
        uint256 count = ids.length;
        for (uint256 i = 0; i < count; i++) {
            bytes32 batchId = ids[i];
            assertEq(anchor.getBatch(batchId).recordCount, handler.expectedRecordCount(batchId), "recordCount mutated");
        }
    }

    /// @dev Batches never disappear. Anything submitted stays queryable forever.
    function invariant_batchesNeverDisappear() public view {
        assertGe(anchor.batchCount(), handler.knownBatchCount(), "batch disappeared");
    }

    /// @dev revoke and supersede are only status flags; they never erase the root.
    function invariant_revokedBatchesRetainRoot() public view {
        bytes32[] memory ids = handler.allBatchIds();
        uint256 count = ids.length;
        for (uint256 i = 0; i < count; i++) {
            bytes32 batchId = ids[i];
            IRegistryAnchor.Batch memory batch = anchor.getBatch(batchId);
            if (batch.revoked || batch.supersededBy != bytes32(0)) {
                assertTrue(batch.root != bytes32(0), "revoke/supersede erased root");
            }
        }
    }

    /// @dev A stored batch always has recordCount >= 1. Empty batches are never anchored.
    function invariant_noEmptyBatchStored() public view {
        bytes32[] memory ids = handler.allBatchIds();
        uint256 count = ids.length;
        for (uint256 i = 0; i < count; i++) {
            assertGt(anchor.getBatch(ids[i]).recordCount, 0);
        }
    }

    /// @dev A batch cannot supersede itself.
    function invariant_noSelfSupersede() public view {
        bytes32[] memory ids = handler.allBatchIds();
        uint256 count = ids.length;
        for (uint256 i = 0; i < count; i++) {
            bytes32 batchId = ids[i];
            assertTrue(anchor.getBatch(batchId).supersededBy != batchId);
        }
    }
}
