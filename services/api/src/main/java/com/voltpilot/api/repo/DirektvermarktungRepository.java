package com.voltpilot.api.repo;

import com.fasterxml.jackson.databind.ObjectMapper;
import java.sql.Date;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.sql.Timestamp;
import java.time.Instant;
import java.time.LocalDate;
import java.util.List;
import java.util.UUID;
import org.springframework.dao.DataIntegrityViolationException;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Repository;

/**
 * Der Anschluss einer Anlage an einen Direktvermarkter ({@code direktvermarktung},
 * {@code direktvermarktung_protokoll}; V20261125140000). Unter RLS des aktuellen Mandanten - Lesen und
 * Schreiben außerhalb der eigenen Anlage gibt es auf dieser Verbindung gar nicht.
 */
@Repository
public class DirektvermarktungRepository {

    /** Zustände, Konzept §5.4 "Lagen des Anschlusses"; die Spalten-CHECK-Constraint ist dieselbe Liste. */
    public static final String ENTWURF = "entwurf";
    public static final String WARTET_AUF_ZUGANG = "wartet_auf_zugang";
    public static final String VERBINDET = "verbindet";
    public static final String WARTET_AUF_PARTNER = "wartet_auf_partner";
    public static final String VERBUNDEN = "verbunden";
    public static final String GESTOERT = "gestoert";
    public static final String ENDET = "endet";
    public static final String BEENDET = "beendet";

    /** Eine Zeile der Tabelle {@code direktvermarktung}. */
    public record Eintrag(UUID id, UUID siteId, String partner, String zustand, Instant zustimmungAm,
            String zustimmungVon, String zustimmungRolle, String zustimmungFassung, LocalDate startdatum,
            LocalDate ende, UUID folgtAuf, int revision, Instant erstelltAm, Instant aktualisiertAm) {

        public boolean aktiv() {
            return !BEENDET.equals(zustand);
        }
    }

    /** Ein Herzschlag-Block aus {@code direktvermarktung_stand} - ohne Zeile ist der Stand unbekannt (§5.1). */
    public record Stand(Instant tunnelObenSeit, Instant handshakeAm, String gegenstelle, Instant letzteAbfrageAm,
            Double abfragenJeMinute, Instant letzteSchreibungAm, Integer vorgabePct, Instant lebenszeichenAm,
            Integer einspeisungW, Integer erzeugungW, Integer netzbetreiberPct, Integer referenzW,
            Instant gemeldetAm) {}

    /** Eine Protokollzeile - append-only, niemals geändert oder gelöscht. */
    public record ProtokollZeile(long id, String ereignis, String von, String rolle, String datenJson, Instant am) {}

    private static final String SPALTEN = "id, site_id, partner, zustand, zustimmung_am, zustimmung_von, "
            + "zustimmung_rolle, zustimmung_fassung, startdatum, ende, folgt_auf, revision, erstellt_am, "
            + "aktualisiert_am";

    private final JdbcTemplate jdbc;
    private final ObjectMapper json;

    public DirektvermarktungRepository(JdbcTemplate jdbc, ObjectMapper json) {
        this.jdbc = jdbc;
        this.json = json;
    }

    /**
     * Die nicht beendeten Einträge einer Anlage, älteste zuerst - normalerweise genau einer; während eines
     * geplanten Wechsels (Abschnitt 6) der alte (mit {@code ende} gesetzt) und der neue zusammen.
     */
    public List<Eintrag> aktuelle(UUID siteId) {
        return jdbc.query("SELECT " + SPALTEN + " FROM direktvermarktung WHERE site_id = ? AND zustand <> ? "
                + "ORDER BY erstellt_am", DirektvermarktungRepository::mapEintrag, siteId, BEENDET);
    }

    /** Der eine Eintrag, der gerade (noch) kein Ende trägt - der, den Zustimmung/Zugang/Start betreffen. */
    public Eintrag aktiverOhneEnde(UUID siteId) {
        return aktuelle(siteId).stream().filter(e -> e.ende() == null).findFirst().orElse(null);
    }

