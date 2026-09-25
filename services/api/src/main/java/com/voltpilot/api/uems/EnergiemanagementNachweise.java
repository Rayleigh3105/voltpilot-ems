package com.voltpilot.api.uems;

import com.voltpilot.api.web.dto.EnergiemanagementDokumentDto;
import com.voltpilot.api.web.dto.EnergiemanagementDokumentDto.Kommunikationsnachweis;
import com.voltpilot.api.web.dto.EnergiemanagementDokumentDto.Nachweis;
import com.voltpilot.api.web.dto.EnergiemanagementDokumentDto.NachweisOrt;
import com.voltpilot.api.web.dto.EnergiemanagementPersonenDto.PersonKurz;
import java.time.LocalDate;
import java.time.format.DateTimeFormatter;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Comparator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Objects;
import java.util.UUID;
import java.util.function.Predicate;
import org.springframework.stereotype.Service;

/**
 * UEMS AP-19 IP-14: betriebliche Nachweise am Energieeinsatz und an der Person, die Bekanntmachungen als Liste der
 * Kommunikationsnachweise (DK1, DK6, KS1; Konzept §3.5, §3.7, §5.3, R7, R8).
 *
 * <p>Ein Leser, kein Speicher: jedes Dokument wird über {@link EnergiemanagementDokumentService} gelesen — im Zaun und
 * mit den Rechten der Anfrage; was die Anfrage nicht sieht, fehlt still. Der Abschnitt „Nachweise“ eines Einsatzes nennt
 * die Dokumente, deren Bezug dieser Einsatz ist (Betrieb und Instandhaltung, Auslegung, Beschaffung …), je mit dem Ort
 * der gültigen Fassung und der Überprüfung beim Abruf; ein Einsatz, den die Anfrage nicht sieht, ist 404 wie einer, den
 * es nicht gibt. Die Nachweise einer Person sind die Dokumente an ihr und an ihren Aufgaben (Kompetenz als Verweis ins
 * Personalsystem, ohne Überprüfung).
 *
 * <p>Eine Bekanntmachung ist EINE Mitteilung: die Einträge desselben Dokuments mit derselben Fassung, demselben Tag,
 * demselben Kreis und derselben Person — je Weg ein Eintrag in der Tabelle — werden zu einem Kommunikationsnachweis mit
 * allen Wegen („über Aushang und Intranet“, Referenzdatei 1.10 {@code "aushang · intranet"}). VoltPilot verschickt
 * nichts und fragt kein „gelesen“ ab.
 */
@Service
public class EnergiemanagementNachweise {

    /** Die Kundenwörter der Wege (Vokabular {@code bekanntmachung_weg}); „weiterer“ nennt seinen Wortlaut. */
    static final Map<String, String> WEG_WORT = Map.of("aushang", "Aushang", "intranet", "Intranet", "unterweisung",
            "Unterweisung", "besprechung", "Besprechung", "e_mail", "E-Mail");
    private static final DateTimeFormatter TAG = DateTimeFormatter.ofPattern("dd.MM.yyyy");

    private final EnergiemanagementDokumentService dokumente;
    private final EnergieeinsatzService einsaetze;
    private final EnergiemanagementPersonenService personen;

    public EnergiemanagementNachweise(EnergiemanagementDokumentService dokumente, EnergieeinsatzService einsaetze,
            EnergiemanagementPersonenService personen) {
        this.dokumente = dokumente;
        this.einsaetze = einsaetze;
        this.personen = personen;
    }

    /** R7: der Abschnitt „Nachweise“ am Energieeinsatz; ein Einsatz außerhalb des Zauns ist 404. */
    public EnergiemanagementDokumentDto.NachweiseAmEinsatz amEinsatz(UUID id) {
        EnergieeinsatzRepository.Zeile e;
        try {
            e = einsaetze.sichtbareZeile(id);
        } catch (EnergieeinsatzAbgelehnt nichtDa) {
            throw new EnergiemanagementAbgelehnt(404, "nicht_gefunden", "Diesen Energieeinsatz gibt es nicht.", null);
        }
        return new EnergiemanagementDokumentDto.NachweiseAmEinsatz(new EnergiemanagementDokumentDto.EinsatzKurz(e.id(),
                e.kennzeichen(), e.name()), dokumente.heute(), nachweise(b -> b.energieeinsatz() != null
                        && id.equals(b.energieeinsatz().id())));
    }

