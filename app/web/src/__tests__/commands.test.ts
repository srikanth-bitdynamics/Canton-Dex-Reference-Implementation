// Snapshot tests for the WalletIntent -> Daml command tree mapping.
//
// One test per intent. The test fixes a deterministic clock and party,
// composes the command tree, and asserts the full shape. If any
// composer changes its emitted commands, the snapshot fails and a
// reviewer must approve the diff — that is the audit boundary.

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

  it('add-liquidity', () => {
    const intent: WalletIntent = {
      kind: 'add-liquidity',
      poolId: 'poolABCDEFGH12',
      baseAmount: '0.1',
      quoteAmount: '3000.0',
      baseHoldingCids: ['b1'],
      quoteHoldingCids: ['q1', 'q2'],
      minLpTokens: '0.0',
      factoryCid: 'factory1',
      operator: 'op::1',
      admin: 'ad::1',
    };
    expect(composeCommands(intent, ctx)).toMatchInlineSnapshot(`
      {
        "actAs": [
          "alice::1220a",
        ],
        "commandId": "add-lp-poolABCDEFGH-1779192000000",
        "commands": [
          {
            "CreateCommand": {
              "createArguments": {
                "admin": "ad::1",
                "baseAmount": "0.1",
                "baseHoldingCids": [
                  "b1",
                ],
                "factoryCid": "factory1",
                "minLpTokens": "0.0",
                "operator": "op::1",
                "poolCid": "poolABCDEFGH12",
                "quoteAmount": "3000.0",
                "quoteHoldingCids": [
                  "q1",
                  "q2",
                ],
                "requestedAt": "2026-05-19T12:00:00.000Z",
                "trader": "alice::1220a",
              },
              "templateId": "#canton-dex-trading:CantonDex.Dex.LiquidityRequest:AddLiquidityRequest",
            },
          },
        ],
      }
    `);
  });

  it('accept-lp-burn', () => {
    const intent: WalletIntent = {
      kind: 'accept-lp-burn',
      burnRequestCid: 'burnreq1234567890',
      holderHoldingCid: 'lpholding1',
      hint: { lpInstrumentId: 'BTC-USDC-LP', amount: '10.0' },
    };
    expect(composeCommands(intent, ctx)).toMatchInlineSnapshot(`
      {
        "actAs": [
          "alice::1220a",
        ],
        "commandId": "lp-burn-burnreq12345-1779192000000",
        "commands": [
          {
            "ExerciseCommand": {
              "choice": "LPTokenPolicy_AcceptBurn",
              "choiceArgument": {
                "holderHoldingCid": "lpholding1",
              },
              "contractId": "burnreq1234567890",
              "templateId": "#canton-dex-trading:CantonDex.Dex.LPToken:LPTokenPolicy",
            },
          },
        ],
      }
    `);
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
