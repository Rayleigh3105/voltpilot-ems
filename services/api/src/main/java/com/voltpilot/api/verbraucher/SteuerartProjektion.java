package com.voltpilot.api.verbraucher;

import com.fasterxml.jackson.databind.JsonNode;
import java.math.BigDecimal;
import java.util.ArrayList;
import java.util.List;

/**
 * Die DETERMINISTISCHE INVERSE „Policy → Steuerart" (Konzept
 * {@code vp-verbrauchsmgmt-konzept-v1} §7.1/§7.2, Captain-Entscheid E2).
 *
 * <p><b>Rein: keine DB, kein Spring, keine Uhr</b> - das
 * {@code Tagesprotokoll}/{@code FleetPflege}/{@code RolloutStates}-Muster des
 * Hauses. Sie ist die EINE Stelle, die aus dem gespeicherten Format ein
 * Kundenwort macht; wer sie anfasst, faehrt die Roundtrip-Vektoren.
 *
 * <p><b>⚠ DIE LEITREGEL: was nicht EINDEUTIG ist, wird „Eigene Regel" - nie
 * geraten.</b> Es gilt die ERSTE passende Regel, und „passt" heisst: genau eine
 * aktive Anforderung dieser Form, Werte werden uebernommen. Alles andere
 * (Baeume mit UND/ODER, {@code mode}-Targets, mehrere Fenster, {@code opportunistic}
 * als Anforderungs-ART, ein Ziel mit zwei Bedarfen) faellt auf Regel 9. Diese
 * Komponente verliert dadurch NICHTS: ihre Policy bleibt unveraendert stehen
 * und die Flaeche verlinkt in den bestehenden Baukasten.
 *
 * <p><b>⚠ Regel 1 und 2 sind zwei verschiedene Aussagen.</b> Ein OCPP-Ladepunkt
 * ohne Policy folgt dem ANLAGEN-STANDARD (seine Quelle wohnt in der
 * Quellen-Bahn der Box, nicht in einer Policy); jede andere Komponente ohne
 * Policy laeuft, wie das Geraet es tut - das ist {@code sofort} und NICHT der
 * Standard eines Ladeparks, den sie gar nicht kennt.
 *
 * <p><b>Nicht implementiert, weil es den TYP noch nicht gibt:</b> die
 * SG-Ready-Woerter {@code freigabe_ueberschuss}/{@code freigabe_guenstig}
 * (Konzept §3.1). Sie entstehen erst mit dem Katalogtyp
 * {@code heat-pump-sgready} (Paket P8); eine Abbildung darauf waere heute Code
 * ohne erreichbaren Fall.
 */
public final class SteuerartProjektion {

    // --- Quellen (Konzept §3, Ids stabil) -----------------------------------
    public static final String QUELLE_SOFORT = "sofort";
    public static final String QUELLE_UEBERSCHUSS = "ueberschuss";
    public static final String QUELLE_GUENSTIG = "guenstig";
    public static final String QUELLE_FESTE_ZEITEN = "feste_zeiten";
    /** Regel 9: die Policy bleibt eine Regel, die Zeile verlinkt den Baukasten. */
    public static final String QUELLE_EIGENE_REGEL = "eigene_regel";

    // --- Ziele --------------------------------------------------------------
    public static final String ZIEL_BIS_UHRZEIT = "bis_uhrzeit";
    public static final String ZIEL_LAUFZEIT_BIS = "laufzeit_bis";

    // --- Herkunft der Projektion -------------------------------------------
    public static final String HERKUNFT_POLICY = "policy";
    public static final String HERKUNFT_STANDARD = "standard";
    public static final String HERKUNFT_OHNE = "ohne";

    // --- Ueberschuss-Modus eines Ladepunkts (§7.2) --------------------------
    public static final String MODUS_PAUSIEREN = "pausieren";
    public static final String MODUS_MINDESTLEISTUNG = "mindestleistung";

