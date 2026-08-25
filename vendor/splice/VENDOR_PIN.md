# Token Standard dependency record

The DEX build consumes the canonical Token Standard DARs committed in
`vendor/splice/dars/`. They were copied from the Splice **0.6.12**
`splice-node` release bundle, built with Daml SDK **3.5.2**.

Using the release DARs preserves the package ids vetted by Canton networks.
Rebuilding the same source locally produces different package ids and is not a
substitute for these binary dependencies.

To refresh the DARs from another Splice release:

```bash
scripts/fetch-splice-dars.sh <splice-version>
(cd trading && dpm build)
bash scripts/run-local-daml-tests.sh
```

The source tree under `vendor/splice/token-standard/` is retained for readable
API and example-code reference. It is not part of the DEX build. The build's
authoritative dependencies are the DAR paths listed in
[`trading/daml.yaml`](../../trading/daml.yaml).
