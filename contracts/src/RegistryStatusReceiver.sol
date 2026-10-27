// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.28;

import {IERC165} from "@openzeppelin/contracts/utils/introspection/IERC165.sol";

interface IRegistryStatusReportReceiver {
    function onReport(bytes calldata metadata, bytes calldata report) external;
}

/// @notice Experimental read-only status mirror, not an approval or an anchor verifier.
/// @dev The pinned forwarder authenticates DON reports; this contract additionally binds
/// workflow identity, destination, time and ordering. No existing anchor state is touched.
contract RegistryStatusReceiver is IRegistryStatusReportReceiver, IERC165 {
    uint8 public constant CURRENT = 1;
    uint8 public constant NEEDS_RE_REVIEW = 2;
    uint8 public constant REVOKED = 3;
    uint8 public constant EXPIRED = 4;
    uint8 public constant UNAVAILABLE = 5;

    struct Report {
        uint256 chainId;
        address receiver;
        bytes32 recordId;
        uint64 registryVersion;
        bytes32 contentHash;
        uint64 observedAt;
        uint64 validUntil;
        uint64 sequence;
        uint8 status;
    }

    address public immutable trustedForwarder;
    bytes32 public immutable expectedWorkflowId;
    address public immutable expectedWorkflowOwner;
    uint64 public immutable maxReportTTL;
    mapping(bytes32 recordId => Report state) private _states;

    error InvalidConfiguration();
    error UnauthorizedForwarder();
    error InvalidMetadata();
    error UnauthorizedWorkflow();
    error InvalidReport();
    error InvalidDestination();
    error InvalidReportTime();
    error OutOfOrderReport();
    error VersionRollback();
    error ContentHashConflict();

    event StatusObserved(
        bytes32 indexed recordId,
        uint64 registryVersion,
        bytes32 contentHash,
        uint64 sequence,
        uint8 status,
        uint64 observedAt,
        uint64 validUntil
    );

    constructor(address forwarder, bytes32 workflowId, address workflowOwner, uint64 maxTTL) {
        if (
            forwarder == address(0) || forwarder.code.length == 0 || workflowId == bytes32(0)
                || workflowOwner == address(0) || maxTTL == 0 || maxTTL > 1 days
        ) revert InvalidConfiguration();
        trustedForwarder = forwarder;
        expectedWorkflowId = workflowId;
        expectedWorkflowOwner = workflowOwner;
        maxReportTTL = maxTTL;
    }

    /// @dev Production KeystoneForwarder metadata has the packed 62-byte identity
    /// followed by a two-byte report ID. Empty simulation metadata is intentionally rejected.
    function onReport(bytes calldata metadata, bytes calldata report) external override {
        if (msg.sender != trustedForwarder) revert UnauthorizedForwarder();
        if (metadata.length != 64) revert InvalidMetadata();
        bytes32 workflowId;
        address workflowOwner;
        assembly {
            workflowId := calldataload(metadata.offset)
            workflowOwner := shr(96, calldataload(add(metadata.offset, 42)))
        }
        if (workflowId != expectedWorkflowId || workflowOwner != expectedWorkflowOwner) {
            revert UnauthorizedWorkflow();
        }
        // A static nine-word ABI keeps extra or truncated payloads from being silently accepted.
        if (report.length != 9 * 32) revert InvalidReport();
        Report memory next = abi.decode(report, (Report));
        if (next.chainId != block.chainid || next.receiver != address(this)) revert InvalidDestination();
        if (
            next.recordId == bytes32(0) || next.contentHash == bytes32(0) || next.registryVersion == 0
                || next.sequence == 0 || next.status < CURRENT || next.status > UNAVAILABLE
        ) revert InvalidReport();
        if (
            next.observedAt > block.timestamp || next.validUntil <= block.timestamp
                || next.validUntil <= next.observedAt || next.validUntil - next.observedAt > maxReportTTL
        ) {
            revert InvalidReportTime();
        }
        Report storage previous = _states[next.recordId];
        if (next.sequence <= previous.sequence || next.observedAt < previous.observedAt) revert OutOfOrderReport();
        if (next.registryVersion < previous.registryVersion) revert VersionRollback();
        if (next.registryVersion == previous.registryVersion && next.contentHash != previous.contentHash) {
            revert ContentHashConflict();
        }
        _states[next.recordId] = next;
        emit StatusObserved(
            next.recordId,
            next.registryVersion,
            next.contentHash,
            next.sequence,
            next.status,
            next.observedAt,
            next.validUntil
        );
    }

    /// @notice Raw latest observation; consumers must inspect status and freshness.
    function getState(bytes32 recordId) external view returns (Report memory) {
        return _states[recordId];
    }

    /// @notice A fresh positive observation, not permission to operate, trade or invest.
    function isCurrent(bytes32 recordId) external view returns (bool) {
        Report storage state = _states[recordId];
        return state.status == CURRENT && state.validUntil > block.timestamp;
    }

    function supportsInterface(bytes4 interfaceId) external pure override returns (bool) {
        return
            interfaceId == type(IRegistryStatusReportReceiver).interfaceId || interfaceId == type(IERC165).interfaceId;
    }
}
