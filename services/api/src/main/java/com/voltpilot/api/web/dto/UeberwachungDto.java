package com.voltpilot.api.web.dto;

import com.fasterxml.jackson.databind.JsonNode;
import java.time.Instant;
import java.util.List;

/**
 * Eine Regel im Reiter "Überwachungen" (Alerting Scheibe 1+2, Konzept §6.8 "Überwachungen ist eine
 * Liste von Sätzen mit Zustand, Empfängern und letzter Meldung"). Scheibe 1 zeigte sie nur lesend;
 * Scheibe 2 fügt {@link Anlegen} hinzu - "Vom Wert zur fertigen Regel: drei Taps" (§6.8) - und den
 * 30-Tage-Probelauf: {@code probelaufBis} ist {@code null}, sobald die Regel scharf ist (ab Werk
 * gesäte Regeln kennen keinen Probelauf; eine eigene endet damit nach 30 Tagen oder per Tipper).
 * {@code bezugJson} ist derselbe rohe Bezug wie im Anfragekörper (§6.3, {@link BezugEintrag}) - die
 * Fläche braucht ihn, um "schon überwacht" an einem konkreten Wertverweis zu erkennen: bei der
 * Familie {@code geraet.messwert} identifiziert die Wertart allein keinen Wert, erst Wertart+Bezug.
 */
public record UeberwachungDto(String id, String name, String wertart, String schwere, String herkunft,
        boolean aktiv, Instant probelaufBis, String bezugJson) {

    public record Liste(List<UeberwachungDto> ueberwachungen) {}

    /**
     * Der Bezug im Anfragekörper - {@code anlage} ODER {@code komponente}+{@code kanal} (§6.3) ODER
     * eine AUSWAHL (Alerting Scheibe 4, §6.4 "Gilt für"): {@code alle} ist {@code "anlage"} oder
     * {@code "box"}, wahlweise auf einen {@code standort} eingeschränkt (sonst der ganze
     * Kundenbereich). Genau EINE der drei Formen ist gesetzt.
     */
    public record BezugEintrag(String anlage, String komponente, String kanal, String standort, String alle) {
        public BezugEintrag(String anlage, String komponente, String kanal) {
            this(anlage, komponente, kanal, null, null);
        }
    }

    /** {@code person} ODER {@code rolle} (§6.4 "Mehrere Empfänger") - nie beide. */
    public record EmpfaengerEintrag(String person, String rolle) {}

    /**
     * Eine eigene Überwachung anlegen (§6.8). {@code bedingung} bleibt roh (ihre Form hängt von der
     * Bedingungsart ab, §6.4); ohne {@code empfaenger} gilt "nur ich selbst" (die anlegende Person).
     * {@code herkunft} ist optional und bleibt {@code null}/"eigen" für die normale Fläche "Vom Wert
     * zur fertigen Regel"; "steuerung" (Alerting Scheibe 6, Entscheid 10A: "In Überwachung
     * umwandeln") ist der einzige weitere Wert, den diese Route vom Client annimmt - "ab_werk" und
     * "vorschlag" bleiben serverseitige Vorgaben, nie über diese Route setzbar
     * ({@code UeberwachungAnlegenService#anlegen}).
     */
    public record Anlegen(String wertart, BezugEintrag bezug, JsonNode bedingung, String schwere,
            List<EmpfaengerEintrag> empfaenger, String name, String herkunft) {
        public Anlegen(String wertart, BezugEintrag bezug, JsonNode bedingung, String schwere,
                List<EmpfaengerEintrag> empfaenger, String name) {
            this(wertart, bezug, bedingung, schwere, empfaenger, name, null);
        }
    }
}
