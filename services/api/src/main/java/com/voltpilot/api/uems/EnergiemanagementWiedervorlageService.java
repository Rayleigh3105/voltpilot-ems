package com.voltpilot.api.uems;

import com.voltpilot.api.web.dto.EnergiemanagementPersonenDto;
import com.voltpilot.api.web.dto.EnergiemanagementVerzeichnisDto;
import com.voltpilot.api.web.dto.EnergiemanagementWiedervorlageDto.Erledigt;
import com.voltpilot.api.web.dto.EnergiemanagementWiedervorlageDto.Herleitung;
import com.voltpilot.api.web.dto.EnergiemanagementWiedervorlageDto.NaechsteManagementbewertung;
import com.voltpilot.api.web.dto.EnergiemanagementWiedervorlageDto.Wiedervorlage;
import com.voltpilot.api.web.dto.EnergiemanagementWiedervorlageDto.Zeile;
import com.voltpilot.api.web.dto.EnergiemanagementWiedervorlageDto.Zuletzt;
import com.voltpilot.api.web.dto.EnergiemanagementWiedervorlageDto.Zustaendig;
import java.nio.charset.StandardCharsets;
import java.time.Clock;
import java.time.Instant;
import java.time.LocalDate;
import java.time.OffsetDateTime;
import java.time.ZoneId;
import java.time.ZoneOffset;
import java.time.format.DateTimeFormatter;
import java.time.temporal.ChronoUnit;
import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Comparator;
import java.util.Deque;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import org.springframework.beans.factory.ObjectProvider;
import org.springframework.security.core.context.SecurityContextHolder;
import org.springframework.stereotype.Service;

/**
 * UEMS AP-19 IP-21: die Wiedervorlage (WV1–WV4, E10 = A) — ein Leser, kein Speicher, kein Läufer, keine Nachricht. Er
 * sammelt die Fristen aller {@link WiedervorlageQuelle}n in ihrer {@code @Order}; jede Quelle liest über den Dienst, dem
 * ihre Frist gehört, im Zaun und mit den Rechten des Aufrufers, und rechnet nichts nach (WV2). Lage, Vorschau-Fenster
 * (Einstellung, Startwert 30 Tage) und Reihenfolge macht die Operation {@code wiedervorlage} des Vertrags.
 *
 * <p>Abruf ist der Tag in der Zeitzone des Unternehmens. Der Kalender-Abzug ({@link #ics}) trägt dieselben Zeilen mit
 * dem Vermerk „Stand vom … aus VoltPilot; maßgeblich ist die Wiedervorlage im Portal.“ — ein Abruf, keine Zustellung.
 */
@Service
public class EnergiemanagementWiedervorlageService {

    private static final DateTimeFormatter DATUM = DateTimeFormatter.ofPattern("dd.MM.yyyy");
    private static final DateTimeFormatter ICS_TAG = DateTimeFormatter.BASIC_ISO_DATE;
    private static final DateTimeFormatter ICS_ZEIT = DateTimeFormatter.ofPattern("yyyyMMdd'T'HHmmss'Z'");

    /**
     * Konzept Wiedervorlage w1, §5.4: wer eine Frist erledigt, wenn das Objekt keine Person nennt: die Person der
     * laufenden Aufgabe im Energiemanagement. Die Managementbewertung nennt ihre Person schon aus der Aufgabe.
     */
    static final Map<String, String> ART_AUFGABE = Map.ofEntries(
            Map.entry("dokument_ueberpruefung", "dokumente"),
            Map.entry("internes_audit", "interne_audits"),
            Map.entry("managementbewertung", "managementbewertung"),
            Map.entry("bezugsbasis_ueberpruefung", "bezugsbasen"),
            Map.entry("bewertung_ueberpruefung", "bewertung_messplanung"),
            Map.entry("messbedarf_frist", "bewertung_messplanung"),
            Map.entry("zaehlerablesung", "bewertung_messplanung"),
            Map.entry("massnahme_termin", "energieziele_massnahmen"),
            Map.entry("energieziel_bewertung", "energieziele_massnahmen"),
            Map.entry("abweichung_frist", "energieziele_massnahmen"),
            Map.entry("bericht_anstoss", "energiemanagement_leiten"));

