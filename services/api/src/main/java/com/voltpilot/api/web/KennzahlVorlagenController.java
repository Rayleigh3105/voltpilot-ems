package com.voltpilot.api.web;

import com.fasterxml.jackson.databind.JsonNode;
import com.voltpilot.api.uems.KennzahlVorlagen;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

/**
 * Der Vorlagen-Katalog der Kennzahlen (UEMS AP-11 IP-10, E9 = A, Schema
 * {@code docs/contracts/v2/kennzahl-vorlagen.schema.json}): acht VoltPilot-Vorlagen, die den Assistenten „Kennzahl
 * anlegen“ vorbelegen — Rechenform, Name, Zweck, Komplement und die Erwartung an Menge und Bezugsgröße. Die Arbeit
 * macht {@link KennzahlVorlagen}; die Portal-Kopie der Datei ist byte-gleich.
 *
 * <p><b>Rechte:</b> der Katalog ist eine VoltPilot-Vorgabe ohne Kundendaten und ohne Mandant (E9: kein Kundenobjekt,
 * kein Recht für Vorlagen). Wer aus einer Vorlage anlegt, braucht erst beim Anlegen und in der Vorschau
 * {@code kennzahl.standort_definieren} bzw. {@code kennzahl.unternehmen_definieren} ({@link KennzahlController}).
 */
@RestController
@RequestMapping("/api/v1/kennzahl-vorlagen")
public class KennzahlVorlagenController {

    private final KennzahlVorlagen vorlagen;

    public KennzahlVorlagenController(KennzahlVorlagen vorlagen) {
        this.vorlagen = vorlagen;
    }

    /**
     * Recht: keine eigene Kennung — eine VoltPilot-Vorgabe, gelesen von jedem angemeldeten Benutzer. Alle Vorlagen
     * in Katalog-Reihenfolge, Knoten für Knoten die der Datei.
     */
    @GetMapping
    public JsonNode liste() {
        return vorlagen.katalog();
    }
}
