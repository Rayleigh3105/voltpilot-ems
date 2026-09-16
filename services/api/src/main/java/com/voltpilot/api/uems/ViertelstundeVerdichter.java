package com.voltpilot.api.uems;

import com.voltpilot.api.measurement.MeasurementCatalog;
import java.math.BigDecimal;
import java.sql.Connection;
import java.sql.PreparedStatement;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.sql.Savepoint;
import java.sql.Timestamp;
import java.time.Duration;
import java.time.Instant;
import java.time.LocalDate;
import java.time.ZoneOffset;
import java.util.ArrayList;
import java.util.Collection;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.TreeMap;
import java.util.UUID;
import java.util.concurrent.atomic.AtomicLong;
import java.util.function.UnaryOperator;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Qualifier;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Component;

/**
 * Der VERDICHTUNGS-LAUF der Speicherklasse Viertelstundenwerte (UEMS AP-07 IP-12) — und seit
 * AP-08 IP-2 die Stelle, an der aus den gespeicherten Fakten die MENGE wird.
 *
 * <p>Er tut drei Dinge, und jedes in seiner EIGENEN Transaktion:
 *
 * <ol>
 *   <li><b>Eintragen</b> — welche Intervalle sind seit dem letzten Lauf betroffen? Gefragt wird
 *       über die EINGANGSZEIT der Rohwerte, nicht über ein festes Fenster (§4.5 Nachlieferung
 *       Nr. 3): so findet der Lauf eine Nachlieferung von selbst, auch 80 Tage rückwärts.
 *   <li><b>Rückrechnen</b> — die einmalige Rückrechnung der letzten 90 Tage, rückwärts in
 *       Tagesscheiben, angehalten und wiederaufnehmbar. Eine Unterbrechung kostet höchstens die
 *       angefangene Scheibe.
 *   <li><b>Verdichten</b> — einen Stapel aus der Arbeitsliste entnehmen und die Intervalle aus der
 *       MENGE ihrer Rohwerte bilden (§4.5 Reihenfolge Nr. 3: nie inkrementell fortgeschrieben,
 *       darum reihenfolge-unabhängig und wiederholbar).
 * </ol>
 *
 * <p><b>Die Rechenregeln ruft er auf, er baut sie nicht nach.</b> Menge aus Zählerständen,
 * Rücksprung, Ersatzwerte und Zeitumstellung sind AP-08 und leben in {@link VerbrauchRegeln}
 * (Vertrag mit Python-Zwilling). Die Erwartung kommt aus {@link KadenzRegeln} — mit der Fassung,
 * die ZUM INTERVALL galt, nie der von „jetzt" (IP-10). Zwei Rechenwege für dieselbe Zahl sind
 * genau die Drift, die diese Verträge verhindern.
 *
 * <p><b>AP-08 IP-2: die Menge.</b> Die Regel liefert dasselbe {@code Ergebnis} wie bisher — neu
 * ist nur, dass {@code menge}, {@code menge_zustand} und {@code kennzeichen} nicht mehr
 * weggeworfen, sondern gespeichert werden (Z1–Z3, Z8, Z9; Spalten aus {@code V20260912180000}).
 * Vier Sätze, die dabei nie verletzt werden:
 *
 * <ul>
 *   <li><b>Eine Lücke ist nie eine Null.</b> Eine Viertelstunde ohne einen einzigen Rohwert
 *       bekommt gar keine Zeile; wo eine Zeile steht, aber keine Menge bildbar ist, steht
 *       {@code NULL} — ein Zählerrücksprung erzeugt nie einen erfundenen Verbrauch, ein
 *       Box-Ausfall nie einen gemessenen Stillstand.
 *   <li><b>Abdeckung ist nicht Vollständigkeit.</b> {@code menge_zustand} und
 *       {@code abdeckung_prozent} sind zwei verschiedene Aussagen; nichts wird aufgefüllt und
 *       nichts auf 100 % gerundet.
 *   <li><b>Eine Lücke beginnt ÜBER 2 × Kadenz</b> — mit der Kadenz, die ZUM INTERVALL galt
 *       ({@link KadenzRegeln}, IP-10), nie der von „jetzt".
 *   <li><b>Der Faktor wirkt genau einmal</b> — nämlich beim Erfassen, nicht hier:
 *       {@link ViertelstundeRegeln#FAKTOR_DER_FASSUNG}.
 * </ul>
 *
 * <p><b>Wiederholbar und abbruchsicher.</b> Ein Stapel wird ENTNOMMEN und in DERSELBEN Transaktion
 * geschrieben: bricht der Lauf ab, ist die Entnahme mitgerollt und der Eintrag steht wieder in der
 * Arbeitsliste — es bleibt nie etwas Halbes liegen. Zweimal über dasselbe Intervall ergibt
 * denselben Wert; ein zweiter Lauf ohne neue Rohwerte schreibt gar nichts (der Vergleich in
 * {@code ON CONFLICT … WHERE} lässt eine unveränderte Zeile in Ruhe, {@code berechnet_am}
 * eingeschlossen).
 *
 * <p><b>⚠ Die Grenze zu IP-13.</b> Dieser Lauf schreibt NUR vorläufige Werte und rührt eine
 * endgültige Zeile nie an. Das Umschalten auf {@code endgueltig} (Stundenlauf), die Behandlung
 * einer Spätankunft ({@code late_arrival} + Korrektur-Vorschlag an AP-08) und die Tageswerte sind
 * AP-07 IP-13. KORREKTUREN, Kaskade und Versionierung sind AP-08 IP-12 ff.: {@code version}
 * bleibt 1, und eine korrigierte Zeile wird ebenso wenig angefasst wie eine endgültige.
 */
@Component
public class ViertelstundeVerdichter {

    private static final Logger log = LoggerFactory.getLogger(ViertelstundeVerdichter.class);

    /**
     * Der Sicherheitsabstand des Eingangs-Zeigers: Rohwerte der letzten {@code SICHERHEIT} werden
     * noch nicht als „gesehen" abgehakt. Eine Transaktion, die vor dem Lauf begann und erst danach
     * festschreibt, trüge sonst eine Eingangszeit unterhalb des schon fortgeschriebenen Zeigers.
     */
    static final Duration SICHERHEIT = Duration.ofMinutes(2);

    /** Und dieselbe Spanne wird beim nächsten Lauf noch einmal gelesen — Eintragen ist idempotent. */
    static final Duration UEBERLAPP = Duration.ofMinutes(2);

    /** Die Rückrechnung geht so weit zurück, wie die Rohwerte reichen (Retention 90 Tage). */
    static final Duration RUECKRECHNUNG_TIEFE = Duration.ofDays(90);

    /** Und sie geht in Tagesscheiben — die Einheit, in der sie unterbrechbar ist. */
    static final Duration RUECKRECHNUNG_SCHEIBE = Duration.ofDays(1);

    private static final String ZEIGER = "zeiger";
    private static final String RUECKRECHNUNG = "rueckrechnung";
    private static final String FERTIG = "fertig";

    /** Die Rohwert-Spur, die eine Reihe trägt: der Spiegel liegt ausdrücklich außerhalb (§4.7). */
    private static final String SPUR = "s.entity_id IS NOT NULL AND s.role IS DISTINCT FROM 'spiegel'";

    /** Die Spalten der Tabelle, in der Reihenfolge, in der der Lauf sie setzt. */
    private static final String[] SPALTEN = {
        "intervall_beginn", "tenant_id", "entity_id", "messkanal", "site_id", "wertart",
        "stand_anfang", "stand_anfang_zeit", "stand_ende", "stand_ende_zeit",
        "summe", "mittel", "min_wert", "max_wert",
        "erster_wert", "erster_text", "erster_zeit", "letzter_wert", "letzter_text", "letzter_zeit",
        "menge", "menge_zustand", "kennzeichen", "faktor",
        "energie", "gemessen_s", "luecke_innen",
        "erhalten", "erwartet", "abdeckung_prozent", "kadenz_s", "kadenz_herkunft",
        "n_good", "n_uncertain", "n_invalid", "n_stale", "n_device_error",
        "geraet_einbau", "geraet_einbau_2", "geraet_einbau_weitere",
        "box", "box_2", "box_weitere",
        "fassung", "katalog", "rolle",
        "zustand", "endgueltig_ab", "berechnet_am", "version",
        "n_nachgeliefert", "letzte_eingangszeit", "zustellart", "ereignisse"};

    /** Die Spalten, die als {@code jsonb} geschrieben werden (der Platzhalter braucht den Cast). */
    private static final Set<String> JSONB_SPALTEN = Set.of("ereignisse", "kennzeichen");

    /** Der Schlüssel der Zeile (die Spalten des Unique-Index) — er wird nie überschrieben. */
    private static final List<String> SCHLUESSEL =
            List.of("tenant_id", "entity_id", "messkanal", "intervall_beginn");

    /**
     * Was beim Wiederholen NICHT übernommen wird: der Schlüssel (er ist die Zeile) und die
     * {@code version} — die gehört den Korrekturen von AP-08, nicht diesem Lauf.
     */
    private static final Set<String> NICHT_UEBERNOMMEN = Set.of(
            "intervall_beginn", "tenant_id", "entity_id", "messkanal", "version");

    private final JdbcTemplate adminJdbc;
    private final MeasurementCatalog katalog;
    private final SpaetankunftMelder melder;
    private final int stapelGroesse;
    private final int stapelJeLauf;
    private final int arbeitHochwasser;
    private final AtomicLong spaetankunftFehler = new AtomicLong();

