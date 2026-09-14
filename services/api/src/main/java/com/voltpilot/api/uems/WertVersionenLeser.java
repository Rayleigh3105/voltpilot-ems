package com.voltpilot.api.uems;

import java.math.BigDecimal;
import java.sql.Array;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.sql.Timestamp;
import java.time.Instant;
import java.util.ArrayList;
import java.util.Collection;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import org.springframework.jdbc.core.JdbcTemplate;

/**
 * Was das Lese-Modell „Werte je Messstelle“ an Versionen liest (UEMS AP-08 IP-18) — und nirgends sonst gelesen wird:
 * die Versionen ab 2 je Periode, wie Ersatzwert-Lauf und Korrektur-Kaskade sie geschrieben haben, der Zeitpunkt, an
 * dem die Verdichtung Version 1 gebildet hat, und die Fassungen der Vorgänge, die eine Version ausgelöst haben.
 *
 * <p><b>Nichts wird hier gerechnet oder geschrieben.</b> Alle Abfragen laufen über die App-Verbindung hinter RLS: ein
 * fremder Kundenbereich hat keine Zeile, keine Version und keine Fassung.
 */
public class WertVersionenLeser {

    /**
     * Eine Version ab 2 einer Periode.
     *
     * @param mitFakten {@code true}, wenn die Zeile ihre Rohwert-Fakten selbst trägt (Kaskade, Tag/Monat/Jahr immer);
     *     {@code false} an einer Viertelstunde des Ersatzwert-Laufs — ihre Fakten sind die von Version 1
     * @param zustand vorläufig/endgültig der Basis; an der Viertelstunde {@code null} (die von Version 1)
     */
    public record Version(Instant beginn, int version, BigDecimal menge, String mengeZustand, List<String> kennzeichen,
            boolean mitFakten, Integer erhalten, Integer erwartet, Integer abdeckungProzent, BigDecimal mittel,
            BigDecimal min, BigDecimal max, BigDecimal energie, String zustand, List<String> wirkt,
            String anlassKennung, int anlassFassung, Instant gebildetAm, Instant nachgezogenAm) {}

    /** Eine Fassung eines Ersatzwerts oder einer Korrektur — Urheber, Zeitpunkt, Text. */
    public record Fassung(String kennung, int fassung, String status, String methode, String art, String begruendung,
            String beleg, String grund, String actorName, String actorRolle, String actorArt, Instant am) {

        WertVersionenRegeln.Fassung fuerRegeln() {
            return new WertVersionenRegeln.Fassung(kennung, fassung, status, am);
        }
    }

    private final JdbcTemplate jdbc;

    public WertVersionenLeser(JdbcTemplate jdbc) {
        this.jdbc = jdbc;
    }

    private static final String FAKTEN = "menge, menge_zustand, kennzeichen::text AS kennzeichen, erhalten, erwartet, "
            + "abdeckung_prozent, mittel, min_wert, max_wert, energie, korrekturen, ersatzwerte, anlass_kennung, "
            + "anlass_fassung, created_at";

    /** Die Viertelstunden-Versionen einer Reihe mit Beginn in {@code [von, bis)}, je Beginn älteste zuerst. */
    public Map<Instant, List<Version>> viertelstunden(UUID tenant, UUID entity, String kanal, Instant von,
            Instant bis) {
        Map<Instant, List<Version>> aus = new HashMap<>();
        jdbc.query("SELECT intervall_beginn AS beginn, version, " + FAKTEN + ", NULL::text AS zustand, "
                + "NULL::timestamptz AS nachgezogen_am FROM messreihe_viertelstunde_version "
                + "WHERE tenant_id = ? AND entity_id = ? AND messkanal = ? AND intervall_beginn >= ? "
                + "AND intervall_beginn < ? "
                + "ORDER BY intervall_beginn, version", rs -> {
                    Version v = version(rs);
                    aus.computeIfAbsent(v.beginn(), x -> new ArrayList<>()).add(v);
                }, tenant, entity, kanal, Timestamp.from(von), Timestamp.from(bis));
        return aus;
    }

    /**
     * Die Versionen einer Ebene ({@code tag} · {@code monat} · {@code jahr}; für eine berechnete Messstelle auch
     * {@code viertelstunde}) mit Beginn in {@code [von, bis)} — Spur Reihe ({@code messstelle == null}) oder Spur
     * berechnet.
     */
    public Map<Instant, List<Version>> perioden(UUID tenant, String ebene, UUID entity, String kanal, UUID messstelle,
            Instant von, Instant bis) {
        Map<Instant, List<Version>> aus = new HashMap<>();
        String spur = messstelle == null ? "entity_id = ? AND messkanal = ? AND messstelle_id IS NULL"
                : "messstelle_id = ?";
        List<Object> args = new ArrayList<>(List.of(tenant, ebene));
        if (messstelle == null) {
            args.add(entity);
            args.add(kanal);
        } else {
            args.add(messstelle);
        }
        args.add(Timestamp.from(von));
        args.add(Timestamp.from(bis));
        jdbc.query("SELECT periode_beginn AS beginn, version, " + FAKTEN + ", zustand, nachgezogen_am "
                + "FROM messreihe_periode_version WHERE tenant_id = ? AND ebene = ? AND " + spur
                + " AND periode_beginn >= ? AND periode_beginn < ? ORDER BY periode_beginn, version", rs -> {
                    Version v = version(rs);
                    aus.computeIfAbsent(v.beginn(), x -> new ArrayList<>()).add(v);
                }, args.toArray());
        return aus;
    }

