package com.voltpilot.api.werkstatt;

import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.voltpilot.api.enrollment.EnrollmentDeviceLookup;
import com.voltpilot.api.enrollment.EnrollmentRepository;
import com.voltpilot.api.fernwartung.Akteur;
import com.voltpilot.api.fernwartung.FernwartungProperties;
import com.voltpilot.api.fernwartung.FernwartungRepository.Fenster;
import com.voltpilot.api.fernwartung.FernwartungRepository.Zugang;
import com.voltpilot.api.fernwartung.FernwartungRueckmeldungRepository.BoxStand;
import com.voltpilot.api.fernwartung.FernwartungRueckmeldungService;
import com.voltpilot.api.fernwartung.FernwartungService;
import com.voltpilot.api.ota.BoxArt;
import com.voltpilot.api.ota.RolloutStates;
import com.voltpilot.api.repo.EdgeReleaseRepository;
import com.voltpilot.api.web.EdgeRef;
import com.voltpilot.api.web.dto.EdgeReleaseDto;
import com.voltpilot.api.werkstatt.FernlaufRepository.Fernlauf;
import java.time.Clock;
import java.time.Instant;
import java.util.Comparator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.UUID;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Service;
import org.springframework.web.server.ResponseStatusException;

/**
 * Neue Software für eine Box ohne Kundenkonto, durch den Wartungstunnel (Konzept vp-update-vor-zuordnung, S1,
 * entschieden 18.11.2026: E1 = A, E2 = A).
 *
 * <p><b>Auftrag.</b> Ein Klick in der Geräteakte prüft vor ({@link FernlaufRegel#vorpruefen}), öffnet ein Fenster von
 * 30 Minuten für den Techniker-Zugang des Werkstatt-Dienstes (Grund mit Fassung und Auftrag, Akteur der Auslöser)
 * und legt den Auftrag an: immer die neueste zuweisbare Fassung der Linie der Box mit Skriptstand (Edge Light für
 * die Mango, Edge Industrie für den PFC200; {@link FernlaufRegel#geraet}), dieselbe wie in der Werkstatt
 * ({@link WerkstattRegel#neueste(String)}), nur aufwärts, je Box höchstens einer offen. Der Akteur ist
 * ein Feld: Sammellauf (S2) und Nachtlauf (S4) legen denselben Auftrag an.
 *
 * <p><b>Dienst.</b> Der Werkstatt-Dienst sieht den Auftrag in der Antwort auf seine Ansicht, nimmt ihn an
 * ({@link #beginnen}), meldet seine Schritte und das Ergebnis und schließt das Fenster seines Auftrags - kein
 * anderes. Öffnen kann er keins. Was er meldet, ist Anzeige und Beleg; den Weg zur Box gibt allein das Fenster.
 *
 * <p><b>Ohne Ende.</b> Holt der Dienst einen Auftrag nicht in der Abholfrist ab oder meldet er bis zum Ende des
 * Fensters kein Ergebnis, zeigt die Akte das ({@code nicht_abgeholt}, {@code offen}); der nächste Auftrag für die
 * Box schreibt dafür das Ergebnis mit Quelle {@code portal} und schließt ein noch offenes Fenster.
 */
@Service
public class FernlaufService {

    private static final Logger log = LoggerFactory.getLogger(FernlaufService.class);

    /** Kein Schlüsselmaterial in einer Meldung des Dienstes (wie {@link DienstAnsichtService}). */
    private static final List<String> VERBOTEN = List.of("PRIVATE KEY", "AGE ENCRYPTED FILE", "AGE-SECRET-KEY");
    private static final int MAX_ZEILE = 1000;
    private static final int MAX_GRUND = 2000;
    private static final int MAX_BELEGE = 40;
    private static final int MAX_BELEG = 4096;