    /** „Zuletzt erledigt“: so weit zurück liest der Leser, so viele Einträge gibt er höchstens (Konzept w1). */
    public static final int ZULETZT_TAGE = 90;
    public static final int ZULETZT_ANZAHL = 5;

    /** Verzeichnis-Arten, die eine Frist beenden oder neu beginnen lassen (außer Dokument-Fassungen einer Vorgabe). */
    private static final Set<String> ERLEDIGT_ARTEN = Set.of("internes_audit", "wirksamkeit", "energieziel_bewertung",
            "massnahme_bewertung", "abweichung_abschluss");

    private final ObjectProvider<WiedervorlageQuelle> quellen;
    private final ObjectProvider<ManagementbewertungWiedervorlage> managementbewertung;
    private final EnergiemanagementEinstellungRepository einstellung;
    private final UnternehmenRepository unternehmen;
    private final ObjectProvider<EnergiemanagementPersonenService> personen;
    private final ObjectProvider<EnergiemanagementVerzeichnisService> verzeichnis;
    private final ObjectProvider<EnergiemanagementDokumentService> dokumente;
    private final ObjectProvider<BezugsbasisPflegeService> bezugsbasen;
    private volatile Clock uhr = Clock.systemUTC();

    public EnergiemanagementWiedervorlageService(ObjectProvider<WiedervorlageQuelle> quellen,
            ObjectProvider<ManagementbewertungWiedervorlage> managementbewertung,
            EnergiemanagementEinstellungRepository einstellung, UnternehmenRepository unternehmen,
            ObjectProvider<EnergiemanagementPersonenService> personen,
            ObjectProvider<EnergiemanagementVerzeichnisService> verzeichnis,
            ObjectProvider<EnergiemanagementDokumentService> dokumente,
            ObjectProvider<BezugsbasisPflegeService> bezugsbasen) {
        this.quellen = quellen;
        this.managementbewertung = managementbewertung;
        this.einstellung = einstellung;
        this.unternehmen = unternehmen;
        this.personen = personen;
        this.verzeichnis = verzeichnis;
        this.dokumente = dokumente;
        this.bezugsbasen = bezugsbasen;
    }

    /** Für Tests: die Uhr des Abrufs — an ihr hängen Stichtag, Lage und Vermerk. */
    void uhrStellen(Clock uhr) {
        this.uhr = uhr;
    }

    /** Die Wiedervorlage am Abruf: fällige Zeilen, Vorschau, die Kennzeichen außerhalb des Fensters. */
    public Wiedervorlage lesen() {
        return lesen(uhr.instant());
    }

