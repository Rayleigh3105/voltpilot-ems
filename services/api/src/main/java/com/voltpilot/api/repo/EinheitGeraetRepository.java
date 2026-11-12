package com.voltpilot.api.repo;

import java.math.BigDecimal;
import java.time.Instant;
import java.util.List;
import java.util.UUID;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Repository;

/**
 * S5 (vp-mastr-mehrere-einheiten-konzept §5.1/§8): die freiwillige Zuordnung
 * einer bestätigten PV-{@code register_einheit} zu den Geräten, die sie
 * tatsächlich speisen - ein {@code measurement_point} (role
 * {@code pv-generation}) oder eine Erzeugungseinheit der Anlagensteuerung
 * ({@code geraet_teil}, teilart {@code erzeugungseinheit}). RLS-scoped wie
 * {@link RegisterEinheitRepository} - keine Berechnung hängt an dieser
 * Tabelle (Migrationskommentar); sie ist reine Anzeige/Zuordnung.
 */
@Repository
public class EinheitGeraetRepository {

    /**
     * Plausibilitäts-Schwelle „gemessene Spitze über der Summe" (report §4.4:
     * „fehlt eine Einheit?"), dieselbe wie {@code FleetPflege.KWP_HIGH_FACTOR}
     * - EINE Antwort auf dieselbe Frage, nicht zwei verschiedene Schwellen für
     * dieselbe Plausibilität.
     */
    public static final double PEAK_UEBER_SUMME_FAKTOR = 1.25;

    /** Wie viele Viertelstunden mit PV-Wert ein Urteil tragen - wie {@code FleetPflege.KWP_MIN_BUCKETS}. */
    public static final long PEAK_MIN_BUCKETS = 96;

    private final JdbcTemplate jdbc;

    public EinheitGeraetRepository(JdbcTemplate jdbc) {
        this.jdbc = jdbc;
    }

    /** Ein zuordenbares Gerät der Anlage: entweder ein Messpunkt oder eine Erzeugungseinheit. */
    public record GeraetKandidat(UUID id, String art, String bezeichnung, BigDecimal nennleistungKw,
            UUID zugeordnetAn) {
    }

    /** Eine bestehende Zuordnung, mit dem Namen des Geräts für die Anzeige. */
    public record Zuordnung(UUID id, UUID einheitId, UUID geraetId, String art, String bezeichnung) {
    }

    /**
     * Jedes PV-fähige Gerät der Anlage - Messpunkt ({@code role = 'pv-generation'})
     * oder aktive Erzeugungseinheit ({@code teilart = 'erzeugungseinheit'},
     * {@code einheit_art = 'pv_wechselrichter'}, {@code ausgebaut_am IS NULL}) -
     * mit der Einheit, der es schon zugeordnet ist (null = frei). Ein Gerät kann
     * nur EINER Einheit zugeordnet werden (die Portal-Oberfläche zeigt es dann
     * nicht mehr als frei an); die Datenbank selbst erlaubt n:m (Migrations-
     * kommentar), falls ein Sonderfall das später braucht.
     */
    public List<GeraetKandidat> geraeteFuerSite(UUID siteId) {
        return jdbc.query(
                "SELECT mp.id AS id, 'messpunkt' AS art, "
                        + "coalesce(mp.label, mp.brand || ' ' || mp.model, 'Messpunkt') AS bezeichnung, "
                        + "mp.capacity_kwp AS nennleistung_kw, eg.einheit_id AS zugeordnet_an "
                        + "FROM measurement_point mp "
                        + "LEFT JOIN einheit_geraet eg ON eg.measurement_point_id = mp.id "
                        + "WHERE mp.site_id = ? AND mp.role = 'pv-generation' "
                        + "UNION ALL "
                        + "SELECT gt.id AS id, 'erzeugungseinheit' AS art, "
                        + "coalesce(gt.bezeichnung, gt.typ_bild, 'Erzeugungseinheit ' || gt.te_nr) AS bezeichnung, "
                        + "gt.nennleistung_kw AS nennleistung_kw, eg.einheit_id AS zugeordnet_an "
                        + "FROM geraet_teil gt "
                        + "JOIN geraet g ON g.id = gt.geraet_id "
                        + "LEFT JOIN einheit_geraet eg ON eg.geraet_teil_id = gt.id "
                        + "WHERE g.site_id = ? AND gt.teilart = 'erzeugungseinheit' "
                        + "AND gt.einheit_art = 'pv_wechselrichter' AND gt.ausgebaut_am IS NULL",
                (rs, i) -> new GeraetKandidat(
                        rs.getObject("id", UUID.class),
                        rs.getString("art"),
                        rs.getString("bezeichnung"),
                        rs.getBigDecimal("nennleistung_kw"),
                        rs.getObject("zugeordnet_an", UUID.class)),
                siteId, siteId);
    }

