package com.voltpilot.api.uems;

import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ArrayNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import java.sql.Connection;
import java.sql.PreparedStatement;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.sql.Timestamp;
import java.time.Instant;
import java.time.YearMonth;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.TreeSet;
import java.util.UUID;

/**
 * Der Anstoß am VORGANG (UEMS AP-18 M5, Z5, §5.6) — ein Vermerk an einer Maßnahme oder einem Energieziel, dessen Kopie
 * nicht mehr stimmt; die Kopie bleibt byte-gleich, eine Person antwortet ({@link VorgangAntwort}). Je Vorgang × Art ×
 * Anlass genau einmal ({@code vorgang_anstoss_massnahme_uq}, {@code vorgang_anstoss_energieziel_uq}), dazu die
 * Protokollzeile {@code anstoss_gesetzt}. Beendete Vorgänge (verworfene Maßnahme, beendetes Ziel) stößt er nicht an.
 *
 * <ul>
 *   <li><b>Pfad 1</b> (IP-17, {@link #nachKorrektur}): ein Kennzahl-Monatswert wird in der Kaskade Version n + 1 — jede
 *       Maßnahme, deren Ausgangslage ({@code vergleich[].bereinigt.gemessen.version}) oder deren bewerteter bzw.
 *       beantragter Stand ({@code monate[].version}) diesen Monat in einer älteren Version zitiert, bekommt
 *       {@code ausgangslage_korrigiert} bzw. {@code bewertung_korrigiert}; jedes bewertete Ziel, dessen Zielperiode den
 *       Monat enthält, {@code bewertung_korrigiert} (seine Kopie nennt Σ ÷ Σ ohne Monatsversionen — jede neue Version
 *       nach der Bewertung trifft sie). Anlass-Kennung = die des Bezugsbasis-Anstoßes Pfad 1
 *       ({@link BezugsbasisAnstoss#kennung}: {@code K-2028-0001}).</li>
 *   <li><b>Pfad 2</b> (IP-7 Ziele, IP-17 Maßnahmen): eine Bezugsbasis endet ({@code bezugsbasis_beendet}) oder bekommt
 *       eine freigegebene Fassung n + 1 ({@code fassung_freigegeben}) — {@code messgrundlage_beendet} bzw.
 *       {@code messgrundlage_neu_gefasst} an den offenen Zielen, deren Zielperiode die Referenzperiode überschneidet, und
 *       an den Maßnahmen der Basis: beendet an jeder nicht verworfenen, neu gefasst an jeder umgesetzten bzw. bewerteten
 *       mit älterer Fassung, deren neue Referenzperiode im Umsetzungsmonat oder danach endet (dieselbe Regel wie der
 *       Wirkung-Grund {@code basis_nach_umsetzung}, {@link VerbesserungRegeln#wirkung}). Anlass {@code BB-…/beendet}
 *       bzw. {@code BB-…/Fassung-n}.</li>
 * </ul>
 *
 * <p>Gerufen NUR über die {@link VerbesserungNaht} (Schalter) — Pfad 1 aus der {@link KennzahlKaskade} direkt nach dem
 * Bezugsbasis-Anstoß Pfad 1, Pfad 2 aus dem {@link BezugsbasisAnstoss} im {@link StrukturAenderungLaeufer} unter dem
 * Wasserzeichen {@code bezugsbasis_struktur_gelesen}; beide in DERSELBEN Transaktion wie der Bezugsbasis-Anstoß und mit
 * der administrativen Rolle (INSERT seit {@code V20260925001000}, ohne RLS — jede Abfrage nennt den Mandanten). Ohne
 * {@code FOR UPDATE}: die Admin-Rolle hat auf den Vorgängen kein UPDATE; doppelt setzt {@code ON CONFLICT} nichts.
 */
final class VorgangAnstoss {

    static final String AUSGANGSLAGE_KORRIGIERT = "ausgangslage_korrigiert";
    static final String BEWERTUNG_KORRIGIERT = "bewertung_korrigiert";
    static final String BEENDET = "messgrundlage_beendet";
    static final String NEU_GEFASST = "messgrundlage_neu_gefasst";
    static final String AKTEUR = "VoltPilot (Struktur-Läufer)";
    static final String AKTEUR_KASKADE = "VoltPilot (Kaskade)";
    private static final String MONAT = "monat";
    private static final ObjectMapper JSON = new ObjectMapper();

    private VorgangAnstoss() {}

