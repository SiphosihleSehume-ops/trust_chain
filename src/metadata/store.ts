import { keccak256, toUtf8Bytes } from "ethers";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

/**
 * Off-chain metadata, stored by its hash ("content-addressed").
 *
 * The supplier commits `hashMetadata(metadata)` on-chain. Anyone can later fetch the metadata
 * and recompute the hash. If they match, the data is exactly what was committed.
 *
 * Important: this proves INTEGRITY only. It does not prove the claims in the metadata are true.
 */

const HASH_RE = /^0x[0-9a-fA-F]{64}$/;

export const isHash = (value: string): boolean => HASH_RE.test(value);

/**
 * Canonical JSON: object keys sorted recursively, no whitespace. Two systems that build the
 * same data in a different key order still get the same hash.
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([k, v]) => [k, sortKeys(v)]),
    );
  }
  return value;
}

/** keccak256 of the canonical JSON text. This is the value a supplier commits on-chain. */
export function hashMetadata(value: unknown): string {
  return keccak256(toUtf8Bytes(canonicalJson(value)));
}

export interface MetadataStore {
  save(metadata: unknown): Promise<string>;
  get(hash: string): Promise<unknown | undefined>;
}

/** Simple store: one JSON file per metadata record, named by its hash. */
export class FileMetadataStore implements MetadataStore {
  constructor(private readonly dir: string) {}

  private fileFor(hash: string): string {
    // Only accept a strict 0x + 64 hex hash, so a caller can never smuggle in a path like "../../x".
    if (!isHash(hash)) throw new Error("Invalid metadata hash");
    return path.join(this.dir, `${hash.toLowerCase()}.json`);
  }

  async save(metadata: unknown): Promise<string> {
    const hash = hashMetadata(metadata);
    await mkdir(this.dir, { recursive: true });
    await writeFile(this.fileFor(hash), canonicalJson(metadata), "utf8");
    return hash;
  }

  async get(hash: string): Promise<unknown | undefined> {
    try {
      return JSON.parse(await readFile(this.fileFor(hash), "utf8"));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw err;
    }
  }
}
