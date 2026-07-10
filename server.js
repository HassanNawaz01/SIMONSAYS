import http from "http";
import fs from "fs/promises";
import fsSync from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { WebSocketServer, WebSocket } from "ws";
import { ethers } from "ethers";

function loadEnvFile() {
  const envPath = path.resolve(".env");
  if (!fsSync.existsSync(envPath)) return;

  for (const rawLine of fsSync.readFileSync(envPath, "utf8").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    const value = line.slice(eq + 1).trim().replace(/^["']|["']$/g, "");
    if (!process.env[key]) process.env[key] = value;
  }
}

loadEnvFile();

// Development signer private key (Hardhat account #0)
// Signer Address: 0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266
const SIGNER_PRIVATE_KEY = process.env.SIGNER_PRIVATE_KEY || "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
const wallet = new ethers.Wallet(SIGNER_PRIVATE_KEY);
console.log(`Simon says server started. Signer address: ${wallet.address}`);

const STAKE_ESCROW_ADDRESS = process.env.STAKE_ESCROW_ADDRESS || "0x654B8495765f8Db94f4880c20F5c7E5f8a9CFe90";
const BASE_RPC_URL = process.env.BASE_RPC_URL || "https://mainnet.base.org";
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
const stakeProvider = new ethers.JsonRpcProvider(BASE_RPC_URL);
const stakeEscrow = ethers.isAddress(STAKE_ESCROW_ADDRESS)
  ? new ethers.Contract(STAKE_ESCROW_ADDRESS, [
      "function hasDeposit(bytes32 matchId, address player) view returns (bool)",
      "function matches(bytes32 matchId) view returns (address player1, address player2, uint256 stake, uint64 createdAt, bool player1Deposited, bool player2Deposited, bool settled)"
    ], stakeProvider)
  : null;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const STATIC_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".svg": "image/svg+xml"
};

async function serveStatic(req, res) {
  const url = new URL(req.url || "/", "http://localhost");
  const pathname = decodeURIComponent(url.pathname === "/" ? "/base-simon.html" : url.pathname);
  const safePath = path.normalize(pathname).replace(/^(\.\.[/\\])+/, "");
  const filePath = path.join(__dirname, safePath);

  if (!filePath.startsWith(__dirname)) {
    res.writeHead(403, { "Content-Type": "text/plain" });
    res.end("Forbidden\n");
    return;
  }

  try {
    const data = await fs.readFile(filePath);
    const type = STATIC_TYPES[path.extname(filePath).toLowerCase()] || "application/octet-stream";
    res.writeHead(200, { "Content-Type": type });
    res.end(data);
  } catch (err) {
    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("Not found\n");
  }
}

const server = http.createServer(async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  const url = new URL(req.url || "/", "http://localhost");

  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  if (url.pathname === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      ok: true,
      queue: queue.length,
      pendingMatches: pendingMatches.size,
      activeMatches: activeMatches.size,
      completedSettlements: completedSettlements.size
    }));
    return;
  }

  if (url.pathname === "/api/settlement") {
    const matchId = String(url.searchParams.get("matchId") || "").toLowerCase();
    if (!/^0x[0-9a-f]{64}$/.test(matchId)) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: "bad matchId" }));
      return;
    }

    const settlement = completedSettlements.get(matchId);
    if (!settlement) {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: "settlement not found" }));
      return;
    }

    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true, settlement }));
    return;
  }

  if (req.method === "GET" || req.method === "HEAD") {
    await serveStatic(req, res);
    return;
  }

  res.writeHead(405, { "Content-Type": "text/plain" });
  res.end("Method not allowed\n");
});

const wss = new WebSocketServer({ server });

const ALLOWED_STAKES = new Set([
  "0",
  "500000000000000",
  "1000000000000000",
  "5000000000000000",
  "10000000000000000"
]);
const FREE_READY_TIMEOUT_MS = 30000;
const PAID_READY_TIMEOUT_MS = 180000;

let clients = new Set();
let queue = []; // Array of { ws, playerAddress, stakeWei, joinedAt }
let pendingMatches = new Map(); // readyId => PendingMatch
let activeMatches = new Map(); // matchId => MatchState
let completedSettlements = new Map(); // matchId => signed paid settlement

function generateMatchId() {
  return ethers.hexlify(ethers.randomBytes(32));
}

function broadcast(match, data) {
  const msg = JSON.stringify(data);
  if (match.p1.ws.readyState === WebSocket.OPEN) match.p1.ws.send(msg);
  if (match.p2.ws.readyState === WebSocket.OPEN) match.p2.ws.send(msg);
}

function sendJson(ws, data) {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(data));
  }
}

