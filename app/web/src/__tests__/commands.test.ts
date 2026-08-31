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
const REQUESTED_AT = FIXED_NOW.toISOString();

const ctx: ComposeContext = {
  party: 'alice::1220a',
  packagePrefix: '#canton-dex-trading-v2',
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
    createdEventBlob: 'payload',
  },
];

describe('composeCommands', () => {
  // A prefunded order lock spec: no transfer legs, funded through
  // nextIterationFunding under the lock admin.
  const orderFundingSpec = (admin: string, instrumentId: string, amount: string) => ({
    admin,
    authorizer: { owner: 'alice::1220a', provider: null, id: '' },
    transferLegSides: [],
    settlementDeadline: null,
    nextIterationFunding: { [instrumentId]: amount },
    committed: true,
    meta: { values: {} },
  });
  // A cross-admin order's counter-admin receipt: zero funding, locks nothing.
  const orderReceiptSpec = (admin: string) => ({
    admin,
    authorizer: { owner: 'alice::1220a', provider: null, id: '' },
    transferLegSides: [],
    settlementDeadline: null,
    nextIterationFunding: {},
    committed: true,
    meta: { values: {} },
  });

  it('fund-order (single admin) = accept + one batched allocate', () => {
    const intent: WalletIntent = {
      kind: 'fund-order',
      requestCid: 'orderReqABCDEF',
      settlement: { executors: ['op::1'], id: 'DexOrder-web-1', cid: null, meta: { values: {} } },
      allocations: [orderFundingSpec('ad::1', 'USDCx', '100.0')],
      requestedAt: REQUESTED_AT,
      factoryCids: ['factory1'],
      allocationFactoryExtraArgs: [allocationFactoryExtraArgs],
      allocationRequestExtraArgs,
      disclosure,
      inputHoldingCids: ['holding1', 'holding2'],
      hint: { instrumentId: 'USDCx', amount: '100.0' },
    };
    const out = composeCommands(intent, ctx);
    expect(out.actAs).toEqual(['alice::1220a']);
    expect(out.commandId).toMatch(/^order-fund-batch-/);
    expect(out.commands).toHaveLength(1);
    const cmd = (out.commands[0] as { CreateAndExerciseCommand: { templateId: string; choice: string; choiceArgument: Record<string, unknown> } }).CreateAndExerciseCommand;
    expect(cmd.templateId).toContain('Splice.Util.Token.Wallet.BatchingUtilityV2:BatchingUtility');
    expect(cmd.choice).toBe('BatchingUtility_ExecuteBatch');
    const arg = cmd.choiceArgument as {
      inputHoldingMap: { byAdminAndAccount: [Record<string, unknown>, Record<string, string[]>][] };
      actions: { tag: string; value: { cid: string; arg: Record<string, unknown> } }[];
    };
    // Order funding accepts the OrderAllocationRequest the standard way, then
    // authors the funding allocation.
    expect(arg.actions.map((a) => a.tag)).toEqual([
      'TSA_AllocationRequest_AcceptV2',
      'TSA_AllocationFactory_AllocateV2',
    ]);
    expect(arg.actions[0].value.cid).toBe('orderReqABCDEF');
    expect(arg.actions[1].value.cid).toBe('factory1');
    expect(arg.actions[1].value.arg.inputHoldingCids).toEqual([]);
    expect(arg.actions[1].value.arg.extraArgs).toEqual(allocationFactoryExtraArgs);
    // The funding holdings thread through the map, keyed by the lock instrument
    // read from nextIterationFunding (there is no sender leg to read it from).
    expect(arg.inputHoldingMap.byAdminAndAccount).toHaveLength(1);
    const [scoped, byInstrument] = arg.inputHoldingMap.byAdminAndAccount[0];
    expect(scoped).toEqual({
      admin: 'ad::1',
      account: { owner: 'alice::1220a', provider: null, id: '' },
    });
    expect(byInstrument).toEqual({ USDCx: ['holding1', 'holding2'] });
    expect(out.disclosedContracts).toEqual(disclosure);
  });

  it('fund-order (cross admin) accepts + authors funding + receipt in one batch', () => {
    const intent: WalletIntent = {
      kind: 'fund-order',
      requestCid: 'orderReqXADMIN',
      settlement: { executors: ['op::1'], id: 'DexOrder-web-2', cid: null, meta: { values: {} } },
      // Bid on Amulet@base / USDCx@quote: lock quote, receipt on base.
      allocations: [
        orderFundingSpec('quote-ad::1', 'USDCx', '100.0'),
        orderReceiptSpec('base-ad::1'),
      ],
      requestedAt: REQUESTED_AT,
      factoryCids: ['quoteFactory', 'baseFactory'],
      allocationFactoryExtraArgs: [allocationFactoryExtraArgs, lpFactoryExtraArgs],
      allocationRequestExtraArgs,
      disclosure,
      inputHoldingCids: ['q1'],
      hint: { instrumentId: 'USDCx', amount: '100.0' },
    };
    const out = composeCommands(intent, ctx);
    expect(out.commands).toHaveLength(1);
    const arg = (out.commands[0] as { CreateAndExerciseCommand: { choiceArgument: Record<string, unknown> } }).CreateAndExerciseCommand.choiceArgument as {
      inputHoldingMap: { byAdminAndAccount: [Record<string, unknown>, Record<string, string[]>][] };
      actions: { tag: string; value: { cid: string } }[];
    };
    // Accept the request, then author both allocations.
    expect(arg.actions.map((a) => a.tag)).toEqual([
      'TSA_AllocationRequest_AcceptV2',
      'TSA_AllocationFactory_AllocateV2',
      'TSA_AllocationFactory_AllocateV2',
    ]);
    expect(arg.actions[0].value.cid).toBe('orderReqXADMIN');
    expect(arg.actions.slice(1).map((a) => a.value.cid)).toEqual(['quoteFactory', 'baseFactory']);
    // Only the lock-admin funding spec draws holdings; the receipt locks nothing.
    expect(arg.inputHoldingMap.byAdminAndAccount).toHaveLength(1);
    const [scoped, byInstrument] = arg.inputHoldingMap.byAdminAndAccount[0];
    expect(scoped).toEqual({
      admin: 'quote-ad::1',
      account: { owner: 'alice::1220a', provider: null, id: '' },
    });
    expect(byInstrument).toEqual({ USDCx: ['q1'] });
    // Two created allocation cids expected for the cross-admin order.
    const tx = {
      createdEvents: [
        { contractId: 'fund0', templateId: 'pkg:CantonDex.Registry.V2:Allocation' },
        { contractId: 'rcpt1', templateId: 'pkg:CantonDex.Registry.V2:Allocation' },
      ],
    };
    expect(extractCreatedAllocationCids(intent, tx)).toEqual(['fund0', 'rcpt1']);
  });

  it('place-order', () => {
    const intent: WalletIntent = {
      kind: 'place-order',
      pair: {
        base: { admin: 'ad::1', id: 'Amulet' },
        quote: { admin: 'ad::1', id: 'USDCx' },
      },
      side: 'Bid',
      limitPrice: '30000.0',
      quantity: '0.5',
      expiry: null,
      operator: 'op::1',
    };
    expect(composeCommands(intent, ctx)).toMatchInlineSnapshot(`
      {
        "actAs": [
          "alice::1220a",
        ],
        "commandId": "order-Amulet-USDCx-1779192000000",
        "commands": [
          {
            "CreateCommand": {
              "createArguments": {
                "baseInstrumentId": {
                  "admin": "ad::1",
                  "id": "Amulet",
                },
                "expiry": null,
                "limitPrice": "30000.0",
                "operator": "op::1",
                "quantity": "0.5",
                "quoteInstrumentId": {
                  "admin": "ad::1",
                  "id": "USDCx",
                },
                "side": "Bid",
                "trader": "alice::1220a",
              },
              "templateId": "#canton-dex-trading-v2:CantonDex.Dex.OrderFundingRequest:OrderFundingRequest",
            },
          },
        ],
      }
    `);
  });

  const opAccount = { owner: 'op::1', provider: null, id: '' };
  const swapInLeg = (instrumentId: string, amount: string): RequestSwapIntent['allocations'][number]['transferLegSides'][number] => ({
    transferLegId: 'swap-in', side: 'SenderSide',
    otherside: opAccount, amount, instrumentId, meta: { values: {} },
  });
  const swapOutLeg = (instrumentId: string, amount: string): RequestSwapIntent['allocations'][number]['transferLegSides'][number] => ({
    transferLegId: 'swap-out-0', side: 'ReceiverSide',
    otherside: opAccount, amount, instrumentId, meta: { values: {} },
  });
  const swapSpec = (
    admin: string,
    legs: RequestSwapIntent['allocations'][number]['transferLegSides'],
  ): RequestSwapIntent['allocations'][number] => ({
    admin,
    authorizer: { owner: 'alice::1220a', provider: null, id: '' },
    transferLegSides: legs,
    settlementDeadline: null,
    nextIterationFunding: null,
    committed: false,
    meta: { values: {} },
  });
  const swapSettlement = {
    executors: ['op::1'], id: 'DexPool', cid: 'pool1234567890', meta: { values: {} },
  };

  it('request-swap (single admin) = accept + one combined allocation', () => {
    const intent: WalletIntent = {
      kind: 'request-swap',
      poolId: 'pool1234567890',
      requestCid: 'swapReqSINGLE',
      settlement: swapSettlement,
      allocations: [swapSpec('ad::1', [swapInLeg('Amulet', '0.1'), swapOutLeg('USDCx', '1974.31')])],
      requestedAt: REQUESTED_AT,
      factoryCids: ['factory1'],
      allocationFactoryExtraArgs: [allocationFactoryExtraArgs],
      allocationRequestExtraArgs,
      disclosure,
      inputHoldingCids: ['h1'],
    };
    const out = composeCommands(intent, ctx);
    expect(out.commandId).toMatch(/^swap-batch-/);
    expect(out.commands).toHaveLength(1);
    const cmd = (out.commands[0] as { CreateAndExerciseCommand: { choice: string; choiceArgument: Record<string, unknown> } }).CreateAndExerciseCommand;
    expect(cmd.choice).toBe('BatchingUtility_ExecuteBatch');
    const arg = cmd.choiceArgument as {
      inputHoldingMap: { byAdminAndAccount: [Record<string, unknown>, Record<string, string[]>][] };
      actions: { tag: string; value: { cid: string; arg: { requestedAt: string } } }[];
    };
    // Swap accepts the request, then authors the single combined spec.
    expect(arg.actions.map((a) => a.tag)).toEqual([
      'TSA_AllocationRequest_AcceptV2',
      'TSA_AllocationFactory_AllocateV2',
    ]);
    expect(arg.actions[0].value.cid).toBe('swapReqSINGLE');
    expect(arg.actions[1].value.cid).toBe('factory1');
    expect(arg.actions[1].value.arg.requestedAt).toBe(REQUESTED_AT);
    // Input holdings routed by the swap-in sender leg's instrument.
    expect(arg.inputHoldingMap.byAdminAndAccount).toHaveLength(1);
    expect(arg.inputHoldingMap.byAdminAndAccount[0][1]).toEqual({ Amulet: ['h1'] });
  });

  it('request-swap (cross admin) = accept + input allocation + output receipt', () => {
    const intent: WalletIntent = {
      kind: 'request-swap',
      poolId: 'pool1234567890',
      requestCid: 'swapReqXADMIN',
      settlement: swapSettlement,
      allocations: [
        swapSpec('cc-admin', [swapInLeg('Amulet', '0.1')]),
        swapSpec('usdc-admin', [swapOutLeg('USDCx', '1974.31')]),
      ],
      requestedAt: REQUESTED_AT,
      factoryCids: ['ccFactory', 'usdcFactory'],
      allocationFactoryExtraArgs: [allocationFactoryExtraArgs, lpFactoryExtraArgs],
      allocationRequestExtraArgs,
      disclosure,
      inputHoldingCids: ['h1'],
    };
    const out = composeCommands(intent, ctx);
    expect(out.commands).toHaveLength(1);
    const arg = (out.commands[0] as { CreateAndExerciseCommand: { choiceArgument: Record<string, unknown> } }).CreateAndExerciseCommand.choiceArgument as {
      inputHoldingMap: { byAdminAndAccount: [Record<string, unknown>, Record<string, string[]>][] };
      actions: { tag: string; value: { cid: string } }[];
    };
    expect(arg.actions.map((a) => a.tag)).toEqual([
      'TSA_AllocationRequest_AcceptV2',
      'TSA_AllocationFactory_AllocateV2',
      'TSA_AllocationFactory_AllocateV2',
    ]);
    // Factories in canonical admin order: input admin first, output admin next.
    expect(arg.actions.slice(1).map((a) => a.value.cid)).toEqual(['ccFactory', 'usdcFactory']);
    // Only the input (sender) spec draws holdings; the output receipt locks nothing.
    expect(arg.inputHoldingMap.byAdminAndAccount).toHaveLength(1);
    const [scoped, byInstrument] = arg.inputHoldingMap.byAdminAndAccount[0];
    expect(scoped).toEqual({
      admin: 'cc-admin',
      account: { owner: 'alice::1220a', provider: null, id: '' },
    });
    expect(byInstrument).toEqual({ Amulet: ['h1'] });
    // Two created allocation cids, input admin first.
    const tx = {
      createdEvents: [
        { contractId: 'inAlloc', templateId: 'pkg:CantonDex.Registry.V2:Allocation' },
        { contractId: 'outAlloc', templateId: 'pkg:CantonDex.Registry.V2:Allocation' },
      ],
    };
    expect(extractCreatedAllocationCids(intent, tx)).toEqual(['inAlloc', 'outAlloc']);
  });

  it('request-swap refuses unconfigured factory', () => {
    const intent: WalletIntent = {
      kind: 'request-swap',
      poolId: 'pool1',
      requestCid: 'swapReqSINGLE',
      settlement: swapSettlement,
      allocations: [swapSpec('ad::1', [swapInLeg('Amulet', '0.1'), swapOutLeg('USDCx', '1974.31')])],
      requestedAt: REQUESTED_AT,
      factoryCids: ['PENDING_FACTORY'],
      allocationFactoryExtraArgs: [allocationFactoryExtraArgs],
      allocationRequestExtraArgs,
      disclosure,
      inputHoldingCids: [],
    };
    expect(() => composeCommands(intent, ctx)).toThrowError(
      /AllocationFactory CID not configured/,
    );
  });

  // DvP add/remove: the wallet authors one AllocationFactory_Allocate
  // per spec, in canonical order, mapping the right factory + holdings.
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
    const baseSpec = mkSpec('lp-base-deposit', 'Amulet', 'SenderSide', true);
    const quoteSpec = mkSpec('lp-quote-deposit', 'USDCx', 'SenderSide', true);
    const receiptSpec = mkSpec('lp-mint', 'Amulet-USDCx-LP', 'ReceiverSide', false);
    const intent: WalletIntent = {
      kind: 'add-liquidity',
      requestCid: 'reqABCDEFGH12',
      settlement,
      allocations: [baseSpec, quoteSpec, receiptSpec],
      requestedAt: REQUESTED_AT,
      factoryCids: ['depF', 'depF', 'lpF'],
      allocationFactoryExtraArgs: [
        allocationFactoryExtraArgs,
        allocationFactoryExtraArgs,
        lpFactoryExtraArgs,
      ],
      allocationRequestExtraArgs,
      disclosure,
      baseHoldingCids: ['b1'],
      quoteHoldingCids: ['q1', 'q2'],
    };
    const out = composeCommands(intent, ctx);
    expect(out.actAs).toEqual(['alice::1220a']);
    // One CreateAndExercise of the standard BatchingUtilityV2 accepts the
    // request and authors all three allocations inside one Daml transaction.
    expect(out.commands).toHaveLength(1);
    const cmd = (out.commands[0] as { CreateAndExerciseCommand: { templateId: string; createArguments: Record<string, unknown>; choice: string; choiceArgument: Record<string, unknown> } }).CreateAndExerciseCommand;
    expect(cmd.templateId).toContain('Splice.Util.Token.Wallet.BatchingUtilityV2:BatchingUtility');
    expect(cmd.createArguments).toEqual({ user: 'alice::1220a' });
    expect(cmd.choice).toBe('BatchingUtility_ExecuteBatch');
    const arg = cmd.choiceArgument as {
      inputHoldingMap: { byAdminAndAccount: [Record<string, unknown>, Record<string, string[]>][] };
      actions: { tag: string; value: { cid: string; arg: Record<string, unknown> } }[];
      archiveAfterExecution: boolean;
    };
    expect(arg.archiveAfterExecution).toBe(true);
    // Action 0 accepts the request; actions 1..3 allocate [base, quote, LP]
    // against the right factory, funded via the holding map (not per-call).
    expect(arg.actions.map((a) => a.tag)).toEqual([
      'TSA_AllocationRequest_AcceptV2',
      'TSA_AllocationFactory_AllocateV2',
      'TSA_AllocationFactory_AllocateV2',
      'TSA_AllocationFactory_AllocateV2',
    ]);
    expect(arg.actions[0].value.cid).toBe('reqABCDEFGH12');
    expect(arg.actions[0].value.arg.actors).toEqual(['alice::1220a']);
    expect(arg.actions.slice(1).map((a) => a.value.cid)).toEqual(['depF', 'depF', 'lpF']);
    for (const a of arg.actions.slice(1)) {
      expect(a.value.arg.inputHoldingCids).toEqual([]);
      expect(a.value.arg.requestedAt).toBe(REQUESTED_AT);
    }
    expect(arg.actions.slice(1).map((a) => a.value.arg.extraArgs)).toEqual([
      allocationFactoryExtraArgs,
      allocationFactoryExtraArgs,
      lpFactoryExtraArgs,
    ]);
    // Both deposits share one (admin, account) bucket, keyed per instrument.
    expect(arg.inputHoldingMap.byAdminAndAccount).toHaveLength(1);
    const [scoped, byInstrument] = arg.inputHoldingMap.byAdminAndAccount[0];
    expect(scoped).toEqual({
      admin: 'reg::1',
      account: { owner: 'alice::1220a', provider: null, id: '' },
    });
    expect(byInstrument).toEqual({ Amulet: ['b1'], USDCx: ['q1', 'q2'] });
  });

  it('remove-liquidity = single batched ExecuteBatch command (base+quote receipts, LP burn-sender)', () => {
    const baseRcpt = mkSpec('lp-base-out-0', 'Amulet', 'ReceiverSide', false);
    const quoteRcpt = mkSpec('lp-quote-out-0', 'USDCx', 'ReceiverSide', false);
    const burnSpec = mkSpec('lp-burn', 'Amulet-USDCx-LP', 'SenderSide', true);
    const intent: WalletIntent = {
      kind: 'remove-liquidity',
      requestCid: 'reqREMOVE1234',
      settlement,
      allocations: [baseRcpt, quoteRcpt, burnSpec],
      requestedAt: REQUESTED_AT,
      factoryCids: ['depF', 'depF', 'lpF'],
      allocationFactoryExtraArgs: [
        allocationFactoryExtraArgs,
        allocationFactoryExtraArgs,
        lpFactoryExtraArgs,
      ],
      allocationRequestExtraArgs,
      disclosure,
      lpHoldingCids: ['lp1', 'lp2'],
    };
    const out = composeCommands(intent, ctx);
    // One top-level command, mirroring add.
    expect(out.commands).toHaveLength(1);
    const cmd = (out.commands[0] as { CreateAndExerciseCommand: { choice: string; choiceArgument: Record<string, unknown> } }).CreateAndExerciseCommand;
    expect(cmd.choice).toBe('BatchingUtility_ExecuteBatch');
    const arg = cmd.choiceArgument as {
      inputHoldingMap: { byAdminAndAccount: [Record<string, unknown>, Record<string, string[]>][] };
      actions: { tag: string; value: { cid: string; arg: { requestedAt: string } } }[];
    };
    expect(arg.actions[0].tag).toBe('TSA_AllocationRequest_AcceptV2');
    expect(arg.actions[0].value.cid).toBe('reqREMOVE1234');
    expect(arg.actions.slice(1).map((a) => a.value.cid)).toEqual(['depF', 'depF', 'lpF']);
    expect(
      arg.actions.slice(1).map((a) => a.value.arg.requestedAt),
    ).toEqual([REQUESTED_AT, REQUESTED_AT, REQUESTED_AT]);
    // Only the burn-sender (LP) funds from holdings; the two receipts lock
    // nothing. ALL fragmented LP holdings are threaded so any position redeems.
    expect(arg.inputHoldingMap.byAdminAndAccount).toHaveLength(1);
    expect(arg.inputHoldingMap.byAdminAndAccount[0][1]).toEqual({
      'Amulet-USDCx-LP': ['lp1', 'lp2'],
    });
  });

  it('extractCreatedAllocationCids ignores the acceptance-evidence create', () => {
    const intent: WalletIntent = {
      kind: 'add-liquidity',
      requestCid: 'reqABCDEFGH12',
      settlement,
      allocations: [
        mkSpec('lp-base-deposit', 'Amulet', 'SenderSide', true),
        mkSpec('lp-quote-deposit', 'USDCx', 'SenderSide', true),
        mkSpec('lp-mint', 'Amulet-USDCx-LP', 'ReceiverSide', false),
      ],
      requestedAt: REQUESTED_AT,
      factoryCids: ['depF', 'depF', 'lpF'],
      allocationFactoryExtraArgs: [
        allocationFactoryExtraArgs,
        allocationFactoryExtraArgs,
        lpFactoryExtraArgs,
      ],
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

  it('fund-matched-trade (cross admin) = accept + sender + receiver, only sender funds', () => {
    // A cross-admin buy: USDCx sender leg (funded) under usdc-admin, Amulet
    // receiver leg (locks nothing) under cc-admin.
    const senderSpec = swapSpec('usdc-admin', [
      {
        transferLegId: 'leg-quote', side: 'SenderSide', otherside: opAccount,
        amount: '1000.0', instrumentId: 'USDCx', meta: { values: {} },
      },
    ]);
    const receiverSpec = swapSpec('cc-admin', [
      {
        transferLegId: 'leg-base', side: 'ReceiverSide', otherside: opAccount,
        amount: '0.1', instrumentId: 'Amulet', meta: { values: {} },
      },
    ]);
    const intent: WalletIntent = {
      kind: 'fund-matched-trade',
      requestCid: 'tradeReqXADMIN',
      settlement: { executors: ['op::1'], id: 'MatchedTrade', cid: 'trade-1', meta: { values: {} } },
      allocations: [senderSpec, receiverSpec],
      requestedAt: REQUESTED_AT,
      factoryCids: ['usdcFactory', 'ccFactory'],
      allocationFactoryExtraArgs: [allocationFactoryExtraArgs, lpFactoryExtraArgs],
      allocationRequestExtraArgs,
      disclosure,
      inputHoldingCids: ['h-usdc'],
    };
    const out = composeCommands(intent, ctx);
    expect(out.commandId).toMatch(/^trade-fund-batch-/);
    expect(out.commands).toHaveLength(1);
    const arg = (out.commands[0] as { CreateAndExerciseCommand: { choiceArgument: Record<string, unknown> } }).CreateAndExerciseCommand.choiceArgument as {
      inputHoldingMap: { byAdminAndAccount: [Record<string, unknown>, Record<string, string[]>][] };
      actions: { tag: string; value: { cid: string } }[];
    };
    // Accept the TradeAllocationRequest, then author both specs.
    expect(arg.actions.map((a) => a.tag)).toEqual([
      'TSA_AllocationRequest_AcceptV2',
      'TSA_AllocationFactory_AllocateV2',
      'TSA_AllocationFactory_AllocateV2',
    ]);
    expect(arg.actions[0].value.cid).toBe('tradeReqXADMIN');
    expect(arg.actions.slice(1).map((a) => a.value.cid)).toEqual(['usdcFactory', 'ccFactory']);
    // Only the USDCx sender spec draws holdings.
    expect(arg.inputHoldingMap.byAdminAndAccount).toHaveLength(1);
    const [scoped, byInstrument] = arg.inputHoldingMap.byAdminAndAccount[0];
    expect(scoped).toEqual({
      admin: 'usdc-admin',
      account: { owner: 'alice::1220a', provider: null, id: '' },
    });
    expect(byInstrument).toEqual({ USDCx: ['h-usdc'] });
    // Both created allocation cids extracted, in spec order.
    const tx = {
      createdEvents: [
        { contractId: 'sendAlloc', templateId: 'pkg:CantonDex.Registry.V2:Allocation' },
        { contractId: 'recvAlloc', templateId: 'pkg:CantonDex.Registry.V2:Allocation' },
      ],
    };
    expect(extractCreatedAllocationCids(intent, tx)).toEqual(['sendAlloc', 'recvAlloc']);
  });

});
