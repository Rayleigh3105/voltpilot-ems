package com.voltpilot.api.repo;

import com.voltpilot.api.optimizer.SlotEconomics;
import java.math.BigDecimal;
import java.time.LocalDate;
import java.util.List;
import java.util.UUID;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Repository;

/**
 * Die Grundlage der Karte "Einspeisevergütung" und ihr einziger Schreibweg
 * ({@code site.einspeiseverguetung_ct_kwh}, Migration V20261027101500).
 * Transparent RLS-begrenzt wie jede Anlagen-Abfrage: eine fremde Anlage liefert
 * keine Zeile (=&gt; 404) und lässt sich nicht beschreiben.
 */
@Repository
public class EinspeiseverguetungRepository {

    /**
     * Was die Karte liest - in EINER Zeile: Veräußerungsform, Netzladen, die
     * Angabe des Kunden samt seiner Antwort zu § 51a (nur ohne
     * Inbetriebnahmedatum von Belang), die Herleitungs-Grundlage des primären
     * PV-Assets und die Herkunft der festen Bewertung, genau so, wie die
     * Erlöse sie berechnen ({@code quelle}: {@code angegeben} | {@code eeg} |
     * null).
     */
    public record Grundlage(
            String plantKind,
            boolean netzladenErlaubt,
            BigDecimal angegebenCtKwh,
            Boolean inbetriebnahmeAbSolarspitzengesetz,
            LocalDate inbetriebnahme,
            BigDecimal leistungKwp,
            BigDecimal anzulegenderWertCtKwh,
            String quelle) {
    }

    private final JdbcTemplate jdbc;

    public EinspeiseverguetungRepository(JdbcTemplate jdbc) {
        this.jdbc = jdbc;
    }

    /** Die Grundlage, oder {@code null}, wenn RLS die Anlage verbirgt. */
    public Grundlage find(UUID siteId) {
        List<Grundlage> rows = jdbc.query(
                "SELECT s.plant_kind, s.netzladen_erlaubt, s.einspeiseverguetung_ct_kwh,"
                        + " s.inbetriebnahme_ab_solarspitzengesetz,"
                        + " s.anzulegender_wert_ct_kwh, pv.commissioned_on, pv.pv_capacity_kwp, "
                        + SlotEconomics.exportVerguetungQuelleSql() + " AS quelle "
                        + "FROM site s "
                        + "LEFT JOIN asset pv ON pv.site_id = s.id AND pv.type = 'pv' AND pv.is_primary "
                        + "WHERE s.id = ?",
                (rs, i) -> new Grundlage(
                        rs.getString("plant_kind"),
                        rs.getBoolean("netzladen_erlaubt"),
                        rs.getBigDecimal("einspeiseverguetung_ct_kwh"),
                        rs.getObject("inbetriebnahme_ab_solarspitzengesetz", Boolean.class),
                        rs.getObject("commissioned_on", LocalDate.class),
                        rs.getBigDecimal("pv_capacity_kwp"),
                        rs.getBigDecimal("anzulegender_wert_ct_kwh"),
                        rs.getString("quelle")),
                siteId);
        return rows.isEmpty() ? null : rows.get(0);
    }

    /**
     * Setzt die Angabe des Kunden mit seiner Antwort zu § 51a; {@code null}
     * als Satz setzt auf die Herleitung zurück (der Aufrufer reicht dann auch
     * für die Antwort {@code null}). Voll-Setzen, kein COALESCE: die Angabe ist
     * EINE Aussage, die der Kunde ausdrücklich macht. False, wenn RLS die
     * Anlage verbirgt.
     */
    public boolean setAngegeben(UUID siteId, BigDecimal satzCtKwh, Boolean abSolarspitzengesetz) {
        return jdbc.update("UPDATE site SET einspeiseverguetung_ct_kwh = ?,"
                + " inbetriebnahme_ab_solarspitzengesetz = ? WHERE id = ?",
                satzCtKwh, abSolarspitzengesetz, siteId) > 0;
    }
}