    /**
     * Was die Akte über die Box und ihren Fernlauf weiß; {@code rueckmeldungAm} ist, wann die API die letzte
     * Meldung des Tunnel-Dienstes zu ihr annahm ({@code null} = nie), für den Nachtlauf ({@link Nachtlauf}).
     */
    public record Stand(String edgeRef, String laeuft, Instant laeuftGemeldetAm, Instant fragtZuletztAm,
            String neueste, String werkstattFassung, Instant werkstattAm, FernlaufRegel.Urteil urteil,
            List<Fernlauf> verlauf, Instant rueckmeldungAm, Instant jetzt) {
    }

    /** Was der Dienst beim Annehmen bekommt: alles für seinen Lauf, nichts Geheimes. */
    public record Auftrag(Fernlauf fernlauf, String tunnelAdresse, String hostSchluessel, Instant fensterEnde,
            FernwartungProperties server) {
    }

    /** Was der Dienst als Ergebnis meldet. */
    public record ErgebnisMeldung(String ergebnis, String grund, String schritt, String fassungVorher,
            String fassungNachher, Map<String, String> belege) {
    }

    private final FernlaufRepository repo;
    private final EnrollmentDeviceLookup geraete;
    private final EnrollmentRepository enrollments;
    private final WerkstattRepository werkstatt;
    private final EinloesungRepository einloesungen;
    private final FernwartungService fernwartung;
    private final FernwartungRueckmeldungService rueckmeldungen;
    private final DienstAnsichtService ansichten;
    private final WerkstattRegel regel;
    private final EdgeReleaseRepository releases;
    private final ObjectMapper json;
    private final String technikerZugang;
    private Clock uhr = Clock.systemUTC();

    public FernlaufService(FernlaufRepository repo, EnrollmentDeviceLookup geraete, EnrollmentRepository enrollments,
            WerkstattRepository werkstatt, EinloesungRepository einloesungen, FernwartungService fernwartung,
            FernwartungRueckmeldungService rueckmeldungen, DienstAnsichtService ansichten, WerkstattRegel regel,
            EdgeReleaseRepository releases, ObjectMapper json,
            @Value("${voltpilot.werkstatt.techniker-zugang:}") String technikerZugang) {
        this.repo = repo;
        this.geraete = geraete;
        this.enrollments = enrollments;
        this.werkstatt = werkstatt;
        this.einloesungen = einloesungen;
        this.fernwartung = fernwartung;
        this.rueckmeldungen = rueckmeldungen;
        this.ansichten = ansichten;
        this.regel = regel;
        this.releases = releases;
        this.json = json;
        this.technikerZugang = technikerZugang == null ? "" : technikerZugang.trim();
    }

    void setzeUhr(Clock uhr) {
        this.uhr = uhr;
    }

    // ── Akte ──────────────────────────────────────────────────────────────

    public Stand stand(String edgeRef) {
        pruefeRef(edgeRef);
        Instant jetzt = uhr.instant();
        List<Fernlauf> verlauf = repo.letzte(edgeRef, 10);
        Lage l = lage(edgeRef, verlauf, jetzt);
        return new Stand(edgeRef, l.eingabe().laeuft(), l.meldung().map(EnrollmentRepository.Meldung::csrUpdatedAt)
                .orElse(null), l.meldung().map(EnrollmentRepository.Meldung::zuletztAbgefragtAm).orElse(null),
                l.neueste().soll() == null ? l.neueste().name() : l.neueste().soll().edgeLight().fassung(),
                l.abnahme().map(WerkstattRepository.Abnahme::fassung).orElse(null),
                l.abnahme().map(WerkstattRepository.Abnahme::erfasstAm).orElse(null),
                FernlaufRegel.vorpruefen(l.eingabe(), jetzt), verlauf, l.eingabe().rueckmeldungAm(), jetzt);
    }

