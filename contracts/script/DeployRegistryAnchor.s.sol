// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Script} from "forge-std/Script.sol";
import {console} from "forge-std/console.sol";
import {RegistryAnchorV1} from "../src/RegistryAnchorV1.sol";

/// @notice RegistryAnchorV1 배포 스크립트.
///
/// @dev **로컬·테스트넷 전용 배치다.** 세 role을 모두 같은 EOA에 주는 것은
///      개발 편의이며, prod에서는 admin·submitter를 Safe multisig가 갖고 pauser를
///      보안 대응 조직이 갖는다. 한 주소가 셋을 다 가지면 "MPC 자신도 단독으로
///      바꿀 수 없다"는 컨트랙트의 전제가 성립하지 않는다.
///
///      환경변수:
///      - `ANCHOR_DEPLOYER_KEY` — 배포·서명 키
///      - `ANCHOR_ADMIN` / `ANCHOR_SUBMITTER` / `ANCHOR_PAUSER` — 없으면 배포자 주소
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
