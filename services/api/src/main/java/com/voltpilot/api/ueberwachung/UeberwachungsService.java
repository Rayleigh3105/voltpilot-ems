package com.voltpilot.api.ueberwachung;

import com.fasterxml.jackson.databind.JsonNode;
import com.voltpilot.api.history.HistoryRange;
import com.voltpilot.api.repo.PeakShavingRepository;
import com.voltpilot.api.repo.PriceRepository;
import com.voltpilot.api.ueberwachung.UeberwachungRepository.AlarmZeile;
import com.voltpilot.api.ueberwachung.UeberwachungRepository.InstanzZeile;
import com.voltpilot.api.ueberwachung.UeberwachungRepository.UeberwachungZeile;
import com.voltpilot.api.uems.EnergiezielService;
import com.voltpilot.api.uems.KennzahlAbgelehnt;
import com.voltpilot.api.uems.KennzahlService;
import com.voltpilot.api.uems.MessstelleRepository;
import com.voltpilot.api.uems.RechteAbleitung.Rolle;
import com.voltpilot.api.uems.VerbesserungAbgelehnt;
import com.voltpilot.api.versand.BenachrichtigungAusgang;
import com.voltpilot.api.web.dto.EnergiezielDto;
import com.voltpilot.api.web.dto.KennzahlDto;
import com.voltpilot.api.web.dto.PriceRangeSummaryDto;
import com.voltpilot.api.zugriff.ZugriffRepository;
import java.math.BigDecimal;
import java.time.Instant;
import java.time.LocalDate;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Optional;
import java.util.Set;
import java.util.UUID;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.stereotype.Service;

/**
 * Der EINE Takt der Überwachung im Kundenbereich des {@link com.voltpilot.api.tenant.TenantContext}
 * (den der {@link UeberwachungsLaeufer} mitbringt, wie {@code AblaufLaeufer} es für die
 * Unterstützung tut): sät die Vorschläge ab Werk (Entscheid 2A), wertet jede aktive Regel aus und
 * schreibt Zustandsübergänge in {@code alarm}/{@code alarm_verlauf} (§6.5).
 *
 * <p>Scheibe 1 kannte nur den Bezug {@code anlage} und die Bedingungsart {@code zustand}; Scheibe 2
 * fügt den Bezug {@code komponente} (Familie {@code geraet.messwert}, §6.3 Nr. 1) und die
 * Bedingungsarten {@code ueber}/{@code unter}/{@code ausserhalb}/{@code keine_daten} additiv hinzu
 * ({@link BedingungsPruefung}). Scheibe 4 fügt die AUSWAHL hinzu (§6.4 "Gilt für": {@code alle}
 * = {@code anlage}/{@code box}, wahlweise auf einen {@code standort} eingeschränkt) - {@link #lauf}
 * löst sie JEDEN Takt frisch in ihre aktuellen Mitglieder auf ({@link #bezuegeAus}), damit ein neu
 * hinzugekommener Bezug sofort mit überwacht ist, und die Bedingungsarten {@code periode}/
 * {@code aenderung} für die periodischen Leserarten {@code menge}/{@code geld} - nie im
 * Minutentakt ({@link #PERIODISCH_MINDESTABSTAND}). <b>Quittierungspflicht (Entscheid 3B): keine.</b>
 * "Gesehen" ist eine freiwillige Aktion, die nur den Verlauf speist (siehe {@link #gesehen}) - sie
 * hält den Zustandsübergang nicht auf: ein Alarm wird erledigt, sobald sein Wert zurückkehrt,
 * unabhängig davon, ob jemand ihn gesehen hat.
 */
@Service
public class UeberwachungsService {

    private static final Logger log = LoggerFactory.getLogger(UeberwachungsService.class);

    public record Lauf(int gesaet, int ausgeloest, int erledigt) {}

    /** Periodische Leser (menge, geld) werden höchstens in diesem Abstand neu gelesen - NIE im
     * Minutentakt (§6.7: "wenn ihr Läufer neue Werte geschrieben hat, sonst einmal täglich"; diese
     * Scheibe wählt einen festen, einfachen Mindestabstand statt die Verdichter-Läufe zu beobachten). */
    static final java.time.Duration PERIODISCH_MINDESTABSTAND = java.time.Duration.ofMinutes(5);

    /** Bündelfenster (§6.4 Nr. 6, §9): Auslöser derselben Regel innerhalb dieser Zeit gehen in EINE
     * Nachricht - ein fester, UTC-ausgerichteter Tumbling-Bucket (keine echte Sliding-Window-Bündelung:
     * zwei Auslöser kurz vor/nach einer Bucket-Grenze bündeln nicht zusammen - bewusste Vereinfachung). */
    static final long BUENDELFENSTER_S = 30;

    /** Wertarten, deren aktiver Alarm abhängige Meldungen DERSELBEN Anlage unterdrückt (§6.4 Nr. 7). */
    private static final List<String> GATENDE_WERTARTEN = List.of("box.erreichbar", "datenquelle.liefert_daten");

