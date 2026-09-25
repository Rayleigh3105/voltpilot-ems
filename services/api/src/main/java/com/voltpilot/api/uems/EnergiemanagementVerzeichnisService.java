package com.voltpilot.api.uems;

import com.voltpilot.api.web.dto.EnergiemanagementVerzeichnisDto.Filter;
import com.voltpilot.api.web.dto.EnergiemanagementVerzeichnisDto.Gruppe;
import com.voltpilot.api.web.dto.EnergiemanagementVerzeichnisDto.Verzeichnis;
import com.voltpilot.api.web.dto.EnergiemanagementVerzeichnisDto.Zeile;
import com.voltpilot.api.web.dto.EnergiemanagementVerzeichnisDto.Zuschnitt;
import java.nio.charset.StandardCharsets;
import java.time.Clock;
import java.time.LocalDate;
import java.time.OffsetDateTime;
import java.time.ZoneId;
import java.time.format.DateTimeFormatter;
import java.time.temporal.ChronoUnit;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.UUID;
import java.util.stream.Collectors;
import org.springframework.beans.factory.ObjectProvider;
import org.springframework.stereotype.Service;

/**
 * UEMS AP-19 IP-8: das Verzeichnis (VZ1–VZ4, G1, G4, KS2) — ein Leser, kein Speicher. Er sammelt die Zeilen aller
 * {@link VerzeichnisQuelle}n in ihrer {@code @Order}; jede Quelle liest über den Dienst, dem ihre Nachweise gehören, im
 * Zaun und mit den Rechten des Aufrufers. Was der Aufrufer dort nicht sieht, steht hier nicht — ohne Hinweis.
 *
 * <p>Stichtag ist der Abruf (in der Zeitzone des Unternehmens); eine Zeile, deren Tag danach liegt, ist noch nicht
 * festgehalten. Filter: Gruppe, Zeitraum (von/bis, beide Tage eingeschlossen; eine Zeile ohne Tag fällt dann heraus)
 * und Person („in meinem Namen festgehalten“: die Person ist „entschieden von“ — oder, wo niemand anderes entschieden
 * hat, „eingetragen von“, G2). Eine Gruppe ohne Zeile sagt „Hier ist noch nichts festgehalten.“ und nennt ihre Zeilen
 * des Zuschnitts. Nie eine Zahl über das Ganze, nie „fehlt“, kein Urteil (G4).
 */
@Service
public class EnergiemanagementVerzeichnisService {

    public static final List<String> GRUPPEN = EnergiemanagementRegeln.VOKABULARE.get("verzeichnis_gruppe");

    private static final String GEFUEHRT = "in VoltPilot geführt";
    private static final String WORTLAUT = "Wortlaut in VoltPilot, Original bei Ihnen";
    private static final String VERWEIS = "Verweis auf Ihr System";

    /** Die Zeilen des Zuschnitts (Konzept §3.2) je Gruppe — was eine leere Gruppe nennt (VZ3). */
    static final Map<String, List<Zuschnitt>> ZUSCHNITT = Map.ofEntries(
            Map.entry("grundlagen", List.of(new Zuschnitt("Anwendungsbereich", GEFUEHRT),
                    new Zuschnitt("Kontext und interessierte Parteien", VERWEIS),
                    new Zuschnitt("Rechtliche Anforderungen", VERWEIS), new Zuschnitt("Energiepolitik", WORTLAUT))),
            Map.entry("verantwortung", List.of(new Zuschnitt("Aufgaben im Energiemanagement", GEFUEHRT))),
            Map.entry("risiken_chancen", List.of(new Zuschnitt("Risiken und Chancen", VERWEIS))),
            Map.entry("kompetenz_kommunikation", List.of(new Zuschnitt("Kompetenz", VERWEIS),
                    new Zuschnitt("Kommunikation", GEFUEHRT))),
            Map.entry("betrieb_auslegung_beschaffung", List.of(new Zuschnitt("Betrieb und Instandhaltung", VERWEIS),
                    new Zuschnitt("Auslegung", VERWEIS), new Zuschnitt("Beschaffung", VERWEIS))),
            Map.entry("bewertung_messplanung", List.of(new Zuschnitt("Energetische Bewertung und Messplanung",
                    GEFUEHRT))),
            Map.entry("kennzahlen_bezugsbasen", List.of(new Zuschnitt("Kennzahlen, Bezugsbasen und "
                    + "Leistungsvergleiche", GEFUEHRT))),
            Map.entry("ziele_massnahmen_abweichungen", List.of(new Zuschnitt("Energieziele, Maßnahmen und "
                    + "Abweichungen", GEFUEHRT))),
            Map.entry("audits_feststellungen", List.of(new Zuschnitt("Interne Audits", GEFUEHRT),
                    new Zuschnitt("Feststellung, Maßnahme, Wirksamkeit", GEFUEHRT))),
            Map.entry("managementbewertung", List.of(new Zuschnitt("Eingaben, Sitzung, Beschlüsse", GEFUEHRT))),
            Map.entry("berichte", List.of(new Zuschnitt("Berichte", GEFUEHRT))));

