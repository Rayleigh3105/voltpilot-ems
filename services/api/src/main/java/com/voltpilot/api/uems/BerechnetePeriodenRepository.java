package com.voltpilot.api.uems;

import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.core.type.TypeReference;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.math.BigDecimal;
import java.sql.Connection;
import java.sql.PreparedStatement;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.sql.Timestamp;
import java.sql.Types;
import java.time.Instant;
import java.time.LocalDate;
import java.time.ZoneId;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.UUID;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Repository;

/**
 * Die Spur {@code berechnet} der Speicherklasse (UEMS AP-10 IP-10, E6 = A): Zeilen berechneter Messstellen in
 * {@code messreihe_viertelstunde}, {@code messreihe_tag} und {@code messreihe_periode} samt ihren Eingängen in
 * {@code bilanzwert_eingang}.
 *
 * <p>Geschrieben wird NUR über die Verbindung, die der Lauf hereinreicht (BYPASSRLS, eine Transaktion); gelesen
 * wird für das Lese-Modell über die App-Verbindung hinter RLS.
 *
 * <p><b>Wiederholbar.</b> Eine Zeile wird nur geschrieben, wenn es sie noch nicht gibt oder wenn sich an ihr
 * oder an ihren Eingängen etwas geändert hat — ein zweiter Lauf über dieselbe Periode schreibt nichts. Eine
 * ENDGÜLTIGE Zeile wird nie angefasst, auch ihre Eingänge nicht.
 */
@Repository
public class BerechnetePeriodenRepository {

    public static final String VIERTELSTUNDE = "viertelstunde";
    public static final String TAG = "tag";
    public static final String MONAT = "monat";
    public static final String JAHR = "jahr";

    private static final ObjectMapper JSON = new ObjectMapper();

    private final JdbcTemplate jdbc;

    public BerechnetePeriodenRepository(JdbcTemplate jdbc) {
        this.jdbc = jdbc;
    }

    /** Ein Eingang, wie er gespeichert wird: woher er kommt und wie er einging. */
    public record EingangZeile(UUID messstelleId, String kennzeichen, UUID entityId, String messkanal,
            BerechnetePeriode.Eingang eingang) {}

    /**
     * Eine berechnete Zeile. {@code tag} ist der Ortstag (Tag) bzw. der erste Kalendertag (Monat/Jahr), bei
     * der Viertelstunde {@code null}; {@code zone}/{@code zoneHerkunft} tragen nur Tag, Monat und Jahr.
     */
    public record Zeile(String ebene, Instant beginn, Instant ende, LocalDate tag, ZoneId zone, String zoneHerkunft,
            UUID fassungId, String formelTyp, BerechnetePeriode.Ergebnis ergebnis, List<EingangZeile> eingaenge) {}

    /** Was ein Schreibzug tat. */
    public record Geschrieben(int geschrieben, int unveraendert, int endgueltigUnberuehrt) {}

    /** Eine gespeicherte Zeile, wie das Lese-Modell sie braucht. */
    public record Gespeichert(Instant beginn, BigDecimal menge, String mengeZustand, List<String> kennzeichen,
            Integer abdeckungProzent, String zustand, Instant endgueltigAb, int version) {}

    // ------------------------------------------------------------------------------ lesen (App, RLS)

    /** Die gespeicherten Zeilen der Messstelle auf einer Ebene mit Beginn in {@code [von, bis)}, nach Beginn. */
    public Map<Instant, Gespeichert> gespeichert(UUID messstelleId, String ebene, Instant von, Instant bis) {
        Map<Instant, Gespeichert> out = new HashMap<>();
        List<Object> args = new ArrayList<>(List.of(messstelleId));
        if (!artFilter(ebene).isEmpty()) {
            args.add(ebene);
        }
        args.add(Timestamp.from(von));
        args.add(Timestamp.from(bis));
        jdbc.query("SELECT " + beginnSpalte(ebene) + " AS beginn, menge, menge_zustand, kennzeichen::text, "
                + "abdeckung_prozent, zustand, endgueltig_ab, version FROM " + tabelle(ebene)
                + " WHERE messstelle_id = ?" + artFilter(ebene) + " AND " + beginnSpalte(ebene) + " >= ? AND "
                + beginnSpalte(ebene) + " < ? AND version = 1", rs -> {
                    Instant b = rs.getTimestamp("beginn").toInstant();
                    out.put(b, new Gespeichert(b, rs.getBigDecimal("menge"), rs.getString("menge_zustand"),
                            saetze(rs.getString(4)), (Integer) rs.getObject("abdeckung_prozent", Integer.class),
                            rs.getString("zustand"), rs.getTimestamp("endgueltig_ab").toInstant(),
                            rs.getInt("version")));
                }, args.toArray());
        return out;
    }

