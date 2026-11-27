package com.voltpilot.api.uems;

import com.voltpilot.api.flows.FlowActivationService;
import com.voltpilot.api.repo.SiteRepository;
import com.voltpilot.api.repo.UmzugMerkzettelRepository;
import com.voltpilot.api.tenant.TenantContext;
import com.voltpilot.api.uems.StandortLesemodell.Lage;
import com.voltpilot.api.uems.StandortLesemodell.StandortAmStichtag;
import com.voltpilot.api.uems.StandortLesemodell.StandortBezug;
import com.voltpilot.api.uems.StandortLesemodell.ZugeordneteAnlage;
import com.voltpilot.api.web.dto.AnlageOrtDto;
import com.voltpilot.api.web.dto.AnlageUmzugDto;
import com.voltpilot.api.web.dto.SiteDto;
import com.voltpilot.api.web.dto.StandortDto;
import java.math.BigDecimal;
import java.time.Clock;
import java.time.LocalDate;
import java.time.ZoneId;
import java.util.UUID;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

/**
 * „Ort berichtigen" (vp-standort-konzept §6.1/§6.6, B1/B3/B6): EIN Schreibweg statt drei (der
 * Standort-PUT der Adresse, ein eigener PUT des Kartenpunkts der Anlage, und — bisher gar nicht
 * verbunden — die Folgen für Box und Wetter). Nie ein Datum: eine Korrektur gilt rückwirkend für
 * die Stammdaten, wie jede Berichtigung der Ortsstruktur; die Zuordnung „Gehört zu" bleibt der
 * eigene Weg {@link AnlageUmzugService}.
 *
 * <h2>Mehrere Anlagen an einem Standort (§6.6)</h2>
 *
 * Nur DIESE Anlage bekommt immer den gemeldeten Punkt (die Adresse setzt ihren Pin). Die
 * übrigen Anlagen des Standorts (Geschwister) ziehen NUR mit, wenn ihr eigener Punkt noch genau
 * auf dem ALTEN Standortpunkt lag (kein gezogener Pin wird überschrieben) — außer der neue Punkt
 * liegt mehr als 2 km vom alten entfernt: dann zieht JEDE Anlage des Standorts mit derselben
 * Verschiebung mit (auch eine, deren Pin schon vorher gezogen war). Das behebt B3 (Adresse und
 * Kartenpunkt liefen auseinander, weil die alte Weiterleitung nur Anlagen OHNE eigenen Punkt
 * traf — nach Anlage-Flow a1 hat jede Anlage von Anfang an einen).
 *
 * <h2>Box und Wetter (§6.6)</h2>
 *
 * Jede Anlage, deren eigener Punkt sich ändert, bekommt ihre Steuerlogik-Bündel neu gebaut und
 * zugestellt ({@link FlowActivationService#republishForSite}, Sonnenbezug). Liegt ihr neuer
 * Punkt mehr als 2 km vom alten entfernt, wird zusätzlich ein Auftrag „Wetter nachholen"
 * eingetragen ({@link OrtWetterNachholungRepository}) — der Wetter-Collector (services/forecast)
 * verwirft dann das gespeicherte Wetter der Anlage und holt 28 Tage am neuen Punkt nach, damit
 * die Prognose nicht am alten Ort weiterlernt.
 *
 * <h2>Umzug (§7, E1 = B): dasselbe Wetter, aber am Tag getrennt</h2>
 *
 * {@link #umziehen} trägt denselben Nachholungs-Auftrag MIT einem {@code ab_tag} ein: der
 * Collector verwirft dann NICHT alles, sondern behält das Wetter vor dem Umzugstag (am alten
 * Punkt richtig gelernt) und ersetzt nur ab dann durch das neue am neuen Punkt. Außerdem setzt
 * {@code umziehen} {@code site.umzug_seit} — der Prognose-Sammler beginnt sein Lernfenster bei
 * max(heute − 28 Tage, Umzugstag) statt immer bei heute − 28 Tage (Bericht 6.4/E1 Punkt 4); eine
 * Berichtigung („Adresse war falsch") setzt das NICHT, sie darf wie bisher alles ersetzen.
 */
