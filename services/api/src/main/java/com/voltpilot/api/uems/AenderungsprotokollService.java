package com.voltpilot.api.uems;

import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.voltpilot.api.uems.AenderungsprotokollRepository.Achse;
import com.voltpilot.api.uems.AenderungsprotokollRepository.Filter;
import com.voltpilot.api.uems.AenderungsprotokollRepository.Zeiger;
import com.voltpilot.api.uems.AenderungsprotokollRepository.Zeile;
import com.voltpilot.api.web.dto.ProtokollDto;
import java.time.Instant;
import java.time.LocalDate;
import java.time.format.DateTimeParseException;
import java.util.ArrayList;
import java.util.List;
import java.util.Set;
import java.util.UUID;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Service;
import org.springframework.web.server.ResponseStatusException;

/**
 * Die drei LESEWEGE des Änderungsprotokolls (UEMS AP-04 IP-21): je Messstelle, je Gerät und
 * für das ganze Unternehmen über einen Zeitraum. Dieser Dienst SCHREIBT nichts — jeder Eintrag
 * stammt aus einem der bestehenden Schreibwege (Messstelle anlegen/bearbeiten, Ort und
 * elektrische Stellung, Quellenbindung, Einstellungs-Fassungen, Zählerwechsel, Datenquelle).
 *
 * <p>Seit AP-02 IP-14 zwei Lesewege mehr — je Gebäude/Bereich und je Standort samt seinen Kindern
 * und Anlagen-Zuordnungen ({@link OrtProtokollUmfang}) — und die dritte Achse
 * {@code gueltigkeit}: welche Einträge in einen Zeitraum aus TAGEN reichen (die Schnittstelle für
 * die Revision freigegebener Berichte, AP-12).
 *
 * <p><b>Die Zeitachse ist ausdrücklich, nie stillschweigend.</b> {@code achse=wirkung}
 * (Vorgabe) filtert und sortiert nach „gilt ab“, {@code achse=eintrag} nach „eingetragen am“.
 * Der rückwirkende Zählerwechsel von MS-06 (gilt 18.11. 10:40, eingetragen 11:05) steht mit der
 * Vorgabe im Zeitraum 10:00–11:00 und mit {@code achse=eintrag} im Zeitraum 11:00–12:00 — beide
 * Male genau EINMAL. Welche Achse gewirkt hat, steht in der ANTWORT.
 *
 * <p>Mandantenzaun: RLS trägt ihn. Eine fremde Messstelle und ein fremdes Gerät sind 404 (die
 * Suche findet sie nicht), nie 403.
 */
@Service
public class AenderungsprotokollService {

    /** Wie viele Einträge eine Seite höchstens trägt, wenn die Anfrage nichts sagt. */
    public static final int SEITE_VORGABE = 100;
    /** Die Obergrenze — mehr liefert auch eine Anfrage nicht, die mehr verlangt. */
    public static final int SEITE_GRENZE = 500;

    private final AenderungsprotokollRepository protokolle;
    private final MessstelleRepository messstellen;
    private final GeraetRepository geraete;
    private final OrtRepository orte;
    private final StandortRepository standorte;
    private final OrtAenderungRepository ortAenderungen;
    private final StandortLesemodellService lesemodell;
    private final ObjectMapper json;

    public AenderungsprotokollService(AenderungsprotokollRepository protokolle,
            MessstelleRepository messstellen, GeraetRepository geraete, OrtRepository orte,
            StandortRepository standorte, OrtAenderungRepository ortAenderungen,
            StandortLesemodellService lesemodell, ObjectMapper json) {
        this.protokolle = protokolle;
        this.messstellen = messstellen;
        this.geraete = geraete;
        this.orte = orte;
        this.standorte = standorte;
        this.ortAenderungen = ortAenderungen;
        this.lesemodell = lesemodell;
        this.json = json;
    }

