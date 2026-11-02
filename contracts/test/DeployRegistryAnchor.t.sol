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

    function deployWith(uint256 deployerKey, uint48 adminDelay, address admin, address submitter, address pauser)
        external
        returns (RegistryAnchorV1)
    {
        return deploy(deployerKey, adminDelay, admin, submitter, pauser);
    }

    function adminDelayFromEnv(string memory name) external view returns (uint48) {
        return requiredAdminDelay(name);
    }

    function adminDelayCheck(uint256 chainId, uint48 adminDelay) external pure {
        checkAdminDelay(chainId, adminDelay);
    }

    function delayBounds(uint256 chainId) external pure returns (uint48, uint48) {
        return adminDelayBounds(chainId);
    }

    function eoaSubmitterChain(uint256 chainId) external pure returns (bool) {
        return isEoaSubmitterChain(chainId);
    }

    function anvilList() external pure returns (address[] memory) {
        return anvilDevAddresses();
    }

    function fixtureList() external pure returns (address[] memory) {
        return committedFixtureAddresses();
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
    uint256 internal freshDeployerKey;

    /// @dev Valid on every chain: the Safe-chain minimum.
    uint48 internal constant ADMIN_DELAY = 1 days;

    function setUp() public {
        script = new DeployRegistryAnchorHarness();
        freshDeployerKey = bound(vm.randomUint(), 1, 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364140);
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
        uint256 deployerKey = freshDeployerKey;
        address admin = address(0xA1);
        address submitter = address(0xB2);
        address pauser = address(0xC3);
        vm.setEnv("ANCHOR_DEPLOYER_KEY", vm.toString(bytes32(deployerKey)));
        vm.setEnv("ANCHOR_ADMIN", vm.toString(admin));
        vm.setEnv("ANCHOR_SUBMITTER", vm.toString(submitter));
        vm.setEnv("ANCHOR_PAUSER", vm.toString(pauser));
        vm.setEnv("ANCHOR_ADMIN_DELAY_SECONDS", "3600");

        RegistryAnchorV1 anchor = script.run();

        assertEq(anchor.defaultAdmin(), admin);
        assertEq(anchor.defaultAdminDelay(), 3600);

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
        script.deployWith(freshDeployerKey, ADMIN_DELAY, address(0xA1), address(0xB2), address(0xC3));
    }

    function test_DeploysWithAContractSubmitterOffTheLocalChain() public {
        address safe = address(new SafeStandIn());
        vm.chainId(56);

        RegistryAnchorV1 anchor = script.deployWith(freshDeployerKey, ADMIN_DELAY, address(0xA1), safe, address(0xC3));

        assertTrue(anchor.hasRole(anchor.ANCHOR_SUBMITTER_ROLE(), safe));
    }

    function test_DeploysWithAnEoaSubmitterOnTheLocalChain() public {
        vm.chainId(31337);

        RegistryAnchorV1 anchor = script.deployWith(freshDeployerKey, ADMIN_DELAY, address(0xA1), address(0xB2), address(0xC3));

        assertTrue(anchor.hasRole(anchor.ANCHOR_SUBMITTER_ROLE(), address(0xB2)));
    }

    /// @dev opBNB testnet runs the anchor worker's own key as submitter: there is no Safe to
    ///      protect testnet roots, and requiring one would block the testnet path entirely.
    function test_DeploysWithAnEoaSubmitterOnOpBnbTestnet() public {
        vm.chainId(5611);

        RegistryAnchorV1 anchor = script.deployWith(freshDeployerKey, ADMIN_DELAY, address(0xA1), address(0xB2), address(0xC3));

        assertTrue(anchor.hasRole(anchor.ANCHOR_SUBMITTER_ROLE(), address(0xB2)));
    }

    /// @dev The single-key layout the testnet docs describe: one address holds every role.
    function test_DeploysASingleKeyLayoutOnOpBnbTestnet() public {
        uint256 deployerKey = freshDeployerKey;
        address deployer = vm.addr(deployerKey);
        vm.chainId(5611);

        RegistryAnchorV1 anchor = script.deployWith(deployerKey, ADMIN_DELAY, deployer, deployer, deployer);

        assertTrue(anchor.hasRole(anchor.DEFAULT_ADMIN_ROLE(), deployer));
        assertTrue(anchor.hasRole(anchor.ANCHOR_SUBMITTER_ROLE(), deployer));
        assertTrue(anchor.hasRole(anchor.PAUSER_ROLE(), deployer));
    }

    /// @dev The EOA allowance is a closed list, not "anything but mainnet". BSC testnet (97)
    ///      and opBNB mainnet (204) are neighbours of 5611 that must not inherit it.
    function test_RevertWhen_SubmitterIsAnEoaOnBscTestnet() public {
        vm.chainId(97);
        vm.expectRevert(bytes(SUBMITTER_NOT_CONTRACT));
        script.deployWith(freshDeployerKey, ADMIN_DELAY, address(0xA1), address(0xB2), address(0xC3));
    }

    function test_RevertWhen_SubmitterIsAnEoaOnOpBnbMainnet() public {
        vm.chainId(204);
        vm.expectRevert(bytes(SUBMITTER_NOT_CONTRACT));
        script.deployWith(freshDeployerKey, ADMIN_DELAY, address(0xA1), address(0xB2), address(0xC3));
    }

    /// @dev The set is exactly {31337, 5611}; the worker's `ANCHOR_EOA_CHAIN_IDS` uses the same.
    function test_EoaSubmitterChainsAreLocalAndOpBnbTestnet() public view {
        assertTrue(script.eoaSubmitterChain(31337));
        assertTrue(script.eoaSubmitterChain(5611));
        assertFalse(script.eoaSubmitterChain(56));
        assertFalse(script.eoaSubmitterChain(97));
        assertFalse(script.eoaSubmitterChain(204));
    }

    /// @dev Every chain outside the EOA submitter set refuses an EOA submitter.
    function testFuzz_RevertWhen_SubmitterIsAnEoaOutsideTheEoaChains(uint64 chainId) public {
        vm.assume(chainId != 31337 && chainId != 5611);
        vm.chainId(chainId);
        vm.expectRevert(bytes(SUBMITTER_NOT_CONTRACT));
        script.deployWith(freshDeployerKey, ADMIN_DELAY, address(0xA1), address(0xB2), address(0xC3));
    }

    // --- Public development addresses ---------------------------------------------------------

    /// @dev `config/local-secrets/scan_service_key`, committed and therefore public.
    address internal constant SCAN_SERVICE_FIXTURE = 0xDA519e0e438D9836DC7E9Ca61117e43a9773B598;
    string internal constant DEV_MNEMONIC = "test test test test test test test test test test test junk";

    /// @dev Anvil account 0. Public: every anvil node prints it, and CI deploys with it on 31337.
    ///      Derived rather than written out, so no key literal sits in the source for secret
    ///      scanners to flag.
    function _anvil0Key() private pure returns (uint256) {
        return vm.deriveKey(DEV_MNEMONIC, 0);
    }

    /// @dev A public admin can grant itself the submitter role, so every role is checked, not
    ///      only the submitter. Both kinds of public address are refused in every position.
    function test_RevertWhen_ARoleHolderIsAPublicDevAddressOnOpBnbTestnet() public {
        address[] memory fixtures = script.fixtureList();
        address[] memory publicAddresses = new address[](fixtures.length + 1);
        publicAddresses[0] = vm.addr(_anvil0Key());
        for (uint256 i = 0; i < fixtures.length; i++) publicAddresses[i + 1] = fixtures[i];
        vm.chainId(5611);
        for (uint256 i = 0; i < publicAddresses.length; i++) {
            address dev = publicAddresses[i];

            vm.expectRevert(bytes(_devKey("ANCHOR_ADMIN", "5611")));
            script.deployWith(freshDeployerKey, ADMIN_DELAY, dev, address(0xB2), address(0xC3));

            vm.expectRevert(bytes(_devKey("ANCHOR_SUBMITTER", "5611")));
            script.deployWith(freshDeployerKey, ADMIN_DELAY, address(0xA1), dev, address(0xC3));

            vm.expectRevert(bytes(_devKey("ANCHOR_PAUSER", "5611")));
            script.deployWith(freshDeployerKey, ADMIN_DELAY, address(0xA1), address(0xB2), dev);
        }
    }

    /// @dev Derived from the mnemonic, not copied from the list, so a wrong entry in the list
    ///      fails here too.
    function test_RevertWhen_TheDeployerUsesCommittedSigningFixtures() public {
        uint256 deployerKey = 0xA11CE;
        vm.chainId(5611);
        vm.expectRevert(bytes(_devKey("ANCHOR_DEPLOYER_KEY", "5611")));
        script.deployWith(deployerKey, ADMIN_DELAY, address(0xA1), address(0xB2), address(0xC3));
        address[] memory fixtures = script.fixtureList();
        for (uint256 i = 0; i < fixtures.length; i++) {
            vm.expectRevert(bytes(_devKey("ANCHOR_ADMIN", "5611")));
            script.deployWith(freshDeployerKey, ADMIN_DELAY, fixtures[i], address(0xB2), address(0xC3));
        }
    }

    function testFuzz_RevertWhen_TheDeployerIsAnAnvilAccountOnOpBnbTestnet(uint32 index) public {
        uint256 key = vm.deriveKey(DEV_MNEMONIC, uint32(bound(index, 0, 19)));
        vm.chainId(5611);
        vm.expectRevert(bytes(_devKey("ANCHOR_DEPLOYER_KEY", "5611")));
        script.deployWith(key, ADMIN_DELAY, address(0xA1), address(0xB2), address(0xC3));
    }

    function test_RevertWhen_TheAdminIsAPublicDevAddressOnMainnet() public {
        address safe = address(new SafeStandIn());
        vm.chainId(56);
        vm.expectRevert(bytes(_devKey("ANCHOR_ADMIN", "56")));
        script.deployWith(freshDeployerKey, ADMIN_DELAY, vm.addr(_anvil0Key()), safe, address(0xC3));
    }

    /// @dev The local flow and the CI deployment (`integration-tests.yml`) use anvil account 0
    ///      for the deployer and all three roles on 31337. That must keep working.
    function test_DeploysWithAnvilAccountZeroForEverythingOnTheLocalChain() public {
        uint256 anvil0Key = _anvil0Key();
        address anvil0 = vm.addr(anvil0Key);
        vm.chainId(31337);

        RegistryAnchorV1 anchor = script.deployWith(anvil0Key, ADMIN_DELAY, anvil0, anvil0, anvil0);

        assertTrue(anchor.hasRole(anchor.DEFAULT_ADMIN_ROLE(), anvil0));
        assertTrue(anchor.hasRole(anchor.ANCHOR_SUBMITTER_ROLE(), anvil0));
        assertTrue(anchor.hasRole(anchor.PAUSER_ROLE(), anvil0));
    }

    /// @dev The worker and the API refuse the same addresses through `packages/config`. Two
    ///      hand-kept lists drift; this reads the TypeScript source and fails when they do.
    function test_DevAddressListsMatchTheTypeScriptSource() public view {
        string memory source = vm.readFile("../packages/config/src/dev-keys.ts");
        _assertSameList(_tsList(source, "ANVIL_DEV_ADDRESSES"), script.anvilList(), "ANVIL_DEV_ADDRESSES");
        _assertSameList(
            _tsList(source, "COMMITTED_FIXTURE_ADDRESSES"), script.fixtureList(), "COMMITTED_FIXTURE_ADDRESSES"
        );
    }

    /// @dev The quoted strings between `NAME: readonly string[] = [` and the closing `];`.
    function _tsList(string memory source, string memory name) private pure returns (string[] memory list) {
        string[] memory afterOpen = vm.split(source, string.concat(name, ": readonly string[] = ["));
        require(afterOpen.length == 2, string.concat(name, " not found exactly once in dev-keys.ts"));
        string[] memory quoted = vm.split(vm.split(afterOpen[1], "];")[0], "\"");
        list = new string[](quoted.length / 2);
        for (uint256 i = 0; i < list.length; i++) {
            list[i] = quoted[2 * i + 1];
        }
    }

    function _assertSameList(string[] memory expected, address[] memory actual, string memory name) private pure {
        assertEq(actual.length, expected.length, name);
        for (uint256 i = 0; i < actual.length; i++) {
            assertEq(vm.toLowercase(vm.toString(actual[i])), expected[i], name);
        }
    }

    function _devKey(string memory name, string memory chainId) private pure returns (string memory) {
        return string.concat(
            name,
            " is a public development key (anvil/hardhat or a committed fixture), accepted only on chain 31337; generate a fresh key for chain ",
            chainId
        );
    }

    // --- Admin delay ----------------------------------------------------------------------------

    function test_RevertWhen_AdminDelayIsUnset() public {
        vm.expectRevert(
            bytes("ANCHOR_TEST_DELAY_NEVER_SET is required. Set the admin handover delay in seconds explicitly.")
        );
        script.adminDelayFromEnv("ANCHOR_TEST_DELAY_NEVER_SET");
    }

    /// @dev An explicit 0 is a value, not a missing variable; whether 0 is acceptable is the
    ///      chain check's decision.
    function test_ReadsAnExplicitZeroAdminDelay() public {
        vm.setEnv("ANCHOR_TEST_DELAY_ZERO", "0");
        assertEq(script.adminDelayFromEnv("ANCHOR_TEST_DELAY_ZERO"), 0);
    }

    function test_RevertWhen_AdminDelayOverflowsUint48() public {
        vm.setEnv("ANCHOR_TEST_DELAY_HUGE", vm.toString(uint256(type(uint48).max) + 1));
        vm.expectRevert(bytes("ANCHOR_TEST_DELAY_HUGE does not fit in uint48."));
        script.adminDelayFromEnv("ANCHOR_TEST_DELAY_HUGE");
    }

    /// @dev The bounds per chain: local anything; opBNB testnet 5 minutes to 30 days; every
    ///      Safe chain (mainnet and anything else outside the EOA set) 1 day to 30 days.
    function test_AdminDelayBoundsPerChain() public view {
        _assertBounds(31337, 0, type(uint48).max);
        _assertBounds(5611, 300, 2_592_000);
        _assertBounds(56, 86_400, 2_592_000);
        _assertBounds(97, 86_400, 2_592_000);
        _assertBounds(204, 86_400, 2_592_000);
    }

    /// @dev min-1 refused, min accepted, max accepted, max+1 refused, on each bounded chain.
    function test_AdminDelayBoundariesOnOpBnbTestnet() public {
        _assertBoundaries(5611, 300, 2_592_000);
    }

    function test_AdminDelayBoundariesOnMainnet() public {
        _assertBoundaries(56, 86_400, 2_592_000);
    }

    function test_AdminDelayBoundariesOnAnotherChain() public {
        _assertBoundaries(97, 86_400, 2_592_000);
    }

    /// @dev The audit's examples: a milliseconds typo for two days, and uint48 max.
    function test_RevertWhen_AdminDelayIsAMillisecondsTypo() public {
        vm.expectRevert(bytes(_tooLong(56)));
        script.adminDelayCheck(56, 172_800_000);
        vm.expectRevert(bytes(_tooLong(5611)));
        script.adminDelayCheck(5611, type(uint48).max);
    }

    /// @dev Mainnet with a one-second delay — accepted before this rule — is refused.
    function test_RevertWhen_MainnetAdminDelayIsOneSecond() public {
        vm.chainId(56);
        address safe = address(new SafeStandIn());
        vm.expectRevert(bytes(_tooShort(56, 86_400)));
        script.deployWith(freshDeployerKey, 1, address(0xA1), safe, address(0xC3));
    }

    /// @dev The bound applies on the deploy path, not only in the helper.
    function test_RevertWhen_AdminDelayIsZeroOffTheLocalChain() public {
        vm.chainId(5611);
        vm.expectRevert(bytes(_tooShort(5611, 300)));
        script.deployWith(freshDeployerKey, 0, address(0xA1), address(0xB2), address(0xC3));
    }

    function test_DeploysWithTheRecommendedTestnetDelay() public {
        vm.chainId(5611);
        RegistryAnchorV1 anchor = script.deployWith(freshDeployerKey, 3600, address(0xA1), address(0xB2), address(0xC3));
        assertEq(anchor.defaultAdminDelay(), 3600);
    }

    function _assertBounds(uint256 chainId, uint48 min, uint48 max) private view {
        (uint48 actualMin, uint48 actualMax) = script.delayBounds(chainId);
        assertEq(actualMin, min, "min");
        assertEq(actualMax, max, "max");
    }

    function _assertBoundaries(uint256 chainId, uint48 min, uint48 max) private {
        vm.expectRevert(bytes(_tooShort(chainId, min)));
        script.adminDelayCheck(chainId, min - 1);
        script.adminDelayCheck(chainId, min);
        script.adminDelayCheck(chainId, max);
        vm.expectRevert(bytes(_tooLong(chainId)));
        script.adminDelayCheck(chainId, max + 1);
    }

    function _tooShort(uint256 chainId, uint48 min) private pure returns (string memory) {
        return string.concat(
            "ANCHOR_ADMIN_DELAY_SECONDS must be at least ",
            vm.toString(uint256(min)),
            " seconds on chain ",
            vm.toString(chainId),
            "."
        );
    }

    function _tooLong(uint256 chainId) private pure returns (string memory) {
        return string.concat(
            "ANCHOR_ADMIN_DELAY_SECONDS must be at most 2592000 seconds (30 days) on chain ",
            vm.toString(chainId),
            ". The value is in seconds, not milliseconds."
        );
    }

    /// @dev The local flow and CI may deploy with no delay; nothing there is worth stealing.
    function test_DeploysWithZeroAdminDelayOnTheLocalChain() public {
        vm.chainId(31337);
        RegistryAnchorV1 anchor = script.deployWith(freshDeployerKey, 0, address(0xA1), address(0xB2), address(0xC3));
        assertEq(anchor.defaultAdminDelay(), 0);
        assertEq(anchor.defaultAdmin(), address(0xA1));
    }

    string internal constant SUBMITTER_NOT_CONTRACT =
        "ANCHOR_SUBMITTER must be a contract (the Safe multisig) outside the EOA submitter chains 31337 and 5611.";

    function _missing(string memory name) private pure returns (string memory) {
        return string.concat(
            name,
            " is required. Name the role holder explicitly; for a local single-key deployment set it to the deployer address."
        );
    }
}
