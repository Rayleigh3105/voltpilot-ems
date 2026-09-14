package com.voltpilot.api.uems;

import com.voltpilot.api.measurement.SpeicherklasseHistorie;
import com.voltpilot.api.tenant.TenantContext;
import com.voltpilot.api.uems.BilanzRestRepository.FassungMitRest;
import com.voltpilot.api.uems.MessstelleFormelTermRepository.TermZeile;
import com.voltpilot.api.uems.MessstelleRepository.Messstelle;
import com.voltpilot.api.web.dto.MessstelleWerteDto;
import java.math.BigDecimal;
import java.sql.Connection;
import java.sql.Date;
import java.sql.PreparedStatement;
import java.sql.SQLException;
import java.sql.Timestamp;
import java.time.Instant;
import java.time.LocalDate;
import java.time.OffsetDateTime;
import java.time.ZoneId;
import java.time.format.DateTimeParseException;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.Set;
import java.util.TreeMap;
import java.util.TreeSet;
import java.util.UUID;
import java.util.stream.Collectors;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Qualifier;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Component;
import org.springframework.web.server.ResponseStatusException;

/**
 * Der Rechenschritt der berechneten Messstellen im Verdichtungsjob (UEMS AP-10 IP-10, Captain-Entscheid E6 = A):
 * Viertelstunde, Tag, Monat und Jahr jeder berechneten Messstelle als Zeile der Spur {@code berechnet} — im Takt
 * von {@link EndgueltigkeitLaeufer} NACH den gemessenen ({@link TagVerdichter}, {@link PeriodeVerdichter}).
 *
 * <p><b>Die Reihenfolge ist der Kern.</b> Eine berechnete Messstelle rechnet aus anderen Messstellen; liefe sie
 * vor ihnen, schriebe sie eine Zahl, die schon beim Schreiben falsch ist. Darum erst die gemessenen (der Takt),
 * dann die berechneten in der Abhängigkeitsordnung aus ihren Fassungen ({@link BerechnetePeriode#reihenfolge}) —
 * ein Formel-Kreis wird benannt abgelehnt ({@link BerechnetePeriode#FORMEL_KREIS}), nie endlos gerechnet.
 *
 * <p><b>Gerechnet wird nichts neu.</b> Die Eingänge liest das Lese-Modell „Werte je Messstelle“
 * ({@link MessstelleWerteService}, AP-08 IP-9; ein Messkanal-Term seine Reihe über
 * {@link SpeicherklasseHistorie}), den Wert je Typ bildet {@link MessstelleFormelRegeln#periodenwert}, die
 * Terme eines {@code rest} je Tag {@link BilanzAbleitung#restAusStellung}, vorläufig/endgültig
 * {@link TagRegeln#zustand} ({@link BerechnetePeriode#rechne}).
 *
 * <p><b>Welche Tage.</b> (1) Das FENSTER der letzten {@value #FENSTER_TAGE} Tage bis heute — so lange kann sich
 * eine gemessene Zeile Version 1 ändern (Frist 7 Tage, E5), und darin wird eine berechnete Zeile endgültig, sobald
 * ihre Eingänge es sind. (2) NACHZÜGLER: vorläufige berechnete Tage, Monate und Jahre vor dem Fenster, deren Frist
 * abgelaufen ist (der Takt fiel aus). (3) NACHHOLEN: die Vergangenheit rückwärts in Scheiben von
 * {@value #NACHHOLEN_TAGE} Tagen je Lauf, bis zum frühesten gemessenen Tageswert des Kundenbereichs
 * ({@code messreihe_berechnet_stand}); eine Messstelle holt nie weiter zurück nach als die berechneten
 * Messstellen, die sie liest.
 *
 * <p><b>Monat und Jahr</b> werden aus den Monats- bzw. Jahreswerten der Eingänge gerechnet — nur, wenn an allen
 * Tagen der Periode, an denen die Formel etwas rechnet, DIESELBE Fassung mit denselben Termen gilt. Wechseln sie
 * (Stellungs- oder Fassungswechsel mitten in der Periode), entsteht keine Zeile: eine Periodenzahl über Abschnitte
 * wäre eine neue Rechenregel ({@link #TERME_WECHSELN}).
 *
 * <p><b>Wiederholbar und abbruchsicher.</b> Die Zeilen einer Messstelle je Tagesscheibe (Viertelstunden + Tage),
 * je Monat und je Jahr gehen samt ihren Eingängen in EINER Transaktion; ein Abbruch lässt die Scheibe ganz alt.
 * Eine unveränderte Zeile wird nicht geschrieben, eine endgültige nie angefasst ({@link BerechnetePeriodenRepository}).
 *
 * <p><b>Der Live-Wert bleibt live</b> ({@link MessstelleFormelService#wert}) — hier entstehen nur Perioden.
 */
@Component
public class BerechnetePeriodenLauf {

    private static final Logger log = LoggerFactory.getLogger(BerechnetePeriodenLauf.class);

    /** Wie weit das Fenster zurückreicht: sieben Tage Frist, ein Tag Zone, ein Tag Takt. */
    static final int FENSTER_TAGE = 9;
    /** Eine Scheibe des Nachholens — je Lauf und Messstelle. */
    static final int NACHHOLEN_TAGE = 28;
    /** Höchstens so viele Nachzügler-Tage je Messstelle und Lauf. */
    static final int NACHZUEGLER_JE_LAUF = 62;
    /** Die längste Tagesscheibe, die das Lese-Modell auf einmal liest (21 × 100 Viertelstunden ≤ 2 200 Schritte). */
    static final int SCHEIBE_TAGE = 21;