    public Eintrag findById(UUID id) {
        List<Eintrag> r = jdbc.query("SELECT " + SPALTEN + " FROM direktvermarktung WHERE id = ?",
                DirektvermarktungRepository::mapEintrag, id);
        return r.isEmpty() ? null : r.get(0);
    }

    /** Die ganze Geschichte einer Anlage, neueste zuerst (Beenden/Wechsel eingeschlossen). */
    public List<Eintrag> verlauf(UUID siteId, int grenze) {
        return jdbc.query("SELECT " + SPALTEN + " FROM direktvermarktung WHERE site_id = ? "
                + "ORDER BY erstellt_am DESC LIMIT ?", DirektvermarktungRepository::mapEintrag, siteId, grenze);
    }

    /**
     * Legt einen neuen Entwurf an; {@code folgtAuf} nur bei einem geplanten Wechsel. Wirft
     * {@link DataIntegrityViolationException}, wenn die Anlage schon einen aktiven Eintrag ohne Ende hat
     * ({@code ux_direktvermarktung_aktiv_ohne_ende}) - der Dienst übersetzt das in eine deutsche Ablehnung.
     */
    public Eintrag anlegen(UUID tenantId, UUID siteId, String partner, UUID folgtAuf, Instant jetzt) {
        UUID id = UUID.randomUUID();
        jdbc.update("INSERT INTO direktvermarktung (id, tenant_id, site_id, partner, zustand, folgt_auf, "
                + "erstellt_am, aktualisiert_am) VALUES (?, ?, ?, ?, ?, ?, ?, ?)", id, tenantId, siteId, partner,
                ENTWURF, folgtAuf, Timestamp.from(jetzt), Timestamp.from(jetzt));
        return findById(id);
    }

    /** Zustimmung: Zeit, Person, Rolle, Textfassung - und der Schritt nach "wartet_auf_zugang". */
    public void zustimmen(UUID id, String von, String rolle, String fassung, Instant jetzt) {
        jdbc.update("UPDATE direktvermarktung SET zustand = ?, zustimmung_am = ?, zustimmung_von = ?, "
                + "zustimmung_rolle = ?, zustimmung_fassung = ?, aktualisiert_am = ? WHERE id = ?",
                WARTET_AUF_ZUGANG, Timestamp.from(jetzt), von, rolle, fassung, Timestamp.from(jetzt), id);
    }

    public void zustandSetzen(UUID id, String zustand, Instant jetzt) {
        jdbc.update("UPDATE direktvermarktung SET zustand = ?, aktualisiert_am = ? WHERE id = ?", zustand,
                Timestamp.from(jetzt), id);
    }

    public void startdatumSetzen(UUID id, LocalDate startdatum, Instant jetzt) {
        jdbc.update("UPDATE direktvermarktung SET startdatum = ?, aktualisiert_am = ? WHERE id = ?",
                startdatum == null ? null : Date.valueOf(startdatum), Timestamp.from(jetzt), id);
    }

    /** Beenden: setzt das Enddatum; {@code endeZustand} ist {@code beendet} (Datum schon erreicht) oder {@code endet}. */
    public void beenden(UUID id, LocalDate ende, String endeZustand, Instant jetzt) {
        jdbc.update("UPDATE direktvermarktung SET ende = ?, zustand = ?, aktualisiert_am = ? WHERE id = ?",
                Date.valueOf(ende), endeZustand, Timestamp.from(jetzt), id);
    }

    /** Die Einträge, deren Enddatum heute oder früher liegt und die noch nicht {@code beendet} sind (Nachtlauf). */
    public List<Eintrag> fälligZumBeenden(LocalDate heute) {
        return jdbc.query("SELECT " + SPALTEN + " FROM direktvermarktung WHERE zustand = ? AND ende <= ?",
                DirektvermarktungRepository::mapEintrag, ENDET, Date.valueOf(heute));
    }

    /** Die Entwürfe, deren Startdatum heute oder früher liegt (Nachtlauf, Vermarktungsart umstellen). */
    public List<Eintrag> fälligZumStarten(LocalDate heute) {
        return jdbc.query("SELECT " + SPALTEN + " FROM direktvermarktung WHERE zustand <> ? AND zustand <> ? "
                + "AND startdatum IS NOT NULL AND startdatum <= ?", DirektvermarktungRepository::mapEintrag,
                BEENDET, ENDET, Date.valueOf(heute));
    }