    public ViertelstundeVerdichter(
            @Qualifier("adminJdbcTemplate") JdbcTemplate adminJdbc,
            MeasurementCatalog katalog,
            SpaetankunftMelder melder,
            @Value("${voltpilot.uems.viertelstunde.stapel:500}") int stapelGroesse,
            @Value("${voltpilot.uems.viertelstunde.stapel-je-lauf:40}") int stapelJeLauf,
            @Value("${voltpilot.uems.viertelstunde.arbeit-hochwasser:200000}") int arbeitHochwasser) {
        this.adminJdbc = adminJdbc;
        this.katalog = katalog;
        this.melder = melder;
        this.stapelGroesse = stapelGroesse;
        this.stapelJeLauf = stapelJeLauf;
        this.arbeitHochwasser = arbeitHochwasser;
    }

    // ===================================================================== Eingang

    /** Was ein Lauf tat — für das Log und die Tests. */
    public record Lauf(int eingetragen, int rueckgerechnet, int scheiben, boolean rueckrechnungFertig,
            int verdichtet, int geschrieben, int spaetankuenfte) {}

    /** Fehlgeschlagene Zusatz-Stapel; der Betriebszähler bleibt auch ohne Metrik-Backend prüfbar. */
    public long spaetankunftFehlerAnzahl() {
        return spaetankunftFehler.get();
    }

    /**
     * Ein ganzer Takt: eintragen → eine Scheibe zurückrechnen → verdichten, bis die Arbeitsliste
     * leer ist oder {@code stapel-je-lauf} Stapel abgearbeitet sind.
     */
    public Lauf lauf(Instant jetzt) {
        int eingetragen = eintragenAusEingang(jetzt);
        Scheibe s = rueckrechnenEineScheibe(jetzt);
        int verdichtet = 0;
        int geschrieben = 0;
        int spaet = 0;
        for (int i = 0; i < stapelJeLauf; i++) {
            int[] ergebnis = verdichteEinenStapel(jetzt);
            if (ergebnis[0] == 0) {
                break;
            }
            verdichtet += ergebnis[0];
            geschrieben += ergebnis[1];
            spaet += ergebnis[2];
            if (ergebnis[3] > 0) {
                // Der Zusatz wird beim nächsten Takt erneut versucht. Ohne Abbruch würde derselbe
                // wieder eingereihte Stapel in diesem Takt bis zur Stapelgrenze heiß laufen.
                break;
            }
        }
        Lauf l = new Lauf(eingetragen, s.eingetragen(), s.gefahren() ? 1 : 0, s.fertig(),
                verdichtet, geschrieben, spaet);
        if (eingetragen > 0 || verdichtet > 0 || s.eingetragen() > 0) {
            log.info("UEMS Viertelstunden-Lauf: {} Intervalle aus dem Eingang, {} aus der "
                    + "Rückrechnung ({}), {} verdichtet, {} geschrieben, {} zu spät",
                    eingetragen, s.eingetragen(), s.fertig() ? "fertig" : "läuft",
                    verdichtet, geschrieben, spaet);
        }
        return l;
    }

    /**
     * Trägt die Intervalle jedes Rohwerts in die Arbeitsliste ein, der seit dem Zeiger EINGEGANGEN
     * ist — und schiebt den Zeiger in DERSELBEN Transaktion nach.
     *
     * <p>Der erste Lauf überhaupt setzt den Zeiger nur auf „jetzt": die Vergangenheit gehört der
     * Rückrechnung, sonst läse der erste Takt nach einem Deploy die ganzen 90 Tage auf einmal.
     */
    int eintragenAusEingang(Instant jetzt) {
        Instant obergrenze = jetzt.minus(SICHERHEIT);
        return inTransaktion(con -> {
            Stand stand = standLesenUndSperren(con, ZEIGER);
            if (stand.zeitpunkt() == null) {
                standSetzen(con, ZEIGER, obergrenze, 0, null);
                return 0;
            }
            Instant untergrenze = stand.zeitpunkt().minus(UEBERLAPP);
            if (!untergrenze.isBefore(obergrenze)) {
                return 0;
            }
            int n;
            try (PreparedStatement ps = con.prepareStatement("""
                    INSERT INTO messreihe_viertelstunde_arbeit
                           (tenant_id, entity_id, messkanal, intervall_beginn, grund)
                    SELECT DISTINCT s.tenant_id, s.entity_id, s.point_key,
                           to_timestamp(floor(extract(epoch FROM s.time) / 900) * 900), 'eingang'
                      FROM device_measurement_sample s
                     WHERE s.received_at > ? AND s.received_at <= ?
                       AND """ + " " + SPUR + """
                    ON CONFLICT DO NOTHING
                    """)) {
                ps.setTimestamp(1, Timestamp.from(untergrenze));
                ps.setTimestamp(2, Timestamp.from(obergrenze));
                n = ps.executeUpdate();
            }
            // AP-08 IP-4: ein Bruch (Gerätegrenze, Neustart, Überlauf), der SEIT DEM ZEIGER eingegangen
            // ist, bildet seine Viertelstunden neu - im selben Fenster, in derselben Transaktion.
            try (PreparedStatement ps = con.prepareStatement("""
                    INSERT INTO messreihe_viertelstunde_arbeit
                           (tenant_id, entity_id, messkanal, intervall_beginn, grund)
                    SELECT tenant_id, entity_id, messkanal, beginn, 'ereignis'
                      FROM (""" + BruchEreignisse.VIERTELSTUNDEN + """
                           ) betroffen
                    ON CONFLICT DO NOTHING
                    """)) {
                ps.setTimestamp(1, Timestamp.from(untergrenze));
                ps.setTimestamp(2, Timestamp.from(obergrenze));
                ps.setTimestamp(3, Timestamp.from(jetzt.minus(RUECKRECHNUNG_TIEFE)));
                n += ps.executeUpdate();
            }
            standSetzen(con, ZEIGER, obergrenze, n, null);
            return n;
        });
    }

    // ================================================================ Rückrechnung

    /** Was eine Scheibe der Rückrechnung tat. */
    record Scheibe(boolean gefahren, int eingetragen, boolean fertig) {}

    /**
     * EINE Scheibe der einmaligen Rückrechnung: sie geht von „jetzt" rückwärts in Tagesscheiben bis
     * 90 Tage zurück und trägt die Intervalle der dort vorhandenen Rohwerte ein.
     *
     * <p>Anders als das Eintragen aus dem Eingang fragt sie über die MESSZEIT — damit schließt
     * TimescaleDB die Chunks aus, die außerhalb der Scheibe liegen.
     *
     * <p>Sie hält an, solange die Arbeitsliste voll ist: die Rückrechnung darf die Verdichtung nie
     * überholen, sonst wüchse die Liste unbegrenzt.
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
            Instant obergrenze = stand.zeitpunkt() != null
                    ? stand.zeitpunkt()
                    : ViertelstundeRegeln.ende(ViertelstundeRegeln.beginn(jetzt));
            Instant boden = ViertelstundeRegeln.beginn(jetzt.minus(RUECKRECHNUNG_TIEFE));
            Instant untergrenze = obergrenze.minus(RUECKRECHNUNG_SCHEIBE);
            if (untergrenze.isBefore(boden)) {
                untergrenze = boden;
            }
            if (!untergrenze.isBefore(obergrenze)) {
                standSetzen(con, RUECKRECHNUNG, boden, 0, FERTIG);
                return new Scheibe(false, 0, true);
            }
            int n;
            try (PreparedStatement ps = con.prepareStatement("""
                    INSERT INTO messreihe_viertelstunde_arbeit
                           (tenant_id, entity_id, messkanal, intervall_beginn, grund)
                    SELECT DISTINCT s.tenant_id, s.entity_id, s.point_key,
                           to_timestamp(floor(extract(epoch FROM s.time) / 900) * 900), 'rueckrechnung'
                      FROM device_measurement_sample s
                     WHERE s.time >= ? AND s.time < ?
                       AND """ + " " + SPUR + """
                    ON CONFLICT DO NOTHING
                    """)) {
                ps.setTimestamp(1, Timestamp.from(untergrenze));
                ps.setTimestamp(2, Timestamp.from(obergrenze));
                n = ps.executeUpdate();
            }
            boolean fertig = !untergrenze.isAfter(boden);
            standSetzen(con, RUECKRECHNUNG, untergrenze, n, fertig ? FERTIG : null);
            return new Scheibe(true, n, fertig);
        });
    }

    /** Fährt die Rückrechnung zu Ende — die Tür für Tests und für einen Betriebs-Anstoß. */
    public int rueckrechnenGanz(Instant jetzt, int hoechstensScheiben) {
        int summe = 0;
        for (int i = 0; i < hoechstensScheiben; i++) {
            Scheibe s = rueckrechnenEineScheibe(jetzt);
            summe += s.eingetragen();
            if (s.fertig() || !s.gefahren()) {
                break;
            }
        }
        return summe;
    }

    // =================================================================== Verdichten

