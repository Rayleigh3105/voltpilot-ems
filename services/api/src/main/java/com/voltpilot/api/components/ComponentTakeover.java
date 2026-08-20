package com.voltpilot.api.components;

import com.fasterxml.jackson.databind.ObjectMapper;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import java.util.Set;
import java.util.UUID;

/**
 * Die ÜBERNAHME-REGEL: ein Gerät, das eine Zeile sucht, bekommt die VERWAISTE
 * Zeile desselben Geräts - nicht eine zweite daneben.
 *
 * <h2>Wofür es sie gibt</h2>
 *
 * <p>Der Live-Fall (Anlage Pilsting/Herzogau, 20.08.2026, Captain: „beim neu
 * hinzufügen sind die Aliase jetzt weg"): nach dem Identitäts-Riss meldeten sich
 * dieselben Wechselrichter unter NEUEN Quellen-Kennungen. Die Bestands-Übernahme
 * fand unter der neuen Kennung keine gepinnte Zeile, die von der Plattform
 * komponierte Zeile war schon an eine andere Kennung gepinnt - und legte
 * daraufhin eine ZWEITE Komponente an, mit dem vom Gerät gemeldeten Namen. Der
 * KUNDENNAME („Fronius Anlage WR1") blieb auf der verwaisten Zeile daneben
 * liegen, und die kWp der Anlage zählten doppelt. Derselbe Riss klafft im
 * Anlege-Assistenten: „Komponente hinzufügen" legte immer eine neue Erzeuger-Zeile
 * an, auch wenn daneben genau dieses Gerät verwaist lag.
 *
 * <p>Diese Klasse ist die gemeinsame Regel beider Schreibwege. Sie ist die
 * SCHWESTER von {@link ComponentRebind}, nicht ihr Ersatz: der Re-Pin heilt eine
 * Bindung, deren Anbindung wir gespeichert haben; diese Regel entscheidet, in
 * WELCHE Zeile ein Gerät geschrieben wird, und sie kommt auch mit Zeilen zurecht,
 * die (noch) gar keine gespeicherte Anbindung tragen - genau die U2-adoptierten
 * Zeilen, die der Re-Pin per Konstruktion nicht wiedererkennen kann.
 *
 * <h2>Die Leiter, und warum jede Sprosse existiert</h2>
 *
 * <p>Genommen wird die ERSTE Sprosse, die GENAU EINE freie Zeile trifft. Trifft
 * eine Sprosse mehrere, wird NICHTS entschieden und die nächste NICHT versucht -
 * eine Mehrdeutigkeit auf einer starken Sprosse wird von einer schwächeren nicht
 * besser (die Lehre aus der Doppel-Adoption {@code vp-vier-erzeuger-p9}).
 *
 * <ol>
 *   <li><b>Die MaStR-Referenz.</b> Der stärkste Schlüssel, den es gibt: vom
 *       Betreiber gepflegt, bundesweit eindeutig, und er überlebt jeden
 *       Kennungs-Riss.</li>
 *   <li><b>Der Anbindungs-Fingerabdruck</b> ({@link ComponentRebind#fingerprint}
 *       - dieselbe Funktion, kein Zwilling): Rolle + Kommunikationsart + die
 *       ganze kanonisierte Verbindung. Zwei Geräte können nicht dieselbe
 *       Transportadresse haben.</li>
 *   <li><b>Marke + Modell auf einer BELEGT verwaisten Zeile OHNE gespeicherte
 *       Anbindung.</b> Die schwächste Sprosse, und sie ist bewusst eng: nur eine
 *       Zeile, die einen Pin HATTE und ihn verloren hat (ein nie gepinnter Punkt
 *       ist frisch, nicht gestrandet), und nur, wenn wir über ihre Anbindung
 *       nichts wissen - eine gespeicherte, ABWEICHENDE Anbindung ist der Beweis,
 *       dass es ein anderes Gerät ist.</li>
 * </ol>
 *
 * <p><b>FREI</b> heißt: die Zeile trägt keinen Pin, oder ihr Pin zeigt auf eine
 * Kennung, die die Box nicht (mehr) meldet. Eine LEBENDE Bindung wird nie
 * angefasst - dieselbe erste Regel wie beim Re-Pin.
 *
 * <p>Rein: keine Datenbank, kein Broker, keine Uhr - das
 * {@code ComponentRebind}/{@code Tagesprotokoll}-Muster.
 */
