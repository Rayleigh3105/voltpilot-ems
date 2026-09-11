package com.voltpilot.api.uems;

import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.voltpilot.api.tenant.TenantContext;
import com.voltpilot.api.uems.MessstelleAbgelehnt.Schnittstelle;
import com.voltpilot.api.uems.MessstelleAenderungRepository.NeuerEintrag;
import com.voltpilot.api.uems.MessstelleAenderungRepository.Uebergang;
import com.voltpilot.api.uems.MessstelleRegeln.Fehler;
import com.voltpilot.api.uems.MessstelleRegeln.Groesse;
import com.voltpilot.api.uems.MessstelleRegeln.GroesseUrteil;
import com.voltpilot.api.uems.MessstelleRegeln.KennzeichenUrteil;
import com.voltpilot.api.uems.MessstelleRegeln.LebenszyklusEingang;
import com.voltpilot.api.uems.MessstelleRegeln.LebenszyklusErgebnis;
import com.voltpilot.api.uems.MessstelleRegeln.QuelleZeitraum;
import com.voltpilot.api.uems.MessstelleRegeln.Vergeben;
import com.voltpilot.api.uems.MessstelleQuelleRepository.Quelle;
import com.voltpilot.api.uems.MessstelleRepository.Messstelle;
import com.voltpilot.api.uems.MessstelleRepository.Nebengroesse;
import com.voltpilot.api.uems.MessstelleRepository.NeueMessstelle;
import com.voltpilot.api.uems.MessstelleZuordnungRepository.OrtZeile;
import com.voltpilot.api.uems.MessstelleZuordnungRepository.StellungZeile;
import com.voltpilot.api.uems.MessstelleZuordnungRepository.Tagesintervall;
import com.voltpilot.api.web.dto.MessstelleDto;
import java.sql.SQLException;
import java.time.Clock;
import java.time.Instant;
import java.time.LocalDate;
import java.time.OffsetDateTime;
import java.time.ZoneId;
import java.time.format.DateTimeFormatter;
import java.time.temporal.ChronoUnit;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.Set;
import java.util.UUID;
import java.util.function.BiPredicate;
import java.util.function.Supplier;
import org.springframework.dao.DataIntegrityViolationException;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Service;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.support.TransactionTemplate;
import org.springframework.web.server.ResponseStatusException;

/**
 * Die Messstellen-Schnittstelle (UEMS AP-04 IP-3): anlegen, lesen, bearbeiten, anhalten,
 * fortsetzen, archivieren — je Schreibvorgang EINE Transaktion und GENAU EIN Eintrag im
 * Änderungsprotokoll mit Urheber ({@link ProtokollAkteur}).
 *
 * <p><b>Keine zweite Regel-Logik.</b> Kennzeichen-Form und -Belegung, Größen-Katalog und
 * Lebenszyklus urteilt {@link MessstelleRegeln}; Code und Status einer Ablehnung kommen aus
 * dessen {@link Fehler}-Tabelle. Hier steht nur, was der Vertrag ausdrücklich der
 * Schnittstelle lässt (§10): die Form der Anfrage, die Übergänge des gespeicherten Zustands
 * und ihre Zeitpunkte.
 *
 * <h2>Die Übergänge und ihre Zeitpunkte (A15, E2)</h2>
 *
 * Gespeichert sind nur die Zustands-Eingänge {@code angehalten_ab}/{@code archiviert_am}
 * (V20260911140000). Daraus folgen die Regeln:
 * <ul>
 *   <li>Anhalten nur, wenn nicht angehalten; Fortsetzen nur, wenn angehalten; nichts an einer
 *       archivierten Messstelle (kein Wiederbeleben) — sonst 409 {@code zustand_passt_nicht}.</li>
 *   <li>Der Zeitpunkt gilt auf die Minute (sonst 400), Vorgabe jetzt; die Vergangenheit ist
 *       erlaubt und steht als „rückwirkend“ im Protokoll. Die ZUKUNFT nicht (422
 *       {@code zeitpunkt_in_zukunft}): Archivieren sagt es ausdrücklich („jetzt oder
 *       Vergangenheit“, AP-04 §4.5), und ein angekündigtes Anhalten verlöre sein Ende, sobald
 *       es fortgesetzt wird — die Tabelle kennt nur den heutigen Eingang.</li>
 *   <li>Jeder Übergang liegt NACH seinem Vorgänger (dem letzten Anhalten/Fortsetzen), sonst 422
 *       {@code zeitpunkt_vor_vorgaenger} — dieselbe Regel und derselbe Code wie der Wechsel
 *       einer Quelle (Vertrag §5 Regel 6) — und nie vor dem Beginn der Messstelle (Regel 5:
 *       Mitternacht des ersten Tages ihres ersten Orts, IP-7), dann mit {@code beginn} statt
 *       eines Vorgängers. Ohne Ort gibt es keinen Beginn und nichts zu prüfen.</li>
 *   <li>Archivieren beendet die Zuordnungen (Ort, Stellung) am Vortag des Archivtags (AP-04 §4.5,
 *       A13); eine, die erst an ihm oder später beginnt, wird aufgehoben — in DERSELBEN
 *       Transaktion, der Eintrag „archiviert“ nennt den letzten Tag.</li>
 * </ul>
 *
 * <p>Die Zuordnungen selbst schreibt {@link MessstelleZuordnungService}; hier werden sie gelesen
 * ({@code orte}, {@code elektrische_stellung}) und gehen als „Ort vorhanden“ in den Lebenszyklus.
 *
 * <p>Der Mandant ist die RLS: eine fremde Messstelle ist nicht da (404, nie 403).
 */
