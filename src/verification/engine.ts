import type {
  Check,
  CheckStatus,
  ChainEvidence,
  MetadataEvidence,
  OverallResult,
  Position,
  SupplierEvent,
  VerificationReport,
  VerifyOptions,
} from "./types.js";

/**
 * The deterministic verification engine.
 *
 * It is a PURE function: the same evidence always gives the same report. It does no
 * network calls, reads no database and never calls an AI. That is what makes it testable
 * and trustworthy. Anything that explains the result in plain language (Phase 4) must only
 * consume this report and may never change it.
 */

export const LIMITATIONS: readonly string[] = [
  "A record on the blockchain is not proof that its contents were truthful; the supplier could have submitted false information.",
  "A registered supplier is not trustworthy forever. Authorisation was checked as of the time of registration, and its current status is shown separately.",
  "A shipment record is not proof of physical delivery. Only the receiving party's own confirmation counts, and even that is their statement.",
  "A matching metadata hash proves the retrieved data matches what was committed. It does not prove the claims inside it are true.",
  "A valid QR code does not prove the physical item carrying it is genuine; QR codes can be copied onto counterfeit items.",
  "Any AI-generated explanation is not verification evidence. This deterministic report is the result.",
];

// small helpers 

const compare = (a: Position, b: Position): number =>
  a.blockNumber - b.blockNumber || a.logIndex - b.logIndex;

const sameAddress = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();
const sameHex = sameAddress; // hex strings are compared case-insensitively too

const short = (address: string): string => `${address.slice(0, 6)}…${address.slice(-4)}`;

const where = (p: Position): string => `block ${p.blockNumber}`;

function makeCheck(
  id: string,
  title: string,
  status: CheckStatus,
  headline: string,
  detail: string,
): Check {
  return { id, title, status, headline, detail };
}

// the engine

export function verifyBatch(
  chain: ChainEvidence,
  metadata: MetadataEvidence,
  options: VerifyOptions = {},
): VerificationReport {
  const base = {
    batchId: chain.batchId,
    checkedAtBlock: chain.checkedAtBlock,
    limitations: [...LIMITATIONS],
  };

  // 1. Does the batch exist at all? If not, nothing else can be said.
  if (!chain.batch.exists) {
    return {
      ...base,
      overall: "not_found",
      summary:
        "No registration was found for this batch identifier. This does not show the product is fake or genuine; it only means no record exists on this contract.",
      checks: [
        makeCheck(
          "batch_registered",
          "Batch registration",
          "missing",
          "No registration found for this identifier.",
          `No BatchRegistered record exists for ${chain.batchId}.`,
        ),
      ],
      warnings: [],
      shipments: [],
    };
  }

  const checks: Check[] = [];
  const warnings: string[] = [];
  const batch = chain.batch;
  const reg = chain.registeredEvent;
  const shipments = [...chain.shipments].sort((a, b) => a.state.id - b.state.id);
  const latest = shipments.length > 0 ? shipments[shipments.length - 1] : undefined;

  checks.push(
    makeCheck(
      "batch_registered",
      "Batch registration",
      "verified",
      "Registration found.",
      `Batch registered by ${batch.supplier} at block ${batch.registeredBlock}.`,
    ),
  );

  // 2. Was the registering wallet authorised AT THE TIME of registration?
  //    We replay approve/revoke events up to the registration event. We do not trust
  //    the supplier's CURRENT status for this, because it may have changed since.
  const supplierEvents: SupplierEvent[] = chain.supplierEvents
    .filter((e) => sameAddress(e.supplier, batch.supplier))
    .sort(compare);

  let authorisingEvent: SupplierEvent | undefined;
  if (!reg) {
    checks.push(
      makeCheck(
        "supplier_authorised_at_registration",
        "Supplier authorised at registration",
        "missing",
        "Supplier authorisation at registration could not be established.",
        "The BatchRegistered event was not found, so authorisation cannot be replayed to that point in history.",
      ),
    );
  } else {
    let authorised = false;
    let lastBefore: SupplierEvent | undefined;
    for (const e of supplierEvents) {
      if (compare(e, reg) >= 0) break;
      lastBefore = e;
      authorised = e.type === "approved";
      authorisingEvent = authorised ? e : undefined;
    }
    if (authorised) {
      checks.push(
        makeCheck(
          "supplier_authorised_at_registration",
          "Supplier authorised at registration",
          "verified",
          "Supplier was authorised when the batch was registered.",
          `Approved at ${where(authorisingEvent!)}, before registration at ${where(reg)}.`,
        ),
      );
    } else {
      checks.push(
        makeCheck(
          "supplier_authorised_at_registration",
          "Supplier authorised at registration",
          "failed",
          "Supplier was NOT authorised when the batch was registered.",
          lastBefore
            ? `Latest authorisation event before registration was a revocation at ${where(lastBefore)}.`
            : `No approval event for ${batch.supplier} exists before registration at ${where(reg)}.`,
        ),
      );
    }
  }

  if (!chain.currentlyAuthorised) {
    warnings.push(
      "This supplier's authorisation has since been revoked. Records made while it was authorised are unchanged, but new activity from it is blocked.",
    );
  }

  // 3. Does the retrieved off-chain metadata hash to the committed value?
  if (!metadata.found) {
    checks.push(
      makeCheck(
        "metadata_hash_matches",
        "Metadata hash",
        "missing",
        "Off-chain metadata was not available to check against the committed hash.",
        `No stored metadata was found for committed hash ${batch.metadataHash}.`,
      ),
    );
  } else if (sameHex(metadata.computedHash, batch.metadataHash)) {
    checks.push(
      makeCheck(
        "metadata_hash_matches",
        "Metadata hash",
        "verified",
        "Metadata hash matches the on-chain commitment.",
        `Recomputed hash equals committed hash ${batch.metadataHash}. This shows integrity, not truthfulness.`,
      ),
    );
  } else {
    checks.push(
      makeCheck(
        "metadata_hash_matches",
        "Metadata hash",
        "failed",
        "Metadata does NOT match the on-chain commitment.",
        `Committed ${batch.metadataHash} but the retrieved content hashes to ${metadata.computedHash}.`,
      ),
    );
  }
}