    /** Eine Periode, an deren Tagen verschiedene Terme gelten, bekommt keine Zeile. */
    public static final String TERME_WECHSELN = "terme_wechseln";
    /** Ein Eingang mit Anteil (positiv/negativ): die Speicherklassen tragen nur den ganzen Wert der Reihe. */
    static final String ANTEIL_NICHT_GESPEICHERT = MessstelleWerteRegeln.OhneZahl.ANTEIL_NICHT_GESPEICHERT.wort();
    /** Ein Verteilungs-Term: verteilte Werte bringt AP-10 IP-11. */
    static final String VERTEILUNG_NICHT_GESPEICHERT = "verteilung_nicht_gespeichert";
    /** Ein Messkanal-Term, dessen Reihe keine Menge trägt (kein Zählerstand). */
    static final String KEINE_MENGE = "keine_menge";
    /** Das Lese-Modell konnte den Eingang nicht lesen (etwa: die Messstelle gibt es nicht mehr). */
    static final String NICHT_LESBAR = "nicht_lesbar";

    private static final String MOMENTANWERT = "Momentanwert";
    private static final String GESAMT = "gesamt";

    /** Was ein Lauf tat — die Ablehnungen mit Namen und Kette. */
    public record Lauf(int messstellen, int geschrieben, int unveraendert, int endgueltigUnberuehrt,
            List<BerechnetePeriode.Abgelehnt> abgelehnt) {}

    private final JdbcTemplate adminJdbc;
    private final JdbcTemplate jdbc;
    private final MessstelleRepository messstellen;
    private final BilanzRestRepository reste;
    private final MessstelleFormelTermRepository terme;
    private final BilanzStellungen stellungen;
    private final MessstelleWerteService werte;
    private final SpeicherklasseHistorie historie;
    private final BerechnetePeriodenRepository speicher;

    public BerechnetePeriodenLauf(@Qualifier("adminJdbcTemplate") JdbcTemplate adminJdbc, JdbcTemplate jdbc,
            MessstelleRepository messstellen, BilanzRestRepository reste, MessstelleFormelTermRepository terme,
            BilanzStellungen stellungen, MessstelleWerteService werte, SpeicherklasseHistorie historie,
            BerechnetePeriodenRepository speicher) {
        this.adminJdbc = adminJdbc;
        this.jdbc = jdbc;
        this.messstellen = messstellen;
        this.reste = reste;
        this.terme = terme;
        this.stellungen = stellungen;
        this.werte = werte;
        this.historie = historie;
        this.speicher = speicher;
    }

    /** Ein ganzer Lauf über alle Kundenbereiche mit berechneten Messstellen. Wirft nie für einen einzelnen. */
    public Lauf lauf(Instant jetzt) {
        Zaehler z = new Zaehler();
        for (UUID tenant : adminJdbc.queryForList(
                "SELECT DISTINCT tenant_id FROM messstelle WHERE art = 'berechnet' ORDER BY tenant_id", UUID.class)) {
            UUID vorher = TenantContext.get();
            TenantContext.set(tenant);
            try {
                mandant(tenant, jetzt, z);
            } catch (RuntimeException e) {
                log.warn("UEMS berechnete Periodenwerte für Kundenbereich {} übersprungen: {}", tenant, e.toString());
            } finally {
                if (vorher == null) {
                    TenantContext.clear();
                } else {
                    TenantContext.set(vorher);
                }
            }
        }
        if (z.geschrieben > 0 || !z.abgelehnt.isEmpty()) {
            log.info("UEMS berechnete Periodenwerte: {} Messstellen, {} Zeilen geschrieben, {} unverändert, "
                    + "{} endgültig unberührt, {} abgelehnt", z.messstellen, z.geschrieben, z.unveraendert,
                    z.endgueltig, z.abgelehnt.size());
        }
        return new Lauf(z.messstellen, z.geschrieben, z.unveraendert, z.endgueltig, List.copyOf(z.abgelehnt));
    }

    private static final class Zaehler {
        int messstellen;
        int geschrieben;
        int unveraendert;
        int endgueltig;
        final List<BerechnetePeriode.Abgelehnt> abgelehnt = new ArrayList<>();

        void add(BerechnetePeriodenRepository.Geschrieben g) {
            geschrieben += g.geschrieben();
            unveraendert += g.unveraendert();
            endgueltig += g.endgueltigUnberuehrt();
        }
    }

    // ------------------------------------------------------------------------------ ein Kundenbereich

    /** Ein Term eines Tages: woher der Eingang kommt und wie er eingeht. */
    record TermRef(UUID messstelleId, String kennzeichen, boolean berechnet, UUID entityId, String messkanal,
            String rolle, String anteil, String vorzeichen, BigDecimal faktor, String grund) {

        /** Der Leseschlüssel: dieselbe Reihe wird je Scheibe einmal gelesen. */
        String quelle() {
            return messstelleId != null ? "m:" + kennzeichen : "k:" + entityId + "|" + messkanal;
        }
    }

    /** Die Formel eines Tages: Fassung, Typ, Terme — {@code null}, wenn an dem Tag nichts gerechnet wird. */
    record TagesFormel(UUID fassungId, String typ, List<TermRef> terme) {}

    record Kontext(UUID tenant, ZoneId zone, String zoneHerkunft, Instant jetzt, LocalDate heute,
            Map<UUID, Messstelle> nachId, Map<UUID, List<FassungMitRest>> fassungen,
            Map<UUID, List<TermZeile>> termeJeFassung, BilanzStellungen.Stand stand) {}

    /** Der Kontext eines Kundenbereichs und seine berechneten Messstellen — {@code null}, wenn er keine hat. */
    private record Aufbau(Kontext k, List<Messstelle> berechnete) {}