    /**
     * Der Klick „Auf … bringen“: 201 mit dem Auftrag; 409 mit dem ersten Grund der Vorprüfung, oder wenn die
     * bestätigte Fassung nicht mehr die neueste ist; 422 Kennung.
     */
    public Fernlauf aufspielen(String edgeRef, String fassung, Akteur akteur) {
        pruefeRef(edgeRef);
        Instant jetzt = uhr.instant();
        List<Fernlauf> verlauf = repo.letzte(edgeRef, 10);
        Lage l = lage(edgeRef, verlauf, jetzt);
        FernlaufRegel.Urteil u = FernlaufRegel.vorpruefen(l.eingabe(), jetzt);
        if (!u.moeglich()) {
            throw new ResponseStatusException(HttpStatus.CONFLICT, u.gruende().get(0).text());
        }
        WerkstattRegel.Soll ziel = l.neueste().soll();
        if (fassung != null && !fassung.isBlank() && !fassung.trim().equals(ziel.edgeLight().fassung())) {
            throw new ResponseStatusException(HttpStatus.CONFLICT, "Inzwischen ist " + ziel.edgeLight().fassung()
                    + " die neueste Fassung; bitte noch einmal bestätigen.");
        }
        for (Fernlauf alt : verlauf) {
            abschliessen(alt, jetzt);
        }
        UUID id = UUID.randomUUID();
        Fenster fenster = fernwartung.fensterOeffnen(edgeRef, l.techniker().id(), "Software aufspielen "
                + ziel.edgeLight().fassung() + " (Auftrag " + id.toString().substring(0, 8) + ")",
                FernlaufRegel.FENSTER, null, akteur);
        try {
            repo.anlegen(id, edgeRef, FernlaufRegel.AUFSPIELEN, l.eingabe().laeuft(), ziel, fenster.id(),
                    akteur.sub(), akteur.name(), jetzt);
        } catch (RuntimeException e) {
            fernwartung.fensterSchliessen(fenster.id(), akteur);
            throw e;
        }
        log.info("Fernlauf {}: {} von {} auf {} (Fenster {}, ausgelöst von {})", id, edgeRef, l.eingabe().laeuft(),
                ziel.edgeLight().fassung(), fenster.id(), akteur.sub());
        return repo.mitId(id).orElseThrow();
    }

    /**
     * Alle Boxen ohne Kundenkonto mit Tunnel-Zugang, für die Karte „Ohne Kundenkonto" (S2, §4.5 „Plattform › Geräte
     * › Updates"): derselbe Stand wie {@link #stand}, einmal je Box - reine Auflistung, keine zweite Vorprüfung.
     * Eine Box ohne Tunnel-Zugang steht hier nie (ohne ihn gibt es weder einen Fernlauf noch diese Karte für sie).
     */
    public List<Stand> ohneKundenkonto() {
        return fernwartung.boxen().stream().map(Zugang::edgeRef).distinct()
                .filter(ref -> geraete.findByRef(ref).isEmpty())
                .filter(ref -> !enrollments.meldung(ref).map(EnrollmentRepository.Meldung::zertifikat).orElse(false))
                .sorted()
                .map(this::standFuerUebersicht)
                .toList();
    }

    /**
     * Wie {@link #stand}, aber für die Liste: eine Kennung, die {@link #pruefeRef} ablehnt (z. B. ein
     * Sticker-Format oder eine fremde Form), kippt nie die ganze Liste - sie erscheint mit Grund, so wie jede
     * andere nicht mögliche Box.
     */
    private Stand standFuerUebersicht(String edgeRef) {
        try {
            return stand(edgeRef);
        } catch (ResponseStatusException e) {
            log.warn("Fernlauf-Übersicht: Stand von {} nicht lesbar ({})", edgeRef, e.getReason());
            String grund = e.getReason() == null || e.getReason().isBlank() ? "Der Stand dieser Box ist nicht "
                    + "lesbar." : e.getReason();
            return new Stand(edgeRef, null, null, null, null, null, null,
                    new FernlaufRegel.Urteil(false, List.of(new FernlaufRegel.Grund("stand_unlesbar", grund)),
                            new FernlaufRegel.Haken(false, false, true)),
                    List.of(), null, uhr.instant());
        }
    }