    // --------------------------------------------------------------------- schreiben (Lauf, BYPASSRLS)

    /**
     * Schreibt die Zeilen EINER Messstelle auf EINER Ebene in der Transaktion von {@code con}. Die Zeilen der
     * Messstelle werden vorher gesperrt ({@code FOR UPDATE}); eine endgültige bleibt stehen.
     */
    Geschrieben schreiben(Connection con, UUID tenant, UUID messstelleId, String ebene, List<Zeile> zeilen,
            Instant jetzt) throws SQLException {
        if (zeilen.isEmpty()) {
            return new Geschrieben(0, 0, 0);
        }
        Instant von = zeilen.stream().map(Zeile::beginn).min(Instant::compareTo).orElseThrow();
        Instant bis = zeilen.stream().map(Zeile::beginn).max(Instant::compareTo).orElseThrow().plusSeconds(1);
        Map<Instant, Bestand> bestand = bestand(con, tenant, messstelleId, ebene, von, bis);
        Map<Instant, List<String>> eingaenge = eingaenge(con, tenant, messstelleId, ebene, von, bis);
        int geschrieben = 0;
        int gleich = 0;
        int endgueltig = 0;
        for (Zeile z : zeilen) {
            Bestand alt = bestand.get(z.beginn());
            List<String> neueEingaenge = eingangSchluessel(z.eingaenge());
            if (alt != null && ViertelstundeRegeln.ENDGUELTIG.equals(alt.zustand())) {
                endgueltig++;
                continue;
            }
            if (alt != null && alt.gleich(z) && neueEingaenge.equals(eingaenge.getOrDefault(z.beginn(), List.of()))) {
                gleich++;
                continue;
            }
            if (alt == null) {
                einfuegen(con, tenant, messstelleId, z, jetzt);
            } else {
                aktualisieren(con, tenant, messstelleId, z, jetzt);
            }
            try (PreparedStatement ps = con.prepareStatement("DELETE FROM bilanzwert_eingang WHERE tenant_id = ? "
                    + "AND messstelle_id = ? AND periode = ? AND periode_beginn = ? AND version = 1")) {
                ps.setObject(1, tenant);
                ps.setObject(2, messstelleId);
                ps.setString(3, ebene);
                ps.setTimestamp(4, Timestamp.from(z.beginn()));
                ps.executeUpdate();
            }
            eingaengeEinfuegen(con, tenant, messstelleId, z, jetzt);
            geschrieben++;
        }
        return new Geschrieben(geschrieben, gleich, endgueltig);
    }

    private record Bestand(BigDecimal menge, String mengeZustand, List<String> kennzeichen, Integer abdeckung,
            String zustand, UUID fassungId, String formelTyp) {

        boolean gleich(Zeile z) {
            BerechnetePeriode.Ergebnis e = z.ergebnis();
            return gleicheZahl(menge, e.menge()) && Objects.equals(mengeZustand, e.mengeZustand())
                    && Objects.equals(kennzeichen, e.kennzeichen()) && Objects.equals(abdeckung, e.abdeckungProzent())
                    && Objects.equals(zustand, e.zustand()) && Objects.equals(fassungId, z.fassungId())
                    && Objects.equals(formelTyp, z.formelTyp());
        }
    }

