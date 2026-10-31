import { Contract, EventLog, type Log, type Provider, getAddress } from "ethers";
import { TRACEABILITY_ABI } from "./abi.js";
import type {
  ChainEvidence,
  ReceiptConfirmedEvent,
  ShipmentEvidence,
  ShipmentRecordedEvent,
  SupplierEvent,
} from "../verification/types.js";

/**
 * Collects raw evidence about one batch from the chain. It makes NO judgements:
 * deciding what the evidence means is the engine's job.
 *
 * All reads use the same block number, so the evidence is a consistent snapshot even if
 * new blocks arrive while we are reading.
 */
export interface ChainReaderOptions {
  provider: Provider;
  contractAddress: string;
  /** First block to scan for events (the deploy block). Scanning from 0 on Sepolia is slow. */
  fromBlock?: number;
  /** Max blocks per getLogs call. Public RPC providers usually cap this (often 10,000 or less). */
  chunkSize?: number;
}

export class ChainReader {
  private readonly contract: Contract;
  private readonly provider: Provider;
  private readonly fromBlock: number;
  private readonly chunkSize: number;

  constructor(opts: ChainReaderOptions) {
    this.provider = opts.provider;
    this.contract = new Contract(getAddress(opts.contractAddress), TRACEABILITY_ABI, opts.provider);
    this.fromBlock = opts.fromBlock ?? 0;
    this.chunkSize = opts.chunkSize ?? 5000;
  }

  async collect(batchId: string): Promise<ChainEvidence> {
    const toBlock = await this.provider.getBlockNumber();
    const blockTag = toBlock;

    const [exists, b] = await this.contract.getBatch(batchId, { blockTag });
    const batch = {
      exists: Boolean(exists),
      supplier: b.supplier as string,
      metadataHash: b.metadataHash as string,
      registeredAt: Number(b.registeredAt),
      registeredBlock: Number(b.registeredBlock),
    };

    if (!batch.exists) {
      return {
        checkedAtBlock: toBlock,
        batchId,
        batch,
        supplierEvents: [],
        currentlyAuthorised: false,
        shipments: [],
      };
    }

    const [registeredLogs, approvedLogs, revokedLogs, currentlyAuthorised, shipmentIds] = await Promise.all([
      this.query(this.contract.filters.BatchRegistered(batchId), toBlock),
      this.query(this.contract.filters.SupplierApproved(batch.supplier), toBlock),
      this.query(this.contract.filters.SupplierRevoked(batch.supplier), toBlock),
      this.contract.isSupplier(batch.supplier, { blockTag }) as Promise<boolean>,
      this.contract.getBatchShipmentIds(batchId, { blockTag }) as Promise<bigint[]>,
    ]);

    const registered = registeredLogs[0];
    const supplierEvents: SupplierEvent[] = [
      ...approvedLogs.map((l): SupplierEvent => ({
        type: "approved",
        supplier: l.args.supplier as string,
        blockNumber: l.blockNumber,
        logIndex: l.index,
      })),
      ...revokedLogs.map((l): SupplierEvent => ({
        type: "revoked",
        supplier: l.args.supplier as string,
        blockNumber: l.blockNumber,
        logIndex: l.index,
      })),
    ];

    const shipments: ShipmentEvidence[] = [];
    for (const id of shipmentIds) {
      const [, s] = await this.contract.getShipment(id, { blockTag });
      const [recordedLogs, receiptLogs] = await Promise.all([
        this.query(this.contract.filters.ShipmentRecorded(id), toBlock),
        this.query(this.contract.filters.ReceiptConfirmed(id), toBlock),
      ]);
      const rec = recordedLogs[0];
      const rcp = receiptLogs[0];
      shipments.push({
        state: {
          id: Number(id),
          batchId: s.batchId as string,
          sender: s.sender as string,
          recipient: s.recipient as string,
          shippedAt: Number(s.shippedAt),
          shippedBlock: Number(s.shippedBlock),
          receivedAt: Number(s.receivedAt),
          receivedBlock: Number(s.receivedBlock),
        },
        ...(rec
          ? {
              recordedEvent: {
                shipmentId: Number(rec.args.shipmentId),
                batchId: rec.args.batchId as string,
                sender: rec.args.sender as string,
                recipient: rec.args.recipient as string,
                blockNumber: rec.blockNumber,
                logIndex: rec.index,
              } satisfies ShipmentRecordedEvent,
            }
          : {}),
        ...(rcp
          ? {
              receiptEvent: {
                shipmentId: Number(rcp.args.shipmentId),
                batchId: rcp.args.batchId as string,
                recipient: rcp.args.recipient as string,
                blockNumber: rcp.blockNumber,
                logIndex: rcp.index,
              } satisfies ReceiptConfirmedEvent,
            }
          : {}),
      });
    }

    return {
      checkedAtBlock: toBlock,
      batchId,
      batch,
      ...(registered
        ? {
            registeredEvent: {
              batchId: registered.args.batchId as string,
              supplier: registered.args.supplier as string,
              metadataHash: registered.args.metadataHash as string,
              blockNumber: registered.blockNumber,
              logIndex: registered.index,
            },
          }
        : {}),
      supplierEvents,
      currentlyAuthorised,
      shipments,
    };
  }

  /** getLogs in chunks, because RPC providers reject very large block ranges. */
  private async query(filter: Parameters<Contract["queryFilter"]>[0], toBlock: number): Promise<EventLog[]> {
    const out: EventLog[] = [];
    for (let from = this.fromBlock; from <= toBlock; from += this.chunkSize) {
      const to = Math.min(from + this.chunkSize - 1, toBlock);
      const logs: Array<EventLog | Log> = await this.contract.queryFilter(filter, from, to);
      for (const l of logs) if (l instanceof EventLog) out.push(l);
    }
    return out;
  }
}