@Service
public class AnlageOrtService {

    /** §6.6: „weit weg" — mehr als 2 km. */
    static final double WEIT_WEG_KM = 2.0;

    private final SiteRepository sites;
    private final StandortLesemodellService lesemodell;
    private final StandortService standorte;
    private final FlowActivationService deployments;
    private final OrtWetterNachholungRepository wetterNachholung;
    private final AnlageUmzugService umzuege;
    private final UmzugMerkzettelRepository merkzettel;
    private volatile Clock uhr = Clock.systemUTC();

    public AnlageOrtService(SiteRepository sites, StandortLesemodellService lesemodell,
            StandortService standorte, FlowActivationService deployments,
            OrtWetterNachholungRepository wetterNachholung, AnlageUmzugService umzuege,
            UmzugMerkzettelRepository merkzettel) {
        this.sites = sites;
        this.lesemodell = lesemodell;
        this.standorte = standorte;
        this.deployments = deployments;
        this.wetterNachholung = wetterNachholung;
        this.umzuege = umzuege;
        this.merkzettel = merkzettel;
    }

    /** Nur für Tests: die Uhr, an der „heute" (keine Zukunft, E1 = B Lesart 1) hängt. */
    void uhrStellen(Clock uhr) {
        this.uhr = uhr;
    }

    @Transactional
    public AnlageOrtDto.Ergebnis berichtigen(UUID siteId, AnlageOrtDto.Anfrage a, ProtokollAkteur wer) {
        UUID tenant = TenantContext.get();
        SiteDto site = sites.findById(siteId);
        if (site == null) {
            throw OrtAbgelehnt.nichtGefunden("Diese Anlage gibt es nicht.");
        }
        StandortBezug bezug = lesemodell.bezugDerAnlage(siteId);
        if (bezug == null) {
            throw OrtAbgelehnt.nichtGefunden("Diese Anlage hat noch keinen Standort.");
        }
        StandortAmStichtag vorStandort = lesemodell.standort(bezug.id(), null)
                .orElseThrow(() -> new IllegalStateException("Standort verschwunden: " + bezug.id()));
        Lage alteStandortLage = vorStandort.lage();

        StandortDto.Stammdaten stammdaten = new StandortDto.Stammdaten(vorStandort.name(), vorStandort.kurzzeichen(),
                a.adresse(), vorStandort.zeitzone(), vorStandort.nutzung(), vorStandort.notiz(), a.lage());
        StandortAmStichtag nachStandort = standorte.bearbeiten(bezug.id(), stammdaten, wer);
        Lage neueLage = nachStandort.lage();
        if (neueLage == null) {
            throw OrtAbgelehnt.anfrage("lage", "Bitte setzen Sie den Punkt auf der Karte.");
        }
        String neueGebotszone = OrtFelder.gebotszoneFuerLand(nachStandort.adresse().land());

        // Diese Anlage: die Adresse setzt den Pin — ihr Punkt wird IMMER der gemeldete, unabhängig
        // davon, ob er dem Standort folgt oder (fein gezogen) leicht davon abweicht.
        sites.lageUndGebotszoneSetzen(siteId, neueLage.breitengrad(), neueLage.laengengrad(), neueGebotszone);
        boolean boxZugestellt = deployments.republishForSite(siteId);
        boolean wetterAngestossen = weitWeg(site.latitude(), site.longitude(), neueLage);
        if (wetterAngestossen) {
            wetterNachholung.anfordern(tenant, siteId);
        }

        geschwisterMitziehen(vorStandort, siteId, alteStandortLage, neueLage, neueGebotszone, tenant);

        SiteDto neuesSite = sites.findById(siteId);
        return new AnlageOrtDto.Ergebnis(neuesSite, nachStandort, boxZugestellt, wetterAngestossen);
    }

