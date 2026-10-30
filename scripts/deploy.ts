import { mkdirSync, writeFileSync } from "node:fs";
import { network } from "hardhat";

const { ethers, networkName } = await network.getOrCreate();

const [deployer] = await ethers.getSigners();

// The admin approves/revokes suppliers. Defaults to the deployer; set ADMIN_ADDRESS to
// hand control to another wallet (e.g. a multisig) from the start.
const admin = process.env.ADMIN_ADDRESS ?? deployer.address;
if (!ethers.isAddress(admin)) {
  throw new Error(`ADMIN_ADDRESS is not a valid address: ${admin}`);
}

console.log(`Network:  ${networkName}`);
console.log(`Deployer: ${deployer.address}`);
console.log(`Admin:    ${admin}`);

const trace = await ethers.deployContract("ProductTraceability", [admin]);
const receipt = await trace.deploymentTransaction()?.wait();
const address = await trace.getAddress();
const chainId = (await ethers.provider.getNetwork()).chainId;

console.log(`ProductTraceability deployed to: ${address}`);

// Saved so the backend (Phase 2) can read the address + the block to start scanning events from.
mkdirSync("deployments", { recursive: true });
writeFileSync(
  `deployments/${networkName}.json`,
  JSON.stringify(
    {
      contract: "ProductTraceability",
      network: networkName,
      chainId: chainId.toString(),
      address,
      admin,
      deployer: deployer.address,
      deployBlock: receipt?.blockNumber ?? null,
      deployTxHash: receipt?.hash ?? null,
    },
    null,
    2,
  ) + "\n",
);
console.log(`Saved deployments/${networkName}.json`);
