package com.voltpilot.api.uems;

import java.sql.Array;
import java.sql.Timestamp;
import java.time.Instant;
import java.util.Collection;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Repository;

/**
 * Der Bestand einer Anlage, so wie die Vorschlagsliste ihn braucht (UEMS AP-06 IP-4), und die
 * zwei Verweise, die erst die Bestätigung setzt. Alles unter RLS — eine fremde Anlage hat hier
 * keine Komponenten.
 *
 * <p>Die Gruppierung selbst ist Vertrag ({@link DatenquelleRegeln#vorschlagsliste}); dieses
 * Repository liest nur die Fakten, aus denen sie entsteht, nach Regeln, die es schon gibt:
 * <ul>
 *   <li><b>Reihenbeginn</b> ist der Beginn der ersten Speisung der Komponente
 *       ({@code geraet_komponente}, AP-04: der Beginn ihres Verlaufs in VoltPilot); ohne
 *       Speisung ihre Anlagezeit auf die Minute.</li>
 *   <li><b>Komponiertes Geschwister</b> ist, was die Geräte-Ableitung ({@code
 *       uems_geraet_ableiten_fuer}, V20260911240000) dafür hält — Erzeuger, Netzzähler oder
 *       Hausverbrauch ohne Pin, Marke, Modell und eigene Verbindung —, und sein Wechselrichter
 *       ({@code anker}) ist das andere Mitglied seines laufenden Geräts.</li>
 *   <li><b>Station</b>: die Ladepunkt-Kennung aus {@code device_charge_point} und die Box, an
 *       deren Zentrale die Station hängt — nur eine Box, die nicht ausgebaut ist (AP-07 IP-11).</li>
 * </ul>
 */
@Repository
public class DatenquelleBestandRepository {

    private final JdbcTemplate jdbc;

    public DatenquelleBestandRepository(JdbcTemplate jdbc) {
        this.jdbc = jdbc;
    }

    /**
     * Eine Komponente der Anlage mit ihrem heutigen Anschluss.
     *
     * @param box          {@code measurement_point.device_id} — gesetzt nur an komponierten
     *                     Zeilen; sonst liest die führende Box (der Registry-Push)
     * @param datenquelle  die Quelle, die sie schon hat, oder {@code null}
     * @param geraetQuelle die Quelle des Geräts ihrer laufenden Speisung, oder {@code null}
     * @param anker        bei einem komponierten Geschwister: der Wechselrichter seines Geräts
     * @param stationen    wie viele Ladepunkt-Kennungen auf sie zeigen (nur eine ist eindeutig)
     */
    public record Bestand(UUID id, String name, String art, UUID box, String communication,
            String connectionJson, boolean steuerbar, UUID datenquelle,
            UUID geraetQuelle, UUID anker, Instant reihenbeginn, int stationen, UUID stationBox,
            String stationId) {}

    /** Die Komponenten der Anlage in Anlage-Reihenfolge (created_at, id). */
    public List<Bestand> derAnlage(UUID siteId) {
        return jdbc.query("""
                WITH k AS (
                    SELECT mp.id, mp.label, coalesce(mp.entity_type, mp.role) AS art, mp.device_id,
                           mp.communication, mp.connection_json, mp.control,
                           mp.data_source_id, mp.created_at,
                           (SELECT v.geraet_id FROM geraet_komponente v
                            WHERE v.entity_id = mp.id AND v.gueltig_ab <= now()
                              AND (v.gueltig_bis IS NULL OR v.gueltig_bis > now())) AS geraet_id,
                           (coalesce(mp.entity_type, mp.role) IN ('producer', 'pv-generation', 'grid-meter',
                                                                  'house-load')
                            AND mp.edge_source_id IS NULL
                            AND nullif(btrim(mp.brand), '') IS NULL
                            AND nullif(btrim(mp.model), '') IS NULL
                            AND (mp.connection_json IS NULL
                                 OR mp.connection_json IN ('null'::jsonb, '{}'::jsonb))) AS geschwister
                    FROM measurement_point mp
                    WHERE mp.site_id = ?
                ),
                station AS (
                    -- Nur Stationen hinter einer Box, die am Betrieb teilnimmt (UEMS AP-07 IP-11):
                    -- die Zeilen einer ausgebauten Box bleiben, sie ist aber keine Station-Box mehr.
                    SELECT c.entity_id, c.device_id, c.charge_point_id
                    FROM device_charge_point c
                    WHERE EXISTS (SELECT 1 FROM device d WHERE d.id = c.device_id AND d.ausgebaut_am IS NULL)
                )
                SELECT k.id, k.label, k.art, k.device_id, k.communication,
                       k.connection_json::text AS connection_json, k.control,
                       k.data_source_id,
                       (SELECT g.data_source_id FROM geraet g WHERE g.id = k.geraet_id) AS geraet_quelle,
                       CASE WHEN k.geschwister AND k.geraet_id IS NOT NULL THEN
                           (SELECT a.id FROM k a WHERE a.geraet_id = k.geraet_id AND a.id <> k.id
                              AND NOT a.geschwister ORDER BY a.created_at, a.id LIMIT 1)
                       END AS anker,
                       coalesce((SELECT min(v.gueltig_ab) FROM geraet_komponente v WHERE v.entity_id = k.id),
                                date_trunc('minute', k.created_at AT TIME ZONE 'UTC') AT TIME ZONE 'UTC')
                           AS reihenbeginn,
                       (SELECT count(*) FROM station c WHERE c.entity_id = k.id) AS stationen,
                       (SELECT c.device_id FROM station c WHERE c.entity_id = k.id
                        ORDER BY c.device_id, c.charge_point_id LIMIT 1) AS station_box,
                       (SELECT c.charge_point_id FROM station c WHERE c.entity_id = k.id
                        ORDER BY c.device_id, c.charge_point_id LIMIT 1) AS station_id
                FROM k
                ORDER BY k.created_at, k.id
                """, (rs, n) -> new Bestand(
                        rs.getObject("id", UUID.class),
                        rs.getString("label"),
                        rs.getString("art"),
                        rs.getObject("device_id", UUID.class),
                        rs.getString("communication"),
                        rs.getString("connection_json"),
                        rs.getBoolean("control"),
                        rs.getObject("data_source_id", UUID.class),
                        rs.getObject("geraet_quelle", UUID.class),
                        rs.getObject("anker", UUID.class),
                        rs.getTimestamp("reihenbeginn").toInstant(),
                        rs.getInt("stationen"),
                        rs.getObject("station_box", UUID.class),
                        rs.getString("station_id")),
                siteId);
    }

