package com.voltpilot.api.cockpit;

import com.voltpilot.api.profile.AnwendungKatalog;
import com.voltpilot.api.profile.AnwendungKatalog.Baustein;
import com.voltpilot.api.profile.AnwendungKatalog.LayoutDoc;
import com.voltpilot.api.repo.CockpitLayoutRepository;
import com.voltpilot.api.repo.CockpitLayoutRepository.StoredLayout;
import com.voltpilot.api.repo.SiteRepository;
import com.voltpilot.api.tenant.TenantContext;
import com.voltpilot.api.web.dto.CockpitLayoutDto;
import com.voltpilot.api.web.dto.CockpitLayoutDto.BausteinDto;
import com.voltpilot.api.web.dto.CockpitLayoutDto.LayerDto;
import com.voltpilot.api.web.dto.CockpitLayoutDto.LayoutDocumentDto;
import com.voltpilot.api.web.dto.SiteDto;
import java.util.ArrayList;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Set;
import java.util.UUID;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Service;
import org.springframework.web.server.ResponseStatusException;

/**
 * Der LAYOUT-Speicher einer Fläche (Anwendungs-Programm Stufe 3, Scout
 * {@code vp-portal-zielbild-anwendungen} §3.2 E / §3.3): lesen, schreiben,
 * zurücksetzen — plus die FORM-Prüfung eines Dokuments.
 *
 * <p><b>Was hier NICHT lebt: die Auflösung.</b> Katalog → Preset → Vorgabe →
 * Eigen ist eine reine Funktion und wohnt im Portal
 * ({@code cockpitLayout.ts layoutResolve}), das rendert. Der Server hält
 * Katalog und Absicht; einen {@code GET /surface} gibt es bewusst nicht
 * (BUILD.md §4.1). Deshalb braucht er die kanonische Reihenfolge auch nicht zu
 * kennen — sie ist je Bildschirmbreite verschieden.
 *
 * <p><b>Die drei Ablehnungen, und was sie NICHT sind.</b> Geprüft wird die
 * FORM: (a) ein unbekannter Baustein-Schlüssel, (b) ein Baustein einer ANDEREN
 * Fläche (ein Portfolio-Baustein in einem Cockpit-Dokument), (c) ein
 * Pflicht-Baustein in {@code hidden} bzw. ein {@code lead}, der kein
 * lead-fähiger Block ist. Jede ist ein 400 mit deutschem Grund.
 *
 * <p><b>Ausdrücklich KEINE Ablehnung ist ein Baustein, den diese Anlage gerade
 * nicht hat</b> — das wäre ein Widerspruch zur tragenden Regel der Stufe: „ein
 * Baustein, dessen Anwendung nicht (mehr) aktiv ist, wird beim Rendern still
 * übersprungen, seine Präferenz bleibt gespeichert" (§3.2 E). Wer eine
 * Anwendung abschaltet und später wieder einschaltet, bekommt sein Bild
 * zurück; ein Schreib-Gate auf die momentane Verfügbarkeit würde genau diese
 * Eigenschaft zerstören.
 *
 * <p><b>Rechte (E2).</b> Die Schicht {@code eigen} schreibt der Kunde für
 * SEINE Anlage (RLS ist der Zaun, kein {@code @PreAuthorize}); die Schicht
 * {@code vorgabe} schreibt der Portal-Admin über den {@code X-Tenant-Id}-
 * Umschalter — die Methodenprüfung sitzt am Controller, der DATENPFAD ist
 * derselbe RLS-gefencte. Der Kunde GEWINNT: sein „Zurücksetzen" ist ein DELETE
 * seiner Schicht und fällt damit auf die Vorgabe zurück.
 */
@Service
public class CockpitLayoutService {

    /** Die Fläche „Anlagen-Cockpit" (Stufe 3). */
    public static final String SURFACE_COCKPIT = CockpitLayoutRepository.SURFACE_COCKPIT;
    /** Die Fläche „Portfolio-Cockpit" (Stufe 4) — sie hängt am KUNDEN. */
    public static final String SURFACE_PORTFOLIO = CockpitLayoutRepository.SURFACE_PORTFOLIO;

    private final SiteRepository sites;
    private final CockpitLayoutRepository layouts;
    private final AnwendungKatalog anwendungen;

    public CockpitLayoutService(SiteRepository sites, CockpitLayoutRepository layouts,
            AnwendungKatalog anwendungen) {
        this.sites = sites;
        this.layouts = layouts;
        this.anwendungen = anwendungen;
    }

    // -- read ---------------------------------------------------------------

