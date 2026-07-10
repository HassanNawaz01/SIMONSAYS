import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { spawn } from "node:child_process";
import http from "node:http";
import { once } from "node:events";
import { ethers } from "ethers";
import { WebSocket } from "ws";

let child;
let baseUrl;
let wsUrl;
let testSignerWallet;

async function availablePort() {
  const probe = http.createServer();
  probe.listen(0, "127.0.0.1");
  await once(probe, "listening");
  const { port } = probe.address();
  await new Promise((resolve) => probe.close(resolve));
  return port;
}

async function waitForServer(url) {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url + "/health");
      if (response.ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("Test server did not start in time");
}

function socketInbox(url) {
  const ws = new WebSocket(url);
  const messages = [];
  const waiters = [];

  ws.on("message", (raw) => {
    const message = JSON.parse(raw.toString());
    const index = waiters.findIndex((waiter) => waiter.predicate(message));
    if (index >= 0) {
      const [waiter] = waiters.splice(index, 1);
      clearTimeout(waiter.timer);
      waiter.resolve(message);
    } else {
      messages.push(message);
    }
  });

  return {
    ws,
    async open() {
      if (ws.readyState === WebSocket.OPEN) return;
      await once(ws, "open");
    },
    next(predicate, timeoutMs = 8000) {
      const index = messages.findIndex(predicate);
      if (index >= 0) return Promise.resolve(messages.splice(index, 1)[0]);
      return new Promise((resolve, reject) => {
        const waiter = { predicate, resolve, timer: null };
        waiter.timer = setTimeout(() => {
          const current = waiters.indexOf(waiter);
          if (current >= 0) waiters.splice(current, 1);
          reject(new Error("Timed out waiting for WebSocket message"));
        }, timeoutMs);
        waiters.push(waiter);
      });
    }
  };
}

before(async () => {
  const port = await availablePort();
  baseUrl = `http://127.0.0.1:${port}`;
  wsUrl = `ws://127.0.0.1:${port}`;
  testSignerWallet = ethers.Wallet.createRandom();
  child = spawn(process.execPath, ["server.js"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      PORT: String(port),
      SIGNER_PRIVATE_KEY: testSignerWallet.privateKey,
      BASE_RPC_URL: "http://127.0.0.1:1"
    },
    stdio: ["ignore", "pipe", "pipe"]
  });
  await waitForServer(baseUrl);
});

after(async () => {
  if (!child || child.exitCode !== null) return;
  child.kill();
  await Promise.race([once(child, "exit"), new Promise((resolve) => setTimeout(resolve, 2000))]);
});

test("serves only public assets and sends browser security headers", async () => {
  const page = await fetch(baseUrl + "/");
  assert.equal(page.status, 200);
  assert.match(page.headers.get("content-security-policy") || "", /frame-ancestors 'none'/);
  assert.equal(page.headers.get("x-content-type-options"), "nosniff");
  assert.equal(page.headers.get("x-frame-options"), "DENY");

  for (const pathname of ["/.env", "/server.js", "/package.json", "/contracts/SimonStakeEscrow.sol"]) {
    const response = await fetch(baseUrl + pathname);
    assert.equal(response.status, 404, pathname + " must not be public");
  }
});

test("rejects invalid settlement lookups", async () => {
  const bad = await fetch(baseUrl + "/api/settlement?matchId=bad");
  assert.equal(bad.status, 400);
  const missing = await fetch(baseUrl + "/api/settlement?matchId=" + "0x" + "11".repeat(32));
  assert.equal(missing.status, 404);
});

test("requires a wallet ownership signature before paid matchmaking", async () => {
  const client = socketInbox(wsUrl);
  await client.open();
  const player = ethers.Wallet.createRandom();

  client.ws.send(JSON.stringify({ type: "1v1_join", playerAddress: player.address, stakeWei: "500000000000000" }));
  const unauthenticated = await client.next((message) => message.type === "error");
  assert.match(unauthenticated.message, /authentication first/i);

  client.ws.send(JSON.stringify({ type: "paid_auth_request", playerAddress: player.address }));
  const challenge = await client.next((message) => message.type === "paid_auth_challenge");
  const signature = await player.signMessage(challenge.message);
  client.ws.send(JSON.stringify({ type: "paid_auth_response", signature }));
  const authenticated = await client.next((message) => message.type === "paid_auth_ok");
  assert.equal(authenticated.playerAddress, player.address);
  client.ws.close();
});

test("pairs unique wallets and rejects click automation during pattern playback", async () => {
  const p1 = socketInbox(wsUrl);
  const p2 = socketInbox(wsUrl);
  const duplicate = socketInbox(wsUrl);
  await Promise.all([p1.open(), p2.open(), duplicate.open()]);

  const address1 = ethers.Wallet.createRandom().address;
  const address2 = ethers.Wallet.createRandom().address;
  p1.ws.send(JSON.stringify({ type: "1v1_join", playerAddress: address1, stakeWei: "0" }));
  p2.ws.send(JSON.stringify({ type: "1v1_join", playerAddress: address2, stakeWei: "0" }));

  const [ready1, ready2] = await Promise.all([
    p1.next((message) => message.type === "ready_check"),
    p2.next((message) => message.type === "ready_check")
  ]);
  assert.equal(ready1.readyId, ready2.readyId);

  duplicate.ws.send(JSON.stringify({ type: "1v1_join", playerAddress: address1, stakeWei: "0" }));
  const duplicateError = await duplicate.next((message) => message.type === "error");
  assert.match(duplicateError.message, /already searching or playing/i);

  p1.ws.send(JSON.stringify({ type: "1v1_ready", readyId: ready1.readyId, ready: true }));
  p2.ws.send(JSON.stringify({ type: "1v1_ready", readyId: ready2.readyId, ready: true }));
  await Promise.all([
    p1.next((message) => message.type === "match_start"),
    p2.next((message) => message.type === "match_start")
  ]);
  await p1.next((message) => message.type === "match_go", 8000);

  for (let i = 0; i <= 20; i++) {
    p1.ws.send(JSON.stringify({ type: "1v1_click", matchId: ready1.readyId, index: 0 }));
  }
  const failed = await p1.next((message) => message.type === "player_failed");
  assert.equal(failed.reason, "invalid_timing");
  const ended = await p1.next((message) => message.type === "match_end");
  const scorePayload = ethers.AbiCoder.defaultAbiCoder().encode(
    ["address", "uint256", "address", "uint256", "uint8", "bytes32"],
    ["0xd376DA21BDCDD1338C2283488d592880F25F09f1", 8453n, address1, BigInt(ended.score), 1, ready1.readyId]
  );
  const recoveredSigner = ethers.verifyMessage(
    ethers.getBytes(ethers.keccak256(scorePayload)),
    ended.signature
  );
  assert.equal(recoveredSigner, testSignerWallet.address);

  p1.ws.close();
  p2.ws.close();
  duplicate.ws.close();
});
