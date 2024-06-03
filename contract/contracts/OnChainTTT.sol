/*

▄▄▄  ▄• ▄▌·▄▄▄·▄▄▄ ▄▄▄▄·  ▄• ▄▌·▄▄▄·▄▄▄
▀▄ █·█▪██▌▐▄▄·▐▄▄· ▐█ ▀█▪ █▪██▌▐▄▄·▐▄▄·
▐▀▀▄ █▌▐█▌██▪ ██▪  ▐█▀▀█▄ █▌▐█▌██▪ ██▪ 
▐█•█▌▐█▄█▌██▌.██▌ .██▄▪▐█ ▐█▄█▌██▌.██▌.
.▀  ▀ ▀▀▀ ▀▀▀ ▀▀▀  ·▀▀▀▀   ▀▀▀ ▀▀▀ ▀▀▀ 

#Wallet: 0xruffbuff.eth
#Discord: chain.eth | 0xRuffBuff#8817

*/
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

import "@chainlink/contracts/src/v0.8/automation/interfaces/AutomationCompatibleInterface.sol";
import "@chainlink/contracts/src/v0.8/functions/dev/v1_0_0/FunctionsClient.sol";
import "@chainlink/contracts/src/v0.8/functions/dev/v1_0_0/libraries/FunctionsResponse.sol";
import "@chainlink/contracts/src/v0.8/dev/vrf/VRFConsumerBaseV2Plus.sol";
import "@chainlink/contracts/src/v0.8/dev/vrf/libraries/VRFV2PlusClient.sol";
import "./PlayerRatings.sol";
import "./Utils.sol";

