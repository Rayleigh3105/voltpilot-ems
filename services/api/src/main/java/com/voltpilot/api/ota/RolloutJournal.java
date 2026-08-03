package com.voltpilot.api.ota;

import com.voltpilot.api.repo.RolloutRepository;
import java.time.Instant;
import java.time.ZoneId;
import java.time.format.DateTimeFormatter;
import java.util.List;
import java.util.Map;
import java.util.UUID;

/**
 * Das Audit-Journal als MARKDOWN - der optionale gitops-Spiegel der OTA
 * Stufe 4 (Scout vp-ota-rollout-h4 §6, Captain-Entscheid D2).
 *
 * <h2>Was das ist - und vor allem, was es NICHT ist</h2>
 *
 * D2 ist eindeutig: die Autorität über den Soll-Zustand ist die Portal-DB plus
 * die retained MQTT-Nachricht, <b>nicht</b> das gitops-Repo. Der Spiegel ist
 * „rein dokumentarisch, nie im Wirkpfad" - eine zweite, git-förmige Zeitachse
 * für den Betreiber, der ohnehin alles in Git nachliest.
 *
 * <p>Daraus folgen drei Bau-Entscheidungen, die zusammengehören:
 *
 * <ol>
 *   <li><b>Die api hält KEIN gitops-Schreib-Token.</b> Ein Zugangsdaten-Satz,
 *       der ein zweites Repo beschreiben darf, wäre eine neue Angriffsfläche
 *       im Wirkpfad - und zwar für etwas, das ausdrücklich NICHT im Wirkpfad
 *       liegen darf. Die api EXPORTIERT nur; das Committen macht ein Mensch
 *       oder ein Cron außerhalb ({@code tools/deploy/mirror-rollout-journal.sh},
 *       Anleitung in {@code docs/deploy.md}).</li>
 *   <li><b>Die Ausgabe ist DETERMINISTISCH.</b> Derselbe Zustand ergibt
 *       dieselben Bytes, also erzeugt ein wiederholter Lauf keinen Commit -
 *       genau das macht einen Spiegel im Git brauchbar statt lärmend. Deshalb
 *       trägt der Kopf kein „erzeugt am".</li>
 *   <li><b>Es fließt nichts zurück.</b> Es gibt keinen Import-Pfad, keinen
 *       Abgleich, keine Ableitung aus dem Spiegel - er ist eine Kopie, und
 *       eine Kopie, die etwas entscheiden könnte, wäre eine zweite Wahrheit.
 *       </li>
 * </ol>
 *
 * <p>Rein und Docker-frei testbar wie {@link RolloutStates} und
 * {@link BakeGate} - eine Papier-Spur ist eine Behauptung über die
 * Vergangenheit und gehört an EINE nagelbare Stelle.
 */
public final class RolloutJournal {

    /**
     * Die Zeitzone der Darstellung. Europe/Berlin wie überall im Portal (die
     * {@code HistoryRange}-Disziplin): der Betreiber liest die Zeit, in der er
     * gehandelt hat, nicht UTC.
     */
    public static final ZoneId ZONE = ZoneId.of("Europe/Berlin");

    private static final DateTimeFormatter STAMP =
            DateTimeFormatter.ofPattern("dd.MM.yyyy HH:mm:ss").withZone(ZONE);
    private static final DateTimeFormatter DAY =
            DateTimeFormatter.ofPattern("dd.MM.yyyy").withZone(ZONE);

    /** Die deutschen Namen der Ereignisse - dieselben Wörter wie im Portal. */
    private static final Map<String, String> EVENTS = Map.ofEntries(
            Map.entry("rollout_created", "Rollout gestartet"),
            Map.entry("wave_released", "Welle freigegeben"),
            Map.entry("wave_auto_released", "Welle AUTOMATISCH freigegeben"),
            Map.entry("auto_advance_on", "Wellen-Automatik eingeschaltet"),
            Map.entry("auto_advance_off", "Wellen-Automatik ausgeschaltet"),
            Map.entry("rollout_paused", "Rollout pausiert"),
            Map.entry("rollout_resumed", "Rollout fortgesetzt"),
            Map.entry("rollout_halted", "Rollout eingefroren"),
            Map.entry("rollout_auto_halted", "Rollout AUTOMATISCH angehalten"),
            Map.entry("rollout_done", "Rollout abgeschlossen"),
            Map.entry("rollout_last_wave", "Letzte Welle freigegeben"),
            Map.entry("target_assigned", "Release zugewiesen"),
            Map.entry("target_reverted", "Zuweisung zurückgenommen"),
            Map.entry("target_republished", "Zuweisung erneut gesendet"),
            Map.entry("target_cleared_on_unclaim", "Zuweisung beim Entfernen des Geräts gelöscht"),
            Map.entry("device_pinned_skipped", "Gerät übersprungen (festgenagelt)"),
            Map.entry("device_state", "Zustand geändert"));

