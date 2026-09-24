package com.voltpilot.api.uems;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import java.sql.Connection;
import java.sql.PreparedStatement;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.sql.Timestamp;
import java.time.Instant;
import java.util.ArrayList;
import java.util.List;
import java.util.UUID;

/**
 * Der Anstoß am VORGANG, Pfad 2 (UEMS AP-18 IP-7, Z5, §5.6): endet eine Bezugsbasis ({@code bezugsbasis_beendet}) oder
 * bekommt sie eine freigegebene Fassung n + 1, deren Referenzperiode in der Zielperiode liegt
 * ({@code fassung_freigegeben}), stößt das jedes OFFENE Energieziel an, das die Basis zitiert — Art
 * {@code messgrundlage_beendet} bzw. {@code messgrundlage_neu_gefasst}, Anlass-Kennung {@code BB-…/beendet} bzw.
 * {@code BB-…/Fassung-n}, je Ziel × Art × Anlass genau einmal ({@code vorgang_anstoss_energieziel_uq}), dazu die
 * Protokollzeile {@code anstoss_gesetzt}. Die Kopie der Bewertung bleibt byte-gleich; eine Person antwortet.
 *
 * <p>Gerufen vom {@link BezugsbasisAnstoss} (Pfad 2 im {@link StrukturAenderungLaeufer}) in DERSELBEN Transaktion und
 * unter demselben Wasserzeichen ({@code bezugsbasis_struktur_gelesen}) wie der Bezugsbasis-Zweig — mit der
 * administrativen Rolle (INSERT seit {@code V20260925001000}). Beendete und bewertete Ziele stößt er nicht an. Pfad 2
 * an Maßnahmen (IP-17) setzt hier daneben an.
 */
final class VorgangAnstoss {

    static final String BEENDET = "messgrundlage_beendet";
    static final String NEU_GEFASST = "messgrundlage_neu_gefasst";
    static final String AKTEUR = "VoltPilot (Struktur-Läufer)";
    private static final ObjectMapper JSON = new ObjectMapper();

    private VorgangAnstoss() {}

    /** Ein gesetzter Anstoß am Ziel. */
    record Gesetzt(UUID tenant, UUID energieziel, UUID anstoss, String art, String anlassKennung) {}

    /**
     * Eine Zeile {@code bezugsbasis_aenderung} ({@code fassung_freigegeben} mit ihrer Fassung n, oder
     * {@code bezugsbasis_beendet}) → die Anstöße an den offenen Zielen der Basis.
     */
    static List<Gesetzt> anZielen(Connection con, UUID tenant, UUID basis, String protokollArt, long eintrag,
            Instant jetzt) throws SQLException {
        String bb = text(con, "SELECT kennzeichen FROM bezugsbasis WHERE tenant_id = ? AND id = ?", tenant, basis);
        String art;
        String anlass;
        String sql = "SELECT id FROM energieziel WHERE tenant_id = ? AND bezugsbasis_id = ? AND zustand = 'offen'";
        String referenzperiode = null;
        int fassung = 0;
        if ("bezugsbasis_beendet".equals(protokollArt)) {
            art = BEENDET;
            anlass = bb + "/beendet";
        } else if ("fassung_freigegeben".equals(protokollArt)) {
            fassung = Integer.parseInt(text(con, "SELECT fassung::text FROM bezugsbasis_aenderung "
                    + "WHERE tenant_id = ? AND id = ?", tenant, eintrag));
            referenzperiode = wert(con, "SELECT referenzperiode FROM bezugsbasis_fassung WHERE tenant_id = ? "
                    + "AND bezugsbasis_id = ? AND fassung = " + fassung, tenant, basis);
            if (referenzperiode == null) {
                return List.of(); // ohne die Fassung gibt es keine Referenzperiode zu vergleichen
            }
            art = NEU_GEFASST;
            anlass = bb + "/Fassung-" + fassung;
            // Zitiert das Ziel eine frühere Fassung, und überschneidet die Referenzperiode die Zielperiode?
            sql += " AND fassung < " + fassung + " AND substring(zielperiode FROM 1 FOR 7) <= ?"
                    + " AND substring(zielperiode FROM 9 FOR 7) >= ?";
        } else {
            return List.of();
        }
        List<UUID> ziele = new ArrayList<>();
        // Ohne FOR UPDATE: die Admin-Rolle hat auf energieziel kein UPDATE; doppelt setzt ON CONFLICT nichts.
        try (PreparedStatement ps = con.prepareStatement(sql + " ORDER BY kennzeichen")) {
            ps.setObject(1, tenant);
            ps.setObject(2, basis);
            if (referenzperiode != null) {
                ps.setString(3, referenzperiode.substring(8, 15));
                ps.setString(4, referenzperiode.substring(0, 7));
            }
            try (ResultSet rs = ps.executeQuery()) {
                while (rs.next()) {
                    ziele.add(rs.getObject(1, UUID.class));
                }
            }
        }
        List<Gesetzt> gesetzt = new ArrayList<>();
        for (UUID ziel : ziele) {
            UUID id = null;
            try (PreparedStatement ps = con.prepareStatement("""
                    INSERT INTO vorgang_anstoss (tenant_id, energieziel_id, art, anlass_kennung, angestossen_am)
                    VALUES (?, ?, ?, ?, ?)
                    ON CONFLICT (tenant_id, energieziel_id, art, anlass_kennung) WHERE energieziel_id IS NOT NULL
                    DO NOTHING RETURNING id
                    """)) {
                ps.setObject(1, tenant);
                ps.setObject(2, ziel);
                ps.setString(3, art);
                ps.setString(4, anlass);
                ps.setTimestamp(5, Timestamp.from(jetzt));
                try (ResultSet rs = ps.executeQuery()) {
                    if (rs.next()) {
                        id = rs.getObject(1, UUID.class);
                    }
                }
            }
            if (id == null) {
                continue;
            }
            ObjectNode neu = JSON.createObjectNode();
            neu.put("anstoss_id", id.toString());
            neu.put("art", art);
            neu.put("anlass_kennung", anlass);
            if (fassung > 0) {
                neu.put("fassung", fassung);
                neu.put("referenzperiode", referenzperiode);
            }
            try (PreparedStatement ps = con.prepareStatement("INSERT INTO energieziel_aenderung (tenant_id, "
                    + "energieziel_id, art, neu, actor_name, actor_art) VALUES (?, ?, 'anstoss_gesetzt', ?::jsonb, ?, "
                    + "'voltpilot')")) {
                ps.setObject(1, tenant);
                ps.setObject(2, ziel);
                ps.setString(3, neu.toString());
                ps.setString(4, AKTEUR);
                ps.executeUpdate();
            }
            gesetzt.add(new Gesetzt(tenant, ziel, id, art, anlass));
        }
        return gesetzt;
    }

    private static String text(Connection con, String sql, UUID tenant, Object id) throws SQLException {
        String w = wert(con, sql, tenant, id);
        if (w == null) {
            throw new IllegalStateException("UEMS Vorgang-Anstoß: " + id + " gibt es nicht");
        }
        return w;
    }

    private static String wert(Connection con, String sql, UUID tenant, Object id) throws SQLException {
        try (PreparedStatement ps = con.prepareStatement(sql)) {
            ps.setObject(1, tenant);
            ps.setObject(2, id);
            try (ResultSet rs = ps.executeQuery()) {
                return rs.next() ? rs.getString(1) : null;
            }
        }
    }
}
