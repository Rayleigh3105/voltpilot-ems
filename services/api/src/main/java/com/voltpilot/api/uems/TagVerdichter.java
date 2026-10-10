package com.voltpilot.api.uems;

import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.voltpilot.api.kundenbereich.BeendeteKundenbereiche;
import com.voltpilot.api.measurement.MeasurementCatalog;
import java.math.BigDecimal;
import java.sql.Connection;
import java.sql.Date;
import java.sql.PreparedStatement;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.sql.Timestamp;
import java.sql.Types;
import java.time.Duration;
import java.time.Instant;
import java.time.LocalDate;
import java.time.ZoneId;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.beans.factory.annotation.Qualifier;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Component;

/**
 * Der TAGESLAUF (UEMS AP-07 IP-13): aus den Viertelstundenwerten eines Ortstages wird eine Zeile
 * in {@code messreihe_tag}.
 *
 * <p><b>Die Tagesgrenze liegt in der ZEITZONE DES STANDORTS</b> (W10) und die Zeitzone wird in der
 * Zeile GESPEICHERT — samt ihrer Herkunft (Standort · Unternehmen · Vorgabe), damit ein Bericht in
 * zehn Jahren dieselbe Grenze reproduziert (A8) und die Zone nicht nur behauptet ist. Wie lang
 * der Tag ist, RECHNET dieser Lauf nicht: {@link TagRegeln#stunden} bestellt die Zahl bei der
 * Verbrauchsregel von AP-08. Am 25.10.2026 sind es 25 Stunden (100 Viertelstunden), am 28.03.2027
 * 23 (92).
 *
 * <p><b>Die Menge (AP-08 IP-5)</b> kommt aus den PERIODENSTÄNDEN des Tages, nie als Summe der
 * Viertelstunden: {@link VerbrauchRegeln#zaehlerstandAusTeilperioden} über die gespeicherten
 * Viertelstunden samt ihren Nachbarn an den Tagesgrenzen ({@link ViertelstundenTeile}). Die
 * Stände {@code stand_anfang}/{@code stand_ende} sind die an den TAGESGRENZEN (NULL, wo dort nicht
 * gemessen wurde), die Abdeckung zählt eine Viertelstunde ohne Zeile mit ihrer Erwartung. Eine
 * Summe trägt die Zeile nie. Ein geschriebener Tag trägt seinen Monat in die Arbeitsliste von
 * {@link PeriodeVerdichter} ein — in derselben Transaktion.
 *
 * <p><b>Vorläufig und endgültig gelten hier wie eine Stufe tiefer</b> ({@link TagRegeln#zustand}):
 * ein Tag, dessen Viertelstunden noch vorläufig sind, ist selbst vorläufig — und er wird erst
 * endgültig, wenn zusätzlich seine eigene Frist (Tagesende + 7 Tage) abgelaufen ist. Der Zusatz
 * ist nötig, weil eine fehlende Viertelstunde gar keine Zeile hat (IP-12): erst nach der Frist
 * kann keine mehr entstehen.
 *
 * <p><b>Wiederholbar und abbruchsicher</b>, nach dem Muster von {@link ViertelstundeVerdichter}:
 * eine durable Arbeitsliste, deren Entnahme und deren Schreiben in EINER Transaktion liegen;
 * {@code ON CONFLICT … DO UPDATE … WHERE} lässt eine endgültige Zeile und eine unveränderte in
 * Ruhe. Drei Quellen füllen die Liste — die neu gebildeten Viertelstunden (über einen Zeiger auf
 * {@code berechnet_am}), der Frist-Durchgang (Tage, die vorläufig sind und deren Frist abgelaufen
 * ist) und die einmalige Rückrechnung der Vergangenheit in Tagesscheiben.
 */
@Component
public class TagVerdichter {

    private static final Logger log = LoggerFactory.getLogger(TagVerdichter.class);

    private static final ObjectMapper JSON = new ObjectMapper();

    /** Wie bei IP-12: Rohwerte der letzten zwei Minuten gelten noch nicht als „gesehen". */
    static final Duration SICHERHEIT = Duration.ofMinutes(2);

    /** Und dieselbe Spanne wird beim nächsten Lauf noch einmal gelesen — Eintragen ist idempotent. */
    static final Duration UEBERLAPP = Duration.ofMinutes(2);

    /**
     * Die Rückrechnung geht so weit zurück, wie der Verdichtungs-Lauf Viertelstunden bilden kann
     * — und der baut aus Rohwerten, die 90 Tage leben. Ein Tag mehr, damit der angeschnittene
     * Rand mitkommt.
     */
    static final Duration RUECKRECHNUNG_TIEFE = Duration.ofDays(91);

    /** Und sie geht in Tagesscheiben — die Einheit, in der sie unterbrechbar ist. */
    static final Duration RUECKRECHNUNG_SCHEIBE = Duration.ofDays(1);

    /**
     * Derselbe Riegel wie in IP-12 für den Zeiger-Durchgang: der Verdichtungs-Lauf baut nur aus
     * Rohwerten, also liegt jede neu gebildete Viertelstunde in diesem Fenster. Ohne ihn müsste
     * die Abfrage jeden Chunk der zehn Jahre anfassen.
     */
    static final Duration ZEIGER_TIEFE = Duration.ofDays(91);

    private static final String ZEIGER = "zeiger";
    private static final String RUECKRECHNUNG = "rueckrechnung";
    private static final String FERTIG = "fertig";

    private static final ZoneId UTC = ZoneId.of("UTC");

