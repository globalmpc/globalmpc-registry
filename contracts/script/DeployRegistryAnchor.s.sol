// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Script} from "forge-std/Script.sol";
import {console} from "forge-std/console.sol";
import {RegistryAnchorV1} from "../src/RegistryAnchorV1.sol";

/// @notice RegistryAnchorV1 deployment script.
///
/// @dev **This layout is for local and testnet only.** Giving all three roles to one EOA is a
///      development convenience; in prod a Safe multisig holds admin and submitter, and the
///      security response team holds pauser. If one address holds all three, the contract's
///      premise that "not even MPC can change it on its own" does not hold.
///
///      Environment variables:
///      - `ANCHOR_DEPLOYER_KEY` — deployment and signing key
///      - `ANCHOR_ADMIN` / `ANCHOR_SUBMITTER` / `ANCHOR_PAUSER` — default to the deployer address
contract DeployRegistryAnchor is Script {
    function run() external returns (RegistryAnchorV1 anchor) {
        uint256 deployerKey = vm.envUint("ANCHOR_DEPLOYER_KEY");
        address deployer = vm.addr(deployerKey);

        address admin = vm.envOr("ANCHOR_ADMIN", deployer);
        address submitter = vm.envOr("ANCHOR_SUBMITTER", deployer);
        address pauser = vm.envOr("ANCHOR_PAUSER", deployer);

        vm.startBroadcast(deployerKey);
        anchor = new RegistryAnchorV1(admin, submitter, pauser);
        vm.stopBroadcast();

        console.log("RegistryAnchorV1", address(anchor));
        console.log("admin", admin);
        console.log("submitter", submitter);
        console.log("pauser", pauser);

        if (admin == submitter && submitter == pauser) {
            console.log("WARNING: single-key deployment. Local/testnet only.");
        }
    }
}