    /**
     * Ein Eintrag der Arbeitsliste — genau eine Reihe und genau ein Intervall, samt dem GRUND,
     * aus dem er eingetragen wurde.
     *
     * <p>⚠ Der Grund entscheidet NICHT über die Frist (AP-08 IP-19). Ob {@code eingang}, {@code ereignis}
     * oder {@code rueckrechnung}: ein geschlossenes Intervall mit Nachzügler wird gemeldet und vorgeschlagen,
     * nie gebildet. Sonst bildete ein Eintrag, der den Schlüssel schon belegt ({@code ON CONFLICT DO NOTHING}
     * verschluckt dann den Eingang), einen zu spät eingetroffenen Wert still in eine Lücke. Die Rückrechnung
     * bleibt die ERSTE Bildung der Vergangenheit — geschlossene Intervalle ohne Nachzügler bildet sie weiter.
     */
    record Auftrag(UUID tenant, UUID entity, String kanal, Instant beginn, String grund) {

        SpaetankunftMelder.Intervall intervall() {
            return new SpaetankunftMelder.Intervall(tenant, entity, kanal, beginn);
        }
    }

    /**
     * Entnimmt EINEN Stapel und schreibt seine Intervalle in derselben Transaktion. Die zusätzliche
     * Spätankunft-Meldung liegt in einem Savepoint: ihr Fehler hält die normale Verdichtung nicht auf,
     * der betroffene Auftrag wird aber wieder eingereiht und deshalb niemals still neu gebildet.
     *
     * @return {@code [entnommene Intervalle, geschriebene Zeilen, gemeldete Spätankünfte, Zusatzfehler]}
     */
    int[] verdichteEinenStapel(Instant jetzt) {
        return inTransaktion(con -> {
            List<Auftrag> stapel = entnehmen(con, stapelGroesse);
            if (stapel.isEmpty()) {
                return new int[] {0, 0, 0, 0};
            }
            // AP-07 IP-13, E5: ein Rohwert für ein GESCHLOSSENES Intervall wird gespeichert,
            // gemeldet und vorgeschlagen — nie angewendet. Aussortiert wird deshalb VOR dem
            // Bilden, und genau dann, wenn es wirklich einen NACHZÜGLER gibt: einen Rohwert
            // dieses Intervalls, dessen EINGANGSZEIT nach der Frist liegt.
            //
            // Warum nicht schon „das Intervall ist geschlossen"? Weil ein geschlossenes
            // Intervall auch ohne Nachzügler wieder in der Arbeitsliste landen kann (die
            // Überlappung des Zeigers, ein Betriebs-Anstoß, die Rückrechnung). Dann ist das
            // Bilden harmlos: es entsteht dieselbe Zeile, und eine endgültige rührt der
            // Schreibsatz ohnehin nicht an. Was E5 verbietet, ist genau das eine — einen zu
            // spät eingetroffenen Wert ANWENDEN.
            //
            // AP-08 IP-19: gefragt wird JEDES geschlossene Intervall, nicht nur eines aus dem Eingang —
            // vor der Frist rechnet das System nach, nach der Frist fragt es, gleich aus welchem Grund
            // das Intervall in der Liste steht. Die Vorprüfung ist EINE Abfrage je Stapel.
            Set<SpaetankunftMelder.Intervall> mitNachzueglern = melder.mitNachzueglern(con, stapel.stream()
                    .filter(a -> TagRegeln.geschlossen(a.beginn(), jetzt))
                    .map(Auftrag::intervall)
                    .toList());
            List<Auftrag> offen = new ArrayList<>();
            List<Auftrag> spaet = new ArrayList<>();
            for (Auftrag a : stapel) {
                if (mitNachzueglern.contains(a.intervall())) {
                    spaet.add(a);
                } else {
                    offen.add(a);
                }
            }
            int[] meldung = spaet.isEmpty() ? new int[] {0, 0} : spaetankuenfteMelden(con, spaet);
            int geschrieben = offen.isEmpty() ? 0 : bilden(con, offen, jetzt);
            return new int[] {stapel.size(), geschrieben, meldung[0], meldung[1]};
        });
    }

    /**
     * Der Zusatzschreibweg des bestehenden Verdichtungsstapels. Scheitert eine Meldung, fällt der
     * gesamte Zusatz-Stapel bis zum Savepoint zurück; alle betroffenen Aufträge bleiben für den
     * nächsten Takt liegen. Die normale Verdichtung der übrigen Aufträge darf trotzdem festschreiben.
     */
    private int[] spaetankuenfteMelden(Connection con, List<Auftrag> auftraege) throws SQLException {
        Savepoint punkt = con.setSavepoint();
        try {
            for (Auftrag a : auftraege) {
                if (!melder.melden(con, a.tenant(), a.entity(), a.kanal(), a.beginn()).vorgeschlagen()) {
                    throw new SQLException("erkannte Spätankunft wurde nicht vorgeschlagen");
                }
            }
            con.releaseSavepoint(punkt);
            return new int[] {auftraege.size(), 0};
        } catch (SQLException | RuntimeException e) {
            con.rollback(punkt);
            con.releaseSavepoint(punkt);
            wiedereinreihen(con, auftraege);
            spaetankunftFehler.incrementAndGet();
            io.micrometer.core.instrument.Metrics.counter(
                    "voltpilot_uems_spaetankunft_total", "ergebnis", "fehler").increment();
            log.warn("UEMS Spätankunft: Zusatz-Stapel mit {} Intervallen zurückgerollt — später erneut: {}",
                    auftraege.size(), e.toString());
            return new int[] {0, 1};
        }
    }

    private static void wiedereinreihen(Connection con, List<Auftrag> auftraege) throws SQLException {
        try (PreparedStatement ps = con.prepareStatement("""
                INSERT INTO messreihe_viertelstunde_arbeit
                       (tenant_id, entity_id, messkanal, intervall_beginn, grund)
                VALUES (?, ?, ?, ?, ?)
                ON CONFLICT DO NOTHING
                """)) {
            for (Auftrag a : auftraege) {
                ps.setObject(1, a.tenant());
                ps.setObject(2, a.entity());
                ps.setString(3, a.kanal());
                ps.setTimestamp(4, Timestamp.from(a.beginn()));
                ps.setString(5, a.grund());
                ps.addBatch();
            }
            ps.executeBatch();
        }
    }

    /**
     * Die Entnahme: {@code FOR UPDATE SKIP LOCKED} — zwei gleichzeitige Läufe bekommen disjunkte
     * Stapel, keiner wartet auf den anderen, und keiner verliert einen Eintrag (die Entnahme rollt
     * mit der Transaktion zurück). Das ÄLTESTE Intervall zuerst, damit eine Nachlieferung nicht
     * hinter der laufenden Verdichtung verhungert.
     */
    private List<Auftrag> entnehmen(Connection con, int limit) throws SQLException {
        List<Auftrag> auftraege = new ArrayList<>();
        try (PreparedStatement ps = con.prepareStatement("""
                DELETE FROM messreihe_viertelstunde_arbeit a
                 USING (SELECT tenant_id, entity_id, messkanal, intervall_beginn
                          FROM messreihe_viertelstunde_arbeit
                         ORDER BY intervall_beginn, eingetragen_am
                         LIMIT ?
                         FOR UPDATE SKIP LOCKED) c
                 WHERE a.tenant_id = c.tenant_id AND a.entity_id = c.entity_id
                   AND a.messkanal = c.messkanal AND a.intervall_beginn = c.intervall_beginn
                RETURNING a.tenant_id, a.entity_id, a.messkanal, a.intervall_beginn, a.grund
                """)) {
            ps.setInt(1, limit);
            try (ResultSet rs = ps.executeQuery()) {
                while (rs.next()) {
                    auftraege.add(new Auftrag(rs.getObject(1, UUID.class), rs.getObject(2, UUID.class),
                            rs.getString(3), rs.getTimestamp(4).toInstant(), rs.getString(5)));
                }
            }
        }
        return auftraege;
    }

    private int arbeitZaehlen(Connection con) throws SQLException {
        try (PreparedStatement ps = con.prepareStatement(
                "SELECT count(*) FROM messreihe_viertelstunde_arbeit");
                ResultSet rs = ps.executeQuery()) {
            rs.next();
            return rs.getInt(1);
        }
    }

    // ------------------------------------------------------------------- Der Kern

    /** Ein Rohwert, wie ihn die Verdichtung sieht. */
    record Roh(Instant zeit, Instant eingang, String qualitaet, BigDecimal zahl, String wort,
            UUID box, UUID einbau, Long fassung, String katalog, String rolle, String wertart,
            String verdichtungsart, String zustellart, UUID siteId) {

        boolean gut() {
            return "good".equals(qualitaet);
        }
    }

    /**
     * Ein Ereignis der Reihe im Intervall — samt der Anker, die es NENNT: eine Gerätegrenze nennt
     * das alte und das neue Einbau-Kennzeichen, eine Übergabe die alte und die neue Box.
     */
    record Ereignis(String art, Instant zeit, BigDecimal endstand, BigDecimal anfangsstand,
            Long verlustS, String einbauAlt, String einbauNeu, UUID boxAlt, UUID boxNeu) {}

    private int bilden(Connection con, List<Auftrag> stapel, Instant jetzt) throws SQLException {
        int geschrieben = 0;
        try (PreparedStatement ps = con.prepareStatement(upsertSql())) {
            for (Object[] werte : zeilen(con, stapel, jetzt, null)) {
                if (werte == null) {
                    continue;
                }
                for (int p = 0; p < werte.length; p++) {
                    ps.setObject(p + 1, werte[p]);
                }
                geschrieben += ps.executeUpdate();
            }
        }
        return geschrieben;
    }

