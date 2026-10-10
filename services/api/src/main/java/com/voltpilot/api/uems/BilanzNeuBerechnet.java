package com.voltpilot.api.uems;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.voltpilot.api.uems.EreignisVokabular.Urheber;
import com.voltpilot.api.uems.EreignisVokabular.Urteil;
import java.nio.charset.StandardCharsets;
import java.sql.Connection;
import java.sql.PreparedStatement;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.sql.Timestamp;
import java.time.Instant;
import java.time.LocalDate;
import java.time.ZoneId;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;

/**
 * Die Meldung {@code bilanz_neu_berechnet} (UEMS AP-10 IP-11) — der Anschluss der Kostenstellen-Sicht an die
 * VORHANDENE Korrektur-Kaskade ({@link KorrekturKaskade}, AP-08 IP-17). Keine zweite Kaskade: die Kaskade rechnet,
 * diese Stelle sagt nur, WESSEN Bilanz-Werte sich dadurch geändert haben.
 *
 * <p>Bilanz-Werte einer Messstelle sind (1) die Versionen einer BERECHNETEN Messstelle, die
 * {@link BerechnetePeriodenLauf#nachKorrektur} eben geschrieben hat, und (2) die VERTEILTEN Werte einer GEMESSENEN
 * Messstelle, deren korrigierte Reihe sie führend liest und die an den betroffenen Tagen auf Kostenstellen verteilt
 * ist. Verteilte Werte werden nie gespeichert — sie entstehen beim Lesen aus den Tageswerten und tragen die Version
 * ihrer Quelle ({@link KostenstelleEnergieRegeln}); darum ist die Meldung ihre einzige Spur.
 *
 * <p>Eine Meldung je Messstelle und Anlass-Fassung, Urheber {@code cloud} (entschieden hat ein Mensch — das meldet
 * {@code correction}), in DERSELBEN Transaktion wie die Versionen: bricht die Kaskade ab, gibt es auch keine Meldung.
 * Die Kennung ist abgeleitet; eine Wiederholung schreibt nichts.
 */
final class BilanzNeuBerechnet {

    private static final ObjectMapper JSON = new ObjectMapper();

    static final String ART = "bilanz_neu_berechnet";

    private BilanzNeuBerechnet() {}

    /**
     * Meldet jede Messstelle, deren Bilanz-Werte die Verarbeitung eines Anlasses geändert hat.
     *
     * @param berechnete die Kennzeichen der berechneten Messstellen, die eine neue Version bekamen
     * @param versionen wie viele Versionen die Verarbeitung schrieb — ohne neue Version ändert sich nichts
     * @return die Kennungen der Meldungen, nach Kennzeichen der Messstelle
     */
    static List<UUID> melden(Connection con, UUID tenant, String anlass, int fassung, String status,
            List<KorrekturKaskade.Reihe> reihen, Instant von, Instant bis, ZoneId zone, LocalDate ersterTag,
            LocalDate letzterTag, List<String> berechnete, int versionen, Instant jetzt) throws SQLException {
        if (versionen == 0) {
            return List.of();
        }
        Map<String, UUID> messstellen = new LinkedHashMap<>();
        if (!berechnete.isEmpty()) {
            try (PreparedStatement ps = con.prepareStatement("SELECT id, kennzeichen FROM messstelle "
                    + "WHERE tenant_id = ? AND kennzeichen = ANY (?) ORDER BY kennzeichen")) {
                ps.setObject(1, tenant);
                ps.setArray(2, con.createArrayOf("text", berechnete.toArray()));
                sammeln(ps, messstellen);
            }
        }
        for (KorrekturKaskade.Reihe r : reihen) {
            try (PreparedStatement ps = con.prepareStatement("""
                    SELECT DISTINCT m.id, m.kennzeichen
                      FROM messstelle m
                      JOIN messstelle_quelle q ON q.messstelle_id = m.id AND q.tenant_id = m.tenant_id
                     WHERE m.tenant_id = ? AND q.entity_id = ? AND q.kanal = ? AND q.rolle = 'fuehrend'
                       AND q.gueltig_ab < ? AND (q.gueltig_bis IS NULL OR q.gueltig_bis > ?)
                       AND EXISTS (SELECT 1 FROM messstelle_verteilung v
                                    WHERE v.tenant_id = m.tenant_id AND v.messstelle_id = m.id
                                      AND v.aufgehoben_am IS NULL AND v.gueltig_ab <= ?
                                      AND (v.gueltig_bis IS NULL OR v.gueltig_bis >= ?))
                     ORDER BY m.kennzeichen
                    """)) {
                ps.setObject(1, tenant);
                ps.setObject(2, r.entity());
                ps.setString(3, r.kanal());
                ps.setTimestamp(4, Timestamp.from(bis));
                ps.setTimestamp(5, Timestamp.from(von));
                ps.setObject(6, letzterTag);
                ps.setObject(7, ersterTag);
                sammeln(ps, messstellen);
            }
        }
        Instant tageVon = ersterTag.atStartOfDay(zone).toInstant();
        Instant tageBis = letzterTag.plusDays(1).atStartOfDay(zone).toInstant();
        List<UUID> ids = new ArrayList<>();
        for (Map.Entry<String, UUID> m : messstellen.entrySet().stream()
                .sorted(Map.Entry.comparingByKey()).toList()) {
            ids.add(meldung(con, tenant, anlass, fassung, status, m.getKey(), m.getValue(), tageVon, tageBis, jetzt));
        }
        return List.copyOf(ids);
    }

