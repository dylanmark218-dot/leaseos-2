# Main Branch Source Cleanup

The exact CAL05a supplied tree is preserved at `milestone/cal05a` and tag `source-cal05a`. For the GitHub-facing `main` branch, two files that the project itself marks as ignored were removed:

- `vite.config.ts.bak` — ignored backup copy; authoritative vite.config.ts remains.
- `client/public/__manus__/version.json` — ignored generated Manus runtime version artifact.

No functional source module was removed. The three zero-byte `.gitkeep` files remain because they preserve intentional empty directories and are not accidental duplicate source code.