    /**
     * AP-08 IP-14: was dieser Lauf für EINE Viertelstunde heute schriebe — mit denselben Ladewegen und
     * derselben Rechenregel wie {@link #bilden}, aber geschrieben wird nichts. Die Vorschau „neu“ eines
     * Korrektur-Vorschlags ist genau diese Zeile; sie rechnet nichts Eigenes. {@code null}, wenn die
     * Viertelstunde keinen einzigen Rohwert hat (eine Lücke ist keine Null).
     *
     * @param umdeuten die Zähler-Deklaration, mit der gerechnet wird — {@code null} = die gespeicherte; eine
     *     Umklassifizierung (E4) rechnet mit einem bestätigten Wertebereich bzw. ohne einen
     * @return die Spalten der Zeile nach Namen
     */
    Map<String, Object> waereZeile(Connection con, UUID tenant, UUID entity, String kanal, Instant beginn,
            Instant jetzt, UnaryOperator<ZaehlerDeklaration> umdeuten) throws SQLException {
        Object[] werte = zeilen(con, List.of(new Auftrag(tenant, entity, kanal, beginn, "vorschlag")), jetzt,
                umdeuten).get(0);
        if (werte == null) {
            return null;
        }
        Map<String, Object> aus = new LinkedHashMap<>();
        for (int i = 0; i < SPALTEN.length; i++) {
            aus.put(SPALTEN[i], werte[i]);
        }
        return aus;
    }

    /** Die Zeilen eines Stapels in seiner Reihenfolge, {@code null} für ein Intervall ohne Rohwert. */
    private List<Object[]> zeilen(Connection con, List<Auftrag> stapel, Instant jetzt,
            UnaryOperator<ZaehlerDeklaration> umdeuten) throws SQLException {
        // 1. Die Erwartung ZUM INTERVALL (IP-10): Fassung -> Auswahl -> Katalog -> 300 s.
        Map<Integer, KadenzRegeln.Wirksam> kadenzen = kadenzJeAuftrag(con, stapel);
        // 2. Die Rohwerte, je Auftrag mit dem Rückblick einer Kadenz (Z1 braucht ihn für den
        //    Stand an der Anfangsgrenze).
        Map<Integer, List<Roh>> rohe = rohwerte(con, stapel, kadenzen);
        //    … und ob eine Quellenbindung die Reihe als Energie liest (Herleitung `integration`, E5).
        Set<Integer> integrieren = integrationJeAuftrag(con, stapel);
        // 3. Die Ereignisse im Intervall …
        Map<Integer, List<Ereignis>> ereignisse = ereignisse(con, stapel);
        // … und die Einbau-Kennzeichen, die sie nennen, als Einbau aufgelöst (A5).
        Map<String, UUID> einbauten = einbautenJeKennzeichen(con, stapel, ereignisse);
        // 4. Was die Zählerreihe rechenbar macht (AP-08 IP-4, Z6/Z7) - dieselbe Quelle wie der Writer.
        Map<Integer, ZaehlerDeklaration> deklarationen = deklarationen(con, stapel);
        // 5. Einheit und Zeitzone, in denen die Kennzeichen sprechen - EIN Träger je Reihe.
        Map<Integer, ReihenKontext> kontexte = kontexte(con, stapel);

        List<Object[]> aus = new ArrayList<>();
        for (int i = 0; i < stapel.size(); i++) {
            ZaehlerDeklaration deklaration = deklarationen.getOrDefault(i, ZaehlerDeklaration.NICHTS);
            aus.add(zeile(stapel.get(i), kontexte.get(i), kadenzen.get(i),
                    rohe.getOrDefault(i, List.of()), ereignisse.getOrDefault(i, List.of()),
                    einbauten, integrieren.contains(i),
                    umdeuten == null ? deklaration : umdeuten.apply(deklaration), jetzt));
        }
        return aus;
    }