    // --- Die Woerter der Box-Quellenbahn (lastmgmt/surplus.go) --------------
    public static final String POLICY_SCHNELL = "schnell";
    public static final String POLICY_NUR_SONNE = "nur_sonne";
    public static final String POLICY_SONNE_ZUERST = "sonne_zuerst";

    private SteuerartProjektion() {}

    /**
     * §7.2: der ANLAGEN-STANDARD der Ladepunkte aus der Quellen-Wahl der Box.
     *
     * <p><b>⚠ Die Vorgabe ist {@code schnell}, nicht „Sonne zuerst".</b> Das ist
     * woertlich die Kompatibilitaets-Zusage der Box
     * ({@code lastmgmt.NormalizePolicy}): {@code PolicyFast} ist der NEUTRALE
     * Wert - keine Quellen-Kappe -, also verhaelt sich eine Anlage, deren Kunde
     * nie gewaehlt hat, byte-genau wie vorher. „Sonne zuerst" ist die Vorgabe
     * INNERHALB der Karte, nie die einer nie gefragten Anlage. Ein unbekanntes
     * Wort loest genauso auf: eine Wahl, die wir nicht lesen koennen, darf weder
     * eine Einschraenkung noch ein Versprechen erfinden.
     *
     * @param surplusPolicy {@code schnell|nur_sonne|sonne_zuerst}, {@code null}
     *                      oder unbekannt
     * @param minPowerKw    die Mindestleistung der Box; {@code null} = sie meldet
     *                      keine (nie eine 0)
     */
    public static Steuerart anlagenStandard(String surplusPolicy, BigDecimal minPowerKw) {
        String p = surplusPolicy == null ? "" : surplusPolicy.trim();
        if (POLICY_NUR_SONNE.equals(p)) {
            return new Steuerart(QUELLE_UEBERSCHUSS, HERKUNFT_STANDARD, null, null,
                    MODUS_PAUSIEREN, null, null, null, null, null, null, null);
        }
        if (POLICY_SONNE_ZUERST.equals(p)) {
            return new Steuerart(QUELLE_UEBERSCHUSS, HERKUNFT_STANDARD, null, null,
                    MODUS_MINDESTLEISTUNG, minPowerKw, null, null, null, null, null, null);
        }
        return Steuerart.quelleOnly(QUELLE_SOFORT, HERKUNFT_STANDARD);
    }

    /**
     * §7.1: die Steuerart EINER Komponente.
     *
     * @param policyDocument das Dokument der AKTIVEN Policy, oder {@code null}
     * @param istOcppLadepunkt true = eine komponierte {@code ev-charger}-Saeule,
     *                       deren Quelle die Box faehrt (Regel 1)
     * @param anlagenStandard der Standard aus §7.2 (nur fuer Regel 1 benutzt)
     */
    public static Steuerart projiziere(JsonNode policyDocument, boolean istOcppLadepunkt,
            Steuerart anlagenStandard) {
        if (policyDocument == null || policyDocument.isNull()) {
            // Regel 1 / Regel 2.
            return istOcppLadepunkt ? anlagenStandard
                    : Steuerart.quelleOnly(QUELLE_SOFORT, HERKUNFT_OHNE);
        }
        List<JsonNode> aktive = aktiveAnforderungen(policyDocument);
        if (aktive.isEmpty()) {
            // Eine Policy ohne aktive Anforderung sagt nichts - wie keine.
            return istOcppLadepunkt ? anlagenStandard
                    : Steuerart.quelleOnly(QUELLE_SOFORT, HERKUNFT_OHNE);
        }
        Steuerart quelle = null;
        Steuerart ziel = null;
        for (JsonNode r : aktive) {
            Steuerart q = alsQuelle(r);
            Steuerart z = alsZiel(r);
            if (q != null && quelle == null) {
                quelle = q;
            } else if (z != null && ziel == null) {
                ziel = z;
            } else {
                // Zwei Quellen, zwei Ziele oder eine Form, die wir nicht lesen.
                return eigeneRegel();
            }
        }
        if (quelle != null && ziel == null) {
            return quelle; // Regeln 3-6.
        }
        if (quelle == null && ziel != null) {
            // Regel 7: eine Frist ALLEIN - der Planer waehlt die billigsten
            // Slots, also ist die Quelle „Guenstige Stunden" (ohne Grenze; sie
            // steht in keinem Dokument und wird deshalb nicht erfunden).
            return Steuerart.quelleOnly(QUELLE_GUENSTIG, HERKUNFT_POLICY).mitZiel(ziel);
        }
        if (quelle != null) {
            return quelle.mitZiel(ziel); // Regel 8.
        }
        return eigeneRegel();
    }

