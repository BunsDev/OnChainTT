const express = require("express");
const path = require("path");
const socketIO = require("socket.io");
const fs = require("fs");
const cors = require("cors");
const https = require('https');
const mysql = require('mysql2');
const Web3 = require('web3');
const bodyParser = require('body-parser');

const config = require('./config.json');
const { contractAddress, contractABI } = require('./contract.js');

const web3 = new Web3(new Web3.providers.WebsocketProvider(`wss://polygon-amoy.g.alchemy.com/v2/${config.RPC_API_KEY}`));
const contract = new web3.eth.Contract(contractABI, contractAddress);

const pool = mysql.createPool({
    host: config.HOST,
    user: config.USER,
    password: config.PASSWORD,
    database: config.DATABASE,
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0
});

const promisePool = pool.promise();

const app = express();

const options = {
    key: fs.readFileSync('/etc/letsencrypt/live/app.sbc.pp.ua/privkey.pem'),
    cert: fs.readFileSync('/etc/letsencrypt/live/app.sbc.pp.ua/fullchain.pem'),
};

const server = https.createServer(options, app);

const io = socketIO(server, {
    cors: {
        origin: "*",
        methods: ["GET", "POST"],
        credentials: true,
    },
});
const PORT = 443;

const corsOptions = {
    origin: ["https://localhost:443", "https://app.sbc.pp.ua:443"],
    methods: ["GET", "POST"],
    credentials: true,
};

app.use(cors(corsOptions));
app.use(express.static(path.join(__dirname, "..", "client")));
app.use(bodyParser.json({ limit: '50mb' }));

server.listen(PORT, () => {
    console.log(`Server listening on port ${PORT}`);
    listenToContractEvents(); // Call the function to set up event listeners
});

let sessionCounter = 0;
const sessionLinks = {};
const sessionAccounts = {};
const gameOpponents = {};
const gameSessions = {};
let waitingQueue = [];
const activeSessions = new Set();

const logFile = path.join(__dirname, "logs.txt");

function listenToContractEvents() {
    contract.events.GameJoined({})
        .on('data', (event) => {
            io.emit('gameJoined', { gameId: event.returnValues.gameId, player2: event.returnValues.player2 });
        })
        .on('error', console.error);

    contract.events.GameEnded({})
        .on('data', (event) => {
            io.emit('gameEnded', { gameId: event.returnValues.gameId, winner: event.returnValues.winner, reward: event.returnValues.reward });
        })
        .on('error', console.error);

    contract.events.GameCancelled({})
        .on('data', (event) => {
            io.emit('gameCancelled', { gameId: event.returnValues.gameId });
        })
        .on('error', console.error);
}

function logEvent(event) {
    const timestamp = new Date().toISOString();
    const logEntry = `${timestamp} - ${event}\n`;
    fs.appendFileSync(logFile, logEntry, "utf8");
}

io.on("connection", (socket) => {
    const sessionId = ++sessionCounter;
    sessionLinks[sessionId] = socket;
    // logEvent(`Client connected: Session ${sessionId}`);

    socket.on("message", (rawData) => {
        const action = JSON.parse(rawData);
        if (action.method === "connect") {
            sessionAccounts[sessionId] = action.account;
            logEvent(
                `Wallet connected: Session ${sessionId} - Account ${action.account}`,
            );
        } else if (action.method === "move") {
            logEvent(
                `Move by Session ${sessionId}: ${JSON.stringify(action.field)}`,
            );
            processMove(action, sessionId);
        } else if (action.method === "start") {
            if (!activeSessions.has(sessionId)) {
                waitingQueue.push({
                    sessionId,
                    gameId: action.gameId,
                    betAmount: action.betAmount,
                });
                logEvent(
                    `Session ${sessionId} started a game with bet amount ${action.betAmount}`,
                );
                broadcastGameCreated(
                    action.gameId,
                    action.account,
                    action.betAmount,
                );
                tryPairing();
            }
        } else if (action.method === "join") {
            if (!activeSessions.has(sessionId)) {
                waitingQueue.push({
                    sessionId,
                    gameId: action.gameId,
                    betAmount: action.betAmount,
                });
                logEvent(`Session ${sessionId} joined a game`);
                tryPairing();
            }
        }
    });

    socket.on("disconnect", () => {
        logEvent(`Client disconnected: Session ${sessionId}`);
        terminateSession(sessionId);
    });
});