    private final UeberwachungRepository repo;
    private final WerteKatalog katalog;
    private final ZustandWerteLeser zustandLeser;
    private final EreignisWerteLeser ereignisLeser;
    private final AnlagenflussWerteLeser anlagenflussLeser;
    private final MessreiheWerteLeser messreiheLeser;
    private final MengeWerteLeser mengeLeser;
    private final GeldWerteLeser geldLeser;
    private final KennzahlWerteLeser kennzahlLeser;
    private final ZaehlungWerteLeser zaehlungLeser;
    private final LadepunktWerteLeser ladepunktLeser;
    private final ZugriffRepository zugriffe;
    private final PriceRepository preise;
    private final PeakShavingRepository peakShaving;
    private final MessstelleRepository messstellen;
    private final KennzahlService kennzahlen;
    private final EnergiezielService energieziele;
    private BenachrichtigungAusgang ausgang = BenachrichtigungAusgang.STUMM;
    /** Die Adresse des Portals für die Links einer Mail (dieselbe wie im Bestätigungs-Link der Wege). */
    private String basisUrl = "http://localhost:5173";
    private static final com.fasterxml.jackson.databind.ObjectMapper JSON =
            new com.fasterxml.jackson.databind.ObjectMapper();
    /** Alerting Scheibe 6, Entscheid 11B: ohne Spring (reine Tests) bleibt es {@code null} - keine externen
     * Empfänger werden benachrichtigt. */
    private ExterneEmpfaengerService externeEmpfaenger;
    /** UEMS EZ-11: die Wertequelle „Erzeuger“; ohne Spring (reine Tests) {@code null} - ihre Vorlagen ruhen dann. */
    private ErzeugerWerteLeser erzeugerLeser;

    public UeberwachungsService(UeberwachungRepository repo, WerteKatalog katalog,
            ZustandWerteLeser zustandLeser, EreignisWerteLeser ereignisLeser,
            AnlagenflussWerteLeser anlagenflussLeser, MessreiheWerteLeser messreiheLeser,
            MengeWerteLeser mengeLeser, GeldWerteLeser geldLeser,
            KennzahlWerteLeser kennzahlLeser, ZaehlungWerteLeser zaehlungLeser,
            LadepunktWerteLeser ladepunktLeser,
            ZugriffRepository zugriffe, PriceRepository preise, PeakShavingRepository peakShaving,
            MessstelleRepository messstellen, KennzahlService kennzahlen, EnergiezielService energieziele) {
        this.repo = repo;
        this.katalog = katalog;
        this.zustandLeser = zustandLeser;
        this.ereignisLeser = ereignisLeser;
        this.anlagenflussLeser = anlagenflussLeser;
        this.messreiheLeser = messreiheLeser;
        this.mengeLeser = mengeLeser;
        this.geldLeser = geldLeser;
        this.kennzahlLeser = kennzahlLeser;
        this.zaehlungLeser = zaehlungLeser;
        this.ladepunktLeser = ladepunktLeser;
        this.zugriffe = zugriffe;
        this.preise = preise;
        this.peakShaving = peakShaving;
        this.messstellen = messstellen;
        this.kennzahlen = kennzahlen;
        this.energieziele = energieziele;
    }

    /** Die EINE Stelle, die {@code leser.art} auf ihre Implementierung abbildet (§6.3 Nr. 3). */
    private WerteLeser leserFuer(String art) {
        return switch (art) {
            case "zustand" -> zustandLeser;
            case "ereignis" -> ereignisLeser;
            case "anlagenfluss" -> anlagenflussLeser;
            case "messreihe" -> messreiheLeser;
            case "menge" -> mengeLeser;
            case "geld" -> geldLeser;
            case "kennzahl" -> kennzahlLeser;
            case "zaehlung" -> zaehlungLeser;
            case "erzeuger" -> erzeugerLeser;
            case "ladepunkt" -> ladepunktLeser;
            default -> null;
        };
    }

    /** Ob eine Leserart periodisch ist (§6.7: nie im Minutentakt) - entscheidet die Drossel in {@link #werte}.
     * Scheibe 5: {@code kennzahl} (eigene, seltener aktualisierte Läufe) und {@code zaehlung} (Messstellen-Werte,
     * nur monatlich) sind ebenso periodisch. */
    private static boolean periodisch(String leserArt) {
        return "menge".equals(leserArt) || "geld".equals(leserArt) || "kennzahl".equals(leserArt)
                || "zaehlung".equals(leserArt);
    }

    /** Nachgereicht wie {@code VersandRepository}: Scheibe-0-Ausgang, in Tests austauschbar. */
    @Autowired(required = false)
    public void setAusgang(BenachrichtigungAusgang ausgang) {
        this.ausgang = ausgang == null ? BenachrichtigungAusgang.STUMM : ausgang;
    }

    @Autowired(required = false)
    void setBasisUrl(@org.springframework.beans.factory.annotation.Value(
            "${voltpilot.versand.bestaetigung-basis-url:http://localhost:5173}") String basisUrl) {
        this.basisUrl = basisUrl;
    }

    @Autowired(required = false)
    public void setExterneEmpfaenger(ExterneEmpfaengerService externeEmpfaenger) {
        this.externeEmpfaenger = externeEmpfaenger;
    }

    @Autowired(required = false)
    public void setErzeugerLeser(ErzeugerWerteLeser erzeugerLeser) {
        this.erzeugerLeser = erzeugerLeser;
    }

    public Lauf lauf(Instant jetzt) {
        int gesaet = aussaat();
        int ausgeloest = 0;
        int erledigt = 0;
        for (UeberwachungZeile regel : repo.aktive()) {
            WerteKatalog.Eintrag eintrag = katalog.eintrag(regel.wertart());
            WerteLeser leser = eintrag == null ? null : leserFuer(eintrag.leser().art());
            if (leser == null) {
                continue; // unbekannte/entfernte Wertart oder Leserart
            }
            boolean auswahl = regel.bezug().has("alle");
            List<WerteLeser.Bezug> bezuege = bezuegeAus(regel.bezug());
            if (leser == erzeugerLeser && erzeugerLeser.jeEinheit(eintrag)) {
                // EZ-11: je Einheit eine eigene Meldung - wie eine Auswahl gebündelt, damit drei Wechselrichter,
                // die zugleich ausfallen, in EINER Nachricht ankommen.
                bezuege = bezuege.stream().flatMap(b -> erzeugerLeser.einheiten(b.id()).stream()).toList();
                auswahl = true;
            }
            for (WerteLeser.Bezug bezug : bezuege) {
                UUID anlageId = anlageFuerBezug(bezug);
                if (anlageId == null && brauchtAnlage(bezug.art())) {
                    continue; // Bezug zeigt auf nichts (mehr) Sichtbares - Instanz bleibt unverändert liegen
                }
                Ergebnis e = werte(regel, eintrag, leser, bezug, anlageId, auswahl, jetzt);
                ausgeloest += e.ausgeloest ? 1 : 0;
                erledigt += e.erledigt ? 1 : 0;
            }
        }
        if (gesaet + ausgeloest + erledigt > 0) {
            log.info("Überwachung: {} gesät, {} ausgelöst, {} erledigt", gesaet, ausgeloest, erledigt);
        }
        return new Lauf(gesaet, ausgeloest, erledigt);
    }

