package com.voltpilot.api.uems;

import com.voltpilot.api.measurement.MeasurementCatalog;
import com.voltpilot.api.uems.VerbrauchRegeln.Ergebnis;
import com.voltpilot.api.uems.VerbrauchRegeln.Teilperiode;
import java.math.BigDecimal;
import java.sql.Connection;
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
import java.util.List;
import java.util.Map;
import java.util.UUID;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Qualifier;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Component;

/**
 * Der MONATS- und JAHRESLAUF (UEMS AP-08 IP-5): aus den gespeicherten Perioden wird eine Zeile in
 * {@code messreihe_periode}.
 *
 * <p><b>Aus den Periodenständen, nie als Summe.</b> Die Menge bildet
 * {@link VerbrauchRegeln#zaehlerstandAusTeilperioden} — ein MONAT aus seinen Viertelstunden (nicht
 * aus den Tageszeilen: die trägt ein Tag, der vor IP-5 schon endgültig war, gar nicht, und eine
 * endgültige Zeile wird nie angefasst), ein JAHR aus seinen Monaten. Beides ergibt dasselbe wie die
 * Regel über alle Rohwerte ({@code VerbrauchTeilperiodenTest}).
 *
 * <p><b>Die Zeitzone ist die des Tages</b>: der Monat übernimmt Zone und Herkunft seiner jüngsten
 * Tageszeile (die sie aus Standort → Unternehmen → Vorgabe hat), das Jahr die seines jüngsten
 * Monats — und speichert sie (W10/A8). Die Grenzen sind Kalendergrenzen in dieser Zone; die Stunden
 * (743 · 744 · 745 …) stehen aus {@code beginn}/{@code ende} in der Zeile.
 *
 * <p><b>Fortpflanzung der Zeit (§4.5).</b> Ein Monat ist vorläufig, solange einer seiner Tage
 * vorläufig ist oder eine seiner Viertelstunden, oder seine eigene Frist (Monatsende + 7 Tage)
 * läuft; ein Jahr ebenso über seine Monate ({@link TagRegeln#zustand}). Abdeckung ist Summe erhalten
 * ÷ Summe erwartet, Kennzeichen und Vollständigkeit kommen aus der Regel.
 *
 * <p><b>Wiederholbar und abbruchsicher</b>, dieselbe Form wie {@link TagVerdichter}: durable
 * Arbeitsliste, Entnahme unter {@code FOR UPDATE SKIP LOCKED}, entnehmen und schreiben in EINER
 * Transaktion; {@code ON CONFLICT … DO UPDATE … WHERE} lässt eine endgültige und eine unveränderte
 * Zeile in Ruhe. Drei Quellen: der Tageslauf (ein Tag wurde geschrieben), dieser Lauf selbst (ein
 * Monat wurde geschrieben → sein Jahr) und der Frist-Durchgang; dazu die einmalige Nachholung
 * der Monate, deren Tage schon vor IP-5 standen.
 */
@Component
public class PeriodeVerdichter {

    private static final Logger log = LoggerFactory.getLogger(PeriodeVerdichter.class);

    static final String MONAT = "monat";
    static final String JAHR = "jahr";

    private static final String[] SPALTEN = {
        "tag", "art", "tenant_id", "entity_id", "messkanal", "site_id",
        "zeitzone", "zeitzone_herkunft", "beginn", "ende", "stunden",
        "teile_erwartet", "teile_vorhanden", "teile_endgueltig",
        "wertart", "stand_anfang", "stand_anfang_zeit", "stand_ende", "stand_ende_zeit",
        "erster_wert", "erster_zeit", "letzter_wert", "letzter_zeit",
        "menge", "menge_zustand", "kennzeichen", "erhalten", "erwartet", "abdeckung_prozent",
        "kadenz_s", "n_nachgeliefert", "zustand", "endgueltig_ab", "berechnet_am", "version",
        "mittel", "min_wert", "max_wert", "summe", "energie", "gemessen_s", "luecke_innen",
        "menge_positiv", "menge_negativ"};