    /**
     * „Umzug" (E1 = B, §7): anders als {@link #berichtigen} entsteht ein NEUER Standort statt den
     * bisherigen in-place zu ändern — nur DIESE Anlage gehört ihm, ihre Geschwister am bisherigen
     * Standort bleiben unberührt (kein {@code geschwisterMitziehen}). Der neue Standort heißt wie
     * die Anlage und entsteht still über {@link StandortService#anlegen} — derselbe Dienst, den
     * {@code StandortController} hinter {@code standort.verwalten} aufruft, hier als interner
     * Schritt des bereits mit {@code anlage.ort_berichtigen} geprüften Aufrufs (keine zweite,
     * eigene Rechteprüfung: ein Unterstützer ab „Einrichten" hat {@code standort.verwalten} sonst
     * nicht). Die Zuordnung selbst läuft über den vorhandenen Weg {@link AnlageUmzugService}
     * (Vorgang VERSCHIEBEN), der bisherige Standort wird NICHT automatisch archiviert — das
     * Portal bietet es danach an, wie bei „Zuordnung korrigieren" (derselbe Lese-Weg, keine
     * eigene Mechanik hier).
     */
    @Transactional
    public AnlageOrtDto.UmzugErgebnis umziehen(UUID siteId, AnlageOrtDto.UmzugAnfrage a, ProtokollAkteur wer) {
        UUID tenant = TenantContext.get();
        SiteDto site = sites.findById(siteId);
        if (site == null) {
            throw OrtAbgelehnt.nichtGefunden("Diese Anlage gibt es nicht.");
        }
        StandortBezug bezug = lesemodell.bezugDerAnlage(siteId);
        if (bezug == null) {
            throw OrtAbgelehnt.nichtGefunden("Diese Anlage hat noch keinen Standort.");
        }
        StandortAmStichtag alterStandort = lesemodell.standort(bezug.id(), null)
                .orElseThrow(() -> new IllegalStateException("Standort verschwunden: " + bezug.id()));
        Lage neueLage = a.lage();
        if (neueLage == null) {
            throw OrtAbgelehnt.anfrage("lage", "Bitte setzen Sie den Punkt auf der Karte.");
        }
        // Lesart 1 (§7): der Umzugstag ist heute oder ein Tag davor, nie in der Zukunft — der
        // Punkt der Anlage hat keine Gültigkeit und wechselt sofort beim Speichern.
        LocalDate heute = uhr.instant().atZone(ZoneId.of(alterStandort.zeitzone())).toLocalDate();
        LocalDate gueltigAb = a.gueltigAb() == null ? heute : a.gueltigAb();
        if (gueltigAb.isAfter(heute)) {
            throw OrtAbgelehnt.anfrage("gueltigAb", "Der Umzugstag darf nicht in der Zukunft liegen.");
        }

        // Ein neuer Standort entsteht still mit der neuen Adresse — er heißt wie die Anlage
        // (beim Privatkunden bleibt „Gehört zu" ohnehin unsichtbar, sobald der alte Standort
        // leer archiviert ist: ein einziger vorhandener Standort zeigt es nie, §6.2). Ein noch
        // nicht archivierter Standort eines FRÜHEREN Umzugs derselben Anlage trägt denselben Namen
        // schon — ein Zähler hängt dann an, statt mit "name_belegt" abzulehnen.
        String standortName = standorte.freierStandortName(site.name());
        StandortDto.Stammdaten stammdaten = new StandortDto.Stammdaten(standortName, null, a.adresse(), null, null,
                null, neueLage);
        StandortAmStichtag neuerStandort = standorte.anlegen(stammdaten, wer);

        AnlageUmzugDto.Anfrage umzugAnfrage = new AnlageUmzugDto.Anfrage(neuerStandort.id(), gueltigAb, null, false);
        AnlageUmzugDto.Umzug umzug = umzuege.umziehen(siteId, umzugAnfrage, wer);

        String neueGebotszone = OrtFelder.gebotszoneFuerLand(a.adresse().land());
        sites.lageUndGebotszoneSetzen(siteId, neueLage.breitengrad(), neueLage.laengengrad(), neueGebotszone);
        // Bericht 6.4/E1 Punkt 4: das Lernfenster der Prognose beginnt bei max(heute - 28 Tage,
        // Umzugstag) — unabhängig davon, ob sich der Punkt um mehr als 2 km verschoben hat (auch
        // ein naher Umzug ist ein Umzug, keine Berichtigung).
        sites.umzugSeitSetzen(siteId, gueltigAb);
        // Bericht 6.6 Punkt 7: der Merkzettel "Neues Haus? Bitte prüfen" ersetzt eine noch
        // offene frühere Erinnerung vollständig (ein neuerer Umzug zählt).
        merkzettel.neuAnlegen(tenant, siteId);
        boolean boxZugestellt = deployments.republishForSite(siteId);
        boolean wetterAngestossen = weitWeg(site.latitude(), site.longitude(), neueLage);
        if (wetterAngestossen) {
            // §7: anders als bei "Ort berichtigen" bleibt das Wetter VOR dem Umzugstag (am alten
            // Punkt gelernt) stehen - der Nachholer ersetzt nur ab `gueltigAb`.
            wetterNachholung.anfordern(tenant, siteId, gueltigAb);
        }

        SiteDto neuesSite = sites.findById(siteId);
        StandortAmStichtag neuerStandortFrisch = lesemodell.standort(neuerStandort.id(), null).orElse(neuerStandort);
        return new AnlageOrtDto.UmzugErgebnis(neuesSite, neuerStandortFrisch, umzug, boxZugestellt, wetterAngestossen);
    }

