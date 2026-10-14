// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Script} from "forge-std/Script.sol";
import {console} from "forge-std/console.sol";
import {RegistryAnchorV1} from "../src/RegistryAnchorV1.sol";

/// @notice RegistryAnchorV1 deployment script.
///
/// @dev **Every role holder is named explicitly.** In prod a Safe multisig holds admin and
///      submitter, and the security response team holds pauser. If one address holds all
///      three, the contract's premise that "not even MPC can change it on its own" does not
///      hold. A fallback to the deployer would turn a forgotten variable into exactly that
///      layout, silently — so a missing or zero role variable stops the deployment instead.
///
///      A single-key layout is still possible on the local chain, but only by naming
///      the deployer address for all three; the script then prints a warning.
///
///      Environment variables:
///      - `ANCHOR_DEPLOYER_KEY` — deployment and signing key
///      - `ANCHOR_ADMIN` / `ANCHOR_SUBMITTER` / `ANCHOR_PAUSER` — role holders, all required.
///        Outside the local chain (31337) `ANCHOR_SUBMITTER` must be a contract (the Safe).
contract DeployRegistryAnchor is Script {
    /// @dev The local development chain (anvil). The only chain where an EOA may hold the
    ///      submitter role.
    uint256 internal constant LOCAL_CHAIN_ID = 31337;

    function run() external returns (RegistryAnchorV1 anchor) {
        uint256 deployerKey = vm.envUint("ANCHOR_DEPLOYER_KEY");

        address admin = requiredRole("ANCHOR_ADMIN");
        address submitter = requiredRole("ANCHOR_SUBMITTER");
        address pauser = requiredRole("ANCHOR_PAUSER");

        anchor = deploy(deployerKey, admin, submitter, pauser);
    }

    /// @dev Off the local chain the submitter must be a contract — the Safe multisig. An EOA
    ///      there lets one key anchor alone, which the worker also refuses; but the role grant
    ///      made here is what the chain enforces, so the script checks it too. A Safe not yet
    ///      deployed at that address has no code and is refused the same way.
    function deploy(uint256 deployerKey, address admin, address submitter, address pauser)
        internal
        returns (RegistryAnchorV1 anchor)
    {
        if (block.chainid != LOCAL_CHAIN_ID) {
            require(
                submitter.code.length > 0,
                "ANCHOR_SUBMITTER must be a contract (the Safe multisig) outside the local chain 31337."
            );
        }

        vm.startBroadcast(deployerKey);
        anchor = new RegistryAnchorV1(admin, submitter, pauser);
        vm.stopBroadcast();

        console.log("RegistryAnchorV1", address(anchor));
        console.log("admin", admin);
        console.log("submitter", submitter);
        console.log("pauser", pauser);

        if (admin == submitter && submitter == pauser) {
            console.log("WARNING: single-key deployment. Local chain only.");
        }
    }

    /// @dev Reads a role holder. Unset and the zero address are both refused: a role granted to
    ///      address(0) is a role nobody holds.
    function requiredRole(string memory name) internal view returns (address holder) {
        holder = vm.envOr(name, address(0));
        if (holder == address(0)) {
            revert(
                string.concat(
                    name,
                    " is required. Name the role holder explicitly; for a local single-key deployment set it to the deployer address."
                )
            );
        }
    }
}
