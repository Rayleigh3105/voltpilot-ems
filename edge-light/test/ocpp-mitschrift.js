// Mitschrift für einen Ladetest: fragt die Web-App der Box alle 5 s ab und
// schreibt je Runde eine Zeile (Messwerte, Budget, Zuteilung und was die
// erste Säule tatsächlich tut). Nur lesend, keine Abhängigkeiten (Node >= 18).
//
//   node edge-light/test/ocpp-mitschrift.js <datei.log> [http://10.10.1.25:8484]
//
// Spalten: pv/last/soc/netz aus /api/state und /api/ocpp; „zugeteilt“ ist die
// Summe der Box, „soll“ die Zuteilung des Steckers, „p“ seine gemessene
// Leistung, „ph“ die Phasenzahl (bei Steckern mit Phasenumschaltung),
// „cmd“/„rb“ Antwort und Rücklesung der Säule.
const fs = require("fs");
const out = process.argv[2];
const base = process.argv[3] || "http://10.10.1.25:8484";
if (!out) {
  console.error("Aufruf: node ocpp-mitschrift.js <datei.log> [http://<box>:8484]");
  process.exit(2);
}
const f = (v, d = 2) => (v == null ? "-" : typeof v === "number" ? v.toFixed(d) : String(v));

async function get(path) {
  const r = await fetch(base + path, { signal: AbortSignal.timeout(6000) });
  return r.json();
}

async function round() {
  const t = new Date().toLocaleTimeString("de-DE", { timeZone: "Europe/Berlin" });
  try {
    const [st, oc] = await Promise.all([get("/api/state"), get("/api/ocpp")]);
    const o = oc.ocpp || {};
    const cs = (o.control_status && o.control_status.stations && o.control_status.stations[0]) || {};
    const ch = (o.chargers && o.chargers[0]) || {};
    const con = (ch.connectors && ch.connectors[0]) || {};
    const line = [
      t,
      `pv=${f(st.pv_kw)}`, `last=${f(st.load_kw)}`, `soc=${f(st.soc_pct, 0)}`,
      `netz=${f(o.site_grid_kw)}`, `budget=${f(o.budget_kw)}`, `zugeteilt=${f(o.allocated_kw)}`,
      `| ${con.status || "-"}`, `p=${f(con.power_kw)}`, `soll=${f(con.allocated_kw)}`,
      `ph=${con.phases || "-"}`, `grund=${con.reason || "-"}`,
      `cmd=${con.command_status || "-"}`, `rb=${con.readback || "-"}`, `profile=${cs.profiles_accepted}`,
      con.phase_note ? `phase="${con.phase_note}"` : "",
      ch.note ? `hinweis="${ch.note}"` : "",
      con.reason_text ? `text="${con.reason_text}"` : "",
    ].filter(Boolean).join(" ");
    fs.appendFileSync(out, line + "\n");
  } catch (e) {
    fs.appendFileSync(out, `${t} FEHLER ${e.message}\n`);
  }
}

(async () => {
  for (;;) {
    await round();
    await new Promise((r) => setTimeout(r, 5000));
  }
})();
