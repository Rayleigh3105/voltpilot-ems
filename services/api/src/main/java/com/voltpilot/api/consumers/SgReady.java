package com.voltpilot.api.consumers;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.node.ArrayNode;
import com.fasterxml.jackson.databind.node.JsonNodeFactory;
import com.fasterxml.jackson.databind.node.ObjectNode;
import java.math.BigDecimal;
import java.math.RoundingMode;
import java.util.ArrayList;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Set;

/**
 * Die SG-Ready-Wärmepumpe als eigener Verbrauchertyp (Verbrauchsmanagement v1,
 * Paket P8; Konzept {@code vp-verbrauchsmgmt-konzept-v1} §3.1/§3.3/§3.4/§3.5,
 * Captain-Entscheid <b>E9 = nur Zustand 3 „Anlaufempfehlung", ein Relais</b>).
 *
 * <p><b>⚠ DIE TRAGENDE AUSSAGE: es wird eine FREIGABE geschaltet, kein Gerät.</b>
 * Ein potentialfreier Relais-Kontakt liegt auf dem SG-Ready-Eingang 2 der
 * Wärmepumpe: offen = Zustand 2 „Normalbetrieb", geschlossen = Zustand 3
 * „Anlaufempfehlung". Ob die Pumpe daraufhin anläuft und mit welcher Leistung,
 * entscheidet <em>sie</em> - VoltPilot kann es weder befehlen noch messen.
 * Daraus folgt alles Weitere:
 *
 * <ul>
 *   <li><b>Der Nachweis ist {@link #CONFIRMATION_CHANNEL} {@code freigabe}</b> -
 *       eine eigene D3-Stufe neben gemessen/integriert/angenommen. Der
 *       Relais-Rücklesewert belegt, dass die Freigabe GESETZT war; er belegt
 *       keine einzige kWh. Ohne diese Stufe hätte
 *       {@code ConsumerService.confirmationChannelFor} {@code relay_state} und
 *       damit „angenommen (Nennleistung × Zeit)" abgeleitet - eine erfundene
 *       Energie über ein Gerät, dessen Verbrauch wir gar nicht kennen.</li>
 *   <li><b>Die Nennleistung ist OPTIONAL</b> ({@link #ratedPowerOptional}):
 *       sie ist eine Angabe ÜBER die Wärmepumpe, kein Steuerwert. Sie zu
 *       verlangen zwänge den Kunden, eine Zahl zu erfinden, die niemand
 *       benutzen darf.</li>
 *   <li><b>Es gibt kein ZIEL</b> ({@link #findings}): „bis Uhrzeit fertig" und
 *       „Laufzeit bis Uhrzeit" setzen voraus, dass wir den Lauf erzwingen und
 *       nachweisen können. Beides trifft hier nicht zu, also wird ein
 *       Frist-Ziel serverseitig ABGELEHNT statt still zu einer Zusage zu
 *       werden, die die Anlage nicht halten kann.</li>
 *   <li><b>Das Ziel ist immer {@code on_off}</b> - ein kW-/Prozent-Sollwert
 *       hätte auf einem Freigabe-Kontakt keine Bedeutung.</li>
 * </ul>
 *
 * <p>Die Klasse ist REIN (kein Spring, keine DB, keine Uhr) - das
 * {@code Tagesprotokoll}/{@code FleetPflege}-Muster -, damit die Regeln ohne
 * Container prüfbar sind. Sie ist bewusst SG-Ready-scharf geschnitten: der
 * allgemeine Steuerart-Dialog (Paket P2) hängt den Typ nur noch ein, statt hier
 * eine zweite Steuerart-Wahrheit zu bauen.
 *
 * <p><b>Nicht gebaut (E9):</b> Zustand 4 „Anlaufbefehl" (Eingang 1+2 - er
 * ZWINGT die Pumpe und braucht die Freigabe des Herstellers je Modell) und
 * Zustand 1 „Sperre" (die EVU-Sperre gehört dem Netzbetreiber).
 */
