package com.voltpilot.api.mispel;

import com.voltpilot.api.mispel.FoerderwegRegeln.Foerderweg;
import java.math.BigDecimal;
import java.time.Instant;
import java.time.LocalDate;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.Optional;
import java.util.UUID;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Service;
import org.springframework.transaction.support.TransactionTemplate;

/**
 * Die Pauschaloption vormerken, solange ihr Tag noch nicht feststeht (MiSpeL MP-27, Bedienkonzept BK-27, Vertrag
 * {@code docs/contracts/v2/mispel-foerderweg.md} 1.3 § 5a): „vorgemerkt, Termin offen“.
 *
 * <p>Die Pauschaloption gilt erst ab dem Monatsersten nach der Genehmigung der EU-Kommission (Tenor S. 3 Ziff. 9 b);
 * eine Fassung davor lehnt der Förderweg ab ({@code pauschaloption_noch_nicht_anwendbar}). Die Vormerkung ist darum
 * keine Fassung: Optimierer, Box und die Läufe lesen sie nicht. Sie hält den Wunsch des Kunden fest und die beiden
 * Voraussetzungen der Anlage 2, die VoltPilot nicht messen kann, mit Datum (Voraussetzung 2 „ein Betreiber“, A2 S. 18;
 * Voraussetzung 4 „Steckersolar in der Direktvermarktung“, A2 S. 19 Fn. 15). Die 30-kWp-Grenze (Voraussetzung 3,
 * A2 S. 19) prüft sie gegen die Solarleistung im Aufbau; Steckersolargeräte zählen dafür nicht (Fn. 14).
 */
@Service
public class PauschalVormerkungService {

    /** Höchstgrenze der installierten Solarleistung (Voraussetzung 3, A2 S. 19; § 19 Abs. 3c S. 2 Nr. 3 EEG). */
    public static final BigDecimal GRENZE_KWP = new BigDecimal("30");

    /** Was der Kunde angibt; {@code steckersolarKwp} 0 = keine Steckersolargeräte (eine Antwort, keine Lücke). */
    public record Angaben(Boolean einBetreiber, BigDecimal steckersolarKwp, Boolean steckersolarDirektvermarktung,
            String direktvermarkter, Boolean bilanzkreisGesondert) {}

    /** Eine stehende Vormerkung. {@code termin}: der Tag aus {@code pauschaloption-ab}, {@code null} = offen. */
    public record Vormerkung(UUID id, BigDecimal steckersolarKwp, Instant einBetreiberBestaetigtAm,
            Instant steckersolarDvBestaetigtAm, String direktvermarkter, Boolean bilanzkreisGesondert,
            Instant vorgemerktAm, String vorgemerktVon, LocalDate termin) {}

    private static final String SELECT = "SELECT id, steckersolar_kwp, ein_betreiber_bestaetigt_am, "
            + "steckersolar_dv_bestaetigt_am, direktvermarkter, bilanzkreis_gesondert, created_at, created_by "
            + "FROM site_pauschal_vormerkung WHERE site_id = ? AND aufgehoben_am IS NULL";

    private final JdbcTemplate jdbc;
    private final FoerderwegRepository wege;
    private final FoerderwegService foerderwege;
    private final TransactionTemplate transaktion;
    private final LocalDate pauschaloptionAb;

    public PauschalVormerkungService(JdbcTemplate jdbc, FoerderwegRepository wege, FoerderwegService foerderwege,
            TransactionTemplate transaktion, @Value("${voltpilot.mispel.pauschaloption-ab:}") String pauschaloptionAb) {
        this.jdbc = jdbc;
        this.wege = wege;
        this.foerderwege = foerderwege;
        this.transaktion = transaktion;
        this.pauschaloptionAb = pauschaloptionAb == null || pauschaloptionAb.isBlank() ? null
                : LocalDate.parse(pauschaloptionAb.trim());
    }

    /** Der Tag aus {@code voltpilot.mispel.pauschaloption-ab}; {@code null} = noch keine EU-Genehmigung (E7 = B). */
    public LocalDate pauschaloptionAb() {
        return pauschaloptionAb;
    }