    /**
     * Die eine Zeile aus der MENGE der Rohwerte eines Intervalls — reihenfolge-unabhängig, nie
     * inkrementell fortgeschrieben (§4.5 Reihenfolge Nr. 3). {@code null}, wenn das Intervall
     * keinen einzigen Rohwert hat: eine Lücke ist keine Null und wird nicht geschrieben.
     */
    private Object[] zeile(Auftrag a, ReihenKontext kontext, KadenzRegeln.Wirksam kadenz, List<Roh> fenster,
            List<Ereignis> alleEreignisse, Map<String, UUID> einbauten, boolean integrieren,
            ZaehlerDeklaration deklaration, Instant jetzt) {
        Instant von = a.beginn();
        Instant bis = ViertelstundeRegeln.ende(von);
        // Gezählt und verankert wird, was in [von, bis) liegt; die Regel bekommt auch einen Bruch
        // GENAU auf bis - sie wendet ihn in (von, bis] an (Z4: ein Wechsel um 10:45 gehört zu 10:30).
        List<Ereignis> ereignisse = alleEreignisse.stream().filter(e -> e.zeit().isBefore(bis)).toList();
        List<Roh> imIntervall = fenster.stream()
                .filter(r -> !r.zeit().isBefore(von) && r.zeit().isBefore(bis))
                .toList();
        if (imIntervall.isEmpty()) {
            return null;
        }
        List<Roh> gute = imIntervall.stream().filter(Roh::gut).toList();
        Roh bezug = gute.isEmpty() ? imIntervall.get(imIntervall.size() - 1) : gute.get(gute.size() - 1);

        String wertart = wertart(bezug);
        Duration kadenzD = Duration.ofSeconds(kadenz.erwartetS());

        // Die Rechenregel von AP-08 wird AUFGERUFEN, nie nachgebaut. Das Fenster reicht zwei
        // Kadenzen über das Intervall hinaus (M4: ein Wert hält bis zum nächsten, höchstens zwei
        // Kadenzen); die Zählerstand- und Intervall-Regeln sehen weiter genau (Beginn − Kadenz, Ende].
        String regel = ViertelstundeRegeln.regelWort(wertart);
        boolean momentan = "momentanwert".equals(regel);
        Instant regelVon = von.minus(kadenzD);
        List<VerbrauchRegeln.Rohwert> werte = fenster.stream()
                .filter(r -> r.zahl() != null)
                .filter(r -> momentan || (r.zeit().isAfter(regelVon) && !r.zeit().isAfter(bis)))
                .map(r -> new VerbrauchRegeln.Rohwert(r.zeit(), r.zahl(), r.gut()))
                .toList();
        VerbrauchRegeln.Ergebnis e;
        // AP-08 IP-3: Momentanwert und Intervallmenge in der Form, die Tag, Monat und Jahr brauchen
        // (ungerundete Summe, Energie, gemessene Zeit, Lücke im Intervall) — dieselbe Regel.
        VerbrauchRegeln.Werteteil teil = null;
        if (momentan) {
            teil = VerbrauchRegeln.momentanwertTeil(werte, von, bis, kadenzD, integrieren);
            e = teil.teil().ergebnis();
        } else if ("intervallmenge".equals(regel)) {
            teil = VerbrauchRegeln.intervallmengeTeil(werte, von, bis, kadenzD, ViertelstundeRegeln.FAKTOR_DER_FASSUNG);
            e = teil.teil().ergebnis();
        } else if (regel != null) {
            e = VerbrauchRegeln.ergebnis(kontext, regel, werte, von, bis, kadenzD,
                    fuerVerbrauchRegeln(alleEreignisse, deklaration), ViertelstundeRegeln.FAKTOR_DER_FASSUNG,
                    deklaration.modulFuer(kadenzD), deklaration.hoechstzuwachsFuer(kadenzD), false);
        } else {
            // Zustands-, Bitfeld- und Textreihen haben keine Regel von AP-08: kein Mittel, keine
            // Menge. Die Abdeckung aber gibt es — sie wird AUFGERUFEN, nicht nachgerechnet.
            int erwartet = VerbrauchRegeln.erwarteteWerte(von, bis, kadenzD);
            e = new VerbrauchRegeln.Ergebnis(null, null, null, null, null,
                    gute.isEmpty() ? VerbrauchRegeln.KEINE_WERTE : VerbrauchRegeln.UNVOLLSTAENDIG,
                    gute.size(), erwartet, null, List.of()).mitAbdeckung(erwartet);
        }

        boolean zaehler = "zaehlerstand".equals(regel);
        VerbrauchRegeln.Rohwert standAnfang = zaehler
                ? VerbrauchRegeln.periodenstand(werte, von, kadenzD) : null;
        VerbrauchRegeln.Rohwert standEnde = zaehler
                ? VerbrauchRegeln.periodenstand(werte, bis, kadenzD) : null;

        Roh erster = gute.isEmpty() ? null : gute.get(0);
        Roh letzter = gute.isEmpty() ? null : gute.get(gute.size() - 1);

        // Die Anker kommen aus den WERTEN — und aus den Ereignissen, die einen Wechsel NENNEN
        // (§4.4: „bei Wechsel im Intervall: geraet_einbau_2 + Ereignis device_boundary"; ebenso
        // box_2 + handover). Ein Wechsel gegen Ende des Intervalls hat sonst gar keinen Wert des
        // Nachfolgers mehr in DIESEM Intervall (A5: Z-5b liefert erst um 10:47, A6: Box Halle 2
        // erst um 07:31:10) — der zweite Anker stünde nicht da, obwohl er belegt ist.
        List<Zeitanker> einbauFolge = new ArrayList<>();
        List<Zeitanker> boxFolge = new ArrayList<>();
        for (Roh r : gute) {
            einbauFolge.add(new Zeitanker(r.zeit(), r.einbau()));
            boxFolge.add(new Zeitanker(r.zeit(), r.box()));
        }
        for (Ereignis ev : ereignisse) {
            einbauFolge.add(new Zeitanker(ev.zeit(), einbauten.get(a.tenant() + "|" + ev.einbauAlt())));
            einbauFolge.add(new Zeitanker(ev.zeit(), einbauten.get(a.tenant() + "|" + ev.einbauNeu())));
            boxFolge.add(new Zeitanker(ev.zeit(), ev.boxAlt()));
            boxFolge.add(new Zeitanker(ev.zeit(), ev.boxNeu()));
        }
        ViertelstundeRegeln.Anker<UUID> einbau = ViertelstundeRegeln.anker(nachZeit(einbauFolge));
        ViertelstundeRegeln.Anker<UUID> box = ViertelstundeRegeln.anker(nachZeit(boxFolge));

        Set<UUID> sites = new LinkedHashSet<>(imIntervall.stream().map(Roh::siteId).filter(x -> x != null).toList());
        UUID site = sites.size() == 1 ? sites.iterator().next() : null;

        int nachgeliefert = (int) imIntervall.stream()
                .filter(r -> ViertelstundeRegeln.NACHGELIEFERT.equals(r.zustellart())).count();
        Instant letzterEingang = imIntervall.stream().map(Roh::eingang)
                .filter(x -> x != null).max(Instant::compareTo).orElse(null);

        Map<String, Object> werteJeSpalte = new LinkedHashMap<>();
        werteJeSpalte.put("intervall_beginn", Timestamp.from(von));
        werteJeSpalte.put("tenant_id", a.tenant());
        werteJeSpalte.put("entity_id", a.entity());
        werteJeSpalte.put("messkanal", a.kanal());
        werteJeSpalte.put("site_id", site);
        werteJeSpalte.put("wertart", wertart);
        werteJeSpalte.put("stand_anfang", standAnfang == null ? null : standAnfang.wert());
        werteJeSpalte.put("stand_anfang_zeit", standAnfang == null ? null : Timestamp.from(standAnfang.zeit()));
        werteJeSpalte.put("stand_ende", standEnde == null ? null : standEnde.wert());
        werteJeSpalte.put("stand_ende_zeit", standEnde == null ? null : Timestamp.from(standEnde.zeit()));
        werteJeSpalte.put("summe", teil == null ? null : teil.summe());
        werteJeSpalte.put("mittel", e.mittel());
        werteJeSpalte.put("min_wert", e.min());
        werteJeSpalte.put("max_wert", e.max());
        werteJeSpalte.put("erster_wert", erster == null ? null : erster.zahl());
        werteJeSpalte.put("erster_text", erster == null ? null : erster.wort());
        werteJeSpalte.put("erster_zeit", erster == null ? null : Timestamp.from(erster.zeit()));
        werteJeSpalte.put("letzter_wert", letzter == null ? null : letzter.zahl());
        werteJeSpalte.put("letzter_text", letzter == null ? null : letzter.wort());
        werteJeSpalte.put("letzter_zeit", letzter == null ? null : Timestamp.from(letzter.zeit()));
        // AP-08 IP-2: die MENGE, ihr Zustand und die Klartext-Kennzeichen — genau das, was die
        // Regel ohnehin schon ausgerechnet hat und was bis hierher weggeworfen wurde. NULL heißt
        // „keine Menge bildbar", nie 0; ohne Regel (state/bitfield/text) gibt es gar keine
        // Aussage — dann steht auch kein Zustand da, statt „unvollständig" zu behaupten.
        werteJeSpalte.put("menge", regel == null ? null : e.menge());
        werteJeSpalte.put("menge_zustand", regel == null ? null : e.zustand());
        werteJeSpalte.put("kennzeichen",
                ViertelstundeRegeln.kennzeichenJson(regel == null ? List.of() : e.kennzeichen()));
        werteJeSpalte.put("faktor", ViertelstundeRegeln.FAKTOR_DER_FASSUNG);
        // E5: die Energie aus Leistung — nur mit Bindung `integration`, nur mit Kennzeichen (das die
        // Regel schon in `kennzeichen` gesetzt hat), nie in `menge` (M6).
        werteJeSpalte.put("energie", teil == null ? null : teil.energie());
        werteJeSpalte.put("gemessen_s", momentan ? (int) teil.gemessenS() : null);
        werteJeSpalte.put("luecke_innen", momentan ? teil.lueckeInnen() : null);
        werteJeSpalte.put("erhalten", e.erhalten());
        werteJeSpalte.put("erwartet", e.erwartet());
        werteJeSpalte.put("abdeckung_prozent", e.abdeckungProzent());
        werteJeSpalte.put("kadenz_s", kadenz.erwartetS());
        werteJeSpalte.put("kadenz_herkunft", kadenz.herkunft().code());
        werteJeSpalte.put("n_good", zaehleQualitaet(imIntervall, "good"));
        werteJeSpalte.put("n_uncertain", zaehleQualitaet(imIntervall, "uncertain"));
        werteJeSpalte.put("n_invalid", zaehleQualitaet(imIntervall, "invalid"));
        werteJeSpalte.put("n_stale", zaehleQualitaet(imIntervall, "stale"));
        werteJeSpalte.put("n_device_error", zaehleQualitaet(imIntervall, "device_error"));
        werteJeSpalte.put("geraet_einbau", einbau.erster());
        werteJeSpalte.put("geraet_einbau_2", einbau.zweiter());
        werteJeSpalte.put("geraet_einbau_weitere", einbau.weitere());
        werteJeSpalte.put("box", box.erster());
        werteJeSpalte.put("box_2", box.zweiter());
        werteJeSpalte.put("box_weitere", box.weitere());
        werteJeSpalte.put("fassung", bezug.fassung());
        werteJeSpalte.put("katalog", bezug.katalog());
        werteJeSpalte.put("rolle", bezug.rolle());
        werteJeSpalte.put("zustand", ViertelstundeRegeln.VORLAEUFIG);
        werteJeSpalte.put("endgueltig_ab", Timestamp.from(ViertelstundeRegeln.endgueltigAb(von)));
        // Die Uhr DES LAUFS, nicht die der Maschine: seit AP-07 IP-13 hängt der Tageslauf
        // seinen Zeiger an diese Spalte, und ein Lauf muss eine einzige Zeit haben.
        werteJeSpalte.put("berechnet_am", Timestamp.from(jetzt));
        werteJeSpalte.put("version", 1);
        werteJeSpalte.put("n_nachgeliefert", nachgeliefert);
        werteJeSpalte.put("letzte_eingangszeit", letzterEingang == null ? null : Timestamp.from(letzterEingang));
        werteJeSpalte.put("zustellart", ViertelstundeRegeln.zustellart(
                imIntervall.stream().map(Roh::zustellart).filter(x -> x != null).toList()));
        werteJeSpalte.put("ereignisse", ereignisZaehlung(ereignisse));

        Object[] reihe = new Object[SPALTEN.length];
        for (int i = 0; i < SPALTEN.length; i++) {
            reihe[i] = werteJeSpalte.get(SPALTEN[i]);
        }
        return reihe;
    }

    /**
     * AP-08 IP-13: die RECHENGRUNDLAGE einer Viertelstunde für {@link VerbrauchRegeln} — dieselben
     * Rohwerte (mit dem Rückblick einer Kadenz), Ereignisse, Kadenz, Deklaration und derselbe Träger, die
     * {@link #zeile} der Regel gibt, aber ohne zu rechnen und ohne zu schreiben. Der Ersatzwert-Lauf rechnet
     * damit einen nachgetragenen Ablesestand (E7 d) über Z4 — kein zweiter Ladeweg für dieselbe Zahl.
     *
     * @param regel die Rechenregel der Reihe ({@link ViertelstundeRegeln#regelWort}), {@code null} = keine
     */
    record Grundlage(String regel, List<VerbrauchRegeln.Rohwert> werte, Collection<VerbrauchRegeln.Ereignis> ereignisse,
            Duration kadenz, ReihenKontext kontext, BigDecimal modul, BigDecimal hoechstzuwachs) {}

    /**
     * Die Rechengrundlage der Viertelstunde ab {@code beginn}; {@code null}, wenn sie keinen einzigen Rohwert
     * (mehr) hat — die Rohwerte haben 90 Tage Aufbewahrung, die Viertelstunden zehn Jahre.
     */
    Grundlage grundlage(Connection con, UUID tenant, UUID entity, String kanal, Instant beginn) throws SQLException {
        List<Auftrag> stapel = List.of(new Auftrag(tenant, entity, kanal, beginn, "ersatzwert"));
        Map<Integer, KadenzRegeln.Wirksam> kadenzen = kadenzJeAuftrag(con, stapel);
        List<Roh> fenster = rohwerte(con, stapel, kadenzen).getOrDefault(0, List.of());
        Instant bis = ViertelstundeRegeln.ende(beginn);
        List<Roh> imIntervall = fenster.stream()
                .filter(r -> !r.zeit().isBefore(beginn) && r.zeit().isBefore(bis))
                .toList();
        if (imIntervall.isEmpty()) {
            return null;
        }
        List<Roh> gute = imIntervall.stream().filter(Roh::gut).toList();
        Roh bezug = gute.isEmpty() ? imIntervall.get(imIntervall.size() - 1) : gute.get(gute.size() - 1);
        Duration kadenzD = Duration.ofSeconds(kadenzen.get(0).erwartetS());
        Instant regelVon = beginn.minus(kadenzD);
        List<VerbrauchRegeln.Rohwert> werte = fenster.stream()
                .filter(r -> r.zahl() != null)
                .filter(r -> r.zeit().isAfter(regelVon) && !r.zeit().isAfter(bis))
                .map(r -> new VerbrauchRegeln.Rohwert(r.zeit(), r.zahl(), r.gut()))
                .toList();
        ZaehlerDeklaration deklaration = deklarationen(con, stapel).getOrDefault(0, ZaehlerDeklaration.NICHTS);
        return new Grundlage(ViertelstundeRegeln.regelWort(wertart(bezug)), werte,
                fuerVerbrauchRegeln(ereignisse(con, stapel).getOrDefault(0, List.of()), deklaration), kadenzD,
                kontexte(con, stapel).get(0), deklaration.modulFuer(kadenzD), deklaration.hoechstzuwachsFuer(kadenzD));
    }