    /**
     * Wann die Verdichtung Version 1 der Periode gebildet hat ({@code berechnet_am} ihrer Zeile) — {@code null} ohne
     * Zeile (eine Lücke).
     */
    public Instant ersteGebildet(UUID tenant, String ebene, UUID entity, String kanal, UUID messstelle,
            Instant beginn) {
        String tabelle = switch (ebene) {
            case "viertelstunde" -> "messreihe_viertelstunde";
            case "tag" -> "messreihe_tag";
            case "monat", "jahr" -> "messreihe_periode";
            default -> throw new IllegalArgumentException("keine Ebene mit Versionen: " + ebene);
        };
        String beginnSpalte = "viertelstunde".equals(ebene) ? "intervall_beginn" : "beginn";
        String art = "monat".equals(ebene) || "jahr".equals(ebene) ? " AND art = '" + ebene + "'" : "";
        String spur = messstelle == null ? "entity_id = ? AND messkanal = ?" : "messstelle_id = ?";
        Object[] args = messstelle == null ? new Object[] {tenant, entity, kanal, Timestamp.from(beginn)}
                : new Object[] {tenant, messstelle, Timestamp.from(beginn)};
        return jdbc.query("SELECT max(berechnet_am) FROM " + tabelle + " WHERE tenant_id = ? AND " + spur + art
                + " AND " + beginnSpalte + " = ?", rs -> rs.next() ? ViertelstundenTeile.zeit(rs, 1) : null, args);
    }

    /** Alle Fassungen der genannten Vorgänge, je Kennung älteste zuerst. */
    public List<Fassung> fassungen(UUID tenant, Collection<String> kennungen) {
        List<String> ersatzwerte = kennungen.stream().filter(k -> k.startsWith("EW-")).distinct().toList();
        List<String> korrekturen = kennungen.stream().filter(k -> k.startsWith("K-")).distinct().toList();
        List<Fassung> aus = new ArrayList<>();
        if (!ersatzwerte.isEmpty()) {
            aus.addAll(jdbc.query("SELECT kennung, fassung, status, methode, NULL::text AS art, begruendung, beleg, "
                    + "grund, actor_name, actor_rolle, actor_art, created_at FROM messreihe_ersatzwert "
                    + "WHERE tenant_id = ? AND kennung = ANY (?) ORDER BY kennung, fassung", (rs, n) -> fassung(rs),
                    tenant, ersatzwerte.toArray(String[]::new)));
        }
        if (!korrekturen.isEmpty()) {
            aus.addAll(jdbc.query("SELECT kennung, fassung, status, NULL::text AS methode, art, begruendung, beleg, "
                    + "grund, actor_name, actor_rolle, actor_art, created_at FROM messreihe_korrektur "
                    + "WHERE tenant_id = ? AND kennung = ANY (?) ORDER BY kennung, fassung", (rs, n) -> fassung(rs),
                    tenant, korrekturen.toArray(String[]::new)));
        }
        return aus;
    }

    // ------------------------------------------------------------------------------ Zeilen

    private static Version version(ResultSet rs) throws SQLException {
        List<String> korrekturen = texte(rs.getArray("korrekturen"));
        List<String> wirkt = new ArrayList<>(korrekturen == null ? List.of() : korrekturen);
        List<String> ersatzwerte = texte(rs.getArray("ersatzwerte"));
        if (ersatzwerte != null) {
            wirkt.addAll(ersatzwerte);
        }
        // An der Viertelstunde trägt nur die Kaskade Fakten (korrekturen gesetzt); Tag/Monat/Jahr immer.
        boolean mitFakten = korrekturen != null;
        return new Version(ViertelstundenTeile.zeit(rs, rs.findColumn("beginn")), rs.getInt("version"),
                rs.getBigDecimal("menge"), rs.getString("menge_zustand"),
                ViertelstundenTeile.kennzeichen(rs.getString("kennzeichen")), mitFakten, ganz(rs, "erhalten"),
                ganz(rs, "erwartet"), ganz(rs, "abdeckung_prozent"), rs.getBigDecimal("mittel"),
                rs.getBigDecimal("min_wert"), rs.getBigDecimal("max_wert"), rs.getBigDecimal("energie"),
                rs.getString("zustand"), List.copyOf(wirkt), rs.getString("anlass_kennung"), rs.getInt("anlass_fassung"),
                ViertelstundenTeile.zeit(rs, rs.findColumn("created_at")),
                ViertelstundenTeile.zeit(rs, rs.findColumn("nachgezogen_am")));
    }

    private static Fassung fassung(ResultSet rs) throws SQLException {
        return new Fassung(rs.getString("kennung"), rs.getInt("fassung"), rs.getString("status"),
                rs.getString("methode"), rs.getString("art"), rs.getString("begruendung"), rs.getString("beleg"),
                rs.getString("grund"), rs.getString("actor_name"), rs.getString("actor_rolle"),
                rs.getString("actor_art"), ViertelstundenTeile.zeit(rs, rs.findColumn("created_at")));
    }

    private static List<String> texte(Array a) throws SQLException {
        return a == null ? null : List.of((String[]) a.getArray());
    }

    private static Integer ganz(ResultSet rs, String spalte) throws SQLException {
        int v = rs.getInt(spalte);
        return rs.wasNull() ? null : v;
    }
}