@Service
public class MessstelleService {

    /**
     * Die Zeitzone der Zeitpunkte (die der Vektor-Datei). Alle zulässigen Zeitzonen von
     * Unternehmen und Standort (Berlin, Wien, Zürich — {@code standort_zeitzone_chk}) haben
     * dieselben Regeln; Tage und Versätze sind in jeder dieselben. Auch die der Quellenbindung
     * und des Messkanal-Read-Models (IP-13).
     */
    public static final ZoneId ZEITZONE = ZoneId.of("Europe/Berlin");

    private static final String SCHEMA_VERSION = "1.0";
    private static final List<String> ARTEN = List.of("gemessen", "berechnet");
    private static final DateTimeFormatter ANZEIGE = DateTimeFormatter.ofPattern("dd.MM.yyyy HH:mm");

    private final MessstelleRepository messstellen;
    private final MessstelleAenderungRepository aenderungen;
    private final MessstelleZuordnungRepository zuordnungen;
    private final MessstelleQuelleRepository quellen;
    private final MessstelleQuelleService quellenDienst;
    private final TransactionTemplate transaktion;
    private final ObjectMapper json;
    private volatile Clock uhr = Clock.systemUTC();

    public MessstelleService(MessstelleRepository messstellen, MessstelleAenderungRepository aenderungen,
            MessstelleZuordnungRepository zuordnungen, MessstelleQuelleRepository quellen,
            MessstelleQuelleService quellenDienst, PlatformTransactionManager transactionManager,
            ObjectMapper json) {
        this.messstellen = messstellen;
        this.aenderungen = aenderungen;
        this.zuordnungen = zuordnungen;
        this.quellen = quellen;
        this.quellenDienst = quellenDienst;
        this.transaktion = new TransactionTemplate(transactionManager);
        this.json = json;
    }

    /** Nur für Tests: die Uhr, an der „jetzt“ hängt (ein Archivieren am 30.06.2027, A13). */
    void uhrStellen(Clock uhr) {
        this.uhr = uhr;
    }

    // ------------------------------------------------------------------ lesen

    // Die Liste liest das Register in EINER Abfrage (IP-4, MessstelleRegisterService) und baut
    // jede Messstelle über dieselbe darstellung(…) wie eine(id).

    public MessstelleDto.Messstelle eine(UUID id) {
        return darstellung(finde(id));
    }

    /** Der Vorschlag des Anlege-Dialogs (E7) — ohne den Zähler zu bewegen. */
    public MessstelleDto.Vorschlag vorschlag() {
        return new MessstelleDto.Vorschlag(messstellen.vorschlag().kennzeichen());
    }

    // ---------------------------------------------------------------- anlegen

