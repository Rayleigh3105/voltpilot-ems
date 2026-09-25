package com.voltpilot.api.uems;

import com.voltpilot.api.web.dto.EnergiemanagementWiedervorlageDto.NaechsteManagementbewertung;
import com.voltpilot.api.web.dto.EnergiemanagementWiedervorlageDto.Wiedervorlage;
import com.voltpilot.api.web.dto.EnergiemanagementWiedervorlageDto.Zeile;
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
import java.util.Deque;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import org.springframework.beans.factory.ObjectProvider;
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

    private final ObjectProvider<WiedervorlageQuelle> quellen;
    private final ObjectProvider<ManagementbewertungWiedervorlage> managementbewertung;
    private final EnergiemanagementEinstellungRepository einstellung;
    private final UnternehmenRepository unternehmen;
    private volatile Clock uhr = Clock.systemUTC();

    public EnergiemanagementWiedervorlageService(ObjectProvider<WiedervorlageQuelle> quellen,
            ObjectProvider<ManagementbewertungWiedervorlage> managementbewertung,
            EnergiemanagementEinstellungRepository einstellung, UnternehmenRepository unternehmen) {
        this.quellen = quellen;
        this.managementbewertung = managementbewertung;
        this.einstellung = einstellung;
        this.unternehmen = unternehmen;
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
        List<Zeile> faellig = zeilen((List<Map<String, Object>>) r.get("faellig"), je);
        List<Zeile> vorschau = zeilen((List<Map<String, Object>>) r.get("vorschau"), je);
        return new Wiedervorlage(jetzt, vorschauTage, faellig, vorschau, (int) r.get("anzahl_faellig"),
                (int) r.get("anzahl_vorschau"), (List<String>) r.get("nicht_in_liste"),
                EnergiemanagementRegeln.SAETZE.get("verantwortung"), naechsteManagementbewertung(abruf));
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
     * E10 = A, WV4: der Kalender-Abzug (RFC 5545) — je Zeile der Wiedervorlage (fällig und Vorschau) ein ganztägiger
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

    private static List<Zeile> alle(Wiedervorlage w) {
        var alle = new ArrayList<Zeile>(w.faellig());
        alle.addAll(w.vorschau());
        return alle;
    }

    private static List<Zeile> zeilen(List<Map<String, Object>> aus, Map<List<String>, Deque<WiedervorlageQuelle.Frist>> je) {
        return aus.stream().map(z -> {
            var f = je.get(schluessel((String) z.get("art"), (String) z.get("kennzeichen"), (String) z.get("titel"),
                    (String) z.get("faellig_am"))).poll();
            UUID id = f == null ? null : f.id();
            UUID kennzahl = f == null ? null : f.kennzahlId();
            return new Zeile((String) z.get("art"), (String) z.get("kennzeichen"), (String) z.get("titel"),
                    LocalDate.parse((String) z.get("faellig_am")), (int) z.get("tage"), (String) z.get("satz"),
                    (String) z.get("verantwortlich"), id, kennzahl);
        }).toList();
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
