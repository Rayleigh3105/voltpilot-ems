# Messmittel-Angaben am Einbau (AP-16 IP-15)

Verbindlich: [Bewertung §12](../../contracts/v2/bewertung.md#12-messmittel-angaben-am-einbau-ip-15-g1g3-r8-e7--a),
`MessmittelService`, `MessmittelAngabenApiTest`, `MessmittelSchnittstelleVertragTest`.

- Angaben hängen an der `geraet`-ZEILE (= Einbau Z-5b), nicht am Kennzeichen GR-4. Ein
  Zählerwechsel übernimmt nichts; wer Angaben mitwandern lassen will, braucht einen Entscheid.
- NULL = nicht erhoben. Die Route übersetzt NULL in `nicht_erhoben`; nie einen Vorgabewert
  eintragen und nie eine Genauigkeit der Messkette rechnen (G3). Katalog „laut Hersteller“
  ist IP-16 und bleibt getrennt.
- Beleg = Verweis mit SHA-256, die Datei kommt nie an. Ohne gültige Prüfsumme 422; die DB
  hält dieselbe Grenze (`geraet_beleg_vollstaendig_chk`, `geraet_beleg_sha256_chk`, klein).
- `quelle_einstellung.klasse` liegt außerhalb des Tupels von `quelle_einstellung_nur_verkuerzen`:
  eine Angabe, keine Wirkung. Wer den Trigger abschreibt, lässt `klasse` draußen.
- Eigenes Journal `geraet_aenderung` (Art `messmittel_angabe`), ohne FK auf `geraet`, mit
  Mandanten-FK: Offboarding löscht es (`TenantRepository`, `to_regclass`-Probe). Es erscheint
  über `STROM_GERAET` im Geräte- und Unternehmensprotokoll; Sichtbarkeit über `RechtZiel.GERAET`.
- Recht `messmittel.angaben` hat die Zellen von `geraet.einrichten` (`wie`); der Zaun ist die
  Anlage des Geräts. GET trägt kein `@Recht`, nur den Pflicht-Kommentar `messwerte.ansehen`.
