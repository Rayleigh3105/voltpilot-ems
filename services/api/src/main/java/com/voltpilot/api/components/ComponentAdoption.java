package com.voltpilot.api.components;

import com.voltpilot.api.entities.EntityObservedRepository.EdgeLink;
import com.voltpilot.api.entities.EntityObservedRepository.ObservedRow;
import com.voltpilot.api.web.dto.ComponentTemplateDto;
import java.math.BigDecimal;
import java.util.ArrayList;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.Set;

/**
 * Die REINE Regel der Bestands-Übernahme (Einheitsmodell Stufe 2, Konzept
 * vp-komponenten-einheit-h2 §4.2): entscheidet aus dem GEMELDETEN Ist einer
 * box-verwalteten Anlage, ob es vollständig genug ist, um es als Soll zu
 * übernehmen - und wenn ja, welche Komponenten daraus entstehen.
 *
 * <p>Keine Datenbank, kein Broker, keine Uhr - das
 * {@code Tagesprotokoll}/{@code FleetPflege}/{@code RolloutStates}-Muster. Jede
 * Regel, die eine Übernahme VERHINDERN kann, liegt hier und ist ohne einen
 * einzigen Container prüfbar; {@link ComponentAdoptionService} ist nur noch
 * Verdrahtung.
 *
 * <h2>Die fünf Regeln, und warum jede existiert</h2>
 *
 * <ul>
 *   <li><b>ALLES ODER NICHTS.</b> Entweder wird die GANZE Anlage übernommen oder
 *       gar nichts. Ein halbes Soll wäre schlimmer als keines: der Applier auf
 *       der Box leitet die Quellenliste VOLLSTÄNDIG aus dem Push ab, ein
 *       fehlender Eintrag würde ein laufendes Messgerät also nicht „auslassen",
 *       sondern ENTFERNEN.</li>
 *   <li><b>Ohne Verbindung keine Übernahme.</b> Ein Eintrag ohne Transport +
 *       Verbindungsfelder ist der Bericht eines ÄLTEREN Box-Stands. Daraus ein
 *       Soll zu bauen hieße, die Adresse des Lesepfads einer Live-Anlage zu
 *       raten - genau das, wogegen die Verbindungstest-Pflicht der Stufe 1
 *       gebaut wurde.</li>
 *   <li><b>Nur bekannte Geräte.</b> Marke + Modell müssen im Vorlagen-Register
 *       stehen. Ohne Vorlage gäbe es kein {@code template_ref}, also keine
 *       Herkunft und keine Feld-Definition - die Komponente wäre im Portal nicht
 *       bearbeitbar, und der eine Anlege-Weg hätte eine Zeile, die er nicht
 *       öffnen kann.</li>
 *   <li><b>Keine erfundene Geräteart.</b> Eine gemeldete Rolle wird nur
 *       übernommen, wenn ihr Entitätstyp EINDEUTIG ist. Ein Verbraucher kann
 *       Wallbox, Heizstab oder allgemeine Last sein - das ist eine
 *       Mensch-Entscheidung (so fragt es der U2-Übernahme-Dialog auch), und
 *       raten hieße, eine Kundenanlage falsch zu etikettieren.</li>
 *   <li><b>Ein Wechselrichter.</b> Zwei gemeldete Wechselrichter sind auf der
 *       Box nicht entscheidbar (der Applier lehnt sie dort ebenfalls ab), also
 *       wird hier gar nicht erst ein widersprüchliches Soll gebaut.</li>
 * </ul>
 *
 * <p><b>Was diese Klasse ausdrücklich NICHT prüft:</b> ob die Anlage ein
 * eindeutiges Gateway-Gerät hat und ob die Wechselrichter-Zeile existiert - das
 * sind Datenbank-Fakten, die der Dienst vorher klärt. Hier geht es nur um den
 * BERICHT.
 */
public final class ComponentAdoption {

    /** Der Ausgang einer Prüfung. Genau einer, nie eine Mischung. */
    public enum Verdict {
        /** Das Ist ist vollständig - die Anlage kann übernommen werden. */
        ADOPTABLE,
        /** Die Anlage ist bereits portal-verwaltet; hier ist nichts zu tun. */
        ALREADY_PORTAL,
        /** Die Box hat sich zu ihrer Geräte-Einrichtung noch nie geäußert. */
        NO_REPORT,
        /**
         * Der Bericht nennt Geräte, aber ohne Verbindungsfelder - der typische
         * ältere Box-Stand. „Noch nicht möglich", nie „diese Anlage hat keine
         * Verbindungen".
         */
        INCOMPLETE_REPORT,
        /** Ein gemeldetes Gerät steht nicht im Vorlagen-Register. */
        UNKNOWN_DEVICE,
        /** Eine gemeldete Rolle hat keine eindeutige Geräteart. */
        UNMAPPABLE_ROLE,
        /** Der Bericht nennt zwei Wechselrichter. */
        AMBIGUOUS_INVERTER
    }

    /**
     * Eine übernommene Komponente: das gemeldete Ist plus die Vorlage, aus der
     * ihre Definition entsteht. {@code edgeSourceId} ist {@code null} für den
     * Wechselrichter (er ist keine Quelle, sondern die Auswahl der Box).
     */
    public record Item(String edgeSourceId, String role, String entityType, String label,
            String connectionJson, Integer intervalS, BigDecimal capacityKwp,
            String registryUnitId, ComponentTemplateDto template) {}

    /** Das Ergebnis: ein Urteil, ein deutscher Grund, und - wenn übernehmbar - die Liste. */
    public record Plan(Verdict verdict, String reason, List<Item> items) {

        public boolean adoptable() {
            return verdict == Verdict.ADOPTABLE;
        }
    }

