package com.voltpilot.api.werkstatt;

import com.voltpilot.api.fernwartung.Akteur;
import com.voltpilot.api.werkstatt.FernlaufRepository.Fernlauf;
import com.voltpilot.api.werkstatt.FernlaufRepository.Umstellung;
import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.function.Function;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Service;
import org.springframework.web.server.ResponseStatusException;

/**
 * „Nachts von selbst" (Konzept vp-update-vor-zuordnung, Entscheid des Captains 18.11.2026: E3 = B, §11.2; S4):
 * der Schalter des Betriebs, wer in der nächsten Nacht dran ist (für die Karte „Ohne Kundenkonto" und die Akte) und
 * der Takt, der in der Nacht je Durchlauf höchstens einen Auftrag anlegt. Was erlaubt ist, entscheidet allein die
 * reine Regel {@link Nachtlauf}; dieser Dienst sammelt nur ihre Eingaben und legt den Auftrag über
 * {@link FernlaufService#aufspielen} an - denselben wie der Knopf, mit dem Akteur {@link Nachtlauf#AKTEUR}.
 */
@Service
public class NachtlaufService {

    private static final Logger log = LoggerFactory.getLogger(NachtlaufService.class);

    /** So weit zurück liest der Takt Aufträge, auch vor Beginn der Nacht: ein offener Auftrag ist jünger. */
    static final Duration RUECKBLICK = Duration.ofHours(1);

    /** Der Schalter mit seiner jüngsten Umstellung ({@code null} = nie umgestellt, ab Werk an). */
    public record Schalter(boolean an, Umstellung zuletzt) {
    }

    /** Was die Karte über den Nachtlauf sagt: Schalter, die Nacht, und wie viele Läufe darin schon angelegt sind. */
    public record Lage(Schalter schalter, Nachtlauf.Nacht nacht, Instant naechsterBeginn, boolean imFenster,
            int angelegt, Instant jetzt) {
    }

    private final FernlaufRepository repo;
    private final FernlaufService fernlauf;
    private Clock uhr = Clock.systemUTC();
    private Function<Instant, Nachtlauf.Nacht> nachtVon = Nachtlauf::nacht;

    public NachtlaufService(FernlaufRepository repo, FernlaufService fernlauf) {
        this.repo = repo;
        this.fernlauf = fernlauf;
    }

    void setzeUhr(Clock uhr) {
        this.uhr = uhr;
    }

    /**
     * Nur für Tests mit echter Datenbank: das Nachtfenster um die echte Zeit legen, weil Fenster der Fernwartung,
     * Meldungen und Aufträge die Uhr der Datenbank und der anderen Dienste tragen. Die Fenster-Regel selbst prüft
     * {@code NachtlaufTest} rein.
     */
    void setzeNacht(Function<Instant, Nachtlauf.Nacht> nachtVon) {
        this.nachtVon = nachtVon;
    }

    // ── Schalter ─────────────────────────────────────────────────────────

    public Schalter schalter() {
        Optional<Umstellung> u = repo.nachtlaufSchalter();
        return new Schalter(u.map(Umstellung::an).orElse(true), u.orElse(null));
    }

    /** Den Schalter umlegen; dieselbe Stellung noch einmal ändert nichts. */
    public Schalter schalten(boolean an, Akteur akteur) {
        Schalter vorher = schalter();
        if (vorher.an() != an) {
            repo.nachtlaufSchalten(an, akteur.sub(), akteur.name(), uhr.instant());
            log.info("Nachtlauf: {} von {}", an ? "eingeschaltet" : "angehalten", akteur.sub());
        }
        return schalter();
    }

    public Lage lage() {
        Instant jetzt = uhr.instant();
        Nachtlauf.Nacht nacht = nachtVon.apply(jetzt);
        boolean drin = nacht.enthaelt(jetzt);
        return new Lage(schalter(), nacht, drin ? jetzt : nacht.beginn(), drin,
                Nachtlauf.anzahl(nacht, laeufe(repo.seit(fruehestens(nacht, jetzt)), jetzt)), jetzt);
    }

    // ── Wer dran ist ─────────────────────────────────────────────────────

    /** Je Box der Liste „Ohne Kundenkonto", ob sie in der nächsten (oder laufenden) Nacht dran ist. */
    public Map<String, Nachtlauf.Dran> plan(List<FernlaufService.Stand> liste) {
        Instant jetzt = uhr.instant();
        Nachtlauf.Nacht nacht = nachtVon.apply(jetzt);
        List<Nachtlauf.Lauf> juengste = laeufe(repo.seit(fruehestens(nacht, jetzt)), jetzt);
        return Nachtlauf.plan(schalter().an(), jetzt, nacht, liste.stream().map(NachtlaufService::box).toList(),
                juengste);
    }

