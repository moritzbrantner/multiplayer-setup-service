from pathlib import Path

ROOTS = [Path("web"), Path("web-tests"), Path("e2e")]
violations = sorted(
    path.as_posix()
    for root in ROOTS
    for path in root.rglob("*")
    if path.is_file() and path.suffix in {".js", ".mjs"}
)

if violations:
    raise SystemExit(
        "Committed JavaScript source is not allowed; use TypeScript instead:\n"
        + "\n".join(f"- {path}" for path in violations)
    )
