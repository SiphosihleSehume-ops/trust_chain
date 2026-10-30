# Product Traceability – Phase 1 (Smart Contract)

A prototype Ethereum contract for batch registration, shipment records and receipt
confirmation. A later verification engine (Phase 2) reads these records and runs
deterministic checks. **AI is never the source of truth.**

## What the contract does

| Role | Can do |
|------|--------|
| Admin (`DEFAULT_ADMIN_ROLE`, OpenZeppelin `AccessControl`) | `approveSupplier`, `revokeSupplier` |
| Approved supplier | `registerBatch(batchId, metadataHash)`, `recordShipment(batchId, recipient)` |
| Recipient wallet named in a shipment | `confirmReceipt(shipmentId)` |
| Anyone (read-only) | `getBatch`, `getShipment`, `getBatchShipmentIds`, `isSupplier`, `shipmentCount`, and all events |

Events: `SupplierApproved`, `SupplierRevoked`, `BatchRegistered`, `ShipmentRecorded`, `ReceiptConfirmed`.

### Rules enforced on-chain
- Only the admin can approve/revoke suppliers; wallets cannot approve themselves.
- Batch ids are globally unique; zero ids/hashes are rejected.
- Only the supplier that registered a batch can ship it, and only while still approved.
- Recipient cannot be the zero address or the sender.
- A batch has at most one unconfirmed shipment at a time.
- Only the named recipient can confirm receipt, once.

### What it does NOT prove (keep these visible in the UI)
- A record on-chain is not proof the supplier told the truth.
- A shipment event is not proof of physical delivery; only the recipient's own receipt confirmation counts.
- A matching metadata hash proves data integrity, not that the claims are true.
- A QR code can be copied onto a counterfeit item.
- `isSupplier` is the *current* status. "Authorised at registration" is checked by replaying
  `SupplierApproved`/`SupplierRevoked` events against `Batch.registeredBlock` (Phase 2).
- Any address can be named as a recipient (no distributor registry in the MVP).

## Commands

```bash
npm install
npm run compile       # compile
npm test              # 28 tests
npm run typecheck     # TypeScript check
```

If your network blocks `binaries.soliditylang.org` (compiler download), use the bundled
solc-js fallback:

```bash
SOLC_JS_PATH=node_modules/solc/soljson.js npm test
```

### Deploy locally

```bash
npx hardhat run scripts/deploy.ts          # throwaway in-process chain

npm run node                                # terminal 1: persistent local chain
npm run deploy:local                        # terminal 2: deploys, writes deployments/localhost.json
```

### Deploy to Sepolia
1. `cp .env.example .env` and fill in `SEPOLIA_RPC_URL` and `SEPOLIA_PRIVATE_KEY` (a throwaway wallet with test ETH).
2. `npm run deploy:sepolia`

`deployments/<network>.json` stores the real address and deploy block for the backend to use.
Never commit `.env`.

## Project layout
```
contracts/ProductTraceability.sol   the contract
test/ProductTraceability.ts         tests
scripts/deploy.ts                   deploy script
hardhat.config.ts                   Hardhat 3 config
.env.example                        env template (no real secrets)
```

## Run 

```bash
npm install --save-dev @types/node
```
to install necessary node modules

## 

```bash
npx hardhat run scripts/deploy.ts                      (throwaway in-process network)

npx hardhat run scripts/deploy.ts --network localhost  (needs `npx hardhat node` running)

npx hardhat run scripts/deploy.ts --network sepolia    (needs .env, see .env.example)
```