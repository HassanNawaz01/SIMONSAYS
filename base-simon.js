    "use strict";

    /* =========================================================
       CONFIG — deploy SimonOnBase.sol on Base mainnet,
       then paste the deployed address below.
       ========================================================= */
    const CONTRACT_ADDRESS = "0xd376DA21BDCDD1338C2283488d592880F25F09f1";

    /* Function selectors (keccak256 of the signature, first 4 bytes) */
    const SEL = {
      mint: "0x08142c10", // mintScore(uint256,uint8)
      best: "0xdc0c695f", // bestScore(address)
      games: "0x2c4e591b", // totalGames()
      week: "0x06575c89", // currentWeek()
      pCount: "0x302bcc57", // playerCount()
      wCount: "0xbc5a4f3c", // weekPlayerCount(uint256)
      range: "0xf5441d17", // getRange(uint256,uint256)
      wRange: "0x0990ccc9", // getWeekRange(uint256,uint256,uint256)
      claim: "0xb5804373", // claimBadge(uint8)
      claimed: "0xfbb905e3",// claimed(address,uint8)
      ensName: "0x691f3431",// name(bytes32)   — Basenames L2Resolver
      ensAddr: "0x3b3b57de" // addr(bytes32)
    };

    const BASE_CHAIN = {
      chainId: "0x2105", chainName: "Base",
      nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
      rpcUrls: ["https://mainnet.base.org"],
      blockExplorerUrls: ["https://basescan.org"]
    };

    /* Basenames (official Base deployments — verified) */
    const L2_RESOLVER = "0xC6d566A56A1aFf6508b41f6c90ff131615583BCD";
    /* namehash("80002105.reverse") — Base coinType reverse namespace, precomputed */
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
    const overlay = $("overlay"), finalScoreEl = $("finalScore"), mintBtn = $("mintBtn"), againBtn = $("againBtn"), mintMsg = $("mintMsg");
    const walletBtn = $("walletBtn"), totalGamesEl = $("totalGames"), practiceNote = $("practiceNote");
    const lbTable = $("lbTable"), lbRefresh = $("lbRefresh"), lbMeta = $("lbMeta");
    const seasonNum = $("seasonNum"), countdown = $("countdown");
    const overTitle = $("overTitle"), overSub = $("overSub"), badgeMsg = $("badgeMsg");

    /* ================= tabs ================= */
    document.querySelectorAll("nav button").forEach(b => b.addEventListener("click", () => {
      document.querySelectorAll("nav button").forEach(x => x.classList.toggle("on", x === b));
      document.querySelectorAll(".view").forEach(v => v.classList.toggle("on", v.id === "view-" + b.dataset.view));
      if (b.dataset.view === "ranks") loadLeaderboard();
      if (b.dataset.view === "badges") refreshBadges();
    }));

    /* ================= difficulty modes ================= */
    const MODES = {
      practice: { label: "Practice", base: 620, step: 32, min: 220, mint: false, shuffle: false, id: null },
      onchain: { label: "Onchain", base: 620, step: 32, min: 220, mint: true, shuffle: false, id: 1 }
    };
    let modeKey = "onchain";
    const PAD_COLORS = ["var(--pad-1)", "var(--pad-2)", "var(--pad-3)", "var(--pad-4)"];
    function applyPadColors(order) { pads.forEach((p, i) => p.style.background = PAD_COLORS[order[i]]); }
    applyPadColors([0, 1, 2, 3]);

    function updateModeUI() {
      const isPractice = modeKey === "practice";
      const hudEl = document.querySelector(".hud");
      const chainStatBox = chainBestEl.closest(".stat");
      if (chainStatBox && hudEl) {
        if (isPractice) {
          chainStatBox.style.display = "none";
          hudEl.style.gridTemplateColumns = "repeat(2, 1fr)";
        } else {
          chainStatBox.style.display = "";
          hudEl.style.gridTemplateColumns = "repeat(3, 1fr)";
        }
      }
    }

    document.querySelectorAll(".mode").forEach(m => m.addEventListener("click", () => {
      if (running) return;
      modeKey = m.dataset.mode;
      document.querySelectorAll(".mode").forEach(x => x.classList.toggle("on", x === m));
      practiceNote.textContent = MODES[modeKey].mint ? "" : "Practice runs are not minted onchain. Just for training.";
      setStatus("Ready for " + MODES[modeKey].label + " mode");
      updateModeUI();
    }));
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
    async function startGame() {
      const selectedMode = MODES[modeKey];
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
        overTitle.textContent = "Game over";
      } else {
        mintBtn.style.display = "none";
        overTitle.textContent = "Practice over";
      }
      overlay.classList.add("show");
    }
    pads.forEach(p => p.addEventListener("click", async e => {
      if (!accepting) return;
      const i = +e.currentTarget.dataset.i;
      flash(i, 180);
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
       WALLET — minimal-permission by design.
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
        refreshOnchainBest(); refreshGlobal(); loadLeaderboard(); refreshBadges();
      } catch (e) { }
    }
    async function refreshOnchainBest() {
      if (!account || !contractReady()) { chainBestEl.textContent = "–"; return; }
      try { chainBestEl.textContent = parseInt(await ethCall(CONTRACT_ADDRESS, SEL.best + pad64(BigInt(account))), 16) || 0; }
      catch (e) { chainBestEl.textContent = "–"; }
    }
    async function refreshGlobal() {
      if (!window.ethereum || !account || !contractReady()) return;
      try {
        totalGamesEl.textContent = (parseInt(await ethCall(CONTRACT_ADDRESS, SEL.games), 16) || 0).toLocaleString();
      } catch (e) { }
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
        const data = SEL.mint + pad64(lastScore) + pad64(runMode.id);
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
        account = accs[0] || null;
        walletBtn.textContent = account ? short(account) : "Connect wallet";
        walletBtn.classList.toggle("connected", !!account);
        refreshOnchainBest(); refreshGlobal(); loadLeaderboard(); refreshBadges();
      });
      window.ethereum.on?.("chainChanged", () => { refreshOnchainBest(); refreshGlobal(); });
    }

    /* =========================================================
       BASENAMES — reverse resolve + forward verify (anti-spoof)
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
       LEADERBOARD — weekly seasons + all-time, gas-free reads
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
       BADGES — milestone progress + soulbound claims
       ========================================================= */
    async function refreshBadges() {
      const bBest = $("bBest"), bNext = $("bNext"), bBar = $("bBar");
      if (!account || !contractReady()) {
        bBest.textContent = "–"; bNext.textContent = "Connect wallet to track progress"; bBar.style.width = "0%";
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