    /**
     * Die gelesene Anfrage — schon geprüft, nie roher Text.
     *
     * @param von/bis der Zeitraum auf der gewählten Achse, halboffen {@code [von, bis)};
     *     {@code null} = ohne Grenze. Bei {@code gueltigkeit} der Beginn des ersten und des Tages
     *     NACH dem letzten Tag — so bleibt die Antwort halboffen wie immer.
     * @param vonTag/bisTag nur bei {@code gueltigkeit}: die Tage, beide zählen mit
     * @param grenze wie viele Einträge diese Seite höchstens trägt
     * @param nach der Fortsetzungszeiger der vorigen Seite; {@code null} = die erste
     */
    public record Anfrage(Instant von, Instant bis, LocalDate vonTag, LocalDate bisTag, Achse achse, int grenze,
            Zeiger nach) {}

    // ------------------------------------------------------------------ Die drei Lesewege

    /** Das Protokoll EINER Messstelle. Eine fremde ist 404. */
    public ProtokollDto.Protokoll messstelle(UUID id, Anfrage a) {
        messstellen.finde(id).orElseThrow(() ->
                new ResponseStatusException(HttpStatus.NOT_FOUND, "Messstelle nicht gefunden."));
        return antwort(protokolle.fuerMessstelle(id, filter(a)), a);
    }

    /**
     * Das Protokoll EINES Geräts. Ein Gerät hat kein eigenes Journal — seine Einträge hängen an
     * den Messstellen, die es speist, und nennen es über ihr Einbau-Kennzeichen (die
     * Überbrückung steht in {@link AenderungsprotokollRepository#fuerEinbau}). Ein fremdes
     * Gerät ist 404.
     */
    public ProtokollDto.Protokoll geraet(UUID id, Anfrage a) {
        GeraetRepository.Einbau g = geraete.eines(id).orElseThrow(() ->
                new ResponseStatusException(HttpStatus.NOT_FOUND, "Gerät nicht gefunden."));
        return antwort(protokolle.fuerEinbau(g.einbauKennzeichen(), filter(a)), a);
    }

    /** Das Protokoll des ganzen Unternehmens — Messstellen, Quellen, Einstellungen, Orte, Anlagen. */
    public ProtokollDto.Protokoll unternehmen(Anfrage a) {
        return antwort(protokolle.fuerUnternehmen(filter(a)), a);
    }

    /** Das Protokoll EINES Gebäudes oder Bereichs (AP-02 IP-14, H2). Ein fremder Ort ist 404. */
    public ProtokollDto.Protokoll ort(UUID id, Anfrage a) {
        orte.finde(id).orElseThrow(() ->
                new ResponseStatusException(HttpStatus.NOT_FOUND, "Gebäude oder Bereich nicht gefunden."));
        return antwort(protokolle.fuerOrt(id, filter(a)), a);
    }

    /**
     * Das Protokoll EINES Standorts EINSCHLIESSLICH seiner Gebäude, Bereiche und
     * Anlagen-Zuordnungen (AP-02 IP-14) — welche Einträge dazugehören, urteilt
     * {@link OrtProtokollUmfang} am Ortsbaum des Lesemodells. Ein fremder Standort ist 404.
     */
    public ProtokollDto.Protokoll standort(UUID id, Anfrage a) {
        standorte.finde(id).orElseThrow(() ->
                new ResponseStatusException(HttpStatus.NOT_FOUND, "Standort nicht gefunden."));
        StandortLesemodell.Zeilen z = lesemodell.zeilen();
        Set<Long> ids = OrtProtokollUmfang.desStandorts(StandortLesemodell.baum(z), z.anlageZuordnungen(), id,
                ortAenderungen.kandidatenDesStandorts(id));
        return antwort(protokolle.fuerOrtEintraege(ids, filter(a)), a);
    }

    /** Eine Zeile MEHR lesen, als die Seite trägt — so weiß die Antwort, ob es weitergeht. */
    private static Filter filter(Anfrage a) {
        return new Filter(a.von(), a.bis(), a.vonTag(), a.bisTag(), a.achse(), a.grenze() + 1, a.nach());
    }

    // ------------------------------------------------------------------ Die Antwort