public final class SgReady {

    /** Der Katalogtyp ({@code entitytypes/catalog.json}). */
    public static final String TYPE = "heat-pump-sgready";

    /**
     * Die eigene D3-Stufe: das Relais belegt die FREIGABE, nie einen Verbrauch.
     * Ein Wort außerhalb von energy/power - {@code ConsumerRequirementLedgerWriter
     * .levelFor} bildet es auf {@link ConsumerRequirementLedger.EnergyConfirmation#FREIGABE}
     * ab, und die erzeugt niemals eine Energie-Zahl.
     */
    public static final String CONFIRMATION_CHANNEL = "freigabe";

    /** Die Quelle „Freigabe bei Überschuss" (§3.1). */
    public static final String QUELLE_UEBERSCHUSS = "freigabe_ueberschuss";
    /** Die Quelle „Freigabe bei günstigem Strom" (§3.1). */
    public static final String QUELLE_GUENSTIG = "freigabe_guenstig";

    /** Die zwei - und nur die zwei - Steuerart-Quellen dieses Typs (§3.1). */
    public static final List<String> QUELLEN = List.of(QUELLE_UEBERSCHUSS, QUELLE_GUENSTIG);

    /** Vorgabe der Folgefrage „Schwelle" (§3.2): 2 kW Überschuss. */
    public static final BigDecimal SCHWELLE_KW_VORGABE = new BigDecimal("2");
    /** Vorgabe der Folgefrage „Mindestfreigabe" (§3.2): 30 min. */
    public static final int MINDESTFREIGABE_MINUTEN = 30;
    /** Vorgabe der Folgefrage „Sperrzeit danach" (§3.2, aus dem WP-Handbuch): 20 min. */
    public static final int SPERRZEIT_MINUTEN = 20;
    /** Vorgabe der Preisgrenze der Quelle „günstig" (ct/kWh). */
    public static final BigDecimal PREISGRENZE_CT_VORGABE = new BigDecimal("15");

    /** Das lokale Signal der Überschuss-Quelle. */
    static final String SIGNAL_UEBERSCHUSS = "site.pv_surplus_kw";
    /** Das Cloud-Signal der Günstig-Quelle. */
    static final String SIGNAL_PREIS = "market.import_price_ct_kwh";
    /** Frische-Fenster des lokalen Signals (§3.3). */
    static final int MAX_AGE_S = 120;
    /** Hysterese des lokalen Signals: Rückfall auf 0,75 × Schwelle (§3.3). */
    static final BigDecimal HYSTERESE_FAKTOR = new BigDecimal("0.75");

    /**
     * Der Kunden-Satz zum Nachweis - er steht WÖRTLICH so im Portal
     * ({@code frontend/portal/src/consumers/questions.ts NACHWEIS_FREIGABE});
     * wer ihn hier ändert, ändert ihn dort mit.
     */
    public static final String NACHWEIS_SATZ =
            "Ohne Messung kann VoltPilot nur die Freigabe nachweisen, nicht den Verbrauch.";

    private static final JsonNodeFactory F = JsonNodeFactory.instance;

    private SgReady() {}

    /** Ob {@code entityType} die SG-Ready-Wärmepumpe ist ({@code null} = nein). */
    public static boolean is(String entityType) {
        return TYPE.equals(entityType);
    }

    /**
     * Ob dieser Typ ohne Nennleistung angelegt werden darf. Heute genau der
     * SG-Ready-Typ; jeder andere Verbraucher verlangt sie unverändert.
     */
    public static boolean ratedPowerOptional(String entityType) {
        return is(entityType);
    }

    /**
     * Der D3-Nachweiskanal dieses Typs, oder {@code null}, wenn die allgemeine
     * Ableitung gilt. Er hängt am TYP, nicht am gebundenen Gerät: auch ein
     * messender Shelly misst auf einem potentialfreien Kontakt nichts - der
     * Strom der Wärmepumpe fließt woanders.
     */
    public static String confirmationChannel(String entityType) {
        return is(entityType) ? CONFIRMATION_CHANNEL : null;
    }

