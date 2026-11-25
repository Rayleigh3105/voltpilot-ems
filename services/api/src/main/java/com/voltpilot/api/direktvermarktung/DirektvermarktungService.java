package com.voltpilot.api.direktvermarktung;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.voltpilot.api.repo.DirektvermarktungRepository;
import com.voltpilot.api.repo.DirektvermarktungRepository.Eintrag;
import com.voltpilot.api.repo.DirektvermarktungRepository.ProtokollZeile;
import com.voltpilot.api.repo.DirektvermarktungRepository.Stand;
import com.voltpilot.api.repo.SiteRepository;
import com.voltpilot.api.tenant.TenantContext;
import java.time.Clock;
import java.time.Instant;
import java.time.LocalDate;
import java.util.List;
import java.util.UUID;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.dao.DataIntegrityViolationException;
import org.springframework.stereotype.Service;
import org.springframework.transaction.support.TransactionTemplate;

/**
 * Der Anschluss einer Anlage an einen Direktvermarkter (Konzept vp-direktvermarktung-konzept d2 §5.7,
 * Entscheidungen E1-E6 = A). Der Dienst hält nur die CLOUD-seitige Buchführung (Partner, Zustimmung,
 * Start-/Enddatum, Zustand als grobe Lage); was die Box über Register und Lebenszeichen wirklich tut,
 * ist "Zustellung" und damit außerhalb dieses Auftrags - ohne sie bleibt jeder Anschluss bei
 * {@code wartet_auf_zugang} stehen, was ehrlich ist ("Unbekannt ist keine Null", §5.1).
 *
 * <p>Die feinere Lage, die der Kunde liest (z. B. "getrennt" vs. "luox fragt nicht ab"), leitet das
 * Portal aus Zustand, Stand und Zugang ab (Konzept §5.4 "Lagen des Anschlusses") - ein TS-Zwilling
 * dieser Herleitung, nicht eine zweite Quelle.
 */
@Service
public class DirektvermarktungService {

    private static final Logger log = LoggerFactory.getLogger(DirektvermarktungService.class);

    /** Wie viele Protokollzeilen eine Statusantwort mitträgt (die Seite lädt mehr über die Verlauf-Route). */
    private static final int VERLAUF_KURZ = 5;

    public static final String VERMARKTUNGSART_DIREKT = "direktvermarktung";
    public static final String VERMARKTUNGSART_EIGEN = "eigenverbrauch";

    private final DirektvermarktungRepository repo;
    private final PartnerKatalog katalog;
    private final SiteRepository sites;
    private final TransactionTemplate tx;
    private final ObjectMapper json;
    private final Clock clock;

    @Autowired
    public DirektvermarktungService(DirektvermarktungRepository repo, PartnerKatalog katalog, SiteRepository sites,
            TransactionTemplate tx, ObjectMapper json) {
        this(repo, katalog, sites, tx, json, Clock.systemUTC());
    }

    DirektvermarktungService(DirektvermarktungRepository repo, PartnerKatalog katalog, SiteRepository sites,
            TransactionTemplate tx, ObjectMapper json, Clock clock) {
        this.repo = repo;
        this.katalog = katalog;
        this.sites = sites;
        this.tx = tx;
        this.json = json;
        this.clock = clock;
    }

    /** Eine Ablehnung mit deutschem Satz und Grund-Code (409 bzw. 404 am Controller). */
    public static final class Abgelehnt extends RuntimeException {

        private final String grund;

        public Abgelehnt(String grund, String message) {
            super(message);
            this.grund = grund;
        }

        public String grund() {
            return grund;
        }
    }

    /** Die Antwort auf jede Schreibroute: der neue Stand - die Seite baut sich daraus jedes Mal neu auf. */
    public record Status(Eintrag aktuell, Eintrag geplant, PartnerProfil partner, PartnerProfil geplanterPartner,
            Stand stand, List<ProtokollZeile> verlaufKurz, List<PartnerProfil> katalog) {}