    // ── Dienst ────────────────────────────────────────────────────────────

    /**
     * Der letzte Fernlauf dieser Box, neueste zuerst (für die Werkstatt-Seite, S3 §4.6 „Nach der Werkstatt");
     * {@code empty}, wenn für diese Box noch nie einer lief.
     */
    public Optional<Fernlauf> letzter(String edgeRef) {
        pruefeRef(edgeRef);
        return repo.letzte(edgeRef, 1).stream().findFirst();
    }

    /** Aufträge, die der Dienst annehmen kann (in der Antwort auf seine Ansicht, nicht verbraucht). */
    public List<Fernlauf> abholbar() {
        return repo.abholbar(uhr.instant().minus(FernlaufRegel.ABHOLFRIST));
    }

    /**
     * Der Dienst nimmt einen Auftrag an: 200 mit allem für den Lauf; 404 unbekannt; 409, wenn er nicht mehr
     * abholbar ist. Hat die Box inzwischen ein Kundenkonto oder ein Zertifikat, oder ist das Fenster schon zu, endet
     * der Auftrag hier ohne Änderung (Ergebnis {@code unveraendert}, Quelle {@code portal}).
     */
    public Auftrag beginnen(UUID id, Akteur dienst) {
        Fernlauf f = mitId(id);
        Instant jetzt = uhr.instant();
        if (!"erteilt".equals(f.zustand(jetzt))) {
            throw new ResponseStatusException(HttpStatus.CONFLICT, "Dieser Auftrag ist nicht mehr abholbar ("
                    + f.zustand(jetzt) + ").");
        }
        boolean konto = geraete.findByRef(f.edgeRef()).isPresent()
                || enrollments.meldung(f.edgeRef()).map(EnrollmentRepository.Meldung::zertifikat).orElse(false);
        if (konto || !f.fensterEnde().isAfter(jetzt)) {
            String grund = konto ? "Inzwischen verbunden: Das Update läuft über das erste Verbinden."
                    : "Das Fenster des Auftrags war schon zu.";
            repo.ergebnis(f.id(), f.edgeRef(), "unveraendert", grund, null, f.fassungVorher(), null, "{}", "portal",
                    jetzt);
            fensterZu(f, dienst);
            throw new ResponseStatusException(HttpStatus.CONFLICT, grund);
        }
        if (!repo.beginnen(id, jetzt, jetzt.minus(FernlaufRegel.ABHOLFRIST))) {
            throw new ResponseStatusException(HttpStatus.CONFLICT, "Dieser Auftrag ist schon angenommen.");
        }
        Zugang box = fernwartung.box(f.edgeRef()).orElseThrow(() -> new ResponseStatusException(HttpStatus.CONFLICT,
                "Die Box hat keinen Tunnel-Zugang mehr."));
        String host = hostSchluessel(f.edgeRef(), abnahme(f.edgeRef())).orElse(null);
        log.info("Fernlauf {}: vom Werkstatt-Dienst angenommen ({})", id, f.edgeRef());
        return new Auftrag(repo.mitId(id).orElseThrow(), box.adresse(), host, f.fensterEnde(),
                fernwartung.konfiguration());
    }

    /** Ein Schritt des Dienstes: 204; 409 nicht angenommen oder schon beendet; 422 Form. */
    public void schritt(UUID id, String schritt, String zustand, String zeile) {
        Fernlauf f = mitId(id);
        if (schritt == null || !FernlaufRegel.SCHRITTE.contains(schritt)) {
            throw form("schritt: einer aus " + FernlaufRegel.SCHRITTE);
        }
        if (zustand == null || !FernlaufRegel.SCHRITT_ZUSTAENDE.contains(zustand)) {
            throw form("zustand: laeuft, belegt oder gescheitert");
        }
        String text = text(zeile, MAX_ZEILE, "zeile");
        Instant jetzt = uhr.instant();
        String eintrag = null;
        if (!"laeuft".equals(zustand)) {
            Map<String, Object> e = new LinkedHashMap<>();
            e.put("schritt", schritt);
            e.put("zustand", zustand);
            e.put("zeit", jetzt.toString());
            if (text != null) {
                e.put("zeile", text);
            }
            eintrag = schreibe(e);
        }
        Instant seit = "laeuft".equals(zustand) || f.schrittSeit() == null || !schritt.equals(f.schritt())
                ? jetzt : f.schrittSeit();
        if (!repo.schritt(id, schritt, seit, eintrag, jetzt)) {
            throw new ResponseStatusException(HttpStatus.CONFLICT, "Dieser Auftrag ist nicht angenommen oder schon "
                    + "beendet.");
        }
    }

