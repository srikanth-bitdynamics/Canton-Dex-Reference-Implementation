// @vitest-environment node
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { createVault, unlockVault, sign, from64, verifyPrepared, verifyTopology } from "../wallet/hosted-crypto";
import type { PreparedSubmission } from "../wallet/sequential-submit";

const fixture = JSON.parse(readFileSync(new URL("./fixtures/hosted-signing.json", import.meta.url), "utf8"));
const allocation = JSON.parse(readFileSync(new URL("./fixtures/hosted-allocation.json", import.meta.url), "utf8"));

describe("hosted wallet signing", () => {
  it("validates actual Canton 3.5.2 external topology and prepared transaction", async () => {
    await expect(verifyTopology(fixture.topology, fixture.publicKey, fixture.cfg)).resolves.toBeUndefined();
    await expect(verifyPrepared(fixture.prepared, fixture.submission, fixture.cfg)).resolves.toContain("OrderFundingRequest");
    await expect(verifyPrepared(allocation.prepared, allocation.submission, allocation.cfg)).resolves.toContain("AllocationFactory_Allocate");
  });
  it("rejects changed allocation admin, amount, direction, actor and funding", async () => {
    const mutations = [
      (a: any) => { a.allocation.admin = "other-admin"; },
      (a: any) => { a.allocation.transferLegSides[0].amount = "1000"; },
      (a: any) => { a.allocation.transferLegSides[0].side = "SenderSide"; },
      (a: any) => { a.actors = ["victim"]; },
      (a: any) => { a.inputHoldingCids = ["victim-holding"]; },
    ];
    for (const mutate of mutations) {
      const submission = structuredClone(allocation.submission);
      mutate(submission.commands[0].ExerciseCommand.choiceArgument);
      await expect(verifyPrepared(allocation.prepared, submission, allocation.cfg)).rejects.toThrow("differs");
    }
  });
  it("rejects another key or hosting participant before topology signing", async () => {
    await expect(verifyTopology(fixture.topology, btoa("x".repeat(32)), fixture.cfg)).rejects.toThrow("your signing key");
    await expect(verifyTopology(fixture.topology, fixture.publicKey, { ...fixture.cfg, participantId: "attacker::123" })).rejects.toThrow("Participant");
    await expect(verifyTopology({ ...fixture.topology, multiHash: btoa("x".repeat(34)) }, fixture.publicKey, fixture.cfg)).rejects.toThrow("hash mismatch");
  });
  it("rejects a changed hash, network, party, command, amount, or missing value", async () => {
    await expect(verifyPrepared({ ...fixture.prepared, preparedTransactionHash: "wrong" }, fixture.submission, fixture.cfg)).rejects.toThrow("hash mismatch");
    await expect(verifyPrepared(fixture.prepared, fixture.submission, { ...fixture.cfg, synchronizerId: "other::123" })).rejects.toThrow("network");
    for (const update of [{ actAs: ["victim"] }, { commandId: "replaced" }]) {
      await expect(verifyPrepared(fixture.prepared, { ...fixture.submission, ...update }, fixture.cfg)).rejects.toThrow("mismatch");
    }
    const wrongPackage = structuredClone(fixture.submission);
    wrongPackage.commands[0].CreateCommand.templateId = "#another-package:CantonDex.Dex.OrderFundingRequest:OrderFundingRequest";
    await expect(verifyPrepared(fixture.prepared, wrongPackage, fixture.cfg)).rejects.toThrow("differs");
    for (const field of ["operator", "quantity", "expiry"]) {
      const submission = structuredClone(fixture.submission) as PreparedSubmission;
      const command = submission.commands[0];
      if (!("CreateCommand" in command)) throw new Error("expected create");
      command.CreateCommand.createArguments[field] = field === "quantity" ? "1000" : field === "expiry" ? "2026-10-01T00:00:00Z" : "victim";
      await expect(verifyPrepared(fixture.prepared, submission, fixture.cfg)).rejects.toThrow("differs");
    }
  });
  it("encrypts a portable backup, authenticates its network and key, and imports a non-extractable signer", async () => {
    const password = "test passphrase with many words";
    const vault = await createVault(password, "https://dex.example", "canton:testnet");
    expect(JSON.stringify(vault)).not.toContain(password);
    expect(Object.keys(vault).sort()).toEqual(["ciphertext", "iv", "network", "origin", "publicKey", "salt", "version"]);
    await expect(unlockVault(vault, "wrong", vault.origin, vault.network)).rejects.toThrow();
    await expect(unlockVault(vault, password, vault.origin, "canton:mainnet")).rejects.toThrow("another site or network");
    await expect(unlockVault({ ...vault, publicKey: btoa("x".repeat(32)) }, password, vault.origin, vault.network)).rejects.toThrow();
    const key = await unlockVault(JSON.parse(JSON.stringify(vault)), password, vault.origin, vault.network);
    expect(key.extractable).toBe(false);
    const data = new TextEncoder().encode("user-approved transaction");
    const publicKey = await crypto.subtle.importKey("raw", from64(vault.publicKey), "Ed25519", false, ["verify"]);
    expect(await crypto.subtle.verify("Ed25519", publicKey, from64(await sign(key, data)), data)).toBe(true);
  });
});
