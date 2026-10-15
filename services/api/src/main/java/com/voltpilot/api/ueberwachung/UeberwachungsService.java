package com.voltpilot.api.ueberwachung;

import com.fasterxml.jackson.databind.JsonNode;
import com.voltpilot.api.uems.RechteAbleitung.Rolle;
import com.voltpilot.api.ueberwachung.UeberwachungRepository.AlarmZeile;
import com.voltpilot.api.ueberwachung.UeberwachungRepository.InstanzZeile;
import com.voltpilot.api.ueberwachung.UeberwachungRepository.UeberwachungZeile;
import com.voltpilot.api.versand.BenachrichtigungAusgang;
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
 * <p>Scheibe 1 kennt nur den Bezug {@code anlage} und die Bedingungsart {@code zustand}; eine Regel
 * mit anderem Bezug oder anderer Bedingungsart wird übersprungen (spätere Scheiben, §7 "Ausdrücklich
 * NICHT"). <b>Quittierungspflicht (Entscheid 3B): keine.</b> "Gesehen" ist eine freiwillige Aktion,
 * die nur den Verlauf speist (siehe {@link #gesehen}) - sie hält den Zustandsübergang nicht auf: ein
 * Alarm wird erledigt, sobald sein Wert zurückkehrt, unabhängig davon, ob jemand ihn gesehen hat.
 */
@Service
public class UeberwachungsService {

    private static final Logger log = LoggerFactory.getLogger(UeberwachungsService.class);

    public record Lauf(int gesaet, int ausgeloest, int erledigt) {}

    private final UeberwachungRepository repo;
    private final WerteKatalog katalog;
    private final ZustandWerteLeser zustandLeser;
    private final ZugriffRepository zugriffe;
    private BenachrichtigungAusgang ausgang = BenachrichtigungAusgang.STUMM;

    public UeberwachungsService(UeberwachungRepository repo, WerteKatalog katalog,
            ZustandWerteLeser zustandLeser, ZugriffRepository zugriffe) {
        this.repo = repo;
        this.katalog = katalog;
        this.zustandLeser = zustandLeser;
        this.zugriffe = zugriffe;
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
            UUID anlageId = anlageAusBezug(regel.bezug());
            if (anlageId == null) {
                continue; // anderer Bezug (Scheibe 4+) oder "alle X" (Scheibe 4+) - hier übersprungen
            }
            WerteKatalog.Eintrag eintrag = katalog.eintrag(regel.wertart());
            if (eintrag == null || !"zustand".equals(eintrag.leser().art())) {
                continue; // unbekannte/entfernte Wertart, oder ereignis-Bedingung (Scheibe 2+)
            }
            Ergebnis e = werte(regel, eintrag, anlageId, jetzt);
            ausgeloest += e.ausgeloest ? 1 : 0;
            erledigt += e.erledigt ? 1 : 0;
        }
        if (gesaet + ausgeloest + erledigt > 0) {
            log.info("Überwachung: {} gesät, {} ausgelöst, {} erledigt", gesaet, ausgeloest, erledigt);
        }
        return new Lauf(gesaet, ausgeloest, erledigt);
    }

    private static UUID anlageAusBezug(JsonNode bezug) {
        JsonNode anlage = bezug.path("anlage");
        if (!anlage.isTextual()) {
            return null;
        }
        try {
            return UUID.fromString(anlage.asText());
        } catch (IllegalArgumentException e) {
            return null;
        }
    }

    // --------------------------------------------------------------------- Aussaat (§7 Nr. 7, Entscheid 2A)

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
        return n;
    }

    // --------------------------------------------------------------------- Auswertung (§6.5)

    private record Ergebnis(boolean ausgeloest, boolean erledigt) {
        static final Ergebnis NICHTS = new Ergebnis(false, false);
    }

    private Ergebnis werte(UeberwachungZeile regel, WerteKatalog.Eintrag eintrag, UUID anlageId, Instant jetzt) {
        WerteLeser.Bezug bezug = WerteLeser.Bezug.anlage(anlageId);
        WerteLeser.Lesung lesung = zustandLeser.lese(eintrag, bezug, jetzt);
        JsonNode bedingung = regel.bedingung();
        List<String> ziel = textListe(bedingung.path("ziel"));
        long dauerS = bedingung.path("dauer_s").asLong(0);
        long erholenS = bedingung.path("erholen_s").asLong(300);
        boolean erfuellt = lesung.bekannt() && ziel.contains(lesung.zustandswort());

        InstanzZeile instanz = repo.instanz(regel.id(), bezug.kennung());
        String letzterWertJson = lesung.bekannt() ? "{\"zustand\":\"" + lesung.zustandswort() + "\"}" : null;

        switch (instanz.zustand()) {
            case "normal" -> {
                if (erfuellt) {
                    repo.instanzSpeichern(regel.id(), bezug.kennung(), "ausstehend", jetzt, letzterWertJson,
                            lesung.messzeit(), null, jetzt);
                }
                return Ergebnis.NICHTS;
            }
            case "ausstehend" -> {
                if (!erfuellt) {
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
                if (erfuellt) {
                    return Ergebnis.NICHTS; // unverändert aktiv
                }
                repo.instanzSpeichern(regel.id(), bezug.kennung(), "erholend", jetzt, letzterWertJson,
                        lesung.messzeit(), instanz.offenerAlarm(), jetzt);
                return Ergebnis.NICHTS;
            }
            case "erholend" -> {
                if (erfuellt) {
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

    private static List<String> textListe(JsonNode array) {
        List<String> out = new java.util.ArrayList<>();
        if (array.isArray()) {
            array.forEach(n -> out.add(n.asText()));
        }
        return out;
    }

    // --------------------------------------------------------------------- Ausgelöst / wieder normal (§6.8)

    private UUID ausloesen(UeberwachungZeile regel, WerteLeser.Bezug bezug, UUID anlageId, Instant jetzt,
            WerteLeser.Lesung lesung) {
        String anlageName = anlageNameOder(anlageId);
        String wertJson = "{\"zustand\":\"" + lesung.zustandswort() + "\"}";
        UUID alarmId = repo.alarmErzeugen(regel, bezug.kennung(), regel.standortId() != null
                ? regel.standortId() : repo.standortHeute(anlageId), jetzt, wertJson);
        repo.alarmVerlauf(alarmId, "ausgeloest", null, satzname(regel) + " der Anlage " + anlageName, wertJson);
        if (!"hinweis".equals(regel.schwere())) {
            versenden(regel, alarmId, anlageName, "ausgeloest",
                    schwereWort(regel.schwere()) + ": " + regel.name(),
                    satzname(regel) + " der Anlage " + anlageName + " meldet: " + lesung.zustandswort()
                            + ". Kennzeichen " + repo.alarm(alarmId).map(AlarmZeile::kennzeichen).orElse("?")
                            + ".");
        }
        repo.alarmVerlauf(alarmId, "versand", null, "Versand eingereiht", null);
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
        if (!"hinweis".equals(regel.schwere())) {
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
        for (String sub : empfaenger) {
            ausgang.email("alarm", alarmId, sub, anlass, betreff, inhalt);
        }
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
