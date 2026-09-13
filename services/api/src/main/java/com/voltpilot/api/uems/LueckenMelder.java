package com.voltpilot.api.uems;

import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.voltpilot.api.measurement.MeasurementCatalog;
import com.voltpilot.api.uems.EreignisVokabular.Urheber;
import com.voltpilot.api.uems.EreignisVokabular.Urteil;
import java.math.BigDecimal;
import java.sql.Connection;
import java.sql.PreparedStatement;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.sql.Savepoint;
import java.sql.Timestamp;
import java.time.Duration;
import java.time.Instant;
import java.util.ArrayList;
import java.util.List;
import java.util.UUID;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Qualifier;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Component;

/**
 * Der Lücken-Melder (UEMS AP-07 IP-9): stellt fest, dass Werte FEHLEN, und schreibt es als
 * Ereignis {@code data_gap} fest — und schließt die Lücke wieder, wenn die Box zurückkommt oder
 * nachliefert ({@code nachgeliefert_am}, Ereignis {@code backfill}).
 *
 * <h2>Zwei Wege, ein Ergebnis</h2>
 *
 * <ul>
 *   <li><b>Je Reihe aus der Kadenz</b> (Komponente + Messkanal, E2): kein guter Wert über
 *       {@code 2 × Kadenz} — die Schwelle ist die des Zustandsvertrags
 *       ({@link LueckenRegeln#reiheOffen}), die Kadenz die ZUM ZEITPUNKT des letzten guten Werts
 *       (E9, {@link KadenzRegeln#wirksam}). Eine offene Lücke beginnt beim ersten erwarteten, aber
 *       fehlenden Wert; ein Loch zwischen zwei guten Werten, das zwischen zwei Takten entstand
 *       und schon wieder zu ist, wird geschlossen gemeldet. Nur Reihen mit eingeschalteter
 *       Mess-Auswahl werden erwartet.
 *   <li><b>Je Box aus dem letzten Eingang</b> („Box meldet sich nicht“): länger als die
 *       Herzschlag-Toleranz kein Eingang von ihr ({@code telemetry.received_at} — dieselbe
 *       Grundlage wie die Live-Flächen — und {@code device_measurement_sample.received_at}). Dann
 *       entsteht EINE offene Lücke je Box (Bezug nur {@code box}: der KERN-Pfad bekommt so seine
 *       Lücke) und EINE je Datenquelle, für die die Box zu dem Zeitpunkt zuständig war
 *       ({@code data_source_assignment}, der UEMS-Pfad) — nie eine je fehlendem Wert, nie eine
 *       zweite, solange die erste offen ist.
 * </ul>
 *
 * <h2>Schließen</h2>
 *
 * <p>Schließen ist eine FORTSCHREIBUNG (append-only, dieselbe Kennung, gleicher Bezug):
 * {@code bis} ist bei der Reihe die Messzeit des ersten wieder rechtzeitig eingegangenen Werts,
 * bei Box und Quelle der erste Eingang nach dem Schweigen (bei einer Quelle, deren Zuständigkeit
 * vorher endete, dieses Ende — ein Box-Tausch liefert nicht nach). {@code nachgeliefert_am} ist
 * die Eingangszeit des ersten nachgelieferten Werts im Zeitraum — die Zustellart hat der Writer
 * schon festgestellt ({@code delivery = 'nachgeliefert'}); sie kommt mit dem Schließen oder
 * später als eigene Fortschreibung. Eine Nachlieferung wird, sobald sie ruht, je Box und Quelle
 * EIN {@code backfill}.
 *
 * <h2>Arbeitsweise</h2>
 *
 * <p>Zwei Schritte je Takt: {@link #eintragen} liest die Eingänge seit dem Zeiger und schreibt den
 * Stand je Box und Reihe fort ({@code messreihe_luecke_stand}, Zeiger unter {@code FOR UPDATE SKIP
 * LOCKED}); {@link #pruefen} entnimmt die fälligen Einheiten stapelweise unter {@code FOR UPDATE
 * SKIP LOCKED} und prüft, meldet und schreibt den Stand in DERSELBEN Transaktion. Jede Einheit in
 * einem eigenen Savepoint: ein Fehler kostet nur ihre Prüfung, nie den Stapel. Die Kennungen sind
 * abgeleitet ({@link LueckenRegeln}), eine Meldung wird vor dem Schreiben gegen die jüngste
 * derselben Kennung geprüft — ein zweiter Lauf schreibt nichts.
 *
 * <p>Nicht hier: Alarm und Benachrichtigung, Ersatzwerte (AP-08 E7), Korrektur, Löschen,
 * Rechte-Durchsetzung.
 */
@Component
public class LueckenMelder {

    private static final Logger log = LoggerFactory.getLogger(LueckenMelder.class);
    private static final ObjectMapper JSON = new ObjectMapper();

    /** Die Zeilen mit Reihe außerhalb des Spiegels — dieselbe Spur wie die Verdichtung. */
    static final String SPUR = "s.entity_id IS NOT NULL AND s.role IS DISTINCT FROM 'spiegel'";

    /** Der Zeiger bleibt so weit hinter der Uhr, damit laufende Schreibvorgänge ankommen. */
    static final Duration SICHERHEIT = Duration.ofMinutes(2);

    /** Die Überlappung beim Wiederlesen — jeder Eintrag ist idempotent (GREATEST/LEAST). */
    static final Duration UEBERLAPP = Duration.ofMinutes(2);

    /**
     * Wie weit der allererste Lauf die Eingänge zurückliest. Den jüngsten Eingang JEDER Box holt er
     * trotzdem, über den Index {@code (device_id, received_at)} der Telemetrie — eine Box, die schon
     * vor dem ersten Lauf schwieg, bekommt ihre Lücke.
     */
    static final Duration ANLAUF = Duration.ofDays(1);

    /** Wann eine Einheit mit offener Lücke erneut angesehen wird, auch ohne Eingang. */
    static final Duration NACHSCHAU = Duration.ofHours(1);

    /** Wie weit zurück geschlossene Lücken noch eine Nachlieferung bekommen (die Rohdaten-Frist). */
    static final Duration ROHDATEN_FRIST = Duration.ofDays(90);

    private final JdbcTemplate adminJdbc;
    private final MeasurementCatalog katalog;
    private final int stapel;
    private final int stapelJeLauf;
    private final int werteJeLochsuche;

    public LueckenMelder(@Qualifier("adminJdbcTemplate") JdbcTemplate adminJdbc,
            MeasurementCatalog katalog,
            @Value("${voltpilot.uems.luecken.stapel:200}") int stapel,
            @Value("${voltpilot.uems.luecken.stapel-je-lauf:50}") int stapelJeLauf,
            @Value("${voltpilot.uems.luecken.werte-je-lochsuche:20000}") int werteJeLochsuche) {
        this.adminJdbc = adminJdbc;
        this.katalog = katalog;
        this.stapel = stapel;
        this.stapelJeLauf = stapelJeLauf;
        this.werteJeLochsuche = werteJeLochsuche;
    }

    /** Was ein Lauf tat — für das Log und die Tests. */
    public record Ergebnis(int eingetragen, int geprueft, int geoeffnet, int geschlossen,
            int nachgeliefert, int backfill, int verworfen) {}

    private static final class Zaehler {
        int eingetragen;
        int geprueft;
        int geoeffnet;
        int geschlossen;
        int nachgeliefert;
        int backfill;
        int verworfen;

        Ergebnis ergebnis() {
            return new Ergebnis(eingetragen, geprueft, geoeffnet, geschlossen, nachgeliefert,
                    backfill, verworfen);
        }
    }

    /**
     * Ein Takt: eintragen, dann die fälligen Einheiten prüfen. Hält ein anderer Melder gerade den
     * Zeiger, entfällt der GANZE Takt — nicht nur das Eintragen: ein Prüfen auf dem Stand von
     * vorher sähe eine Box schweigen, deren Eingänge der andere gerade einträgt.
     */
    public Ergebnis lauf(Instant jetzt) {
        int eingetragen = eintragen(jetzt);
        if (eingetragen < 0) {
            return new Zaehler().ergebnis();
        }
        Ergebnis e = pruefen(jetzt, eingetragen);
        if (e.geoeffnet() + e.geschlossen() + e.nachgeliefert() + e.backfill() + e.verworfen() > 0) {
            log.info("UEMS Lücken-Melder: {}", e);
        }
        return e;
    }

    /** Prüft die fälligen Einheiten, stapelweise unter {@code FOR UPDATE SKIP LOCKED}. */
    public Ergebnis pruefen(Instant jetzt) {
        return pruefen(jetzt, 0);
    }

    private Ergebnis pruefen(Instant jetzt, int eingetragen) {
        Zaehler z = new Zaehler();
        z.eingetragen = eingetragen;
        for (int i = 0; i < stapelJeLauf; i++) {
            int n = inTransaktion(con -> pruefeStapel(con, jetzt, z));
            if (n < stapel) {
                break;
            }
        }
        return z.ergebnis();
    }


    // ============================================================== 1. Eintragen