    /** R8: die Nachweise an der Person und an ihren Aufgaben; die Person gibt es im ganzen Kundenbereich (sonst 404). */
    public EnergiemanagementDokumentDto.NachweiseDerPerson derPerson(UUID id) {
        var p = personen.person(id).person();
        return new EnergiemanagementDokumentDto.NachweiseDerPerson(new PersonKurz(p.id(), p.name(), p.funktion(),
                p.kuerzel(), p.konto() != null), dokumente.heute(), nachweise(b -> (b.person() != null
                        && id.equals(b.person().id())) || (b.aufgabe() != null && b.aufgabe().person() != null
                        && id.equals(b.aufgabe().person().id()))));
    }

    /** DK6: jede Bekanntmachung eines Dokuments im Zaun als ein Kommunikationsnachweis, nach Tag und Kennzeichen. */
    public EnergiemanagementDokumentDto.Kommunikationsnachweise bekanntmachungen() {
        List<Kommunikationsnachweis> alle = new ArrayList<>();
        for (var kurz : dokumente.dokumente().dokumente()) {
            alle.addAll(kommunikation(dokumente.dokument(kurz.id())));
        }
        alle.sort(Comparator.comparing(Kommunikationsnachweis::am)
                .thenComparing(k -> k.kennzeichen().length()).thenComparing(Kommunikationsnachweis::kennzeichen));
        return new EnergiemanagementDokumentDto.Kommunikationsnachweise(dokumente.heute(), alle);
    }

    private List<Nachweis> nachweise(Predicate<EnergiemanagementDokumentDto.BezugAus> bezug) {
        return dokumente.dokumente().dokumente().stream().filter(k -> bezug.test(k.bezug()))
                .map(k -> nachweis(dokumente.dokument(k.id()))).toList();
    }

    private static Nachweis nachweis(EnergiemanagementDokumentDto.Dokument d) {
        return new Nachweis(d.id(), d.kennzeichen(), d.art(), d.artWort(), d.klasse(), d.titel(), d.bezug(),
                d.zustand(), d.gueltigeFassung(), ort(d), d.ueberpruefung(), kommunikation(d));
    }

    /**
     * KS1, G1: der Ort der gültigen Fassung — Verweis „Geführt in Ihrem System: …“ mit Kennung und Fassungsangabe des
     * Kunden, Wortlaut mit Original beim Kunden oder „in VoltPilot“; ohne gültige Fassung {@code null}. Das Ort-Wort und
     * die Zeile kommen aus der Operation {@code verzeichnis_zeile}, der Satz aus {@code satz} ({@code ort_verweis} bzw.
     * {@code ort_wortlaut}).
     */
    static NachweisOrt ort(EnergiemanagementDokumentDto.Dokument d) {
        if (d.gueltigeFassung() == null) {
            return null;
        }
        var f = d.fassungen().stream().filter(x -> x.nr() == d.gueltigeFassung()).findFirst().orElseThrow();
        var v = f.verweis();
        var beleg = d.beleg();
        String ort;
        String ablage;
        String kennung;
        String adresse;
        String fassungsangabe = null;
        LocalDate datum = null;
        String sha256;
        if (v != null) {
            ort = "verweis";
            ablage = v.ablage();
            kennung = v.kennung();
            adresse = v.adresse();
            fassungsangabe = v.fassungsangabe();
            datum = v.datum();
            sha256 = v.sha256();
        } else if (beleg != null) {
            ort = "wortlaut_original_beim_kunden";
            ablage = beleg.ablage();
            kennung = beleg.kennung();
            adresse = beleg.adresse();
            sha256 = beleg.sha256();
        } else {
            ort = "in_voltpilot";
            ablage = null;
            kennung = null;
            adresse = null;
            sha256 = null;
        }
        Map<String, Object> zeile = EnergiemanagementRegeln.verzeichnisZeile(new EnergiemanagementRegeln
                .VerzeichnisEingang(DokumentVerzeichnis.GRUPPE.get(d.art()), d.art(), d.kennzeichen(), d.titel(), f.nr(),
                        null, null, null, null, ort, ablage));
        if (zeile.containsKey("fehler")) {
            throw new IllegalStateException("Ort von " + d.kennzeichen() + ": " + zeile.get("fehler"));
        }
        String ortSatz = (String) zeile.get("ort_satz");
        String satz = switch (ort) {
            case "verweis" -> {
                String angaben = angaben(kennung, fassungsangabe, datum);
                yield angaben == null ? ortSatz + "." : satz("ort_verweis", Map.of("ablage", ablage, "angaben", angaben));
            }
            case "wortlaut_original_beim_kunden" -> satz("ort_wortlaut", Map.of("ablage", ablage));
            default -> null;
        };
        boolean https = adresse != null && adresse.toLowerCase(Locale.ROOT).startsWith("https:");
        return new NachweisOrt(ort, ortSatz, satz, v == null, f.nr(), f.entschiedenAm(), ablage, kennung, adresse,
                https, fassungsangabe, datum, sha256);
    }

