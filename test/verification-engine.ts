import { expect } from "chai";
import { verifyBatch, LIMITATIONS } from "../src/verification/engine.js";
import type {
  ChainEvidence,
  Check,
  MetadataEvidence,
  ShipmentEvidence,
  VerificationReport,
} from "../src/verification/types.js";

//  test data builders 

const BATCH_ID = "0x" + "11".repeat(32);
const HASH = "0x" + "aa".repeat(32);
const SUPPLIER = "0x00000000000000000000000000000000000000A1";
const DISTRIBUTOR = "0x00000000000000000000000000000000000000B2";
const STRANGER = "0x00000000000000000000000000000000000000C3";

const shipment = (id: number, overrides: Partial<ShipmentEvidence> = {}, received = true): ShipmentEvidence => {
  const shippedBlock = 10 * id + 4;
  const receivedBlock = 10 * id + 5;
  return {
    state: {
      id,
      batchId: BATCH_ID,
      sender: SUPPLIER,
      recipient: DISTRIBUTOR,
      shippedAt: 1000 + id,
      shippedBlock,
      receivedAt: received ? 2000 + id : 0,
      receivedBlock: received ? receivedBlock : 0,
    },
    recordedEvent: { blockNumber: shippedBlock, logIndex: 0, shipmentId: id, batchId: BATCH_ID, sender: SUPPLIER, recipient: DISTRIBUTOR },
    ...(received
      ? { receiptEvent: { blockNumber: receivedBlock, logIndex: 0, shipmentId: id, batchId: BATCH_ID, recipient: DISTRIBUTOR } }
      : {}),
    ...overrides,
  };
};

/** A fully valid, fully confirmed batch. Tests tweak one thing at a time. */
const good = (): ChainEvidence => ({
  checkedAtBlock: 100,
  batchId: BATCH_ID,
  batch: { exists: true, supplier: SUPPLIER, metadataHash: HASH, registeredAt: 900, registeredBlock: 3 },
  registeredEvent: { blockNumber: 3, logIndex: 0, batchId: BATCH_ID, supplier: SUPPLIER, metadataHash: HASH },
  supplierEvents: [{ type: "approved", supplier: SUPPLIER, blockNumber: 2, logIndex: 0 }],
  currentlyAuthorised: true,
  shipments: [shipment(1)],
});

const metaOk: MetadataEvidence = { found: true, computedHash: HASH };

const get = (r: VerificationReport, id: string): Check => {
  const c = r.checks.find((x) => x.id === id);
  if (!c) throw new Error(`check ${id} not in report`);
  return c;
};

// ---- tests -------------------------------------------------------------------

