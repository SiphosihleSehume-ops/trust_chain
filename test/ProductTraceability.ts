import { expect } from "chai";
import { network } from "hardhat";

const { ethers, networkHelpers } = await network.getOrCreate();

const BATCH_ID = ethers.id("BATCH-2026-0001"); // keccak256 of a readable label -> bytes32
const OTHER_BATCH_ID = ethers.id("BATCH-2026-0002");
const METADATA_HASH = ethers.id('{"product":"Premium Olive Oil 500ml","lot":"A1"}');

describe("ProductTraceability", () => {
  // A fixture deploys once, then every test starts from a fresh snapshot (fast + isolated).
  async function deployFixture() {
    const [admin, supplierA, supplierB, distributorB, stranger] = await ethers.getSigners();
    const trace = await ethers.deployContract("ProductTraceability", [admin.address]);
    return { trace, admin, supplierA, supplierB, distributorB, stranger };
  }

  async function approvedSupplierFixture() {
    const ctx = await deployFixture();
    await ctx.trace.connect(ctx.admin).approveSupplier(ctx.supplierA.address);
    return ctx;
  }

  async function registeredBatchFixture() {
    const ctx = await approvedSupplierFixture();
    await ctx.trace.connect(ctx.supplierA).registerBatch(BATCH_ID, METADATA_HASH);
    return ctx;
  }

  async function shippedFixture() {
    const ctx = await registeredBatchFixture();
    await ctx.trace.connect(ctx.supplierA).recordShipment(BATCH_ID, ctx.distributorB.address);
    return ctx; // shipment id is 1
  }

  describe("deployment", () => {
    it("grants the admin role to the initial admin only", async () => {
      const { trace, admin, stranger } = await networkHelpers.loadFixture(deployFixture);
      const role = await trace.DEFAULT_ADMIN_ROLE();
      expect(await trace.hasRole(role, admin.address)).to.equal(true);
      expect(await trace.hasRole(role, stranger.address)).to.equal(false);
    });

    it("rejects a zero-address admin", async () => {
      const factory = await ethers.getContractFactory("ProductTraceability");
      await expect(factory.deploy(ethers.ZeroAddress)).to.be.revertedWithCustomError(
        factory,
        "InvalidAddress",
      );
    });
  });

  describe("supplier authorisation", () => {
    it("lets the admin approve a supplier and emits SupplierApproved", async () => {
      const { trace, admin, supplierA } = await networkHelpers.loadFixture(deployFixture);
      await expect(trace.connect(admin).approveSupplier(supplierA.address))
        .to.emit(trace, "SupplierApproved")
        .withArgs(supplierA.address, admin.address);
      expect(await trace.isSupplier(supplierA.address)).to.equal(true);
    });

    it("does not let arbitrary wallets approve themselves or others", async () => {
      const { trace, stranger, supplierA } = await networkHelpers.loadFixture(deployFixture);
      await expect(trace.connect(stranger).approveSupplier(stranger.address))
        .to.be.revertedWithCustomError(trace, "AccessControlUnauthorizedAccount");
      await expect(trace.connect(supplierA).approveSupplier(supplierA.address))
        .to.be.revertedWithCustomError(trace, "AccessControlUnauthorizedAccount");
      expect(await trace.isSupplier(stranger.address)).to.equal(false);
    });

    it("rejects approving the zero address or an already-approved supplier", async () => {
      const { trace, admin, supplierA } = await networkHelpers.loadFixture(approvedSupplierFixture);
      await expect(trace.connect(admin).approveSupplier(ethers.ZeroAddress))
        .to.be.revertedWithCustomError(trace, "InvalidAddress");
      await expect(trace.connect(admin).approveSupplier(supplierA.address))
        .to.be.revertedWithCustomError(trace, "SupplierAlreadyApproved")
        .withArgs(supplierA.address);
    });

    it("lets the admin revoke a supplier and emits SupplierRevoked", async () => {
      const { trace, admin, supplierA } = await networkHelpers.loadFixture(approvedSupplierFixture);
      await expect(trace.connect(admin).revokeSupplier(supplierA.address))
        .to.emit(trace, "SupplierRevoked")
        .withArgs(supplierA.address, admin.address);
      expect(await trace.isSupplier(supplierA.address)).to.equal(false);
    });

    it("rejects revoking a supplier that is not approved, and non-admin revocation", async () => {
      const { trace, admin, supplierA, stranger } = await networkHelpers.loadFixture(approvedSupplierFixture);
      await expect(trace.connect(admin).revokeSupplier(stranger.address))
        .to.be.revertedWithCustomError(trace, "SupplierNotApproved")
        .withArgs(stranger.address);
      await expect(trace.connect(stranger).revokeSupplier(supplierA.address))
        .to.be.revertedWithCustomError(trace, "AccessControlUnauthorizedAccount");
    });
  });

  describe("registerBatch", () => {
    it("stores the batch, supplier and metadata hash and emits BatchRegistered", async () => {
      const { trace, supplierA } = await networkHelpers.loadFixture(approvedSupplierFixture);
      await expect(trace.connect(supplierA).registerBatch(BATCH_ID, METADATA_HASH))
        .to.emit(trace, "BatchRegistered")
        .withArgs(BATCH_ID, supplierA.address, METADATA_HASH);

      const [exists, batch] = await trace.getBatch(BATCH_ID);
      expect(exists).to.equal(true);
      expect(batch.supplier).to.equal(supplierA.address);
      expect(batch.metadataHash).to.equal(METADATA_HASH);
      expect(batch.registeredBlock).to.be.greaterThan(0n);
      expect(batch.registeredAt).to.be.greaterThan(0n);
    });

    it("rejects an unauthorised supplier (never approved)", async () => {
      const { trace, stranger } = await networkHelpers.loadFixture(approvedSupplierFixture);
      await expect(trace.connect(stranger).registerBatch(BATCH_ID, METADATA_HASH))
        .to.be.revertedWithCustomError(trace, "NotAuthorisedSupplier")
        .withArgs(stranger.address);
    });

    it("rejects a supplier whose authorisation was revoked", async () => {
      const { trace, admin, supplierA } = await networkHelpers.loadFixture(approvedSupplierFixture);
      await trace.connect(admin).revokeSupplier(supplierA.address);
      await expect(trace.connect(supplierA).registerBatch(BATCH_ID, METADATA_HASH))
        .to.be.revertedWithCustomError(trace, "NotAuthorisedSupplier");
    });

    it("rejects a duplicate batch id, including from another approved supplier", async () => {
      const { trace, admin, supplierA, supplierB } = await networkHelpers.loadFixture(registeredBatchFixture);
      await expect(trace.connect(supplierA).registerBatch(BATCH_ID, METADATA_HASH))
        .to.be.revertedWithCustomError(trace, "BatchAlreadyRegistered")
        .withArgs(BATCH_ID);

      await trace.connect(admin).approveSupplier(supplierB.address);
      await expect(trace.connect(supplierB).registerBatch(BATCH_ID, ethers.id("different")))
        .to.be.revertedWithCustomError(trace, "BatchAlreadyRegistered");

      // The original record must be untouched.
      const [, batch] = await trace.getBatch(BATCH_ID);
      expect(batch.supplier).to.equal(supplierA.address);
      expect(batch.metadataHash).to.equal(METADATA_HASH);
    });

    it("rejects a zero batch id or zero metadata hash", async () => {
      const { trace, supplierA } = await networkHelpers.loadFixture(approvedSupplierFixture);
      await expect(trace.connect(supplierA).registerBatch(ethers.ZeroHash, METADATA_HASH))
        .to.be.revertedWithCustomError(trace, "InvalidBatchId");
      await expect(trace.connect(supplierA).registerBatch(BATCH_ID, ethers.ZeroHash))
        .to.be.revertedWithCustomError(trace, "InvalidMetadataHash");
    });

    it("reports exists = false for an unknown batch", async () => {
      const { trace } = await networkHelpers.loadFixture(deployFixture);
      const [exists] = await trace.getBatch(BATCH_ID);
      expect(exists).to.equal(false);
    });
  });

  describe("recordShipment", () => {
    it("records a shipment to the distributor and emits ShipmentRecorded", async () => {
      const { trace, supplierA, distributorB } = await networkHelpers.loadFixture(registeredBatchFixture);
      await expect(trace.connect(supplierA).recordShipment(BATCH_ID, distributorB.address))
        .to.emit(trace, "ShipmentRecorded")
        .withArgs(1n, BATCH_ID, supplierA.address, distributorB.address);

      const [exists, shipment] = await trace.getShipment(1n);
      expect(exists).to.equal(true);
      expect(shipment.batchId).to.equal(BATCH_ID);
      expect(shipment.sender).to.equal(supplierA.address);
      expect(shipment.recipient).to.equal(distributorB.address);
      expect(shipment.receivedAt).to.equal(0n); // receipt still missing
      expect(await trace.getBatchShipmentIds(BATCH_ID)).to.deep.equal([1n]);
    });

    it("rejects an unknown batch", async () => {
      const { trace, supplierA, distributorB } = await networkHelpers.loadFixture(approvedSupplierFixture);
      await expect(trace.connect(supplierA).recordShipment(BATCH_ID, distributorB.address))
        .to.be.revertedWithCustomError(trace, "BatchNotFound")
        .withArgs(BATCH_ID);
    });

    it("rejects an unauthorised caller", async () => {
      const { trace, stranger, distributorB } = await networkHelpers.loadFixture(registeredBatchFixture);
      await expect(trace.connect(stranger).recordShipment(BATCH_ID, distributorB.address))
        .to.be.revertedWithCustomError(trace, "NotAuthorisedSupplier");
    });

    it("rejects a different approved supplier shipping someone else's batch", async () => {
      const { trace, admin, supplierB, distributorB } = await networkHelpers.loadFixture(registeredBatchFixture);
      await trace.connect(admin).approveSupplier(supplierB.address);
      await expect(trace.connect(supplierB).recordShipment(BATCH_ID, distributorB.address))
        .to.be.revertedWithCustomError(trace, "NotBatchSupplier")
        .withArgs(BATCH_ID, supplierB.address);
    });

    it("rejects invalid recipients (zero address and the sender itself)", async () => {
      const { trace, supplierA } = await networkHelpers.loadFixture(registeredBatchFixture);
      await expect(trace.connect(supplierA).recordShipment(BATCH_ID, ethers.ZeroAddress))
        .to.be.revertedWithCustomError(trace, "InvalidRecipient");
      await expect(trace.connect(supplierA).recordShipment(BATCH_ID, supplierA.address))
        .to.be.revertedWithCustomError(trace, "InvalidRecipient")
        .withArgs(supplierA.address);
    });

    it("rejects a revoked supplier", async () => {
      const { trace, admin, supplierA, distributorB } = await networkHelpers.loadFixture(registeredBatchFixture);
      await trace.connect(admin).revokeSupplier(supplierA.address);
      await expect(trace.connect(supplierA).recordShipment(BATCH_ID, distributorB.address))
        .to.be.revertedWithCustomError(trace, "NotAuthorisedSupplier");
    });

    it("blocks a second shipment while the first has no receipt, then allows it after receipt", async () => {
      const { trace, supplierA, distributorB, stranger } = await networkHelpers.loadFixture(shippedFixture);
      await expect(trace.connect(supplierA).recordShipment(BATCH_ID, stranger.address))
        .to.be.revertedWithCustomError(trace, "OpenShipmentExists")
        .withArgs(BATCH_ID, 1n);

      await trace.connect(distributorB).confirmReceipt(1n);
      await expect(trace.connect(supplierA).recordShipment(BATCH_ID, stranger.address))
        .to.emit(trace, "ShipmentRecorded")
        .withArgs(2n, BATCH_ID, supplierA.address, stranger.address);
      expect(await trace.getBatchShipmentIds(BATCH_ID)).to.deep.equal([1n, 2n]);
    });
  });

  describe("confirmReceipt", () => {
    it("lets only the intended distributor confirm and emits ReceiptConfirmed", async () => {
      const { trace, distributorB } = await networkHelpers.loadFixture(shippedFixture);
      await expect(trace.connect(distributorB).confirmReceipt(1n))
        .to.emit(trace, "ReceiptConfirmed")
        .withArgs(1n, BATCH_ID, distributorB.address);

      const [, shipment] = await trace.getShipment(1n);
      expect(shipment.receivedAt).to.be.greaterThan(0n);
      expect(shipment.receivedBlock).to.be.greaterThan(shipment.shippedBlock);
    });

    it("rejects the supplier, the admin and strangers confirming on the distributor's behalf", async () => {
      const { trace, admin, supplierA, stranger } = await networkHelpers.loadFixture(shippedFixture);
      for (const wrongWallet of [supplierA, admin, stranger]) {
        await expect(trace.connect(wrongWallet).confirmReceipt(1n))
          .to.be.revertedWithCustomError(trace, "NotShipmentRecipient")
          .withArgs(1n, wrongWallet.address);
      }
      const [, shipment] = await trace.getShipment(1n);
      expect(shipment.receivedAt).to.equal(0n); // still unconfirmed
    });

    it("rejects an unknown shipment id", async () => {
      const { trace, distributorB } = await networkHelpers.loadFixture(shippedFixture);
      await expect(trace.connect(distributorB).confirmReceipt(99n))
        .to.be.revertedWithCustomError(trace, "ShipmentNotFound")
        .withArgs(99n);
      await expect(trace.connect(distributorB).confirmReceipt(0n))
        .to.be.revertedWithCustomError(trace, "ShipmentNotFound");
    });

    it("rejects confirming the same shipment twice", async () => {
      const { trace, distributorB } = await networkHelpers.loadFixture(shippedFixture);
      await trace.connect(distributorB).confirmReceipt(1n);
      await expect(trace.connect(distributorB).confirmReceipt(1n))
        .to.be.revertedWithCustomError(trace, "ShipmentAlreadyReceived")
        .withArgs(1n);
    });
  });

  describe("verification data (what the backend will rely on)", () => {
    it("distinguishes 'receipt missing' from 'receipt confirmed' using on-chain state and events", async () => {
      const { trace, distributorB } = await networkHelpers.loadFixture(shippedFixture);

      // Before receipt: shipment exists, but there is no ReceiptConfirmed event.
      let [, shipment] = await trace.getShipment(1n);
      expect(shipment.receivedAt).to.equal(0n);
      expect(await trace.queryFilter(trace.filters.ReceiptConfirmed(1n))).to.have.length(0);

      await trace.connect(distributorB).confirmReceipt(1n);

      [, shipment] = await trace.getShipment(1n);
      expect(shipment.receivedAt).to.be.greaterThan(0n);
      expect(await trace.queryFilter(trace.filters.ReceiptConfirmed(1n))).to.have.length(1);
    });

    it("keeps records readable after revocation and lets history be replayed in block order", async () => {
      const { trace, admin, supplierA } = await networkHelpers.loadFixture(registeredBatchFixture);
      await trace.connect(admin).revokeSupplier(supplierA.address);

      // Current state: no longer authorised. Historic registration: still there.
      expect(await trace.isSupplier(supplierA.address)).to.equal(false);
      const [exists, batch] = await trace.getBatch(BATCH_ID);
      expect(exists).to.equal(true);

      // Replaying supplier events proves the supplier WAS authorised at registration time.
      const approved = await trace.queryFilter(trace.filters.SupplierApproved(supplierA.address));
      const revoked = await trace.queryFilter(trace.filters.SupplierRevoked(supplierA.address));
      expect(approved).to.have.length(1);
      expect(revoked).to.have.length(1);
      expect(BigInt(approved[0].blockNumber)).to.be.lessThan(batch.registeredBlock);
      expect(BigInt(revoked[0].blockNumber)).to.be.greaterThan(batch.registeredBlock);
    });

    it("does not let one batch's records leak into another", async () => {
      const { trace, supplierA } = await networkHelpers.loadFixture(shippedFixture);
      await trace.connect(supplierA).registerBatch(OTHER_BATCH_ID, ethers.id("other"));
      expect(await trace.getBatchShipmentIds(OTHER_BATCH_ID)).to.deep.equal([]);
      expect(await trace.getBatchShipmentIds(BATCH_ID)).to.deep.equal([1n]);
    });
  });

  describe("end-to-end flow", () => {
    it("admin approves -> supplier registers -> supplier ships -> distributor confirms", async () => {
      const { trace, admin, supplierA, distributorB } = await networkHelpers.loadFixture(deployFixture);

      await trace.connect(admin).approveSupplier(supplierA.address);
      await trace.connect(supplierA).registerBatch(BATCH_ID, METADATA_HASH);
      await trace.connect(supplierA).recordShipment(BATCH_ID, distributorB.address);
      await trace.connect(distributorB).confirmReceipt(1n);

      const [batchExists, batch] = await trace.getBatch(BATCH_ID);
      const [shipExists, shipment] = await trace.getShipment(1n);
      expect(batchExists).to.equal(true);
      expect(shipExists).to.equal(true);
      expect(batch.supplier).to.equal(supplierA.address);
      expect(batch.metadataHash).to.equal(METADATA_HASH);
      expect(shipment.recipient).to.equal(distributorB.address);
      expect(shipment.receivedAt).to.be.greaterThan(0n);

      // Events occurred in the expected order.
      const events = [
        ...(await trace.queryFilter(trace.filters.SupplierApproved())),
        ...(await trace.queryFilter(trace.filters.BatchRegistered())),
        ...(await trace.queryFilter(trace.filters.ShipmentRecorded())),
        ...(await trace.queryFilter(trace.filters.ReceiptConfirmed())),
      ].map((e) => e.blockNumber);
      expect(events).to.deep.equal([...events].sort((a, b) => a - b));
      expect(new Set(events).size).to.equal(4);
    });
  });
});
