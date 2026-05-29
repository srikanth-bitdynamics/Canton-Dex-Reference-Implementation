// Snapshot tests for WalletIntent -> Daml command composition.

import { describe, it, expect } from 'vitest';

import { composeCommands, type ComposeContext } from '@/wallet/commands';
import type { WalletIntent } from '@/wallet/types';

const FIXED_NOW = new Date('2026-05-19T12:00:00.000Z');

const ctx: ComposeContext = {
  party: 'alice::1220a',
  packagePrefix: '#canton-dex-trading',
  now: () => FIXED_NOW,
};

describe('composeCommands', () => {
  it('accept-allocation-request', () => {
    const intent: WalletIntent = {
      kind: 'accept-allocation-request',
      requestCid: 'aaaaaaaaaaaarequest1',
      factoryCid: 'factory1',
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
              "choice": "OrderAllocationRequest_Accept",
              "choiceArgument": {
                "factoryCid": "factory1",
                "inputHoldingCids": [
                  "holding1",
                  "holding2",
                ],
              },
              "contractId": "aaaaaaaaaaaarequest1",
              "templateId": "#canton-dex-trading:CantonDex.Dex.OrderAllocationRequest:OrderAllocationRequest",
            },
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

  it('request-swap', () => {
    const intent: WalletIntent = {
      kind: 'request-swap',
      poolId: 'pool1234567890',
      inputInstrumentId: 'USDC',
      inputAmount: '1000.0',
      outputInstrumentId: 'BTC',
      minOutputAmount: '0.03',
      inputHoldingCids: ['h1'],
      factoryCid: 'factory1',
      operator: 'op::1',
      admin: 'ad::1',
    };
    expect(composeCommands(intent, ctx)).toMatchInlineSnapshot(`
      {
        "actAs": [
          "alice::1220a",
        ],
        "commandId": "swap-pool12345678-1779192000000",
        "commands": [
          {
            "CreateCommand": {
              "createArguments": {
                "admin": "ad::1",
                "factoryCid": "factory1",
                "inputAmount": "1000.0",
                "inputHoldingCids": [
                  "h1",
                ],
                "inputInstrumentId": "USDC",
                "minOutputAmount": "0.03",
                "operator": "op::1",
                "poolCid": "pool1234567890",
                "requestedAt": "2026-05-19T12:00:00.000Z",
                "trader": "alice::1220a",
              },
              "templateId": "#canton-dex-trading:CantonDex.Dex.SwapRequest:SwapRequest",
            },
          },
        ],
      }
    `);
  });

  it('request-swap refuses unconfigured factory', () => {
    const intent: WalletIntent = {
      kind: 'request-swap',
      poolId: 'pool1',
      inputInstrumentId: 'USDC',
      inputAmount: '1.0',
      outputInstrumentId: 'BTC',
      minOutputAmount: '0.0',
      inputHoldingCids: [],
      factoryCid: 'PENDING_FACTORY',
      operator: 'op::1',
      admin: 'ad::1',
    };
    expect(() => composeCommands(intent, ctx)).toThrowError(
      /AllocationFactory CID not configured/,
    );
  });

  // DvP add/remove (DEX-54): the wallet authors one AllocationFactory_Allocate
  // per spec, in canonical order, mapping the right factory + holdings.
  const ALLOC_FACTORY_IID =
    '#splice-api-token-allocation-instruction-v2:Splice.Api.Token.AllocationInstructionV2:AllocationFactory';
  const settlement = { executors: ['op::1'], id: 's1', cid: null, meta: {} };
  const mkSpec = (
    legId: string,
    instrumentId: string,
    side: 'SenderSide' | 'ReceiverSide',
    committed: boolean,
  ) => ({
    admin: 'reg::1',
    authorizer: { owner: 'alice::1220a', provider: null, id: '' },
    transferLegSides: [
      { transferLegId: legId, side, otherside: { owner: null, provider: null, id: '' }, amount: '1.0', instrumentId, meta: {} },
    ],
    settlementDeadline: null,
    nextIterationFunding: null,
    committed,
    meta: {},
  });

  it('add-liquidity authors 3 allocations (base+quote deposits, LP receipt)', () => {
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
      baseHoldingCids: ['b1'],
      quoteHoldingCids: ['q1', 'q2'],
    };
    const out = composeCommands(intent, ctx);
    expect(out.actAs).toEqual(['alice::1220a']);
    expect(out.commands).toHaveLength(3);
    const cmds = out.commands.map((c) => (c as { ExerciseCommand: { contractId: string; choice: string; choiceArgument: Record<string, unknown> } }).ExerciseCommand);
    expect(cmds.every((c) => c.choice === 'AllocationFactory_Allocate')).toBe(true);
    // base deposit → deposit factory, base holdings
    expect(cmds[0].contractId).toBe('depF');
    expect(cmds[0].choiceArgument.inputHoldingCids).toEqual(['b1']);
    expect(cmds[0].choiceArgument.allocation).toEqual(baseSpec);
    // quote deposit → deposit factory, quote holdings
    expect(cmds[1].contractId).toBe('depF');
    expect(cmds[1].choiceArgument.inputHoldingCids).toEqual(['q1', 'q2']);
    // LP receipt → LP factory, no input holdings
    expect(cmds[2].contractId).toBe('lpF');
    expect(cmds[2].choiceArgument.inputHoldingCids).toEqual([]);
    expect(cmds[2].choiceArgument.allocation).toEqual(receiptSpec);
    // interface-targeted exercise + actors threaded
    expect((out.commands[0] as { ExerciseCommand: { templateId: string } }).ExerciseCommand.templateId).toBe(ALLOC_FACTORY_IID);
    expect(cmds[0].choiceArgument.actors).toEqual(['alice::1220a']);
  });

  it('remove-liquidity authors 3 allocations (base+quote receipts, LP burn-sender)', () => {
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
      lpHoldingCids: ['lp1', 'lp2'],
    };
    const out = composeCommands(intent, ctx);
    expect(out.commands).toHaveLength(3);
    const cmds = out.commands.map((c) => (c as { ExerciseCommand: { contractId: string; choiceArgument: Record<string, unknown> } }).ExerciseCommand);
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