    private final JdbcTemplate adminJdbc;
    private final MeasurementCatalog katalog;
    private final int stapelGroesse;
    private final int stapelJeLauf;
    private final int nachholenJeLauf;

    public PeriodeVerdichter(
            @Qualifier("adminJdbcTemplate") JdbcTemplate adminJdbc,
            MeasurementCatalog katalog,
            @Value("${voltpilot.uems.periode.stapel:50}") int stapelGroesse,
            @Value("${voltpilot.uems.periode.stapel-je-lauf:40}") int stapelJeLauf,
            @Value("${voltpilot.uems.periode.nachholen-je-lauf:2000}") int nachholenJeLauf) {
        this.adminJdbc = adminJdbc;
        this.katalog = katalog;
        this.stapelGroesse = stapelGroesse;
        this.stapelJeLauf = stapelJeLauf;
        this.nachholenJeLauf = nachholenJeLauf;
    }

    /** Was ein Lauf tat — für das Log und die Tests. */
    public record Lauf(int ausFrist, int nachgeholt, int gebildet, int geschrieben) {}

    /** Ein ganzer Takt: eintragen (Frist, Nachholen) → bilden, bis die Arbeitsliste leer ist. */
    public Lauf lauf(Instant jetzt) {
        int ausFrist = eintragenAusFrist(jetzt);
        int nachgeholt = nachholen();
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
        if (ausFrist > 0 || nachgeholt > 0 || gebildet > 0) {
            log.info("UEMS Monats-/Jahreslauf: {} aus der Frist, {} nachgeholt, {} gebildet, {} geschrieben",
                    ausFrist, nachgeholt, gebildet, geschrieben);
        }
        return new Lauf(ausFrist, nachgeholt, gebildet, geschrieben);
    }

    // ================================================================== Eingang
    // Beide Quellen lesen nur REIHEN (`entity_id IS NOT NULL`): Monat und Jahr einer berechneten Messstelle
    // (Spur `berechnet`, AP-10 IP-10) rechnet ihr eigener Lauf aus den Perioden ihrer Eingänge.

    /** Perioden, die noch vorläufig sind und deren Frist abgelaufen ist — sie werden endgültig. */
    int eintragenAusFrist(Instant jetzt) {
        return adminJdbc.update("""
                INSERT INTO messreihe_periode_arbeit (tenant_id, entity_id, messkanal, art, tag, grund)
                SELECT p.tenant_id, p.entity_id, p.messkanal, p.art, p.tag, 'frist'
                  FROM messreihe_periode p
                 WHERE p.zustand = 'vorlaeufig' AND p.endgueltig_ab <= ?
                   AND p.entity_id IS NOT NULL
                ON CONFLICT DO NOTHING
                """, Timestamp.from(jetzt));
    }

    /**
     * Die Monate, deren Tage schon stehen, die aber noch keine Zeile haben — einmal nach dem
     * Deploy die Vergangenheit, danach findet er nichts mehr (ein Tag wird geschrieben → sein Monat
     * steht schon in der Liste).
     */
    int nachholen() {
        return adminJdbc.update("""
                INSERT INTO messreihe_periode_arbeit (tenant_id, entity_id, messkanal, art, tag, grund)
                SELECT DISTINCT t.tenant_id, t.entity_id, t.messkanal, 'monat',
                       date_trunc('month', t.tag)::date, 'tag'
                  FROM messreihe_tag t
                 WHERE NOT EXISTS (SELECT 1 FROM messreihe_periode p
                                    WHERE p.tenant_id = t.tenant_id AND p.entity_id = t.entity_id
                                      AND p.messkanal = t.messkanal AND p.art = 'monat'
                                      AND p.tag = date_trunc('month', t.tag)::date)
                   AND t.entity_id IS NOT NULL
                 LIMIT ?
                ON CONFLICT DO NOTHING
                """, nachholenJeLauf);
    }

    // ================================================================== Das Bilden