    /**
     * Die Bezüge EINER Regel als {@link WerteLeser.Bezug} (§6.3 Wertverweis-Syntax): {@code anlage}
     * (Scheibe 1), {@code komponente} mit Messkanal (Scheibe 2, Familie {@code geraet.messwert})
     * oder eine AUSWAHL (Scheibe 4, §6.4 "Gilt für": {@code alle = "anlage"} oder {@code "box"},
     * wahlweise auf einen {@code standort} eingeschränkt) - "eine Auswahl ergibt je Bezug eine
     * eigene Instanz mit eigener Meldung", die Mitgliederliste wird JEDEN Lauf frisch gelesen, damit
     * ein neu hinzugekommener Bezug sofort mit überwacht ist.
     */
    private List<WerteLeser.Bezug> bezuegeAus(JsonNode bezug) {
        JsonNode anlage = bezug.path("anlage");
        if (anlage.isTextual()) {
            UUID id = alsUuid(anlage.asText());
            return id == null ? List.of() : List.of(WerteLeser.Bezug.anlage(id));
        }
        JsonNode komponente = bezug.path("komponente");
        if (komponente.isTextual()) {
            UUID id = alsUuid(komponente.asText());
            return id == null ? List.of() : List.of(WerteLeser.Bezug.komponente(id, bezug.path("kanal").asText(null)));
        }
        JsonNode messstelle = bezug.path("messstelle");
        if (messstelle.isTextual()) {
            UUID id = alsUuid(messstelle.asText());
            return id == null ? List.of() : List.of(WerteLeser.Bezug.messstelle(id));
        }
        JsonNode kennzahl = bezug.path("kennzahl");
        if (kennzahl.isTextual()) {
            UUID id = alsUuid(kennzahl.asText());
            return id == null ? List.of() : List.of(WerteLeser.Bezug.kennzahl(id));
        }
        JsonNode energieziel = bezug.path("energieziel");
        if (energieziel.isTextual()) {
            UUID id = alsUuid(energieziel.asText());
            return id == null ? List.of() : List.of(WerteLeser.Bezug.energieziel(id));
        }
        JsonNode alle = bezug.path("alle");
        if (alle.isTextual()) {
            return auswahlAnlagen(bezug, alle.asText()).stream().map(WerteLeser.Bezug::anlage).toList();
        }
        return List.of();
    }

    private List<UUID> auswahlAnlagen(JsonNode bezug, String alle) {
        JsonNode standort = bezug.path("standort");
        UUID standortId = standort.isTextual() ? alsUuid(standort.asText()) : null;
        return switch (alle) {
            case "anlage" -> standortId != null ? repo.anlagenDesStandorts(standortId) : repo.alleAnlagen();
            case "box" -> standortId != null ? repo.anlagenDesStandortsMitBox(standortId)
                    : repo.anlagenMitAngenommenerBox();
            default -> List.of();
        };
    }

    private static UUID alsUuid(String text) {
        try {
            return UUID.fromString(text);
        } catch (IllegalArgumentException e) {
            return null;
        }
    }

    /** Die Anlage, an der ein Bezug tatsächlich hängt - für Standort, Name und die Lesung selbst.
     * Scheibe 5: Messstelle/Kennzahl/Energieziel hängen an keiner Anlage - {@code null} ist hier
     * normal, kein fehlender Bezug (siehe {@link #brauchtAnlage}). */
    private UUID anlageFuerBezug(WerteLeser.Bezug bezug) {
        return switch (bezug.art()) {
            case "anlage" -> bezug.id();
            case "komponente" -> repo.anlageDerKomponente(bezug.id());
            case "einheit" -> erzeugerLeser == null ? null : erzeugerLeser.anlageDerSteuerung(bezug.id());
            default -> null;
        };
    }

    /** Ob ein Bezug OHNE Anlage ein fehlendes Ziel ist (dann überspringt {@link #lauf} ihn) oder normal
     * (Scheibe 5: Messstelle, Kennzahl, Energieziel haben nie eine Anlage). */
    private static boolean brauchtAnlage(String bezugArt) {
        return "anlage".equals(bezugArt) || "komponente".equals(bezugArt) || "einheit".equals(bezugArt);
    }

    // --------------------------------------------------------------------- Aussaat (§7 Nr. 7, Entscheid 2A)

    private static final String WERTART_PREIS_JETZT = "anlage.preis.jetzt";

    /** 5 % über der Schwelle (Hausregel §9: Rückkehr mindestens die Auflösung, hier ein fester Aufschlag). */
    private static final double PREIS_RUECKKEHR_AUFSCHLAG = 1.05;

