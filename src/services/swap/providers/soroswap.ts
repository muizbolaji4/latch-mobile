import { Operation, TransactionBuilder, xdr } from '@stellar/stellar-sdk';

import {
  SOROSWAP_API_KEY,
  SOROSWAP_API_URL,
  SOROSWAP_NETWORK,
  STELLAR_NETWORK_PASSPHRASE,
} from '@/src/constants/config';
import { toBaseUnits } from '@/src/services/send-token';
import type { SwapBuildResult, SwapProvider, SwapQuote, SwapQuoteParams } from '../types';

// Protocols the aggregator routes across. SDEX is the classic Stellar order
// book; the rest are Soroban AMMs.
//
// 'aqua' is deliberately excluded: verified live against mainnet that for
// XLM/USDC it routes through a specific thin pool
// (CCCRWH6Q3FNP3I2I57BDLM5AFAT7O6OF6GKQOC6SSJNDAVRZ57SPHGU2) that returns
// amountOut multiple times the real market value (e.g. 5 XLM ≈ $0.86 priced
// out at $3-7+ of USDC). soroswap, phoenix, and sdex all independently agree
// on the correct price for the same trade — only aqua's pool is broken, and
// the aggregator keeps picking it because it looks like the best price.
const PROTOCOLS = ['soroswap', 'phoenix', 'sdex'];

// A multi-hop `platform: 'aggregator'` route can return poolHashes that the
// /quote/build endpoint rejects with 400 "Invalid poolHashes string". When that
// happens we re-quote against a single AMM, which builds cleanly. The fallback
// route is built from its OWN fresh quote, so its on-chain amountOutMin (the
// slippage guard) is correct for the route actually executed.
const FALLBACK_PROTOCOLS = ['soroswap'];

// Convert SAC base units (7 decimals, integer string) → human-readable string.
// String arithmetic avoids float precision loss on large i128 amounts.
function fromBaseUnits(base: string): string {
  const neg = base.startsWith('-');
  const digits = (neg ? base.slice(1) : base).padStart(8, '0');
  const intPart = digits.slice(0, -7).replace(/^0+(?=\d)/, '');
  const fracPart = digits.slice(-7).replace(/0+$/, '');
  const out = fracPart ? `${intPart}.${fracPart}` : intPart;
  return neg ? `-${out}` : out;
}

async function soroswapPost(path: string, body: object): Promise<any> {
  const url = `${SOROSWAP_API_URL}${path}?network=${SOROSWAP_NETWORK}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      Authorization: `Bearer ${SOROSWAP_API_KEY}`,
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Soroswap ${path} ${res.status}: ${text || res.statusText}`);
  }
  return res.json();
}

// Raw /quote response for a pair + protocol set. The object is passed back to
// /quote/build verbatim, so it is treated as opaque (stored on SwapQuote.raw).
function fetchRawQuote(params: SwapQuoteParams, protocols: string[]): Promise<any> {
  return soroswapPost('/quote', {
    assetIn: params.fromSacId,
    assetOut: params.toSacId,
    // i128 base units serialized as a string (JSON has no bigint).
    amount: toBaseUnits(params.amountIn).toString(),
    tradeType: 'EXACT_IN',
    protocols,
    slippageBps: params.slippageBps,
  });
}

// Map a raw /quote response to a SwapQuote against the originating params.
function mapQuote(rawQuote: any, params: SwapQuoteParams): SwapQuote {
  const amountOut = fromBaseUnits(String(rawQuote.amountOut ?? '0'));
  const minReceived = fromBaseUnits(String(rawQuote.otherAmountThreshold ?? '0'));
  const inNum = parseFloat(params.amountIn);
  return {
    providerId: 'soroswap',
    amountIn: params.amountIn,
    amountOut,
    minReceived,
    rate: inNum > 0 ? parseFloat(amountOut) / inNum : 0,
    priceImpactPct: parseFloat(String(rawQuote.priceImpactPct ?? '0')),
    fromSacId: params.fromSacId,
    toSacId: params.toSacId,
    slippageBps: params.slippageBps,
    raw: rawQuote,
  };
}

// Build the swap tx for a raw quote and extract the invokeHostFunction op with
// its auth stripped — we re-derive the smart-account auth during simulation.
async function buildOpFromRawQuote(rawQuote: unknown, smartAccountAddress: string): Promise<xdr.Operation> {
  const buildRes = await soroswapPost('/quote/build', {
    quote: rawQuote,
    // Output tokens return to the smart account.
    from: smartAccountAddress,
    to: smartAccountAddress,
  });

  if (!buildRes?.xdr) throw new Error('Soroswap build returned no xdr');

  const tx = TransactionBuilder.fromXDR(buildRes.xdr, STELLAR_NETWORK_PASSPHRASE);
  const op = ('operations' in tx ? tx.operations[0] : undefined) as
    | { type?: string; func?: xdr.HostFunction }
    | undefined;
  if (!op || op.type !== 'invokeHostFunction' || !op.func) {
    throw new Error('Soroswap build did not return an invokeHostFunction operation');
  }

  return Operation.invokeHostFunction({ func: op.func, auth: [] });
}

function isPoolHashesError(err: unknown): boolean {
  return err instanceof Error && /poolhashes/i.test(err.message);
}

export const soroswapProvider: SwapProvider = {
  id: 'soroswap',
  name: 'Soroswap',
  icon: require('@/src/assets/images/soroswap.png'),

  async getQuote(params: SwapQuoteParams): Promise<SwapQuote> {
    return mapQuote(await fetchRawQuote(params, PROTOCOLS), params);
  },

  async buildSwapOperation(
    quote: SwapQuote,
    smartAccountAddress: string,
  ): Promise<SwapBuildResult> {
    try {
      const operation = await buildOpFromRawQuote(quote.raw, smartAccountAddress);
      return { operation, effectiveQuote: quote };
    } catch (err) {
      if (!isPoolHashesError(err)) throw err;
      // Aggregator route's poolHashes were rejected — rebuild via a single AMM.
      // The fallback quote is what actually executes, so return it as effective.
      if (__DEV__) {
        console.log('[swap] aggregator build rejected (poolHashes); retrying single-AMM route');
      }
      const params: SwapQuoteParams = {
        fromSacId: quote.fromSacId,
        toSacId: quote.toSacId,
        amountIn: quote.amountIn,
        slippageBps: quote.slippageBps,
      };
      const fallbackRaw = await fetchRawQuote(params, FALLBACK_PROTOCOLS);
      const operation = await buildOpFromRawQuote(fallbackRaw, smartAccountAddress);
      return { operation, effectiveQuote: mapQuote(fallbackRaw, params) };
    }
  },
};