    /**
     * AP-19 IP-22: dieselbe Wiedervorlage zu einem gegebenen Augenblick — dem Datenstand des Abzugs einer
     * Managementbewertung (Abschnitt „Wiedervorlage zum Stichtag“).
     */
    @SuppressWarnings("unchecked")
    public Wiedervorlage lesen(Instant stichtag) {
        OffsetDateTime jetzt = OffsetDateTime.ofInstant(stichtag, zone()).truncatedTo(ChronoUnit.MINUTES);
        LocalDate abruf = jetzt.toLocalDate();
        int vorschauTage = einstellung.vorschauTage();
        List<WiedervorlageQuelle.Frist> fristen = fristen(abruf);
        Map<String, Object> r = EnergiemanagementRegeln.wiedervorlage(new EnergiemanagementRegeln.WiedervorlageEingang(
                abruf.toString(), vorschauTage, fristen.stream().map(f -> new EnergiemanagementRegeln.WiedervorlageZeile(
                        f.art(), f.kennzeichen(), f.titel(), f.faelligAm().toString(), f.verantwortlich())).toList()));
        if (r.containsKey("fehler")) {
            throw new IllegalStateException("Wiedervorlage nicht berechenbar: " + r.get("fehler"));
        }
        // Der Sprung hängt an der Frist, nicht an der Ausgabe: gleiche Zeilen kommen in der Reihenfolge des Eingangs
        // zurück (die Sortierung der Operation ist stabil), also ordnet die Warteschlange je Schlüssel sie wieder zu.
        Map<List<String>, Deque<WiedervorlageQuelle.Frist>> je = new HashMap<>();
        for (var f : fristen) {
            je.computeIfAbsent(schluessel(f.art(), f.kennzeichen(), f.titel(), f.faelligAm().toString()),
                    k -> new ArrayDeque<>()).add(f);
        }
        Zustaendigkeit wer = zustaendigkeit(abruf);
        List<Zeile> faellig = zeilen((List<Map<String, Object>>) r.get("faellig"), je, wer);
        List<Zeile> vorschau = zeilen((List<Map<String, Object>>) r.get("vorschau"), je, wer);
        List<Zeile> spaeter = zeilen((List<Map<String, Object>>) r.get("spaeter"), je, wer);
        return new Wiedervorlage(jetzt, vorschauTage, faellig, vorschau, (int) r.get("anzahl_faellig"),
                (int) r.get("anzahl_vorschau"), (List<String>) r.get("nicht_in_liste"),
                EnergiemanagementRegeln.SAETZE.get("verantwortung"), naechsteManagementbewertung(abruf), spaeter,
                (int) r.get("anzahl_ueberfaellig"), (int) r.get("anzahl_naechste"), (int) r.get("anzahl_spaeter"),
                wer.lesbar());
    }

    // ------------------------------------------------------------------ Zuständig (Konzept w1, Entscheid 6)

    /**
     * Am Abruf: je Aufgabe die Person der laufenden Zuordnung, dazu wer der Aufrufer ist (Konto und Person im
     * Energiemanagement); einmal je Abruf, nicht je Zeile. {@code lesbar}: der Aufrufer liest die Aufgaben überhaupt
     * (unternehmensweit); sonst kennt der Leser keine Person laut Aufgabe und sagt auch nicht, dass es keine gibt.
     */
    private record Zustaendigkeit(Map<String, EnergiemanagementPersonenDto.PersonKurz> aufgabe, String sub,
            UUID person, String personName, boolean lesbar) {}

    private Zustaendigkeit zustaendigkeit(LocalDate abruf) {
        var auth = SecurityContextHolder.getContext().getAuthentication();
        String sub = ProtokollAkteur.aus(auth).map(ProtokollAkteur::sub).orElse(null);
        var dienst = personen.getIfAvailable();
        if (dienst == null) return new Zustaendigkeit(Map.of(), sub, null, null, false);
        // Wer nicht unternehmensweit liest, bekommt vom Dienst keine Aufgabe (nicht einmal die ohne Person).
        var aufgaben = dienst.aufgaben(abruf).aufgaben();
        Map<String, EnergiemanagementPersonenDto.PersonKurz> aufgabe = new HashMap<>();
        for (var a : aufgaben) {
            if (!a.laufend().isEmpty()) aufgabe.put(a.aufgabe(), a.laufend().get(0).person());
        }
        var ich = sub == null ? null : dienst.personen().personen().stream()
                .filter(p -> p.konto() != null && sub.equals(p.konto().sub())).findFirst().orElse(null);
        return new Zustaendigkeit(aufgabe, sub, ich == null ? null : ich.id(), ich == null ? null : ich.name(),
                !aufgaben.isEmpty());
    }