    // --- Steuerart-Vorlage (§3.3) -------------------------------------------

    /**
     * Die Folgefragen-Antworten einer SG-Ready-Steuerart (§3.2). Ein
     * {@code null}-Feld nimmt die Vorgabe - nie einen erfundenen Wert.
     */
    public record Steuerart(String quelle, BigDecimal schwelleKw, BigDecimal preisgrenzeCtKwh,
            Integer mindestfreigabeMinuten, Integer sperrzeitMinuten) {

        /** Die Steuerart „Freigabe bei Überschuss" mit den Vorgaben aus §3.2. */
        public static Steuerart ueberschuss() {
            return new Steuerart(QUELLE_UEBERSCHUSS, null, null, null, null);
        }

        /** Die Steuerart „Freigabe bei günstigem Strom" mit den Vorgaben aus §3.2. */
        public static Steuerart guenstig() {
            return new Steuerart(QUELLE_GUENSTIG, null, null, null, null);
        }

        BigDecimal effektiveSchwelleKw() {
            return schwelleKw != null && schwelleKw.signum() > 0
                    ? schwelleKw : SCHWELLE_KW_VORGABE;
        }

        BigDecimal effektivePreisgrenzeCtKwh() {
            return preisgrenzeCtKwh != null ? preisgrenzeCtKwh : PREISGRENZE_CT_VORGABE;
        }

        /** Die Mindestfreigabe in Sekunden - der {@code min_on_seconds} des Profils. */
        public int mindestfreigabeSekunden() {
            int min = mindestfreigabeMinuten != null && mindestfreigabeMinuten > 0
                    ? mindestfreigabeMinuten : MINDESTFREIGABE_MINUTEN;
            return min * 60;
        }

        /** Die Sperrzeit in Sekunden - der {@code min_off_seconds} des Profils. */
        public int sperrzeitSekunden() {
            int min = sperrzeitMinuten != null && sperrzeitMinuten > 0
                    ? sperrzeitMinuten : SPERRZEIT_MINUTEN;
            return min * 60;
        }
    }

    /**
     * Die Projektion einer SG-Ready-Steuerart auf ein
     * {@code consumer-policy.schema.json}-Dokument (§3.3): {@code reactive} +
     * {@code opportunistic} + Ziel {@code on_off:true}. Nie eine Frist, nie ein
     * kW-Ziel - genau das, was {@link #findings} danach auch ablehnen würde.
     *
     * <p>⚠ Die Hysterese hängt an der Signal-KLASSE, nicht am Geschmack: das
     * lokale {@code site.pv_surplus_kw} bekommt {@code reset_value} +
     * {@code max_age_s} (eine ziehende Wolke darf die Pumpe nicht im Takt
     * schalten), das Cloud-Signal {@code market.import_price_ct_kwh} bekommt
     * KEINE - der Validator lehnt sie dort ab ({@code cloud_signal_hysteresis}).
     * Die Mindestfreigabe/Sperrzeit sind deshalb Profil-Felder
     * ({@code min_on_seconds}/{@code min_off_seconds}), kein Dokument-Feld.
     *
     * @param entityId die Entität, auf die der Server stempelt
     * @param timezone die Zone der Anlage (darf {@code null} sein)
     */
    public static ObjectNode policyDocument(String entityId, String timezone, Steuerart steuerart) {
        if (steuerart == null || !QUELLEN.contains(steuerart.quelle())) {
            throw new IllegalArgumentException("Unbekannte Steuerart für eine SG-Ready-Wärmepumpe.");
        }
        ObjectNode doc = F.objectNode();
        doc.put("schema_version", "1.0");
        doc.put("entity_id", entityId);
        if (timezone != null && !timezone.isBlank()) {
            doc.put("timezone", timezone);
        }
        ObjectNode req = F.objectNode();
        req.put("id", steuerart.quelle());
        req.put("name", QUELLE_UEBERSCHUSS.equals(steuerart.quelle())
                ? "Freigabe bei Überschuss" : "Freigabe bei günstigem Strom");
        req.put("kind", "reactive");
        req.put("enforcement", "opportunistic");
        ObjectNode cond = req.putObject("condition");
        if (QUELLE_UEBERSCHUSS.equals(steuerart.quelle())) {
            BigDecimal schwelle = steuerart.effektiveSchwelleKw();
            cond.put("signal", SIGNAL_UEBERSCHUSS);
            cond.put("operator", "gt");
            cond.put("value", schwelle);
            cond.put("reset_value",
                    schwelle.multiply(HYSTERESE_FAKTOR).setScale(3, RoundingMode.HALF_UP));
            cond.put("max_age_s", MAX_AGE_S);
        } else {
            cond.put("signal", SIGNAL_PREIS);
            cond.put("operator", "lt");
            cond.put("value", steuerart.effektivePreisgrenzeCtKwh());
        }
        ObjectNode target = req.putObject("target");
        target.put("kind", "on_off");
        target.put("value", true);
        ArrayNode reqs = doc.putArray("requirements");
        reqs.add(req);
        return doc;
    }