    private Aufbau aufbau(UUID tenant, Instant jetzt) {
        ZoneKette zone = zone();
        LocalDate heute = TagRegeln.tag(jetzt, zone.zone());
        Map<UUID, Messstelle> nachId = new LinkedHashMap<>();
        messstellen.alle().forEach(m -> nachId.put(m.id(), m));
        List<Messstelle> berechnete = nachId.values().stream()
                .filter(m -> MessstelleRegeln.BERECHNET.equals(m.art()))
                .filter(m -> !MOMENTANWERT.equals(m.hauptgroesse().wertart()))
                .toList();
        if (berechnete.isEmpty()) {
            return null;
        }
        Map<UUID, List<FassungMitRest>> fassungen = reste.fassungen(berechnete.stream().map(Messstelle::id).toList())
                .stream().collect(Collectors.groupingBy(FassungMitRest::messstelleId, LinkedHashMap::new,
                        Collectors.toList()));
        Map<UUID, List<TermZeile>> termeJeFassung = terme.derFassungen(fassungen.values().stream()
                .flatMap(List::stream).map(FassungMitRest::id).toList());
        return new Aufbau(new Kontext(tenant, zone.zone(), zone.herkunft(), jetzt, heute, nachId, fassungen,
                termeJeFassung, stellungen.lesen()), berechnete);
    }

    /**
     * Die berechneten Messstellen, die {@code m} an den Tagen {@code [von, bis]} liest (Terme, beim {@code rest} aus der
     * Stellung) oder in irgendeiner Fassung als Baustein nennt — die Kanten der Abhängigkeitsordnung.
     */
    private List<String> kanten(Kontext k, Messstelle m, LocalDate von, LocalDate bis) {
        Set<String> kanten = new LinkedHashSet<>();
        for (LocalDate tag = von; !tag.isAfter(bis); tag = tag.plusDays(1)) {
            TagesFormel f = formel(k, m, tag);
            if (f != null) {
                f.terme().stream().filter(TermRef::berechnet).map(TermRef::kennzeichen).forEach(kanten::add);
            }
        }
        k.fassungen().getOrDefault(m.id(), List.of()).forEach(fs -> k.termeJeFassung().getOrDefault(fs.id(), List.of())
                .stream().filter(t -> t.quellMessstelleId() != null)
                .map(t -> k.nachId().get(t.quellMessstelleId()))
                .filter(q -> q != null && MessstelleRegeln.BERECHNET.equals(q.art()))
                .forEach(q -> kanten.add(q.kennzeichen())));
        return List.copyOf(kanten);
    }

    private void mandant(UUID tenant, Instant jetzt, Zaehler z) {
        Aufbau aufbau = aufbau(tenant, jetzt);
        if (aufbau == null) {
            return;
        }
        Kontext k = aufbau.k();
        List<Messstelle> berechnete = aufbau.berechnete();
        LocalDate heute = k.heute();

        // Welche Tage je Messstelle in Frage kommen — die Obermenge, aus der die Kanten der Stellung stammen.
        LocalDate fensterBeginn = heute.minusDays(FENSTER_TAGE);
        LocalDate untergrenze = adminJdbc.queryForObject(
                "SELECT min(tag) FROM messreihe_tag WHERE tenant_id = ? AND entity_id IS NOT NULL", LocalDate.class,
                tenant);
        Map<UUID, Stand> staende = new HashMap<>();
        Map<String, List<String>> lesen = new LinkedHashMap<>();
        Map<String, Messstelle> nachKennzeichen = new LinkedHashMap<>();
        for (Messstelle m : berechnete) {
            Stand s = stand(tenant, m.id(), fensterBeginn);
            staende.put(m.id(), s);
            nachKennzeichen.put(m.kennzeichen(), m);
            lesen.put(m.kennzeichen(), kanten(k, m, s.nachgeholtAb().minusDays(NACHHOLEN_TAGE), heute));
        }

        BerechnetePeriode.Reihenfolge r = BerechnetePeriode.reihenfolge(lesen);
        for (BerechnetePeriode.Abgelehnt a : r.abgelehnt()) {
            log.warn("UEMS berechnete Periodenwerte: {} abgelehnt ({}): {}", a.messstelle(), a.grund(),
                    String.join(" → ", a.kette()));
            z.abgelehnt.add(a);
        }

        Map<String, LocalDate> neuNachgeholt = new HashMap<>();
        for (String kz : r.ordnung()) {
            Messstelle m = nachKennzeichen.get(kz);
            Stand s = staende.get(m.id());
            TreeSet<LocalDate> tage = new TreeSet<>();
            for (LocalDate tag = fensterBeginn; !tag.isAfter(heute); tag = tag.plusDays(1)) {
                tage.add(tag);
            }
            tage.addAll(nachzuegler(tenant, m.id(), fensterBeginn, jetzt));

            // Nachholen: nie weiter zurück als die berechneten Eingänge, die selbst noch nicht fertig sind.
            LocalDate grenze = untergrenze;
            for (String eingang : lesen.get(kz)) {
                Stand es = staende.get(nachKennzeichen.get(eingang).id());
                if (!es.fertig()) {
                    LocalDate ihr = neuNachgeholt.getOrDefault(eingang, es.nachgeholtAb());
                    grenze = grenze == null || ihr.isAfter(grenze) ? ihr : grenze;
                }
            }
            LocalDate ab = s.nachgeholtAb();
            boolean fertig = s.fertig();
            if (!fertig && untergrenze != null && grenze != null) {
                LocalDate von = s.nachgeholtAb().minusDays(NACHHOLEN_TAGE);
                von = von.isBefore(grenze) ? grenze : von;
                for (LocalDate tag = von; tag.isBefore(s.nachgeholtAb()); tag = tag.plusDays(1)) {
                    tage.add(tag);
                }
                ab = von.isBefore(s.nachgeholtAb()) ? von : s.nachgeholtAb();
                fertig = !ab.isAfter(untergrenze);
            }
            neuNachgeholt.put(kz, ab);

            z.messstellen++;
            rechneMessstelle(k, m, tage, z);
            if (!ab.equals(s.nachgeholtAb()) || fertig != s.fertig() || !s.gespeichert()) {
                standSetzen(tenant, m.id(), ab, fertig);
            }
        }
    }