    private static void sammeln(PreparedStatement ps, Map<String, UUID> messstellen) throws SQLException {
        try (ResultSet rs = ps.executeQuery()) {
            while (rs.next()) {
                messstellen.putIfAbsent(rs.getString("kennzeichen"), rs.getObject("id", UUID.class));
            }
        }
    }

    private static UUID meldung(Connection con, UUID tenant, String anlass, int fassung, String status,
            String kennzeichen, UUID messstelle, Instant von, Instant bis, Instant jetzt) throws SQLException {
        UUID id = UUID.nameUUIDFromBytes((ART + ":" + tenant + ":" + anlass + ":" + fassung + ":" + status + ":"
                + messstelle).getBytes(StandardCharsets.UTF_8));
        ObjectNode e = JSON.createObjectNode();
        e.put("ereignis_id", id.toString());
        e.put("art", ART);
        e.put("von", von.toString());
        e.put("bis", bis.toString());
        e.put("messstelle", kennzeichen);
        e.put("ausloeser", anlass);
        Urteil urteil = EreignisVokabular.pruefe(e, Urheber.CLOUD);
        if (!urteil.angenommen()) {
            throw new IllegalStateException(ART + "-Meldung verworfen: " + urteil.grund() + " " + urteil.hinweis());
        }
        try (PreparedStatement ps = con.prepareStatement("""
                INSERT INTO messreihe_ereignis (zeit, tenant_id, ereignis_id, art, urheber, von, bis, kennungen,
                       messstelle_id, nutzlast, eingang)
                VALUES (?, ?, ?, 'bilanz_neu_berechnet', 'cloud', ?, ?, ?::jsonb, ?, ?::jsonb, ?)
                ON CONFLICT DO NOTHING
                """)) {
            ps.setTimestamp(1, Timestamp.from(von));
            ps.setObject(2, tenant);
            ps.setObject(3, id);
            ps.setTimestamp(4, Timestamp.from(von));
            ps.setTimestamp(5, Timestamp.from(bis));
            ps.setString(6, JSON.createObjectNode().put("messstelle", kennzeichen).toString());
            ps.setObject(7, messstelle);
            ps.setString(8, JSON.createObjectNode().put("ausloeser", anlass).toString());
            ps.setTimestamp(9, Timestamp.from(jetzt));
            ps.executeUpdate();
        }
        return id;
    }
}
