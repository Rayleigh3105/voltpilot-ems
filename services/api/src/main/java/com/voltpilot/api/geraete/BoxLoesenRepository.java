package com.voltpilot.api.geraete;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.voltpilot.api.geraete.BoxLoesenRegel.BoxBefund;
import java.sql.Timestamp;
import java.time.Duration;
import java.time.Instant;
import java.util.UUID;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Repository;

/**
 * Der RLS-gezäunte Teil von „Vom Kunden lösen" (L1): die erneute Prüfung UNTER {@code lockReference}
 * (Mandantentrennung - der Aufrufer hat {@link com.voltpilot.api.tenant.TenantContext} vorher auf den
 * Mandanten DIESER Box gesetzt, Muster {@code BenutzerService.erster}; keine BYPASSRLS-Rolle) und das
 * Protokoll. Der Erst-Befund (vor dem Sperren, über jeden Mandanten) kommt aus
 * {@link AdminBoxLoesenRepository}.
 */
@Repository
public class BoxLoesenRepository {

    /** Report Abschnitt 3.3/B3: höchstens 14 Tage Hinweis beim Kunden. */
    static final Duration HINWEIS_DAUER = Duration.ofDays(14);

    private final JdbcTemplate jdbc;
    private final ObjectMapper json;

    public BoxLoesenRepository(JdbcTemplate jdbc, ObjectMapper json) {
        this.jdbc = jdbc;
        this.json = json;
    }

    /**
     * Wie {@link #befundUnterSperre}, aber mit den Stammdaten (Kennung, Anlage, verbunden am) für
     * das Protokoll - gebraucht vom Kunden-Weg (Box verbinden S4, {@code DeviceController.claim} mit
     * {@code ersetzt}), der die Geräte-ID schon aus der Anfrage hat und keinen zweiten, admin-
     * geschützten Erst-Befund (wie {@link AdminBoxLoesenRepository}) braucht - der Aufrufer sitzt
     * schon im eigenen Mandanten (RLS), nicht BYPASSRLS über jeden Mandanten.
     */
    public java.util.Optional<BoxBefundSql.Zeile> zeileUnterSperre(UUID deviceId) {
        return jdbc.query("SELECT " + BoxBefundSql.FELDER + BoxBefundSql.VON
                        + " WHERE d.id = ? AND d.ausgebaut_am IS NULL",
                        BoxBefundSql::zeile, deviceId)
                .stream().findFirst();
    }

    /**
     * Der Befund UNTER der Sperre, über die Geräte-ID (RLS scopt auf den gesetzten Mandanten). Ist
     * die Box inzwischen weg (gelöst, ausgebaut) oder gehört sie - ein gefälschter Pfad - einem
     * anderen Mandanten, ist sie {@code aktiv = false}: derselbe Grund {@code verbund} wie eine
     * schon ausgebaute Box, kein Absturz.
     */
    public BoxBefund befundUnterSperre(UUID deviceId) {
        return zeileUnterSperre(deviceId)
                .map(BoxBefundSql.Zeile::befund)
                .orElse(new BoxBefund(false, null, null, null, false, null));
    }

    /** Was ins Protokoll geschrieben wird (Abschnitt 3.3 Punkt 6). */
    public record Eintrag(UUID tenantId, UUID siteId, String siteName, UUID deviceId, String externalRef,
            Instant verbundenAm, String geloestVonSub, String geloestVonName, String geloestArt,
            String anlass, String anlassText, BoxBefund befund) {
    }

    public void protokollieren(Eintrag e) {
        jdbc.update("INSERT INTO box_loesen_protokoll (tenant_id, site_id, site_name, device_id, external_ref, "
                        + "verbunden_am, geloest_von_sub, geloest_von_name, geloest_art, anlass, anlass_text, befund) "
                        + "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?::jsonb)",
                e.tenantId(), e.siteId(), e.siteName(), e.deviceId(), e.externalRef(),
                Timestamp.from(e.verbundenAm()), e.geloestVonSub(), e.geloestVonName(),
                e.geloestArt(), e.anlass(), e.anlassText(), befundJson(e.befund()));
    }

    private String befundJson(BoxBefund b) {
        try {
            return json.writeValueAsString(java.util.Map.of(
                    "herzschlagAm", String.valueOf(b.herzschlagAm()),
                    "messwertAm", String.valueOf(b.messwertAm()),
                    "meldungAm", String.valueOf(b.meldungAm()),
                    "hatZustaendigkeiten", b.hatZustaendigkeiten(),
                    "schluesselAbgeholtAm", String.valueOf(b.schluesselAbgeholtAm())));
        } catch (com.fasterxml.jackson.core.JsonProcessingException ex) {
            throw new IllegalStateException(ex);
        }
    }

    /** B3: der Hinweis beim Kunden an der Anlage, solange keine Box verbunden ist, höchstens 14 Tage. */
    public record Hinweis(String anlass, String anlassText, Instant geloestAm, Instant bisSpaetestens) {
    }

    /**
     * Für {@code GET /api/v1/overview} - EINE Abfrage über jede sichtbare Anlage (Muster
     * {@link com.voltpilot.api.repo.OverviewRepository#sitesWithUnlinkedBattery}), statt je Anlage
     * eine eigene. Nur Anlagen ohne aktive Box UND mit einem Lösen-Eintrag der letzten 14 Tage.
     */
    public java.util.Map<UUID, Hinweis> hinweiseJeAnlage() {
        java.util.Map<UUID, Hinweis> aus = new java.util.HashMap<>();
        jdbc.query("SELECT DISTINCT ON (p.site_id) p.site_id, p.anlass, p.anlass_text, p.geloest_am "
                        + "FROM box_loesen_protokoll p "
                        + "WHERE p.site_id IS NOT NULL AND p.geloest_am > now() - interval '14 days' "
                        + "AND NOT EXISTS (SELECT 1 FROM device d WHERE d.site_id = p.site_id "
                        + "AND d.ausgebaut_am IS NULL) "
                        + "ORDER BY p.site_id, p.geloest_am DESC",
                rs -> {
                    Instant geloestAm = rs.getTimestamp("geloest_am").toInstant();
                    aus.put(rs.getObject("site_id", UUID.class), new Hinweis(rs.getString("anlass"),
                            rs.getString("anlass_text"), geloestAm, geloestAm.plus(HINWEIS_DAUER)));
                });
        return aus;
    }
}
