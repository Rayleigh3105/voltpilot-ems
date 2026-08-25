package com.voltpilot.api.cockpit;

import com.voltpilot.api.cockpit.EigeneAuswertung.CustomBaustein;
import com.voltpilot.api.entities.EntityRegistryRepository;
import com.voltpilot.api.entities.EntityRegistryRepository.EntityRow;
import com.voltpilot.api.history.HistoryRange;
import com.voltpilot.api.profile.AnwendungKatalog.LayoutDoc;
import com.voltpilot.api.repo.CockpitLayoutRepository;
import com.voltpilot.api.repo.CockpitLayoutRepository.StoredLayout;
import com.voltpilot.api.repo.EntityHistoryRepository;
import com.voltpilot.api.repo.EntityHistoryRepository.Bucket;
import com.voltpilot.api.repo.SiteRepository;
import com.voltpilot.api.tenant.TenantContext;
import com.voltpilot.api.web.dto.EigeneAuswertungDto;
import com.voltpilot.api.web.dto.EigeneAuswertungDto.WertDto;
import java.time.LocalDate;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import org.springframework.stereotype.Service;

/**
 * Die WERTE der eigenen Auswertungen einer Anlage (Anwendungs-Programm
 * Stufe 5) — der schmale Lesepfad hinter {@code GET
 * /api/v1/sites/{id}/eigene-auswertung}.
 *
 * <h2>Kein neuer Speicher, keine neue Abfrage</h2>
 *
 * Die DEFINITIONEN stehen im Layout-Dokument ({@code cockpit_layout.document.custom}),
 * die WERTE kommen aus {@link EntityHistoryRepository} — demselben Pfad, aus
 * dem der Messwerte-Explorer seine Kurven zieht (inklusive der MIG-B2-Naht, die
 * einer migrierten Anlage ihre v1-Historie erhält). Es gibt hier weder eine
 * eigene Tabelle noch ein eigenes SQL: eine zweite Messwert-Quelle wäre eine
 * zweite Wahrheit über dieselbe Zahl.
 *
 * <p>Je KOMPONENTE läuft genau EINE Abfrage, auch wenn mehrere Kacheln auf ihr
 * sitzen — die Antwort trägt alle Kanäle dieser Komponente ohnehin.
 *
 * <h2>Die vier Kennzahlen, und warum sie so gerechnet werden</h2>
 *
 * <ul>
 *   <li><b>jetzt</b> — der {@code last} des jüngsten Eimers, der einen hat. Er
 *       stammt aus DERSELBEN Reihe, die das Chart zeichnet: Kachel und Kurve
 *       können damit nie Verschiedenes behaupten (eine zweite Quelle wie der
 *       gemeldete Momentanwert wäre genau diese Doppeldeutigkeit).
 *   <li><b>tagesmax</b> — das Maximum über die Eimer-Maxima.
 *   <li><b>tagesmittel</b> — das STICHPROBEN-GEWICHTETE Mittel der
 *       Eimer-Mittel ({@code Σ avg·n / Σ n}), wie {@code verlaufStats} im
 *       Portal: ein ungewichtetes Mittel überbetonte einen Eimer mit drei
 *       Messungen gegenüber einem mit neunzig.
 *   <li><b>tagessumme</b> — der ZUWACHS ({@code max − min}), nie eine Summe der
 *       Messwerte. Ein kWh-Kanal meldet in diesem Haus einen ZÄHLERSTAND (die
 *       Hausregel steht in {@code ConsumerRequirementStateRepository.energyOverPeriod}),
 *       seine Werte zu addieren ergäbe das Vielfache des Zählerstands. <b>Fällt
 *       die Reihe irgendwo</b> (Rücksetzung, Gerätetausch — oder ein Kanal, der
 *       gar keinen Zählerstand meldet), gibt es KEINE Zahl: lieber keine als
 *       eine falsche.
 * </ul>
 *
 * <p><b>Fehlt der Wert, steht {@code null} — nie eine 0.</b> Eine Kachel ohne
 * Messung sagt „noch keine Werte", sie behauptet keine Null.
 */
@Service
public class EigeneAuswertungService {

    private final SiteRepository sites;
    private final CockpitLayoutRepository layouts;
    private final EntityRegistryRepository entities;
    private final EntityHistoryRepository history;

    public EigeneAuswertungService(SiteRepository sites, CockpitLayoutRepository layouts,
            EntityRegistryRepository entities, EntityHistoryRepository history) {
        this.sites = sites;
        this.layouts = layouts;
        this.entities = entities;
        this.history = history;
    }

