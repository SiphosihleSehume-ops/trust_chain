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

    // Administrator operations

    /// @notice Approve a supplier wallet. Business identity must be checked off-chain first.
    function approveSupplier(address supplier) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (supplier == address(0)) revert InvalidAddress();
        if (isSupplier[supplier]) revert SupplierAlreadyApproved(supplier);
        isSupplier[supplier] = true;
        emit SupplierApproved(supplier, msg.sender);
    }

    /// @notice Revoke a supplier. Existing records stay on-chain; new actions are blocked.
    function revokeSupplier(address supplier) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (!isSupplier[supplier]) revert SupplierNotApproved(supplier);
        isSupplier[supplier] = false;
        emit SupplierRevoked(supplier, msg.sender);
    }

     // Supplier operations

    /// @notice Register a batch. `batchId` must be unique across all suppliers.
    /// @param batchId      Unique identifier (e.g. keccak256 of "BATCH-2026-0001").
    /// @param metadataHash Hash committing to the off-chain metadata/document.
    function registerBatch(bytes32 batchId, bytes32 metadataHash) external onlySupplier {
        if (batchId == bytes32(0)) revert InvalidBatchId();
        if (metadataHash == bytes32(0)) revert InvalidMetadataHash();
        if (_batches[batchId].supplier != address(0)) revert BatchAlreadyRegistered(batchId);

        _batches[batchId] = Batch({
            supplier: msg.sender,
            metadataHash: metadataHash,
            registeredAt: uint64(block.timestamp),
            registeredBlock: uint64(block.number)
        });

        emit BatchRegistered(batchId, msg.sender, metadataHash);
    }

    /// @notice Record that a batch is being shipped to `recipient`.
    /// @dev MVP rule: a batch can have only one unconfirmed shipment at a time.
    function recordShipment(bytes32 batchId, address recipient)
        external
        onlySupplier
        returns (uint256 shipmentId)
    {
        Batch storage batch = _batches[batchId];
        if (batch.supplier == address(0)) revert BatchNotFound(batchId);
        if (batch.supplier != msg.sender) revert NotBatchSupplier(batchId, msg.sender);
        if (recipient == address(0) || recipient == msg.sender) revert InvalidRecipient(recipient);

        uint256[] storage ids = _batchShipmentIds[batchId];
        if (ids.length > 0) {
            uint256 lastId = ids[ids.length - 1];
            if (_shipments[lastId].receivedAt == 0) revert OpenShipmentExists(batchId, lastId);
        }

        shipmentId = ++shipmentCount;
        _shipments[shipmentId] = Shipment({
            batchId: batchId,
            sender: msg.sender,
            recipient: recipient,
            shippedAt: uint64(block.timestamp),
            shippedBlock: uint64(block.number),
            receivedAt: 0,
            receivedBlock: 0
        });
        ids.push(shipmentId);

        emit ShipmentRecorded(shipmentId, batchId, msg.sender, recipient);
    }

    // Distributor operations

    /// @notice Confirm receipt. Only the recipient named in the shipment can call this.
    function confirmReceipt(uint256 shipmentId) external {
        Shipment storage shipment = _shipments[shipmentId];
        if (shipment.sender == address(0)) revert ShipmentNotFound(shipmentId);
        if (shipment.recipient != msg.sender) revert NotShipmentRecipient(shipmentId, msg.sender);
        if (shipment.receivedAt != 0) revert ShipmentAlreadyReceived(shipmentId);

        shipment.receivedAt = uint64(block.timestamp);
        shipment.receivedBlock = uint64(block.number);

        emit ReceiptConfirmed(shipmentId, shipment.batchId, msg.sender);
    }

    // Verification (read-only) operations

    /// @notice Returns the batch record. `exists == false` means it was never registered.
    function getBatch(bytes32 batchId)
        external
        view
        returns (bool exists, Batch memory batch)
    {
        batch = _batches[batchId];
        exists = batch.supplier != address(0);
    }

    /// @notice Returns one shipment. `exists == false` means the id is unknown.
    function getShipment(uint256 shipmentId)
        external
        view
        returns (bool exists, Shipment memory shipment)
    {
        shipment = _shipments[shipmentId];
        exists = shipment.sender != address(0);
    }

    /// @notice All shipment ids recorded for a batch, oldest first.
    function getBatchShipmentIds(bytes32 batchId) external view returns (uint256[] memory) {
        return _batchShipmentIds[batchId];
    }

}
