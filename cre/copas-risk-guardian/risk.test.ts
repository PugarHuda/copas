import { expect, test } from 'bun:test'
import { ddBps, ddToLimitPct, divergenceBps, heuristicRisk, parseLlm, shouldCheckpoint, toBase64 } from './risk'

test('drawdown matches LeaderBook._checkpoint', () => {
	expect(ddBps(10n ** 18n, 9n * 10n ** 17n)).toBe(1000) // -10%
	expect(ddBps(10n ** 18n, 11n * 10n ** 17n)).toBe(0) // above peak
	expect(ddBps(0n, 5n)).toBe(0)
	expect(ddToLimitPct(1000, 1250)).toBe(80) // 10% of a 12.5% limit
})

test('divergence + checkpoint rule', () => {
	expect(divergenceBps(101, 100)).toBe(100)
	expect(divergenceBps(0, 100)).toBe(-1)
	expect(shouldCheckpoint(2, 0)).toBe(true)
	expect(shouldCheckpoint(1, 80)).toBe(true)
	expect(shouldCheckpoint(1, 79)).toBe(false)
	expect(heuristicRisk(10, true, false)).toBe(0)
	expect(heuristicRisk(10, true, true)).toBe(1)
	expect(heuristicRisk(85, true, false)).toBe(3)
})

test('parseLlm yields fixed fields, -1 on garbage', () => {
	expect(parseLlm('not json', 2)).toEqual({ r0: -1, d0: -1, r1: -1, d1: -1 })
	const out = parseLlm(
		JSON.stringify({ leaders: [{ index: 1, riskLevel: 7, ddToLimitPct: 81.6, note: 'x' }, { index: 9, riskLevel: 1 }] }),
		2,
	)
	expect(out).toEqual({ r0: -1, d0: -1, r1: 3, d1: 82 })
})

test('base64 without Buffer', () => {
	expect(toBase64('{"a":"é"}')).toBe(Buffer.from('{"a":"é"}').toString('base64'))
})