    /**
     * Alle Schichten des Anlagen-Cockpits, oder null wenn RLS die Anlage
     * verbirgt (⇒ 404, nie 403).
     */
    public CockpitLayoutDto forSite(UUID siteId, boolean darfVorgabe) {
        SiteDto site = sites.findById(siteId);
        if (site == null) {
            return null;
        }
        UUID tenantId = TenantContext.get();
        List<StoredLayout> siteRows =
                layouts.find(CockpitLayoutRepository.SCOPE_SITE, siteId, SURFACE_COCKPIT);
        List<StoredLayout> tenantRows = tenantId == null ? List.of()
                : layouts.find(CockpitLayoutRepository.SCOPE_TENANT, tenantId, SURFACE_COCKPIT);
        return new CockpitLayoutDto(SURFACE_COCKPIT, site.profil(),
                document(anwendungen.presetLayout(site.profil(), SURFACE_COCKPIT)),
                layer(tenantRows, CockpitLayoutRepository.LAYER_VORGABE),
                layer(siteRows, CockpitLayoutRepository.LAYER_VORGABE),
                layer(siteRows, CockpitLayoutRepository.LAYER_EIGEN),
                bausteine(SURFACE_COCKPIT), darfVorgabe);
    }

    /**
     * Die kunden-weite Schicht (E1: „für alle meine Anlagen") einer Fläche.
     *
     * <p><b>Das Profil ist hier eine MEHRHEITS-Frage</b>, denn ein Preset hängt
     * an der ANLAGE und diese Fläche am KUNDEN: die Regel steht rein und
     * Docker-frei in {@link PortfolioPreset}. Auf der Fläche {@code cockpit}
     * bleibt sie ausdrücklich ungefragt — dort löst jedes Anlagen-Cockpit gegen
     * SEIN eigenes Profil auf, und ein Mehrheits-Profil daneben wäre eine
     * zweite Aussage über dieselbe Sache.
     */
    public CockpitLayoutDto forTenant(String surface, boolean darfVorgabe) {
        UUID tenantId = requireTenant();
        String flaeche = requireSurface(surface);
        List<StoredLayout> rows =
                layouts.find(CockpitLayoutRepository.SCOPE_TENANT, tenantId, flaeche);
        String profil = SURFACE_PORTFOLIO.equals(flaeche)
                ? PortfolioPreset.mehrheitsProfil(sites.findAll().stream()
                        .map(SiteDto::profil).toList())
                : null;
        return new CockpitLayoutDto(flaeche, profil,
                document(anwendungen.presetLayout(profil, flaeche)),
                layer(rows, CockpitLayoutRepository.LAYER_VORGABE), null,
                layer(rows, CockpitLayoutRepository.LAYER_EIGEN), bausteine(flaeche), darfVorgabe);
    }

    // -- write --------------------------------------------------------------

    /** Schreibt eine Schicht des Anlagen-Cockpits (nach der Form-Prüfung). */
    public CockpitLayoutDto saveForSite(UUID siteId, String layer, LayoutDoc document,
            String updatedBy, boolean darfVorgabe) {
        requireSite(siteId);
        String normalized = requireLayer(layer);
        validate(document, SURFACE_COCKPIT);
        layouts.save(CockpitLayoutRepository.SCOPE_SITE, siteId, SURFACE_COCKPIT, normalized,
                document, updatedBy);
        return forSite(siteId, darfVorgabe);
    }

    /** Schreibt die kunden-weite Schicht einer Fläche (E1). */
    public CockpitLayoutDto saveForTenant(String surface, String layer, LayoutDoc document,
            String updatedBy, boolean darfVorgabe) {
        UUID tenantId = requireTenant();
        String flaeche = requireSurface(surface);
        String normalized = requireLayer(layer);
        validate(document, flaeche);
        layouts.save(CockpitLayoutRepository.SCOPE_TENANT, tenantId, flaeche, normalized,
                document, updatedBy);
        return forTenant(flaeche, darfVorgabe);
    }

    /**
     * Der RESET: löscht GENAU diese Schicht. Sie fällt damit auf die darunter —
     * das ist die Semantik, die der Knopf dem Kunden ansagt (E2). Eine Schicht,
     * die es nie gab, zu löschen ist ein harmloses No-op, kein 404: der Kunde
     * hat den Zustand erreicht, den er wollte.
     */
    public CockpitLayoutDto resetForSite(UUID siteId, String layer, boolean darfVorgabe) {
        requireSite(siteId);
        layouts.delete(CockpitLayoutRepository.SCOPE_SITE, siteId, SURFACE_COCKPIT,
                requireLayer(layer));
        return forSite(siteId, darfVorgabe);
    }

    /** Der Reset der kunden-weiten Schicht („Vorgabe entfernen"). */
    public CockpitLayoutDto resetForTenant(String surface, String layer, boolean darfVorgabe) {
        UUID tenantId = requireTenant();
        String flaeche = requireSurface(surface);
        layouts.delete(CockpitLayoutRepository.SCOPE_TENANT, tenantId, flaeche,
                requireLayer(layer));
        return forTenant(flaeche, darfVorgabe);
    }

    // -- Form-Prüfung -------------------------------------------------------