    /**
     * Baut die Antwort aus den gelesenen Zeilen. Es wurde eine Zeile MEHR gelesen, als die Seite
     * trägt: ist sie da, gibt es eine weitere Seite, und der Zeiger steht auf der letzten
     * GELIEFERTEN Zeile — nicht auf der überzähligen.
     */
    private ProtokollDto.Protokoll antwort(List<Zeile> gelesen, Anfrage a) {
        boolean weitere = gelesen.size() > a.grenze();
        List<Zeile> seite = weitere ? gelesen.subList(0, a.grenze()) : gelesen;
        List<ProtokollDto.Eintrag> eintraege = new ArrayList<>(seite.size());
        for (Zeile z : seite) {
            eintraege.add(eintrag(z, a.achse()));
        }
        Zeile letzte = seite.isEmpty() ? null : seite.get(seite.size() - 1);
        return new ProtokollDto.Protokoll(List.copyOf(eintraege), a.achse().code(),
                MessstelleService.zeit(a.von()), MessstelleService.zeit(a.bis()),
                weitere && letzte != null ? zeiger(letzte, a.achse()) : null);
    }

    private ProtokollDto.Eintrag eintrag(Zeile z, Achse achse) {
        JsonNode alt = baum(z.altJson());
        JsonNode neu = baum(z.neuJson());
        return new ProtokollDto.Eintrag(
                z.quelle() + ":" + z.id(),
                z.quelle(),
                z.art(),
                AenderungSatz.satz(z.bezugArt(), z.art(), alt, neu, z.ergebnis()),
                new ProtokollDto.Bezug(z.bezugArt(), z.bezugId(), z.bezugKennzeichen(), z.bezugName()),
                MessstelleService.zeit(z.giltAb()),
                z.giltBis(),
                MessstelleService.zeit(z.eingetragenAm()),
                zeitform(z),
                z.grund(),
                new ProtokollDto.Urheber(z.urheberName(), z.urheberRolle(), z.urheberArt()),
                alt,
                neu);
    }

    /**
     * Das Urteil über die beiden Zeitpunkte. {@code rueckwirkend} ist das GESPEICHERTE Urteil
     * des Schreibwegs (er kennt die Zeitzone des Standorts und rechnet bei Tages-Einträgen in
     * Tagen, nicht in Minuten) — es wird hier nicht nachgerechnet. {@code angekuendigt} heißt:
     * die Änderung gilt erst nach dem Eintrag. Alles andere ist {@code sofort}.
     */
    private static String zeitform(Zeile z) {
        if (z.rueckwirkend()) {
            return "rueckwirkend";
        }
        return z.giltAb().isAfter(z.eingetragenAm()) ? "angekuendigt" : "sofort";
    }

    private JsonNode baum(String text) {
        if (text == null) {
            return null;
        }
        try {
            return json.readTree(text);
        } catch (JsonProcessingException e) {
            throw new IllegalStateException("Protokolleintrag nicht lesbar", e);
        }
    }

    // ------------------------------------------------------------------ Der Fortsetzungszeiger

    /**
     * Der Zeiger trägt genau das Tripel, nach dem sortiert wird: Zeit auf der Achse, Herkunft,
     * laufende Nummer. Zwei Einträge mit derselben Zeit (ein Zählerwechsel schreibt an JEDER
     * betroffenen Messstelle dasselbe „gilt ab“) bleiben deshalb in derselben Reihenfolge, und
     * die nächste Seite setzt genau HINTER dem letzten gelieferten Eintrag an — sie springt
     * keinen, und sie zeigt keinen zweimal.
     */
    private static String zeiger(Zeile z, Achse achse) {
        Instant zeit = achse == Achse.EINTRAG ? z.eingetragenAm() : z.giltAb();
        return zeit.toEpochMilli() + ":" + z.quelle() + ":" + z.id();
    }

    // ------------------------------------------------------------------ Die Anfrage lesen

