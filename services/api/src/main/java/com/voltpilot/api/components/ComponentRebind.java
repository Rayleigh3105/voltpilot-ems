package com.voltpilot.api.components;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.Iterator;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.TreeMap;
import java.util.UUID;

/**
 * Die RE-PIN-BRÜCKE: eine Komponente, deren Bindung an ihr Gerät gerissen ist,
 * findet dasselbe Gerät unter seiner neuen Kennung wieder - automatisch, beim
 * nächsten Herzschlag, ohne Klick.
 *
 * <h2>Wofür es sie gibt</h2>
 *
 * <p>Eine Quellen-Kennung der Box ist der Pin, an dem die Komponente hängt
 * ({@code measurement_point.edge_source_id}). Ändert sich diese Kennung, ohne
 * dass sich das GERÄT ändert, liest die Anlage im Portal „nicht mehr mit einem
 * gemeldeten Gerät verbunden" - und derselbe Wechselrichter meldet sich daneben
 * als „Neues Gerät gefunden". Genau das ist auf der Anlage Pilsting/Herzogau
 * beim Update edge-2026.08.5 -&gt; .10 passiert: die Bestands-Übernahme leitete
 * die Kennungen deterministisch neu ab, während die Box ihre - vor den
 * deterministischen Kennungen vergebenen - zufälligen fuhr.
 *
 * <p>Die WURZEL ist auf der Box behoben (componentapply behält die Kennung
 * eines Geräts, das dort schon läuft). Diese Klasse ist die zweite Hälfte: sie
 * heilt die Anlagen, deren Bindung schon gerissen IST - auch ohne
 * Edge-Auslieferung, denn eine Box, die den Riss bereits vollzogen hat, meldet
 * ab jetzt die neuen Kennungen.
 *
 * <h2>Die vier Regeln, und warum jede existiert</h2>
 *
 * <ul>
 *   <li><b>NUR verwaiste Pins, NUR freie Geräte.</b> Betrachtet wird
 *       ausschließlich eine Komponente, deren gepinnte Kennung KEIN gemeldetes
 *       Gerät mehr trägt, und ein gemeldetes Gerät, das KEINE Komponente pinnt.
 *       Eine lebende Bindung wird nie angefasst.</li>
 *   <li><b>NUR ein eindeutiges 1:1.</b> Trifft ein Fingerabdruck mehr als eine
 *       verwaiste Komponente oder mehr als ein freies Gerät, wird NICHTS getan
 *       und der manuelle Weg („Wieder verbinden") bleibt. Das ist die Lehre aus
 *       der Doppel-Adoption (Scout vp-vier-erzeuger-p9): eine geratene
 *       Zuordnung erzeugt einen Geister-Erzeuger, den niemand mehr auseinander
 *       bekommt.</li>
 *   <li><b>Der Fingerabdruck ist STRENGER als die Identität der Box, nicht
 *       gleich.</b> Verglichen werden Rolle, Kommunikationsart und die GANZE
 *       Verbindung (ohne die reinen Anzeige-/Kadenzfelder). Das ist bewusst
 *       KEINE zweite Wahrheit darüber, was ein Gerät IST - eine zweite
 *       Identitäts-Regel in Java würde von {@code sources.TransportIdentity}
 *       abdriften. Eine Obermenge kann höchstens einen legitimen Re-Pin
 *       verpassen (dann greift der manuelle Weg), nie einen falschen
 *       herstellen.</li>
 *   <li><b>Ohne gespeicherte Verbindung wird nichts behauptet.</b> Eine
 *       Komponente, die keine Anbindung trägt, hat nichts, woran ein Gerät
 *       wiedererkannt werden könnte - sie bleibt verwaist und sichtbar.</li>
 * </ul>
 *
 * <p>Rein: keine Datenbank, kein Broker, keine Uhr - das
 * {@code ComponentAdoption}/{@code Tagesprotokoll}-Muster.
 */
public final class ComponentRebind {

    /**
     * Verbindungsfelder, die NICHT zum Gerät gehören: die Lese-Kadenz legt der
     * Anlege-Weg (und die Übernahme) IN die gespeicherte Verbindung, die Box
     * führt sie dagegen als eigenes Quellen-Feld und meldet sie nie in der
     * Verbindung. Ohne diese Ausnahme scheiterte jeder Vergleich genau an der
     * Kopie, die wir selbst hineingeschrieben haben.
     */
    private static final Set<String> IGNORED_CONNECTION_FIELDS = Set.of("interval_s");

    /** Eine gepinnte Komponente der Anlage. */
    public record PinnedComponent(UUID pointId, String edgeSourceId, String role,
            String communication, String connectionJson, String label) {}

    /** Ein von der Box gemeldetes Gerät (eine {@code local}-Zeile). */
    public record ReportedDevice(String edgeSourceId, String role, String communication,
            String connectionJson, String label) {}

    /** Ein beschlossener Re-Pin - und der Grund, den das Protokoll trägt. */
    public record Rebind(UUID pointId, String fromSourceId, String toSourceId, String label) {}

    private ComponentRebind() {
    }

