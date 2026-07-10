// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * SimonStakeEscrow
 *
 * Holds paid 1v1 stakes until the match result is signed by the game server.
 * Each player pays stake + 0.05% platform fee. Fees are credited to the
 * fee recipient, and the two stakes remain locked until settlement.
 */
contract SimonStakeEscrow {
    uint256 public constant FEE_BPS = 5; // 0.05%
    uint256 private constant BPS_DENOMINATOR = 10_000;

    address public owner;
    address public feeRecipient;
    address public signerAddress;
    uint256 private locked;

    mapping(uint256 => bool) public allowedStake;
    mapping(address => uint256) public credits;
    mapping(bytes32 => EscrowMatch) public matches;

    struct EscrowMatch {
        address player1;
        address player2;
        uint256 stake;
        uint64 createdAt;
        bool player1Deposited;
        bool player2Deposited;
        bool settled;
    }

    event Deposited(bytes32 indexed matchId, address indexed player, address indexed opponent, uint256 stake, uint256 fee);
    event Settled(bytes32 indexed matchId, address indexed winner, uint256 payout);
    event Refunded(bytes32 indexed matchId, address indexed player, uint256 amount);
    event FeeRecipientUpdated(address indexed feeRecipient);
    event SignerUpdated(address indexed signerAddress);
    event StakeAllowed(uint256 stake, bool allowed);

    modifier onlyOwner() {
        require(msg.sender == owner, "not owner");
        _;
    }

    modifier nonReentrant() {
        require(locked == 0, "reentrant");
        locked = 1;
        _;
        locked = 0;
    }

    constructor(address _signerAddress, address _feeRecipient) {
        require(_signerAddress != address(0), "bad signer");
        require(_feeRecipient != address(0), "bad fee recipient");
        owner = msg.sender;
        signerAddress = _signerAddress;
        feeRecipient = _feeRecipient;

        allowedStake[0.0005 ether] = true;
        allowedStake[0.001 ether] = true;
        allowedStake[0.005 ether] = true;
        allowedStake[0.01 ether] = true;
    }

    function setSigner(address _signerAddress) external onlyOwner {
        require(_signerAddress != address(0), "bad signer");
        signerAddress = _signerAddress;
        emit SignerUpdated(_signerAddress);
    }

    function setFeeRecipient(address _feeRecipient) external onlyOwner {
        require(_feeRecipient != address(0), "bad fee recipient");
        feeRecipient = _feeRecipient;
        emit FeeRecipientUpdated(_feeRecipient);
    }

    function setAllowedStake(uint256 stake, bool allowed) external onlyOwner {
        allowedStake[stake] = allowed;
        emit StakeAllowed(stake, allowed);
    }

    function requiredValue(uint256 stake) public pure returns (uint256) {
        return stake + feeFor(stake);
    }

    function feeFor(uint256 stake) public pure returns (uint256) {
        return (stake * FEE_BPS) / BPS_DENOMINATOR;
    }

    function deposit(bytes32 matchId, address opponent, uint256 stake) external payable nonReentrant {
        require(matchId != bytes32(0), "bad match");
        require(opponent != address(0) && opponent != msg.sender, "bad opponent");
        require(allowedStake[stake], "stake not allowed");
        require(msg.value == requiredValue(stake), "bad value");

        EscrowMatch storage m = matches[matchId];
        if (m.stake == 0) {
            m.player1 = msg.sender;
            m.player2 = opponent;
            m.stake = stake;
            m.createdAt = uint64(block.timestamp);
        } else {
            require(m.stake == stake, "stake mismatch");
            require(
                (msg.sender == m.player1 && opponent == m.player2) ||
                (msg.sender == m.player2 && opponent == m.player1),
                "not participant"
            );
        }

        if (msg.sender == m.player1) {
            require(!m.player1Deposited, "already deposited");
            m.player1Deposited = true;
        } else if (msg.sender == m.player2) {
            require(!m.player2Deposited, "already deposited");
            m.player2Deposited = true;
        } else {
            revert("not participant");
        }

        uint256 fee = feeFor(stake);
        credits[feeRecipient] += fee;
        emit Deposited(matchId, msg.sender, opponent, stake, fee);
    }

    function hasDeposit(bytes32 matchId, address player) external view returns (bool) {
        EscrowMatch storage m = matches[matchId];
        if (player == m.player1) return m.player1Deposited;
        if (player == m.player2) return m.player2Deposited;
        return false;
    }

    function settle(bytes32 matchId, address winner, bytes calldata signature) external nonReentrant {
        EscrowMatch storage m = matches[matchId];
        require(!m.settled, "settled");
        require(m.player1Deposited && m.player2Deposited, "not funded");
        require(winner == m.player1 || winner == m.player2 || winner == address(0), "bad winner");
        require(_validSettlementSignature(matchId, winner, signature), "bad signature");

        m.settled = true;
        uint256 payout = m.stake * 2;
        if (winner == address(0)) {
            credits[m.player1] += m.stake;
            credits[m.player2] += m.stake;
        } else {
            credits[winner] += payout;
        }

        emit Settled(matchId, winner, payout);
    }

    function refundExpired(bytes32 matchId) external nonReentrant {
        EscrowMatch storage m = matches[matchId];
        require(!m.settled, "settled");
        require(m.createdAt != 0 && block.timestamp > m.createdAt + 30 minutes, "not expired");
        require(m.player1Deposited != m.player2Deposited, "not partial");

        m.settled = true;
        address player = m.player1Deposited ? m.player1 : m.player2;
        credits[player] += m.stake;
        emit Refunded(matchId, player, m.stake);
    }

    function withdraw() external nonReentrant {
        uint256 amount = credits[msg.sender];
        require(amount > 0, "no credit");
        credits[msg.sender] = 0;
        (bool ok, ) = msg.sender.call{value: amount}("");
        require(ok, "withdraw failed");
    }

    function _validSettlementSignature(bytes32 matchId, address winner, bytes calldata signature) internal view returns (bool) {
        EscrowMatch storage m = matches[matchId];
        bytes32 messageHash = keccak256(abi.encodePacked(address(this), matchId, m.player1, m.player2, m.stake, winner));
        bytes32 ethSignedMessageHash = keccak256(abi.encodePacked("\x19Ethereum Signed Message:\n32", messageHash));
        return recoverSigner(ethSignedMessageHash, signature) == signerAddress;
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
