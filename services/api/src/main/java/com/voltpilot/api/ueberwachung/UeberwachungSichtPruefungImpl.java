package com.voltpilot.api.ueberwachung;

import com.voltpilot.api.uems.RechteAbleitung;
import com.voltpilot.api.uems.RechteAbleitung.Benutzer;
import com.voltpilot.api.uems.RechteAbleitung.Kundenbereich;
import com.voltpilot.api.uems.RechteAbleitung.Person;
import com.voltpilot.api.uems.RechteAbleitung.Rolle;
import com.voltpilot.api.uems.RechteAbleitung.Standort;
import com.voltpilot.api.uems.RechteAbleitung.Ziel;
import com.voltpilot.api.ueberwachung.UeberwachungRepository.AlarmZeile;
import com.voltpilot.api.versand.UeberwachungSichtPruefung;
import com.voltpilot.api.zugriff.RechteMatrixDatei;
import com.voltpilot.api.zugriff.ZugriffRepository;
import com.voltpilot.api.zugriff.ZugriffRepository.BenutzerSpiegel;
import java.time.Instant;
import java.util.List;
import java.util.UUID;
import org.springframework.stereotype.Component;

/**
 * Die Sicht-Prüfung je Empfänger beim Versand (Alerting Scheibe 1, Konzept §6.6): baut
 * {@code RechteAbleitung.Benutzer}/{@code Kundenbereich} für einen BELIEBIGEN Empfänger (nicht den
 * Anfragenden einer Web-Anfrage) genau wie {@code Selbstauskunft.benutzer} es für den eigenen
 * Nutzer tut, und ruft dieselbe reine Funktion {@code RechteAbleitung.darf} auf.
 */
@Component
public class UeberwachungSichtPruefungImpl implements UeberwachungSichtPruefung {

    private final UeberwachungRepository repo;
    private final WerteKatalog katalog;
    private final ZugriffRepository zugriffe;

    public UeberwachungSichtPruefungImpl(UeberwachungRepository repo, WerteKatalog katalog,
            ZugriffRepository zugriffe) {
        this.repo = repo;
        this.katalog = katalog;
        this.zugriffe = zugriffe;
    }

    @Override
    public boolean sichtbar(UUID alarmId, String empfaengerSub, Instant jetzt) {
        AlarmZeile alarm = repo.alarm(alarmId).orElse(null);
        if (alarm == null) {
            return false; // der Alarm ist schon weg (Löschlauf einer späteren Scheibe) - nichts zu zeigen
        }
        WerteKatalog.Eintrag eintrag = katalog.eintrag(alarm.wertart());
        String recht = eintrag != null ? eintrag.recht() : "messwerte.ansehen";

        Benutzer benutzer = benutzer(empfaengerSub);
        if (benutzer == null) {
            return false; // kein Konto (mehr) - keine Sicht
        }
        Kundenbereich kundenbereich = kundenbereich(jetzt);
        Ziel ziel = alarm.standortId() == null ? Ziel.unternehmen()
                : zielFuerStandort(repo.standortKurzzeichen(alarm.standortId()));
        return RechteAbleitung.darf(RechteMatrixDatei.matrix(), benutzer, kundenbereich, recht, ziel, jetzt)
                .darf();
    }

    private static Ziel zielFuerStandort(String kurzzeichen) {
        return kurzzeichen == null ? Ziel.unternehmen() : Ziel.standort(kurzzeichen);
    }

    private Benutzer benutzer(String sub) {
        BenutzerSpiegel spiegel = zugriffe.spiegel(sub).orElse(null);
        if (spiegel == null) {
            return null;
        }
        return new Benutzer(sub, spiegel.anzeigename(), spiegel.konto(), spiegel.zustand(),
                zugriffe.wirksam(sub, Instant.now()).stream().map(ZugriffRepository.Zeile::alsZuweisung).toList());
    }

    private Kundenbereich kundenbereich(Instant jetzt) {
        ZugriffRepository.KundenbereichKopf kopf = zugriffe.kundenbereichKopf();
        List<Standort> standorte = zugriffe.standorte().stream()
                .map(s -> new Standort(s.kurzzeichen(), s.name())).toList();
        List<Person> kundenadministratoren = zugriffe.wirksamImKundenbereich(Rolle.KUNDENADMINISTRATOR, jetzt)
                .stream().map(m -> new Person(m.zeile().benutzerSub(), m.name())).toList();
        return new Kundenbereich(kopf.name(), standorte, kundenadministratoren);
    }
}