    // --- Lesen ------------------------------------------------------------------------------------------------

    public Status stand(UUID siteId) {
        requireSite(siteId);
        List<Eintrag> aktuelle = repo.aktuelle(siteId);
        // Während eines geplanten Wechsels (Abschnitt 6) trägt der NEUE Eintrag `folgt_auf` - er ist "geplant",
        // nicht "aktuell", bis sein Vorgänger tatsächlich endet. Ohne Wechsel ist der eine Eintrag "aktuell".
        Eintrag geplant = aktuelle.stream().filter(e -> e.folgtAuf() != null).findFirst().orElse(null);
        Eintrag aktuell = aktuelle.stream().filter(e -> e != geplant).findFirst()
                .orElse(aktuelle.isEmpty() ? null : aktuelle.get(0));
        return new Status(aktuell, geplant, aktuell == null ? null : katalog.finde(aktuell.partner()),
                geplant == null ? null : katalog.finde(geplant.partner()),
                aktuell == null ? null : repo.stand(siteId), repo.protokoll(siteId, VERLAUF_KURZ), katalog.alle());
    }

    public List<ProtokollZeile> verlauf(UUID siteId, int grenze) {
        requireSite(siteId);
        return repo.protokoll(siteId, grenze);
    }

    // --- Schreiben ----------------------------------------------------------------------------------------------

    /** Schritt 2 des Einrichtens: Partner wählen - legt den Entwurf an (Bildschirm 4 "Direktvermarkter wählen"). */
    public Status waehlen(UUID siteId, String partner, String von, String rolle) {
        requireSite(siteId);
        PartnerProfil profil = katalog.finde(partner);
        if (profil == null) {
            throw new Abgelehnt("partner_unbekannt", "Diesen Direktvermarkter kennen wir noch nicht.");
        }
        Eintrag vorhanden = repo.aktiverOhneEnde(siteId);
        if (vorhanden != null) {
            throw new Abgelehnt("schon_eingerichtet", "Diese Anlage hat schon einen Direktvermarkter; bitte "
                    + "erst beenden oder wechseln.");
        }
        Instant jetzt = clock.instant();
        Eintrag neu;
        try {
            neu = repo.anlegen(TenantContext.get(), siteId, partner, null, jetzt);
        } catch (DataIntegrityViolationException e) {
            throw new Abgelehnt("schon_eingerichtet", "Diese Anlage hat schon einen Direktvermarkter; bitte "
                    + "erst beenden oder wechseln.");
        }
        repo.protokolliere(TenantContext.get(), siteId, neu.id(), "gewaehlt", von, rolle,
                daten("partner", partner), jetzt);
        return stand(siteId);
    }

    /** Schritt 3: Zustimmen (Bildschirm 6) - mit Zeit, Person und Textfassung, append-only im Protokoll. */
    public Status zustimmen(UUID siteId, String textfassung, String von, String rolle) {
        requireSite(siteId);
        Eintrag e = repo.aktiverOhneEnde(siteId);
        if (e == null) {
            throw new Abgelehnt("nicht_gewaehlt", "Bitte zuerst einen Direktvermarkter wählen.");
        }
        if (!DirektvermarktungRepository.ENTWURF.equals(e.zustand())) {
            throw new Abgelehnt("schon_zugestimmt", "Der Zustimmung liegt schon vor.");
        }
        Instant jetzt = clock.instant();
        repo.zustimmen(e.id(), von, rolle, textfassung, jetzt);
        repo.protokolliere(TenantContext.get(), siteId, e.id(), "zugestimmt", von, rolle,
                daten("textfassung", textfassung), jetzt);
        return stand(siteId);
    }

