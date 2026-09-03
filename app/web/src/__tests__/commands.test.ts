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

// The Token Standard V2 AllocationFactory interface id the external-wallet path
// exercises directly (no BatchingUtilityV2 wrapper).
const ALLOCATION_FACTORY_TID =
  '#splice-api-token-allocation-instruction-v2:Splice.Api.Token.AllocationInstructionV2:AllocationFactory';

interface ExerciseCmd {
  templateId: string;
  contractId: string;
  choice: string;
  choiceArgument: {
    settlement: unknown;
    allocation: unknown;
    requestedAt: string;
    inputHoldingCids: string[];
    extraArgs: unknown;
    actors: string[];
  };
}

// Every command an allocation-authoring flow emits is a direct ExerciseCommand.
function exercisesOf(out: { commands: unknown[] }): ExerciseCmd[] {
  return out.commands.map((c) => {
    expect(c).toHaveProperty('ExerciseCommand');
    return (c as { ExerciseCommand: ExerciseCmd }).ExerciseCommand;
  });
}

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

  it('fund-order (single admin) = one direct allocate carrying the funding cids', () => {
    const spec = orderFundingSpec('ad::1', 'USDCx', '100.0');
    const intent: WalletIntent = {
      kind: 'fund-order',
      requestCid: 'orderReqABCDEF',
      settlement: { executors: ['op::1'], id: 'DexOrder-web-1', cid: null, meta: { values: {} } },
      allocations: [spec],
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
    // One allocation, so one direct AllocationFactory_Allocate exercise.
    expect(out.commands).toHaveLength(1);
    const [cmd] = exercisesOf(out);
    expect(cmd.templateId).toBe(ALLOCATION_FACTORY_TID);
    expect(cmd.contractId).toBe('factory1');
    expect(cmd.choice).toBe('AllocationFactory_Allocate');
    // The funding leg carries its real per-leg holdings directly (no holding map).
    expect(cmd.choiceArgument.inputHoldingCids).toEqual(['holding1', 'holding2']);
    expect(cmd.choiceArgument.extraArgs).toEqual(allocationFactoryExtraArgs);
    expect(cmd.choiceArgument.actors).toEqual(['alice::1220a']);
    expect(cmd.choiceArgument.settlement).toEqual(intent.settlement);
    expect(cmd.choiceArgument.allocation).toEqual(spec);
    expect(cmd.choiceArgument.requestedAt).toBe(REQUESTED_AT);
    expect(out.disclosedContracts).toEqual(disclosure);
  });

  it('fund-order (cross admin) authors funding + receipt in one batch', () => {
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
    // Two allocations (funding + receipt), so two direct exercises.
    expect(out.commands).toHaveLength(2);
    const cmds = exercisesOf(out);
    expect(cmds.every((c) => c.choice === 'AllocationFactory_Allocate')).toBe(true);
    expect(cmds.every((c) => c.templateId === ALLOCATION_FACTORY_TID)).toBe(true);
    expect(cmds.map((c) => c.contractId)).toEqual(['quoteFactory', 'baseFactory']);
    // Only the lock-admin funding spec draws holdings; the receipt locks nothing.
    expect(cmds[0].choiceArgument.inputHoldingCids).toEqual(['q1']);
    expect(cmds[1].choiceArgument.inputHoldingCids).toEqual([]);
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

  it('request-swap (single admin) = one combined allocation', () => {
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
    // Single-admin swap collapses to one combined spec = one direct exercise.
    expect(out.commands).toHaveLength(1);
    const [cmd] = exercisesOf(out);
    expect(cmd.choice).toBe('AllocationFactory_Allocate');
    expect(cmd.contractId).toBe('factory1');
    expect(cmd.choiceArgument.requestedAt).toBe(REQUESTED_AT);
    // The swap-in (funding) spec carries its input holding cids directly.
    expect(cmd.choiceArgument.inputHoldingCids).toEqual(['h1']);
  });

  it('request-swap (cross admin) = input allocation + output receipt', () => {
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
    // Cross-admin swap = two direct exercises, input admin first.
    expect(out.commands).toHaveLength(2);
    const cmds = exercisesOf(out);
    expect(cmds.every((c) => c.choice === 'AllocationFactory_Allocate')).toBe(true);
    // Factories in canonical admin order: input admin first, output admin next.
    expect(cmds.map((c) => c.contractId)).toEqual(['ccFactory', 'usdcFactory']);
    // Only the input (sender) spec draws holdings; the output receipt locks nothing.
    expect(cmds[0].choiceArgument.inputHoldingCids).toEqual(['h1']);
    expect(cmds[1].choiceArgument.inputHoldingCids).toEqual([]);
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

  it('add-liquidity = 3 allocations (base+quote deposits, LP receipt)', () => {
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
    // Three direct AllocationFactory_Allocate exercises in one atomic transaction.
    expect(out.commands).toHaveLength(3);
    const cmds = exercisesOf(out);
    expect(cmds.every((c) => c.templateId === ALLOCATION_FACTORY_TID)).toBe(true);
    expect(cmds.every((c) => c.choice === 'AllocationFactory_Allocate')).toBe(true);
    // Exercises allocate [base, quote, LP] against the right factory.
    expect(cmds.map((c) => c.contractId)).toEqual(['depF', 'depF', 'lpF']);
    expect(cmds[0].choiceArgument.actors).toEqual(['alice::1220a']);
    for (const c of cmds) {
      expect(c.choiceArgument.requestedAt).toBe(REQUESTED_AT);
    }
    // The two deposits carry their per-leg holdings; the LP receipt locks nothing.
    expect(cmds.map((c) => c.choiceArgument.inputHoldingCids)).toEqual([
      ['b1'],
      ['q1', 'q2'],
      [],
    ]);
    expect(cmds.map((c) => c.choiceArgument.extraArgs)).toEqual([
      allocationFactoryExtraArgs,
      allocationFactoryExtraArgs,
      lpFactoryExtraArgs,
    ]);
  });

  it('remove-liquidity = three direct exercises (base+quote receipts, LP burn-sender)', () => {
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
    // Three direct exercises, mirroring add.
    expect(out.commands).toHaveLength(3);
    const cmds = exercisesOf(out);
    expect(cmds.every((c) => c.choice === 'AllocationFactory_Allocate')).toBe(true);
    expect(cmds.map((c) => c.contractId)).toEqual(['depF', 'depF', 'lpF']);
    expect(cmds.map((c) => c.choiceArgument.requestedAt)).toEqual([
      REQUESTED_AT,
      REQUESTED_AT,
      REQUESTED_AT,
    ]);
    // Only the burn-sender (LP) funds from holdings; the two receipts lock
    // nothing. ALL fragmented LP holdings ride the burn exercise so any position
    // redeems.
    expect(cmds.map((c) => c.choiceArgument.inputHoldingCids)).toEqual([
      [],
      [],
      ['lp1', 'lp2'],
    ]);
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

  it('fund-matched-trade (cross admin) = sender + receiver, only sender funds', () => {
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
    // Sender + receiver = two direct exercises.
    expect(out.commands).toHaveLength(2);
    const cmds = exercisesOf(out);
    expect(cmds.every((c) => c.choice === 'AllocationFactory_Allocate')).toBe(true);
    expect(cmds.map((c) => c.contractId)).toEqual(['usdcFactory', 'ccFactory']);
    // Only the USDCx sender spec draws holdings; the receiver locks nothing.
    expect(cmds[0].choiceArgument.inputHoldingCids).toEqual(['h-usdc']);
    expect(cmds[1].choiceArgument.inputHoldingCids).toEqual([]);
    // Both created allocation cids extracted, in spec order.
    const tx = {
      createdEvents: [
        { contractId: 'sendAlloc', templateId: 'pkg:CantonDex.Registry.V2:Allocation' },
        { contractId: 'recvAlloc', templateId: 'pkg:CantonDex.Registry.V2:Allocation' },
      ],
    };
    expect(extractCreatedAllocationCids(intent, tx)).toEqual(['sendAlloc', 'recvAlloc']);
  });

  // The external-wallet invariant: every allocation-authoring flow emits ONLY
  // direct Token-Standard AllocationFactory_Allocate exercises against the asset
  // registry's factory — never a DEX (canton-dex-trading-v2 / CantonDex.*)
  // template, the batching utility, or an AllocationRequest_Accept.
  it('external-wallet invariant: only direct AllocationFactory_Allocate, no DEX or utility templates', () => {
    const singleSwap: WalletIntent = {
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
    const crossSwap: WalletIntent = {
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
    const add: WalletIntent = {
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
      allocationFactoryExtraArgs: [allocationFactoryExtraArgs, allocationFactoryExtraArgs, lpFactoryExtraArgs],
      allocationRequestExtraArgs,
      disclosure,
      baseHoldingCids: ['b1'],
      quoteHoldingCids: ['q1'],
    };
    const remove: WalletIntent = {
      kind: 'remove-liquidity',
      requestCid: 'reqREMOVE1234',
      settlement,
      allocations: [
        mkSpec('lp-base-out-0', 'Amulet', 'ReceiverSide', false),
        mkSpec('lp-quote-out-0', 'USDCx', 'ReceiverSide', false),
        mkSpec('lp-burn', 'Amulet-USDCx-LP', 'SenderSide', true),
      ],
      requestedAt: REQUESTED_AT,
      factoryCids: ['depF', 'depF', 'lpF'],
      allocationFactoryExtraArgs: [allocationFactoryExtraArgs, allocationFactoryExtraArgs, lpFactoryExtraArgs],
      allocationRequestExtraArgs,
      disclosure,
      lpHoldingCids: ['lp1'],
    };
    const fundOrder: WalletIntent = {
      kind: 'fund-order',
      requestCid: 'orderReqXADMIN',
      settlement: { executors: ['op::1'], id: 'DexOrder-web-2', cid: null, meta: { values: {} } },
      allocations: [orderFundingSpec('quote-ad::1', 'USDCx', '100.0'), orderReceiptSpec('base-ad::1')],
      requestedAt: REQUESTED_AT,
      factoryCids: ['quoteFactory', 'baseFactory'],
      allocationFactoryExtraArgs: [allocationFactoryExtraArgs, lpFactoryExtraArgs],
      allocationRequestExtraArgs,
      disclosure,
      inputHoldingCids: ['q1'],
      hint: { instrumentId: 'USDCx', amount: '100.0' },
    };

    // Expected exercise counts: swap same-admin 1 / cross-admin 2, LP 3, cross-order 2.
    const cases: Array<{ intent: WalletIntent; count: number }> = [
      { intent: singleSwap, count: 1 },
      { intent: crossSwap, count: 2 },
      { intent: add, count: 3 },
      { intent: remove, count: 3 },
      { intent: fundOrder, count: 2 },
    ];

    for (const { intent, count } of cases) {
      const out = composeCommands(intent, ctx);
      expect(out.commands).toHaveLength(count);
      // exercisesOf asserts each command is a top-level ExerciseCommand.
      for (const cmd of exercisesOf(out)) {
        expect(cmd.choice).toBe('AllocationFactory_Allocate');
        expect(cmd.templateId).toBe(ALLOCATION_FACTORY_TID);
      }
      const serialized = JSON.stringify(out.commands);
      for (const forbidden of [
        'canton-dex-trading-v2',
        'splice-util-token-standard-wallet',
        'CantonDex.',
        'BatchingUtility',
        'AllocationRequest_Accept',
        'CreateAndExerciseCommand',
      ]) {
        expect(serialized).not.toContain(forbidden);
      }
    }
  });

});
