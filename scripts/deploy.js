import { ethers } from "ethers";
import fs from "fs";
import path from "path";

async function main() {
  // Read artifact
  const artifactPath = path.resolve("./artifacts/contracts/SimonSaysScores.sol/SimonSaysScores.json");
  const artifact = JSON.parse(fs.readFileSync(artifactPath, "utf8"));

  // Connect to the local Hardhat node
  const provider = new ethers.JsonRpcProvider("http://127.0.0.1:8545");
  
  // Use Account #0's private key to sign the deployment transaction
  const privateKey = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
  const wallet = new ethers.Wallet(privateKey, provider);

  console.log("Deploying contract with account:", wallet.address);

  // Deploy
  const factory = new ethers.ContractFactory(artifact.abi, artifact.bytecode, wallet);
  const contract = await factory.deploy();
  await contract.waitForDeployment();

  console.log("SimonSaysScores deployed to:", await contract.getAddress());
}

main().catch((error) => {
  console.error("Deployment failed:", error);
  process.exitCode = 1;
});
