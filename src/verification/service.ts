import { id as keccakText } from "ethers";
import { hashMetadata, isHash, type MetadataStore } from "../metadata/store.js";
import { verifyBatch } from "./engine.js";
import type { ChainEvidence, MetadataEvidence, VerificationReport, VerifyOptions } from "./types.js";

/** Anything that can gather chain evidence for a batch (the real ChainReader, or a fake in tests). */
export interface EvidenceSource {
  collect(batchId: string): Promise<ChainEvidence>;
}

export class BadRequestError extends Error {}

/**
 * Turns what a person or QR code gives us into the bytes32 id used on-chain.
 *  - "0x" + 64 hex characters is used as-is.
 *  - Anything else (e.g. "BATCH-2026-0001") is hashed with keccak256, exactly like
 *    `ethers.id("BATCH-2026-0001")` which is how the tests and demo create batch ids.
 */
export function toBatchId(input: string): string {
  const text = input.trim();
  if (text.length === 0 || text.length > 128) throw new BadRequestError("Batch identifier must be 1-128 characters");
  return isHash(text) ? text.toLowerCase() : keccakText(text);
}

/** Glue: gather chain evidence + metadata evidence, then run the pure engine. */
export class VerificationService {
  constructor(
    private readonly source: EvidenceSource,
    private readonly store: MetadataStore,
  ) {}

  async verify(input: string, options: VerifyOptions = {}): Promise<VerificationReport> {
    const batchId = toBatchId(input);
    const chain = await this.source.collect(batchId);

    let metadata: MetadataEvidence = { found: false };
    if (chain.batch.exists) {
      const content = await this.store.get(chain.batch.metadataHash);
      if (content !== undefined) {
        // Recompute from the retrieved content; never trust a stored label.
        metadata = { found: true, computedHash: hashMetadata(content) };
      }
    }
    return verifyBatch(chain, metadata, options);
  }
}
