// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

import "@chainlink/contracts/src/v0.8/automation/interfaces/AutomationCompatibleInterface.sol";
import "@chainlink/contracts/src/v0.8/shared/access/ConfirmedOwner.sol";
import "@chainlink/contracts/src/v0.8/functions/dev/v1_0_0/FunctionsClient.sol";
import "@chainlink/contracts/src/v0.8/functions/dev/v1_0_0/libraries/FunctionsResponse.sol";

contract OnChainTTT is AutomationCompatibleInterface, FunctionsClient, ConfirmedOwner {
    using FunctionsRequest for FunctionsRequest.Request;

    event GameCreated(uint256 gameId, address indexed player1, bytes32 gameKey);
    event GameJoined(uint256 gameId, address indexed player2);
    event GameEnded(uint256 gameId, address winner, uint256 reward);
    event GameCancelled(uint256 gameId);
    event GameResultRequested(uint256 gameId);
    event WinnerDetermined(uint256 gameId, address winner);
    event AddressParsed(string rawAddress, address parsedAddress);
    event RankUpdated(address indexed player, string newRank);
    event RequestFailed(uint256 gameId, string message);

    struct Game {
        uint256 gameId;
        uint256 betAmount;
        uint256 lastCheckedTime;
        uint8 requestAttempts;
        address player1;
        address player2;
        address winner;
        bytes32 gameKey;
        bool isActive;
        bool winnerDetermined;
        bool requestSent;
    }

    struct Player {
        uint256 xp;
        uint8 rankIndex;
    }

    address public constant DRAW_ADDRESS = 0x0000000000000000000000000000000000deaD11;

    address public admin1;
    address public admin2;
    address public router;
    bytes32 public donID;

    uint32 public gasLimit;
    uint64 public subscriptionId;
    uint256 public nextGameId;
    uint256 public accumulatedFees;
    uint256 constant minBetAmount = 100000000000000; // 0.0001 $MATIC
    uint256 constant maxBetAmount = 100000000000000000000000; // 100,000.0000 $MATIC
    uint256[] public xpThresholds = [0, 100, 250, 500, 1000, 2000];
    string[] public rankNames = ["Beginner", "Novice", "Competent", "Proficient", "Expert", "Master"];

    mapping(uint256 => Game) public games;
    mapping(address => Player) public players;
    mapping(address => uint256) private activeGameId;
    mapping(bytes32 => uint256) private requestToGameId;

    constructor(address _router, address _admin1, address _admin2, bytes32 _donID) FunctionsClient(_router) ConfirmedOwner(msg.sender) {
        admin1 = _admin1;
        admin2 = _admin2;
        router = _router;
        donID = _donID;
        gasLimit = 300000;
        subscriptionId = 209;
    }

    function setSubscriptionId(uint64 _subscriptionId) external onlyAdmin {
        subscriptionId = _subscriptionId;
    }

    function createGame() external payable {
        require(msg.value >= minBetAmount, "Bet amount must be at least 0.0001 MATIC");
        require(msg.value <= maxBetAmount, "Bet amount must be lower that 100,000.0000 MATIC");
        require(activeGameId[msg.sender] == 0 || !games[activeGameId[msg.sender]].isActive, "You already have an active game");

        uint256 gameId = nextGameId++;
        bytes32 gameKey = keccak256(abi.encodePacked(msg.sender, gameId));

        games[gameId] = Game({
            gameId: gameId,
            betAmount: msg.value,
            lastCheckedTime: block.timestamp,
            requestAttempts: 0,
            player1: msg.sender,
            player2: address(0),
            winner: address(0),
            gameKey: gameKey,
            isActive: true,
            winnerDetermined: false,
            requestSent: false
        });

        activeGameId[msg.sender] = gameId;
        emit GameCreated(gameId, msg.sender, gameKey);
    }

    function joinGame(uint256 gameId) external payable gameExists(gameId) isActiveGame(gameId) {
        Game storage game = games[gameId];
        require(game.player2 == address(0), "Game already full");
        require(msg.value == game.betAmount, "Bet amount must match the game's bet amount");
        require(activeGameId[msg.sender] == 0 || !games[activeGameId[msg.sender]].isActive, "You already have an active game");

        game.player2 = msg.sender;
        game.isActive = true;
        game.lastCheckedTime = block.timestamp;
        activeGameId[msg.sender] = gameId;
        emit GameJoined(gameId, msg.sender);
    }

    function endGame(uint256 gameId) internal {
        Game storage game = games[gameId];
        require(game.winnerDetermined, "Winner has not been determined yet");
        require(game.isActive, "Game is not active");

        updatePlayerXP(game.player1, game.winner == game.player1);
        updatePlayerXP(game.player2, game.winner == game.player2);
        game.isActive = false;
        activeGameId[game.player1] = 0;
        if (game.player2 != address(0)) {
            activeGameId[game.player2] = 0;
        }

        uint256 totalBet = game.betAmount * 2;
        if (game.winner == DRAW_ADDRESS) {
            payable(game.player1).transfer(game.betAmount);
            payable(game.player2).transfer(game.betAmount);
            emit GameEnded(gameId, address(0), 0);
        } else {
            uint256 reward = (totalBet * 95) / 100;
            uint256 feeAmount = totalBet - reward;
            payable(game.winner).transfer(reward);
            accumulatedFees += feeAmount;
            emit GameEnded(gameId, game.winner, reward);
        }
    }

    function updatePlayerXP(address player, bool won) internal {
        uint256 xpWon = won ? 50 : 10;
        Player storage playerInfo = players[player];
        playerInfo.xp += xpWon;

        updatePlayerRank(player);
    }

    function updatePlayerRank(address player) internal {
        Player storage playerInfo = players[player];
        uint8 newRankIndex = playerInfo.rankIndex;

        for (uint8 i = playerInfo.rankIndex; i < xpThresholds.length; i++) {
            if (playerInfo.xp >= xpThresholds[i]) {
                newRankIndex = i;
            } else {
                break;
            }
        }

        if (newRankIndex != playerInfo.rankIndex) {
            playerInfo.rankIndex = newRankIndex;
            emit RankUpdated(player, rankNames[newRankIndex]);
        }
    }

    function cancelGame(uint256 gameId) external gameExists(gameId) isActiveGame(gameId) {
        Game storage game = games[gameId];
        require(game.player1 == msg.sender, "Only the creator can cancel the game");
        require(game.player2 == address(0), "Cannot cancel a game that has already started");

        game.isActive = false;
        activeGameId[msg.sender] = 0;
        payable(game.player1).transfer(game.betAmount);

        emit GameCancelled(gameId);
    }

    function getActiveGames() external view returns (Game[] memory) {
        uint256 activeCount = 0;
        for (uint256 i = 0; i < nextGameId; i++) {
            if (games[i].isActive) {
                activeCount++;
            }
        }

        Game[] memory activeGames = new Game[](activeCount);
        uint256 index = 0;
        for (uint256 i = 0; i < nextGameId; i++) {
            if (games[i].isActive) {
                activeGames[index] = games[i];
                index++;
            }
        }

        return activeGames;
    }

    function withdraw(uint256 amount) external onlyAdmin {
        require(amount <= accumulatedFees, "Amount exceeds available fees");
        accumulatedFees -= amount;
        payable(msg.sender).transfer(amount);
    }

    function checkUpkeep(bytes calldata /* checkData */) external view override returns (bool upkeepNeeded, bytes memory performData) {
        for (uint256 i = 0; i < nextGameId; i++) {
            Game storage game = games[i];
            if (game.isActive) {
                if (!game.winnerDetermined && game.player2 != address(0) && !game.requestSent && block.timestamp >= game.lastCheckedTime + 40 seconds) {
                    return (true, abi.encode(true, i));
                }
                if (game.winnerDetermined) {
                    return (true, abi.encode(false, i));
                }
            }
        }
        return (false, "");
    }

    function performUpkeep(bytes calldata performData) external override {
        (bool shouldRequestResult, uint256 gameId) = abi.decode(performData, (bool, uint256));
        Game storage game = games[gameId];

        if (shouldRequestResult) {
            if (game.isActive && !game.winnerDetermined && game.player2 != address(0) && !game.requestSent) {
                requestGameResult(gameId);
                game.requestSent = true;
            }
        } else {
            if (game.isActive && game.winnerDetermined) {
                endGame(gameId);
            }
        }
    }

    function publicRequestGameResult(uint256 gameId) external isActiveGame(gameId) {
        Game storage game = games[gameId];
        game.requestSent = false;
        requestGameResult(gameId);
    }

    function requestGameResult(uint256 gameId) internal {
        Game storage game = games[gameId];
        require(!game.requestSent, "Request already sent");
        require(!game.winnerDetermined, "Winner has already been determined");
        
        game.requestAttempts++;
        game.requestSent = true;
        
        FunctionsRequest.Request memory req;
        req.initializeRequestForInlineJavaScript(
            string.concat(
                "const gameId = args[0];",
                "const response = await Functions.makeHttpRequest({",
                "    url: `https://app.sbc.pp.ua:443/game/${gameId}/winner`,",
                "    method: 'GET'",
                "});",
                "if (response.error) {",
                "    console.error(response.error);",
                "    throw new Error('Request failed');",
                "}",
                "const { data } = response;",
                "console.log('API response data:', JSON.stringify(data, null, 2));",
                "return Functions.encodeString(data.winner);"
            )
        );

        string[] memory args = new string[](1);
        args[0] = uint2str(gameId);
        req.setArgs(args);

        bytes32 requestId = _sendRequest(
            req.encodeCBOR(),
            subscriptionId,
            gasLimit,
            donID
        );

        requestToGameId[requestId] = gameId;
        emit GameResultRequested(gameId);
    }

    function fulfillRequest(bytes32 requestId, bytes memory response, bytes memory) internal override {
        uint256 gameId = requestToGameId[requestId];
        Game storage game = games[gameId];
        require(!game.winnerDetermined, "Winner has already been determined.");

        if (bytes(string(response)).length < 42) {
            emit RequestFailed(gameId, "Invalid response length");
            if (game.requestAttempts < 2) {
                game.requestSent = false;
                game.lastCheckedTime = block.timestamp;
                requestGameResult(gameId);
            } else {
                delete requestToGameId[requestId];
                game.isActive = false; 
            }
            return;
        }

        address winner = parseAddress(string(response));
        game.winner = winner;
        game.winnerDetermined = true;
        game.requestSent = false;
        emit WinnerDetermined(gameId, winner);
        delete requestToGameId[requestId];
    }

    function uint2str(uint _i) internal pure returns (string memory _uintAsString) {
        if (_i == 0) {
            return "0";
        }
        uint j = _i;
        uint len;
        while (j != 0) {
            len++;
            j /= 10;
        }
        bytes memory bstr = new bytes(len);
        uint k = len;
        while (_i != 0) {
            k = k - 1;
            uint8 temp = (48 + uint8(_i - _i / 10 * 10));
            bytes1 b1 = bytes1(temp);
            bstr[k] = b1;
            _i /= 10;
        }
        return string(bstr);
    }

    function parseAddress(string memory addr) internal returns (address) {
        bytes memory addrBytes = bytes(addr);
        require(addrBytes.length >= 42, "Address string too short");
        uint160 result = 0;
        uint160 b;
        uint160 base = 16;

        for (uint256 i = 2; i < 42; i++) {
            b = uint160(uint8(addrBytes[i]));
            if (b >= 48 && b <= 57) {
                b -= 48;
            } else if (b >= 65 && b <= 70) {
                b -= 55;
            } else if (b >= 97 && b <= 102) {
                b -= 87;
            } else {
                revert("Invalid character in address");
            }

            result = result * base + b;
        }

        address parsed = address(result);
        emit AddressParsed(addr, parsed);
        return parsed;
    }

    modifier gameExists(uint256 gameId) {
        require(gameId < nextGameId, "Game does not exist");
        _;
    }

    modifier isActiveGame(uint256 gameId) {
        require(games[gameId].isActive, "Game is not active");
        _;
    }

    modifier onlyAdmin() {
        require(msg.sender == admin1 || msg.sender == admin2, "Only admins can call this function");
        _;
    }
}