    private Map<Instant, Bestand> bestand(Connection con, UUID tenant, UUID messstelleId, String ebene, Instant von,
            Instant bis) throws SQLException {
        Map<Instant, Bestand> out = new HashMap<>();
        try (PreparedStatement ps = con.prepareStatement("SELECT " + beginnSpalte(ebene) + ", menge, menge_zustand, "
                + "kennzeichen::text, abdeckung_prozent, zustand, formel_fassung_id, formel_typ FROM " + tabelle(ebene)
                + " WHERE tenant_id = ? AND messstelle_id = ?" + artFilter(ebene) + " AND " + beginnSpalte(ebene)
                + " >= ? AND " + beginnSpalte(ebene) + " < ? AND version = 1 FOR UPDATE")) {
            int p = 1;
            ps.setObject(p++, tenant);
            ps.setObject(p++, messstelleId);
            if (!artFilter(ebene).isEmpty()) {
                ps.setString(p++, ebene);
            }
            ps.setTimestamp(p++, Timestamp.from(von));
            ps.setTimestamp(p, Timestamp.from(bis));
            try (ResultSet rs = ps.executeQuery()) {
                while (rs.next()) {
                    out.put(rs.getTimestamp(1).toInstant(), new Bestand(rs.getBigDecimal(2), rs.getString(3),
                            saetze(rs.getString(4)), rs.getObject(5, Integer.class), rs.getString(6),
                            rs.getObject(7, UUID.class), rs.getString(8)));
                }
            }
        }
        return out;
    }

    private Map<Instant, List<String>> eingaenge(Connection con, UUID tenant, UUID messstelleId, String ebene,
            Instant von, Instant bis) throws SQLException {
        Map<Instant, List<String>> out = new HashMap<>();
        try (PreparedStatement ps = con.prepareStatement("SELECT periode_beginn, eingang_messstelle_id, "
                + "eingang_kennzeichen, entity_id, messkanal, rolle, anteil, vorzeichen, faktor, menge, menge_zustand, "
                + "fassung, abdeckung_prozent, eingang_version, kennzeichen::text, grund FROM bilanzwert_eingang "
                + "WHERE tenant_id = ? AND messstelle_id = ? AND periode = ? AND periode_beginn >= ? "
                + "AND periode_beginn < ? AND version = 1 ORDER BY periode_beginn, position")) {
            ps.setObject(1, tenant);
            ps.setObject(2, messstelleId);
            ps.setString(3, ebene);
            ps.setTimestamp(4, Timestamp.from(von));
            ps.setTimestamp(5, Timestamp.from(bis));
            try (ResultSet rs = ps.executeQuery()) {
                while (rs.next()) {
                    BerechnetePeriode.Eingang e = new BerechnetePeriode.Eingang(rs.getString(3), rs.getString(6),
                            rs.getString(7), rs.getString(8), rs.getBigDecimal(9), rs.getBigDecimal(10),
                            rs.getString(11), rs.getObject(13, Integer.class), rs.getObject(14, Integer.class),
                            saetze(rs.getString(15)), rs.getString(12), rs.getString(16));
                    out.computeIfAbsent(rs.getTimestamp(1).toInstant(), k -> new ArrayList<>()).add(schluessel(
                            new EingangZeile(rs.getObject(2, UUID.class), rs.getString(3), rs.getObject(4, UUID.class),
                                    rs.getString(5), e)));
                }
            }
        }
        return out;
    }

    private static List<String> eingangSchluessel(List<EingangZeile> eingaenge) {
        return eingaenge.stream().map(BerechnetePeriodenRepository::schluessel).toList();
    }

    /** Ein Eingang als Text — Beträge numerisch (10 und 10.000000 sind derselbe Betrag). */
    private static String schluessel(EingangZeile z) {
        BerechnetePeriode.Eingang e = z.eingang();
        return String.join("|", String.valueOf(z.messstelleId()), String.valueOf(z.kennzeichen()),
                String.valueOf(z.entityId()), String.valueOf(z.messkanal()), String.valueOf(e.rolle()),
                String.valueOf(e.anteil()), String.valueOf(e.vorzeichen()), zahl(e.faktor()), zahl(e.menge()),
                String.valueOf(e.zustand()), String.valueOf(e.fassung()), String.valueOf(e.abdeckungProzent()),
                String.valueOf(e.version()), String.valueOf(e.kennzeichen() == null ? List.of() : e.kennzeichen()),
                String.valueOf(e.grund()));
    }

    private static String zahl(BigDecimal b) {
        return b == null ? "null" : b.stripTrailingZeros().toPlainString();
    }

    private static boolean gleicheZahl(BigDecimal a, BigDecimal b) {
        return a == null ? b == null : b != null && a.compareTo(b) == 0;
    }

