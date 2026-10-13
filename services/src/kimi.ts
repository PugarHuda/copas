/**
 * D1/D3 LLM risk analyst (Kimi K3 on the Moonshot API when KIMI_API_KEY is set, else OpenRouter free models). Explains precomputed features; never decides or executes anything.
 * Every call carries X-Msh-Request-Nonce, so Kimi returns a Request Signature that anyone can check at
 * POST https://api.moonshot.ai/v1/signatures/verify. Hashes of input/output are appended to data/kimi-log.jsonl.
 */
import { createHash, randomUUID } from "node:crypto";
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { keccak256, toBytes } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import type { Features } from "./features.js";
import { type Fetch, canonicalJson, env, requireEnv, round } from "./util.js";

export const kimiBase = () => env("KIMI_BASE_URL") ?? "https://api.moonshot.ai/v1";
export const KIMI_MODEL = "kimi-k3";
// Without KIMI_API_KEY, OPENROUTER_API_KEY switches the analyst to OpenRouter free models (no Kimi request signature, $0 cost).
const OPENROUTER = "https://openrouter.ai/api/v1";
const OR_MODELS = () => (env("LLM_MODEL") ?? "google/gemma-4-31b-it:free,nvidia/nemotron-3-super-120b-a12b:free").split(",");
export const llmProvider = () => (!env("KIMI_API_KEY") && env("OPENROUTER_API_KEY") ? "openrouter" : "kimi");
export const KIMI_PRICE = { input: 3, cachedInput: 0.3, output: 15 }; // USD per 1M tokens (platform.kimi.ai/docs/pricing/chat-k3)

export interface Bilingual {
  en: string;
  id: string;
}
export interface Analysis {
  riskLevel: "low" | "medium" | "high";
  styleSummary: Bilingual;
  tilt: Bilingual & { detected: boolean };
  drift: Bilingual & { detected: boolean };
  weeklySummary: Bilingual;
  devilsAdvocate: (Bilingual & { key: string; metric: string; value: number })[];
}
export interface KimiSignature {
  nonce: string;
  timestamp: number;
  model: string;
  signature: string;
}
/** OpenRouter has no response signing: the service signs a receipt over the hashes with ATTESTER_PRIVATE_KEY (EIP-191). */
export interface AnalysisReceipt {
  kind: "eip191-receipt";
  payload: { leader: string; model: string; generationId: string | null; inputHash: string; outputHash: string; at: number };
  hash: `0x${string}`;
  signature: `0x${string}`;
  signer: `0x${string}`;
}
export interface AnalysisResult {
  analysis: Analysis;
  features: Features;
  signature: KimiSignature | AnalysisReceipt | null;
  signatureValid: boolean | null;
  nonce: string;
  verifyUrl: string;
  usage: { promptTokens: number; cachedTokens: number; completionTokens: number };
  costUsd: number;
  inputHash: string;
  outputHash: string;
  model: string;
}

const SYSTEM = `You are the risk analyst of Copas, a bonded copy-trading app on Monad (Perpl perps).
You EXPLAIN precomputed, deterministic features of a leader to a retail follower, in plain English. Rules:
- Use only numbers that appear in the input. Never invent data, prices or forecasts.
- Never tell the user to buy, sell or follow; execution is done by deterministic contracts, not by you.
- "tilt.detected" and "drift.detected" MUST equal the input flags; you only explain them.
- "activity" is ground truth. If it has fills or open positions, never say the leader has not traded, shows no activity
  or holds no position. With 0 closed trades say "no closed trades yet" and describe the open positions (side, size,
  market, entry, unrealized PnL); the styleSummary must restate activity.summary in your words.
- devilsAdvocate: pick exactly 3 items from input.reasonsNotToFollow (strongest first), keep their "key", explain each with its numbers.
- Write for a person, not a programmer: never output field names or code identifiers (camelCase, snake_case, "x = 2"),
  never mention "severity", scores or flags, and write dates as dates (e.g. "Oct 3"), never unix timestamps.
  Say "2 times they increased size after a loss", not "sizeUpsAfterLoss = 2".
- Max 2 sentences per text field.
Reply with ONE JSON object:
{"riskLevel":"low|medium|high","styleSummary":{"en":""},"tilt":{"detected":bool,"en":""},"drift":{"detected":bool,"en":""},"weeklySummary":{"en":""},"devilsAdvocate":[{"key":"","en":""}]}`;