    /**
     * Seit wann eine Box in ihrer heutigen Anlage liest: ihre Anlage-Zeile oder der letzte Umzug
     * dorthin — was später ist. Früher kann sie nichts gelesen haben.
     */
    public Map<UUID, Instant> seitWannIhreAnlage(Collection<UUID> boxen) {
        Map<UUID, Instant> seit = new HashMap<>();
        if (boxen.isEmpty()) {
            return seit;
        }
        jdbc.query(con -> {
            var ps = con.prepareStatement("""
                    SELECT d.id, greatest(d.created_at,
                           coalesce((SELECT max(a.effective_at) FROM device_site_assignment a
                                     WHERE a.device_id = d.id AND a.to_site_id = d.site_id), d.created_at)) AS seit
                    FROM device d WHERE d.id = ANY(?)
                    """);
            Array ids = con.createArrayOf("uuid", boxen.toArray());
            ps.setArray(1, ids);
            return ps;
        }, rs -> {
            Timestamp t = rs.getTimestamp("seit");
            seit.put(rs.getObject("id", UUID.class), t.toInstant());
        });
        return seit;
    }

    /** Die nächste Nummer, die der Kundenbereich vergibt — ohne den Zähler zu bewegen (fehlt er: 1). */
    public int naechsteNummer() {
        List<Integer> n = jdbc.queryForList("SELECT naechste_nummer FROM data_source_kennzeichen_seq", Integer.class);
        return n.isEmpty() ? 1 : n.get(0);
    }

    /** Die Kennzeichen, die im Kundenbereich schon eine Quelle trägt (archivierte eingeschlossen). */
    public List<String> belegteKennzeichen() {
        return jdbc.queryForList("SELECT kennzeichen FROM data_source", String.class);
    }

    /**
     * Zwei Bestätigungen derselben Anlage warten aufeinander (bis zum Ende der Transaktion) —
     * die zweite sieht dann, was die erste geschrieben hat, und zählt es als unverändert.
     */
    public void sperreAnlage(UUID siteId) {
        long schluessel = siteId.getMostSignificantBits() ^ siteId.getLeastSignificantBits() ^ 0x49502d34L;
        jdbc.query("SELECT pg_advisory_xact_lock(?)", rs -> null, schluessel);
    }

    /** Setzt die Quelle an Komponenten, die noch keine haben; gibt zurück, an wie vielen. */
    public int verknuepfeKomponenten(UUID quelle, UUID siteId, List<UUID> komponenten) {
        return jdbc.update(con -> {
            var ps = con.prepareStatement("UPDATE measurement_point SET data_source_id = ? "
                    + "WHERE site_id = ? AND id = ANY(?) AND data_source_id IS NULL");
            ps.setObject(1, quelle);
            ps.setObject(2, siteId);
            ps.setArray(3, con.createArrayOf("uuid", komponenten.toArray()));
            return ps;
        });
    }

    /**
     * Setzt die Quelle am Gerät der LAUFENDEN Speisung jeder Komponente — frühere Einbauten
     * bleiben, wie sie sind; ein Gerät, das schon eine Quelle trägt, auch.
     */
    public int verknuepfeGeraete(UUID quelle, List<UUID> komponenten) {
        return jdbc.update(con -> {
            var ps = con.prepareStatement("UPDATE geraet g SET data_source_id = ? "
                    + "WHERE g.data_source_id IS NULL AND g.id IN (SELECT v.geraet_id FROM geraet_komponente v "
                    + "WHERE v.entity_id = ANY(?) AND v.gueltig_ab <= now() "
                    + "AND (v.gueltig_bis IS NULL OR v.gueltig_bis > now()))");
            ps.setObject(1, quelle);
            ps.setArray(2, con.createArrayOf("uuid", komponenten.toArray()));
            return ps;
        });
    }
}