    /** Die Spalten der Tagesklasse, in der Reihenfolge, in der der Lauf sie setzt. */
    private static final String[] SPALTEN = {
        "tag", "tenant_id", "entity_id", "messkanal", "site_id",
        "zeitzone", "zeitzone_herkunft", "beginn", "ende", "stunden",
        "slots_erwartet", "slots_vorhanden", "slots_endgueltig",
        "wertart", "stand_anfang", "stand_anfang_zeit", "stand_ende", "stand_ende_zeit",
        "mittel", "min_wert", "max_wert",
        "erster_wert", "erster_text", "erster_zeit", "letzter_wert", "letzter_text", "letzter_zeit",
        "erhalten", "erwartet", "abdeckung_prozent",
        "n_good", "n_uncertain", "n_invalid", "n_stale", "n_device_error",
        "geraet_einbau", "geraet_einbau_2", "geraet_einbau_weitere",
        "box", "box_2", "box_weitere", "fassung", "katalog", "rolle",
        "zustand", "endgueltig_ab", "berechnet_am", "version",
        "n_nachgeliefert", "letzte_eingangszeit", "zustellart", "ereignisse",
        "menge", "menge_zustand", "kennzeichen", "kadenz_s",
        "summe", "energie", "gemessen_s", "luecke_innen",
        "menge_positiv", "menge_negativ"};

    private static final Set<String> JSONB_SPALTEN = Set.of("ereignisse", "kennzeichen");

    private static final List<String> SCHLUESSEL =
            List.of("tenant_id", "entity_id", "messkanal", "tag");

    /** Der Schlüssel ist die Zeile, und die `version` gehört den Korrekturen von AP-08. */
    private static final Set<String> NICHT_UEBERNOMMEN =
            Set.of("tag", "tenant_id", "entity_id", "messkanal", "version");

    private final JdbcTemplate adminJdbc;
    private final MeasurementCatalog katalog;
    private final int stapelGroesse;
    private final int stapelJeLauf;
    private final int fristJeLauf;
    private final int arbeitHochwasser;

    /** Beendete Kundenbereiche lässt der Läufer aus (AP-20, E10 = A); ohne Spring gilt KEINE. */
    private BeendeteKundenbereiche beendete = BeendeteKundenbereiche.KEINE;

    @Autowired(required = false)
    void setBeendeteKundenbereiche(BeendeteKundenbereiche beendete) {
        this.beendete = beendete;
    }

    public TagVerdichter(
            @Qualifier("adminJdbcTemplate") JdbcTemplate adminJdbc,
            MeasurementCatalog katalog,
            @Value("${voltpilot.uems.tag.stapel:200}") int stapelGroesse,
            @Value("${voltpilot.uems.tag.stapel-je-lauf:40}") int stapelJeLauf,
            @Value("${voltpilot.uems.tag.frist-je-lauf:20000}") int fristJeLauf,
            @Value("${voltpilot.uems.tag.arbeit-hochwasser:200000}") int arbeitHochwasser) {
        this.adminJdbc = adminJdbc;
        this.katalog = katalog;
        this.stapelGroesse = stapelGroesse;
        this.stapelJeLauf = stapelJeLauf;
        this.fristJeLauf = fristJeLauf;
        this.arbeitHochwasser = arbeitHochwasser;
    }

    // ===================================================================== Eingang

    /** Was ein Lauf tat — für das Log und die Tests. */
    public record Lauf(int ausViertelstunden, int ausFrist, int ausRueckrechnung,
            boolean rueckrechnungFertig, int gebildet, int geschrieben) {}

    /** Ein ganzer Takt: eintragen (drei Quellen) → bilden, bis die Arbeitsliste leer ist. */
    public Lauf lauf(Instant jetzt) {
        int ausVs = eintragenAusViertelstunden(jetzt);
        int ausFrist = eintragenAusFrist(jetzt);
        Scheibe s = rueckrechnenEineScheibe(jetzt);
        int gebildet = 0;
        int geschrieben = 0;
        for (int i = 0; i < stapelJeLauf; i++) {
            int[] r = bildeEinenStapel(jetzt);
            if (r[0] == 0) {
                break;
            }
            gebildet += r[0];
            geschrieben += r[1];
        }
        Lauf l = new Lauf(ausVs, ausFrist, s.eingetragen(), s.fertig(), gebildet, geschrieben);
        if (ausVs > 0 || ausFrist > 0 || s.eingetragen() > 0 || gebildet > 0) {
            log.info("UEMS Tageslauf: {} aus Viertelstunden, {} aus der Frist, {} aus der "
                    + "Rückrechnung ({}), {} gebildet, {} geschrieben",
                    ausVs, ausFrist, s.eingetragen(), s.fertig() ? "fertig" : "läuft",
                    gebildet, geschrieben);
        }
        return l;
    }

    // ------------------------------------------------------- Quelle 1: die Viertelstunden
    // Alle drei Quellen lesen nur REIHEN (`entity_id IS NOT NULL`): eine Zeile der Spur `berechnet`
    // (AP-10 IP-10) bildet ihr eigener Lauf aus den Tageswerten ihrer Eingänge, nie aus Viertelstunden.