    /** Ein gesetzter Anstoß — an einer Maßnahme ODER an einem Ziel. */
    record Gesetzt(UUID tenant, UUID massnahme, UUID energieziel, UUID anstoss, String art, String anlassKennung) {}

    // ============================================================================ Pfad 1 (IP-17)

    /**
     * Die Kennzahl-Monate, die in der Kaskade eben Version n + 1 wurden → die Anstöße an den Vorgängen, deren Kopie sie
     * in einer älteren Version zitiert. Wirft bei jedem Fehler (die Kaskade rollt zurück).
     */
    static List<Gesetzt> nachKorrektur(Connection con, UUID tenant, String anlass, List<KennzahlLauf.Neu> neu,
            Instant jetzt) throws SQLException {
        // Je Kennzahl die Monate mit ihrer neuen Version — ein Monat zählt einmal.
        Map<UUID, Map<String, Integer>> monate = new LinkedHashMap<>();
        for (KennzahlLauf.Neu n : neu) {
            if (MONAT.equals(n.periodeArt()) && n.version() > 1) {
                monate.computeIfAbsent(n.kennzahl(), k -> new LinkedHashMap<>())
                        .merge(YearMonth.from(n.von()).toString(), n.version(), Math::max);
            }
        }
        List<Gesetzt> gesetzt = new ArrayList<>();
        for (Map.Entry<UUID, Map<String, Integer>> e : monate.entrySet()) {
            UUID kennzahl = e.getKey();
            Map<String, Integer> jeMonat = e.getValue();
            // Ausgangslage: vergleich[].periode mit bereinigt.gemessen.version < neu.
            for (Object[] m : zeilen(con, "SELECT id, ausgangslage FROM massnahme WHERE tenant_id = ? AND kennzahl_id = ? "
                    + "AND zustand <> 'verworfen' AND ausgangslage IS NOT NULL ORDER BY kennzeichen", tenant, kennzahl)) {
                List<ObjectNode> zitiert = zitiert(json((String) m[1]).path("vergleich"), "/bereinigt/gemessen/version",
                        jeMonat);
                if (!zitiert.isEmpty()) {
                    ObjectNode z = anlassZitat(kennzahl(con, tenant, kennzahl), zitiert);
                    setzen(con, tenant, (UUID) m[0], null, AUSGANGSLAGE_KORRIGIERT, anlass, z, AKTEUR_KASKADE, jetzt)
                            .ifPresent(gesetzt::add);
                }
            }
            // Bewertungs-Stände (IP-12): monate[].periode mit version < neu — je Maßnahme ein Anstoß, alle Stände darin.
            Map<UUID, List<ObjectNode>> staende = new LinkedHashMap<>();
            Map<UUID, TreeSet<Integer>> nummern = new LinkedHashMap<>();
            for (Object[] b : zeilen(con, "SELECT b.massnahme_id, b.wirkung, b.stand_nr FROM massnahme_bewertung b "
                    + "JOIN massnahme m ON m.id = b.massnahme_id AND m.tenant_id = b.tenant_id WHERE b.tenant_id = ? "
                    + "AND b.kennzahl_id = ? AND b.status IN ('bewertet', 'beantragt') AND b.wirkung IS NOT NULL "
                    + "AND m.zustand <> 'verworfen' ORDER BY m.kennzeichen, b.stand_nr", tenant, kennzahl)) {
                List<ObjectNode> zitiert = zitiert(json((String) b[1]).path("monate"), "/version", jeMonat);
                if (!zitiert.isEmpty()) {
                    UUID massnahme = (UUID) b[0];
                    staende.computeIfAbsent(massnahme, k -> new ArrayList<>()).addAll(zitiert);
                    nummern.computeIfAbsent(massnahme, k -> new TreeSet<>()).add(((Number) b[2]).intValue());
                }
            }
            for (Map.Entry<UUID, List<ObjectNode>> s : staende.entrySet()) {
                ObjectNode z = anlassZitat(kennzahl(con, tenant, kennzahl), eindeutig(s.getValue()));
                ArrayNode nr = z.putArray("staende");
                nummern.get(s.getKey()).forEach(nr::add);
                setzen(con, tenant, s.getKey(), null, BEWERTUNG_KORRIGIERT, anlass, z, AKTEUR_KASKADE, jetzt)
                        .ifPresent(gesetzt::add);
            }
            // Ziel-Bewertung (IP-7): die Zielperiode enthält den Monat.
            for (Object[] zi : zeilen(con, "SELECT id, zielperiode FROM energieziel WHERE tenant_id = ? AND kennzahl_id = ? "
                    + "AND zustand = 'bewertet' AND bewertung_kopie IS NOT NULL ORDER BY kennzeichen", tenant, kennzahl)) {
                String p = (String) zi[1];
                List<ObjectNode> zitiert = new ArrayList<>();
                jeMonat.forEach((monat, version) -> {
                    if (p.substring(0, 7).compareTo(monat) <= 0 && monat.compareTo(p.substring(8, 15)) <= 0) {
                        ObjectNode o = JSON.createObjectNode();
                        o.put("monat", monat);
                        o.put("version_gueltig", version);
                        zitiert.add(o);
                    }
                });
                if (!zitiert.isEmpty()) {
                    ObjectNode z = anlassZitat(kennzahl(con, tenant, kennzahl), zitiert);
                    setzen(con, tenant, null, (UUID) zi[0], BEWERTUNG_KORRIGIERT, anlass, z, AKTEUR_KASKADE, jetzt)
                            .ifPresent(gesetzt::add);
                }
            }
        }
        return gesetzt;
    }