    /**
     * Liest die Eingänge seit dem Zeiger und schreibt den Stand je Box und Reihe fort. Gibt die
     * Zahl der fortgeschriebenen Einheiten zurück, {@code -1}, wenn ein anderer Melder den Zeiger
     * gerade hält (übersprungen, nicht gewartet).
     */
    public int eintragen(Instant jetzt) {
        return inTransaktion(con -> {
            Timestamp alt;
            try (PreparedStatement ps = con.prepareStatement("SELECT zeitpunkt FROM messreihe_luecke_lauf "
                    + "WHERE schluessel = 'zeiger' FOR UPDATE SKIP LOCKED");
                    ResultSet rs = ps.executeQuery()) {
                if (!rs.next()) {
                    return -1;
                }
                alt = rs.getTimestamp(1);
            }
            Instant neu = jetzt.minus(SICHERHEIT);
            Instant ab = alt == null ? neu.minus(ANLAUF) : alt.toInstant().minus(UEBERLAPP);
            int n = 0;
            if (alt == null) {
                n += boxenErstmals(con, neu, jetzt);
            }
            if (neu.isAfter(ab)) {
                n += boxAusProben(con, ab, neu, jetzt);
                n += reihenAusProben(con, ab, neu, jetzt);
                n += boxAusTelemetrie(con, ab, neu, jetzt);
            }
            try (PreparedStatement ps = con.prepareStatement("UPDATE messreihe_luecke_lauf "
                    + "SET zeitpunkt = GREATEST(COALESCE(zeitpunkt, ?), ?), zahl = zahl + ?, "
                    + "geaendert_am = now() WHERE schluessel = 'zeiger'")) {
                ps.setTimestamp(1, Timestamp.from(neu));
                ps.setTimestamp(2, Timestamp.from(neu));
                ps.setLong(3, n);
                ps.executeUpdate();
            }
            return n;
        });
    }

    /** Das Fortschreiben eines Box-Stands — gemeinsam für Messwerte und Telemetrie. */
    private static final String BOX_KONFLIKT = """
            ON CONFLICT (tenant_id, einheit) DO UPDATE SET
                   zuletzt = GREATEST(st.zuletzt, EXCLUDED.zuletzt),
                   site_id = COALESCE(EXCLUDED.site_id, st.site_id),
                   erste_nach = CASE WHEN st.luecke_seit IS NULL THEN NULL
                                     ELSE LEAST(st.erste_nach, EXCLUDED.erste_nach) END,
                   nachlieferung_von = LEAST(st.nachlieferung_von, EXCLUDED.nachlieferung_von),
                   nachlieferung_bis = GREATEST(st.nachlieferung_bis, EXCLUDED.nachlieferung_bis),
                   faellig_ab = EXCLUDED.faellig_ab
            """;

    /**
     * Der allererste Lauf: der jüngste Telemetrie-Eingang jeder angemeldeten Box, egal wie alt — nur
     * über den Index, ohne die Nachlieferungs-Filter (die liest das Eintragen nur im Anlauf-Fenster).
     */
    private int boxenErstmals(Connection con, Instant bis, Instant jetzt) throws SQLException {
        try (PreparedStatement ps = con.prepareStatement("""
                INSERT INTO messreihe_luecke_stand AS st (tenant_id, einheit, art, device_id, site_id,
                       zuletzt, faellig_ab)
                SELECT d.tenant_id, 'box:' || d.id::text, 'box', d.id, d.site_id, t.letzte, ?
                  FROM device d
                 CROSS JOIN LATERAL (SELECT max(x.received_at) AS letzte FROM telemetry x
                                      WHERE x.device_id = d.id AND x.received_at <= ?) t
                 WHERE d.status = 'claimed' AND t.letzte IS NOT NULL
                ON CONFLICT (tenant_id, einheit) DO UPDATE SET
                       zuletzt = GREATEST(st.zuletzt, EXCLUDED.zuletzt), faellig_ab = EXCLUDED.faellig_ab
                """)) {
            ps.setTimestamp(1, Timestamp.from(jetzt));
            ps.setTimestamp(2, Timestamp.from(bis));
            return ps.executeUpdate();
        }
    }

    private int boxAusProben(Connection con, Instant von, Instant bis, Instant jetzt)
            throws SQLException {
        String sql = """
                INSERT INTO messreihe_luecke_stand AS st (tenant_id, einheit, art, device_id, site_id,
                       zuletzt, erste_nach, nachlieferung_von, nachlieferung_bis, faellig_ab)
                SELECT e.tenant_id, 'box:' || e.device_id::text, 'box', e.device_id, e.site_id,
                       e.letzte, e.erste_nach, e.nach_von, e.nach_bis, ?
                  FROM (SELECT s.tenant_id, s.device_id, d.site_id,
                               max(s.received_at) AS letzte,
                               min(s.received_at) FILTER (WHERE s.received_at > b.luecke_seit) AS erste_nach,
                               min(s.received_at) FILTER (WHERE s.delivery = 'nachgeliefert'
                                   AND s.received_at > COALESCE(b.nachlieferung_gemeldet_bis, '-infinity')) AS nach_von,
                               max(s.received_at) FILTER (WHERE s.delivery = 'nachgeliefert'
                                   AND s.received_at > COALESCE(b.nachlieferung_gemeldet_bis, '-infinity')) AS nach_bis
                          FROM device_measurement_sample s
                          LEFT JOIN device d ON d.id = s.device_id AND d.tenant_id = s.tenant_id
                          LEFT JOIN messreihe_luecke_stand b
                                 ON b.tenant_id = s.tenant_id AND b.einheit = 'box:' || s.device_id::text
                         WHERE s.received_at > ? AND s.received_at <= ? AND %s
                         GROUP BY s.tenant_id, s.device_id, d.site_id, b.luecke_seit,
                                  b.nachlieferung_gemeldet_bis) e
                """.formatted(SPUR) + BOX_KONFLIKT;
        try (PreparedStatement ps = con.prepareStatement(sql)) {
            ps.setTimestamp(1, Timestamp.from(jetzt));
            ps.setTimestamp(2, Timestamp.from(von));
            ps.setTimestamp(3, Timestamp.from(bis));
            return ps.executeUpdate();
        }
    }

    /**
     * Die Telemetrie des Kerns: je Box über ihren Index {@code (device_id, received_at)} — dieselbe
     * Ankunft, aus der die Live-Flächen „verbunden“ ableiten. Ein Wert heißt hier nachgeliefert,
     * wenn er mehr als die Mindest-Toleranz nach seiner Messzeit einging (der Kern kennt keine
     * Zustellart).
     */
    private int boxAusTelemetrie(Connection con, Instant von, Instant bis, Instant jetzt)
            throws SQLException {
        String sql = """
                INSERT INTO messreihe_luecke_stand AS st (tenant_id, einheit, art, device_id, site_id,
                       zuletzt, erste_nach, nachlieferung_von, nachlieferung_bis, faellig_ab)
                SELECT d.tenant_id, 'box:' || d.id::text, 'box', d.id, d.site_id,
                       t.letzte, t.erste_nach, t.nach_von, t.nach_bis, ?
                  FROM device d
                  LEFT JOIN messreihe_luecke_stand b
                         ON b.tenant_id = d.tenant_id AND b.einheit = 'box:' || d.id::text
                 CROSS JOIN LATERAL (
                        SELECT max(x.received_at) AS letzte,
                               min(x.received_at) FILTER (WHERE x.received_at > b.luecke_seit) AS erste_nach,
                               min(x.received_at) FILTER (WHERE x.received_at > x.time + make_interval(secs => ?)
                                   AND x.received_at > COALESCE(b.nachlieferung_gemeldet_bis, '-infinity')) AS nach_von,
                               max(x.received_at) FILTER (WHERE x.received_at > x.time + make_interval(secs => ?)
                                   AND x.received_at > COALESCE(b.nachlieferung_gemeldet_bis, '-infinity')) AS nach_bis
                          FROM telemetry x
                         WHERE x.device_id = d.id AND x.received_at > ? AND x.received_at <= ?) t
                 WHERE t.letzte IS NOT NULL
                """ + BOX_KONFLIKT;
        try (PreparedStatement ps = con.prepareStatement(sql)) {
            ps.setTimestamp(1, Timestamp.from(jetzt));
            ps.setLong(2, ZustandAbleitung.TOLERANZ_MINDESTENS_S);
            ps.setLong(3, ZustandAbleitung.TOLERANZ_MINDESTENS_S);
            ps.setTimestamp(4, Timestamp.from(von));
            ps.setTimestamp(5, Timestamp.from(bis));
            return ps.executeUpdate();
        }
    }

    private int reihenAusProben(Connection con, Instant von, Instant bis, Instant jetzt)
            throws SQLException {
        String sql = """
                INSERT INTO messreihe_luecke_stand AS st (tenant_id, einheit, art, device_id, site_id,
                       entity_id, messkanal, zuletzt, nachlieferung_von, nachlieferung_bis, faellig_ab)
                SELECT s.tenant_id, 'reihe:' || s.entity_id::text || ':' || s.point_key, 'reihe',
                       (array_agg(s.device_id ORDER BY s.time DESC))[1],
                       (array_agg(s.site_id ORDER BY s.time DESC))[1],
                       s.entity_id, s.point_key, max(s.time),
                       min(s.received_at) FILTER (WHERE s.delivery = 'nachgeliefert'),
                       max(s.received_at) FILTER (WHERE s.delivery = 'nachgeliefert'), ?
                  FROM device_measurement_sample s
                 WHERE s.received_at > ? AND s.received_at <= ? AND %s AND s.quality = 'good'
                 GROUP BY s.tenant_id, s.entity_id, s.point_key
                ON CONFLICT (tenant_id, einheit) DO UPDATE SET
                       device_id = CASE WHEN EXCLUDED.zuletzt >= st.zuletzt THEN EXCLUDED.device_id
                                        ELSE st.device_id END,
                       site_id = CASE WHEN EXCLUDED.zuletzt >= st.zuletzt THEN EXCLUDED.site_id
                                      ELSE st.site_id END,
                       zuletzt = GREATEST(st.zuletzt, EXCLUDED.zuletzt),
                       nachlieferung_von = LEAST(st.nachlieferung_von, EXCLUDED.nachlieferung_von),
                       nachlieferung_bis = GREATEST(st.nachlieferung_bis, EXCLUDED.nachlieferung_bis),
                       faellig_ab = EXCLUDED.faellig_ab
                """.formatted(SPUR);
        try (PreparedStatement ps = con.prepareStatement(sql)) {
            ps.setTimestamp(1, Timestamp.from(jetzt));
            ps.setTimestamp(2, Timestamp.from(von));
            ps.setTimestamp(3, Timestamp.from(bis));
            return ps.executeUpdate();
        }
    }