/** Belt and braces for the prompt rules: code identifiers, "= n", severities and unix timestamps out of user text. */
export function humanize(text: string): string {
  return text
    .replace(/`([^`]*)`/g, "$1")
    .replace(/\(?\s*severity\s*[:=]?\s*\d+(\.\d+)?\s*\)?/gi, "")
    .replace(/\b1[6-9]\d{8}\b/g, (t) => new Date(Number(t) * 1000).toISOString().slice(0, 10))
    .replace(/\b([a-z]+(?:[A-Z][a-z0-9]*)+|[a-z]+(?:_[a-z0-9]+)+)\b(\s*(?:=|:)\s*)?/g, (_m, id: string, eq?: string) => {
      const words = id.replace(/_/g, " ").replace(/([a-z0-9])([A-Z])/g, "$1 $2").toLowerCase();
      return eq ? `${words} ` : words;
    })
    .replace(/\s{2,}/g, " ")
    .replace(/\s+([.,;])/g, "$1")
    .trim();
}

/** What the LLM sees: features minus internal scoring, timestamps as dates. */
export function llmInput(f: Features) {
  const day = (t: number) => new Date(t * 1000).toISOString().slice(0, 10);
  return {
    ...f,
    weekly: { ...f.weekly, from: day(f.weekly.from), to: day(f.weekly.to) },
    reasonsNotToFollow: f.reasonsNotToFollow.map(({ severity: _s, ...r }) => r),
  };
}

export const sha256 = (s: string) => "0x" + createHash("sha256").update(s).digest("hex");

export function kimiCost(usage: { prompt_tokens?: number; completion_tokens?: number; prompt_tokens_details?: { cached_tokens?: number }; cached_tokens?: number }) {
  const prompt = usage.prompt_tokens ?? 0;
  const cached = usage.prompt_tokens_details?.cached_tokens ?? usage.cached_tokens ?? 0;
  const out = usage.completion_tokens ?? 0;
  const costUsd = ((prompt - cached) * KIMI_PRICE.input + cached * KIMI_PRICE.cachedInput + out * KIMI_PRICE.output) / 1e6;
  return { usage: { promptTokens: prompt, cachedTokens: cached, completionTokens: out }, costUsd: round(costUsd, 6) };
}

/** LLM text claiming the leader never traded (contradicted by fills or open positions) / holds nothing (contradicted by open positions). */
const CLAIMS_NO_TRADING = /\b(?:has(?:n't| not)|did(?:n't| not)|never)\s+(?:yet\s+)?(?:executed|made|placed|opened|taken|traded)\b|\bnot\s+(?:executed|made|placed|opened)\s+any\b|\bno\s+(?:trades?|trading|activity|fills?|executions?|orders?)\b|\bzero\s+(?:trades|fills)\b/i;
const CLAIMS_NO_POSITION = /\bno\s+(?:active|open|current|live)\s+positions?\b|\bnot\s+holding\b|\bholds?\s+no\b/i;

/** Keeps the LLM inside the deterministic facts: flags are overwritten, reasons must come from the candidates. */
export function guardAnalysis(raw: any, f: Features): Analysis {
  // English only now; `id` mirrors `en` so the response shape (and the web) stays the same.
  const bi = (x: any): Bilingual => {
    const en = humanize(String(x?.en ?? ""));
    return { en, id: en };
  };
  const cands = new Map(f.reasonsNotToFollow.map((r) => [r.key, r]));
  const picked = (Array.isArray(raw?.devilsAdvocate) ? raw.devilsAdvocate : []).filter((d: any) => cands.has(d?.key));
  const seen = new Set<string>();
  const da = picked
    .filter((d: any) => !seen.has(d.key) && seen.add(d.key))
    .slice(0, 3)
    .map((d: any) => ({ key: d.key, metric: cands.get(d.key)!.metric, value: cands.get(d.key)!.value, ...bi(d) }));
  // fill up from the deterministic ranking if the model returned fewer than 3 valid keys
  for (const r of f.reasonsNotToFollow) {
    if (da.length >= 3) break;
    if (seen.has(r.key)) continue;
    seen.add(r.key);
    da.push({ key: r.key, metric: r.metric, value: r.value, en: r.detail, id: r.detail });
  }
  const act = f.activity;
  const traded = !!act && (act.fills > 0 || (act.openPositions?.length ?? 0) > 0);
  const holds = (act?.openPositions?.length ?? 0) > 0;
  // a sentence that contradicts the activity facts is replaced by the deterministic summary
  const fact = (b: Bilingual): Bilingual => ((traded && CLAIMS_NO_TRADING.test(b.en)) || (holds && CLAIMS_NO_POSITION.test(b.en)) ? { en: act!.summary, id: act!.summary } : b);
  let style = fact(bi(raw?.styleSummary));
  if (act && act.status !== "trading" && style.en !== act.summary && !/\bclosed\b/i.test(style.en)) style = { en: `${act.summary} ${style.en}`.trim(), id: `${act.summary} ${style.en}`.trim() };
  let level = ["low", "medium", "high"].includes(raw?.riskLevel) ? raw.riskLevel : "medium";
  if (act && act.status !== "trading" && level === "low") level = "medium"; // no track record is never "low risk"
  return {
    riskLevel: level,
    styleSummary: style,
    tilt: { detected: f.tilt.detected, ...fact(bi(raw?.tilt)) },
    drift: { detected: f.drift.detected, ...fact(bi(raw?.drift)) },
    weeklySummary: fact(bi(raw?.weeklySummary)),
    devilsAdvocate: da,
  };
}

export async function verifyKimiSignature(sig: KimiSignature, f: Fetch = fetch): Promise<boolean> {
  const key = requireEnv("KIMI_API_KEY");
  const r = await f(`${kimiBase()}/signatures/verify`, {
    method: "POST",
    headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
    body: JSON.stringify(sig),
  });
  if (!r.ok) return false;
  return !!((await r.json()) as { valid?: boolean }).valid;
}

export async function analyzeLeader(
  address: string,
  features: Features,
  opts: { fetch?: Fetch; logPath?: string; now?: number } = {},
): Promise<AnalysisResult> {
  const or = llmProvider() === "openrouter";
  const key = requireEnv(or ? "OPENROUTER_API_KEY" : "KIMI_API_KEY");
  const f = opts.fetch ?? fetch;
  const nonce = randomUUID();
  const input = canonicalJson({ leader: address, features: llmInput(features) });
  const messages = [
    { role: "system", content: SYSTEM },
    { role: "user", content: input },
  ];
  const res = await f(`${or ? OPENROUTER : kimiBase()}/chat/completions`, {
    method: "POST",
    headers: { authorization: `Bearer ${key}`, "content-type": "application/json", "X-Msh-Request-Nonce": nonce, ...(or ? { "X-Title": "Copas" } : {}) },
    // Kimi: no temperature/top_p (K3 locks them). OpenRouter: `models` = fallback chain across free models.
    body: JSON.stringify(
      or
        ? { model: OR_MODELS()[0], models: OR_MODELS(), response_format: { type: "json_object" }, messages }
        : { model: KIMI_MODEL, reasoning_effort: "high", response_format: { type: "json_object" }, messages },
    ),
  });
  if (!res.ok) throw new Error(`${or ? "openrouter" : "kimi"} ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const ts = res.headers.get("msh-request-timestamp");
  const sg = res.headers.get("msh-request-signature");
  const signature = ts && sg ? { nonce, timestamp: Number(ts), model: KIMI_MODEL, signature: sg } : null;
  const body = (await res.json()) as any;
  const model = or ? String(body.model ?? OR_MODELS()[0]) : KIMI_MODEL;
  const content = String(body.choices?.[0]?.message?.content ?? "{}");
  let raw: unknown = {};
  try {
    raw = JSON.parse(content.slice(content.indexOf("{"), content.lastIndexOf("}") + 1));
  } catch {
    raw = {};
  }
  const analysis = guardAnalysis(raw, features);
  const { usage, costUsd: kimiUsd } = kimiCost(body.usage ?? {});
  const costUsd = or ? 0 : kimiUsd;
  const inputHash = sha256(input);
  const outputHash = sha256(canonicalJson(analysis));
  const ak = or ? env("ATTESTER_PRIVATE_KEY") : undefined;
  const receipt = ak ? await signReceipt(ak as `0x${string}`, { leader: address, model, generationId: body.id ? String(body.id) : null, inputHash, outputHash, at: opts.now ?? Math.floor(Date.now() / 1000) }) : null;
  const signatureValid = receipt ? true : signature ? await verifyKimiSignature(signature, f).catch(() => null) : null;
  const out: AnalysisResult = {
    analysis,
    features,
    signature: receipt ?? signature,
    signatureValid,
    nonce,
    // receipt: check with viem verifyMessage({ address: signer, message: { raw: hash }, signature }) after re-hashing payload
    verifyUrl: or ? "" : `${kimiBase()}/signatures/verify`,
    usage,
    costUsd,
    inputHash,
    outputHash,
    model,
  };
  const logPath = opts.logPath ?? env("KIMI_LOG_PATH") ?? "data/kimi-log.jsonl";
  mkdirSync(dirname(logPath), { recursive: true });
  appendFileSync(
    logPath,
    JSON.stringify({ at: opts.now ?? Math.floor(Date.now() / 1000), leader: address, model, nonce, signature, signatureValid, inputHash: out.inputHash, outputHash: out.outputHash, usage, costUsd }) + "\n",
  );
  return out;
}

/** keccak256 of the canonical payload, signed EIP-191 (same scheme as attest.ts). */
export async function signReceipt(pk: `0x${string}`, payload: AnalysisReceipt["payload"]): Promise<AnalysisReceipt> {
  const account = privateKeyToAccount(pk);
  const hash = keccak256(toBytes(canonicalJson(payload)));
  return { kind: "eip191-receipt", payload, hash, signature: await account.signMessage({ message: { raw: hash } }), signer: account.address };
}
