package com.voltpilot.api.uems;

import java.math.BigDecimal;
import java.time.LocalDate;
import java.util.List;
import java.util.UUID;
import org.springframework.stereotype.Component;

/**
 * Der Leseweg der wirksamen Grenzen einer Anlage (UEMS AP-15 IP-3, Konzept §6.1): Bindung am Tag + Grenzblatt ihres
 * Netzanschlusses, entschieden von {@link GrenzeAufloesung} — nie hier. Das Ladepark-Dokument liest den Bezug hier;
 * der Optimierer liest dieselben Zeilen über seinen Python-Zwilling.
 */
@Component
public class AnlageGrenzen {

    private final NetzanschlussRepository anschluesse;
    private final NetzanschlussGrenzeRepository grenzen;

    public AnlageGrenzen(NetzanschlussRepository anschluesse, NetzanschlussGrenzeRepository grenzen) {
        this.anschluesse = anschluesse;
        this.grenzen = grenzen;
    }

    /** Die wirksamen Grenzen der Anlage am {@code tag} zu den Werten der Anlage. */
    public GrenzeAufloesung.Wirksam wirksam(UUID siteId, LocalDate tag, BigDecimal einspeisungAnlage,
            BigDecimal bezugAnlage) {
        NetzanschlussRepository.Bindung b = anschluesse.bindungenDerAnlage(siteId).stream()
                .filter(x -> x.laeuftAm(tag)).findFirst().orElse(null);
        List<GrenzeAufloesung.Fassung> fassungen = b == null ? List.of()
                : grenzen.fassungen(b.netzanschlussId()).stream().map(NetzanschlussGrenzeRepository.Zeile::fassung).toList();
        return GrenzeAufloesung.aufloesen(new GrenzeAufloesung.Grenzen(einspeisungAnlage, bezugAnlage), b != null,
                fassungen, tag);
    }

    /**
     * Der Bezug für das Ladepark-Dokument ({@code site_charging_config.grid_limit_kw} gegen das Grenzblatt). Gilt der
     * Wert der Anlage, kommt DASSELBE {@code Double} zurück — das Dokument bleibt Byte für Byte.
     */
    public Double bezugKw(UUID siteId, LocalDate tag, Double anlage) {
        BigDecimal wert = anlage == null ? null : BigDecimal.valueOf(anlage);
        BigDecimal wirksam = wirksam(siteId, tag, null, wert).bezugKw();
        if (wirksam == wert) {
            return anlage;
        }
        return wirksam.doubleValue();
    }
}
