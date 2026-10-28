import "dotenv/config";
import { configVariable, defineConfig } from "hardhat/config";
import hardhatToolboxMochaEthers from "@nomicfoundation/hardhat-toolbox-mocha-ethers";

export default defineConfig({
  plugins: [hardhatToolboxMochaEthers],
  solidity: {
    version: "0.8.28",
    // Optional: set SOLC_JS_PATH=node_modules/solc/soljson.js only if your network
    // blocks the official compiler download (binaries.soliditylang.org).
    ...(process.env.SOLC_JS_PATH ? { path: process.env.SOLC_JS_PATH } : {}),
    settings: {
      optimizer: { enabled: true, runs: 200 },
    },
  },
  networks: {
    // `npx hardhat node` starts a persistent local chain at this URL.
    localhost: {
      type: "http",
      chainType: "l1",
      url: "http://127.0.0.1:8545",
    },
    // Sepolia is only contacted when you pass `--network sepolia`.
    // Secrets are read from environment variables (see .env.example).
    sepolia: {
      type: "http",
      chainType: "l1",
      url: configVariable("SEPOLIA_RPC_URL"),
      accounts: [configVariable("SEPOLIA_PRIVATE_KEY")],
    },
  },
});