    /**
     * Legt eine Messstelle an. Ohne Kennzeichen vergibt das Repository unter der Zeilensperre
     * des Zählers das nächste automatische (MS-0001 …) — in DERSELBEN Transaktion wie
     * Nebengrößen und Protokolleintrag; scheitert irgendetwas, rückt auch der Zähler nicht vor.
     * Geprüft wird erst jede Form (400), dann die Belegung (409).
     */
    public MessstelleDto.Messstelle anlegen(MessstelleDto.Anlegen a, ProtokollAkteur wer) {
        UUID tenant = TenantContext.get();
        if (tenant == null) {
            throw new ResponseStatusException(HttpStatus.FORBIDDEN, "Kein Kundenbereich gewählt.");
        }
        String kennzeichen = a.kennzeichen();
        if (kennzeichen != null && !MessstelleRegeln.kennzeichenFormatGueltig(kennzeichen)) {
            throw kennzeichenFormat();
        }
        if (a.art() == null || !ARTEN.contains(a.art())) {
            throw MessstelleAbgelehnt.anfrage("art", "Die Art ist „gemessen“ oder „berechnet“.");
        }
        if (a.medium() == null) {
            throw MessstelleAbgelehnt.anfrage("medium", "Das Medium fehlt.");
        }
        if (a.hauptgroesse() == null) {
            throw MessstelleAbgelehnt.anfrage("hauptgroesse", "Die Hauptgröße fehlt.");
        }
        Groesse haupt = groesse(a.hauptgroesse());
        groesseImKatalog(a.medium(), haupt, "hauptgroesse");
        List<Groesse> neben = new ArrayList<>();
        List<MessstelleDto.Groesse> nebenAnfrage = a.nebengroessen() == null ? List.of() : a.nebengroessen();
        for (int i = 0; i < nebenAnfrage.size(); i++) {
            String feld = "nebengroessen[" + i + "]";
            if (nebenAnfrage.get(i) == null) {
                throw MessstelleAbgelehnt.anfrage(feld, "Eine Nebengröße ist leer.");
            }
            Groesse g = groesse(nebenAnfrage.get(i));
            groesseImKatalog(a.medium(), g, feld);
            neben.add(g);
        }
        jedeGroesseEinmal(haupt, neben);
        if (kennzeichen != null) {
            kennzeichenFrei(kennzeichen, null);
        }

        String name = text(a.name());
        String notiz = text(a.notiz());
        Instant jetzt = minute(uhr.instant());
        UUID id = schreibe(kennzeichen, null, () -> transaktion.execute(s -> {
            Messstelle m = messstellen.anlegen(new NeueMessstelle(tenant, kennzeichen, name, a.art(),
                    a.medium(), haupt, notiz));
            for (Groesse g : neben) {
                messstellen.nebengroesseHinzufuegen(m.id(), g).orElseThrow();
            }
            Map<String, Object> neu = new LinkedHashMap<>();
            neu.put("kennzeichen", m.kennzeichen());
            neu.put("name", name);
            neu.put("art", a.art());
            neu.put("medium", a.medium());
            neu.put("hauptgroesse", groesseAlsMap(haupt));
            neu.put("nebengroessen", neben.stream().map(MessstelleService::groesseAlsMap).toList());
            neu.put("notiz", notiz);
            protokoll(m.id(), "angelegt", null, neu, jetzt, false, null, wer);
            return m.id();
        }));
        return eine(id);
    }

    // ------------------------------------------------------------- bearbeiten

    /**
     * Schreibt Kennzeichen, Name und Notiz (die ganze Menge — ein fehlendes Feld ist leer).
     * Ändert sich nichts, wird nichts geschrieben und nichts protokolliert; sonst trägt der
     * Eintrag „bearbeitet“ alt/neu NUR der geänderten Felder.
     */
    public MessstelleDto.Messstelle bearbeiten(UUID id, MessstelleDto.Bearbeiten b, ProtokollAkteur wer) {
        Messstelle m = finde(id);
        nichtArchiviert(m);
        String kennzeichen = b.kennzeichen();
        if (!MessstelleRegeln.kennzeichenFormatGueltig(kennzeichen)) {
            throw kennzeichenFormat();
        }
        kennzeichenFrei(kennzeichen, m.kennzeichen());

        String name = text(b.name());
        String notiz = text(b.notiz());
        Map<String, Object> alt = new LinkedHashMap<>();
        Map<String, Object> neu = new LinkedHashMap<>();
        vergleiche("kennzeichen", m.kennzeichen(), kennzeichen, alt, neu);
        vergleiche("name", m.name(), name, alt, neu);
        vergleiche("notiz", m.notiz(), notiz, alt, neu);
        if (neu.isEmpty()) {
            return darstellung(m);
        }
        Instant jetzt = minute(uhr.instant());
        schreibe(kennzeichen, m.kennzeichen(), () -> transaktion.execute(s -> {
            if (!messstellen.bearbeiten(id, kennzeichen, name, notiz)) {
                throw zustandPasstNicht(finde(id), "wurde soeben archiviert.");
            }
            protokoll(id, "bearbeitet", alt, neu, jetzt, false, null, wer);
            return id;
        }));
        return eine(id);
    }

    // ------------------------------------------------------------ Übergänge

    /** Hält die Messstelle an (Umbau, Zähler ausgebaut): Quellen und Zuordnungen bleiben. */
    public MessstelleDto.Messstelle anhalten(UUID id, MessstelleDto.Uebergang u, ProtokollAkteur wer) {
        Messstelle m = finde(id);
        Instant jetzt = minute(uhr.instant());
        Instant ab = zeitpunkt(u, jetzt);
        nichtArchiviert(m);
        if (m.angehaltenAb() != null) {
            throw zustandPasstNicht(m, "ist bereits angehalten (seit " + anzeige(m.angehaltenAb()) + ").");
        }
        nichtInDerZukunft(ab, jetzt, "Anhalten");
        nachDemVorgaenger(m, ab);
        transaktion.execute(s -> {
            if (!messstellen.anhalten(id, ab)) {
                throw zustandPasstNicht(finde(id), "wurde soeben verändert.");
            }
            protokoll(id, "angehalten", eintrag("angehalten_ab", null), eintrag("angehalten_ab", ab),
                    ab, ab.isBefore(jetzt), text(grund(u)), wer);
            return id;
        });
        return eine(id);
    }