    /** Was die Plattform gerade von der Box des Auftrags hört (für den Schritt {@code meldet_sich}). */
    public EnrollmentRepository.Meldung meldung(UUID id) {
        Fernlauf f = mitId(id);
        if (f.begonnenAm() == null || f.ergebnis() != null) {
            throw new ResponseStatusException(HttpStatus.CONFLICT, "Dieser Auftrag läuft nicht.");
        }
        return enrollments.meldung(f.edgeRef()).orElse(new EnrollmentRepository.Meldung(null, null, null, false));
    }

    /** Das Ergebnis des Dienstes: 201; 409 nicht angenommen oder schon eins; 422 Form oder Schlüsselmaterial. */
    public Fernlauf ergebnis(UUID id, ErgebnisMeldung m) {
        Fernlauf f = mitId(id);
        if (m == null || m.ergebnis() == null || !FernlaufRegel.ERGEBNISSE.contains(m.ergebnis())) {
            throw form("ergebnis: einer aus " + FernlaufRegel.ERGEBNISSE);
        }
        if (m.schritt() != null && !FernlaufRegel.SCHRITTE.contains(m.schritt())) {
            throw form("schritt: einer aus " + FernlaufRegel.SCHRITTE);
        }
        String grund = text(m.grund(), MAX_GRUND, "grund");
        String vorher = text(m.fassungVorher(), 64, "fassungVorher");
        String nachher = text(m.fassungNachher(), 64, "fassungNachher");
        Map<String, String> belege = m.belege() == null ? Map.of() : m.belege();
        if (belege.size() > MAX_BELEGE) {
            throw form("höchstens " + MAX_BELEGE + " Belege");
        }
        Map<String, String> geprueft = new LinkedHashMap<>();
        for (Map.Entry<String, String> b : belege.entrySet()) {
            if (b.getKey() == null || !b.getKey().matches("^[a-z0-9_]{1,40}$")) {
                throw form("Beleg-Name: klein, Ziffern und _ (höchstens 40)");
            }
            geprueft.put(b.getKey(), text(b.getValue(), MAX_BELEG, "beleg " + b.getKey()));
        }
        if (f.begonnenAm() == null) {
            throw new ResponseStatusException(HttpStatus.CONFLICT, "Dieser Auftrag ist nicht angenommen.");
        }
        Instant jetzt = uhr.instant();
        if (!repo.ergebnis(id, f.edgeRef(), m.ergebnis(), grund, m.schritt(), vorher == null ? f.fassungVorher()
                : vorher, nachher, schreibe(geprueft), "dienst", jetzt)) {
            throw new ResponseStatusException(HttpStatus.CONFLICT, "Für diesen Auftrag gibt es schon ein Ergebnis.");
        }
        log.info("Fernlauf {}: {} ({}, Schritt {}, nachher {})", id, m.ergebnis(), f.edgeRef(), m.schritt(), nachher);
        return repo.mitId(id).orElseThrow();
    }

    /** Das Fenster des Auftrags schließen (nur dieses): das geschlossene Fenster; 409 schon zu. */
    public Fenster fensterSchliessen(UUID id, Akteur dienst) {
        return fernwartung.fensterSchliessen(mitId(id).fensterId(), dienst);
    }