    /**
     * Die Wertart, mit der das Intervall gebildet wurde: die NACHGESCHLAGENE des Bezugswerts
     * ({@code value_kind}, IP-7), sonst das Vertragswort seiner Verdichtungsart — dieselbe
     * Filterung, die der Writer anwendet ({@code event} und {@code none} des Katalogs sind keine
     * Wertart). {@code null} heißt „keine", nie eine geratene.
     */
    private static String wertart(Roh bezug) {
        if (bezug.wertart() != null) {
            return bezug.wertart();
        }
        String art = bezug.verdichtungsart();
        return art != null && Set.of("counter", "gauge", "state", "bitfield", "text").contains(art) ? art : null;
    }

    /** Ein Anker mit dem Zeitpunkt, an dem er belegt ist (Messzeit bzw. Zeit des Ereignisses). */
    private record Zeitanker(Instant zeit, UUID anker) {}

    /**
     * Die Anker in der Reihenfolge der ZEIT — stabil, damit „alt vor neu" desselben Ereignisses
     * erhalten bleibt. So steht in {@code box} die Box, die im Intervall zuerst zuständig war, und
     * in {@code box_2} die, die übernommen hat (A6) — nicht umgekehrt, bloß weil der erste Wert
     * der neuen Box zufällig vor dem Ereignis in der Liste stand.
     */
    private static List<UUID> nachZeit(List<Zeitanker> folge) {
        return folge.stream()
                .sorted(java.util.Comparator.comparing(Zeitanker::zeit))
                .map(Zeitanker::anker)
                .toList();
    }

    private static int zaehleQualitaet(List<Roh> werte, String q) {
        return (int) werte.stream().filter(r -> q.equals(r.qualitaet())).count();
    }

    /**
     * Die Gerätegrenzen und Neustarts als Eingang von {@link VerbrauchRegeln} (Z4/Z7). Der
     * Zählverlust eines Neustarts kommt aus der Meldung, sonst aus der Deklaration der Reihe, sonst
     * ist er „bis zu 255 s“ — geschätzt oder hochgerechnet wird er nie.
     */
    static Collection<VerbrauchRegeln.Ereignis> fuerVerbrauchRegeln(List<Ereignis> ereignisse,
            ZaehlerDeklaration deklaration) {
        List<VerbrauchRegeln.Ereignis> aus = new ArrayList<>();
        for (Ereignis e : ereignisse) {
            if (VerbrauchRegeln.Ereignis.GERAETEGRENZE.equals(e.art())) {
                aus.add(new VerbrauchRegeln.Ereignis(e.art(), e.zeit(), e.endstand(), e.anfangsstand(), 0));
            } else if (VerbrauchRegeln.Ereignis.NEUSTART.equals(e.art())) {
                aus.add(new VerbrauchRegeln.Ereignis(e.art(), e.zeit(), null, null,
                        e.verlustS() == null ? deklaration.neustartVerlust() : e.verlustS()));
            }
        }
        return aus;
    }

    /**
     * Der Träger je Auftrag: die Einheit des Messkanals aus dem Katalog und die Zeitzone des Standorts
     * zum (UTC-)Tag des Intervalls — dieselbe Kette wie der Tageslauf, in EINER Abfrage für den Stapel.
     */
    private Map<Integer, ReihenKontext> kontexte(Connection con, List<Auftrag> stapel) throws SQLException {
        List<ReihenKontext.Frage> fragen = stapel.stream()
                .map(a -> new ReihenKontext.Frage(a.tenant(), a.entity(),
                        LocalDate.ofInstant(a.beginn(), ZoneOffset.UTC)))
                .toList();
        Map<Integer, ReihenKontext.Zeitzone> zonen = ReihenKontext.zeitzonen(con, fragen);
        Map<Integer, ReihenKontext> aus = new HashMap<>();
        for (int i = 0; i < stapel.size(); i++) {
            aus.put(i, ReihenKontext.aus(katalog, stapel.get(i).kanal(), zonen.get(i).zone()));
        }
        return aus;
    }

    /** Die Zählung je Art als jsonb-Text; eine Art ohne Ereignis steht gar nicht erst darin. */
    private static String ereignisZaehlung(List<Ereignis> ereignisse) {
        Map<String, Integer> zahl = new TreeMap<>();
        for (Ereignis e : ereignisse) {
            if (ViertelstundeRegeln.GEZAEHLTE_EREIGNISSE.contains(e.art())) {
                zahl.merge(e.art(), 1, Integer::sum);
            }
        }
        StringBuilder b = new StringBuilder("{");
        for (Map.Entry<String, Integer> x : zahl.entrySet()) {
            if (b.length() > 1) {
                b.append(',');
            }
            b.append('"').append(x.getKey()).append("\":").append(x.getValue());
        }
        return b.append('}').toString();
    }

    // ------------------------------------------------------------------- Die Züge

    private Map<Integer, KadenzRegeln.Wirksam> kadenzJeAuftrag(Connection con, List<Auftrag> stapel)
            throws SQLException {
        Map<Integer, Integer> fassung = fassungJeAuftrag(con, stapel);
        Map<String, Integer> auswahl = auswahlKadenz(con, stapel);
        Map<Integer, KadenzRegeln.Wirksam> aus = new HashMap<>();
        for (int i = 0; i < stapel.size(); i++) {
            Auftrag a = stapel.get(i);
            MeasurementCatalog.Point p = katalog.resolve(a.kanal());
            aus.put(i, KadenzRegeln.wirksam(fassung.get(i),
                    auswahl.get(a.tenant() + "|" + a.entity() + "|" + a.kanal()),
                    p == null ? null : p.defaultCadenceS()));
        }
        return aus;
    }

    /**
     * Die Aufträge, deren Reihe eine Quellenbindung als ENERGIE AUS LEISTUNG liest (Herleitung
     * {@code integration}, AP-04 Regel 7 — für AP-08 gekennzeichnet): nur für sie wird integriert
     * (E5). Ohne eine solche Bindung entsteht keine Energie — eine Spannung oder Temperatur wird nie
     * „integriert", bloß weil sie ein Momentanwert ist. Es genügt eine Bindung, deren Gültigkeit das
     * Intervall berührt (halboffen, auf die Minute). ⚠ Eine Bindung mit ANTEIL (AP-08 IP-7) zählt
     * nicht: die Reihe ist der ganze Vorzeichen-Wert, und seine Energie wäre ein stiller Saldo (E12) —
     * die Energie je Anteil entsteht nur je Rohwert ({@link QuelleAnteilWerte}).
     */
    private Set<Integer> integrationJeAuftrag(Connection con, List<Auftrag> stapel) throws SQLException {
        Set<Integer> aus = new java.util.HashSet<>();
        String sql = """
                WITH frage(nr, tenant_id, entity_id, messkanal, von, bis) AS (VALUES %s)
                SELECT DISTINCT f.nr
                  FROM frage f
                  JOIN messstelle_quelle q
                    ON q.tenant_id = f.tenant_id AND q.entity_id = f.entity_id AND q.kanal = f.messkanal
                   AND q.herleitung = 'integration' AND q.anteil IS NULL
                   AND q.gueltig_ab < f.bis AND (q.gueltig_bis IS NULL OR q.gueltig_bis > f.von)
                """.formatted(werteListe(stapel.size(),
                        "?::int, ?::uuid, ?::uuid, ?::text, ?::timestamptz, ?::timestamptz", 6));
        try (PreparedStatement ps = con.prepareStatement(sql)) {
            int p = 1;
            for (int i = 0; i < stapel.size(); i++) {
                Auftrag a = stapel.get(i);
                ps.setInt(p++, i);
                ps.setObject(p++, a.tenant());
                ps.setObject(p++, a.entity());
                ps.setString(p++, a.kanal());
                ps.setTimestamp(p++, Timestamp.from(a.beginn()));
                ps.setTimestamp(p++, Timestamp.from(ViertelstundeRegeln.ende(a.beginn())));
            }
            try (ResultSet rs = ps.executeQuery()) {
                while (rs.next()) {
                    aus.add(rs.getInt(1));
                }
            }
        }
        return aus;
    }