    /** Die stehende Vormerkung der Anlage — leer, wenn keine steht oder die Anlage fremd ist (RLS). */
    public Optional<Vormerkung> aktuelle(UUID siteId) {
        return jdbc.query(SELECT, (rs, n) -> new Vormerkung(rs.getObject("id", UUID.class),
                rs.getBigDecimal("steckersolar_kwp"), instant(rs.getTimestamp("ein_betreiber_bestaetigt_am")),
                instant(rs.getTimestamp("steckersolar_dv_bestaetigt_am")), rs.getString("direktvermarkter"),
                (Boolean) rs.getObject("bilanzkreis_gesondert"), instant(rs.getTimestamp("created_at")),
                rs.getString("created_by"), pauschaloptionAb), siteId).stream().findFirst();
    }

    /**
     * Die Solarleistung im Aufbau (Summe der PV-Assets, kWp) — {@code null}, wenn sie unbekannt ist: kein PV-Asset oder
     * eines ohne Leistung. Unbekannt ist keine Null.
     */
    public BigDecimal solarleistungImAufbau(UUID siteId) {
        return jdbc.query("SELECT count(*) AS n, count(pv_capacity_kwp) AS bekannt, sum(pv_capacity_kwp) AS kwp "
                + "FROM asset WHERE site_id = ? AND type = 'pv'", rs -> {
                    if (!rs.next() || rs.getLong("n") == 0 || rs.getLong("bekannt") < rs.getLong("n")) {
                        return null;
                    }
                    return rs.getBigDecimal("kwp");
                }, siteId);
    }

    /** Merkt die Pauschaloption vor (oder ändert die stehende Vormerkung); Fehler als {@link FoerderwegAbgelehnt}. */
    public void vormerken(UUID siteId, Angaben a, String von) {
        pruefeForm(a);
        transaktion.executeWithoutResult(tx -> {
            FoerderwegRepository.Schalter s = wege.schalterSperren(siteId).orElseThrow(() ->
                    new FoerderwegAbgelehnt("anlage_unbekannt", 404, "Anlage nicht gefunden.", Map.of()));
            LocalDate heute = foerderwege.heute();
            if (pauschaloptionAb != null && !pauschaloptionAb.isAfter(FoerderwegRegeln.naechsterMonatserster(heute))) {
                throw ab("termin_steht_fest", 422, "Der Tag der Pauschaloption steht fest — sie wird über den "
                        + "Förderweg eingetragen, nicht mit offenem Termin.", "anwendbar_ab", pauschaloptionAb.toString(),
                        "Vertrag § 5a; Tenor S. 3 Ziff. 9b");
            }
            FoerderwegService.Ansicht heuteSicht = foerderwege.ansicht(siteId, heute);
            if (heuteSicht != null && heuteSicht.angaben() != null
                    && heuteSicht.angaben().foerderweg() == Foerderweg.MARKTPRAEMIE_PAUSCHAL) {
                throw ab("foerderweg_unveraendert", 409, "Die Anlage ist schon in der Pauschaloption.", "am",
                        heute.toString(), "Vertrag § 3");
            }
            if (heuteSicht != null && heuteSicht.vormerkung() != null) {
                throw ab("vormerkung_besteht", 409, "Für diese Anlage ist schon ein Förderweg zum "
                        + heuteSicht.vormerkung().gueltigAb() + " vorgemerkt; erst zurücknehmen.", "gueltig_ab",
                        heuteSicht.vormerkung().gueltigAb().toString(), "Vertrag § 5");
            }
            BigDecimal aufbau = solarleistungImAufbau(siteId);
            if (aufbau == null) {
                throw ab("solarleistung_unbekannt", 422, "Die installierte Solarleistung steht nicht im Aufbau; ohne sie "
                        + "lässt sich die 30-kWp-Grenze nicht prüfen.", "grenze_kwp", GRENZE_KWP,
                        "Voraussetzung 3, A2 S. 19");
            }
            // Steht das Steckersolargerät schon im Aufbau, zählt es dort mit — für die Grenze nicht (Fn. 14).
            if (aufbau.compareTo(GRENZE_KWP) > 0) {
                Map<String, Object> f = new LinkedHashMap<>();
                f.put("solarleistung_kwp", aufbau);
                f.put("grenze_kwp", GRENZE_KWP);
                f.put("fundstelle", "Voraussetzung 3, A2 S. 19 mit Fn. 14; § 19 Abs. 3c S. 2 Nr. 3 EEG");
                throw new FoerderwegAbgelehnt("ueber_30_kwp", 422, "Die Pauschaloption gilt nur bis 30 kWp installierter "
                        + "Solarleistung hinter der Einspeisestelle.", f);
            }
            jdbc.update("UPDATE site_pauschal_vormerkung SET aufgehoben_am = now() WHERE site_id = ? "
                    + "AND aufgehoben_am IS NULL", siteId);
            boolean stecker = a.steckersolarKwp().signum() > 0;
            jdbc.update("INSERT INTO site_pauschal_vormerkung (tenant_id, site_id, steckersolar_kwp, "
                    + "ein_betreiber_bestaetigt_am, steckersolar_dv_bestaetigt_am, direktvermarkter, "
                    + "bilanzkreis_gesondert, created_by) VALUES (?, ?, ?, now(), " + (stecker ? "now()" : "NULL")
                    + ", ?, ?, ?)", s.tenantId(), siteId, a.steckersolarKwp(), blank(a.direktvermarkter()),
                    a.bilanzkreisGesondert(), von);
        });
    }