    // ================================================================ 2. Prüfen

    /** Der Stand EINER Einheit, wie entnommen — und wie er zurückgeschrieben wird. */
    static final class Einheit {
        UUID tenant;
        String einheit;
        boolean box;
        UUID device;
        UUID site;
        UUID entity;
        String kanal;
        Instant zuletzt;
        Instant lueckeSeit;
        Integer lueckeKadenzS;
        Instant ersteNach;
        Instant nachVon;
        Instant nachBis;
        Instant gemeldetBis;
        Instant geprueftBis;
        Instant faellig;
    }

    private int pruefeStapel(Connection con, Instant jetzt, Zaehler z) throws SQLException {
        List<Einheit> einheiten = new ArrayList<>();
        try (PreparedStatement ps = con.prepareStatement("""
                SELECT tenant_id, einheit, art, device_id, site_id, entity_id, messkanal, zuletzt,
                       luecke_seit, luecke_kadenz_s, erste_nach, nachlieferung_von,
                       nachlieferung_bis, nachlieferung_gemeldet_bis, geprueft_bis
                  FROM messreihe_luecke_stand
                 WHERE faellig_ab <= ?
                 ORDER BY (art = 'box'), faellig_ab
                 LIMIT ?
                 FOR UPDATE SKIP LOCKED
                """)) {
            ps.setTimestamp(1, Timestamp.from(jetzt));
            ps.setInt(2, stapel);
            try (ResultSet rs = ps.executeQuery()) {
                while (rs.next()) {
                    Einheit e = new Einheit();
                    e.tenant = rs.getObject("tenant_id", UUID.class);
                    e.einheit = rs.getString("einheit");
                    e.box = "box".equals(rs.getString("art"));
                    e.device = rs.getObject("device_id", UUID.class);
                    e.site = rs.getObject("site_id", UUID.class);
                    e.entity = rs.getObject("entity_id", UUID.class);
                    e.kanal = rs.getString("messkanal");
                    e.zuletzt = zeit(rs, "zuletzt");
                    e.lueckeSeit = zeit(rs, "luecke_seit");
                    int k = rs.getInt("luecke_kadenz_s");
                    e.lueckeKadenzS = rs.wasNull() ? null : k;
                    e.ersteNach = zeit(rs, "erste_nach");
                    e.nachVon = zeit(rs, "nachlieferung_von");
                    e.nachBis = zeit(rs, "nachlieferung_bis");
                    e.gemeldetBis = zeit(rs, "nachlieferung_gemeldet_bis");
                    e.geprueftBis = zeit(rs, "geprueft_bis");
                    einheiten.add(e);
                }
            }
        }
        for (Einheit e : einheiten) {
            Savepoint sp = con.setSavepoint();
            try {
                if (e.box) {
                    pruefeBox(con, e, jetzt, z);
                } else {
                    pruefeReihe(con, e, jetzt, z);
                }
                standSchreiben(con, e, jetzt);
                con.releaseSavepoint(sp);
                z.geprueft++;
            } catch (SQLException | RuntimeException ex) {
                // Nur DIESE Einheit fällt zurück; sie wird später erneut angesehen und hält den
                // Stapel nicht auf. Laut, nie still.
                con.rollback(sp);
                z.verworfen++;
                log.error("UEMS Lücken-Melder: Prüfung von {} ({}) fehlgeschlagen — später erneut",
                        e.einheit, e.tenant, ex);
                try (PreparedStatement ps = con.prepareStatement("UPDATE messreihe_luecke_stand "
                        + "SET faellig_ab = ?, geprueft_am = ? WHERE tenant_id = ? AND einheit = ?")) {
                    ps.setTimestamp(1, Timestamp.from(jetzt.plus(NACHSCHAU)));
                    ps.setTimestamp(2, Timestamp.from(jetzt));
                    ps.setObject(3, e.tenant);
                    ps.setString(4, e.einheit);
                    ps.executeUpdate();
                }
            }
        }
        return einheiten.size();
    }

    private void standSchreiben(Connection con, Einheit e, Instant jetzt) throws SQLException {
        try (PreparedStatement ps = con.prepareStatement("""
                UPDATE messreihe_luecke_stand
                   SET luecke_seit = ?, luecke_kadenz_s = ?, erste_nach = ?, nachlieferung_von = ?,
                       nachlieferung_bis = ?, nachlieferung_gemeldet_bis = ?, geprueft_bis = ?,
                       faellig_ab = ?, geprueft_am = ?
                 WHERE tenant_id = ? AND einheit = ?
                """)) {
            ps.setTimestamp(1, ts(e.lueckeSeit));
            ps.setObject(2, e.box ? null : e.lueckeKadenzS);
            ps.setTimestamp(3, ts(e.ersteNach));
            ps.setTimestamp(4, ts(e.nachVon));
            ps.setTimestamp(5, ts(e.nachBis));
            ps.setTimestamp(6, ts(e.box ? e.gemeldetBis : null));
            ps.setTimestamp(7, ts(e.box ? null : e.geprueftBis));
            ps.setTimestamp(8, ts(e.faellig));
            ps.setTimestamp(9, Timestamp.from(jetzt));
            ps.setObject(10, e.tenant);
            ps.setString(11, e.einheit);
            ps.executeUpdate();
        }
    }

    // ------------------------------------------------------------------- Box

    private void pruefeBox(Connection con, Einheit e, Instant jetzt, Zaehler z) throws SQLException {
        boolean angemeldet = boxAngemeldet(con, e);
        Instant faellig = null;
        if (e.lueckeSeit == null) {
            if (LueckenRegeln.boxSchweigt(e.zuletzt, jetzt)) {
                if (angemeldet) {
                    oeffneBox(con, e, e.zuletzt, jetzt, z);
                    e.lueckeSeit = e.zuletzt;
                    e.ersteNach = null;
                    faellig = jetzt.plus(NACHSCHAU);
                }
            } else if (angemeldet) {
                faellig = LueckenRegeln.boxFaelligAb(e.zuletzt);
            }
        } else if (e.ersteNach != null) {
            schliesseBox(con, e, e.lueckeSeit, e.ersteNach, jetzt, z);
            e.lueckeSeit = null;
            e.ersteNach = null;
            faellig = angemeldet ? LueckenRegeln.boxFaelligAb(e.zuletzt) : null;
        } else {
            // Die Box schweigt weiter — aber eine Quelle, deren Zuständigkeit inzwischen endete
            // (Box-Tausch), hat ihre Lücke genau dort zu Ende.
            for (Zustaendigkeit q : quellenAm(con, e, e.lueckeSeit)) {
                if (q.ende() != null && !q.ende().isAfter(jetzt)) {
                    schliesseQuelle(con, e, q, e.lueckeSeit, q.ende(), jetzt, z);
                }
            }
            faellig = jetzt.plus(NACHSCHAU);
        }
        if (e.nachVon != null) {
            if (LueckenRegeln.nachlieferungRuht(e.nachBis, jetzt)) {
                meldeNachlieferung(con, e, jetzt, z);
                e.gemeldetBis = spaeter(e.gemeldetBis, e.nachBis);
                e.nachVon = null;
                e.nachBis = null;
            } else {
                faellig = frueher(faellig, LueckenRegeln.nachlieferungFaelligAb(e.nachBis));
            }
        }
        e.faellig = faellig;
    }

    private record Zustaendigkeit(UUID dataSourceId, Instant ende) {}

    private boolean boxAngemeldet(Connection con, Einheit e) throws SQLException {
        try (PreparedStatement ps = con.prepareStatement(
                "SELECT status, site_id FROM device WHERE id = ? AND tenant_id = ?")) {
            ps.setObject(1, e.device);
            ps.setObject(2, e.tenant);
            try (ResultSet rs = ps.executeQuery()) {
                if (!rs.next()) {
                    return false;
                }
                if (e.site == null) {
                    e.site = rs.getObject("site_id", UUID.class);
                }
                return "claimed".equals(rs.getString("status"));
            }
        }
    }

    /** Die Datenquellen, für die die Box zum Zeitpunkt {@code t} zuständig war. */
    private List<Zustaendigkeit> quellenAm(Connection con, Einheit e, Instant t) throws SQLException {
        List<Zustaendigkeit> aus = new ArrayList<>();
        try (PreparedStatement ps = con.prepareStatement("""
                SELECT data_source_id, effective_to
                  FROM data_source_assignment
                 WHERE tenant_id = ? AND device_id = ? AND effective_from <= ?
                   AND (effective_to IS NULL OR effective_to > ?)
                 ORDER BY data_source_id
                """)) {
            ps.setObject(1, e.tenant);
            ps.setObject(2, e.device);
            ps.setTimestamp(3, Timestamp.from(t));
            ps.setTimestamp(4, Timestamp.from(t));
            try (ResultSet rs = ps.executeQuery()) {
                while (rs.next()) {
                    aus.add(new Zustaendigkeit(rs.getObject(1, UUID.class), zeit(rs, "effective_to")));
                }
            }
        }
        return aus;
    }