function cleanupQueue() {
  queue = queue.filter((p) => p.ws.readyState === WebSocket.OPEN);
}

function findMatchBySocket(ws) {
  for (const match of activeMatches.values()) {
    if (match.p1.ws === ws || match.p2.ws === ws) return match;
  }
  return null;
}

function findPendingBySocket(ws) {
  for (const pending of pendingMatches.values()) {
    if (pending.p1.ws === ws || pending.p2.ws === ws) return pending;
  }
  return null;
}

function queuePayload() {
  cleanupQueue();
  return queue.map((p) => ({
    address: p.playerAddress,
    stakeWei: p.stakeWei,
    joinedAt: p.joinedAt
  }));
}

function broadcastQueue() {
  const players = queuePayload();
  for (const client of clients) {
    sendJson(client, { type: "queue_update", players });
  }
}

function removeFromQueue(ws) {
  const before = queue.length;
  queue = queue.filter((p) => p.ws !== ws);
  if (queue.length !== before) broadcastQueue();
}

function cancelPending(readyId, reason = "cancelled") {
  const pending = pendingMatches.get(readyId);
  if (!pending) return;

  clearTimeout(pending.readyTimer);
  pendingMatches.delete(readyId);
  sendJson(pending.p1.ws, { type: "match_cancelled", reason });
  sendJson(pending.p2.ws, { type: "match_cancelled", reason });
}

function startPendingMatch(readyId) {
  const pending = pendingMatches.get(readyId);
  if (!pending) return;

  clearTimeout(pending.readyTimer);
  pendingMatches.delete(readyId);

  const matchId = readyId;
  const initialSequence = [Math.floor(Math.random() * 4)];
  const match = {
    matchId,
    stakeWei: pending.stakeWei,
    timeLeft: 90,
    p1: {
      ws: pending.p1.ws,
      address: pending.p1.playerAddress,
      score: 0,
      sequence: [...initialSequence],
      step: 0,
      failed: false
    },
    p2: {
      ws: pending.p2.ws,
      address: pending.p2.playerAddress,
      score: 0,
      sequence: [...initialSequence],
      step: 0,
      failed: false
    },
    forfeiter: null,
    started: false,
    countdownLeft: 5,
    countdownInterval: null,
    timerInterval: null
  };

  activeMatches.set(matchId, match);

  sendJson(pending.p1.ws, {
    type: "match_start",
    matchId,
    opponent: pending.p2.playerAddress,
    stakeWei: pending.stakeWei,
    initialSequence,
    countdown: match.countdownLeft,
    timeLeft: match.timeLeft
  });

  sendJson(pending.p2.ws, {
    type: "match_start",
    matchId,
    opponent: pending.p1.playerAddress,
    stakeWei: pending.stakeWei,
    initialSequence,
    countdown: match.countdownLeft,
    timeLeft: match.timeLeft
  });

  console.log(`Match countdown started: ${matchId} between ${pending.p1.playerAddress} and ${pending.p2.playerAddress}`);

  broadcast(match, { type: "match_countdown", seconds: match.countdownLeft });

  match.countdownInterval = setInterval(() => {
    match.countdownLeft--;

    if (match.countdownLeft > 0) {
      broadcast(match, { type: "match_countdown", seconds: match.countdownLeft });
      return;
    }

    clearInterval(match.countdownInterval);
    match.countdownInterval = null;
    match.started = true;
    broadcast(match, { type: "match_go", timeLeft: match.timeLeft });
    console.log(`Match started: ${matchId}`);

    match.timerInterval = setInterval(() => {
      match.timeLeft--;
      broadcast(match, { type: "timer_tick", timeLeft: match.timeLeft });

      if (match.timeLeft <= 0) {
        endMatch(matchId, "time_out");
      }
    }, 1000);
  }, 1000);
}

function tryCreateReadyPair() {
  cleanupQueue();

  const stakeOrder = [...ALLOWED_STAKES];
  for (const stakeWei of stakeOrder) {
    while (queue.filter((p) => p.stakeWei === stakeWei).length >= 2) {
      const firstIndex = queue.findIndex((p) => p.stakeWei === stakeWei);
      const p1 = queue.splice(firstIndex, 1)[0];
      const secondIndex = queue.findIndex((p) => p.stakeWei === stakeWei);
      const p2 = queue.splice(secondIndex, 1)[0];

      if (p1.ws.readyState !== WebSocket.OPEN || p2.ws.readyState !== WebSocket.OPEN) {
        cleanupQueue();
        continue;
      }

      const readyId = generateMatchId();
      const readyTimeoutMs = stakeWei === "0" ? FREE_READY_TIMEOUT_MS : PAID_READY_TIMEOUT_MS;
      const pending = {
        readyId,
        stakeWei,
        p1,
        p2,
        ready: new Set(),
        readyTimer: setTimeout(() => cancelPending(readyId, "ready_timeout"), readyTimeoutMs)
      };

      pendingMatches.set(readyId, pending);
      sendJson(p1.ws, { type: "ready_check", readyId, opponent: p2.playerAddress, stakeWei, expiresIn: Math.floor(readyTimeoutMs / 1000) });
      sendJson(p2.ws, { type: "ready_check", readyId, opponent: p1.playerAddress, stakeWei, expiresIn: Math.floor(readyTimeoutMs / 1000) });
    }
  }

  broadcastQueue();
}