    private int aussaat() {
        int n = 0;
        for (WerteKatalog.Eintrag eintrag : katalog.mitVorschlagAbWerk()) {
            List<UUID> anlagen = switch (eintrag.leser().feld()) {
                case "box_erreichbar" -> repo.anlagenMitAngenommenerBox();
                case "datenquelle_status" -> repo.anlagenMitDatenquelle();
                case "wallbox_meldet_sich_nicht", "ziel_wird_knapp" -> repo.anlagenMitLadepunkt();
                default -> List.of();
            };
            for (UUID anlageId : anlagen) {
                repo.seedAbWerk(anlageId, repo.standortHeute(anlageId), eintrag);
                n++;
            }
        }
        n += aussaatPreisHinweisPrivatkunde();
        n += aussaatLastspitzeDrohtGewerbe();
        return n;
    }

    private static final String WERTART_LASTSPITZE_LAUFEND = "anlage.netz.lastspitze_laufend";

    /** Die Schwelle ist 95 % der Grenze (§6.10 Punkt 3); die Rückkehrschwelle ist dieselbe
     * §9-Vorgabe (5 % unter der Schwelle) wie jede andere freie Schwelle - KEIN Sonderfall. */
    private static final double LASTSPITZE_SCHWELLE_ANTEIL = 0.95;
    private static final double LASTSPITZE_RUECKKEHR_ANTEIL = 0.95;

    /**
     * "Lastspitze droht" ab Werk EINGESCHALTET (Entscheid 2A, Dringend - der EINZIGE
     * Dringend-Vorschlag ab Werk, §6.10 Punkt 3), nur wo ein Leistungspreis gilt
     * ({@code site.leistungspreis_eur_kw IS NOT NULL}). "Die Grenze" ist die bisher höchste
     * gemessene Spitze der laufenden Abrechnungsperiode ({@link PeakShavingRepository}) - das
     * Datenmodell kennt keine separate "vereinbarte Leistung" (§6.10 Punkt 3 nennt beides als
     * Alternativen); ohne eine einzige gemessene Spitze gibt es noch keine Schwelle (§6.1 Nr. 9
     * "Vorgaben, die meistens passen" - keine erfundene Zahl ohne eigene Daten).
     */
    private int aussaatLastspitzeDrohtGewerbe() {
        WerteKatalog.Eintrag eintrag = katalog.eintrag(WERTART_LASTSPITZE_LAUFEND);
        if (eintrag == null) {
            return 0;
        }
        Instant jetzt = Instant.now();
        LocalDate heute = jetzt.atZone(HistoryRange.ZONE).toLocalDate();
        int n = 0;
        for (UUID anlageId : repo.anlagenMitLeistungspreis()) {
            BigDecimal grenze = peakShaving.laufendePeriodenSpitzeKw(anlageId, heute);
            if (grenze == null || grenze.doubleValue() <= 0) {
                continue;
            }
            double schwelle = grenze.doubleValue() * LASTSPITZE_SCHWELLE_ANTEIL;
            double rueckkehr = schwelle * LASTSPITZE_RUECKKEHR_ANTEIL;
            repo.seedAbWerkLastspitze(anlageId, repo.standortHeute(anlageId), eintrag, schwelle, rueckkehr);
            n++;
        }
        return n;
    }

    /**
     * Preis-Hinweis ab Werk EINGESCHALTET für Privatkunden (Entscheid 15C, Abweichung von
     * Empfehlung A, §6.10 Punkt 4): die Schwelle ist der eigene Durchschnittspreis der letzten
     * 30 Tage (§6.1 Nr. 9 "Vorgaben, die meistens passen") - kein Preis-Hinweis ohne eigene
     * Preisreihe (unbekannte/keine Gebotszone, zu junge Anlage).
     */
    private int aussaatPreisHinweisPrivatkunde() {
        WerteKatalog.Eintrag eintrag = katalog.eintrag(WERTART_PREIS_JETZT);
        if (eintrag == null || !repo.istEndkunde()) {
            return 0;
        }
        int n = 0;
        for (UUID anlageId : repo.alleAnlagen()) {
            String zone = repo.biddingZone(anlageId);
            if (zone == null) {
                continue;
            }
            Instant jetzt = Instant.now();
            PriceRangeSummaryDto stat = preise.summarize(zone, jetzt.minus(java.time.Duration.ofDays(30)), jetzt);
            if (stat.count() == 0 || stat.avgEurMwh() == null) {
                continue;
            }
            double schwelle = stat.avgEurMwh().doubleValue() / 10.0; // ct/kWh, dieselbe Umrechnung wie der Leser
            repo.seedAbWerkPreis(anlageId, repo.standortHeute(anlageId), eintrag, schwelle,
                    schwelle * PREIS_RUECKKEHR_AUFSCHLAG);
            n++;
        }
        return n;
    }

    // --------------------------------------------------------------------- Auswertung (§6.5)

    private record Ergebnis(boolean ausgeloest, boolean erledigt) {
        static final Ergebnis NICHTS = new Ergebnis(false, false);
    }

