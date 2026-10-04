// copas-risk-guardian — Chainlink CRE workflow for Copas (bonded copy trading on Monad).
//
// Every 5 minutes, as a DON:
//   1. EVM read  (Monad): CopasRegistry.leaderCount/leaderBooks + LeaderBook.status/equity/mandate/peak/last
//                         + Perpl Exchange mark prices — batched through Multicall3 to stay inside 15 reads.
//   2. HTTP      : public CEX/aggregator prices (CoinGecko) → sanity flag when Perpl mark diverges > X bps.
//   3. HTTP      : Kimi K3 (OpenAI-compatible) with a strict JSON schema → per-leader riskLevel, median across nodes.
//   4. EVM write : DON-signed report → KeystoneForwarder → CopasRiskConsumer.onReport, which stores RiskNote
//                  and calls the permissionless LeaderBook.checkpoint() for leaders with risk >= 2 or dd >= 80%.
import {
	bytesToHex,
	ConsensusAggregationByFields,
	CronCapability,
	EVMClient,
	encodeCallMsg,
	getNetwork,
	HTTPClient,
	type HTTPSendRequester,
	handler,
	json,
	LAST_FINALIZED_BLOCK_NUMBER,
	median,
	ok,
	prepareReportRequest,
	Runner,
	type Runtime,
	text,
	TxStatus,
} from '@chainlink/cre-sdk'
import {
	type Address,
	decodeFunctionResult,
	encodeAbiParameters,
	encodeFunctionData,
	type Hex,
	keccak256,
	parseAbi,
	toBytes,
	zeroAddress,
} from 'viem'
import { z } from 'zod'
import {
	buildPrompt,
	clampRisk,
	ddBps,
	ddToLimitPct,
	divergenceBps,
	heuristicRisk,
	LLM_SCHEMA,
	type LeaderSnapshot,
	type MarketCheck,
	noteText,
	parseLlm,
	STATUS_ACTIVE,
	shouldCheckpoint,
	toBase64,
} from './risk'

// ---------------------------------------------------------------- config

const configSchema = z.object({
	schedule: z.string(),
	chainName: z.string(), // monad-mainnet | monad-testnet
	isTestnet: z.boolean(),
	registry: z.string(), // CopasRegistry (zero address = not deployed yet: leader reads are skipped)
	consumer: z.string(), // CopasRiskConsumer (zero address = report is built but not written)
	exchange: z.string(), // Perpl Exchange
	multicall: z.string(), // Multicall3
	maxLeaders: z.number().int().min(1).max(32),
	callsPerRead: z.number().int().min(1).max(32), // keeps each EVM read under the 5 KB payload quota
	gasLimit: z.string(),
	maxDivergenceBps: z.number(),
	priceUrl: z.string(), // must return {"<id>": {"usd": n}}
	markets: z.array(z.object({ symbol: z.string(), perpId: z.number(), priceDecimals: z.number(), priceId: z.string() })),
	llm: z.object({
		url: z.string(),
		model: z.string(),
		reasoningEffort: z.enum(['low', 'high', 'max']),
		timeout: z.string(), // protobuf duration, e.g. "150s"
		secretId: z.string(),
	}),
})
type Config = z.infer<typeof configSchema>

// ---------------------------------------------------------------- ABIs (minimal, typed)

const MULTICALL_ABI = parseAbi([
	'struct Call3 { address target; bool allowFailure; bytes callData; }',
	'struct Result { bool success; bytes returnData; }',
	'function aggregate3(Call3[] calls) payable returns (Result[] returnData)',
])
const REGISTRY_ABI = parseAbi([
	'function leaderCount() view returns (uint256)',
	'function leaderBooks(uint256) view returns (address)',
])
const LEADER_ABI = parseAbi([
	'struct Mandate { uint32 maxDDbps; uint32 maxLeverageHdths; uint32 feeBps; uint64 epochLen; uint128 maxNotionalCNS; uint256 marketsMask; }',
	'function status() view returns (uint8)',
	'function equity() view returns (uint256 eq, bool valid)',
	'function mandate() view returns (Mandate)',
	'function peakUnitPrice() view returns (uint256)',
	'function lastUnitPrice() view returns (uint256)',
])
// getPosition(perpId, 1) is the cheap mark read PerplLib already uses (getPerpetualInfo is ~1.2 KB per market).
const PERPL_ABI = parseAbi([
	'struct PositionInfo { uint256 accountId; uint256 nextNodeId; uint256 prevNodeId; uint8 positionType; uint256 depositCNS; uint256 pricePNS; uint256 lotLNS; uint256 entryBlock; int256 pnlCNS; int256 deltaPnlCNS; int256 premiumPnlCNS; }',
	'function getPosition(uint256 perpId, uint256 accountId) view returns (PositionInfo positionInfo, uint256 markPricePNS, bool markPriceValid)',
])

