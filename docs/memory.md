# Memory

OB-1 keeps project memory locally so a future session can reuse decisions, facts, and relationships
instead of starting cold. Memory lives under the workspace `.ob1/` directory and can be inspected with
slash commands.

## Commands

```text
/memory
/memory add <fact>
/memory search <query>
/memory export dot
/memory export html
```

## What Gets Stored

- Durable facts about the project.
- Relationships between files, modules, decisions, and concepts.
- Reflection notes when `OB1_MEM_REFLECT=on`.
- Evolved facts when `OB1_MEM_EVOLVE=on`.
- Autolinks when `OB1_MEM_AUTOLINK=on`.

The default posture is conservative: memory evolution, reflection, autolinking, and skill learning are
opt-in. The graph is readable and portable rather than hidden in a hosted service.

## Practical Use

Use `/memory add` for facts that should survive a session: architecture constraints, test commands,
release rules, or project-specific gotchas. Use `/memory export html` when you want an inspectable graph
for review or debugging.