    record Auftrag(UUID tenant, UUID entity, String kanal, String art, LocalDate tag) {}

    /**
     * Entnimmt EINEN Stapel und schreibt seine Perioden in derselben Transaktion.
     *
     * @return {@code [entnommene Einträge, wirklich geschriebene Zeilen]}
     */
    int[] bildeEinenStapel(Instant jetzt) {
        return inTransaktion(con -> {
            List<Auftrag> stapel = entnehmen(con);
            int geschrieben = 0;
            try (PreparedStatement upsert = con.prepareStatement(upsertSql());
                    PreparedStatement jahr = con.prepareStatement(JAHR_EINTRAGEN)) {
                for (Auftrag a : stapel) {
                    Object[] werte = MONAT.equals(a.art()) ? monat(con, a, jetzt) : jahr(con, a, jetzt);
                    if (werte == null) {
                        continue;
                    }
                    for (int p = 0; p < werte.length; p++) {
                        upsert.setObject(p + 1, werte[p]);
                    }
                    int n = upsert.executeUpdate();
                    geschrieben += n;
                    if (n > 0 && MONAT.equals(a.art())) {
                        jahr.setObject(1, a.tenant(), Types.OTHER);
                        jahr.setObject(2, a.entity(), Types.OTHER);
                        jahr.setString(3, a.kanal());
                        jahr.setObject(4, a.tag().withDayOfYear(1));
                        jahr.executeUpdate();
                    }
                }
            }
            return new int[] {stapel.size(), geschrieben};
        });
    }

    private static final String JAHR_EINTRAGEN = "INSERT INTO messreihe_periode_arbeit "
            + "(tenant_id, entity_id, messkanal, art, tag, grund) VALUES (?, ?, ?, 'jahr', ?, 'monat') "
            + "ON CONFLICT DO NOTHING";

    private List<Auftrag> entnehmen(Connection con) throws SQLException {
        List<Auftrag> aus = new ArrayList<>();
        try (PreparedStatement ps = con.prepareStatement("""
                DELETE FROM messreihe_periode_arbeit a
                 USING (SELECT tenant_id, entity_id, messkanal, art, tag
                          FROM messreihe_periode_arbeit
                         ORDER BY art DESC, tag, eingetragen_am
                         LIMIT ?
                         FOR UPDATE SKIP LOCKED) c
                 WHERE a.tenant_id = c.tenant_id AND a.entity_id = c.entity_id
                   AND a.messkanal = c.messkanal AND a.art = c.art AND a.tag = c.tag
                RETURNING a.tenant_id, a.entity_id, a.messkanal, a.art, a.tag
                """)) {
            ps.setInt(1, stapelGroesse);
            try (ResultSet rs = ps.executeQuery()) {
                while (rs.next()) {
                    aus.add(new Auftrag(rs.getObject(1, UUID.class), rs.getObject(2, UUID.class),
                            rs.getString(3), rs.getString(4), rs.getDate(5).toLocalDate()));
                }
            }
        }
        // Monate vor Jahren: ein Jahr, das im selben Stapel steht, soll auf seinen frischen Monaten
        // stehen (DELETE … RETURNING garantiert keine Reihenfolge).
        aus.sort((x, y) -> x.art().equals(y.art()) ? x.tag().compareTo(y.tag()) : MONAT.equals(x.art()) ? -1 : 1);
        return aus;
    }

    /** Zone und Herkunft der jüngsten Zeile der Teile — und die Zahl der Teile samt endgültigen. */
    private record Teile(String zone, String herkunft, int vorhanden, int endgueltig) {}

