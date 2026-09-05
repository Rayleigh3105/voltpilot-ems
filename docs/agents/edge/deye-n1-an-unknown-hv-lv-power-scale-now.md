# Deye N1: an UNKNOWN HV/LV power scale now REFUSES the whole ToU plan

Ausgelagert aus `edge-app/AGENTS.md` am 05.09.2026 (Abschnitt Nr. 38).


The live 10x bug (report §2.3): `power_scale` "Automatisch" fell back to 1, so an
HV SG01HP3 was written **10x too large** - a 0,3 kW command became a ~15 kW export
ceiling and the plant exported 14,6 kW. `resolveDeyePowerScale(conn, cap)` now
resolves explicit config → the DEVICE-DETECTED class from the capability probe
(register `0x0000`, the read path's own auto-detect) → **refuse**. With the scale
unknown the ENTIRE ToU plan is withheld (`powerScaleSuppressed`, planned/writes/
readbacks all empty), because emitting it minus the power ops would arm ToU +
Export-First + Solar-Sell against the installer's own sell-power ceiling - the same
accident. **Consequence for tests: a Deye fixture that exercises the ToU mapping
must state `power_scale`** (or supply a capability with a `scaleClass`). The remote
path derives its scaling from rated power and cannot inherit `power_scale` at all.