    /**
     * Trägt den UTC-Tag jeder Viertelstunde ein, die seit dem Zeiger neu GEBILDET wurde — und
     * schiebt den Zeiger in DERSELBEN Transaktion nach.
     *
     * <p>Der erste Lauf überhaupt setzt den Zeiger nur auf „jetzt": die Vergangenheit gehört der
     * Rückrechnung, sonst läse der erste Takt nach einem Deploy 90 Tage auf einmal.
     */
    int eintragenAusViertelstunden(Instant jetzt) {
        return inTransaktion(con -> {
            Stand stand = standLesenUndSperren(con, ZEIGER);
            Instant bis = jetzt.minus(SICHERHEIT);
            if (stand.zeitpunkt() == null) {
                standSetzen(con, ZEIGER, bis, 0, null);
                return 0;
            }
            Instant von = stand.zeitpunkt().minus(UEBERLAPP);
            if (!bis.isAfter(von)) {
                return 0;
            }
            if (arbeitZaehlen(con) >= arbeitHochwasser) {
                return 0;
            }
            int n;
            try (PreparedStatement ps = con.prepareStatement("""
                    INSERT INTO messreihe_tag_arbeit
                           (tenant_id, entity_id, messkanal, utc_tag, grund)
                    SELECT DISTINCT v.tenant_id, v.entity_id, v.messkanal,
                           (v.intervall_beginn AT TIME ZONE 'UTC')::date, 'viertelstunde'
                      FROM messreihe_viertelstunde v
                     WHERE v.berechnet_am > ? AND v.berechnet_am <= ?
                       AND v.intervall_beginn >= ?
                       AND v.entity_id IS NOT NULL
                    ON CONFLICT DO NOTHING
                    """)) {
                ps.setTimestamp(1, Timestamp.from(von));
                ps.setTimestamp(2, Timestamp.from(bis));
                ps.setTimestamp(3, Timestamp.from(jetzt.minus(ZEIGER_TIEFE)));
                n = ps.executeUpdate();
            }
            // AP-08 IP-4: ein Bruch, der SEIT DEM ZEIGER eingegangen ist, bildet seinen Tag neu — auch
            // wenn keine Viertelstunde sich ändert (F4/F5: die Gerätegrenze liegt in der Lücke
            // 10:39–10:47 und wirkt erst über die Viertelstundengrenze, also erst im Tag).
            try (PreparedStatement ps = con.prepareStatement("""
                    INSERT INTO messreihe_tag_arbeit
                           (tenant_id, entity_id, messkanal, utc_tag, grund)
                    SELECT DISTINCT tenant_id, entity_id, messkanal, (beginn AT TIME ZONE 'UTC')::date, 'ereignis'
                      FROM (""" + BruchEreignisse.VIERTELSTUNDEN + """
                           ) betroffen
                    ON CONFLICT DO NOTHING
                    """)) {
                ps.setTimestamp(1, Timestamp.from(von));
                ps.setTimestamp(2, Timestamp.from(bis));
                ps.setTimestamp(3, Timestamp.from(jetzt.minus(ZEIGER_TIEFE)));
                n += ps.executeUpdate();
            }
            standSetzen(con, ZEIGER, bis, n, null);
            return n;
        });
    }

    // ------------------------------------------------------------ Quelle 2: die Frist

    /**
     * Trägt jeden Tag ein, der noch {@code vorlaeufig} ist, dessen Frist aber abgelaufen ist.
     *
     * <p>Das ist der Durchgang, der einen Tag ENDGÜLTIG macht: der Stundenlauf schaltet die
     * Viertelstunden um, ohne {@code berechnet_am} anzufassen (die Zahlen der Zeile haben sich
     * nicht geändert) — Quelle 1 sieht davon also nichts. Dieser Durchgang holt es nach, und zwar
     * genau einmal je Tag: sobald die Zeile endgültig ist, findet er sie nicht mehr.
     */
    int eintragenAusFrist(Instant jetzt) {
        return inTransaktion(con -> {
            if (arbeitZaehlen(con) >= arbeitHochwasser) {
                return 0;
            }
            try (PreparedStatement ps = con.prepareStatement("""
                    INSERT INTO messreihe_tag_arbeit
                           (tenant_id, entity_id, messkanal, utc_tag, grund)
                    SELECT t.tenant_id, t.entity_id, t.messkanal,
                           (t.beginn AT TIME ZONE 'UTC')::date, 'frist'
                      FROM messreihe_tag t
                     WHERE t.zustand = 'vorlaeufig'
                       AND t.endgueltig_ab <= ?
                       AND t.tag <= ?
                       AND t.entity_id IS NOT NULL
                       AND NOT (t.tenant_id = ANY (?::uuid[]))
                     ORDER BY t.tag
                     LIMIT ?
                    ON CONFLICT DO NOTHING
                    """)) {
                ps.setTimestamp(1, Timestamp.from(jetzt));
                // Grobe, sichere Obergrenze auf der Partitionierungs-Spalte (Chunk-Ausschluss):
                // ein Tag, dessen Frist abgelaufen ist, liegt mindestens sieben Tage zurück.
                ps.setObject(2, LocalDate.ofInstant(jetzt.minus(TagRegeln.FRIST), UTC));
                ps.setObject(3, beendete.sqlFeld()); // Kundenbereich beendet: der Tag bleibt vorläufig
                ps.setInt(4, fristJeLauf);
                return ps.executeUpdate();
            }
        });
    }

    // ---------------------------------------------------- Quelle 3: die Rückrechnung

    /** Was eine Scheibe der Rückrechnung tat. */
    record Scheibe(boolean gefahren, int eingetragen, boolean fertig) {}

    /**
     * Eine Tagesscheibe der einmaligen Rückrechnung — dieselbe Form wie in IP-12: sie geht
     * rückwärts, sie ist jederzeit unterbrechbar, und eine Unterbrechung kostet höchstens die
     * angefangene Scheibe.
     */
    Scheibe rueckrechnenEineScheibe(Instant jetzt) {
        return inTransaktion(con -> {
            Stand stand = standLesenUndSperren(con, RUECKRECHNUNG);
            if (FERTIG.equals(stand.notiz())) {
                return new Scheibe(false, 0, true);
            }
            if (arbeitZaehlen(con) >= arbeitHochwasser) {
                return new Scheibe(false, 0, false);
            }
            Instant boden = jetzt.minus(RUECKRECHNUNG_TIEFE);
            Instant bis = stand.zeitpunkt() == null
                    ? jetzt.plus(RUECKRECHNUNG_SCHEIBE)
                    : stand.zeitpunkt();
            Instant von = bis.minus(RUECKRECHNUNG_SCHEIBE);
            boolean fertig = !von.isAfter(boden);
            int n;
            try (PreparedStatement ps = con.prepareStatement("""
                    INSERT INTO messreihe_tag_arbeit
                           (tenant_id, entity_id, messkanal, utc_tag, grund)
                    SELECT DISTINCT v.tenant_id, v.entity_id, v.messkanal,
                           (v.intervall_beginn AT TIME ZONE 'UTC')::date, 'rueckrechnung'
                      FROM messreihe_viertelstunde v
                     WHERE v.intervall_beginn >= ? AND v.intervall_beginn < ?
                       AND v.entity_id IS NOT NULL
                    ON CONFLICT DO NOTHING
                    """)) {
                ps.setTimestamp(1, Timestamp.from(von));
                ps.setTimestamp(2, Timestamp.from(bis));
                n = ps.executeUpdate();
            }
            standSetzen(con, RUECKRECHNUNG, von, n, fertig ? FERTIG : null);
            return new Scheibe(true, n, fertig);
        });
    }