    /** Nimmt die stehende Vormerkung zurück (sie bleibt als aufgehobene lesbar); {@code false} = keine stand. */
    public boolean zuruecknehmen(UUID siteId) {
        return jdbc.update("UPDATE site_pauschal_vormerkung SET aufgehoben_am = now() WHERE site_id = ? "
                + "AND aufgehoben_am IS NULL", siteId) > 0;
    }

    private static void pruefeForm(Angaben a) {
        if (a.steckersolarKwp() == null) {
            throw FoerderwegAbgelehnt.anfrage("steckersolar_kwp", "„steckersolar_kwp“ fehlt — 0, wenn kein "
                    + "Steckersolargerät hinter dem Zähler hängt.");
        }
        if (a.steckersolarKwp().signum() < 0 || a.steckersolarKwp().compareTo(GRENZE_KWP) > 0
                || a.steckersolarKwp().scale() > 3) {
            throw FoerderwegAbgelehnt.anfrage("steckersolar_kwp", "„steckersolar_kwp“ ist eine Leistung in kWp "
                    + "von 0 bis 30 mit höchstens drei Nachkommastellen.");
        }
        if (a.direktvermarkter() != null && (a.direktvermarkter().isBlank() || a.direktvermarkter().length() > 200
                || !a.direktvermarkter().strip().equals(a.direktvermarkter()))) {
            throw FoerderwegAbgelehnt.anfrage("direktvermarkter", "„direktvermarkter“ hat 1 bis 200 Zeichen ohne "
                    + "Leerraum am Rand.");
        }
        if (!Boolean.TRUE.equals(a.einBetreiber())) {
            throw ab("voraussetzung_unbestaetigt", 422, "Alle Solaranlagen, Speicher und Ladepunkte hinter der "
                    + "Einspeisestelle muss derselbe Anlagenbetreiber betreiben — bitte bestätigen.", "feld",
                    "ein_betreiber", "Voraussetzung 2, A2 S. 18; § 19 Abs. 3c S. 2 Nr. 2 EEG");
        }
        if (a.steckersolarKwp().signum() > 0 && !Boolean.TRUE.equals(a.steckersolarDirektvermarktung())) {
            throw ab("voraussetzung_unbestaetigt", 422, "Auch Steckersolargeräte müssen in der Direktvermarktung sein; "
                    + "die unentgeltliche Abnahme ist ausgeschlossen — bitte bestätigen.", "feld",
                    "steckersolar_direktvermarktung", "Voraussetzung 4, A2 S. 19 mit Fn. 15");
        }
    }

    private static FoerderwegAbgelehnt ab(String code, int status, String satz, String fakt, Object wert,
            String fundstelle) {
        Map<String, Object> f = new LinkedHashMap<>();
        f.put(fakt, wert);
        f.put("fundstelle", fundstelle);
        return new FoerderwegAbgelehnt(code, status, satz, f);
    }

    private static String blank(String s) {
        return s == null || s.isBlank() ? null : s;
    }

    private static Instant instant(java.sql.Timestamp t) {
        return t == null ? null : t.toInstant();
    }
}