    /**
     * Die Vorlagen-Auflösung. Als Funktion hereingereicht, damit diese Klasse
     * ohne Datenbank prüfbar bleibt.
     */
    @FunctionalInterface
    public interface TemplateLookup {
        Optional<ComponentTemplateDto> find(String brand, String model);
    }

    /** Die Rollen, deren Geräteart eindeutig ist. */
    private static final Map<String, String> ROLE_ENTITY_TYPE = Map.of(
            ComponentService.ROLE_INVERTER, "battery-hybrid",
            ComponentService.ROLE_ERZEUGER, "producer",
            ComponentService.ROLE_NETZ, "grid-meter");

    /** Die Kennung, unter der die Box ihre Wechselrichter-AUSWAHL meldet. */
    public static final String INVERTER_ENTRY_ID = "inverter";

    private ComponentAdoption() {
    }

    /**
     * Prüft den gemeldeten Stand einer Anlage.
     *
     * @param authority der gespeicherte Autoritäts-Zustand der Anlage
     * @param observed  ALLE beobachteten Zeilen der Anlage (nur {@code local}
     *                  wird betrachtet)
     * @param templates die Vorlagen-Auflösung über Marke + Modell
     */
    public static Plan decide(String authority, List<ObservedRow> observed,
            TemplateLookup templates) {
        if (ComponentAuthority.isPortalManaged(authority)) {
            return refuse(Verdict.ALREADY_PORTAL,
                    "Diese Anlage wird bereits im Portal verwaltet.");
        }
        List<ObservedRow> local = observed.stream()
                .filter(r -> "local".equals(r.source()))
                .toList();
        if (local.isEmpty()) {
            return refuse(Verdict.NO_REPORT,
                    "Diese Anlage hat noch nicht gemeldet, welche Geräte auf ihr eingerichtet "
                            + "sind.");
        }

        List<Item> items = new ArrayList<>();
        Set<String> seenSourceIds = new LinkedHashSet<>();
        int inverters = 0;
        for (ObservedRow row : local) {
            EdgeLink link = row.edgeLink();
            if (link == null || !link.complete()) {
                // Genau HIER bleibt eine Bestandsanlage mit alter Box-Software
                // stehen: sie meldet Marke und Modell, aber nicht, wie sie ihr
                // Gerät erreicht. Das ist kein Fehler, sondern ein Software-Stand.
                return refuse(Verdict.INCOMPLETE_REPORT,
                        "Diese Anlage meldet noch nicht, wie ihre Geräte angebunden sind. "
                                + "Die Übernahme ins Portal ist möglich, sobald die Box "
                                + "aktualisiert wurde.");
            }
            boolean isInverter = INVERTER_ENTRY_ID.equals(stripLocal(row.entityId()))
                    || "inverter".equals(row.entityType());
            String role = isInverter ? ComponentService.ROLE_INVERTER : trim(row.edgeRole());
            if (isInverter) {
                inverters++;
                if (inverters > 1) {
                    return refuse(Verdict.AMBIGUOUS_INVERTER,
                            "Diese Anlage meldet zwei Wechselrichter. Welcher der führende ist, "
                                    + "lässt sich nicht entscheiden.");
                }
            }
            String entityType = ROLE_ENTITY_TYPE.get(role);
            if (entityType == null) {
                return refuse(Verdict.UNMAPPABLE_ROLE, "Für ein gemeldetes Gerät (" + label(row)
                        + ") lässt sich die Geräteart nicht eindeutig bestimmen.");
            }
            Optional<ComponentTemplateDto> template =
                    templates.find(trim(row.edgeBrand()), trim(row.edgeModel()));
            if (template.isEmpty()) {
                return refuse(Verdict.UNKNOWN_DEVICE, "Ein gemeldetes Gerät (" + label(row)
                        + ") steht noch nicht in unserem Geräte-Verzeichnis.");
            }
            String sourceId = isInverter ? null : stripLocal(row.entityId());
            if (sourceId != null && !seenSourceIds.add(sourceId)) {
                // Kann nur passieren, wenn ein Bericht dieselbe Quelle doppelt
                // nennt. Zwei Komponenten auf EINE Quelle zu pinnen verletzt den
                // Eindeutigkeits-Index und wäre ein 500er beim Schreiben.
                return refuse(Verdict.UNMAPPABLE_ROLE,
                        "Der Bericht nennt ein Gerät doppelt (" + sourceId + ").");
            }
            items.add(new Item(sourceId, role, entityType, trim(row.label()),
                    link.connectionJson(), link.intervalS(), link.capacityKwp(),
                    trim(link.registryUnitId()), template.get()));
        }
        return new Plan(Verdict.ADOPTABLE, null, List.copyOf(items));
    }

    private static Plan refuse(Verdict verdict, String reason) {
        return new Plan(verdict, reason, List.of());
    }

    /**
     * Die gemeldete Quellen-Kennung. Der Zuhörer legt sie als {@code local:<id>}
     * ab, damit sie nie mit einer Entitäts-UUID kollidiert.
     */
    private static String stripLocal(String entityId) {
        if (entityId == null) {
            return "";
        }
        return entityId.startsWith("local:") ? entityId.substring("local:".length()) : entityId;
    }

    /** Ein Gerät für eine Fehlermeldung benennen - nie eine nackte Kennung. */
    private static String label(ObservedRow row) {
        String l = trim(row.label());
        if (l != null) {
            return l;
        }
        String brand = trim(row.edgeBrand());
        String model = trim(row.edgeModel());
        if (brand != null && model != null) {
            return brand + " " + model;
        }
        return brand != null ? brand : stripLocal(row.entityId());
    }

    private static String trim(String raw) {
        if (raw == null) {
            return null;
        }
        String t = raw.trim();
        return t.isEmpty() ? null : t;
    }
}
