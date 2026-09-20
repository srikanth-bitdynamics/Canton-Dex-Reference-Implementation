import { useState } from "react";
import { createRoot } from "react-dom/client";
import { createVault, unlockVault, type KeyVault } from "./hosted-crypto";

type Keys = { vault: KeyVault; key: CryptoKey };
const button = "rounded bg-emerald-700 px-4 py-2 text-white disabled:opacity-40";
const input = "w-full rounded border border-slate-500 bg-slate-900 p-2 text-white";

function modal<T>(render: (resolve: (value: T) => void, reject: () => void) => React.ReactNode): Promise<T> {
  return new Promise((resolve, reject) => {
    const node = document.createElement("dialog");
    node.className = "w-full max-w-2xl rounded-lg border border-slate-600 bg-slate-950 p-6 text-slate-100 backdrop:bg-black/70";
    document.body.append(node);
    const root = createRoot(node);
    const close = () => { node.close(); setTimeout(() => { root.unmount(); node.remove(); }, 0); };
    const cancel = () => { close(); reject(new Error("Wallet request cancelled")); };
    node.addEventListener("cancel", e => { e.preventDefault(); cancel(); });
    root.render(render(value => { close(); resolve(value); }, cancel));
    node.showModal();
  });
}

export function requestKeys(origin: string, network: string): Promise<Keys> {
  return modal((resolve, reject) => <KeyForm origin={origin} network={network} resolve={resolve} cancel={reject} />);
}

function KeyForm({ origin, network, resolve, cancel }: {
  origin: string; network: string; resolve: (keys: Keys) => void; cancel: () => void;
}) {
  const storageKey = `canton-dex:encrypted-key:${origin}:${network}`;
  const [vault, setVault] = useState<KeyVault | null>(() => {
    try { return JSON.parse(localStorage.getItem(storageKey) ?? "null"); } catch { return null; }
  });
  const [password, setPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [backup, setBackup] = useState(false);
  const [downloaded, setDownloaded] = useState(false);
  const [creating, setCreating] = useState(!vault);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [keys, setKeys] = useState<Keys | null>(null);

  async function unlock() {
    setBusy(true); setError("");
    try {
      if (creating && (!vault || !keys)) {
        if (password !== confirmation) throw new Error("Passphrases must match.");
        const created = await createVault(password, origin, network);
        const key = await unlockVault(created, password, origin, network);
        setVault(created); setKeys({ vault: created, key }); setPassword(""); setConfirmation("");
      } else if (vault) {
        const result = keys ?? { vault, key: await unlockVault(vault, password, origin, network) };
        localStorage.setItem(storageKey, JSON.stringify(vault));
        setPassword(""); resolve(result);
      }
    } catch (e) { setError(e instanceof Error ? e.message : "Unable to unlock backup."); }
    finally { setBusy(false); }
  }
  function download() {
    if (!vault) return;
    const url = URL.createObjectURL(new Blob([JSON.stringify(vault, null, 2)], { type: "application/json" }));
    const a = document.createElement("a"); a.href = url; a.download = "canton-dex-encrypted-wallet.json"; a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000); setDownloaded(true);
  }
  return <div className="space-y-4">
    <h2 className="text-xl font-semibold">{creating ? "Create testnet wallet" : "Unlock testnet wallet"}</h2>
    <p>Your signing key stays in this browser. Save the encrypted backup and keep its passphrase separately. The operator cannot reset a lost key.</p>
    <p className="text-sm text-slate-400">{network} · {origin}</p>
    {!keys && <>
      <label className="block">Passphrase<input className={input} type="password" autoComplete={creating ? "new-password" : "current-password"} value={password} onChange={e => setPassword(e.target.value)} /></label>
      {creating && <label className="block">Repeat passphrase<input className={input} type="password" autoComplete="new-password" value={confirmation} onChange={e => setConfirmation(e.target.value)} /></label>}
      <label className="block text-sm">Restore encrypted backup<input type="file" accept="application/json,.json" className="block py-2" disabled={busy} onChange={async e => {
        const file = e.target.files?.[0]; if (!file) return;
        try {
          if (file.size > 16_384) throw new Error("Backup is too large.");
          setVault(JSON.parse(await file.text()) as KeyVault); setCreating(false); setKeys(null); setError("");
        } catch { setError("Invalid wallet backup file."); }
      }} /></label>
    </>}
    {keys && <>
      <button className={button} onClick={download}>Download encrypted backup</button>
      <label className="flex gap-2"><input type="checkbox" checked={backup} disabled={!downloaded} onChange={e => setBackup(e.target.checked)} />I saved the backup and know that losing my passphrase can lose access to this wallet.</label>
    </>}
    {error && <p role="alert" className="text-red-300">{error}</p>}
    <div className="flex gap-3">
      <button className={button} disabled={busy || (keys !== null ? !backup : creating ? password.length < 16 || password !== confirmation : !password)} onClick={() => void unlock()}>{busy ? "Working…" : keys ? "Continue" : creating ? "Generate key" : "Unlock"}</button>
      <button className="rounded border border-slate-500 px-4 py-2" onClick={cancel}>Cancel</button>
    </div>
  </div>;
}

export function approveHosted(title: string, description: string, details: string): Promise<void> {
  return modal((resolve, reject) => <div className="space-y-4">
    <h2 className="text-xl font-semibold">{title}</h2>
    <p className="whitespace-pre-wrap break-words">{description}</p>
    <details><summary className="cursor-pointer">Verified transaction details</summary><pre className="mt-2 max-h-72 overflow-auto whitespace-pre-wrap break-all rounded bg-slate-900 p-3 text-xs">{details}</pre></details>
    <div className="flex gap-3"><button className={button} onClick={() => resolve()}>Approve and sign</button><button className="rounded border border-slate-500 px-4 py-2" onClick={reject}>Cancel</button></div>
  </div>);
}
