# fpt-uptime

Checks FPT's websites from outside their server, every 10 minutes, on GitHub Actions.
Alerts go to the team's private alert channel when a site is down for two checks in a
row, again when it is back, and once a day to show the monitor itself is running.

The targets (with any credentials) and the alert route are repository secrets
(`MONITOR_TARGETS`, `ALERT_WEBHOOK_URL`); logs name targets only.

Test the alert path: Actions → uptime → Run workflow, with `simulate_down` set to a target
name, twice; then run it once empty for the recovery message.

The source of record is `scripts/ops/outside-monitor/` in the FPT repository.
