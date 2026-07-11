import http from "http";
import fs from "fs/promises";
import fsSync from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { randomInt } from "crypto";
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

const SIGNER_PRIVATE_KEY = process.env.SIGNER_PRIVATE_KEY;
if (!SIGNER_PRIVATE_KEY) {
  throw new Error("SIGNER_PRIVATE_KEY is required. Refusing to start without the configured onchain signer.");
}

let wallet;
try {
  wallet = new ethers.Wallet(SIGNER_PRIVATE_KEY);
} catch {
  throw new Error("SIGNER_PRIVATE_KEY is invalid.");
}
console.log(`Simon says server started. Signer address: ${wallet.address}`);

const STAKE_ESCROW_ADDRESS = process.env.STAKE_ESCROW_ADDRESS || "0xdf2b460F59d0Ee0B5C892A9eF1b645a33BBEF563";
const SCORE_CONTRACT_ADDRESS = process.env.SCORE_CONTRACT_ADDRESS || "0xd376DA21BDCDD1338C2283488d592880F25F09f1";
const BASE_RPC_URL = process.env.BASE_RPC_URL || "https://mainnet.base.org";
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
const stakeProvider = new ethers.JsonRpcProvider(BASE_RPC_URL);
const stakeEscrow = ethers.isAddress(STAKE_ESCROW_ADDRESS)
  ? new ethers.Contract(STAKE_ESCROW_ADDRESS, [
      "function hasDeposit(bytes32 matchId, address player) view returns (bool)",
      "function matches(bytes32 matchId) view returns (address player1, address player2, uint256 stake, uint64 createdAt, bool player1Deposited, bool player2Deposited, bool settled)",
      "function signerAddress() view returns (address)",
      "function allowedStake(uint256 stake) view returns (bool)",
      "function settle(bytes32 matchId, address winner, bytes signature)"
    ], stakeProvider)
  : null;
const settlementSigner = new ethers.NonceManager(wallet.connect(stakeProvider));
const stakeEscrowWriter = stakeEscrow ? stakeEscrow.connect(settlementSigner) : null;
let paidEscrowConfigPromise = null;

function ensurePaidEscrowConfigured(stakeWei) {
  if (!stakeEscrow) return Promise.reject(new Error("Paid escrow contract is not configured."));

  if (!paidEscrowConfigPromise) {
    paidEscrowConfigPromise = (async () => {
      const [network, code, configuredSigner] = await Promise.all([
        stakeProvider.getNetwork(),
        stakeProvider.getCode(STAKE_ESCROW_ADDRESS),
        stakeEscrow.signerAddress()
      ]);
      if (network.chainId !== 8453n) throw new Error("Escrow RPC is not Base mainnet.");
      if (code === "0x") throw new Error("Escrow contract is not deployed.");
      if (configuredSigner.toLowerCase() !== wallet.address.toLowerCase()) {
        throw new Error("Server signer does not match the escrow contract signer.");
      }
      return true;
    })().catch((error) => {
      paidEscrowConfigPromise = null;
      throw error;
    });
  }

  return paidEscrowConfigPromise.then(async () => {
    if (!(await stakeEscrow.allowedStake(stakeWei))) throw new Error("Stake is disabled onchain.");
    return true;
  });
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const STATIC_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8"
};
const PUBLIC_FILES = new Set(["base-simon.html", "base-simon.css", "base-simon.js"]);
const CSP = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "connect-src 'self' ws://127.0.0.1:* ws://localhost:* https://simonsays-ayuz.onrender.com wss://simonsays-ayuz.onrender.com",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
  "object-src 'none'"
].join("; ");

function setSecurityHeaders(res) {
  res.setHeader("Content-Security-Policy", CSP);
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=(), payment=()");
}