async function endMatch(matchId, reason) {
  const match = activeMatches.get(matchId);
  if (!match) return;

  clearInterval(match.countdownInterval);
  clearInterval(match.timerInterval);
  activeMatches.delete(matchId);

  console.log(`Ending match ${matchId}. Reason: ${reason}`);

  let p1Result = "tie";
  let p2Result = "tie";

  if (match.forfeiter === match.p1.address) {
    p1Result = "lose";
    p2Result = "win";
  } else if (match.forfeiter === match.p2.address) {
    p1Result = "win";
    p2Result = "lose";
  } else if (match.p1.score > match.p2.score) {
    p1Result = "win";
    p2Result = "lose";
  } else if (match.p2.score > match.p1.score) {
    p1Result = "lose";
    p2Result = "win";
  }

  const winnerAddress = p1Result === "win"
    ? match.p1.address
    : p2Result === "win"
      ? match.p2.address
      : ZERO_ADDRESS;

  const signScore = async (playerAddr, score) => {
    const messageHash = ethers.solidityPackedKeccak256(
      ["address", "uint256", "uint8", "bytes32"],
      [playerAddr, score, 1, matchId]
    );
    return await wallet.signMessage(ethers.getBytes(messageHash));
  };

  const p1Sig = await signScore(match.p1.address, match.p1.score);
  const p2Sig = await signScore(match.p2.address, match.p2.score);
  let settlement = null;

  if (match.stakeWei !== "0" && stakeEscrow) {
    try {
      const escrowMatch = await stakeEscrow.matches(matchId);
      const messageHash = ethers.solidityPackedKeccak256(
        ["address", "bytes32", "address", "address", "uint256", "address"],
        [STAKE_ESCROW_ADDRESS, matchId, escrowMatch.player1, escrowMatch.player2, escrowMatch.stake, winnerAddress]
      );
      settlement = {
        matchId,
        winner: winnerAddress,
        signature: await wallet.signMessage(ethers.getBytes(messageHash)),
        stakeWei: match.stakeWei,
        p1: match.p1.address,
        p2: match.p2.address,
        createdAt: Date.now()
      };
      completedSettlements.set(matchId.toLowerCase(), settlement);
    } catch (err) {
      console.error("Could not sign paid settlement:", err);
    }
  }

  sendJson(match.p1.ws, {
    type: "match_end",
    score: match.p1.score,
    opponentScore: match.p2.score,
    result: p1Result,
    signature: p1Sig,
    settlement,
    stakeWei: match.stakeWei,
    matchId
  });

  sendJson(match.p2.ws, {
    type: "match_end",
    score: match.p2.score,
    opponentScore: match.p1.score,
    result: p2Result,
    signature: p2Sig,
    settlement,
    stakeWei: match.stakeWei,
    matchId
  });
}

async function verifyPaidDeposit(pending, ws, txHash) {
  if (pending.stakeWei === "0") return true;
  if (!stakeEscrow) throw new Error("Paid escrow contract is not configured on the server.");

  const player = pending.p1.ws === ws ? pending.p1.playerAddress : pending.p2.playerAddress;
  const receipt = await stakeProvider.waitForTransaction(txHash, 1, 90000);
  if (!receipt || receipt.status !== 1) throw new Error("Escrow deposit transaction failed or was not confirmed.");

  const hasDeposit = await stakeEscrow.hasDeposit(pending.readyId, player);
  if (!hasDeposit) throw new Error("Escrow deposit was not found for this match.");
  return true;
}