    /**
     * Liest die Abfrage-Parameter der drei Routen. Jeder Fehler ist 400
     * {@code anfrage_ungueltig} mit dem Feld — nie eine stille Vorgabe.
     */
    public static Anfrage anfrage(String von, String bis, String achse, String limit, String nach) {
        Achse a = achse(achse);
        if (a == Achse.GUELTIGKEIT) {
            LocalDate vonTag = tag(von, "von");
            LocalDate bisTag = tag(bis, "bis");
            if (vonTag != null && bisTag != null && bisTag.isBefore(vonTag)) {
                throw MessstelleAbgelehnt.anfrage("bis", "„bis“ liegt nicht vor „von“ — für die "
                        + "Gültigkeit zählen beide Tage mit.");
            }
            return new Anfrage(
                    vonTag == null ? null : vonTag.atStartOfDay(MessstelleService.ZEITZONE).toInstant(),
                    bisTag == null ? null : bisTag.plusDays(1).atStartOfDay(MessstelleService.ZEITZONE).toInstant(),
                    vonTag, bisTag, a, grenze(limit), zeiger(nach));
        }
        Instant vonZeit = zeitpunkt(von, "von");
        Instant bisZeit = zeitpunkt(bis, "bis");
        if (vonZeit != null && bisZeit != null && !bisZeit.isAfter(vonZeit)) {
            throw MessstelleAbgelehnt.anfrage("bis", "„bis“ liegt nach „von“ — der Zeitraum ist "
                    + "halboffen: „von“ zählt mit, „bis“ nicht mehr.");
        }
        return new Anfrage(vonZeit, bisZeit, null, null, a, grenze(limit), zeiger(nach));
    }

    private static Achse achse(String text) {
        if (text == null || text.isBlank()) {
            return Achse.WIRKUNG;
        }
        Achse a = Achse.aus(text.strip());
        if (a == null) {
            throw MessstelleAbgelehnt.anfrage("achse", "Die Zeitachse ist „wirkung“ (wann die "
                    + "Änderung gilt, die Vorgabe), „eintrag“ (wann sie eingetragen wurde) oder "
                    + "„gueltigkeit“ (welche Änderungen in den Zeitraum reichen).");
        }
        return a;
    }

    private static Instant zeitpunkt(String text, String feld) {
        try {
            return MessstelleQuelleService.stichtag(text, null);
        } catch (DateTimeParseException e) {
            throw MessstelleAbgelehnt.anfrage(feld, "„" + feld + "“ ist ein Zeitpunkt "
                    + "(2026-11-18T10:40:00+01:00) oder ein Tag (2026-11-18, dann dessen Beginn).");
        }
    }

    /** Ein Tag der Achse {@code gueltigkeit} — nur als Tag, nie als Zeitpunkt. */
    private static LocalDate tag(String text, String feld) {
        if (text == null || text.isBlank()) {
            return null;
        }
        try {
            return LocalDate.parse(text.strip());
        } catch (DateTimeParseException e) {
            throw MessstelleAbgelehnt.anfrage(feld, "Für die Gültigkeit ist „" + feld + "“ ein Tag "
                    + "(2027-02-01); „von“ und „bis“ zählen beide mit.");
        }
    }

    private static int grenze(String text) {
        if (text == null || text.isBlank()) {
            return SEITE_VORGABE;
        }
        int wert;
        try {
            wert = Integer.parseInt(text.strip());
        } catch (NumberFormatException e) {
            throw MessstelleAbgelehnt.anfrage("limit", "Die Zahl der Einträge ist eine ganze Zahl "
                    + "zwischen 1 und " + SEITE_GRENZE + ".");
        }
        if (wert < 1 || wert > SEITE_GRENZE) {
            throw MessstelleAbgelehnt.anfrage("limit", "Die Zahl der Einträge ist eine ganze Zahl "
                    + "zwischen 1 und " + SEITE_GRENZE + ".");
        }
        return wert;
    }

    private static Zeiger zeiger(String text) {
        if (text == null || text.isBlank()) {
            return null;
        }
        String[] teile = text.strip().split(":");
        if (teile.length != 3) {
            throw MessstelleAbgelehnt.anfrage("nach", "Der Fortsetzungszeiger ist der Wert "
                    + "„weiter“ der vorigen Seite.");
        }
        try {
            return new Zeiger(Instant.ofEpochMilli(Long.parseLong(teile[0])), teile[1],
                    Long.parseLong(teile[2]));
        } catch (NumberFormatException e) {
            throw MessstelleAbgelehnt.anfrage("nach", "Der Fortsetzungszeiger ist der Wert "
                    + "„weiter“ der vorigen Seite.");
        }
    }
}