    /** Die Einträge einer Kopie, die einen der Monate in einer älteren Version zitieren (Version am Pfad). */
    private static List<ObjectNode> zitiert(JsonNode eintraege, String versionPfad, Map<String, Integer> jeMonat) {
        List<ObjectNode> aus = new ArrayList<>();
        for (JsonNode e : eintraege) {
            Integer gueltig = jeMonat.get(e.path("periode").asText(""));
            JsonNode v = e.at(versionPfad);
            if (gueltig != null && v.isIntegralNumber() && v.asInt() < gueltig) {
                ObjectNode o = JSON.createObjectNode();
                o.put("monat", e.path("periode").asText());
                o.put("version_zitiert", v.asInt());
                o.put("version_gueltig", gueltig);
                aus.add(o);
            }
        }
        return aus;
    }

    private static List<ObjectNode> eindeutig(List<ObjectNode> zitate) {
        Map<String, ObjectNode> aus = new LinkedHashMap<>();
        zitate.forEach(z -> aus.putIfAbsent(z.toString(), z));
        return List.copyOf(aus.values());
    }

    private static ObjectNode anlassZitat(String kennzahl, List<ObjectNode> zitiert) {
        ObjectNode z = JSON.createObjectNode();
        z.put("kennzahl", kennzahl);
        z.putArray("monate").addAll(zitiert);
        return z;
    }

    private static String kennzahl(Connection con, UUID tenant, UUID kennzahl) throws SQLException {
        return text(con, "SELECT kennzeichen FROM kennzahl WHERE tenant_id = ? AND id = ?", tenant, kennzahl);
    }

    // ============================================================================ Pfad 2 (IP-7 Ziele, IP-17 Maßnahmen)

    /**
     * Eine Zeile {@code bezugsbasis_aenderung} ({@code fassung_freigegeben} mit ihrer Fassung n, oder
     * {@code bezugsbasis_beendet}) → die Anstöße an den offenen Zielen und an den Maßnahmen der Basis.
     */
    static List<Gesetzt> anVorgaengen(Connection con, UUID tenant, UUID basis, String protokollArt, long eintrag,
            Instant jetzt) throws SQLException {
        String bb = text(con, "SELECT kennzeichen FROM bezugsbasis WHERE tenant_id = ? AND id = ?", tenant, basis);
        String art;
        String anlass;
        String ziele = "SELECT id FROM energieziel WHERE tenant_id = ? AND bezugsbasis_id = ? AND zustand = 'offen'";
        String massnahmen = "SELECT id FROM massnahme WHERE tenant_id = ? AND bezugsbasis_id = ?";
        String referenzperiode = null;
        int fassung = 0;
        if ("bezugsbasis_beendet".equals(protokollArt)) {
            art = BEENDET;
            anlass = bb + "/beendet";
            massnahmen += " AND zustand <> 'verworfen'";
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
            ziele += " AND fassung < " + fassung + " AND substring(zielperiode FROM 1 FOR 7) <= ?"
                    + " AND substring(zielperiode FROM 9 FOR 7) >= ?";
            // Zitiert die Maßnahme eine frühere Fassung, und endet die Referenzperiode im Umsetzungsmonat oder danach?
            massnahmen += " AND fassung < " + fassung + " AND zustand IN ('umgesetzt', 'bewertet')"
                    + " AND umgesetzt_am IS NOT NULL AND to_char(umgesetzt_am, 'YYYY-MM') <= ?";
        } else {
            return List.of();
        }
        ObjectNode zitat = JSON.createObjectNode();
        if (fassung > 0) {
            zitat.put("fassung", fassung);
            zitat.put("referenzperiode", referenzperiode);
        }
        List<Gesetzt> gesetzt = new ArrayList<>();
        List<Object> zielWerte = new ArrayList<>(List.of(tenant, basis));
        List<Object> massnahmeWerte = new ArrayList<>(List.of(tenant, basis));
        if (referenzperiode != null) {
            zielWerte.add(referenzperiode.substring(8, 15));
            zielWerte.add(referenzperiode.substring(0, 7));
            massnahmeWerte.add(referenzperiode.substring(8, 15));
        }
        for (Object[] z : zeilen(con, ziele + " ORDER BY kennzeichen", zielWerte.toArray())) {
            setzen(con, tenant, null, (UUID) z[0], art, anlass, zitat, AKTEUR, jetzt).ifPresent(gesetzt::add);
        }
        for (Object[] m : zeilen(con, massnahmen + " ORDER BY kennzeichen", massnahmeWerte.toArray())) {
            setzen(con, tenant, (UUID) m[0], null, art, anlass, zitat, AKTEUR, jetzt).ifPresent(gesetzt::add);
        }
        return gesetzt;
    }

