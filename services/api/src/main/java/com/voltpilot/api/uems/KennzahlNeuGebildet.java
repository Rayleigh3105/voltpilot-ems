package com.voltpilot.api.uems;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.voltpilot.api.uems.EreignisVokabular.Urheber;
import com.voltpilot.api.uems.EreignisVokabular.Urteil;
import java.nio.charset.StandardCharsets;
import java.sql.Connection;
import java.sql.PreparedStatement;
import java.sql.SQLException;
import java.sql.Timestamp;
import java.time.Instant;
import java.util.ArrayList;
import java.util.List;
import java.util.UUID;

/**
 * Die Meldung {@code kennzahl_neu_gebildet} (UEMS AP-11 IP-8) — was die Kaskaden-Naht der Kennzahlen neu gebildet hat.
 *
 * <p>Eine Meldung je Kennzahl-Periode, deren ENDGÜLTIGER Wert Version n + 1 wurde; ein vorläufiger Wert, der ohne neue
 * Version nachzieht, meldet nichts (AP-11 V3). Urheber {@code cloud} — entschieden hat ein Mensch, und das meldet
 * {@code correction}. Bezug die Kennzahl (Kennzeichen), [von, bis) die Periode in der Zone ihres Geltungsbereichs, Pflicht
 * der Auslöser ({@code K-…} oder {@code EW-…}) und die neue Version. Geschrieben in DERSELBEN Transaktion wie die
 * Versionen: bricht die Kaskade ab, gibt es auch keine Meldung. Die Kennung ist abgeleitet; eine Wiederholung schreibt
 * nichts. Gelesen von AP-12 (Revision freigegebener Berichte).
 */
final class KennzahlNeuGebildet {

    private static final ObjectMapper JSON = new ObjectMapper();

    static final String ART = "kennzahl_neu_gebildet";

    private KennzahlNeuGebildet() {}

    /** Meldet jede neue Version n + 1 — in der Reihenfolge, in der die Kaskade sie bildete. */
    static List<UUID> melden(Connection con, UUID tenant, String ausloeser, List<KennzahlLauf.Neu> neu, Instant jetzt)
            throws SQLException {
        List<UUID> ids = new ArrayList<>();
        for (KennzahlLauf.Neu n : neu) {
            ids.add(meldung(con, tenant, ausloeser, n, jetzt));
        }
        return List.copyOf(ids);
    }

    private static UUID meldung(Connection con, UUID tenant, String ausloeser, KennzahlLauf.Neu n, Instant jetzt)
            throws SQLException {
        UUID id = UUID.nameUUIDFromBytes((ART + ":" + tenant + ":" + n.kennzahl() + ":" + n.periodeArt() + ":" + n.von()
                + ":" + n.version()).getBytes(StandardCharsets.UTF_8));
        Instant von = n.von().atStartOfDay(n.zone()).toInstant();
        Instant bis = n.bis().plusDays(1).atStartOfDay(n.zone()).toInstant();
        ObjectNode e = JSON.createObjectNode();
        e.put("ereignis_id", id.toString());
        e.put("art", ART);
        e.put("von", von.toString());
        e.put("bis", bis.toString());
        e.put("kennzahl", n.kennzeichen());
        e.put("ausloeser", ausloeser);
        e.put("version", n.version());
        Urteil urteil = EreignisVokabular.pruefe(e, Urheber.CLOUD);
        if (!urteil.angenommen()) {
            throw new IllegalStateException(ART + "-Meldung verworfen: " + urteil.grund() + " " + urteil.hinweis());
        }
        try (PreparedStatement ps = con.prepareStatement("""
                INSERT INTO messreihe_ereignis (zeit, tenant_id, ereignis_id, art, urheber, von, bis, kennungen, nutzlast,
                       eingang)
                VALUES (?, ?, ?, 'kennzahl_neu_gebildet', 'cloud', ?, ?, ?::jsonb, ?::jsonb, ?)
                ON CONFLICT DO NOTHING
                """)) {
            ps.setTimestamp(1, Timestamp.from(von));
            ps.setObject(2, tenant);
            ps.setObject(3, id);
            ps.setTimestamp(4, Timestamp.from(von));
            ps.setTimestamp(5, Timestamp.from(bis));
            ps.setString(6, JSON.createObjectNode().put("kennzahl", n.kennzeichen()).toString());
            ps.setString(7, JSON.createObjectNode().put("ausloeser", ausloeser).put("version", n.version()).toString());
            ps.setTimestamp(8, Timestamp.from(jetzt));
            ps.executeUpdate();
        }
        return id;
    }
}
