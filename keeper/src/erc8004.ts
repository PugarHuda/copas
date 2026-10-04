// ERC-8004 reputation feedback (feature flag ENABLE_8004_FEEDBACK).
// ReputationRegistry v2.0.0 on Monad. Signature verified against the deployed implementation
// (selector 0x3c036a7e present in bytecode of 0x16e0…da34 behind proxy 0x8004BAa1…9b63):
//   giveFeedback(uint256 agentId, int128 value, uint8 valueDecimals, string tag1, string tag2,
//                string endpoint, string feedbackURI, bytes32 feedbackHash)
// The registry reverts "Self-feedback not allowed" when msg.sender owns/operates the agent, so the
// keeper wallet must NOT be the agent's owner or approved operator.
import { encodeFunctionData, parseAbi, zeroHash, type Address, type Hex, type PublicClient } from 'viem';
import { ABI, cfg, REPUTATION_8004 } from './config.js';
import { feedbackFor } from './logic.js';

export const reputationAbi = parseAbi([
  'function giveFeedback(uint256 agentId, int128 value, uint8 valueDecimals, string tag1, string tag2, string endpoint, string feedbackURI, bytes32 feedbackHash)',
  'function getVersion() view returns (string)',
]);

/** Calldata for this leader's epoch-e feedback, or null if the leader is not an ERC-8004 agent. */
export async function feedbackCall(client: PublicClient, agentRegistry: Address, leader: Address, epoch: bigint): Promise<{ to: Address; data: Hex; tag2: string; agentId: bigint } | null> {
  const agentId = (await client.readContract({ address: agentRegistry, abi: ABI.agentRegistry, functionName: 'agentOf', args: [leader] })) as bigint;
  if (agentId === 0n) return null;
  const breached = (await client.readContract({ address: leader, abi: ABI.leader, functionName: 'breached', args: [epoch] })) as boolean;
  const reason = breached
    ? Number(((await client.readContract({ address: leader, abi: ABI.leader, functionName: 'breachOf', args: [epoch] })) as { reason: number }).reason)
    : 0;
  const f = feedbackFor(breached, reason);
  const uri = process.env.FEEDBACK_URI_BASE ? `${process.env.FEEDBACK_URI_BASE}/leader/${leader}?epoch=${epoch}` : '';
  const data = encodeFunctionData({
    abi: reputationAbi,
    functionName: 'giveFeedback',
    args: [agentId, f.value, 0, f.tag1, f.tag2, `copas:${cfg.chainId}:${leader}:epoch-${epoch}`, uri, zeroHash],
  });
  return { to: REPUTATION_8004, data, tag2: f.tag2, agentId };
}