    private static Steuerart eigeneRegel() {
        return Steuerart.quelleOnly(QUELLE_EIGENE_REGEL, HERKUNFT_POLICY);
    }

    /** Die Anforderungen, die wirklich gelten ({@code active} absent = true). */
    private static List<JsonNode> aktiveAnforderungen(JsonNode doc) {
        List<JsonNode> out = new ArrayList<>();
        JsonNode reqs = doc.path("requirements");
        if (!reqs.isArray()) {
            return out;
        }
        for (JsonNode r : reqs) {
            JsonNode active = r.get("active");
            if (active != null && active.isBoolean() && !active.asBoolean()) {
                continue;
            }
            out.add(r);
        }
        return out;
    }

    // -----------------------------------------------------------------------
    // Quellen-Formen (Regeln 3-6)
    // -----------------------------------------------------------------------

    private static Steuerart alsQuelle(JsonNode r) {
        if (!zielbaresTarget(r.path("target"))) {
            return null;
        }
        String kind = r.path("kind").asText("");
        if ("fixed_window".equals(kind)) {
            // Regel 6.
            if (!"must_run".equals(r.path("enforcement").asText(""))) {
                return null;
            }
            Steuerart.Fenster f = fenster(r.path("recurrence"));
            return f == null ? null
                    : new Steuerart(QUELLE_FESTE_ZEITEN, HERKUNFT_POLICY, null, null, null, null,
                            f, null, null, null, null, null);
        }
        if (!"reactive".equals(kind)) {
            return null;
        }
        JsonNode cond = r.path("condition");
        JsonNode blatt = einzelBlatt(cond);
        if (blatt == null) {
            return null;
        }
        String signal = blatt.path("signal").asText("");
        String op = blatt.path("operator").asText("");
        JsonNode wert = blatt.path("value");
        if ("consumer.vehicle_connected".equals(signal)) {
            // Regel 3: „Fahrzeug verbunden ⇒ ein" IST „Sofort laden".
            boolean an = "eq".equals(op) && wert.isBoolean() && wert.asBoolean();
            return an ? Steuerart.quelleOnly(QUELLE_SOFORT, HERKUNFT_POLICY) : null;
        }
        if ("site.pv_surplus_kw".equals(signal)) {
            // Regel 4.
            if ((!"gt".equals(op) && !"gte".equals(op)) || !wert.isNumber()) {
                return null;
            }
            return new Steuerart(QUELLE_UEBERSCHUSS, HERKUNFT_POLICY, wert.decimalValue(), null,
                    null, null, null, null, null, null, null, null);
        }
        if ("market.import_price_ct_kwh".equals(signal) || "market.spot_price_ct_kwh".equals(signal)) {
            // Regel 5.
            if ((!"lt".equals(op) && !"lte".equals(op)) || !wert.isNumber()) {
                return null;
            }
            return new Steuerart(QUELLE_GUENSTIG, HERKUNFT_POLICY, null, wert.decimalValue(), null,
                    null, null, null, null, null, null, null);
        }
        return null;
    }