    // ------------------------------------------------------------------------------ nach einer Korrektur (IP-17)

    /** Was die Kaskade je berechneter Messstelle bekommt: ihre Zeilen im Zeitraum, gerechnet und NICHT geschrieben. */
    record Neuberechnet(Messstelle messstelle, List<BerechnetePeriodenRepository.Zeile> zeilen) {}

    /**
     * Die Eingänge, wie die Kaskade sie sieht: was der Lauf liest ({@code gelesen}, Version 1), überlagert mit der
     * neuesten Version jedes Eingangs — auch der, die die Kaskade in DIESER Transaktion gerade geschrieben hat.
     */
    @FunctionalInterface
    interface Ueberlagerung {
        Map<Instant, BerechnetePeriode.Eingang> ueberlagern(Kontext k, TermRef ref, String ebene, LocalDate von,
                LocalDate bis, Map<Instant, BerechnetePeriode.Eingang> gelesen);
    }

    /** Übernimmt die Zeilen EINER Messstelle — gerufen in der Abhängigkeitsordnung, bevor die nächste rechnet. */
    @FunctionalInterface
    interface Uebernahme {
        void uebernehmen(Neuberechnet n) throws SQLException;
    }

    /**
     * AP-08 IP-17 — die Anschlussstelle der Korrektur-Kaskade (E9) an DIESEM Lauf: dieselbe Abhängigkeitsordnung
     * ({@link BerechnetePeriode#reihenfolge}, derselbe benannt abgelehnte Kreis), dieselben Formeln je Tag, dieselben
     * Leser und dieselbe Rechnung ({@link #zeile}) — nur mit den überlagerten Eingängen und ohne zu schreiben. Die Kaskade
     * vergleicht und schreibt die Versionen selbst; sie ruft das hier in IHRER Transaktion, darum übergibt sie jede
     * Messstelle ({@code uebernahme}), bevor die nächste in der Ordnung rechnet.
     *
     * @param von erster betroffener Tag (Zone des Kundenbereichs, wie der Lauf)
     * @param bis letzter betroffener Tag, einschließlich; Monate und Jahre dieser Tage kommen dazu
     * @param ebenen die Ebenen, die gerechnet werden ({@code viertelstunde} und {@code tag} gehen nur zusammen)
     * @return die Messstellen, die nicht gerechnet wurden — Kreis ({@link BerechnetePeriode#FORMEL_KREIS}) oder
     *     daran hängend ({@link BerechnetePeriode#HAENGT_AN_KREIS})
     */
    List<BerechnetePeriode.Abgelehnt> nachKorrektur(UUID tenant, LocalDate von, LocalDate bis, Set<String> ebenen,
            Instant jetzt, Ueberlagerung ueberlagerung, Uebernahme uebernahme) throws SQLException {
        UUID vorher = TenantContext.get();
        TenantContext.set(tenant);
        try {
            Aufbau a = aufbau(tenant, jetzt);
            if (a == null) {
                return List.of();
            }
            Kontext k = a.k();
            Map<String, List<String>> lesen = new LinkedHashMap<>();
            Map<String, Messstelle> nachKennzeichen = new LinkedHashMap<>();
            for (Messstelle m : a.berechnete()) {
                nachKennzeichen.put(m.kennzeichen(), m);
                lesen.put(m.kennzeichen(), kanten(k, m, von, bis));
            }
            BerechnetePeriode.Reihenfolge r = BerechnetePeriode.reihenfolge(lesen);
            for (BerechnetePeriode.Abgelehnt ab : r.abgelehnt()) {
                log.warn("UEMS Korrektur-Kaskade: berechnete Messstelle {} abgelehnt ({}): {}", ab.messstelle(),
                        ab.grund(), String.join(" → ", ab.kette()));
            }
            Leser leser = (kk, ref, ebene, v, b) -> ueberlagerung.ueberlagern(kk, ref, ebene, v, b, lies(kk, ref, ebene, v, b));
            for (String kz : r.ordnung()) {
                Messstelle m = nachKennzeichen.get(kz);
                Map<LocalDate, TagesFormel> formeln = new TreeMap<>();
                for (LocalDate tag = von; !tag.isAfter(bis); tag = tag.plusDays(1)) {
                    TagesFormel f = formel(k, m, tag);
                    if (f != null) {
                        formeln.put(tag, f);
                    }
                }
                if (formeln.isEmpty()) {
                    continue;
                }
                List<BerechnetePeriodenRepository.Zeile> zeilen = new ArrayList<>();
                if (ebenen.contains(BerechnetePeriodenRepository.VIERTELSTUNDE)
                        || ebenen.contains(BerechnetePeriodenRepository.TAG)) {
                    for (List<LocalDate> scheibe : scheiben(formeln.keySet())) {
                        Scheibe sch = scheibeRechnen(k, m, scheibe, formeln, leser);
                        zeilen.addAll(sch.viertelstunden());
                        zeilen.addAll(sch.tage());
                    }
                }
                Set<LocalDate> monate = new TreeSet<>();
                Set<LocalDate> jahre = new TreeSet<>();
                formeln.keySet().forEach(t -> {
                    monate.add(t.withDayOfMonth(1));
                    jahre.add(t.withDayOfYear(1));
                });
                for (LocalDate monat : ebenen.contains(BerechnetePeriodenRepository.MONAT) ? monate : Set.<LocalDate>of()) {
                    periodeRechnen(k, m, BerechnetePeriodenRepository.MONAT, monat, monat.plusMonths(1), leser)
                            .ifPresent(zeilen::add);
                }
                for (LocalDate jahr : ebenen.contains(BerechnetePeriodenRepository.JAHR) ? jahre : Set.<LocalDate>of()) {
                    periodeRechnen(k, m, BerechnetePeriodenRepository.JAHR, jahr, jahr.plusYears(1), leser)
                            .ifPresent(zeilen::add);
                }
                uebernahme.uebernehmen(new Neuberechnet(m, List.copyOf(zeilen)));
            }
            return r.abgelehnt();
        } finally {
            if (vorher == null) {
                TenantContext.clear();
            } else {
                TenantContext.set(vorher);
            }
        }
    }

