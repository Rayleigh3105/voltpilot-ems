# `fronius_sunspec` PV source: AC only for a BATTERYLESS inverter (Model 124 gate)

Ausgelagert aus `edge-app/AGENTS.md` am 05.09.2026 (Abschnitt Nr. 5).


`sunspec/sunspec-live.js decodeInverter` publishes `pv_power_kw` from the
inverter's **AC** `W` only while the discovery walk finds **no Model 124
(Storage)** — a batteryless string inverter (the live Fronius Ecos), where AC
output IS the PV, `max(0, W)` clamp included. With Model 124 present the device
is a **hybrid** (AC = PV + discharge − charge), so PV comes from the inverter
model's **DC** power (`DCW`, model 113 float / model 103 int+SF) with the
one-sided clamp DROPPED (a sign/scale error must be a visible negative, not a
silent 0); an unreadable `DCW` publishes NOTHING rather than an AC number. The
DCW offsets are the standard SunSpec definition but are **VERIFY-on-device** —
no hybrid Fronius exists on any live site (see `nodered/FRONIUS.md` §5b).
Consequence for fixtures: **never pad a SunSpec test image with model id 124** —
its presence means "hybrid" (`sources-read.e2e.test.js` `PAD` list). Pinned by
`sunspec/sunspec-live.test.js` (hybrid sweep / negative DCW / unreadable DCW /
batteryless unchanged) and, for the already-clean Deye, by the
`deye-decode.test.js` `0x024E` battery sweep. Background:
`firstmate/data/vp-pv-battery-bug/report.md` §7.

