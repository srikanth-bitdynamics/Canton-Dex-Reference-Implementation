// DEX-91 PartyLayer probe spike.
//
// Drives the full loop the probe needs to confirm LIVE:
//   1. connect a Canton wallet via PartyLayer (Console / Nightly / Send / Cantor8);
//   2. submit a DEX command tree (a harmless one, then a real add-liquidity batch);
//   3. read back the raw submit result (expected: updateId-only, per DEX-91);
//   4. recover the created Allocation + LiquidityAllocationAcceptance cids by
//      updateId via `ledgerApi` (proves the operator-discovery path end-to-end).
//
// Everything logs raw JSON to the page. Paste the captured shapes into
// docs/partylayer-probe.md (the "Live-run results" + capability matrix).
//
// NOTE: the exact `submitTransaction` param shape is the one field the published
// types did not pin down (SubmitTransactionParams). The call below is the
// best-known shape; if the wallet rejects it, check the error and adjust the
// `commands` wrapping (this is itself a probe outcome to record).

import { useState } from "react";
import {
  PartyLayerKit,
  ConnectButton,
  usePartyLayer,
  useSession,
} from "@partylayer/react";

const NETWORK = (import.meta.env.VITE_PL_NETWORK ?? "devnet") as
  | "devnet"
  | "testnet"
  | "mainnet";
// The operator backend that produces /request payloads + the DAR package id.
const API_BASE = import.meta.env.VITE_API_BASE ?? "http://localhost:8080";

function log(setter: (s: string) => void, label: string, value: unknown) {
  setter(`${label}:\n${JSON.stringify(value, null, 2)}`);
  // eslint-disable-next-line no-console
  console.log(`[probe] ${label}`, value);
}