    /** Die Zone der berechneten Zeilen dieses Kundenbereichs — dieselbe Kette wie der Lauf. */
    ZoneId zoneDesKundenbereichs(UUID tenant) {
        UUID vorher = TenantContext.get();
        TenantContext.set(tenant);
        try {
            return zone().zone();
        } finally {
            if (vorher == null) {
                TenantContext.clear();
            } else {
                TenantContext.set(vorher);
            }
        }
    }

    // ------------------------------------------------------------------------------ eine Messstelle

    private void rechneMessstelle(Kontext k, Messstelle m, TreeSet<LocalDate> kandidaten, Zaehler z) {
        Map<LocalDate, TagesFormel> formeln = new TreeMap<>();
        for (LocalDate tag : kandidaten) {
            TagesFormel f = formel(k, m, tag);
            if (f != null) {
                formeln.put(tag, f);
            }
        }
        for (List<LocalDate> scheibe : scheiben(formeln.keySet())) {
            scheibe(k, m, scheibe, formeln, z);
        }
        Set<LocalDate> monate = new TreeSet<>();
        Set<LocalDate> jahre = new TreeSet<>();
        formeln.keySet().forEach(t -> {
            monate.add(t.withDayOfMonth(1));
            jahre.add(t.withDayOfYear(1));
        });
        for (LocalDate monat : monate) {
            periode(k, m, BerechnetePeriodenRepository.MONAT, monat, monat.plusMonths(1), z);
        }
        for (LocalDate jahr : jahre) {
            periode(k, m, BerechnetePeriodenRepository.JAHR, jahr, jahr.plusYears(1), z);
        }
    }

    /** Tagesscheiben: zusammenhängende Tage, höchstens SCHEIBE_TAGE lang. */
    private static List<List<LocalDate>> scheiben(Set<LocalDate> tage) {
        List<List<LocalDate>> scheiben = new ArrayList<>();
        for (LocalDate tag : new TreeSet<>(tage)) {
            List<LocalDate> letzte = scheiben.isEmpty() ? null : scheiben.get(scheiben.size() - 1);
            if (letzte != null && letzte.get(letzte.size() - 1).plusDays(1).equals(tag) && letzte.size() < SCHEIBE_TAGE) {
                letzte.add(tag);
            } else {
                scheiben.add(new ArrayList<>(List.of(tag)));
            }
        }
        return scheiben;
    }

    /** Viertelstunden und Tage einer zusammenhängenden Tagesscheibe — in EINER Transaktion. */
    private void scheibe(Kontext k, Messstelle m, List<LocalDate> tage, Map<LocalDate, TagesFormel> formeln, Zaehler z) {
        Scheibe sch = scheibeRechnen(k, m, tage, formeln, this::lies);
        // Gezählt wird erst nach dem Commit — eine zurückgerollte Scheibe hat nichts geschrieben.
        inTransaktion(con -> {
            sperren(con, k.tenant(), m.id());
            return List.of(
                    speicher.schreiben(con, k.tenant(), m.id(), BerechnetePeriodenRepository.VIERTELSTUNDE,
                            sch.viertelstunden(), k.jetzt()),
                    speicher.schreiben(con, k.tenant(), m.id(), BerechnetePeriodenRepository.TAG, sch.tage(),
                            k.jetzt()));
        }).forEach(z::add);
    }

    /** Die Eingänge EINES Terms je Periodenbeginn über {@code [von, bis]} — der Lauf liest sie, die Kaskade überlagert. */
    @FunctionalInterface
    interface Leser {
        Map<Instant, BerechnetePeriode.Eingang> lies(Kontext k, TermRef ref, String ebene, LocalDate von, LocalDate bis);
    }

    private record Scheibe(List<BerechnetePeriodenRepository.Zeile> viertelstunden,
            List<BerechnetePeriodenRepository.Zeile> tage) {}