    /**
     * Wertet eine Regel an ihrem Bezug aus. {@link BedingungsPruefung#pruefen} liefert zwei
     * Stufen (§6.4 Nr. 2-4, §9): {@code ausgeloest} - die STRENGE Schwelle - entscheidet
     * {@code normal → ausstehend} und ob die Dauer weiterläuft; {@code nochAktiv} - die LOCKERE
     * Rückkehrschwelle (Hysterese) - entscheidet, ob eine schon ausgelöste Regel {@code aktiv}
     * bleibt bzw. während der Erholdauer zurückfällt. Ohne eigene Rückkehrschwelle (Bedingungsart
     * {@code zustand}, {@code keine_daten}) sind beide Stufen identisch - unverändertes Verhalten
     * gegenüber Scheibe 1.
     */
    private Ergebnis werte(UeberwachungZeile regel, WerteKatalog.Eintrag eintrag, WerteLeser leser,
            WerteLeser.Bezug bezug, UUID anlageId, boolean auswahl, Instant jetzt) {
        InstanzZeile instanz = repo.instanz(regel.id(), bezug.kennung());
        String leserArt = eintrag.leser().art();
        if (periodisch(leserArt) && instanz.ausgewertetAm() != null
                && jetzt.isBefore(instanz.ausgewertetAm().plus(PERIODISCH_MINDESTABSTAND))) {
            return Ergebnis.NICHTS; // §6.7: menge/geld NIE im Minutentakt lesen
        }
        JsonNode bedingung = regel.bedingung();
        String bedingungsart = bedingung.path("art").asText("");
        WerteLeser.Lesung lesung;
        BedingungsPruefung.Erfuellung erfuellung;
        if ("aenderung".equals(bedingungsart)) {
            String periode = bedingung.path("periode").asText("tag");
            lesung = leser.lesePeriode(eintrag, bezug, periode, false, jetzt);
            WerteLeser.Lesung vorperiode = leser.leseVorperiode(eintrag, bezug, periode, jetzt);
            erfuellung = BedingungsPruefung.aenderung(bedingung, lesung, vorperiode);
        } else if ("periode".equals(bedingungsart)) {
            String periode = bedingung.path("periode").asText("tag");
            boolean nurEndgueltig = bedingung.path("endgueltig").asBoolean(false);
            lesung = leser.lesePeriode(eintrag, bezug, periode, nurEndgueltig, jetzt);
            erfuellung = BedingungsPruefung.pruefen(bedingung, lesung);
        } else if (leser == erzeugerLeser) {
            lesung = erzeugerLeser.lese(eintrag, bezug, bedingung, jetzt);
            erfuellung = BedingungsPruefung.pruefen(bedingung, lesung);
            if (!lesung.bekannt()) {
                // EZ-11: veraltete Werte der Steuerung sagen nicht, dass die Anlage wieder bereit ist oder folgt -
                // ein ausgelöster Erzeuger-Alarm HÄLT, bis ein aktueller Wert zurückkommt (das Veralten selbst
                // meldet die Vorlage „Daten veraltet“); auslösen kann Unbekannt weiterhin nie.
                erfuellung = new BedingungsPruefung.Erfuellung(false, true);
            }
        } else {
            lesung = leser.lese(eintrag, bezug, jetzt);
            erfuellung = BedingungsPruefung.pruefen(bedingung, lesung);
        }
        long dauerS = bedingung.path("dauer_s").asLong(0);
        long erholenS = bedingung.path("erholen_s").asLong(300);

        String letzterWertJson = wertJson(lesung);

        switch (instanz.zustand()) {
            case "normal" -> {
                if (erfuellung.ausgeloest()) {
                    repo.instanzSpeichern(regel.id(), bezug.kennung(), "ausstehend", jetzt, letzterWertJson,
                            lesung.messzeit(), null, jetzt);
                } else if (periodisch(leserArt)) {
                    // Drossel-Zeitstempel fortschreiben (§6.7): sonst bliebe ausgewertet_am stehen und
                    // die Drossel am Anfang dieser Methode würde nach dem ERSTEN Mindestabstand
                    // wirkungslos (immer "längst überfällig").
                    repo.instanzSpeichern(regel.id(), bezug.kennung(), "normal", null, letzterWertJson,
                            lesung.messzeit(), null, jetzt);
                }
                return Ergebnis.NICHTS;
            }
            case "ausstehend" -> {
                if (!erfuellung.ausgeloest()) {
                    repo.instanzSpeichern(regel.id(), bezug.kennung(), "normal", null, letzterWertJson,
                            lesung.messzeit(), null, jetzt);
                    return Ergebnis.NICHTS;
                }
                if (jetzt.getEpochSecond() - instanz.seit().getEpochSecond() >= dauerS) {
                    UUID alarmId = ausloesen(regel, bezug, anlageId, auswahl, jetzt, lesung);
                    repo.instanzSpeichern(regel.id(), bezug.kennung(), "aktiv", jetzt, letzterWertJson,
                            lesung.messzeit(), alarmId, jetzt);
                    return new Ergebnis(true, false);
                }
                return Ergebnis.NICHTS; // Dauer läuft noch
            }
            case "aktiv" -> {
                if (erfuellung.nochAktiv()) {
                    return Ergebnis.NICHTS; // unverändert aktiv (noch über der Rückkehrschwelle)
                }
                repo.instanzSpeichern(regel.id(), bezug.kennung(), "erholend", jetzt, letzterWertJson,
                        lesung.messzeit(), instanz.offenerAlarm(), jetzt);
                return Ergebnis.NICHTS;
            }
            case "erholend" -> {
                if (erfuellung.nochAktiv()) {
                    // Rückfall in der Erholdauer: dieselbe Meldung, keine neue Nachricht (§6.4 Nr. 4).
                    repo.instanzSpeichern(regel.id(), bezug.kennung(), "aktiv", instanz.seit(), letzterWertJson,
                            lesung.messzeit(), instanz.offenerAlarm(), jetzt);
                    return Ergebnis.NICHTS;
                }
                if (jetzt.getEpochSecond() - instanz.seit().getEpochSecond() >= erholenS) {
                    wiederNormal(regel, instanz.offenerAlarm(), bezug, anlageId, auswahl, jetzt, lesung);
                    repo.instanzSpeichern(regel.id(), bezug.kennung(), "normal", null, letzterWertJson,
                            lesung.messzeit(), null, jetzt);
                    return new Ergebnis(false, true);
                }
                return Ergebnis.NICHTS; // Erholdauer läuft noch
            }
            default -> {
                return Ergebnis.NICHTS;
            }
        }
    }