wss.on("connection", (ws) => {
  let playerAddress = null;
  clients.add(ws);
  sendJson(ws, { type: "queue_update", players: queuePayload() });

  ws.on("message", async (message) => {
    try {
      const data = JSON.parse(message);

      if (data.type === "1v1_join") {
        playerAddress = data.playerAddress;
        if (!playerAddress || !ethers.isAddress(playerAddress)) {
          sendJson(ws, { type: "error", message: "Invalid wallet address" });
          return;
        }

        const stakeWei = String(data.stakeWei || "0");
        if (!ALLOWED_STAKES.has(stakeWei)) {
          sendJson(ws, { type: "error", message: "Invalid stake amount" });
          return;
        }

        cleanupQueue();

        // Check if already in queue
        if (queue.some(p => p.playerAddress.toLowerCase() === playerAddress.toLowerCase())) {
          sendJson(ws, { type: "queue_status", status: "Already in queue" });
          return;
        }

        console.log(`Player joined queue: ${playerAddress} stake=${stakeWei}`);
        queue.push({ ws, playerAddress, stakeWei, joinedAt: Date.now() });
        sendJson(ws, { type: "queue_status", status: "queued" });
        broadcastQueue();

        tryCreateReadyPair();
      }

      else if (data.type === "1v1_leave") {
        removeFromQueue(ws);
        const pending = findPendingBySocket(ws);
        if (pending) cancelPending(pending.readyId, "cancelled");
      }

      else if (data.type === "1v1_ready") {
        const pending = pendingMatches.get(data.readyId);
        if (!pending || (pending.p1.ws !== ws && pending.p2.ws !== ws)) {
          sendJson(ws, { type: "error", message: "Match expired. Please find another 1v1." });
          return;
        }

        if (!data.ready) {
          cancelPending(pending.readyId, "declined");
          return;
        }

        if (pending.stakeWei !== "0" && !/^0x[0-9a-fA-F]{64}$/.test(String(data.txHash || ""))) {
          sendJson(ws, { type: "error", message: "Paid matches require an escrow deposit transaction first." });
          return;
        }

        if (pending.stakeWei !== "0") {
          try {
            sendJson(ws, { type: "ready_state", readyCount: pending.ready.size, message: "Verifying escrow deposit..." });
            await verifyPaidDeposit(pending, ws, String(data.txHash));
            if (pendingMatches.get(data.readyId) !== pending) {
              sendJson(ws, { type: "error", message: "Match expired after deposit. Open Pending reward to refund or claim, then find another 1v1." });
              return;
            }
          } catch (err) {
            sendJson(ws, { type: "error", message: err.message || "Could not verify escrow deposit." });
            return;
          }
        }

        pending.ready.add(ws);
        const readyCount = pending.ready.size;
        sendJson(pending.p1.ws, { type: "ready_state", readyCount });
        sendJson(pending.p2.ws, { type: "ready_state", readyCount });

        if (readyCount >= 2) {
          startPendingMatch(pending.readyId);
        }
      }

      else if (data.type === "1v1_click") {
        const matchId = data.matchId;
        const match = activeMatches.get(matchId);
        if (!match) return;

        const isP1 = ws === match.p1.ws;
        const player = isP1 ? match.p1 : match.p2;
        const opponent = isP1 ? match.p2 : match.p1;

        if (!match.started || player.failed || match.timeLeft <= 0) return;

        const clickedIndex = data.index;
        const expectedIndex = player.sequence[player.step];

        if (clickedIndex === expectedIndex) {
          player.step++;
          // Level cleared
          if (player.step === player.sequence.length) {
            player.step = 0;
            player.score++;
            player.sequence.push(Math.floor(Math.random() * 4));

            // Send next sequence to the player
            sendJson(player.ws, {
              type: "next_round",
              sequence: player.sequence,
              score: player.score
            });

            // Notify opponent of score update
            sendJson(opponent.ws, {
              type: "opponent_score",
              score: player.score
            });
          }
        } else {
          // Player failed
          player.failed = true;
          sendJson(player.ws, { type: "player_failed", score: player.score });
          sendJson(opponent.ws, { type: "opponent_failed", score: player.score });

          console.log(`Player failed: ${player.address} in match ${matchId} with score ${player.score}`);

          // If both failed, end match early
          if (match.p1.failed && match.p2.failed) {
            endMatch(matchId, "both_failed");
          }
        }
      }
    } catch (err) {
      console.error("Error handling message:", err);
    }
  });

  ws.on("close", () => {
    clients.delete(ws);
    removeFromQueue(ws);

    const pending = findPendingBySocket(ws);
    if (pending) {
      cancelPending(pending.readyId, "disconnect");
    }

    const match = findMatchBySocket(ws);
    if (match) {
      const player = match.p1.ws === ws ? match.p1 : match.p2;
      const opponent = match.p1.ws === ws ? match.p2 : match.p1;
      player.failed = true;
      match.forfeiter = player.address;
      sendJson(opponent.ws, { type: "opponent_failed", score: player.score });
      endMatch(match.matchId, "disconnect");
    }

    console.log("Connection closed.");
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server is listening on port ${PORT}`);
});