    /**
     * Ob diese eine Box dran ist (für die Akte): erst sie allein; nur wenn sie es wäre, alle Boxen ohne
     * Kundenkonto, denn die Obergrenze verteilt die Plätze der Nacht in der Reihenfolge der Kennungen.
     */
    public Nachtlauf.Dran dran(FernlaufService.Stand stand) {
        Nachtlauf.Dran allein = plan(List.of(stand)).get(stand.edgeRef());
        if (!allein.dran()) {
            return allein;
        }
        return Optional.ofNullable(plan(fernlauf.ohneKundenkonto()).get(stand.edgeRef())).orElse(allein);
    }

    // ── Takt ─────────────────────────────────────────────────────────────

    /**
     * Ein Durchlauf: nur ein Replikat zur Zeit ({@link FernlaufRepository#alsEinziger}), höchstens ein Auftrag.
     * Schalter und Fenster prüft er zuerst, ohne die Boxen zu lesen - am Tag kostet ein Takt eine Abfrage.
     *
     * @return das Urteil der Regel; {@code null}, wenn ein anderer Takt führte
     */
    public Nachtlauf.Urteil takt() {
        Nachtlauf.Urteil[] out = new Nachtlauf.Urteil[1];
        if (!repo.alsEinziger(() -> out[0] = durchlauf())) {
            log.debug("Nachtlauf: ein anderer Takt führt");
            return null;
        }
        return out[0];
    }

    private Nachtlauf.Urteil durchlauf() {
        Instant jetzt = uhr.instant();
        Nachtlauf.Nacht nacht = nachtVon.apply(jetzt);
        boolean an = schalter().an();
        if (!an || !nacht.enthaelt(jetzt)) {
            return Nachtlauf.takt(an, jetzt, nacht, List.of(), List.of());
        }
        List<Nachtlauf.Lauf> juengste = laeufe(repo.seit(fruehestens(nacht, jetzt)), jetzt);
        List<FernlaufService.Stand> liste = juengste.stream().anyMatch(l -> FernlaufRegel.offen(l.zustand()))
                ? List.of() : fernlauf.ohneKundenkonto();
        Nachtlauf.Urteil u = Nachtlauf.takt(true, jetzt, nacht, liste.stream().map(NachtlaufService::box).toList(),
                juengste);
        if (u.art() == Nachtlauf.Art.ANLEGEN) {
            try {
                Fernlauf f = fernlauf.aufspielen(u.edgeRef(), u.fassung(), Nachtlauf.AKTEUR);
                log.info("Nachtlauf: Auftrag {} für {} auf {}", f.id(), u.edgeRef(), u.fassung());
            } catch (ResponseStatusException e) {
                // Die Vorprüfung beim Anlegen sieht es anders als eben (Box gerade weg, neuere Fassung): nichts
                // angelegt, der nächste Takt urteilt neu.
                log.warn("Nachtlauf: {} nicht angelegt: {}", u.edgeRef(), e.getReason());
            }
        }
        return u;
    }

    // ── intern ───────────────────────────────────────────────────────────

    private static Instant fruehestens(Nachtlauf.Nacht nacht, Instant jetzt) {
        Instant stunde = jetzt.minus(RUECKBLICK);
        return nacht.beginn().isBefore(stunde) ? nacht.beginn() : stunde;
    }

    private static List<Nachtlauf.Lauf> laeufe(List<Fernlauf> auftraege, Instant jetzt) {
        return auftraege.stream().map(f -> lauf(f, jetzt)).toList();
    }

    private static Nachtlauf.Lauf lauf(Fernlauf f, Instant jetzt) {
        return new Nachtlauf.Lauf(f.edgeRef(), f.fassungZiel(), Nachtlauf.URHEBER.equals(f.akteurSub()),
                f.zustand(jetzt), f.erteiltAm());
    }

    static Nachtlauf.Box box(FernlaufService.Stand s) {
        Instant jetzt = s.jetzt();
        return new Nachtlauf.Box(s.edgeRef(), s.urteil(), s.urteil().gruende().stream()
                .anyMatch(g -> "keine_neueste".equals(g.code())) ? null : s.neueste(), s.rueckmeldungAm(),
                s.verlauf().stream().map(f -> lauf(f, jetzt)).toList());
    }
}