    /**
     * Die Person am Objekt geht vor; nennt das Objekt keine (Dokument, Bewertung, Bericht, Messbedarf), die Person der
     * Aufgabe ({@link #ART_AUFGABE}); die Managementbewertung zählt immer als Aufgabe. Ohne beide: {@code null}.
     */
    private static Zustaendig zustaendig(String art, String verantwortlich, WiedervorlageQuelle.Herkunft h,
            Zustaendigkeit wer) {
        if (verantwortlich != null && !"managementbewertung".equals(art)) {
            String konto = h == null ? null : h.verantwortlichSub();
            boolean ich = konto != null ? konto.equals(wer.sub()) : verantwortlich.equals(wer.personName());
            return new Zustaendig(verantwortlich, "objekt", ich);
        }
        String aufgabe = ART_AUFGABE.get(art);
        var p = aufgabe == null ? null : wer.aufgabe().get(aufgabe);
        if (p == null) return null;
        return new Zustaendig(p.name(), "aufgabe", p.id().equals(wer.person()));
    }

    // ------------------------------------------------------------------ Zuletzt erledigt (Konzept w1)

    /**
     * Die letzten Entscheidungen, die eine Frist beenden oder neu beginnen lassen: die Zeilen des Verzeichnisses (mit
     * den Rechten des Aufrufers) und dazu „geprüft, bleibt“ an Dokumenten und Bezugsbasen, die das Verzeichnis nicht
     * führt. {@code tage} Tage bis zum Abruf, die jüngste zuerst, höchstens {@code anzahl}.
     */
    public Zuletzt zuletzt(int tage, int anzahl) {
        OffsetDateTime jetzt = OffsetDateTime.ofInstant(uhr.instant(), zone()).truncatedTo(ChronoUnit.MINUTES);
        LocalDate bis = jetzt.toLocalDate();
        LocalDate ab = bis.minusDays(tage);
        var aus = new ArrayList<Erledigt>();
        for (var g : verzeichnis.getObject().lesen(null, ab, bis, null).gruppen()) {
            for (var z : g.zeilen()) {
                if (z.tag() == null || z.tag().isBefore(ab) || z.tag().isAfter(bis) || !erledigt(g.gruppe(), z)) continue;
                aus.add(new Erledigt(z.art(), g.gruppe(), z.kennzeichen(), z.titel(), z.nr(), z.tag(), z.entschiedenVon(),
                        z.eingetragenVon()));
            }
        }
        for (var b : dokumente.getObject().geprueftBleibt(ab, bis)) {
            aus.add(new Erledigt("dokument_geprueft_bleibt", null, b.kennzeichen(), b.titel(), b.fassung(), b.am(),
                    b.entschiedenVon(), b.eingetragenVon()));
        }
        for (var b : bezugsbasen.getObject().bestaetigt(ab, bis)) {
            aus.add(new Erledigt("bezugsbasis_geprueft_bleibt", null, b.kennzeichen(), "Bezugsbasis " + b.kennzeichen()
                    + " (" + b.kennzahlKennzeichen() + " " + b.kennzahlName() + ")", b.fassung(), b.am(), null,
                    b.eingetragenVon()));
        }
        aus.sort(Comparator.comparing(Erledigt::am).reversed().thenComparing(Erledigt::kennzeichen));
        return new Zuletzt(jetzt, tage, aus.size() > anzahl ? List.copyOf(aus.subList(0, anzahl)) : List.copyOf(aus));
    }

    /**
     * Zählt eine Zeile des Verzeichnisses als „erledigt“? Eine freigegebene Fassung einer Vorgabe, ein abgeschlossenes
     * Audit, eine Wirksamkeit, eine Bezugsbasis-Fassung, eine Bewertung eines Ziels oder einer Maßnahme, ein Abschluss
     * einer Abweichung, der Stand einer energetischen Bewertung oder Managementbewertung und ein Berichtsstand nach einer
     * Korrektur (Nr. ab 2); keine Kennzahl-Fassung, keine Aufgabe, keine Feststellung, kein Nachweis.
     */
    private static boolean erledigt(String gruppe, EnergiemanagementVerzeichnisDto.Zeile z) {
        if ("vorgabe".equals(EnergiemanagementRegeln.DOKUMENT_ART_KLASSE.get(z.art()))) return true;
        if ("bezugsbasis_fassung".equals(z.art())) return z.nr() != null;
        if (ERLEDIGT_ARTEN.contains(z.art())) return true;
        if (!"berichtsstand".equals(z.art()) || z.nr() == null) return false;
        return "managementbewertung".equals(gruppe) || "bewertung_messplanung".equals(gruppe) || z.nr() > 1;
    }

