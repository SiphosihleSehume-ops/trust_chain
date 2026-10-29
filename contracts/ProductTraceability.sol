// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";

/// @title ProductTraceability
/// @notice Records batch registration, shipments and receipt confirmations so that
///         an off-chain verification engine can independently inspect them.
/// @dev What this contract guarantees:
///      - only an admin-approved supplier wallet can register batches / record shipments;
///      - batch identifiers are unique;
///      - only the intended recipient wallet can confirm receipt of a shipment.
///      What it can NOT guarantee: that the supplier told the truth, that goods
///      physically moved, or that a physical item carrying a QR code is genuine.

contract ProductTraceability is AccessControl {

    /// @dev Roughly like a Java record. One entry per registered batch.
    struct Batch {
        address supplier;       // wallet that registered the batch
        bytes32 metadataHash;   // hash of the off-chain metadata (e.g. keccak256 of a JSON file)
        uint64 registeredAt;    // block timestamp (seconds)
        uint64 registeredBlock; // block number (lets the verifier replay supplier history)
    }

    /// @dev One entry per shipment. receivedAt == 0 means "not yet confirmed".
    struct Shipment {
        bytes32 batchId;
        address sender;
        address recipient;
        uint64 shippedAt;
        uint64 shippedBlock;
        uint64 receivedAt;
        uint64 receivedBlock;
    }

    /// @notice Current supplier authorisation. Historical changes are in the events.
    mapping(address => bool) public isSupplier;

    mapping(bytes32 => Batch) private _batches;

    /// @dev Shipment ids start at 1, so id 0 always means "does not exist".
    mapping(uint256 => Shipment) private _shipments;
    mapping(bytes32 => uint256[]) private _batchShipmentIds;
    uint256 public shipmentCount;

    // Events (the verification engine reads these to rebuild history)

    event SupplierApproved(address indexed supplier, address indexed approvedBy);
    event SupplierRevoked(address indexed supplier, address indexed revokedBy);
    event BatchRegistered(bytes32 indexed batchId, address indexed supplier, bytes32 metadataHash);
    event ShipmentRecorded(
        uint256 indexed shipmentId,
        bytes32 indexed batchId,
        address indexed sender,
        address recipient
    );
    event ReceiptConfirmed(
        uint256 indexed shipmentId,
        bytes32 indexed batchId,
        address indexed recipient
    );

    // Errors (cheaper than strings, and easy to assert in tests)

    error NotAuthorisedSupplier(address caller);
    error SupplierAlreadyApproved(address supplier);
    error SupplierNotApproved(address supplier);
    error InvalidAddress();
    error InvalidBatchId();
    error InvalidMetadataHash();
    error BatchAlreadyRegistered(bytes32 batchId);
    error BatchNotFound(bytes32 batchId);
    error NotBatchSupplier(bytes32 batchId, address caller);
    error InvalidRecipient(address recipient);
    error OpenShipmentExists(bytes32 batchId, uint256 shipmentId);
    error ShipmentNotFound(uint256 shipmentId);
    error NotShipmentRecipient(uint256 shipmentId, address caller);
    error ShipmentAlreadyReceived(uint256 shipmentId);

    // Setup and access control

    /// @param initialAdmin Wallet that can approve/revoke suppliers. Use a multisig later.
    constructor(address initialAdmin) {
        if (initialAdmin == address(0)) revert InvalidAddress();
        _grantRole(DEFAULT_ADMIN_ROLE, initialAdmin);
    }

    modifier onlySupplier() {
        if (!isSupplier[msg.sender]) revert NotAuthorisedSupplier(msg.sender);
        _;
    }
}
