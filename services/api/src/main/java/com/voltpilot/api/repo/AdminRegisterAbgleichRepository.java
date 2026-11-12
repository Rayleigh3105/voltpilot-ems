package com.voltpilot.api.repo;

import java.math.BigDecimal;
import java.time.Instant;
import java.sql.Timestamp;
import java.util.List;
import java.util.UUID;
import org.springframework.beans.factory.annotation.Qualifier;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Repository;

/**
 * S5 (vp-mastr-mehrere-einheiten-konzept §6/§8): die CROSS-TENANT Lesequellen
 * des Plattform-Admin "Register-Abgleich" - vier Hinweis-Kategorien über alle
 * Anlagen hinweg (Messung über der Summe, Register geändert seit Übernahme,
 * Nummer an zwei Anlagen, ohne Register).
 *
 * <p>Die RLS-Umgehung folgt exakt dem Muster von {@link AdminFleetRepository}:
 * dieselbe dedizierte {@code adminJdbcTemplate}-Verbindung (BYPASSRLS-Rolle),
 * erreichbar ausschließlich aus einem
 * {@code @PreAuthorize("hasRole('platform-admin')")}-Endpunkt. Read-only, mit
 * Absicht - keine Zeile hier schreibt irgendetwas.
 */
@Repository
public class AdminRegisterAbgleichRepository {

    /** Dieselbe Schwelle wie {@link EinheitGeraetRepository#PEAK_UEBER_SUMME_FAKTOR} - eine Antwort. */
    private static final double PEAK_UEBER_SUMME_FAKTOR = EinheitGeraetRepository.PEAK_UEBER_SUMME_FAKTOR;
    private static final long PEAK_MIN_BUCKETS = EinheitGeraetRepository.PEAK_MIN_BUCKETS;

    private final JdbcTemplate jdbc;

    public AdminRegisterAbgleichRepository(@Qualifier("adminJdbcTemplate") JdbcTemplate adminJdbcTemplate) {
        this.jdbc = adminJdbcTemplate;
    }

    /** Eine Anlage mit einem Hinweis - die Kategorie steckt im aufrufenden Code, nicht hier. */
    public record Zeile(UUID siteId, String siteName, UUID tenantId, String tenantName, String hinweis) {
    }

    /**
     * Messung über der Summe: die gemessene PV-Spitze der letzten 30 Tage
     * übersteigt die Summe der bestätigten PV-Einheiten um mehr als
     * {@link #PEAK_UEBER_SUMME_FAKTOR} - "fehlt eine Einheit?" (Abschnitt 4.4),
     * cross-tenant. Nur Anlagen mit mindestens einer bestätigten PV-Einheit
     * UND genug Messwerten; eine Anlage ohne jede Einheit gehört zu
     * {@link #ohneRegister(Instant)}, nicht hierher.
     */
    public List<Zeile> messungUeberSumme(Instant seit) {
        return jdbc.query(
                "WITH summen AS ("
                        + "  SELECT site_id, SUM(leistung_kwp) AS summe_kwp FROM register_einheit"
                        + "  WHERE art = 'pv' AND bestaetigt_am IS NOT NULL AND leistung_kwp IS NOT NULL"
                        + "  GROUP BY site_id HAVING SUM(leistung_kwp) > 0"
                        + "), peaks AS ("
                        + "  SELECT site_id, max(pv_kwh) * 4 AS peak_kw,"
                        + "    count(*) FILTER (WHERE pv_kwh IS NOT NULL) AS buckets"
                        + "  FROM telemetry_rollup_15m WHERE bucket >= ? GROUP BY site_id"
                        + ") "
                        + "SELECT s.id AS site_id, s.name AS site_name, t.id AS tenant_id, t.name AS tenant_name,"
                        + "  summen.summe_kwp, peaks.peak_kw "
                        + "FROM summen "
                        + "JOIN peaks ON peaks.site_id = summen.site_id AND peaks.buckets >= ? "
                        + "JOIN site s ON s.id = summen.site_id "
                        + "JOIN tenant t ON t.id = s.tenant_id "
                        + "WHERE peaks.peak_kw > summen.summe_kwp * ? "
                        + "ORDER BY t.name, s.name",
                (rs, i) -> new Zeile(
                        rs.getObject("site_id", UUID.class), rs.getString("site_name"),
                        rs.getObject("tenant_id", UUID.class), rs.getString("tenant_name"),
                        String.format(java.util.Locale.GERMANY,
                                "Gemessene Spitze %.1f kW über der Summe %.1f kWp bestätigter Einheiten",
                                rs.getBigDecimal("peak_kw").doubleValue(),
                                rs.getBigDecimal("summe_kwp").doubleValue())),
                Timestamp.from(seit), PEAK_MIN_BUCKETS, PEAK_UEBER_SUMME_FAKTOR);
    }

