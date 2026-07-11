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
  const signerAddress = process.env.SIGNER_ADDRESS ||
    (process.env.SIGNER_PRIVATE_KEY ? new ethers.Wallet(process.env.SIGNER_PRIVATE_KEY).address : null);

  if (!signerAddress || !ethers.isAddress(signerAddress)) {
    throw new Error("Missing or invalid SIGNER_ADDRESS/SIGNER_PRIVATE_KEY.");
  }

  const artifactPath = path.resolve("./artifacts/contracts/SimonOnBaseVerified.sol/SimonOnBaseVerified.json");
  const artifact = JSON.parse(fs.readFileSync(artifactPath, "utf8"));
  const provider = new ethers.JsonRpcProvider(rpcUrl);
  const wallet = new ethers.Wallet(deployerPrivateKey, provider);
  const balance = await provider.getBalance(wallet.address);

  console.log("Deploying verified score contract with:", wallet.address);
  console.log("Deployer balance:", ethers.formatEther(balance), "ETH");
  console.log("Server signer:", signerAddress);

  const factory = new ethers.ContractFactory(artifact.abi, artifact.bytecode, wallet);
  if (process.argv.includes("--estimate")) {
    const deployment = await factory.getDeployTransaction(signerAddress);
    const gas = await provider.estimateGas({ ...deployment, from: wallet.address });
    const feeData = await provider.getFeeData();
    const gasPrice = feeData.maxFeePerGas || feeData.gasPrice;
    console.log("Estimated gas:", gas.toString());
    console.log("Maximum estimated deployment cost:", ethers.formatEther(gas * gasPrice), "ETH");
    return;
  }

  const contract = await factory.deploy(signerAddress);
  console.log("Deployment tx:", contract.deploymentTransaction().hash);
  await contract.waitForDeployment();

  const address = await contract.getAddress();
  console.log("SimonOnBaseVerified deployed to:", address);
  console.log(`Set CONTRACT_ADDRESS in base-simon.js to "${address}".`);
  console.log(`Set SCORE_CONTRACT_ADDRESS in the match server environment to "${address}", then restart it.`);
}

main().catch((error) => {
  console.error("Verified score deployment failed:", error.message || error);
  process.exitCode = 1;
});
