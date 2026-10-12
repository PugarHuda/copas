// Pure, deterministic helpers (no CRE imports) so they can be unit-tested with `bun test`.

export const STATUS_ACTIVE = 0 // LeaderBook.LeaderStatus.Active
export const CHECKPOINT_RISK = 2 // keep in sync with CopasRiskConsumer
export const CHECKPOINT_DD_PCT = 80

export type LeaderSnapshot = {
	index: number
	address: `0x${string}`
	equityUsd: number
	equityValid: boolean
	maxDDbps: number
	maxLeverageX: number
	peakUnitPrice: bigint
	lastUnitPrice: bigint
	ddBps: number
	ddToLimitPct: number
}

export type MarketCheck = {
	symbol: string
	perplMark: number
	cexPrice: number
	divergenceBps: number
	flagged: boolean
}

/** Drawdown of the unit price from the epoch peak, exactly as LeaderBook._checkpoint computes it. */
export function ddBps(peak: bigint, last: bigint): number {
	if (peak === 0n || last >= peak) return 0
	return Number(((peak - last) * 10_000n) / peak)
}

/** Current drawdown as a % of the mandate limit (100 = at the breach line). */
export function ddToLimitPct(dd: number, maxDDbps: number): number {
	if (maxDDbps <= 0) return 0
	return Math.min(Math.floor((dd * 100) / maxDDbps), 65_535)
}

export function divergenceBps(perplMark: number, cexPrice: number): number {
	if (cexPrice <= 0 || perplMark <= 0) return -1 // unknown
	return Math.round((Math.abs(perplMark - cexPrice) / cexPrice) * 10_000)
}

/** Fallback score when the LLM is unavailable: drawdown bands, bumped one level when marks look off. */
export function heuristicRisk(ddPct: number, equityValid: boolean, anyDivergence: boolean): number {
	let r = ddPct >= 80 ? 3 : ddPct >= 50 ? 2 : ddPct >= 25 ? 1 : 0
	if (!equityValid || anyDivergence) r = Math.max(r, 1)
	return r
}

export function shouldCheckpoint(riskLevel: number, ddPct: number): boolean {
	return riskLevel >= CHECKPOINT_RISK || ddPct >= CHECKPOINT_DD_PCT
}

export function clampRisk(x: number): number {
	return Math.max(0, Math.min(3, Math.round(x)))
}

/** Deterministic note: every DON node builds the identical string, so its hash is consensus-safe. */
export function noteText(l: LeaderSnapshot, riskLevel: number, source: 'llm' | 'heuristic', markets: MarketCheck[]): string {
	const div = markets.filter((m) => m.flagged).map((m) => `${m.symbol}:${m.divergenceBps}bps`)
	return [
		'copas-risk-guardian/v1',
		l.address.toLowerCase(),
		`risk=${riskLevel}(${source})`,
		`dd=${l.ddBps}bps/${l.maxDDbps}bps=${l.ddToLimitPct}%`,
		`equity=${l.equityUsd.toFixed(2)}${l.equityValid ? '' : '(invalid-mark)'}`,
		`divergence=${div.length ? div.join(',') : 'none'}`,
	].join('|')
}

export const LLM_SCHEMA = {
	type: 'object',
	additionalProperties: false,
	required: ['leaders'],
	properties: {
		leaders: {
			type: 'array',
			items: {
				type: 'object',
				additionalProperties: false,
				required: ['index', 'riskLevel', 'ddToLimitPct', 'note'],
				properties: {
					index: { type: 'integer' },
					riskLevel: { type: 'integer', enum: [0, 1, 2, 3] },
					ddToLimitPct: { type: 'number' },
					note: { type: 'string' },
				},
			},
		},
	},
} as const

export function buildPrompt(leaders: LeaderSnapshot[], markets: MarketCheck[]): { system: string; user: string } {
	const system =
		'You are the risk analyst of Copas, a bonded copy-trading protocol on Monad. Each leader trades perps on Perpl ' +
		'under a mandate (max drawdown of unit price from the epoch peak, max leverage). If the drawdown exceeds the ' +
		'mandate, the leader bond is slashed to followers. Score each leader: riskLevel 0=ok, 1=watch, 2=high (likely to ' +
		'approach the limit soon), 3=critical (at/over the limit or data invalid). ddToLimitPct = drawdown as % of the ' +
		'mandate limit. note = one short sentence (<= 160 chars) for followers. Consider Perpl mark vs CEX divergence: a ' +
		'large divergence means the mark (and thus equity) may be unreliable. Return JSON only, one entry per leader index.'
	const user = JSON.stringify({
		leaders: leaders.map((l) => ({
			index: l.index,
			equityUsd: Number(l.equityUsd.toFixed(2)),
			equityValid: l.equityValid,
			drawdownBps: l.ddBps,
			mandateMaxDDbps: l.maxDDbps,
			ddToLimitPct: l.ddToLimitPct,
			mandateMaxLeverageX: l.maxLeverageX,
		})),
		markets: markets.map((m) => ({
			symbol: m.symbol,
			perplMark: m.perplMark,
			cexPrice: m.cexPrice,
			divergenceBps: m.divergenceBps,
		})),
	})
	return { system, user }
}

/** Parse the LLM content into fixed numeric fields r<i>/d<i> (-1 = missing) so the DON can take a per-field median. */
export function parseLlm(content: string, n: number): Record<string, number> {
	const out: Record<string, number> = {}
	for (let i = 0; i < n; i++) {
		out[`r${i}`] = -1
		out[`d${i}`] = -1
	}
	let parsed: unknown
	try {
		parsed = JSON.parse(content)
	} catch {
		return out
	}
	const leaders = (parsed as { leaders?: unknown }).leaders
	if (!Array.isArray(leaders)) return out
	for (const e of leaders) {
		const idx = Number((e as { index?: unknown }).index)
		const r = Number((e as { riskLevel?: unknown }).riskLevel)
		const d = Number((e as { ddToLimitPct?: unknown }).ddToLimitPct)
		if (!Number.isInteger(idx) || idx < 0 || idx >= n || !Number.isFinite(r)) continue
		out[`r${idx}`] = clampRisk(r)
		out[`d${idx}`] = Number.isFinite(d) ? Math.max(0, Math.round(d)) : -1
	}
	return out
}

/** UTF-8 → base64 without Buffer (not available in the QuickJS/WASM runtime). */
// The CRE WASM runtime (Javy/QuickJS) has no btoa or TextEncoder: UTF-8 + base64 by hand.
const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
export function toBase64(s: string): string {
	const bytes: number[] = []
	for (const ch of s) {
		const c = ch.codePointAt(0)!
		if (c < 0x80) bytes.push(c)
		else if (c < 0x800) bytes.push(0xc0 | (c >> 6), 0x80 | (c & 63))
		else if (c < 0x10000) bytes.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63))
		else bytes.push(0xf0 | (c >> 18), 0x80 | ((c >> 12) & 63), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63))
	}
	let out = ''
	for (let i = 0; i < bytes.length; i += 3) {
		const [a, b = 0, c = 0] = [bytes[i], bytes[i + 1], bytes[i + 2]]
		const n = (a << 16) | (b << 8) | c
		out += B64[n >> 18] + B64[(n >> 12) & 63] + (i + 1 < bytes.length ? B64[(n >> 6) & 63] : '=') + (i + 2 < bytes.length ? B64[n & 63] : '=')
	}
	return out
}
