A cron expression is five fields separated by spaces:

```
minute  hour  day-of-month  month  day-of-week
```

| Field | Values |
| --- | --- |
| minute | 0–59 |
| hour | 0–23 |
| day of month | 1–31 |
| month | 1–12 |
| day of week | 0–7 (0 and 7 are both Sunday, 1 is Monday) |

## Syntax

| Write | Means |
| --- | --- |
| `*` | every value of the field |
| `1,15` | a list: 1 and 15 |
| `1-5` | a range: 1 to 5 |
| `*/15` | every 15th value from the start of the field |
| `9-17/2` | every 2nd value from 9 to 17 |
| `5/15` | every 15th value from 5 to the end of the field |

Only numbers are accepted: names such as `MON` or `JAN`, `L`, `?` and a sixth seconds field are not.

## Examples

| Runs | Expression |
| --- | --- |
| Every day at 08:00 | `0 8 * * *` |
| Weekdays at 09:00 | `0 9 * * 1-5` |
| Every 15 minutes | `*/15 * * * *` |
| Every hour, on the hour | `0 * * * *` |
| Twice a day, 08:00 and 18:00 | `0 8,18 * * *` |
| Mondays at 07:30 | `30 7 * * 1` |
| The first of every month at 09:00 | `0 9 1 * *` |
| Every 2 hours from 09:00 to 17:00 on weekdays | `0 9-17/2 * * 1-5` |

## Good to know

- Times are read in the schedule's timezone, not the computer's.
- When both day of month and day of week are restricted, a day matching **either** runs (`0 9 1 * 1` is the 1st of the month and every Monday). When either of them starts with `*` (including a step such as `*/2`), a day has to match both.
- On a daylight-saving change, a time that does not exist that day is skipped, and a time that happens twice runs once.
