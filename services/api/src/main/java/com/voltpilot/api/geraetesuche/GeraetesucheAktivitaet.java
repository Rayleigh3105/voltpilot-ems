package com.voltpilot.api.geraetesuche;

import com.fasterxml.jackson.core.type.TypeReference;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.voltpilot.api.uems.ProtokollAkteur;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.sql.Timestamp;
import java.time.Instant;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.stream.Collectors;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Repository;

/**
 * Das Protokoll der Gerätesuche als Zeilen der Aktivität (Folgepaket vp-gs-folge-herkunft; Konzept §4 „Verlauf",
 * §13 „Woraus die Karte ‚Aktivität' der Box gespeist wird"; Bild d1).
 *
 * <p>Die Karte „Aktivität" der Box liest den Kommando-Verlauf ({@code GET …/commands/history?device=<Box>}); dort
 * mischt {@code CommandLogReader} diese Zeilen zur LESEZEIT als eigenen Strom ein - wie die Register-Vorgänge, ohne
 * zweite Speicherung und ohne zweiten Strom daneben. Eine Suche ist EINE Zeile: {@code gestartet} (wann, wer) mit
 * {@code beendet} (Zustand, Grund, Dauer, Zähler) und {@code abbruch} (wer) derselben {@code such_id} gefaltet. Eine
 * Übernahme ist eine eigene Zeile.
 *
 * <p>Ohne {@code beendet} gilt die Regel der Suche selbst ({@link GeraetesucheDienst#zustand}): offen, solange die Box
 * sich innerhalb von {@link GeraetesucheVertrag#KEINE_ANTWORT} gemeldet hat, sonst {@code keine_antwort} - auch, wenn
 * die Suche schon vom Läufer gelöscht ist.
 */
@Repository
public class GeraetesucheAktivitaet {

    /** Die Arten, die eine Zeile tragen; {@code abbruch} und {@code beendet} werden in ihre Suche gefaltet. */
    static final List<String> ZEILEN_ARTEN = List.of("gestartet", GeraetesucheHerkunft.UEBERNOMMEN,
            GeraetesucheHerkunft.ADRESSE_UEBERNOMMEN);

    /**
     * Wessen Zeilen: die ganze Anlage ({@link #ANLAGE}), eine Box (ihre Suchen und was aus ihnen übernommen wurde)
     * oder nur die Übernahmen bestimmter Komponenten (die Seite einer Komponente oder eines Geräts dahinter).
     */
    public record Umfang(UUID box, List<UUID> komponenten) {
        public static final Umfang ANLAGE = new Umfang(null, null);

        public static Umfang box(UUID box) {
            return new Umfang(box, null);
        }

        public static Umfang komponenten(List<UUID> komponenten) {
            return new Umfang(null, List.copyOf(komponenten));
        }
    }

    /**
     * Eine Zeile der Aktivität.
     *
     * @param id         die Kennung der tragenden Protokollzeile
     * @param art        {@code gestartet} (die Suche), {@code uebernommen} oder {@code adresse_uebernommen}
     * @param wer        wer gestartet bzw. übernommen hat
     * @param beendetAm  Ankunft des Ergebnisses; null = noch keines
     * @param zustand    bei einer Suche: was die Box meldete, sonst abgeleitet (wartet, laeuft, keine_antwort)
     * @param zaehler    Funde je Gruppe zum Zeitpunkt des Ergebnisses; null ohne Ergebnis
     * @param abbruchVon wer den Abbruch angefragt hat; null = niemand
     * @param komponente der heutige Name der übernommenen Komponente (Name, sonst Marke und Modell, sonst die Rolle -
     *                   die Regel des Abgleichs); null, wenn sie inzwischen entfernt ist
     */
    public record Zeile(long id, String art, UUID suchId, UUID deviceId, UUID entityId, Instant am,
            ProtokollAkteur wer, Instant beendetAm, String zustand, String grund, Integer dauerMs,
            Map<String, Integer> zaehler, ProtokollAkteur abbruchVon, String komponente, String fund,
            Instant gesuchtAm) {
    }

    private static final String SPALTEN = """
            SELECT p.id, p.art, p.such_id, p.device_id, p.entity_id, p.am, p.actor_sub, p.actor_name, p.actor_rolle,
                   p.actor_art, p.fund_schluessel, p.gesucht_am,
                   coalesce(nullif(btrim(m.label), ''), nullif(btrim(concat_ws(' ', m.brand, m.model)), ''), m.role)
                       AS komponente,
                   b.am AS beendet_am, b.zustand, b.grund, b.dauer_ms, b.zaehler::text AS zaehler,
                   a.actor_sub AS abbruch_sub, a.actor_name AS abbruch_name, a.actor_rolle AS abbruch_rolle,
                   a.actor_art AS abbruch_art,
                   s.zustand AS such_zustand, coalesce(s.letzte_meldung_am, s.ausgeloest_am) AS such_zuletzt
              FROM geraetesuche_protokoll p
              LEFT JOIN LATERAL (SELECT am, zustand, grund, dauer_ms, zaehler FROM geraetesuche_protokoll b
                                  WHERE p.art = 'gestartet' AND b.such_id = p.such_id AND b.art = 'beendet'
                                  ORDER BY b.id LIMIT 1) b ON true
              LEFT JOIN LATERAL (SELECT actor_sub, actor_name, actor_rolle, actor_art FROM geraetesuche_protokoll a
                                  WHERE p.art = 'gestartet' AND a.such_id = p.such_id AND a.art = 'abbruch'
                                  ORDER BY a.id LIMIT 1) a ON true
              LEFT JOIN geraetesuche s ON p.art = 'gestartet' AND s.id = p.such_id
              LEFT JOIN measurement_point m ON m.id = p.entity_id
            """;

