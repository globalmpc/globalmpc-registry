// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {DeployRegistryAnchor} from "../script/DeployRegistryAnchor.s.sol";
import {RegistryAnchorV1} from "../src/RegistryAnchorV1.sol";

/// @dev Exposes the script's role reader. Each test reads its own variable name: `vm.setEnv`
///      is process-wide, so shared names would let parallel tests see each other's values.
contract DeployRegistryAnchorHarness is DeployRegistryAnchor {
    function roleFromEnv(string memory name) external view returns (address) {
        return requiredRole(name);
    }

    function deployWith(uint256 deployerKey, address admin, address submitter, address pauser)
        external
        returns (RegistryAnchorV1)
    {
        return deploy(deployerKey, admin, submitter, pauser);
    }
}

/// @dev Stands in for a Safe: any address with code.
contract SafeStandIn {}

/// @notice The deployment script names every role holder explicitly.
///
/// @dev A silent fallback to the deployer turns a forgotten variable into a single-key
///      deployment — the one layout under which "not even MPC can change it alone" fails.
contract DeployRegistryAnchorTest is Test {
    DeployRegistryAnchorHarness internal script;

    function setUp() public {
        script = new DeployRegistryAnchorHarness();
    }

    function test_RevertWhen_RoleVariableIsUnset() public {
        vm.expectRevert(bytes(_missing("ANCHOR_TEST_ROLE_NEVER_SET")));
        script.roleFromEnv("ANCHOR_TEST_ROLE_NEVER_SET");
    }

    function test_RevertWhen_RoleVariableIsZeroAddress() public {
        vm.setEnv("ANCHOR_TEST_ROLE_ZERO", vm.toString(address(0)));
        vm.expectRevert(bytes(_missing("ANCHOR_TEST_ROLE_ZERO")));
        script.roleFromEnv("ANCHOR_TEST_ROLE_ZERO");
    }

    function test_ReadsAnExplicitRoleHolder() public {
        vm.setEnv("ANCHOR_TEST_ROLE_SET", vm.toString(address(0xBEEF)));
        assertEq(script.roleFromEnv("ANCHOR_TEST_ROLE_SET"), address(0xBEEF));
    }

    function test_RunGrantsEachRoleToItsNamedHolder() public {
        uint256 deployerKey = 0xA11CE;
        address admin = address(0xA1);
        address submitter = address(0xB2);
        address pauser = address(0xC3);
        vm.setEnv("ANCHOR_DEPLOYER_KEY", vm.toString(bytes32(deployerKey)));
        vm.setEnv("ANCHOR_ADMIN", vm.toString(admin));
        vm.setEnv("ANCHOR_SUBMITTER", vm.toString(submitter));
        vm.setEnv("ANCHOR_PAUSER", vm.toString(pauser));

        RegistryAnchorV1 anchor = script.run();

        assertTrue(anchor.hasRole(anchor.DEFAULT_ADMIN_ROLE(), admin));
        assertTrue(anchor.hasRole(anchor.ANCHOR_SUBMITTER_ROLE(), submitter));
        assertTrue(anchor.hasRole(anchor.PAUSER_ROLE(), pauser));
        // The deployer only pays for the deployment. It holds nothing it was not named for.
        address deployer = vm.addr(deployerKey);
        assertFalse(anchor.hasRole(anchor.DEFAULT_ADMIN_ROLE(), deployer));
        assertFalse(anchor.hasRole(anchor.ANCHOR_SUBMITTER_ROLE(), deployer));
        assertFalse(anchor.hasRole(anchor.PAUSER_ROLE(), deployer));
    }

    /// @dev Off the local chain the submitter must be a contract (the Safe). An EOA submitter
    ///      there means one key anchors alone — the worker refuses that too, but the role grant
    ///      on chain is what decides who can submit.
    function test_RevertWhen_SubmitterIsAnEoaOffTheLocalChain() public {
        vm.chainId(56);
        vm.expectRevert(bytes(SUBMITTER_NOT_CONTRACT));
        script.deployWith(0xA11CE, address(0xA1), address(0xB2), address(0xC3));
    }

    function test_DeploysWithAContractSubmitterOffTheLocalChain() public {
        address safe = address(new SafeStandIn());
        vm.chainId(56);

        RegistryAnchorV1 anchor = script.deployWith(0xA11CE, address(0xA1), safe, address(0xC3));

        assertTrue(anchor.hasRole(anchor.ANCHOR_SUBMITTER_ROLE(), safe));
    }

    function test_DeploysWithAnEoaSubmitterOnTheLocalChain() public {
        vm.chainId(31337);

        RegistryAnchorV1 anchor = script.deployWith(0xA11CE, address(0xA1), address(0xB2), address(0xC3));

        assertTrue(anchor.hasRole(anchor.ANCHOR_SUBMITTER_ROLE(), address(0xB2)));
    }

    string internal constant SUBMITTER_NOT_CONTRACT =
        "ANCHOR_SUBMITTER must be a contract (the Safe multisig) outside the local chain 31337.";

    function _missing(string memory name) private pure returns (string memory) {
        return string.concat(
            name,
            " is required. Name the role holder explicitly; for a local single-key deployment set it to the deployer address."
        );
    }
}
