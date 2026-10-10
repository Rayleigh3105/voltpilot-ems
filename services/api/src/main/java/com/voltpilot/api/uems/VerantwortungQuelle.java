package com.voltpilot.api.uems;

import com.voltpilot.api.web.dto.EnergiemanagementVerantwortungDto;
import java.util.List;

/**
 * UEMS AP-19 IP-10 (PA4): die Andockstelle von „Wer ist wofür verantwortlich“. Jede Quelle liest die Verantwortlichen
 * ihrer Objekte über den Dienst, dem sie gehören — im Zaun und mit den Rechten des Aufrufers, nie aus einer Kopie.
 * {@link EnergiemanagementVerantwortungService} sammelt alle Quellen in ihrer {@code @Order}.
 *
 * <p>Heute: {@link VerantwortungBestand} (Kennzahl, Energieeinsatz, Bezugsbasis, Energieziel, Maßnahme, Abweichung,
 * Order 0). Internes Audit (IP-18) und Feststellung (IP-19) docken hier als eigene {@code @Component} an — ihre Art
 * ergänzt die Aufzählung {@code objekt.art} in {@code openapi.yaml}.
 */
public interface VerantwortungQuelle {

    /** Die sichtbaren Objekte dieser Quelle mit ihrem Verantwortlichen, in der Reihenfolge ihres Registers. */
    List<EnergiemanagementVerantwortungDto.Objekt> objekte();
}