contract OnChainTTT is VRFConsumerBaseV2Plus, AutomationCompatibleInterface, FunctionsClient {
    using FunctionsRequest for FunctionsRequest.Request;
    using PlayerRatings for PlayerRatings.Player;
    using Utils for *;

    event GameCreated(uint256 gameId, address indexed player1);
    event GameJoined(uint256 gameId, address indexed player2);
    event GameEnded(uint256 gameId, address winner, uint256 reward);
    event GameCancelled(uint256 gameId);
    event GameResultRequested(uint256 gameId);
    event GameRequestFailed(uint256 gameId, string message);
    event WinnerDetermined(uint256 gameId, address winner);
    event AddressParsed(string rawAddress, address parsedAddress);
    event RandomWRequstSent(uint256 requestId, uint32 numWords);
    event RandomWRequstFulfilled(uint256 requestId, uint256[] randomWords); 

    struct Game {
        uint256 gameId;
        uint256 betAmount;
        uint256 lastCheckedTime;
        uint256[] randomWords;
        uint8 requestAttempts;
        address player1;
        address player2;
        address winner;
        bool isActive;
        bool winnerDetermined;
        bool requestSent;
    }

    struct RequestStatus {
        bool fulfilled;
        bool exists;
        uint256[] randomWords;
    }

    address public constant DRAW_ADDRESS = 0x0000000000000000000000000000000000deaD11;

    address public admin1;
    address public admin2;
    address public router;
    bytes32 public donID;

    bytes32 keyHash = 0x816bedba8a50b294e5cbd47842baf240c2385f2eaf719edbd4f250a137a8c899;
    uint32 callbackGasLimit = 300000;
    uint16 requestConfirmations = 3;
    uint32 numWords = 2;
    uint256 public s_subscriptionId = 65874477381308627793694165998392943664525396676498444094557313498870528215104;

    uint32 public gasLimit;
    uint64 public subscriptionId;
    uint256 public nextGameId;
    uint256 public accumulatedFees;
    uint256 constant minBetAmount = 100000000000000; // 0.0001 $MATIC
    uint256 constant maxBetAmount = 100000000000000000000000; // 100,000.0000 $MATIC

    mapping(uint256 => Game) public games;
    mapping(address => uint256) private activeGameId;
    mapping(uint256 => RequestStatus) public s_requests;
    mapping(bytes32 => uint256) private requestToGameId;
    mapping(address => PlayerRatings.Player) public players;

    constructor(address _router, address _admin1, address _admin2, bytes32 _donID) VRFConsumerBaseV2Plus(0x343300b5d84D444B2ADc9116FEF1bED02BE49Cf2) FunctionsClient(_router) {
        admin1 = _admin1;
        admin2 = _admin2;
        router = _router;
        donID = _donID;
        gasLimit = 300000;
        subscriptionId = 209;
    }

    function createGame() external payable {
        require(msg.value >= minBetAmount, "MinBet is: 0.0001 MATIC");
        require(msg.value <= maxBetAmount, "MaxBet is: 100,000.0000 MATIC");
        require(activeGameId[msg.sender] == 0 || !games[activeGameId[msg.sender]].isActive, "You already have an active game");

        uint256 gameId = nextGameId++;

        games[gameId] = Game({
            gameId: gameId,
            betAmount: msg.value,
            lastCheckedTime: block.timestamp,
            randomWords: new uint256[](numWords),
            requestAttempts: 0,
            player1: msg.sender,
            player2: address(0),
            winner: address(0),
            isActive: true,
            winnerDetermined: false,
            requestSent: false
        });

        activeGameId[msg.sender] = gameId;
        requestRandomWords(gameId, false); // Pay with LINK
        emit GameCreated(gameId, msg.sender);
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

    function endGame(uint256 gameId) internal isActiveGame(gameId) {
        Game storage game = games[gameId];
        require(game.winnerDetermined, "Winner not yet determined");

        updatePlayerXP(game.player1, game.winner == game.player1);
        updatePlayerXP(game.player2, game.winner == game.player2);

        updatePlayerRank(game.player1);
        updatePlayerRank(game.player2);

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

    function cancelGame(uint256 gameId) external gameExists(gameId) isActiveGame(gameId) {
        Game storage game = games[gameId];
        require(game.player1 == msg.sender, "Only the creator can cancel the game");
        require(game.player2 == address(0), "Game already full");

        game.isActive = false;
        activeGameId[msg.sender] = 0;
        payable(game.player1).transfer(game.betAmount);

        emit GameCancelled(gameId);
    }

    function updatePlayerXP(address playerAddress, bool won) internal {
        players[playerAddress].updateXP(won);
    }

    function updatePlayerRank(address playerAddress) internal {
        players[playerAddress].updateRank(playerAddress);
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

    function withdraw(uint256 amount) external onlyOwner() {
        require(amount <= accumulatedFees, "Withdrawal miss");
        accumulatedFees -= amount;
        payable(msg.sender).transfer(amount);
    }

    function requestRandomWords(uint256 gameId, bool enableNativePayment) internal returns (uint256 requestId) {
        requestId = s_vrfCoordinator.requestRandomWords(
            VRFV2PlusClient.RandomWordsRequest({
                keyHash: keyHash,
                subId: s_subscriptionId,
                requestConfirmations: requestConfirmations,
                callbackGasLimit: callbackGasLimit,
                numWords: numWords,
                extraArgs: VRFV2PlusClient._argsToBytes(
                    VRFV2PlusClient.ExtraArgsV1({
                        nativePayment: enableNativePayment
                    })
                )
            })
        );
        s_requests[requestId] = RequestStatus({
            randomWords: new uint256[](numWords),
            exists: true,
            fulfilled: false
        });
        games[gameId].requestSent = true;
        requestToGameId[bytes32(requestId)] = gameId;
        emit RandomWRequstSent(requestId, numWords);
        return requestId;
    }

    function fulfillRandomWords(uint256 requestId, uint256[] memory randomWords) internal override {
        require(s_requests[requestId].exists, "request not found");
        s_requests[requestId].fulfilled = true;
        s_requests[requestId].randomWords = randomWords;
        uint256 gameId = requestToGameId[bytes32(requestId)];
        Game storage game = games[gameId];
        game.requestSent = false;
        game.randomWords = randomWords;
        emit RandomWRequstFulfilled(requestId, randomWords);
    }

    function getRandomWords(uint256 gameId) public view returns (uint256[] memory) {
        require(gameId < nextGameId, "Game does not exist");
        return games[gameId].randomWords;
    }

    function checkUpkeep(bytes calldata /* checkData */) external view override returns (bool upkeepNeeded, bytes memory performData) {
        for (uint256 i = 0; i < nextGameId; i++) {
            Game storage game = games[i];
            if (game.isActive) {
                if (!game.winnerDetermined && game.player2 != address(0) && !game.requestSent && block.timestamp >= game.lastCheckedTime + 20 seconds) {
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
        require(!game.winnerDetermined, "Winner determined");
        
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
        args[0] = Utils.uint2str(gameId);
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
        require(!game.winnerDetermined, "Winner determined.");

        if (bytes(string(response)).length < 42) {
            emit GameRequestFailed(gameId, "Invalid response length");
            if (game.requestAttempts < 2) {
                game.requestSent = false;
                game.lastCheckedTime = block.timestamp;
                requestGameResult(gameId);
            } else {
                delete requestToGameId[requestId];
            }
            return;
        }

        address winner = Utils.parseAddress(string(response));
        game.winner = winner;
        game.winnerDetermined = true;
        game.requestSent = false;
        emit WinnerDetermined(gameId, winner);
        delete requestToGameId[requestId];
    }

    modifier gameExists(uint256 gameId) {
        require(gameId < nextGameId, "Game does not exist");
        _;
    }

    modifier isActiveGame(uint256 gameId) {
        require(games[gameId].isActive, "Game is not active");
        _;
    }
}
