// Generated from copas/contracts/abi/PerplExchange.json (subset used by the web app).
// Regenerate: see README > Perpl ABI.
export const perplExchangeAbi = [
 {
  "type": "function",
  "name": "getAccountByAddr",
  "inputs": [
   {
    "name": "accountAddress",
    "type": "address",
    "internalType": "address"
   }
  ],
  "outputs": [
   {
    "name": "accountInfo",
    "type": "tuple",
    "internalType": "struct AccountInfo",
    "components": [
     {
      "name": "accountId",
      "type": "uint256",
      "internalType": "uint256"
     },
     {
      "name": "balanceCNS",
      "type": "uint256",
      "internalType": "uint256"
     },
     {
      "name": "lockedBalanceCNS",
      "type": "uint256",
      "internalType": "uint256"
     },
     {
      "name": "frozen",
      "type": "uint8",
      "internalType": "enum FreezeStatusEnum"
     },
     {
      "name": "accountAddr",
      "type": "address",
      "internalType": "address"
     },
     {
      "name": "positions",
      "type": "tuple",
      "internalType": "struct PositionBitMap",
      "components": [
       {
        "name": "bank1",
        "type": "uint256",
        "internalType": "uint256"
       },
       {
        "name": "bank2",
        "type": "uint256",
        "internalType": "uint256"
       },
       {
        "name": "bank3",
        "type": "uint256",
        "internalType": "uint256"
       },
       {
        "name": "bank4",
        "type": "uint256",
        "internalType": "uint256"
       }
      ]
     }
    ]
   }
  ],
  "stateMutability": "view"
 },
 {
  "type": "function",
  "name": "getAccountById",
  "inputs": [
   {
    "name": "accountId",
    "type": "uint256",
    "internalType": "uint256"
   }
  ],
  "outputs": [
   {
    "name": "accountInfo",
    "type": "tuple",
    "internalType": "struct AccountInfo",
    "components": [
     {
      "name": "accountId",
      "type": "uint256",
      "internalType": "uint256"
     },
     {
      "name": "balanceCNS",
      "type": "uint256",
      "internalType": "uint256"
     },
     {
      "name": "lockedBalanceCNS",
      "type": "uint256",
      "internalType": "uint256"
     },
     {
      "name": "frozen",
      "type": "uint8",
      "internalType": "enum FreezeStatusEnum"
     },
     {
      "name": "accountAddr",
      "type": "address",
      "internalType": "address"
     },
     {
      "name": "positions",
      "type": "tuple",
      "internalType": "struct PositionBitMap",
      "components": [
       {
        "name": "bank1",
        "type": "uint256",
        "internalType": "uint256"
       },
       {
        "name": "bank2",
        "type": "uint256",
        "internalType": "uint256"
       },
       {
        "name": "bank3",
        "type": "uint256",
        "internalType": "uint256"
       },
       {
        "name": "bank4",
        "type": "uint256",
        "internalType": "uint256"
       }
      ]
     }
    ]
   }
  ],
  "stateMutability": "view"
 },
 {
  "type": "function",
  "name": "getExchangeInfo",
  "inputs": [],
  "outputs": [
   {
    "name": "balanceCNS",
    "type": "uint256",
    "internalType": "uint256"
   },
   {
    "name": "protocolBalanceCNS",
    "type": "uint256",
    "internalType": "uint256"
   },
   {
    "name": "recycleBalanceCNS",
    "type": "uint256",
    "internalType": "uint256"
   },
   {
    "name": "collateralDecimals",
    "type": "uint256",
    "internalType": "uint256"
   },
   {
    "name": "collateralToken",
    "type": "address",
    "internalType": "address"
   },
   {
    "name": "verifierProxy",
    "type": "address",
    "internalType": "address"
   }
  ],
  "stateMutability": "view"
 },
 {
  "type": "function",
  "name": "getMakerFee",
  "inputs": [
   {
    "name": "perpId",
    "type": "uint256",
    "internalType": "uint256"
   }
  ],
  "outputs": [
   {
    "name": "",
    "type": "uint256",
    "internalType": "uint256"
   }
  ],
  "stateMutability": "view"
 },
 {
  "type": "function",
  "name": "getMarginFractions",
  "inputs": [
   {
    "name": "perpId",
    "type": "uint256",
    "internalType": "uint256"
   },
   {
    "name": "lotLNS",
    "type": "uint256",
    "internalType": "uint256"
   }
  ],
  "outputs": [
   {
    "name": "perpInitMarginFracHdths",
    "type": "uint256",
    "internalType": "uint256"
   },
   {
    "name": "perpMaintMarginFracHdths",
    "type": "uint256",
    "internalType": "uint256"
   },
   {
    "name": "dynamicInitMarginFracHdths",
    "type": "uint256",
    "internalType": "uint256"
   },
   {
    "name": "oiMaxLNS",
    "type": "uint256",
    "internalType": "uint256"
   },
   {
    "name": "unityDescentThreshHdths",
    "type": "uint256",
    "internalType": "uint256"
   },
   {
    "name": "overColDescentThreshHdths",
    "type": "uint256",
    "internalType": "uint256"
   }
  ],
  "stateMutability": "view"
 },
 {
  "type": "function",
  "name": "getPerpetualInfo",
  "inputs": [
   {
    "name": "perpId",
    "type": "uint256",
    "internalType": "uint256"
   }
  ],
  "outputs": [
   {
    "name": "perpetualInfo",
    "type": "tuple",
    "internalType": "struct PerpetualInfo",
    "components": [
     {
      "name": "name",
      "type": "string",
      "internalType": "string"
     },
     {
      "name": "symbol",
      "type": "string",
      "internalType": "string"
     },
     {
      "name": "priceDecimals",
      "type": "uint256",
      "internalType": "uint256"
     },
     {
      "name": "lotDecimals",
      "type": "uint256",
      "internalType": "uint256"
     },
     {
      "name": "linkFeedId",
      "type": "bytes32",
      "internalType": "bytes32"
     },
     {
      "name": "priceTolPer100K",
      "type": "uint256",
      "internalType": "uint256"
     },
     {
      "name": "marginTol",
      "type": "uint256",
      "internalType": "uint256"
     },
     {
      "name": "marginTolDecimals",
      "type": "uint256",
      "internalType": "uint256"
     },
     {
      "name": "refPriceMaxAgeSec",
      "type": "uint256",
      "internalType": "uint256"
     },
     {
      "name": "positionBalanceCNS",
      "type": "uint256",
      "internalType": "uint256"
     },
     {
      "name": "insuranceBalanceCNS",
      "type": "uint256",
      "internalType": "uint256"
     },
     {
      "name": "markPNS",
      "type": "uint256",
      "internalType": "uint256"
     },
     {
      "name": "markTimestamp",
      "type": "uint256",
      "internalType": "uint256"
     },
     {
      "name": "lastPNS",
      "type": "uint256",
      "internalType": "uint256"
     },
     {
      "name": "lastTimestamp",
      "type": "uint256",
      "internalType": "uint256"
     },
     {
      "name": "oraclePNS",
      "type": "uint256",
      "internalType": "uint256"
     },
     {
      "name": "oracleTimestampSec",
      "type": "uint256",
      "internalType": "uint256"
     },
     {
      "name": "longOpenInterestLNS",
      "type": "uint256",
      "internalType": "uint256"
     },
     {
      "name": "shortOpenInterestLNS",
      "type": "uint256",
      "internalType": "uint256"
     },
     {
      "name": "fundingStartBlock",
      "type": "uint256",
      "internalType": "uint256"
     },
     {
      "name": "fundingRatePct100k",
      "type": "int16",
      "internalType": "int16"
     },
     {
      "name": "absFundingClampPctPer100K",
      "type": "uint256",
      "internalType": "uint256"
     },
     {
      "name": "status",
      "type": "uint8",
      "internalType": "enum PerpStatusEnum"
     },
     {
      "name": "basePricePNS",
      "type": "uint256",
      "internalType": "uint256"
     },
     {
      "name": "maxBidPriceONS",
      "type": "uint256",
      "internalType": "uint256"
     },
     {
      "name": "minBidPriceONS",
      "type": "uint256",
      "internalType": "uint256"
     },
     {
      "name": "maxAskPriceONS",
      "type": "uint256",
      "internalType": "uint256"
     },
     {
      "name": "minAskPriceONS",
      "type": "uint256",
      "internalType": "uint256"
     },
     {
      "name": "numOrders",
      "type": "uint256",
      "internalType": "uint256"
     },
     {
      "name": "ignOracle",
      "type": "bool",
      "internalType": "bool"
     }
    ]
   }
  ],
  "stateMutability": "view"
 },
 {
  "type": "function",
  "name": "getPosition",
  "inputs": [
   {
    "name": "perpId",
    "type": "uint256",
    "internalType": "uint256"
   },
   {
    "name": "accountId",
    "type": "uint256",
    "internalType": "uint256"
   }
  ],
  "outputs": [
   {
    "name": "positionInfo",
    "type": "tuple",
    "internalType": "struct PositionInfo",
    "components": [
     {
      "name": "accountId",
      "type": "uint256",
      "internalType": "uint256"
     },
     {
      "name": "nextNodeId",
      "type": "uint256",
      "internalType": "uint256"
     },
     {
      "name": "prevNodeId",
      "type": "uint256",
      "internalType": "uint256"
     },
     {
      "name": "positionType",
      "type": "uint8",
      "internalType": "enum PositionEnum"
     },
     {
      "name": "depositCNS",
      "type": "uint256",
      "internalType": "uint256"
     },
     {
      "name": "pricePNS",
      "type": "uint256",
      "internalType": "uint256"
     },
     {
      "name": "lotLNS",
      "type": "uint256",
      "internalType": "uint256"
     },
     {
      "name": "entryBlock",
      "type": "uint256",
      "internalType": "uint256"
     },
     {
      "name": "pnlCNS",
      "type": "int256",
      "internalType": "int256"
     },
     {
      "name": "deltaPnlCNS",
      "type": "int256",
      "internalType": "int256"
     },
     {
      "name": "premiumPnlCNS",
      "type": "int256",
      "internalType": "int256"
     }
    ]
   },
   {
    "name": "markPricePNS",
    "type": "uint256",
    "internalType": "uint256"
   },
   {
    "name": "markPriceValid",
    "type": "bool",
    "internalType": "bool"
   }
  ],
  "stateMutability": "view"
 },
 {
  "type": "function",
  "name": "getPositionIds",
  "inputs": [
   {
    "name": "perpId",
    "type": "uint256",
    "internalType": "uint256"
   }
  ],
  "outputs": [
   {
    "name": "startNodeId",
    "type": "uint256",
    "internalType": "uint256"
   },
   {
    "name": "endNodeId",
    "type": "uint256",
    "internalType": "uint256"
   }
  ],
  "stateMutability": "view"
 },
 {
  "type": "function",
  "name": "getPositions",
  "inputs": [
   {
    "name": "perpId",
    "type": "uint256",
    "internalType": "uint256"
   },
   {
    "name": "pageStartPositionId",
    "type": "uint256",
    "internalType": "uint256"
   },
   {
    "name": "positionsPerPage",
    "type": "uint256",
    "internalType": "uint256"
   }
  ],
  "outputs": [
   {
    "name": "positions",
    "type": "tuple[]",
    "internalType": "struct PositionInfo[]",
    "components": [
     {
      "name": "accountId",
      "type": "uint256",
      "internalType": "uint256"
     },
     {
      "name": "nextNodeId",
      "type": "uint256",
      "internalType": "uint256"
     },
     {
      "name": "prevNodeId",
      "type": "uint256",
      "internalType": "uint256"
     },
     {
      "name": "positionType",
      "type": "uint8",
      "internalType": "enum PositionEnum"
     },
     {
      "name": "depositCNS",
      "type": "uint256",
      "internalType": "uint256"
     },
     {
      "name": "pricePNS",
      "type": "uint256",
      "internalType": "uint256"
     },
     {
      "name": "lotLNS",
      "type": "uint256",
      "internalType": "uint256"
     },
     {
      "name": "entryBlock",
      "type": "uint256",
      "internalType": "uint256"
     },
     {
      "name": "pnlCNS",
      "type": "int256",
      "internalType": "int256"
     },
     {
      "name": "deltaPnlCNS",
      "type": "int256",
      "internalType": "int256"
     },
     {
      "name": "premiumPnlCNS",
      "type": "int256",
      "internalType": "int256"
     }
    ]
   },
   {
    "name": "numPositions",
    "type": "uint256",
    "internalType": "uint256"
   },
   {
    "name": "markPricePNS",
    "type": "uint256",
    "internalType": "uint256"
   },
   {
    "name": "markPriceValid",
    "type": "bool",
    "internalType": "bool"
   }
  ],
  "stateMutability": "view"
 },
 {
  "type": "function",
  "name": "getTakerFee",
  "inputs": [
   {
    "name": "perpId",
    "type": "uint256",
    "internalType": "uint256"
   }
  ],
  "outputs": [
   {
    "name": "",
    "type": "uint256",
    "internalType": "uint256"
   }
  ],
  "stateMutability": "view"
 },
 {
  "type": "function",
  "name": "numberOfAccounts",
  "inputs": [],
  "outputs": [
   {
    "name": "numAccounts",
    "type": "uint256",
    "internalType": "uint256"
   }
  ],
  "stateMutability": "view"
 },
 {
  "type": "event",
  "name": "AccountCreated",
  "inputs": [
   {
    "name": "account",
    "type": "address",
    "indexed": false,
    "internalType": "address"
   },
   {
    "name": "id",
    "type": "uint256",
    "indexed": false,
    "internalType": "uint256"
   }
  ],
  "anonymous": false
 },
 {
  "type": "event",
  "name": "CollateralDeposit",
  "inputs": [
   {
    "name": "accountId",
    "type": "uint256",
    "indexed": false,
    "internalType": "uint256"
   },
   {
    "name": "amountCNS",
    "type": "uint256",
    "indexed": false,
    "internalType": "uint256"
   },
   {
    "name": "balanceCNS",
    "type": "uint256",
    "indexed": false,
    "internalType": "uint256"
   }
  ],
  "anonymous": false
 },
 {
  "type": "event",
  "name": "CollateralWithdrawal",
  "inputs": [
   {
    "name": "accountId",
    "type": "uint256",
    "indexed": false,
    "internalType": "uint256"
   },
   {
    "name": "amountCNS",
    "type": "uint256",
    "indexed": false,
    "internalType": "uint256"
   },
   {
    "name": "balanceCNS",
    "type": "uint256",
    "indexed": false,
    "internalType": "uint256"
   }
  ],
  "anonymous": false
 },
 {
  "type": "event",
  "name": "MakerOrderFilledV2",
  "inputs": [
   {
    "name": "perpId",
    "type": "uint256",
    "indexed": false,
    "internalType": "uint256"
   },
   {
    "name": "accountId",
    "type": "uint256",
    "indexed": false,
    "internalType": "uint256"
   },
   {
    "name": "orderId",
    "type": "uint256",
    "indexed": false,
    "internalType": "uint256"
   },
   {
    "name": "pricePNS",
    "type": "uint256",
    "indexed": false,
    "internalType": "uint256"
   },
   {
    "name": "lotLNS",
    "type": "uint256",
    "indexed": false,
    "internalType": "uint256"
   },
   {
    "name": "feeCNS",
    "type": "uint256",
    "indexed": false,
    "internalType": "uint256"
   },
   {
    "name": "lockedBalanceCNS",
    "type": "uint256",
    "indexed": false,
    "internalType": "uint256"
   },
   {
    "name": "amountCNS",
    "type": "int256",
    "indexed": false,
    "internalType": "int256"
   },
   {
    "name": "balanceCNS",
    "type": "uint256",
    "indexed": false,
    "internalType": "uint256"
   },
   {
    "name": "builderId",
    "type": "uint256",
    "indexed": false,
    "internalType": "uint256"
   },
   {
    "name": "builderFeeCNS",
    "type": "uint256",
    "indexed": false,
    "internalType": "uint256"
   }
  ],
  "anonymous": false
 },
 {
  "type": "event",
  "name": "PositionClosed",
  "inputs": [
   {
    "name": "perpId",
    "type": "uint256",
    "indexed": false,
    "internalType": "uint256"
   },
   {
    "name": "accountId",
    "type": "uint256",
    "indexed": false,
    "internalType": "uint256"
   },
   {
    "name": "positionType",
    "type": "uint8",
    "indexed": false,
    "internalType": "enum PositionEnum"
   },
   {
    "name": "pricePNS",
    "type": "uint256",
    "indexed": false,
    "internalType": "uint256"
   },
   {
    "name": "deltaPnlCNS",
    "type": "int256",
    "indexed": false,
    "internalType": "int256"
   },
   {
    "name": "fundingCNS",
    "type": "int256",
    "indexed": false,
    "internalType": "int256"
   }
  ],
  "anonymous": false
 },
 {
  "type": "event",
  "name": "PositionDecreased",
  "inputs": [
   {
    "name": "perpId",
    "type": "uint256",
    "indexed": false,
    "internalType": "uint256"
   },
   {
    "name": "accountId",
    "type": "uint256",
    "indexed": false,
    "internalType": "uint256"
   },
   {
    "name": "positionType",
    "type": "uint8",
    "indexed": false,
    "internalType": "enum PositionEnum"
   },
   {
    "name": "startDepositCNS",
    "type": "uint256",
    "indexed": false,
    "internalType": "uint256"
   },
   {
    "name": "endDepositCNS",
    "type": "uint256",
    "indexed": false,
    "internalType": "uint256"
   },
   {
    "name": "startLotLNS",
    "type": "uint256",
    "indexed": false,
    "internalType": "uint256"
   },
   {
    "name": "endLotLNS",
    "type": "uint256",
    "indexed": false,
    "internalType": "uint256"
   },
   {
    "name": "deltaPnlCNS",
    "type": "int256",
    "indexed": false,
    "internalType": "int256"
   },
   {
    "name": "fundingCNS",
    "type": "int256",
    "indexed": false,
    "internalType": "int256"
   }
  ],
  "anonymous": false
 },
 {
  "type": "event",
  "name": "PositionDeleveragedV2",
  "inputs": [
   {
    "name": "perpId",
    "type": "uint256",
    "indexed": false,
    "internalType": "uint256"
   },
   {
    "name": "accountId",
    "type": "uint256",
    "indexed": false,
    "internalType": "uint256"
   },
   {
    "name": "forceClose",
    "type": "bool",
    "indexed": false,
    "internalType": "bool"
   },
   {
    "name": "positionType",
    "type": "uint8",
    "indexed": false,
    "internalType": "enum PositionEnum"
   },
   {
    "name": "entryPricePNS",
    "type": "uint256",
    "indexed": false,
    "internalType": "uint256"
   },
   {
    "name": "markPricePNS",
    "type": "uint256",
    "indexed": false,
    "internalType": "uint256"
   },
   {
    "name": "deleveragePricePNS",
    "type": "uint256",
    "indexed": false,
    "internalType": "uint256"
   },
   {
    "name": "deltaPnlCNS",
    "type": "int256",
    "indexed": false,
    "internalType": "int256"
   },
   {
    "name": "fundingCNS",
    "type": "int256",
    "indexed": false,
    "internalType": "int256"
   },
   {
    "name": "startDepositCNS",
    "type": "uint256",
    "indexed": false,
    "internalType": "uint256"
   },
   {
    "name": "endDepositCNS",
    "type": "uint256",
    "indexed": false,
    "internalType": "uint256"
   },
   {
    "name": "startLotLNS",
    "type": "uint256",
    "indexed": false,
    "internalType": "uint256"
   },
   {
    "name": "endLotLNS",
    "type": "uint256",
    "indexed": false,
    "internalType": "uint256"
   },
   {
    "name": "amountCNS",
    "type": "uint256",
    "indexed": false,
    "internalType": "uint256"
   },
   {
    "name": "balanceCNS",
    "type": "uint256",
    "indexed": false,
    "internalType": "uint256"
   },
   {
    "name": "priceResiduePNSQ16",
    "type": "uint256",
    "indexed": false,
    "internalType": "uint256"
   }
  ],
  "anonymous": false
 },
 {
  "type": "event",
  "name": "PositionIncreased",
  "inputs": [
   {
    "name": "perpId",
    "type": "uint256",
    "indexed": false,
    "internalType": "uint256"
   },
   {
    "name": "accountId",
    "type": "uint256",
    "indexed": false,
    "internalType": "uint256"
   },
   {
    "name": "positionType",
    "type": "uint8",
    "indexed": false,
    "internalType": "enum PositionEnum"
   },
   {
    "name": "leverageHdths",
    "type": "uint256",
    "indexed": false,
    "internalType": "uint256"
   },
   {
    "name": "startDepositCNS",
    "type": "uint256",
    "indexed": false,
    "internalType": "uint256"
   },
   {
    "name": "endDepositCNS",
    "type": "uint256",
    "indexed": false,
    "internalType": "uint256"
   },
   {
    "name": "pnlCollateralizedCNS",
    "type": "int256",
    "indexed": false,
    "internalType": "int256"
   },
   {
    "name": "premiumPnlSettledCNS",
    "type": "int256",
    "indexed": false,
    "internalType": "int256"
   },
   {
    "name": "maxNegPnlCollatBPS",
    "type": "uint256",
    "indexed": false,
    "internalType": "uint256"
   },
   {
    "name": "pricePNS",
    "type": "uint256",
    "indexed": false,
    "internalType": "uint256"
   },
   {
    "name": "startLotLNS",
    "type": "uint256",
    "indexed": false,
    "internalType": "uint256"
   },
   {
    "name": "endLotLNS",
    "type": "uint256",
    "indexed": false,
    "internalType": "uint256"
   },
   {
    "name": "insFeeCNS",
    "type": "uint256",
    "indexed": false,
    "internalType": "uint256"
   },
   {
    "name": "protFeeCNS",
    "type": "uint256",
    "indexed": false,
    "internalType": "uint256"
   }
  ],
  "anonymous": false
 },
 {
  "type": "event",
  "name": "PositionIncreasedV2",
  "inputs": [
   {
    "name": "perpId",
    "type": "uint256",
    "indexed": false,
    "internalType": "uint256"
   },
   {
    "name": "accountId",
    "type": "uint256",
    "indexed": false,
    "internalType": "uint256"
   },
   {
    "name": "positionType",
    "type": "uint8",
    "indexed": false,
    "internalType": "enum PositionEnum"
   },
   {
    "name": "leverageHdths",
    "type": "uint256",
    "indexed": false,
    "internalType": "uint256"
   },
   {
    "name": "startDepositCNS",
    "type": "uint256",
    "indexed": false,
    "internalType": "uint256"
   },
   {
    "name": "endDepositCNS",
    "type": "uint256",
    "indexed": false,
    "internalType": "uint256"
   },
   {
    "name": "pnlCollateralizedCNS",
    "type": "int256",
    "indexed": false,
    "internalType": "int256"
   },
   {
    "name": "premiumPnlSettledCNS",
    "type": "int256",
    "indexed": false,
    "internalType": "int256"
   },
   {
    "name": "maxNegPnlCollatBPS",
    "type": "uint256",
    "indexed": false,
    "internalType": "uint256"
   },
   {
    "name": "pricePNS",
    "type": "uint256",
    "indexed": false,
    "internalType": "uint256"
   },
   {
    "name": "startLotLNS",
    "type": "uint256",
    "indexed": false,
    "internalType": "uint256"
   },
   {
    "name": "endLotLNS",
    "type": "uint256",
    "indexed": false,
    "internalType": "uint256"
   },
   {
    "name": "insFeeCNS",
    "type": "uint256",
    "indexed": false,
    "internalType": "uint256"
   },
   {
    "name": "protFeeCNS",
    "type": "uint256",
    "indexed": false,
    "internalType": "uint256"
   },
   {
    "name": "priceResiduePNSQ16",
    "type": "uint256",
    "indexed": false,
    "internalType": "uint256"
   }
  ],
  "anonymous": false
 },
 {
  "type": "event",
  "name": "PositionLiquidated",
  "inputs": [
   {
    "name": "perpId",
    "type": "uint256",
    "indexed": false,
    "internalType": "uint256"
   },
   {
    "name": "posAccountId",
    "type": "uint256",
    "indexed": false,
    "internalType": "uint256"
   },
   {
    "name": "positionType",
    "type": "uint8",
    "indexed": false,
    "internalType": "enum PositionEnum"
   },
   {
    "name": "markPricePNS",
    "type": "uint256",
    "indexed": false,
    "internalType": "uint256"
   },
   {
    "name": "liqPricePNS",
    "type": "uint256",
    "indexed": false,
    "internalType": "uint256"
   },
   {
    "name": "liqLotLNS",
    "type": "uint256",
    "indexed": false,
    "internalType": "uint256"
   },
   {
    "name": "posLotLNS",
    "type": "uint256",
    "indexed": false,
    "internalType": "uint256"
   },
   {
    "name": "deltaPnlCNS",
    "type": "int256",
    "indexed": false,
    "internalType": "int256"
   },
   {
    "name": "fundingCNS",
    "type": "int256",
    "indexed": false,
    "internalType": "int256"
   },
   {
    "name": "posAmountCNS",
    "type": "int256",
    "indexed": false,
    "internalType": "int256"
   },
   {
    "name": "posDepositCNS",
    "type": "uint256",
    "indexed": false,
    "internalType": "uint256"
   },
   {
    "name": "accAmountCNS",
    "type": "int256",
    "indexed": false,
    "internalType": "int256"
   },
   {
    "name": "accBalanceCNS",
    "type": "uint256",
    "indexed": false,
    "internalType": "uint256"
   },
   {
    "name": "onOrderBook",
    "type": "bool",
    "indexed": false,
    "internalType": "bool"
   }
  ],
  "anonymous": false
 },
 {
  "type": "event",
  "name": "PositionOpened",
  "inputs": [
   {
    "name": "perpId",
    "type": "uint256",
    "indexed": false,
    "internalType": "uint256"
   },
   {
    "name": "accountId",
    "type": "uint256",
    "indexed": false,
    "internalType": "uint256"
   },
   {
    "name": "positionType",
    "type": "uint8",
    "indexed": false,
    "internalType": "enum PositionEnum"
   },
   {
    "name": "leverageHdths",
    "type": "uint256",
    "indexed": false,
    "internalType": "uint256"
   },
   {
    "name": "depositCNS",
    "type": "uint256",
    "indexed": false,
    "internalType": "uint256"
   },
   {
    "name": "pnlCollateralizedCNS",
    "type": "int256",
    "indexed": false,
    "internalType": "int256"
   },
   {
    "name": "pricePNS",
    "type": "uint256",
    "indexed": false,
    "internalType": "uint256"
   },
   {
    "name": "lotLNS",
    "type": "uint256",
    "indexed": false,
    "internalType": "uint256"
   },
   {
    "name": "insFeeCNS",
    "type": "uint256",
    "indexed": false,
    "internalType": "uint256"
   },
   {
    "name": "protFeeCNS",
    "type": "uint256",
    "indexed": false,
    "internalType": "uint256"
   }
  ],
  "anonymous": false
 },
 {
  "type": "event",
  "name": "PositionOpenedV2",
  "inputs": [
   {
    "name": "perpId",
    "type": "uint256",
    "indexed": false,
    "internalType": "uint256"
   },
   {
    "name": "accountId",
    "type": "uint256",
    "indexed": false,
    "internalType": "uint256"
   },
   {
    "name": "positionType",
    "type": "uint8",
    "indexed": false,
    "internalType": "enum PositionEnum"
   },
   {
    "name": "leverageHdths",
    "type": "uint256",
    "indexed": false,
    "internalType": "uint256"
   },
   {
    "name": "depositCNS",
    "type": "uint256",
    "indexed": false,
    "internalType": "uint256"
   },
   {
    "name": "pnlCollateralizedCNS",
    "type": "int256",
    "indexed": false,
    "internalType": "int256"
   },
   {
    "name": "pricePNS",
    "type": "uint256",
    "indexed": false,
    "internalType": "uint256"
   },
   {
    "name": "lotLNS",
    "type": "uint256",
    "indexed": false,
    "internalType": "uint256"
   },
   {
    "name": "insFeeCNS",
    "type": "uint256",
    "indexed": false,
    "internalType": "uint256"
   },
   {
    "name": "protFeeCNS",
    "type": "uint256",
    "indexed": false,
    "internalType": "uint256"
   },
   {
    "name": "priceResiduePNSQ16",
    "type": "uint256",
    "indexed": false,
    "internalType": "uint256"
   }
  ],
  "anonymous": false
 },
 {
  "type": "event",
  "name": "TakerOrderFilledV2",
  "inputs": [
   {
    "name": "entryPricePNS",
    "type": "uint256",
    "indexed": false,
    "internalType": "uint256"
   },
   {
    "name": "collatPricePNS",
    "type": "uint256",
    "indexed": false,
    "internalType": "uint256"
   },
   {
    "name": "pnlPricePNS",
    "type": "uint256",
    "indexed": false,
    "internalType": "uint256"
   },
   {
    "name": "lotLNS",
    "type": "uint256",
    "indexed": false,
    "internalType": "uint256"
   },
   {
    "name": "feeCNS",
    "type": "uint256",
    "indexed": false,
    "internalType": "uint256"
   },
   {
    "name": "amountCNS",
    "type": "int256",
    "indexed": false,
    "internalType": "int256"
   },
   {
    "name": "balanceCNS",
    "type": "uint256",
    "indexed": false,
    "internalType": "uint256"
   },
   {
    "name": "builderId",
    "type": "uint256",
    "indexed": false,
    "internalType": "uint256"
   },
   {
    "name": "builderFeeCNS",
    "type": "uint256",
    "indexed": false,
    "internalType": "uint256"
   }
  ],
  "anonymous": false
 }
] as const;