    /**
     * Die zum INTERVALLBEGINN geltende Kadenz-Fassung je Auftrag — Spiegelbild von
     * {@code QuelleKadenzRepository.jeKanal}, nur über die BYPASSRLS-Verbindung und je Zeitpunkt:
     * lesen mehrere Bindungen denselben Messkanal, gilt die SCHNELLSTE ihrer Fassungen.
     */
    private Map<Integer, Integer> fassungJeAuftrag(Connection con, List<Auftrag> stapel) throws SQLException {
        Map<Integer, Integer> aus = new HashMap<>();
        String sql = """
                WITH frage(nr, tenant_id, entity_id, messkanal, zeitpunkt) AS (VALUES %s)
                SELECT f.nr, min(k.erwartet_s)
                  FROM frage f
                  JOIN messstelle_quelle q
                    ON q.tenant_id = f.tenant_id AND q.entity_id = f.entity_id AND q.kanal = f.messkanal
                   AND q.gueltig_ab <= f.zeitpunkt AND (q.gueltig_bis IS NULL OR q.gueltig_bis > f.zeitpunkt)
                  JOIN quelle_kadenz k
                    ON k.messstelle_quelle_id = q.id AND k.tenant_id = q.tenant_id
                   AND k.gueltig_ab <= f.zeitpunkt AND (k.gueltig_bis IS NULL OR k.gueltig_bis > f.zeitpunkt)
                 GROUP BY f.nr
                """.formatted(werteListe(stapel.size(), "?::int, ?::uuid, ?::uuid, ?::text, ?::timestamptz", 5));
        try (PreparedStatement ps = con.prepareStatement(sql)) {
            int p = 1;
            for (int i = 0; i < stapel.size(); i++) {
                Auftrag a = stapel.get(i);
                ps.setInt(p++, i);
                ps.setObject(p++, a.tenant());
                ps.setObject(p++, a.entity());
                ps.setString(p++, a.kanal());
                ps.setTimestamp(p++, Timestamp.from(a.beginn()));
            }
            try (ResultSet rs = ps.executeQuery()) {
                while (rs.next()) {
                    aus.put(rs.getInt(1), rs.getInt(2));
                }
            }
        }
        return aus;
    }

    /** Die Kadenz der Mess-Selektion je Messkanal — das zweite Glied der Vorgabe-Kette. */
    private Map<String, Integer> auswahlKadenz(Connection con, List<Auftrag> stapel) throws SQLException {
        List<Auftrag> reihen = stapel.stream()
                .collect(java.util.stream.Collectors.toMap(
                        a -> a.tenant() + "|" + a.entity() + "|" + a.kanal(), a -> a, (x, y) -> x,
                        LinkedHashMap::new))
                .values().stream().toList();
        Map<String, Integer> aus = new HashMap<>();
        String sql = """
                WITH frage(tenant_id, entity_id, messkanal) AS (VALUES %s)
                SELECT f.tenant_id, f.entity_id, f.messkanal, min(s.cadence_s)
                  FROM frage f
                  JOIN device_measurement_selection s
                    ON s.tenant_id = f.tenant_id AND s.entity_id = f.entity_id AND s.point_key = f.messkanal
                 GROUP BY 1, 2, 3
                """.formatted(werteListe(reihen.size(), "?::uuid, ?::uuid, ?::text", 3));
        try (PreparedStatement ps = con.prepareStatement(sql)) {
            int p = 1;
            for (Auftrag a : reihen) {
                ps.setObject(p++, a.tenant());
                ps.setObject(p++, a.entity());
                ps.setString(p++, a.kanal());
            }
            try (ResultSet rs = ps.executeQuery()) {
                while (rs.next()) {
                    int kadenz = rs.getInt(4);
                    if (!rs.wasNull()) {
                        aus.put(rs.getObject(1, UUID.class) + "|" + rs.getObject(2, UUID.class)
                                + "|" + rs.getString(3), kadenz);
                    }
                }
            }
        }
        return aus;
    }

    /**
     * Die Rohwerte je Auftrag: {@code (Beginn − 2 × Kadenz, Ende + 2 × Kadenz]}. Der Rückblick einer
     * Kadenz ist Z1 ({@code Stand(t)} ist der letzte gute Wert in {@code (t − Kadenz, t]}), das Ende
     * einschließlich ebenso — {@code Stand(bis)} liegt genau auf der Grenze. Die zweite Kadenz
     * davor und die zwei danach braucht seit AP-08 IP-3 nur der Momentanwert (M4: ein Wert hält bis
     * zum nächsten guten Wert, höchstens zwei Kadenzen, auch über die Grenze).
     */
    private Map<Integer, List<Roh>> rohwerte(Connection con, List<Auftrag> stapel,
            Map<Integer, KadenzRegeln.Wirksam> kadenzen) throws SQLException {
        Map<Integer, List<Roh>> aus = new HashMap<>();
        Instant von = null;
        Instant bis = null;
        List<Instant[]> fenster = new ArrayList<>();
        for (int i = 0; i < stapel.size(); i++) {
            Instant b = stapel.get(i).beginn();
            long reichweite = (long) VerbrauchRegeln.HALTEN_FAKTOR * kadenzen.get(i).erwartetS();
            Instant f0 = b.minusSeconds(reichweite);
            Instant f1 = ViertelstundeRegeln.ende(b).plusSeconds(reichweite);
            fenster.add(new Instant[] {f0, f1});
            von = von == null || f0.isBefore(von) ? f0 : von;
            bis = bis == null || f1.isAfter(bis) ? f1 : bis;
        }
        String sql = """
                WITH fenster(nr, tenant_id, entity_id, messkanal, von, bis) AS (VALUES %s)
                SELECT f.nr, s.time, s.received_at, s.quality,
                       coalesce(s.decoded_numeric, s.raw_numeric) AS zahl,
                       coalesce(s.decoded_text, s.raw_text) AS wort,
                       s.device_id, s.device_install_id, s.applied_revision, s.catalog_version,
                       s.role, s.value_kind, s.aggregation_kind, s.delivery, s.site_id
                  FROM fenster f
                  JOIN device_measurement_sample s
                    ON s.tenant_id = f.tenant_id AND s.entity_id = f.entity_id
                   AND s.point_key = f.messkanal
                   AND s.time > f.von AND s.time <= f.bis
                 WHERE s.time > ? AND s.time <= ?
                   AND %s
                 ORDER BY f.nr, s.time, s.received_at
                """.formatted(werteListe(stapel.size(),
                        "?::int, ?::uuid, ?::uuid, ?::text, ?::timestamptz, ?::timestamptz", 6), SPUR);
        try (PreparedStatement ps = con.prepareStatement(sql)) {
            int p = 1;
            for (int i = 0; i < stapel.size(); i++) {
                Auftrag a = stapel.get(i);
                ps.setInt(p++, i);
                ps.setObject(p++, a.tenant());
                ps.setObject(p++, a.entity());
                ps.setString(p++, a.kanal());
                ps.setTimestamp(p++, Timestamp.from(fenster.get(i)[0]));
                ps.setTimestamp(p++, Timestamp.from(fenster.get(i)[1]));
            }
            ps.setTimestamp(p++, Timestamp.from(von));
            ps.setTimestamp(p, Timestamp.from(bis));
            try (ResultSet rs = ps.executeQuery()) {
                while (rs.next()) {
                    aus.computeIfAbsent(rs.getInt(1), k -> new ArrayList<>()).add(new Roh(
                            rs.getTimestamp(2).toInstant(),
                            rs.getTimestamp(3) == null ? null : rs.getTimestamp(3).toInstant(),
                            rs.getString(4), rs.getBigDecimal(5), rs.getString(6),
                            rs.getObject(7, UUID.class), rs.getObject(8, UUID.class),
                            (Long) rs.getObject(9), rs.getString(10), rs.getString(11),
                            rs.getString(12), rs.getString(13), rs.getString(14),
                            rs.getObject(15, UUID.class)));
                }
            }
        }
        return aus;
    }