    private static Teile teile(Connection con, Auftrag a, String tabelle, String bedingung, LocalDate von,
            LocalDate bis) throws SQLException {
        try (PreparedStatement ps = con.prepareStatement(
                "SELECT (array_agg(zeitzone ORDER BY tag DESC))[1], (array_agg(zeitzone_herkunft ORDER BY tag DESC))[1], "
                        + "count(*), count(*) FILTER (WHERE zustand = 'endgueltig') FROM " + tabelle
                        + " WHERE tenant_id = ? AND entity_id = ? AND messkanal = ? AND tag >= ? AND tag < ?"
                        + bedingung)) {
            ps.setObject(1, a.tenant(), Types.OTHER);
            ps.setObject(2, a.entity(), Types.OTHER);
            ps.setString(3, a.kanal());
            ps.setObject(4, von);
            ps.setObject(5, bis);
            try (ResultSet rs = ps.executeQuery()) {
                rs.next();
                return rs.getString(1) == null ? null
                        : new Teile(rs.getString(1), rs.getString(2), rs.getInt(3), rs.getInt(4));
            }
        }
    }

    /** Ein MONAT aus seinen Viertelstunden — Zone, Zahl und Zustand der Tage aus den Tageszeilen. */
    private Object[] monat(Connection con, Auftrag a, Instant jetzt) throws SQLException {
        LocalDate erster = a.tag().withDayOfMonth(1);
        LocalDate naechster = erster.plusMonths(1);
        Teile tage = teile(con, a, "messreihe_tag", "", erster, naechster);
        if (tage == null) {
            return null;
        }
        ZoneId zone = TagRegeln.zone(tage.zone());
        Instant beginn = TagRegeln.beginn(erster, zone);
        Instant ende = TagRegeln.beginn(naechster, zone);
        ViertelstundenTeile.Geladen v = ViertelstundenTeile.laden(con, a.tenant(), a.entity(), a.kanal(),
                beginn, ende);
        if (v.vorhanden() == 0) {
            return null;
        }
        // Vorläufig, solange EIN Tag oder EINE Viertelstunde vorläufig ist oder die Frist läuft.
        boolean alleSlotsEndgueltig = v.endgueltig() == v.vorhanden();
        String zustand = alleSlotsEndgueltig
                ? TagRegeln.zustand(tage.vorhanden(), tage.endgueltig(), TagRegeln.endgueltigAb(ende), jetzt)
                : ViertelstundeRegeln.VORLAEUFIG;
        return zeile(a, erster, ReihenKontext.aus(katalog, a.kanal(), zone), tage, beginn, ende,
                erster.lengthOfMonth(),
                tage.endgueltig(), v.innen(beginn, ende), v.teile(), v.ereignisse(), v.deklaration(), v.wertart(),
                v.kadenzS(),
                v.nachgeliefert(), v.siteEindeutig() ? v.siteId() : null, zustand,
                ViertelstundenTeile.werte(v.werteteile(), v.wertart(), v.kadenzS(), beginn, ende),
                Richtungspaar.ausTeilen(v.anteile(), beginn, ende), jetzt);
    }

