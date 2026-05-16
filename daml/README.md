# Daml Workspace

This directory now holds workspace notes for the source-aligned Daml
implementation.

Current constraint:

- only implement workflows that are already present in the source material
- prefer local module names that clearly map back to the upstream workflow they
  mirror

Planned layout:

- `../src/CantonDex/DexApp/`
  - matched-trade baseline derived from `TradingAppV2`
- `../src/CantonDex/Instrument/`
  - registry-backed instrument and configuration integration notes
- `../tests/CantonDex/Tests/`
  - source-aligned Daml scripts and validation scenarios
