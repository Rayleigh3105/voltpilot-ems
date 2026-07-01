"""Voltpilot-EMS market-data service.

Responsibility (architecture section 8/13): fetch external **market data**
(ENTSO-E Transparency day-ahead spot prices per Gebotszone) behind an
**anti-corruption adapter** so the optimization engine consumes an internal,
provider-agnostic price representation. ENTSO-E is the first implementation; a
commercial data provider can be swapped in later without touching callers
(architecture sections 3/11/13: "Marktdaten: ENTSO-E Transparency, hinter
Adapter; kommerzieller Anbieter later andockbar").

Public surface:
- :class:`voltpilot_market_data.source.DayAheadPriceSource` - the port.
- :class:`voltpilot_market_data.model.PriceSeries` - the internal representation.
- :class:`voltpilot_market_data.entsoe.EntsoeDayAheadPriceSource` - ENTSO-E impl.
- :class:`voltpilot_market_data.resilience.ResilientPriceSource` - cache + retry
  + circuit-breaker wrapper the optimizer talks to.
"""

__version__ = "0.1.0"