    /**
     * Startdatum setzen (Bildschirm 14, "aus der Lieferbestätigung"): ab diesem Tag rechnen die Erlöse mit
     * Marktprämie (Konzept §5.7 "Erlöse"). Liegt der Tag schon heute oder früher, stellt derselbe Aufruf die
     * Vermarktungsart sofort um; sonst holt das der Nachtlauf nach ({@link #naechtlicheUebergaenge(LocalDate)}).
     */
    public Status startdatumSetzen(UUID siteId, LocalDate startdatum, String von, String rolle) {
        requireSite(siteId);
        Eintrag e = repo.aktiverOhneEnde(siteId);
        if (e == null) {
            throw new Abgelehnt("nicht_gewaehlt", "Bitte zuerst einen Direktvermarkter wählen.");
        }
        Instant jetzt = clock.instant();
        repo.startdatumSetzen(e.id(), startdatum, jetzt);
        repo.protokolliere(TenantContext.get(), siteId, e.id(), "startdatum_gesetzt", von, rolle,
                daten("startdatum", String.valueOf(startdatum)), jetzt);
        if (startdatum != null && !startdatum.isAfter(LocalDate.now(clock))) {
            repo.plantKindSetzen(siteId, VERMARKTUNGSART_DIREKT);
        }
        return stand(siteId);
    }

    /**
     * Beenden (Bildschirm 27): das Enddatum ist ein Vorschlag (Monatsende), frei änderbar. Liegt der Tag schon
     * heute oder früher, endet der Anschluss sofort und die Vermarktungsart fällt zurück auf Eigenverbrauch;
     * sonst trägt der Eintrag {@code endet}, bis der Nachtlauf den Tag erreicht.
     */
    public Status beenden(UUID siteId, LocalDate endeAm, String von, String rolle) {
        requireSite(siteId);
        Eintrag e = repo.aktiverOhneEnde(siteId);
        if (e == null) {
            throw new Abgelehnt("nicht_gewaehlt", "Diese Anlage hat keinen Direktvermarkter zum Beenden.");
        }
        if (endeAm == null) {
            throw new Abgelehnt("datum_fehlt", "Bitte ein Enddatum angeben.");
        }
        beendenInterner(e, endeAm, von, rolle);
        return stand(siteId);
    }

    /**
     * Wechsel (Bildschirm 28): der alte Anschluss endet zum Stichtag, der neue beginnt als Entwurf - nie zwei
     * gleichzeitig aktiv ohne Ende (Konzept Abschnitt 6 "Wechsel").
     */
    public Status wechseln(UUID siteId, String neuerPartner, LocalDate stichtag, String von, String rolle) {
        requireSite(siteId);
        Eintrag alt = repo.aktiverOhneEnde(siteId);
        if (alt == null) {
            throw new Abgelehnt("nicht_gewaehlt", "Diese Anlage hat keinen Direktvermarkter zum Wechseln.");
        }
        PartnerProfil profil = katalog.finde(neuerPartner);
        if (profil == null) {
            throw new Abgelehnt("partner_unbekannt", "Diesen Direktvermarkter kennen wir noch nicht.");
        }
        if (neuerPartner.equals(alt.partner())) {
            throw new Abgelehnt("gleicher_partner", "Das ist schon Ihr jetziger Direktvermarkter.");
        }
        if (stichtag == null) {
            throw new Abgelehnt("datum_fehlt", "Bitte einen Stichtag für den Wechsel angeben.");
        }
        UUID tenant = TenantContext.get();
        Instant jetzt = clock.instant();
        tx.executeWithoutResult(s -> {
            beendenInterner(alt, stichtag, von, rolle);
            Eintrag neu = repo.anlegen(tenant, siteId, neuerPartner, alt.id(), jetzt);
            repo.protokolliere(tenant, siteId, neu.id(), "wechsel_geplant", von, rolle,
                    daten("folgt_auf", alt.partner(), "ab", String.valueOf(stichtag)), jetzt);
        });
        return stand(siteId);
    }

