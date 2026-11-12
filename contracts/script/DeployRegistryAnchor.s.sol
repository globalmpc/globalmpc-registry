// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {DevKeyGuard} from "./DevKeyGuard.sol";
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
///      A single-key layout is still possible on the EOA submitter chains (local and opBNB
///      testnet), but only by naming the deployer address for all three; the script then
///      prints a warning.
///
///      Environment variables:
///      - `ANCHOR_DEPLOYER_KEY` — deployment and signing key
///      - `ANCHOR_ADMIN` / `ANCHOR_SUBMITTER` / `ANCHOR_PAUSER` — role holders, all required.
///        Outside the EOA submitter chains (31337, 5611) `ANCHOR_SUBMITTER` must be a contract
///        (the Safe).
///      Outside the local chain (31337) no role holder and no deployer may be a public
///      development address (anvil/hardhat accounts or a committed fixture).
///      - `ANCHOR_ADMIN_DELAY_SECONDS` — required, no default. How long an admin handover or
///        renounce must wait (`AccessControlDefaultAdminRules`). Bounded per chain; see
///        `adminDelayBounds`.
contract DeployRegistryAnchor is Script, DevKeyGuard {
    /// @dev The local development chain (anvil).
    uint256 internal constant LOCAL_CHAIN_ID = 31337;

    /// @dev opBNB testnet. Its roots prove nothing anyone relies on, and the worker anchors
    ///      there with its own EOA, so a Safe would add cost without protecting anything.
    uint256 internal constant OPBNB_TESTNET_CHAIN_ID = 5611;

    uint48 internal constant MIN_ADMIN_DELAY_SAFE_CHAIN = 1 days;
    uint48 internal constant MIN_ADMIN_DELAY_OPBNB_TESTNET = 5 minutes;
    uint48 internal constant MAX_ADMIN_DELAY = 30 days;

    function run() external returns (RegistryAnchorV1 anchor) {
        uint256 deployerKey = vm.envUint("ANCHOR_DEPLOYER_KEY");

        address admin = requiredRole("ANCHOR_ADMIN");
        address submitter = requiredRole("ANCHOR_SUBMITTER");
        address pauser = requiredRole("ANCHOR_PAUSER");
        uint48 adminDelay = requiredAdminDelay("ANCHOR_ADMIN_DELAY_SECONDS");

        anchor = deploy(deployerKey, adminDelay, admin, submitter, pauser);
    }

    /// @dev Off the EOA submitter chains the submitter must be a contract — the Safe multisig.
    ///      An EOA there lets one key anchor alone, which the worker also refuses; but the role
    ///      grant made here is what the chain enforces, so the script checks it too. A Safe not
    ///      yet deployed at that address has no code and is refused the same way.
    ///
    ///      The admin delay must lie within `adminDelayBounds` for the chain.
    function deploy(uint256 deployerKey, uint48 adminDelay, address admin, address submitter, address pauser)
        internal
        returns (RegistryAnchorV1 anchor)
    {
        checkAdminDelay(block.chainid, adminDelay);

        if (block.chainid != LOCAL_CHAIN_ID) {
            refuseDevAddress("ANCHOR_DEPLOYER_KEY", vm.addr(deployerKey));
            refuseDevAddress("ANCHOR_ADMIN", admin);
            refuseDevAddress("ANCHOR_SUBMITTER", submitter);
            refuseDevAddress("ANCHOR_PAUSER", pauser);
        }

        if (!isEoaSubmitterChain(block.chainid)) {
            require(
                submitter.code.length > 0,
                "ANCHOR_SUBMITTER must be a contract (the Safe multisig) outside the EOA submitter chains 31337 and 5611."
            );
        }

        vm.startBroadcast(deployerKey);
        anchor = new RegistryAnchorV1(adminDelay, admin, submitter, pauser);
        vm.stopBroadcast();

        console.log("RegistryAnchorV1", address(anchor));
        console.log("admin", admin);
        console.log("submitter", submitter);
        console.log("pauser", pauser);
        console.log("admin delay (s)", uint256(adminDelay));

        if (admin == submitter && submitter == pauser) {
            console.log("WARNING: single-key deployment. Local chain or opBNB testnet only.");
        }
    }

    /// @dev The chains where an EOA may hold the submitter role. A closed list rather than
    ///      "not mainnet": a chain added later, test or not, gets the Safe requirement until
    ///      someone decides otherwise here. Mirrors `ANCHOR_EOA_CHAIN_IDS` in the worker.
    function isEoaSubmitterChain(uint256 chainId) internal pure returns (bool) {
        return chainId == LOCAL_CHAIN_ID || chainId == OPBNB_TESTNET_CHAIN_ID;
    }

    /// @dev A public key on a shared chain belongs to whoever uses it first. A public admin can
    ///      grant itself the submitter role, so the check covers every role, not only the
    ///      submitter, and the deployer too: its funds and nonce are equally up for grabs. The
    ///      message names the variable, never the key.
    function refuseDevAddress(string memory name, address holder) internal view {
        if (isPublicDevAddress(holder)) {
            revert(
                string.concat(
                    name,
                    " is a public development key (anvil/hardhat or a committed fixture), accepted only on chain 31337; generate a fresh key for chain ",
                    vm.toString(block.chainid)
                )
            );
        }
    }

    function isPublicDevAddress(address holder) internal pure returns (bool) {
        return publicDevAddress(holder);
    }

    /// @dev Admin delay bounds in seconds, by chain.
    ///
    ///      - Minimum: the window in which the current admin sees an unwanted handover and
    ///        cancels it. On a Safe chain (mainnet and every chain outside the EOA set) that is
    ///        a day, so the signers can gather. On opBNB testnet five minutes still lets a
    ///        mistaken handover be cancelled without slowing rehearsals; 3600 is recommended.
    ///        On the local chain anything goes, including 0.
    ///      - Maximum, everywhere but local: 30 days. The delay is also how long a legitimate
    ///        handover takes, and shortening it later waits for the difference between the old
    ///        and new delay (OpenZeppelin `_delayChangeWait`). A milliseconds typo — 172800000
    ///        for two days — would freeze handovers for about 5.5 years with no quick way back,
    ///        and values near uint48 max overflow the handover schedule outright.
    function adminDelayBounds(uint256 chainId) internal pure returns (uint48 min, uint48 max) {
        if (chainId == LOCAL_CHAIN_ID) return (0, type(uint48).max);
        max = MAX_ADMIN_DELAY;
        min = chainId == OPBNB_TESTNET_CHAIN_ID ? MIN_ADMIN_DELAY_OPBNB_TESTNET : MIN_ADMIN_DELAY_SAFE_CHAIN;
    }

    function checkAdminDelay(uint256 chainId, uint48 adminDelay) internal pure {
        (uint48 min, uint48 max) = adminDelayBounds(chainId);
        if (adminDelay < min) {
            revert(
                string.concat(
                    "ANCHOR_ADMIN_DELAY_SECONDS must be at least ",
                    vm.toString(uint256(min)),
                    " seconds on chain ",
                    vm.toString(chainId),
                    "."
                )
            );
        }
        if (adminDelay > max) {
            revert(
                string.concat(
                    "ANCHOR_ADMIN_DELAY_SECONDS must be at most ",
                    vm.toString(uint256(max)),
                    " seconds (30 days) on chain ",
                    vm.toString(chainId),
                    ". The value is in seconds, not milliseconds."
                )
            );
        }
    }

    /// @dev Reads the admin delay. No default: the right value differs by orders of magnitude
    ///      between a rehearsal and mainnet, and a silent default would pick one for the operator.
    function requiredAdminDelay(string memory name) internal view returns (uint48) {
        if (!vm.envExists(name)) {
            revert(string.concat(name, " is required. Set the admin handover delay in seconds explicitly."));
        }
        uint256 value = vm.envUint(name);
        require(value <= type(uint48).max, string.concat(name, " does not fit in uint48."));
        // forge-lint: disable-next-line(unsafe-typecast)
        return uint48(value);
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