    /** Die Viertelstunden und Tage einer Tagesscheibe — gerechnet, nicht geschrieben. */
    private Scheibe scheibeRechnen(Kontext k, Messstelle m, List<LocalDate> tage, Map<LocalDate, TagesFormel> formeln,
            Leser leser) {
        LocalDate von = tage.get(0);
        LocalDate bis = tage.get(tage.size() - 1);
        Map<String, TermRef> quellen = new LinkedHashMap<>();
        tage.forEach(t -> formeln.get(t).terme().forEach(ref -> quellen.putIfAbsent(ref.quelle(), ref)));
        Map<String, Map<Instant, BerechnetePeriode.Eingang>> viertel = new HashMap<>();
        Map<String, Map<Instant, BerechnetePeriode.Eingang>> tageswerte = new HashMap<>();
        quellen.forEach((q, ref) -> {
            viertel.put(q, leser.lies(k, ref, BerechnetePeriodenRepository.VIERTELSTUNDE, von, bis));
            tageswerte.put(q, leser.lies(k, ref, BerechnetePeriodenRepository.TAG, von, bis));
        });

        String einheit = m.hauptgroesse().einheit();
        List<BerechnetePeriodenRepository.Zeile> vs = new ArrayList<>();
        List<BerechnetePeriodenRepository.Zeile> ts = new ArrayList<>();
        for (LocalDate tag : tage) {
            TagesFormel f = formeln.get(tag);
            Instant beginn = TagRegeln.beginn(tag, k.zone());
            Instant ende = TagRegeln.ende(tag, k.zone());
            for (Instant q = beginn; q.isBefore(ende); q = q.plus(ViertelstundeRegeln.LAENGE)) {
                Instant schritt = q;
                zeile(k, f, einheit, BerechnetePeriodenRepository.VIERTELSTUNDE, schritt,
                        schritt.plus(ViertelstundeRegeln.LAENGE), null, viertel).ifPresent(vs::add);
            }
            zeile(k, f, einheit, BerechnetePeriodenRepository.TAG, beginn, ende, tag, tageswerte).ifPresent(ts::add);
        }
        return new Scheibe(vs, ts);
    }

    /**
     * Monat oder Jahr: nur, wenn an allen Tagen der Periode, an denen die Formel rechnet, dieselbe Fassung mit
     * denselben Termen gilt — sonst keine Zeile ({@link #TERME_WECHSELN}).
     */
    private void periode(Kontext k, Messstelle m, String ebene, LocalDate erster, LocalDate naechster, Zaehler z) {
        Optional<BerechnetePeriodenRepository.Zeile> zeile = periodeRechnen(k, m, ebene, erster, naechster, this::lies);
        if (zeile.isEmpty()) {
            return;
        }
        z.add(inTransaktion(con -> {
            sperren(con, k.tenant(), m.id());
            return speicher.schreiben(con, k.tenant(), m.id(), ebene, List.of(zeile.get()), k.jetzt());
        }));
    }

    /** Monat oder Jahr — gerechnet, nicht geschrieben; leer ohne gemeinsame Formel oder ohne Ergebnis. */
    private Optional<BerechnetePeriodenRepository.Zeile> periodeRechnen(Kontext k, Messstelle m, String ebene,
            LocalDate erster, LocalDate naechster, Leser leser) {
        TagesFormel gemeinsam = null;
        for (LocalDate tag = erster; tag.isBefore(naechster); tag = tag.plusDays(1)) {
            TagesFormel f = formel(k, m, tag);
            if (f == null) {
                continue;
            }
            if (gemeinsam == null) {
                gemeinsam = f;
            } else if (!gemeinsam.equals(f)) {
                log.debug("UEMS berechnete Periodenwerte: {} {} {} — {}", m.kennzeichen(), ebene, erster, TERME_WECHSELN);
                return Optional.empty();
            }
        }
        if (gemeinsam == null) {
            return Optional.empty();
        }
        Map<String, Map<Instant, BerechnetePeriode.Eingang>> gelesen = new HashMap<>();
        for (TermRef ref : gemeinsam.terme()) {
            gelesen.computeIfAbsent(ref.quelle(), q -> leser.lies(k, ref, ebene, erster, naechster.minusDays(1)));
        }
        Instant beginn = TagRegeln.beginn(erster, k.zone());
        Instant ende = TagRegeln.beginn(naechster, k.zone());
        return zeile(k, gemeinsam, m.hauptgroesse().einheit(), ebene, beginn, ende, erster, gelesen);
    }

    /** Die Zeile EINER Periode aus den gelesenen Eingängen — leer, wenn die Regel keine ergibt. */
    private Optional<BerechnetePeriodenRepository.Zeile> zeile(Kontext k, TagesFormel f, String einheit, String ebene,
            Instant beginn, Instant ende, LocalDate tag, Map<String, Map<Instant, BerechnetePeriode.Eingang>> gelesen) {
        List<BerechnetePeriode.Eingang> eingaenge = new ArrayList<>();
        List<BerechnetePeriodenRepository.EingangZeile> zeilen = new ArrayList<>();
        for (TermRef ref : f.terme()) {
            BerechnetePeriode.Eingang wert = ref.grund() != null ? null : gelesen.get(ref.quelle()).get(beginn);
            BerechnetePeriode.Eingang e = new BerechnetePeriode.Eingang(
                    ref.messstelleId() != null ? ref.kennzeichen() : ref.messkanal(), ref.rolle(), ref.anteil(),
                    ref.vorzeichen(), ref.faktor(),
                    wert == null ? null : wert.menge(), wert == null ? null : wert.zustand(),
                    wert == null ? null : wert.abdeckungProzent(), wert == null ? null : wert.version(),
                    wert == null ? List.of() : wert.kennzeichen(), wert == null ? null : wert.fassung(),
                    ref.grund() != null ? ref.grund() : wert == null ? null : wert.grund());
            eingaenge.add(e);
            zeilen.add(new BerechnetePeriodenRepository.EingangZeile(ref.messstelleId(),
                    ref.messstelleId() != null ? ref.kennzeichen() : null, ref.entityId(), ref.messkanal(), e));
        }
        BerechnetePeriode.Urteil u = BerechnetePeriode.rechne(f.typ(), einheit, ebene, eingaenge, ende, k.jetzt(),
                List.of());
        if (u.ergebnis() == null) {
            return Optional.empty();
        }
        return Optional.of(new BerechnetePeriodenRepository.Zeile(ebene, beginn, ende, tag, k.zone(),
                k.zoneHerkunft(), f.fassungId(), f.typ(), u.ergebnis(), List.copyOf(zeilen)));
    }

