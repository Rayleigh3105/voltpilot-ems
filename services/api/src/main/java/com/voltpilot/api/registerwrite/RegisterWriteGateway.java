package com.voltpilot.api.registerwrite;

import java.time.Instant;
import java.util.List;
import java.util.Optional;
import java.util.UUID;

/**
 * WELCHE BOX GEFRAGT WIRD - die Adressierungs-Regel des Register-Kanals
 * (Produktionsvorfall 20.08.2026, „der Downlink kommt nie an").
 *
 * <p><b>⚠ DAS TOPIC IST EINE ADRESSE, KEIN ZIEL.</b> Der Auftrag reist auf
 * {@code ems/{t}/{s}/{d}/v2/register-write}, und auf diesem Pfad hört GENAU EINE
 * Sache zu: der Core der Box, der sich unter dieser Geräte-Kennung angemeldet
 * hat ({@code edge-app/core/internal/cloud} {@code Link.topic}). WELCHES Gerät
 * beschrieben werden soll, steht im {@code target}-Feld der Nutzlast - der
 * Kontrakt trennt die beiden ausdrücklich. Landet der Auftrag auf dem Pfad einer
 * Geräte-Zeile, hinter der kein Core steckt, ist er NICHT-RETAINED und damit
 * schlicht weg: kein Abonnent, keine Ablehnung, keine Spur - auf beiden Seiten.
 * Genau diese Stille hat zwei Untersuchungsrunden gekostet.
 *
 * <p><b>Daraus die zwei Regeln dieser Klasse:</b>
 * <ol>
 *   <li><b>Das Topic FOLGT dem Ziel, nie der Behauptung des Aufrufers.</b> Ist
 *       das gewählte Ziel eine Komponente oder eine von der Box gemeldete
 *       Quelle, dann kennt die Plattform das Gerät, das sie MELDET - und nur das
 *       kann den Auftrag ausführen. Eine abweichende {@code deviceId} im Rumpf
 *       wird überstimmt statt befolgt; sie könnte den Auftrag sonst auf eine
 *       Zeile umlenken, die niemand abonniert.</li>
 *   <li><b>Eine wahrscheinliche Verwechslung wird BENANNT, nie abgewiesen.</b>
 *       Hat sich die gewählte Zeile noch NIE gemeldet, während eine ANDERE Zeile
 *       derselben Anlage sehr wohl meldet, ist das der Verwechslungs-Verdacht:
 *       er reist als {@code note} mit, wird protokolliert und steht im
 *       Schweige-Grund, falls nichts zurückkommt.</li>
 * </ol>
 *
 * <p><b>⚠ WARUM DIE LEBENDIGKEIT KEIN TOR IST.</b> {@code lastSeenAt} ist
 * {@code max(received_at)} der TELEMETRIE - eine ganz andere Kette als das
 * MQTT-Abonnement des Cores. Eine frisch eingerichtete Box, deren Layer 1 noch
 * keinen Wechselrichter kennt, sendet keine einzige Telemetrie-Zeile und hört
 * trotzdem zu; sie abzuweisen wäre genau die Art Fehlurteil, gegen die dieser
 * Pfad sonst überall argumentiert („Schweigen ist eine Lücke, kein Beweis").
 * Der Auftrag geht deshalb hinaus, und die drei Schweige-Gründe
 * ({@link RegisterWriteSilence}) benennen den Ausgang hinterher - jetzt mit dem
 * Verwechslungs-Verdacht darin.
 *
 * <p>Rein und ohne Uhr (jede zeitabhängige Funktion nimmt ihr {@code now}) - das
 * {@code Tagesprotokoll}/{@code FleetPflege}-Muster: die Regel, die entscheidet,
 * auf welchem Pfad ein Auftrag landet, ist ohne einen einzigen Container
 * prüfbar.
 */
public final class RegisterWriteGateway {

    private RegisterWriteGateway() {
    }

    /** Eine Geräte-Zeile der Anlage, so weit die Regel sie braucht. */
    public record Device(UUID id, String label, Instant lastSeenAt) {

        /** Ob sich diese Zeile je gemeldet hat - ein INDIZ, nie ein Beweis (siehe oben). */
        public boolean everSeen() {
            return lastSeenAt != null;
        }

        boolean live(Instant now) {
            return lastSeenAt != null
                    && !lastSeenAt.isBefore(now.minus(RegisterWriteSilence.LIVE_WINDOW));
        }
    }

    /**
     * Die EINE Ablehnung, die der Aufrufer als 404 spricht - der Mandanten- und
     * Anlagen-Zaun antwortet auf diesem Pfad so, und die zwei Zustände dürfen
     * nicht auseinanderlaufen. Als Konstante, damit der Aufrufer sie nicht am
     * Satz erkennen muss.
     */
    public static final String DEVICE_NOT_FOUND = "Gerät nicht gefunden.";

