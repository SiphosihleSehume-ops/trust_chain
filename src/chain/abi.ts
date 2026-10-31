/**
 * The slice of the contract's ABI that the backend needs, in ethers "human-readable" form.
 *
 * It lives in source (not read from `artifacts/`) so the backend runs without a Hardhat build.
 * test/chain-integration.ts checks this stays in sync with the compiled contract.
 */
export const TRACEABILITY_ABI = [
  "function isSupplier(address) view returns (bool)",
  "function getBatch(bytes32 batchId) view returns (bool exists, tuple(address supplier, bytes32 metadataHash, uint64 registeredAt, uint64 registeredBlock) batch)",
  "function getShipment(uint256 shipmentId) view returns (bool exists, tuple(bytes32 batchId, address sender, address recipient, uint64 shippedAt, uint64 shippedBlock, uint64 receivedAt, uint64 receivedBlock) shipment)",
  "function getBatchShipmentIds(bytes32 batchId) view returns (uint256[])",
  "event SupplierApproved(address indexed supplier, address indexed approvedBy)",
  "event SupplierRevoked(address indexed supplier, address indexed revokedBy)",
  "event BatchRegistered(bytes32 indexed batchId, address indexed supplier, bytes32 metadataHash)",
  "event ShipmentRecorded(uint256 indexed shipmentId, bytes32 indexed batchId, address indexed sender, address recipient)",
  "event ReceiptConfirmed(uint256 indexed shipmentId, bytes32 indexed batchId, address indexed recipient)",
] as const;