    /** Setzt die angehaltene Messstelle fort; die Lücke bleibt sichtbar, nie aufgefüllt. */
    public MessstelleDto.Messstelle fortsetzen(UUID id, MessstelleDto.Uebergang u, ProtokollAkteur wer) {
        Messstelle m = finde(id);
        Instant jetzt = minute(uhr.instant());
        Instant ab = zeitpunkt(u, jetzt);
        nichtArchiviert(m);
        if (m.angehaltenAb() == null) {
            throw zustandPasstNicht(m, "ist nicht angehalten.");
        }
        nichtInDerZukunft(ab, jetzt, "Fortsetzen");
        nachDemVorgaenger(m, ab);
        transaktion.execute(s -> {
            if (!messstellen.fortsetzen(id)) {
                throw zustandPasstNicht(finde(id), "wurde soeben verändert.");
            }
            protokoll(id, "fortgesetzt", eintrag("angehalten_ab", m.angehaltenAb()),
                    eintrag("angehalten_ab", null), ab, ab.isBefore(jetzt), text(grund(u)), wer);
            return id;
        });
        return eine(id);
    }

    /**
     * Archiviert die Messstelle: das Kennzeichen bleibt belegt, alles Lesbare bleibt stehen, kein
     * Wiederbeleben. Ihre Zuordnungen (Ort, Stellung) enden am Vortag des Archivtags — eine, die
     * erst an ihm oder später beginnt, wird aufgehoben (A13: archiviert am 30.06.2027 16:30, der
     * Ort endet am 29.06.2027). Jede offene Quelle endet zum Archivzeitpunkt (AP-04 §4.5, IP-13) —
     * in DERSELBEN Transaktion, genannt im EINEN Protokolleintrag „archiviert“
     * ({@code quellen_beendet}); eine Quelle, die sich dort nicht beenden lässt, ohne sie
     * umzuschreiben (angekündigt oder mit späterem Ende), lehnt das Archivieren zu diesem
     * Zeitpunkt ab ({@link MessstelleQuelleService#archivierbar}) — eine Quelle wird nie aufgehoben.
     */
    public MessstelleDto.Messstelle archivieren(UUID id, MessstelleDto.Uebergang u, ProtokollAkteur wer) {
        Messstelle m = finde(id);
        Instant jetzt = minute(uhr.instant());
        Instant am = zeitpunkt(u, jetzt);
        nichtArchiviert(m);
        nichtInDerZukunft(am, jetzt, "Archivieren");
        nachDemVorgaenger(m, am);
        LocalDate archivtag = zeit(am).toLocalDate();
        quellenDienst.archivierbar(m, am);
        transaktion.execute(s -> {
            if (!messstellen.archivieren(id, am)) {
                throw zustandPasstNicht(finde(id), "wurde soeben archiviert.");
            }
            boolean beendet = false;
            for (OrtZeile z : zuordnungen.orte(id)) {
                beendet |= beendeAm(z, archivtag, jetzt, zuordnungen::ortBeenden, zuordnungen::ortAufheben);
            }
            for (StellungZeile z : zuordnungen.stellungen(id)) {
                beendet |= beendeAm(z, archivtag, jetzt, zuordnungen::stellungBeenden, zuordnungen::stellungAufheben);
            }
            List<UUID> quellenBeendet = quellenDienst.zumArchivBeenden(m, am);
            Map<String, Object> neu = eintrag("archiviert_am", am);
            if (beendet) {
                neu.put("zuordnungen_bis", archivtag.minusDays(1).toString());
            }
            if (!quellenBeendet.isEmpty()) {
                neu.put("quellen_beendet", quellenBeendet.stream().map(UUID::toString).toList());
            }
            protokoll(id, "archiviert", eintrag("archiviert_am", null), neu,
                    am, am.isBefore(jetzt), text(grund(u)), wer);
            return id;
        });
        return eine(id);
    }

    /**
     * Beendet ein wirksames Intervall am Vortag von {@code archivtag}; beginnt es erst an ihm oder
     * später, belegte es danach keinen Tag — dann wird es aufgehoben. {@code true}, wenn sich etwas
     * geändert hat.
     */
    private static boolean beendeAm(Tagesintervall z, LocalDate archivtag, Instant jetzt,
            BiPredicate<UUID, LocalDate> beenden, BiPredicate<UUID, Instant> aufheben) {
        if (z.aufgehoben() || (z.gueltigBis() != null && z.gueltigBis().isBefore(archivtag))) {
            return false;
        }
        if (!z.gueltigAb().isBefore(archivtag)) {
            return aufheben.test(z.id(), jetzt);
        }
        return beenden.test(z.id(), archivtag.minusDays(1));
    }