    /** MG7 mit Herkunft, auch außerhalb des Fensters — aus derselben Quelle wie die Zeile, nie nachgerechnet (WV2). */
    private NaechsteManagementbewertung naechsteManagementbewertung(LocalDate abruf) {
        var quelle = managementbewertung.getIfAvailable();
        if (quelle == null) return null;
        return quelle.naechste(abruf).map(n -> new NaechsteManagementbewertung(n.faelligAm(), n.kennzeichen(),
                n.sitzungAm(), n.rhythmusMonate())).orElse(null);
    }

    /**
     * Jede Frist am Tag {@code abruf} aus allen Quellen in ihrer Folge — auch außerhalb des Vorschau-Fensters (AP-19 IP-22:
     * die Überprüfung einer Grundlage, einer Bezugsbasis oder der Bewertung in der Managementbewertung).
     */
    public List<WiedervorlageQuelle.Frist> fristen(LocalDate abruf) {
        return quellen.orderedStream().flatMap(q -> q.fristen(abruf).stream()).filter(f -> f.faelligAm() != null)
                .toList();
    }

    /** Der Tag in der Zeitzone des Unternehmens zu einem Augenblick. */
    public LocalDate tag(Instant augenblick) {
        return LocalDate.ofInstant(augenblick, zone());
    }

    /**
     * E10 = A, WV4: der Kalender-Abzug (RFC 5545), je Zeile der Wiedervorlage (fällig, Vorschau, Jahresplan) ein ganztägiger
     * Termin am Tag, an dem sie fällig ist bzw. wird; Titel „Kennzeichen: Titel“, Beschreibung und Kalender tragen den
     * Stand-Vermerk. Die Zeilen veralten im Kalender des Kunden — der Vermerk sagt es.
     */
    public static byte[] ics(Wiedervorlage w) {
        String vermerk = vermerk(w.stichtag().toLocalDate());
        String stempel = ICS_ZEIT.format(w.stichtag().withOffsetSameInstant(ZoneOffset.UTC));
        var s = new StringBuilder();
        zeile(s, "BEGIN:VCALENDAR");
        zeile(s, "VERSION:2.0");
        zeile(s, "PRODID:-//VoltPilot//Wiedervorlage Energiemanagement//DE");
        zeile(s, "CALSCALE:GREGORIAN");
        zeile(s, "METHOD:PUBLISH");
        zeile(s, "X-WR-CALNAME:" + text("Wiedervorlage Energiemanagement"));
        zeile(s, "X-WR-CALDESC:" + text(vermerk));
        Map<String, Integer> uids = new HashMap<>();
        for (Zeile z : alle(w)) {
            String uid = z.art() + "-" + z.kennzeichen() + "-" + ICS_TAG.format(z.faelligAm());
            int n = uids.merge(uid, 1, Integer::sum);
            zeile(s, "BEGIN:VEVENT");
            zeile(s, "UID:" + uid + (n > 1 ? "-" + n : "") + "@wiedervorlage.voltpilot");
            zeile(s, "DTSTAMP:" + stempel);
            zeile(s, "DTSTART;VALUE=DATE:" + ICS_TAG.format(z.faelligAm()));
            zeile(s, "DTEND;VALUE=DATE:" + ICS_TAG.format(z.faelligAm().plusDays(1)));
            zeile(s, "SUMMARY:" + text(z.kennzeichen() + ": " + z.titel()));
            zeile(s, "DESCRIPTION:" + text(vermerk));
            zeile(s, "TRANSP:TRANSPARENT");
            zeile(s, "END:VEVENT");
        }
        zeile(s, "END:VCALENDAR");
        return s.toString().getBytes(StandardCharsets.UTF_8);
    }