    /** §6.6: die anderen Anlagen des Standorts — Regel oben in der Klassen-Doku. */
    private void geschwisterMitziehen(StandortAmStichtag vorStandort, UUID siteId, Lage alteStandortLage,
            Lage neueLage, String neueGebotszone, UUID tenant) {
        if (alteStandortLage == null) {
            return;
        }
        boolean weitWeg = GeoAbstand.kilometer(alteStandortLage.breitengrad(), alteStandortLage.laengengrad(),
                neueLage.breitengrad(), neueLage.laengengrad()) > WEIT_WEG_KM;
        BigDecimal deltaBreite = neueLage.breitengrad().subtract(alteStandortLage.breitengrad());
        BigDecimal deltaLaenge = neueLage.laengengrad().subtract(alteStandortLage.laengengrad());
        for (ZugeordneteAnlage z : vorStandort.anlagen()) {
            if (z.id().equals(siteId)) {
                continue;
            }
            SiteDto s = sites.findById(z.id());
            if (s == null) {
                continue;
            }
            boolean aufAltemPunkt = s.latitude() != null && s.longitude() != null
                    && s.latitude().compareTo(alteStandortLage.breitengrad()) == 0
                    && s.longitude().compareTo(alteStandortLage.laengengrad()) == 0;
            if (weitWeg && s.latitude() != null && s.longitude() != null) {
                BigDecimal neuBreite = s.latitude().add(deltaBreite);
                BigDecimal neuLaenge = s.longitude().add(deltaLaenge);
                sites.lageUndGebotszoneSetzen(z.id(), neuBreite, neuLaenge, neueGebotszone);
                deployments.republishForSite(z.id());
                wetterNachholung.anfordern(tenant, z.id());
            } else if (aufAltemPunkt) {
                sites.lageUndGebotszoneSetzen(z.id(), neueLage.breitengrad(), neueLage.laengengrad(), neueGebotszone);
                deployments.republishForSite(z.id());
            } else {
                // Gezogener Pin bleibt unverändert — nur die Gebotszone folgt dem Land.
                sites.lageUndGebotszoneSetzen(z.id(), s.latitude(), s.longitude(), neueGebotszone);
            }
        }
    }

    private static boolean weitWeg(BigDecimal alteBreite, BigDecimal alteLaenge, Lage neueLage) {
        if (alteBreite == null || alteLaenge == null) {
            return false;
        }
        return GeoAbstand.kilometer(alteBreite, alteLaenge, neueLage.breitengrad(), neueLage.laengengrad())
                > WEIT_WEG_KM;
    }
}
