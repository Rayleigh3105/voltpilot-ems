package com.voltpilot.api.ueberwachung;

import com.fasterxml.jackson.databind.JsonNode;
import com.voltpilot.api.repo.PriceRepository;
import com.voltpilot.api.uems.RechteAbleitung.Rolle;
import com.voltpilot.api.ueberwachung.UeberwachungRepository.AlarmZeile;
import com.voltpilot.api.ueberwachung.UeberwachungRepository.InstanzZeile;
import com.voltpilot.api.ueberwachung.UeberwachungRepository.UeberwachungZeile;
import com.voltpilot.api.versand.BenachrichtigungAusgang;
import com.voltpilot.api.web.dto.PriceRangeSummaryDto;
import com.voltpilot.api.zugriff.ZugriffRepository;
import java.time.Instant;
import java.util.LinkedHashSet;
import java.util.List;
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
 * ({@link BedingungsPruefung}) - eine Regel mit anderem Bezug (Auswahl "alle Anlagen") bleibt
 * übersprungen (Scheibe 4, §7 "Ausdrücklich NICHT"). <b>Quittierungspflicht (Entscheid 3B): keine.</b>
 * "Gesehen" ist eine freiwillige Aktion, die nur den Verlauf speist (siehe {@link #gesehen}) - sie
 * hält den Zustandsübergang nicht auf: ein Alarm wird erledigt, sobald sein Wert zurückkehrt,
 * unabhängig davon, ob jemand ihn gesehen hat.
 */
@Service
public class UeberwachungsService {

    private static final Logger log = LoggerFactory.getLogger(UeberwachungsService.class);

    public record Lauf(int gesaet, int ausgeloest, int erledigt) {}

    private final UeberwachungRepository repo;
    private final WerteKatalog katalog;
    private final ZustandWerteLeser zustandLeser;
    private final EreignisWerteLeser ereignisLeser;
    private final AnlagenflussWerteLeser anlagenflussLeser;
    private final MessreiheWerteLeser messreiheLeser;
    private final ZugriffRepository zugriffe;
    private final PriceRepository preise;
    private BenachrichtigungAusgang ausgang = BenachrichtigungAusgang.STUMM;

    public UeberwachungsService(UeberwachungRepository repo, WerteKatalog katalog,
            ZustandWerteLeser zustandLeser, EreignisWerteLeser ereignisLeser,
            AnlagenflussWerteLeser anlagenflussLeser, MessreiheWerteLeser messreiheLeser,
            ZugriffRepository zugriffe, PriceRepository preise) {
        this.repo = repo;
        this.katalog = katalog;
        this.zustandLeser = zustandLeser;
        this.ereignisLeser = ereignisLeser;
        this.anlagenflussLeser = anlagenflussLeser;
        this.messreiheLeser = messreiheLeser;
        this.zugriffe = zugriffe;
        this.preise = preise;
    }

    /** Die EINE Stelle, die {@code leser.art} auf ihre Implementierung abbildet (§6.3 Nr. 3). */
    private WerteLeser leserFuer(String art) {
        return switch (art) {
            case "zustand" -> zustandLeser;
            case "ereignis" -> ereignisLeser;
            case "anlagenfluss" -> anlagenflussLeser;
            case "messreihe" -> messreiheLeser;
            default -> null;
        };
    }

    /** Nachgereicht wie {@code VersandRepository}: Scheibe-0-Ausgang, in Tests austauschbar. */
    @Autowired(required = false)
    public void setAusgang(BenachrichtigungAusgang ausgang) {
        this.ausgang = ausgang == null ? BenachrichtigungAusgang.STUMM : ausgang;
    }

    public Lauf lauf(Instant jetzt) {
        int gesaet = aussaat();
        int ausgeloest = 0;
        int erledigt = 0;
        for (UeberwachungZeile regel : repo.aktive()) {
            WerteLeser.Bezug bezug = bezugAus(regel.bezug());
            if (bezug == null) {
                continue; // "alle X" (Scheibe 4+) - hier übersprungen
            }
            WerteKatalog.Eintrag eintrag = katalog.eintrag(regel.wertart());
            WerteLeser leser = eintrag == null ? null : leserFuer(eintrag.leser().art());
            if (leser == null) {
                continue; // unbekannte/entfernte Wertart oder Leserart
            }
            UUID anlageId = anlageFuerBezug(bezug);
            if (anlageId == null) {
                continue; // Bezug zeigt auf nichts (mehr) Sichtbares - Instanz bleibt unverändert liegen
            }
            Ergebnis e = werte(regel, eintrag, leser, bezug, anlageId, jetzt);
            ausgeloest += e.ausgeloest ? 1 : 0;
            erledigt += e.erledigt ? 1 : 0;
        }
        if (gesaet + ausgeloest + erledigt > 0) {
            log.info("Überwachung: {} gesät, {} ausgelöst, {} erledigt", gesaet, ausgeloest, erledigt);
        }
        return new Lauf(gesaet, ausgeloest, erledigt);
    }

    /**
     * Der Bezug einer Regel als {@link WerteLeser.Bezug} (§6.3 Wertverweis-Syntax): {@code anlage}
     * (Scheibe 1) oder {@code komponente} mit Messkanal (Scheibe 2, Familie {@code geraet.messwert}).
     */
    private static WerteLeser.Bezug bezugAus(JsonNode bezug) {
        JsonNode anlage = bezug.path("anlage");
        if (anlage.isTextual()) {
            UUID id = alsUuid(anlage.asText());
            return id == null ? null : WerteLeser.Bezug.anlage(id);
        }
        JsonNode komponente = bezug.path("komponente");
        if (komponente.isTextual()) {
            UUID id = alsUuid(komponente.asText());
            return id == null ? null : WerteLeser.Bezug.komponente(id, bezug.path("kanal").asText(null));
        }
        return null;
    }

    private static UUID alsUuid(String text) {
        try {
            return UUID.fromString(text);
        } catch (IllegalArgumentException e) {
            return null;
        }
    }

    /** Die Anlage, an der ein Bezug tatsächlich hängt - für Standort, Name und die Lesung selbst. */
    private UUID anlageFuerBezug(WerteLeser.Bezug bezug) {
        return switch (bezug.art()) {
            case "anlage" -> bezug.id();
            case "komponente" -> repo.anlageDerKomponente(bezug.id());
            default -> null;
        };
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
                default -> List.of();
            };
            for (UUID anlageId : anlagen) {
                repo.seedAbWerk(anlageId, repo.standortHeute(anlageId), eintrag);
                n++;
            }
        }
        n += aussaatPreisHinweisPrivatkunde();
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
            WerteLeser.Bezug bezug, UUID anlageId, Instant jetzt) {
        WerteLeser.Lesung lesung = leser.lese(eintrag, bezug, jetzt);
        JsonNode bedingung = regel.bedingung();
        long dauerS = bedingung.path("dauer_s").asLong(0);
        long erholenS = bedingung.path("erholen_s").asLong(300);
        BedingungsPruefung.Erfuellung erfuellung = BedingungsPruefung.pruefen(bedingung, lesung);

        InstanzZeile instanz = repo.instanz(regel.id(), bezug.kennung());
        String letzterWertJson = wertJson(lesung);

        switch (instanz.zustand()) {
            case "normal" -> {
                if (erfuellung.ausgeloest()) {
                    repo.instanzSpeichern(regel.id(), bezug.kennung(), "ausstehend", jetzt, letzterWertJson,
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
                    UUID alarmId = ausloesen(regel, bezug, anlageId, jetzt, lesung);
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
                    wiederNormal(regel, instanz.offenerAlarm(), anlageId, jetzt, lesung);
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

    /** Der Wert in Prosa, für Betreff und Text einer Nachricht (§6.8). */
    private static String wertText(WerteLeser.Lesung lesung) {
        if (!lesung.bekannt()) {
            return "keine Daten";
        }
        if (lesung.zustandswort() != null) {
            return lesung.zustandswort();
        }
        String einheit = lesung.einheit() == null ? "" : " " + lesung.einheit();
        return String.format(java.util.Locale.GERMANY, "%.1f%s", lesung.zahlenwert(), einheit);
    }

    // --------------------------------------------------------------------- Ausgelöst / wieder normal (§6.8)

    private UUID ausloesen(UeberwachungZeile regel, WerteLeser.Bezug bezug, UUID anlageId, Instant jetzt,
            WerteLeser.Lesung lesung) {
        String anlageName = anlageNameOder(anlageId);
        String wertJson = wertJson(lesung);
        boolean probelauf = regel.imProbelauf(jetzt);
        UUID alarmId = repo.alarmErzeugen(regel, bezug.kennung(), regel.standortId() != null
                ? regel.standortId() : repo.standortHeute(anlageId), jetzt, wertJson, probelauf);
        repo.alarmVerlauf(alarmId, "ausgeloest", null, satzname(regel) + " der Anlage " + anlageName
                + (probelauf ? " (Probelauf - hätte gemeldet)" : ""), wertJson);
        // Probelauf (§6.4, §6.8 Entwurf 1): ausgewertet und im Verlauf nachweisbar, aber OHNE
        // Versand - "was sie gemeldet hätte", nicht was sie wirklich gemeldet hat.
        if (!probelauf && !"hinweis".equals(regel.schwere())) {
            versenden(regel, alarmId, anlageName, "ausgeloest",
                    schwereWort(regel.schwere()) + ": " + regel.name(),
                    satzname(regel) + " der Anlage " + anlageName + " meldet: " + wertText(lesung)
                            + ". Kennzeichen " + repo.alarm(alarmId).map(AlarmZeile::kennzeichen).orElse("?")
                            + ".");
        }
        repo.alarmVerlauf(alarmId, "versand", null, probelauf ? "Probelauf - kein Versand" : "Versand eingereiht",
                null);
        return alarmId;
    }

    private void wiederNormal(UeberwachungZeile regel, UUID alarmId, UUID anlageId, Instant jetzt,
            WerteLeser.Lesung lesung) {
        if (alarmId == null) {
            return;
        }
        // 3B: keine Quittierungspflicht - jeder Alarm wird erledigt, sobald sein Wert zurückkehrt.
        repo.alarmWiederNormal(alarmId, jetzt, true);
        repo.alarmVerlauf(alarmId, "wieder_normal", null, "wieder normal", null);
        repo.alarmVerlauf(alarmId, "erledigt", null, "erledigt (Wert zurück)", null);
        // Derselbe Alarm, dieselbe Probelauf-Marke wie beim Auslösen (§6.4, §6.8 Entwurf 1) - nicht
        // regel.imProbelauf(jetzt) neu befragen: die Regel könnte in der Zwischenzeit scharf geschaltet
        // worden sein, ihr erster Alarm bleibt trotzdem ohne Versand "wieder normal".
        boolean probelauf = repo.alarm(alarmId).map(AlarmZeile::probelauf).orElse(false);
        if (!probelauf && !"hinweis".equals(regel.schwere())) {
            String anlageName = anlageNameOder(anlageId);
            versenden(regel, alarmId, anlageName, "wieder_normal",
                    "Wieder normal: " + regel.name(),
                    satzname(regel) + " der Anlage " + anlageName + " ist seit " + jetzt + " wieder normal.");
        }
    }

    private String anlageNameOder(UUID anlageId) {
        String name = repo.anlageName(anlageId);
        return name != null ? name : anlageId.toString();
    }

    private static String satzname(UeberwachungZeile regel) {
        return regel.name() != null ? regel.name() : regel.wertart();
    }

    private static String schwereWort(String schwere) {
        return switch (schwere) {
            case "dringend" -> "Dringend";
            case "warnung" -> "Warnung";
            default -> "Hinweis";
        };
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
    private void versenden(UeberwachungZeile regel, UUID alarmId, String anlageName, String anlass,
            String betreff, String inhalt) {
        for (String sub : empfaengerAufloesen(regel)) {
            ausgang.email("alarm", alarmId, sub, anlass, betreff, inhalt);
            ausgang.webpush("alarm", alarmId, sub, anlass, betreff, inhalt, regel.schwere());
        }
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
