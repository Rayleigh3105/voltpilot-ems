package com.voltpilot.api.uems;

import com.voltpilot.api.web.dto.EnergiemanagementPersonenDto;
import com.voltpilot.api.web.dto.EnergiemanagementVerantwortungDto;
import java.time.LocalDate;
import org.springframework.beans.factory.ObjectProvider;
import org.springframework.stereotype.Service;

/**
 * UEMS AP-19 IP-10: „Wer ist wofür verantwortlich“ (PA2, PA4, §5.2, R5) — ein Leser, kein Speicher. Er stellt neben
 * die Aufgaben am Tag ({@link EnergiemanagementPersonenService#aufgaben}) die Verantwortlichen der Objekte aus allen
 * {@link VerantwortungQuelle}n und die Freigaben der Bezugsbasen ({@link VerantwortungBestand#bezugsbasenFreigaben}).
 * Ob die Verteilung genügt, sagt er nicht (G4) — das beurteilt eine Person, etwa die Auditorin; Verantwortung verleiht
 * kein Recht (AP-18 M1).
 */
@Service
public class EnergiemanagementVerantwortungService {

    private final EnergiemanagementPersonenService personen;
    private final VerantwortungBestand bestand;
    private final ObjectProvider<VerantwortungQuelle> quellen;

    public EnergiemanagementVerantwortungService(EnergiemanagementPersonenService personen,
            VerantwortungBestand bestand, ObjectProvider<VerantwortungQuelle> quellen) {
        this.personen = personen;
        this.bestand = bestand;
        this.quellen = quellen;
    }

    /** Die Aufgaben am {@code tag} (Vorgabe heute), die Objekte und Freigaben so, wie ihre Dienste sie heute zeigen. */
    public EnergiemanagementVerantwortungDto.Verantwortung lesen(LocalDate tag) {
        EnergiemanagementPersonenDto.Aufgaben a = personen.aufgaben(tag);
        return new EnergiemanagementVerantwortungDto.Verantwortung(a.tag(), a.leitung(), a.aufgaben(),
                a.aufgaben().stream().filter(x -> x.satz() != null).map(EnergiemanagementPersonenDto.Aufgabe::aufgabe)
                        .toList(),
                quellen.orderedStream().flatMap(q -> q.objekte().stream()).toList(), bestand.bezugsbasenFreigaben());
    }
}