    private void oeffneBox(Connection con, Einheit e, Instant von, Instant jetzt, Zaehler z)
            throws SQLException {
        ObjectNode box = JSON.createObjectNode();
        box.put("ereignis_id", LueckenRegeln.boxKennung(e.tenant, e.device, von).toString());
        box.put("art", "data_gap");
        box.put("von", uhr(von));
        box.putNull("bis");
        box.put("box", e.device.toString());
        box.put("erkannt_aus", "herzschlag");
        box.put("fehlerklasse", LueckenRegeln.BOX_MELDET_SICH_NICHT);
        if (melden(con, e.tenant, e.site, box, jetzt, z)) {
            z.geoeffnet++;
        }
        for (Zustaendigkeit q : quellenAm(con, e, von)) {
            ObjectNode quelle = box.deepCopy();
            quelle.put("ereignis_id",
                    LueckenRegeln.quelleKennung(e.tenant, e.device, q.dataSourceId(), von).toString());
            quelle.put("datenquelle", q.dataSourceId().toString());
            if (melden(con, e.tenant, e.site, quelle, jetzt, z)) {
                z.geoeffnet++;
            }
        }
    }

    private void schliesseBox(Connection con, Einheit e, Instant von, Instant rueckkehr,
            Instant jetzt, Zaehler z) throws SQLException {
        JsonNode alt = juengsteMeldung(con, e.tenant, LueckenRegeln.boxKennung(e.tenant, e.device, von));
        if (alt != null && alt.path("bis").isNull()) {
            ObjectNode neu = ((ObjectNode) alt).deepCopy();
            neu.put("bis", uhr(LueckenRegeln.lueckeEnde(von, rueckkehr)));
            Instant nach = nachgeliefertAmBox(con, e, von, rueckkehr);
            if (nach != null) {
                neu.put("nachgeliefert_am", uhr(nach));
            }
            if (melden(con, e.tenant, e.site, neu, jetzt, z)) {
                z.geschlossen++;
            }
        }
        for (Zustaendigkeit q : quellenAm(con, e, von)) {
            Instant bis = q.ende() != null && q.ende().isBefore(rueckkehr) ? q.ende() : rueckkehr;
            schliesseQuelle(con, e, q, von, bis, jetzt, z);
        }
    }

    private void schliesseQuelle(Connection con, Einheit e, Zustaendigkeit q, Instant von,
            Instant bis, Instant jetzt, Zaehler z) throws SQLException {
        JsonNode alt = juengsteMeldung(con, e.tenant,
                LueckenRegeln.quelleKennung(e.tenant, e.device, q.dataSourceId(), von));
        if (alt == null || !alt.path("bis").isNull()) {
            return;
        }
        ObjectNode neu = ((ObjectNode) alt).deepCopy();
        neu.put("bis", uhr(LueckenRegeln.lueckeEnde(von, bis)));
        Instant nach = nachgeliefertAmQuelle(con, e, q.dataSourceId(), von, bis);
        if (nach != null) {
            neu.put("nachgeliefert_am", uhr(nach));
        }
        if (melden(con, e.tenant, e.site, neu, jetzt, z)) {
            z.geschlossen++;
        }
    }

    /** Der erste nachgelieferte Eingang eines Box-Zeitraums — Messwerte UND Kern-Telemetrie. */
    private Instant nachgeliefertAmBox(Connection con, Einheit e, Instant von, Instant bis)
            throws SQLException {
        try (PreparedStatement ps = con.prepareStatement("""
                SELECT min(x) FROM (
                    SELECT min(s.received_at) AS x FROM device_measurement_sample s
                     WHERE s.tenant_id = ? AND s.device_id = ? AND s.time >= ? AND s.time < ?
                       AND s.delivery = 'nachgeliefert'
                    UNION ALL
                    SELECT min(t.received_at) FROM telemetry t
                     WHERE t.device_id = ? AND t.time >= ? AND t.time < ?
                       AND t.received_at > t.time + make_interval(secs => ?)) u
                """)) {
            ps.setObject(1, e.tenant);
            ps.setObject(2, e.device);
            ps.setTimestamp(3, Timestamp.from(von));
            ps.setTimestamp(4, Timestamp.from(bis));
            ps.setObject(5, e.device);
            ps.setTimestamp(6, Timestamp.from(von));
            ps.setTimestamp(7, Timestamp.from(bis));
            ps.setLong(8, ZustandAbleitung.TOLERANZ_MINDESTENS_S);
            return eineZeit(ps);
        }
    }

    /** Der erste nachgelieferte Eingang einer Datenquelle dieser Box im Zeitraum. */
    private Instant nachgeliefertAmQuelle(Connection con, Einheit e, UUID dataSourceId, Instant von,
            Instant bis) throws SQLException {
        try (PreparedStatement ps = con.prepareStatement("""
                SELECT min(s.received_at)
                  FROM device_measurement_sample s
                  JOIN measurement_point mp ON mp.id = s.entity_id AND mp.tenant_id = s.tenant_id
                 WHERE s.tenant_id = ? AND s.device_id = ? AND mp.data_source_id = ?
                   AND s.time >= ? AND s.time < ? AND s.delivery = 'nachgeliefert' AND %s
                """.formatted(SPUR))) {
            ps.setObject(1, e.tenant);
            ps.setObject(2, e.device);
            ps.setObject(3, dataSourceId);
            ps.setTimestamp(4, Timestamp.from(von));
            ps.setTimestamp(5, Timestamp.from(bis));
            return eineZeit(ps);
        }
    }

    /**
     * Meldet die zur Ruhe gekommene Nachlieferung dieser Box: EIN {@code backfill} je Datenquelle
     * (Messzeit des ersten und letzten nachgelieferten Werts, Eingangszeiten, Anzahl) — und trägt
     * {@code nachgeliefert_am} an ihren geschlossenen Herzschlag-Lücken nach, die die Werte beim
     * Schließen noch nicht hatten.
     */
    private void meldeNachlieferung(Connection con, Einheit e, Instant jetzt, Zaehler z)
            throws SQLException {
        record Welle(UUID quelle, Instant von, Instant bis, Instant eingangVon, Instant eingangBis,
                long anzahl) {}
        List<Welle> wellen = new ArrayList<>();
        long ohneQuelle = 0;
        try (PreparedStatement ps = con.prepareStatement("""
                SELECT mp.data_source_id, min(s.time), max(s.time), min(s.received_at),
                       max(s.received_at), count(*)
                  FROM device_measurement_sample s
                  LEFT JOIN measurement_point mp ON mp.id = s.entity_id AND mp.tenant_id = s.tenant_id
                 WHERE s.received_at >= ? AND s.received_at <= ? AND s.tenant_id = ?
                   AND s.device_id = ? AND s.delivery = 'nachgeliefert' AND %s
                   AND s.received_at > COALESCE(?, '-infinity'::timestamptz)
                 GROUP BY mp.data_source_id
                """.formatted(SPUR))) {
            ps.setTimestamp(1, Timestamp.from(e.nachVon));
            ps.setTimestamp(2, Timestamp.from(e.nachBis));
            ps.setObject(3, e.tenant);
            ps.setObject(4, e.device);
            ps.setTimestamp(5, ts(e.gemeldetBis));
            try (ResultSet rs = ps.executeQuery()) {
                while (rs.next()) {
                    UUID quelle = rs.getObject(1, UUID.class);
                    if (quelle == null) {
                        ohneQuelle += rs.getLong(6);
                        continue;
                    }
                    wellen.add(new Welle(quelle, rs.getTimestamp(2).toInstant(),
                            rs.getTimestamp(3).toInstant(), rs.getTimestamp(4).toInstant(),
                            rs.getTimestamp(5).toInstant(), rs.getLong(6)));
                }
            }
        }
        if (ohneQuelle > 0) {
            // Der Vertrag kennt eine Nachlieferung nur je Box UND Quelle — ohne Datenquelle an der
            // Komponente gibt es keine Meldung, aber eine Spur im Log.
            log.info("UEMS Lücken-Melder: {} nachgelieferte Werte der Box {} ohne Datenquelle — "
                    + "kein backfill", ohneQuelle, e.device);
        }
        for (Welle w : wellen) {
            ObjectNode b = JSON.createObjectNode();
            b.put("ereignis_id",
                    LueckenRegeln.backfillKennung(e.tenant, e.device, w.quelle(), w.eingangVon()).toString());
            b.put("art", "backfill");
            b.put("von", uhr(w.von()));
            b.put("bis", LueckenRegeln.sekundeAuf(w.bis()).toString());
            b.put("box", e.device.toString());
            b.put("datenquelle", w.quelle().toString());
            b.put("eingang_von", uhr(w.eingangVon()));
            b.put("eingang_bis", LueckenRegeln.sekundeAuf(w.eingangBis()).toString());
            b.put("anzahl", w.anzahl());
            Long erwartet = erwartetAusReihenluecken(con, e, w.quelle(), w.eingangVon(), w.eingangBis(),
                    w.anzahl());
            if (erwartet != null) {
                b.put("erwartet", erwartet);
            }
            if (melden(con, e.tenant, e.site, b, jetzt, z)) {
                z.backfill++;
            }
        }
        // `nachgeliefert_am` an den schon geschlossenen Herzschlag-Lücken dieser Box.
        for (JsonNode alt : geschlosseneOhneNachlieferung(con, e.tenant, "device_id", e.device, null,
                "herzschlag", jetzt)) {
            Instant von = Instant.parse(alt.get("von").asText());
            Instant bis = Instant.parse(alt.get("bis").asText());
            Instant nach = alt.has("datenquelle")
                    ? nachgeliefertAmQuelle(con, e, UUID.fromString(alt.get("datenquelle").asText()), von, bis)
                    : nachgeliefertAmBox(con, e, von, bis);
            if (nach != null) {
                ObjectNode neu = ((ObjectNode) alt).deepCopy();
                neu.put("nachgeliefert_am", uhr(nach));
                if (melden(con, e.tenant, e.site, neu, jetzt, z)) {
                    z.nachgeliefert++;
                }
            }
        }
    }