    /** Wie die Adresse zustande kam - ausschließlich fürs Protokoll. */
    public enum Origin {
        /** Aus dem gewählten Ziel abgeleitet: die Box, die diese Komponente MELDET. */
        TARGET,
        /** Vom Aufrufer benannt (primäre Lane, freie Adresse). */
        REQUESTED,
        /** Die einzige Box der Anlage. */
        ONLY,
        /** Aus dem gemeinsamen Dienst für die führende Box. */
        LEAD
    }

    /**
     * Das Ergebnis: entweder ein Gerät, auf dessen Pfad veröffentlicht wird,
     * oder eine deutsche Ablehnung - nie beides und nie keines.
     *
     * @param note ein deutscher Verdacht über die ADRESSE ({@code null}, wenn
     *             es keinen gibt). Er verhindert nichts - er wird protokolliert
     *             und in den Schweige-Grund gehängt.
     */
    public record Choice(Device device, Origin origin, String refusal, boolean overruled,
            String note) {

        public boolean ok() {
            return device != null;
        }
    }

    /**
     * Die Adresse des Auftrags.
     *
     * @param devices  die Geräte-Zeilen DIESER Anlage (RLS-gefenced vom Aufrufer).
     * @param owner    das Gerät, das das gewählte Ziel MELDET, falls die
     *                 Plattform es kennt - {@code null} bei der primären Lane
     *                 und bei einer frei getippten Adresse, wo es kein
     *                 gemeldetes Ziel gibt.
     * @param requested die vom Aufrufer benannte Geräte-Zeile, oder {@code null}.
     */
    public static Choice choose(List<Device> devices, UUID owner, UUID requested, Instant now) {
        return choose(devices, owner, requested, null, now);
    }

    public static Choice choose(List<Device> devices, UUID owner, UUID requested, UUID lead, Instant now) {
        if (devices == null || devices.isEmpty()) {
            return refused("Diese Anlage hat noch kein verbundenes Gerät.");
        }
        if (owner != null) {
            Optional<Device> byOwner = find(devices, owner);
            if (byOwner.isPresent()) {
                // ⚠ Das Ziel gewinnt über die Behauptung des Aufrufers: die
                // Plattform WEISS, welche Box dieses Gerät meldet.
                return chosen(byOwner.get(), Origin.TARGET,
                        requested != null && !requested.equals(owner), devices, now);
            }
            return refused("Die zuständige Box ist in dieser Anlage nicht verfügbar.");
        }
        if (requested != null) {
            Optional<Device> byId = find(devices, requested);
            if (byId.isEmpty()) {
                return refused(DEVICE_NOT_FOUND);
            }
            return chosen(byId.get(), Origin.REQUESTED, false, devices, now);
        }
        if (lead != null) {
            return find(devices, lead).map(d -> chosen(d, Origin.LEAD, false, devices, now))
                    .orElseGet(() -> refused("Die führende Box ist in dieser Anlage nicht verfügbar."));
        }
        if (devices.size() > 1) {
            return refused("Diese Anlage hat mehrere Geräte. Bitte wählen Sie aus, "
                    + "welches schreiben soll.");
        }
        return chosen(devices.get(0), Origin.ONLY, false, devices, now);
    }

    /**
     * Der Verwechslungs-Verdacht: die gewählte Zeile hat sich NIE gemeldet,
     * eine ANDERE derselben Anlage sehr wohl.
     *
     * <p>Er wird nur auf einer Anlage mit mehreren Zeilen gebildet - auf einer
     * Anlage mit genau einer Zeile gibt es nichts zu verwechseln, und ihr
     * Schweigen ist eine gewöhnliche Lücke. Genannt wird die Alternative nur,
     * wenn sie EINDEUTIG ist: „das ist die falsche" ohne „das ist die richtige"
     * wäre die halbe Auskunft, aber eine geratene Empfehlung wäre schlechter
     * als keine.
     */
    private static Choice chosen(Device device, Origin origin, boolean overruled,
            List<Device> devices, Instant now) {
        if (device.everSeen()) {
            return new Choice(device, origin, null, overruled, null);
        }
        List<Device> others = devices.stream()
                .filter(d -> !d.id().equals(device.id()) && d.everSeen())
                .toList();
        if (others.isEmpty()) {
            return new Choice(device, origin, null, overruled, null);
        }
        List<Device> live = others.stream().filter(d -> d.live(now)).toList();
        String named = live.size() == 1
                ? " Die Anlage meldet sich über „" + live.get(0).label() + "\"."
                : "";
        return new Choice(device, origin, null, overruled,
                "Diese Geräte-Zeile hat sich noch nie bei VoltPilot gemeldet, eine andere "
                        + "dieser Anlage schon." + named);
    }

    private static Optional<Device> find(List<Device> devices, UUID id) {
        return devices.stream().filter(d -> id.equals(d.id())).findFirst();
    }

    private static Choice refused(String reason) {
        return new Choice(null, null, reason, false, null);
    }
}
