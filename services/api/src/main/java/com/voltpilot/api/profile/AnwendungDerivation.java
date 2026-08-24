package com.voltpilot.api.profile;

import java.util.LinkedHashSet;
import java.util.Set;

/**
 * Die Aktivierungs- und Voraussetzungs-REGELN der Anwendungen — rein, ohne
 * Datenbank, ohne Spring, ohne Uhr (das {@code Tagesprotokoll}/{@code FleetPflege}-
 * Muster), damit sie Docker-frei gegen die geteilten Vektoren laufen können.
 *
 * <p><b>Warum das hier Code bleibt und nicht in den Katalog wandert</b> (Scout
 * §3.2): der Katalog beschreibt, WAS eine Anwendung ist; ob eine Anlage sie von
 * selbst aktiviert, ist eine Regel über Signale. Sie hat einen ZWILLING im
 * Portal ({@code frontend/portal/src/anwendungen.ts derivedAnwendungen} und, für
 * die vier Geschäfts-Anwendungen, {@code surface.ts activeModes}); beide Seiten
 * fahren dieselben Vektoren aus
 * {@code docs/contracts/v2/anwendung-vectors.json} — <b>Regeln und Vektoren
 * zusammen ändern</b> (das {@code usage-profile-vectors.json}-Muster).
 *
 * <p><b>Die zwei Ehrlichkeitsregeln, an denen die Klasse hängt:</b>
 * <ul>
 *   <li><b>Der Server erfindet keine Regel.</b> {@code verbraucher} gilt als
 *       abgeleitet aktiv, sobald ein AKTIVER Flow den generierten
 *       Verbraucher-Executor {@code vp.consumer.reactive} trägt — das ist
 *       beweisbar. {@code ueberschuss} wird <b>nie</b> abgeleitet: eine
 *       Überschuss-Regel und eine Zeitplan-Regel entstehen beide im
 *       Verbraucher-Baukasten und sind serverseitig nur an ihrem
 *       Bedingungsbaum zu unterscheiden — daraus einen Zustand zu behaupten,
 *       wäre eine Erfindung. Ihr Schalter ist deshalb reine Absicht.</li>
 *   <li><b>„Noch keine Regel" wird nur BELEGT gesagt.</b>
 *       {@link #hasCustomerRule} ist wahr, sobald die Anlage einen aktiven Flow
 *       OHNE Strategie-Knoten hat (eine Kunden-Automation). Nur wenn es keinen
 *       einzigen gibt, darf der Leer-Zustand einer eingeschalteten
 *       Regel-Anwendung behauptet werden.</li>
 * </ul>
 */
public final class AnwendungDerivation {

    /** Der generierte Verbraucher-Executor (D-19) — der Beleg für eine Regel. */
    public static final String NODE_CONSUMER_REACTIVE = "vp.consumer.reactive";

    /** Die Voraussetzungs-Ids, die {@link #requirementMet} kennt. */
    public static final String REQ_MESSWERT = "messwert";
    public static final String REQ_SPEICHER = "speicher";
    public static final String REQ_PV = "pv";
    public static final String REQ_STEUERBARES_GERAET = "steuerbares-geraet";
    public static final String REQ_MARKTZUGANG = "marktzugang";
    public static final String REQ_LEISTUNGSPREIS = "leistungspreis";
    public static final String REQ_LEISTUNGSMESSUNG = "leistungsmessung";
    public static final String REQ_LADEPUNKT = "ladepunkt";
    public static final String REQ_ANSCHLUSSGRENZE = "anschlussgrenze";

    /**
     * Alles, woraus eine Anwendung abgeleitet wird — die Schnittmenge dessen,
     * was Server und Portal beide besitzen. Genau diese Felder stehen in den
     * geteilten Vektoren.
     *
     * @param hasStorage              die Anlage misst einen Speicher
     * @param hasPv                   die Anlage misst PV-Erzeugung
     * @param hasControllableConsumer ≥ 1 steuerbarer Verbraucher (nicht-leeres
     *                                {@code actuate})
     * @param hasChargePoint          ≥ 1 Ladepunkt ({@code ev-charger})
     * @param hasMeasurement          ≥ 1 Komponente mit einem Messwert
     * @param hasLeistungspreis       ein Leistungspreis ist hinterlegt
     * @param hasGridLimit            eine Anschlussgrenze ist hinterlegt
     * @param activeNodeTypes         die Knotentypen der AKTIVEN Flows
     * @param hasCustomerRule         ≥ 1 aktiver Flow OHNE Strategie-Knoten
     * @param plantKind               {@code direktvermarktung} | …
     * @param tarifArt                {@code dynamisch} | {@code fest} | {@code ohne}
     * @param netzladenErlaubt        der EEG-Schalter der Anlage
     */
    public record Input(boolean hasStorage, boolean hasPv, boolean hasControllableConsumer,
            boolean hasChargePoint, boolean hasMeasurement, boolean hasLeistungspreis,
            boolean hasGridLimit, Set<String> activeNodeTypes, boolean hasCustomerRule,
            String plantKind, String tarifArt, boolean netzladenErlaubt) {

        public Input {
            activeNodeTypes = activeNodeTypes == null ? Set.of() : Set.copyOf(activeNodeTypes);
        }

        boolean carries(String nodeType) {
            return nodeType != null && activeNodeTypes.contains(nodeType);
        }

        boolean isDirektvermarktung() {
            return "direktvermarktung".equals(plantKind);
        }

        boolean isDynamicTariff() {
            return "dynamisch".equals(tarifArt);
        }

        /** Marktzugang = dynamischer Tarif und/oder Direktvermarktung (OPEN(O1)). */
        public boolean hasMarketAccess() {
            return isDynamicTariff() || isDirektvermarktung();
        }
    }