type Call = { target: Address; callData: Hex }

// ---------------------------------------------------------------- EVM helpers

function multicall(runtime: Runtime<Config>, evm: EVMClient, calls: Call[]): { success: boolean; returnData: Hex }[] {
	const out: { success: boolean; returnData: Hex }[] = []
	const step = runtime.config.callsPerRead
	for (let i = 0; i < calls.length; i += step) {
		const chunk = calls.slice(i, i + step).map((c) => ({ ...c, allowFailure: true }))
		const data = encodeFunctionData({ abi: MULTICALL_ABI, functionName: 'aggregate3', args: [chunk] })
		const reply = evm
			.callContract(runtime, {
				call: encodeCallMsg({ from: zeroAddress, to: runtime.config.multicall as Address, data }),
				blockNumber: LAST_FINALIZED_BLOCK_NUMBER,
			})
			.result()
		const res = decodeFunctionResult({ abi: MULTICALL_ABI, functionName: 'aggregate3', data: bytesToHex(reply.data) })
		out.push(...res)
	}
	return out
}

const isZero = (a: string) => /^0x0{40}$/i.test(a)

// ---------------------------------------------------------------- step 1: onchain state

function readMarketsAndLeaders(runtime: Runtime<Config>, evm: EVMClient) {
	const cfg = runtime.config
	const exchange = cfg.exchange as Address
	const registry = cfg.registry as Address
	const hasRegistry = !isZero(registry)

	// read A: Perpl marks (+ leaderCount)
	const callsA: Call[] = cfg.markets.map((m) => ({
		target: exchange,
		callData: encodeFunctionData({ abi: PERPL_ABI, functionName: 'getPosition', args: [BigInt(m.perpId), 1n] }),
	}))
	if (hasRegistry) callsA.push({ target: registry, callData: encodeFunctionData({ abi: REGISTRY_ABI, functionName: 'leaderCount' }) })
	const resA = multicall(runtime, evm, callsA)

	const marks = cfg.markets.map((m, i) => {
		const r = resA[i]
		if (!r.success) return 0
		const [, markPNS, valid] = decodeFunctionResult({ abi: PERPL_ABI, functionName: 'getPosition', data: r.returnData })
		return valid ? Number(markPNS) / 10 ** m.priceDecimals : 0
	})
	if (!hasRegistry) {
		runtime.log('registry not configured (zero address): skipping leader reads')
		return { marks, leaders: [] as LeaderSnapshot[] }
	}

	const countRes = resA[cfg.markets.length]
	const count = countRes.success
		? Number(decodeFunctionResult({ abi: REGISTRY_ABI, functionName: 'leaderCount', data: countRes.returnData }))
		: 0
	const n = Math.min(count, cfg.maxLeaders)
	runtime.log(`registry ${registry}: ${count} leader(s), evaluating ${n}`)
	if (n === 0) return { marks, leaders: [] as LeaderSnapshot[] }

	// read B: leader addresses
	const resB = multicall(
		runtime,
		evm,
		Array.from({ length: n }, (_, i) => ({
			target: registry,
			callData: encodeFunctionData({ abi: REGISTRY_ABI, functionName: 'leaderBooks', args: [BigInt(i)] }),
		})),
	)
	const books = resB
		.filter((r) => r.success)
		.map((r) => decodeFunctionResult({ abi: REGISTRY_ABI, functionName: 'leaderBooks', data: r.returnData }))

	// read C: per-leader state, 5 calls each
	const fns = ['status', 'equity', 'mandate', 'peakUnitPrice', 'lastUnitPrice'] as const
	const resC = multicall(
		runtime,
		evm,
		books.flatMap((b) => fns.map((fn) => ({ target: b, callData: encodeFunctionData({ abi: LEADER_ABI, functionName: fn }) }))),
	)

	const leaders: LeaderSnapshot[] = []
	books.forEach((address, i) => {
		const r = resC.slice(i * fns.length, (i + 1) * fns.length)
		if (r.some((x) => !x.success)) return
		const status = decodeFunctionResult({ abi: LEADER_ABI, functionName: 'status', data: r[0].returnData })
		if (status !== STATUS_ACTIVE) return
		const [eq, valid] = decodeFunctionResult({ abi: LEADER_ABI, functionName: 'equity', data: r[1].returnData })
		const m = decodeFunctionResult({ abi: LEADER_ABI, functionName: 'mandate', data: r[2].returnData })
		const peak = decodeFunctionResult({ abi: LEADER_ABI, functionName: 'peakUnitPrice', data: r[3].returnData })
		const last = decodeFunctionResult({ abi: LEADER_ABI, functionName: 'lastUnitPrice', data: r[4].returnData })
		const dd = ddBps(peak, last)
		leaders.push({
			index: leaders.length,
			address,
			equityUsd: Number(eq) / 1e6,
			equityValid: valid,
			maxDDbps: m.maxDDbps,
			maxLeverageX: m.maxLeverageHdths / 100,
			peakUnitPrice: peak,
			lastUnitPrice: last,
			ddBps: dd,
			ddToLimitPct: ddToLimitPct(dd, m.maxDDbps),
		})
	})
	return { marks, leaders }
}

