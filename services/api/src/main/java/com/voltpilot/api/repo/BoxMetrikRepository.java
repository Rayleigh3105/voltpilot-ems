package com.voltpilot.api.repo;

import java.sql.Timestamp;
import java.time.Instant;
import java.util.ArrayList;
import java.util.Collection;
import java.util.List;
import java.util.UUID;
import org.springframework.beans.factory.annotation.Qualifier;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Repository;

/**
 * AP-15 IP-11 (NW-9): die Rohzahlen hinter den Box-Metriken der Gemeinsamen Steuerung. <b>Nur
 * Lesepfade</b>, nur Kennungen und Zeitpunkte — kein Name, keine Seriennummer.
 *
 * <p><b>Welche Boxen.</b> Nur aktive Boxen mit Bezug: eine Zeile in {@code plan_zustellung} (die
 * Box hat einen Plan 2.0 veröffentlicht bekommen oder quittiert), ein Herzschlag-Block
 * {@code gemeinsame_steuerung} seit dem Start dieses Prozesses (die Box hält einen Plan 2.0) oder
 * eine JETZT gültige Mitgliedschaft in einer Gemeinsamen Steuerung ({@code steuerungsverbund_mitglied},
 * IP-4; Lesart wie {@code SteuerungsverbundRepository}: nicht aufgehoben, {@code [gueltig_ab,
 * gueltig_bis)}). Eine Bestandsbox ohne all das erscheint nicht — keine Reihe je Box der Flotte
 * (Übergabe docs/rollout/gemeinsame-steuerung-metriken.md).
 *
 * <p><b>Welche Zeitpunkte.</b> „veröffentlicht“ und „angenommen“ sind die Erzeugung
 * ({@code generated_at}) des jüngsten veröffentlichten bzw. angenommenen Plans — dieselbe Ordnung
 * wie {@code PlanZustellungRepository#stand} und damit der Fall R11 („erzeugt 10:15 · angenommen
 * 10:00“). Beides ist die Uhr des Optimierers, nicht die der Box (A8), und keine Ankunftszeit:
 * die retained Quittung, die der Broker nach jedem Neustart der api erneut zustellt, setzt das Alter
 * nicht zurück.
 *
 * <p>Wie {@link UemsMetricsRepository} über die BYPASSRLS-Rolle: ohne {@code TenantContext} gäbe die
 * Mandanten-RLS null Zeilen, und null Zeilen hieße hier „keine Box stumm“.
 */
@Repository
public class BoxMetrikRepository {

    /** Die Ordnung von {@code PlanZustellungRepository#stand}, wörtlich. */
    private static final String JUENGSTER =
            " ORDER BY z.generated_at DESC NULLS LAST, COALESCE(z.veroeffentlicht_um, z.quittiert_um) DESC LIMIT 1";

    private static final String BOXEN = """
            SELECT d.id AS device_id, d.tenant_id, d.site_id,
                   d.device_status_seen_at AS herzschlag,
                   COALESCE(d.supports @> '["plan_quittung"]'::jsonb, false) AS quittiert,
                   v.erzeugt AS veroeffentlicht, a.erzeugt AS angenommen,
                   m.rolle, m.stufe, m.gesendet_epoche, m.gesendet_revision, m.gesendet_am,
                   m.quittiert_epoche, m.quittiert_revision,
                   COALESCE(u.anzahl, 0) AS uhrereignisse
              FROM device d
              LEFT JOIN LATERAL (SELECT COALESCE(z.generated_at, z.veroeffentlicht_um) AS erzeugt
                                   FROM plan_zustellung z
                                  WHERE z.device_id = d.id AND z.veroeffentlicht_um IS NOT NULL
            """ + JUENGSTER + """
                                ) v ON true
              LEFT JOIN LATERAL (SELECT COALESCE(z.generated_at, z.quittiert_um) AS erzeugt
                                   FROM plan_zustellung z
                                  WHERE z.device_id = d.id AND z.urteil = 'angenommen'
            """ + JUENGSTER + """
                                ) a ON true
              LEFT JOIN LATERAL (SELECT m.rolle, s.stufe, m.gesendet_epoche, m.gesendet_revision,
                                        m.gesendet_am, m.quittiert_epoche, m.quittiert_revision
                                   FROM steuerungsverbund_mitglied m
                                   JOIN steuerungsverbund s ON s.id = m.steuerungsverbund_id
                                  WHERE m.device_id = d.id AND m.aufgehoben_am IS NULL
                                    AND m.gueltig_ab <= now()
                                    AND (m.gueltig_bis IS NULL OR m.gueltig_bis > now())
                                  ORDER BY m.gueltig_ab DESC LIMIT 1) m ON true
              LEFT JOIN LATERAL (
                    SELECT count(*) AS anzahl
                      FROM messreihe_ereignis e
                     WHERE e.tenant_id = d.tenant_id
                       AND e.art IN ('clock_jump', 'clock_ahead')
                       AND e.device_id = d.id
              ) u ON true
             WHERE d.ausgebaut_am IS NULL
               AND (EXISTS (SELECT 1 FROM plan_zustellung z WHERE z.device_id = d.id)
                    OR d.id = ANY (?)
                    OR m.rolle IS NOT NULL)
             ORDER BY d.tenant_id, d.site_id, d.id
            """;

