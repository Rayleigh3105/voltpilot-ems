package com.voltpilot.api.web.dto;

import java.time.Instant;
import java.util.List;

/**
 * Eine Meldung im Meldungs-Center (Alerting Scheibe 1, Konzept §6.8 Entwurf 2/3/5) - die
 * Portal-Form von {@code UeberwachungRepository.AlarmZeile}, mit der Anlage aufgelöst.
 *
 * <p>{@code bezugKennung} ist derselbe rohe Bezug wie am Alarm (Alerting Scheibe 5, §6.4 Nr. 7:
 * "Zur Auffälligkeit" bei einer Meldung aus einer eigenen Überwachung auf Messstelle/Kennzahl/
 * Energieziel) - die Fläche parst daraus die Ziel-Kennung, ohne eine zweite Wahrheit über den Bezug.
 *
 * <p>{@code text} (Kunden-Alarmierung P1) ist die Eingabe des Meldungstexts - dieselbe, aus der Mail und Push
 * gerendert werden; das Portal rendert sie mit {@code meldungsText.ts} (Vektoren
 * {@code docs/contracts/v2/meldungs-text-vectors.json}).
 *
 * <p>{@code ueberwachungId} (Kunden-Alarmierung P3) ist die Regel der Meldung - der Knopf „Stumm“ an der Karte schaltet
 * genau sie stumm ({@code POST /api/v1/stummschaltungen}, Art {@code regel}).
 */
public record MeldungDto(String id, String kennzeichen, String wertart, String schwere, String anlageId,
        String anlageName, String standortId, Instant ausgeloestAm, String zustand, Instant wiederNormalAm,
        String gesehenVon, Instant gesehenAm, Instant erledigtAm, String bezugKennung,
        com.voltpilot.api.ueberwachung.MeldungsText.Eingabe text, String ueberwachungId) {

    public record Liste(List<MeldungDto> meldungen) {}

    public record Zahl(long ungesehen, boolean dringend) {}
}