    /** Fährt die Rückrechnung zu Ende — die Tür für Tests und für einen Betriebs-Anstoß. */
    public int rueckrechnenGanz(Instant jetzt, int hoechstensScheiben) {
        int gesamt = 0;
        for (int i = 0; i < hoechstensScheiben; i++) {
            Scheibe s = rueckrechnenEineScheibe(jetzt);
            gesamt += s.eingetragen();
            if (!s.gefahren() || s.fertig()) {
                break;
            }
        }
        return gesamt;
    }

    // ==================================================================== Das Bilden

    /** Ein Eintrag der Arbeitsliste: genau eine Reihe und genau ein UTC-Tag. */
    record Auftrag(UUID tenant, UUID entity, String kanal, LocalDate utcTag) {}

    /** Ein Ortstag, wie ihn der Lauf bildet — mit seiner Zone und deren Herkunft. */
    record Ortstag(UUID tenant, UUID entity, String kanal, LocalDate tag, ZoneId zone,
            String zoneName, String zoneHerkunft, UUID siteId) {}

    /**
     * Entnimmt EINEN Stapel und schreibt seine Tage in derselben Transaktion.
     *
     * @return {@code [entnommene Einträge, wirklich geschriebene Zeilen]}
     */
    int[] bildeEinenStapel(Instant jetzt) {
        return inTransaktion(con -> {
            List<Auftrag> stapel = entnehmen(con, stapelGroesse);
            if (stapel.isEmpty()) {
                return new int[] {0, 0};
            }
            List<Ortstag> tage = ortstage(con, stapel);
            int geschrieben = bilden(con, tage, jetzt);
            return new int[] {stapel.size(), geschrieben};
        });
    }

    private List<Auftrag> entnehmen(Connection con, int limit) throws SQLException {
        List<Auftrag> aus = new ArrayList<>();
        try (PreparedStatement ps = con.prepareStatement("""
                DELETE FROM messreihe_tag_arbeit a
                 USING (SELECT tenant_id, entity_id, messkanal, utc_tag
                          FROM messreihe_tag_arbeit
                         WHERE NOT (tenant_id = ANY (?::uuid[]))
                         ORDER BY utc_tag, eingetragen_am
                         LIMIT ?
                         FOR UPDATE SKIP LOCKED) c
                 WHERE a.tenant_id = c.tenant_id AND a.entity_id = c.entity_id
                   AND a.messkanal = c.messkanal AND a.utc_tag = c.utc_tag
                RETURNING a.tenant_id, a.entity_id, a.messkanal, a.utc_tag
                """)) {
            ps.setObject(1, beendete.sqlFeld()); // Kundenbereich beendet: der Auftrag bleibt liegen
            ps.setInt(2, limit);
            try (ResultSet rs = ps.executeQuery()) {
                while (rs.next()) {
                    aus.add(new Auftrag(rs.getObject(1, UUID.class), rs.getObject(2, UUID.class),
                            rs.getString(3), rs.getDate(4).toLocalDate()));
                }
            }
        }
        return aus;
    }

    private int arbeitZaehlen(Connection con) throws SQLException {
        try (PreparedStatement ps = con.prepareStatement(
                "SELECT count(*) FROM messreihe_tag_arbeit");
                ResultSet rs = ps.executeQuery()) {
            rs.next();
            return rs.getInt(1);
        }
    }

    // --------------------------------------------------------------- Die Zeitzone

    /**
     * Die ORTSTAGE eines Stapels: je Auftrag die Zeitzone nachschlagen und den UTC-Tag darin auf
     * seine ein oder zwei Kalendertage abbilden.
     *
     * <p>Die Kette ist STANDORT → UNTERNEHMEN → VORGABE, und welches Glied geliefert hat, reist
     * als {@code zeitzone_herkunft} mit — dieselbe Form wie die Kadenz-Kette (IP-10). Der Standort
     * wird ZUM TAG nachgeschlagen (die Zuordnung Anlage→Standort ist zeitgültig, AP-02); heute
     * tragen alle drei zugelassenen Zonen denselben Versatz, die Wahl kann die Tagesgrenze also
     * nicht verschieben — gespeichert wird sie trotzdem.
     */
    private List<Ortstag> ortstage(Connection con, List<Auftrag> stapel) throws SQLException {
        Map<Integer, ReihenKontext.Zeitzone> zonen = ReihenKontext.zeitzonen(con, stapel.stream()
                .map(a -> new ReihenKontext.Frage(a.tenant(), a.entity(), a.utcTag()))
                .toList());
        Set<Ortstag> aus = new LinkedHashSet<>();
        for (int i = 0; i < stapel.size(); i++) {
            Auftrag a = stapel.get(i);
            ReihenKontext.Zeitzone z = zonen.get(i);
            ZoneId zone = z.zone();
            for (LocalDate tag : TagRegeln.ortstageEinesUtcTages(a.utcTag(), zone)) {
                aus.add(new Ortstag(a.tenant(), a.entity(), a.kanal(), tag, zone, z.name(), z.herkunft(),
                        z.siteId()));
            }
        }
        return List.copyOf(aus);
    }

    // ------------------------------------------------------------- Die Viertelstunden

    /** Eine Viertelstunde, wie der Tageslauf sie sieht. */
    private record Slot(Instant beginn, String zustand, String wertart, UUID siteId,
            BigDecimal standAnfang, Instant standAnfangZeit, BigDecimal standEnde,
            Instant standEndeZeit, BigDecimal mittel, BigDecimal minWert, BigDecimal maxWert,
            BigDecimal ersterWert, String ersterText, Instant ersterZeit,
            BigDecimal letzterWert, String letzterText, Instant letzterZeit,
            int erhalten, int erwartet, int nGood, int nUncertain, int nInvalid, int nStale,
            int nDeviceError, UUID einbau, UUID einbau2, UUID box, UUID box2,
            Long fassung, String katalog, String rolle, int nNachgeliefert,
            Instant letzteEingangszeit, String zustellart, String ereignisse) {}

