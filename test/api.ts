import { expect } from "chai";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { createApp } from "../src/app.js";
import { hashMetadata, type MetadataStore } from "../src/metadata/store.js";
import { VerificationService, type EvidenceSource } from "../src/verification/service.js";
import type { ChainEvidence } from "../src/verification/types.js";

class MemoryStore implements MetadataStore {
  private data = new Map<string, unknown>();
  async save(m: unknown) {
    const h = hashMetadata(m);
    this.data.set(h, m);
    return h;
  }
  async get(h: string) {
    return this.data.get(h);
  }
}

const notFound = (batchId: string): ChainEvidence => ({
  checkedAtBlock: 7,
  batchId,
  batch: { exists: false, supplier: "0x" + "0".repeat(40), metadataHash: "0x" + "0".repeat(64), registeredAt: 0, registeredBlock: 0 },
  supplierEvents: [],
  currentlyAuthorised: false,
  shipments: [],
});

describe("HTTP API", () => {
  let server: Server;
  let base: string;
  let chainDown = false;

  const source: EvidenceSource = {
    async collect(batchId) {
      if (chainDown) throw new Error("connect ECONNREFUSED 127.0.0.1:8545");
      return notFound(batchId);
    },
  };

  before(async () => {
    const store = new MemoryStore();
    server = createApp(new VerificationService(source, store), store, () => {}).listen(0);
    await new Promise((r) => server.once("listening", r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  after(() => {
    server.close();
  });
  beforeEach(() => {
    chainDown = false;
  });

  it("serves the verification page and its assets", async () => {
    const page = await fetch(`${base}/`);
    expect(page.status).to.equal(200);
    expect(page.headers.get("content-type")).to.match(/text\/html/);
    expect(await page.text()).to.contain("<title>");
    expect((await fetch(`${base}/app.js`)).status).to.equal(200);
    expect((await fetch(`${base}/style.css`)).status).to.equal(200);
    expect((await fetch(`${base}/vendor/qrcode.js`)).status).to.equal(200);
  });

  it("GET /api/health", async () => {
    const res = await fetch(`${base}/api/health`);
    expect(res.status).to.equal(200);
    expect(await res.json()).to.deep.equal({ ok: true });
  });

  it("returns a structured not_found report, with limitations, for an unknown batch", async () => {
    const res = await fetch(`${base}/api/verify/BATCH-NOPE`);
    expect(res.status).to.equal(200);
    const body = (await res.json()) as { overall: string; limitations: string[]; checkedAtBlock: number };
    expect(body.overall).to.equal("not_found");
    expect(body.checkedAtBlock).to.equal(7);
    expect(body.limitations.length).to.be.greaterThan(0);
  });

  it("rejects an invalid expectedRecipient with 400", async () => {
    const res = await fetch(`${base}/api/verify/BATCH-1?expectedRecipient=not-an-address`);
    expect(res.status).to.equal(400);
  });

  it("rejects an over-long batch identifier with 400", async () => {
    const res = await fetch(`${base}/api/verify/${"x".repeat(200)}`);
    expect(res.status).to.equal(400);
  });

  it("answers 502 (and NO verification result) when the chain cannot be read", async () => {
    chainDown = true;
    const res = await fetch(`${base}/api/verify/BATCH-1`);
    expect(res.status).to.equal(502);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).to.not.have.property("overall");
    expect(JSON.stringify(body)).to.not.contain("ECONNREFUSED"); // no internal details leaked
  });

  it("stores metadata and returns the same hash a supplier would compute", async () => {
    const data = { product: "Oil", lot: "A1" };
    const res = await fetch(`${base}/api/metadata`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(data),
    });
    expect(res.status).to.equal(201);
    const { hash } = (await res.json()) as { hash: string };
    expect(hash).to.equal(hashMetadata(data));

    const got = await fetch(`${base}/api/metadata/${hash}`);
    expect(got.status).to.equal(200);
    expect(await got.json()).to.deep.equal(data);
  });

  it("rejects bad metadata bodies", async () => {
    const post = (body: string) =>
      fetch(`${base}/api/metadata`, { method: "POST", headers: { "content-type": "application/json" }, body });
    expect((await post("[1,2,3]")).status).to.equal(400);
    expect((await post("{}")).status).to.equal(400);
    expect((await post("{not json")).status).to.equal(400);
    expect((await post(JSON.stringify({ blob: "x".repeat(200_000) }))).status).to.equal(413);
  });

  it("GET /api/metadata validates and 404s", async () => {
    expect((await fetch(`${base}/api/metadata/not-a-hash`)).status).to.equal(400);
    expect((await fetch(`${base}/api/metadata/0x${"ab".repeat(32)}`)).status).to.equal(404);
  });
});
