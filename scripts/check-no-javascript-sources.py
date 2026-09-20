from pathlib import Path
import subprocess

# Ignore generated artifacts and dependencies, while checking staged and new source.
paths = subprocess.run(
    ["git", "ls-files", "-z", "--cached", "--others", "--exclude-standard", "--", "web", "web-tests", "e2e"],
    check=True, capture_output=True, text=True,
).stdout.split("\0")
violations = sorted({path for path in paths if Path(path).suffix in {".js", ".mjs", ".cjs"}})
if violations:
    raise SystemExit(
        "JavaScript source is not allowed; use TypeScript instead:\n"
        + "\n".join(f"- {path}" for path in violations)
    )
