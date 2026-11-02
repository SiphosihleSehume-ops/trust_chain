import { expect } from "chai";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { keccak256, toUtf8Bytes } from "ethers";
import { canonicalJson, FileMetadataStore, hashMetadata, isHash } from "../src/metadata/store.js";

describe("metadata store", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), "trace-store-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("produces the same hash regardless of key order (including nested objects)", () => {
    const a = { product: "Oil", lot: "A1", extra: { x: 1, y: [1, 2, { b: 2, a: 1 }] } };
    const b = { extra: { y: [1, 2, { a: 1, b: 2 }], x: 1 }, lot: "A1", product: "Oil" };
    expect(hashMetadata(a)).to.equal(hashMetadata(b));
  });

  it("changes the hash when any value changes, and when array order changes", () => {
    expect(hashMetadata({ lot: "A1" })).to.not.equal(hashMetadata({ lot: "A2" }));
    expect(hashMetadata({ l: [1, 2] })).to.not.equal(hashMetadata({ l: [2, 1] }));
  });

  it("hashes the canonical JSON text with keccak256 (so other systems can reproduce it)", () => {
    const value = { b: 1, a: 2 };
    expect(canonicalJson(value)).to.equal('{"a":2,"b":1}');
    expect(hashMetadata(value)).to.equal(keccak256(toUtf8Bytes('{"a":2,"b":1}')));
  });

  it("saves and retrieves metadata by its hash", async () => {
    const store = new FileMetadataStore(dir);
    const data = { product: "Oil", lot: "A1" };
    const hash = await store.save(data);
    expect(hash).to.equal(hashMetadata(data));
    expect(await store.get(hash)).to.deep.equal(data);
    expect(await store.get(hash.toUpperCase().replace("0X", "0x"))).to.deep.equal(data); // case-insensitive
  });

  it("returns undefined for a hash that was never stored", async () => {
    expect(await new FileMetadataStore(dir).get("0x" + "ab".repeat(32))).to.equal(undefined);
  });

  it("rejects anything that is not a strict 32-byte hash (no path traversal)", async () => {
    const store = new FileMetadataStore(dir);
    for (const bad of ["../../etc/passwd", "0x1234", "../" + "a".repeat(64), "", "0x" + "zz".repeat(32)]) {
      let threw = false;
      try {
        await store.get(bad);
      } catch {
        threw = true;
      }
      expect(threw, `should reject ${JSON.stringify(bad)}`).to.equal(true);
    }
    expect(isHash("0x" + "ab".repeat(32))).to.equal(true);
    expect(isHash("0x" + "ab".repeat(31))).to.equal(false);
  });
});