    /** Die Vermarktungsart der Anlage (Muster {@code EinspeiseverguetungRepository.setAngegeben}). */
    public boolean plantKindSetzen(UUID siteId, String plantKind) {
        return jdbc.update("UPDATE site SET plant_kind = ? WHERE id = ?", plantKind, siteId) > 0;
    }

    public Stand stand(UUID siteId) {
        List<Stand> r = jdbc.query("SELECT tunnel_oben_seit, handshake_am, gegenstelle, letzte_abfrage_am, "
                + "abfragen_je_minute, letzte_schreibung_am, vorgabe_pct, lebenszeichen_am, einspeisung_w, "
                + "erzeugung_w, netzbetreiber_pct, referenz_w, gemeldet_am FROM direktvermarktung_stand "
                + "WHERE site_id = ?", DirektvermarktungRepository::mapStand, siteId);
        return r.isEmpty() ? null : r.get(0);
    }

    public void protokolliere(UUID tenantId, UUID siteId, UUID direktvermarktungId, String ereignis, String von,
            String rolle, String datenJson, Instant jetzt) {
        jdbc.update("INSERT INTO direktvermarktung_protokoll (tenant_id, site_id, direktvermarktung_id, ereignis, "
                + "von, rolle, daten, am) VALUES (?, ?, ?, ?, ?, ?, ?::jsonb, ?)", tenantId, siteId,
                direktvermarktungId, ereignis, von, rolle, datenJson, Timestamp.from(jetzt));
    }

    public List<ProtokollZeile> protokoll(UUID siteId, int grenze) {
        return jdbc.query("SELECT id, ereignis, von, rolle, daten::text, am FROM direktvermarktung_protokoll "
                + "WHERE site_id = ? ORDER BY am DESC, id DESC LIMIT ?",
                (rs, i) -> new ProtokollZeile(rs.getLong(1), rs.getString(2), rs.getString(3), rs.getString(4),
                        rs.getString(5), rs.getTimestamp(6).toInstant()),
                siteId, grenze);
    }

    private static Eintrag mapEintrag(ResultSet rs, int i) throws SQLException {
        Date startdatum = rs.getDate("startdatum");
        Date ende = rs.getDate("ende");
        String folgtAufRaw = rs.getString("folgt_auf");
        return new Eintrag(UUID.fromString(rs.getString("id")), UUID.fromString(rs.getString("site_id")),
                rs.getString("partner"), rs.getString("zustand"), ts(rs, "zustimmung_am"),
                rs.getString("zustimmung_von"), rs.getString("zustimmung_rolle"), rs.getString("zustimmung_fassung"),
                startdatum == null ? null : startdatum.toLocalDate(), ende == null ? null : ende.toLocalDate(),
                folgtAufRaw == null ? null : UUID.fromString(folgtAufRaw), rs.getInt("revision"),
                ts(rs, "erstellt_am"), ts(rs, "aktualisiert_am"));
    }

    private static Stand mapStand(ResultSet rs, int i) throws SQLException {
        return new Stand(ts(rs, "tunnel_oben_seit"), ts(rs, "handshake_am"), rs.getString("gegenstelle"),
                ts(rs, "letzte_abfrage_am"), (Double) rs.getObject("abfragen_je_minute"),
                ts(rs, "letzte_schreibung_am"), (Integer) rs.getObject("vorgabe_pct"),
                ts(rs, "lebenszeichen_am"), (Integer) rs.getObject("einspeisung_w"),
                (Integer) rs.getObject("erzeugung_w"), (Integer) rs.getObject("netzbetreiber_pct"),
                (Integer) rs.getObject("referenz_w"), ts(rs, "gemeldet_am"));
    }

    private static Instant ts(ResultSet rs, String spalte) throws SQLException {
        Timestamp t = rs.getTimestamp(spalte);
        return t == null ? null : t.toInstant();
    }
}
