const hre = require("hardhat");
const { ethers, run } = hre;

async function main() {
    console.log("Starting deployment...");

    const admin1 = "0x5CEe0e6D261dA886aa4F02FB47f45E1E9fa4991b";
    const admin2 = "0xA1424c75B7899d49dE57eEF73EabF0e85e093D44";
    const router = "0xC22a79eBA640940ABB6dF0f7982cc119578E11De";
    const donID = "0x66756e2d706f6c79676f6e2d616d6f792d310000000000000000000000000000";

    const OnChainTTT = await ethers.getContractFactory("OnChainTTT");
    console.log("Deploying OnChainTTT...");
    const onChainTTT = await OnChainTTT.deploy(router, admin1, admin2, donID);

    await onChainTTT.deployed();

    console.log("OnChainTTT deployed to:", onChainTTT.address);
    console.log("Deploy transaction hash:", onChainTTT.deployTransaction.hash);

    await onChainTTT.deployTransaction.wait(5);

    console.log("Verifying contract...");
    await run("verify:verify", {
        address: onChainTTT.address,
        constructorArguments: [router, admin1, admin2, donID],
    });

    console.log("Contract verified successfully.");
}

main()
    .then(() => process.exit(0))
    .catch(error => {
        console.error("Error during deployment:", error);
        process.exit(1);
    });
