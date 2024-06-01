import { contractAddress, contractABI } from './contract.js';

document.addEventListener('DOMContentLoaded', () => {
  const cells = document.querySelectorAll('.cell');
  const statusMessage = document.querySelector('.message');
  const modal = document.querySelector('.modal');
  const modalMessage = document.querySelector('.modal-message');
  const restartButton = document.querySelector('.restart-button');
  const connectWalletButton = document.querySelector('.connect-wallet-button');
  const startButton = document.querySelector('.start-button');
  const betAmountInput = document.querySelector('.bet-amount-input');
  const gameList = document.querySelector('.game-list');
  const menu = document.querySelector('.menu');
  const xpBarContainer = document.querySelector('.xp-bar-container');

  const settingsButton = document.querySelector('.settings-button');
  const avatarModal = document.querySelector('.avatar-modal');
  const avatarInput = document.querySelector('.avatar-input');
  const saveAvatarButton = document.querySelector('.save-avatar-button');

  const rulesButton = document.querySelector('.rules-button');
  const rulesModal = document.querySelector('.rules-modal');
  const closeButton = rulesModal.querySelector('.close-button');

  let gameBoard = new Array(9).fill("");
  let gameActive = false;
  let playerSymbol = null;
  let currentPlayer = null;
  let account = null;
  let web3;
  let contract;
  let gameId = null;
  let modalTimeout;
  let gameSessions = {};

  const socket = io("https://app.sbc.pp.ua:443");

  socket.on("message", (data) => {
      const parsedData = JSON.parse(data);
      switch (parsedData.method) {
          case "join":
              playerSymbol = parsedData.symbol;
              currentPlayer = parsedData.turn;
              gameId = parsedData.gameId;

              if (!gameSessions[parsedData.gameId]) {
                  gameSessions[parsedData.gameId] = [parsedData.account];
              } 
              
              if (!gameSessions[parsedData.gameId].includes(account)) {
                  gameSessions[parsedData.gameId].push(account);
              }

              updateGameDisplay();
              updateStatusMessage();
              menu.style.display = 'none';
              document.querySelector('.board').style.display = 'grid';
              statusMessage.style.display = 'block';
              modal.style.display = 'none';
              break;
          case "update":
              gameBoard = parsedData.field;
              currentPlayer = parsedData.turn;
              refreshGameBoard();
              updateGameDisplay();
              updateStatusMessage();
              break;
          case "result":
              gameBoard = parsedData.field;
              refreshGameBoard();
              currentPlayer = null;
              setTimeout(() => {
                  showModal(parsedData.message, { showRestartButton: true, autoClose: true });
              }, 100);
              removeGameFromList(parsedData.gameId);
              delete gameSessions[parsedData.gameId];
              updateGameDisplay();
              break;
          case "left":
              currentPlayer = null;
              if (statusMessage) statusMessage.textContent = parsedData.message;
              if (gameSessions[parsedData.gameId]) {
                  const index = gameSessions[parsedData.gameId].indexOf(parsedData.account);
                  if (index !== -1) {
                      gameSessions[parsedData.gameId].splice(index, 1);
                  }
              }
              modalMessage.textContent = parsedData.message;
              modal.style.display = 'flex';
              statusMessage.style.display = 'none';
              updateGameDisplay();
              break;
          case "gameCreated":
              const { gameId: newGameId, player1, betAmount } = parsedData;
              addGameToList(newGameId, player1, betAmount);
              break;
          case "gameEnded":
              removeGameFromList(parsedData.gameId);
              delete gameSessions[parsedData.gameId];
              break;
      }
  });

  socket.on('gameJoined', function(data) {
      updateGameList(data);
  });

  socket.on('gameEnded', function(data) {
      updatePlayerData();
      removeGameFromList(data.gameId);
    });

  socket.on('gameCancelled', function(data) {
      removeGameFromList(data.gameId);
    });

  socket.on("move", (data) => {
      const { sessionId, field } = data;
      gameBoard = field;
      refreshGameBoard();
      updateStatusMessage();
  });

  socket.on("endGame", (data) => {
      const { reason } = data;
      showModal(`Game ended: ${reason}`, { showRestartButton: true, autoClose: true });
  });

  cells.forEach((cell, index) => {
    cell.addEventListener('click', () => attemptMove(index));
  });

  if (settingsButton) {
    settingsButton.addEventListener('click', () => {
      avatarModal.style.display = 'flex';
    });
  }

  if (closeButton) {
    closeButton.addEventListener('click', () => {
      avatarModal.style.display = 'none';
    });
  }

  window.addEventListener('click', (event) => {
    if (event.target === avatarModal) {
      avatarModal.style.display = 'none';
    }
  });

  if (saveAvatarButton) {
    saveAvatarButton.addEventListener('click', () => {
      const file = avatarInput.files[0];
      if (file) {
        const reader = new FileReader();
        reader.onloadend = async () => {
          const base64Image = reader.result;
          try {
            await saveAvatarToDatabase(account, base64Image);
            alert('Avatar saved successfully!');
            avatarModal.style.display = 'none';
            updateAvatarDisplay(base64Image);
          } catch (error) {
            console.error('Error saving avatar:', error);
            alert('Error saving avatar.');
          }
        };
        reader.readAsDataURL(file);
      } else {
        alert('Please select an avatar.');
      }
    });
  }

  rulesButton.addEventListener('click', () => {
      rulesModal.style.display = 'flex';
  });

  closeButton.addEventListener('click', () => {
      rulesModal.style.display = 'none';
  });

  window.addEventListener('click', (event) => {
      if (event.target === rulesModal) {
          rulesModal.style.display = 'none';
      }
  });

  async function saveAvatarToDatabase(account, avatarData) {
    const response = await fetch('/save-avatar', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ account, avatarData }),
    });
    if (!response.ok) {
      throw new Error('Failed to save avatar');
    }
  }

  async function loadAvatarFromDatabase(account) {
      // console.log(`Attempting to load avatar for account: ${account}`);
      try {
          const response = await fetch(`/get-avatar?account=${account}`);
          if (response.ok) {
              const data = await response.json();
              // console.log(`Avatar loaded successfully for account: ${account}`, data);
              return data.avatarData;
          } else {
              console.error(`Failed to load avatar for account: ${account}. Status: ${response.status}`);
              return null;
          }
      } catch (error) {
          console.error(`Error loading avatar for account: ${account}`, error);
          return null;
      }
  }

  function updateAvatarDisplay(avatarData) {
    const avatarImage = document.querySelector('.avatar-image');

    if (avatarImage) {
      avatarImage.src = avatarData;
      avatarImage.style.display = 'block';
    }
  }

  function showModal(message, options = {}) {
    modalMessage.textContent = message;
    modal.style.display = 'flex';
    statusMessage.style.display = 'none';

    restartButton.style.display = options.showRestartButton ? 'block' : 'none';
    
    if (options.showCancelButton) {
        const cancelButton = document.createElement('button');
        cancelButton.textContent = 'Cancel Game';
        cancelButton.className = 'button cancel-game-button';
        cancelButton.onclick = function() {
            socket.emit("message", JSON.stringify({ method: "cancel", gameId: gameId }));
            closeModalAndRefresh();
        };
        modalMessage.appendChild(cancelButton);
    }

    if (options.autoClose) {
        modalTimeout = setTimeout(() => {
            closeModalAndRefresh();
        }, 30000);
    } else {
        clearTimeout(modalTimeout);
    }
  }

  async function updatePlayerData() {
    try {
      const playerData = await contract.methods.players(account).call();
      updateXPBar(playerData.xp, playerData.rankIndex);
    } catch (error) {
      console.error("Failed to fetch player data:", error);
    }
  }

  function closeModalAndRefresh() {
    modal.style.display = 'none';
    menu.style.display = 'flex';
    document.querySelector('.board').style.display = 'none';
    document.querySelector('.avatars-board').style.display = 'none';
    statusMessage.style.display = 'none';
    gameId = null;
    gameBoard = new Array(9).fill("");
    refreshGameBoard();
    currentPlayer = null;
    playerSymbol = null;
    updateGameList();
    updatePlayerData();
    document.querySelector('.xp-bar-container').style.display = 'block';

    clearTimeout(modalTimeout);
  }

  if (restartButton) {
    restartButton.addEventListener('click', () => {
      closeModalAndRefresh();
    });
  }

  function attemptMove(index) {
    if (!gameActive || gameBoard[index] !== "" || currentPlayer !== playerSymbol) return;

    gameBoard[index] = playerSymbol;
    cells[index].classList.add(playerSymbol);

    socket.emit("message", JSON.stringify({ method: "move", symbol: playerSymbol, field: gameBoard, gameId: gameId }));

    refreshGameBoard();

    gameActive = false;

    updateStatusMessage();
  }

  function refreshGameBoard() {
    cells.forEach((cell, index) => {
      cell.className = 'cell';
      if (gameBoard[index] !== "") cell.classList.add(gameBoard[index]);
    });
  }

  function updateStatusMessage() {
      if (statusMessage) {
          statusMessage.textContent = (playerSymbol === currentPlayer) ? "Your step" : `Waiting for opponent's move`;
      }
  }

  function updateGameDisplay() {
      gameActive = currentPlayer === playerSymbol;
      const board = document.querySelector('.board');
      const statusMessage = document.querySelector('.message');
      const avatarsBoard = document.querySelector('.avatars-board');

      board.style.display = 'grid';
      statusMessage.style.display = 'block';
      avatarsBoard.style.display = 'none';
  }

  async function connectWallet() {
    if (window.ethereum) {
      try {
        const accounts = await window.ethereum.request({ method: 'eth_requestAccounts' });
        account = accounts[0];
        console.log("Wallet connected, account:", account);

        web3 = new Web3(window.ethereum);
        contract = new web3.eth.Contract(contractABI, contractAddress);

        const networkId = await web3.eth.net.getId();
        const expectedNetworkId = 80002;
        if (networkId !== expectedNetworkId) {
          // console.error("Connected to the wrong network.");
          try {
            await window.ethereum.request({
              method: 'wallet_switchEthereumChain',
              params: [{ chainId: '0x13882' }],
            });
          } catch (switchError) {
            if (switchError.code === 4902) {
              try {
                await window.ethereum.request({
                  method: 'wallet_addEthereumChain',
                  params: [{
                    chainId: '0x13882',
                    chainName: 'Amoy Testnet',
                    rpcUrls: ['https://rpc-amoy.polygon.technology'],
                    nativeCurrency: {
                      name: 'MATIC',
                      symbol: 'MATIC',
                      decimals: 18,
                    },
                    blockExplorerUrls: ['https://amoy.polygonscan.com/']
                  }],
                });
                console.log("Successfully added the network.");
              } catch (addError) {
                alert('Failed to add the network.');
                console.error('Failed to add the network:', addError);
              }
            } else {
              alert('Please switch to the correct network.');
              console.error('Failed to switch network:', switchError);
            }
            return;
          }
        }

        const playerData = await contract.methods.players(account).call();
        if (!playerData) throw new Error("Failed to fetch player data");

        updateXPBar(playerData.xp, playerData.rankIndex);
        if (menu.style.display !== 'none') {
          document.querySelector('.xp-bar-container').style.display = 'block';
          document.querySelector('.rules-button').style.display = 'block'; 
        }

        socket.emit("message", JSON.stringify({ method: "connect", account }));
        updatePlayerData();
        updateGameList();
        listenForGameCreated();

        document.querySelector('.footer').style.display = 'flex';

        document.querySelector('.rules-button').style.display = 'none';

        connectWalletButton.style.display = 'none';
        startButton.style.display = 'block';
        betAmountInput.style.display = 'block';
        rulesButton.style.display = 'block';
        settingsButton.style.display = 'block';
      } catch (error) {
        console.error("Connection error:", error);
      }
    } else {
      console.log("MetaMask is not installed.");
      alert("Please install MetaMask!");
    }
  }

  function updateXPBar(xp, rankIndex) {
      xp = parseInt(xp);
      rankIndex = parseInt(rankIndex);
      const xpThresholds = [0, 100, 250, 500, 1000, 2000];
      const rankNames = ["Beginner", "Novice", "Competent", "Proficient", "Expert", "Master"];
      
      const currentRank = rankNames[rankIndex];
      let maxXP = xpThresholds[rankIndex + 1] || xp;
      const minXP = xpThresholds[rankIndex];

      const xpBar = document.getElementById('xp-bar');
      const rankNameLabel = document.querySelector('.rank-name');
      const xpTextLabel = document.querySelector('.xp-text');

      if (rankIndex >= rankNames.length - 1) {
          maxXP = xp;
          xpTextLabel.textContent = 'XP MAX';
      } else {
          xpTextLabel.textContent = `${xp - minXP}/${maxXP - minXP} XP until next rank`;
      }

      xpBar.max = maxXP - minXP;
      xpBar.value = xp - minXP;
      rankNameLabel.textContent = currentRank;

      const percentage = (xpBar.value / xpBar.max) * 100;
      const xpBarThumb = document.querySelector('progress[value]::after');
      if (xpBarThumb) {
          xpBarThumb.style.right = `${100 - percentage}%`;
      }
  }

  connectWalletButton.addEventListener('click', async () => {
    await connectWallet();
    const avatarData = await loadAvatarFromDatabase(account);
    if (avatarData) {
      updateAvatarDisplay(avatarData);
    }
    settingsButton.style.display = 'block';
  });
  
  restartButton.addEventListener('click', () => {
    modal.style.display = 'none';
    gameBoard.fill("");
    refreshGameBoard();
    menu.style.display = 'flex';
    document.querySelector('.board').style.display = 'none';
    statusMessage.style.display = 'none';
    gameId = null;
    updateGameList();
    document.querySelector('.xp-bar-container').style.display = 'block';
  });

  startButton.addEventListener('click', async () => {
    if (!socket.connected) {
      alert('Cannot connect to the game server. Please try again later.');
      return;
    }

    const betAmount = betAmountInput.value;
    if (!betAmount || betAmount <= 0) {
      alert("Please enter a valid bet amount.");
      return;
    }

    try {
      const result = await contract.methods.createGame().send({ from: account, value: web3.utils.toWei(betAmount, "ether") });
      gameId = result.events.GameCreated.returnValues.gameId.toString();
      socket.emit("message", JSON.stringify({ method: "start", account, gameId, betAmount }));
      updateGameList();
    } catch (error) {
      console.error("Failed to create game:", error);
    }
  });

  gameList.addEventListener('click', async (event) => {
    if (!socket.connected) {
      alert('Cannot connect to the game server. Please try again later.');
      return;
    }

    if (event.target.classList.contains('join-game-button')) {
      const selectedGameId = event.target.dataset.gameId;
      const betAmount = event.target.dataset.betAmount;

      try {
        const result = await contract.methods.joinGame(selectedGameId).send({ from: account, value: web3.utils.toWei(betAmount, "ether") });
        //console.log('Game joined:', result);
        gameId = selectedGameId;
        socket.emit("message", JSON.stringify({ method: "join", account, gameId, betAmount }));
        modalMessage.textContent = "Joining an existing game...";
        modal.style.display = 'flex';
        updateGameList();
      } catch (error) {
        console.error("Failed to join game:", error);
        alert("Failed to join game: " + error.message);
      }
    } else if (event.target.classList.contains('cancel-game-button')) {
      const gameId = event.target.dataset.gameId;
      try {
        const result = await contract.methods.cancelGame(gameId).send({ from: account });
        updateGameList();
      } catch (error) {
        console.error("Failed to cancel game:", error);
        alert("Failed to cancel game: " + error.message);
      }
    }
  });

  function listenForGameCreated() {
    contract.events.GameCreated({}, (error, event) => {
      if (error) {
        console.error("Error listening for GameCreated event:", error);
      } else {
        const { gameId, player1, betAmount } = event.returnValues;
        addGameToList(gameId.toString(), player1, web3.utils.fromWei(betAmount, "ether"));
      }
    });
  }

  async function updateGameList() {
    try {
      const activeGames = await contract.methods.getActiveGames().call();
      gameList.innerHTML = '';
      activeGames.forEach(game => {
        const { gameId, player1, player2, betAmount } = game;
        const betAmountDisplay = web3.utils.fromWei(betAmount, "ether");
        const isGameFull = player2 !== '0x0000000000000000000000000000000000000000';
        addGameToList(gameId, player1, betAmountDisplay, isGameFull);
      });
    } catch (error) {
      console.error("Failed to fetch active games:", error);
    }
  }

  function addGameToList(gameId, player1, betAmount, isGameFull) {
    const gameItem = document.createElement('div');
    gameItem.className = 'game-item';
    gameItem.dataset.gameId = gameId;

    let playersCount = isGameFull ? "2/2" : "1/2";
    gameItem.innerHTML = `
      <span>Game ID: ${gameId}</span>
      <span>Player: ${shortenAddress(player1)}</span>
      <span>Bet: ${betAmount} MATIC</span>
      <span>${playersCount}</span>`;

    if (isGameFull) {
      gameItem.innerHTML += `
        <button class="button join-game-button" data-game-id="${gameId}" data-bet-amount="${betAmount}" disabled>
          <span class="icon"></span>(Full)
        </button>`;
    } else {
      if (account.toLowerCase() === player1.toLowerCase()) {
        gameItem.innerHTML += `
          <button class="button cancel-game-button" data-game-id="${gameId}">
            <span class="icon"></span> Cancel Game
          </button>`;
      } else {
        gameItem.innerHTML += `
          <button class="button join-game-button" data-game-id="${gameId}" data-bet-amount="${betAmount}">
            <span class="icon"></span> Join Game
          </button>`;
      }
    }

    gameList.prepend(gameItem);
  }

  function shortenAddress(address) {
    return `${address.slice(0, 6)}...${address.slice(-4)}`;
  }

  function removeGameFromList(gameId) {
    const gameItems = gameList.querySelectorAll('.game-item');
    for (let i = 0; i < gameItems.length; i++) {
      const joinButton = gameItems[i].querySelector('.join-game-button');
      if (joinButton && joinButton.dataset.gameId === gameId) {
        gameList.removeChild(gameItems[i]);
        return;
      }
    }
  }
});
