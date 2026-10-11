// Kuru V1 order book helpers (ABI fragments from @kuru-labs/kuru-sdk 0.0.95 abi/{Router,OrderBook,MarginAccount}.json).
// Mainnet V1 deployProxy is owner-only (Safe multisig, reverts Unauthorized()); testnet V1 router is permissionless.
import { encodeFunctionData, parseAbi, parseUnits, type Address, type Hex } from 'viem';

export const routerAbi = parseAbi([
  'function deployProxy(uint8 _type, address _baseAssetAddress, address _quoteAssetAddress, uint96 _sizePrecision, uint32 _pricePrecision, uint32 _tickSize, uint96 _minSize, uint96 _maxSize, uint256 _takerFeeBps, uint256 _makerFeeBps, uint96 _kuruAmmSpread) returns (address)',
  'function marginAccountAddress() view returns (address)',
  'function owner() view returns (address)',
  'event MarketRegistered(address baseAsset, address quoteAsset, address market, address vaultAddress, uint32 pricePrecision, uint96 sizePrecision, uint32 tickSize, uint96 minSize, uint96 maxSize, uint256 takerFeeBps, uint256 makerFeeBps, uint96 kuruAmmSpread)',
]);

export const orderBookAbi = parseAbi([
  'function getMarketParams() view returns (uint32 pricePrecision, uint96 sizePrecision, address baseAsset, uint256 baseDecimals, address quoteAsset, uint256 quoteDecimals, uint32 tickSize, uint96 minSize, uint96 maxSize, uint256 takerFeeBps, uint256 makerFeeBps)',
  'function bestBidAsk() view returns (uint256, uint256)',
  'function addBuyOrder(uint32 _price, uint96 size, bool _postOnly)',
  'function addSellOrder(uint32 _price, uint96 size, bool _postOnly)',
  'function placeAndExecuteMarketBuy(uint96 _quoteSize, uint256 _minAmountOut, bool _isMargin, bool _isFillOrKill) payable returns (uint256)',
  'function placeAndExecuteMarketSell(uint96 _size, uint256 _minAmountOut, bool _isMargin, bool _isFillOrKill) payable returns (uint256)',
]);

export const marginAccountAbi = parseAbi([
  'function deposit(address _user, address _token, uint256 _amount) payable',
  'function withdraw(uint256 _amount, address _token)',
  'function getBalance(address _user, address _token) view returns (uint256)',
]);

/**
 * Defaults for a DOWN/AUSD book (both 6 decimals, price in [0, 1] AUSD).
 * price precision 1e4, size precision 1e2: price*size/(1e4*1e2) * 1e6 stays an integer number of AUSD units.
 */
export const DOWN_MARKET_DEFAULTS = {
  type: 0, // NO_NATIVE
  sizePrecision: 100n,
  pricePrecision: 10_000,
  tickSize: 10, // 0.001 AUSD
  minSize: 100n, // 1 DOWN
  maxSize: 10n ** 12n,
  takerFeeBps: 30n,
  makerFeeBps: 10n,
  kuruAmmSpread: 100n,
};

export function deployProxyArgs(base: Address, quote: Address, p = DOWN_MARKET_DEFAULTS) {
  return [
    p.type,
    base,
    quote,
    p.sizePrecision,
    p.pricePrecision,
    p.tickSize,
    p.minSize,
    p.maxSize,
    p.takerFeeBps,
    p.makerFeeBps,
    p.kuruAmmSpread,
  ] as const;
}

export type MarketParams = { pricePrecision: number; sizePrecision: bigint };
const decimalsOf = (precision: bigint | number) => String(precision).length - 1; // 10^n -> n

/** Limit order. Funds come from the Kuru MarginAccount (deposit first). price in AUSD, size in DOWN. */
export function limitOrderData(m: MarketParams, side: 'buy' | 'sell', price: string, size: string, postOnly = true): Hex {
  const p = Number(parseUnits(price, decimalsOf(m.pricePrecision)));
  const s = parseUnits(size, decimalsOf(m.sizePrecision));
  return encodeFunctionData({
    abi: orderBookAbi,
    functionName: side === 'buy' ? 'addBuyOrder' : 'addSellOrder',
    args: [p, s, postOnly],
  });
}

/**
 * Market (IOC) order from the wallet (isMargin=false; approve the order book first).
 * buy: `amount` is AUSD to spend; sell: `amount` is DOWN to sell. minOut in atomic units of the received token.
 */
export function marketOrderData(m: MarketParams, side: 'buy' | 'sell', amount: string, minOut = 0n): Hex {
  return side === 'buy'
    ? encodeFunctionData({
        abi: orderBookAbi,
        functionName: 'placeAndExecuteMarketBuy',
        args: [parseUnits(amount, decimalsOf(m.pricePrecision)), minOut, false, false],
      })
    : encodeFunctionData({
        abi: orderBookAbi,
        functionName: 'placeAndExecuteMarketSell',
        args: [parseUnits(amount, decimalsOf(m.sizePrecision)), minOut, false, false],
      });
}