    /**
     * Die Werte aller eigenen Auswertungen dieser Anlage für EINEN Tag.
     *
     * @param at der Anker-Tag (Europe/Berlin); null = heute
     */
    public EigeneAuswertungDto forSite(UUID siteId, LocalDate at) {
        LocalDate anchor = at != null ? at : LocalDate.now(HistoryRange.ZONE);
        HistoryRange.Window window = HistoryRange.DAY.window(anchor);

        Map<String, CustomBaustein> defs = definitionen(siteId);
        List<WertDto> werte = new ArrayList<>();
        // Je Komponente EINE Abfrage — ihre Antwort trägt alle Kanäle.
        Map<String, Map<String, List<Bucket>>> proKomponente = new LinkedHashMap<>();
        Map<String, EntityRow> rows = new LinkedHashMap<>();

        for (CustomBaustein b : defs.values()) {
            EntityRow row = rows.computeIfAbsent(b.entityId(), id -> entity(siteId, id));
            if (row == null) {
                // Die Komponente gibt es nicht (mehr). Die Definition bleibt
                // gespeichert — sie zu löschen wäre ein stiller Datenverlust —,
                // aber es wird nichts behauptet.
                werte.add(leer(b, "Die Komponente dieser Auswertung gibt es nicht mehr."));
                continue;
            }
            Map<String, List<Bucket>> channels = proKomponente.computeIfAbsent(b.entityId(),
                    id -> history.history(siteId, id, HistoryRange.DAY, window.from(),
                            window.to(), row.entityType(), row.deviceId()));
            werte.add(wert(b, row, channels.getOrDefault(b.channel(), List.of())));
        }
        return new EigeneAuswertungDto(anchor.toString(), window.from(), window.to(),
                HistoryRange.DAY.bucketMinutes(), List.copyOf(werte));
    }

    /** Existiert diese Anlage im Mandanten des Aufrufers? (RLS ist der Zaun.) */
    public boolean siteVisible(UUID siteId) {
        return sites.existsForCurrentTenant(siteId);
    }

    /**
     * Die Definitionen aller Schichten, {@code eigen} gewinnt bei gleichem
     * Schlüssel — dieselbe Rangfolge wie beim Auflösen der Reihenfolge (E2:
     * „Kunde gewinnt"). Eine Kachel, die nur die Vorgabe definiert, bleibt
     * dabei erhalten.
     */
    private Map<String, CustomBaustein> definitionen(UUID siteId) {
        UUID tenantId = TenantContext.get();
        List<StoredLayout> tenantRows = tenantId == null ? List.of()
                : layouts.find(CockpitLayoutRepository.SCOPE_TENANT, tenantId,
                        CockpitLayoutRepository.SURFACE_COCKPIT);
        List<StoredLayout> siteRows = layouts.find(CockpitLayoutRepository.SCOPE_SITE, siteId,
                CockpitLayoutRepository.SURFACE_COCKPIT);
        // ⚠ GENAU die drei Schichten, die `CockpitLayoutService.forSite` dem
        // Portal liefert — und in derselben Rangfolge. Eine vierte (eine
        // kunden-weite `eigen`-Zeile auf der Cockpit-Fläche) erreicht das
        // Portal gar nicht; sie hier zu lesen hiesse, Werte für eine Kachel zu
        // liefern, die niemand rendert, bzw. eine Definition zu bevorzugen, die
        // die Fläche nicht kennt.
        Map<String, CustomBaustein> out = new LinkedHashMap<>();
        for (LayoutDoc doc : List.of(
                dokument(tenantRows, CockpitLayoutRepository.LAYER_VORGABE),
                dokument(siteRows, CockpitLayoutRepository.LAYER_VORGABE),
                dokument(siteRows, CockpitLayoutRepository.LAYER_EIGEN))) {
            for (CustomBaustein b : doc.custom()) {
                out.put(b.id(), b);
            }
        }
        return out;
    }

    /** Das Dokument EINER Schicht, oder das leere. */
    private static LayoutDoc dokument(List<StoredLayout> rows, String layer) {
        for (StoredLayout row : rows) {
            if (row.layer().equals(layer)) {
                return row.document();
            }
        }
        return LayoutDoc.leer();
    }

    private EntityRow entity(UUID siteId, String entityId) {
        try {
            return entities.entityForSite(siteId, UUID.fromString(entityId));
        } catch (IllegalArgumentException e) {
            return null;
        }
    }

    private static WertDto leer(CustomBaustein b, String hinweis) {
        return new WertDto(b.id(), b.titel(), b.darstellung(), b.entityId(), b.channel(),
                b.aggregat(), null, null, null, null, hinweis, List.of());
    }