    /** WV4: „Stand vom &lt;Tag&gt; aus VoltPilot; maßgeblich ist die Wiedervorlage im Portal.“ (§5.8). */
    static String vermerk(LocalDate stand) {
        return (String) EnergiemanagementRegeln.satz("kalender_abzug", Map.of("am", DATUM.format(stand))).get("satz");
    }

    /** Seit Vertrag 1.1 trägt der Kalender-Abzug auch den Jahresplan: das Jahr steht im Kalender. */
    private static List<Zeile> alle(Wiedervorlage w) {
        var alle = new ArrayList<Zeile>(w.faellig());
        alle.addAll(w.vorschau());
        if (w.spaeter() != null) alle.addAll(w.spaeter());
        return alle;
    }

    private static List<Zeile> zeilen(List<Map<String, Object>> aus, Map<List<String>, Deque<WiedervorlageQuelle.Frist>> je,
            Zustaendigkeit wer) {
        return aus.stream().map(z -> {
            var f = je.get(schluessel((String) z.get("art"), (String) z.get("kennzeichen"), (String) z.get("titel"),
                    (String) z.get("faellig_am"))).poll();
            UUID id = f == null ? null : f.id();
            UUID kennzahl = f == null ? null : f.kennzahlId();
            var h = f == null ? null : f.herkunft();
            String art = (String) z.get("art");
            String verantwortlich = (String) z.get("verantwortlich");
            return new Zeile(art, (String) z.get("kennzeichen"), (String) z.get("titel"),
                    LocalDate.parse((String) z.get("faellig_am")), (int) z.get("tage"), (String) z.get("satz"),
                    verantwortlich, id, kennzahl, herleitung(h), h == null ? null : h.bezug(),
                    h == null ? null : h.einsatzId(), ART_AUFGABE.get(art), zustaendig(art, verantwortlich, h, wer));
        }).toList();
    }

    private static Herleitung herleitung(WiedervorlageQuelle.Herkunft h) {
        if (h == null || h.basis() == null) return null;
        return new Herleitung(h.basis(), h.am(), h.fassung(), h.monate(), h.kennung(), h.quelleArt(), h.anzahl());
    }

    private static List<String> schluessel(String art, String kennzeichen, String titel, String faelligAm) {
        return Arrays.asList(art, kennzeichen, titel, faelligAm);
    }

    private ZoneId zone() {
        return ZoneId.of(unternehmen.desKundenbereichs().map(UnternehmenRepository.Unternehmen::zeitzone)
                .orElse("Europe/Berlin"));
    }

    // ------------------------------------------------------------------ RFC 5545

    /** TEXT-Werte: Backslash, Semikolon, Komma und Zeilenumbruch maskiert (RFC 5545 §3.3.11). */
    static String text(String wert) {
        return wert.replace("\\", "\\\\").replace(";", "\\;").replace(",", "\\,").replace("\r\n", "\\n")
                .replace("\n", "\\n");
    }

    /**
     * Eine Inhaltszeile mit CRLF, gefaltet nach 75 Oktetten (RFC 5545 §3.1): die Fortsetzung beginnt mit einem
     * Leerzeichen; ein UTF-8-Zeichen wird nie zerteilt.
     */
    static void zeile(StringBuilder s, String inhalt) {
        int oktette = 0;
        int grenze = 75;
        for (int i = 0; i < inhalt.length(); ) {
            int cp = inhalt.codePointAt(i);
            int laenge = new String(Character.toChars(cp)).getBytes(StandardCharsets.UTF_8).length;
            if (oktette + laenge > grenze) {
                s.append("\r\n ");
                oktette = 0;
                grenze = 74;
            }
            s.appendCodePoint(cp);
            oktette += laenge;
            i += Character.charCount(cp);
        }
        s.append("\r\n");
    }
}