    private RolloutJournal() {
    }

    /**
     * Das Journal als Markdown-Dokument.
     *
     * @param events die Einträge, NEUESTE ZUERST (so liefert sie das
     *               Repository); ausgegeben wird chronologisch aufsteigend je
     *               Tag, weil eine Papier-Spur vorwärts gelesen wird
     * @param labels Geräte-Id → lesbarer Name; fehlt ein Eintrag, steht die Id
     *               da - <b>nie ein erfundener Name</b>
     */
    public static String render(List<RolloutRepository.EventRow> events,
            Map<UUID, String> labels) {
        StringBuilder out = new StringBuilder();
        out.append("# VoltPilot Edge-Rollouts - Audit-Journal\n\n");
        out.append("Dokumentarischer Spiegel des append-only `rollout_event`-Journals der ");
        out.append("Portal-Datenbank.\n");
        out.append("**Die Autorität ist die Portal-DB, nicht diese Datei** ");
        out.append("(Scout `vp-ota-rollout-h4` §6, Entscheid D2) - hier wird nichts ");
        out.append("entschieden und nichts zurückgelesen.\n\n");

        if (events == null || events.isEmpty()) {
            out.append("_Bisher kein Ereignis._\n");
            return out.toString();
        }

        // Chronologisch aufsteigend, damit die Datei wie ein Logbuch liest.
        List<RolloutRepository.EventRow> asc = new java.util.ArrayList<>(events);
        asc.sort(java.util.Comparator.comparing(RolloutRepository.EventRow::at)
                .thenComparingLong(RolloutRepository.EventRow::id));

        String currentDay = null;
        for (RolloutRepository.EventRow e : asc) {
            String day = DAY.format(e.at());
            if (!day.equals(currentDay)) {
                out.append("\n## ").append(day).append("\n\n");
                out.append("| Zeit | Wer | Ereignis | Rollout | Gerät | Detail |\n");
                out.append("|---|---|---|---|---|---|\n");
                currentDay = day;
            }
            out.append("| ").append(time(e.at()))
                    .append(" | ").append(cell(actor(e.actor())))
                    .append(" | ").append(cell(event(e.event())))
                    .append(" | ").append(cell(shortId(e.rolloutId())))
                    .append(" | ").append(cell(device(e.deviceId(), labels)))
                    .append(" | ").append(cell(e.detail()))
                    .append(" |\n");
        }
        return out.toString();
    }

    /**
     * Der Wächter handelt als {@code system} und wird auch so benannt - ein
     * Automatismus, der sich als Mensch ausgibt, macht das Journal wertlos.
     */
    private static String actor(String actor) {
        return RolloutService.SYSTEM_ACTOR.equals(actor) ? "automatisch" : actor;
    }

    /** Ein Ereignis, das dieser Stand nicht kennt, steht ROH da - nie geraten. */
    private static String event(String event) {
        return EVENTS.getOrDefault(event, event);
    }

    private static String device(UUID id, Map<UUID, String> labels) {
        if (id == null) {
            return null;
        }
        String label = labels == null ? null : labels.get(id);
        return label != null && !label.isBlank() ? label : id.toString();
    }

    private static String shortId(UUID id) {
        return id == null ? null : id.toString().substring(0, 8);
    }

    private static String time(Instant at) {
        return STAMP.format(at).substring(11);
    }

    /**
     * Eine Tabellenzelle: leere Werte werden zu {@code —}, und ein Pipe im
     * Freitext würde die Tabelle sprengen - er wird escaped, nicht entfernt
     * (der Grund eines Auto-Halts ist Beweismittel und wird nicht gekürzt).
     */
    private static String cell(String raw) {
        if (raw == null || raw.isBlank()) {
            return "—";
        }
        return raw.replace("\\", "\\\\").replace("|", "\\|").replace("\n", " ");
    }
}