    // ------------------------------------------------------------------------------ die Formel eines Tages

    /**
     * Die Formel am Tag: die wirksame Fassung des Tages, und beim {@code rest} die Terme aus der Stellung
     * ({@link BilanzAbleitung#restAusStellung}). {@code null}, wenn an dem Tag keine Fassung gilt, der
     * Hauptzähler an dem Tag keiner ist oder der Typ hier nicht gerechnet wird ({@code saldo}: noch kein
     * Schreibweg, AP-10 IP-16).
     */
    private TagesFormel formel(Kontext k, Messstelle m, LocalDate tag) {
        FassungMitRest fassung = null;
        for (FassungMitRest f : k.fassungen().getOrDefault(m.id(), List.of())) {
            if (f.alsRegel().deckt(tag)) {
                fassung = f;
            }
        }
        if (fassung == null) {
            return null;
        }
        List<TermRef> refs = new ArrayList<>();
        if (MessstelleFormelRegeln.REST.equals(fassung.formelTyp())) {
            Messstelle hz = fassung.restHauptzaehlerId() == null ? null : k.nachId().get(fassung.restHauptzaehlerId());
            if (hz == null) {
                return null;
            }
            BilanzAbleitung.RestFassung rf = k.stand().rest(hz.kennzeichen(), tag);
            if (rf.fehler() != null) {
                return null;
            }
            for (BilanzAbleitung.RestTerm t : rf.terme()) {
                Messstelle q = k.stand().nachKennzeichen().get(t.messstelle());
                refs.add(new TermRef(q == null ? null : q.id(), t.messstelle(),
                        q != null && MessstelleRegeln.BERECHNET.equals(q.art()), null, null, t.rolle(), t.anteil(), null,
                        null, q == null ? NICHT_LESBAR : anteilGrund(t.anteil())));
            }
        } else if (MessstelleFormelRegeln.GEWICHTETE_SUMME.equals(fassung.formelTyp())) {
            for (TermZeile t : k.termeJeFassung().getOrDefault(fassung.id(), List.of())) {
                BigDecimal faktor = BigDecimal.valueOf(t.faktor());
                if ("messkanal".equals(t.eingangArt())) {
                    refs.add(new TermRef(null, null, false, t.entityId(), t.pointKey(), null, t.anteil(), t.vorzeichen(),
                            faktor, anteilGrund(t.anteil())));
                    continue;
                }
                Messstelle q = k.nachId().get(t.quellMessstelleId());
                String grund = q == null ? NICHT_LESBAR
                        : "verteilung".equals(t.eingangArt()) ? VERTEILUNG_NICHT_GESPEICHERT : anteilGrund(t.anteil());
                refs.add(new TermRef(t.quellMessstelleId(), q == null ? String.valueOf(t.quellMessstelleId())
                        : q.kennzeichen(), q != null && MessstelleRegeln.BERECHNET.equals(q.art()), null, null, null,
                        t.anteil(), t.vorzeichen(), faktor, grund));
            }
        } else {
            return null;
        }
        return refs.isEmpty() ? null : new TagesFormel(fassung.id(), fassung.formelTyp(), List.copyOf(refs));
    }

    private static String anteilGrund(String anteil) {
        return anteil == null || GESAMT.equals(anteil) ? null : ANTEIL_NICHT_GESPEICHERT;
    }

    // ------------------------------------------------------------------------------ Eingänge lesen

    /**
     * Die Werte EINES Eingangs je Periodenbeginn über {@code [von, bis]} (Tage einschließlich). Eine Messstelle
     * über das Lese-Modell; ein Messkanal über seine Reihe. Eine BERECHNETE Messstelle ohne Zeile ist hier kein
     * „noch nicht gebildet“, sondern schlicht ohne Wert: sie wurde in DIESEM Lauf vorher gerechnet
     * (Abhängigkeitsordnung) und hat an der Periode nichts.
     */
    private Map<Instant, BerechnetePeriode.Eingang> lies(Kontext k, TermRef ref, String ebene, LocalDate von,
            LocalDate bis) {
        Map<Instant, BerechnetePeriode.Eingang> out = new HashMap<>();
        if (ref.grund() != null) {
            return out;
        }
        if (ref.messstelleId() == null) {
            return reihe(k, ref, ebene, von, bis);
        }
        List<MessstelleWerteDto.Wert> gelesen;
        try {
            gelesen = werte.werte(ref.kennzeichen(), ebene, von.toString(), bis.toString(), null).werte();
        } catch (ResponseStatusException | MessstelleAbgelehnt e) {
            log.warn("UEMS berechnete Periodenwerte: Eingang {} ({} {}–{}) nicht lesbar: {}", ref.kennzeichen(), ebene,
                    von, bis, e.getMessage());
            return out;
        }
        for (MessstelleWerteDto.Wert w : gelesen) {
            String grund = ref.berechnet() && BerechnetePeriode.NOCH_NICHT_GEBILDET.equals(w.grund()) ? null : w.grund();
            out.put(zeitpunkt(w.von()), new BerechnetePeriode.Eingang(ref.kennzeichen(), null, null, null, null,
                    w.menge(), w.zustand(), w.abdeckungProzent(), w.version(),
                    w.kennzeichen() == null ? List.of() : w.kennzeichen(), w.version() == null ? null : w.fassung(),
                    grund));
        }
        return out;
    }