    /** Ein JAHR aus seinen Monaten. */
    private Object[] jahr(Connection con, Auftrag a, Instant jetzt) throws SQLException {
        LocalDate erster = a.tag().withDayOfYear(1);
        LocalDate naechster = erster.plusYears(1);
        Teile monate = teile(con, a, "messreihe_periode", " AND art = 'monat'", erster, naechster);
        if (monate == null) {
            return null;
        }
        ZoneId zone = TagRegeln.zone(monate.zone());
        Instant beginn = TagRegeln.beginn(erster, zone);
        Instant ende = TagRegeln.beginn(naechster, zone);

        List<Teilperiode> teile = new ArrayList<>();
        List<Teilperiode> innen = new ArrayList<>();
        List<VerbrauchRegeln.Werteteil> werteteile = new ArrayList<>();
        Richtungspaar.Summe paar = new Richtungspaar.Summe();
        String wertart = null;
        Integer kadenzS = null;
        int nachgeliefert = 0;
        UUID site = null;
        boolean siteEindeutig = true;
        try (PreparedStatement ps = con.prepareStatement(
                "SELECT tag, beginn, ende, stand_anfang, stand_anfang_zeit, stand_ende, stand_ende_zeit, "
                        + "erster_wert, erster_zeit, letzter_wert, letzter_zeit, menge, menge_zustand, "
                        + "erhalten, erwartet, kennzeichen::text, kadenz_s, wertart, n_nachgeliefert, site_id, "
                        + "summe, mittel, min_wert, max_wert, energie, gemessen_s, luecke_innen, "
                        + "menge_positiv, menge_negativ "
                        + "FROM messreihe_periode WHERE tenant_id = ? AND entity_id = ? AND messkanal = ? "
                        + "AND art = 'monat' AND tag >= ? AND tag <= ? ORDER BY tag")) {
            ps.setObject(1, a.tenant(), Types.OTHER);
            ps.setObject(2, a.entity(), Types.OTHER);
            ps.setString(3, a.kanal());
            // Der Dezember davor und der Januar danach: die Nachbarn der Jahresgrenzen.
            ps.setObject(4, erster.minusMonths(1));
            ps.setObject(5, naechster);
            try (ResultSet rs = ps.executeQuery()) {
                while (rs.next()) {
                    LocalDate tag = rs.getDate(1).toLocalDate();
                    Teilperiode t = new Teilperiode(ViertelstundenTeile.zeit(rs, 2), ViertelstundenTeile.zeit(rs, 3),
                            ViertelstundenTeile.wert(rs, 4, 5), ViertelstundenTeile.wert(rs, 6, 7),
                            ViertelstundenTeile.wert(rs, 8, 9), ViertelstundenTeile.wert(rs, 10, 11),
                            new Ergebnis(rs.getBigDecimal(12), null, null, null, null, rs.getString(13),
                                    rs.getInt(14), rs.getInt(15), null,
                                    ViertelstundenTeile.kennzeichen(rs.getString(16))));
                    teile.add(t);
                    // AP-08 IP-3: derselbe Monat als Werteteil (Mittel, Summe, Energie, gemessene Zeit).
                    Integer gemessen = (Integer) rs.getObject(26);
                    Boolean luecke = (Boolean) rs.getObject(27);
                    werteteile.add(new VerbrauchRegeln.Werteteil(
                            new Teilperiode(t.von(), t.bis(), null, null, t.erster(), t.letzter(),
                                    new Ergebnis(t.ergebnis().menge(), rs.getBigDecimal(22), rs.getBigDecimal(23),
                                            rs.getBigDecimal(24), null, t.ergebnis().zustand(),
                                            t.ergebnis().erhalten(), t.ergebnis().erwartet(), null,
                                            t.ergebnis().kennzeichen())),
                            rs.getBigDecimal(21), rs.getBigDecimal(25), gemessen == null ? 0 : gemessen,
                            luecke != null && luecke));
                    if (!tag.isBefore(erster) && tag.isBefore(naechster)) {
                        innen.add(t);
                        paar.nimm(rs.getBigDecimal(28), rs.getBigDecimal(29));
                        kadenzS = (Integer) rs.getObject(17);
                        wertart = rs.getString(18) != null ? rs.getString(18) : wertart;
                        nachgeliefert += rs.getInt(19);
                        UUID s = rs.getObject(20, UUID.class);
                        if (s != null && site == null) {
                            site = s;
                        } else if (s != null && !site.equals(s)) {
                            siteEindeutig = false;
                        }
                    }
                }
            }
        }
        // Ein Monat einer anderen Zone kachelt dieses Jahr nicht — die Regel weist ihn ab, statt
        // ihn still zu kappen. Heute tragen alle zugelassenen Zonen denselben Versatz.
        ZaehlerDeklaration deklaration = ZaehlerDeklaration.lesen(con, a.tenant(), a.entity(), a.kanal(), beginn);
        List<VerbrauchRegeln.Ereignis> ereignisse = ViertelstundenTeile.ereignisse(con, a.tenant(), a.entity(),
                a.kanal(), beginn, ende, deklaration);
        String zustand = TagRegeln.zustand(monate.vorhanden(), monate.endgueltig(), TagRegeln.endgueltigAb(ende),
                jetzt);
        return zeile(a, erster, ReihenKontext.aus(katalog, a.kanal(), zone), monate, beginn, ende, 12,
                monate.endgueltig(), innen, teile, ereignisse,
                deklaration, wertart, kadenzS, nachgeliefert, siteEindeutig ? site : null, zustand,
                ViertelstundenTeile.werte(werteteile, wertart, kadenzS, beginn, ende), paar.fertig(), jetzt);
    }

