package com.voltpilot.api.cockpit;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.voltpilot.api.cockpit.EigeneAuswertung.CustomBaustein;
import com.voltpilot.api.entities.EntityRegistryRepository;
import com.voltpilot.api.entities.EntityRegistryRepository.EntityRow;
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
import com.voltpilot.api.web.dto.CockpitLayoutDto.CustomBausteinDto;
import com.voltpilot.api.web.dto.CockpitLayoutDto.LayoutDocumentDto;
import com.voltpilot.api.web.dto.CockpitLayoutDto.VorlageDto;
import com.voltpilot.api.web.dto.SiteDto;
import java.util.ArrayList;
import java.util.LinkedHashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
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
    private final EntityRegistryRepository entities;
    private final ObjectMapper mapper;

    public CockpitLayoutService(SiteRepository sites, CockpitLayoutRepository layouts,
            AnwendungKatalog anwendungen, EntityRegistryRepository entities, ObjectMapper mapper) {
        this.sites = sites;
        this.layouts = layouts;
        this.anwendungen = anwendungen;
        this.entities = entities;
        this.mapper = mapper;
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
                bausteine(SURFACE_COCKPIT), darfVorgabe, vorlagen(SURFACE_COCKPIT));
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
                layer(rows, CockpitLayoutRepository.LAYER_EIGEN), bausteine(flaeche), darfVorgabe,
                vorlagen(flaeche));
    }

    // -- write --------------------------------------------------------------

    /** Schreibt eine Schicht des Anlagen-Cockpits (nach der Form-Prüfung). */
    public CockpitLayoutDto saveForSite(UUID siteId, String layer, LayoutDoc document,
            String updatedBy, boolean darfVorgabe) {
        requireSite(siteId);
        String normalized = requireLayer(layer);
        validate(document, SURFACE_COCKPIT, siteId);
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
        validate(document, flaeche, null);
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
    void validate(LayoutDoc document, String flaeche, UUID siteId) {
        if (document == null) {
            throw bad("Es wurde kein Layout übergeben.");
        }
        Map<String, CustomBaustein> eigene = validateCustom(document, flaeche, siteId);
        for (String id : document.order()) {
            requireBaustein(id, flaeche, eigene);
        }
        for (String id : document.shown()) {
            requireBaustein(id, flaeche, eigene);
        }
        for (String id : document.hidden()) {
            Baustein b = requireBaustein(id, flaeche, eigene);
            // Eine eigene Auswertung ist NIE Pflicht — sie hat keinen Baustein
            // im Katalog, also auch keine Pflicht-Eigenschaft.
            if (b != null && b.pflicht()) {
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

    /**
     * Die EIGENEN Auswertungen eines Dokuments (Anwendungs-Programm Stufe 5).
     *
     * <p>Geprüft wird hier, was die reine {@link EigeneAuswertung} allein nicht
     * wissen kann — dass die Komponente zu DIESER Anlage gehört (RLS: eine
     * fremde ist über {@code entityForSite} schlicht nicht auffindbar) und dass
     * sie diesen Messwert überhaupt meldet. Die Form und die EHRLICHKEITSREGEL
     * (welches Aggregat zu welchem Kanal passt) kommen aus der reinen Klasse,
     * damit sie ohne einen einzigen Container prüfbar bleiben.
     *
     * <p><b>Nur die Anlagen-Fläche trägt eigene Auswertungen.</b> Das Portfolio
     * hängt am KUNDEN und hat keine einzelne Komponente, gegen die ein Kanal
     * geprüft werden könnte; eine Kachel dort wäre eine Zusage über Messwerte,
     * die je Anlage verschieden sind.
     */
    private Map<String, CustomBaustein> validateCustom(LayoutDoc document, String flaeche,
            UUID siteId) {
        List<CustomBaustein> custom = document.custom();
        if (custom.isEmpty()) {
            return Map.of();
        }
        if (!SURFACE_COCKPIT.equals(flaeche) || siteId == null) {
            throw bad("Eigene Auswertungen gibt es nur auf dem Cockpit einer Anlage.");
        }
        if (custom.size() > EigeneAuswertung.MAX_BAUSTEINE) {
            throw bad("Mehr als " + EigeneAuswertung.MAX_BAUSTEINE
                    + " eigene Auswertungen kann ein Cockpit nicht tragen.");
        }
        String doppelt = EigeneAuswertung.ersterDoppelter(custom);
        if (doppelt != null) {
            throw bad("„" + doppelt + "“ ist zweimal definiert.");
        }
        Map<String, CustomBaustein> out = new LinkedHashMap<>();
        // Je Komponente EINE Abfrage, auch wenn mehrere Kacheln auf ihr sitzen.
        Map<String, EntityRow> geladen = new LinkedHashMap<>();
        for (CustomBaustein b : custom) {
            String form = EigeneAuswertung.pruefeForm(b);
            if (form != null) {
                throw bad(form);
            }
            EntityRow row = geladen.computeIfAbsent(b.entityId(), id -> entity(siteId, id));
            if (row == null) {
                throw bad("Die gewählte Komponente gehört nicht zu dieser Anlage.");
            }
            if (!messkanaele(row).contains(b.channel())) {
                throw bad("„" + name(row) + "“ meldet diesen Messwert nicht.");
            }
            String grund = EigeneAuswertung.grund(b.channel(), b.aggregat(), null);
            if (grund != null) {
                throw bad(grund);
            }
            out.put(b.id(), b);
        }
        return Map.copyOf(out);
    }

    /** Die Komponente dieser Anlage, oder null (auch bei krummer Id). */
    private EntityRow entity(UUID siteId, String entityId) {
        try {
            return entities.entityForSite(siteId, UUID.fromString(entityId));
        } catch (IllegalArgumentException e) {
            return null;
        }
    }

    /** Die Messwert-Kanäle, die diese Komponente laut Registry meldet. */
    private Set<String> messkanaele(EntityRow row) {
        Set<String> out = new LinkedHashSet<>();
        if (row.capabilitiesJson() == null) {
            return out;
        }
        try {
            JsonNode measure = mapper.readTree(row.capabilitiesJson()).path("measure");
            for (JsonNode m : measure) {
                String channel = m.path("channel").asText(null);
                if (channel != null && !channel.isBlank()) {
                    out.add(channel);
                }
            }
        } catch (Exception e) {
            // Unlesbare Fähigkeiten sind KEIN Freibrief: dann meldet die
            // Komponente nachweislich nichts, was wir kennen.
            return Set.of();
        }
        return out;
    }

    private static String name(EntityRow row) {
        return row.label() == null || row.label().isBlank() ? "Diese Komponente" : row.label();
    }

    /**
     * Der Baustein hinter einem Schlüssel — oder null für eine EIGENE
     * Auswertung, die dieses Dokument selbst definiert.
     *
     * <p>Ein {@code eigen:}-Schlüssel ist damit nur bekannt, weil DASSELBE
     * Dokument ihn definiert: eine Reihenfolge, die eine Kachel nennt, die es
     * nicht gibt, wäre ein Schlüssel, den niemand rendern kann.
     */
    private Baustein requireBaustein(String id, String flaeche,
            Map<String, CustomBaustein> eigene) {
        if (EigeneAuswertung.istEigen(id)) {
            if (!eigene.containsKey(id)) {
                throw bad("Zu „" + id + "“ gibt es keine eigene Auswertung in diesem Layout.");
            }
            return null;
        }
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

    /** Die ARTEN eigener Auswertungen dieser Fläche — Katalog-Daten. */
    private List<VorlageDto> vorlagen(String flaeche) {
        List<VorlageDto> out = new ArrayList<>();
        for (AnwendungKatalog.BausteinVorlage v : anwendungen.bausteinVorlagen(flaeche)) {
            out.add(new VorlageDto(v.id(), v.label(), v.satz(), v.darstellung(), v.anwendung(),
                    v.nach()));
        }
        return List.copyOf(out);
    }

    private static LayoutDocumentDto document(LayoutDoc doc) {
        List<CustomBausteinDto> custom = new ArrayList<>();
        for (CustomBaustein b : doc.custom()) {
            custom.add(new CustomBausteinDto(b.id(), b.titel(), b.darstellung(), b.entityId(),
                    b.channel(), b.aggregat()));
        }
        return new LayoutDocumentDto(1, doc.order(), doc.hidden(), doc.shown(), doc.lead(),
                List.copyOf(custom), doc.seen());
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
