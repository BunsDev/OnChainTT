require("@nomicfoundation/hardhat-verify");
require("@nomiclabs/hardhat-ethers");
const fs = require('fs');

// Read the config.json file
const config = JSON.parse(fs.readFileSync('config.json', 'utf8'));

module.exports = {
  solidity: "0.8.19",
  settings: {
    enable: true,
    runs: 200
  },
  networks: {
    polygonAmoy: {
      url: config.rpcUrl,
      accounts: [config.privateKey],
    },
  },
  etherscan: {
    apiKey: {
      polygonAmoy: config.etherscanApiKey,
    },
  },
};