    /**
     * Wie viele Werte die Nachlieferung einer Quelle erwarten ließ — NUR, wenn die Kadenz-Lücken
     * ihrer Reihen es zählen: jede Reihe mit nachgelieferten Werten braucht eine geschlossene
     * Lücke mit {@code erwartet_fehlend}, die ihre Messzeiten umfasst. Sonst bleibt das Feld weg
     * — geschätzt wird nie.
     */
    private Long erwartetAusReihenluecken(Connection con, Einheit e, UUID quelle, Instant eingangVon,
            Instant eingangBis, long anzahl) throws SQLException {
        record Reihe(UUID entity, String kanal, Instant von, Instant bis) {}
        List<Reihe> reihen = new ArrayList<>();
        try (PreparedStatement ps = con.prepareStatement("""
                SELECT s.entity_id, s.point_key, min(s.time), max(s.time)
                  FROM device_measurement_sample s
                  JOIN measurement_point mp ON mp.id = s.entity_id AND mp.tenant_id = s.tenant_id
                 WHERE s.received_at >= ? AND s.received_at <= ? AND s.tenant_id = ?
                   AND s.device_id = ? AND mp.data_source_id = ? AND s.delivery = 'nachgeliefert' AND %s
                 GROUP BY s.entity_id, s.point_key
                """.formatted(SPUR))) {
            ps.setTimestamp(1, Timestamp.from(eingangVon));
            ps.setTimestamp(2, Timestamp.from(eingangBis));
            ps.setObject(3, e.tenant);
            ps.setObject(4, e.device);
            ps.setObject(5, quelle);
            try (ResultSet rs = ps.executeQuery()) {
                while (rs.next()) {
                    reihen.add(new Reihe(rs.getObject(1, UUID.class), rs.getString(2),
                            rs.getTimestamp(3).toInstant(), rs.getTimestamp(4).toInstant()));
                }
            }
        }
        long summe = 0;
        for (Reihe r : reihen) {
            Long gezaehlt = null;
            for (JsonNode l : juengsteLueckenDerReihe(con, e.tenant, r.entity(), r.kanal(), r.von())) {
                if (l.path("bis").isNull() || !l.has("erwartet_fehlend")) {
                    continue;
                }
                Instant von = Instant.parse(l.get("von").asText());
                Instant bis = Instant.parse(l.get("bis").asText());
                if (!von.isAfter(r.von()) && bis.isAfter(r.bis())) {
                    gezaehlt = l.get("erwartet_fehlend").asLong();
                    break;
                }
            }
            if (gezaehlt == null) {
                return null;
            }
            summe += gezaehlt;
        }
        return summe >= anzahl && summe > 0 ? summe : null;
    }

    // ------------------------------------------------------------------ Reihe

    private void pruefeReihe(Connection con, Einheit e, Instant jetzt, Zaehler z)
            throws SQLException {
        Zeitleiste kadenz = zeitleiste(con, e);
        Instant faellig = null;
        if (e.lueckeSeit != null) {
            Instant von = e.lueckeSeit;
            int k = e.lueckeKadenzS;
            Instant rueckkehr = ersterRechtzeitigerWert(con, e, von);
            Instant bis = rueckkehr;
            Auswahl auswahl = auswahl(con, e);
            if (!auswahl.an() && auswahl.aus() != null && auswahl.aus().isAfter(von)
                    && (bis == null || auswahl.aus().isBefore(bis))) {
                // Abgewählt: ab dort wird kein Wert mehr erwartet — die Lücke endet dort.
                bis = auswahl.aus();
            }
            if (bis != null) {
                schliesseReihe(con, e, von, bis, k, jetzt, z);
                e.lueckeSeit = null;
                e.lueckeKadenzS = null;
                e.geprueftBis = spaeter(e.geprueftBis, bis);
            } else {
                faellig = jetzt.plus(NACHSCHAU);
            }
        }
        if (e.lueckeSeit == null) {
            Wert letzter = letzterGuterWert(con, e);
            if (letzter != null) {
                if (e.geprueftBis == null) {
                    // Der erste Blick auf die Reihe: Löcher werden ab hier gesucht, nicht rückwirkend.
                    e.geprueftBis = letzter.zeit();
                } else if (letzter.zeit().isAfter(e.geprueftBis)) {
                    if (lochsuche(con, e, kadenz, jetzt, z)) {
                        faellig = jetzt; // mehr Werte als eine Suche liest — gleich weiter
                    }
                }
                int k = kadenz.am(letzter.zeit());
                if (auswahl(con, e).an()) {
                    if (LueckenRegeln.reiheOffen(letzter.zeit(), k, jetzt)) {
                        oeffneReihe(con, e, letzter, k, jetzt, z);
                        e.lueckeSeit = LueckenRegeln.lueckeBeginn(letzter.zeit(), k);
                        e.lueckeKadenzS = k;
                        e.geprueftBis = spaeter(e.geprueftBis, letzter.zeit());
                        faellig = jetzt.plus(NACHSCHAU);
                    } else if (faellig == null) {
                        faellig = LueckenRegeln.reiheFaelligAb(letzter.zeit(), k);
                    }
                }
            }
        }
        if (e.nachVon != null) {
            for (JsonNode alt : geschlosseneOhneNachlieferung(con, e.tenant, "entity_id", e.entity,
                    e.kanal, "kadenz", jetzt)) {
                Instant von = Instant.parse(alt.get("von").asText());
                Instant bis = Instant.parse(alt.get("bis").asText());
                Instant nach = nachgeliefertAmReihe(con, e, von, bis);
                if (nach != null) {
                    ObjectNode neu = ((ObjectNode) alt).deepCopy();
                    neu.put("nachgeliefert_am", uhr(nach));
                    if (melden(con, e.tenant, e.site, neu, jetzt, z)) {
                        z.nachgeliefert++;
                    }
                }
            }
            e.nachVon = null;
            e.nachBis = null;
        }
        e.faellig = faellig;
    }

    private record Wert(Instant zeit, UUID device, UUID site) {}

    private record Auswahl(boolean an, Instant aus) {}

    /**
     * Die Kadenz einer Reihe über die Zeit: die Fassungen ihrer Quellenbindungen (bei mehreren
     * zugleich die schnellste, wie der Draht), dahinter Auswahl und Katalog — die Kette von
     * {@link KadenzRegeln#wirksam}, einmal geladen, je Zeitpunkt gefragt.
     */
    record Zeitleiste(List<KadenzRegeln.Fassung> fassungen, Integer auswahlS, Integer katalogS) {

        int am(Instant t) {
            Integer schnellste = null;
            for (KadenzRegeln.Fassung f : fassungen) {
                if (!f.gueltigAb().isAfter(t) && (f.gueltigBis() == null || t.isBefore(f.gueltigBis()))
                        && KadenzRegeln.imRahmen(f.erwartetS())
                        && (schnellste == null || f.erwartetS() < schnellste)) {
                    schnellste = f.erwartetS();
                }
            }
            return KadenzRegeln.wirksam(schnellste, auswahlS, katalogS).erwartetS();
        }
    }

    private Zeitleiste zeitleiste(Connection con, Einheit e) throws SQLException {
        List<KadenzRegeln.Fassung> fassungen = new ArrayList<>();
        try (PreparedStatement ps = con.prepareStatement("""
                SELECT k.id::text, k.erwartet_s,
                       GREATEST(q.gueltig_ab, k.gueltig_ab) AS ab,
                       CASE WHEN q.gueltig_bis IS NULL AND k.gueltig_bis IS NULL THEN NULL
                            ELSE LEAST(COALESCE(q.gueltig_bis, k.gueltig_bis),
                                       COALESCE(k.gueltig_bis, q.gueltig_bis)) END AS bis
                  FROM messstelle_quelle q
                  JOIN quelle_kadenz k ON k.messstelle_quelle_id = q.id AND k.tenant_id = q.tenant_id
                 WHERE q.tenant_id = ? AND q.entity_id = ? AND q.kanal = ?
                """)) {
            ps.setObject(1, e.tenant);
            ps.setObject(2, e.entity);
            ps.setString(3, e.kanal);
            try (ResultSet rs = ps.executeQuery()) {
                while (rs.next()) {
                    fassungen.add(new KadenzRegeln.Fassung(rs.getString(1), rs.getInt(2),
                            zeit(rs, "ab"), zeit(rs, "bis")));
                }
            }
        }
        Integer auswahl = null;
        // Die Auswahl einer ausgebauten Box (AP-07 IP-11) zählt nur, wenn keine andere den Kanal liest.
        try (PreparedStatement ps = con.prepareStatement("SELECT COALESCE(min(s.cadence_s) FILTER "
                + "(WHERE d.ausgebaut_am IS NULL), min(s.cadence_s)) FROM device_measurement_selection s "
                + "LEFT JOIN device d ON d.id = s.device_id "
                + "WHERE s.tenant_id = ? AND s.entity_id = ? AND s.point_key = ?")) {
            ps.setObject(1, e.tenant);
            ps.setObject(2, e.entity);
            ps.setString(3, e.kanal);
            try (ResultSet rs = ps.executeQuery()) {
                if (rs.next()) {
                    int a = rs.getInt(1);
                    auswahl = rs.wasNull() ? null : a;
                }
            }
        }
        MeasurementCatalog.Point p = katalog.resolve(e.kanal);
        return new Zeitleiste(fassungen, auswahl, p == null ? null : p.defaultCadenceS());
    }