    private void einfuegen(Connection con, UUID tenant, UUID messstelleId, Zeile z, Instant jetzt)
            throws SQLException {
        BerechnetePeriode.Ergebnis e = z.ergebnis();
        String sql = switch (z.ebene()) {
            case VIERTELSTUNDE -> "INSERT INTO messreihe_viertelstunde (intervall_beginn, tenant_id, messstelle_id, "
                    + "formel_fassung_id, formel_typ, menge, menge_zustand, kennzeichen, abdeckung_prozent, zustand, "
                    + "endgueltig_ab, berechnet_am, version) VALUES (?, ?, ?, ?, ?, ?, ?, ?::jsonb, ?, ?, ?, ?, 1)";
            case TAG -> "INSERT INTO messreihe_tag (beginn, tenant_id, messstelle_id, formel_fassung_id, formel_typ, "
                    + "menge, menge_zustand, kennzeichen, abdeckung_prozent, zustand, endgueltig_ab, berechnet_am, "
                    + "version, tag, zeitzone, zeitzone_herkunft, ende, stunden) "
                    + "VALUES (?, ?, ?, ?, ?, ?, ?, ?::jsonb, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?)";
            default -> "INSERT INTO messreihe_periode (beginn, tenant_id, messstelle_id, formel_fassung_id, formel_typ, "
                    + "menge, menge_zustand, kennzeichen, abdeckung_prozent, zustand, endgueltig_ab, berechnet_am, "
                    + "version, tag, zeitzone, zeitzone_herkunft, ende, stunden, art) "
                    + "VALUES (?, ?, ?, ?, ?, ?, ?, ?::jsonb, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?)";
        };
        try (PreparedStatement ps = con.prepareStatement(sql)) {
            int p = 1;
            ps.setTimestamp(p++, Timestamp.from(z.beginn()));
            ps.setObject(p++, tenant);
            ps.setObject(p++, messstelleId);
            ps.setObject(p++, z.fassungId());
            ps.setString(p++, z.formelTyp());
            ps.setBigDecimal(p++, e.menge());
            ps.setString(p++, e.mengeZustand());
            ps.setString(p++, json(e.kennzeichen()));
            setzeZahl(ps, p++, e.abdeckungProzent());
            ps.setString(p++, e.zustand());
            ps.setTimestamp(p++, Timestamp.from(e.endgueltigAb()));
            ps.setTimestamp(p++, Timestamp.from(jetzt));
            if (!VIERTELSTUNDE.equals(z.ebene())) {
                ps.setObject(p++, z.tag());
                ps.setString(p++, z.zone().getId());
                ps.setString(p++, z.zoneHerkunft());
                ps.setTimestamp(p++, Timestamp.from(z.ende()));
                ps.setInt(p++, (int) VerbrauchRegeln.stunden(z.beginn(), z.ende()));
                if (!TAG.equals(z.ebene())) {
                    ps.setString(p, z.ebene());
                }
            }
            ps.executeUpdate();
        }
    }

    private void aktualisieren(Connection con, UUID tenant, UUID messstelleId, Zeile z, Instant jetzt)
            throws SQLException {
        BerechnetePeriode.Ergebnis e = z.ergebnis();
        try (PreparedStatement ps = con.prepareStatement("UPDATE " + tabelle(z.ebene()) + " SET formel_fassung_id = ?, "
                + "formel_typ = ?, menge = ?, menge_zustand = ?, kennzeichen = ?::jsonb, abdeckung_prozent = ?, "
                + "zustand = ?, berechnet_am = ? WHERE tenant_id = ? AND messstelle_id = ?" + artFilter(z.ebene())
                + " AND " + beginnSpalte(z.ebene()) + " = ? AND version = 1 AND zustand = '"
                + ViertelstundeRegeln.VORLAEUFIG + "'")) {
            int p = 1;
            ps.setObject(p++, z.fassungId());
            ps.setString(p++, z.formelTyp());
            ps.setBigDecimal(p++, e.menge());
            ps.setString(p++, e.mengeZustand());
            ps.setString(p++, json(e.kennzeichen()));
            setzeZahl(ps, p++, e.abdeckungProzent());
            ps.setString(p++, e.zustand());
            ps.setTimestamp(p++, Timestamp.from(jetzt));
            ps.setObject(p++, tenant);
            ps.setObject(p++, messstelleId);
            if (!artFilter(z.ebene()).isEmpty()) {
                ps.setString(p++, z.ebene());
            }
            ps.setTimestamp(p, Timestamp.from(z.beginn()));
            ps.executeUpdate();
        }
    }

