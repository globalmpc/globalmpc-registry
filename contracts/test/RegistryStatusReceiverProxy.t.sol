// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import {OwnableUpgradeable} from "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";
import {Initializable} from "@openzeppelin/contracts/proxy/utils/Initializable.sol";
import {RegistryStatusReceiver} from "../src/RegistryStatusReceiver.sol";
import {LocalStatusForwarder} from "./RegistryStatusReceiver.t.sol";

contract RegistryStatusReceiverNext is RegistryStatusReceiver {
    function implementationVersion() external pure returns (uint256) {
        return 2;
    }
}

contract RegistryStatusReceiverProxyTest is Test {
    RegistryStatusReceiver private implementation;
    RegistryStatusReceiver private receiver;
    LocalStatusForwarder private forwarder;
    bytes32 private constant WORKFLOW = keccak256("registered-workflow");
    address private constant WORKFLOW_OWNER = address(0xB0B);
    bytes32 private constant RECORD = keccak256("published-project");
    bytes32 private constant CONTENT = keccak256("approved-version");

    function setUp() public {
        vm.warp(1_800_000_000);
        implementation = new RegistryStatusReceiver();
        forwarder = new LocalStatusForwarder();
        receiver = RegistryStatusReceiver(
            address(
                new ERC1967Proxy(
                    address(implementation),
                    abi.encodeCall(
                        RegistryStatusReceiver.initialize,
                        (address(forwarder), bytes32(0), address(0), uint64(3600), address(this))
                    )
                )
            )
        );
    }

    function report(address destination, uint64 sequence) private view returns (RegistryStatusReceiver.Report memory) {
        return RegistryStatusReceiver.Report(
            block.chainid,
            destination,
            RECORD,
            1,
            CONTENT,
            uint64(block.timestamp),
            uint64(block.timestamp + 300),
            sequence,
            1
        );
    }

    function metadata(bytes32 id, address owner) private pure returns (bytes memory) {
        return abi.encodePacked(id, bytes10("registered"), owner, bytes2(0x0001));
    }

    function testImplementationAndProxyCannotBeInitializedAgain() public {
        vm.expectRevert(Initializable.InvalidInitialization.selector);
        implementation.initialize(address(forwarder), WORKFLOW, WORKFLOW_OWNER, 3600, address(this));
        vm.expectRevert(Initializable.InvalidInitialization.selector);
        receiver.initialize(address(forwarder), WORKFLOW, WORKFLOW_OWNER, 3600, address(this));
    }

    function testBootstrapIsClosedEvenForZeroWorkflowMetadata() public {
        assertEq(receiver.owner(), address(this));
        vm.expectRevert(RegistryStatusReceiver.UnauthorizedWorkflow.selector);
        forwarder.deliver(receiver, metadata(bytes32(0), address(0)), abi.encode(report(address(receiver), 1)));
        vm.expectRevert(RegistryStatusReceiver.UnauthorizedWorkflow.selector);
        forwarder.deliver(receiver, metadata(WORKFLOW, WORKFLOW_OWNER), abi.encode(report(address(receiver), 1)));
        assertEq(receiver.getState(RECORD).sequence, 0);
    }

    function testOnlyOwnerCanBindARegisteredWorkflow() public {
        vm.prank(address(0xBAD));
        vm.expectRevert(abi.encodeWithSelector(OwnableUpgradeable.OwnableUnauthorizedAccount.selector, address(0xBAD)));
        receiver.configureWorkflow(WORKFLOW, WORKFLOW_OWNER);
        receiver.configureWorkflow(WORKFLOW, WORKFLOW_OWNER);
        forwarder.deliver(receiver, metadata(WORKFLOW, WORKFLOW_OWNER), abi.encode(report(address(receiver), 1)));
        assertTrue(receiver.isCurrent(RECORD));
        vm.expectRevert(RegistryStatusReceiver.InvalidConfiguration.selector);
        receiver.configureWorkflow(bytes32(0), WORKFLOW_OWNER);
        vm.expectRevert(RegistryStatusReceiver.InvalidConfiguration.selector);
        receiver.configureWorkflow(WORKFLOW, address(0));
    }

    function testSignedDestinationMustBeProxyNotImplementation() public {
        receiver.configureWorkflow(WORKFLOW, WORKFLOW_OWNER);
        vm.expectRevert(RegistryStatusReceiver.InvalidDestination.selector);
        forwarder.deliver(receiver, metadata(WORKFLOW, WORKFLOW_OWNER), abi.encode(report(address(implementation), 1)));
    }

    function testUpgradePreservesConfigurationReportsAndReplayProtection() public {
        receiver.configureWorkflow(WORKFLOW, WORKFLOW_OWNER);
        forwarder.deliver(receiver, metadata(WORKFLOW, WORKFLOW_OWNER), abi.encode(report(address(receiver), 1)));
        RegistryStatusReceiverNext next = new RegistryStatusReceiverNext();
        receiver.upgradeToAndCall(address(next), "");
        assertEq(RegistryStatusReceiverNext(address(receiver)).implementationVersion(), 2);
        assertEq(receiver.owner(), address(this));
        assertEq(receiver.trustedForwarder(), address(forwarder));
        assertEq(receiver.expectedWorkflowId(), WORKFLOW);
        assertEq(receiver.expectedWorkflowOwner(), WORKFLOW_OWNER);
        assertEq(receiver.maxReportTTL(), 3600);
        assertEq(receiver.getState(RECORD).contentHash, CONTENT);
        assertEq(receiver.getState(RECORD).sequence, 1);
        vm.expectRevert(RegistryStatusReceiver.OutOfOrderReport.selector);
        forwarder.deliver(receiver, metadata(WORKFLOW, WORKFLOW_OWNER), abi.encode(report(address(receiver), 1)));
        forwarder.deliver(receiver, metadata(WORKFLOW, WORKFLOW_OWNER), abi.encode(report(address(receiver), 2)));
        assertEq(receiver.getState(RECORD).sequence, 2);
    }

    function testUnrelatedAccountCannotUpgradeOrAcceptOwnership() public {
        RegistryStatusReceiverNext next = new RegistryStatusReceiverNext();
        vm.prank(address(0xBAD));
        vm.expectRevert(abi.encodeWithSelector(OwnableUpgradeable.OwnableUnauthorizedAccount.selector, address(0xBAD)));
        receiver.upgradeToAndCall(address(next), "");
        vm.prank(address(0xBAD));
        vm.expectRevert();
        receiver.acceptOwnership();
    }

    function testOwnerHandoverIsTwoStepAndMovesUpgradeAuthority() public {
        address successor = address(0xA11CE);
        receiver.transferOwnership(successor);
        assertEq(receiver.owner(), address(this));
        vm.prank(successor);
        receiver.acceptOwnership();
        assertEq(receiver.owner(), successor);
        vm.expectRevert(abi.encodeWithSelector(OwnableUpgradeable.OwnableUnauthorizedAccount.selector, address(this)));
        receiver.configureWorkflow(WORKFLOW, WORKFLOW_OWNER);
        vm.prank(successor);
        receiver.configureWorkflow(WORKFLOW, WORKFLOW_OWNER);
        RegistryStatusReceiverNext next = new RegistryStatusReceiverNext();
        vm.prank(successor);
        receiver.upgradeToAndCall(address(next), "");
        assertEq(RegistryStatusReceiverNext(address(receiver)).implementationVersion(), 2);
    }

    function testWorkflowRotationRetainsHistoryAndRejectsPreviousIdentity() public {
        receiver.configureWorkflow(WORKFLOW, WORKFLOW_OWNER);
        forwarder.deliver(receiver, metadata(WORKFLOW, WORKFLOW_OWNER), abi.encode(report(address(receiver), 1)));
        receiver.configureWorkflow(bytes32(uint256(2)), address(0xA11CE));
        vm.expectRevert(RegistryStatusReceiver.UnauthorizedWorkflow.selector);
        forwarder.deliver(receiver, metadata(WORKFLOW, WORKFLOW_OWNER), abi.encode(report(address(receiver), 2)));
        assertEq(receiver.getState(RECORD).sequence, 1);
        forwarder.deliver(
            receiver, metadata(bytes32(uint256(2)), address(0xA11CE)), abi.encode(report(address(receiver), 2))
        );
    }

    function testInvalidOwnerAndNonUUPSUpgradeAreRejected() public {
        vm.expectRevert(RegistryStatusReceiver.InvalidConfiguration.selector);
        new ERC1967Proxy(
            address(implementation),
            abi.encodeCall(
                RegistryStatusReceiver.initialize,
                (address(forwarder), WORKFLOW, WORKFLOW_OWNER, uint64(3600), address(0))
            )
        );
        vm.expectRevert();
        receiver.upgradeToAndCall(address(forwarder), "");
        assertEq(receiver.owner(), address(this));
    }
}