    /**
     * Wird die Reihe gerade erwartet? Eine eingeschaltete Mess-Auswahl einer Box, die nicht
     * ausgebaut ist — sonst, seit wann nicht: die eingeschaltete Auswahl einer ausgebauten Box
     * endet mit ihrem Ausbau (AP-07 IP-11), sie ist keine Erwartung mehr.
     */
    private Auswahl auswahl(Connection con, Einheit e) throws SQLException {
        try (PreparedStatement ps = con.prepareStatement("""
                SELECT COALESCE(bool_or(s.enabled AND d.ausgebaut_am IS NULL), false),
                       max(CASE WHEN s.enabled AND d.ausgebaut_am IS NOT NULL THEN d.ausgebaut_am
                                ELSE s.disabled_at END)
                  FROM device_measurement_selection s
                  LEFT JOIN device d ON d.id = s.device_id
                 WHERE s.tenant_id = ? AND s.point_key = ?
                   AND (s.entity_id = ? OR (s.entity_id IS NULL AND s.device_id = ?))
                """)) {
            ps.setObject(1, e.tenant);
            ps.setString(2, e.kanal);
            ps.setObject(3, e.entity);
            ps.setObject(4, e.device);
            try (ResultSet rs = ps.executeQuery()) {
                rs.next();
                return new Auswahl(rs.getBoolean(1), zeit(rs, 2));
            }
        }
    }

    private Wert letzterGuterWert(Connection con, Einheit e) throws SQLException {
        try (PreparedStatement ps = con.prepareStatement("""
                SELECT s.time, s.device_id, s.site_id
                  FROM device_measurement_sample s
                 WHERE s.tenant_id = ? AND s.entity_id = ? AND s.point_key = ? AND %s
                   AND s.quality = 'good'
                 ORDER BY s.time DESC
                 LIMIT 1
                """.formatted(SPUR))) {
            ps.setObject(1, e.tenant);
            ps.setObject(2, e.entity);
            ps.setString(3, e.kanal);
            try (ResultSet rs = ps.executeQuery()) {
                return rs.next() ? new Wert(rs.getTimestamp(1).toInstant(),
                        rs.getObject(2, UUID.class), rs.getObject(3, UUID.class)) : null;
            }
        }
    }

    /**
     * Die Rückkehr einer Reihe: der erste gute Wert NACH {@code von}, der RECHTZEITIG einging (die
     * Zustellart des Writers). Ein nachgelieferter Wert füllt die Lücke, schließt sie aber nicht —
     * er setzt {@code nachgeliefert_am}.
     */
    private Instant ersterRechtzeitigerWert(Connection con, Einheit e, Instant von) throws SQLException {
        try (PreparedStatement ps = con.prepareStatement("""
                SELECT min(s.time)
                  FROM device_measurement_sample s
                 WHERE s.tenant_id = ? AND s.entity_id = ? AND s.point_key = ? AND %s
                   AND s.quality = 'good' AND s.time > ?
                   AND s.delivery IS DISTINCT FROM 'nachgeliefert'
                """.formatted(SPUR))) {
            ps.setObject(1, e.tenant);
            ps.setObject(2, e.entity);
            ps.setString(3, e.kanal);
            ps.setTimestamp(4, Timestamp.from(von));
            return eineZeit(ps);
        }
    }

    private Instant nachgeliefertAmReihe(Connection con, Einheit e, Instant von, Instant bis)
            throws SQLException {
        try (PreparedStatement ps = con.prepareStatement("""
                SELECT min(s.received_at)
                  FROM device_measurement_sample s
                 WHERE s.tenant_id = ? AND s.entity_id = ? AND s.point_key = ? AND %s
                   AND s.quality = 'good' AND s.time >= ? AND s.time < ?
                   AND s.delivery = 'nachgeliefert'
                """.formatted(SPUR))) {
            ps.setObject(1, e.tenant);
            ps.setObject(2, e.entity);
            ps.setString(3, e.kanal);
            ps.setTimestamp(4, Timestamp.from(von));
            ps.setTimestamp(5, Timestamp.from(bis));
            return eineZeit(ps);
        }
    }

    /**
     * Sucht Löcher zwischen den guten Werten ab {@code geprueft_bis} — ein Loch, das zwischen zwei
     * Takten entstand und schon wieder zu ist, wird als GESCHLOSSENE Lücke gemeldet (ohne
     * Nachlieferung: zwischen zwei aufeinanderfolgenden Werten liegt keiner). Gelesen wird nur,
     * was vor der Sicherheit eingegangen ist. Gibt {@code true} zurück, wenn es mehr Werte gab,
     * als eine Suche liest.
     */
    private boolean lochsuche(Connection con, Einheit e, Zeitleiste kadenz, Instant jetzt, Zaehler z)
            throws SQLException {
        record Punkt(Instant zeit, UUID device, UUID site) {}
        List<Punkt> werte = new ArrayList<>();
        try (PreparedStatement ps = con.prepareStatement("""
                SELECT s.time, s.device_id, s.site_id
                  FROM device_measurement_sample s
                 WHERE s.tenant_id = ? AND s.entity_id = ? AND s.point_key = ? AND %s
                   AND s.quality = 'good' AND s.time >= ? AND s.received_at <= ?
                 ORDER BY s.time
                 LIMIT ?
                """.formatted(SPUR))) {
            ps.setObject(1, e.tenant);
            ps.setObject(2, e.entity);
            ps.setString(3, e.kanal);
            ps.setTimestamp(4, Timestamp.from(e.geprueftBis));
            ps.setTimestamp(5, Timestamp.from(jetzt.minus(SICHERHEIT)));
            ps.setInt(6, werteJeLochsuche + 1);
            try (ResultSet rs = ps.executeQuery()) {
                while (rs.next()) {
                    werte.add(new Punkt(rs.getTimestamp(1).toInstant(), rs.getObject(2, UUID.class),
                            rs.getObject(3, UUID.class)));
                }
            }
        }
        boolean mehr = werte.size() > werteJeLochsuche;
        if (mehr) {
            werte = werte.subList(0, werteJeLochsuche);
        }
        for (int i = 0; i + 1 < werte.size(); i++) {
            Punkt a = werte.get(i);
            Punkt b = werte.get(i + 1);
            int k = kadenz.am(a.zeit());
            if (LueckenRegeln.loch(a.zeit(), b.zeit(), k)) {
                Instant von = LueckenRegeln.lueckeBeginn(a.zeit(), k);
                ObjectNode l = reihenMeldung(con, e, new Wert(a.zeit(), a.device(), a.site()), von);
                l.put("bis", uhr(LueckenRegeln.lueckeEnde(von, b.zeit())));
                l.put("erwartet_fehlend", LueckenRegeln.erwartetFehlend(von, b.zeit(), k));
                zuwachs(con, e, von, b.zeit(), k, l);
                if (melden(con, e.tenant, a.site() != null ? a.site() : e.site, l, jetzt, z)) {
                    z.geschlossen++;
                }
            }
        }
        if (!werte.isEmpty()) {
            e.geprueftBis = spaeter(e.geprueftBis, werte.get(werte.size() - 1).zeit());
        }
        return mehr;
    }

    private void oeffneReihe(Connection con, Einheit e, Wert letzter, int k, Instant jetzt, Zaehler z)
            throws SQLException {
        Instant von = LueckenRegeln.lueckeBeginn(letzter.zeit(), k);
        ObjectNode l = reihenMeldung(con, e, letzter, von);
        l.putNull("bis");
        if (melden(con, e.tenant, letzter.site() != null ? letzter.site() : e.site, l, jetzt, z)) {
            z.geoeffnet++;
        }
    }

    private void schliesseReihe(Connection con, Einheit e, Instant von, Instant bis, int k,
            Instant jetzt, Zaehler z) throws SQLException {
        JsonNode alt = juengsteMeldung(con, e.tenant,
                LueckenRegeln.reiheKennung(e.tenant, e.entity, e.kanal, von));
        if (alt == null || !alt.path("bis").isNull()) {
            return;
        }
        ObjectNode neu = ((ObjectNode) alt).deepCopy();
        neu.put("bis", uhr(LueckenRegeln.lueckeEnde(von, bis)));
        neu.put("erwartet_fehlend", LueckenRegeln.erwartetFehlend(von, bis, k));
        zuwachs(con, e, von, bis, k, neu);
        Instant nach = nachgeliefertAmReihe(con, e, von, bis);
        if (nach != null) {
            neu.put("nachgeliefert_am", uhr(nach));
        }
        if (melden(con, e.tenant, e.site, neu, jetzt, z)) {
            z.geschlossen++;
        }
    }

    /** Ein guter Wert am Rand einer Lücke: Messzeit, Zahl und die Wertart, mit der er gespeichert ist. */
    private record Stand(Instant zeit, BigDecimal wert, String wertart) {}