    /** {@code {"zustand":"..."}} (Scheibe 1) oder {@code {"wert":<Zahl>,"einheit":"..."}} (Scheibe 2). */
    private static String wertJson(WerteLeser.Lesung lesung) {
        if (!lesung.bekannt()) {
            return null;
        }
        if (lesung.zustandswort() != null) {
            return "{\"zustand\":\"" + lesung.zustandswort() + "\"}";
        }
        String einheit = lesung.einheit() == null ? "null" : "\"" + lesung.einheit() + "\"";
        return "{\"wert\":" + lesung.zahlenwert() + ",\"einheit\":" + einheit + "}";
    }

    // --------------------------------------------------------------------- Ausgelöst / wieder normal (§6.8)

    private UUID ausloesen(UeberwachungZeile regel, WerteLeser.Bezug bezug, UUID anlageId, boolean auswahl,
            Instant jetzt, WerteLeser.Lesung lesung) {
        String wertJson = wertJson(lesung);
        boolean probelauf = regel.imProbelauf(jetzt);
        // Abhängige Meldungen schweigen (§6.4 Nr. 7): meldet sich die Box/Datenquelle dieser Anlage
        // nicht, geht diese Meldung nicht einzeln hinaus, sondern steht unter deren Alarm - außer sie
        // IST selbst die gatende Meldung (keine Selbst-Unterdrückung). Ohne Anlage (Scheibe 5: Messstelle,
        // Kennzahl, Energieziel) gibt es diese Abhängigkeit nicht.
        UUID unterdrueckDurch = anlageId == null || GATENDE_WERTARTEN.contains(regel.wertart()) ? null
                : repo.aktiverAlarmAufAnlage(anlageId, GATENDE_WERTARTEN).orElse(null);
        UUID alarmId = repo.alarmErzeugen(regel, bezug.kennung(), regel.standortId() != null
                ? regel.standortId() : repo.standortHeute(anlageId), jetzt, alarmWertJson(lesung), probelauf,
                unterdrueckDurch);
        // Kunden-Alarmierung P1: EIN Text für Mail, Push und Portal (MeldungsText, Vorlagen im Katalog).
        MeldungsText.Eingabe eingabe = new MeldungsText.Eingabe(regel.wertart(), regel.herkunft(), regel.name(),
                regel.schwere(), bezug.art(), ortName(bezug, anlageId), regel.bedingung(), textWert(lesung),
                MeldungsText.beginn(jetzt, regel.bedingung()), null);
        MeldungsText.Nachricht nachricht = katalog.meldungsText().ausgeloest(eingabe, jetzt);
        repo.alarmVerlauf(alarmId, "ausgeloest", null, nachricht.titel()
                + (probelauf ? " (Probelauf - hätte gemeldet)" : ""), wertJson);
        if (unterdrueckDurch != null) {
            String kennzeichenEltern = repo.alarm(unterdrueckDurch).map(AlarmZeile::kennzeichen).orElse("?");
            repo.alarmVerlauf(alarmId, "versand", null,
                    "unterdrückt (abhängig von " + kennzeichenEltern + ")", null);
            return alarmId;
        }
        // Probelauf (§6.4, §6.8 Entwurf 1): ausgewertet und im Verlauf nachweisbar, aber OHNE
        // Versand - "was sie gemeldet hätte", nicht was sie wirklich gemeldet hat.
        if (!probelauf && !"hinweis".equals(regel.schwere())) {
            String kennzeichen = repo.alarm(alarmId).map(AlarmZeile::kennzeichen).orElse("?");
            versenden(regel, alarmId, "ausgeloest", nachricht, kennzeichen, auswahl, jetzt);
        }
        repo.alarmVerlauf(alarmId, "versand", null, probelauf ? "Probelauf - kein Versand" : "Versand eingereiht",
                null);
        return alarmId;
    }

    private void wiederNormal(UeberwachungZeile regel, UUID alarmId, WerteLeser.Bezug bezug, UUID anlageId,
            boolean auswahl, Instant jetzt, WerteLeser.Lesung lesung) {
        if (alarmId == null) {
            return;
        }
        // 3B: keine Quittierungspflicht - jeder Alarm wird erledigt, sobald sein Wert zurückkehrt.
        repo.alarmWiederNormal(alarmId, jetzt, true);
        repo.alarmVerlauf(alarmId, "wieder_normal", null, "wieder normal", null);
        repo.alarmVerlauf(alarmId, "erledigt", null, "erledigt (Wert zurück)", null);
        // Derselbe Alarm, dieselbe Probelauf-/Unterdrückungs-Marke wie beim Auslösen (§6.4, §6.8
        // Entwurf 1) - nicht regel.imProbelauf(jetzt) neu befragen: die Regel könnte in der
        // Zwischenzeit scharf geschaltet worden sein, ihr erster Alarm bleibt trotzdem ohne Versand.
        Optional<AlarmZeile> zeile = repo.alarm(alarmId);
        boolean probelauf = zeile.map(AlarmZeile::probelauf).orElse(false);
        boolean unterdrueckt = zeile.map(AlarmZeile::unterdrueckDurch).isPresent();
        if (!probelauf && !unterdrueckt && !"hinweis".equals(regel.schwere()) && zeile.isPresent()) {
            AlarmZeile alarm = zeile.get();
            MeldungsText.Eingabe eingabe = new MeldungsText.Eingabe(regel.wertart(), regel.herkunft(), regel.name(),
                    regel.schwere(), bezug.art(), ortName(bezug, anlageId), regel.bedingung(),
                    textWert(repo.textAngaben(List.of(alarmId)).get(alarmId)),
                    MeldungsText.beginn(alarm.ausgeloestAm(), regel.bedingung()),
                    MeldungsText.ende(jetzt, regel.bedingung()));
            MeldungsText.Nachricht nachricht = katalog.meldungsText().entwarnung(eingabe, jetzt);
            versenden(regel, alarmId, "wieder_normal", nachricht, alarm.kennzeichen(), auswahl, jetzt);
        }
    }

