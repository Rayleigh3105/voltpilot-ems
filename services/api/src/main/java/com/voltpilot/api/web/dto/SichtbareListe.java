package com.voltpilot.api.web.dto;

import java.util.List;

/** Sichtbare Einträge und der Umfang derselben Antwort (AP-03 IP-12). */
public record SichtbareListe<T>(List<T> eintraege, TeilansichtDto teilansicht) {}
