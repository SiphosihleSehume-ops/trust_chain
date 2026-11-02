import { expect } from "chai";
import hre, { network } from "hardhat";
import { EventFragment, FunctionFragment, Interface } from "ethers";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { TRACEABILITY_ABI } from "../src/chain/abi.js";
import { ChainReader } from "../src/chain/reader.js";
import { FileMetadataStore, hashMetadata } from "../src/metadata/store.js";
import { VerificationService } from "../src/verification/service.js";
import type { Check, VerificationReport } from "../src/verification/types.js";

const { ethers, networkHelpers } = await network.getOrCreate();

const LABEL = "BATCH-2026-0001";
const BATCH_ID = ethers.id(LABEL);
const METADATA = { product: "Premium Olive Oil 500ml", lot: "A1", documentHash: ethers.id("certificate.pdf") };

const statusOf = (r: VerificationReport, id: string): Check["status"] => {
  const c = r.checks.find((x) => x.id === id);
  if (!c) throw new Error(`check ${id} missing`);
  return c.status;
};

describe("chain reader + engine against the real contract", () => {
  let dir: string;
  let store: FileMetadataStore;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), "trace-meta-"));
    store = new FileMetadataStore(dir);
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  async function deployFixture() {
    const [admin, supplierA, distributorB, stranger] = await ethers.getSigners();
    const trace = await ethers.deployContract("ProductTraceability", [admin.address]);
    return { trace, admin, supplierA, distributorB, stranger, address: await trace.getAddress() };
  }

  /** admin approves supplier, supplier registers LABEL committing hashMetadata(METADATA). */
  async function registeredFixture() {
    const ctx = await deployFixture();
    await ctx.trace.connect(ctx.admin).approveSupplier(ctx.supplierA.address);
    await ctx.trace.connect(ctx.supplierA).registerBatch(BATCH_ID, hashMetadata(METADATA));
    return ctx;
  }

  async function shippedFixture() {
    const ctx = await registeredFixture();
    await ctx.trace.connect(ctx.supplierA).recordShipment(BATCH_ID, ctx.distributorB.address);
    return ctx;
  }

  async function receivedFixture() {
    const ctx = await shippedFixture();
    await ctx.trace.connect(ctx.distributorB).confirmReceipt(1n);
    return ctx;
  }

  const serviceFor = (address: string, opts: { fromBlock?: number; chunkSize?: number } = {}) =>
    new VerificationService(
      new ChainReader({ provider: ethers.provider, contractAddress: address, ...opts }),
      store,
    );

  it("keeps src/chain/abi.ts in sync with the compiled contract", async () => {
    const artifact = await hre.artifacts.readArtifact("ProductTraceability");
    const compiled = new Interface(artifact.abi);
    const mine = new Interface(TRACEABILITY_ABI);
    let checked = 0;
    for (const f of mine.fragments) {
      if (f instanceof FunctionFragment) {
        const real = compiled.getFunction(f.selector);
        expect(real, `function ${f.name}`).to.not.equal(null);
        expect(f.outputs.map((o) => o.format("sighash"))).to.deep.equal(real!.outputs.map((o) => o.format("sighash")));
        checked++;
      } else if (f instanceof EventFragment) {
        const real = compiled.getEvent(f.topicHash);
        expect(real, `event ${f.name}`).to.not.equal(null);
        // `indexed` is false in one parser and null in the other for non-indexed inputs.
        expect(f.inputs.map((i) => Boolean(i.indexed))).to.deep.equal(real!.inputs.map((i) => Boolean(i.indexed)));
        checked++;
      }
    }
    expect(checked).to.equal(9);
  });

  it("verifies a complete, confirmed supply chain end to end", async () => {
    const { address, distributorB } = await networkHelpers.loadFixture(receivedFixture);
    await store.save(METADATA);
    const r = await serviceFor(address).verify(LABEL, { expectedRecipient: distributorB.address });
    expect(r.overall).to.equal("verified");
    expect(r.shipments).to.have.length(1);
    expect(r.shipments[0].receiptConfirmed).to.equal(true);
    expect(r.checkedAtBlock).to.be.greaterThan(0);
  });

  it("accepts the raw bytes32 id as well as the readable label", async () => {
    const { address } = await networkHelpers.loadFixture(receivedFixture);
    await store.save(METADATA);
    const r = await serviceFor(address).verify(BATCH_ID);
    expect(r.overall).to.equal("verified");
  });

  it("reports 'incomplete' when shipped but the distributor has not confirmed", async () => {
    const { address } = await networkHelpers.loadFixture(shippedFixture);
    await store.save(METADATA);
    const r = await serviceFor(address).verify(LABEL);
    expect(r.overall).to.equal("incomplete");
    expect(statusOf(r, "shipment_recorded")).to.equal("verified");
    expect(statusOf(r, "receipt_confirmed")).to.equal("missing");
    expect(r.summary).to.contain("Delivery confirmation is missing.");
  });

  it("reports 'not_found' for an identifier that was never registered", async () => {
    const { address } = await networkHelpers.loadFixture(deployFixture);
    const r = await serviceFor(address).verify("NEVER-REGISTERED");
    expect(r.overall).to.equal("not_found");
  });

  it("is 'incomplete' (not verified) when the off-chain metadata cannot be found", async () => {
    const { address } = await networkHelpers.loadFixture(receivedFixture);
    // metadata deliberately NOT saved
    const r = await serviceFor(address).verify(LABEL);
    expect(r.overall).to.equal("incomplete");
    expect(statusOf(r, "metadata_hash_matches")).to.equal("missing");
  });

  it("is 'suspicious' when stored metadata was altered after it was committed", async () => {
    const { address } = await networkHelpers.loadFixture(receivedFixture);
    const hash = await store.save(METADATA);
    // Someone swaps the file contents but keeps the file name (the committed hash).
    await writeFile(path.join(dir, `${hash}.json`), JSON.stringify({ ...METADATA, lot: "FORGED" }), "utf8");
    const r = await serviceFor(address).verify(LABEL);
    expect(r.overall).to.equal("suspicious");
    expect(statusOf(r, "metadata_hash_matches")).to.equal("failed");
  });

  it("is 'suspicious' when the expected recipient differs from the shipment", async () => {
    const { address, stranger } = await networkHelpers.loadFixture(receivedFixture);
    await store.save(METADATA);
    const r = await serviceFor(address).verify(LABEL, { expectedRecipient: stranger.address });
    expect(r.overall).to.equal("suspicious");
    expect(statusOf(r, "expected_recipient_matches")).to.equal("failed");
  });

  it("stays verified, with a warning, if the supplier is revoked after registering", async () => {
    const { address, trace, admin, supplierA } = await networkHelpers.loadFixture(receivedFixture);
    await trace.connect(admin).revokeSupplier(supplierA.address);
    await store.save(METADATA);
    const r = await serviceFor(address).verify(LABEL);
    expect(r.overall).to.equal("verified");
    expect(statusOf(r, "supplier_authorised_at_registration")).to.equal("verified");
    expect(r.warnings.join(" ")).to.match(/revoked/);
    expect(r.batch?.supplierCurrentlyAuthorised).to.equal(false);
  });

  it("gives the same answer when logs are fetched in tiny chunks", async () => {
    const { address } = await networkHelpers.loadFixture(receivedFixture);
    await store.save(METADATA);
    const big = await serviceFor(address, { chunkSize: 5000 }).verify(LABEL);
    const tiny = await serviceFor(address, { chunkSize: 1 }).verify(LABEL);
    expect(tiny).to.deep.equal(big);
  });

  it("never claims 'verified' if the scan starts too late and misses events", async () => {
    const { address } = await networkHelpers.loadFixture(receivedFixture);
    await store.save(METADATA);
    const tip = await ethers.provider.getBlockNumber();
    const r = await serviceFor(address, { fromBlock: tip }).verify(LABEL); // misconfigured DEPLOY_BLOCK
    expect(r.overall).to.not.equal("verified");
    expect(statusOf(r, "supplier_authorised_at_registration")).to.equal("missing");
  });

  it("tracks a second shipment after the first is confirmed", async () => {
    const { address, trace, supplierA, stranger } = await networkHelpers.loadFixture(receivedFixture);
    await trace.connect(supplierA).recordShipment(BATCH_ID, stranger.address);
    await store.save(METADATA);
    const r = await serviceFor(address).verify(LABEL);
    expect(r.shipments).to.have.length(2);
    expect(statusOf(r, "receipt_confirmed")).to.equal("missing"); // latest shipment not yet confirmed
    expect(statusOf(r, "event_sequence")).to.equal("verified");
    expect(r.overall).to.equal("incomplete");
  });
});