    // ------------------------------------------------------------ Regeln

    /** Form → Belegung, wie der Vertrag sie ordnet (§3); die Messstelle kollidiert nie mit sich selbst. */
    private void kennzeichenFrei(String kandidat, String fuerMessstelle) {
        KennzeichenUrteil urteil = MessstelleRegeln.kennzeichenPruefen(kandidat, fuerMessstelle,
                messstellen.vergeben());
        if (urteil.fehler() == Fehler.KENNZEICHEN_FORMAT) {
            throw kennzeichenFormat();
        }
        if (urteil.fehler() != null) {
            Vergeben v = urteil.bestehend();
            String traeger = v.name() == null ? v.messstelle()
                    : v.frueher() ? v.name() + ", heute " + v.messstelle() : v.name();
            Map<String, Object> bestehend = new LinkedHashMap<>();
            bestehend.put("kennzeichen", v.kennzeichen());
            bestehend.put("messstelle", v.messstelle());
            bestehend.put("name", v.name());
            bestehend.put("archiviert", v.archiviert());
            bestehend.put("frueher", v.frueher());
            throw MessstelleAbgelehnt.regel(urteil.fehler(), v.kennzeichen() + " ist bereits vergeben ("
                    + traeger + "). Kennzeichen sind je Unternehmen eindeutig — auch archivierte "
                    + "bleiben belegt.", Map.of("bestehend", bestehend));
        }
    }

    private static MessstelleAbgelehnt kennzeichenFormat() {
        return MessstelleAbgelehnt.regel(Fehler.KENNZEICHEN_FORMAT,
                "Erlaubt sind 2–16 Zeichen: Großbuchstaben, Ziffern, „-“, „.“, „/“.", Map.of());
    }

    /** Der Größen-Katalog des Vertrags (§2), für Haupt- und Nebengröße gleich. */
    private static void groesseImKatalog(String medium, Groesse g, String feld) {
        GroesseUrteil urteil = MessstelleRegeln.groessePruefen(medium, g);
        if (urteil.fehler() == null) {
            return;
        }
        String was = "„" + g.groesse() + "“";
        String satz = switch (urteil.grund()) {
            case "groesse" -> was + " steht nicht im Größen-Katalog.";
            case "medium" -> was + " gibt es beim Medium „" + medium + "“ nicht.";
            case "einheit" -> "Die Einheit „" + g.einheit() + "“ passt nicht zu " + was + ".";
            case "richtung" -> "Die Richtung „" + g.richtung() + "“ gibt es bei " + was + " nicht.";
            default -> "Die Wertart „" + g.wertart() + "“ gibt es bei " + was + " nicht.";
        };
        Map<String, Object> fakten = new LinkedHashMap<>();
        fakten.put("grund", urteil.grund());
        fakten.put("feld", feld);
        throw MessstelleAbgelehnt.regel(urteil.fehler(), satz, fakten);
    }

    /**
     * Je Messstelle gibt es jede (Größe, Richtung) einmal und nie zusätzlich zur Hauptgröße —
     * die Tabelle hält das selbst ({@code messstelle_groesse_eindeutig},
     * {@code messstelle_groesse_nicht_hauptgroesse}); hier wird es vorher gesagt, mit Feld.
     */
    private static void jedeGroesseEinmal(Groesse haupt, List<Groesse> neben) {
        Set<String> gesehen = new HashSet<>();
        gesehen.add(haupt.groesse() + "|" + haupt.richtung());
        for (int i = 0; i < neben.size(); i++) {
            Groesse g = neben.get(i);
            if (!gesehen.add(g.groesse() + "|" + g.richtung())) {
                throw MessstelleAbgelehnt.anfrage("nebengroessen[" + i + "]", "„" + g.groesse() + " · "
                        + g.richtung() + "“ steht schon an dieser Messstelle — jede Größe gibt es je "
                        + "Messstelle einmal.");
            }
        }
    }

    private static void nichtArchiviert(Messstelle m) {
        if (m.archiviertAm() != null) {
            throw zustandPasstNicht(m, "ist seit " + anzeige(m.archiviertAm())
                    + " archiviert — eine archivierte Messstelle bleibt, wie sie ist.");
        }
    }

    private static void nichtInDerZukunft(Instant zeitpunkt, Instant jetzt, String was) {
        if (zeitpunkt.isAfter(jetzt)) {
            throw MessstelleAbgelehnt.schnittstelle(Schnittstelle.ZEITPUNKT_IN_ZUKUNFT, was
                    + " gilt ab jetzt oder rückwirkend — der " + anzeige(zeitpunkt)
                    + " liegt in der Zukunft.", Map.of("zeitpunkt", zeit(zeitpunkt)));
        }
    }