    private void eingaengeEinfuegen(Connection con, UUID tenant, UUID messstelleId, Zeile z, Instant jetzt)
            throws SQLException {
        eingaengeEinfuegen(con, tenant, messstelleId, z, 1, jetzt);
    }

    /**
     * Die Eingänge einer Zeile in ihrer {@code version} — Version 1 schreibt der Lauf, jede weitere die Korrektur-Kaskade
     * (AP-08 IP-17): so nennt die Herkunft einer Version ihre Eingänge in DEREN Version.
     */
    static void eingaengeEinfuegen(Connection con, UUID tenant, UUID messstelleId, Zeile z, int version, Instant jetzt)
            throws SQLException {
        try (PreparedStatement ps = con.prepareStatement("INSERT INTO bilanzwert_eingang (periode_beginn, tenant_id, "
                + "messstelle_id, periode, version, position, eingang_messstelle_id, eingang_kennzeichen, entity_id, "
                + "messkanal, rolle, anteil, vorzeichen, faktor, menge, menge_zustand, fassung, abdeckung_prozent, "
                + "eingang_version, kennzeichen, grund, berechnet_am) "
                + "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?::jsonb, ?, ?)")) {
            int position = 0;
            for (EingangZeile ez : z.eingaenge()) {
                BerechnetePeriode.Eingang e = ez.eingang();
                int p = 1;
                ps.setTimestamp(p++, Timestamp.from(z.beginn()));
                ps.setObject(p++, tenant);
                ps.setObject(p++, messstelleId);
                ps.setString(p++, z.ebene());
                ps.setInt(p++, version);
                ps.setInt(p++, position++);
                ps.setObject(p++, ez.messstelleId(), Types.OTHER);
                ps.setString(p++, ez.messstelleId() == null ? null : ez.kennzeichen());
                ps.setObject(p++, ez.entityId(), Types.OTHER);
                ps.setString(p++, ez.messkanal());
                ps.setString(p++, e.rolle());
                ps.setString(p++, e.anteil());
                ps.setString(p++, e.vorzeichen());
                ps.setBigDecimal(p++, e.faktor());
                ps.setBigDecimal(p++, e.menge());
                ps.setString(p++, e.zustand());
                ps.setString(p++, e.fassung());
                setzeZahl(ps, p++, e.abdeckungProzent());
                setzeZahl(ps, p++, e.version());
                ps.setString(p++, json(e.kennzeichen() == null ? List.of() : e.kennzeichen()));
                ps.setString(p++, e.grund());
                ps.setTimestamp(p, Timestamp.from(jetzt));
                ps.addBatch();
            }
            ps.executeBatch();
        }
    }

    // ------------------------------------------------------------------------------------ Hilfen

    private static String tabelle(String ebene) {
        return switch (ebene) {
            case VIERTELSTUNDE -> "messreihe_viertelstunde";
            case TAG -> "messreihe_tag";
            case MONAT, JAHR -> "messreihe_periode";
            default -> throw new IllegalArgumentException("unbekannte Ebene " + ebene);
        };
    }

    private static String beginnSpalte(String ebene) {
        return VIERTELSTUNDE.equals(ebene) ? "intervall_beginn" : "beginn";
    }

    /** Monat und Jahr teilen sich eine Tabelle — ihr Filter ist die Art (ein Parameter). */
    private static String artFilter(String ebene) {
        return MONAT.equals(ebene) || JAHR.equals(ebene) ? " AND art = ?" : "";
    }

    private static void setzeZahl(PreparedStatement ps, int p, Integer wert) throws SQLException {
        if (wert == null) {
            ps.setNull(p, Types.INTEGER);
        } else {
            ps.setInt(p, wert);
        }
    }

    private static String json(List<String> saetze) {
        try {
            return JSON.writeValueAsString(saetze);
        } catch (JsonProcessingException e) {
            throw new IllegalStateException(e);
        }
    }

    private static List<String> saetze(String json) {
        if (json == null) {
            return List.of();
        }
        try {
            return List.copyOf(JSON.readValue(json, new TypeReference<List<String>>() {}));
        } catch (JsonProcessingException e) {
            throw new IllegalStateException(e);
        }
    }
}
