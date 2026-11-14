package com.voltpilot.api.repo;

import java.sql.Timestamp;
import java.time.Instant;
import java.util.List;
import java.util.UUID;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Repository;

/**
 * Die Logiken einer Anlage ({@code steuerlogik}), ihr Mitlauf auf der Box ({@code steuerlogik_lauf}) und das
 * Vergleichsprotokoll ({@code steuerlogik_wechsel}), alles unter RLS des aktuellen Mandanten
 * (V20261114180000__steuerlogik.sql). Texte und Artefakt bleiben TEXT - Byte für Byte, was kam und was der Dienst
 * gebaut hat.
 */
@Repository
public class SteuerlogikRepository {

    private final JdbcTemplate jdbc;

    public SteuerlogikRepository(JdbcTemplate jdbc) {
        this.jdbc = jdbc;
    }

    /** Eine Fassung einer Logik, ohne die großen Texte. */
    public record Fassung(UUID logikId, int fassung, UUID siteId, String name, String zustand,
            String contentHash, String berichtJson, Instant angelegtAm, String angelegtVon, Instant stillgelegtAm) {}

    /** Der jüngste gemeldete Mitlauf einer Logik auf einer Box. */
    public record Lauf(UUID deviceId, UUID logikId, int fassung, String contentHash, String zustand,
            Instant seit, String rueckmeldungJson, Instant gemeldetAm) {}

    /** Eine Zeile des Vergleichsprotokolls. */
    public record Wechsel(UUID deviceId, UUID logikId, int fassung, Instant laufSeit, long nr, Instant t,
            String geraet, String was, String neuJson, String andereJson, String lage) {}

    // --- Logiken ------------------------------------------------------------------------------------------------

    /** Die nächste Fassung einer Logik (1 für eine neue). */
    public int naechsteFassung(UUID logikId) {
        Integer max = jdbc.queryForObject("SELECT max(fassung) FROM steuerlogik WHERE logik_id = ?",
                Integer.class, logikId);
        return max == null ? 1 : max + 1;
    }

    /** Ob die Logik zu dieser Anlage gehört (unter RLS: eine fremde ist unsichtbar). */
    public boolean gehoertZu(UUID logikId, UUID siteId) {
        Integer n = jdbc.queryForObject("SELECT count(*) FROM steuerlogik WHERE logik_id = ? AND site_id = ?",
                Integer.class, logikId, siteId);
        return n != null && n > 0;
    }

    /**
     * Legt eine Fassung an und lässt sie mitlaufen; eine bis dahin mitlaufende Fassung derselben Logik wird
     * stillgelegt. In der Transaktion des Aufrufers.
     */
    public void legeAn(UUID tenantId, UUID siteId, UUID logikId, int fassung, String name, String quelltext,
            String kanonisch, String artefakt, String contentHash, String berichtJson, String von, Instant jetzt) {
        stillegen(logikId, jetzt);
        jdbc.update("""
                INSERT INTO steuerlogik (logik_id, fassung, tenant_id, site_id, name, quelltext, kanonisch, artefakt,
                                         content_hash, bericht, zustand, angelegt_am, angelegt_von)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?::jsonb, 'mitlaufend', ?, ?)
                """, logikId, fassung, tenantId, siteId, name, quelltext, kanonisch, artefakt, contentHash,
                berichtJson, Timestamp.from(jetzt), von);
    }

    /** Legt die mitlaufende Fassung still; Zahl der betroffenen Zeilen. */
    public int stillegen(UUID logikId, Instant jetzt) {
        return jdbc.update("UPDATE steuerlogik SET zustand = 'stillgelegt', stillgelegt_am = ? "
                + "WHERE logik_id = ? AND zustand = 'mitlaufend'", Timestamp.from(jetzt), logikId);
    }

    /** Alle Fassungen der Anlage, je Logik die jüngste zuerst. */
    public List<Fassung> fassungen(UUID siteId) {
        return jdbc.query("""
                SELECT logik_id, fassung, site_id, name, zustand, content_hash, bericht::text, angelegt_am,
                       angelegt_von, stillgelegt_am
                FROM steuerlogik WHERE site_id = ? ORDER BY angelegt_am DESC, logik_id, fassung DESC
                """, (rs, i) -> new Fassung(rs.getObject(1, UUID.class), rs.getInt(2), rs.getObject(3, UUID.class),
                rs.getString(4), rs.getString(5), rs.getString(6), rs.getString(7), instant(rs.getTimestamp(8)),
                rs.getString(9), instant(rs.getTimestamp(10))), siteId);
    }

    /** Der Quelltext einer Fassung, wie er kam ({@code null}, wenn es sie nicht gibt). */
    public String quelltext(UUID logikId, int fassung) {
        List<String> t = jdbc.queryForList("SELECT quelltext FROM steuerlogik WHERE logik_id = ? AND fassung = ?",
                String.class, logikId, fassung);
        return t.isEmpty() ? null : t.get(0);
    }

    /** Die Artefakte der mitlaufenden Logiken der Anlage, Byte für Byte wie gebaut. */
    public List<String> mitlaufendeArtefakte(UUID siteId) {
        return jdbc.queryForList("SELECT artefakt FROM steuerlogik WHERE site_id = ? AND zustand = 'mitlaufend' "
                + "ORDER BY angelegt_am, logik_id", String.class, siteId);
    }

