package com.voltpilot.api.uems;

import com.voltpilot.api.flows.FlowActivationService;
import com.voltpilot.api.repo.SiteRepository;
import com.voltpilot.api.tenant.TenantContext;
import com.voltpilot.api.uems.StandortLesemodell.Lage;
import com.voltpilot.api.uems.StandortLesemodell.StandortAmStichtag;
import com.voltpilot.api.uems.StandortLesemodell.StandortBezug;
import com.voltpilot.api.uems.StandortLesemodell.ZugeordneteAnlage;
import com.voltpilot.api.web.dto.AnlageOrtDto;
import com.voltpilot.api.web.dto.SiteDto;
import com.voltpilot.api.web.dto.StandortDto;
import java.math.BigDecimal;
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

    public AnlageOrtService(SiteRepository sites, StandortLesemodellService lesemodell,
            StandortService standorte, FlowActivationService deployments,
            OrtWetterNachholungRepository wetterNachholung) {
        this.sites = sites;
        this.lesemodell = lesemodell;
        this.standorte = standorte;
        this.deployments = deployments;
        this.wetterNachholung = wetterNachholung;
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