async function serveStatic(req, res) {
  const url = new URL(req.url || "/", "http://localhost");
  let filename;
  try {
    filename = decodeURIComponent(url.pathname === "/" ? "base-simon.html" : url.pathname.slice(1));
  } catch {
    res.writeHead(400, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("Bad request\n");
    return;
  }

  if (!PUBLIC_FILES.has(filename)) {
    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("Not found\n");
    return;
  }

  try {
    const filePath = path.join(__dirname, filename);
    const data = await fs.readFile(filePath);
    const type = STATIC_TYPES[path.extname(filePath).toLowerCase()] || "application/octet-stream";
    res.writeHead(200, {
      "Content-Type": type,
      "Cache-Control": filename.endsWith(".html") ? "no-cache" : "public, max-age=3600"
    });
    res.end(req.method === "HEAD" ? undefined : data);
  } catch {
    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("Not found\n");
  }
}

const server = http.createServer(async (req, res) => {
  setSecurityHeaders(res);
  const url = new URL(req.url || "/", "http://localhost");

  if (req.method === "OPTIONS") {
    if (url.pathname === "/api/settlement" || url.pathname === "/health") {
      res.setHeader("Access-Control-Allow-Origin", "*");
      res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
      res.setHeader("Access-Control-Allow-Headers", "Content-Type");
    }
    res.writeHead(204);
    res.end();
    return;
  }

  if (url.pathname === "/health") {
    if (req.method !== "GET" && req.method !== "HEAD") {
      res.writeHead(405, { "Content-Type": "application/json", "Allow": "GET, HEAD, OPTIONS" });
      res.end(JSON.stringify({ ok: false, error: "method not allowed" }));
      return;
    }
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Cache-Control", "no-store");
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
    if (req.method !== "GET" && req.method !== "HEAD") {
      res.writeHead(405, { "Content-Type": "application/json", "Allow": "GET, HEAD, OPTIONS" });
      res.end(JSON.stringify({ ok: false, error: "method not allowed" }));
      return;
    }
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Cache-Control", "no-store");
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

const wss = new WebSocketServer({
  server,
  maxPayload: 8 * 1024,
  perMessageDeflate: false
});

const ALLOWED_STAKES = new Set([
  "0",
  "500000000000000",
  "1000000000000000",
  "5000000000000000",
  "10000000000000000"
]);
const FREE_READY_TIMEOUT_MS = 30000;
const PAID_READY_TIMEOUT_MS = 180000;
const MAX_CLIENTS = 500;
const MAX_CONNECTIONS_PER_IP = 20;
const MAX_MESSAGES_PER_SECOND = 40;
const MIN_CLICK_INTERVAL_MS = 70;
const MAX_EARLY_CLICKS = 20;
const PAID_AUTH_TTL_MS = 5 * 60 * 1000;
const AUTO_SETTLE_MAX_ATTEMPTS = 5;
const AUTO_SETTLE_RETRY_MS = 15000;
const PAID_READY_CONFIRM_MS = 60 * 1000;

let clients = new Set();
let connectionsByIp = new Map();
let queue = []; // Array of { ws, playerAddress, stakeWei, joinedAt }
let pendingMatches = new Map(); // readyId => PendingMatch
let activeMatches = new Map(); // matchId => MatchState
let completedSettlements = new Map(); // matchId => signed paid settlement

function generateMatchId() {
  return ethers.hexlify(ethers.randomBytes(32));
}

function randomPadIndex() {
  return randomInt(4);
}

function clientIp(req) {
  const forwarded = String(req.headers["x-forwarded-for"] || "").split(",")[0].trim();
  return forwarded || req.socket.remoteAddress || "unknown";
}

function consumeMessageBudget(ws) {
  const now = Date.now();
  if (!ws.messageWindowStartedAt || now - ws.messageWindowStartedAt >= 1000) {
    ws.messageWindowStartedAt = now;
    ws.messageCount = 0;
  }
  ws.messageCount++;
  return ws.messageCount <= MAX_MESSAGES_PER_SECOND;
}

function playbackDelayMs(player) {
  const level = player.score + 1;
  const speed = Math.max(220, 620 - level * 32);
  return 650 + player.sequence.length * (speed + 140) - 150;
}

async function autoSettlePaidReward(settlement, attempt = 1) {
  if (!stakeEscrowWriter || !settlement || settlement.settled) return settlement;
  settlement.settlementAttempt = attempt;

  try {
    await ensurePaidEscrowConfigured(settlement.stakeWei);
    const escrowMatch = await stakeEscrow.matches(settlement.matchId);
    if (escrowMatch.settled) {
      settlement.settled = true;
      settlement.settledAt = Date.now();
      return settlement;
    }

    const tx = await stakeEscrowWriter.settle(
      settlement.matchId,
      settlement.winner,
      settlement.signature
    );
    settlement.txHash = tx.hash;
    const receipt = await stakeProvider.waitForTransaction(tx.hash, 1, 30000);
    if (!receipt || receipt.status !== 1) throw new Error("Settlement transaction failed.");
    settlement.settled = true;
    settlement.settledAt = Date.now();
    delete settlement.settlementError;
    console.log(`Paid reward settled automatically: ${settlement.matchId} tx=${tx.hash}`);
  } catch (error) {
    settlement.settled = false;
    settlement.settlementError = error.shortMessage || error.message || "automatic settlement failed";
    console.error(`Automatic settlement attempt ${attempt} failed for ${settlement.matchId}:`, settlement.settlementError);
    if (attempt < AUTO_SETTLE_MAX_ATTEMPTS) {
      setTimeout(() => autoSettlePaidReward(settlement, attempt + 1), AUTO_SETTLE_RETRY_MS);
    }
  }

  return settlement;
}

async function createPaidSettlement(matchId, stakeWei, p1, p2, winner) {
  const escrowMatch = await stakeEscrow.matches(matchId);
  const messageHash = ethers.solidityPackedKeccak256(
    ["address", "bytes32", "address", "address", "uint256", "address"],
    [STAKE_ESCROW_ADDRESS, matchId, escrowMatch.player1, escrowMatch.player2, escrowMatch.stake, winner]
  );
  const settlement = {
    matchId,
    winner,
    signature: await wallet.signMessage(ethers.getBytes(messageHash)),
    stakeWei,
    p1,
    p2,
    createdAt: Date.now(),
    settled: false,
    txHash: null
  };
  completedSettlements.set(matchId.toLowerCase(), settlement);
  await autoSettlePaidReward(settlement);
  return settlement;
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

function socketIsBusy(ws) {
  return queue.some((p) => p.ws === ws) || Boolean(findPendingBySocket(ws)) || Boolean(findMatchBySocket(ws));
}

function addressIsBusy(address, exceptWs = null) {
  const key = address.toLowerCase();
  if (queue.some((p) => p.ws !== exceptWs && p.playerAddress.toLowerCase() === key)) return true;
  for (const pending of pendingMatches.values()) {
    if ((pending.p1.ws !== exceptWs && pending.p1.playerAddress.toLowerCase() === key) ||
        (pending.p2.ws !== exceptWs && pending.p2.playerAddress.toLowerCase() === key)) return true;
  }
  for (const match of activeMatches.values()) {
    if ((match.p1.ws !== exceptWs && match.p1.address.toLowerCase() === key) ||
        (match.p2.ws !== exceptWs && match.p2.address.toLowerCase() === key)) return true;
  }
  return false;
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

async function cancelPending(readyId, reason = "cancelled") {
  const pending = pendingMatches.get(readyId);
  if (!pending) return;

  clearTimeout(pending.readyTimer);
  clearInterval(pending.readyInterval);
  pendingMatches.delete(readyId);
  let settlement = null;
  let fullyFunded = pending.funded;
  if (pending.stakeWei !== "0" && stakeEscrow) {
    try {
      const escrowMatch = await stakeEscrow.matches(pending.readyId);
      fullyFunded = !escrowMatch.settled && escrowMatch.player1Deposited && escrowMatch.player2Deposited;
    } catch (error) {
      console.error(`Could not check pending match funding ${readyId}:`, error.message || error);
    }
  }
  if (fullyFunded && pending.stakeWei !== "0") {
    try {
      settlement = await createPaidSettlement(
        pending.readyId,
        pending.stakeWei,
        pending.p1.playerAddress,
        pending.p2.playerAddress,
        ZERO_ADDRESS
      );
    } catch (error) {
      console.error(`Could not auto-refund funded pending match ${readyId}:`, error.message || error);
    }
  }
  const payload = {
    type: "match_cancelled",
    reason,
    automaticRefund: Boolean(settlement && settlement.settled),
    refundPending: Boolean(fullyFunded && (!settlement || !settlement.settled)),
    settlement
  };
  sendJson(pending.p1.ws, payload);
  sendJson(pending.p2.ws, payload);
}

function startPaidReadyWindow(pending) {
  clearTimeout(pending.readyTimer);
  clearInterval(pending.readyInterval);
  pending.readyDeadline = Date.now() + PAID_READY_CONFIRM_MS;
  pending.readyTimer = setTimeout(() => cancelPending(pending.readyId, "ready_timeout"), PAID_READY_CONFIRM_MS);
  sendPendingReadyState(pending);
  pending.readyInterval = setInterval(() => {
    if (!pendingMatches.has(pending.readyId)) {
      clearInterval(pending.readyInterval);
      return;
    }
    const seconds = Math.max(0, Math.ceil((pending.readyDeadline - Date.now()) / 1000));
    sendPendingReadyState(pending, seconds);
  }, 1000);
}

function sendPendingDepositState(pending) {
  const p1Deposited = pending.deposited.has(pending.p1.ws);
  const p2Deposited = pending.deposited.has(pending.p2.ws);
  const state = { type: "deposit_state", bothDeposited: p1Deposited && p2Deposited };
  sendJson(pending.p1.ws, { ...state, youDeposited: p1Deposited, opponentDeposited: p2Deposited });
  sendJson(pending.p2.ws, { ...state, youDeposited: p2Deposited, opponentDeposited: p1Deposited });
}

function sendPendingReadyState(pending, seconds = null) {
  const p1Ready = pending.ready.has(pending.p1.ws);
  const p2Ready = pending.ready.has(pending.p2.ws);
  const remaining = seconds ?? Math.max(0, Math.ceil(((pending.readyDeadline || Date.now()) - Date.now()) / 1000));
  const state = { type: "ready_countdown", seconds: remaining, readyCount: pending.ready.size };
  sendJson(pending.p1.ws, { ...state, youReady: p1Ready, opponentReady: p2Ready });
  sendJson(pending.p2.ws, { ...state, youReady: p2Ready, opponentReady: p1Ready });
}

function startPendingMatch(readyId) {
  const pending = pendingMatches.get(readyId);
  if (!pending) return;

  clearTimeout(pending.readyTimer);
  clearInterval(pending.readyInterval);
  pendingMatches.delete(readyId);

  const matchId = readyId;
  const initialSequence = [randomPadIndex()];
  const match = {
    matchId,
    stakeWei: pending.stakeWei,
    timeLeft: 60,
    p1: {
      ws: pending.p1.ws,
      address: pending.p1.playerAddress,
      score: 0,
      sequence: [...initialSequence],
      step: 0,
      failed: false,
      acceptClicksAt: 0,
      lastClickAt: 0,
      earlyClicks: 0
    },
    p2: {
      ws: pending.p2.ws,
      address: pending.p2.playerAddress,
      score: 0,
      sequence: [...initialSequence],
      step: 0,
      failed: false,
      acceptClicksAt: 0,
      lastClickAt: 0,
      earlyClicks: 0
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
    const acceptClicksAt = Date.now() + playbackDelayMs(match.p1);
    match.p1.acceptClicksAt = acceptClicksAt;
    match.p2.acceptClicksAt = acceptClicksAt;
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
        deposited: new Set(),
        verifying: new Set(),
        funded: false,
        readyDeadline: null,
        readyInterval: null,
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
    const encoded = ethers.AbiCoder.defaultAbiCoder().encode(
      ["address", "uint256", "address", "uint256", "uint8", "bytes32"],
      [SCORE_CONTRACT_ADDRESS, 8453n, playerAddr, score, 1, matchId]
    );
    const messageHash = ethers.keccak256(encoded);
    return await wallet.signMessage(ethers.getBytes(messageHash));
  };

  const p1Sig = await signScore(match.p1.address, match.p1.score);
  const p2Sig = await signScore(match.p2.address, match.p2.score);
  let settlement = null;

  if (match.stakeWei !== "0" && stakeEscrow) {
    try {
      settlement = await createPaidSettlement(
        matchId,
        match.stakeWei,
        match.p1.address,
        match.p2.address,
        winnerAddress
      );
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
  await ensurePaidEscrowConfigured(pending.stakeWei);

  const player = pending.p1.ws === ws ? pending.p1.playerAddress : pending.p2.playerAddress;
  const receipt = await stakeProvider.waitForTransaction(txHash, 1, 90000);
  if (!receipt || receipt.status !== 1) throw new Error("Escrow deposit transaction failed or was not confirmed.");

  const hasDeposit = await stakeEscrow.hasDeposit(pending.readyId, player);
  if (!hasDeposit) throw new Error("Escrow deposit was not found for this match.");
  return true;
}

wss.on("connection", (ws, req) => {
  const ip = clientIp(req);
  const requestOrigin = String(req.headers.origin || "non-browser");
  const ipConnections = connectionsByIp.get(ip) || 0;
  if (clients.size >= MAX_CLIENTS || ipConnections >= MAX_CONNECTIONS_PER_IP) {
    ws.close(1013, "Server busy");
    return;
  }

  let playerAddress = null;
  connectionsByIp.set(ip, ipConnections + 1);
  clients.add(ws);
  sendJson(ws, { type: "queue_update", players: queuePayload() });

  ws.on("message", async (message) => {
    if (!consumeMessageBudget(ws)) {
      ws.close(1008, "Rate limit exceeded");
      return;
    }

    try {
      const data = JSON.parse(message);
      if (!data || typeof data !== "object" || Array.isArray(data)) {
        sendJson(ws, { type: "error", message: "Invalid message" });
        return;
      }

      if (data.type === "1v1_join") {
        const requestedAddress = data.playerAddress;
        if (!requestedAddress || !ethers.isAddress(requestedAddress)) {
          sendJson(ws, { type: "error", message: "Invalid wallet address" });
          return;
        }

        if (socketIsBusy(ws)) {
          sendJson(ws, { type: "queue_status", status: "Already searching or playing" });
          return;
        }

        const normalizedAddress = ethers.getAddress(requestedAddress);
        if (addressIsBusy(normalizedAddress, ws)) {
          sendJson(ws, { type: "error", message: "This wallet is already searching or playing." });
          return;
        }

        const stakeWei = String(data.stakeWei || "0");
        if (!ALLOWED_STAKES.has(stakeWei)) {
          sendJson(ws, { type: "error", message: "Invalid stake amount" });
          return;
        }

        if (stakeWei !== "0") {
          if (!ws.authenticatedAddress || ws.authenticatedAddress.toLowerCase() !== normalizedAddress.toLowerCase()) {
            sendJson(ws, { type: "error", message: "Paid matchmaking requires wallet authentication first." });
            return;
          }
          if (ws.joiningPaid) {
            sendJson(ws, { type: "queue_status", status: "Checking paid mode" });
            return;
          }
          ws.joiningPaid = true;
          try {
            await ensurePaidEscrowConfigured(stakeWei);
          } catch (error) {
            console.error("Paid mode configuration check failed:", error.message || error);
            sendJson(ws, { type: "error", message: "Paid mode is temporarily unavailable. No deposit was requested." });
            return;
          } finally {
            ws.joiningPaid = false;
          }

          if (socketIsBusy(ws) || addressIsBusy(normalizedAddress, ws)) {
            sendJson(ws, { type: "error", message: "This wallet is already searching or playing." });
            return;
          }
        }

        cleanupQueue();

        playerAddress = normalizedAddress;
        console.log(`Player joined queue: ${playerAddress} stake=${stakeWei}`);
        queue.push({ ws, playerAddress, stakeWei, joinedAt: Date.now() });
        sendJson(ws, { type: "queue_status", status: "queued" });
        broadcastQueue();

        tryCreateReadyPair();
      }

      else if (data.type === "paid_auth_request") {
        const requestedAddress = data.playerAddress;
        if (!requestedAddress || !ethers.isAddress(requestedAddress) || socketIsBusy(ws)) {
          sendJson(ws, { type: "error", message: "Paid wallet authentication request is invalid." });
          return;
        }

        const normalizedAddress = ethers.getAddress(requestedAddress);
        const expiresAt = Date.now() + PAID_AUTH_TTL_MS;
        const nonce = ethers.hexlify(ethers.randomBytes(24));
        const authMessage = [
          "Simon on Base paid matchmaking",
          `Wallet: ${normalizedAddress}`,
          `Origin: ${requestOrigin}`,
          `Nonce: ${nonce}`,
          `Expires: ${new Date(expiresAt).toISOString()}`,
          "This signature does not authorize a transaction or token transfer."
        ].join("\n");
        ws.authChallenge = { address: normalizedAddress, message: authMessage, expiresAt };
        sendJson(ws, { type: "paid_auth_challenge", message: authMessage, expiresAt });
      }

      else if (data.type === "paid_auth_response") {
        const challenge = ws.authChallenge;
        ws.authChallenge = null;
        if (!challenge || Date.now() > challenge.expiresAt) {
          sendJson(ws, { type: "error", message: "Paid wallet authentication expired. Please try again." });
          return;
        }

        try {
          const recovered = ethers.verifyMessage(challenge.message, String(data.signature || ""));
          if (recovered.toLowerCase() !== challenge.address.toLowerCase()) throw new Error("wrong signer");
          ws.authenticatedAddress = challenge.address;
          sendJson(ws, { type: "paid_auth_ok", playerAddress: challenge.address });
        } catch {
          sendJson(ws, { type: "error", message: "Paid wallet authentication failed." });
        }
      }

      else if (data.type === "1v1_leave") {
        removeFromQueue(ws);
        const pending = findPendingBySocket(ws);
        if (pending) cancelPending(pending.readyId, "cancelled");
      }

      else if (data.type === "1v1_deposit") {
        const pending = pendingMatches.get(data.readyId);
        if (!pending || pending.stakeWei === "0" || (pending.p1.ws !== ws && pending.p2.ws !== ws)) {
          sendJson(ws, { type: "error", message: "Paid match expired. Please find another 1v1." });
          return;
        }
        if (pending.deposited.has(ws)) {
          sendPendingDepositState(pending);
          return;
        }
        if (pending.verifying.has(ws)) {
          sendJson(ws, { type: "deposit_state", verifying: true, youDeposited: false, opponentDeposited: false, bothDeposited: false });
          return;
        }
        if (!/^0x[0-9a-fA-F]{64}$/.test(String(data.txHash || ""))) {
          sendJson(ws, { type: "error", message: "Paid matches require a valid escrow deposit transaction." });
          return;
        }

        pending.verifying.add(ws);
        try {
          sendJson(ws, { type: "deposit_state", verifying: true, youDeposited: false, bothDeposited: false });
          await verifyPaidDeposit(pending, ws, String(data.txHash));
          if (pendingMatches.get(data.readyId) !== pending) {
            sendJson(ws, { type: "error", message: "Match expired after deposit. Open Pending reward to recover the stake." });
            return;
          }
          pending.deposited.add(ws);
          pending.funded = pending.deposited.size >= 2;
          sendPendingDepositState(pending);
        } catch (error) {
          sendJson(ws, { type: "error", message: error.message || "Could not verify escrow deposit." });
        } finally {
          pending.verifying.delete(ws);
        }
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

        if (pending.ready.has(ws) || pending.verifying.has(ws)) {
          sendJson(ws, { type: "ready_state", readyCount: pending.ready.size, message: "Ready already received. Waiting for opponent..." });
          return;
        }

        if (pending.stakeWei !== "0") {
          if (!pending.funded || !pending.deposited.has(ws)) {
            sendJson(ws, { type: "error", message: "Both escrow deposits must be confirmed before Ready." });
            return;
          }
        }

        pending.ready.add(ws);
        const readyCount = pending.ready.size;

        if (readyCount >= 2) {
          startPendingMatch(pending.readyId);
        } else if (pending.stakeWei !== "0") {
          startPaidReadyWindow(pending);
        } else {
          sendJson(pending.p1.ws, { type: "ready_state", readyCount, youReady: pending.ready.has(pending.p1.ws), opponentReady: pending.ready.has(pending.p2.ws) });
          sendJson(pending.p2.ws, { type: "ready_state", readyCount, youReady: pending.ready.has(pending.p2.ws), opponentReady: pending.ready.has(pending.p1.ws) });
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

        const clickedIndex = Number(data.index);
        if (!Number.isInteger(clickedIndex) || clickedIndex < 0 || clickedIndex > 3) return;

        const now = Date.now();
        if (now < player.acceptClicksAt) {
          player.earlyClicks++;
          if (player.earlyClicks > MAX_EARLY_CLICKS) {
            player.failed = true;
            match.forfeiter = player.address;
            sendJson(player.ws, { type: "player_failed", score: player.score, reason: "invalid_timing" });
            sendJson(opponent.ws, { type: "opponent_failed", score: player.score });
            endMatch(matchId, "invalid_timing");
          }
          return;
        }
        if (now - player.lastClickAt < MIN_CLICK_INTERVAL_MS) return;
        player.lastClickAt = now;

        const expectedIndex = player.sequence[player.step];

        if (clickedIndex === expectedIndex) {
          player.step++;
          // Level cleared
          if (player.step === player.sequence.length) {
            player.step = 0;
            player.score++;
            player.sequence.push(randomPadIndex());
            player.acceptClicksAt = Date.now() + playbackDelayMs(player);
            player.lastClickAt = 0;
            player.earlyClicks = 0;

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
    const remainingForIp = Math.max(0, (connectionsByIp.get(ip) || 1) - 1);
    if (remainingForIp === 0) connectionsByIp.delete(ip);
    else connectionsByIp.set(ip, remainingForIp);
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
