# Daml Test Package

This package holds the source-aligned Daml Script tranche.

Current purpose:

- keep executable tests out of the production DAR
- validate local source-derived workflow slices against the upstream
  `TradingAppV2` example
- keep the query helper copied from `TradingAppV2_Backend` in a test-only
  package until the wider registry-driven backend surface is wired
