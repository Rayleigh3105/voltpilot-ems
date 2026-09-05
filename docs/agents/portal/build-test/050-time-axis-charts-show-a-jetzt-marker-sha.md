# Time-axis charts show a "Jetzt"-marker + shaded past.

Ausgelagert aus `frontend/portal/AGENTS.md` am 05.09.2026 (Abschnitt Nr. 2, Punkt 050).

- **Time-axis charts show a "Jetzt"-marker + shaded past.** On the category-time charts (Fahrplan `ScheduleChart`, Historie day `HistoryDayChart` + energy day view, Wetter `WeatherChart`), a solid `t.price` `markLine` at the slot nearest `Date.now()` labels "Jetzt" and a `markArea` from index 0→now shades the elapsed part (`itemStyle {color: t.axis, opacity: 0.08}` - subtle but visible on white). Fahrplan also keeps the dashed "Morgen" divider. On an HOURLY category axis the markLine label renders rotated along the line - pin it with `rotate: 0` (WeatherChart does; same family as the TelemetryChart edge-label gotcha).
