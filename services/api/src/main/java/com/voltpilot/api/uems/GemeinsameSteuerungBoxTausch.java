package com.voltpilot.api.uems;

import com.voltpilot.api.tenant.TenantContext;
import com.voltpilot.api.uems.SteuerungsverbundAnteilRepository.GeraetZeile;
import com.voltpilot.api.uems.SteuerungsverbundRepository.MitgliedZeile;
import com.voltpilot.api.uems.SteuerungsverbundRepository.VerbundZeile;
import java.time.Instant;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.UUID;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Propagation;
import org.springframework.transaction.annotation.Transactional;

/**
 * Box-Tausch in der Gemeinsamen Steuerung (AP-15 Folge zu IP-30, Ausfallmatrix A14, R17, I3/I4): in der Transaktion des
 * AP-06-Tauschs ({@link BoxTauschService#tauschen}) geht die Mitgliedschaft der ausgebauten Box zum Tauschzeitpunkt auf
 * die Nachfolgerin über — dieselbe Rolle, derselbe Messpunkt (die Quellen reisen 1:1 mit), dieselben Geräte-Angaben,
 * derselbe Anteil. Die Nachfolgerin bekommt das jüngste gespeicherte Anteils-Dokument (gleiche Epoche und Revision,
 * es ist KEINE Änderung der Anteile) und quittiert es; sie ist „wartet auf Bestätigung“ ({@code bestaetigt_am} NULL),
 * bis der Betreiber sie bestätigt (I4) — bis dahin bekommt sie keinen Plan (der Planer rechnet sie belegt, ihr Anteil
 * bleibt für ihre Geräte reserviert und geht an niemanden). Die Stufe der Anlage bleibt; nichts wird gelöscht.
 *
 * <p>Ohne Gemeinsame Steuerung an der Anlage: eine Abfrage, kein Schreiben (I6).
 */
@Service
public class GemeinsameSteuerungBoxTausch {

    /** Protokoll-Wort ({@code steuerungsverbund_aenderung.art}, V20260922150000). */
    public static final String ART = "box_getauscht";

    private final SteuerungsverbundRepository verbuende;
    private final SteuerungsverbundAnteilRepository anteile;
    private final SteuerungsverbundAnteilDienst dienst;

    public GemeinsameSteuerungBoxTausch(SteuerungsverbundRepository verbuende,
            SteuerungsverbundAnteilRepository anteile, SteuerungsverbundAnteilDienst dienst) {
        this.verbuende = verbuende;
        this.anteile = anteile;
        this.dienst = dienst;
    }

    /** Was übertragen wurde — für den Aufrufer und die Tests; leer ohne Mitgliedschaft der Box. */
    public record Uebertragung(UUID vorgaengerMitglied, UUID nachfolgerMitglied, UUID anteilKennung,
            int geraete) {}

    @Transactional(propagation = Propagation.MANDATORY)
    public List<Uebertragung> uebertragen(UUID siteId, UUID alt, UUID neu, Instant ab, ProtokollAkteur wer) {
        Optional<VerbundZeile> gefunden = verbuende.derAnlage(siteId);
        if (gefunden.isEmpty()) {
            return List.of();
        }
        VerbundZeile v = gefunden.get();
        verbuende.sperren(v.id());
        List<MitgliedZeile> betroffen = verbuende.mitgliederGeschichte(v.id()).stream()
                .filter(m -> m.deviceId().equals(alt) && m.aufgehobenAm() == null
                        && (m.gueltigBis() == null || m.gueltigBis().isAfter(ab)))
                .toList();
        if (betroffen.isEmpty()) {
            return List.of();
        }
        UUID tenant = TenantContext.get();
        List<SteuerungsverbundAnteilRepository.DokumentZeile> dokumente = anteile.dokumente(v.id());
        Map<UUID, UUID> kennungen = verbuende.anteilKennungen(v.id());
        List<Uebertragung> aus = new ArrayList<>();
        for (MitgliedZeile m : betroffen) {
            // Unter welcher Kennung führt das gespeicherte Dokument diesen Anteil? Die eigene, oder — nach einem
            // früheren Tausch ohne neues Dokument — die, die schon die Vorgängerin trug.
            UUID kennung = dokumente.isEmpty() ? null
                    : dokumente.get(0).tabelle().boxen().contains(alt.toString()) ? alt : kennungen.get(alt);
            UUID nachfolger = verbuende.nachfolgerinAufnehmen(m, neu, ab, kennung, wer.name()).orElseThrow(
                    () -> new BoxKonflikt("gleichzeitig_geaendert",
                            "Die Gemeinsame Steuerung wurde inzwischen geändert."));
            int geraete = 0;
            for (GeraetZeile g : anteile.geraete(v.id())) {
                if (g.deviceId().equals(alt) && anteile.geraetAufheben(g.id())) {
                    anteile.geraetEintragen(tenant, v.id(), neu, g.entityId(), g.richtung(), g.nennKw(),
                            g.schreibfreigabe(), g.hinweis(), wer.name());
                    geraete++;
                }
            }
            verbuende.protokoll(tenant, v.id(), siteId, ART, json(alt, m, false), json(neu, m, true), ab, false,
                    "box_tausch", wer);
            dienst.nachfolgerinZustellen(v, nachfolger, neu, m.rolle(), kennung, ab);
            aus.add(new Uebertragung(m.id(), nachfolger, kennung, geraete));
        }
        return List.copyOf(aus);
    }

    private static String json(UUID box, MitgliedZeile m, boolean nachfolgerin) {
        StringBuilder s = new StringBuilder("{\"box_id\":\"").append(box).append("\",\"rolle\":\"")
                .append(m.rolle().code()).append('"');
        if (m.dataSourceId() != null) {
            s.append(",\"messpunkt_id\":\"").append(m.dataSourceId()).append('"');
        }
        if (nachfolgerin) {
            s.append(",\"bestaetigt\":false");
        }
        return s.append('}').toString();
    }
}
