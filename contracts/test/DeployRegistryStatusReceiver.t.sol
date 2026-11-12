// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.28;
import {Test} from "forge-std/Test.sol";
import {DeployRegistryStatusReceiver} from "../script/DeployRegistryStatusReceiver.s.sol";
import {RegistryStatusReceiver} from "../src/RegistryStatusReceiver.sol";
import {LocalStatusForwarder} from "./RegistryStatusReceiver.t.sol";

contract ReceiverDeployHarness is DeployRegistryStatusReceiver {
    function exercise(uint256 key, address admin, address forwarder) external returns (RegistryStatusReceiver) {
        return deploy(key, admin, forwarder, bytes32(0), address(0), 3600);
    }
}

contract DeployRegistryStatusReceiverTest is Test {
    ReceiverDeployHarness private harness;
    address private constant FORWARDER = 0x76c9cf548b4179F8901cda1f8623568b58215E62;

    function setUp() public {
        harness = new ReceiverDeployHarness();
    }

    function testRefusesAccidentalOpBNBAndMainnetDeployment() public {
        vm.chainId(5611);
        vm.expectRevert("Receiver deployment supports BSC Testnet97 or local31337 only");
        harness.exercise(1, address(this), address(this));
        vm.chainId(56);
        vm.expectRevert("Receiver deployment supports BSC Testnet97 or local31337 only");
        harness.exercise(1, address(this), address(this));
    }

    function testBSCRequiresOfficialCodeBearingForwarderAndNonPublicKeys() public {
        vm.chainId(97);
        (address signer, uint256 key) = makeAddrAndKey("receiver-bsc-deployer");
        vm.deal(signer, 1 ether);
        vm.expectRevert("Unexpected BSC Testnet forwarder");
        harness.exercise(key, address(this), address(this));
        vm.expectRevert("Public development key refused");
        harness.exercise(key, 0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266, FORWARDER);
        vm.expectRevert("Invalid receiver configuration");
        harness.exercise(key, address(this), FORWARDER);
        LocalStatusForwarder local = new LocalStatusForwarder();
        vm.etch(FORWARDER, address(local).code);
        RegistryStatusReceiver receiver = harness.exercise(key, address(this), FORWARDER);
        assertEq(receiver.owner(), address(this));
        assertEq(receiver.trustedForwarder(), FORWARDER);
        assertEq(receiver.expectedWorkflowId(), bytes32(0));
    }
}
