// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {RegistryAnchorV1} from "../src/RegistryAnchorV1.sol";
import {IRegistryAnchor} from "../src/interfaces/IRegistryAnchor.sol";

/// @notice invariant fuzzing 대상 handler.
/// @dev 임의 순서·임의 인자로 컨트랙트를 두들기되, 제출된 root가 절대 변하지
///      않는다는 것을 확인한다. 13 §13.5의 "Registry root는 overwrite/delete 불가"와
///      "revoked/superseded는 새 event로만 표현"을 기계적으로 검증한다.
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
            // 성공하면 안 된다. invariant가 이것을 잡는다.
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

    /// @dev 제출된 root는 어떤 호출 순서로도 바뀌지 않는다.
    function invariant_rootNeverChanges() public view {
        uint256 count = handler.knownBatchCount();
        for (uint256 i = 0; i < count; i++) {
            bytes32 batchId = handler.knownBatchIds(i);
            IRegistryAnchor.Batch memory batch = anchor.getBatch(batchId);
            assertEq(batch.root, handler.expectedRoot(batchId), "root mutated");
        }
    }

    /// @dev recordCount도 마찬가지다.
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

    /// @dev batch는 사라지지 않는다. 제출된 것은 영구히 조회된다.
    function invariant_batchesNeverDisappear() public view {
        assertGe(anchor.batchCount(), handler.knownBatchCount(), "batch disappeared");
    }

    /// @dev revoke·supersede는 상태 플래그일 뿐 root를 지우지 않는다.
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

    /// @dev 저장된 batch는 recordCount가 항상 1 이상이다. 빈 batch는 anchor되지 않는다.
    function invariant_noEmptyBatchStored() public view {
        uint256 count = handler.knownBatchCount();
        for (uint256 i = 0; i < count; i++) {
            assertGt(anchor.getBatch(handler.knownBatchIds(i)).recordCount, 0);
        }
    }

    /// @dev batch는 자기 자신을 supersede할 수 없다.
    function invariant_noSelfSupersede() public view {
        uint256 count = handler.knownBatchCount();
        for (uint256 i = 0; i < count; i++) {
            bytes32 batchId = handler.knownBatchIds(i);
            assertTrue(anchor.getBatch(batchId).supersededBy != batchId);
        }
    }
}
