# Skills

Skills are markdown procedures OB-1 can load into context when a task matches them. They are useful for
repeatable workflows such as release checks, framework conventions, deployment rules, or team-specific
review standards.

## Using Skills

Project and user skills are discovered from the configured skill roots. Learned skills written by OB-1
live under the workspace `.ob1/skills/` directory so they are visible in the project.

Useful commands:

```text
/skills
/skills reload
```

## Writing Skills

A good skill is short and operational:

- Name the trigger clearly.
- List the exact checks or files it needs.
- Prefer commands and acceptance criteria over prose.
- Avoid secrets and private credentials.

OB-1 can learn skills only when `OB1_SKILL_LEARN=on`. Learned skills are local files and can be reviewed,
edited, or deleted like any other project artifact.
