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

  const matchId = process.env.RECOVERY_MATCH_ID || process.argv[2];
  const winner = process.env.RECOVERY_WINNER || process.argv[3];
  if (!/^0x[0-9a-fA-F]{64}$/.test(matchId || "")) {
    throw new Error("Pass RECOVERY_MATCH_ID as a bytes32 match id.");
  }
  if (!ethers.isAddress(winner)) {
    throw new Error("Pass RECOVERY_WINNER as the winner wallet address.");
  }

  const rpcUrl = process.env.BASE_RPC_URL || "https://mainnet.base.org";
  const escrowAddress = process.env.STAKE_ESCROW_ADDRESS || "0x654B8495765f8Db94f4880c20F5c7E5f8a9CFe90";
  const signerWallet = new ethers.Wallet(requireEnv("SIGNER_PRIVATE_KEY"));
  const txWallet = new ethers.Wallet(requireEnv("DEPLOYER_PRIVATE_KEY"), new ethers.JsonRpcProvider(rpcUrl));
  const escrow = new ethers.Contract(escrowAddress, [
    "function matches(bytes32 matchId) view returns (address player1, address player2, uint256 stake, uint64 createdAt, bool player1Deposited, bool player2Deposited, bool settled)",
    "function signerAddress() view returns (address)",
    "function settle(bytes32 matchId, address winner, bytes signature)"
  ], txWallet);

  const signerAddress = await escrow.signerAddress();
  if (signerAddress.toLowerCase() !== signerWallet.address.toLowerCase()) {
    throw new Error(`SIGNER_PRIVATE_KEY does not match escrow signer. Expected ${signerAddress}, got ${signerWallet.address}.`);
  }

  const m = await escrow.matches(matchId);
  if (m.settled) throw new Error("Match is already settled.");
  if (!m.player1Deposited || !m.player2Deposited) throw new Error("Both players have not deposited.");

  const winnerLower = winner.toLowerCase();
  if (winnerLower !== m.player1.toLowerCase() && winnerLower !== m.player2.toLowerCase()) {
    throw new Error(`Winner must be one of the players: ${m.player1} or ${m.player2}.`);
  }

  const messageHash = ethers.solidityPackedKeccak256(
    ["address", "bytes32", "address", "address", "uint256", "address"],
    [escrowAddress, matchId, m.player1, m.player2, m.stake, winner]
  );
  const signature = await signerWallet.signMessage(ethers.getBytes(messageHash));

  console.log("Settling match:", matchId);
  console.log("Player 1:", m.player1);
  console.log("Player 2:", m.player2);
  console.log("Stake:", ethers.formatEther(m.stake), "ETH each");
  console.log("Winner:", winner);

  const tx = await escrow.settle(matchId, winner, signature);
  console.log("Settlement tx:", tx.hash);
  await tx.wait();
  console.log("Settled. Winner can now claim pending reward in the app.");
}

main().catch((error) => {
  console.error("Recovery settlement failed:", error.message || error);
  process.exitCode = 1;
});