    /** Jede bestehende Zuordnung der Anlage, über alle ihre Einheiten. */
    public List<Zuordnung> zuordnungenFuerSite(UUID siteId) {
        return jdbc.query(
                "SELECT eg.id, eg.einheit_id, "
                        + "coalesce(eg.measurement_point_id, eg.geraet_teil_id) AS geraet_id, "
                        + "CASE WHEN eg.measurement_point_id IS NOT NULL THEN 'messpunkt' ELSE 'erzeugungseinheit' END AS art, "
                        + "coalesce(mp.label, mp.brand || ' ' || mp.model, gt.bezeichnung, gt.typ_bild, "
                        + "'Erzeugungseinheit ' || gt.te_nr) AS bezeichnung "
                        + "FROM einheit_geraet eg "
                        + "JOIN register_einheit re ON re.id = eg.einheit_id AND re.site_id = ? "
                        + "LEFT JOIN measurement_point mp ON mp.id = eg.measurement_point_id "
                        + "LEFT JOIN geraet_teil gt ON gt.id = eg.geraet_teil_id",
                (rs, i) -> new Zuordnung(
                        rs.getObject("id", UUID.class),
                        rs.getObject("einheit_id", UUID.class),
                        rs.getObject("geraet_id", UUID.class),
                        rs.getString("art"),
                        rs.getString("bezeichnung")),
                siteId);
    }

    /**
     * Ordnet ein Gerät einer Einheit zu (freiwillig, n:m laut Schema - siehe
     * Klassenkommentar). Genau eines der beiden IDs ist gesetzt; das andere
     * bleibt {@code null} (die CHECK-Regel der Tabelle verlangt das ohnehin).
     * Idempotent: eine schon bestehende, gleiche Zuordnung bleibt unverändert.
     */
    public void zuordnen(UUID tenantId, UUID einheitId, UUID measurementPointId, UUID geraetTeilId) {
        jdbc.update(
                "INSERT INTO einheit_geraet (tenant_id, einheit_id, measurement_point_id, geraet_teil_id) "
                        + "VALUES (?, ?, ?, ?) ON CONFLICT DO NOTHING",
                tenantId, einheitId, measurementPointId, geraetTeilId);
    }

    /** Entfernt eine Zuordnung (Anzeige-only - keine Rechnung hängt daran). */
    public void entfernen(UUID einheitId, UUID linkId) {
        jdbc.update("DELETE FROM einheit_geraet WHERE id = ? AND einheit_id = ?", linkId, einheitId);
    }

    /** Die gemessene PV-Spitze der Anlage seit {@code from} (15-Minuten-Rollup, Admin-Fleet-Muster). */
    public record PvPeak(BigDecimal peakKw, long buckets) {
    }

    public PvPeak gemessenePeak(UUID siteId, Instant from) {
        List<PvPeak> rows = jdbc.query(
                "SELECT max(pv_kwh) * 4 AS peak_kw, "
                        + "count(*) FILTER (WHERE pv_kwh IS NOT NULL) AS buckets "
                        + "FROM telemetry_rollup_15m WHERE site_id = ? AND bucket >= ?",
                (rs, i) -> new PvPeak(rs.getBigDecimal("peak_kw"), rs.getLong("buckets")),
                siteId, java.sql.Timestamp.from(from));
        return rows.isEmpty() ? new PvPeak(null, 0) : rows.get(0);
    }

    /**
     * Ob die Summe der bestätigten PV-Einheiten eine „fehlt eine Einheit?"-
     * Vermutung rechtfertigt: genug Messwerte, eine gepflegte Summe > 0, und
     * die gemessene Spitze übersteigt sie um mehr als {@link #PEAK_UEBER_SUMME_FAKTOR}.
     * Ohne genug Messwerte oder ohne Summe: kein Urteil (false, nie geraten).
     */
    public boolean moeglicherweiseFehlendeEinheit(BigDecimal summeKwp, PvPeak peak) {
        if (summeKwp == null || summeKwp.signum() <= 0 || peak == null || peak.peakKw() == null
                || peak.buckets() < PEAK_MIN_BUCKETS) {
            return false;
        }
        return peak.peakKw().doubleValue() > summeKwp.doubleValue() * PEAK_UEBER_SUMME_FAKTOR;
    }
}