// ---------------------------------------------------------------- step 2: external prices (node mode → median)

const fetchPrices = (send: HTTPSendRequester, url: string, ids: string[]): Record<string, number> => {
	const out: Record<string, number> = Object.fromEntries(ids.map((id) => [id, 0]))
	const res = send.sendRequest({ url, method: 'GET', headers: { accept: 'application/json' } }).result()
	if (!ok(res)) return out
	const body = json(res) as Record<string, { usd?: number }>
	for (const id of ids) out[id] = Number(body?.[id]?.usd ?? 0)
	return out
}

// ---------------------------------------------------------------- step 3: LLM (node mode → per-field median)

const askLlm = (
	send: HTTPSendRequester,
	llm: Config['llm'],
	apiKey: string,
	prompt: { system: string; user: string },
	n: number,
): Record<string, number> => {
	const body = {
		model: llm.model,
		reasoning_effort: llm.reasoningEffort, // kimi-k3: temperature is fixed at 1.0 and must be omitted
		messages: [
			{ role: 'system', content: prompt.system },
			{ role: 'user', content: prompt.user },
		],
		response_format: { type: 'json_schema', json_schema: { name: 'copas_risk', strict: true, schema: LLM_SCHEMA } },
	}
	const res = send
		.sendRequest({
			url: llm.url,
			method: 'POST',
			headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
			body: toBase64(JSON.stringify(body)),
			timeout: llm.timeout,
		})
		.result()
	if (!ok(res)) return parseLlm(`HTTP ${res.statusCode}: ${text(res).slice(0, 200)}`, n) // all -1 → heuristic fallback
	const content = (json(res) as { choices?: { message?: { content?: string } }[] })?.choices?.[0]?.message?.content ?? ''
	return parseLlm(content, n)
}

// ---------------------------------------------------------------- handler