    private Map<Instant, BerechnetePeriode.Eingang> reihe(Kontext k, TermRef ref, String ebene, LocalDate von,
            LocalDate bis) {
        Instant a = TagRegeln.beginn(von, k.zone());
        Instant b = TagRegeln.ende(bis, k.zone());
        List<SpeicherklasseHistorie.Zeile> zeilen = switch (ebene) {
            case BerechnetePeriodenRepository.VIERTELSTUNDE ->
                    historie.viertelstunden(k.tenant(), ref.entityId(), ref.messkanal(), a, b.minusSeconds(1), 900);
            case BerechnetePeriodenRepository.TAG ->
                    historie.tage(k.tenant(), ref.entityId(), ref.messkanal(), a, b.minusSeconds(1));
            default -> historie.perioden(k.tenant(), ref.entityId(), ref.messkanal(), ebene, a, b);
        };
        Map<Instant, BerechnetePeriode.Eingang> out = new HashMap<>();
        for (SpeicherklasseHistorie.Zeile z : zeilen) {
            boolean menge = "counter".equals(z.wertart());
            out.put(z.zeit(), new BerechnetePeriode.Eingang(ref.messkanal(), null, null, null, null,
                    menge ? z.wert() : null, z.mengeZustand(), z.abdeckungProzent(), z.version(),
                    z.kennzeichen() == null ? List.of() : z.kennzeichen(), z.zustand(), menge ? null : KEINE_MENGE));
        }
        return out;
    }

    private static Instant zeitpunkt(String iso) {
        try {
            return OffsetDateTime.parse(iso).toInstant();
        } catch (DateTimeParseException e) {
            throw new IllegalStateException("Schritt ohne Zeitpunkt: " + iso, e);
        }
    }

    // ------------------------------------------------------------------------------ Laufzustand

    private record Stand(LocalDate nachgeholtAb, boolean fertig, boolean gespeichert) {}

    private Stand stand(UUID tenant, UUID messstelleId, LocalDate fensterBeginn) {
        List<Stand> s = adminJdbc.query("SELECT nachgeholt_ab, fertig FROM messreihe_berechnet_stand "
                + "WHERE tenant_id = ? AND messstelle_id = ?",
                (rs, n) -> new Stand(rs.getObject(1, LocalDate.class), rs.getBoolean(2), true), tenant, messstelleId);
        return s.isEmpty() ? new Stand(fensterBeginn, false, false) : s.get(0);
    }

    private void standSetzen(UUID tenant, UUID messstelleId, LocalDate ab, boolean fertig) {
        adminJdbc.update("INSERT INTO messreihe_berechnet_stand (tenant_id, messstelle_id, nachgeholt_ab, fertig) "
                + "VALUES (?, ?, ?, ?) ON CONFLICT (tenant_id, messstelle_id) DO UPDATE SET "
                + "nachgeholt_ab = EXCLUDED.nachgeholt_ab, fertig = EXCLUDED.fertig, geaendert_am = now()",
                tenant, messstelleId, Date.valueOf(ab), fertig);
    }

    /** Vorläufige berechnete Tage, Monate und Jahre VOR dem Fenster, deren Frist abgelaufen ist. */
    private List<LocalDate> nachzuegler(UUID tenant, UUID messstelleId, LocalDate fensterBeginn, Instant jetzt) {
        return adminJdbc.queryForList("""
                SELECT tag FROM (
                    SELECT tag FROM messreihe_tag
                     WHERE tenant_id = ? AND messstelle_id = ? AND zustand = 'vorlaeufig'
                       AND endgueltig_ab <= ? AND tag < ?
                    UNION
                    SELECT ((ende AT TIME ZONE zeitzone)::date - 1) AS tag FROM messreihe_periode
                     WHERE tenant_id = ? AND messstelle_id = ? AND zustand = 'vorlaeufig'
                       AND endgueltig_ab <= ? AND tag < ?) t
                 ORDER BY tag LIMIT ?
                """, LocalDate.class, tenant, messstelleId, Timestamp.from(jetzt), Date.valueOf(fensterBeginn),
                tenant, messstelleId, Timestamp.from(jetzt), Date.valueOf(fensterBeginn), NACHZUEGLER_JE_LAUF);
    }

    /** Die Zeitzone der berechneten Zeilen — dieselbe Kette wie das Lese-Modell ohne Quelle: Unternehmen → Vorgabe. */
    private record ZoneKette(ZoneId zone, String herkunft) {}

    private ZoneKette zone() {
        List<String> unternehmen = jdbc.queryForList(
                "SELECT zeitzone FROM unternehmen ORDER BY created_at, id LIMIT 1", String.class);
        if (!unternehmen.isEmpty() && TagRegeln.ZONEN.contains(unternehmen.get(0))) {
            return new ZoneKette(TagRegeln.zone(unternehmen.get(0)), TagRegeln.AUS_UNTERNEHMEN);
        }
        return new ZoneKette(TagRegeln.zone(TagRegeln.VORGABE_ZONE), TagRegeln.AUS_VORGABE);
    }

    // ------------------------------------------------------------------------------ Transaktion

    @FunctionalInterface
    private interface Zug<T> {
        T fahren(Connection con) throws SQLException;
    }

    /** Serialisiert die Schreiber EINER Messstelle bis zum Ende der Transaktion (mehrere Instanzen im Takt). */
    private static void sperren(Connection con, UUID tenant, UUID messstelleId) throws SQLException {
        try (PreparedStatement ps = con.prepareStatement("SELECT pg_advisory_xact_lock(hashtextextended(?, 0))")) {
            ps.setString(1, "uems-berechnet:" + tenant + ":" + messstelleId);
            ps.executeQuery().close();
        }
    }

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
                        : new SQLException("UEMS berechnete Periodenwerte fehlgeschlagen", e);
            } finally {
                con.setAutoCommit(autoCommit);
            }
        });
    }
}
