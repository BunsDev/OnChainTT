// ai.js
function bestMove(gameBoard, playerSymbol) {
    let availableMoves = [];
    gameBoard.forEach((cell, index) => {
        if (cell === "") {
        availableMoves.push(index);
        }
    });

    const move = availableMoves[Math.floor(Math.random() * availableMoves.length)];
    return move; // Возвращает индекс для хода
}

export { bestMove };