    /**
     * Prüft die FORM eines Dokuments gegen den Baustein-Katalog. Siehe den
     * Klassen-Kommentar dafür, was hier ausdrücklich NICHT geprüft wird.
     */
    void validate(LayoutDoc document, String flaeche) {
        if (document == null) {
            throw bad("Es wurde kein Layout übergeben.");
        }
        for (String id : document.order()) {
            requireBaustein(id, flaeche);
        }
        for (String id : document.shown()) {
            requireBaustein(id, flaeche);
        }
        for (String id : document.hidden()) {
            Baustein b = requireBaustein(id, flaeche);
            if (b.pflicht()) {
                throw bad("„" + b.label() + "“ lässt sich nicht ausblenden — dieser "
                        + "Baustein gehört zur Grundausstattung jedes Cockpits.");
            }
        }
        if (document.lead() != null && !leadBlocks(flaeche).contains(document.lead())) {
            throw bad("„" + document.lead() + "“ lässt sich nicht hervorheben.");
        }
        Set<String> seen = new LinkedHashSet<>();
        for (String id : document.order()) {
            if (!seen.add(id)) {
                throw bad("„" + id + "“ steht mehrfach in der Reihenfolge.");
            }
        }
    }

    private Baustein requireBaustein(String id, String flaeche) {
        Baustein b = anwendungen.baustein(id);
        if (b == null) {
            throw bad("„" + id + "“ ist kein Baustein, den VoltPilot kennt.");
        }
        if (!flaeche.equals(b.flaeche())) {
            throw bad("„" + b.label() + "“ gehört nicht auf diese Fläche.");
        }
        return b;
    }

    /**
     * Die Blöcke, die ein Stern als Lead setzen darf — aus dem Katalog, nie von
     * Hand. Auf der Fläche {@code portfolio} ist die Menge LEER: es gibt dort
     * keine Bühne, die ein Baustein an sich ziehen könnte, und ein gesetzter
     * Lead ist damit ein 400 statt einer stillen Wirkungslosigkeit.
     */
    private Set<String> leadBlocks(String flaeche) {
        Set<String> out = new LinkedHashSet<>();
        for (Baustein b : anwendungen.bausteine(flaeche)) {
            if (b.leadBlock() != null) {
                out.add(b.leadBlock());
            }
        }
        return out;
    }

    // -- Helfer -------------------------------------------------------------

    private List<BausteinDto> bausteine(String flaeche) {
        List<BausteinDto> out = new ArrayList<>();
        for (Baustein b : anwendungen.bausteine(flaeche)) {
            out.add(new BausteinDto(b.id(), b.label(), b.pflicht(), b.beweglich(), b.leadBlock(),
                    anwendungen.beigesteuertVon(b.id())));
        }
        return List.copyOf(out);
    }

    private static LayerDto layer(List<StoredLayout> rows, String layer) {
        for (StoredLayout row : rows) {
            if (row.layer().equals(layer)) {
                return new LayerDto(document(row.document()), row.updatedBy(), row.updatedAt());
            }
        }
        return null;
    }

    private static LayoutDocumentDto document(LayoutDoc doc) {
        return new LayoutDocumentDto(1, doc.order(), doc.hidden(), doc.shown(), doc.lead());
    }

    private void requireSite(UUID siteId) {
        if (!sites.existsForCurrentTenant(siteId)) {
            throw new ResponseStatusException(HttpStatus.NOT_FOUND, "Anlage nicht gefunden.");
        }
    }

    private static UUID requireTenant() {
        UUID tenantId = TenantContext.get();
        if (tenantId == null) {
            // Ein Portal-Admin OHNE gewählten Mandanten: es gibt keine
            // Organisation, deren Vorgabe gemeint sein könnte.
            throw new ResponseStatusException(HttpStatus.NOT_FOUND,
                    "Ohne gewählten Kunden gibt es keine kunden-weite Vorgabe.");
        }
        return tenantId;
    }

    /**
     * Ein unbekanntes Flächen-Wort ist ein 400 mit deutschem Grund, nie ein
     * stiller Rückfall auf das Cockpit: eine Schicht, die unter dem falschen
     * Schlüssel landet, wäre für den Kunden unauffindbar.
     */
    private static String requireSurface(String surface) {
        String f = surface == null || surface.isBlank() ? SURFACE_COCKPIT : surface.trim();
        if (SURFACE_COCKPIT.equals(f) || SURFACE_PORTFOLIO.equals(f)) {
            return f;
        }
        throw bad("Unbekannte Fläche — erlaubt sind „cockpit“ und „portfolio“.");
    }

    private static String requireLayer(String layer) {
        String l = layer == null ? "" : layer.trim();
        if (CockpitLayoutRepository.LAYER_EIGEN.equals(l)
                || CockpitLayoutRepository.LAYER_VORGABE.equals(l)) {
            return l;
        }
        throw bad("Unbekannte Schicht — erlaubt sind „eigen“ und „vorgabe“.");
    }

    private static ResponseStatusException bad(String reason) {
        return new ResponseStatusException(HttpStatus.BAD_REQUEST, reason);
    }
}