    private AnwendungDerivation() {}

    /**
     * Aktiviert die Ableitung allein diese Anwendung? Der abgeleitete Wert wird
     * nie gespeichert (die AE7-Regel) — er wird bei jedem Lesen neu bestimmt.
     */
    public static boolean derivedActive(String anwendungId, Input in) {
        if (anwendungId == null) {
            return false;
        }
        switch (anwendungId) {
            case AnwendungKatalog.MONITORING:
                // Jede Anlage wird beobachtet. Ob schon Werte ankommen, sagt der
                // Voraussetzungs-Chip - eine Anlage, die "Monitoring: aus" liest,
                // wäre eine Falschaussage über die Plattform.
                return true;
            case AnwendungKatalog.SPEICHER_FAHRPLAN:
                // Der Optimierer plant für JEDE Speicher-Anlage alle 15 Minuten -
                // auch für eine reine Eigenverbrauchs-Anlage mit festem Tarif.
                return in.hasStorage();
            case AnwendungKatalog.UEBERSCHUSS:
                // Bewusst NIE abgeleitet: siehe Klassen-Javadoc.
                return false;
            case AnwendungKatalog.VERBRAUCHER:
                return in.carries(NODE_CONSUMER_REACTIVE);
            case AnwendungKatalog.MARKTVERMARKTUNG:
                return in.isDirektvermarktung()
                        || (in.netzladenErlaubt() && in.isDynamicTariff())
                        || in.carries(UsageProfileDeriver.NODE_MARKET);
            case AnwendungKatalog.LASTSPITZENKAPPUNG:
                return in.hasLeistungspreis() || in.carries(UsageProfileDeriver.NODE_PEAKSHAVING);
            case AnwendungKatalog.ATYPISCHE_NETZNUTZUNG:
                return in.carries(UsageProfileDeriver.NODE_ATYPICAL_GRID);
            case AnwendungKatalog.LASTMANAGEMENT:
                // Es gibt keinen Strategie-Knoten: der Verteiler LÄUFT auf der
                // Box, sobald eine Säule da ist. Eine Anlage, die Autos lädt,
                // deren Karte aber "aus" sagt, wäre eine Falschaussage über eine
                // laufende Anlage.
                return in.hasChargePoint();
            default:
                return false;
        }
    }

    /** Die Menge der abgeleitet aktiven Anwendungen, kanonisch geordnet. */
    public static Set<String> derivedActive(Iterable<String> anwendungIds, Input in) {
        Set<String> active = new LinkedHashSet<>();
        for (String id : anwendungIds) {
            if (derivedActive(id, in)) {
                active.add(id);
            }
        }
        return active;
    }

    /**
     * Ist diese Voraussetzung erfüllt? Ein UNBEKANNTER Voraussetzungs-Name gilt
     * als NICHT erfüllt — eine Voraussetzung, die niemand prüfen kann, darf nie
     * als Häkchen erscheinen.
     */
    public static boolean requirementMet(String requirementId, Input in) {
        if (requirementId == null) {
            return false;
        }
        switch (requirementId) {
            case REQ_MESSWERT:
                return in.hasMeasurement();
            case REQ_SPEICHER:
                return in.hasStorage();
            case REQ_PV:
                return in.hasPv();
            case REQ_STEUERBARES_GERAET:
                return in.hasControllableConsumer();
            case REQ_MARKTZUGANG:
                return in.hasMarketAccess();
            case REQ_LEISTUNGSPREIS:
            case REQ_LEISTUNGSMESSUNG:
                return in.hasLeistungspreis();
            case REQ_LADEPUNKT:
                return in.hasChargePoint();
            case REQ_ANSCHLUSSGRENZE:
                return in.hasGridLimit();
            default:
                return false;
        }
    }
}
