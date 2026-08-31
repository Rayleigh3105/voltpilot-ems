package com.voltpilot.api.web.dto;

import com.voltpilot.api.verbraucher.Steuerart;
import java.time.Instant;
import java.util.List;
import java.util.UUID;

/**
 * Die Zone „Verbraucher" einer Anlage (Konzept
 * {@code vp-verbrauchsmgmt-konzept-v1} §6, Paket P1 - LESEND).
 *
 * <p><b>Es entsteht KEINE zweite Wahrheit.</b> Jede Zahl und jedes Wort hierin
 * ist eine PROJEKTION auf das, was schon gespeichert ist: die aktive
 * {@code consumer_policy} (→ {@link com.voltpilot.api.verbraucher.SteuerartProjektion}),
 * die Quellen-Wahl der Box in {@code site_charging_config}, der
 * {@code chargers}-Herzschlag und die Ansprueche der aktiven Flows. Es gibt in
 * diesem Paket bewusst KEINEN Schreibpfad - „Steuerart schreiben" ist P2/P4.
 *
 * <p>Nullbar heisst ueberall „das wissen wir nicht", nie 0.
 */
public record VerbraucherDto(List<Eintrag> verbraucher, Ladepunkte ladepunkte,
        List<RanglisteEintrag> rangliste) {

    /**
     * Eine steuerbare Komponente - Ladepunkt oder anderer Verbraucher.
     *
     * @param entityId    die Komponente ({@code measurement_point})
     * @param name        der vom Menschen vergebene Name; {@code null} = keiner
     *                    (die Flaeche faellt dann auf ihre eigene Kette zurueck)
     * @param typ         der Katalog-Typ ({@code ev-charger}, {@code wallbox},
     *                    {@code heating-rod}, …)
     * @param typLabel    sein Kundenwort aus dem Typkatalog
     * @param ladepunkt   true = dieser Verbraucher laedt ein Auto (OCPP-Saeule
     *                    ODER go-e/Modbus-Wallbox - fuer den Kunden EIN Ding)
     * @param chargePointId die OCPP-Kennung, wenn es eine gibt
     * @param steuerart   Quelle + optionales Ziel
     * @param regeln      wie viele AKTIVE Wenn/Dann-Flows diese Komponente
     *                    beanspruchen - die Regeln, die NICHT die Steuerart
     *                    bilden (die Policy IST die Steuerart bzw. bei
     *                    „Eigene Regel" die Regel selbst)
     * @param fortschritt der Ziel-Fortschritt aus dem Erfuellungs-Ledger, wo es
     *                    einen gibt; {@code null} = keine wiederkehrende
     *                    Anforderung oder noch kein Beleg
     * @param aktiv       {@code consumer_profile.enabled} - {@code null} fuer
     *                    eine komponierte Saeule ohne Profil
     */
    public record Eintrag(UUID entityId, String name, String typ, String typLabel,
            boolean ladepunkt, String chargePointId, Steuerart steuerart, int regeln,
            ConsumerFulfillmentDto.Task fortschritt, Boolean aktiv) {}

    /**
     * Der Ladepunkt-Abschnitt: sein Anlagen-Standard und sein physischer Rahmen.
     *
     * @param standard      die Steuerart, der ein Ladepunkt folgt, solange er
     *                      nicht abweicht (§7.2); {@code null} nur, wenn die
     *                      Anlage gar keinen Ladepunkt hat
     * @param standardFolger wie viele Ladepunkte ihm heute folgen
     * @param gesamt        wie viele Ladepunkte es gibt
     */
    public record Ladepunkte(Steuerart standard, int standardFolger, int gesamt, Rahmen rahmen) {}

    /**
     * Der LADEPARK-RAHMEN (§4.2): die physischen Grenzen des Ladens.
     *
     * <p><b>⚠ Jede Zahl kommt aus der BOX</b> ({@code device_charging_budget},
     * der {@code chargers}-Herzschlag) und wird nur weitergereicht - dieselbe
     * Quelle, aus der die Ladepunkte-Seite ihr Band zeichnet. {@code hinweis}
     * ist der SATZ der Box, woertlich; zwei Renderings desselben Urteils
     * duerften es nicht verschieden sagen.
     *
     * <p>{@code netzanschlussKw} ist der IST-Wert der Box,
     * {@code gepflegteGrenzeKw} der im Portal hinterlegte SOLL-Wert
     * ({@code site_charging_config}). Sie reisen getrennt, weil sie zwei
     * Aussagen sind; fehlen BEIDE, gibt VoltPilot keine Ladeleistung frei und
     * die Flaeche sagt genau das.
     */
    public record Rahmen(Double netzanschlussKw, Double gepflegteGrenzeKw, Double effektivGrenzeKw,
            Double hausLastKw, Double hoechsteHausLastKw, Double verteiltKw, Double budgetKw,
            Double sicherheitsabstandPct, Double mindestleistungKw, String modus, boolean blind,
            String hinweis, int steckerAnzahl, Instant gemeldetAm) {}

    /**
     * Ein Platz der Rangliste (§5).
     *
     * <p>{@code entityId} ist beim Speicher {@code null} - und ebenso bei einer
     * GRUPPE aus mehreren gleichrangigen Ladepunkten (Mockup 1440, Anmerkung
     * 22): fuer Saeulen ohne {@code consumer_profile} kann die Cloud heute nur
     * „Vorrang" und „Rest" ausdruecken, der Ganzzahl-Rang je Saeule ist Paket
     * P6. {@code mitglieder} traegt dann die Komponenten der Zeile, damit die
     * Flaeche sie beim Namen nennen kann („Stellplatz 2 · 3 · Carport").
     *
     * <p>{@code position} zaehlt GERAETE, nicht Zeilen: eine Gruppe aus drei
     * Saeulen auf Platz 6 verbraucht 6, 7 und 8, die naechste Zeile steht auf 9.
     * {@code name} ist der Anzeigename einer EINZELNEN Zeile ({@code null} bei
     * einer Gruppe) - die Flaeche muss ihn nicht zusammensetzen.
     */
    public record RanglisteEintrag(int position, String art, UUID entityId, String name,
            List<Mitglied> mitglieder) {}

    /** Eine Komponente einer Rangliste-Zeile. */
    public record Mitglied(UUID entityId, String name) {}

    /** Der ehrliche Leer-Zustand einer Anlage ohne steuerbares Geraet. */
    public static VerbraucherDto leer() {
        return new VerbraucherDto(List.of(), new Ladepunkte(null, 0, 0, null), List.of());
    }
}