function Panel() {
  const client = usePartyLayer();
  const session = useSession();
  const [out, setOut] = useState("(no output yet)");
  const [updateId, setUpdateId] = useState("");
  const [requestJson, setRequestJson] = useState("");

  const party = (session as { partyId?: string } | null)?.partyId ?? "(not connected)";

  // (3) Submit a harmless command and capture the raw receipt.
  async function submitHarmless() {
    try {
      // A no-op-ish exercise the connected party is authorized for. Replace the
      // contractId with a real Holding cid the party owns on the target network.
      const commands = [
        {
          ExerciseCommand: {
            templateId: "#canton-dex-trading:CantonDex.Registry.V2:Holding",
            contractId: import.meta.env.VITE_PROBE_HOLDING_CID ?? "REPLACE_WITH_HOLDING_CID",
            choice: "Holding_Split",
            choiceArgument: { splitAmount: "0.0000000001" },
          },
        },
      ];
      const receipt = await client.submitTransaction({
        commandId: `probe-harmless-${Date.now()}`,
        actAs: [party],
        commands,
      } as never);
      log(setOut, "submitTransaction receipt (CONFIRM: updateId-only?)", receipt);
      const uid = (receipt as { updateId?: string; transactionHash?: string }).updateId
        ?? (receipt as { transactionHash?: string }).transactionHash ?? "";
      setUpdateId(uid);
    } catch (e) {
      log(setOut, "submitTransaction ERROR (record the param-shape rejection)", String(e));
    }
  }

  // (3') Submit a real add-liquidity batch from a pasted /request response.
  async function submitAddLiquidity() {
    try {
      const req = JSON.parse(requestJson);
      // Canonical Token Standard V2 shape (mirrors composeAddLiquidity):
      // AllocationRequest_Accept + 3x AllocationFactory_Allocate.
      const ALLOC_REQUEST_IID =
        "#splice-api-token-allocation-request-v2:Splice.Api.Token.AllocationRequestV2:AllocationRequest";
      const ALLOC_FACTORY_IID =
        "#splice-api-token-allocation-instruction-v2:Splice.Api.Token.AllocationInstructionV2:AllocationFactory";
      const now = new Date().toISOString();
      const empty = { context: { values: {} }, meta: { values: {} } };
      const accept = {
        ExerciseCommand: {
          templateId: ALLOC_REQUEST_IID,
          contractId: req.requestCid,
          choice: "AllocationRequest_Accept",
          choiceArgument: { actors: [party], extraArgs: empty },
        },
      };
      const allocate = (spec: unknown, factoryCid: string, holdings: string[]) => ({
        ExerciseCommand: {
          templateId: ALLOC_FACTORY_IID,
          contractId: factoryCid,
          choice: "AllocationFactory_Allocate",
          choiceArgument: {
            settlement: req.settlement,
            allocation: spec,
            requestedAt: now,
            inputHoldingCids: holdings,
            actors: [party],
            extraArgs: empty,
          },
        },
      });
      const [baseSpec, quoteSpec, receiptSpec] = req.allocations;
      const commands = [
        accept,
        allocate(baseSpec, req.depositFactoryCid, req.probeBaseHoldingCids ?? []),
        allocate(quoteSpec, req.depositFactoryCid, req.probeQuoteHoldingCids ?? []),
        allocate(receiptSpec, req.lpFactoryCid, []),
      ];
      const receipt = await client.submitTransaction({
        commandId: `probe-add-lp-${Date.now()}`,
        actAs: [party],
        commands,
      } as never);
      log(setOut, "add-liquidity receipt (CONFIRM: updateId-only?)", receipt);
      const uid = (receipt as { updateId?: string }).updateId ?? "";
      setUpdateId(uid);
    } catch (e) {
      log(setOut, "add-liquidity ERROR", String(e));
    }
  }

  // (4a) CLIENT-SIDE precondition check: confirm the created cids are present in
  // the transaction tree keyed by updateId. This is NOT the operator path — it
  // queries via the wallet's own ledgerApi (parties=<connected party>). It only
  // proves the data the operator needs is in the tree. The PRODUCTION recovery
  // runs OPERATOR-SIDE (its own JSON API + operator party) — see (4b) and the
  // backend's PoolService.recoverDvpAllocations (DEX-92).
  async function clientSideTreeCheck() {
    try {
      const res = await client.ledgerApi({
        requestMethod: "GET",
        resource: `/v2/updates/transaction-tree-by-id/${updateId}?parties=${encodeURIComponent(party)}`,
      });
      const tree = JSON.parse((res as { response: string }).response);
      const created: Array<{ contractId: string; templateId?: string }> =
        tree?.transaction?.eventsById
          ? Object.values(tree.transaction.eventsById)
              .map((e: unknown) => (e as { CreatedTreeEvent?: { value?: { contractId: string; templateId: string } } }).CreatedTreeEvent?.value)
              .filter(Boolean) as Array<{ contractId: string; templateId?: string }>
          : [];
      const allocations = created.filter((e) =>
        e.templateId?.endsWith("CantonDex.Registry.V2:Allocation"),
      );
      const acceptance = created.find((e) =>
        e.templateId?.endsWith(
          "CantonDex.Dex.LiquidityAllocationRequest:LiquidityAllocationAcceptance",
        ),
      );
      log(setOut, "CLIENT-SIDE tree check (precondition; NOT the operator path)", {
        allocationCids: allocations.map((a) => a.contractId),
        acceptanceCid: acceptance?.contractId,
        rawCreatedCount: created.length,
      });
    } catch (e) {
      log(setOut, "client-side tree check ERROR", String(e));
    }
  }

  // (4b) OPERATOR-SIDE recovery (the production path): hand the updateId to the
  // operator backend, which runs PoolService.recoverDvpAllocations against its
  // OWN JSON API (operator party) and returns the recovered cids. This is what
  // actually drives /settle for an updateId-only wallet. The endpoint lands with
  // the DEX-92 settle wiring; until then this button shows the wiring gap.
  async function recoverViaOperator() {
    try {
      const res = await fetch(
        `${API_BASE}/v1/pools/recover-dvp-allocations`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ updateId, party }),
        },
      );
      const text = await res.text();
      log(
        setOut,
        res.ok
          ? "OPERATOR-SIDE recovery (production path)"
          : `OPERATOR-SIDE recovery — endpoint not wired yet (DEX-92): ${res.status}`,
        text,
      );
    } catch (e) {
      log(setOut, "operator-side recovery ERROR (is the operator backend running?)", String(e));
    }
  }

  return (
    <div style={{ fontFamily: "system-ui", padding: 24, maxWidth: 900 }}>
      <h2>DEX-91 — PartyLayer probe</h2>
      <p>Network: <b>{NETWORK}</b> · API base: <code>{API_BASE}</code></p>
      <p>Connected party: <code>{party}</code></p>
      <ConnectButton />
      <hr />
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", margin: "12px 0" }}>
        <button onClick={submitHarmless} disabled={!session}>1 · submit harmless</button>
        <button onClick={submitAddLiquidity} disabled={!session}>2 · submit add-liquidity batch</button>
        <input
          placeholder="updateId"
          value={updateId}
          onChange={(e) => setUpdateId(e.target.value)}
          style={{ minWidth: 280 }}
        />
        <button onClick={clientSideTreeCheck} disabled={!session || !updateId}>
          3a · client-side tree check (precondition)
        </button>
        <button onClick={recoverViaOperator} disabled={!updateId}>
          3b · operator-side recover (production path)
        </button>
      </div>
      <details>
        <summary>Paste the operator <code>/v1/pools/add-liquidity/request</code> JSON here for step 2</summary>
        <textarea
          value={requestJson}
          onChange={(e) => setRequestJson(e.target.value)}
          rows={8}
          style={{ width: "100%", fontFamily: "monospace" }}
        />
      </details>
      <pre style={{ background: "#111", color: "#0f0", padding: 16, overflow: "auto" }}>{out}</pre>
    </div>
  );
}

export default function Spike() {
  return (
    <PartyLayerKit network={NETWORK} appName="Canton-Dex Probe">
      <Panel />
    </PartyLayerKit>
  );
}
