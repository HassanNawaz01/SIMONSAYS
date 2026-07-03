// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * SimonSaysScores — minimal onchain score registry + leaderboard for Base mainnet.
 *
 * SECURITY DESIGN (intentionally boring):
 *  - Non-payable everywhere: the contract can never receive or hold ETH.
 *  - No token logic, no approvals, no transferFrom, no signatures.
 *  - No owner / admin functions: nobody can upgrade it or touch user data.
 *  - The ONLY thing a player ever signs is a plain mintScore(uint256) call.
 *    Even if the frontend is fully compromised, the worst possible
 *    transaction it can craft against this contract is writing a fake score.
 *
 * LEADERBOARD DESIGN:
 *  - Every unique player is registered once in `players`.
 *  - The frontend reads players in pages via getRange() (free eth_calls,
 *    no gas) and sorts the top scores client-side.
 */
contract SimonSaysScores {
    mapping(address => uint256) public bestScore;
    mapping(address => uint256) public totalMints;

    address[] private players;
    mapping(address => bool) private registered;

    event ScoreMinted(address indexed player, uint256 score, uint256 newBest, uint256 timestamp);

    /// Record a finished game. Keeps the player's best score onchain.
    function mintScore(uint256 score) external {
        if (!registered[msg.sender]) {
            registered[msg.sender] = true;
            players.push(msg.sender);
        }
        totalMints[msg.sender] += 1;
        if (score > bestScore[msg.sender]) {
            bestScore[msg.sender] = score;
        }
        emit ScoreMinted(msg.sender, score, bestScore[msg.sender], block.timestamp);
    }

    /// Total number of unique players ever.
    function playerCount() external view returns (uint256) {
        return players.length;
    }

    /// Read a page of (player, bestScore) pairs. Free to call, costs no gas.
    function getRange(uint256 start, uint256 count)
        external
        view
        returns (address[] memory addrs, uint256[] memory scores)
    {
        uint256 n = players.length;
        if (start >= n) return (new address[](0), new uint256[](0));
        uint256 end = start + count;
        if (end > n) end = n;
        uint256 len = end - start;
        addrs = new address[](len);
        scores = new uint256[](len);
        for (uint256 i = 0; i < len; i++) {
            address p = players[start + i];
            addrs[i] = p;
            scores[i] = bestScore[p];
        }
    }
}