function tryPairing() {
    while (waitingQueue.length >= 2) {
        const [
            {
                sessionId: firstId,
                gameId: firstGameId,
                betAmount: firstBetAmount,
            },
            {
                sessionId: secondId,
                gameId: secondGameId,
                betAmount: secondBetAmount,
            },
        ] = waitingQueue;

        if (
            firstId === secondId ||
            sessionAccounts[firstId] === sessionAccounts[secondId] ||
            firstGameId !== secondGameId ||
            firstBetAmount !== secondBetAmount
        ) {
            waitingQueue.shift();
            continue;
        }

        waitingQueue.splice(0, 2);

        contract.methods.getRandomWords(firstGameId).call().then(randomWords => {
            console.log(`Random Words for game ${firstGameId}: [${randomWords[0]}, ${randomWords[1]}]`);
            const firstPlayerTurn = randomWords[0] > randomWords[1] ? firstId : secondId;
            const secondPlayerTurn = firstPlayerTurn === firstId ? secondId : firstId;

            sessionLinks[firstPlayerTurn].emit(
                "message",
                JSON.stringify({
                    method: "join",
                    symbol: "X",
                    turn: "X",
                    gameId: firstGameId,
                    betAmount: firstBetAmount,
                }),
            );

            sessionLinks[secondPlayerTurn].emit(
                "message",
                JSON.stringify({
                    method: "join",
                    symbol: "O",
                    turn: "X",
                    gameId: firstGameId,
                    betAmount: firstBetAmount,
                }),
            );

            gameOpponents[firstPlayerTurn] = secondPlayerTurn;
            gameOpponents[secondPlayerTurn] = firstPlayerTurn;
            gameSessions[firstGameId] = [firstPlayerTurn, secondPlayerTurn];
            activeSessions.add(firstPlayerTurn);
            activeSessions.add(secondPlayerTurn);

            logEvent(
                `Game paired: Session ${firstPlayerTurn} (X) vs Session ${secondPlayerTurn} (O) for game ${firstGameId} with bet amount ${firstBetAmount}`,
            );
        }).catch(err => {
            console.error("Failed to retrieve random numbers for game ${firstGameId}: " + err.message);
        });
    }
}

function processMove(action, sessionId) {
    const opponentId = gameOpponents[sessionId];
    const outcome = checkGameOutcome(action.field);
    const gameId = action.gameId;

    if (outcome) {
        if (outcome.message === "Draw") {
            saveWinner(gameId, "draw").then(() => {
                [sessionId, opponentId].forEach(id => {
                    sessionLinks[id].emit("message", JSON.stringify({
                        method: "result",
                        message: "Draw! Game over.",
                        field: action.field,
                        gameId: gameId,
                    }));
                });
                logEvent(`Game draw: Game ${gameId} ended with a draw.`);
                activeSessions.delete(sessionId);
                activeSessions.delete(opponentId);
                broadcastGameEnded(gameId);
            }).catch(err => {
                console.error("Failed to save draw result due to error: " + err.message);
            });
        } else {
            const winnerSymbol = outcome.message.split(" ")[0];
            const winnerSessionId = (winnerSymbol === "X" ? gameSessions[gameId][0] : gameSessions[gameId][1]);
            const winnerAccount = sessionAccounts[winnerSessionId];
            saveWinner(gameId, winnerAccount).then(() => {
                [sessionId, opponentId].forEach(id => {
                    sessionLinks[id].emit("message", JSON.stringify({
                        method: "result",
                        message: outcome.message,
                        field: action.field,
                        gameId: gameId,
                    }));
                });
                logEvent(`Game result: ${outcome.message}`);
                activeSessions.delete(sessionId);
                activeSessions.delete(opponentId);
                broadcastGameEnded(gameId);
            }).catch(err => {
                console.error("Failed to save winner due to error: " + err.message);
            });
        }
    } else {
        [sessionId, opponentId].forEach(id => {
            sessionLinks[id].emit("message", JSON.stringify({
                method: "update",
                turn: action.symbol === "X" ? "O" : "X",
                field: action.field,
                gameId: gameId,
            }));
        });
    }
}

async function saveWinner(gameId, winnerAccount) {
    if (!gameId || !winnerAccount) {
        console.error("Error: gameId or winnerAccount is undefined");
        return;
    }

    const specialDrawAddress = "0x0000000000000000000000000000000000deaD11";
    const accountToSave = winnerAccount === "draw" ? specialDrawAddress : winnerAccount;

    try {
        await promisePool.execute(
            "INSERT INTO winners (gameId, winnerAccount) VALUES (?, ?) ON DUPLICATE KEY UPDATE winnerAccount = VALUES(winnerAccount)",
            [gameId, accountToSave]
        );
        console.log(`Result for game ${gameId} saved as: ${accountToSave}`);
    } catch (err) {
        console.error("Database error: " + err.message);
        throw err;
    }
}