    /**
     * Die Ereignisse der Reihe im Intervall — die fünf gezählten Arten plus {@code device_restart},
     * den {@link VerbrauchRegeln} als Z7 kennt. Eine Übergabe und ein Neustart hängen an der
     * DATENQUELLE der Komponente, nicht an der Reihe (die Box meldet {@code device_restart} je
     * Datenquelle, AP-07 §4.8); darum reist sie über {@code measurement_point.data_source_id} mit.
     * Gelesen wird {@code [von, bis]}: {@link #zeile} zählt {@code [von, bis)}, die Regel wendet
     * {@code (von, bis]} an (AP-08 IP-4).
     */
    private Map<Integer, List<Ereignis>> ereignisse(Connection con, List<Auftrag> stapel) throws SQLException {
        Map<UUID, UUID> quelleJeKomponente = quelleJeKomponente(con, stapel);
        Map<Integer, List<Ereignis>> aus = new HashMap<>();
        Instant von = stapel.stream().map(Auftrag::beginn).min(Instant::compareTo).orElseThrow();
        Instant bis = stapel.stream().map(a -> ViertelstundeRegeln.ende(a.beginn()))
                .max(Instant::compareTo).orElseThrow();
        String sql = """
                WITH fenster(nr, tenant_id, entity_id, messkanal, von, bis, quelle) AS (VALUES %s)
                SELECT f.nr, e.art, e.zeit, e.nutzlast->>'endstand', e.nutzlast->>'anfangsstand',
                       e.nutzlast->>'verlust_s', e.nutzlast->>'einbau_alt', e.nutzlast->>'einbau_neu',
                       e.nutzlast->>'box_alt', e.nutzlast->>'box_neu'
                  FROM fenster f
                  JOIN messreihe_ereignis e
                    ON e.tenant_id = f.tenant_id AND e.zeit >= f.von AND e.zeit <= f.bis
                   AND ((e.entity_id = f.entity_id AND (e.messkanal IS NULL OR e.messkanal = f.messkanal))
                        OR (e.art IN ('handover', 'device_restart') AND f.quelle IS NOT NULL
                            AND e.data_source_id = f.quelle))
                 WHERE e.zeit >= ? AND e.zeit <= ?
                   AND e.art IN ('data_gap', 'counter_reset', 'device_boundary', 'handover',
                                 'duplicate_conflict', 'device_restart')
                 ORDER BY f.nr, e.zeit
                """.formatted(werteListe(stapel.size(),
                        "?::int, ?::uuid, ?::uuid, ?::text, ?::timestamptz, ?::timestamptz, ?::uuid", 7));
        try (PreparedStatement ps = con.prepareStatement(sql)) {
            int p = 1;
            for (int i = 0; i < stapel.size(); i++) {
                Auftrag a = stapel.get(i);
                ps.setInt(p++, i);
                ps.setObject(p++, a.tenant());
                ps.setObject(p++, a.entity());
                ps.setString(p++, a.kanal());
                ps.setTimestamp(p++, Timestamp.from(a.beginn()));
                ps.setTimestamp(p++, Timestamp.from(ViertelstundeRegeln.ende(a.beginn())));
                ps.setObject(p++, quelleJeKomponente.get(a.entity()));
            }
            ps.setTimestamp(p++, Timestamp.from(von));
            ps.setTimestamp(p, Timestamp.from(bis));
            try (ResultSet rs = ps.executeQuery()) {
                while (rs.next()) {
                    aus.computeIfAbsent(rs.getInt(1), k -> new ArrayList<>()).add(new Ereignis(
                            rs.getString(2), rs.getTimestamp(3).toInstant(),
                            zahl(rs.getString(4)), zahl(rs.getString(5)),
                            rs.getString(6) == null ? null : Long.valueOf(rs.getString(6)),
                            rs.getString(7), rs.getString(8),
                            alsUuid(rs.getString(9)), alsUuid(rs.getString(10))));
                }
            }
        }
        return aus;
    }

    private static BigDecimal zahl(String s) {
        return s == null ? null : new BigDecimal(s);
    }

    /** Eine Box-Kennung der Meldung ist die {@code device_id} als Text; was keine ist, ist keine. */
    private static UUID alsUuid(String s) {
        try {
            return s == null ? null : UUID.fromString(s);
        } catch (IllegalArgumentException e) {
            return null;
        }
    }

    /**
     * Die Einbau-Kennzeichen, die die Ereignisse nennen ({@code Z-5a}), als Einbau
     * ({@code geraet.id}) aufgelöst. Was sich nicht auflösen lässt, wird NICHT geraten — dann
     * bleibt es einfach kein Anker.
     */
    private Map<String, UUID> einbautenJeKennzeichen(Connection con, List<Auftrag> stapel,
            Map<Integer, List<Ereignis>> ereignisse) throws SQLException {
        Set<String> kennzeichen = new LinkedHashSet<>();
        for (List<Ereignis> liste : ereignisse.values()) {
            for (Ereignis e : liste) {
                if (e.einbauAlt() != null) {
                    kennzeichen.add(e.einbauAlt());
                }
                if (e.einbauNeu() != null) {
                    kennzeichen.add(e.einbauNeu());
                }
            }
        }
        Map<String, UUID> aus = new HashMap<>();
        if (kennzeichen.isEmpty()) {
            return aus;
        }
        List<UUID> mandanten = stapel.stream().map(Auftrag::tenant).distinct().toList();
        try (PreparedStatement ps = con.prepareStatement(
                "SELECT tenant_id, einbau_kennzeichen, id FROM geraet "
                        + "WHERE tenant_id = ANY (?) AND einbau_kennzeichen = ANY (?)")) {
            ps.setArray(1, con.createArrayOf("uuid", mandanten.toArray()));
            ps.setArray(2, con.createArrayOf("text", kennzeichen.toArray()));
            try (ResultSet rs = ps.executeQuery()) {
                while (rs.next()) {
                    aus.put(rs.getObject(1, UUID.class) + "|" + rs.getString(2), rs.getObject(3, UUID.class));
                }
            }
        }
        return aus;
    }

    /**
     * Die Deklaration je Auftrag zum Intervallbeginn (AP-08 IP-4) — aus
     * {@code messreihe_zaehler_deklaration()}, in EINER Abfrage für den Stapel.
     */
    private Map<Integer, ZaehlerDeklaration> deklarationen(Connection con, List<Auftrag> stapel)
            throws SQLException {
        Map<Integer, ZaehlerDeklaration> aus = new HashMap<>();
        String sql = """
                WITH f(nr, tenant_id, entity_id, messkanal, zeit) AS (VALUES %s)
                SELECT f.nr, d.wertebereich_modul, d.hoechstzuwachs_je_kadenz, d.kadenz_s, d.neustart_verlust_s
                  FROM f
                 CROSS JOIN LATERAL messreihe_zaehler_deklaration(f.tenant_id, f.entity_id, f.messkanal, f.zeit) d
                """.formatted(werteListe(stapel.size(), "?::int, ?::uuid, ?::uuid, ?::text, ?::timestamptz", 5));
        try (PreparedStatement ps = con.prepareStatement(sql)) {
            int p = 1;
            for (int i = 0; i < stapel.size(); i++) {
                Auftrag a = stapel.get(i);
                ps.setInt(p++, i);
                ps.setObject(p++, a.tenant());
                ps.setObject(p++, a.entity());
                ps.setString(p++, a.kanal());
                ps.setTimestamp(p++, Timestamp.from(a.beginn()));
            }
            try (ResultSet rs = ps.executeQuery()) {
                while (rs.next()) {
                    aus.put(rs.getInt(1), ZaehlerDeklaration.aus(rs, 2));
                }
            }
        }
        return aus;
    }

    private Map<UUID, UUID> quelleJeKomponente(Connection con, List<Auftrag> stapel) throws SQLException {
        Map<UUID, UUID> aus = new HashMap<>();
        List<UUID> ids = stapel.stream().map(Auftrag::entity).distinct().toList();
        try (PreparedStatement ps = con.prepareStatement(
                "SELECT id, data_source_id FROM measurement_point WHERE id = ANY (?)")) {
            ps.setArray(1, con.createArrayOf("uuid", ids.toArray()));
            try (ResultSet rs = ps.executeQuery()) {
                while (rs.next()) {
                    UUID quelle = rs.getObject(2, UUID.class);
                    if (quelle != null) {
                        aus.put(rs.getObject(1, UUID.class), quelle);
                    }
                }
            }
        }
        return aus;
    }

    // ----------------------------------------------------------------- Die Sätze

    /**
     * Der Schreibsatz. {@code ON CONFLICT … DO UPDATE … WHERE} ist die Wiederholbarkeit: eine
     * ENDGÜLTIGE Zeile wird nie angefasst (E5 — das Umschalten und die Spätankunft sind IP-13),
     * eine KORRIGIERTE ({@code version > 1}, AP-08) ebenso wenig, und eine unveränderte bleibt
     * Zeichen für Zeichen stehen — {@code berechnet_am} eingeschlossen, weil der Vergleich es
     * ausspart.
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
        return "INSERT INTO messreihe_viertelstunde (" + String.join(", ", SPALTEN) + ") VALUES ("
                + platz + ") ON CONFLICT (" + String.join(", ", SCHLUESSEL) + ") DO UPDATE SET "
                + String.join(", ", uebernommen.stream().map(s -> s + " = EXCLUDED." + s).toList())
                + " WHERE messreihe_viertelstunde.zustand = '" + ViertelstundeRegeln.VORLAEUFIG + "'"
                + " AND messreihe_viertelstunde.version = 1"
                + " AND (" + String.join(", ", verglichen.stream()
                        .map(s -> "messreihe_viertelstunde." + s).toList())
                + ") IS DISTINCT FROM (" + String.join(", ", verglichen.stream()
                        .map(s -> "EXCLUDED." + s).toList()) + ")";
    }

    /** {@code (?, ?, …), (?, ?, …)} — nur die erste Zeile trägt die Typangaben. */
    private static String werteListe(int zeilen, String erste, int spalten) {
        StringBuilder b = new StringBuilder("(").append(erste).append(")");
        String weitere = "(" + "?, ".repeat(spalten - 1) + "?)";
        for (int i = 1; i < zeilen; i++) {
            b.append(", ").append(weitere);
        }
        return b.toString();
    }

    // -------------------------------------------------------------- Der Laufstand

    record Stand(Instant zeitpunkt, long zahl, String notiz) {}

    private static Stand standLesenUndSperren(Connection con, String schluessel) throws SQLException {
        try (PreparedStatement ps = con.prepareStatement(
                "SELECT zeitpunkt, zahl, notiz FROM messreihe_viertelstunde_lauf "
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
                "UPDATE messreihe_viertelstunde_lauf SET zeitpunkt = ?, zahl = zahl + ?, "
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
        return adminJdbc.query("SELECT zeitpunkt, zahl, notiz FROM messreihe_viertelstunde_lauf "
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

    /**
     * EINE Transaktion je Zug: entnehmen und schreiben gehören zusammen, sonst ginge bei einem
     * Abbruch ein Eintrag der Arbeitsliste verloren.
     */
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
                        : new SQLException("UEMS Viertelstunden-Verdichtung fehlgeschlagen", e);
            } finally {
                con.setAutoCommit(autoCommit);
            }
        });
    }
}