    /**
     * Der Wert EINER Auswertung aus den Eimern ihres Kanals.
     *
     * <p><b>Eine fehlende Zahl bekommt IMMER ihren Grund.</b> Ein nackter Strich
     * ohne Erklärung ist ein Rätsel — dieselbe Disziplin, mit der eine gesperrte
     * Wahl im Dialog ihren Grund nennt. Es gibt genau ZWEI Lagen: der Kanal hat
     * heute nichts gemeldet (die Antwort führt ihn dann gar nicht), oder ein
     * Zählerstand ist kleiner geworden — dann ist sein „Zuwachs" keine Energie
     * (dieselbe Regel wie {@code energyOverPeriod}), und das ist der EINZIGE
     * Weg, auf dem eine belegte Reihe keine Zahl ergibt.
     */
    private static WertDto wert(CustomBaustein b, EntityRow row, List<Bucket> buckets) {
        Double value = switch (b.aggregat()) {
            case EigeneAuswertung.AGG_JETZT -> jetzt(buckets);
            case EigeneAuswertung.AGG_TAGESMAX -> tagesmax(buckets);
            case EigeneAuswertung.AGG_TAGESMITTEL -> tagesmittel(buckets);
            case EigeneAuswertung.AGG_TAGESSUMME -> tagessumme(buckets);
            default -> null;
        };
        String hinweis = null;
        if (value == null) {
            hinweis = !buckets.isEmpty() && EigeneAuswertung.AGG_TAGESSUMME.equals(b.aggregat())
                    ? "Dieser Zählerstand ist heute nicht durchgehend gestiegen — daraus lässt "
                            + "sich kein Tageswert ableiten."
                    : "Für diesen Tag liegen noch keine Messwerte vor.";
        }
        return new WertDto(b.id(), b.titel(), b.darstellung(), b.entityId(), b.channel(),
                b.aggregat(), value, EigeneAuswertung.kanalart(b.channel()), row.label(),
                row.entityType(), hinweis,
                // Die Kurve reist nur für ein Chart mit — eine Kachel zeigt EINE
                // Zahl, 96 Eimer wären dort reine Fracht.
                EigeneAuswertung.DARSTELLUNG_CHART.equals(b.darstellung()) ? buckets : List.of());
    }

    /** Der jüngste gemeldete Wert (der `last` des jüngsten belegten Eimers). */
    private static Double jetzt(List<Bucket> buckets) {
        for (int i = buckets.size() - 1; i >= 0; i--) {
            Bucket b = buckets.get(i);
            if (b.last() != null) {
                return b.last();
            }
            if (b.avg() != null) {
                return b.avg();
            }
        }
        return null;
    }

    private static Double tagesmax(List<Bucket> buckets) {
        Double out = null;
        for (Bucket b : buckets) {
            Double v = b.max() != null ? b.max() : b.avg();
            if (v != null && (out == null || v > out)) {
                out = v;
            }
        }
        return out;
    }

    private static Double tagesmittel(List<Bucket> buckets) {
        double sum = 0;
        double weight = 0;
        for (Bucket b : buckets) {
            if (b.avg() == null) {
                continue;
            }
            double w = b.n() > 0 ? b.n() : 1;
            sum += b.avg() * w;
            weight += w;
        }
        return weight > 0 ? sum / weight : null;
    }

    /**
     * Der ZUWACHS des Tages — {@code max − min}, die Hausregel für einen
     * Energiekanal ({@code ConsumerRequirementStateRepository.energyOverPeriod}).
     *
     * <p><b>⚠ Nur auf einer MONOTON steigenden Reihe.</b> {@code max − min} ist
     * per Konstruktion nie negativ, kann eine Rücksetzung also gar nicht
     * anzeigen — bei einem Zähler, der mittags von 950 auf 5 springt, käme 945
     * heraus statt der wirklichen ~57. Deshalb wird die Reihe geprüft: fällt
     * sie irgendwo, gibt es KEINE Zahl. Das fängt zwei Lagen mit derselben
     * Regel:
     * <ul>
     *   <li>der Zähler wurde zurückgesetzt oder das Gerät getauscht;
     *   <li>der Kanal meldet gar keinen Zählerstand, sondern die Energie JE
     *       INTERVALL — dann ist {@code max − min} die Differenz zweier
     *       Intervallwerte und bedeutet nichts.
     * </ul>
     * In beiden Fällen ist keine Zahl besser als eine falsche, und die Kachel
     * sagt, was sie beobachtet hat.
     *
     * <p>Die Toleranz ist bewusst winzig ({@link #MONOTON_EPS}): sie fängt
     * Fließkomma-Rauschen, nicht einen echten Rückschritt.
     */
    private static Double tagessumme(List<Bucket> buckets) {
        Double lo = null;
        Double hi = null;
        Double vorher = null;
        for (Bucket b : buckets) {
            Double min = b.min() != null ? b.min() : b.avg();
            Double max = b.max() != null ? b.max() : b.avg();
            if (min == null || max == null) {
                continue;
            }
            if (vorher != null && min + MONOTON_EPS < vorher) {
                return null;
            }
            vorher = max;
            if (lo == null || min < lo) {
                lo = min;
            }
            if (hi == null || max > hi) {
                hi = max;
            }
        }
        return lo == null ? null : hi - lo;
    }

    /** Fließkomma-Rauschen, nicht ein echter Rückschritt (siehe oben). */
    private static final double MONOTON_EPS = 1e-6;
}
