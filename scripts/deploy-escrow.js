import { ethers } from "ethers";
import fs from "fs";
import path from "path";

function loadEnvFile() {
  const envPath = path.resolve(".env");
  if (!fs.existsSync(envPath)) return;

  for (const rawLine of fs.readFileSync(envPath, "utf8").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    const value = line.slice(eq + 1).trim().replace(/^["']|["']$/g, "");
    if (!process.env[key]) process.env[key] = value;
  }
}

function requireEnv(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing ${name}. Add it to .env or set it in your shell.`);
  return value;
}

async function main() {
  loadEnvFile();

  const rpcUrl = process.env.BASE_RPC_URL || "https://mainnet.base.org";
  const deployerPrivateKey = requireEnv("DEPLOYER_PRIVATE_KEY");
  const feeRecipient = requireEnv("FEE_RECIPIENT");

  const signerAddress = process.env.SIGNER_ADDRESS ||
    (process.env.SIGNER_PRIVATE_KEY ? new ethers.Wallet(process.env.SIGNER_PRIVATE_KEY).address : null);

  if (!signerAddress) {
    throw new Error("Missing SIGNER_ADDRESS or SIGNER_PRIVATE_KEY. This must match the 1v1 server signer.");
  }
  if (!ethers.isAddress(feeRecipient)) throw new Error("FEE_RECIPIENT is not a valid address.");
  if (!ethers.isAddress(signerAddress)) throw new Error("SIGNER_ADDRESS is not a valid address.");

  const artifactPath = path.resolve("./artifacts/contracts/SimonStakeEscrow.sol/SimonStakeEscrow.json");
  const artifact = JSON.parse(fs.readFileSync(artifactPath, "utf8"));

  const provider = new ethers.JsonRpcProvider(rpcUrl);
  const wallet = new ethers.Wallet(deployerPrivateKey, provider);
  const balance = await provider.getBalance(wallet.address);

  console.log("Network RPC:", rpcUrl);
  console.log("Deploying with:", wallet.address);
  console.log("Deployer balance:", ethers.formatEther(balance), "ETH");
  console.log("Server signer:", signerAddress);
  console.log("Fee recipient:", feeRecipient);

  const factory = new ethers.ContractFactory(artifact.abi, artifact.bytecode, wallet);
  const contract = await factory.deploy(signerAddress, feeRecipient);
  console.log("Deployment tx:", contract.deploymentTransaction().hash);

  await contract.waitForDeployment();
  const address = await contract.getAddress();
  console.log("SimonStakeEscrow deployed to:", address);
  console.log("");
  console.log("Paste this into base-simon.js:");
  console.log(`const STAKE_ESCROW_ADDRESS = "${address}";`);
}

main().catch((error) => {
  console.error("Deployment failed:", error);
  process.exitCode = 1;
});
