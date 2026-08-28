# `open_meteo_pilsting_2026-08-28.json`

A VERBATIM Open-Meteo `/v1/forecast` response, recorded 2026-08-28 for the
Pilsting plant's coordinates (48.7 N / 12.65 E) - the day of the dusk incident
that `tests/test_dusk_forecast.py` pins. Not hand-written and not trimmed:
these are the bytes the adapter really receives.

Request (keyless, exactly the variables `_HOURLY_VARIABLES` asks for):

```
https://api.open-meteo.com/v1/forecast
  ?latitude=48.7&longitude=12.65
  &hourly=temperature_2m,cloud_cover,shortwave_radiation,direct_radiation,diffuse_radiation
  &start_date=2026-08-28&end_date=2026-08-28&timezone=UTC
```

**Why the file matters beyond one incident:** its hourly radiation column is
the empirical proof of the labelling convention the adapter now relies on.
Fetching the same day and coordinates at `minutely_15` and averaging the four
quarters of `[T-1h, T)` reproduces the hourly value at `T` at every hour of
the day, to the digit - while the FOLLOWING hour never matches:

| label | hourly | mean of `[T-1h, T)` | mean of `[T, T+1h)` |
|-------|--------|---------------------|---------------------|
| 04:00 |    0.0 |                 0.0 |                 3.8 |
| 05:00 |   12.0 |                12.0 |                76.0 |
| 07:00 |  245.0 |               245.2 |               351.8 |
| 10:00 |  651.0 |               651.0 |               586.2 |
| 17:00 |   87.0 |                86.8 |                42.0 |
| 18:00 |   23.0 |                22.0 |                 0.8 |

Sunrise that day was ~04:35 UTC, so the 05:00 row (12 W/m², a quarter of an
hour of sun) settles it on its own: the following-hour reading would have to
be 76.
