// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * SimonOnBaseVerified - score registry, weekly seasons, and soulbound milestone
 * badges (fully onchain SVG) for Base mainnet, with signature verification.
 */
contract SimonOnBaseVerified {

    /* ───────────────────────── owner & signer ───────────────── */
    address public owner;
    address public signerAddress;
    mapping(bytes32 => bool) public usedMatches; // Prevent replay attacks

    event SignerUpdated(address indexed newSigner);

    modifier onlyOwner() {
        require(msg.sender == owner, "not owner");
        _;
    }

    /* ───────────────────────── scores ───────────────────────── */

    mapping(address => uint256) public bestScore;   // all-time best
    mapping(address => uint8)   public bestMode;    // mode of that best (0 easy, 1 normal/onchain, 2 degen)
    mapping(address => uint256) public totalMints;  // games minted per player
    uint256 public totalGames;                      // global counter

    address[] private players;
    mapping(address => bool) private registered;

    /* ─────────────────── weekly seasons ─────────────────────── */

    mapping(uint256 => mapping(address => uint256)) public weekBest;
    mapping(uint256 => address[]) private weekPlayers;
    mapping(uint256 => mapping(address => bool)) private weekRegistered;

    event ScoreMinted(address indexed player, uint256 score, uint8 mode, uint256 indexed week, uint256 newBest);

    constructor(address _signerAddress) {
        owner = msg.sender;
        signerAddress = _signerAddress;
    }

    function setSigner(address _signerAddress) external onlyOwner {
        signerAddress = _signerAddress;
        emit SignerUpdated(_signerAddress);
    }

    function currentWeek() public view returns (uint256) {
        return block.timestamp / 1 weeks;
    }

    /// Record a finished solo game.
    function mintScore(uint256 score, uint8 mode) external {
        require(mode <= 2, "bad mode");
        _recordScore(msg.sender, score, mode);
    }

    /// Record a finished 1v1 verified game using server signature.
    function mintVerifiedScore(uint256 score, uint8 mode, bytes32 matchId, bytes memory signature) external {
        require(!usedMatches[matchId], "match already minted");
        require(mode <= 2, "bad mode");

        bytes32 messageHash = keccak256(abi.encodePacked(msg.sender, score, mode, matchId));
        bytes32 ethSignedMessageHash = keccak256(abi.encodePacked("\x19Ethereum Signed Message:\n32", messageHash));

        address recovered = recoverSigner(ethSignedMessageHash, signature);
        require(recovered == signerAddress, "invalid signature");

        usedMatches[matchId] = true;
        _recordScore(msg.sender, score, mode);
    }

    function _recordScore(address player, uint256 score, uint8 mode) internal {
        uint256 wk = currentWeek();

        if (!registered[player]) {
            registered[player] = true;
            players.push(player);
        }
        if (!weekRegistered[wk][player]) {
            weekRegistered[wk][player] = true;
            weekPlayers[wk].push(player);
        }

        totalGames += 1;
        totalMints[player] += 1;

        if (score > bestScore[player]) {
            bestScore[player] = score;
            bestMode[player] = mode;
        }
        if (score > weekBest[wk][player]) {
            weekBest[wk][player] = score;
        }
        emit ScoreMinted(player, score, mode, wk, bestScore[player]);
    }

    /* ─────────────── leaderboard reads (free) ───────────────── */

    function playerCount() external view returns (uint256) {
        return players.length;
    }

    function weekPlayerCount(uint256 wk) external view returns (uint256) {
        return weekPlayers[wk].length;
    }

    /// All-time page: (player, best score, mode of best).
    function getRange(uint256 start, uint256 count)
        external view
        returns (address[] memory addrs, uint256[] memory scores, uint8[] memory modes)
    {
        uint256 n = players.length;
        if (start >= n) return (new address[](0), new uint256[](0), new uint8[](0));
        uint256 end = start + count; if (end > n) end = n;
        uint256 len = end - start;
        addrs = new address[](len); scores = new uint256[](len); modes = new uint8[](len);
        for (uint256 i = 0; i < len; i++) {
            address p = players[start + i];
            addrs[i] = p; scores[i] = bestScore[p]; modes[i] = bestMode[p];
        }
    }

    /// Weekly page: (player, best score in that week).
    function getWeekRange(uint256 wk, uint256 start, uint256 count)
        external view
        returns (address[] memory addrs, uint256[] memory scores)
    {
        address[] storage list = weekPlayers[wk];
        uint256 n = list.length;
        if (start >= n) return (new address[](0), new uint256[](0));
        uint256 end = start + count; if (end > n) end = n;
        uint256 len = end - start;
        addrs = new address[](len); scores = new uint256[](len);
        for (uint256 i = 0; i < len; i++) {
            address p = list[start + i];
            addrs[i] = p; scores[i] = weekBest[wk][p];
        }
    }

    /* ────────── milestone badges: soulbound onchain SVG ─────── */

    string public constant name = "Simon on Base Badges";
    string public constant symbol = "SIMONB";

    uint256[3] private THRESHOLDS = [10, 25, 50];

    mapping(address => mapping(uint8 => bool)) public claimed;
    mapping(uint256 => address) private _ownerOf;
    mapping(uint256 => uint8)  public tierOf;
    mapping(address => uint256) public balanceOf;
    uint256 public nextTokenId = 1;

    event Transfer(address indexed from, address indexed to, uint256 indexed tokenId);

    function threshold(uint8 tier) public view returns (uint256) {
        require(tier < 3, "bad tier");
        return THRESHOLDS[tier];
    }

    /// Mint your milestone badge (tier 0 = level 10, 1 = level 25, 2 = level 50).
    function claimBadge(uint8 tier) external {
        require(tier < 3, "bad tier");
        require(!claimed[msg.sender][tier], "already claimed");
        require(bestScore[msg.sender] >= THRESHOLDS[tier], "score too low");

        claimed[msg.sender][tier] = true;
        uint256 id = nextTokenId++;
        _ownerOf[id] = msg.sender;
        tierOf[id] = tier;
        balanceOf[msg.sender] += 1;
        emit Transfer(address(0), msg.sender, id);
    }

    function ownerOf(uint256 id) external view returns (address) {
        address o = _ownerOf[id];
        require(o != address(0), "no token");
        return o;
    }

    function supportsInterface(bytes4 iid) external pure returns (bool) {
        return iid == 0x80ac58cd /* ERC721 */ || iid == 0x5b5e139f /* metadata */ || iid == 0x01ffc9a7 /* ERC165 */;
    }

    /* soulbound: every transfer/approval path reverts */
    error Soulbound();
    function transferFrom(address, address, uint256) external pure { revert Soulbound(); }
    function safeTransferFrom(address, address, uint256) external pure { revert Soulbound(); }
    function safeTransferFrom(address, address, uint256, bytes calldata) external pure { revert Soulbound(); }
    function approve(address, uint256) external pure { revert Soulbound(); }
    function setApprovalForAll(address, bool) external pure { revert Soulbound(); }
    function getApproved(uint256) external pure returns (address) { return address(0); }
    function isApprovedForAll(address, address) external pure returns (bool) { return false; }

    /* ─────────────── onchain SVG metadata ───────────────────── */

    function tokenURI(uint256 id) external view returns (string memory) {
        require(_ownerOf[id] != address(0), "no token");
        uint8 tier = tierOf[id];
        (string memory title, string memory glow) = tier == 0
            ? ("BLUE SPARK", "#4D85FF")
            : tier == 1 ? ("BASE RUNNER", "#0052FF") : ("ONCHAIN LEGEND", "#A6C2FF");
        string memory lvl = _u2s(THRESHOLDS[tier]);

        string memory svg = string(abi.encodePacked(
            "<svg xmlns='http://www.w3.org/2000/svg' width='400' height='400' viewBox='0 0 400 400'>",
            "<rect width='400' height='400' rx='32' fill='#0A0B0D'/>",
            "<circle cx='200' cy='150' r='64' fill='", glow, "'/>",
            "<rect x='136' y='142' width='60' height='16' fill='#0A0B0D'/>",
            "<text x='200' y='268' text-anchor='middle' font-family='Arial' font-size='26' font-weight='bold' fill='#FFFFFF'>", title, "</text>",
            "<text x='200' y='300' text-anchor='middle' font-family='Arial' font-size='15' fill='#8A919E'>LEVEL ", lvl, "+ \xC2\xB7 SIMON ON BASE</text>",
            "</svg>"
        ));

        string memory json = string(abi.encodePacked(
            '{"name":"Simon on Base  - ', title,
            '","description":"Soulbound milestone badge for clearing level ', lvl,
            ' in Simon on Base.","image":"data:image/svg+xml;base64,', _b64(bytes(svg)), '"}'
        ));
        return string(abi.encodePacked("data:application/json;base64,", _b64(bytes(json))));
    }

    function _u2s(uint256 v) private pure returns (string memory) {
        if (v == 0) return "0";
        uint256 t = v; uint256 d;
        while (t != 0) { d++; t /= 10; }
        bytes memory b = new bytes(d);
        while (v != 0) { d--; b[d] = bytes1(uint8(48 + v % 10)); v /= 10; }
        return string(b);
    }

    function _b64(bytes memory data) private pure returns (string memory) {
        string memory table = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
        if (data.length == 0) return "";
        string memory result = new string(4 * ((data.length + 2) / 3));
        assembly {
            let tablePtr := add(table, 1)
            let resultPtr := add(result, 32)
            for { let dataPtr := data let endPtr := add(data, mload(data)) }
                lt(dataPtr, endPtr) {} {
                dataPtr := add(dataPtr, 3)
                let input := mload(dataPtr)
                mstore8(resultPtr, mload(add(tablePtr, and(shr(18, input), 0x3F)))) resultPtr := add(resultPtr, 1)
                mstore8(resultPtr, mload(add(tablePtr, and(shr(12, input), 0x3F)))) resultPtr := add(resultPtr, 1)
                mstore8(resultPtr, mload(add(tablePtr, and(shr(6, input), 0x3F))))  resultPtr := add(resultPtr, 1)
                mstore8(resultPtr, mload(add(tablePtr, and(input, 0x3F))))          resultPtr := add(resultPtr, 1)
            }
            switch mod(mload(data), 3)
            case 1 { mstore8(sub(resultPtr, 1), 0x3d) mstore8(sub(resultPtr, 2), 0x3d) }
            case 2 { mstore8(sub(resultPtr, 1), 0x3d) }
        }
        return result;
    }

    function recoverSigner(bytes32 ethSignedMessageHash, bytes memory sig) public pure returns (address) {
        (bytes32 r, bytes32 s, uint8 v) = splitSignature(sig);
        return ecrecover(ethSignedMessageHash, v, r, s);
    }

    function splitSignature(bytes memory sig) public pure returns (bytes32 r, bytes32 s, uint8 v) {
        require(sig.length == 65, "invalid signature length");
        assembly {
            r := mload(add(sig, 32))
            s := mload(add(sig, 64))
            v := byte(0, mload(add(sig, 96)))
        }
    }
}