    /**
     * AP-08 IP-6 — der gemessene Zuwachs über eine GESCHLOSSENE Reihen-Lücke als Nutzlast
     * ({@code zuwachs}, {@code einheit}, {@code stand_vor}, {@code stand_nach}). Der Zähler hat
     * weitergezählt, während die Werte fehlten: die Differenz der Stände ist gemessen, aber auf keine
     * Viertelstunde verteilbar.
     *
     * <p>Gerechnet wird hier nichts: ob die beiden Nachbarn eine Lücke mit Zuwachs sind (Loch über
     * {@code 2 × Kadenz}, nicht fallend, keine Gerätegrenze dazwischen), entscheidet
     * {@link VerbrauchRegeln#lueckenZuwachs}; in welcher Periode er zählt, {@link VerbrauchRegeln#zaehltZu}.
     * Die Felder bleiben WEG — nie geraten —, wenn die Reihe kein Zählerstand ist, ihr Messkanal keine
     * Einheit aus {@link EreignisVokabular#EINHEITEN_ZUWACHS} hat, oder der direkte Nachbar des Stands
     * davor nicht der Wert ist, der die Lücke schließt (dann liegt schon ein nachgelieferter Wert IN
     * der Lücke, oder sie endete durch Abwählen ohne Stand). Eine Nachlieferung, die erst NACH dem
     * Schließen kommt, ändert die Meldung nicht (append-only): sie trägt dann zusätzlich
     * {@code nachgeliefert_am}, und was danach noch Lücke ist, sagt das Kennzeichen der Periode.
     */
    private void zuwachs(Connection con, Einheit e, Instant von, Instant rueckkehr, int kadenzS, ObjectNode l)
            throws SQLException {
        MeasurementCatalog.Point p = katalog.resolve(e.kanal);
        String einheit = p == null ? null : p.unit();
        if (einheit == null || !EreignisVokabular.EINHEITEN_ZUWACHS.contains(einheit)) {
            return;
        }
        Stand vor = stand(con, e, "s.time < ? ORDER BY s.time DESC", von);
        Stand nach = vor == null ? null : stand(con, e, "s.time > ? ORDER BY s.time", vor.zeit());
        if (nach == null || !nach.zeit().equals(rueckkehr) || !zaehlerstand(vor) || !zaehlerstand(nach)) {
            return;
        }
        List<VerbrauchRegeln.Ereignis> grenzen = new ArrayList<>();
        try (PreparedStatement ps = con.prepareStatement("""
                SELECT e.zeit FROM messreihe_ereignis e
                 WHERE e.tenant_id = ? AND e.entity_id = ? AND (e.messkanal IS NULL OR e.messkanal = ?)
                   AND e.art = 'device_boundary' AND e.zeit > ? AND e.zeit <= ?
                """)) {
            ps.setObject(1, e.tenant);
            ps.setObject(2, e.entity);
            ps.setString(3, e.kanal);
            ps.setTimestamp(4, Timestamp.from(vor.zeit()));
            ps.setTimestamp(5, Timestamp.from(nach.zeit()));
            try (ResultSet rs = ps.executeQuery()) {
                while (rs.next()) {
                    grenzen.add(new VerbrauchRegeln.Ereignis(VerbrauchRegeln.Ereignis.GERAETEGRENZE,
                            rs.getTimestamp(1).toInstant(), null, null, null, 0));
                }
            }
        }
        VerbrauchRegeln.LueckenZuwachs z = VerbrauchRegeln.lueckenZuwachs(
                new VerbrauchRegeln.Rohwert(vor.zeit(), vor.wert()),
                new VerbrauchRegeln.Rohwert(nach.zeit(), nach.wert()),
                grenzen, Duration.ofSeconds(kadenzS), ViertelstundeRegeln.FAKTOR_DER_FASSUNG);
        if (z == null) {
            return;
        }
        l.put("zuwachs", z.zuwachs());
        l.put("einheit", einheit);
        l.put("stand_vor", z.standVor());
        l.put("stand_nach", z.standNach());
    }

    /** Der erste gute Wert der Reihe nach {@code bedingung} (Richtung und Grenze), sonst {@code null}. */
    private Stand stand(Connection con, Einheit e, String bedingung, Instant t) throws SQLException {
        try (PreparedStatement ps = con.prepareStatement("""
                SELECT s.time, coalesce(s.decoded_numeric, s.raw_numeric),
                       coalesce(s.value_kind, s.aggregation_kind)
                  FROM device_measurement_sample s
                 WHERE s.tenant_id = ? AND s.entity_id = ? AND s.point_key = ? AND %s
                   AND s.quality = 'good' AND %s
                 LIMIT 1
                """.formatted(SPUR, bedingung))) {
            ps.setObject(1, e.tenant);
            ps.setObject(2, e.entity);
            ps.setString(3, e.kanal);
            ps.setTimestamp(4, Timestamp.from(t));
            try (ResultSet rs = ps.executeQuery()) {
                if (!rs.next()) {
                    return null;
                }
                double zahl = rs.getDouble(2);
                return rs.wasNull() ? null
                        : new Stand(rs.getTimestamp(1).toInstant(), BigDecimal.valueOf(zahl), rs.getString(3));
            }
        }
    }

    private static boolean zaehlerstand(Stand s) {
        return "zaehlerstand".equals(ViertelstundeRegeln.regelWort(s.wertart()));
    }

    /**
     * Der Bezug einer Reihen-Lücke: die Box, die den letzten guten Wert lieferte, die Datenquelle
     * der Komponente, Komponente + Messkanal und die Messstelle, die den Messkanal zu {@code von}
     * las (führend vor Vergleich). Beim Schließen wird dieser Bezug nie neu nachgeschlagen, sondern
     * aus der gespeicherten Meldung übernommen — eine Fortschreibung ändert keinen Bezug.
     */
    private ObjectNode reihenMeldung(Connection con, Einheit e, Wert w, Instant von)
            throws SQLException {
        ObjectNode l = JSON.createObjectNode();
        l.put("ereignis_id", LueckenRegeln.reiheKennung(e.tenant, e.entity, e.kanal, von).toString());
        l.put("art", "data_gap");
        l.put("von", uhr(von));
        l.put("box", (w.device() != null ? w.device() : e.device).toString());
        UUID quelle = null;
        try (PreparedStatement ps = con.prepareStatement(
                "SELECT data_source_id FROM measurement_point WHERE id = ? AND tenant_id = ?")) {
            ps.setObject(1, e.entity);
            ps.setObject(2, e.tenant);
            try (ResultSet rs = ps.executeQuery()) {
                if (rs.next()) {
                    quelle = rs.getObject(1, UUID.class);
                }
            }
        }
        if (quelle != null) {
            l.put("datenquelle", quelle.toString());
        }
        l.put("komponente", e.entity.toString());
        l.put("messkanal", e.kanal);
        try (PreparedStatement ps = con.prepareStatement("""
                SELECT messstelle_id FROM messstelle_quelle
                 WHERE tenant_id = ? AND entity_id = ? AND kanal = ? AND gueltig_ab <= ?
                   AND (gueltig_bis IS NULL OR gueltig_bis > ?)
                 ORDER BY (rolle = 'fuehrend') DESC, gueltig_ab, id
                 LIMIT 1
                """)) {
            ps.setObject(1, e.tenant);
            ps.setObject(2, e.entity);
            ps.setString(3, e.kanal);
            ps.setTimestamp(4, Timestamp.from(von));
            ps.setTimestamp(5, Timestamp.from(von));
            try (ResultSet rs = ps.executeQuery()) {
                if (rs.next()) {
                    l.put("messstelle", rs.getObject(1, UUID.class).toString());
                }
            }
        }
        l.put("erkannt_aus", "kadenz");
        return l;
    }

    // ============================================================= Die Meldungen

    private static final List<String> KENNUNGEN = List.of("box", "datenquelle", "komponente", "messstelle");
    private static final List<String> KEIN_NUTZFELD = List.of("ereignis_id", "art", "von", "bis",
            "zeitpunkt", "messkanal");

    private static final String SPALTEN = "ereignis_id, art, von, bis, kennungen::text AS kennungen, "
            + "messkanal, nutzlast::text AS nutzlast";

    /** Die Reihenfolge, in der die JÜNGSTE Meldung eines Ereignisses gewinnt. */
    private static final String JUENGSTE_ZUERST = "eingang DESC, (bis IS NULL), "
            + "jsonb_exists(nutzlast, 'nachgeliefert_am') DESC, jsonb_exists(nutzlast, 'erwartet_fehlend') DESC";