    /**
     * Jeder Übergang liegt nie vor dem Beginn der Messstelle (Regel 5 — Mitternacht des ersten
     * Tages ihres ersten Orts) und NACH dem letzten Anhalten/Fortsetzen (Regel 6 des Vertrags, A15).
     */
    private void nachDemVorgaenger(Messstelle m, Instant zeitpunkt) {
        Instant beginn = beginn(zuordnungen.orte(m.id()));
        if (beginn != null && zeitpunkt.isBefore(beginn)) {
            throw MessstelleAbgelehnt.regel(Fehler.ZEITPUNKT_VOR_VORGAENGER, "Der Zeitpunkt liegt vor dem Beginn "
                    + "von " + m.kennzeichen() + " am " + anzeige(beginn) + ". Wählen Sie einen späteren Zeitpunkt.",
                    Map.of("beginn", zeit(beginn)));
        }
        Uebergang v = aenderungen.letzterUebergang(m.id()).orElse(null);
        if (m.angehaltenAb() != null && (v == null || m.angehaltenAb().isAfter(v.giltAb()))) {
            v = new Uebergang("angehalten", m.angehaltenAb());
        }
        if (v == null || zeitpunkt.isAfter(v.giltAb())) {
            return;
        }
        String vorgang = "angehalten".equals(v.art()) ? "dem Anhalten" : "dem Fortsetzen";
        Map<String, Object> vorgaenger = new LinkedHashMap<>();
        vorgaenger.put("art", v.art());
        vorgaenger.put("gilt_ab", zeit(v.giltAb()));
        throw MessstelleAbgelehnt.regel(Fehler.ZEITPUNKT_VOR_VORGAENGER, "Der Zeitpunkt liegt nicht nach "
                + vorgang + " am " + anzeige(v.giltAb()) + ". Wählen Sie einen späteren Zeitpunkt.",
                Map.of("vorgaenger", vorgaenger));
    }

    private static MessstelleAbgelehnt zustandPasstNicht(Messstelle m, String was) {
        Map<String, Object> fakten = new LinkedHashMap<>();
        fakten.put("angehalten_ab", zeit(m.angehaltenAb()));
        fakten.put("archiviert_am", zeit(m.archiviertAm()));
        return MessstelleAbgelehnt.schnittstelle(Schnittstelle.ZUSTAND_PASST_NICHT,
                m.kennzeichen() + " " + was, fakten);
    }

    // ------------------------------------------------------------ Gerüst

    private Messstelle finde(UUID id) {
        return messstellen.finde(id).orElseThrow(() ->
                new ResponseStatusException(HttpStatus.NOT_FOUND, "Messstelle nicht gefunden."));
    }

    private MessstelleDto.Messstelle darstellung(Messstelle m) {
        return darstellung(m, messstellen.nebengroessen(m.id()), zuordnungen.orte(m.id()),
                zuordnungen.stellungen(m.id()), quellen.derMessstelle(m.id()));
    }

    /**
     * Die Messstelle in der Form des Vertrags, mit ihren Zuordnungen (IP-7): alle wirksamen
     * Intervalle nach Beginn, und ihren Quellen (IP-13) je Größe: führend als
     * {@code quellenbindung}, zum Vergleich als {@code vergleichsbindung} — beendete
     * eingeschlossen, nach Beginn. Die Formel (AP-10) gibt es noch nicht — genau so geht sie in
     * {@link MessstelleRegeln#lebenszyklus} ein.
     */
    /** Die Vertrags-Form aus den gelesenen Zeilen — für {@link #eine} wie für das Register. */
    MessstelleDto.Messstelle darstellung(Messstelle m, List<Nebengroesse> neben, List<OrtZeile> orte,
            List<StellungZeile> stellungen, List<Quelle> alle) {
        Groesse h = m.hauptgroesse();
        List<QuelleZeitraum> fuehrendHaupt = derGroesse(alle, h, "fuehrend").stream()
                .map(q -> new QuelleZeitraum(q.entityId().toString(), q.kanal(), q.geraet(), q.einbau(),
                        zeit(q.gueltigAb()), zeit(q.gueltigBis()))).toList();
        LebenszyklusErgebnis z = lebenszyklus(m, ortVorhanden(orte), fuehrendHaupt,
                OffsetDateTime.ofInstant(uhr.instant(), ZEITZONE));
        List<MessstelleDto.Nebengroesse> nebengroessen = neben.stream().map(n -> new MessstelleDto.Nebengroesse(
                n.groesse().groesse(), n.groesse().richtung(), n.groesse().einheit(), n.groesse().wertart(),
                n.archiviertAm() != null || m.archiviertAm() != null ? "archiviert" : "aktiv",
                fuehrend(alle, n.groesse()), vergleich(alle, n.groesse()))).toList();
        return new MessstelleDto.Messstelle(m.id(), SCHEMA_VERSION, m.kennzeichen(), m.name(), m.art(),
                m.medium(), new MessstelleDto.Groesse(h.groesse(), h.richtung(), h.einheit(), h.wertart()),
                fuehrend(alle, h), vergleich(alle, h), nebengroessen,
                wirksam(orte).stream().map(MessstelleService::ortZuordnung).toList(),
                wirksam(stellungen).stream().map(MessstelleService::stellungZuordnung).toList(), null,
                z.lebenszyklus(), z.fehlt(), m.notiz(), zeit(m.angehaltenAb()), zeit(m.archiviertAm()));
    }