    /**
     * Entscheidet, welche Bindungen wiederhergestellt werden.
     *
     * @param pinned  ALLE Komponenten der Anlage, die einen Pin tragen
     * @param reported ALLE von der Box gemeldeten Geräte (source='local')
     * @return die eindeutigen 1:1-Treffer, stabil sortiert; nie {@code null}
     */
    public static List<Rebind> decide(List<PinnedComponent> pinned,
            List<ReportedDevice> reported, ObjectMapper mapper) {
        if (pinned == null || pinned.isEmpty() || reported == null || reported.isEmpty()) {
            return List.of();
        }
        Set<String> reportedIds = new LinkedHashSet<>();
        for (ReportedDevice d : reported) {
            if (d.edgeSourceId() != null && !d.edgeSourceId().isBlank()) {
                reportedIds.add(d.edgeSourceId());
            }
        }
        Set<String> pinnedIds = new LinkedHashSet<>();
        for (PinnedComponent c : pinned) {
            if (c.edgeSourceId() != null && !c.edgeSourceId().isBlank()) {
                pinnedIds.add(c.edgeSourceId());
            }
        }

        // Verwaiste Komponenten (ihr Pin zeigt ins Leere) je Fingerabdruck - und
        // die ERSTBINDUNG: eine im Portal angelegte Komponente trägt noch gar
        // keinen Pin, bis die Box die daraus abgeleitete Quelle meldet. Ohne
        // diesen Fall stand genau diese Quelle als „Neues Gerät gefunden" neben
        // der eigenen Komponente (Live-Fall Ebyte M31, 24.09.2026). Dieselben
        // Zäune gelten: identischer Fingerabdruck, nur ein eindeutiges 1:1.
        Map<String, List<PinnedComponent>> orphans = new TreeMap<>();
        for (PinnedComponent c : pinned) {
            if (c.edgeSourceId() != null && reportedIds.contains(c.edgeSourceId())) {
                continue; // lebende Bindung - nie anfassen
            }
            String fp = fingerprint(c.role(), c.communication(), c.connectionJson(), mapper);
            if (fp == null) {
                continue; // ohne Anbindung gibt es nichts wiederzuerkennen
            }
            orphans.computeIfAbsent(fp, k -> new ArrayList<>()).add(c);
        }
        if (orphans.isEmpty()) {
            return List.of();
        }

        // Freie Geräte (kein Pin zeigt auf sie) je Fingerabdruck.
        Map<String, List<ReportedDevice>> free = new HashMap<>();
        for (ReportedDevice d : reported) {
            if (d.edgeSourceId() == null || d.edgeSourceId().isBlank()
                    || pinnedIds.contains(d.edgeSourceId())) {
                continue;
            }
            String fp = fingerprint(d.role(), d.communication(), d.connectionJson(), mapper);
            if (fp == null) {
                continue;
            }
            free.computeIfAbsent(fp, k -> new ArrayList<>()).add(d);
        }

        List<Rebind> out = new ArrayList<>();
        for (Map.Entry<String, List<PinnedComponent>> e : orphans.entrySet()) {
            List<ReportedDevice> candidates = free.get(e.getKey());
            if (candidates == null || candidates.size() != 1 || e.getValue().size() != 1) {
                continue; // mehrdeutig - lieber sichtbar verwaist als falsch verbunden
            }
            PinnedComponent c = e.getValue().get(0);
            out.add(new Rebind(c.pointId(), c.edgeSourceId(), candidates.get(0).edgeSourceId(),
                    c.label() != null ? c.label() : candidates.get(0).label()));
        }
        return List.copyOf(out);
    }

    /**
     * Der Fingerabdruck eines Geräts: Rolle + Kommunikationsart + die
     * kanonisierte Verbindung. {@code null}, wenn eine der drei Hälften fehlt -
     * dann ist nichts wiederzuerkennen.
     *
     * <p>Die Kanonisierung sortiert die Schlüssel und wirft leere/absente Werte
     * weg, damit zwei Schreibweisen desselben Sachverhalts gleich aussehen; die
     * Anzeige-/Kadenzfelder fallen heraus.
     */
    static String fingerprint(String role, String communication, String connectionJson,
            ObjectMapper mapper) {
        if (role == null || role.isBlank() || communication == null || communication.isBlank()
                || connectionJson == null || connectionJson.isBlank()) {
            return null;
        }
        JsonNode conn;
        try {
            conn = mapper.readTree(connectionJson);
        } catch (Exception e) {
            return null;
        }
        if (conn == null || !conn.isObject()) {
            return null;
        }
        Map<String, String> canonical = new TreeMap<>();
        for (Iterator<Map.Entry<String, JsonNode>> it = conn.fields(); it.hasNext();) {
            Map.Entry<String, JsonNode> f = it.next();
            String key = f.getKey();
            if (IGNORED_CONNECTION_FIELDS.contains(key)) {
                continue;
            }
            JsonNode v = f.getValue();
            if (v == null || v.isNull()) {
                continue;
            }
            String text = v.isNumber() ? trimNumber(v) : v.asText();
            if (text == null || text.isBlank() || "false".equals(text) || "0".equals(text)) {
                // Ein Feld auf seinem Nullwert ist dasselbe wie ein fehlendes -
                // die Box lässt es beim Melden weg (`omitempty`), die Cloud kann
                // es aus einer älteren Fassung noch tragen.
                continue;
            }
            canonical.put(key, text);
        }
        if (canonical.isEmpty()) {
            return null; // eine leere Verbindung erkennt kein Gerät wieder
        }
        StringBuilder sb = new StringBuilder(role.trim()).append('\n')
                .append(communication.trim());
        for (Map.Entry<String, String> f : canonical.entrySet()) {
            sb.append('\n').append(f.getKey()).append('=').append(f.getValue());
        }
        return sb.toString();
    }

    /** {@code 502.0} und {@code 502} sind dieselbe Portnummer. */
    private static String trimNumber(JsonNode v) {
        double d = v.asDouble();
        if (d == Math.rint(d) && !Double.isInfinite(d)) {
            return Long.toString((long) d);
        }
        return v.asText();
    }
}
