// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.28;

import {Script, console} from "forge-std/Script.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import {RegistryStatusReceiver} from "../src/RegistryStatusReceiver.sol";
import {DevKeyGuard} from "./DevKeyGuard.sol";

contract DeployRegistryStatusReceiver is Script, DevKeyGuard {
    address internal constant BSC_TESTNET_FORWARDER = 0x76c9cf548b4179F8901cda1f8623568b58215E62;

    function run() external returns (RegistryStatusReceiver receiver) {
        uint256 key = vm.envUint("ANCHOR_DEPLOYER_KEY");
        address admin = vm.envAddress("ANCHOR_ADMIN");
        address forwarder = vm.envOr("CRE_FORWARDER", BSC_TESTNET_FORWARDER);
        bytes32 workflowId = vm.envOr("CRE_WORKFLOW_ID", bytes32(0));
        address workflowOwner = vm.envOr("CRE_WORKFLOW_OWNER", address(0));
        uint64 ttl = uint64(vm.envOr("CRE_MAX_REPORT_TTL", uint256(3600)));
        require(vm.envOr("CRE_MAX_REPORT_TTL", uint256(3600)) <= 1 days, "Invalid report TTL");
        return deploy(key, admin, forwarder, workflowId, workflowOwner, ttl);
    }

    function deploy(
        uint256 key,
        address admin,
        address forwarder,
        bytes32 workflowId,
        address workflowOwner,
        uint64 ttl
    ) internal returns (RegistryStatusReceiver receiver) {
        require(
            block.chainid == 97 || block.chainid == 31337,
            "Receiver deployment supports BSC Testnet97 or local31337 only"
        );
        if (block.chainid != 31337) {
            require(!publicDevAddress(vm.addr(key)) && !publicDevAddress(admin), "Public development key refused");
            require(forwarder == BSC_TESTNET_FORWARDER, "Unexpected BSC Testnet forwarder");
        }
        require(
            forwarder.code.length > 0 && admin != address(0) && ttl > 0 && ttl <= 1 days
                && (workflowId == bytes32(0)) == (workflowOwner == address(0)),
            "Invalid receiver configuration"
        );
        vm.startBroadcast(key);
        RegistryStatusReceiver implementation = new RegistryStatusReceiver();
        receiver = RegistryStatusReceiver(
            address(
                new ERC1967Proxy(
                    address(implementation),
                    abi.encodeCall(
                        RegistryStatusReceiver.initialize, (forwarder, workflowId, workflowOwner, ttl, admin)
                    )
                )
            )
        );
        vm.stopBroadcast();
        console.log("Receiver proxy", address(receiver));
        console.log("Implementation", address(implementation));
        console.log("Upgrade owner", admin);
        console.log("Workflow configured", workflowId != bytes32(0));
    }
}
