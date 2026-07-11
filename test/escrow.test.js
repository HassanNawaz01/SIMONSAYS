import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import fs from "node:fs/promises";
import { ethers } from "ethers";
import { network } from "hardhat";

let connection;
let provider;
let artifact;
let owner;
let serverSigner;
let feeRecipient;
let player1;
let player2;

async function deployEscrow() {
  const factory = new ethers.ContractFactory(artifact.abi, artifact.bytecode, owner);
  const escrow = await factory.deploy(await serverSigner.getAddress(), await feeRecipient.getAddress());
  await escrow.waitForDeployment();
  return escrow;
}

async function settlementSignature(escrow, matchId, p1, p2, stake, winner) {
  const hash = ethers.solidityPackedKeccak256(
    ["address", "bytes32", "address", "address", "uint256", "address"],
    [await escrow.getAddress(), matchId, p1, p2, stake, winner]
  );
  return serverSigner.signMessage(ethers.getBytes(hash));
}

before(async () => {
  connection = await network.create();
  provider = new ethers.BrowserProvider(connection.provider);
  [owner, serverSigner, feeRecipient, player1, player2] = await Promise.all(
    [0, 1, 2, 3, 4].map((index) => provider.getSigner(index))
  );
  artifact = JSON.parse(await fs.readFile(
    new URL("../artifacts/contracts/SimonStakeEscrowV2.sol/SimonStakeEscrowV2.json", import.meta.url),
    "utf8"
  ));
});

after(async () => {
  await connection?.close();
});

test("locks both stakes, credits fees, settles, and withdraws safely", async () => {
  const escrow = await deployEscrow();
  const stake = ethers.parseEther("0.0005");
  const fee = stake * 50n / 10000n;
  const matchId = ethers.hexlify(ethers.randomBytes(32));
  const p1 = await player1.getAddress();
  const p2 = await player2.getAddress();

  await (await escrow.connect(player1).deposit(matchId, p2, stake, { value: stake })).wait();
  await (await escrow.connect(player2).deposit(matchId, p1, stake, { value: stake })).wait();
  assert.equal(await escrow.credits(await feeRecipient.getAddress()), 0n);

  const signature = await settlementSignature(escrow, matchId, p1, p2, stake, p1);
  await (await escrow.connect(player2).settle(matchId, p1, signature)).wait();
  assert.equal(await escrow.credits(p1), (stake - fee) * 2n);
  assert.equal(await escrow.credits(await feeRecipient.getAddress()), fee * 2n);

  await (await escrow.connect(player1).withdraw()).wait();
  assert.equal(await escrow.credits(p1), 0n);
  await (await escrow.connect(feeRecipient).withdraw()).wait();
  assert.equal(await escrow.credits(await feeRecipient.getAddress()), 0n);
  assert.equal(await provider.getBalance(await escrow.getAddress()), 0n);
});

test("rejects unsupported stakes, wrong values, and forged settlements", async () => {
  const escrow = await deployEscrow();
  const p1 = await player1.getAddress();
  const p2 = await player2.getAddress();
  const matchId = ethers.hexlify(ethers.randomBytes(32));
  const stake = ethers.parseEther("0.0005");
  const fee = stake * 50n / 10000n;

  await assert.rejects(
    escrow.connect(player1).deposit(matchId, p2, 1n, { value: 1n }),
    /stake not allowed|execution reverted/i
  );
  await assert.rejects(
    escrow.connect(player1).deposit(matchId, p2, stake, { value: stake + fee }),
    /bad value|execution reverted/i
  );

  await (await escrow.connect(player1).deposit(matchId, p2, stake, { value: stake })).wait();
  await (await escrow.connect(player2).deposit(matchId, p1, stake, { value: stake })).wait();
  const forgedHash = ethers.keccak256(ethers.toUtf8Bytes("forged"));
  const forged = await player1.signMessage(ethers.getBytes(forgedHash));
  await assert.rejects(
    escrow.settle(matchId, p1, forged),
    /bad signature|execution reverted/i
  );
});

test("allows a lone depositor to recover the stake after timeout", async () => {
  const escrow = await deployEscrow();
  const stake = ethers.parseEther("0.0005");
  const matchId = ethers.hexlify(ethers.randomBytes(32));
  const p1 = await player1.getAddress();
  const p2 = await player2.getAddress();

  await (await escrow.connect(player1).deposit(matchId, p2, stake, { value: stake })).wait();
  await connection.provider.request({ method: "evm_increaseTime", params: [30 * 60 + 1] });
  await connection.provider.request({ method: "evm_mine", params: [] });
  await (await escrow.connect(player1).refundExpired(matchId)).wait();
  assert.equal(await escrow.credits(p1), stake);
});

test("refunds both full stakes without a fee when a funded match is cancelled", async () => {
  const escrow = await deployEscrow();
  const stake = ethers.parseEther("0.005");
  const matchId = ethers.hexlify(ethers.randomBytes(32));
  const p1 = await player1.getAddress();
  const p2 = await player2.getAddress();

  await (await escrow.connect(player1).deposit(matchId, p2, stake, { value: stake })).wait();
  await (await escrow.connect(player2).deposit(matchId, p1, stake, { value: stake })).wait();
  const signature = await settlementSignature(escrow, matchId, p1, p2, stake, ethers.ZeroAddress);
  await (await escrow.settle(matchId, ethers.ZeroAddress, signature)).wait();

  assert.equal(await escrow.credits(p1), stake);
  assert.equal(await escrow.credits(p2), stake);
  assert.equal(await escrow.credits(await feeRecipient.getAddress()), 0n);
});

test("calculates the requested 0.5 percent fee examples", async () => {
  const escrow = await deployEscrow();
  assert.equal(await escrow.feeFor(ethers.parseEther("0.001")), ethers.parseEther("0.000005"));
  assert.equal(await escrow.feeFor(ethers.parseEther("0.005")), ethers.parseEther("0.000025"));
  assert.equal(await escrow.feeFor(ethers.parseEther("0.01")), ethers.parseEther("0.00005"));
  assert.equal(await escrow.winnerPayout(ethers.parseEther("0.005")), ethers.parseEther("0.00995"));
});
