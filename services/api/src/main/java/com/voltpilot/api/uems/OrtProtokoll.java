package com.voltpilot.api.uems;

import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.voltpilot.api.uems.OrtAenderungRepository.NeuerEintrag;
import com.voltpilot.api.uems.OrtsbaumAbleitung.Rueckwirkung;
import com.voltpilot.api.uems.OrtsbaumAbleitung.RueckwirkungEingang;
import java.time.Instant;
import java.time.LocalDate;
import java.time.OffsetDateTime;
import java.time.ZoneId;
import java.util.Map;
import java.util.UUID;
import org.springframework.stereotype.Component;

/**
 * Schreibt das Änderungsprotokoll der Ortsstruktur ({@code ort_aenderung}): GENAU EIN
 * Eintrag je Schreibvorgang (AP-02 Regel 14), in der Transaktion des Aufrufers — scheitert
 * der Vorgang, gibt es auch keinen Eintrag. EIN Baustein für Unternehmen und Standort
 * (IP-4) und für Gebäude/Bereiche (IP-5).
 *
 * <p><b>Die EINE Stelle, die den Urheber abbildet.</b> {@link ProtokollAkteur} spricht das
 * Akteur-Vokabular von AP-03 ({@code actor_sub/name/rolle/art}); {@code ort_aenderung}
 * (V20260911100000) kennt nur {@code akteur_sub} und {@code akteur_name}. Damit ein Eintrag
 * des Plattform-Betriebs trotzdem ehrlich als VoltPilot dasteht, trägt sein Name es
 * („VoltPilot (admin)"); {@code akteur_sub} bleibt die Person. AP-03 IP-7 vereinheitlicht
 * die Journale — wer das ändert, ändert es HIER.
 *
 * <p>{@code rueckwirkend} rechnet {@link OrtsbaumAbleitung#rueckwirkung}: „gilt ab" vor dem
 * Eintragstag in der Zeitzone des Standorts (E2).
 */
@Component
public class OrtProtokoll {

    private final OrtAenderungRepository aenderungen;
    private final ObjectMapper json;

    public OrtProtokoll(OrtAenderungRepository aenderungen, ObjectMapper json) {
        this.aenderungen = aenderungen;
        this.json = json;
    }

    /**
     * @param objektArt {@code unternehmen} · {@code standort} · {@code gebaeude} · {@code bereich}
     * @param art der Code des CHECKs ({@code angelegt}, {@code bearbeitet}, {@code archiviert} …)
     * @param alt/neu nur die geänderten Felder; {@code null} = keine Seite (etwa beim Anlegen)
     * @param giltAb der Tag, ab dem die Änderung gilt
     * @param zeitzone die Zeitzone des Standorts (des Unternehmens) — sie bestimmt den Eintragstag
     * @param jetzt der Zeitpunkt des Eintrags
     */
    public long eintragen(UUID tenant, String objektArt, UUID objektId, String art,
            Map<String, Object> alt, Map<String, Object> neu, LocalDate giltAb, ZoneId zeitzone,
            Instant jetzt, ProtokollAkteur wer) {
        boolean rueckwirkend = OrtsbaumAbleitung.rueckwirkung(new RueckwirkungEingang(
                OffsetDateTime.ofInstant(jetzt, zeitzone), giltAb, null, zeitzone, null))
                .art() == Rueckwirkung.RUECKWIRKEND;
        return aenderungen.eintragen(new NeuerEintrag(tenant, objektArt, objektId, art,
                alsJson(alt), alsJson(neu), giltAb, rueckwirkend, wer.sub(), akteurName(wer)));
    }

    /** Der Name im Protokoll: die Person — beim Plattform-Betrieb ausdrücklich als VoltPilot. */
    static String akteurName(ProtokollAkteur wer) {
        return ProtokollAkteur.ART_VOLTPILOT.equals(wer.art()) ? "VoltPilot (" + wer.name() + ")" : wer.name();
    }

    private String alsJson(Map<String, Object> werte) {
        if (werte == null) {
            return null;
        }
        try {
            return json.writeValueAsString(werte);
        } catch (JsonProcessingException e) {
            throw new IllegalStateException("Protokolleintrag nicht darstellbar", e);
        }
    }
}
