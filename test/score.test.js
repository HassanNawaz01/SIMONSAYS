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
let player1;
let player2;

async function deployScoreContract() {
  const factory = new ethers.ContractFactory(artifact.abi, artifact.bytecode, owner);
  const contract = await factory.deploy(await serverSigner.getAddress());
  await contract.waitForDeployment();
  return contract;
}

async function scoreSignature(contract, player, score, mode, matchId) {
  const { chainId } = await provider.getNetwork();
  const encoded = ethers.AbiCoder.defaultAbiCoder().encode(
    ["address", "uint256", "address", "uint256", "uint8", "bytes32"],
    [await contract.getAddress(), chainId, player, score, mode, matchId]
  );
  return serverSigner.signMessage(ethers.getBytes(ethers.keccak256(encoded)));
}

before(async () => {
  connection = await network.create();
  provider = new ethers.BrowserProvider(connection.provider);
  [owner, serverSigner, player1, player2] = await Promise.all(
    [0, 1, 2, 3].map((index) => provider.getSigner(index))
  );
  artifact = JSON.parse(await fs.readFile(
    new URL("../artifacts/contracts/SimonOnBaseVerified.sol/SimonOnBaseVerified.json", import.meta.url),
    "utf8"
  ));
});

after(async () => {
  await connection?.close();
});

test("lets both players mint once for the same match and blocks cross-contract replay", async () => {
  const scoreContract = await deployScoreContract();
  const otherContract = await deployScoreContract();
  const matchId = ethers.hexlify(ethers.randomBytes(32));
  const p1 = await player1.getAddress();
  const p2 = await player2.getAddress();
  const p1Signature = await scoreSignature(scoreContract, p1, 4n, 1, matchId);
  const p2Signature = await scoreSignature(scoreContract, p2, 3n, 1, matchId);

  await (await scoreContract.connect(player1).mintVerifiedScore(4n, 1, matchId, p1Signature)).wait();
  await (await scoreContract.connect(player2).mintVerifiedScore(3n, 1, matchId, p2Signature)).wait();
  assert.equal(await scoreContract.bestScore(p1), 4n);
  assert.equal(await scoreContract.bestScore(p2), 3n);
  assert.equal(await scoreContract.usedMatches(matchId, p1), true);
  assert.equal(await scoreContract.usedMatches(matchId, p2), true);

  await assert.rejects(
    scoreContract.connect(player1).mintVerifiedScore(4n, 1, matchId, p1Signature),
    /match already minted|execution reverted/i
  );
  await assert.rejects(
    otherContract.connect(player1).mintVerifiedScore(4n, 1, matchId, p1Signature),
    /invalid signature|execution reverted/i
  );
});