const onCron = (runtime: Runtime<Config>): string => {
	const cfg = runtime.config
	const net = getNetwork({ chainFamily: 'evm', chainSelectorName: cfg.chainName, isTestnet: cfg.isTestnet })
	if (!net) throw new Error(`unknown chain ${cfg.chainName}`)
	const evm = new EVMClient(net.chainSelector.selector)
	const http = new HTTPClient()

	// 1. onchain
	const { marks, leaders } = readMarketsAndLeaders(runtime, evm)

	// 2. external prices, compared with Perpl marks
	const ids = cfg.markets.map((m) => m.priceId)
	const priceAgg = ConsensusAggregationByFields<Record<string, number>>(Object.fromEntries(ids.map((id) => [id, median<number>])))
	const cex = http.sendRequest(runtime, fetchPrices, priceAgg)(cfg.priceUrl, ids).result()
	const markets: MarketCheck[] = cfg.markets.map((m, i) => {
		const d = divergenceBps(marks[i], cex[m.priceId])
		return { symbol: m.symbol, perplMark: marks[i], cexPrice: cex[m.priceId], divergenceBps: d, flagged: d > cfg.maxDivergenceBps }
	})
	for (const m of markets) {
		runtime.log(`price ${m.symbol}: perpl=${m.perplMark} cex=${m.cexPrice} div=${m.divergenceBps}bps${m.flagged ? ' FLAG' : ''}`)
	}
	const anyDivergence = markets.some((m) => m.flagged)

	if (leaders.length === 0) {
		runtime.log('no active leaders: nothing to score or write')
		return JSON.stringify({ leaders: 0, flaggedMarkets: markets.filter((m) => m.flagged).map((m) => m.symbol) })
	}

	// 3. LLM risk score (falls back to the deterministic heuristic if the key/API is unavailable)
	let llm: Record<string, number> = parseLlm('', leaders.length)
	try {
		const apiKey = runtime.getSecret({ id: cfg.llm.secretId }).result().value
		const fields = Object.fromEntries(Object.keys(llm).map((k) => [k, median<number>]))
		llm = http
			.sendRequest(runtime, askLlm, ConsensusAggregationByFields<Record<string, number>>(fields))(
				cfg.llm,
				apiKey,
				buildPrompt(leaders, markets),
				leaders.length,
			)
			.result()
	} catch (e) {
		runtime.log(`LLM unavailable, using heuristic: ${(e as Error).message}`)
	}

	const notes = leaders.map((l) => {
		const llmRisk = llm[`r${l.index}`]
		const source = llmRisk >= 0 ? 'llm' : 'heuristic'
		const riskLevel = source === 'llm' ? clampRisk(llmRisk) : heuristicRisk(l.ddToLimitPct, l.equityValid, anyDivergence)
		const note = noteText(l, riskLevel, source, markets)
		runtime.log(
			`leader ${l.address} risk=${riskLevel}(${source}) dd=${l.ddToLimitPct}% llmDD=${llm[`d${l.index}`]} checkpoint=${shouldCheckpoint(riskLevel, l.ddToLimitPct)}`,
		)
		return {
			leader: l.address,
			riskLevel,
			ddToLimitPct: l.ddToLimitPct, // the onchain trigger uses the deterministic value, not the LLM's
			noteHash: keccak256(toBytes(note)),
		}
	})

	// 4. DON-signed report → forwarder → CopasRiskConsumer.onReport
	const payload = encodeAbiParameters(
		[
			{
				type: 'tuple[]',
				components: [
					{ name: 'leader', type: 'address' },
					{ name: 'riskLevel', type: 'uint8' },
					{ name: 'ddToLimitPct', type: 'uint16' },
					{ name: 'noteHash', type: 'bytes32' },
				],
			},
		],
		[notes],
	)
	const report = runtime.report(prepareReportRequest(payload)).result()
	if (isZero(cfg.consumer)) {
		runtime.log('consumer not configured (zero address): report built, not written')
		return JSON.stringify({ leaders: notes.length, written: false })
	}
	const w = evm.writeReport(runtime, { receiver: cfg.consumer, report, gasConfig: { gasLimit: cfg.gasLimit } }).result()
	if (w.txStatus !== TxStatus.SUCCESS) throw new Error(`writeReport failed: ${w.errorMessage || w.txStatus}`)
	const tx = w.txHash ? bytesToHex(w.txHash) : ''
	runtime.log(`report written to ${cfg.consumer} tx=${tx}`)
	return JSON.stringify({ leaders: notes.length, written: true, tx })
}

const initWorkflow = (config: Config) => [handler(new CronCapability().trigger({ schedule: config.schedule }), onCron)]

export async function main() {
	const runner = await Runner.newRunner<Config>({ configSchema })
	await runner.run(initWorkflow)
}

main()