    /**
     * "Jetzt neu verbinden" (Bildschirm 19/20): der formale Neuversuch auf Cloud-Seite. Ohne die Box-Zustellung
     * (außerhalb dieses Auftrags) bewegt das noch keinen echten Tunnel - der Schritt bleibt im Protokoll
     * nachvollziehbar und ist bereit, sobald die Box mitspielt.
     */
    public Status neuVerbinden(UUID siteId, String von, String rolle) {
        requireSite(siteId);
        Eintrag e = repo.aktiverOhneEnde(siteId);
        if (e == null) {
            throw new Abgelehnt("nicht_gewaehlt", "Diese Anlage hat keinen Direktvermarkter.");
        }
        if (DirektvermarktungRepository.ENTWURF.equals(e.zustand())
                || DirektvermarktungRepository.WARTET_AUF_ZUGANG.equals(e.zustand())) {
            throw new Abgelehnt("kein_zugang", "Diese Anlage hat noch keine Zugangsdatei - zuerst hochladen.");
        }
        Instant jetzt = clock.instant();
        repo.zustandSetzen(e.id(), DirektvermarktungRepository.VERBINDET, jetzt);
        repo.protokolliere(TenantContext.get(), siteId, e.id(), "zustand", von, rolle,
                daten("zustand", DirektvermarktungRepository.VERBINDET), jetzt);
        return stand(siteId);
    }

    // --- Nachtlauf ------------------------------------------------------------------------------------------------

    /**
     * Täglich, EINEN Mandanten weit - der aufrufende Läufer (Muster {@code AblaufLaeufer}) setzt
     * {@link TenantContext} je Mandant, bevor er das hier für jeden aufruft, damit RLS nur dessen Anlagen
     * liefert. Enddaten, die erreicht sind, schließen den Anschluss ab und stellen die Vermarktungsart
     * zurück; Startdaten, die erreicht sind, stellen sie auf Direktvermarktung um. Reiner Tagesvergleich,
     * keine Uhrzeit - ein Start- oder Enddatum gilt ab dem ganzen Tag.
     */
    public void naechtlicheUebergaenge(LocalDate heute) {
        Instant jetzt = clock.instant();
        UUID tenant = TenantContext.get();
        for (Eintrag e : repo.fälligZumBeenden(heute)) {
            repo.zustandSetzen(e.id(), DirektvermarktungRepository.BEENDET, jetzt);
            repo.plantKindSetzen(e.siteId(), VERMARKTUNGSART_EIGEN);
            repo.protokolliere(tenant, e.siteId(), e.id(), "beendet", null, "nachtlauf",
                    daten("ende", String.valueOf(e.ende())), jetzt);
            log.info("direktvermarktung: Anschluss {} der Anlage {} zum {} beendet", e.id(), e.siteId(), e.ende());
        }
        for (Eintrag e : repo.fälligZumStarten(heute)) {
            repo.plantKindSetzen(e.siteId(), VERMARKTUNGSART_DIREKT);
        }
    }

    // --- Intern ------------------------------------------------------------------------------------------------

    private void beendenInterner(Eintrag e, LocalDate endeAm, String von, String rolle) {
        LocalDate heute = LocalDate.now(clock);
        String zustand = !endeAm.isAfter(heute) ? DirektvermarktungRepository.BEENDET
                : DirektvermarktungRepository.ENDET;
        Instant jetzt = clock.instant();
        repo.beenden(e.id(), endeAm, zustand, jetzt);
        repo.protokolliere(TenantContext.get(), e.siteId(), e.id(), "beendet", von, rolle,
                daten("ende", String.valueOf(endeAm)), jetzt);
        if (DirektvermarktungRepository.BEENDET.equals(zustand)) {
            repo.plantKindSetzen(e.siteId(), VERMARKTUNGSART_EIGEN);
        }
    }

    private void requireSite(UUID siteId) {
        if (sites.findById(siteId) == null) {
            throw new Abgelehnt("anlage_unbekannt", "Diese Anlage gibt es nicht.");
        }
    }

    private String daten(String... kv) {
        ObjectNode n = json.createObjectNode();
        for (int i = 0; i + 1 < kv.length; i += 2) n.put(kv[i], kv[i + 1]);
        return n.toString();
    }
}