    // --------------------------------------------------------------------- Text einer Meldung (P1)

    /**
     * Der Name, mit dem eine Meldung ihren Ort nennt (Kunden-Alarmierung P1): die Anlage (auch für Komponente und
     * Einheit), sonst Messstelle, Kennzahl oder Energieziel - {@code null}, wenn keiner da ist (der Text sagt dann
     * „Ihre Anlage“), nie eine Kennung.
     */
    private String ortName(WerteLeser.Bezug bezug, UUID anlageId) {
        return switch (bezug.art()) {
            case "messstelle" -> messstellen.finde(bezug.id()).map(MessstelleRepository.Messstelle::name).orElse(null);
            case "kennzahl" -> kennzahlName(bezug.id());
            case "energieziel" -> energiezielName(bezug.id());
            default -> anlageId == null ? null : repo.anlageName(anlageId);
        };
    }

    private String kennzahlName(UUID id) {
        try {
            KennzahlDto.Kennzahl k = kennzahlen.eine(id);
            return k.name() != null ? k.name() : k.kennzeichen();
        } catch (KennzahlAbgelehnt e) {
            return null;
        }
    }

    private String energiezielName(UUID id) {
        try {
            EnergiezielDto.Energieziel z = energieziele.eines(id);
            return z.wortlaut() != null ? z.wortlaut() : z.kennzeichen();
        } catch (VerbesserungAbgelehnt e) {
            return null;
        }
    }

    private static MeldungsText.Wert textWert(WerteLeser.Lesung lesung) {
        if (!lesung.bekannt()) {
            return MeldungsText.Wert.UNBEKANNT;
        }
        return new MeldungsText.Wert(lesung.zustandswort() == null ? lesung.zahlenwert() : null, lesung.einheit(),
                lesung.zustandswort(), lesung.text());
    }

    /** Der Wert beim Auslösen aus {@code alarm.wert_beim_ausloesen} - dieselbe Form, die das Portal bekommt. */
    static MeldungsText.Wert textWert(UeberwachungRepository.TextAngaben angaben) {
        JsonNode w = angaben == null ? null : angaben.wert();
        if (w == null || w.isNull() || w.isMissingNode()) {
            return MeldungsText.Wert.UNBEKANNT;
        }
        return new MeldungsText.Wert(w.hasNonNull("wert") ? w.path("wert").asDouble() : null,
                w.hasNonNull("einheit") ? w.path("einheit").asText() : null,
                w.hasNonNull("zustand") ? w.path("zustand").asText() : null,
                w.hasNonNull("satz") ? w.path("satz").asText() : null);
    }

    /**
     * Die Text-Eingabe einer gespeicherten Meldung (Portal, Erinnerung, Tages-Zusammenfassung): derselbe Text wie
     * beim Versand, aus Alarm, Regel und dem Wert beim Auslösen; die Entwarnung nur, wenn der Wert zurückkam.
     */
    public MeldungsText.Eingabe textEingabe(AlarmZeile alarm, UeberwachungRepository.TextAngaben angaben) {
        return textEingabe(alarm, angaben, bezug -> ortName(bezug, anlageFuerBezug(bezug)));
    }

    /**
     * Ohne Spring-Kontext (Tests, die Erinnerung oder Zusammenfassung von Hand bauen): derselbe Text, der Ort nur
     * für einen Anlagen-Bezug aufgelöst.
     */
    static MeldungsText.Eingabe textEingabeNurRepo(UeberwachungRepository repo, AlarmZeile alarm) {
        return textEingabe(alarm, repo.textAngaben(List.of(alarm.id())).get(alarm.id()),
                bezug -> "anlage".equals(bezug.art()) ? repo.anlageName(bezug.id()) : null);
    }

    private static MeldungsText.Eingabe textEingabe(AlarmZeile alarm, UeberwachungRepository.TextAngaben angaben,
            java.util.function.Function<WerteLeser.Bezug, String> ort) {
        WerteLeser.Bezug bezug = bezugAusKennung(alarm.bezugKennung());
        JsonNode bedingung = angaben == null ? null : angaben.bedingung();
        Instant ende = alarm.wiederNormalAm() == null ? null : MeldungsText.ende(alarm.wiederNormalAm(), bedingung);
        return new MeldungsText.Eingabe(alarm.wertart(), angaben == null ? null : angaben.herkunft(),
                angaben == null ? null : angaben.regelName(), alarm.schwere(), bezug == null ? null : bezug.art(),
                bezug == null ? null : ort.apply(bezug), bedingung, textWert(angaben),
                MeldungsText.beginn(alarm.ausgeloestAm(), bedingung), ende);
    }

    /** Wie {@link #textEingabe(AlarmZeile, UeberwachungRepository.TextAngaben)}, die Angaben selbst gelesen. */
    public MeldungsText.Eingabe textEingabe(AlarmZeile alarm) {
        return textEingabe(alarm, repo.textAngaben(List.of(alarm.id())).get(alarm.id()));
    }

    /** {@code art:<uuid>} mit optionalem {@code ;te=<n>}/{@code ;kanal=<k>} zurück in einen Bezug ({@link WerteLeser.Bezug#kennung}). */
    static WerteLeser.Bezug bezugAusKennung(String kennung) {
        if (kennung == null) {
            return null;
        }
        String[] artRest = kennung.split(":", 2);
        if (artRest.length != 2) {
            return null;
        }
        String[] idParam = artRest[1].split(";", 2);
        UUID id = alsUuid(idParam[0]);
        if (id == null) {
            return null;
        }
        String parameter = idParam.length == 2 && idParam[1].contains("=") ? idParam[1].split("=", 2)[1] : null;
        return new WerteLeser.Bezug(artRest[0], id, parameter);
    }