    /** VZ4: die Spalten der CSV, eine Zeile je Nachweis. */
    static final List<String> CSV_SPALTEN = List.of("Gruppe", "Art", "Kennzeichen", "Titel", "Fassung oder Nr.",
            "entschieden von", "eingetragen von", "Tag", "Prüfsumme", "Ort");

    private static final DateTimeFormatter STICHTAG = DateTimeFormatter.ofPattern("dd.MM.yyyy HH:mm");
    private static final DateTimeFormatter DATUM = DateTimeFormatter.ofPattern("dd.MM.yyyy");

    private final ObjectProvider<VerzeichnisQuelle> quellen;
    private final EnergiemanagementPersonenService personen;
    private final UnternehmenRepository unternehmen;
    private volatile Clock uhr = Clock.systemUTC();

    public EnergiemanagementVerzeichnisService(ObjectProvider<VerzeichnisQuelle> quellen,
            EnergiemanagementPersonenService personen, UnternehmenRepository unternehmen) {
        this.quellen = quellen;
        this.personen = personen;
        this.unternehmen = unternehmen;
    }

    /** Für Tests: die Uhr des Abrufs — an ihr hängen Stichtag und Kopfzeile. */
    void uhrStellen(Clock uhr) {
        this.uhr = uhr;
    }

    /**
     * Das Verzeichnis am Abruf: alle elf Gruppen, mit {@code gruppe} nur diese; {@code person} ist die ID einer Person
     * im Energiemanagement (404 {@code person_fehlt}). 400 bei unbekannter Gruppe oder {@code von} nach {@code bis}.
     */
    public Verzeichnis lesen(String gruppe, LocalDate von, LocalDate bis, UUID person) {
        if (gruppe != null && !GRUPPEN.contains(gruppe)) {
            throw EnergiemanagementAbgelehnt.anfrage("gruppe");
        }
        if (von != null && bis != null && von.isAfter(bis)) {
            throw EnergiemanagementAbgelehnt.anfrage("bis");
        }
        String name = person == null ? null : personen.person(person).person().name();
        OffsetDateTime jetzt = OffsetDateTime.ofInstant(uhr.instant(), zone()).truncatedTo(ChronoUnit.MINUTES);
        LocalDate stichtag = jetzt.toLocalDate();
        List<Zeile> zeilen = quellen.orderedStream().flatMap(q -> q.zeilen(stichtag).stream())
                .map(EnergiemanagementVerzeichnisService::zeile)
                .filter(z -> z.tag() == null || !z.tag().isAfter(stichtag))
                .filter(z -> (von == null && bis == null) || (z.tag() != null
                        && (von == null || !z.tag().isBefore(von)) && (bis == null || !z.tag().isAfter(bis))))
                .filter(z -> name == null || inSeinemNamen(z, name))
                .toList();
        var gruppen = new ArrayList<Gruppe>();
        for (String g : GRUPPEN) {
            if (gruppe != null && !gruppe.equals(g)) continue;
            List<Zeile> diese = zeilen.stream().filter(z -> z.gruppe().equals(g)).toList();
            gruppen.add(new Gruppe(g, EnergiemanagementRegeln.WOERTER.get("verzeichnis_gruppe").get(g), ZUSCHNITT.get(g),
                    diese.isEmpty() ? EnergiemanagementRegeln.SAETZE.get("verzeichnis_leer") : null, diese));
        }
        return new Verzeichnis(jetzt, EnergiemanagementRegeln.SAETZE.get("verantwortung"),
                new Filter(gruppe, von, bis, person, name), gruppen);
    }

