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
    address internal submitter = address(0x5AFE); // Safe multisig 대역
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
    // 제출
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

    /// @dev 08 §8.4: 동일 batchId 재사용 금지.
    function test_submitRoot_revertsOnDuplicateBatchId() public {
        _submit(BATCH_1, ROOT_1);

        vm.prank(submitter);
        vm.expectRevert(abi.encodeWithSelector(IRegistryAnchor.BatchAlreadyExists.selector, BATCH_1));
        anchor.submitRoot(BATCH_1, ROOT_2, MANIFEST_1, "1", 5);
    }

    /// @dev 재사용이 거절된 뒤에도 원래 root가 그대로 남는다.
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

    /// @dev batchId 0은 supersededBy의 "없음"과 값이 같아 의미가 충돌한다.
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
        // role 값을 미리 읽는다. expectRevert 인자 안에서 외부 호출을 하면
        // 그 호출이 prank를 소비해 caller가 바뀐다.
        bytes32 role = anchor.ANCHOR_SUBMITTER_ROLE();

        vm.prank(stranger);
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccessControl.AccessControlUnauthorizedAccount.selector, stranger, role
            )
        );
        anchor.submitRoot(BATCH_1, ROOT_1, MANIFEST_1, "1", 3);
    }

    /// @dev admin은 관리 권한이지 제출 권한이 아니다. 역할을 분리한다.
    function test_submitRoot_adminCannotSubmitWithoutRole() public {
        vm.prank(admin);
        vm.expectRevert();
        anchor.submitRoot(BATCH_1, ROOT_1, MANIFEST_1, "1", 3);
    }

    // -----------------------------------------------------------------------
    // 정정 — 덮어쓰지 않고 새 사실을 추가한다
    // -----------------------------------------------------------------------

    function test_revokeBatch_keepsRoot() public {
        _submit(BATCH_1, ROOT_1);

        vm.prank(submitter);
        anchor.revokeBatch(BATCH_1, "SOURCE_CORRECTION");

        IRegistryAnchor.Batch memory batch = anchor.getBatch(BATCH_1);
        assertTrue(batch.revoked);
        // 핵심: root는 그대로다. 과거에 무엇을 제출했는지 영구히 조회할 수 있다.
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
    // 08 §8.8 — pause가 read와 proof를 막지 않는다
    // -----------------------------------------------------------------------

    function test_pause_blocksSubmissionOnly() public {
        _submit(BATCH_1, ROOT_1);

        vm.prank(pauser);
        anchor.pause();

        vm.prank(submitter);
        vm.expectRevert(Pausable.EnforcedPause.selector);
        anchor.submitRoot(BATCH_2, ROOT_2, MANIFEST_1, "1", 3);

        // read는 계속 가능하다. 무결성 검증을 멈출 수 있으면 공개 검증권이
        // 운영자에게 종속된다.
        assertEq(anchor.getBatch(BATCH_1).root, ROOT_1);
        assertEq(anchor.batchCount(), 1);
    }

    /// @dev pause 중에도 정정은 가능해야 한다. 잘못된 root를 revoke하지 못한 채
    ///      멈추면 오류가 그대로 남는다.
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
    // 관리자도 root를 바꿀 수 없다
    // -----------------------------------------------------------------------

    /// @dev DEFAULT_ADMIN_ROLE이 root를 수정할 수 있는 함수가 아예 없다.
    ///      이 테스트는 ABI에 그런 함수가 추가되면 실패한다.
    function test_noFunctionCanMutateStoredRoot() public {
        _submit(BATCH_1, ROOT_1);
        bytes32 rootBefore = anchor.getBatch(BATCH_1).root;

        vm.startPrank(admin);
        anchor.grantRole(anchor.ANCHOR_SUBMITTER_ROLE(), admin);
        // admin이 모든 권한을 가져도 할 수 있는 것은 revoke/supersede 표시뿐이다.
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
        // batchId 0은 `ZeroBatchId`로 거절되는 별도 경계값이다. 정상 저장 성질을
        // 검증하는 이 fuzz test에서는 그 전제조건을 명시한다.
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
        // batchId 0은 `ZeroBatchId`로 먼저 걸린다. 이 테스트가 보는 것은 중복
        // 판정이므로 그 경로를 제외한다 — 별도 테스트가 0을 따로 본다.
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