    /**
     * Eine Box mit Bezug. {@code herzschlag} null = seit AP-06 IP-15 kein Status-Herzschlag;
     * {@code veroeffentlicht}/{@code angenommen} null = nie; {@code quittiert} = die Box meldet
     * {@code plan_quittung} (sonst bleibt „angenommen“ leer, ohne Alarm).
     */
    public record Box(UUID deviceId, UUID tenantId, UUID siteId, Instant herzschlag, boolean quittiert,
            Instant veroeffentlicht, Instant angenommen, Mitglied mitglied, long uhrereignisse) {

        /** Kompatible Test-Naht ohne Uhr-Ereignisse. */
        public Box(UUID deviceId, UUID tenantId, UUID siteId, Instant herzschlag, boolean quittiert,
                Instant veroeffentlicht, Instant angenommen, Mitglied mitglied) {
            this(deviceId, tenantId, siteId, herzschlag, quittiert, veroeffentlicht, angenommen, mitglied, 0L);
        }

        /** Eine Box ohne Mitgliedschaft. */
        public Box(UUID deviceId, UUID tenantId, UUID siteId, Instant herzschlag, boolean quittiert,
                Instant veroeffentlicht, Instant angenommen) {
            this(deviceId, tenantId, siteId, herzschlag, quittiert, veroeffentlicht, angenommen, null, 0L);
        }
    }

    /**
     * Die jetzt gültige Mitgliedschaft: Rolle ({@code fuehrt} | {@code steuert_mit}), Stufe der
     * Gemeinsamen Steuerung, zuletzt gesendetes und quittiertes Anteils-Dokument (je {@code null} =
     * noch nie; beschrieben ab IP-7).
     */
    public record Mitglied(String rolle, String stufe, Long gesendetEpoche, Long gesendetRevision,
            Instant gesendetAm, Long quittiertEpoche, Long quittiertRevision) {}

    private final JdbcTemplate admin;

    public BoxMetrikRepository(@Qualifier("adminJdbcTemplate") JdbcTemplate admin) {
        this.admin = admin;
    }

    /** Die Boxen mit Bezug; {@code mitBlock} sind die Boxen, deren Herzschlag einen Block trug. */
    public List<Box> boxen(Collection<UUID> mitBlock) {
        List<Box> boxen = new ArrayList<>();
        admin.query(BOXEN, ps -> ps.setArray(1, ps.getConnection().createArrayOf("uuid", mitBlock.toArray())),
                rs -> {
                    boxen.add(new Box(rs.getObject("device_id", UUID.class), rs.getObject("tenant_id", UUID.class),
                            rs.getObject("site_id", UUID.class), instant(rs.getTimestamp("herzschlag")),
                            rs.getBoolean("quittiert"), instant(rs.getTimestamp("veroeffentlicht")),
                            instant(rs.getTimestamp("angenommen")), mitglied(rs), rs.getLong("uhrereignisse")));
                });
        return boxen;
    }

    private static Mitglied mitglied(java.sql.ResultSet rs) throws java.sql.SQLException {
        String rolle = rs.getString("rolle");
        return rolle == null ? null : new Mitglied(rolle, rs.getString("stufe"),
                (Long) rs.getObject("gesendet_epoche"), (Long) rs.getObject("gesendet_revision"),
                instant(rs.getTimestamp("gesendet_am")), (Long) rs.getObject("quittiert_epoche"),
                (Long) rs.getObject("quittiert_revision"));
    }

    private static Instant instant(Timestamp t) {
        return t == null ? null : t.toInstant();
    }
}
