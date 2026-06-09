// Snapshot tests for WalletIntent -> Daml command composition.

import { describe, it, expect } from 'vitest';

import {
  composeCommands,
  extractCreatedAllocationCids,
  extractLiquidityAcceptanceCid,
  type ComposeContext,
} from '@/wallet/commands';
import type { WalletIntent, RequestSwapIntent } from '@/wallet/types';

const FIXED_NOW = new Date('2026-05-19T12:00:00.000Z');

const ctx: ComposeContext = {
  party: 'alice::1220a',
  packagePrefix: '#canton-dex-trading',
  now: () => FIXED_NOW,
};

const allocationFactoryExtraArgs = {
  context: { values: { 'ctx.allocationFactory': true } },
  meta: { values: {} },
};
const allocationRequestExtraArgs = {
  context: { values: { 'ctx.allocationRequest': true } },
  meta: { values: {} },
};
const lpFactoryExtraArgs = {
  context: { values: { 'ctx.lpFactory': true } },
  meta: { values: {} },
};
const disclosure = [
  {
    contractId: '#ctx:0',
    templateId: 'Registry:Context',
    payloadBlob: 'payload',
  },
];

describe('composeCommands', () => {
  it('accept-allocation-request', () => {
    const intent: WalletIntent = {
      kind: 'accept-allocation-request',
      requestCid: 'aaaaaaaaaaaarequest1',
      factoryCid: 'factory1',
      allocationRequestExtraArgs,
      allocationFactoryExtraArgs,
      disclosure,
      settlement: {
        executors: ['op::1'],
        id: 'DexOrder-web-1',
        cid: null,
        meta: { values: {} },
      },
      allocationSpec: {
        admin: 'ad::1',
        authorizer: { owner: 'alice::1220a', provider: null, id: '' },
        transferLegSides: [],
        settlementDeadline: null,
        nextIterationFunding: { USDC: '100.0' },
        committed: true,
        meta: { values: {} },
      },
      inputHoldingCids: ['holding1', 'holding2'],
      hint: { instrumentId: 'USDC', amount: '100.0' },
    };
    expect(composeCommands(intent, ctx)).toMatchInlineSnapshot(`
      {
        "actAs": [
          "alice::1220a",
        ],
        "commandId": "alloc-accept-aaaaaaaaaaaa-1779192000000",
        "commands": [
          {
            "ExerciseCommand": {
              "choice": "AllocationRequest_Accept",
              "choiceArgument": {
                "actors": [
                  "alice::1220a",
                ],
                "extraArgs": {
                  "context": {
                    "values": {
                      "ctx.allocationRequest": true,
                    },
                  },
                  "meta": {
                    "values": {},
                  },
                },
              },
              "contractId": "aaaaaaaaaaaarequest1",
              "templateId": "#splice-api-token-allocation-request-v2:Splice.Api.Token.AllocationRequestV2:AllocationRequest",
            },
          },
          {
            "ExerciseCommand": {
              "choice": "AllocationFactory_Allocate",
              "choiceArgument": {
                "actors": [
                  "alice::1220a",
                ],
                "allocation": {
                  "admin": "ad::1",
                  "authorizer": {
                    "id": "",
                    "owner": "alice::1220a",
                    "provider": null,
                  },
                  "committed": true,
                  "meta": {
                    "values": {},
                  },
                  "nextIterationFunding": {
                    "USDC": "100.0",
                  },
                  "settlementDeadline": null,
                  "transferLegSides": [],
                },
                "extraArgs": {
                  "context": {
                    "values": {
                      "ctx.allocationFactory": true,
                    },
                  },
                  "meta": {
                    "values": {},
                  },
                },
                "inputHoldingCids": [
                  "holding1",
                  "holding2",
                ],
                "requestedAt": "2026-05-19T12:00:00.000Z",
                "settlement": {
                  "cid": null,
                  "executors": [
                    "op::1",
                  ],
                  "id": "DexOrder-web-1",
                  "meta": {
                    "values": {},
                  },
                },
              },
              "contractId": "factory1",
              "templateId": "#splice-api-token-allocation-instruction-v2:Splice.Api.Token.AllocationInstructionV2:AllocationFactory",
            },
          },
        ],
        "disclosedContracts": [
          {
            "contractId": "#ctx:0",
            "payloadBlob": "payload",
            "templateId": "Registry:Context",
          },
        ],
      }
    `);
  });

  it('place-order', () => {
    const intent: WalletIntent = {
      kind: 'place-order',
      pair: { base: 'BTC', quote: 'USDC' },
      side: 'Bid',
      limitPrice: '30000.0',
      quantity: '0.5',
      expiry: null,
      operator: 'op::1',
      admin: 'ad::1',
    };
    expect(composeCommands(intent, ctx)).toMatchInlineSnapshot(`
      {
        "actAs": [
          "alice::1220a",
        ],
        "commandId": "order-BTC-USDC-1779192000000",
        "commands": [
          {
            "CreateCommand": {
              "createArguments": {
                "admin": "ad::1",
                "baseInstrumentId": "BTC",
                "expiry": null,
                "limitPrice": "30000.0",
                "operator": "op::1",
                "quantity": "0.5",
                "quoteInstrumentId": "USDC",
                "side": "Bid",
                "trader": "alice::1220a",
              },
              "templateId": "#canton-dex-trading:CantonDex.Dex.OrderFundingRequest:OrderFundingRequest",
            },
          },
        ],
      }
    `);
  });

  const swapAllocationSpec = {
    admin: 'ad::1',
    authorizer: { owner: 'alice::1220a', provider: null, id: '' },
    transferLegSides: [],
    settlementDeadline: null,
    nextIterationFunding: { USDC: '1000.0' },
    committed: false,
    meta: { values: {} },
  } as unknown as RequestSwapIntent['allocationSpec'];
  const swapSettlement = {
    executor: 'op::1',
    settlementRef: { id: 'DexPool', cid: 'pool1234567890' },
  } as unknown as RequestSwapIntent['settlement'];

  it('request-swap authors a single AllocationFactory_Allocate', () => {
    const intent: WalletIntent = {
      kind: 'request-swap',
      poolId: 'pool1234567890',
      allocationSpec: swapAllocationSpec,
      settlement: swapSettlement,
      factoryCid: 'factory1',
      allocationFactoryExtraArgs,
      disclosure,
      inputHoldingCids: ['h1'],
    };
    const composed = composeCommands(intent, ctx);
    expect(composed.commands).toHaveLength(1);
    expect(composed.commands[0]).toHaveProperty(
      'ExerciseCommand.choice',
      'AllocationFactory_Allocate',
    );
    expect(composed.commands[0]).toHaveProperty(
      'ExerciseCommand.templateId',
      '#splice-api-token-allocation-instruction-v2:Splice.Api.Token.AllocationInstructionV2:AllocationFactory',
    );
  });

  it('request-swap refuses unconfigured factory', () => {
    const intent: WalletIntent = {
      kind: 'request-swap',
      poolId: 'pool1',
      allocationSpec: swapAllocationSpec,
      settlement: swapSettlement,
      factoryCid: 'PENDING_FACTORY',
      allocationFactoryExtraArgs,
      disclosure,
      inputHoldingCids: [],
    };
    expect(() => composeCommands(intent, ctx)).toThrowError(
      /AllocationFactory CID not configured/,
    );
  });

  // DvP add/remove: the wallet authors one AllocationFactory_Allocate
  // per spec, in canonical order, mapping the right factory + holdings.
  const ALLOC_FACTORY_IID =
    '#splice-api-token-allocation-instruction-v2:Splice.Api.Token.AllocationInstructionV2:AllocationFactory';
  const settlement = { executors: ['op::1'], id: 's1', cid: null, meta: { values: {} } };
  const mkSpec = (
    legId: string,
    instrumentId: string,
    side: 'SenderSide' | 'ReceiverSide',
    committed: boolean,
  ) => ({
    admin: 'reg::1',
    authorizer: { owner: 'alice::1220a', provider: null, id: '' },
    transferLegSides: [
      { transferLegId: legId, side, otherside: { owner: null, provider: null, id: '' }, amount: '1.0', instrumentId, meta: { values: {} } },
    ],
    settlementDeadline: null,
    nextIterationFunding: null,
    committed,
    meta: { values: {} },
  });

  it('add-liquidity = accept + 3 allocations (base+quote deposits, LP receipt)', () => {
    const baseSpec = mkSpec('lp-base-deposit', 'BTC', 'SenderSide', true);
    const quoteSpec = mkSpec('lp-quote-deposit', 'USDC', 'SenderSide', true);
    const receiptSpec = mkSpec('lp-mint', 'BTC-USDC-LP', 'ReceiverSide', false);
    const intent: WalletIntent = {
      kind: 'add-liquidity',
      requestCid: 'reqABCDEFGH12',
      settlement,
      allocations: [baseSpec, quoteSpec, receiptSpec],
      depositFactoryCid: 'depF',
      lpFactoryCid: 'lpF',
      depositFactoryExtraArgs: allocationFactoryExtraArgs,
      lpFactoryExtraArgs,
      allocationRequestExtraArgs,
      disclosure,
      baseHoldingCids: ['b1'],
      quoteHoldingCids: ['q1', 'q2'],
    };
    const out = composeCommands(intent, ctx);
    expect(out.actAs).toEqual(['alice::1220a']);
    // Canonical Token Standard V2 shape: accept first, then 3 allocates.
    expect(out.commands).toHaveLength(4);
    const all = out.commands.map((c) => (c as { ExerciseCommand: { templateId: string; contractId: string; choice: string; choiceArgument: Record<string, unknown> } }).ExerciseCommand);
    // [0] AllocationRequest_Accept on the request, actors + context threaded.
    expect(all[0].choice).toBe('AllocationRequest_Accept');
    expect(all[0].contractId).toBe('reqABCDEFGH12');
    expect(all[0].choiceArgument.actors).toEqual(['alice::1220a']);
    expect(all[0].choiceArgument.extraArgs).toEqual(allocationRequestExtraArgs);
    // [1..3] the three AllocationFactory_Allocate exercises.
    const cmds = all.slice(1);
    expect(cmds.every((c) => c.choice === 'AllocationFactory_Allocate')).toBe(true);
    expect(cmds[0].contractId).toBe('depF');
    expect(cmds[0].choiceArgument.inputHoldingCids).toEqual(['b1']);
    expect(cmds[0].choiceArgument.allocation).toEqual(baseSpec);
    expect(cmds[1].contractId).toBe('depF');
    expect(cmds[1].choiceArgument.inputHoldingCids).toEqual(['q1', 'q2']);
    expect(cmds[2].contractId).toBe('lpF');
    expect(cmds[2].choiceArgument.inputHoldingCids).toEqual([]);
    expect(cmds[2].choiceArgument.allocation).toEqual(receiptSpec);
    expect(cmds[0].templateId).toBe(ALLOC_FACTORY_IID);
    expect(cmds[0].choiceArgument.actors).toEqual(['alice::1220a']);
  });

  it('remove-liquidity = accept + 3 allocations (base+quote receipts, LP burn-sender)', () => {
    const baseRcpt = mkSpec('lp-base-out-0', 'BTC', 'ReceiverSide', false);
    const quoteRcpt = mkSpec('lp-quote-out-0', 'USDC', 'ReceiverSide', false);
    const burnSpec = mkSpec('lp-burn', 'BTC-USDC-LP', 'SenderSide', true);
    const intent: WalletIntent = {
      kind: 'remove-liquidity',
      requestCid: 'reqREMOVE1234',
      settlement,
      allocations: [baseRcpt, quoteRcpt, burnSpec],
      depositFactoryCid: 'depF',
      lpFactoryCid: 'lpF',
      depositFactoryExtraArgs: allocationFactoryExtraArgs,
      lpFactoryExtraArgs,
      allocationRequestExtraArgs,
      disclosure,
      lpHoldingCids: ['lp1', 'lp2'],
    };
    const out = composeCommands(intent, ctx);
    expect(out.commands).toHaveLength(4);
    const all = out.commands.map((c) => (c as { ExerciseCommand: { contractId: string; choice: string; choiceArgument: Record<string, unknown> } }).ExerciseCommand);
    expect(all[0].choice).toBe('AllocationRequest_Accept');
    expect(all[0].contractId).toBe('reqREMOVE1234');
    const cmds = all.slice(1);
    expect(cmds[0].contractId).toBe('depF');
    expect(cmds[0].choiceArgument.inputHoldingCids).toEqual([]);
    expect(cmds[1].contractId).toBe('depF');
    expect(cmds[1].choiceArgument.inputHoldingCids).toEqual([]);
    // burn-sender locks ALL the LP holdings under the LP factory (fragmented
    // LP positions must be redeemable).
    expect(cmds[2].contractId).toBe('lpF');
    expect(cmds[2].choiceArgument.inputHoldingCids).toEqual(['lp1', 'lp2']);
    expect(cmds[2].choiceArgument.allocation).toEqual(burnSpec);
  });

  it('extractCreatedAllocationCids ignores the acceptance-evidence create', () => {
    const intent: WalletIntent = {
      kind: 'add-liquidity',
      requestCid: 'reqABCDEFGH12',
      settlement,
      allocations: [
        mkSpec('lp-base-deposit', 'BTC', 'SenderSide', true),
        mkSpec('lp-quote-deposit', 'USDC', 'SenderSide', true),
        mkSpec('lp-mint', 'BTC-USDC-LP', 'ReceiverSide', false),
      ],
      depositFactoryCid: 'depF',
      lpFactoryCid: 'lpF',
      depositFactoryExtraArgs: allocationFactoryExtraArgs,
      lpFactoryExtraArgs,
      allocationRequestExtraArgs,
      disclosure,
      baseHoldingCids: ['b1'],
      quoteHoldingCids: ['q1'],
    };
    // A realistic submit result: the acceptance receipt + a locked holding +
    // the three Allocation creates, interleaved.
    const tx = {
      createdEvents: [
        { contractId: 'acc1', templateId: 'pkg:CantonDex.Dex.LiquidityAllocationRequest:LiquidityAllocationAcceptance' },
        { contractId: 'hold1', templateId: 'pkg:CantonDex.Registry.V2:Holding' },
        { contractId: 'alloc0', templateId: 'pkg:CantonDex.Registry.V2:Allocation' },
        { contractId: 'alloc1', templateId: 'pkg:CantonDex.Registry.V2:Allocation' },
        { contractId: 'alloc2', templateId: 'pkg:CantonDex.Registry.V2:Allocation' },
      ],
    };
    expect(extractCreatedAllocationCids(intent, tx)).toEqual(['alloc0', 'alloc1', 'alloc2']);
    expect(extractLiquidityAcceptanceCid(tx)).toBe('acc1');
  });

  it('post-rfq-quote', () => {
    const intent: WalletIntent = {
      kind: 'post-rfq-quote',
      rfqCid: 'rfqA',
      rfqId: 'rfq-001',
      price: '30100.5',
      expiresAt: '2026-05-19T12:30:00Z',
      postedAt: '2026-05-19T12:00:00Z',
      tier: 'TierTrusted',
      operator: 'op::1',
      trader: 'trader::1',
    };
    const ctxAsDealer: ComposeContext = { ...ctx, party: 'dealer::1' };
    expect(composeCommands(intent, ctxAsDealer)).toMatchInlineSnapshot(`
      {
        "actAs": [
          "dealer::1",
        ],
        "commandId": "rfq-quote-rfq-001-1779192000000",
        "commands": [
          {
            "CreateCommand": {
              "createArguments": {
                "dealer": "dealer::1",
                "expiresAt": "2026-05-19T12:30:00Z",
                "operator": "op::1",
                "postedAt": "2026-05-19T12:00:00Z",
                "price": "30100.5",
                "rfqId": "rfq-001",
                "tier": "TierTrusted",
                "trader": "trader::1",
              },
              "templateId": "#canton-dex-trading:CantonDex.Dex.Rfq:RfqQuote",
            },
          },
        ],
      }
    `);
  });

  it('accept-rfq carries joint trader+operator actAs', () => {
    const intent: WalletIntent = {
      kind: 'accept-rfq',
      rfqCid: 'rfqAcid1234567890',
      acceptedQuoteCid: 'q1',
      consideredQuoteCids: ['q1', 'q2'],
      admin: 'ad::1',
      operator: 'op::1',
    };
    const out = composeCommands(intent, ctx);
    expect(out.actAs).toEqual(['alice::1220a', 'op::1']);
    expect(out.commands).toHaveLength(1);
    const cmd = out.commands[0] as { ExerciseCommand: { choice: string } };
    expect(cmd.ExerciseCommand.choice).toBe('Rfq_Accept');
  });

  it('accept-rfq refuses missing operator', () => {
    const intent = {
      kind: 'accept-rfq',
      rfqCid: 'r',
      acceptedQuoteCid: 'q',
      consideredQuoteCids: [],
      admin: 'ad::1',
      operator: '',
    } as unknown as WalletIntent;
    expect(() => composeCommands(intent, ctx)).toThrowError(
      /operator party is required/,
    );
  });
});