    /** Kunden-Alarmierung P1: der Wert beim Auslösen MIT dem Satz des Lesers - Mail und Portal lesen denselben. */
    private static String alarmWertJson(WerteLeser.Lesung lesung) {
        if (!lesung.bekannt()) {
            return null;
        }
        com.fasterxml.jackson.databind.node.ObjectNode n = JSON.createObjectNode();
        if (lesung.zustandswort() != null) {
            n.put("zustand", lesung.zustandswort());
        } else {
            n.put("wert", lesung.zahlenwert());
            n.put("einheit", lesung.einheit());
        }
        if (lesung.text() != null) {
            n.put("satz", lesung.text());
        }
        return n.toString();
    }

    // --------------------------------------------------------------------- Empfänger auflösen (§6.6)

    /**
     * Reiht EINE E-Mail je aufgelöstem Empfänger in den zentralen Ausgang ein (Scheibe 0,
     * {@link BenachrichtigungAusgang}). Rollen werden HIER aufgelöst (nicht erst beim Versand,
     * anders als die Idealform des Konzepts) - dieselbe Praxis wie
     * {@code UnterstuetzungService} für die Kundenadministratoren (§6.2 "Inseln, die in der
     * Mechanik aufgehen"); die SICHT je Empfänger prüft trotzdem erst der Zusteller zur
     * Sendezeit (§6.6) - ein Rollenwechsel zwischen Einreihen und Versand bleibt also sicher.
     */
    /**
     * Reiht EINE Zustellung je aufgelöstem Empfänger ein. {@code auswahl} (§6.4 Nr. 6, §9): eine
     * Mehrfach-Regel bekommt einen Bündel-Schlüssel und einen auf das 30-Sekunden-Fenster
     * verzögerten Versand, damit mehrere binnen dieser Zeit ausgelöste Bezüge derselben Regel beim
     * {@code Zusteller} zu EINER Nachricht zusammenfinden; eine einfache Regel (Scheibe 1-3) sendet
     * unverändert sofort ohne Schlüssel.
     */
    private void versenden(UeberwachungZeile regel, UUID alarmId, String anlass, MeldungsText.Nachricht nachricht,
            String kennzeichen, boolean auswahl, Instant jetzt) {
        String buendelSchluessel = auswahl ? buendelSchluessel(regel.id(), anlass, jetzt) : null;
        Instant naechsterVersuch = auswahl ? buendelFensterEnde(jetzt) : jetzt;
        String betreff = nachricht.betreff();
        String inhalt = katalog.meldungsText().mailText(nachricht, kennzeichen, basisUrl);
        for (String sub : empfaengerAufloesen(regel)) {
            ausgang.email("alarm", alarmId, sub, anlass, 0, betreff, inhalt, naechsterVersuch, regel.schwere(),
                    buendelSchluessel);
            ausgang.webpush("alarm", alarmId, sub, anlass, 0, nachricht.pushTitel(), nachricht.pushText(),
                    naechsterVersuch, regel.schwere(), buendelSchluessel);
            ausgang.webhook("alarm", alarmId, sub, anlass, 0, betreff, inhalt, naechsterVersuch, regel.schwere(),
                    buendelSchluessel);
            ausgang.telegram("alarm", alarmId, sub, anlass, 0, betreff, inhalt, naechsterVersuch, regel.schwere(),
                    buendelSchluessel);
        }
        if (externeEmpfaenger != null) {
            // Entscheid 11B: Außenstehende bekommen nur den Namen, keine Schwelle und keinen Messwert.
            WerteKatalog.Eintrag eintrag = katalog.eintrag(regel.wertart());
            String name = regel.name() != null ? regel.name() : eintrag != null ? eintrag.name() : "Überwachung";
            externeEmpfaenger.benachrichtigen(regel.id(), alarmId, name, jetzt);
        }
    }

    private static String buendelSchluessel(UUID regelId, String anlass, Instant jetzt) {
        return regelId + ":" + anlass + ":" + (jetzt.getEpochSecond() / BUENDELFENSTER_S);
    }

    private static Instant buendelFensterEnde(Instant jetzt) {
        long bucket = jetzt.getEpochSecond() / BUENDELFENSTER_S;
        return Instant.ofEpochSecond((bucket + 1) * BUENDELFENSTER_S);
    }

    /** Rollen werden HIER aufgelöst (§6.6 "Inseln, die in der Mechanik aufgehen") - die Sicht je Empfänger
     * prüft trotzdem erst der Zusteller zur Sendezeit. Package-sichtbar: {@link ErinnerungsService} teilt
     * dieselbe Auflösung. */
    Set<String> empfaengerAufloesen(UeberwachungZeile regel) {
        Set<String> empfaenger = new LinkedHashSet<>();
        for (JsonNode e : regel.empfaenger()) {
            if (e.has("person")) {
                empfaenger.add(e.get("person").asText());
            } else if (e.has("rolle")) {
                var rolle = Rolle.vonCode(e.get("rolle").asText());
                if (rolle != null) {
                    for (var m : zugriffe.wirksamImKundenbereich(rolle, Instant.now())) {
                        empfaenger.add(m.zeile().benutzerSub());
                    }
                }
            }
        }
        return empfaenger;
    }

    /** "Gesehen" (Entscheid 3B, freiwillig - speist nur den Verlauf, hält nichts auf). */
    public boolean gesehen(UUID alarmId, String wer, Instant jetzt) {
        boolean geaendert = repo.gesehen(alarmId, wer, jetzt);
        if (geaendert) {
            repo.alarmVerlauf(alarmId, "gesehen", wer, "gesehen von " + wer, null);
        }
        return geaendert;
    }
}
