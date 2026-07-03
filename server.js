import http from "http";
import { WebSocketServer, WebSocket } from "ws";
import { ethers } from "ethers";

// Development signer private key (Hardhat account #0)
// Signer Address: 0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266
const SIGNER_PRIVATE_KEY = process.env.SIGNER_PRIVATE_KEY || "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
const wallet = new ethers.Wallet(SIGNER_PRIVATE_KEY);
console.log(`Simon says server started. Signer address: ${wallet.address}`);

const server = http.createServer((req, res) => {
  res.writeHead(200, { "Content-Type": "text/plain" });
  res.end("Simon 1v1 Server Running\n");
});

const wss = new WebSocketServer({ server });

let queue = []; // Array of { ws, playerAddress }
let activeMatches = new Map(); // matchId => MatchState

function generateMatchId() {
  return ethers.hexlify(ethers.randomBytes(32));
}

function broadcast(match, data) {
  const msg = JSON.stringify(data);
  if (match.p1.ws.readyState === WebSocket.OPEN) match.p1.ws.send(msg);
  if (match.p2.ws.readyState === WebSocket.OPEN) match.p2.ws.send(msg);
}

wss.on("connection", (ws) => {
  let playerAddress = null;
  let currentMatchId = null;

  ws.on("message", async (message) => {
    try {
      const data = JSON.parse(message);

      if (data.type === "1v1_join") {
        playerAddress = data.playerAddress;
        if (!playerAddress || !ethers.isAddress(playerAddress)) {
          ws.send(JSON.stringify({ type: "error", message: "Invalid wallet address" }));
          return;
        }

        // Check if already in queue
        if (queue.some(p => p.playerAddress.toLowerCase() === playerAddress.toLowerCase())) {
          ws.send(JSON.stringify({ type: "queue_status", status: "Already in queue" }));
          return;
        }

        console.log(`Player joined queue: ${playerAddress}`);
        queue.push({ ws, playerAddress });
        ws.send(JSON.stringify({ type: "queue_status", status: "queued" }));

        // Matchmaking trigger
        if (queue.length >= 2) {
          const p1 = queue.shift();
          const p2 = queue.shift();

          const matchId = generateMatchId();
          const initialSequence = [Math.floor(Math.random() * 4)];

          const match = {
            matchId,
            timeLeft: 90,
            p1: {
              ws: p1.ws,
              address: p1.playerAddress,
              score: 0,
              sequence: [...initialSequence],
              step: 0,
              failed: false
            },
            p2: {
              ws: p2.ws,
              address: p2.playerAddress,
              score: 0,
              sequence: [...initialSequence],
              step: 0,
              failed: false
            },
            timerInterval: null
          };

          activeMatches.set(matchId, match);

          // Notify players
          p1.ws.send(JSON.stringify({
            type: "match_start",
            matchId,
            opponent: p2.playerAddress,
            initialSequence,
            timeLeft: match.timeLeft
          }));

          p2.ws.send(JSON.stringify({
            type: "match_start",
            matchId,
            opponent: p1.playerAddress,
            initialSequence,
            timeLeft: match.timeLeft
          }));

          console.log(`Match started: ${matchId} between ${p1.playerAddress} and ${p2.playerAddress}`);

          // Start match countdown timer
          match.timerInterval = setInterval(() => {
            match.timeLeft--;
            broadcast(match, { type: "timer_tick", timeLeft: match.timeLeft });

            if (match.timeLeft <= 0) {
              endMatch(matchId, "time_out");
            }
          }, 1000);
        }
      }

      else if (data.type === "1v1_click") {
        const matchId = data.matchId;
        const match = activeMatches.get(matchId);
        if (!match) return;

        const isP1 = ws === match.p1.ws;
        const player = isP1 ? match.p1 : match.p2;
        const opponent = isP1 ? match.p2 : match.p1;

        if (player.failed || match.timeLeft <= 0) return;

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
            player.ws.send(JSON.stringify({
              type: "next_round",
              sequence: player.sequence,
              score: player.score
            }));

            // Notify opponent of score update
            opponent.ws.send(JSON.stringify({
              type: "opponent_score",
              score: player.score
            }));
          }
        } else {
          // Player failed
          player.failed = true;
          player.ws.send(JSON.stringify({ type: "player_failed", score: player.score }));
          opponent.ws.send(JSON.stringify({ type: "opponent_failed", score: player.score }));

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

  async function endMatch(matchId, reason) {
    const match = activeMatches.get(matchId);
    if (!match) return;

    clearInterval(match.timerInterval);
    activeMatches.delete(matchId);

    console.log(`Ending match ${matchId}. Reason: ${reason}`);

    // Determine winner
    let p1Result = "tie";
    let p2Result = "tie";

    if (match.p1.score > match.p2.score) {
      p1Result = "win";
      p2Result = "lose";
    } else if (match.p2.score > match.p1.score) {
      p1Result = "lose";
      p2Result = "win";
    }

    // Sign match results
    // Hash fields: playerAddress, score, mode (1 for onchain), matchId
    const signScore = async (playerAddr, score) => {
      const messageHash = ethers.solidityPackedKeccak256(
        ["address", "uint256", "uint8", "bytes32"],
        [playerAddr, score, 1, matchId]
      );
      return await wallet.signMessage(ethers.getBytes(messageHash));
    };

    const p1Sig = await signScore(match.p1.address, match.p1.score);
    const p2Sig = await signScore(match.p2.address, match.p2.score);

    // Send results
    if (match.p1.ws.readyState === WebSocket.OPEN) {
      match.p1.ws.send(JSON.stringify({
        type: "match_end",
        score: match.p1.score,
        opponentScore: match.p2.score,
        result: p1Result,
        signature: p1Sig,
        matchId
      }));
    }

    if (match.p2.ws.readyState === WebSocket.OPEN) {
      match.p2.ws.send(JSON.stringify({
        type: "match_end",
        score: match.p2.score,
        opponentScore: match.p1.score,
        result: p2Result,
        signature: p2Sig,
        matchId
      }));
    }
  }

  ws.on("close", () => {
    // Remove from queue if disconnected
    queue = queue.filter((p) => p.ws !== ws);
    console.log("Connection closed.");
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server is listening on port ${PORT}`);
});
