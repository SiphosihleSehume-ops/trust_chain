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

  // 4. Shipment recorded?
  if (!latest) {
    checks.push(
      makeCheck(
        "shipment_recorded",
        "Shipment record",
        "missing",
        "No shipment has been recorded.",
        "The batch is registered but no ShipmentRecorded entry exists for it.",
      ),
    );
  } else {
    checks.push(
      makeCheck(
        "shipment_recorded",
        "Shipment record",
        "verified",
        `Shipment recorded to ${short(latest.state.recipient)}.`,
        `Shipment #${latest.state.id} from ${latest.state.sender} to ${latest.state.recipient}.` +
          (shipments.length > 1 ? ` (${shipments.length} shipments in total; latest shown.)` : ""),
      ),
    );
  }

  // 5. Expected recipient (only if the verifier told us who they expect).
  if (!options.expectedRecipient) {
    checks.push(
      makeCheck(
        "expected_recipient_matches",
        "Expected recipient",
        "not_checked",
        "No expected recipient was supplied.",
        "Provide expectedRecipient to check that the latest shipment names a particular wallet.",
      ),
    );
  } else if (!latest) {
    checks.push(
      makeCheck(
        "expected_recipient_matches",
        "Expected recipient",
        "missing",
        "Expected recipient could not be checked because no shipment exists.",
        `Expected ${options.expectedRecipient} but there is no shipment.`,
      ),
    );
  } else if (sameAddress(latest.state.recipient, options.expectedRecipient)) {
    checks.push(
      makeCheck(
        "expected_recipient_matches",
        "Expected recipient",
        "verified",
        "Recipient matches the expected wallet.",
        `Latest shipment names ${latest.state.recipient}.`,
      ),
    );
  } else {
    checks.push(
      makeCheck(
        "expected_recipient_matches",
        "Expected recipient",
        "failed",
        "Recipient does NOT match the expected wallet.",
        `Expected ${options.expectedRecipient} but the latest shipment names ${latest.state.recipient}.`,
      ),
    );
  }

  // 6. Has the recipient independently confirmed receipt?
  if (!latest) {
    checks.push(
      makeCheck(
        "receipt_confirmed",
        "Receipt confirmation",
        "missing",
        "Delivery confirmation is missing.",
        "There is no shipment to confirm yet.",
      ),
    );
  } else {
    const stateReceived = latest.state.receivedAt > 0;
    const ev = latest.receiptEvent;
    if (stateReceived && ev && sameAddress(ev.recipient, latest.state.recipient)) {
      checks.push(
        makeCheck(
          "receipt_confirmed",
          "Receipt confirmation",
          "verified",
          "Recipient confirmed receipt.",
          `Shipment #${latest.state.id} receipt confirmed by ${ev.recipient} at ${where(ev)}.`,
        ),
      );
    } else if (!ev && !stateReceived) {
      checks.push(
        makeCheck(
          "receipt_confirmed",
          "Receipt confirmation",
          "missing",
          "Delivery confirmation is missing.",
          `Shipment #${latest.state.id} has been recorded but ${latest.state.recipient} has not confirmed receipt.`,
        ),
      );
    } else if (stateReceived && !ev) {
      checks.push(
        makeCheck(
          "receipt_confirmed",
          "Receipt confirmation",
          "missing",
          "Receipt is marked confirmed but its event could not be found.",
          `Contract state shows shipment #${latest.state.id} as received, but no ReceiptConfirmed event was found in the scanned range.`,
        ),
      );
    } else {
      checks.push(
        makeCheck(
          "receipt_confirmed",
          "Receipt confirmation",
          "failed",
          "Receipt confirmation records are inconsistent.",
          ev && !stateReceived
            ? `A ReceiptConfirmed event exists for shipment #${latest.state.id} but contract state says it is not received.`
            : `The receipt event was signed by ${ev?.recipient} but the shipment names ${latest.state.recipient}.`,
        ),
      );
    }
  }

  // 7. Do the recorded events follow the expected order?
  //    approval -> registration -> shipment -> receipt (-> next shipment ...)
  const ordered: { label: string; pos: Position }[] = [];
  if (authorisingEvent) ordered.push({ label: "supplier approval", pos: authorisingEvent });
  if (reg) ordered.push({ label: "batch registration", pos: reg });
  for (const s of shipments) {
    if (s.recordedEvent) ordered.push({ label: `shipment #${s.state.id} recorded`, pos: s.recordedEvent });
    if (s.receiptEvent) ordered.push({ label: `shipment #${s.state.id} receipt`, pos: s.receiptEvent });
  }
  const violations: string[] = [];
  for (let i = 1; i < ordered.length; i++) {
    if (compare(ordered[i - 1].pos, ordered[i].pos) >= 0) {
      violations.push(
        `${ordered[i].label} (${where(ordered[i].pos)}) does not come after ${ordered[i - 1].label} (${where(ordered[i - 1].pos)})`,
      );
    }
  }
  if (violations.length > 0) {
    checks.push(
      makeCheck("event_sequence", "Event sequence", "failed", "Events are out of the expected order.", violations.join("; ") + "."),
    );
  } else if (ordered.length < 2) {
    checks.push(
      makeCheck("event_sequence", "Event sequence", "missing", "Not enough events to check the sequence.", "Fewer than two events were available to compare."),
    );
  } else {
    checks.push(
      makeCheck("event_sequence", "Event sequence", "verified", "Events follow the expected order.", `${ordered.length} events checked in order.`),
    );
  }

  // 8. Any contradictions between contract state and event history?
  const problems: string[] = [];
  const gaps: string[] = [];

  if (!reg) {
    gaps.push("BatchRegistered event not found in the scanned range");
  } else {
    if (!sameAddress(reg.supplier, batch.supplier)) problems.push("registration event supplier differs from stored supplier");
    if (!sameHex(reg.metadataHash, batch.metadataHash)) problems.push("registration event metadata hash differs from stored hash");
    if (reg.blockNumber !== batch.registeredBlock) problems.push("registration event block differs from stored registration block");
  }

  if (supplierEvents.length === 0) {
    gaps.push("no supplier approval/revocation events found in the scanned range");
  } else {
    const replayAuthorised = supplierEvents[supplierEvents.length - 1].type === "approved";
    if (replayAuthorised !== chain.currentlyAuthorised) {
      problems.push("supplier's current status disagrees with its approve/revoke event history");
    }
  }

  const openShipments = shipments.filter((s) => s.state.receivedAt === 0);
  if (openShipments.length > 1) problems.push(`${openShipments.length} shipments are unconfirmed at the same time`);
  if (openShipments.length === 1 && openShipments[0] !== latest) {
    problems.push("a newer shipment exists although an earlier one was never confirmed");
  }

  for (const s of shipments) {
    const label = `shipment #${s.state.id}`;
    if (!sameHex(s.state.batchId, chain.batchId)) problems.push(`${label} belongs to a different batch`);
    if (!sameAddress(s.state.sender, batch.supplier)) problems.push(`${label} was sent by a wallet other than the batch's supplier`);
    if (!s.recordedEvent) {
      gaps.push(`${label}: ShipmentRecorded event not found in the scanned range`);
    } else {
      const e = s.recordedEvent;
      if (!sameAddress(e.sender, s.state.sender) || !sameAddress(e.recipient, s.state.recipient) || !sameHex(e.batchId, s.state.batchId)) {
        problems.push(`${label}: event details differ from stored shipment`);
      }
      if (e.blockNumber !== s.state.shippedBlock) problems.push(`${label}: event block differs from stored block`);
    }
    if (s.receiptEvent) {
      if (s.state.receivedAt === 0) problems.push(`${label}: receipt event exists but shipment is not marked received`);
      else if (s.receiptEvent.blockNumber !== s.state.receivedBlock) problems.push(`${label}: receipt event block differs from stored block`);
      if (!sameAddress(s.receiptEvent.recipient, s.state.recipient)) problems.push(`${label}: receipt signed by a wallet other than the named recipient`);
    }
  }

  if (problems.length > 0) {
    checks.push(
      makeCheck("records_consistent", "Record consistency", "failed", "Conflicting or suspicious records were found.", problems.join("; ") + "."),
    );
  } else if (gaps.length > 0) {
    checks.push(
      makeCheck("records_consistent", "Record consistency", "missing", "Some expected records could not be cross-checked.", gaps.join("; ") + "."),
    );
  } else {
    checks.push(
      makeCheck("records_consistent", "Record consistency", "verified", "Contract state and event history agree.", "No contradictions or gaps were found."),
    );
  }

  // ---- overall result ------------------------------------------------------
  const statuses = checks.map((c) => c.status);
  const overall: OverallResult = statuses.includes("failed")
    ? "suspicious"
    : statuses.includes("missing")
      ? "incomplete"
      : "verified";

  const summary = checks
    .filter((c) => c.status !== "not_checked")
    .map((c) => c.headline)
    .join(" ");

  return {
    ...base,
    overall,
    summary,
    batch: {
      supplier: batch.supplier,
      metadataHash: batch.metadataHash,
      registeredAt: batch.registeredAt,
      supplierCurrentlyAuthorised: chain.currentlyAuthorised,
    },
    checks,
    warnings,
    shipments: shipments.map((s) => ({
      shipmentId: s.state.id,
      sender: s.state.sender,
      recipient: s.state.recipient,
      shippedAt: s.state.shippedAt,
      receiptConfirmed: s.state.receivedAt > 0,
      ...(s.state.receivedAt > 0 ? { receivedAt: s.state.receivedAt } : {}),
    })),
  };
}
