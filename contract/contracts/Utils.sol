// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

library Utils {
    function parseAddress(string memory addr) internal pure returns (address) {
        bytes memory addrBytes = bytes(addr);
        require(addrBytes.length >= 42, "Address too short");
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

        return address(result);
    }

    function uint2str(uint _i) internal pure returns (string memory) {
        if (_i == 0) {
            return "0";
        }
        uint j = _i;
        uint len = 0;
        while (j != 0) {
            len++;
            j /= 10;
        }
        bytes memory bstr = new bytes(len);
        uint k = len;
        while (_i != 0) {
            k--;
            uint8 temp = (48 + uint8(_i % 10));
            bstr[k] = bytes1(temp);
            _i /= 10;
        }
        return string(bstr);
    }
}