    // ============================================================================ Setzen

    /** Der Anstoß (idempotent) und seine Protokollzeile {@code anstoss_gesetzt} — nur, wenn er neu ist. */
    private static java.util.Optional<Gesetzt> setzen(Connection con, UUID tenant, UUID massnahme, UUID ziel, String art,
            String anlass, ObjectNode zitat, String akteur, Instant jetzt) throws SQLException {
        boolean anMassnahme = massnahme != null;
        UUID id = null;
        try (PreparedStatement ps = con.prepareStatement("INSERT INTO vorgang_anstoss (tenant_id, "
                + (anMassnahme ? "massnahme_id" : "energieziel_id") + ", art, anlass_kennung, angestossen_am) "
                + "VALUES (?, ?, ?, ?, ?) ON CONFLICT (tenant_id, " + (anMassnahme ? "massnahme_id" : "energieziel_id")
                + ", art, anlass_kennung) WHERE " + (anMassnahme ? "massnahme_id" : "energieziel_id")
                + " IS NOT NULL DO NOTHING RETURNING id")) {
            ps.setObject(1, tenant);
            ps.setObject(2, anMassnahme ? massnahme : ziel);
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
            return java.util.Optional.empty();
        }
        ObjectNode neu = JSON.createObjectNode();
        neu.put("anstoss_id", id.toString());
        neu.put("art", art);
        neu.put("anlass_kennung", anlass);
        neu.setAll(zitat);
        try (PreparedStatement ps = con.prepareStatement("INSERT INTO "
                + (anMassnahme ? "massnahme_aenderung (tenant_id, massnahme_id" : "energieziel_aenderung (tenant_id, "
                        + "energieziel_id") + ", art, neu, actor_name, actor_art) VALUES (?, ?, 'anstoss_gesetzt', "
                + "?::jsonb, ?, 'voltpilot')")) {
            ps.setObject(1, tenant);
            ps.setObject(2, anMassnahme ? massnahme : ziel);
            ps.setString(3, neu.toString());
            ps.setString(4, akteur);
            ps.executeUpdate();
        }
        return java.util.Optional.of(new Gesetzt(tenant, massnahme, ziel, id, art, anlass));
    }

    // ============================================================================ Lesen

    private static List<Object[]> zeilen(Connection con, String sql, Object... werte) throws SQLException {
        List<Object[]> aus = new ArrayList<>();
        try (PreparedStatement ps = con.prepareStatement(sql)) {
            for (int i = 0; i < werte.length; i++) {
                ps.setObject(i + 1, werte[i]);
            }
            try (ResultSet rs = ps.executeQuery()) {
                int n = rs.getMetaData().getColumnCount();
                while (rs.next()) {
                    Object[] z = new Object[n];
                    for (int i = 0; i < n; i++) {
                        z[i] = rs.getObject(i + 1);
                    }
                    aus.add(z);
                }
            }
        }
        return aus;
    }

    private static JsonNode json(String text) {
        try {
            return JSON.readTree(text);
        } catch (JsonProcessingException e) {
            throw new IllegalStateException("UEMS Vorgang-Anstoß: Kopie ist kein JSON", e);
        }
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