    /**
     * VZ4, KS2: das Verzeichnis als CSV für das System des Kunden — UTF-8 mit BOM, CRLF, Trenner {@code ;} (wie die
     * Berichts-CSV); Kopfzeilen mit Stichtag, Verantwortungs-Satz und den wirksamen Filtern, dann die Spalten und eine
     * Zeile je Nachweis. Sie zeigt, was die Seite zeigt.
     */
    public static byte[] csv(Verzeichnis v) {
        var zeilen = new ArrayList<String>();
        zeilen.add("# Stichtag " + v.stichtag().format(STICHTAG));
        zeilen.add("# " + v.verantwortung());
        Filter f = v.filter();
        if (f.gruppe() != null) {
            zeilen.add("# Gruppe: " + EnergiemanagementRegeln.WOERTER.get("verzeichnis_gruppe").get(f.gruppe()));
        }
        if (f.von() != null || f.bis() != null) {
            zeilen.add("# Zeitraum: " + (f.von() == null ? "" : "ab " + f.von().format(DATUM))
                    + (f.von() != null && f.bis() != null ? " " : "") + (f.bis() == null ? "" : "bis " + f.bis().format(DATUM)));
        }
        if (f.personName() != null) {
            zeilen.add("# Person: " + f.personName());
        }
        zeilen.add(csvZeile(CSV_SPALTEN.toArray(String[]::new)));
        for (Gruppe g : v.gruppen()) {
            for (Zeile z : g.zeilen()) {
                zeilen.add(csvZeile(z.gruppeWort(), z.art(), z.kennzeichen(), z.titel(),
                        z.nr() == null ? null : z.nr().toString(), z.entschiedenVon(), z.eingetragenVon(),
                        z.tag() == null ? null : z.tag().toString(), z.pruefsumme(), z.ortSatz()));
            }
        }
        String text = BerichtCsv.BOM + zeilen.stream().map(s -> s + BerichtCsv.ZEILENENDE).collect(Collectors.joining());
        return text.getBytes(StandardCharsets.UTF_8);
    }

    /** G2: „in meinem Namen“ — entschieden von, oder eingetragen von, wo niemand anderes entschieden hat. */
    private static boolean inSeinemNamen(Zeile z, String name) {
        return z.entschiedenVon() != null ? z.entschiedenVon().equals(name) : Objects.equals(z.eingetragenVon(), name);
    }

    private static Zeile zeile(Map<String, Object> m) {
        Object tag = m.get("tag");
        return new Zeile((String) m.get("gruppe"), (String) m.get("art"), (String) m.get("kennzeichen"),
                (String) m.get("titel"), (Integer) m.get("nr"), (String) m.get("entschieden_von"),
                (String) m.get("eingetragen_von"), tag == null ? null : LocalDate.parse(tag.toString().substring(0, 10)),
                (String) m.get("pruefsumme"), (String) m.get("ort"), (String) m.get("gruppe_wort"),
                (String) m.get("ort_satz"));
    }

    /**
     * Eine Zelle mit {@code ;}, {@code "} oder Zeilenumbruch in Anführungszeichen (wie die Berichts-CSV); ein Titel, der
     * mit {@code = + - @} beginnt, bekommt ein {@code '} davor — die Tabelle des Kunden rechnet keinen Wortlaut.
     */
    private static String csvZeile(String... zellen) {
        var raus = new ArrayList<String>();
        for (String s : zellen) {
            if (s != null && !s.isEmpty() && "=+-@".indexOf(s.charAt(0)) >= 0) {
                s = "'" + s;
            }
            if (s == null) {
                raus.add("");
            } else if (s.contains(BerichtRegeln.CSV_TRENNER) || s.contains("\"") || s.contains("\n") || s.contains("\r")) {
                raus.add("\"" + s.replace("\"", "\"\"") + "\"");
            } else {
                raus.add(s);
            }
        }
        return String.join(BerichtRegeln.CSV_TRENNER, raus);
    }

    private ZoneId zone() {
        return ZoneId.of(unternehmen.desKundenbereichs().map(UnternehmenRepository.Unternehmen::zeitzone)
                .orElse("Europe/Berlin"));
    }
}
