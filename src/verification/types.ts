/**
 * Types for the verification engine.
 *
 * Two groups:
 *  1. EVIDENCE  - raw facts collected from the chain and the off-chain metadata store.
 *  2. REPORT    - the structured, deterministic result produced from that evidence.
 *
 * Java comparison: these `interface`s are like plain DTOs / records. They have no behaviour.
 */

// Evidence (input to the engine)

/** Where an event sits in chain history. Ordering is (blockNumber, logIndex). */
export interface Position {
  blockNumber: number;
  logIndex: number;
}

export interface BatchState {
  exists: boolean;
  supplier: string;
  metadataHash: string;
  registeredAt: number;
  registeredBlock: number;
}

export interface ShipmentState {
  id: number;
  batchId: string;
  sender: string;
  recipient: string;
  shippedAt: number;
  shippedBlock: number;
  receivedAt: number; // 0 = not confirmed
  receivedBlock: number;
}

export interface SupplierEvent extends Position {
  type: "approved" | "revoked";
  supplier: string;
}

export interface BatchRegisteredEvent extends Position {
  batchId: string;
  supplier: string;
  metadataHash: string;
}

export interface ShipmentRecordedEvent extends Position {
  shipmentId: number;
  batchId: string;
  sender: string;
  recipient: string;
}

export interface ReceiptConfirmedEvent extends Position {
  shipmentId: number;
  batchId: string;
  recipient: string;
}

export interface ShipmentEvidence {
  state: ShipmentState;
  recordedEvent?: ShipmentRecordedEvent;
  receiptEvent?: ReceiptConfirmedEvent;
}

export interface ChainEvidence {
  /** The block the data was read at, so a result can be reproduced later. */
  checkedAtBlock: number;
  batchId: string;
  batch: BatchState;
  registeredEvent?: BatchRegisteredEvent;
  /** Approve/revoke events for the batch's supplier wallet. */
  supplierEvents: SupplierEvent[];
  /** Result of `isSupplier(supplier)` right now. */
  currentlyAuthorised: boolean;
  shipments: ShipmentEvidence[];
}

/** What the off-chain metadata store returned for the batch's committed hash. */
export type MetadataEvidence =
  | { found: false }
  | { found: true; computedHash: string }; // hash recomputed from the retrieved content

export interface VerifyOptions {
  /** If the person verifying knows who should have received the goods (e.g. their own wallet). */
  expectedRecipient?: string;
}

// Report (output of the engine)

/**
 * verified    - evidence found and it checks out
 * failed      - evidence found and it CONTRADICTS the rules (suspicious)
 * missing     - evidence not found (inconclusive, NOT a pass)
 * not_checked - the check was not asked for (e.g. no expected recipient supplied)
 */
export type CheckStatus = "verified" | "failed" | "missing" | "not_checked";

/**
 * verified   - every applicable check passed (still NOT proof the physical item is genuine)
 * incomplete - nothing contradicts the rules, but some evidence is missing
 * suspicious - at least one check failed
 * not_found  - no registration exists for this identifier
 */
export type OverallResult = "verified" | "incomplete" | "suspicious" | "not_found";

export interface Check {
  id: string;
  title: string;
  status: CheckStatus;
  /** One short sentence; the report summary is built from these. */
  headline: string;
  /** Longer explanation with the specific values involved. */
  detail: string;
}

export interface ShipmentSummary {
  shipmentId: number;
  sender: string;
  recipient: string;
  shippedAt: number;
  receiptConfirmed: boolean;
  receivedAt?: number;
}

export interface VerificationReport {
  batchId: string;
  overall: OverallResult;
  summary: string;
  checkedAtBlock: number;
  batch?: {
    supplier: string;
    metadataHash: string;
    registeredAt: number;
    supplierCurrentlyAuthorised: boolean;
  };
  checks: Check[];
  /** Things worth knowing that are not failures (e.g. supplier revoked after registration). */
  warnings: string[];
  shipments: ShipmentSummary[];
  /** Always present: what a "verified" result does NOT prove. */
  limitations: string[];
}