app.get("/game/:gameId/winner", async (req, res) => {
    const { gameId } = req.params;
    try {
        const [rows, fields] = await promisePool.execute(
            "SELECT winnerAccount FROM winners WHERE gameId = ?",
            [gameId]
        );
        if (rows.length > 0) {
            res.json({ winner: rows[0].winnerAccount });
        } else {
            res.status(404).send("Game not found or no winner yet");
        }
    } catch (err) {
        console.error("Database error: " + err.message);
        res.status(500).send("Internal Server Error");
    }
});

app.post('/save-avatar', async (req, res) => {
    const { account, avatarData } = req.body;
    try {
        await promisePool.execute(
            "INSERT INTO avatars (account, avatarData) VALUES (?, ?) ON DUPLICATE KEY UPDATE avatarData = VALUES(avatarData)",
            [account, avatarData]
        );
        res.send({ success: true });
    } catch (err) {
        console.error("Database error: " + err.message);
        res.status(500).send("Internal Server Error");
    }
});

app.get('/get-avatar', async (req, res) => {
    const { account } = req.query;
    try {
        const [rows] = await promisePool.execute(
            "SELECT avatarData FROM avatars WHERE account = ?",
            [account]
        );
        if (rows.length > 0) {
            res.json({ avatarData: rows[0].avatarData });
        } else {
            res.status(404).send({ error: 'Avatar not found' });
        }
    } catch (err) {
        console.error("Database error: " + err.message);
        res.status(500).send("Internal Server Error");
    }
});

function broadcastGameCreated(gameId, player1, betAmount) {
    const message = JSON.stringify({
        method: "gameCreated",
        gameId: gameId.toString(),
        player1,
        betAmount,
    });
    for (const sessionId in sessionLinks) {
        sessionLinks[sessionId].emit("message", message);
    }
}

function broadcastGameEnded(gameId) {
    const message = JSON.stringify({
        method: "gameEnded",
        gameId: gameId.toString(),
    });
    for (const sessionId in sessionLinks) {
        sessionLinks[sessionId].emit("message", message);
    }
}

function terminateSession(sessionId) {
    const opponentId = gameOpponents[sessionId];
    let opponentAccount = sessionAccounts[opponentId] || "N/A";

    let currentGameId = null;
    for (let key in gameSessions) {
        if (gameSessions[key].includes(sessionId)) {
            currentGameId = key;
            break;
        }
    }

    if (opponentId && activeSessions.has(opponentId) && currentGameId) {
        saveWinner(currentGameId, opponentAccount).then(() => {
            sessionLinks[opponentId].emit("message", JSON.stringify({
                method: "result",
                message: "Opponent disconnected. You win!",
                field: [],
                gameId: currentGameId,
            }));
            logEvent(`Game result: Opponent disconnected. Session ${opponentId} wins Game ${currentGameId}`);
        }).catch(err => {
            console.error("Failed to save winner due to error: " + err.message);
        });
        delete gameSessions[currentGameId];
        activeSessions.delete(sessionId);
        activeSessions.delete(opponentId);
    }

    delete sessionLinks[sessionId];
    delete gameOpponents[sessionId];
    delete sessionAccounts[sessionId];
    activeSessions.delete(sessionId);

    const index = waitingQueue.findIndex(
        (item) => item.sessionId === sessionId
    );
    if (index !== -1) {
        waitingQueue.splice(index, 1);
    }

    console.log(`Session terminated: ${sessionId}. Opponent ${opponentId || "N/A"} left. Opponent account: ${opponentAccount}`);
}

const victoryConditions = [
    [0, 1, 2],
    [3, 4, 5],
    [6, 7, 8],
    [0, 3, 6],
    [1, 4, 7],
    [2, 5, 8],
    [0, 4, 8],
    [2, 4, 6],
];

function checkGameOutcome(field) {
    for (const combo of victoryConditions) {
        if (
            combo.every(
                (index) => field[index] && field[index] === field[combo[0]],
            )
        ) {
            return { message: `${field[combo[0]]} wins` };
        }
    }

    if (field.every((symbol) => symbol)) {
        return { message: "Draw" };
    }

    return null;
}