    // ── intern ────────────────────────────────────────────────────────────

    private record Lage(FernlaufRegel.Eingabe eingabe, Optional<EnrollmentRepository.Meldung> meldung,
            Optional<WerkstattRepository.Abnahme> abnahme, WerkstattRegel.Neueste neueste, Zugang techniker) {
    }

    private Lage lage(String edgeRef, List<Fernlauf> verlauf, Instant jetzt) {
        Optional<EnrollmentRepository.Meldung> meldung = enrollments.meldung(edgeRef);
        Optional<WerkstattRepository.Box> wbox = werkstatt.box(edgeRef);
        Optional<WerkstattRepository.Abnahme> abnahme = wbox.flatMap(b -> werkstatt.abnahmen(b.id()).stream()
                .findFirst());
        String laeuft = FernlaufRegel.laeuft(meldung.map(EnrollmentRepository.Meldung::deviceInfo).orElse(null));
        // Das Gerät entscheidet die Linie: Eine Mango bekommt nie Edge Industrie, ein PFC200 nie Edge Light. Ohne
        // erkanntes Gerät gibt es keinen Knopf (Grund keine_edge_light); gezeigt wird dann die Linie der Mango.
        String erkannt = FernlaufRegel.geraet(wbox.map(WerkstattRepository.Box::boxArt).orElse(null), laeuft);
        String geraet = erkannt == null ? WerkstattRegel.MANGO : erkannt;
        String linie = WerkstattRegel.PFC200.equals(geraet) ? BoxArt.INDUSTRIE : BoxArt.LIGHT;
        Long laeuftSeq = laeuft == null ? null : releases.findAll().stream()
                .filter(r -> linie.equals(BoxArt.ofRelease(r.version(), r.manifest())))
                .filter(r -> RolloutStates.releaseIsRunning(r.version(), laeuft))
                .max(Comparator.comparingLong(EdgeReleaseDto::releaseSeq)).map(EdgeReleaseDto::releaseSeq)
                .orElse(null);
        WerkstattRegel.Neueste neueste = regel.neueste(geraet);
        Optional<Zugang> zugang = fernwartung.box(edgeRef);
        BoxStand rm = zugang.map(z -> rueckmeldungen.boxen().get(z.id())).orElse(null);
        Zugang techniker = techniker();
        Optional<DienstAnsichtService.Gemeldet> dienst = ansichten.gemeldet();
        JsonNode fl = dienst.map(g -> g.ansicht().path("fernlauf")).orElse(null);
        Boolean dienstFernlauf = fl == null || !fl.isObject() ? null : fl.path("bereit").asBoolean(false);
        String dienstGrund = fl == null ? null : fl.path("grund").asText(null);
        boolean offen = verlauf.stream().anyMatch(f -> FernlaufRegel.offen(f.zustand(jetzt)));
        FernlaufRegel.Eingabe e = new FernlaufRegel.Eingabe(geraete.findByRef(edgeRef).isPresent(),
                meldung.map(EnrollmentRepository.Meldung::zertifikat).orElse(false),
                erkannt != null, laeuft, laeuftSeq,
                neueste.soll() == null ? null : neueste.soll().edgeLight().fassung(),
                neueste.soll() == null ? null : neueste.soll().releaseSeq(), neueste.grund(), zugang.isPresent(),
                zugang.map(Zugang::aktiv).orElse(false), rm == null ? null : rm.angenommenAm(),
                rm == null ? null : rm.verbundenSeit(), rm == null ? null : rm.zuletztGefragtUm(), techniker != null,
                dienst.map(DienstAnsichtService.Gemeldet::gemeldetAm).orElse(null), dienstFernlauf, dienstGrund,
                hostSchluessel(edgeRef, abnahme).isPresent(), offen);
        return new Lage(e, meldung, abnahme, neueste, techniker);
    }