    /**
     * Register geändert seit Übernahme: eine bestätigte Einheit, deren letzter
     * Abruf ({@code r_*}) von den wirksamen, vom Kunden bestätigten Werten
     * abweicht - dieselbe {@code abweichung}-Regel wie
     * {@link RegisterEinheitRepository#COLUMNS}, nur cross-tenant.
     */
    public List<Zeile> registerGeaendertSeitUebernahme() {
        return jdbc.query(
                "SELECT re.site_id, s.name AS site_name, t.id AS tenant_id, t.name AS tenant_name,"
                        + "  re.registry_unit_id "
                        + "FROM register_einheit re "
                        + "JOIN site s ON s.id = re.site_id "
                        + "JOIN tenant t ON t.id = s.tenant_id "
                        + "WHERE re.bestaetigt_am IS NOT NULL "
                        + "  AND (re.r_inbetriebnahme IS DISTINCT FROM re.inbetriebnahme"
                        + "    OR re.r_leistung_kwp IS DISTINCT FROM re.leistung_kwp) "
                        + "ORDER BY t.name, s.name",
                (rs, i) -> new Zeile(
                        rs.getObject("site_id", UUID.class), rs.getString("site_name"),
                        rs.getObject("tenant_id", UUID.class), rs.getString("tenant_name"),
                        "Register hat sich seit der Übernahme geändert ("
                                + rs.getString("registry_unit_id") + ")"));
    }

    /**
     * Nummer an zwei Anlagen: dieselbe {@code registry_unit_id} bei zwei oder
     * mehr bestätigten Einheiten verschiedener Anlagen - ein echter
     * Datenintegritäts-Befund (eine MaStR-Nummer gehört zu genau EINER
     * Anlage), kein Lücken-Hinweis.
     */
    public List<Zeile> nummerAnZweiAnlagen() {
        return jdbc.query(
                "WITH mehrfach AS ("
                        + "  SELECT registry_unit_id FROM register_einheit"
                        + "  WHERE registry_unit_id IS NOT NULL AND bestaetigt_am IS NOT NULL"
                        + "  GROUP BY registry_unit_id HAVING COUNT(DISTINCT site_id) > 1"
                        + ") "
                        + "SELECT DISTINCT re.site_id, s.name AS site_name, t.id AS tenant_id, t.name AS tenant_name,"
                        + "  re.registry_unit_id "
                        + "FROM register_einheit re "
                        + "JOIN mehrfach m ON m.registry_unit_id = re.registry_unit_id "
                        + "JOIN site s ON s.id = re.site_id "
                        + "JOIN tenant t ON t.id = s.tenant_id "
                        + "WHERE re.bestaetigt_am IS NOT NULL "
                        + "ORDER BY re.registry_unit_id, t.name, s.name",
                (rs, i) -> new Zeile(
                        rs.getObject("site_id", UUID.class), rs.getString("site_name"),
                        rs.getObject("tenant_id", UUID.class), rs.getString("tenant_name"),
                        "Nummer " + rs.getString("registry_unit_id") + " auch an einer anderen Anlage bestätigt"));
    }

    /**
     * Ohne Register: eine Anlage mit einer PV-Nennleistung (asset.pv_capacity_kwp
     * &gt; 0), aber ohne jede {@code register_einheit} - nie mit MaStR
     * verknüpft.
     */
    public List<Zeile> ohneRegister() {
        return jdbc.query(
                "SELECT s.id AS site_id, s.name AS site_name, t.id AS tenant_id, t.name AS tenant_name,"
                        + "  a.pv_capacity_kwp "
                        + "FROM asset a "
                        + "JOIN site s ON s.id = a.site_id "
                        + "JOIN tenant t ON t.id = s.tenant_id "
                        + "WHERE a.type = 'pv' AND a.is_primary AND a.pv_capacity_kwp > 0 "
                        + "  AND NOT EXISTS (SELECT 1 FROM register_einheit re WHERE re.site_id = s.id) "
                        + "ORDER BY t.name, s.name",
                (rs, i) -> new Zeile(
                        rs.getObject("site_id", UUID.class), rs.getString("site_name"),
                        rs.getObject("tenant_id", UUID.class), rs.getString("tenant_name"),
                        String.format(java.util.Locale.GERMANY,
                                "%.1f kWp gepflegt, aber nie mit dem Register verknüpft",
                                rs.getBigDecimal("pv_capacity_kwp").doubleValue())));
    }
}
