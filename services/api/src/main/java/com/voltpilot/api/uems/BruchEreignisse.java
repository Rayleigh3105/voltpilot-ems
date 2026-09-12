package com.voltpilot.api.uems;

/**
 * Welche Reihen und Viertelstunden ein SPÄTER eingegangener Bruch betrifft (UEMS AP-08 IP-4) — die
 * EINE Auswahl, mit der der Viertelstunden-Lauf und der Tages-Lauf ihre Arbeitsliste füllen
 * (Grund {@code ereignis}, V20260912221000).
 *
 * <p>Eine Gerätegrenze trägt der Kunde oft Stunden nach dem Wechsel ein, ein Neustart kommt als
 * eigene Meldung: die Rohwerte sind dann längst verdichtet, und ohne Eintrag bliebe die vorläufige
 * Periode bei „Rücksetzung“ stehen. Gelesen wird über die EINGANGSZEIT der Meldung, im selben
 * Zeiger-Fenster wie die Rohwerte.
 *
 * <ul>
 *   <li>{@code device_boundary}/{@code counter_overflow} hängen an der Komponente (ohne Messkanal:
 *       an jedem ihrer Kanäle);
 *   <li>{@code device_restart} meldet die Box je DATENQUELLE — betroffen ist jede Komponente, die
 *       diese Quelle liest (ein Controller-Neustart kostet jede Karte ihre Zählung).
 * </ul>
 *
 * <p>Betroffen sind die Viertelstunde, in der der Bruch liegt, und — liegt er genau auf der Grenze —
 * die davor: die Regel wendet einen Bruch in {@code (von, bis]} an. Die Kanäle kommen aus den
 * gebildeten Viertelstunden um den Zeitpunkt (± 1 Tag); eine Reihe ohne solche hat nichts neu zu
 * bilden, ihre Rohwerte tragen sich beim Eingang selbst ein. Eine ENDGÜLTIGE Zeile schließt der
 * Schreibsatz aus — der Nachtrag danach ist ein Vorschlag (AP-08 IP-14), nicht hier.
 */
final class BruchEreignisse {

    /** Die Arten, deren späte Ankunft eine Zählerstand-Periode ändert (Z4, Z6, Z7). */
    static final String ARTEN = "'device_boundary', 'device_restart', 'counter_overflow'";

    /**
     * {@code (tenant_id, entity_id, messkanal, beginn)} je betroffener Viertelstunde. Parameter:
     * Eingang ab (ausschließlich), Eingang bis (einschließlich), Ereigniszeit ab (Chunk-Ausschluss).
     */
    static final String VIERTELSTUNDEN = """
            WITH e AS (
                SELECT e.tenant_id, e.entity_id, e.messkanal, e.data_source_id, e.zeit
                  FROM messreihe_ereignis e
                 WHERE e.eingang > ? AND e.eingang <= ? AND e.zeit >= ?
                   AND NOT e.aus_bestand
                   AND e.art IN (""" + ARTEN + """
            )
            ), komponente AS (
                SELECT tenant_id, entity_id, messkanal, zeit FROM e WHERE entity_id IS NOT NULL
                UNION
                SELECT e.tenant_id, mp.id, NULL::text, e.zeit
                  FROM e
                  JOIN measurement_point mp
                    ON mp.tenant_id = e.tenant_id AND mp.data_source_id = e.data_source_id
                 WHERE e.entity_id IS NULL AND e.data_source_id IS NOT NULL
            )
            SELECT DISTINCT k.tenant_id, k.entity_id, v.messkanal, b.beginn
              FROM komponente k
              JOIN LATERAL (
                    SELECT DISTINCT v.messkanal
                      FROM messreihe_viertelstunde v
                     WHERE v.tenant_id = k.tenant_id AND v.entity_id = k.entity_id
                       AND (k.messkanal IS NULL OR v.messkanal = k.messkanal)
                       AND v.intervall_beginn >= k.zeit - INTERVAL '1 day'
                       AND v.intervall_beginn <= k.zeit + INTERVAL '1 day') v ON true
             CROSS JOIN LATERAL (VALUES
                    (to_timestamp(floor(extract(epoch FROM k.zeit) / 900) * 900)),
                    (to_timestamp(ceil(extract(epoch FROM k.zeit) / 900) * 900 - 900))) b(beginn)
            """;

    private BruchEreignisse() {}
}