    /**
     * Beendet einen alten Auftrag, den niemand zu Ende gemeldet hat ({@code nicht_abgeholt}, {@code offen}): das
     * Ergebnis mit Quelle {@code portal}, und ein noch offenes Fenster geht zu.
     */
    private void abschliessen(Fernlauf f, Instant jetzt) {
        String z = f.zustand(jetzt);
        if (!"nicht_abgeholt".equals(z) && !"offen".equals(z)) {
            return;
        }
        String grund = "nicht_abgeholt".equals(z) ? "Der Werkstatt-Dienst hat den Auftrag nicht abgeholt."
                : "Der Werkstatt-Dienst hat bis zum Ende des Fensters kein Ergebnis gemeldet.";
        repo.ergebnis(f.id(), f.edgeRef(), "nicht_abgeholt".equals(z) ? "unveraendert" : "offen", grund, f.schritt(),
                f.fassungVorher(), null, "{}", "portal", jetzt);
        fensterZu(f, new Akteur("werkstatt-fernlauf", "Fernlauf, Auftrag " + f.id().toString().substring(0, 8)));
    }

    private void fensterZu(Fernlauf f, Akteur akteur) {
        if (f.fensterEnde() != null && f.fensterEnde().isAfter(uhr.instant())) {
            try {
                fernwartung.fensterSchliessen(f.fensterId(), akteur);
            } catch (ResponseStatusException e) {
                if (e.getStatusCode() != HttpStatus.CONFLICT) {
                    throw e;
                }
            }
        }
    }

    private Optional<WerkstattRepository.Abnahme> abnahme(String edgeRef) {
        return werkstatt.box(edgeRef).flatMap(b -> werkstatt.abnahmen(b.id()).stream().findFirst());
    }

    /** Der Host-Schlüssel aus der letzten Abnahme, sonst aus der letzten Einlösung. */
    private Optional<String> hostSchluessel(String edgeRef, Optional<WerkstattRepository.Abnahme> abnahme) {
        return abnahme.map(WerkstattRepository.Abnahme::hostSchluessel).filter(h -> h != null && !h.isBlank())
                .or(() -> einloesungen.einloesungen(edgeRef).stream().findFirst()
                        .map(EinloesungRepository.Einloesung::hostSchluessel));
    }

    /** Der Techniker-Zugang „Werkstatt-Dienst“, eingerichtet und aktiv; sonst {@code null}. */
    private Zugang techniker() {
        UUID id;
        try {
            id = UUID.fromString(technikerZugang);
        } catch (IllegalArgumentException e) {
            return null;
        }
        return fernwartung.techniker().stream().filter(t -> t.id().equals(id) && t.aktiv()).findFirst().orElse(null);
    }

    private Fernlauf mitId(UUID id) {
        return repo.mitId(id).orElseThrow(() -> new ResponseStatusException(HttpStatus.NOT_FOUND,
                "Diesen Auftrag gibt es nicht."));
    }

    private static void pruefeRef(String edgeRef) {
        if (edgeRef == null || !EdgeRef.isValid(edgeRef)) {
            throw new ResponseStatusException(HttpStatus.UNPROCESSABLE_CONTENT,
                    "Einen Fernlauf gibt es nur für eine Kennung der Box mit gültigem Prüfzeichen (edge-…).");
        }
    }

    private static String text(String s, int max, String feld) {
        if (s == null || s.isBlank()) {
            return null;
        }
        if (s.length() > max) {
            throw form(feld + ": höchstens " + max + " Zeichen");
        }
        for (String v : VERBOTEN) {
            if (s.contains(v)) {
                throw form(feld + " enthält Schlüsselmaterial");
            }
        }
        return s;
    }

    private String schreibe(Object o) {
        try {
            return json.writeValueAsString(o);
        } catch (JsonProcessingException e) {
            throw new IllegalStateException(e);
        }
    }

    private static ResponseStatusException form(String grund) {
        return new ResponseStatusException(HttpStatus.UNPROCESSABLE_CONTENT, grund);
    }
}