    // --- Mitlauf aus dem Herzschlag ------------------------------------------------------------------------------

    /**
     * Ersetzt den Mitlauf einer Box: Logiken, die sie nicht mehr meldet, fallen weg; gemeldete werden geschrieben.
     */
    public void ersetzeLaeufe(UUID deviceId, UUID tenantId, UUID siteId, List<Lauf> laeufe, Instant gemeldet) {
        if (laeufe.isEmpty()) {
            jdbc.update("DELETE FROM steuerlogik_lauf WHERE device_id = ?", deviceId);
            return;
        }
        UUID[] ids = laeufe.stream().map(Lauf::logikId).toArray(UUID[]::new);
        jdbc.update(con -> {
            var ps = con.prepareStatement("DELETE FROM steuerlogik_lauf WHERE device_id = ? AND NOT (logik_id = ANY (?))");
            ps.setObject(1, deviceId);
            ps.setArray(2, con.createArrayOf("uuid", ids));
            return ps;
        });
        for (Lauf l : laeufe) {
            jdbc.update("""
                    INSERT INTO steuerlogik_lauf (device_id, logik_id, tenant_id, site_id, fassung, content_hash, zustand,
                                                  seit, rueckmeldung, gemeldet_am)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?::jsonb, ?)
                    ON CONFLICT (device_id, logik_id) DO UPDATE SET site_id = EXCLUDED.site_id,
                        fassung = EXCLUDED.fassung, content_hash = EXCLUDED.content_hash, zustand = EXCLUDED.zustand,
                        seit = EXCLUDED.seit, rueckmeldung = EXCLUDED.rueckmeldung, gemeldet_am = EXCLUDED.gemeldet_am
                    """, deviceId, l.logikId(), tenantId, siteId, l.fassung(), l.contentHash(), l.zustand(),
                    Timestamp.from(l.seit()), l.rueckmeldungJson(), Timestamp.from(gemeldet));
        }
    }

    /** Schreibt Zeilen des Vergleichsprotokolls; eine schon bekannte (Lauf und Nummer) bleibt, wie sie ist. */
    public void schreibeWechsel(UUID tenantId, UUID siteId, List<Wechsel> zeilen) {
        for (Wechsel w : zeilen) {
            jdbc.update("""
                    INSERT INTO steuerlogik_wechsel (device_id, logik_id, lauf_seit, nr, tenant_id, site_id, fassung, t,
                                                     geraet, was, neu, andere, lage)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?::jsonb, ?::jsonb, ?)
                    ON CONFLICT (device_id, logik_id, lauf_seit, nr) DO NOTHING
                    """, w.deviceId(), w.logikId(), Timestamp.from(w.laufSeit()), w.nr(), tenantId, siteId,
                    w.fassung(), Timestamp.from(w.t()), w.geraet(), w.was(), w.neuJson(), w.andereJson(), w.lage());
        }
    }

    /** Hält das Protokoll einer Box kurz: Zeilen vor {@code vor} fallen weg. */
    public int raeumeWechsel(UUID deviceId, Instant vor) {
        return jdbc.update("DELETE FROM steuerlogik_wechsel WHERE device_id = ? AND t < ?", deviceId,
                Timestamp.from(vor));
    }

    /** Der gemeldete Mitlauf der Anlage. */
    public List<Lauf> laeufe(UUID siteId) {
        return jdbc.query("""
                SELECT device_id, logik_id, fassung, content_hash, zustand, seit, rueckmeldung::text, gemeldet_am
                FROM steuerlogik_lauf WHERE site_id = ? ORDER BY logik_id, device_id
                """, (rs, i) -> new Lauf(rs.getObject(1, UUID.class), rs.getObject(2, UUID.class), rs.getInt(3),
                rs.getString(4), rs.getString(5), instant(rs.getTimestamp(6)), rs.getString(7),
                instant(rs.getTimestamp(8))), siteId);
    }

    /** Das Protokoll einer Logik in einem Zeitraum (halboffen), älteste zuerst, höchstens {@code grenze} Zeilen. */
    public List<Wechsel> wechsel(UUID siteId, UUID logikId, Instant von, Instant bis, int grenze) {
        return jdbc.query("""
                SELECT device_id, logik_id, fassung, lauf_seit, nr, t, geraet, was, neu::text, andere::text, lage
                FROM steuerlogik_wechsel WHERE site_id = ? AND logik_id = ? AND t >= ? AND t < ?
                ORDER BY t, lauf_seit, nr LIMIT ?
                """, (rs, i) -> new Wechsel(rs.getObject(1, UUID.class), rs.getObject(2, UUID.class), rs.getInt(3),
                instant(rs.getTimestamp(4)), rs.getLong(5), instant(rs.getTimestamp(6)), rs.getString(7),
                rs.getString(8), rs.getString(9), rs.getString(10), rs.getString(11)),
                siteId, logikId, Timestamp.from(von), Timestamp.from(bis), grenze);
    }

    private static Instant instant(Timestamp ts) {
        return ts == null ? null : ts.toInstant();
    }
}