    /**
     * Das eine Blatt, auf das eine Quellen-Form zurueckgeht.
     *
     * <p><b>⚠ Die EINE zugelassene Verknuepfung ist {@code all[Quelle,
     * vehicle_connected]}</b> (§7.1 Regel 4: „ggf. UND {@code vehicle_connected}").
     * Sie ist die Form, die der Baukasten fuer einen Ladepunkt baut - „nur
     * laden, wenn ein Auto da ist" ist keine zweite Quelle, sondern die
     * Selbstverstaendlichkeit eines Ladepunkts. Jeder andere Baum ist Regel 9.
     */
    private static JsonNode einzelBlatt(JsonNode cond) {
        if (cond == null || cond.isMissingNode() || cond.isNull()) {
            return null;
        }
        if (cond.has("signal")) {
            return cond;
        }
        JsonNode all = cond.get("all");
        if (all == null || !all.isArray() || all.size() != 2) {
            return null;
        }
        JsonNode a = all.get(0);
        JsonNode b = all.get(1);
        if (istFahrzeugBlatt(a) && !istFahrzeugBlatt(b) && b.has("signal")) {
            return b;
        }
        if (istFahrzeugBlatt(b) && !istFahrzeugBlatt(a) && a.has("signal")) {
            return a;
        }
        return null;
    }

    private static boolean istFahrzeugBlatt(JsonNode n) {
        return n != null && n.has("signal")
                && "consumer.vehicle_connected".equals(n.path("signal").asText(""))
                && "eq".equals(n.path("operator").asText(""))
                && n.path("value").isBoolean() && n.path("value").asBoolean();
    }

    // -----------------------------------------------------------------------
    // Ziel-Form (flexible_task)
    // -----------------------------------------------------------------------

    private static Steuerart alsZiel(JsonNode r) {
        if (!"flexible_task".equals(r.path("kind").asText(""))
                || !"required_by_deadline".equals(r.path("enforcement").asText(""))
                || !zielbaresTarget(r.path("target"))) {
            return null;
        }
        Steuerart.Fenster f = fenster(r.path("recurrence"));
        if (f == null) {
            return null;
        }
        JsonNode demand = r.path("demand");
        boolean energie = demand.path("energy_kwh").isNumber();
        boolean laufzeit = demand.path("runtime_minutes").isInt();
        if (energie == laufzeit) {
            // Beides oder keines: mehrdeutig - das faengt Regel 9.
            return null;
        }
        Boolean amStueck = demand.path("contiguous").isBoolean()
                ? demand.path("contiguous").asBoolean() : null;
        if (energie) {
            return new Steuerart(null, HERKUNFT_POLICY, null, null, null, null, null,
                    ZIEL_BIS_UHRZEIT, f, demand.path("energy_kwh").decimalValue(), null, amStueck);
        }
        return new Steuerart(null, HERKUNFT_POLICY, null, null, null, null, null,
                ZIEL_LAUFZEIT_BIS, f, null, demand.path("runtime_minutes").asInt(), amStueck);
    }

    /**
     * §3.3: eine Steuerart schaltet EIN bzw. faehrt eine Leistung.
     * {@code on_off:false} und {@code mode}/{@code percent} sind Regel 9 - ein
     * Aus-Ziel oder ein Geraete-Modus ist keine der sieben Steuerarten, und ihn
     * auf eine abzubilden waere geraten.
     */
    private static boolean zielbaresTarget(JsonNode target) {
        String kind = target.path("kind").asText("");
        if ("on_off".equals(kind)) {
            return target.path("value").isBoolean() && target.path("value").asBoolean();
        }
        return "kw".equals(kind) && target.path("value").isNumber();
    }

    private static Steuerart.Fenster fenster(JsonNode rec) {
        if (rec == null || !rec.isObject()) {
            return null;
        }
        String tage = rec.path("days").asText("");
        String von = rec.path("from").asText("");
        String bis = rec.path("to").asText("");
        if (tage.isEmpty() || von.isEmpty() || bis.isEmpty()) {
            return null;
        }
        return new Steuerart.Fenster(tage, von, bis);
    }
}