    private static final String SLOT_SPALTEN =
            "m.intervall_beginn, m.zustand, m.wertart, m.site_id, m.stand_anfang, "
            + "m.stand_anfang_zeit, m.stand_ende, m.stand_ende_zeit, m.mittel, m.min_wert, "
            + "m.max_wert, m.erster_wert, m.erster_text, m.erster_zeit, m.letzter_wert, "
            + "m.letzter_text, m.letzter_zeit, m.erhalten, m.erwartet, m.n_good, m.n_uncertain, "
            + "m.n_invalid, m.n_stale, m.n_device_error, m.geraet_einbau, m.geraet_einbau_2, "
            + "m.box, m.box_2, m.fassung, m.katalog, m.rolle, m.n_nachgeliefert, "
            + "m.letzte_eingangszeit, m.zustellart, m.ereignisse";

    private Map<Integer, List<Slot>> slots(Connection con, List<Ortstag> tage) throws SQLException {
        Map<Integer, List<Slot>> aus = new LinkedHashMap<>();
        StringBuilder werte = new StringBuilder();
        for (int i = 0; i < tage.size(); i++) {
            werte.append(i == 0 ? "" : ", ").append(i == 0
                    ? "(?::int, ?::uuid, ?::uuid, ?::text, ?::timestamptz, ?::timestamptz)"
                    : "(?, ?, ?, ?, ?, ?)");
        }
        try (PreparedStatement ps = con.prepareStatement(
                "SELECT v.i, " + SLOT_SPALTEN
                + " FROM (VALUES " + werte + ") AS v(i, tenant_id, entity_id, messkanal, von, bis)"
                + " JOIN messreihe_viertelstunde m"
                + "   ON m.tenant_id = v.tenant_id AND m.entity_id = v.entity_id"
                + "  AND m.messkanal = v.messkanal"
                + "  AND m.intervall_beginn >= v.von AND m.intervall_beginn < v.bis"
                + " ORDER BY v.i, m.intervall_beginn")) {
            int p = 1;
            for (int i = 0; i < tage.size(); i++) {
                Ortstag t = tage.get(i);
                ps.setInt(p++, i);
                ps.setObject(p++, t.tenant(), Types.OTHER);
                ps.setObject(p++, t.entity(), Types.OTHER);
                ps.setString(p++, t.kanal());
                ps.setTimestamp(p++, Timestamp.from(TagRegeln.beginn(t.tag(), t.zone())));
                ps.setTimestamp(p++, Timestamp.from(TagRegeln.ende(t.tag(), t.zone())));
            }
            try (ResultSet rs = ps.executeQuery()) {
                while (rs.next()) {
                    aus.computeIfAbsent(rs.getInt(1), k -> new ArrayList<>()).add(new Slot(
                            zeit(rs, 2), rs.getString(3), rs.getString(4),
                            rs.getObject(5, UUID.class),
                            rs.getBigDecimal(6), zeit(rs, 7), rs.getBigDecimal(8), zeit(rs, 9),
                            rs.getBigDecimal(10), rs.getBigDecimal(11), rs.getBigDecimal(12),
                            rs.getBigDecimal(13), rs.getString(14), zeit(rs, 15),
                            rs.getBigDecimal(16), rs.getString(17), zeit(rs, 18),
                            rs.getInt(19), rs.getInt(20), rs.getInt(21), rs.getInt(22),
                            rs.getInt(23), rs.getInt(24), rs.getInt(25),
                            rs.getObject(26, UUID.class), rs.getObject(27, UUID.class),
                            rs.getObject(28, UUID.class), rs.getObject(29, UUID.class),
                            (Long) rs.getObject(30), rs.getString(31), rs.getString(32),
                            rs.getInt(33), zeit(rs, 34), rs.getString(35), rs.getString(36)));
                }
            }
        }
        return aus;
    }

    private static Instant zeit(ResultSet rs, int spalte) throws SQLException {
        Timestamp t = rs.getTimestamp(spalte);
        return t == null ? null : t.toInstant();
    }

    // ------------------------------------------------------------------ Die Zeile

    private int bilden(Connection con, List<Ortstag> tage, Instant jetzt) throws SQLException {
        Map<Integer, List<Slot>> slots = slots(con, tage);
        int geschrieben = 0;
        try (PreparedStatement ps = con.prepareStatement(upsertSql());
                PreparedStatement monat = con.prepareStatement(MONAT_EINTRAGEN)) {
            for (int i = 0; i < tage.size(); i++) {
                Ortstag t = tage.get(i);
                List<Slot> s = slots.getOrDefault(i, List.of());
                if (s.isEmpty()) {
                    continue;
                }
                // AP-08 IP-5: die Viertelstunden als Teilperioden, samt ihren Nachbarn an den
                // Tagesgrenzen und den Ereignissen des Tages — die Menge bildet die Regel.
                ViertelstundenTeile.Geladen teile = ViertelstundenTeile.laden(con, t.tenant(), t.entity(),
                        t.kanal(), TagRegeln.beginn(t.tag(), t.zone()), TagRegeln.ende(t.tag(), t.zone()));
                Object[] werte = zeile(t, s, teile, jetzt);
                for (int p = 0; p < werte.length; p++) {
                    ps.setObject(p + 1, werte[p]);
                }
                int n = ps.executeUpdate();
                geschrieben += n;
                if (n > 0) {
                    // Ein geschriebener Tag macht seinen MONAT neu fällig — in DERSELBEN
                    // Transaktion, damit ein Abbruch nie einen Tag ohne Monats-Eintrag hinterlässt.
                    monat.setObject(1, t.tenant(), Types.OTHER);
                    monat.setObject(2, t.entity(), Types.OTHER);
                    monat.setString(3, t.kanal());
                    monat.setObject(4, t.tag().withDayOfMonth(1));
                    monat.executeUpdate();
                }
            }
        }
        return geschrieben;
    }

