# Session Sharing

OB-1 already supports local transcript export:

```text
/export
/export clipboard
/resume
```

This is the safe first step for sharing because it does not upload code or prompts anywhere. Link-based
sharing is a later product surface and should be explicit about what leaves the machine.

Requirements for public share links:

- Show a preview before upload.
- Redact secrets by default.
- Include model route, mode, checks run, and changed files.
- Keep sharing opt-in.
- Let users delete shared sessions.