describe("verification engine", () => {
  describe("happy path", () => {
    it("verifies a complete, consistent history", () => {
      const r = verifyBatch(good(), metaOk, { expectedRecipient: DISTRIBUTOR });
      expect(r.overall).to.equal("verified");
      for (const c of r.checks) expect(c.status, c.id).to.equal("verified");
      expect(r.warnings).to.deep.equal([]);
    });

    it("always attaches the limitations, even when everything passes", () => {
      const r = verifyBatch(good(), metaOk);
      expect(r.limitations).to.deep.equal([...LIMITATIONS]);
      expect(r.limitations.join(" ")).to.match(/QR codes can be copied/);
    });

    it("is deterministic: same evidence gives an identical report", () => {
      expect(verifyBatch(good(), metaOk)).to.deep.equal(verifyBatch(good(), metaOk));
    });

    it("compares addresses case-insensitively", () => {
      const e = good();
      const r = verifyBatch(e, metaOk, { expectedRecipient: DISTRIBUTOR.toLowerCase() });
      expect(get(r, "expected_recipient_matches").status).to.equal("verified");
    });
  });

  describe("not found", () => {
    it("reports not_found without claiming the product is fake or genuine", () => {
      const e = good();
      e.batch = { exists: false, supplier: "0x" + "0".repeat(40), metadataHash: "0x" + "0".repeat(64), registeredAt: 0, registeredBlock: 0 };
      const r = verifyBatch(e, { found: false });
      expect(r.overall).to.equal("not_found");
      expect(r.summary).to.match(/does not show the product is fake or genuine/);
      expect(r.checks).to.have.length(1);
    });
  });

  describe("missing evidence -> incomplete, never verified", () => {
    it("shipment recorded but receipt missing (the brief's example)", () => {
      const e = good();
      e.shipments = [shipment(1, {}, false)];
      const r = verifyBatch(e, metaOk);
      expect(r.overall).to.equal("incomplete");
      expect(get(r, "shipment_recorded").status).to.equal("verified");
      expect(get(r, "receipt_confirmed").status).to.equal("missing");
      expect(r.summary).to.contain("Delivery confirmation is missing.");
      expect(r.summary).to.contain("Registration found.");
    });

    it("registered but never shipped", () => {
      const e = good();
      e.shipments = [];
      const r = verifyBatch(e, metaOk);
      expect(r.overall).to.equal("incomplete");
      expect(get(r, "shipment_recorded").status).to.equal("missing");
      expect(get(r, "receipt_confirmed").status).to.equal("missing");
    });

    it("off-chain metadata unavailable", () => {
      const r = verifyBatch(good(), { found: false });
      expect(r.overall).to.equal("incomplete");
      expect(get(r, "metadata_hash_matches").status).to.equal("missing");
    });

    it("state says received but the receipt event cannot be found", () => {
      const e = good();
      delete e.shipments[0].receiptEvent;
      const r = verifyBatch(e, metaOk);
      expect(get(r, "receipt_confirmed").status).to.equal("missing");
      expect(r.overall).to.equal("incomplete");
    });

    it("registration event missing from the scanned range", () => {
      const e = good();
      delete e.registeredEvent;
      const r = verifyBatch(e, metaOk);
      expect(get(r, "supplier_authorised_at_registration").status).to.equal("missing");
      expect(r.overall).to.equal("incomplete");
    });
  });

  describe("supplier authorisation at registration", () => {
    it("fails if the supplier was never approved", () => {
      const e = good();
      e.supplierEvents = [];
      const r = verifyBatch(e, metaOk);
      expect(get(r, "supplier_authorised_at_registration").status).to.equal("failed");
      expect(r.overall).to.equal("suspicious");
    });

    it("fails if approved only AFTER registration", () => {
      const e = good();
      e.supplierEvents = [{ type: "approved", supplier: SUPPLIER, blockNumber: 4, logIndex: 0 }];
      expect(get(verifyBatch(e, metaOk), "supplier_authorised_at_registration").status).to.equal("failed");
    });

    it("fails if revoked BEFORE registration", () => {
      const e = good();
      e.supplierEvents = [
        { type: "approved", supplier: SUPPLIER, blockNumber: 1, logIndex: 0 },
        { type: "revoked", supplier: SUPPLIER, blockNumber: 2, logIndex: 0 },
      ];
      e.currentlyAuthorised = false;
      expect(get(verifyBatch(e, metaOk), "supplier_authorised_at_registration").status).to.equal("failed");
    });

    it("passes with a warning (not a failure) if revoked AFTER registration", () => {
      const e = good();
      e.supplierEvents.push({ type: "revoked", supplier: SUPPLIER, blockNumber: 50, logIndex: 0 });
      e.currentlyAuthorised = false;
      const r = verifyBatch(e, metaOk);
      expect(get(r, "supplier_authorised_at_registration").status).to.equal("verified");
      expect(r.overall).to.equal("verified");
      expect(r.warnings.join(" ")).to.match(/since been revoked/);
      expect(r.batch?.supplierCurrentlyAuthorised).to.equal(false);
    });

    it("handles a re-approval after revocation, judged at registration time", () => {
      const e = good();
      e.supplierEvents = [
        { type: "approved", supplier: SUPPLIER, blockNumber: 1, logIndex: 0 },
        { type: "revoked", supplier: SUPPLIER, blockNumber: 2, logIndex: 0 },
        { type: "approved", supplier: SUPPLIER, blockNumber: 2, logIndex: 5 },
      ];
      expect(get(verifyBatch(e, metaOk), "supplier_authorised_at_registration").status).to.equal("verified");
    });

    it("uses logIndex to order events inside the same block", () => {
      const approvedFirst = good();
      approvedFirst.registeredEvent!.blockNumber = 7;
      approvedFirst.batch.registeredBlock = 7;
      approvedFirst.supplierEvents = [{ type: "approved", supplier: SUPPLIER, blockNumber: 7, logIndex: 0 }];
      approvedFirst.registeredEvent!.logIndex = 1;
      approvedFirst.shipments = [];
      expect(get(verifyBatch(approvedFirst, metaOk), "supplier_authorised_at_registration").status).to.equal("verified");

      const approvedSecond = structuredClone(approvedFirst);
      approvedSecond.supplierEvents[0].logIndex = 2; // approval AFTER registration in the same block
      expect(get(verifyBatch(approvedSecond, metaOk), "supplier_authorised_at_registration").status).to.equal("failed");
    });

    it("ignores approval events belonging to other wallets", () => {
      const e = good();
      e.supplierEvents = [{ type: "approved", supplier: STRANGER, blockNumber: 2, logIndex: 0 }];
      expect(get(verifyBatch(e, metaOk), "supplier_authorised_at_registration").status).to.equal("failed");
    });
  });

  describe("metadata hash", () => {
    it("fails when retrieved content does not hash to the commitment", () => {
      const r = verifyBatch(good(), { found: true, computedHash: "0x" + "bb".repeat(32) });
      expect(get(r, "metadata_hash_matches").status).to.equal("failed");
      expect(r.overall).to.equal("suspicious");
    });
  });

  describe("expected recipient", () => {
    it("is not_checked (and does not affect the result) when none is supplied", () => {
      const r = verifyBatch(good(), metaOk);
      expect(get(r, "expected_recipient_matches").status).to.equal("not_checked");
      expect(r.overall).to.equal("verified");
      expect(r.summary).to.not.contain("No expected recipient");
    });

    it("fails when the shipment names a different wallet", () => {
      const r = verifyBatch(good(), metaOk, { expectedRecipient: STRANGER });
      expect(get(r, "expected_recipient_matches").status).to.equal("failed");
      expect(r.overall).to.equal("suspicious");
    });

    it("is missing when asked for but no shipment exists", () => {
      const e = good();
      e.shipments = [];
      expect(get(verifyBatch(e, metaOk, { expectedRecipient: DISTRIBUTOR }), "expected_recipient_matches").status).to.equal("missing");
    });
  });

  describe("contradictory or suspicious records", () => {
    it("fails when a receipt event exists but state says not received", () => {
      const e = good();
      e.shipments[0].state.receivedAt = 0;
      e.shipments[0].state.receivedBlock = 0;
      const r = verifyBatch(e, metaOk);
      expect(get(r, "receipt_confirmed").status).to.equal("failed");
      expect(get(r, "records_consistent").status).to.equal("failed");
      expect(r.overall).to.equal("suspicious");
    });

    it("fails when the receipt was signed by someone other than the named recipient", () => {
      const e = good();
      e.shipments[0].receiptEvent!.recipient = STRANGER;
      const r = verifyBatch(e, metaOk);
      expect(get(r, "receipt_confirmed").status).to.equal("failed");
      expect(r.overall).to.equal("suspicious");
    });

    it("fails when a shipment was sent by a wallet other than the batch supplier", () => {
      const e = good();
      e.shipments[0].state.sender = STRANGER;
      e.shipments[0].recordedEvent!.sender = STRANGER;
      const r = verifyBatch(e, metaOk);
      expect(get(r, "records_consistent").status).to.equal("failed");
      expect(get(r, "records_consistent").detail).to.match(/other than the batch's supplier/);
    });

    it("fails when a shipment event disagrees with stored state", () => {
      const e = good();
      e.shipments[0].recordedEvent!.recipient = STRANGER;
      expect(get(verifyBatch(e, metaOk), "records_consistent").status).to.equal("failed");
    });

    it("fails when the registration event hash differs from the stored hash", () => {
      const e = good();
      e.registeredEvent!.metadataHash = "0x" + "cc".repeat(32);
      expect(get(verifyBatch(e, metaOk), "records_consistent").status).to.equal("failed");
    });

    it("fails when supplier's current status contradicts its event history", () => {
      const e = good();
      e.currentlyAuthorised = false; // events say approved and never revoked
      expect(get(verifyBatch(e, metaOk), "records_consistent").status).to.equal("failed");
    });

    it("fails when two shipments are unconfirmed at once", () => {
      const e = good();
      e.shipments = [shipment(1, {}, false), shipment(2, {}, false)];
      const r = verifyBatch(e, metaOk);
      expect(get(r, "records_consistent").status).to.equal("failed");
      expect(r.overall).to.equal("suspicious");
    });

    it("fails when a shipment belongs to a different batch", () => {
      const e = good();
      e.shipments[0].state.batchId = "0x" + "22".repeat(32);
      expect(get(verifyBatch(e, metaOk), "records_consistent").status).to.equal("failed");
    });
  });

  describe("event sequence", () => {
    it("fails when a shipment is recorded before the batch was registered", () => {
      const e = good();
      e.shipments[0].recordedEvent!.blockNumber = 1;
      e.shipments[0].state.shippedBlock = 1;
      const r = verifyBatch(e, metaOk);
      expect(get(r, "event_sequence").status).to.equal("failed");
      expect(r.overall).to.equal("suspicious");
    });

    it("fails when receipt is confirmed before the shipment was recorded", () => {
      const e = good();
      e.shipments[0].receiptEvent!.blockNumber = 2;
      e.shipments[0].state.receivedBlock = 2;
      expect(get(verifyBatch(e, metaOk), "event_sequence").status).to.equal("failed");
    });

    it("accepts multiple shipments in a valid chain of custody", () => {
      const e = good();
      e.shipments = [shipment(1), shipment(2)];
      const r = verifyBatch(e, metaOk);
      expect(get(r, "event_sequence").status).to.equal("verified");
      expect(r.shipments).to.have.length(2);
      expect(r.overall).to.equal("verified");
    });
  });

  describe("a failure always beats missing evidence", () => {
    it("reports suspicious even if other evidence is also missing", () => {
      const e = good();
      e.shipments = [];
      const r = verifyBatch(e, { found: true, computedHash: "0x" + "bb".repeat(32) });
      expect(get(r, "shipment_recorded").status).to.equal("missing");
      expect(r.overall).to.equal("suspicious");
    });
  });
});
