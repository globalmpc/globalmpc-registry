// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.28;

/// Shared public development addresses refused by public-chain deployment scripts.
abstract contract DevKeyGuard {
    /// @dev Accounts 0–19 of the public anvil/hardhat mnemonic (hardhat's default 20). Mirrors
    ///      `ANVIL_DEV_ADDRESSES` in `packages/config/src/dev-keys.ts`; `DeployRegistryAnchor.t.sol`
    ///      fails if they differ.
    function anvilDevAddresses() internal pure returns (address[] memory list) {
        list = new address[](20);
        list[0] = 0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266;
        list[1] = 0x70997970C51812dc3A010C7d01b50e0d17dc79C8;
        list[2] = 0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC;
        list[3] = 0x90F79bf6EB2c4f870365E785982E1f101E93b906;
        list[4] = 0x15d34AAf54267DB7D7c367839AAf71A00a2C6A65;
        list[5] = 0x9965507D1a55bcC2695C58ba16FB37d819B0A4dc;
        list[6] = 0x976EA74026E726554dB657fA54763abd0C3a0aa9;
        list[7] = 0x14dC79964da2C08b23698B3D3cc7Ca32193d9955;
        list[8] = 0x23618e81E3f5cdF7f54C3d65f7FBc0aBf5B21E8f;
        list[9] = 0xa0Ee7A142d267C1f36714E4a8F75612F20a79720;
        list[10] = 0xBcd4042DE499D14e55001CcbB24a551F3b954096;
        list[11] = 0x71bE63f3384f5fb98995898A86B02Fb2426c5788;
        list[12] = 0xFABB0ac9d68B0B445fB7357272Ff202C5651694a;
        list[13] = 0x1CBd3b2770909D4e10f157cABC84C7264073C9Ec;
        list[14] = 0xdF3e18d64BC6A983f673Ab319CCaE4f1a57C7097;
        list[15] = 0xcd3B766CCDd6AE721141F452C550Ca635964ce71;
        list[16] = 0x2546BcD3c84621e976D8185a91A922aE77ECEc30;
        list[17] = 0xbDA5747bFD65F08deb54cb465eB87D40e51B197E;
        list[18] = 0xdD2FD4581271e230360230F9337D5c0430Bf44C0;
        list[19] = 0x8626f6940E2eb28930eFb4CeF49B2d1F2C9C1199;
    }

    /// @dev Committed fixture keys that are not anvil accounts. Mirrors
    ///      `COMMITTED_FIXTURE_ADDRESSES` in `packages/config/src/dev-keys.ts`, whose own test
    ///      derives that list from the committed key files.
    function committedFixtureAddresses() internal pure returns (address[] memory list) {
        list = new address[](4);
        list[1] = 0x19E7E376E7C213B7E7e7e46cc70A5dD086DAff2A; // repeated-byte 0x11 signing fixture
        list[2] = 0x1563915e194D8CfBA1943570603F7606A3115508; // repeated-byte 0x22 signing fixture
        list[3] = 0xe05fcC23807536bEe418f142D19fa0d21BB0cfF7; // deployment test fixture
        list[0] = 0xDA519e0e438D9836DC7E9Ca61117e43a9773B598; // config/local-secrets/scan_service_key
    }

    function publicDevAddress(address holder) internal pure returns (bool) {
        address[] memory local = anvilDevAddresses();
        for (uint256 i; i < local.length; i++) {
            if (holder == local[i]) return true;
        }
        address[] memory fixtures = committedFixtureAddresses();
        for (uint256 i; i < fixtures.length; i++) {
            if (holder == fixtures[i]) return true;
        }
        return false;
    }
}