public final class ComponentTakeover {

    /** Eine Komponente der Anlage, wie beide Schreibwege sie sehen. */
    public record Existing(UUID pointId, String role, String brand, String model,
            String communication, String connectionJson, String registryUnitId,
            String edgeSourceId) {}

    /** Das Gerät, das eine Zeile sucht (gemeldet oder im Assistenten eingegeben). */
    public record Incoming(String role, String brand, String model, String communication,
            String connectionJson, String registryUnitId) {}

    private ComponentTakeover() {
    }

    /**
     * Die EINE freie Zeile, die dieses Gerät übernehmen soll - oder {@code null},
     * wenn es keine gibt oder die Zuordnung mehrdeutig wäre.
     *
     * @param components       ALLE Zeilen der Anlage
     * @param reportedSourceIds die Kennungen, die die Box gerade meldet. LEER
     *                          heißt „die Box hat sich nicht geäußert" - dann
     *                          gilt keine gepinnte Zeile als verwaist, denn
     *                          Schweigen beweist nichts.
     */
    public static UUID match(List<Existing> components, Set<String> reportedSourceIds,
            Incoming incoming, ObjectMapper mapper) {
        if (components == null || components.isEmpty() || incoming == null
                || blank(incoming.role())) {
            return null;
        }
        Set<String> reported = reportedSourceIds == null ? Set.of() : reportedSourceIds;
        List<Existing> free = new ArrayList<>();
        for (Existing c : components) {
            if (c == null || !incoming.role().equals(c.role())) {
                continue;
            }
            if (isFree(c, reported)) {
                free.add(c);
            }
        }
        if (free.isEmpty()) {
            return null;
        }

        // 1 - die MaStR-Referenz.
        if (!blank(incoming.registryUnitId())) {
            UUID hit = unique(free, c -> normalized(c.registryUnitId())
                    .equals(normalized(incoming.registryUnitId())));
            if (hit != null) {
                return hit;
            }
        }

        // 2 - der Anbindungs-Fingerabdruck (die geteilte Funktion, kein Zwilling).
        String want = ComponentRebind.fingerprint(incoming.role(), incoming.communication(),
                incoming.connectionJson(), mapper);
        if (want != null) {
            UUID hit = unique(free, c -> want.equals(ComponentRebind.fingerprint(c.role(),
                    c.communication(), c.connectionJson(), mapper)));
            if (hit != null) {
                return hit;
            }
        }

        // 3 - Marke + Modell auf einer belegt verwaisten Zeile ohne Anbindung.
        if (!blank(incoming.brand()) && !blank(incoming.model())) {
            return unique(free, c -> blank(c.connectionJson())
                    && !blank(c.edgeSourceId())
                    && !reported.contains(c.edgeSourceId())
                    && normalized(c.brand()).equals(normalized(incoming.brand()))
                    && normalized(c.model()).equals(normalized(incoming.model())));
        }
        return null;
    }

    /**
     * Ohne Pin, oder mit einem Pin, den die Box nicht meldet. Meldet die Box gar
     * nichts, ist nur eine Zeile OHNE Pin frei - „nicht gemeldet" wäre dann keine
     * Aussage über die Zeile, sondern über die Box.
     */
    private static boolean isFree(Existing c, Set<String> reported) {
        if (blank(c.edgeSourceId())) {
            return true;
        }
        return !reported.isEmpty() && !reported.contains(c.edgeSourceId());
    }

    /** Genau ein Treffer gewinnt; keiner oder mehrere entscheiden nichts. */
    private static UUID unique(List<Existing> free, java.util.function.Predicate<Existing> hit) {
        UUID found = null;
        for (Existing c : free) {
            if (!hit.test(c)) {
                continue;
            }
            if (found != null) {
                return null; // mehrdeutig - lieber sichtbar verwaist als falsch verbunden
            }
            found = c.pointId();
        }
        return found;
    }

    private static boolean blank(String s) {
        return s == null || s.isBlank();
    }

    /** Schreibweisen desselben Sachverhalts sollen gleich aussehen. */
    private static String normalized(String s) {
        return s == null ? "" : s.trim().toLowerCase(Locale.ROOT);
    }
}
