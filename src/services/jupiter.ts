import { env } from "../config.js";
import { GuardCode, GuardError } from "../lib/errors.js";

export interface RoutePlanStep {
  swapInfo: {
    ammKey: string;
    label?: string;
    inputMint: string;
    outputMint: string;
    inAmount: string;
    outAmount: string;
    feeAmount: string;
    feeMint: string;
  };
  percent: number;
}

export interface QuoteResponse {
  inputMint: string;
  inAmount: string;
  outputMint: string;
  outAmount: string;
  otherAmountThreshold: string;
  swapMode: "ExactIn" | "ExactOut";
  slippageBps: number;
  priceImpactPct: string;
  routePlan: RoutePlanStep[];
  contextSlot?: number;
  timeTaken?: number;
}

export interface SwapResponse {
  swapTransaction: string; // base64 v0 transaction
  lastValidBlockHeight: number;
  prioritizationFeeLamports?: number;
  computeUnitLimit?: number;
  simulationError?: unknown;
}

function headers(): Record<string, string> {
  const h: Record<string, string> = { accept: "application/json", "content-type": "application/json" };
  if (env.JUPITER_API_KEY) h["x-api-key"] = env.JUPITER_API_KEY;
  return h;
}

export async function getQuote(p: {
  inputMint: string;
  outputMint: string;
  amount: bigint;
  slippageBps: number;
  restrictIntermediateTokens?: boolean;
}): Promise<QuoteResponse> {
  const qs = new URLSearchParams({
    inputMint: p.inputMint,
    outputMint: p.outputMint,
    amount: p.amount.toString(),
    slippageBps: String(p.slippageBps),
    swapMode: "ExactIn",
    restrictIntermediateTokens: String(p.restrictIntermediateTokens ?? true),
  });
  const res = await fetch(`${env.JUPITER_API_URL}/quote?${qs}`, { headers: headers(), signal: AbortSignal.timeout(8000) });
  if (!res.ok) {
    const text = await res.text();
    throw new GuardError(GuardCode.ROUTE_UNAVAILABLE, { detail: text }, `jupiter quote ${res.status}: ${text}`);
  }
  return (await res.json()) as QuoteResponse;
}

export async function getSwapTransaction(p: {
  quoteResponse: QuoteResponse;
  userPublicKey: string;
  prioritizationFeeLamports?: number | "auto";
}): Promise<SwapResponse> {
  const body = {
    quoteResponse: p.quoteResponse,
    userPublicKey: p.userPublicKey,
    wrapAndUnwrapSol: true,
    dynamicComputeUnitLimit: true,
    prioritizationFeeLamports:
      p.prioritizationFeeLamports === undefined || p.prioritizationFeeLamports === "auto"
        ? { priorityLevelWithMaxLamports: { maxLamports: 1_000_000, priorityLevel: "medium" } }
        : p.prioritizationFeeLamports,
  };
  const res = await fetch(`${env.JUPITER_API_URL}/swap`, {
    method: "POST",
    headers: headers(),
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new GuardError(GuardCode.ROUTE_UNAVAILABLE, { detail: text }, `jupiter swap ${res.status}: ${text}`);
  }
  return (await res.json()) as SwapResponse;
}