    /** „IH-SG-01, Rev. 4 vom 03.11.2028“ bzw. „UW-2028-014 vom 24.01.2028“ — die Angaben des Kunden, sonst nichts. */
    static String angaben(String kennung, String fassungsangabe, LocalDate datum) {
        String stand = fassungsangabe != null ? fassungsangabe : datum == null ? null : "vom " + datum.format(TAG);
        if (kennung == null) {
            return stand;
        }
        return stand == null ? kennung : kennung + (fassungsangabe != null ? ", " : " ") + stand;
    }

    /**
     * DK6: die Bekanntmachungen eines Dokuments — je Fassung, Tag, Kreis und Person eine, mit allen Wegen in der
     * Reihenfolge ihrer Einträge.
     */
    static List<Kommunikationsnachweis> kommunikation(EnergiemanagementDokumentDto.Dokument d) {
        Map<List<Object>, List<EnergiemanagementDokumentDto.Eintrag>> gruppen = new LinkedHashMap<>();
        for (var e : d.eintraege()) {
            if ("bekannt_gemacht".equals(e.art())) {
                gruppen.computeIfAbsent(Arrays.asList(e.fassung(), e.am(), e.kreis(),
                        e.person() == null ? null : e.person().id()), k -> new ArrayList<>()).add(e);
            }
        }
        List<Kommunikationsnachweis> aus = new ArrayList<>();
        for (var g : gruppen.values()) {
            var erster = g.get(0);
            List<String> wege = g.stream().map(EnergiemanagementDokumentDto.Eintrag::weg).distinct().toList();
            List<String> worte = g.stream().map(e -> "weiterer".equals(e.weg()) ? e.wegWortlaut()
                    : WEG_WORT.get(e.weg())).filter(Objects::nonNull).distinct().toList();
            String wegeWort = aufzaehlung(worte);
            PersonKurz person = erster.person();
            aus.add(new Kommunikationsnachweis(d.id(), d.kennzeichen(), d.titel(), d.art(), erster.fassung(),
                    erster.am(), erster.kreis(), wege, wegeWort, person, satz("bekanntmachung", Map.of("am",
                            erster.am().format(TAG), "kreis", erster.kreis(), "weg", wegeWort, "person",
                            person == null ? "—" : person.name()))));
        }
        return aus;
    }

    /** „A“, „A und B“, „A, B und C“. */
    static String aufzaehlung(List<String> worte) {
        if (worte.size() <= 1) {
            return worte.isEmpty() ? "" : worte.get(0);
        }
        return String.join(", ", worte.subList(0, worte.size() - 1)) + " und " + worte.get(worte.size() - 1);
    }

    private static String satz(String schluessel, Map<String, String> werte) {
        Map<String, Object> s = EnergiemanagementRegeln.satz(schluessel, werte);
        if (s.containsKey("fehler")) {
            throw new IllegalStateException("Satz " + schluessel + ": " + s.get("fehler"));
        }
        return (String) s.get("satz");
    }
}
