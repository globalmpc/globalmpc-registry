// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {IERC165} from "@openzeppelin/contracts/utils/introspection/IERC165.sol";
import {RegistryStatusReceiver, IRegistryStatusReportReceiver} from "../src/RegistryStatusReceiver.sol";

contract LocalStatusForwarder {
    function deliver(RegistryStatusReceiver receiver, bytes memory metadata, bytes memory report) external {
        receiver.onReport(metadata, report);
    }
}

contract RegistryStatusReceiverTest is Test {
    LocalStatusForwarder private forwarder;
    RegistryStatusReceiver private receiver;
    bytes32 private constant WORKFLOW = keccak256("test-workflow");
    address private constant OWNER = address(0xA11CE);
    bytes32 private constant RECORD = keccak256("published-record");
    bytes32 private constant HASH = keccak256("approved-public-content");

    function setUp() public {
        vm.warp(1_800_000_000);
        forwarder = new LocalStatusForwarder();
        receiver = new RegistryStatusReceiver(address(forwarder), WORKFLOW, OWNER, 3600);
    }

    function metadata() private pure returns (bytes memory) {
        return abi.encodePacked(WORKFLOW, bytes10("0123456789"), OWNER, bytes2(0x0001));
    }

    function fresh() private view returns (RegistryStatusReceiver.Report memory) {
        return RegistryStatusReceiver.Report(
            block.chainid,
            address(receiver),
            RECORD,
            1,
            HASH,
            uint64(block.timestamp),
            uint64(block.timestamp + 300),
            1,
            1
        );
    }

    function deliver(RegistryStatusReceiver.Report memory report) private {
        forwarder.deliver(receiver, metadata(), abi.encode(report));
    }

    function testFreshObservationExpiresAtExactTTLAndUnknownFailsClosed() public {
        assertFalse(receiver.isCurrent(RECORD));
        deliver(fresh());
        assertTrue(receiver.isCurrent(RECORD));
        vm.warp(block.timestamp + 300);
        assertFalse(receiver.isCurrent(RECORD));
        assertEq(receiver.getState(RECORD).contentHash, HASH);
    }

    function testRejectsForgedSenderAndWorkflow() public {
        vm.expectRevert(RegistryStatusReceiver.UnauthorizedForwarder.selector);
        receiver.onReport(metadata(), abi.encode(fresh()));
        vm.expectRevert(RegistryStatusReceiver.UnauthorizedWorkflow.selector);
        forwarder.deliver(
            receiver, abi.encodePacked(bytes32(uint256(1)), bytes10(0), OWNER, bytes2(0)), abi.encode(fresh())
        );
        vm.expectRevert(RegistryStatusReceiver.UnauthorizedWorkflow.selector);
        forwarder.deliver(receiver, abi.encodePacked(WORKFLOW, bytes10(0), address(1), bytes2(0)), abi.encode(fresh()));
    }

    function testMetadataAndReportLengthsAreStrict() public {
        vm.expectRevert(RegistryStatusReceiver.InvalidMetadata.selector);
        forwarder.deliver(receiver, abi.encodePacked(WORKFLOW, bytes10(0), OWNER), abi.encode(fresh()));
        vm.expectRevert(RegistryStatusReceiver.InvalidMetadata.selector);
        forwarder.deliver(receiver, "", abi.encode(fresh()));
        vm.expectRevert(RegistryStatusReceiver.InvalidReport.selector);
        forwarder.deliver(receiver, metadata(), bytes.concat(abi.encode(fresh()), hex"00"));
        vm.expectRevert(RegistryStatusReceiver.InvalidReport.selector);
        forwarder.deliver(receiver, metadata(), "");
    }

    function testDestinationBinding() public {
        RegistryStatusReceiver.Report memory report = fresh();
        report.chainId++;
        vm.expectRevert(RegistryStatusReceiver.InvalidDestination.selector);
        deliver(report);
        report = fresh();
        report.receiver = address(1);
        vm.expectRevert(RegistryStatusReceiver.InvalidDestination.selector);
        deliver(report);
    }

    function testReplayAndObservationRollbackRejected() public {
        RegistryStatusReceiver.Report memory report = fresh();
        deliver(report);
        vm.expectRevert(RegistryStatusReceiver.OutOfOrderReport.selector);
        deliver(report);
        report.sequence = 2;
        report.observedAt--;
        vm.expectRevert(RegistryStatusReceiver.OutOfOrderReport.selector);
        deliver(report);
    }

    function testVersionRollbackAndSameVersionHashMutationRejected() public {
        RegistryStatusReceiver.Report memory report = fresh();
        report.registryVersion = 2;
        deliver(report);
        report.sequence = 2;
        report.registryVersion = 1;
        vm.expectRevert(RegistryStatusReceiver.VersionRollback.selector);
        deliver(report);
        report.registryVersion = 2;
        report.contentHash = keccak256("different-content");
        vm.expectRevert(RegistryStatusReceiver.ContentHashConflict.selector);
        deliver(report);
        report.registryVersion = 3;
        deliver(report);
        assertEq(receiver.getState(RECORD).contentHash, report.contentHash);
    }

    function testNegativeStatesImmediatelyReplacePositiveAndDoNotExpireIntoPositive() public {
        RegistryStatusReceiver.Report memory report = fresh();
        deliver(report);
        for (uint8 status = 2; status <= 5; status++) {
            report.sequence++;
            report.status = status;
            deliver(report);
            assertFalse(receiver.isCurrent(RECORD));
            assertEq(receiver.getState(RECORD).status, status);
        }
        vm.warp(report.validUntil);
        assertFalse(receiver.isCurrent(RECORD));
        assertEq(receiver.getState(RECORD).status, 5);
    }

    function testFreshTrustedRecoveryRequiresANewerSequence() public {
        RegistryStatusReceiver.Report memory report = fresh();
        report.status = 2;
        deliver(report);
        report.status = 1;
        vm.expectRevert(RegistryStatusReceiver.OutOfOrderReport.selector);
        deliver(report);
        report.sequence++;
        deliver(report);
        assertTrue(receiver.isCurrent(RECORD));
    }

    function testInvalidReportTimes() public {
        RegistryStatusReceiver.Report memory report = fresh();
        report.observedAt++;
        vm.expectRevert(RegistryStatusReceiver.InvalidReportTime.selector);
        deliver(report);
        report = fresh();
        report.validUntil = uint64(block.timestamp);
        vm.expectRevert(RegistryStatusReceiver.InvalidReportTime.selector);
        deliver(report);
        report.validUntil = uint64(block.timestamp + 3601);
        vm.expectRevert(RegistryStatusReceiver.InvalidReportTime.selector);
        deliver(report);
        report.observedAt = uint64(block.timestamp - 4000);
        report.validUntil = uint64(block.timestamp + 1);
        vm.expectRevert(RegistryStatusReceiver.InvalidReportTime.selector);
        deliver(report);
    }

    function testFuzzRejectsInvalidStatus(uint8 status) public {
        vm.assume(status == 0 || status > 5);
        RegistryStatusReceiver.Report memory report = fresh();
        report.status = status;
        vm.expectRevert(RegistryStatusReceiver.InvalidReport.selector);
        deliver(report);
    }

    function testZeroIdentityFieldsRejected() public {
        RegistryStatusReceiver.Report memory report = fresh();
        report.recordId = bytes32(0);
        vm.expectRevert(RegistryStatusReceiver.InvalidReport.selector);
        deliver(report);
        report = fresh();
        report.contentHash = bytes32(0);
        vm.expectRevert(RegistryStatusReceiver.InvalidReport.selector);
        deliver(report);
        report = fresh();
        report.registryVersion = 0;
        vm.expectRevert(RegistryStatusReceiver.InvalidReport.selector);
        deliver(report);
        report = fresh();
        report.sequence = 0;
        vm.expectRevert(RegistryStatusReceiver.InvalidReport.selector);
        deliver(report);
    }

    function testConfigurationCannotDisableAuthenticationOrTTL() public {
        vm.expectRevert(RegistryStatusReceiver.InvalidConfiguration.selector);
        new RegistryStatusReceiver(address(0), WORKFLOW, OWNER, 3600);
        vm.expectRevert(RegistryStatusReceiver.InvalidConfiguration.selector);
        new RegistryStatusReceiver(address(1), WORKFLOW, OWNER, 3600);
        vm.expectRevert(RegistryStatusReceiver.InvalidConfiguration.selector);
        new RegistryStatusReceiver(address(forwarder), bytes32(0), OWNER, 3600);
        vm.expectRevert(RegistryStatusReceiver.InvalidConfiguration.selector);
        new RegistryStatusReceiver(address(forwarder), WORKFLOW, address(0), 3600);
        vm.expectRevert(RegistryStatusReceiver.InvalidConfiguration.selector);
        new RegistryStatusReceiver(address(forwarder), WORKFLOW, OWNER, 0);
        vm.expectRevert(RegistryStatusReceiver.InvalidConfiguration.selector);
        new RegistryStatusReceiver(address(forwarder), WORKFLOW, OWNER, 86401);
    }

    function testSupportsReceiverAndERC165Only() public view {
        assertTrue(receiver.supportsInterface(type(IRegistryStatusReportReceiver).interfaceId));
        assertTrue(receiver.supportsInterface(type(IERC165).interfaceId));
        assertFalse(receiver.supportsInterface(0xffffffff));
    }

    function testIndependentRecordsKeepSeparateOrderingAndHealth() public {
        RegistryStatusReceiver.Report memory first = fresh();
        first.sequence = 100;
        first.status = 3;
        deliver(first);
        RegistryStatusReceiver.Report memory second = fresh();
        second.recordId = keccak256("another-approved-public-record");
        deliver(second);
        assertFalse(receiver.isCurrent(first.recordId));
        assertTrue(receiver.isCurrent(second.recordId));
        assertEq(receiver.getState(first.recordId).sequence, 100);
        assertEq(receiver.getState(second.recordId).sequence, 1);
    }
}