    private static List<Quelle> derGroesse(List<Quelle> alle, Groesse g, String rolle) {
        return alle.stream().filter(q -> q.rolle().equals(rolle) && q.groesse().equals(g.groesse())
                && q.richtung().equals(g.richtung()))
                .sorted(Comparator.comparing(Quelle::gueltigAb)).toList();
    }

    /** Die führenden Quellen einer Größe in der Form von {@code $defs/quellenbindung}. */
    private static List<MessstelleDto.Quellenbindung> fuehrend(List<Quelle> alle, Groesse g) {
        return derGroesse(alle, g, "fuehrend").stream().map(q -> new MessstelleDto.Quellenbindung(
                q.entityId().toString(), q.kanal(), q.geraet(), q.einbau(), q.kanalWertart(),
                zeit(q.gueltigAb()), zeit(q.gueltigBis()), stand(q.anfangsstand()), stand(q.endstand()))).toList();
    }

    /** Die Vergleichsquellen einer Größe in der Form von {@code $defs/vergleichsbindung}. */
    private static List<MessstelleDto.Vergleichsbindung> vergleich(List<Quelle> alle, Groesse g) {
        return derGroesse(alle, g, "vergleich").stream().map(q -> new MessstelleDto.Vergleichsbindung(
                q.entityId().toString(), q.kanal(), q.geraet(), q.einbau(), q.kanalWertart(), q.zweck(),
                zeit(q.gueltigAb()), zeit(q.gueltigBis()))).toList();
    }

    private static MessstelleDto.Stand stand(MessstelleQuelleRepository.Stand s) {
        return s == null ? null : new MessstelleDto.Stand(s.wert(), s.einheit());
    }

    /**
     * Der Lebenszyklus einer gespeicherten Messstelle — die EINE Stelle, an der ihre Eingänge in
     * {@link MessstelleRegeln#lebenszyklus} gehen (auch für die Archiv-Sperre des Ortsbaums,
     * {@link MessstelleOrtsbaumMessstellen}).
     */
    static LebenszyklusErgebnis lebenszyklus(Messstelle m, boolean ortVorhanden, OffsetDateTime jetzt) {
        return lebenszyklus(m, ortVorhanden, List.of(), jetzt);
    }

    /** Mit den führenden Quellen der Hauptgröße (IP-13) — der Eingang von {@code quelleVorhanden}. */
    static LebenszyklusErgebnis lebenszyklus(Messstelle m, boolean ortVorhanden, List<QuelleZeitraum> fuehrend,
            OffsetDateTime jetzt) {
        return MessstelleRegeln.lebenszyklus(new LebenszyklusEingang(
                m.art(), m.medium(), m.kennzeichen(), m.name(), m.hauptgroesse(),
                ortVorhanden, false, false,
                m.angehaltenAb() != null, m.archiviertAm() != null,
                fuehrend, jetzt));
    }

    /**
     * „Ort vorhanden“ heißt: ein wirksames Ort-Intervall, gleich wann es gilt — der Lebenszyklus
     * fragt, ob die Stammdaten vollständig sind (AP-04 §4.5), nicht, wo sie heute sitzt; das sagt
     * {@code GET …/standort?am=}.
     */
    static boolean ortVorhanden(List<OrtZeile> orte) {
        return orte.stream().anyMatch(z -> !z.aufgehoben());
    }

    /** Der Beginn der Messstelle: Mitternacht des ersten Tages ihres ersten Orts; {@code null} ohne Ort. */
    static Instant beginn(List<OrtZeile> orte) {
        return wirksam(orte).stream().findFirst()
                .map(z -> z.gueltigAb().atStartOfDay(ZEITZONE).toInstant()).orElse(null);
    }

    /** Die wirksamen (nicht aufgehobenen) Intervalle nach Beginn. */
    static <T extends Tagesintervall> List<T> wirksam(List<T> zeilen) {
        return zeilen.stream().filter(z -> !z.aufgehoben())
                .sorted(Comparator.comparing(Tagesintervall::gueltigAb)).toList();
    }