    /**
     * Hängt EINE Meldung an — nach dem Vertrag geprüft, gegen die jüngste Meldung derselben
     * Kennung: gleich → nichts (Wiederholung), sonst nur als zulässige Fortschreibung. Ein Urteil
     * gegen die EIGENE Meldung ist ein Fehler im Code: laut protokolliert, gezählt, nie
     * geschrieben.
     */
    private boolean melden(Connection con, UUID tenant, UUID site, ObjectNode e, Instant jetzt,
            Zaehler z) throws SQLException {
        Urteil urteil = EreignisVokabular.pruefe(e, Urheber.CLOUD);
        if (!urteil.angenommen()) {
            z.verworfen++;
            log.error("UEMS Lücken-Melder: eigene Meldung vom Vokabular verworfen ({} {}): {}",
                    urteil.grund(), urteil.hinweis(), e);
            return false;
        }
        UUID ereignisId = UUID.fromString(e.get("ereignis_id").asText());
        JsonNode juengste = juengsteMeldung(con, tenant, ereignisId);
        if (juengste != null) {
            if (EreignisVokabular.gleich(juengste, e)) {
                return false;
            }
            Urteil fort = EreignisVokabular.pruefeFortschreibung(juengste, e, Urheber.CLOUD);
            if (!fort.angenommen()) {
                z.verworfen++;
                log.error("UEMS Lücken-Melder: Fortschreibung verworfen ({} {}): {} → {}",
                        fort.grund(), fort.hinweis(), juengste, e);
                return false;
            }
        }
        Instant von = Instant.parse(e.get("von").asText());
        Instant bis = e.hasNonNull("bis") ? Instant.parse(e.get("bis").asText()) : null;
        ObjectNode kennungen = JSON.createObjectNode();
        ObjectNode nutzlast = JSON.createObjectNode();
        e.fields().forEachRemaining(f -> {
            if (KENNUNGEN.contains(f.getKey())) {
                kennungen.set(f.getKey(), f.getValue());
            } else if (!KEIN_NUTZFELD.contains(f.getKey())) {
                nutzlast.set(f.getKey(), f.getValue());
            }
        });
        try (PreparedStatement ps = con.prepareStatement("""
                INSERT INTO messreihe_ereignis (zeit, tenant_id, ereignis_id, art, urheber, von, bis,
                       site_id, kennungen, device_id, data_source_id, entity_id, messkanal,
                       messstelle_id, nutzlast, eingang)
                VALUES (?, ?, ?, ?, 'cloud', ?, ?, ?, ?::jsonb, ?, ?, ?, ?, ?, ?::jsonb, ?)
                ON CONFLICT DO NOTHING
                """)) {
            ps.setTimestamp(1, Timestamp.from(von));
            ps.setObject(2, tenant);
            ps.setObject(3, ereignisId);
            ps.setString(4, e.get("art").asText());
            ps.setTimestamp(5, Timestamp.from(von));
            ps.setTimestamp(6, ts(bis));
            ps.setObject(7, site);
            ps.setString(8, kennungen.toString());
            ps.setObject(9, uuidFeld(e, "box"));
            ps.setObject(10, uuidFeld(e, "datenquelle"));
            ps.setObject(11, uuidFeld(e, "komponente"));
            ps.setString(12, e.path("messkanal").asText(null));
            ps.setObject(13, uuidFeld(e, "messstelle"));
            ps.setString(14, nutzlast.toString());
            ps.setTimestamp(15, Timestamp.from(jetzt));
            return ps.executeUpdate() > 0;
        }
    }

    private JsonNode juengsteMeldung(Connection con, UUID tenant, UUID ereignisId) throws SQLException {
        try (PreparedStatement ps = con.prepareStatement("SELECT " + SPALTEN
                + " FROM messreihe_ereignis WHERE tenant_id = ? AND ereignis_id = ? AND NOT aus_bestand "
                + "AND urheber = 'cloud' ORDER BY " + JUENGSTE_ZUERST + " LIMIT 1")) {
            ps.setObject(1, tenant);
            ps.setObject(2, ereignisId);
            try (ResultSet rs = ps.executeQuery()) {
                return rs.next() ? meldung(rs) : null;
            }
        }
    }

    /**
     * Die geschlossenen Lücken OHNE {@code nachgeliefert_am} eines Bezugs (Box oder Reihe) aus der
     * Rohdaten-Frist — je Ereignis die jüngste Meldung.
     */
    private List<JsonNode> geschlosseneOhneNachlieferung(Connection con, UUID tenant, String spalte,
            UUID id, String kanal, String erkanntAus, Instant jetzt) throws SQLException {
        List<JsonNode> aus = new ArrayList<>();
        String sql = "SELECT * FROM (SELECT DISTINCT ON (ereignis_id) " + SPALTEN
                + " FROM messreihe_ereignis WHERE tenant_id = ? AND " + spalte + " = ? "
                + (kanal != null ? "AND messkanal = ? " : "")
                + "AND art = 'data_gap' AND urheber = 'cloud' AND NOT aus_bestand AND zeit >= ? "
                + "AND nutzlast ->> 'erkannt_aus' = ? "
                + "ORDER BY ereignis_id, " + JUENGSTE_ZUERST + ") j "
                + "WHERE j.bis IS NOT NULL AND NOT jsonb_exists(j.nutzlast::jsonb, 'nachgeliefert_am')";
        try (PreparedStatement ps = con.prepareStatement(sql)) {
            int p = 1;
            ps.setObject(p++, tenant);
            ps.setObject(p++, id);
            if (kanal != null) {
                ps.setString(p++, kanal);
            }
            ps.setTimestamp(p++, Timestamp.from(jetzt.minus(ROHDATEN_FRIST)));
            ps.setString(p, erkanntAus);
            try (ResultSet rs = ps.executeQuery()) {
                while (rs.next()) {
                    aus.add(meldung(rs));
                }
            }
        }
        return aus;
    }

    /** Die Kadenz-Lücken einer Reihe, deren Zeitraum bis {@code bis} begonnen hat — je Ereignis die jüngste. */
    private List<JsonNode> juengsteLueckenDerReihe(Connection con, UUID tenant, UUID entity,
            String kanal, Instant ab) throws SQLException {
        List<JsonNode> aus = new ArrayList<>();
        try (PreparedStatement ps = con.prepareStatement("SELECT DISTINCT ON (ereignis_id) " + SPALTEN
                + " FROM messreihe_ereignis WHERE tenant_id = ? AND entity_id = ? AND messkanal = ? "
                + "AND art = 'data_gap' AND urheber = 'cloud' AND NOT aus_bestand AND zeit <= ? "
                + "AND zeit >= ? AND nutzlast ->> 'erkannt_aus' = 'kadenz' "
                + "ORDER BY ereignis_id, " + JUENGSTE_ZUERST)) {
            ps.setObject(1, tenant);
            ps.setObject(2, entity);
            ps.setString(3, kanal);
            ps.setTimestamp(4, Timestamp.from(ab));
            ps.setTimestamp(5, Timestamp.from(ab.minus(ROHDATEN_FRIST)));
            try (ResultSet rs = ps.executeQuery()) {
                while (rs.next()) {
                    aus.add(meldung(rs));
                }
            }
        }
        return aus;
    }

    /** Eine gespeicherte Zeile zurück in die Form des Vertrags (wie {@code MessreiheEreignisRepository}). */
    private static JsonNode meldung(ResultSet rs) throws SQLException {
        ObjectNode e = JSON.createObjectNode();
        e.put("ereignis_id", rs.getObject("ereignis_id", UUID.class).toString());
        e.put("art", rs.getString("art"));
        e.put("von", rs.getTimestamp("von").toInstant().toString());
        Timestamp bis = rs.getTimestamp("bis");
        if (bis == null) {
            e.putNull("bis");
        } else {
            e.put("bis", bis.toInstant().toString());
        }
        try {
            e.setAll((ObjectNode) JSON.readTree(rs.getString("kennungen")));
            if (rs.getString("messkanal") != null) {
                e.put("messkanal", rs.getString("messkanal"));
            }
            e.setAll((ObjectNode) JSON.readTree(rs.getString("nutzlast")));
        } catch (JsonProcessingException ex) {
            throw new SQLException("messreihe_ereignis: JSON nicht lesbar", ex);
        }
        return e;
    }

    // ================================================================== Kleinkram

    @FunctionalInterface
    private interface Zug<T> {
        T fahren(Connection con) throws SQLException;
    }

    /** EINE Transaktion je Zug: entnehmen, melden und den Stand schreiben gehören zusammen. */
    private <T> T inTransaktion(Zug<T> zug) {
        return adminJdbc.execute((Connection con) -> {
            boolean autoCommit = con.getAutoCommit();
            con.setAutoCommit(false);
            try {
                T ergebnis = zug.fahren(con);
                con.commit();
                return ergebnis;
            } catch (Exception ex) {
                con.rollback();
                throw ex instanceof SQLException sql ? sql
                        : new SQLException("UEMS Lücken-Melder fehlgeschlagen", ex);
            } finally {
                con.setAutoCommit(autoCommit);
            }
        });
    }

    private static Instant eineZeit(PreparedStatement ps) throws SQLException {
        try (ResultSet rs = ps.executeQuery()) {
            return rs.next() ? zeit(rs, 1) : null;
        }
    }

    private static Instant zeit(ResultSet rs, String spalte) throws SQLException {
        Timestamp t = rs.getTimestamp(spalte);
        return t == null ? null : t.toInstant();
    }

    private static Instant zeit(ResultSet rs, int spalte) throws SQLException {
        Timestamp t = rs.getTimestamp(spalte);
        return t == null ? null : t.toInstant();
    }

    private static Timestamp ts(Instant t) {
        return t == null ? null : Timestamp.from(t);
    }

    /** Die Zeit in der Form des Vertrags — ganze Sekunden, abgerundet. */
    private static String uhr(Instant t) {
        return LueckenRegeln.sekunde(t).toString();
    }

    private static UUID uuidFeld(JsonNode e, String feld) {
        return e.hasNonNull(feld) ? UUID.fromString(e.get(feld).asText()) : null;
    }

    private static Instant spaeter(Instant a, Instant b) {
        return a == null ? b : b == null || a.isAfter(b) ? a : b;
    }

    private static Instant frueher(Instant a, Instant b) {
        return a == null ? b : b == null || a.isBefore(b) ? a : b;
    }
}
