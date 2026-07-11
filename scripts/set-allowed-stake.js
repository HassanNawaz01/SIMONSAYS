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
  if (!value) throw new Error(`Missing ${name}.`);
  return value;
}

async function main() {
  loadEnvFile();

  const stakeWei = process.argv[2];
  const allowedArg = String(process.argv[3] ?? "true").toLowerCase();
  if (!/^\d+$/.test(stakeWei || "")) throw new Error("Usage: node scripts/set-allowed-stake.js <stakeWei> <true|false>");
  if (!["true", "false"].includes(allowedArg)) throw new Error("Allowed value must be true or false.");

  const rpcUrl = process.env.BASE_RPC_URL || "https://mainnet.base.org";
  const escrowAddress = process.env.STAKE_ESCROW_ADDRESS || "0xdf2b460F59d0Ee0B5C892A9eF1b645a33BBEF563";
  const wallet = new ethers.Wallet(requireEnv("DEPLOYER_PRIVATE_KEY"), new ethers.JsonRpcProvider(rpcUrl));
  const escrow = new ethers.Contract(escrowAddress, [
    "function owner() view returns (address)",
    "function allowedStake(uint256 stake) view returns (bool)",
    "function setAllowedStake(uint256 stake, bool allowed)"
  ], wallet);

  const owner = await escrow.owner();
  if (owner.toLowerCase() !== wallet.address.toLowerCase()) {
    throw new Error(`DEPLOYER_PRIVATE_KEY is not escrow owner. Owner is ${owner}.`);
  }

  const allowed = allowedArg === "true";
  const before = await escrow.allowedStake(stakeWei);
  console.log("Stake:", ethers.formatEther(stakeWei), "ETH");
  console.log("Before:", before);

  if (before === allowed) {
    console.log("No change needed.");
    return;
  }

  const tx = await escrow.setAllowedStake(stakeWei, allowed);
  console.log("Update tx:", tx.hash);
  await tx.wait();
  console.log("After:", await escrow.allowedStake(stakeWei));
}

main().catch((error) => {
  console.error("Set allowed stake failed:", error.message || error);
  process.exitCode = 1;
});
