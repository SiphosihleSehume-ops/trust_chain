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