    /**
     * @param reihe der Träger dieser Reihe: Einheit aus dem Katalog, Zone der Tage bzw. Monate — in ihm
     *     sprechen die Kennzeichen, die die Regel an dieser Periode neu bildet
     */
    private static Object[] zeile(Auftrag a, LocalDate erster, ReihenKontext reihe, Teile teile, Instant beginn,
            Instant ende, int teileErwartet, int teileEndgueltig, List<Teilperiode> innen,
            List<Teilperiode> alle, List<VerbrauchRegeln.Ereignis> ereignisse, ZaehlerDeklaration deklaration,
            String wertart, Integer kadenzS,
            int nachgeliefert, UUID site, String zustand, VerbrauchRegeln.Werteteil werteteil,
            BigDecimal[] richtungspaar, Instant jetzt) {
        Teilperiode menge = ViertelstundenTeile.zaehlerstand(reihe, alle, ereignisse, deklaration, wertart,
                kadenzS, beginn, ende);
        // Zählerstand aus den Periodenständen (IP-5), Momentanwert/Intervallmenge aus der Regel von
        // IP-3 — ein Momentanwert trägt NIE eine Menge (M6), seine Energie steht in `energie`.
        Ergebnis mengeErgebnis = menge != null ? menge.ergebnis()
                : werteteil == null ? null : werteteil.teil().ergebnis();
        boolean momentan = "momentanwert".equals(ViertelstundeRegeln.regelWort(wertart));
        int erhalten = innen.stream().mapToInt(t -> t.ergebnis().erhalten()).sum();
        int erwartet = kadenzS == null
                ? innen.stream().mapToInt(t -> t.ergebnis().erwartet()).sum()
                : VerbrauchRegeln.erwartetAusTeilperioden(innen, beginn, ende, Duration.ofSeconds(kadenzS));
        Integer abdeckung = erwartet == 0 ? null : Math.min(100, (int) (100L * erhalten / erwartet));
        VerbrauchRegeln.Rohwert sA = menge == null ? null : menge.standAnfang();
        VerbrauchRegeln.Rohwert sE = menge == null ? null : menge.standEnde();
        VerbrauchRegeln.Rohwert ersterWert = innen.stream().map(Teilperiode::erster).filter(r -> r != null)
                .findFirst().orElse(null);
        VerbrauchRegeln.Rohwert letzterWert = innen.stream().map(Teilperiode::letzter).filter(r -> r != null)
                .reduce((x, y) -> y).orElse(null);

        Map<String, Object> z = new LinkedHashMap<>();
        z.put("tag", java.sql.Date.valueOf(erster));
        z.put("art", a.art());
        z.put("tenant_id", a.tenant());
        z.put("entity_id", a.entity());
        z.put("messkanal", a.kanal());
        z.put("site_id", site);
        z.put("zeitzone", teile.zone());
        z.put("zeitzone_herkunft", teile.herkunft());
        z.put("beginn", Timestamp.from(beginn));
        z.put("ende", Timestamp.from(ende));
        z.put("stunden", (int) Duration.between(beginn, ende).toHours());
        z.put("teile_erwartet", teileErwartet);
        z.put("teile_vorhanden", teile.vorhanden());
        z.put("teile_endgueltig", teileEndgueltig);
        z.put("wertart", wertart);
        z.put("stand_anfang", sA == null ? null : sA.wert());
        z.put("stand_anfang_zeit", sA == null ? null : Timestamp.from(sA.zeit()));
        z.put("stand_ende", sE == null ? null : sE.wert());
        z.put("stand_ende_zeit", sE == null ? null : Timestamp.from(sE.zeit()));
        z.put("erster_wert", ersterWert == null ? null : ersterWert.wert());
        z.put("erster_zeit", ersterWert == null ? null : Timestamp.from(ersterWert.zeit()));
        z.put("letzter_wert", letzterWert == null ? null : letzterWert.wert());
        z.put("letzter_zeit", letzterWert == null ? null : Timestamp.from(letzterWert.zeit()));
        z.put("menge", mengeErgebnis == null ? null : mengeErgebnis.menge());
        z.put("menge_zustand", mengeErgebnis == null ? null : mengeErgebnis.zustand());
        z.put("kennzeichen", ViertelstundeRegeln.kennzeichenJson(
                mengeErgebnis == null ? List.of() : mengeErgebnis.kennzeichen()));
        // Das Richtungspaar (V20260918101000) — der Monat aus seinen Viertelstunden, das Jahr aus
        // den gespeicherten Monaten. Unbekannt ist keine Null: fehlt es an EINEM Teil, fehlt es ganz.
        z.put("menge_positiv", richtungspaar == null ? null : richtungspaar[0]);
        z.put("menge_negativ", richtungspaar == null ? null : richtungspaar[1]);
        z.put("erhalten", erhalten);
        z.put("erwartet", erwartet);
        z.put("abdeckung_prozent", abdeckung);
        z.put("kadenz_s", kadenzS);
        z.put("n_nachgeliefert", nachgeliefert);
        z.put("zustand", zustand);
        z.put("endgueltig_ab", Timestamp.from(TagRegeln.endgueltigAb(ende)));
        z.put("berechnet_am", Timestamp.from(jetzt));
        z.put("version", 1);
        Ergebnis w = werteteil == null ? null : werteteil.teil().ergebnis();
        z.put("mittel", w == null ? null : w.mittel());
        z.put("min_wert", w == null ? null : w.min());
        z.put("max_wert", w == null ? null : w.max());
        z.put("summe", werteteil == null ? null : werteteil.summe());
        z.put("energie", werteteil == null ? null : werteteil.energie());
        z.put("gemessen_s", momentan && werteteil != null ? (int) werteteil.gemessenS() : null);
        z.put("luecke_innen", momentan && werteteil != null ? werteteil.lueckeInnen() : null);
        Object[] werte = new Object[SPALTEN.length];
        for (int i = 0; i < SPALTEN.length; i++) {
            werte[i] = z.get(SPALTEN[i]);
        }
        return werte;
    }