    private static final String MONAT_EINTRAGEN = "INSERT INTO messreihe_periode_arbeit "
            + "(tenant_id, entity_id, messkanal, art, tag, grund) VALUES (?, ?, ?, 'monat', ?, 'tag') "
            + "ON CONFLICT DO NOTHING";

    /**
     * Die eine Zeile aus der MENGE der Viertelstunden eines Ortstages — reihenfolge-unabhängig.
     * {@code null}, wenn der Tag keine einzige Viertelstunde hat: ein Tag ohne Werte bekommt keine
     * Zeile, so wie eine Viertelstunde ohne Rohwert keine bekommt (IP-12). Eine Lücke ist keine
     * Null.
     */
    private Object[] zeile(Ortstag t, List<Slot> slots, ViertelstundenTeile.Geladen teile, Instant jetzt) {
        Instant beginn = TagRegeln.beginn(t.tag(), t.zone());
        Instant ende = TagRegeln.ende(t.tag(), t.zone());
        int stunden = TagRegeln.stunden(t.tag(), t.zone());
        Instant endgueltigAb = TagRegeln.endgueltigAb(ende);

        int slotsEndgueltig = 0;
        int erhalten = 0;
        int erwartet = 0;
        int nGood = 0;
        int nUncertain = 0;
        int nInvalid = 0;
        int nStale = 0;
        int nDeviceError = 0;
        int nNachgeliefert = 0;
        Slot erster = null;
        Slot letzter = null;
        Slot letzterMitAnker = null;
        String wertart = null;
        UUID siteId = null;
        boolean siteEindeutig = true;
        Instant letzteEingangszeit = null;
        List<UUID> einbauten = new ArrayList<>();
        List<UUID> boxen = new ArrayList<>();
        List<String> zustellarten = new ArrayList<>();
        Map<String, Long> ereignisse = new LinkedHashMap<>();

        for (Slot s : slots) {
            if (ViertelstundeRegeln.ENDGUELTIG.equals(s.zustand())) {
                slotsEndgueltig++;
            }
            erhalten += s.erhalten();
            erwartet += s.erwartet();
            nGood += s.nGood();
            nUncertain += s.nUncertain();
            nInvalid += s.nInvalid();
            nStale += s.nStale();
            nDeviceError += s.nDeviceError();
            nNachgeliefert += s.nNachgeliefert();
            if (s.ersterZeit() != null && erster == null) {
                erster = s;
            }
            if (s.letzterZeit() != null) {
                letzter = s;
            }
            if (s.wertart() != null) {
                wertart = s.wertart();
            }
            if (s.fassung() != null || s.katalog() != null || s.rolle() != null) {
                letzterMitAnker = s;
            }
            if (s.siteId() != null) {
                if (siteId == null) {
                    siteId = s.siteId();
                } else if (!siteId.equals(s.siteId())) {
                    siteEindeutig = false;
                }
            }
            if (s.letzteEingangszeit() != null
                    && (letzteEingangszeit == null
                        || s.letzteEingangszeit().isAfter(letzteEingangszeit))) {
                letzteEingangszeit = s.letzteEingangszeit();
            }
            if (s.einbau() != null) {
                einbauten.add(s.einbau());
            }
            if (s.einbau2() != null) {
                einbauten.add(s.einbau2());
            }
            if (s.box() != null) {
                boxen.add(s.box());
            }
            if (s.box2() != null) {
                boxen.add(s.box2());
            }
            if (s.zustellart() != null) {
                zustellarten.add(s.zustellart());
            }
            zaehleEreignisse(ereignisse, s.ereignisse());
        }

        ViertelstundeRegeln.Anker<UUID> einbau = ViertelstundeRegeln.anker(einbauten);
        ViertelstundeRegeln.Anker<UUID> box = ViertelstundeRegeln.anker(boxen);
        int slotsErwartet = TagRegeln.slotsErwartet(stunden);
        int slotsVorhanden = slots.size();

        // AP-08 IP-5 — die MENGE aus den PERIODENSTÄNDEN des Tages, nie als Summe der
        // Viertelstunden: gerechnet von VerbrauchRegeln, hier nur angerufen. Für eine Reihe ohne
        // Zählerstand gibt es keine Periodenregel über Ständen (null).
        // Einheit des Messkanals und Zone des Standorts: der EINE Träger, in dem die Kennzeichen sprechen.
        ReihenKontext reihe = ReihenKontext.aus(katalog, t.kanal(), t.zone());
        VerbrauchRegeln.Teilperiode menge = ViertelstundenTeile.zaehlerstand(reihe, teile.teile(),
                teile.ereignisse(), teile.deklaration(), wertart, teile.kadenzS(), beginn, ende);
        // §4.5: Summe erhalten ÷ Summe erwartet — eine Viertelstunde OHNE Zeile zählt mit ihrer
        // Erwartung (F8: 85 %, nicht 98 %). Vor IP-5 zählten nur die vorhandenen.
        if (teile.kadenzS() != null) {
            erwartet = VerbrauchRegeln.erwartetAusTeilperioden(teile.innen(beginn, ende), beginn, ende,
                    Duration.ofSeconds(teile.kadenzS()));
        }
        // Die Abdeckung wird ABGESCHNITTEN, nie auf 100 % gerundet (§4.9 Nr. 6).
        Integer abdeckung = erwartet == 0 ? null : Math.min(100, (int) (100L * erhalten / erwartet));
        // AP-08 IP-3 — Momentanwert (und Intervallmenge) des Tages aus den Viertelstunden: Mittel aus
        // der Summe der guten Werte ÷ erhalten (nie ein Mittel von Mitteln), Vollständigkeit aus den
        // Lücken und Rändern (M3), gemessene Zeit, Energie nur gekennzeichnet — gerechnet von
        // VerbrauchRegeln, hier nur angerufen. Vor IP-3 bildete dieser Lauf das Mittel selbst aus
        // den gerundeten Viertelstunden-Mitteln.
        VerbrauchRegeln.Werteteil werteteil = ViertelstundenTeile.werte(teile.werteteile(), wertart,
                teile.kadenzS(), beginn, ende);
        VerbrauchRegeln.Ergebnis werteErgebnis = werteteil == null ? null : werteteil.teil().ergebnis();
        boolean momentan = "momentanwert".equals(ViertelstundeRegeln.regelWort(wertart));

        Map<String, Object> z = new LinkedHashMap<>();
        z.put("tag", Date.valueOf(t.tag()));
        z.put("tenant_id", t.tenant());
        z.put("entity_id", t.entity());
        z.put("messkanal", t.kanal());
        z.put("site_id", siteEindeutig ? siteId : null);
        z.put("zeitzone", t.zoneName());
        z.put("zeitzone_herkunft", t.zoneHerkunft());
        z.put("beginn", Timestamp.from(beginn));
        z.put("ende", Timestamp.from(ende));
        z.put("stunden", stunden);
        z.put("slots_erwartet", slotsErwartet);
        z.put("slots_vorhanden", slotsVorhanden);
        z.put("slots_endgueltig", slotsEndgueltig);
        z.put("wertart", wertart);
        // Z1: die Periodenstände an den TAGESGRENZEN — NULL, wo dort nicht gemessen wurde (vor
        // IP-5 stand hier der erste Stand irgendeiner Viertelstunde des Tages).
        VerbrauchRegeln.Rohwert sA = menge == null ? null : menge.standAnfang();
        VerbrauchRegeln.Rohwert sE = menge == null ? null : menge.standEnde();
        z.put("stand_anfang", sA == null ? null : sA.wert());
        z.put("stand_anfang_zeit", ts(sA == null ? null : sA.zeit()));
        z.put("stand_ende", sE == null ? null : sE.wert());
        z.put("stand_ende_zeit", ts(sE == null ? null : sE.zeit()));
        z.put("mittel", werteErgebnis == null ? null : werteErgebnis.mittel());
        z.put("min_wert", werteErgebnis == null ? null : werteErgebnis.min());
        z.put("max_wert", werteErgebnis == null ? null : werteErgebnis.max());
        z.put("erster_wert", erster == null ? null : erster.ersterWert());
        z.put("erster_text", erster == null ? null : erster.ersterText());
        z.put("erster_zeit", ts(erster == null ? null : erster.ersterZeit()));
        z.put("letzter_wert", letzter == null ? null : letzter.letzterWert());
        z.put("letzter_text", letzter == null ? null : letzter.letzterText());
        z.put("letzter_zeit", ts(letzter == null ? null : letzter.letzterZeit()));
        z.put("erhalten", erhalten);
        z.put("erwartet", erwartet);
        z.put("abdeckung_prozent", abdeckung);
        z.put("n_good", nGood);
        z.put("n_uncertain", nUncertain);
        z.put("n_invalid", nInvalid);
        z.put("n_stale", nStale);
        z.put("n_device_error", nDeviceError);
        z.put("geraet_einbau", einbau.erster());
        z.put("geraet_einbau_2", einbau.zweiter());
        z.put("geraet_einbau_weitere", einbau.weitere());
        z.put("box", box.erster());
        z.put("box_2", box.zweiter());
        z.put("box_weitere", box.weitere());
        z.put("fassung", letzterMitAnker == null ? null : letzterMitAnker.fassung());
        z.put("katalog", letzterMitAnker == null ? null : letzterMitAnker.katalog());
        z.put("rolle", letzterMitAnker == null ? null : letzterMitAnker.rolle());
        z.put("zustand", TagRegeln.zustand(slotsVorhanden, slotsEndgueltig, endgueltigAb, jetzt));
        z.put("endgueltig_ab", Timestamp.from(endgueltigAb));
        z.put("berechnet_am", Timestamp.from(jetzt));
        z.put("version", 1);
        z.put("n_nachgeliefert", nNachgeliefert);
        z.put("letzte_eingangszeit", ts(letzteEingangszeit));
        z.put("zustellart", ViertelstundeRegeln.zustellart(zustellarten));
        z.put("ereignisse", ereignisJson(ereignisse));
        // Zählerstand: aus den Periodenständen (IP-5). Momentanwert/Intervallmenge: aus der Regel
        // von IP-3 — ein Momentanwert trägt NIE eine Menge (M6), seine Energie steht in `energie`.
        VerbrauchRegeln.Ergebnis mengeErgebnis = menge != null ? menge.ergebnis() : werteErgebnis;
        z.put("menge", mengeErgebnis == null ? null : mengeErgebnis.menge());
        z.put("menge_zustand", mengeErgebnis == null ? null : mengeErgebnis.zustand());
        z.put("kennzeichen", ViertelstundeRegeln.kennzeichenJson(
                mengeErgebnis == null ? List.of() : mengeErgebnis.kennzeichen()));
        z.put("kadenz_s", teile.kadenzS());
        z.put("summe", werteteil == null ? null : werteteil.summe());
        z.put("energie", werteteil == null ? null : werteteil.energie());
        z.put("gemessen_s", momentan && werteteil != null ? (int) werteteil.gemessenS() : null);
        z.put("luecke_innen", momentan && werteteil != null ? werteteil.lueckeInnen() : null);
        // Das Richtungspaar (V20260918101000): neben der Netto-Menge die beiden Anteile, SUMMIERT
        // aus den je Rohwert gebildeten Anteilen der Viertelstunden (V20260918104000, AP-08 E15/M5).
        // Hier wird nichts gerechnet - ein Bericht schreibt ab (bericht.md EW3).
        BigDecimal[] paar = Richtungspaar.ausTeilen(teile.anteile(), beginn, ende);
        z.put("menge_positiv", paar == null ? null : paar[0]);
        z.put("menge_negativ", paar == null ? null : paar[1]);

        Object[] werte = new Object[SPALTEN.length];
        for (int i = 0; i < SPALTEN.length; i++) {
            werte[i] = z.get(SPALTEN[i]);
        }
        return werte;
    }

