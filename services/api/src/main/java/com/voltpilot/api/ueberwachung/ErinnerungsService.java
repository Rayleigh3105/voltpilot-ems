package com.voltpilot.api.ueberwachung;

import com.fasterxml.jackson.databind.JsonNode;
import com.voltpilot.api.uems.RechteAbleitung.Rolle;
import com.voltpilot.api.ueberwachung.UeberwachungRepository.AlarmZeile;
import com.voltpilot.api.ueberwachung.UeberwachungRepository.UeberwachungZeile;
import com.voltpilot.api.versand.BenachrichtigungAusgang;
import com.voltpilot.api.zugriff.ZugriffRepository;
import java.time.Instant;
import java.util.LinkedHashSet;
import java.util.Set;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.stereotype.Service;

/**
 * Erinnern (Alerting Scheibe 3, Konzept §6.5, Vorgabe): eine dringende Meldung ohne "Gesehen"
 * erinnert nach 1 Stunde, danach alle 4 Stunden, höchstens dreimal; endet bei "Gesehen" ODER
 * "Erledigt" (Entscheid 3B - deshalb reicht die Vorbedingung {@code zustand = 'aktiv'} der
 * zugrundeliegenden Abfrage, {@link UeberwachungRepository#dringendOhneGesehenFuerErinnerung()}).
 * Warnung erinnert nie von selbst (§6.5).
 *
 * <p>Eigener Dienst statt eine Erweiterung von {@link UeberwachungsService}: dieselbe
 * {@link UeberwachungsLaeufer}-Taktung (ein Aufruf je Kundenbereich, derselbe {@code TenantContext}),
 * aber ohne den bestehenden, getesteten Zustandsübergang anzufassen.
 */
@Service
public class ErinnerungsService {

    private static final long ERSTE_NACH_S = 3600;
    private static final long WEITERE_NACH_S = 4 * 3600;

    private final UeberwachungRepository repo;
    private final ZugriffRepository zugriffe;
    private BenachrichtigungAusgang ausgang = BenachrichtigungAusgang.STUMM;

    public ErinnerungsService(UeberwachungRepository repo, ZugriffRepository zugriffe) {
        this.repo = repo;
        this.zugriffe = zugriffe;
    }

    @Autowired(required = false)
    void setAusgang(BenachrichtigungAusgang ausgang) {
        this.ausgang = ausgang == null ? BenachrichtigungAusgang.STUMM : ausgang;
    }

    public int lauf(Instant jetzt) {
        int n = 0;
        for (AlarmZeile alarm : repo.dringendOhneGesehenFuerErinnerung()) {
            Instant letzte = alarm.letzteErinnerungAm() != null ? alarm.letzteErinnerungAm() : alarm.ausgeloestAm();
            long schwelleS = alarm.erinnerungenGesendet() == 0 ? ERSTE_NACH_S : WEITERE_NACH_S;
            if (jetzt.getEpochSecond() - letzte.getEpochSecond() < schwelleS) {
                continue;
            }
            UeberwachungZeile regel = repo.einzelneRegel(alarm.ueberwachungId()).orElse(null);
            if (regel == null) {
                continue; // Regel inzwischen gelöscht - keine Erinnerung ohne ihre Empfänger
            }
            int nr = alarm.erinnerungenGesendet() + 1;
            String satz = satzname(regel);
            String betreff = "Noch offen: " + satz;
            String inhalt = satz + " meldet sich seit " + alarm.ausgeloestAm() + " ohne Reaktion. Kennzeichen "
                    + alarm.kennzeichen() + ".";
            for (String sub : empfaengerAufloesen(regel)) {
                ausgang.email("alarm", alarm.id(), sub, "erinnerung", nr, betreff, inhalt, jetzt);
                ausgang.webpush("alarm", alarm.id(), sub, "erinnerung", nr, betreff, inhalt, jetzt, alarm.schwere());
            }
            repo.erinnerungVermerken(alarm.id(), jetzt);
            repo.alarmVerlauf(alarm.id(), "versand", null, "Erinnerung " + nr + " eingereiht", null);
            n++;
        }
        return n;
    }

    private Set<String> empfaengerAufloesen(UeberwachungZeile regel) {
        Set<String> empfaenger = new LinkedHashSet<>();
        for (JsonNode e : regel.empfaenger()) {
            if (e.has("person")) {
                empfaenger.add(e.get("person").asText());
            } else if (e.has("rolle")) {
                Rolle rolle = Rolle.vonCode(e.get("rolle").asText());
                if (rolle != null) {
                    for (var m : zugriffe.wirksamImKundenbereich(rolle, Instant.now())) {
                        empfaenger.add(m.zeile().benutzerSub());
                    }
                }
            }
        }
        return empfaenger;
    }

    private static String satzname(UeberwachungZeile regel) {
        return regel.name() != null ? regel.name() : regel.wertart();
    }
}
