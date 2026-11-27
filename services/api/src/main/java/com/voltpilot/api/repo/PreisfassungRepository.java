package com.voltpilot.api.repo;

import java.math.BigDecimal;
import java.time.Instant;
import java.time.LocalDate;
import java.util.ArrayList;
import java.util.Collection;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;

import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Repository;

/**
 * Die Preisfassungen einer Anlage (vp-tarif-ab-tag, Migration
 * {@code V20261126223000__anlage_preisfassung.sql}): Tarif, Preisblatt und
 * angegebene Einspeisevergütung je Fassung ab einem Tag.
 *
 * <p>Geschrieben werden die Fassungen NUR von der Datenbank (Trigger an
 * {@code site} und {@code site_supply_price}); dieser Weg setzt lediglich den
 * Tag, ab dem die nächste Änderung derselben Transaktion gilt
 * ({@link #abSetzen}), und liest die Fassungen. RLS-begrenzt wie jede
 * Anlagen-Abfrage.
 */
@Repository
public class PreisfassungRepository {

    /** Der Wert für „von Anfang an“ in {@code app.preis_gueltig_ab}. */
    public static final String BEGINN = "beginn";

    /**
     * Eine wirksame Fassung. {@code gueltigAb} {@code null} = von Anfang an; sie
     * gilt bis zum Vortag der nächsten Fassung.
     */
    public record Fassung(
            LocalDate gueltigAb,
            String tarifArt,
            BigDecimal tarifParamCtKwh,
            boolean preisblatt,
            BigDecimal einspeiseverguetungCtKwh,
            Boolean inbetriebnahmeAbSolarspitzengesetz) {
    }

    private final JdbcTemplate jdbc;

    public PreisfassungRepository(JdbcTemplate jdbc) {
        this.jdbc = jdbc;
    }

    /**
     * Setzt den Tag, ab dem die Preisänderungen DIESER Transaktion gelten:
     * ein Tag ({@code YYYY-MM-DD}, heute oder davor) oder {@link #BEGINN}.
     * {@code null} lässt die Vorgabe der Datenbank (heute, Europe/Berlin).
     * Nur innerhalb einer Transaktion wirksam ({@code set_config(…, true)}).
     */
    public void abSetzen(String gueltigAb) {
        if (gueltigAb == null) {
            return;
        }
        jdbc.queryForList("SELECT set_config('app.preis_gueltig_ab', ?, true)", gueltigAb);
    }

    /** Die wirksamen Fassungen einer Anlage in Tagesfolge (leer, wenn RLS sie verbirgt). */
    public List<Fassung> fassungen(UUID siteId) {
        return fassungen(List.of(siteId)).getOrDefault(siteId, List.of());
    }

    /** Die wirksamen Fassungen mehrerer Anlagen, je Anlage in Tagesfolge - EINE Abfrage. */
    public Map<UUID, List<Fassung>> fassungen(Collection<UUID> siteIds) {
        Map<UUID, List<Fassung>> result = new HashMap<>();
        if (siteIds.isEmpty()) {
            return result;
        }
        jdbc.query(
                "SELECT site_id, gueltig_ab, tarif_art, tarif_param_ct_kwh, preisblatt,"
                        + " einspeiseverguetung_ct_kwh, inbetriebnahme_ab_solarspitzengesetz"
                        + " FROM anlage_preiszeitraum WHERE site_id = ANY (?)"
                        + " ORDER BY site_id, von",
                rs -> {
                    result.computeIfAbsent(rs.getObject("site_id", UUID.class), k -> new ArrayList<>())
                            .add(new Fassung(
                                    rs.getObject("gueltig_ab", LocalDate.class),
                                    rs.getString("tarif_art"),
                                    rs.getBigDecimal("tarif_param_ct_kwh"),
                                    rs.getBoolean("preisblatt"),
                                    rs.getBigDecimal("einspeiseverguetung_ct_kwh"),
                                    rs.getObject("inbetriebnahme_ab_solarspitzengesetz", Boolean.class)));
                },
                (Object) siteIds.toArray(UUID[]::new));
        return result;
    }

    /**
     * Umzug-Merkzettel (vp-standort-konzept §7, E1 = B): ob Tarif, Preisblatt oder
     * Einspeisevergütung seit {@code seit} geändert wurden — jede Änderung zeichnet der Trigger
     * als neue Fassung auf, egal über welchen der bestehenden Schreibwege sie kam.
     */
    public boolean geaendertSeit(UUID siteId, Instant seit) {
        Boolean geaendert = jdbc.queryForObject(
                "SELECT EXISTS(SELECT 1 FROM anlage_preisfassung WHERE site_id = ? AND created_at > ?)",
                Boolean.class, siteId, java.sql.Timestamp.from(seit));
        return Boolean.TRUE.equals(geaendert);
    }
}