    private static Timestamp ts(Instant t) {
        return t == null ? null : Timestamp.from(t);
    }

    /** Die Zählung je Ereignisart summiert sich über die Viertelstunden; eine 0 steht nie da. */
    private static void zaehleEreignisse(Map<String, Long> summe, String json) {
        if (json == null || json.isBlank()) {
            return;
        }
        try {
            JsonNode n = JSON.readTree(json);
            for (String art : ViertelstundeRegeln.GEZAEHLTE_EREIGNISSE) {
                JsonNode w = n.get(art);
                if (w != null && w.isIntegralNumber() && w.asLong() > 0) {
                    summe.merge(art, w.asLong(), Long::sum);
                }
            }
        } catch (JsonProcessingException e) {
            // Die Spalte ist jsonb und trägt einen CHECK — was hier ankommt, IST ein Objekt.
            throw new IllegalStateException("unlesbare Ereignis-Zählung: " + json, e);
        }
    }

    private static String ereignisJson(Map<String, Long> summe) {
        StringBuilder b = new StringBuilder("{");
        for (String art : ViertelstundeRegeln.GEZAEHLTE_EREIGNISSE) {
            Long n = summe.get(art);
            if (n == null || n <= 0) {
                continue;
            }
            if (b.length() > 1) {
                b.append(',');
            }
            b.append('"').append(art).append("\":").append(n);
        }
        return b.append('}').toString();
    }

