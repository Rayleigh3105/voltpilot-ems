# vp-modbus-read (MB-M1): generic Modbus flow read + the shared connection manager

Ausgelagert aus `edge-app/AGENTS.md` am 05.09.2026 (Abschnitt Nr. 23).


Palette **0.3.0** adds `nodes/vp-modbus-read.js` (catalog type `vp.modbus.read`): a
trigger-driven generic Modbus-TCP register read (FC3/FC4, u16/s16/u32/s32/float32 ×
word order via the codec) that optionally records each reading as edge-entity
telemetry on `edge/entities/{id}/telemetry` - the normal E1b uplink carries it, no
edge release logic knows "modbus" specially. Rules that must hold:

- **`lib/modbus-conn.js` is the ONE Modbus I/O path for vp-modbus nodes** - it bakes
  the 2026-07-13 poll law in as a library (one in-flight op per (host, port) across
  ALL tabs, bounded drop-oldest queue, fresh socket, 8 s/8 s/30 s caps, never
  silent). A future vp-modbus-write must reuse it, never open its own sockets.
- **`lib/modbus-tcp.js` is a byte-identical synced copy** of
  `edge-app/nodered/modbus-tcp.js` (a palette package cannot require repo files);
  `test/modbus_spec.js` guards the drift - after editing the codec, re-copy the
  file AND re-run `nodered/build-flows.js` (the test-read flow node embeds a copy
  too, `flows-sync.test.js` guards that one).
- **READ-ONLY**: no write path exists in 0.3.0 (M2 is the gated write). The deadband
  gates the flow emission only; entity telemetry records every successful read; a
  failed read emits NOTHING (status + rate-limited warn).
- The artifact `min_palette_version` lifts to 0.3.0 for flows using the node - old
  devices ack `unsupported` with the palette-floor copy
  (`flowdeploy/crosscheck_test.go` pins it). Root AGENTS.md "Generic Modbus READ
  node (MB-M1)" has the full picture (catalogs, validators, D-15).