    // --- Validierung (§3.1: kein Ziel, kein kW-Ziel) -------------------------

    private static final Set<String> ZIEL_KINDS = new LinkedHashSet<>(
            List.of("flexible_task"));
    private static final Set<String> ZIEL_ENFORCEMENTS = new LinkedHashSet<>(
            List.of("required_by_deadline"));

    /**
     * Die TYP-scharfen Regeln über einem bereits generisch validierten
     * Dokument. Sie leben hier statt im {@link ConsumerPolicyValidator}, weil
     * der ein Dokument-Validator mit einem TS-Zwilling und geteilten Vektoren
     * ist - er kennt den Verbrauchertyp per Konstruktion nicht, und ihn dafür
     * zu erweitern würde die zwei Zwillinge auseinanderlaufen lassen.
     *
     * <p>Ein anderer Typ liefert IMMER eine leere Liste: die Regeln sind
     * additiv, ein Bestandsverbraucher ändert dadurch kein Byte.
     */
    public static List<ConsumerFinding> findings(String entityType, JsonNode doc) {
        List<ConsumerFinding> out = new ArrayList<>();
        if (!is(entityType) || doc == null || !doc.isObject()) {
            return out;
        }
        JsonNode reqs = doc.path("requirements");
        if (!reqs.isArray()) {
            return out;
        }
        for (int i = 0; i < reqs.size(); i++) {
            JsonNode r = reqs.get(i);
            String path = "$.requirements[" + i + "]";
            if (r == null || !r.isObject()) {
                continue;
            }
            String kind = r.path("kind").asText("");
            String enforcement = r.path("enforcement").asText("");
            if (ZIEL_KINDS.contains(kind) || ZIEL_ENFORCEMENTS.contains(enforcement)
                    || r.has("demand")) {
                out.add(ConsumerFinding.error("sgready_kein_ziel", path,
                        "Für eine SG-Ready-Wärmepumpe gibt es kein Ziel: VoltPilot gibt die "
                                + "Freigabe, anlaufen lässt sich die Pumpe nicht. Wählen Sie eine "
                                + "Freigabe bei Überschuss oder bei günstigem Strom."));
                continue;
            }
            String targetKind = r.path("target").path("kind").asText("");
            if (!targetKind.isEmpty() && !"on_off".equals(targetKind)) {
                out.add(ConsumerFinding.error("sgready_nur_freigabe", path + ".target.kind",
                        "Eine SG-Ready-Wärmepumpe kennt nur die Freigabe (ein/aus) - eine "
                                + "Leistung lässt sich ihr nicht vorgeben."));
            }
        }
        return out;
    }
}
