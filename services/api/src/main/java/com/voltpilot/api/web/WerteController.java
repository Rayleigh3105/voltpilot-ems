package com.voltpilot.api.web;

import com.voltpilot.api.ueberwachung.AnlagenflussWerteLeser;
import com.voltpilot.api.ueberwachung.WerteKatalog;
import com.voltpilot.api.ueberwachung.WerteLeser;
import com.voltpilot.api.web.dto.WertverweisDto;
import java.time.Instant;
import java.util.List;
import java.util.UUID;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.server.ResponseStatusException;

/**
 * "Was lässt sich hier überwachen?" (Alerting Scheibe 2, Konzept §6.3): speist die Auswahl
 * "+ Überwachung" im Meldungs-Center und das Menü "..." an einem Wert. Keine eigene Rechte-Prüfung
 * - wie {@code MeldungenController} liest diese Route unter der normalen RLS-Sicht der Verbindung
 * (eine Anlage, die der Aufrufer nicht sieht, liefert über die zugrunde liegende Topologie keine
 * Werte, kein Fehler); nur die {@code anlagenfluss}-Leserart ist bislang verdrahtet - {@code messreihe}
 * (jeder gemessene Kanal einer Komponente) ist eine Familie und braucht die Enumeration über den
 * Messpunkt-Katalog einer späteren Runde.
 */
@RestController
@RequestMapping("/api/v1/werte")
public class WerteController {

    private final WerteKatalog katalog;
    private final AnlagenflussWerteLeser anlagenfluss;

    public WerteController(WerteKatalog katalog, AnlagenflussWerteLeser anlagenfluss) {
        this.katalog = katalog;
        this.anlagenfluss = anlagenfluss;
    }

    @GetMapping
    public WertverweisDto.Liste werte(@RequestParam String bezug) {
        String[] teile = bezug.split(":", 2);
        if (teile.length != 2 || !"anlage".equals(teile[0])) {
            throw new ResponseStatusException(org.springframework.http.HttpStatus.BAD_REQUEST,
                    "nur bezug=anlage:<id> wird unterstützt");
        }
        UUID anlageId;
        try {
            anlageId = UUID.fromString(teile[1]);
        } catch (IllegalArgumentException e) {
            throw new ResponseStatusException(org.springframework.http.HttpStatus.BAD_REQUEST, "ungültige Anlage");
        }
        WerteLeser.Bezug leserBezug = WerteLeser.Bezug.anlage(anlageId);
        Instant jetzt = Instant.now();
        String bezugJson = "{\"anlage\":\"" + anlageId + "\"}";

        List<WertverweisDto> werte = katalog.alle().stream()
                .filter(e -> "anlagenfluss".equals(e.leser().art()))
                .map(e -> {
                    WerteLeser.Lesung l = anlagenfluss.lese(e, leserBezug, jetzt);
                    return new WertverweisDto(e.wertart(), e.name(), e.satzname(), e.bedingungen(), bezugJson,
                            l.bekannt(), l.zahlenwert(), l.zustandswort(), l.einheit());
                })
                .toList();
        return new WertverweisDto.Liste(werte);
    }
}