    private final JdbcTemplate jdbc;
    private final ObjectMapper mapper;

    public GeraetesucheAktivitaet(JdbcTemplate jdbc, ObjectMapper mapper) {
        this.jdbc = jdbc;
        this.mapper = mapper;
    }

    /**
     * Die Zeilen im Fenster {@code [from, to)}, die bis {@code before} begannen ({@code <=}, der Cursor des
     * Verlaufs) - jüngste zuerst, höchstens {@code limit}.
     */
    public List<Zeile> zeilen(UUID siteId, Umfang umfang, Instant from, Instant to, Instant before, int limit,
            Instant jetzt) {
        List<Object> args = new ArrayList<>();
        StringBuilder sql = new StringBuilder(SPALTEN).append(" WHERE ");
        bedingung(sql, args, siteId, umfang, from, to);
        if (before != null) {
            sql.append(" AND p.am <= ?");
            args.add(Timestamp.from(before));
        }
        sql.append(" ORDER BY p.am DESC, p.id DESC LIMIT ?");
        args.add(limit);
        return jdbc.query(sql.toString(), (rs, n) -> zeile(rs, jetzt), args.toArray());
    }

    /** Wie viele Zeilen das Fenster trägt - für den Treffer-Zähler des Verlaufs. */
    public int zahl(UUID siteId, Umfang umfang, Instant from, Instant to) {
        List<Object> args = new ArrayList<>();
        StringBuilder sql = new StringBuilder("SELECT count(*) FROM geraetesuche_protokoll p WHERE ");
        bedingung(sql, args, siteId, umfang, from, to);
        Integer n = jdbc.queryForObject(sql.toString(), Integer.class, args.toArray());
        return n == null ? 0 : n;
    }

    private static void bedingung(StringBuilder sql, List<Object> args, UUID siteId, Umfang umfang, Instant from,
            Instant to) {
        sql.append("p.site_id = ? AND p.am >= ? AND p.am < ? AND p.art = ANY(?::text[])");
        args.add(siteId);
        args.add(Timestamp.from(from));
        args.add(Timestamp.from(to));
        if (umfang.komponenten() != null) {
            // Die Seite einer Komponente: nur, was zu IHR wurde - die Suchen gehören der Box.
            args.add(textArray(List.of(GeraetesucheHerkunft.UEBERNOMMEN, GeraetesucheHerkunft.ADRESSE_UEBERNOMMEN)));
            sql.append(" AND p.entity_id = ANY(?::uuid[])");
            args.add("{" + umfang.komponenten().stream().map(UUID::toString).collect(Collectors.joining(",")) + "}");
            return;
        }
        args.add(textArray(ZEILEN_ARTEN));
        if (umfang.box() != null) {
            sql.append(" AND p.device_id = ?");
            args.add(umfang.box());
        }
    }

    private Zeile zeile(ResultSet rs, Instant jetzt) throws SQLException {
        String art = rs.getString("art");
        String zustand = rs.getString("zustand");
        if ("gestartet".equals(art) && zustand == null) {
            zustand = offen(rs.getString("such_zustand"), instant(rs, "such_zuletzt"), jetzt);
        }
        String abbruchName = rs.getString("abbruch_name");
        return new Zeile(rs.getLong("id"), art, rs.getObject("such_id", UUID.class),
                rs.getObject("device_id", UUID.class), rs.getObject("entity_id", UUID.class), instant(rs, "am"),
                new ProtokollAkteur(rs.getString("actor_sub"), rs.getString("actor_name"),
                        rs.getString("actor_rolle"), rs.getString("actor_art")),
                instant(rs, "beendet_am"), zustand, rs.getString("grund"), (Integer) rs.getObject("dauer_ms"),
                zaehler(rs.getString("zaehler")),
                abbruchName == null ? null : new ProtokollAkteur(rs.getString("abbruch_sub"), abbruchName,
                        rs.getString("abbruch_rolle"), rs.getString("abbruch_art")),
                rs.getString("komponente"), rs.getString("fund_schluessel"), instant(rs, "gesucht_am"));
    }

    /**
     * Eine Suche ohne Ergebnis im Protokoll: offen nach der Regel von {@link GeraetesucheDienst#zustand}, sonst
     * {@code keine_antwort} - auch, wenn der Läufer die Suche schon gelöscht hat.
     */
    static String offen(String gespeichert, Instant zuletzt, Instant jetzt) {
        boolean offen = "wartet".equals(gespeichert) || "laeuft".equals(gespeichert);
        if (!offen || zuletzt == null || zuletzt.isBefore(jetzt.minus(GeraetesucheVertrag.KEINE_ANTWORT))) {
            return "keine_antwort";
        }
        return gespeichert;
    }

    private Map<String, Integer> zaehler(String json) {
        if (json == null) {
            return null;
        }
        try {
            return mapper.readValue(json, new TypeReference<java.util.LinkedHashMap<String, Integer>>() { });
        } catch (Exception e) {
            throw new IllegalStateException("zaehler", e);
        }
    }

    private static String textArray(List<String> werte) {
        return "{" + String.join(",", werte) + "}";
    }

    private static Instant instant(ResultSet rs, String spalte) throws SQLException {
        Timestamp t = rs.getTimestamp(spalte);
        return t == null ? null : t.toInstant();
    }
}