    /** Ein Ort-Intervall in der Form des Vertrags ({@code $defs/ortZuordnung}). */
    static MessstelleDto.OrtZuordnung ortZuordnung(OrtZeile z) {
        return new MessstelleDto.OrtZuordnung(z.zielArt(), z.kennzeichen(), z.gueltigAb(), z.gueltigBis());
    }

    /** Ein Stellungs-Intervall in der Form des Vertrags ({@code $defs/stellungZuordnung}). */
    static MessstelleDto.StellungZuordnung stellungZuordnung(StellungZeile z) {
        return new MessstelleDto.StellungZuordnung(z.siteId().toString(), z.stellung(),
                z.unterzaehlerVonKennzeichen(), z.gueltigAb(), z.gueltigBis());
    }

    /**
     * Schreibt und fängt das eine Rennen, das die Prüfung vorher nicht ausschließen kann: ein
     * anderer belegt dasselbe Kennzeichen zwischen Prüfung und Schreiben. Die Datenbank lehnt
     * mit 23505 ab; nach dem Zurückrollen urteilen die Regeln neu und nennen den Träger.
     */
    private <T> T schreibe(String kandidat, String fuerMessstelle, Supplier<T> arbeit) {
        try {
            return arbeit.get();
        } catch (DataIntegrityViolationException e) {
            if (kandidat != null && "23505".equals(sqlState(e))) {
                kennzeichenFrei(kandidat, fuerMessstelle);
            }
            throw e;
        }
    }

    private void protokoll(UUID messstelle, String art, Map<String, Object> alt, Map<String, Object> neu,
            Instant giltAb, boolean rueckwirkend, String grund, ProtokollAkteur wer) {
        aenderungen.eintragen(new NeuerEintrag(TenantContext.get(), messstelle, art, alsJson(alt),
                alsJson(neu), giltAb, rueckwirkend, grund, wer.sub(), wer.name(), wer.rolle(), wer.art()));
    }

    private String alsJson(Map<String, Object> werte) {
        if (werte == null) {
            return null;
        }
        try {
            return json.writeValueAsString(werte);
        } catch (JsonProcessingException e) {
            throw new IllegalStateException("Protokolleintrag nicht darstellbar", e);
        }
    }

    /** Der Zeitpunkt eines Übergangs: auf die Minute (E2), fehlend = jetzt. */
    private static Instant zeitpunkt(MessstelleDto.Uebergang u, Instant jetzt) {
        OffsetDateTime z = u == null ? null : u.zeitpunkt();
        if (z == null) {
            return jetzt;
        }
        if (z.getSecond() != 0 || z.getNano() != 0) {
            throw MessstelleAbgelehnt.anfrage("zeitpunkt", "Der Zeitpunkt gilt auf die Minute — ohne Sekunden.");
        }
        return z.toInstant();
    }

    private static String grund(MessstelleDto.Uebergang u) {
        return u == null ? null : u.grund();
    }

    private static void vergleiche(String feld, String vorher, String nachher,
            Map<String, Object> alt, Map<String, Object> neu) {
        if (!Objects.equals(vorher, nachher)) {
            alt.put(feld, vorher);
            neu.put(feld, nachher);
        }
    }

    /** Ein Feld des Protokolls; der Zeitpunkt in der Form des Vertrags ({@code 2027-06-30T16:30:00+02:00}). */
    private static Map<String, Object> eintrag(String feld, Instant wert) {
        Map<String, Object> m = new LinkedHashMap<>();
        m.put(feld, wert == null ? null : DateTimeFormatter.ISO_OFFSET_DATE_TIME.format(zeit(wert)));
        return m;
    }

    private static Map<String, Object> groesseAlsMap(Groesse g) {
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("groesse", g.groesse());
        m.put("richtung", g.richtung());
        m.put("einheit", g.einheit());
        m.put("wertart", g.wertart());
        return m;
    }

    private static Groesse groesse(MessstelleDto.Groesse g) {
        return new Groesse(g.groesse(), g.richtung(), g.einheit(), g.wertart());
    }

    /** Leer (fehlend, leer oder nur Leerzeichen) ist {@code null}: „fehlt“ hat EINE Darstellung. */
    private static String text(String s) {
        return s == null || s.isBlank() ? null : s;
    }

    private static Instant minute(Instant t) {
        return t.truncatedTo(ChronoUnit.MINUTES);
    }

    /** Ein Zeitpunkt mit dem Versatz der Zeitzone; {@code null} bleibt {@code null}. */
    static OffsetDateTime zeit(Instant t) {
        return t == null ? null : OffsetDateTime.ofInstant(t, ZEITZONE);
    }

    private static String anzeige(Instant t) {
        return ANZEIGE.format(zeit(t));
    }

    private static String sqlState(Throwable e) {
        for (Throwable t = e; t != null; t = t.getCause()) {
            if (t instanceof SQLException s && s.getSQLState() != null) {
                return s.getSQLState();
            }
        }
        return null;
    }
}
