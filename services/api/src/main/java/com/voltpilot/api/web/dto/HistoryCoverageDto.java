package com.voltpilot.api.web.dto;

import java.time.Instant;

/**
 * <b>Wie vollständig die Zahlen dieses Zeitraums gemessen sind</b> (Feature F4 /
 * Maßnahme P7 des Historie-Konzepts {@code data/vp-historie-konzept-t4}) -
 * additiv auf {@link HistoryDto}, damit ein älterer Client unverändert
 * weiterläuft.
 *
 * <p>Der behobene Vertrauensschaden: ein „Jahr", das sechs Wochen Balken zeigt,
 * und eine Lücke, die von einer gemessenen Null nicht unterscheidbar ist. Diese
 * Metadaten sagen beides aus - <em>ab wann</em> es überhaupt Daten gibt und
 * <em>wie viel</em> des erwarteten Zeitraums wirklich gemessen wurde.
 *
 * <p><b>Bezugsgröße ist immer die Viertelstunde</b> ({@code resolutionMinutes}),
 * nicht der Anzeige-Bucket: die Messreihe entsteht in Viertelstunden, egal ob
 * die Seite gerade Tage oder Stunden zeichnet.
 *
 * <p><b>Der erwartete Zeitraum ist bewusst enger als das Fenster</b>
 * ({@code expectedFrom}/{@code expectedTo}): er beginnt frühestens, wenn die
 * Anlage das erste Mal gemessen hat (sonst läse ein Kalenderjahr einer im Juni
 * ans Netz gegangenen Anlage „45 % gemessen", obwohl nichts fehlt), und endet
 * vor der laufenden Viertelstunde - eine Viertelstunde, die noch läuft, kann
 * nicht fehlen. Der Prozentsatz wird bewusst NICHT hier gerechnet: die Zähler
 * sind die Tatsache, die Formulierung gehört der Oberfläche.
 *
 * @param firstDataAt     erste je gemessene Viertelstunde der Anlage
 *                        (null = nichts gemessen, dann behauptet die
 *                        Oberfläche gar keine Abdeckung)
 * @param lastDataAt      letzte je gemessene Viertelstunde der Anlage
 * @param expectedFrom    Beginn des Zeitraums, auf den sich die Zähler beziehen
 * @param expectedTo      Ende (exklusiv) desselben Zeitraums
 * @param expectedBuckets Viertelstunden, die dieser Zeitraum tragen konnte
 * @param measuredBuckets davon wirklich gemessene Viertelstunden
 * @param gaps            zusammenhängende Fehlstellen darin (0 = durchgehend)
 * @param resolutionMinutes Länge einer gezählten Einheit in Minuten (15)
 */
public record HistoryCoverageDto(
        Instant firstDataAt,
        Instant lastDataAt,
        Instant expectedFrom,
        Instant expectedTo,
        long expectedBuckets,
        long measuredBuckets,
        int gaps,
        int resolutionMinutes) {
}