    // ----------------------------------------------------------------- Die Sätze

    /**
     * Der Schreibsatz. {@code ON CONFLICT … DO UPDATE … WHERE} ist die Wiederholbarkeit: eine
     * ENDGÜLTIGE Zeile wird nie angefasst, eine KORRIGIERTE ({@code version > 1}, AP-08) ebenso
     * wenig, und eine unveränderte bleibt Zeichen für Zeichen stehen — {@code berechnet_am}
     * eingeschlossen, weil der Vergleich es ausspart.
     */
    private static String upsertSql() {
        List<String> uebernommen = new ArrayList<>();
        List<String> verglichen = new ArrayList<>();
        for (String s : SPALTEN) {
            if (!NICHT_UEBERNOMMEN.contains(s)) {
                uebernommen.add(s);
                if (!"berechnet_am".equals(s)) {
                    verglichen.add(s);
                }
            }
        }
        StringBuilder platz = new StringBuilder();
        for (String s : SPALTEN) {
            platz.append(platz.length() == 0 ? "" : ", ")
                    .append(JSONB_SPALTEN.contains(s) ? "?::jsonb" : "?");
        }
        return "INSERT INTO messreihe_tag (" + String.join(", ", SPALTEN) + ") VALUES ("
                + platz + ") ON CONFLICT (" + String.join(", ", SCHLUESSEL) + ") DO UPDATE SET "
                + String.join(", ", uebernommen.stream().map(s -> s + " = EXCLUDED." + s).toList())
                + " WHERE messreihe_tag.zustand = '" + ViertelstundeRegeln.VORLAEUFIG + "'"
                + " AND messreihe_tag.version = 1"
                + " AND (" + String.join(", ",
                        verglichen.stream().map(s -> "messreihe_tag." + s).toList())
                + ") IS DISTINCT FROM (" + String.join(", ",
                        verglichen.stream().map(s -> "EXCLUDED." + s).toList()) + ")";
    }

    // -------------------------------------------------------------- Der Laufstand

    record Stand(Instant zeitpunkt, long zahl, String notiz) {}

    private static Stand standLesenUndSperren(Connection con, String schluessel)
            throws SQLException {
        try (PreparedStatement ps = con.prepareStatement(
                "SELECT zeitpunkt, zahl, notiz FROM messreihe_tag_lauf "
                        + "WHERE schluessel = ? FOR UPDATE")) {
            ps.setString(1, schluessel);
            try (ResultSet rs = ps.executeQuery()) {
                if (!rs.next()) {
                    return new Stand(null, 0, null);
                }
                return new Stand(rs.getTimestamp(1) == null ? null : rs.getTimestamp(1).toInstant(),
                        rs.getLong(2), rs.getString(3));
            }
        }
    }

    private static void standSetzen(Connection con, String schluessel, Instant zeitpunkt, int plus,
            String notiz) throws SQLException {
        try (PreparedStatement ps = con.prepareStatement(
                "UPDATE messreihe_tag_lauf SET zeitpunkt = ?, zahl = zahl + ?, "
                        + "notiz = coalesce(?, notiz), geaendert_am = now() WHERE schluessel = ?")) {
            ps.setTimestamp(1, Timestamp.from(zeitpunkt));
            ps.setInt(2, plus);
            ps.setString(3, notiz);
            ps.setString(4, schluessel);
            ps.executeUpdate();
        }
    }

    /** Der Laufstand, wie ihn der Betrieb und die Tests lesen. */
    public Stand stand(String schluessel) {
        return adminJdbc.query("SELECT zeitpunkt, zahl, notiz FROM messreihe_tag_lauf "
                + "WHERE schluessel = ?", rs -> rs.next()
                        ? new Stand(rs.getTimestamp(1) == null ? null : rs.getTimestamp(1).toInstant(),
                                rs.getLong(2), rs.getString(3))
                        : null, schluessel);
    }

    // --------------------------------------------------------------- Die Klammer

    @FunctionalInterface
    private interface Zug<T> {
        T fahren(Connection con) throws SQLException;
    }

    /** EINE Transaktion je Zug: entnehmen und schreiben gehören zusammen. */
    private <T> T inTransaktion(Zug<T> zug) {
        return adminJdbc.execute((Connection con) -> {
            boolean autoCommit = con.getAutoCommit();
            con.setAutoCommit(false);
            try {
                T ergebnis = zug.fahren(con);
                con.commit();
                return ergebnis;
            } catch (Exception e) {
                con.rollback();
                throw e instanceof SQLException sql ? sql
                        : new SQLException("UEMS Tages-Verdichtung fehlgeschlagen", e);
            } finally {
                con.setAutoCommit(autoCommit);
            }
        });
    }
}