    private static String upsertSql() {
        List<String> uebernommen = new ArrayList<>();
        List<String> verglichen = new ArrayList<>();
        StringBuilder platz = new StringBuilder();
        for (String s : SPALTEN) {
            platz.append(platz.length() == 0 ? "" : ", ").append("kennzeichen".equals(s) ? "?::jsonb" : "?");
            if (List.of("tag", "art", "tenant_id", "entity_id", "messkanal", "version").contains(s)) {
                continue;
            }
            uebernommen.add(s + " = EXCLUDED." + s);
            if (!"berechnet_am".equals(s)) {
                verglichen.add(s);
            }
        }
        return "INSERT INTO messreihe_periode (" + String.join(", ", SPALTEN) + ") VALUES (" + platz + ")"
                + " ON CONFLICT (tenant_id, entity_id, messkanal, art, tag) DO UPDATE SET "
                + String.join(", ", uebernommen)
                + " WHERE messreihe_periode.zustand = '" + ViertelstundeRegeln.VORLAEUFIG + "'"
                + " AND messreihe_periode.version = 1"
                + " AND (" + String.join(", ", verglichen.stream().map(s -> "messreihe_periode." + s).toList())
                + ") IS DISTINCT FROM ("
                + String.join(", ", verglichen.stream().map(s -> "EXCLUDED." + s).toList()) + ")";
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
                        : new SQLException("UEMS Monats-/Jahres-Verdichtung fehlgeschlagen", e);
            } finally {
                con.setAutoCommit(autoCommit);
            }
        });
    }
}
