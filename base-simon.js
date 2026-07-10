    "use strict";

    /* =========================================================
       CONFIG - deploy SimonOnBase.sol on Base mainnet,
       then paste the deployed address below.
       ========================================================= */
    const CONTRACT_ADDRESS = "0xd376DA21BDCDD1338C2283488d592880F25F09f1";
    const STAKE_ESCROW_ADDRESS = "0x654B8495765f8Db94f4880c20F5c7E5f8a9CFe90";
    const STAKE_ESCROW_DEPLOY_BLOCK = "0x2e34a18";
    const STAKE_DEPOSITED_TOPIC = "0xe3ad398758b9cbdf4196c5d060a1aebae967b4f9115c7394e937cbb46f449587";

    /* Function selectors (keccak256 of the signature, first 4 bytes) */
    const SEL = {
      mint: "0x08142c10", // mintScore(uint256,uint8)
      mintVerified: "0x135b34bd", // mintVerifiedScore(uint256,uint8,bytes32,bytes)
      scoreSigner: "0x5b7633d0", // signerAddress()
      stakeDeposit: "0xd954863c", // deposit(bytes32,address,uint256)
      stakeSettle: "0x1369b2b4", // settle(bytes32,address,bytes)
      stakeRefundExpired: "0xcc3e049b", // refundExpired(bytes32)
      stakeMatches: "0x9fe9ada3", // matches(bytes32)
      stakeCredits: "0xfe5ff468", // credits(address)
      stakeWithdraw: "0x3ccfd60b", // withdraw()
      best: "0xdc0c695f", // bestScore(address)
      games: "0x2c4e591b", // totalGames()
      week: "0x06575c89", // currentWeek()
      pCount: "0x302bcc57", // playerCount()
      wCount: "0xbc5a4f3c", // weekPlayerCount(uint256)
      range: "0xf5441d17", // getRange(uint256,uint256)
      wRange: "0x0990ccc9", // getWeekRange(uint256,uint256,uint256)
      claim: "0xb5804373", // claimBadge(uint8)
      claimed: "0xfbb905e3",// claimed(address,uint8)
      ensName: "0x691f3431",// name(bytes32)   - Basenames L2Resolver
      ensAddr: "0x3b3b57de" // addr(bytes32)
    };

    const BASE_CHAIN = {
      chainId: "0x2105", chainName: "Base",
      nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
      rpcUrls: ["https://mainnet.base.org"],
      blockExplorerUrls: ["https://basescan.org"]
    };

    /* Basenames (official Base deployments - verified) */
    const L2_RESOLVER = "0xC6d566A56A1aFf6508b41f6c90ff131615583BCD";
    /* namehash("80002105.reverse") - Base coinType reverse namespace, precomputed */
    const BASE_REVERSE_NODE = "08d9b0993eb8c4da57c37a4b84a6e384c2623114ff4e9370ed51c9b8935109ba";

    const BADGE_THRESHOLDS = [10, 25, 50];
    const WEEK_SECONDS = 604800;

    /* =========================================================
       keccak-256 (BigInt implementation, no external libraries)
       Verified against pycryptodome test vectors.
       ========================================================= */
    const keccak256 = (() => {
      const RC = ["0x1", "0x8082", "0x800000000000808A", "0x8000000080008000", "0x808B", "0x80000001",
        "0x8000000080008081", "0x8000000000008009", "0x8A", "0x88", "0x80008009", "0x8000000A",
        "0x8000808B", "0x800000000000008B", "0x8000000000008089", "0x8000000000008003",
        "0x8000000000008002", "0x8000000000000080", "0x800A", "0x800000008000000A",
        "0x8000000080008081", "0x8000000000008080", "0x80000001", "0x8000000080008008"].map(BigInt);
      const R = [[0, 36, 3, 41, 18], [1, 44, 10, 45, 2], [62, 6, 43, 15, 61], [28, 55, 25, 21, 56], [27, 20, 39, 8, 14]];
      const M = (1n << 64n) - 1n;
      const rot = (v, n) => n === 0 ? v : (((v << BigInt(n)) | (v >> BigInt(64 - n))) & M);
      return function (bytes) { // Uint8Array → 32-byte hex (no 0x)
        const rate = 136;
        const padded = new Uint8Array(Math.ceil((bytes.length + 1) / rate) * rate);
        padded.set(bytes); padded[bytes.length] ^= 0x01; padded[padded.length - 1] ^= 0x80;
        const A = Array.from({ length: 5 }, () => Array(5).fill(0n));
        for (let off = 0; off < padded.length; off += rate) {
          for (let i = 0; i < rate / 8; i++) {
            let lane = 0n;
            for (let b = 7; b >= 0; b--) lane = (lane << 8n) | BigInt(padded[off + i * 8 + b]);
            A[i % 5][(i / 5) | 0] ^= lane;
          }
          for (let r = 0; r < 24; r++) {
            const C = [], D = [];
            for (let x = 0; x < 5; x++) C[x] = A[x][0] ^ A[x][1] ^ A[x][2] ^ A[x][3] ^ A[x][4];
            for (let x = 0; x < 5; x++) D[x] = C[(x + 4) % 5] ^ rot(C[(x + 1) % 5], 1);
            for (let x = 0; x < 5; x++)for (let y = 0; y < 5; y++) A[x][y] ^= D[x];
            const B = Array.from({ length: 5 }, () => Array(5).fill(0n));
            for (let x = 0; x < 5; x++)for (let y = 0; y < 5; y++) B[y][(2 * x + 3 * y) % 5] = rot(A[x][y], R[x][y]);
            for (let x = 0; x < 5; x++)for (let y = 0; y < 5; y++) A[x][y] = B[x][y] ^ ((~B[(x + 1) % 5][y] & M) & B[(x + 2) % 5][y]);
            A[0][0] ^= RC[r];
          }
        }
        let out = "";
        for (let i = 0; i < 4; i++) {
          let lane = A[i % 5][(i / 5) | 0];
          for (let b = 0; b < 8; b++) out += Number((lane >> BigInt(8 * b)) & 0xFFn).toString(16).padStart(2, "0");
        }
        return out;
      };
    })();
    const utf8 = s => new TextEncoder().encode(s);
    const utf8Hex = s => "0x" + [...utf8(s)].map(byte => byte.toString(16).padStart(2, "0")).join("");
    const hexBytes = h => { const a = new Uint8Array(h.length / 2); for (let i = 0; i < a.length; i++) a[i] = parseInt(h.substr(i * 2, 2), 16); return a; };
    function namehash(name) {
      let node = "0".repeat(64);
      if (name) {
        for (const label of name.toLowerCase().split(".").reverse()) {
          node = keccak256(hexBytes(node + keccak256(utf8(label))));
        }
      }
      return node;
    }

    /* ================= DOM refs ================= */
    const $ = id => document.getElementById(id);
    const pads = [...document.querySelectorAll(".pad")], board = $("board"), statusEl = $("status");
    const levelEl = $("level"), bestEl = $("best"), chainBestEl = $("chainBest"), startBtn = $("startBtn");
    const overlay = $("overlay"), finalScoreEl = $("finalScore"), mintBtn = $("mintBtn"), settleRewardBtn = $("settleRewardBtn"), againBtn = $("againBtn"), mintMsg = $("mintMsg");
    const walletBtn = $("walletBtn"), totalGamesEl = $("totalGames"), practiceNote = $("practiceNote");
    const lbTable = $("lbTable"), lbRefresh = $("lbRefresh"), lbMeta = $("lbMeta");
    const seasonNum = $("seasonNum"), countdown = $("countdown");
    const overTitle = $("overTitle"), overSub = $("overSub"), badgeMsg = $("badgeMsg");
    const queuePanel = $("queuePanel"), queueList = $("queueList"), queueCount = $("queueCount");
    const stakePanel = $("stakePanel"), stakeOptions = $("stakeOptions"), selectedStakeLabel = $("selectedStakeLabel");
    const rewardPanel = $("rewardPanel"), pendingRewardAmount = $("pendingRewardAmount"), pendingRewardMsg = $("pendingRewardMsg"), claimRewardBtn = $("claimRewardBtn"), refundStakeBtn = $("refundStakeBtn");
    const readyOverlay = $("readyOverlay"), readyOpponent = $("readyOpponent"), readyText = $("readyText");
    const readyAcceptBtn = $("readyAcceptBtn"), readyCancelBtn = $("readyCancelBtn");

    /* ================= tabs ================= */
    let quitConfirmCallback = null;
    let quitCancelCallback = null;

    function promptQuit(onConfirm, onCancel) {
      const quitOverlay = document.getElementById("quitOverlay");
      if (quitOverlay) quitOverlay.classList.add("show");
      
      quitConfirmCallback = () => {
        if (quitOverlay) quitOverlay.classList.remove("show");
        stopActiveGame();
        if (onConfirm) onConfirm();
      };
      
      quitCancelCallback = () => {
        if (quitOverlay) quitOverlay.classList.remove("show");
        if (onCancel) onCancel();
      };
    }

    document.getElementById("confirmQuitBtn").addEventListener("click", () => {
      if (quitConfirmCallback) quitConfirmCallback();
    });

    document.getElementById("cancelQuitBtn").addEventListener("click", () => {
      if (quitCancelCallback) quitCancelCallback();
    });

    function switchTab(b) {
      document.querySelectorAll("nav button").forEach(x => x.classList.toggle("on", x === b));
      document.querySelectorAll(".view").forEach(v => v.classList.toggle("on", v.id === "view-" + b.dataset.view));
      if (b.dataset.view === "ranks") loadLeaderboard();
      if (b.dataset.view === "badges") refreshBadges();
    }

    document.querySelectorAll("nav button").forEach(b => b.addEventListener("click", () => {
      if (running && b.dataset.view !== "play") {
        promptQuit(() => switchTab(b));
      } else {
        switchTab(b);
      }
    }));

    /* ================= difficulty modes ================= */
    const MODES = {
      practice: { label: "Practice", base: 620, step: 32, min: 220, mint: false, shuffle: false, id: null },
      onchain: { label: "Onchain", base: 620, step: 32, min: 220, mint: true, shuffle: false, id: 1 },
      multiplayer: { label: "1v1 Match", base: 620, step: 32, min: 220, mint: true, shuffle: false, id: 1 }
    };
    let modeKey = "onchain";
    const PAD_COLORS = ["var(--pad-1)", "var(--pad-2)", "var(--pad-3)", "var(--pad-4)"];
    function applyPadColors(order) { pads.forEach((p, i) => p.style.background = PAD_COLORS[order[i]]); }
    applyPadColors([0, 1, 2, 3]);

    function updateModeUI() {
      const isPractice = modeKey === "practice";
      const isMultiplayer = modeKey === "multiplayer";
      const hudEl = document.querySelector(".hud");
      const chainStatBox = chainBestEl.closest(".stat");
      const multiHud = document.getElementById("multiplayerHud");
      
      if (chainStatBox && hudEl) {
        if (isPractice) {
          chainStatBox.style.display = "none";
          hudEl.style.gridTemplateColumns = "repeat(2, 1fr)";
        } else {
          chainStatBox.style.display = "";
          hudEl.style.gridTemplateColumns = "repeat(3, 1fr)";
        }
      }

      if (multiHud) {
        multiHud.style.display = "none";
      }
      if (queuePanel) queuePanel.hidden = !isMultiplayer;
      if (stakePanel) stakePanel.hidden = !isMultiplayer;

      if (isMultiplayer) {
        startBtn.textContent = isQueueing ? "Cancel Queue" : "Find " + stakeLabel(selectedStakeWei) + " 1v1";
        if (isQueueing) {
          startBtn.style.background = "var(--bad)";
        } else {
          startBtn.style.background = "";
        }
      } else {
        startBtn.textContent = "Start game";
        startBtn.style.background = "";
        renderQueue([]);
        if (rewardPanel) rewardPanel.hidden = true;
      }
    }

    function switchMode(m) {
      modeKey = m.dataset.mode;
      document.querySelectorAll(".mode").forEach(x => x.classList.toggle("on", x === m));
      practiceNote.textContent = MODES[modeKey].mint ? "" : "Practice runs are not minted onchain. Just for training.";
      setStatus("Ready for " + MODES[modeKey].label + " mode");
      updateModeUI();
      refreshPendingReward();
    }

    document.querySelectorAll(".mode").forEach(m => m.addEventListener("click", () => {
      if (running) {
        promptQuit(() => switchMode(m));
      } else {
        switchMode(m);
      }
    }));

    stakeOptions?.querySelectorAll("button").forEach((button) => {
      button.addEventListener("click", () => {
        if (isQueueing || running) return;
        selectedStakeWei = button.dataset.stake || "0";
        stakeOptions.querySelectorAll("button").forEach((b) => b.classList.toggle("on", b === button));
        selectedStakeLabel.textContent = stakeLabel(selectedStakeWei);
        renderQueue(queuePlayers);
        updateModeUI();
      });
    });

    /* ================= WebSockets Client ================= */
    let wsClient = null;
    let isQueueing = false;
    let activeMatchId = null;
    let lastSignature = null;
    let lastMatchId = null;
    let pendingReadyId = null;
    let pendingOpponent = null;
    let pendingStakeWei = "0";
    let lastSettlement = null;
    let pendingRefunds = [];
    let queuePlayers = [];
    let selectedStakeWei = "0";
    const DEFAULT_WS_URL = "wss://simonsays-ayuz.onrender.com";
    const STAKE_LABELS = {
      "0": "Free",
      "500000000000000": "0.0005 ETH",
      "1000000000000000": "0.001 ETH",
      "5000000000000000": "0.005 ETH",
      "10000000000000000": "0.01 ETH"
    };

    function stakeLabel(stakeWei) {
      return STAKE_LABELS[String(stakeWei || "0")] || "Custom";
    }

    function isPaidStake(stakeWei = selectedStakeWei) {
      return String(stakeWei || "0") !== "0";
    }

    function playerLabel(addr) {
      return /^0x[0-9a-fA-F]{40}$/.test(addr || "") ? short(addr) : "Unknown";
    }

    async function hydrateName(el, addr) {
      if (!el || !/^0x[0-9a-fA-F]{40}$/.test(addr || "")) return;
      const name = await resolveBasename(addr);
      if (name) {
        el.textContent = name;
        el.closest(".queue-player")?.classList.add("named");
      }
    }

    function renderQueue(players = queuePlayers) {
      queuePlayers = players;
      if (!queueList || !queueCount) return;

      const visiblePlayers = players.filter((p) => String(p.stakeWei || "0") === String(selectedStakeWei));
      queueCount.textContent = visiblePlayers.length + (visiblePlayers.length === 1 ? " online" : " online");
      queueList.replaceChildren();
      if (!visiblePlayers.length) {
        const empty = document.createElement("div");
        empty.className = "queue-empty";
        empty.textContent = "No players waiting for " + stakeLabel(selectedStakeWei) + " yet.";
        queueList.append(empty);
        return;
      }

      visiblePlayers.forEach((p) => {
        if (!addressReady(p.address)) return;
        const me = account && p.address && p.address.toLowerCase() === account.toLowerCase();
        const row = document.createElement("div");
        row.className = "queue-player";
        row.dataset.address = p.address;

        const who = document.createElement("span");
        who.className = "who";
        who.textContent = me ? "You" : playerLabel(p.address);
        const amount = document.createElement("span");
        amount.className = "amount";
        amount.textContent = stakeLabel(p.stakeWei);
        const state = document.createElement("span");
        state.className = "state";
        state.textContent = me ? "waiting" : "online";
        row.append(who, amount, state);
        queueList.append(row);
      });

      queueList.querySelectorAll(".queue-player").forEach((row) => {
        const addr = row.dataset.address;
        if (account && addr && addr.toLowerCase() === account.toLowerCase()) return;
        hydrateName(row.querySelector(".who"), addr);
      });
    }

    async function showReadyPrompt(msg) {
      pendingReadyId = msg.readyId;
      pendingOpponent = msg.opponent;
      pendingStakeWei = String(msg.stakeWei || "0");
      const label = await resolveBasename(msg.opponent) || playerLabel(msg.opponent);
      const paid = isPaidStake(msg.stakeWei);
      readyOpponent.textContent = label;
      readyText.textContent = paid
        ? "Paid match: " + stakeLabel(msg.stakeWei) + " each. " + paidBreakdown(msg.stakeWei) + " Deposit window: " + Math.floor((msg.expiresIn || 180) / 60) + " min."
        : "Are you ready to play? Waiting for both players.";
      readyAcceptBtn.disabled = false;
      readyCancelBtn.disabled = false;
      readyAcceptBtn.textContent = paid ? "Deposit & Ready" : "Ready";
      readyOverlay.classList.add("show");
      setStatus("Opponent found. Confirm when ready.", "go");
      updateModeUI();
    }

    function hideReadyPrompt() {
      pendingReadyId = null;
      pendingOpponent = null;
      pendingStakeWei = "0";
      readyOverlay.classList.remove("show");
      readyAcceptBtn.disabled = false;
      readyCancelBtn.disabled = false;
      readyAcceptBtn.textContent = "Ready";
    }

    function addressReady(addr) {
      return /^0x[0-9a-fA-F]{40}$/.test(addr || "");
    }

    function requiredStakeValue(stakeWei) {
      const stake = BigInt(stakeWei || "0");
      return stake + stakeFeeValue(stakeWei);
    }

    function stakeFeeValue(stakeWei) {
      const stake = BigInt(stakeWei || "0");
      return (stake * 5n) / 10000n;
    }

    function winningValue(stakeWei) {
      return BigInt(stakeWei || "0") * 2n;
    }

    function formatEth(wei, maxDecimals = 9) {
      const value = BigInt(wei || 0);
      const whole = value / 1000000000000000000n;
      const frac = (value % 1000000000000000000n).toString().padStart(18, "0").replace(/0+$/, "");
      return frac ? whole + "." + frac.slice(0, maxDecimals) + " ETH" : whole + " ETH";
    }

    function paidBreakdown(stakeWei) {
      const stake = BigInt(stakeWei || "0");
      if (stake === 0n) return "";
      const feeEach = stakeFeeValue(stakeWei);
      return "Winner gets " + formatEth(winningValue(stakeWei)) +
        ". Platform fee " + formatEth(feeEach) + " each (" + formatEth(feeEach * 2n) + " total, 0.1%).";
    }

    function encodeStakeDepositData(matchId, opponent, stakeWei) {
      const cleanMatchId = matchId.replace(/^0x/, "").padStart(64, "0");
      return SEL.stakeDeposit +
        cleanMatchId +
        pad64(BigInt(opponent)) +
        pad64(BigInt(stakeWei));
    }

    function encodeBytes(hex) {
      const clean = String(hex || "0x").replace(/^0x/, "");
      const byteLen = clean.length / 2;
      const paddedLen = Math.ceil(byteLen / 32) * 64;
      return pad64(BigInt(byteLen)) + clean.padEnd(paddedLen, "0");
    }

    function encodeStakeSettleData(matchId, winner, signature) {
      const cleanMatchId = matchId.replace(/^0x/, "").padStart(64, "0");
      const cleanWinner = String(winner || "0x0").toLowerCase();
      const signatureOffset = pad64(96n);
      return SEL.stakeSettle +
        cleanMatchId +
        pad64(BigInt(cleanWinner)) +
        signatureOffset +
        encodeBytes(signature);
    }

    function encodeStakeRefundData(matchId) {
      return SEL.stakeRefundExpired + matchId.replace(/^0x/, "").padStart(64, "0");
    }

    function topicAddress(addr) {
      return "0x" + String(addr || "").replace(/^0x/, "").toLowerCase().padStart(64, "0");
    }

    function decodeEscrowMatch(raw) {
      if (!raw || raw === "0x") return null;
      return {
        player1: "0x" + word(raw, 0).slice(24),
        player2: "0x" + word(raw, 1).slice(24),
        stake: BigInt("0x" + word(raw, 2)),
        createdAt: BigInt("0x" + word(raw, 3)),
        player1Deposited: BigInt("0x" + word(raw, 4)) !== 0n,
        player2Deposited: BigInt("0x" + word(raw, 5)) !== 0n,
        settled: BigInt("0x" + word(raw, 6)) !== 0n
      };
    }

    async function loadPendingRefunds() {
      if (!account || !escrowReady()) return [];
      try {
        const logs = await window.ethereum.request({
          method: "eth_getLogs",
          params: [{
            address: STAKE_ESCROW_ADDRESS,
            fromBlock: STAKE_ESCROW_DEPLOY_BLOCK,
            toBlock: "latest",
            topics: [STAKE_DEPOSITED_TOPIC, null, topicAddress(account)]
          }]
        });

        const byMatch = new Map();
        for (const log of logs || []) {
          const matchId = log.topics && log.topics[1];
          if (!matchId || byMatch.has(matchId.toLowerCase())) continue;
          const raw = await ethCall(STAKE_ESCROW_ADDRESS, SEL.stakeMatches + matchId.replace(/^0x/, ""));
          const match = decodeEscrowMatch(raw);
          if (!match || match.settled || match.createdAt === 0n) continue;

          const user = account.toLowerCase();
          const depositedByUser =
            (match.player1.toLowerCase() === user && match.player1Deposited) ||
            (match.player2.toLowerCase() === user && match.player2Deposited);
          const partialDeposit = match.player1Deposited !== match.player2Deposited;
          if (!depositedByUser || !partialDeposit) continue;

          const refundableAt = Number(match.createdAt) * 1000 + (30 * 60 * 1000);
          byMatch.set(matchId.toLowerCase(), {
            matchId,
            stakeWei: match.stake.toString(),
            refundableAt,
            canRefund: Date.now() >= refundableAt
          });
        }
        return [...byMatch.values()];
      } catch (e) {
        return pendingRefunds;
      }
    }

    function refundWaitText(refund) {
      const waitMs = Math.max(0, refund.refundableAt - Date.now());
      const mins = Math.ceil(waitMs / 60000);
      return mins <= 1 ? "about 1 minute" : mins + " minutes";
    }

    function settlementStorageKey(matchId) {
      return account && matchId ? "simon:paid-settlement:" + account.toLowerCase() + ":" + matchId.toLowerCase() : null;
    }

    function saveSettlement(settlement) {
      lastSettlement = settlement;
      const key = settlementStorageKey(settlement.matchId);
      if (key) localStorage.setItem(key, JSON.stringify(settlement));
      updateSettleRewardUI();
    }

    function clearSettlement(matchId) {
      const key = settlementStorageKey(matchId);
      if (key) localStorage.removeItem(key);
      if (lastSettlement && lastSettlement.matchId === matchId) lastSettlement = null;
      updateSettleRewardUI();
    }

    function updateSettleRewardUI() {
      if (!settleRewardBtn) return;
      const canSettle = modeKey === "multiplayer" && lastSettlement && lastSettlement.signature && escrowReady();
      settleRewardBtn.hidden = !canSettle;
      settleRewardBtn.disabled = false;
      settleRewardBtn.textContent = "Settle paid reward";
    }

    async function fetchServerSettlement(matchId) {
      if (!matchId) return null;
      try {
        const serverOrigin = wsToHttpUrl(resolveWsUrl());
        if (!serverOrigin) return null;
        const endpoint = new URL("/api/settlement", serverOrigin);
        endpoint.searchParams.set("matchId", matchId);
        const res = await fetch(endpoint, { cache: "no-store" });
        if (!res.ok) return null;
        const data = await res.json();
        return data && data.ok ? data.settlement : null;
      } catch (e) {
        return null;
      }
    }

    async function recoverFundedSettlement() {
      if (!account || !escrowReady() || lastSettlement) return null;
      try {
        const logs = await window.ethereum.request({
          method: "eth_getLogs",
          params: [{
            address: STAKE_ESCROW_ADDRESS,
            fromBlock: STAKE_ESCROW_DEPLOY_BLOCK,
            toBlock: "latest",
            topics: [STAKE_DEPOSITED_TOPIC, null, topicAddress(account)]
          }]
        });

        for (const log of [...(logs || [])].reverse()) {
          const matchId = log.topics && log.topics[1];
          if (!matchId) continue;
          const raw = await ethCall(STAKE_ESCROW_ADDRESS, SEL.stakeMatches + matchId.replace(/^0x/, ""));
          const match = decodeEscrowMatch(raw);
          if (!match || match.settled || !(match.player1Deposited && match.player2Deposited)) continue;
          const settlement = await fetchServerSettlement(matchId);
          if (!settlement || !settlement.signature) continue;
          saveSettlement(settlement);
          return settlement;
        }
      } catch (e) { }
      return null;
    }

    function escrowReady() {
      return /^0x[0-9a-fA-F]{40}$/.test(STAKE_ESCROW_ADDRESS);
    }

    async function refreshPendingReward() {
      if (!rewardPanel || !pendingRewardAmount || !claimRewardBtn) return;
      if (modeKey !== "multiplayer" || !account || !escrowReady()) {
        rewardPanel.hidden = true;
        if (refundStakeBtn) refundStakeBtn.hidden = true;
        updateSettleRewardUI();
        return;
      }

      rewardPanel.hidden = false;
      updateSettleRewardUI();
      try {
        const raw = await ethCall(STAKE_ESCROW_ADDRESS, SEL.stakeCredits + pad64(BigInt(account)));
        const amount = BigInt(raw || "0x0");
        pendingRefunds = await loadPendingRefunds();
        const recoveredSettlement = await recoverFundedSettlement();
        const refundable = pendingRefunds.find((r) => r.canRefund);
        if (refundStakeBtn) {
          refundStakeBtn.hidden = pendingRefunds.length === 0;
          refundStakeBtn.disabled = !refundable;
          refundStakeBtn.textContent = refundable ? "Refund stake" : "Refund locked";
        }
        pendingRewardAmount.textContent = formatEth(amount);
        claimRewardBtn.disabled = amount === 0n;
        if (amount > 0n) {
          pendingRewardMsg.textContent = "Reward is safe in escrow. You can claim now or later.";
        } else if (lastSettlement || recoveredSettlement) {
          pendingRewardMsg.textContent = "Paid match is funded. Settle the reward first, then claim it here.";
        } else if (refundable) {
          pendingRewardMsg.textContent = "A paid match did not start. Refund the stake, then claim it here. The current contract's deposit fee is not refundable.";
        } else if (pendingRefunds.length) {
          pendingRewardMsg.textContent = "A paid match did not start. Refund unlocks in " + refundWaitText(pendingRefunds[0]) + ". The current contract's deposit fee is not refundable.";
        } else {
          pendingRewardMsg.textContent = "No pending reward right now.";
        }
      } catch (e) {
        pendingRewardAmount.textContent = "-";
        claimRewardBtn.disabled = true;
        if (refundStakeBtn) refundStakeBtn.hidden = true;
        pendingRewardMsg.textContent = "Could not read escrow rewards.";
      }
    }

    async function claimPendingReward() {
      if (!account) { await connect(); if (!account) return; }
      if (!escrowReady()) {
        pendingRewardMsg.textContent = "Escrow contract address is not set yet.";
        return;
      }

      try {
        await ensureBase();
        claimRewardBtn.disabled = true;
        pendingRewardMsg.textContent = "Confirm reward claim in your wallet.";
        const tx = await window.ethereum.request({
          method: "eth_sendTransaction",
          params: [{ from: account, to: STAKE_ESCROW_ADDRESS, value: "0x0", data: SEL.stakeWithdraw }]
        });
        pendingRewardMsg.innerHTML = "Reward claim submitted. <a href='" + BASE_CHAIN.blockExplorerUrls[0] + "/tx/" + tx + "' target='_blank' rel='noopener noreferrer'>View on Basescan</a>";
        setTimeout(refreshPendingReward, 6000);
        setTimeout(refreshPendingReward, 15000);
      } catch (e) {
        pendingRewardMsg.textContent = (e && e.code === 4001)
          ? "Reward claim cancelled. You can retry anytime."
          : "Reward claim failed. Funds stay pending; retry anytime.";
        refreshPendingReward();
      }
    }

    claimRewardBtn?.addEventListener("click", claimPendingReward);

    async function refundPendingStake() {
      if (!account) { await connect(); if (!account) return; }
      if (!escrowReady()) return;
      pendingRefunds = await loadPendingRefunds();
      const refund = pendingRefunds.find((r) => r.canRefund);
      if (!refund) {
        pendingRewardMsg.textContent = pendingRefunds.length
          ? "Refund unlocks in " + refundWaitText(pendingRefunds[0]) + "."
          : "No refundable paid deposit found.";
        return;
      }

      try {
        await ensureBase();
        refundStakeBtn.disabled = true;
        pendingRewardMsg.textContent = "Confirm stake refund in your wallet.";
        const tx = await window.ethereum.request({
          method: "eth_sendTransaction",
          params: [{ from: account, to: STAKE_ESCROW_ADDRESS, value: "0x0", data: encodeStakeRefundData(refund.matchId) }]
        });
        pendingRewardMsg.innerHTML = "Refund submitted. After confirmation, claim it here. <a href='" + BASE_CHAIN.blockExplorerUrls[0] + "/tx/" + tx + "' target='_blank' rel='noopener noreferrer'>View on Basescan</a>";
        setTimeout(refreshPendingReward, 6000);
        setTimeout(refreshPendingReward, 15000);
      } catch (e) {
        refundStakeBtn.disabled = false;
        pendingRewardMsg.textContent = (e && e.code === 4001)
          ? "Refund cancelled. You can retry after unlock."
          : "Refund failed. You can retry after unlock.";
      }
    }

    refundStakeBtn?.addEventListener("click", refundPendingStake);

    async function settlePaidReward() {
      if (!lastSettlement) return;
      if (!account) { await connect(); if (!account) return; }
      try {
        await ensureBase();
        settleRewardBtn.disabled = true;
        mintMsg.textContent = "Confirm paid reward settlement in your wallet.";
        mintMsg.className = "";
        const tx = await window.ethereum.request({
          method: "eth_sendTransaction",
          params: [{
            from: account,
            to: STAKE_ESCROW_ADDRESS,
            value: "0x0",
            data: encodeStakeSettleData(lastSettlement.matchId, lastSettlement.winner, lastSettlement.signature)
          }]
        });
        const settledMatchId = lastSettlement.matchId;
        mintMsg.innerHTML = "Paid reward settled. Claim it from Pending reward. <a href='" + BASE_CHAIN.blockExplorerUrls[0] + "/tx/" + tx + "' target='_blank' rel='noopener noreferrer'>View on Basescan</a>";
        mintMsg.className = "ok";
        clearSettlement(settledMatchId);
        setTimeout(refreshPendingReward, 6000);
        setTimeout(refreshPendingReward, 15000);
      } catch (e) {
        settleRewardBtn.disabled = false;
        mintMsg.textContent = (e && e.code === 4001)
          ? "Settlement cancelled. You can retry anytime."
          : "Settlement failed. You can retry anytime.";
        mintMsg.className = "err";
      }
    }

    settleRewardBtn?.addEventListener("click", settlePaidReward);

    async function sendReady(isReady) {
      if (!pendingReadyId || !wsClient || wsClient.readyState !== WebSocket.OPEN) return;
      let txHash = null;

      if (isReady && isPaidStake(pendingStakeWei)) {
        if (!addressReady(STAKE_ESCROW_ADDRESS)) {
          setStatus("Paid escrow contract is not deployed yet.", "dead");
          readyText.textContent = "Paid mode needs the escrow contract address before deposits can be locked.";
          return;
        }
        try {
          await ensureBase();
          readyAcceptBtn.disabled = true;
          readyAcceptBtn.textContent = "Confirm wallet";
          readyText.textContent = "Confirm the escrow deposit in your wallet.";
          txHash = await window.ethereum.request({
            method: "eth_sendTransaction",
            params: [{
              from: account,
              to: STAKE_ESCROW_ADDRESS,
              value: "0x" + requiredStakeValue(pendingStakeWei).toString(16),
              data: encodeStakeDepositData(pendingReadyId, pendingOpponent, pendingStakeWei)
            }]
          });
          refreshPendingReward();
        } catch (e) {
          readyAcceptBtn.disabled = false;
          readyAcceptBtn.textContent = "Deposit & Ready";
          readyText.textContent = (e && e.code === 4001) ? "Deposit cancelled." : "Deposit failed. Please try again.";
          setStatus("Deposit failed.", "dead");
          return;
        }
      }

      wsClient.send(JSON.stringify({
        type: "1v1_ready",
        readyId: pendingReadyId,
        ready: isReady,
        txHash
      }));
      if (isReady) {
        readyAcceptBtn.disabled = true;
        readyAcceptBtn.textContent = "Ready sent";
        readyText.textContent = "Waiting for opponent...";
        setStatus("Ready sent. Waiting for opponent...", "watch");
      } else {
        hideReadyPrompt();
        setStatus("Match cancelled.");
      }
    }

    readyAcceptBtn.addEventListener("click", () => sendReady(true));
    readyCancelBtn.addEventListener("click", () => sendReady(false));

    function resolveWsUrl() {
      const params = new URLSearchParams(window.location.search);
      const override = params.get("ws");
      const host = window.location.hostname;
      const isLocal = !host || host === "localhost" || host === "127.0.0.1";
      if (override && isLocal && /^wss?:\/\//i.test(override)) return override;
      if (isLocal && window.location.host) {
        const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
        return protocol + "//" + window.location.host;
      }
      if (isLocal) return "ws://localhost:3000";

      return DEFAULT_WS_URL;
    }

    function wsToHttpUrl(wsUrl) {
      try {
        const url = new URL(wsUrl);
        url.protocol = url.protocol === "wss:" ? "https:" : "http:";
        return url.toString();
      } catch (e) {
        return null;
      }
    }

    async function wakeMatchServer(wsUrl) {
      const httpUrl = wsToHttpUrl(wsUrl);
      if (!httpUrl) return;

      try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 35000);
        try {
          await fetch(httpUrl, {
            method: "GET",
            mode: "no-cors",
            cache: "no-store",
            signal: controller.signal
          });
        } finally {
          clearTimeout(timeout);
        }
      } catch (e) {
        // The wake request is best-effort. The WebSocket attempt below is the source of truth.
      }
    }

    async function connectWS(onConnectCallback, attempt = 1) {
      if (wsClient && wsClient.readyState === WebSocket.OPEN) {
        if (onConnectCallback) onConnectCallback();
        return;
      }
      
      const wsUrl = resolveWsUrl();
      if (attempt === 1) {
        setStatus("Waking match server...", "watch");
        await wakeMatchServer(wsUrl);
      } else {
        setStatus("Retrying match server connection...", "watch");
      }

      wsClient = new WebSocket(wsUrl);
      const socket = wsClient;
      let settled = false;
      let ignoreClose = false;
      const connectTimer = setTimeout(() => failConnection(), 45000);

      function resetAfterConnectionFailure() {
        isQueueing = false;
        running = false;
        startBtn.disabled = false;
        document.getElementById("multiplayerHud").style.display = "none";
        updateModeUI();
      }

      function failConnection() {
        if (settled) return;
        settled = true;
        ignoreClose = true;
        clearTimeout(connectTimer);
        try { socket.close(); } catch (e) { }

        if (attempt < 2) {
          setStatus("Match server is waking up. Trying once more...", "watch");
          setTimeout(() => connectWS(onConnectCallback, attempt + 1), 1500);
          return;
        }

        if (socket === wsClient) wsClient = null;
        setStatus("Connection failed. Server is offline or still waking up. Please try again.", "dead");
        resetAfterConnectionFailure();
      }

      wsClient.onopen = () => {
        if (socket !== wsClient) return;
        settled = true;
        clearTimeout(connectTimer);
        console.log("WebSocket connected");
        if (onConnectCallback) onConnectCallback();
      };

      wsClient.onmessage = async (event) => {
        if (socket !== wsClient) return;
        const msg = JSON.parse(event.data);
        console.log("WS Msg:", msg);

        if (msg.type === "error") {
          setStatus(msg.message || "Server error.", "dead");
          if (/authentication/i.test(msg.message || "")) {
            isQueueing = false;
            startBtn.disabled = false;
            updateModeUI();
          } else if (/expired|cancelled|deposit|escrow/i.test(msg.message || "")) {
            if (/expired/i.test(msg.message || "")) {
              hideReadyPrompt();
              isQueueing = false;
              startBtn.disabled = false;
              updateModeUI();
              refreshPendingReward();
            } else if (readyOverlay.classList.contains("show")) {
              readyAcceptBtn.disabled = false;
              readyAcceptBtn.textContent = isPaidStake(pendingStakeWei) ? "Deposit & Ready" : "Ready";
            }
          }
        }

        else if (msg.type === "queue_update") {
          renderQueue(msg.players || []);
        }

        else if (msg.type === "paid_auth_challenge") {
          if (!account || !isPaidStake(selectedStakeWei) || typeof msg.message !== "string" || msg.message.length > 2048) {
            setStatus("Paid wallet authentication failed.", "dead");
            startBtn.disabled = false;
            return;
          }
          try {
            setStatus("Confirm the gas-free matchmaking signature in your wallet.", "watch");
            const signature = await window.ethereum.request({
              method: "personal_sign",
              params: [utf8Hex(msg.message), account]
            });
            if (socket !== wsClient || socket.readyState !== WebSocket.OPEN) return;
            socket.send(JSON.stringify({ type: "paid_auth_response", signature }));
            setStatus("Wallet verified. Joining paid queue...", "watch");
          } catch (error) {
            setStatus(error && error.code === 4001 ? "Wallet verification cancelled." : "Wallet verification failed.", "dead");
            startBtn.disabled = false;
          }
        }

        else if (msg.type === "paid_auth_ok") {
          if (!account || String(msg.playerAddress || "").toLowerCase() !== account.toLowerCase()) {
            setStatus("Paid wallet authentication did not match the connected wallet.", "dead");
            startBtn.disabled = false;
            return;
          }
          socket.send(JSON.stringify({
            type: "1v1_join",
            playerAddress: account,
            stakeWei: selectedStakeWei
          }));
        }

        else if (msg.type === "queue_status" && msg.status === "queued") {
          isQueueing = true;
          startBtn.disabled = false;
          startBtn.textContent = "Cancel Queue";
          startBtn.style.background = "var(--bad)";
          setStatus("Searching for opponent...", "watch");
        }

        else if (msg.type === "ready_check") {
          isQueueing = false;
          startBtn.disabled = true;
          renderQueue([]);
          showReadyPrompt(msg);
        }

        else if (msg.type === "ready_state") {
          const readyCount = msg.readyCount || 0;
          readyText.textContent = msg.message || (readyCount === 1 ? "One player is ready. Waiting for the other..." : "Both players ready.");
        }

        else if (msg.type === "match_cancelled") {
          hideReadyPrompt();
          isQueueing = false;
          startBtn.disabled = false;
          updateModeUI();
          refreshPendingReward();
          setStatus("Match cancelled. Find another 1v1 when ready.", "watch");
        }
        
        else if (msg.type === "match_start") {
          isQueueing = false;
          hideReadyPrompt();
          renderQueue([]);
          activeMatchId = msg.matchId;
          const opponentLabel = await resolveBasename(msg.opponent) || short(msg.opponent);
          document.getElementById("opponentAddr").textContent = opponentLabel;
          document.getElementById("opponentScore").textContent = "0";
          document.getElementById("matchTimer").textContent = (msg.countdown || 5) + "s";
          document.getElementById("multiplayerHud").style.display = "block";
          
          runMode = MODES.multiplayer;
          sequence = msg.initialSequence;
          level = 1;
          levelEl.textContent = level;
          running = true;
          board.classList.add("playing");
          $("modes").classList.add("locked");
          startBtn.disabled = true;
          overlay.classList.remove("show");
          applyPadColors([0, 1, 2, 3]);
          
          accepting = false;
          board.classList.add("locked");
          setStatus("Deposits confirmed. Starting in " + (msg.countdown || 5) + "...", "watch");
        }

        else if (msg.type === "match_countdown") {
          document.getElementById("matchTimer").textContent = msg.seconds + "s";
          setStatus("Starting in " + msg.seconds + "...", "watch");
        }

        else if (msg.type === "match_go") {
          document.getElementById("matchTimer").textContent = msg.timeLeft + "s";
          setStatus("Go! 90 seconds started.", "go");
          playSequence();
        }
        
        else if (msg.type === "timer_tick") {
          document.getElementById("matchTimer").textContent = msg.timeLeft + "s";
        }
        
        else if (msg.type === "next_round") {
          level = msg.score + 1;
          levelEl.textContent = level;
          sequence = msg.sequence;
          playSequence();
        }
        
        else if (msg.type === "opponent_score") {
          document.getElementById("opponentScore").textContent = msg.score;
        }
        
        else if (msg.type === "player_failed") {
          running = false;
          accepting = false;
          board.classList.remove("playing");
          board.classList.add("locked");
          setStatus("Mistake! Waiting for opponent...", "dead");
          tone(0, 0.6, 110);
        }
        
        else if (msg.type === "opponent_failed") {
          setStatus("Opponent failed! Keep going!", "go");
        }
        
        else if (msg.type === "match_end") {
          running = false;
          accepting = false;
          board.classList.remove("playing");
          board.classList.add("locked");
          $("modes").classList.remove("locked");
          startBtn.disabled = false;
          
          lastScore = msg.score;
          best = Math.max(best, lastScore);
          bestEl.textContent = best;
          
          lastSignature = msg.signature;
          lastMatchId = msg.matchId;
          lastSettlement = null;
          
          finalScoreEl.textContent = lastScore;
          overSub.textContent = "levels cleared. Opponent: " + msg.opponentScore;
          if (isPaidStake(msg.stakeWei)) {
            overSub.textContent += " · " + paidBreakdown(msg.stakeWei);
          }
          
          mintMsg.textContent = "";
          mintMsg.className = "";
          mintBtn.style.display = "";
          mintBtn.disabled = false;
          settleRewardBtn.hidden = true;
          
          if (msg.result === "win") {
            overTitle.textContent = "You Won! 🏆";
            tone(2, 0.4, 330);
            setStatus("You won the match!", "go");
          } else if (msg.result === "lose") {
            overTitle.textContent = "Match Lost";
            tone(0, 0.6, 110);
            setStatus("Opponent won.", "dead");
          } else {
            overTitle.textContent = "Match Tied";
            setStatus("It's a tie!", "watch");
          }

          const paidSettlement = (msg.settlement && msg.settlement.signature)
            ? msg.settlement
            : (isPaidStake(msg.stakeWei) ? await fetchServerSettlement(msg.matchId) : null);

          if (paidSettlement && paidSettlement.signature && paidSettlement.winner) {
            saveSettlement({
              matchId: msg.matchId,
              winner: paidSettlement.winner,
              signature: paidSettlement.signature,
              stakeWei: msg.stakeWei
            });
            mintMsg.textContent = msg.result === "lose"
              ? "Paid match ended. You can submit the signed result; the reward still goes only to the winner."
              : "Paid match ended. " + paidBreakdown(msg.stakeWei) + " Settle the reward, then claim it from Pending reward.";
          } else if (isPaidStake(msg.stakeWei)) {
            mintMsg.textContent = "Paid match ended, but settlement was not ready. Open 1v1 Pending reward to retry.";
            mintMsg.className = "err";
          }
          
          overlay.classList.add("show");
          document.getElementById("multiplayerHud").style.display = "none";
          refreshPendingReward();
          updateModeUI();
          
          wsClient.close();
          wsClient = null;
        }
      };

      wsClient.onclose = () => {
        if (ignoreClose || socket !== wsClient) return;
        if (!settled) {
          failConnection();
          return;
        }
        console.log("WebSocket closed");
        if (isQueueing || running) {
          isQueueing = false;
          running = false;
          hideReadyPrompt();
          renderQueue([]);
          setStatus("Disconnected from server.");
          board.classList.remove("playing");
          $("modes").classList.remove("locked");
          startBtn.disabled = false;
          document.getElementById("multiplayerHud").style.display = "none";
          updateModeUI();
        }
      };
      
      wsClient.onerror = () => {
        if (socket !== wsClient) return;
        failConnection();
      };
    }
    updateModeUI();

    /* ================= sound ================= */
    let audioCtx = null;
    const FREQS = [164.81, 220.0, 277.18, 329.63];
    function tone(i, dur = 0.28, freq) {
      try {
        audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
        const o = audioCtx.createOscillator(), g = audioCtx.createGain();
        o.type = "sine"; o.frequency.value = freq || FREQS[i];
        g.gain.setValueAtTime(0.0001, audioCtx.currentTime);
        g.gain.exponentialRampToValueAtTime(0.25, audioCtx.currentTime + 0.02);
        g.gain.exponentialRampToValueAtTime(0.0001, audioCtx.currentTime + dur);
        o.connect(g); g.connect(audioCtx.destination);
        o.start(); o.stop(audioCtx.currentTime + dur + 0.05);
      } catch (e) { }
    }

    /* ================= game ================= */
    let sequence = [], playerStep = 0, level = 0, best = 0;
    let accepting = false, running = false, lastScore = 0, runMode = MODES.onchain;
    const sleep = ms => new Promise(r => setTimeout(r, ms));
    const speed = () => Math.max(runMode.min, runMode.base - level * runMode.step);
    function setStatus(t, c) { statusEl.textContent = t; statusEl.className = c || ""; }
    function flash(i, ms) { pads[i].classList.add("lit"); tone(i, ms / 1000 * 0.9); setTimeout(() => pads[i].classList.remove("lit"), ms); }
    function shuffleColors() {
      const order = [0, 1, 2, 3];
      for (let i = 3; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1));[order[i], order[j]] = [order[j], order[i]]; }
      applyPadColors(order);
    }
    async function playSequence() {
      accepting = false; board.classList.add("locked");
      if (runMode.shuffle) shuffleColors();
      setStatus("Watch the pattern...", "watch");
      await sleep(650);
      for (const i of sequence) { flash(i, speed()); await sleep(speed() + 140); }
      accepting = true; playerStep = 0; board.classList.remove("locked");
      setStatus("Your turn!", "go");
    }
    function nextRound() {
      level++; levelEl.textContent = level;
      sequence.push(Math.floor(Math.random() * 4));
      playSequence();
    }
    function stopActiveGame() {
      running = false;
      accepting = false;
      board.classList.remove("playing");
      board.classList.add("locked");
      $("modes").classList.remove("locked");
      startBtn.disabled = false;
      
      if (wsClient) {
        if (wsClient.readyState === WebSocket.OPEN) {
          wsClient.send(JSON.stringify({ type: "1v1_leave" }));
        }
        wsClient.close();
        wsClient = null;
      }
      
      const multiHud = document.getElementById("multiplayerHud");
      if (multiHud) {
        multiHud.style.display = "none";
      }
      
      isQueueing = false;
      hideReadyPrompt();
      renderQueue([]);
      updateModeUI();
      setStatus("Game stopped.");
    }

    async function startGame() {
      const selectedMode = MODES[modeKey];
      
      if (modeKey === "multiplayer") {
        if (!account) {
          setStatus("Connect wallet to search for match!", "dead");
          await connect();
          if (!account) {
            setStatus("Please connect your wallet to start.");
            return;
          }
        }
        
        if (isQueueing) {
          if (wsClient && wsClient.readyState === WebSocket.OPEN) {
            wsClient.send(JSON.stringify({ type: "1v1_leave" }));
          }
          if (wsClient) wsClient.close();
          isQueueing = false;
          renderQueue([]);
          updateModeUI();
          setStatus("Ready for 1v1 Match");
        } else {
          setStatus("Connecting to server...");
          startBtn.disabled = true;
          connectWS(() => {
            if (isPaidStake(selectedStakeWei)) {
              wsClient.send(JSON.stringify({ type: "paid_auth_request", playerAddress: account }));
            } else {
              wsClient.send(JSON.stringify({
                type: "1v1_join",
                playerAddress: account,
                stakeWei: selectedStakeWei
              }));
            }
          });
        }
        return;
      }

      if (selectedMode.mint && !account) {
        setStatus("Connect wallet to play Onchain mode!", "dead");
        await connect();
        if (!account) {
          setStatus("Please connect your wallet to start.");
          return;
        }
      }
      runMode = selectedMode;
      sequence = []; level = 0; running = true;
      board.classList.add("playing");
      $("modes").classList.add("locked");
      startBtn.disabled = true;
      overlay.classList.remove("show");
      applyPadColors([0, 1, 2, 3]);
      nextRound();
    }
    function gameOver() {
      running = false; accepting = false;
      lastScore = level - 1;
      best = Math.max(best, lastScore); bestEl.textContent = best;
      board.classList.remove("playing"); board.classList.add("locked");
      $("modes").classList.remove("locked");
      startBtn.disabled = false;
      tone(0, 0.6, 110);
      setStatus("Game over", "dead");
      finalScoreEl.textContent = lastScore;
      overSub.textContent = "levels cleared in " + runMode.label + " mode";
      mintMsg.textContent = ""; mintMsg.className = "";
      if (runMode.mint) {
        mintBtn.style.display = "";
        mintBtn.disabled = lastScore < 1;
        settleRewardBtn.hidden = true;
        overTitle.textContent = "Game over";
      } else {
        mintBtn.style.display = "none";
        settleRewardBtn.hidden = true;
        overTitle.textContent = "Practice over";
      }
      overlay.classList.add("show");
    }
    pads.forEach(p => p.addEventListener("click", async e => {
      if (!accepting) return;
      const i = +e.currentTarget.dataset.i;
      flash(i, 180);
      
      if (modeKey === "multiplayer") {
        if (wsClient && wsClient.readyState === WebSocket.OPEN) {
          wsClient.send(JSON.stringify({
            type: "1v1_click",
            matchId: activeMatchId,
            index: i
          }));
        }
        return;
      }
      
      if (i !== sequence[playerStep]) { gameOver(); return; }
      playerStep++;
      if (playerStep === sequence.length) {
        accepting = false; board.classList.add("locked");
        setStatus("Nice ✓", "go");
        await sleep(700);
        if (running) nextRound();
      }
    }));
    startBtn.addEventListener("click", startGame);
    againBtn.addEventListener("click", () => { overlay.classList.remove("show"); startGame(); });

    /* =========================================================
       WALLET - minimal-permission by design.
       Signable actions: eth_requestAccounts (read address),
       and 0-value eth_sendTransaction for mintScore / claimBadge.
       Everything else is free read-only eth_call.
       ========================================================= */
    let account = null;
    const short = a => a.slice(0, 6) + "…" + a.slice(-4);
    const contractReady = () => /^0x[0-9a-fA-F]{40}$/.test(CONTRACT_ADDRESS);
    const pad64 = v => v.toString(16).padStart(64, "0");
    const word = (hex, i) => hex.slice(2 + i * 64, 2 + (i + 1) * 64);
    const ethCall = (to, data) => window.ethereum.request({ method: "eth_call", params: [{ to, data }, "latest"] });

    async function verifiedScoreReady() {
      if (!contractReady()) return false;
      try {
        const raw = await ethCall(CONTRACT_ADDRESS, SEL.scoreSigner);
        return Boolean(raw && raw !== "0x" && raw.length >= 66 && BigInt(raw) !== 0n);
      } catch {
        return false;
      }
    }

    async function ensureBase() {
      try {
        await window.ethereum.request({ method: "wallet_switchEthereumChain", params: [{ chainId: BASE_CHAIN.chainId }] });
      } catch (err) {
        if (err && (err.code === 4902 || String(err.message || "").includes("Unrecognized")))
          await window.ethereum.request({ method: "wallet_addEthereumChain", params: [BASE_CHAIN] });
        else throw err;
      }
    }
    async function connect() {
      if (!window.ethereum) { alert("No wallet found. Install Coinbase Wallet or MetaMask, then reopen this page."); return; }
      try {
        const accs = await window.ethereum.request({ method: "eth_requestAccounts" });
        account = accs[0];
        await ensureBase();
        walletBtn.textContent = short(account);
        walletBtn.classList.add("connected");
        refreshOnchainBest(); refreshGlobal(); loadLeaderboard(); refreshBadges(); refreshPendingReward();
      } catch (e) { }
    }
    async function refreshOnchainBest() {
      if (!account || !contractReady()) { chainBestEl.textContent = "-"; return; }
      try { chainBestEl.textContent = parseInt(await ethCall(CONTRACT_ADDRESS, SEL.best + pad64(BigInt(account))), 16) || 0; }
      catch (e) { chainBestEl.textContent = "-"; }
    }
    async function refreshGlobal() {
      if (!window.ethereum || !account || !contractReady()) return;
      try {
        totalGamesEl.textContent = (parseInt(await ethCall(CONTRACT_ADDRESS, SEL.games), 16) || 0).toLocaleString();
      } catch (e) { }
    }
    function encodeMintVerifiedData(score, mode, matchId, signature) {
      const cleanMatchId = matchId.replace(/^0x/, "");
      const cleanSig = signature.replace(/^0x/, "");
      
      const selector = SEL.mintVerified.replace(/^0x/, "");
      
      const pScore = pad64(BigInt(score));
      const pMode = pad64(BigInt(mode));
      const pMatchId = cleanMatchId.padStart(64, "0");
      
      const signatureOffset = pad64(96n);
      
      const sigLen = cleanSig.length / 2;
      const pSigLen = pad64(BigInt(sigLen));
      
      const paddedSig = cleanSig.padEnd(192, "0");
      
      return "0x" + selector + pScore + pMode + pMatchId + signatureOffset + pSigLen + paddedSig;
    }

    async function mint() {
      mintMsg.className = "";
      if (!account) { await connect(); if (!account) return; }
      if (!contractReady()) {
        mintMsg.textContent = "Contract address is missing. You need to deploy SimonOnBase.sol first and set the address.";
        mintMsg.className = "err"; return;
      }
      try {
        await ensureBase();
        mintBtn.disabled = true;
        mintMsg.textContent = "Confirm the transaction in your wallet. It's a 0 ETH contract call.";
        
        let data;
        if (runMode === MODES.multiplayer) {
          if (!(await verifiedScoreReady())) {
            mintMsg.textContent = "Verified 1v1 score contract is not deployed yet. Paid escrow reward is separate and remains claimable.";
            mintMsg.className = "err";
            mintBtn.disabled = false;
            return;
          }
          if (!lastSignature || !lastMatchId) {
            mintMsg.textContent = "Signature or Match ID missing from server.";
            mintMsg.className = "err";
            mintBtn.disabled = false;
            return;
          }
          data = encodeMintVerifiedData(lastScore, 1, lastMatchId, lastSignature);
        } else {
          data = SEL.mint + pad64(lastScore) + pad64(runMode.id);
        }

        const tx = await window.ethereum.request({
          method: "eth_sendTransaction",
          params: [{ from: account, to: CONTRACT_ADDRESS, value: "0x0", data }]
        });
        mintMsg.innerHTML = "Score minted successfully! ✓ <a href='" + BASE_CHAIN.blockExplorerUrls[0] + "/tx/" + tx + "' target='_blank' rel='noopener noreferrer'>View on Basescan</a>";
        mintMsg.className = "ok";
        setTimeout(() => { refreshOnchainBest(); refreshGlobal(); }, 6000);
        setTimeout(() => { refreshOnchainBest(); refreshGlobal(); loadLeaderboard(); refreshBadges(); }, 15000);
      } catch (e) {
        mintMsg.textContent = (e && e.code === 4001) ? "Transaction canceled." : "Transaction failed. Please try again.";
        mintMsg.className = "err"; mintBtn.disabled = false;
      }
    }
    walletBtn.addEventListener("click", connect);
    mintBtn.addEventListener("click", mint);
    if (window.ethereum) {
      window.ethereum.on?.("accountsChanged", accs => {
        const nextAccount = accs[0] || null;
        if (account && nextAccount && account.toLowerCase() !== nextAccount.toLowerCase() &&
            (running || isQueueing || pendingReadyId)) {
          stopActiveGame();
        }
        account = nextAccount;
        walletBtn.textContent = account ? short(account) : "Connect wallet";
        walletBtn.classList.toggle("connected", !!account);
        refreshOnchainBest(); refreshGlobal(); loadLeaderboard(); refreshBadges(); refreshPendingReward();
      });
      window.ethereum.on?.("chainChanged", () => { refreshOnchainBest(); refreshGlobal(); refreshPendingReward(); });
    }

    /* =========================================================
       BASENAMES - reverse resolve + forward verify (anti-spoof)
       ========================================================= */
    const nameCache = new Map();
    async function resolveBasename(addr) {
      const key = addr.toLowerCase();
      if (nameCache.has(key)) return nameCache.get(key);
      let result = null;
      try {
        const addrNode = keccak256(utf8(key.slice(2)));
        const node = keccak256(hexBytes(BASE_REVERSE_NODE + addrNode));
        const res = await ethCall(L2_RESOLVER, SEL.ensName + node);
        if (res && res !== "0x" && res.length > 130) {
          const len = parseInt(word(res, 1), 16);
          if (len > 0 && len < 256) {
            const raw = res.slice(2 + 64 + 64, 2 + 64 + 64 + len * 2);
            const name = new TextDecoder().decode(hexBytes(raw));
            /* forward-verify: the name must resolve back to this address */
            const fwd = await ethCall(L2_RESOLVER, SEL.ensAddr + namehash(name));
            if (fwd && "0x" + word(fwd, 0).slice(24) === key) result = name;
          }
        }
      } catch (e) { }
      nameCache.set(key, result);
      return result;
    }

    /* =========================================================
       LEADERBOARD - weekly seasons + all-time, gas-free reads
       ========================================================= */
    let lbMode = "week";
    const PAGE = 200, MAX_PLAYERS = 2000;
    document.querySelectorAll("#lbSeg button").forEach(b => b.addEventListener("click", () => {
      lbMode = b.dataset.lb;
      document.querySelectorAll("#lbSeg button").forEach(x => x.classList.toggle("on", x === b));
      loadLeaderboard();
    }));

    function decodeRange3(hex) { // (address[],uint256[],uint8[])
      if (!hex || hex === "0x") return [];
      const o1 = parseInt(word(hex, 0), 16) / 32, o2 = parseInt(word(hex, 1), 16) / 32, o3 = parseInt(word(hex, 2), 16) / 32;
      const len = parseInt(word(hex, o1), 16), out = [];
      for (let i = 0; i < len; i++) out.push({
        addr: "0x" + word(hex, o1 + 1 + i).slice(24),
        score: parseInt(word(hex, o2 + 1 + i), 16),
        mode: parseInt(word(hex, o3 + 1 + i), 16)
      });
      return out;
    }
    function decodeRange2(hex) { // (address[],uint256[])
      if (!hex || hex === "0x") return [];
      const o1 = parseInt(word(hex, 0), 16) / 32, o2 = parseInt(word(hex, 1), 16) / 32;
      const len = parseInt(word(hex, o1), 16), out = [];
      for (let i = 0; i < len; i++) out.push({
        addr: "0x" + word(hex, o1 + 1 + i).slice(24),
        score: parseInt(word(hex, o2 + 1 + i), 16),
        mode: null
      });
      return out;
    }
    function lbMessage(t) { lbTable.innerHTML = '<div class="lb-empty">' + t + '</div>'; lbMeta.textContent = ""; }

    let seasonTimer = null;
    function startCountdown(week) {
      seasonNum.textContent = "#" + week;
      const reset = (week + 1) * WEEK_SECONDS * 1000;
      clearInterval(seasonTimer);
      const tick = () => {
        let s = Math.max(0, Math.floor((reset - Date.now()) / 1000));
        const d = (s / 86400) | 0; s %= 86400;
        const h = (s / 3600) | 0; s %= 3600;
        const m = (s / 60) | 0;
        countdown.textContent = d + "d " + h + "h " + m + "m";
      };
      tick(); seasonTimer = setInterval(tick, 30000);
    }

    async function loadLeaderboard() {
      if (!window.ethereum) { lbMessage("Install a wallet to view the leaderboard."); return; }
      if (!account) { lbMessage("Connect your wallet to load the Base leaderboard."); return; }
      if (!contractReady()) { lbMessage("Leaderboard goes live once the score contract is deployed."); return; }
      lbRefresh.disabled = true;
      lbMessage("Loading from Base…");
      try {
        const week = parseInt(await ethCall(CONTRACT_ADDRESS, SEL.week), 16);
        startCountdown(week);
        let count, fetchPage;
        if (lbMode === "week") {
          count = parseInt(await ethCall(CONTRACT_ADDRESS, SEL.wCount + pad64(week)), 16) || 0;
          fetchPage = (s, c) => ethCall(CONTRACT_ADDRESS, SEL.wRange + pad64(week) + pad64(s) + pad64(c)).then(decodeRange2);
        } else {
          count = parseInt(await ethCall(CONTRACT_ADDRESS, SEL.pCount), 16) || 0;
          fetchPage = (s, c) => ethCall(CONTRACT_ADDRESS, SEL.range + pad64(s) + pad64(c)).then(decodeRange3);
        }
        count = Math.min(count, MAX_PLAYERS);
        if (count === 0) { lbMessage(lbMode === "week" ? "No scores this season yet. Claim the crown!" : "No scores minted yet. Be the first!"); lbRefresh.disabled = false; return; }
        let all = [];
        for (let s = 0; s < count; s += PAGE) all = all.concat(await fetchPage(s, Math.min(PAGE, count - s)));
        all.sort((a, b) => b.score - a.score);
        const top = all.slice(0, 10);
        lbTable.innerHTML = top.map((p, i) => {
          const me = account && p.addr.toLowerCase() === account.toLowerCase();
          const chip = p.mode === null ? "" :
            '<span class="chip m' + p.mode + '">' + ["EASY", "ONCHAIN", "DEGEN"][p.mode] + '</span>';
          return '<div class="lb-row' + (i < 3 ? ' top' + (i + 1) : '') + (me ? ' me' : '') + '" data-addr="' + p.addr + '">'
            + '<span class="rank">#' + (i + 1) + '</span>'
            + '<span class="who">' + short(p.addr) + '</span>'
            + chip
            + '<span class="pts">' + p.score + '</span></div>';
        }).join("");
        lbMeta.textContent = all.length + " player" + (all.length === 1 ? "" : "s") + (lbMode === "week" ? " this season" : " all-time");
        /* basenames: resolve visible rows, swap in verified names */
        top.forEach(async p => {
          const name = await resolveBasename(p.addr);
          if (name) {
            const row = lbTable.querySelector('[data-addr="' + p.addr + '"] .who');
            if (row) { row.textContent = name; row.classList.add("named"); }
          }
        });
      } catch (e) {
        lbMessage("Couldn't load the leaderboard. Try refresh.");
      } finally {
        lbRefresh.disabled = false;
      }
    }
    lbRefresh.addEventListener("click", loadLeaderboard);

    /* =========================================================
       BADGES - milestone progress + soulbound claims
       ========================================================= */
    async function refreshBadges() {
      const bBest = $("bBest"), bNext = $("bNext"), bBar = $("bBar");
      if (!account || !contractReady()) {
        bBest.textContent = "-"; bNext.textContent = "Connect wallet to track progress"; bBar.style.width = "0%";
        return;
      }
      try {
        const myBest = parseInt(await ethCall(CONTRACT_ADDRESS, SEL.best + pad64(BigInt(account))), 16) || 0;
        bBest.textContent = myBest;
        const next = BADGE_THRESHOLDS.find(t => myBest < t);
        if (next) { bNext.textContent = "Next badge at " + next; bBar.style.width = Math.min(100, myBest / next * 100) + "%"; }
        else { bNext.textContent = "All badges unlocked! 🏆"; bBar.style.width = "100%"; }
        for (let tier = 0; tier < 3; tier++) {
          const el = document.querySelector('.badge[data-tier="' + tier + '"]');
          const slot = el.querySelector(".badge-cta");
          const isClaimed = parseInt(await ethCall(CONTRACT_ADDRESS, SEL.claimed + pad64(BigInt(account)) + pad64(tier)), 16) === 1;
          if (isClaimed) {
            el.classList.remove("locked"); el.classList.add("owned");
            slot.innerHTML = '<span class="badge-state owned">Owned ✓</span>';
          } else if (myBest >= BADGE_THRESHOLDS[tier]) {
            el.classList.remove("locked");
            slot.innerHTML = '<button data-claim="' + tier + '">Claim</button>';
          } else {
            el.classList.add("locked");
            slot.innerHTML = '<span class="badge-state locked">Locked</span>';
          }
        }
      } catch (e) { }
    }
    document.getElementById("badgeList").addEventListener("click", async e => {
      const btn = e.target.closest("[data-claim]");
      if (!btn) return;
      const tier = +btn.dataset.claim;
      badgeMsg.className = "";
      try {
        await ensureBase();
        btn.disabled = true;
        badgeMsg.textContent = "Confirm the transaction in your wallet. It's a 0 ETH soulbound badge mint.";
        const tx = await window.ethereum.request({
          method: "eth_sendTransaction",
          params: [{ from: account, to: CONTRACT_ADDRESS, value: "0x0", data: SEL.claim + pad64(tier) }]
        });
        badgeMsg.innerHTML = "Badge minted successfully! ✓ <a href='" + BASE_CHAIN.blockExplorerUrls[0] + "/tx/" + tx + "' target='_blank' rel='noopener noreferrer'>View on Basescan</a>";
        badgeMsg.className = "ok";
        setTimeout(refreshBadges, 8000);
      } catch (err) {
        badgeMsg.textContent = (err && err.code === 4001) ? "Transaction canceled." : "Claim failed. Please try again.";
        badgeMsg.className = "err"; btn.disabled = false;
      }
    });
