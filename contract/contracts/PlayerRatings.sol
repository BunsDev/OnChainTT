// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

library PlayerRatings {
    struct Player {
        uint256 xp;
        uint8 rankIndex;
    }

    event RankUpdated(address indexed player, string newRank);

    function updateXP(Player storage player, bool won) internal {
        player.xp += won ? 50 : 10;
    }

    function updateRank(Player storage player, address playerAddress) internal {
        uint256[] memory xpThresholds = new uint256[](6);
        xpThresholds[0] = 0;
        xpThresholds[1] = 100;
        xpThresholds[2] = 250;
        xpThresholds[3] = 500;
        xpThresholds[4] = 1000;
        xpThresholds[5] = 2000;

        uint8 newRankIndex = player.rankIndex;
        for (uint8 i = player.rankIndex; i < xpThresholds.length; i++) {
            if (player.xp >= xpThresholds[i]) {
                newRankIndex = i;
            } else {
                break;
            }
        }

        if (newRankIndex != player.rankIndex) {
            player.rankIndex = newRankIndex;
            emit RankUpdated(playerAddress, getRankName(newRankIndex));
        }
    }

    function getRankName(uint8 rankIndex) internal pure returns (string memory) {
        string[6] memory rankNames = ["Beginner", "Novice", "Competent", "Proficient", "Expert", "Master"];
        return rankNames[rankIndex];
    }
}
